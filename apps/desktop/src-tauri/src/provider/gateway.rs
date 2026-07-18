use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::diagnostics::model_trace::ModelTraceRecorder;

use super::contracts::{
    ProviderDraftInput, ProviderModelCatalogRuntime,
    ProviderProbeProfileRuntime, ProviderRoutingDecision,
    ProviderRuntimeError, ProviderSmokeResult, TtsSynthesisResult,
};
use super::gateway_parts::{
    dashscope::DashScopeProviderAdapter,
    models::ModelCatalogService,
    openai::OpenAiProviderAdapter,
    probe::ProviderProbeService,
    realtime_audio::RealtimeAudioSynthesizer,
    routing::build_routing_decision,
    transport::{is_openai_compatible_kind, resolve_transport},
};

const LATENCY_BUDGET_MS: u64 = 1200;

pub struct ProviderGateway {
    model_catalog: ModelCatalogService,
    probe_service: ProviderProbeService,
    openai_adapter: OpenAiProviderAdapter,
    dashscope_adapter: DashScopeProviderAdapter,
    realtime_audio: RealtimeAudioSynthesizer,
}

impl ProviderGateway {
    pub fn new() -> Self {
        Self {
            model_catalog: ModelCatalogService,
            probe_service: ProviderProbeService,
            openai_adapter: OpenAiProviderAdapter,
            dashscope_adapter: DashScopeProviderAdapter,
            realtime_audio: RealtimeAudioSynthesizer,
        }
    }

    pub(crate) fn translate_text(
        &self,
        provider: ProviderDraftInput,
        source_text: String,
        source_language: String,
        target_language: String,
    ) -> Result<String, ProviderRuntimeError> {
        self.translate_text_streaming_traced(
            provider,
            source_text,
            source_language,
            target_language,
            None,
            |_| Ok(()),
        )
    }

    pub(crate) fn translate_text_streaming_traced<F>(
        &self,
        provider: ProviderDraftInput,
        source_text: String,
        source_language: String,
        target_language: String,
        trace: Option<&ModelTraceRecorder>,
        mut on_delta: F,
    ) -> Result<String, ProviderRuntimeError>
    where
        F: FnMut(&str) -> Result<(), ProviderRuntimeError>,
    {
        let mut trace_call = trace.map(|trace| trace.call("provider.translate_text"));
        if let Some(trace_call) = trace_call.as_ref() {
            let source_text_length = source_text.chars().count();
            let source_text_preview: String = source_text.chars().take(80).collect();
            trace_call.input(
                "request",
                json!({
                  "providerId": provider.provider_id,
                  "kind": provider.kind,
                  "model": provider.model,
                  "sourceLanguage": source_language,
                  "targetLanguage": target_language,
                  "sourceTextLength": source_text_length,
                  "sourceTextPreview": source_text_preview,
                }),
            );
        }

        let smoke = self.execute_smoke(provider, source_text, source_language, target_language);

        if let Some(error) = smoke.error.clone() {
            if let Some(trace_call) = trace_call.as_mut() {
                trace_call.error(format!("{}: {}", error.code, error.message));
            }
            return Err(error);
        }

        let result = (|| -> Result<String, ProviderRuntimeError> {
            let mut emitted_delta = false;
            for event in &smoke.event_log {
                if event.event_type != "translation.delta" {
                    continue;
                }

                if let Some(delta) = event.text_delta.as_deref() {
                    emitted_delta = true;
                    on_delta(delta)?;
                }
            }

            if !emitted_delta && !smoke.transcript.is_empty() {
                on_delta(&smoke.transcript)?;
            }

            Ok(smoke.transcript.clone())
        })();

        match result {
            Ok(transcript) => {
                if let Some(trace_call) = trace_call.as_ref() {
                    trace_call.output(
                        "response",
                        json!({
                          "streamObserved": smoke.stream_observed,
                          "eventCount": smoke.event_log.len(),
                          "transcriptLength": transcript.chars().count(),
                          "transcript": transcript,
                        }),
                    );
                }
                if let Some(trace_call) = trace_call.as_mut() {
                    trace_call.end();
                }
                Ok(smoke.transcript)
            }
            Err(error) => {
                if let Some(trace_call) = trace_call.as_mut() {
                    trace_call.error(format!(
                        "delta callback failed: {}: {}",
                        error.code, error.message
                    ));
                }
                Err(error)
            }
        }
    }

    pub fn fetch_models(&self, provider: ProviderDraftInput) -> ProviderModelCatalogRuntime {
        self.model_catalog.fetch(provider)
    }

    pub fn probe(&self, provider: ProviderDraftInput) -> ProviderProbeProfileRuntime {
        let smoke = self.execute_smoke(
            provider.clone(),
            "请把这句中文翻译成英文，并保留语气自然。".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );
        self.probe_service.evaluate(provider, smoke)
    }

    pub fn execute_smoke(
        &self,
        provider: ProviderDraftInput,
        source_text: String,
        source_language: String,
        target_language: String,
    ) -> ProviderSmokeResult {
        let request_id = format!("req-{}", now_marker());
        let transport_requested = provider.transport.clone();
        let (transport_effective, fallback_applied) = resolve_transport(&provider);
        let started_at = Instant::now();

        let mut discard_delta = discard_provider_delta;
        let execution = match provider.kind.as_str() {
            kind if is_openai_compatible_kind(kind) => self.openai_adapter.execute(
                &provider,
                &transport_effective,
                &request_id,
                &source_text,
                &source_language,
                &target_language,
                &mut discard_delta,
            ),
            "dashscope" => self.dashscope_adapter.execute(
                &provider,
                &transport_effective,
                &request_id,
                &source_text,
                &source_language,
                &target_language,
                &mut discard_delta,
            ),
            other => Err(ProviderRuntimeError::new(
                "request.invalid",
                format!("unsupported provider kind: {other}"),
            )),
        };

        match execution {
            Ok(mut execution) => {
                execution.fallback_applied = fallback_applied;
                execution.transport_requested = transport_requested.clone();
                execution.duration_ms = started_at.elapsed().as_millis() as u64;
                execution.routing_decision = build_routing_decision(
                    if execution
                        .first_event_latency_ms
                        .unwrap_or(execution.duration_ms)
                        <= LATENCY_BUDGET_MS
                    {
                        "available"
                    } else {
                        "realtime-risk"
                    },
                    execution
                        .first_event_latency_ms
                        .unwrap_or(execution.duration_ms),
                    fallback_applied,
                );
                execution.request_id = request_id;
                execution.provider_id = provider.provider_id;
                execution.source_language = source_language;
                execution.target_language = target_language;
                execution.transport_requested = transport_requested;
                execution
            }
            Err(error) => ProviderSmokeResult {
                request_id,
                provider_id: provider.provider_id,
                status: "failed".to_string(),
                transport_requested,
                transport_effective,
                fallback_applied,
                stream_observed: false,
                duration_ms: started_at.elapsed().as_millis() as u64,
                first_event_latency_ms: None,
                transcript: String::new(),
                source_language,
                target_language,
                event_log: Vec::new(),
                input_tokens: None,
                output_tokens: None,
                audio_seconds: None,
                routing_decision: ProviderRoutingDecision::for_verdict(
                    "unavailable",
                    LATENCY_BUDGET_MS,
                    fallback_applied,
                ),
                error: Some(error),
            },
        }
    }

    #[allow(dead_code, reason = "direct TTS gateway remains part of the provider contract while HTTP TTS is disabled")]
    pub fn synthesize_tts(
        &self,
        provider: ProviderDraftInput,
        _text: String,
        _target_language: String,
        _voice_preset_id: String,
    ) -> Result<TtsSynthesisResult, ProviderRuntimeError> {
        Err(ProviderRuntimeError::new(
            "tts.disabled",
            format!(
                "HTTP TTS endpoint 已禁用（provider={} model={}）。请使用 Omni Realtime 音频链路。",
                provider.provider_id, provider.model
            ),
        ))
    }

    pub fn synthesize_realtime_audio(
        &self,
        provider: ProviderDraftInput,
        text: String,
        target_language: String,
        voice: String,
    ) -> Result<TtsSynthesisResult, ProviderRuntimeError> {
        self.realtime_audio
            .synthesize(provider, text, target_language, voice)
    }

}

fn discard_provider_delta(_: &str) -> Result<(), ProviderRuntimeError> {
    Ok(())
}

fn now_marker() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("unix:{}", duration.as_secs()),
        Err(_) => "unix:0".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;
    use crate::provider::contracts::ProviderAuthRefInput;
    use crate::provider::gateway_parts::transport::{
        normalize_websocket_read_error, to_websocket_url, WebSocketTransport,
    };
    use rodio::{Decoder, Source};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;
    use tungstenite::{accept, Message};

    fn openai_provider(base_url: String) -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: "template-openai-compatible-realtime".to_string(),
            provider_id: "provider-openai-compatible".to_string(),
            kind: "openai-compatible".to_string(),
            display_name: "OpenAI Compatible".to_string(),
            model: "test-model".to_string(),
            base_url,
            transport: "streaming-http".to_string(),
            auth_ref: ProviderAuthRefInput {
                kind: "credential-ref".to_string(),
                reference: "none".to_string(),
                header_name: "Authorization".to_string(),
                scheme: "none".to_string(),
            },
            region: None,
            stream_enabled: true,
            timeout_ms: 5_000,
            system_prompt_template: "video-realtime-cn".to_string(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: vec![],
            scene_model_assignments: vec![],
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    fn dashscope_provider(base_url: String) -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: "template-dashscope-realtime".to_string(),
            provider_id: "provider-dashscope".to_string(),
            kind: "dashscope".to_string(),
            display_name: "DashScope".to_string(),
            model: "qwen-live".to_string(),
            base_url,
            transport: "websocket".to_string(),
            auth_ref: ProviderAuthRefInput {
                kind: "credential-ref".to_string(),
                reference: "none".to_string(),
                header_name: "Authorization".to_string(),
                scheme: "none".to_string(),
            },
            region: Some("cn-beijing".to_string()),
            stream_enabled: true,
            timeout_ms: 5_000,
            system_prompt_template: "game-live-translation-cn".to_string(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: vec![],
            scene_model_assignments: vec![],
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    fn realtime_provider(base_url: String) -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: "template-dashscope-realtime".to_string(),
            provider_id: "provider-dashscope-realtime".to_string(),
            kind: "dashscope".to_string(),
            display_name: "DashScope Realtime".to_string(),
            model: "qwen3.5-omni-plus-realtime".to_string(),
            base_url,
            transport: "websocket".to_string(),
            auth_ref: ProviderAuthRefInput {
                kind: "credential-ref".to_string(),
                reference: "none".to_string(),
                header_name: "Authorization".to_string(),
                scheme: "none".to_string(),
            },
            region: Some("cn-beijing".to_string()),
            stream_enabled: true,
            timeout_ms: 5_000,
            system_prompt_template: "game-live-translation-cn".to_string(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: vec![],
            scene_model_assignments: vec![],
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    #[test]
    fn openai_streaming_smoke_collects_delta_events() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":4}}\n\n",
        "data: [DONE]\n\n"
      );
            write_http_response(&mut stream, "text/event-stream", body);
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(format!("http://{}", addr)),
            "你好，世界".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert!(smoke.stream_observed);
        assert_eq!(smoke.transcript, "Hello world");
        assert!(smoke
            .event_log
            .iter()
            .any(|item| item.event_type == "translation.delta"));
        assert!(smoke
            .event_log
            .iter()
            .any(|item| item.event_type == "response.completed"));
    }

    #[test]
    fn openai_streaming_smoke_reads_array_content_delta() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"你\"}]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"好\"}]}}]}\n\n",
                "data: [DONE]\n\n"
            );
            write_http_response(&mut stream, "text/event-stream", body);
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(format!("http://{}", addr)),
            "hello".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert_eq!(smoke.transcript, "你好");
        assert!(smoke.stream_observed);
    }

    #[test]
    fn openai_streaming_smoke_extracts_reasoning_translation() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Thinking Process:\\n\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Decision: 这是一艘价值十亿美元的火箭飞船。\"}}]}\n\n",
                "data: [DONE]\n\n"
            );
            write_http_response(&mut stream, "text/event-stream", body);
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(format!("http://{}", addr)),
            "Project Aurora has a one billion dollar reliability fund.".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert_eq!(smoke.transcript, "这是一艘价值十亿美元的火箭飞船。");
        assert!(smoke.stream_observed);
    }

    #[test]
    fn dashscope_websocket_smoke_reads_text_frames() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            let mut websocket = accept(stream).expect("websocket should be accepted");
            let _ = websocket.read().expect("request payload should arrive");
            websocket
                .send(Message::Text(
                    "{\"event\":{\"textDelta\":\"Realtime \"}}"
                        .to_string()
                        .into(),
                ))
                .expect("delta frame should send");
            websocket
        .send(Message::Text(
          "{\"event\":{\"textDelta\":\"translation\",\"type\":\"response.completed\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}"
            .to_string()
            .into(),
        ))
        .expect("completion frame should send");
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            dashscope_provider(format!("ws://{}/ws", addr)),
            "你好，世界".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert!(smoke.stream_observed);
        assert_eq!(smoke.transcript, "Realtime translation");
        assert_eq!(smoke.input_tokens, Some(10));
        assert_eq!(smoke.output_tokens, Some(2));
    }

    #[test]
    fn realtime_websocket_smoke_uses_realtime_api_protocol() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            let mut websocket = accept(stream).expect("websocket should be accepted");
            let _ = websocket.read().expect("session.update should arrive");
            let _ = websocket
                .read()
                .expect("conversation.item.create should arrive");
            let _ = websocket.read().expect("response.create should arrive");
            websocket
                .send(Message::Text(
                    "{\"type\":\"session.created\",\"session\":{\"id\":\"sess_1\"}}"
                        .to_string()
                        .into(),
                ))
                .expect("session.created should send");
            websocket
                .send(Message::Text(
                    "{\"type\":\"response.text.delta\",\"delta\":\"Hello\"}"
                        .to_string()
                        .into(),
                ))
                .expect("first delta should send");
            websocket
                .send(Message::Text(
                    "{\"type\":\"response.text.delta\",\"delta\":\" world\"}"
                        .to_string()
                        .into(),
                ))
                .expect("second delta should send");
            websocket
        .send(Message::Text(
          "{\"type\":\"response.done\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":4}}}"
            .to_string()
            .into(),
        ))
        .expect("response.done should send");
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            realtime_provider(format!("ws://{}/ws", addr)),
            "你好，世界".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert!(smoke.stream_observed);
        assert_eq!(smoke.transcript, "Hello world");
        assert_eq!(smoke.input_tokens, Some(12));
        assert_eq!(smoke.output_tokens, Some(4));
        assert!(smoke
            .event_log
            .iter()
            .any(|item| item.event_type == "translation.delta"));
        assert!(smoke
            .event_log
            .iter()
            .any(|item| item.event_type == "translation.completed"));
        assert!(smoke
            .event_log
            .iter()
            .any(|item| item.event_type == "response.completed"));
    }

    #[test]
    fn dashscope_realtime_audio_synthesis_reads_audio_delta() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            let mut websocket = accept(stream).expect("websocket should be accepted");
            let session = websocket.read().expect("session.update should arrive");
            let item = websocket
                .read()
                .expect("conversation.item.create should arrive");
            let response = websocket.read().expect("response.create should arrive");
            assert!(session
                .to_text()
                .unwrap()
                .contains("\"modalities\":[\"text\",\"audio\"]"));
            assert!(item.to_text().unwrap().contains("你好，世界。"));
            assert!(response.to_text().unwrap().contains("response.create"));
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&1000_i16.to_le_bytes());
            bytes.extend_from_slice(&(-1000_i16).to_le_bytes());
            let delta = BASE64_STANDARD.encode(bytes);
            websocket
                .send(Message::Text(
                    format!("{{\"type\":\"response.audio.delta\",\"delta\":\"{delta}\"}}").into(),
                ))
                .expect("audio delta should send");
            websocket
                .send(Message::Text(
                    "{\"type\":\"response.audio.done\"}".to_string().into(),
                ))
                .expect("audio done should send");
        });

        let gateway = ProviderGateway::new();
        let synthesis = gateway
            .synthesize_realtime_audio(
                realtime_provider(format!("ws://{}/ws", addr)),
                "你好，世界。".to_string(),
                "zh-CN".to_string(),
                "Ethan".to_string(),
            )
            .expect("realtime audio should synthesize");

        assert_eq!(synthesis.audio.sample_rate_hz, 24_000);
        assert_eq!(synthesis.audio.channel_count, 1);
        assert_eq!(synthesis.audio.pcm_i16, vec![1000, -1000]);
        assert!(synthesis
            .event_log
            .iter()
            .any(|item| item.event_type == "realtime-audio.completed"));
    }

    #[test]
    fn dashscope_websocket_url_uses_documented_realtime_endpoint() {
        let url = to_websocket_url(
            "https://dashscope.aliyuncs.com/api/v1",
            "qwen3-livetranslate-flash-realtime",
        )
        .expect("dashscope websocket url should be generated");

        assert_eq!(
      url.as_str(),
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-livetranslate-flash-realtime"
    );
    }

    #[test]
    fn probe_marks_high_latency_as_realtime_risk() {
        let routing = build_routing_decision("realtime-risk", 1800, false);

        assert_eq!(routing.subtitle_priority, "subtitle-first");
        assert_eq!(routing.speech_disposition, "deferred");
    }

    #[test]
    fn openai_model_catalog_reads_models_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            write_http_response(
                &mut stream,
                "application/json",
                r#"{"data":[{"id":"gpt-4.1","owned_by":"openai"},{"id":"gpt-4o-realtime-preview","owned_by":"openai"}]}"#,
            );
        });

        let gateway = ProviderGateway::new();
        let catalog = gateway.fetch_models(openai_provider(format!("http://{}", addr)));

        assert!(catalog.error.is_none());
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[1].id, "gpt-4o-realtime-preview");
        assert!(catalog.models[1]
            .capabilities
            .iter()
            .any(|item| item == "speech-to-speech"));
        assert!(catalog.models[1]
            .capabilities
            .iter()
            .any(|item| item == "speech-to-text"));
    }

    #[test]
    fn openrouter_model_catalog_reads_openai_compatible_models_endpoint() {
        let endpoint = crate::provider::gateway_parts::models::resolve_models_endpoint(&ProviderDraftInput {
            kind: "openrouter".to_string(),
            base_url: "https://openrouter.ai/api/v1/models".to_string(),
            ..openai_provider("https://openrouter.ai/api/v1".to_string())
        })
        .expect("models endpoint should resolve");

        assert_eq!(endpoint, "https://openrouter.ai/api/v1/models");
        assert_eq!(
            crate::provider::gateway_parts::models::derive_model_capabilities("nvidia/parakeet-tdt-0.6b-v3"),
            vec!["speech-to-text".to_string()]
        );
        assert_eq!(
            crate::provider::gateway_parts::models::derive_model_capabilities("openai/gpt-audio"),
            vec!["text-to-speech".to_string(), "speech-to-speech".to_string()]
        );
    }

    #[test]
    fn dashscope_model_catalog_switches_to_compatible_mode_endpoint() {
        let endpoint = crate::provider::gateway_parts::models::resolve_models_endpoint(&dashscope_provider(
            "https://dashscope.aliyuncs.com/api/v1".to_string(),
        ))
        .expect("models endpoint should resolve");

        assert_eq!(
            endpoint,
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
    }

    #[test]
    fn unsupported_transport_falls_back_to_supported_mode() {
        let mut provider = dashscope_provider("http://127.0.0.1:8080/api/v1".to_string());
        provider.transport = "streaming-http".to_string();

        let (effective_transport, fallback_applied) = resolve_transport(&provider);

        assert_eq!(effective_transport, "http");
        assert!(fallback_applied);
    }

    #[test]
    fn openai_error_response_is_normalized_for_auth_failures() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            write_http_error_response(
                &mut stream,
                401,
                "application/json",
                r#"{"error":{"code":"invalid_api_key","message":"token expired"}}"#,
            );
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(format!("http://{}", addr)),
            "你好，世界".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );

        let error = smoke.error.expect("error should be normalized");
        assert_eq!(smoke.status, "failed");
        assert_eq!(error.code, "auth.invalid");
        assert_eq!(error.http_status, Some(401));
        assert_eq!(error.provider_code.as_deref(), Some("invalid_api_key"));
        assert!(error
            .suggestion
            .as_deref()
            .unwrap_or_default()
            .contains("Credential Manager"));
    }

    #[test]
    fn dashscope_error_response_is_normalized_for_rate_limits() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            write_http_error_response(
                &mut stream,
                429,
                "application/json",
                r#"{"code":"RateQuotaExceeded","message":"too many requests"}"#,
            );
        });

        let mut provider = dashscope_provider(format!("http://{}", addr));
        provider.transport = "http".to_string();
        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            provider,
            "你好，世界".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );

        let error = smoke.error.expect("error should be normalized");
        assert_eq!(smoke.status, "failed");
        assert_eq!(error.code, "rate-limited");
        assert!(error.retriable);
        assert_eq!(error.http_status, Some(429));
        assert_eq!(error.provider_code.as_deref(), Some("RateQuotaExceeded"));
    }

    fn read_http_request(stream: &mut TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().expect("stream clone should succeed"));
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("http request line should be readable");
            if line == "\r\n" || line.is_empty() {
                break;
            }
        }
    }

    fn write_http_response(stream: &mut TcpStream, content_type: &str, body: &str) {
        let response = format!(
      "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
      body.len(),
      body,
    );
        stream
            .write_all(response.as_bytes())
            .expect("http response should write");
        stream.flush().expect("http response should flush");
    }

    fn write_http_error_response(
        stream: &mut TcpStream,
        status: u16,
        content_type: &str,
        body: &str,
    ) {
        let response = format!(
      "HTTP/1.1 {status} ERROR\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
      body.len(),
      body,
    );
        stream
            .write_all(response.as_bytes())
            .expect("http error response should write");
        stream.flush().expect("http error response should flush");
    }

    #[test]
    fn openai_tts_request_reports_disabled_http_tts() {
        let gateway = ProviderGateway::new();
        let error = gateway
            .synthesize_tts(
                openai_provider("http://127.0.0.1:1".to_string()),
                "字幕优先后的译音请求".to_string(),
                "zh-CN".to_string(),
                "voice-cn-neutral".to_string(),
            )
            .expect_err("HTTP TTS should stay disabled in favor of Omni realtime audio");

        assert_eq!(error.code, "tts.disabled");
        assert!(error.message.contains("Omni Realtime"));
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LlmIntegrationConfig {
        providers: Vec<LlmIntegrationProviderConfig>,
        audio_test_file: Option<String>,
        audio: Option<LlmIntegrationProviderConfig>,
        environment: Option<HashMap<String, String>>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LlmIntegrationProviderConfig {
        name: String,
        template_id: String,
        provider_id: String,
        kind: String,
        model: String,
        base_url: String,
        transport: String,
        api_key_env: String,
        auth_header_name: Option<String>,
        auth_scheme: Option<String>,
        smoke: Option<LlmIntegrationSmokeConfig>,
        test_file: Option<String>,
        expected_source_chars: Option<usize>,
        expected_translation_chars: Option<usize>,
        catalog: Option<LlmIntegrationCatalogConfig>,
        probe: Option<LlmIntegrationProbeConfig>,
        speech: Option<LlmIntegrationSpeechConfig>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LlmIntegrationSmokeConfig {
        source_text: String,
        source_language: String,
        target_language: String,
        expected_transcript_chars: Option<usize>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LlmIntegrationCatalogConfig {
        enabled: bool,
        expected_model_id: Option<String>,
        minimum_model_count: Option<usize>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LlmIntegrationProbeConfig {
        enabled: bool,
        allowed_verdicts: Option<Vec<String>>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LlmIntegrationSpeechConfig {
        enabled: bool,
        text: Option<String>,
        target_language: Option<String>,
        voice: Option<String>,
        minimum_pcm_samples: Option<usize>,
    }

    fn load_llm_integration_config() -> LlmIntegrationConfig {
        let path = std::env::var("OMNI_LLM_TEST_CONFIG").unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../scripts/testing/llm-integration.config.json")
                .to_string_lossy()
                .to_string()
        });
        let raw = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "failed to read LLM integration config at {path}: {error}. \
                 Set OMNI_LLM_TEST_CONFIG or create scripts/testing/llm-integration.config.json"
            )
        });
        let config = parse_llm_integration_config(&raw).unwrap_or_else(|error| {
            panic!("invalid LLM integration config JSON at {path}: {error}")
        });
        if let Some(environment) = &config.environment {
            for (name, value) in environment {
                if std::env::var_os(name).is_none()
                    && !value.is_empty()
                    && !(value.starts_with('<') && value.ends_with('>'))
                {
                    std::env::set_var(name, value);
                }
            }
        }
        config
    }

    fn parse_llm_integration_config(raw: &str) -> Result<LlmIntegrationConfig, serde_json::Error> {
        serde_json::from_str(raw.trim_start_matches('\u{feff}'))
    }

    fn provider_from_integration_config(
        config: &LlmIntegrationProviderConfig,
    ) -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: config.template_id.clone(),
            provider_id: config.provider_id.clone(),
            kind: config.kind.clone(),
            display_name: config.name.clone(),
            model: config.model.clone(),
            base_url: config.base_url.clone(),
            transport: config.transport.clone(),
            auth_ref: ProviderAuthRefInput {
                kind: "env-ref".to_string(),
                reference: config.api_key_env.clone(),
                header_name: config
                    .auth_header_name
                    .clone()
                    .unwrap_or_else(|| "Authorization".to_string()),
                scheme: config
                    .auth_scheme
                    .clone()
                    .unwrap_or_else(|| "bearer".to_string()),
            },
            region: None,
            stream_enabled: true,
            timeout_ms: 30_000,
            system_prompt_template: "video-realtime-cn".to_string(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: vec![],
            scene_model_assignments: vec![],
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    fn realtime_audio_provider_from_integration_config(
        config: &LlmIntegrationProviderConfig,
    ) -> ProviderDraftInput {
        let mut provider = provider_from_integration_config(config);
        provider.response_modalities = vec!["text".to_string(), "audio".to_string()];
        provider.system_prompt_template = "audio-realtime-integration".to_string();
        provider.timeout_ms = 120_000;
        provider
    }

    fn decode_audio_file_to_mono_16k(path: &str) -> Vec<i16> {
        if path.to_ascii_lowercase().ends_with(".mp3") {
            return decode_mp3_file_to_mono_16k(path);
        }

        let file = fs::File::open(path).unwrap_or_else(|error| {
            panic!("failed to open integration audio file {path}: {error}")
        });
        let decoder = Decoder::new(BufReader::new(file)).unwrap_or_else(|error| {
            panic!("failed to decode integration audio file {path}: {error}")
        });
        let channels = decoder.channels().get().max(1) as usize;
        let sample_rate = decoder.sample_rate().get().max(1);
        let samples: Vec<f32> = decoder.collect();
        let mono: Vec<f32> = samples
            .chunks(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / frame.len().max(1) as f32)
            .collect();

        resample_mono_to_16k_i16(&mono, sample_rate)
    }

    fn decode_mp3_file_to_mono_16k(path: &str) -> Vec<i16> {
        let file = fs::File::open(path)
            .unwrap_or_else(|error| panic!("failed to open integration MP3 file {path}: {error}"));
        let mut decoder = minimp3::Decoder::new(file);
        let mut mono = Vec::new();
        let mut sample_rate: Option<u32> = None;

        loop {
            match decoder.next_frame() {
                Ok(frame) => {
                    sample_rate.get_or_insert(frame.sample_rate.max(1) as u32);
                    let channels = frame.channels.max(1);
                    mono.extend(frame.data.chunks(channels).map(|frame| {
                        frame
                            .iter()
                            .copied()
                            .map(|sample| sample as f32 / i16::MAX as f32)
                            .sum::<f32>()
                            / frame.len().max(1) as f32
                    }));
                }
                Err(minimp3::Error::Eof) => break,
                Err(error) => panic!("failed to decode integration MP3 file {path}: {error}"),
            }
        }

        resample_mono_to_16k_i16(&mono, sample_rate.unwrap_or(16_000))
    }

    fn resample_mono_to_16k_i16(samples: &[f32], source_rate: u32) -> Vec<i16> {
        const TARGET_RATE: u32 = 16_000;
        if samples.is_empty() {
            return Vec::new();
        }

        let target_len =
            ((samples.len() as u64 * TARGET_RATE as u64) / source_rate.max(1) as u64).max(1);
        let ratio = source_rate as f64 / TARGET_RATE as f64;
        (0..target_len as usize)
            .map(|index| {
                let source_pos = index as f64 * ratio;
                let left_index = source_pos.floor() as usize;
                let right_index = (left_index + 1).min(samples.len() - 1);
                let fraction = (source_pos - left_index as f64) as f32;
                let sample =
                    samples[left_index] * (1.0 - fraction) + samples[right_index] * fraction;
                (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
            })
            .collect()
    }

    fn encode_pcm_i16_base64(samples: &[i16]) -> String {
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        BASE64_STANDARD.encode(bytes)
    }

    fn run_realtime_audio_file_integration(
        provider: ProviderDraftInput,
        audio_path: &str,
    ) -> Result<(String, String, u32), ProviderRuntimeError> {
        let samples = decode_audio_file_to_mono_16k(audio_path);
        if samples.is_empty() {
            return Err(ProviderRuntimeError::new(
                "request.invalid",
                format!("integration audio file decoded to zero samples: {audio_path}"),
            ));
        }

        let (mut socket, websocket_timeout) =
            WebSocketTransport::default().connect_provider(&provider)?;

        let request_id = format!("audio-integration-{}", now_marker());
        let safe_id = request_id.replace([':', '-'], "_");
        let session_update = json!({
            "event_id": format!("evt_{}_session", safe_id),
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "voice": "Ethan",
                "instructions": "Transcribe the input audio and translate it to Chinese. Keep the response concise.",
                "input_audio_format": "pcm16",
                "sample_rate": 16000,
                "output_audio_format": "pcm",
                "turn_detection": null
            }
        });
        socket
            .send(Message::Text(session_update.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("realtime audio session.update failed: {error}"),
                )
            })?;

        let mut session_ready = false;
        let ready_started = Instant::now();
        while ready_started.elapsed() < Duration::from_secs(20) {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    let value: Value = serde_json::from_str(text.as_str()).map_err(|error| {
                        ProviderRuntimeError::new(
                            "response.unparseable",
                            format!("failed to parse realtime audio event: {error}"),
                        )
                    })?;
                    match value["type"].as_str() {
                        Some("session.updated") => {
                            session_ready = true;
                            break;
                        }
                        Some("error") => {
                            return Err(ProviderRuntimeError::new(
                                "response.error",
                                format!("realtime audio session error: {}", value["error"]),
                            ));
                        }
                        _ => {}
                    }
                }
                Ok(Message::Close(_)) => {
                    return Err(ProviderRuntimeError::new(
                        "transport.unavailable",
                        "realtime audio websocket closed before session.updated",
                    ));
                }
                Err(error) => return Err(normalize_websocket_read_error(error, websocket_timeout)),
                _ => {}
            }
        }
        assert!(
            session_ready,
            "realtime audio session.updated was not received"
        );

        for (index, chunk) in samples.chunks(320).enumerate() {
            let append = json!({
                "event_id": format!("evt_{}_audio_{}", safe_id, index),
                "type": "input_audio_buffer.append",
                "audio": encode_pcm_i16_base64(chunk)
            });
            socket
                .send(Message::Text(append.to_string().into()))
                .map_err(|error| {
                    ProviderRuntimeError::new(
                        "transport.unavailable",
                        format!("realtime audio append failed at chunk {index}: {error}"),
                    )
                })?;
            thread::sleep(Duration::from_millis(18));
        }

        socket
            .send(Message::Text(
                json!({
                    "event_id": format!("evt_{}_commit", safe_id),
                    "type": "input_audio_buffer.commit"
                })
                .to_string()
                .into(),
            ))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("realtime audio commit failed: {error}"),
                )
            })?;
        socket
            .send(Message::Text(
                json!({
                    "event_id": format!("evt_{}_response", safe_id),
                    "type": "response.create",
                    "response": { "modalities": ["text", "audio"] }
                })
                .to_string()
                .into(),
            ))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("realtime audio response.create failed: {error}"),
                )
            })?;

        let started = Instant::now();
        let mut source = String::new();
        let mut translation = String::new();
        let mut response_count = 0_u32;
        while started.elapsed() < Duration::from_secs(90) {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    let value: Value = serde_json::from_str(text.as_str()).map_err(|error| {
                        ProviderRuntimeError::new(
                            "response.unparseable",
                            format!("failed to parse realtime audio event: {error}"),
                        )
                    })?;
                    match value["type"].as_str() {
                        Some("conversation.item.input_audio_transcription.completed") => {
                            source = value["transcript"].as_str().unwrap_or("").to_string();
                        }
                        Some("response.audio_transcript.delta") => {
                            translation.push_str(value["delta"].as_str().unwrap_or(""));
                        }
                        Some("response.audio_transcript.done") => {
                            if let Some(transcript) = value["transcript"].as_str() {
                                if !transcript.trim().is_empty() {
                                    translation = transcript.to_string();
                                }
                            }
                        }
                        Some("response.done") => {
                            response_count += 1;
                            break;
                        }
                        Some("error") => {
                            return Err(ProviderRuntimeError::new(
                                "response.error",
                                format!("realtime audio response error: {}", value["error"]),
                            ));
                        }
                        _ => {}
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(error) => return Err(normalize_websocket_read_error(error, websocket_timeout)),
                _ => {}
            }
        }

        let _ = socket.close(None);
        Ok((source, translation, response_count))
    }

    #[test]
    fn llm_integration_provider_smoke_calls_configured_models() {
        let config = load_llm_integration_config();
        assert!(
            !config.providers.is_empty(),
            "LLM integration config must contain at least one provider"
        );

        let gateway = ProviderGateway::new();
        for provider_config in config.providers {
            assert!(
                std::env::var(&provider_config.api_key_env).is_ok(),
                "missing API key env var {} for {}",
                provider_config.api_key_env,
                provider_config.name
            );
            let smoke_config = provider_config.smoke.as_ref();
            let smoke = gateway.execute_smoke(
                provider_from_integration_config(&provider_config),
                smoke_config
                    .map(|item| item.source_text.clone())
                    .unwrap_or_else(|| "Hello, this is an integration test.".to_string()),
                smoke_config
                    .map(|item| item.source_language.clone())
                    .unwrap_or_else(|| "en".to_string()),
                smoke_config
                    .map(|item| item.target_language.clone())
                    .unwrap_or_else(|| "zh-CN".to_string()),
            );

            println!();
            println!("=== TEXT SMOKE RESULT for {} ===", provider_config.name);
            println!("  status:     {}", smoke.status);
            println!("  transcript: {}", smoke.transcript);
            println!("  char_count: {}", smoke.transcript.chars().count());
            println!("  duration:   {}ms", smoke.duration_ms);
            if let Some(ref err) = smoke.error {
                println!("  error:      {err:?}");
            }
            println!("  event_log ({} entries):", smoke.event_log.len());
            for event in &smoke.event_log {
                println!("    - {}: {}", event.event_type, event.summary);
            }
            println!("=== END TEXT SMOKE ===");
            println!();

            assert!(
                smoke.error.is_none(),
                "provider {} failed smoke test: {:?}",
                provider_config.name,
                smoke.error
            );
            assert_eq!(smoke.status, "completed");
            let transcript_len = smoke.transcript.chars().count();
            if let Some(expected) = provider_config
                .smoke
                .as_ref()
                .and_then(|s| s.expected_transcript_chars)
            {
                let lower = (expected as f64 * 0.7).ceil() as usize;
                let upper = (expected as f64 * 1.3).floor() as usize;
                assert!(
                    transcript_len >= lower && transcript_len <= upper,
                    "provider {} transcript chars {} outside ±30% of expected {} (range {}-{})",
                    provider_config.name,
                    transcript_len,
                    expected,
                    lower,
                    upper
                );
            } else {
                assert!(
                    transcript_len >= 5,
                    "provider {} returned too few chars in transcript: {} (need >= 5)",
                    provider_config.name,
                    transcript_len
                );
            }
            assert!(
                smoke
                    .event_log
                    .iter()
                    .any(|item| item.event_type == "translation.completed"),
                "provider {} did not emit translation.completed",
                provider_config.name
            );

            if provider_config
                .catalog
                .as_ref()
                .map(|item| item.enabled)
                .unwrap_or(false)
            {
                let catalog_config = provider_config.catalog.as_ref().unwrap();
                let catalog =
                    gateway.fetch_models(provider_from_integration_config(&provider_config));
                println!("=== MODEL CATALOG RESULT for {} ===", provider_config.name);
                println!("  endpoint:    {}", catalog.endpoint);
                println!("  model_count: {}", catalog.models.len());
                println!("=== END MODEL CATALOG ===");
                assert!(
                    catalog.error.is_none(),
                    "provider {} failed model catalog test: {:?}",
                    provider_config.name,
                    catalog.error
                );
                assert!(
                    catalog.models.len() >= catalog_config.minimum_model_count.unwrap_or(1),
                    "provider {} returned too few models: {}",
                    provider_config.name,
                    catalog.models.len()
                );
                if let Some(expected_model_id) = catalog_config.expected_model_id.as_deref() {
                    assert!(
                        catalog
                            .models
                            .iter()
                            .any(|item| item.id == expected_model_id),
                        "provider {} model catalog did not contain {}",
                        provider_config.name,
                        expected_model_id
                    );
                }
            }

            if provider_config
                .probe
                .as_ref()
                .map(|item| item.enabled)
                .unwrap_or(false)
            {
                let probe_config = provider_config.probe.as_ref().unwrap();
                let probe = gateway.probe(provider_from_integration_config(&provider_config));
                println!("=== PROVIDER PROBE RESULT for {} ===", provider_config.name);
                println!("  verdict:     {}", probe.verdict);
                println!("  latency_ms:  {}", probe.measured_latency_ms);
                println!("=== END PROVIDER PROBE ===");
                assert!(
                    probe.error.is_none(),
                    "provider {} failed provider probe: {:?}",
                    provider_config.name,
                    probe.error
                );
                assert!(probe.response_shape_stable);
                assert!(probe.stream_supported);
                let allowed_verdicts = probe_config
                    .allowed_verdicts
                    .clone()
                    .unwrap_or_else(|| vec!["available".to_string(), "realtime-risk".to_string()]);
                assert!(
                    allowed_verdicts.iter().any(|item| item == &probe.verdict),
                    "provider {} probe verdict {} not in {:?}",
                    provider_config.name,
                    probe.verdict,
                    allowed_verdicts
                );
            }
        }

        if let Some(audio_config) = config.audio {
            assert!(
                std::env::var(&audio_config.api_key_env).is_ok(),
                "missing API key env var {} for {}",
                audio_config.api_key_env,
                audio_config.name
            );
            let audio_path = audio_config
                .test_file
                .as_deref()
                .or(config.audio_test_file.as_deref())
                .expect("audio integration config must set audio.testFile or audioTestFile");
            assert!(
                PathBuf::from(audio_path).exists(),
                "audio integration test file does not exist: {}",
                audio_path
            );
            let (source, translation, response_count) = run_realtime_audio_file_integration(
                realtime_audio_provider_from_integration_config(&audio_config),
                audio_path,
            )
            .unwrap_or_else(|error| {
                panic!(
                    "provider {} failed realtime audio integration test with {}: {:?}",
                    audio_config.name, audio_path, error
                )
            });

            println!();
            println!("=== AUDIO REALTIME RESULT for {} ===", audio_config.name);
            println!("  source:         {:?}", source);
            println!("  source_chars:   {}", source.chars().count());
            println!("  translation:    {:?}", translation);
            println!("  translation_chars: {}", translation.chars().count());
            println!("  response_count: {}", response_count);
            println!("=== END AUDIO REALTIME ===");
            println!();

            let source_len = source.chars().count();
            let translation_len = translation.chars().count();
            assert!(
                response_count >= 1,
                "provider {} did not receive response.done for {}",
                audio_config.name,
                audio_path
            );

            if let Some(expected) = audio_config.expected_source_chars {
                let lower = (expected as f64 * 0.7).ceil() as usize;
                let upper = (expected as f64 * 1.3).floor() as usize;
                assert!(
                    source_len >= lower && source_len <= upper,
                    "provider {} audio transcription chars {} outside ±30% of expected {} (range {}-{})",
                    audio_config.name, source_len, expected, lower, upper
                );
            } else {
                assert!(
                    source_len >= 50,
                    "provider {} returned too few chars in audio transcription: {} (need >= 50)",
                    audio_config.name,
                    source_len
                );
            }

            if let Some(expected) = audio_config.expected_translation_chars {
                let lower = (expected as f64 * 0.7).ceil() as usize;
                let upper = (expected as f64 * 1.3).floor() as usize;
                assert!(
                    translation_len >= lower && translation_len <= upper,
                    "provider {} audio translation chars {} outside ±30% of expected {} (range {}-{})",
                    audio_config.name, translation_len, expected, lower, upper
                );
            } else {
                assert!(
                    translation_len >= 20,
                    "provider {} returned too few chars in audio translation: {} (need >= 20)",
                    audio_config.name,
                    translation_len
                );
            }

            if audio_config
                .speech
                .as_ref()
                .map(|item| item.enabled)
                .unwrap_or(false)
            {
                let speech_config = audio_config.speech.as_ref().unwrap();
                let speech = gateway
                    .synthesize_realtime_audio(
                        realtime_audio_provider_from_integration_config(&audio_config),
                        speech_config
                            .text
                            .clone()
                            .unwrap_or_else(|| "Realtime speech integration test.".to_string()),
                        speech_config
                            .target_language
                            .clone()
                            .unwrap_or_else(|| "en-US".to_string()),
                        speech_config
                            .voice
                            .clone()
                            .unwrap_or_else(|| "Ethan".to_string()),
                    )
                    .unwrap_or_else(|error| {
                        panic!(
                            "provider {} failed realtime speech synthesis integration: {:?}",
                            audio_config.name, error
                        )
                    });
                println!("=== AUDIO SYNTHESIS RESULT for {} ===", audio_config.name);
                println!("  pcm_samples: {}", speech.audio.pcm_i16.len());
                println!("  audio_seconds: {}", speech.audio_seconds);
                println!("=== END AUDIO SYNTHESIS ===");
                assert!(
                    speech.audio.pcm_i16.len()
                        >= speech_config.minimum_pcm_samples.unwrap_or(1_600),
                    "provider {} returned too few realtime speech PCM samples: {}",
                    audio_config.name,
                    speech.audio.pcm_i16.len()
                );
                assert!(speech.audio_seconds > 0.0);
            }
        }
    }

    #[test]
    fn llm_integration_config_accepts_utf8_bom_and_optional_scenarios() {
        let config = parse_llm_integration_config(
            "\u{feff}{\"providers\":[{\"name\":\"text\",\"templateId\":\"template\",\"providerId\":\"provider\",\"kind\":\"openai-compatible\",\"model\":\"model\",\"baseUrl\":\"https://example.com/v1\",\"transport\":\"streaming-http\",\"apiKeyEnv\":\"API_KEY\",\"catalog\":{\"enabled\":true},\"probe\":{\"enabled\":true}}],\"audio\":{\"name\":\"audio\",\"templateId\":\"template-audio\",\"providerId\":\"provider-audio\",\"kind\":\"dashscope\",\"model\":\"audio-model\",\"baseUrl\":\"https://example.com/v1\",\"transport\":\"websocket\",\"apiKeyEnv\":\"API_KEY\",\"speech\":{\"enabled\":true}}}",
        )
        .expect("integration config with BOM should parse");

        assert_eq!(config.providers.len(), 1);
        assert!(config.providers[0].catalog.as_ref().unwrap().enabled);
        assert!(config.providers[0].probe.as_ref().unwrap().enabled);
        assert!(config.audio.unwrap().speech.as_ref().unwrap().enabled);
    }
}
