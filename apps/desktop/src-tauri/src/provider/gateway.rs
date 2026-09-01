use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde_json::json;

use crate::diagnostics::model_trace::ModelTraceRecorder;
use crate::shared::time::now_unix_millis_marker;

use super::contracts::{
    ProviderDraftInput, ProviderModelCatalogRuntime,
    ProviderProbeProfileRuntime, ProviderRoutingDecision,
    ProviderRuntimeError, ProviderSmokeResult, TtsSynthesisResult,
};
use super::connection_lease;
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
static NEXT_TRANSLATION_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn next_translation_request_id() -> String {
    let sequence = NEXT_TRANSLATION_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("req-{}-{}", now_unix_millis_marker(), sequence)
}

fn model_protocol_runtime_error(message: String) -> ProviderRuntimeError {
    let code = message
        .split_once(':')
        .map(|(code, _)| code)
        .filter(|code| code.starts_with("model_protocol."))
        .unwrap_or("model_protocol.authorization_failed")
        .to_string();
    ProviderRuntimeError::new(&code, message)
}

fn provider_manifest_runtime_error(message: String) -> ProviderRuntimeError {
    let code = message
        .split_once(':')
        .map(|(code, _)| code)
        .filter(|code| code.starts_with("provider_manifest."))
        .unwrap_or("provider_manifest.authorization_failed")
        .to_string();
    ProviderRuntimeError::new(&code, message)
}

fn provider_declares_bailian_voice_protocol(
    provider: &ProviderDraftInput,
    exact_model_id: &str,
) -> bool {
    // Provider/template defaults are not bound to the selected exact model.
    // Only an exact registry row may opt an otherwise unknown model into the
    // voice-protocol fail-closed boundary.
    provider
        .local_model_capability_registry
        .iter()
        .filter(|entry| entry.model_id.trim().eq_ignore_ascii_case(exact_model_id.trim()))
        .any(|entry| {
            entry.model_protocol_registry_version.is_some()
                || entry.model_protocol_profile_id.is_some()
                || entry.model_protocol_profile_version.is_some()
                || entry.capabilities.iter().any(|capability| {
                    matches!(
                        capability.as_str(),
                        "speech-to-speech" | "speech-to-text" | "text-to-speech"
                    )
                })
                || entry
                    .realtime_protocol
                    .as_deref()
                    .is_some_and(|protocol| protocol.trim().starts_with("dashscope-"))
        })
}

/// Central fail-closed authority check shared by provider and benchmark paid
/// boundaries. Exact manifest membership and explicit provider declarations
/// can require authorization; model-name patterns never grant authority.
pub(crate) fn authorize_bailian_model_operation_before_provider_access(
    provider: &ProviderDraftInput,
    exact_model_id: &str,
    operation: &str,
) -> Result<
    Option<crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile>,
    ProviderRuntimeError,
> {
    let profiles = crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(
        exact_model_id,
    )
    .map_err(|error| {
        ProviderRuntimeError::new(
            error.code(),
            format!(
                "{}: unable to inspect model protocol authority for '{}'",
                error.code(), exact_model_id
            ),
        )
    })?;
    let explicit_bailian_voice_protocol =
        provider_declares_bailian_voice_protocol(provider, exact_model_id);
    if profiles.is_empty() && !explicit_bailian_voice_protocol {
        return Ok(None);
    }
    if !provider.model.trim().eq_ignore_ascii_case(exact_model_id.trim()) {
        return Err(ProviderRuntimeError::new(
            "model_protocol.authorization_identity_mismatch",
            format!(
                "model_protocol.authorization_identity_mismatch: provider model '{}' does not match invocation model '{}'",
                provider.model, exact_model_id
            ),
        ));
    }
    if profiles.is_empty() {
        return Err(ProviderRuntimeError::new(
            "model_protocol.model_not_registered",
            format!(
                "model_protocol.model_not_registered: explicitly declared Bailian voice model '{}' has no exact manifest profile",
                exact_model_id
            ),
        ));
    }
    if provider.kind != "dashscope" {
        return Err(ProviderRuntimeError::new(
            "model_protocol.provider_family_mismatch",
            format!(
                "model_protocol.provider_family_mismatch: Bailian voice model '{}' requires provider kind 'dashscope', got '{}'",
                exact_model_id, provider.kind
            ),
        ));
    }
    crate::audio::events::authorize_bailian_model_operation(provider, exact_model_id, operation)
        .map(Some)
        .map_err(model_protocol_runtime_error)
}

#[derive(Clone)]
pub(crate) struct ProviderGateway {
    model_catalog: ModelCatalogService,
    probe_service: ProviderProbeService,
    openai_adapter: OpenAiProviderAdapter,
    dashscope_adapter: DashScopeProviderAdapter,
    realtime_audio: RealtimeAudioSynthesizer,
}

impl ProviderGateway {
    pub(crate) fn new() -> Self {
        Self {
            model_catalog: ModelCatalogService,
            probe_service: ProviderProbeService,
            openai_adapter: OpenAiProviderAdapter,
            dashscope_adapter: DashScopeProviderAdapter,
            realtime_audio: RealtimeAudioSynthesizer,
        }
    }

    pub(crate) fn translate_text_streaming_traced_with_glossary<F>(
        &self,
        provider: ProviderDraftInput,
        source_text: String,
        source_language: String,
        target_language: String,
        glossary_prompt: Option<&str>,
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

        let mut emitted_delta = false;
        let smoke = {
            let mut forward_delta = |delta: &str| {
                if delta.is_empty() {
                    return Ok(());
                }
                emitted_delta = true;
                on_delta(delta)
            };
            self.execute_smoke_with_delta(
                provider,
                source_text,
                source_language,
                target_language,
                glossary_prompt,
                false,
                &mut forward_delta,
            )
        };

        if let Some(error) = smoke.error.clone() {
            if let Some(trace_call) = trace_call.as_mut() {
                trace_call.error(format!("{}: {}", error.code, error.message));
            }
            return Err(error);
        }

        let result = (|| -> Result<String, ProviderRuntimeError> {
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

    pub(crate) fn fetch_models(&self, provider: ProviderDraftInput) -> ProviderModelCatalogRuntime {
        self.model_catalog.fetch(provider)
    }

    pub(crate) fn probe(&self, provider: ProviderDraftInput) -> ProviderProbeProfileRuntime {
        let mut discard_delta = discard_provider_delta;
        let smoke = self.execute_smoke_with_delta(
            provider.clone(),
            "请把这句中文翻译成英文，并保留语气自然。".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
            None,
            true,
            &mut discard_delta,
        );
        self.probe_service.evaluate(provider, smoke)
    }

    pub(crate) fn execute_smoke(
        &self,
        provider: ProviderDraftInput,
        source_text: String,
        source_language: String,
        target_language: String,
    ) -> ProviderSmokeResult {
        let mut discard_delta = discard_provider_delta;
        self.execute_smoke_with_delta(
            provider,
            source_text,
            source_language,
            target_language,
            None,
            false,
            &mut discard_delta,
        )
    }

    fn execute_smoke_with_delta(
        &self,
        mut provider: ProviderDraftInput,
        source_text: String,
        source_language: String,
        target_language: String,
        glossary_prompt: Option<&str>,
        livetranslate_session_probe: bool,
        on_delta: &mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>,
    ) -> ProviderSmokeResult {
        let request_id = next_translation_request_id();
        let transport_requested = provider.transport.clone();
        let (transport_effective, fallback_applied) = resolve_transport(&provider);
        let started_at = Instant::now();
        let bailian_authorization = authorize_bailian_model_operation_before_provider_access(
            &provider,
            &provider.model,
            "native_translate",
        );
        let manifest_authorization = crate::provider::provider_manifest::authorize_provider_operation(
            &provider,
            "text-translation",
        )
        .map_err(provider_manifest_runtime_error)
        .and_then(|authority| match authority {
            Some(authority) if authority.adapter_id == "openai-compatible-http" => Ok(Some(authority)),
            Some(authority) => Err(ProviderRuntimeError::new(
                "provider_manifest.adapter_mismatch",
                format!(
                    "provider_manifest.adapter_mismatch: text gateway cannot execute adapter '{}'",
                    authority.adapter_id
                ),
            )),
            None => Ok(None),
        });
        let boundary_authorization = bailian_authorization.and(manifest_authorization);
        let boundary_authorized = boundary_authorization.is_ok();
        if let Ok(Some(authority)) = boundary_authorization.as_ref() {
            provider = authority.provider_for_connection(&provider);
        }
        let connection_attempts = if boundary_authorized { 1 } else { 0 };
        let connection_lease = boundary_authorized.then(|| connection_lease::acquire(&provider));
        let (connection_owner, connection_generation) = connection_lease
            .as_ref()
            .and_then(|lease| lease.as_ref().ok())
            .and_then(|lease| lease.owner())
            .map(|owner| (Some(owner.label()), Some(owner.generation)))
            .unwrap_or((None, None));

        let execution = match boundary_authorization {
            Err(error) => Err(error),
            Ok(_) => match connection_lease.expect("authorized boundary must acquire a lease") {
            Err(error) => Err(error),
            Ok(_lease) => match provider.kind.as_str() {
            kind if is_openai_compatible_kind(kind) => self.openai_adapter.execute(
                &provider,
                &transport_effective,
                &request_id,
                &source_text,
                &source_language,
                &target_language,
                glossary_prompt,
                livetranslate_session_probe,
                on_delta,
            ),
            "dashscope" => self.dashscope_adapter.execute(
                &provider,
                &transport_effective,
                &request_id,
                &source_text,
                &source_language,
                &target_language,
                glossary_prompt,
                livetranslate_session_probe,
                on_delta,
            ),
            other => Err(ProviderRuntimeError::new(
                "request.invalid",
                format!("unsupported provider kind: {other}"),
            )),
            },
            },
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
                execution.connection_attempts = connection_attempts;
                execution.connection_owner = connection_owner;
                execution.connection_generation = connection_generation;
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
                connection_attempts,
                connection_count: 0,
                connection_opened: false,
                connection_closed: false,
                connection_owner,
                connection_generation,
                routing_decision: ProviderRoutingDecision::for_verdict(
                    "unavailable",
                    LATENCY_BUDGET_MS,
                    fallback_applied,
                ),
                error: Some(error),
                wire_evidence: None,
            },
        }
    }

    #[allow(dead_code, reason = "direct TTS gateway remains part of the provider contract while HTTP TTS is disabled")]
    pub(crate) fn synthesize_tts(
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

    pub(crate) fn synthesize_realtime_audio(
        &self,
        provider: ProviderDraftInput,
        text: String,
        target_language: String,
        voice: String,
    ) -> Result<TtsSynthesisResult, ProviderRuntimeError> {
        authorize_bailian_model_operation_before_provider_access(
            &provider,
            &provider.model,
            "tts",
        )?;
        self.realtime_audio
            .synthesize(provider, text, target_language, voice)
    }

}

fn discard_provider_delta(_: &str) -> Result<(), ProviderRuntimeError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;
    use crate::provider::contracts::ProviderAuthRefInput;
    use crate::shared::time::now_unix_seconds_marker;
    use crate::provider::gateway_parts::transport::{
        build_client, normalize_transport_error, normalize_websocket_read_error,
        redirect_target_is_same_origin, set_test_websocket_connect_override, to_websocket_url,
        WebSocketTransport,
    };
    use rodio::{Decoder, Source};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use sha2::Digest;
    use std::collections::HashMap;
    use std::fs;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;
    use tungstenite::{accept, Message};
    use url::Url;

    /// Build a `ProviderDraftInput` for tests, filling in the auth/tuning fields
    /// that every fixture shares (credential-ref auth, streaming enabled, 5s
    /// timeout, text modality) so each provider helper only names the fields
    /// that actually distinguish it.
    #[allow(clippy::too_many_arguments)]
    fn provider_draft(
        template_id: &str,
        provider_id: &str,
        kind: &str,
        display_name: &str,
        model: &str,
        base_url: String,
        transport: &str,
        region: Option<String>,
        system_prompt_template: &str,
    ) -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: template_id.to_string(),
            provider_id: provider_id.to_string(),
            manifest_provider_id: None,
            kind: kind.to_string(),
            template_realtime_protocol: None,
            realtime_protocol: None,
            display_name: display_name.to_string(),
            model: model.to_string(),
            deployment_id: None,
            base_url,
            transport: transport.to_string(),
            auth_ref: ProviderAuthRefInput {
                kind: "credential-ref".to_string(),
                reference: "none".to_string(),
                header_name: "Authorization".to_string(),
                scheme: "none".to_string(),
            },
            region,
            stream_enabled: true,
            timeout_ms: 5_000,
            system_prompt_template: system_prompt_template.to_string(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: vec![],
            scene_model_assignments: vec![],
            model_protocol_bindings: vec![],
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    fn openai_provider(base_url: String) -> ProviderDraftInput {
        provider_draft(
            "template-test-openai-compatible",
            "provider-openai-compatible",
            "openai-compatible",
            "OpenAI Compatible",
            "test-model",
            base_url,
            "streaming-http",
            None,
            "video-realtime-cn",
        )
    }

    fn dashscope_provider(base_url: String) -> ProviderDraftInput {
        let mut provider = provider_draft(
            "template-dashscope-realtime",
            "provider-dashscope",
            "dashscope",
            "DashScope",
            "qwen-live",
            base_url,
            "websocket",
            Some("cn-beijing".to_string()),
            "game-live-translation-cn",
        );
        provider.realtime_protocol = Some("dashscope-omni".to_string());
        provider
    }

    fn dashscope_text_provider(base_url: String) -> ProviderDraftInput {
        let mut provider = dashscope_provider(base_url);
        provider.model = "qwen-plus".to_string();
        provider.transport = "http".to_string();
        provider.realtime_protocol = None;
        provider.local_model_capability_registry = vec![serde_json::from_value(json!({
            "id": "seed-qwen-plus",
            "modelId": "qwen-plus",
            "capabilities": ["text-generation"],
            "realtimeAudioMode": "server_vad",
            "interactionCapabilities": [],
            "source": "official"
        }))
        .expect("explicit DashScope text model registry fixture must deserialize")];
        provider
    }

    fn declare_exact_unknown_bailian_voice_model(provider: &mut ProviderDraftInput) {
        provider.realtime_protocol = None;
        provider.local_model_capability_registry = vec![serde_json::from_value(json!({
            "id": "custom-unknown-bailian-voice",
            "modelId": provider.model,
            "capabilities": ["speech-to-speech"],
            "realtimeProtocol": "dashscope-omni",
            "realtimeAudioMode": "server_vad",
            "interactionCapabilities": ["streaming", "auto_vad"],
            "source": "custom"
        }))
        .expect("exact unknown Bailian voice registry fixture must deserialize")];
    }

    fn realtime_provider(base_url: String) -> ProviderDraftInput {
        let mut provider = provider_draft(
            "template-dashscope-realtime",
            "provider-dashscope-realtime",
            "dashscope",
            "DashScope Realtime",
            "qwen3.5-omni-plus-realtime",
            base_url,
            "websocket",
            Some("cn-beijing".to_string()),
            "game-live-translation-cn",
        );
        provider.realtime_protocol = Some("dashscope-omni".to_string());
        provider
    }

    fn livetranslate_provider(base_url: String) -> ProviderDraftInput {
        set_test_websocket_connect_override(&base_url);
        let mut provider = provider_draft(
            "template-dashscope-realtime",
            "provider-dashscope",
            "dashscope",
            "DashScope LiveTranslate",
            "qwen3.5-livetranslate-flash-realtime",
            "https://dashscope.aliyuncs.com/api/v1".to_string(),
            "websocket",
            Some("cn-beijing".to_string()),
            "game-live-translation-cn",
        );
        provider.realtime_protocol = Some("dashscope-livetranslate".to_string());
        provider
    }

    fn openai_misrouted_bailian_provider(
        base_url: String,
        model: &str,
    ) -> ProviderDraftInput {
        let mut provider = provider_draft(
            "template-openai-compatible-realtime",
            "provider-openai-compatible-bailian-misroute",
            "openai-compatible",
            "Misrouted Bailian Voice",
            model,
            base_url,
            "streaming-http",
            Some("cn-beijing".to_string()),
            "game-live-translation-cn",
        );
        provider.realtime_protocol = Some("dashscope-livetranslate".to_string());
        provider
    }

    fn sha256_hex(value: &str) -> String {
        format!("{:x}", sha2::Sha256::digest(value.as_bytes()))
    }

    #[test]
    fn translation_request_ids_are_unique_for_concurrent_calls() {
        let first = next_translation_request_id();
        let second = next_translation_request_id();

        assert_ne!(first, second);
        assert!(first.starts_with("req-unix-ms:"));
        assert!(second.starts_with("req-unix-ms:"));
    }

    #[test]
    fn openai_streaming_smoke_collects_delta_events() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":4}}\n\n",
            "data: [DONE]\n\n"
        );
        let (base_url, _server) = spawn_http_server(move |stream| {
            write_http_response(stream, "text/event-stream", body);
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(base_url),
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
    fn openai_translation_forwards_delta_before_stream_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);

            let first_delta =
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n";
            let remainder = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
                "data: [DONE]\n\n"
            );
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                first_delta.len() + remainder.len()
            );
            stream
                .write_all(headers.as_bytes())
                .expect("http response headers should write");
            stream
                .write_all(first_delta.as_bytes())
                .expect("first delta should write");
            stream.flush().expect("first delta should flush");

            release_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("test should release the remaining response");
            stream
                .write_all(remainder.as_bytes())
                .expect("remaining response should write");
            stream.flush().expect("remaining response should flush");
        });

        let (delta_rx, client) = spawn_delta_forwarding_client(
            openai_provider(format!("http://{}", addr)),
            "hello",
            "en-US",
            "zh-CN",
        );

        assert_eq!(
            delta_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("first delta should arrive before the stream completes"),
            "Hello"
        );
        release_tx
            .send(())
            .expect("remaining response should be released");
        assert_eq!(
            delta_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("second delta should arrive"),
            " world"
        );
        assert_eq!(
            client
                .join()
                .expect("client thread should finish")
                .expect("translation should succeed"),
            "Hello world"
        );
        server.join().expect("server thread should finish");
    }

    #[test]
    fn openai_non_streaming_translation_forwards_final_text_once() {
        let (base_url, server) = spawn_http_server(|stream| {
            write_http_response(
                stream,
                "application/json",
                "{\"choices\":[{\"message\":{\"content\":\"Complete answer\"}}]}",
            );
        });

        let mut provider = openai_provider(base_url);
        provider.stream_enabled = false;
        let mut deltas = Vec::new();
        let result = ProviderGateway::new()
            .translate_text_streaming_traced_with_glossary(
                provider,
                "hello".to_string(),
                "en-US".to_string(),
                "zh-CN".to_string(),
                None,
                None,
                |delta| {
                    deltas.push(delta.to_string());
                    Ok(())
                },
            )
            .expect("non-streaming translation should succeed");

        assert_eq!(result, "Complete answer");
        assert_eq!(deltas, vec!["Complete answer"]);
        server.join().expect("server thread should finish");
    }

    #[test]
    fn openai_translation_sends_configured_glossary_in_system_prompt() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            let request_body = read_http_request_body(&mut stream);
            let request: Value =
                serde_json::from_str(&request_body).expect("request body should be JSON");
            let system_prompt = request
                .pointer("/messages/0/content")
                .and_then(Value::as_str)
                .expect("translation request should contain a system prompt");
            assert!(system_prompt.contains("\"GG\""));
            assert!(system_prompt.contains("\"好局\""));
            write_http_response(
                &mut stream,
                "application/json",
                "{\"choices\":[{\"message\":{\"content\":\"好局\"}}]}",
            );
        });

        let mut provider = openai_provider(format!("http://{}", addr));
        provider.stream_enabled = false;
        provider.transport = "http".to_string();
        let glossary = crate::audio::glossary::GlossaryCatalog::from_config(&json!({
            "glossary": {
                "processingMode": "inject-important",
                "libraries": [{
                    "enabled": true,
                    "entries": [{
                        "sourceLang": "en-US",
                        "targetLang": "zh-CN",
                        "sourceTerm": "GG",
                        "targetTerm": "好局",
                        "strategy": "force",
                        "important": true
                    }]
                }]
            }
        }))
        .for_languages("en-US", "zh-CN");
        let translated = ProviderGateway::new()
            .translate_text_streaming_traced_with_glossary(
                provider,
                "GG".to_string(),
                "en-US".to_string(),
                "zh-CN".to_string(),
                glossary.prompt(),
                None,
                |_| Ok(()),
            )
            .expect("translation should succeed");

        assert_eq!(translated, "好局");
        server.join().expect("server thread should finish");
    }

    #[test]
    fn openai_translation_stops_when_delta_callback_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
                "data: [DONE]\n\n"
            );
            write_http_response(&mut stream, "text/event-stream", body);
        });

        let mut callback_count = 0;
        let error = ProviderGateway::new()
            .translate_text_streaming_traced_with_glossary(
                openai_provider(format!("http://{}", addr)),
                "hello".to_string(),
                "en-US".to_string(),
                "zh-CN".to_string(),
                None,
                None,
                |_| {
                    callback_count += 1;
                    Err(ProviderRuntimeError::new(
                        "test.callback-failed",
                        "stop streaming",
                    ))
                },
            )
            .expect_err("callback failure should abort translation");

        assert_eq!(error.code, "test.callback-failed");
        assert_eq!(callback_count, 1);
        server.join().expect("server thread should finish");
    }

    #[test]
    fn openai_streaming_smoke_reads_array_content_delta() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"你\"}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"好\"}]}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let (base_url, _server) = spawn_http_server(move |stream| {
            write_http_response(stream, "text/event-stream", body);
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(base_url),
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
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Thinking Process:\\n\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Decision: 这是一艘价值十亿美元的火箭飞船。\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let (base_url, _server) = spawn_http_server(move |stream| {
            write_http_response(stream, "text/event-stream", body);
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(base_url),
            "Project Aurora has a one billion dollar reliability fund.".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert_eq!(smoke.transcript, "这是一艘价值十亿美元的火箭飞船。");
        assert!(smoke.stream_observed);
    }

    #[test]
    fn registered_bailian_voice_model_with_openai_kind_is_rejected_before_network() {
        let (base_url, attempts, stop, server) = spawn_counted_loopback_http_server();
        let smoke = ProviderGateway::new().execute_smoke(
            openai_misrouted_bailian_provider(
                base_url,
                "qwen3.5-livetranslate-flash-realtime",
            ),
            "hello".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );
        stop.store(true, AtomicOrdering::SeqCst);
        server.join().expect("counter server should stop");

        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
        let error = smoke
            .error
            .expect("cross-kind Bailian voice routing must fail closed");
        assert_eq!(error.code, "model_protocol.provider_family_mismatch");
    }

    #[test]
    fn registered_bailian_voice_model_with_wrong_transport_is_rejected_before_network() {
        let (base_url, attempts, stop, server) = spawn_counted_loopback_http_server();
        let mut provider = provider_draft(
            "template-dashscope-realtime",
            "provider-dashscope-wrong-transport",
            "dashscope",
            "DashScope Wrong Transport",
            "qwen3.5-livetranslate-flash-realtime",
            base_url,
            "http",
            Some("cn-beijing".to_string()),
            "game-live-translation-cn",
        );
        provider.realtime_protocol = Some("dashscope-livetranslate".to_string());
        let smoke = ProviderGateway::new().execute_smoke(
            provider,
            "hello".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );
        stop.store(true, AtomicOrdering::SeqCst);
        server.join().expect("counter server should stop");

        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
        let error = smoke
            .error
            .expect("wrong Bailian voice transport must fail closed");
        assert_eq!(error.code, "model_protocol.transport_mismatch");
    }

    #[test]
    fn registered_bailian_voice_model_with_wrong_operation_is_rejected_before_network() {
        let (base_url, attempts, stop, server) = spawn_counted_loopback_http_server();
        let mut provider = provider_draft(
            "template-dashscope-realtime",
            "provider-dashscope-wrong-operation",
            "dashscope",
            "DashScope Wrong Operation",
            "qwen3-tts-flash-realtime",
            base_url,
            "websocket",
            Some("cn-beijing".to_string()),
            "game-live-translation-cn",
        );
        provider.realtime_protocol = Some("dashscope-livetranslate".to_string());
        let smoke = ProviderGateway::new().execute_smoke(
            provider,
            "hello".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );
        stop.store(true, AtomicOrdering::SeqCst);
        server.join().expect("counter server should stop");

        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
        let error = smoke
            .error
            .expect("wrong Bailian voice operation must fail closed");
        assert_eq!(error.code, "model_protocol.operation_not_supported");
    }

    #[test]
    fn registered_bailian_voice_model_with_wrong_endpoint_is_rejected_before_network() {
        let (base_url, attempts, stop, server) = spawn_counted_loopback_http_server();
        let mut provider = provider_draft(
            "template-dashscope-realtime",
            "provider-dashscope-wrong-endpoint",
            "dashscope",
            "DashScope Wrong Endpoint",
            "qwen3.5-livetranslate-flash-realtime",
            base_url,
            "websocket",
            Some("cn-beijing".to_string()),
            "game-live-translation-cn",
        );
        provider.realtime_protocol = Some("dashscope-livetranslate".to_string());
        let smoke = ProviderGateway::new().execute_smoke(
            provider,
            "hello".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );
        stop.store(true, AtomicOrdering::SeqCst);
        server.join().expect("counter server should stop");

        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
        let error = smoke
            .error
            .expect("wrong Bailian voice endpoint must fail closed");
        assert_eq!(error.code, "model_protocol.endpoint_host_region_mismatch");
    }

    #[test]
    fn unknown_bailian_voice_snapshot_is_rejected_before_network() {
        let (base_url, attempts, stop, server) = spawn_counted_loopback_http_server();
        let mut provider = openai_misrouted_bailian_provider(
            base_url,
            "qwen3.5-livetranslate-flash-realtime-2099-12-31",
        );
        provider.realtime_protocol = None;
        provider.local_model_capability_registry = vec![serde_json::from_value(json!({
            "id": "custom-unknown-bailian-voice-snapshot",
            "modelId": "qwen3.5-livetranslate-flash-realtime-2099-12-31",
            "capabilities": ["speech-to-speech"],
            "realtimeAudioMode": "server_vad",
            "interactionCapabilities": [],
            "source": "custom"
        }))
        .expect("explicit voice capability fixture must deserialize")];
        let smoke = ProviderGateway::new().execute_smoke(
            provider,
            "hello".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );
        stop.store(true, AtomicOrdering::SeqCst);
        server.join().expect("counter server should stop");

        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
        let error = smoke
            .error
            .expect("unknown Bailian voice snapshot must fail closed");
        assert_eq!(error.code, "model_protocol.model_not_registered");
    }

    #[test]
    fn unknown_dashscope_websocket_model_is_rejected_before_connector_access() {
        let (base_url, attempts, stop, server) = spawn_counted_loopback_ws_server();
        let mut provider = dashscope_provider(base_url);
        declare_exact_unknown_bailian_voice_model(&mut provider);
        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            provider,
            "你好，世界".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );
        stop.store(true, AtomicOrdering::SeqCst);
        server.join().expect("WebSocket counter server should stop");

        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
        let error = smoke.error.expect("unknown model must fail closed");
        assert_eq!(smoke.status, "failed");
        assert_eq!(error.code, "model_protocol.model_not_registered");
        assert!(error.message.contains("model_protocol.model_not_registered"));
    }

    #[test]
    fn unknown_dashscope_streaming_model_emits_no_delta_before_rejection() {
        let mut provider = dashscope_provider("ws://127.0.0.1:9/api/v1".to_string());
        declare_exact_unknown_bailian_voice_model(&mut provider);
        let mut deltas = Vec::new();
        let error = ProviderGateway::new()
            .translate_text_streaming_traced_with_glossary(
                provider,
                "hello".to_string(),
                "en-US".to_string(),
                "zh-CN".to_string(),
                None,
                None,
                |delta| {
                    deltas.push(delta.to_string());
                    Ok(())
                },
            )
            .expect_err("unknown model must fail before streaming starts");
        assert_eq!(error.code, "model_protocol.model_not_registered");
        assert!(error.message.contains("model_protocol.model_not_registered"));
        assert!(deltas.is_empty());
    }

    #[test]
    fn dashscope_text_model_with_requested_websocket_uses_http_fallback() {
        let (base_url, server) = spawn_http_server(|stream| {
            write_http_response(
                stream,
                "application/json",
                r#"{"choices":[{"message":{"content":"HTTP fallback translation"}}]}"#,
            );
        });
        let mut provider = dashscope_text_provider(base_url);
        provider.transport = "websocket".to_string();
        provider.template_realtime_protocol = Some("dashscope-omni".to_string());

        let (effective_transport, fallback_applied) = resolve_transport(&provider);
        assert_eq!(effective_transport, "http");
        assert!(fallback_applied);

        let smoke = ProviderGateway::new().execute_smoke(
            provider,
            "hello".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert_eq!(smoke.transport_requested, "websocket");
        assert_eq!(smoke.transport_effective, "http");
        assert!(smoke.fallback_applied);
        assert_eq!(smoke.transcript, "HTTP fallback translation");
        server.join().expect("HTTP fallback server should stop");
    }

    #[test]
    fn manifest_only_omni_text_gateway_is_rejected_before_connector_access() {
        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            realtime_provider("https://dashscope.aliyuncs.com/api/v1".to_string()),
            "你好，世界".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );

        let error = smoke.error.expect("manifest-only Omni must fail closed");
        assert_eq!(smoke.status, "failed");
        assert_eq!(error.code, "model_protocol.adapter_unavailable");
        assert!(error.message.contains("model_protocol.adapter_unavailable"));
    }

    #[test]
    fn livetranslate_probe_uses_zero_audio_finish_lifecycle_in_wire_order() {
        let (ws_url, server) = spawn_ws_server(|websocket| {
            websocket
                .send(Message::Text(
                    r#"{"event_id":"evt_server_created","type":"session.created","session":{"id":"session-test","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}}"#
                        .to_string()
                        .into(),
                ))
                .expect("session.created should send");
            let session_update = websocket.read().expect("session.update should arrive");
            let session_update: Value = serde_json::from_str(session_update.to_text().unwrap())
                .expect("session.update should be JSON");
            assert_eq!(session_update["type"], "session.update");
            assert!(session_update["event_id"]
                .as_str()
                .is_some_and(|value| !value.is_empty()));
            assert_eq!(
                session_update["session"],
                json!({
                    "modalities": ["text"],
                    "sample_rate": 16_000,
                    "input_audio_format": "pcm",
                    "input_audio_transcription": {
                        "model": "qwen3-asr-flash-realtime",
                        "language": "zh"
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.0,
                        "silence_duration_ms": 400
                    },
                    "translation": { "language": "en" },
                })
            );
            let top_level = session_update
                .as_object()
                .expect("session.update object");
            assert_eq!(top_level.len(), 3);
            assert!(["event_id", "session", "type"]
                .iter()
                .all(|key| top_level.contains_key(*key)));

            websocket
                .send(Message::Text(
                    r#"{"event_id":"evt_server_updated","type":"session.updated","session":{"id":"session-test","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"sample_rate":16000,"input_audio_format":"pcm","turn_detection":{"type":"server_vad","threshold":0.0,"silence_duration_ms":400},"input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"translation":{"language":"en"}}}"#
                        .to_string()
                        .into(),
                ))
                .expect("session.updated should send");
            let finish = websocket.read().expect("session.finish should arrive");
            let finish: Value = serde_json::from_str(finish.to_text().unwrap())
                .expect("session.finish should be JSON");
            assert_eq!(finish["type"], "session.finish");
            websocket
                .send(Message::Text(
                    r#"{"event_id":"evt_server_finished","type":"session.finished"}"#.to_string().into(),
                ))
                .expect("session.finished should send");
        });

        let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
        server.join().expect("server should complete");

        assert_eq!(profile.verdict, "available");
        assert_eq!(profile.latency_budget_ms, 1_200);
        assert!(profile.input_tokens.is_none());
        assert!(profile.output_tokens.is_none());
        assert_eq!(profile.connection_attempts, 1);
        assert_eq!(profile.connection_count, 1);
        assert!(profile.connection_opened);
        assert!(profile.connection_closed);
        let evidence = profile.wire_evidence.expect("wire evidence should be retained");
        assert_eq!(evidence.evidence_outcome, "livetranslate-session-finished");
        assert_eq!(evidence.provider_input_mode, "none");
        assert_eq!(evidence.external_audio_samples, 0);
        assert_eq!(evidence.conversation_item_create_input_text_count, 0);
        assert_eq!(evidence.response_create_count, 0);
        assert_eq!(evidence.connection_count, 1);
        let session_authority = evidence
            .session_authority
            .as_ref()
            .expect("session authority should be retained");
        assert_eq!(
            session_authority.server_model,
            "qwen3.5-livetranslate-flash-realtime"
        );
        assert_eq!(session_authority.session_identity_sha256.len(), 64);
        assert_eq!(session_authority.echoed_session_config_sha256.len(), 64);
        assert_eq!(
            evidence
                .trace
                .iter()
                .map(|entry| (entry.direction.as_str(), entry.event_type.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("transport", "websocket.upgrade"),
                ("server-to-client", "session.created"),
                ("client-to-server", "session.update"),
                ("server-to-client", "session.updated"),
                ("client-to-server", "session.finish"),
                ("server-to-client", "session.finished"),
            ]
        );
        assert_eq!(
            evidence
                .trace
                .iter()
                .filter(|entry| entry.event_type == "session.finish")
                .count(),
            1
        );
        let server_event_ids = evidence
            .trace
            .iter()
            .filter(|entry| {
                matches!(
                    entry.event_type.as_str(),
                    "session.created" | "session.updated" | "session.finished"
                )
            })
            .map(|entry| {
                let payload = entry
                    .raw_redacted_payload
                    .as_deref()
                    .expect("server lifecycle payload should be retained");
                let value: Value = serde_json::from_str(payload)
                    .expect("server lifecycle payload should remain JSON");
                value["event_id"]
                    .as_str()
                    .expect("validated server event_id should be retained")
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(server_event_ids.len(), 3);
        let unique_server_event_ids = server_event_ids
            .iter()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique_server_event_ids.len(), 3);
        for entry in evidence
            .trace
            .iter()
            .filter(|entry| entry.raw_redacted_payload.is_some())
        {
            let payload = entry
                .raw_redacted_payload
                .as_deref()
                .expect("payload should exist");
            let expected_digest = sha256_hex(payload);
            assert_eq!(
                entry.sha256.as_deref(),
                Some(expected_digest.as_str())
            );
        }
        assert!(evidence.trace.windows(2).all(|pair| {
            pair[0].monotonic_ms < pair[1].monotonic_ms
        }));
    }

    #[test]
    fn livetranslate_probe_rejects_out_of_order_server_lifecycle() {
        let (ws_url, server) = spawn_ws_server(|websocket| {
            websocket
                .send(Message::Text(
                    r#"{"event_id":"evt_server_updated_first","type":"session.updated"}"#.to_string().into(),
                ))
                .expect("out-of-order session.updated should send");
        });

        let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
        server.join().expect("server should complete");
        assert_eq!(profile.verdict, "unavailable");
        assert_eq!(profile.error.as_ref().map(|error| error.code.as_str()), Some("protocol.invalid"));
        let evidence = profile.wire_evidence.expect("wire evidence should be retained");
        assert_eq!(
            evidence.evidence_outcome,
            "incomplete-livetranslate-lifecycle"
        );
        assert!(evidence.trace.iter().all(|entry| {
            !matches!(
                entry.event_type.as_str(),
                "conversation.item.create" | "response.create" | "input_audio_buffer.append"
            )
        }));
    }

    #[test]
    fn livetranslate_probe_rejects_missing_blank_or_reused_server_event_ids() {
        let cases = [
            (
                r#"{"type":"session.created","session":{"id":"session-event-id","model":"qwen3.5-livetranslate-flash-realtime"}}"#,
                r#"{"event_id":"evt_server_updated","type":"session.updated","session":{"id":"session-event-id","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"sample_rate":16000,"input_audio_format":"pcm","input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"translation":{"language":"en"}}}"#,
                r#"{"event_id":"evt_server_finished","type":"session.finished"}"#,
            ),
            (
                r#"{"event_id":"   ","type":"session.created","session":{"id":"session-event-id","model":"qwen3.5-livetranslate-flash-realtime"}}"#,
                r#"{"event_id":"evt_server_updated","type":"session.updated","session":{"id":"session-event-id","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"sample_rate":16000,"input_audio_format":"pcm","input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"translation":{"language":"en"}}}"#,
                r#"{"event_id":"evt_server_finished","type":"session.finished"}"#,
            ),
            (
                r#"{"event_id":"evt_server_duplicate","type":"session.created","session":{"id":"session-event-id","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}}"#,
                r#"{"event_id":"evt_server_duplicate","type":"session.updated","session":{"id":"session-event-id","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"sample_rate":16000,"input_audio_format":"pcm","input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"translation":{"language":"en"}}}"#,
                r#"{"event_id":"evt_server_duplicate","type":"session.finished"}"#,
            ),
        ];

        for (created, updated, finished) in cases {
            let created = created.to_string();
            let updated = updated.to_string();
            let finished = finished.to_string();
            let (ws_url, server) = spawn_ws_server(move |websocket| {
                let _ = websocket.send(Message::Text(created.into()));
                let _ = websocket.send(Message::Text(updated.into()));
                let _ = websocket.send(Message::Text(finished.into()));
            });

            let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
            server.join().expect("server should complete");
            assert_eq!(profile.verdict, "unavailable");
            assert!(matches!(
                profile.error.as_ref().map(|error| error.code.as_str()),
                Some("protocol.event-id-invalid" | "protocol.event-id-reused")
            ));
            assert_eq!(
                profile
                    .wire_evidence
                    .as_ref()
                    .map(|evidence| evidence.evidence_outcome.as_str()),
                Some("invalid-livetranslate-server-event-id")
            );
        }
    }

    #[test]
    fn livetranslate_probe_fails_immediately_with_redacted_provider_error_evidence() {
        let (ws_url, server) = spawn_ws_server(|websocket| {
            let long_context = "x".repeat(700);
            websocket
                .send(Message::Text(
                    format!(
                        "{{\"type\":\"error\",\"error\":{{\"code\":\"InvalidApiKey\\r\\nAuthorization: Bearer super-secret\",\"message\":\"rate limit diagnostic api_key=message-secret {long_context}\"}}}}"
                    )
                    .into(),
                ))
                .expect("provider error should send");
        });

        let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
        server.join().expect("server should complete");
        assert_eq!(profile.verdict, "unavailable");
        let evidence = profile.wire_evidence.expect("wire evidence should be retained");
        assert_eq!(evidence.evidence_outcome, "provider-error-frame");
        let error = evidence
            .provider_error_frame
            .expect("provider error frame should be retained");
        assert!(error.provider_code.contains("InvalidApiKey"));
        assert!(!error.provider_code.contains("super-secret"));
        assert!(!error.provider_code.chars().any(char::is_control));
        assert!(error.provider_code.chars().count() <= 128);
        assert!(error.raw_redacted_payload.contains("[REDACTED]"));
        assert!(error.raw_redacted_payload.contains("rate limit diagnostic"));
        assert!(!error.raw_redacted_payload.contains("super-secret"));
        assert!(!error.raw_redacted_payload.contains("message-secret"));
        assert!(error.raw_redacted_payload.chars().count() <= 2_048);
        assert_eq!(
            error.sha256,
            format!(
                "{:x}",
                sha2::Sha256::digest(error.raw_redacted_payload.as_bytes())
            )
        );
    }

    #[test]
    fn livetranslate_probe_preserves_abnormal_websocket_close_authority() {
        let (ws_url, server) = spawn_ws_server(|websocket| {
            let reason = format!(
                "upstream failed\r\nAuthorization: Bearer close-secret api_key=key-secret diagnostic-context-{}",
                "x".repeat(24)
            );
            assert!(reason.len() <= 123, "fixture must fit a WebSocket close frame");
            websocket
                .close(Some(tungstenite::protocol::CloseFrame {
                    code: tungstenite::protocol::frame::coding::CloseCode::Error,
                    reason: reason.into(),
                }))
                .expect("close frame should send");
        });

        let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
        server.join().expect("server should complete");
        assert_eq!(profile.verdict, "unavailable");
        let evidence = profile.wire_evidence.expect("wire evidence should be retained");
        assert_eq!(evidence.evidence_outcome, "websocket-close-abnormal");
        let close = evidence.websocket_close.expect("close authority should exist");
        assert_eq!(close.code, 1_011);
        assert!(close.reason.contains("upstream failed"));
        assert!(!close.reason.contains("close-secret"));
        assert!(!close.reason.contains("key-secret"));
        assert!(!close.reason.chars().any(char::is_control));
        assert!(close.reason.chars().count() <= 96);
        assert!(!close.normal);
        let terminal = evidence.trace.last().expect("close trace should exist");
        assert_eq!(terminal.reason.as_deref(), Some(close.reason.as_str()));
        let raw_redacted_payload = terminal
            .raw_redacted_payload
            .as_deref()
            .expect("close trace should retain sanitized authority");
        assert!(!raw_redacted_payload.contains("close-secret"));
        assert!(!raw_redacted_payload.contains("key-secret"));
        assert_eq!(
            terminal.sha256.as_deref(),
            Some(sha256_hex(raw_redacted_payload).as_str())
        );
    }

    #[test]
    fn livetranslate_probe_distinguishes_first_event_and_completion_timeouts() {
        for response_completion in [false, true] {
            let (ws_url, server) = spawn_ws_server(move |websocket| {
                if response_completion {
                    websocket
                        .send(Message::Text(
                            r#"{"event_id":"evt_server_timeout_created","type":"session.created","session":{"id":"session-timeout","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}}"#
                                .to_string()
                                .into(),
                        ))
                        .expect("session.created should send");
                    let update = websocket.read().expect("session.update should arrive");
                    assert!(update.to_text().unwrap().contains("session.update"));
                }
                thread::sleep(Duration::from_millis(1_200));
            });
            let mut provider = livetranslate_provider(ws_url);
            provider.timeout_ms = 1_000;
            let profile = ProviderGateway::new().probe(provider);
            server.join().expect("server should complete");
            assert_eq!(profile.verdict, "unavailable");
            let evidence = profile.wire_evidence.expect("wire evidence should be retained");
            let expected_phase = if response_completion {
                "response-completion"
            } else {
                "read-first-event"
            };
            assert_eq!(evidence.timeout_phase.as_deref(), Some(expected_phase));
            assert_eq!(evidence.timeout_budget_ms, Some(1_000));
            assert_eq!(
                evidence.evidence_outcome,
                format!("timeout:{expected_phase}")
            );
            let terminal = evidence.trace.last().expect("timeout trace should exist");
            assert_eq!(
                terminal.deadline_monotonic_ms.unwrap()
                    - terminal.started_monotonic_ms.unwrap(),
                1_000
            );
            assert!(terminal.monotonic_ms >= terminal.deadline_monotonic_ms.unwrap());
            if response_completion {
                let session_update = evidence
                    .trace
                    .iter()
                    .find(|entry| entry.event_type == "session.update")
                    .expect("session.update trace should be retained");
                assert_eq!(
                    terminal.started_monotonic_ms,
                    Some(session_update.monotonic_ms),
                    "completion timeout must reuse the raw session.update phase authority"
                );
            }
        }
    }

    #[test]
    fn livetranslate_probe_ping_frames_do_not_extend_the_absolute_first_event_deadline() {
        let (ws_url, server) = spawn_ws_server(|websocket| {
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(1_300) {
                if websocket
                    .send(Message::Ping(Vec::from("keepalive").into()))
                    .is_err()
                {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        let mut provider = livetranslate_provider(ws_url);
        provider.timeout_ms = 1_000;
        let started = Instant::now();
        let profile = ProviderGateway::new().probe(provider);
        let elapsed = started.elapsed();
        server.join().expect("server should complete");

        assert_eq!(profile.verdict, "unavailable");
        assert!(elapsed < Duration::from_millis(1_500));
        let evidence = profile.wire_evidence.expect("wire evidence should exist");
        assert_eq!(evidence.timeout_phase.as_deref(), Some("read-first-event"));
        assert_eq!(evidence.timeout_budget_ms, Some(1_000));
    }

    #[test]
    fn livetranslate_probe_rejects_binary_application_frames() {
        let (ws_url, server) = spawn_ws_server(|websocket| {
            websocket
                .send(Message::Binary(vec![1, 2, 3].into()))
                .expect("binary frame should send");
        });

        let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
        server.join().expect("server should complete");
        assert_eq!(profile.verdict, "unavailable");
        assert_eq!(
            profile.error.as_ref().map(|error| error.code.as_str()),
            Some("response.unparseable")
        );
        let evidence = profile.wire_evidence.expect("wire evidence should exist");
        assert_eq!(
            evidence.evidence_outcome,
            "invalid-livetranslate-binary-frame"
        );
        assert_eq!(
            evidence.trace.last().map(|entry| entry.event_type.as_str()),
            Some("websocket.binary")
        );
    }

    #[test]
    fn livetranslate_probe_rejects_session_model_and_echoed_config_mismatch() {
        for config_mismatch in [false, true] {
            let (ws_url, server) = spawn_ws_server(move |websocket| {
                let model = if config_mismatch {
                    "qwen3.5-livetranslate-flash-realtime"
                } else {
                    "wrong-model"
                };
                websocket
                    .send(Message::Text(
                        format!(
                            "{{\"event_id\":\"evt_server_authority_created\",\"type\":\"session.created\",\"session\":{{\"id\":\"session-authority\",\"object\":\"realtime.session\",\"model\":\"{model}\"}}}}"
                        )
                        .into(),
                    ))
                    .expect("session.created should send");
                if config_mismatch {
                    let _ = websocket.read().expect("session.update should arrive");
                    websocket
                        .send(Message::Text(
                            r#"{"event_id":"evt_server_authority_updated","type":"session.updated","session":{"id":"session-authority","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"sample_rate":16000,"input_audio_format":"pcm","turn_detection":{"type":"server_vad","threshold":0.0,"silence_duration_ms":400},"input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"translation":{"language":"fr"}}}"#
                                .to_string()
                                .into(),
                        ))
                        .expect("session.updated should send");
                }
            });

            let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
            server.join().expect("server should complete");
            assert_eq!(profile.verdict, "unavailable");
            assert!(matches!(
                profile.error.as_ref().map(|error| error.code.as_str()),
                Some("protocol.identity-invalid" | "protocol.config-mismatch")
            ));
            assert_eq!(
                profile
                    .wire_evidence
                    .expect("wire evidence should exist")
                    .evidence_outcome,
                "invalid-livetranslate-session-authority"
            );
        }
    }

    #[test]
    fn livetranslate_probe_reuses_production_session_object_authority() {
        for wrong_updated_object in [false, true] {
            let (ws_url, server) = spawn_ws_server(move |websocket| {
                let created_object = if wrong_updated_object {
                    ",\"object\":\"realtime.session\""
                } else {
                    ""
                };
                websocket
                    .send(Message::Text(
                        format!(
                            "{{\"event_id\":\"evt_server_object_created\",\"type\":\"session.created\",\"session\":{{\"id\":\"session-object\"{created_object},\"model\":\"qwen3.5-livetranslate-flash-realtime\"}}}}"
                        )
                        .into(),
                    ))
                    .expect("session.created should send");
                if wrong_updated_object {
                    let _ = websocket.read().expect("session.update should arrive");
                    websocket
                        .send(Message::Text(
                            r#"{"event_id":"evt_server_object_updated","type":"session.updated","session":{"id":"session-object","object":"wrong.session","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"sample_rate":16000,"input_audio_format":"pcm","turn_detection":{"type":"server_vad","threshold":0.0,"silence_duration_ms":400},"input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"translation":{"language":"en"}}}"#
                                .to_string()
                                .into(),
                        ))
                        .expect("session.updated should send");
                }
            });

            let profile = ProviderGateway::new().probe(livetranslate_provider(ws_url));
            server.join().expect("server should complete");
            assert_eq!(profile.verdict, "unavailable");
            assert!(matches!(
                profile.error.as_ref().map(|error| error.code.as_str()),
                Some("protocol.identity-invalid" | "protocol.config-mismatch")
            ));
            assert_eq!(
                profile
                    .wire_evidence
                    .expect("wire evidence should exist")
                    .evidence_outcome,
                "invalid-livetranslate-session-authority"
            );
        }
    }

    #[test]
    fn livetranslate_probe_marks_complete_lifecycle_over_1200ms_as_realtime_risk() {
        let (ws_url, server) = spawn_ws_server(|websocket| {
            thread::sleep(Duration::from_millis(1_250));
            websocket
                .send(Message::Text(
                    r#"{"event_id":"evt_server_late_created","type":"session.created","session":{"id":"session-late","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}}"#
                        .to_string()
                        .into(),
                ))
                .expect("session.created should send");
            let _ = websocket.read().expect("session.update should arrive");
            websocket
                .send(Message::Text(
                    r#"{"event_id":"evt_server_late_updated","type":"session.updated","session":{"id":"session-late","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"sample_rate":16000,"input_audio_format":"pcm","turn_detection":{"type":"server_vad","threshold":0.0,"silence_duration_ms":400},"input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"translation":{"language":"en"}}}"#
                        .to_string()
                        .into(),
                ))
                .expect("session.updated should send");
            let _ = websocket.read().expect("session.finish should arrive");
            websocket
                .send(Message::Text(
                    r#"{"event_id":"evt_server_late_finished","type":"session.finished"}"#.to_string().into(),
                ))
                .expect("session.finished should send");
        });
        let mut provider = livetranslate_provider(ws_url);
        provider.timeout_ms = 3_000;
        let profile = ProviderGateway::new().probe(provider);
        server.join().expect("server should complete");

        assert_eq!(profile.verdict, "realtime-risk");
        assert_eq!(profile.latency_budget_ms, 1_200);
        assert!(profile.measured_latency_ms > 1_200);
        assert_eq!(
            profile
                .wire_evidence
                .as_ref()
                .map(|evidence| evidence.evidence_outcome.as_str()),
            Some("livetranslate-session-finished")
        );
    }

    #[test]
    fn livetranslate_probe_preserves_upgrade_timeout_without_fake_101() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("client should connect");
            thread::sleep(Duration::from_millis(1_200));
        });
        let mut provider = livetranslate_provider(format!("ws://{addr}"));
        provider.timeout_ms = 1_000;
        let profile = ProviderGateway::new().probe(provider);
        server.join().expect("server should complete");

        assert_eq!(profile.verdict, "unavailable");
        let evidence = profile.wire_evidence.expect("wire evidence should exist");
        assert_eq!(evidence.evidence_outcome, "timeout:websocket-upgrade");
        assert_eq!(evidence.timeout_phase.as_deref(), Some("websocket-upgrade"));
        assert_eq!(profile.connection_attempts, 1);
        assert_eq!(profile.connection_count, 0);
        assert!(!profile.connection_opened);
        assert!(!profile.connection_closed);
        assert_eq!(evidence.connection_count, 0);
        assert_eq!(
            evidence.trace.last().map(|entry| entry.event_type.as_str()),
            Some("websocket.upgrade.timeout")
        );
        assert!(evidence.trace.iter().all(|entry| entry.status != Some(101)));
        let terminal = evidence.trace.last().expect("terminal trace should exist");
        assert_eq!(terminal.started_monotonic_ms, Some(0));
        assert_eq!(terminal.deadline_monotonic_ms, Some(1_000));
        let payload = terminal
            .raw_redacted_payload
            .as_deref()
            .expect("sanitized request authority should exist");
        assert!(!payload.to_ascii_lowercase().contains("bearer"));
        assert!(!payload.to_ascii_lowercase().contains("api-key"));
        let expected_digest = sha256_hex(payload);
        assert_eq!(terminal.sha256.as_deref(), Some(expected_digest.as_str()));
    }

    #[test]
    fn omni_profile_cannot_be_used_as_tts_before_connector_access() {
        let gateway = ProviderGateway::new();
        let error = gateway
            .synthesize_realtime_audio(
                realtime_provider("ws://127.0.0.1:9/api/v1".to_string()),
                "你好，世界。".to_string(),
                "zh-CN".to_string(),
                "Ethan".to_string(),
            )
            .expect_err("Omni profile is not a TTS product profile");

        assert_eq!(error.code, "model_protocol.operation_not_supported");
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
    fn provider_redirects_are_limited_to_the_original_origin() {
        let initial = Url::parse("https://api.example.test/v1/messages").unwrap();
        let same_origin = Url::parse("https://api.example.test/v2/messages").unwrap();
        let other_host = Url::parse("https://collector.example.test/capture").unwrap();
        let downgrade = Url::parse("http://api.example.test/v2/messages").unwrap();
        let other_port = Url::parse("https://api.example.test:8443/v2/messages").unwrap();

        assert!(redirect_target_is_same_origin(&same_origin, &[initial.clone()]));
        assert!(!redirect_target_is_same_origin(&other_host, &[initial.clone()]));
        assert!(!redirect_target_is_same_origin(&downgrade, &[initial.clone()]));
        assert!(!redirect_target_is_same_origin(&other_port, &[initial]));
        assert!(!redirect_target_is_same_origin(&same_origin, &[]));
    }

    #[test]
    fn cross_origin_provider_redirect_returns_an_explicit_policy_error() {
        let (base_url, server) = spawn_http_server(|stream| {
            let response = concat!(
                "HTTP/1.1 302 Found\r\n",
                "Location: https://collector.example.test/capture\r\n",
                "Content-Length: 0\r\n",
                "Connection: close\r\n\r\n"
            );
            stream
                .write_all(response.as_bytes())
                .expect("redirect response should write");
            stream.flush().expect("redirect response should flush");
        });

        let error = build_client(1_000)
            .expect("provider client should build")
            .get(base_url)
            .send()
            .expect_err("cross-origin redirect should be rejected");
        server.join().expect("redirect server should stop");

        let error = normalize_transport_error(error);

        assert_eq!(error.code, "transport.unavailable");
        assert!(error.message.contains("仅允许同源重定向"));
        assert!(!error.retriable);
    }

    #[test]
    fn probe_marks_high_latency_as_realtime_risk() {
        let routing = build_routing_decision("realtime-risk", 1800, false);

        assert_eq!(routing.subtitle_priority, "subtitle-first");
        assert_eq!(routing.speech_disposition, "deferred");
    }

    #[test]
    fn openai_model_catalog_reads_models_endpoint_without_name_based_capabilities() {
        let (base_url, _server) = spawn_http_server(|stream| {
            write_http_response(
                stream,
                "application/json",
                r#"{"data":[{"id":"gpt-4.1","owned_by":"openai"},{"id":"gpt-4o-realtime-preview","owned_by":"openai"}]}"#,
            );
        });

        let gateway = ProviderGateway::new();
        let catalog = gateway.fetch_models(openai_provider(base_url));

        assert!(catalog.error.is_none());
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[1].id, "gpt-4o-realtime-preview");
        assert!(catalog.models[1].capabilities.is_empty());
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
        let (base_url, _server) = spawn_http_server(|stream| {
            write_http_error_response(
                stream,
                401,
                "application/json",
                r#"{"error":{"code":"invalid_api_key","message":"token expired"}}"#,
            );
        });

        let gateway = ProviderGateway::new();
        let smoke = gateway.execute_smoke(
            openai_provider(base_url),
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
        let (base_url, _server) = spawn_http_server(|stream| {
            write_http_error_response(
                stream,
                429,
                "application/json",
                r#"{"code":"RateQuotaExceeded","message":"too many requests"}"#,
            );
        });

        let provider = dashscope_text_provider(base_url);
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

    fn read_http_request_body(stream: &mut TcpStream) -> String {
        let mut reader = BufReader::new(&mut *stream);
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("http request header should be readable");
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if line
                .split_once(':')
                .is_some_and(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            {
                let value = line
                    .split_once(':')
                    .map(|(_, value)| value)
                    .expect("content length header should contain a value");
                content_length = value
                    .trim()
                    .parse()
                    .expect("content length should be numeric");
            }
        }
        let mut body = vec![0u8; content_length];
        reader
            .read_exact(&mut body)
            .expect("http request body should be readable");
        String::from_utf8(body).expect("http request body should be UTF-8")
    }

    /// Spawn a client thread that runs a streaming translation and forwards each
    /// observed delta over a channel, returning the delta receiver and the client
    /// join handle. Shared by the streaming delta-forwarding tests, which drove
    /// this identical callback wiring.
    fn spawn_delta_forwarding_client(
        provider: ProviderDraftInput,
        source_text: &'static str,
        source_language: &'static str,
        target_language: &'static str,
    ) -> (
        mpsc::Receiver<String>,
        thread::JoinHandle<Result<String, ProviderRuntimeError>>,
    ) {
        let (delta_tx, delta_rx) = mpsc::channel();
        let client = thread::spawn(move || {
            ProviderGateway::new().translate_text_streaming_traced_with_glossary(
                provider,
                source_text.to_string(),
                source_language.to_string(),
                target_language.to_string(),
                None,
                None,
                |delta| {
                    delta_tx.send(delta.to_string()).map_err(|error| {
                        ProviderRuntimeError::new(
                            "test.callback-failed",
                            format!("failed to observe delta: {error}"),
                        )
                    })
                },
            )
        });
        (delta_rx, client)
    }

    /// Bind an ephemeral loopback HTTP server that accepts one connection, drains
    /// the request headers, then hands the stream to `respond` so each test can
    /// write its own canned reply. Returns the base URL and the server thread
    /// handle. Shared by the smoke/catalog/error tests, which previously
    /// repeated this bind/accept/read scaffolding verbatim.
    fn spawn_http_server<F>(respond: F) -> (String, thread::JoinHandle<()>)
    where
        F: FnOnce(&mut TcpStream) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            read_http_request(&mut stream);
            respond(&mut stream);
        });
        (format!("http://{}", addr), handle)
    }

    fn spawn_counted_loopback_http_server() -> (
        String,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        listener
            .set_nonblocking(true)
            .expect("counter listener should be nonblocking");
        let addr = listener.local_addr().expect("listener should have addr");
        let attempts = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let attempts_for_server = Arc::clone(&attempts);
        let stop_for_server = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !stop_for_server.load(AtomicOrdering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        attempts_for_server.fetch_add(1, AtomicOrdering::SeqCst);
                        read_http_request(&mut stream);
                        write_http_response(
                            &mut stream,
                            "text/event-stream",
                            concat!(
                                "data: {\"choices\":[{\"delta\":{\"content\":\"unexpected network access\"}}]}\n\n",
                                "data: [DONE]\n\n"
                            ),
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("counter listener failed: {error}"),
                }
            }
        });
        (format!("http://{addr}"), attempts, stop, handle)
    }

    /// Bind an ephemeral loopback WebSocket server that accepts one connection
    /// and completes the handshake, then hands the live socket to `exchange` so
    /// each test drives its own frame read/write sequence. Returns the
    /// `ws://.../ws` URL and the server thread handle. Shared by the websocket
    /// smoke tests, which previously repeated the bind/accept/handshake prefix.
    fn spawn_ws_server<F>(exchange: F) -> (String, thread::JoinHandle<()>)
    where
        F: FnOnce(&mut tungstenite::WebSocket<TcpStream>) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            let mut websocket = accept(stream).expect("websocket should be accepted");
            exchange(&mut websocket);
        });
        (format!("ws://{}/ws", addr), handle)
    }

    fn spawn_counted_loopback_ws_server() -> (
        String,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        listener
            .set_nonblocking(true)
            .expect("counter listener should be nonblocking");
        let addr = listener.local_addr().expect("listener should have addr");
        let attempts = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let attempts_for_server = Arc::clone(&attempts);
        let stop_for_server = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !stop_for_server.load(AtomicOrdering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        attempts_for_server.fetch_add(1, AtomicOrdering::SeqCst);
                        let _ = accept(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("WebSocket counter listener failed: {error}"),
                }
            }
        });
        (format!("ws://{addr}/ws"), attempts, stop, handle)
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
            manifest_provider_id: None,
            kind: config.kind.clone(),
            template_realtime_protocol: None,
            realtime_protocol: None,
            display_name: config.name.clone(),
            model: config.model.clone(),
            deployment_id: None,
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
            model_protocol_bindings: vec![],
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
        let lower_path = path.to_ascii_lowercase();
        if lower_path.ends_with(".mp3") {
            return decode_mp3_file_to_mono_16k(path);
        }
        if lower_path.ends_with(".wav") {
            return decode_wav_file_to_mono_16k(path);
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

    fn decode_wav_file_to_mono_16k(path: &str) -> Vec<i16> {
        let mut reader = hound::WavReader::open(path)
            .unwrap_or_else(|error| panic!("failed to open integration WAV file {path}: {error}"));
        let spec = reader.spec();
        let channels = spec.channels.max(1) as usize;
        let interleaved = match spec.sample_format {
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .map(|sample| {
                    sample.unwrap_or_else(|error| {
                        panic!("failed to decode integration WAV file {path}: {error}")
                    })
                })
                .collect::<Vec<_>>(),
            hound::SampleFormat::Int if spec.bits_per_sample <= 16 => reader
                .samples::<i16>()
                .map(|sample| {
                    sample.unwrap_or_else(|error| {
                        panic!("failed to decode integration WAV file {path}: {error}")
                    }) as f32
                        / i16::MAX as f32
                })
                .collect::<Vec<_>>(),
            hound::SampleFormat::Int => {
                let peak = ((1_i64 << spec.bits_per_sample.saturating_sub(1)) - 1).max(1) as f32;
                reader
                    .samples::<i32>()
                    .map(|sample| {
                        sample.unwrap_or_else(|error| {
                            panic!("failed to decode integration WAV file {path}: {error}")
                        }) as f32
                            / peak
                    })
                    .collect::<Vec<_>>()
            }
        };
        let mono = interleaved
            .chunks(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / frame.len().max(1) as f32)
            .collect::<Vec<_>>();
        resample_mono_to_16k_i16(&mono, spec.sample_rate.max(1))
    }

    fn decode_mp3_file_to_mono_16k(path: &str) -> Vec<i16> {
        let file = fs::File::open(path)
            .unwrap_or_else(|error| panic!("failed to open integration MP3 file {path}: {error}"));
        let decoder = Decoder::try_from(file).unwrap_or_else(|error| {
            panic!("failed to decode integration MP3 file {path}: {error}")
        });
        let sample_rate = decoder.sample_rate().get();
        let channels = decoder.channels().get() as usize;
        let interleaved = decoder.collect::<Vec<f32>>();
        let mono = interleaved
            .chunks(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / frame.len().max(1) as f32)
            .collect::<Vec<_>>();

        resample_mono_to_16k_i16(&mono, sample_rate)
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

    #[test]
    fn tracked_watch_wav_fixture_decodes_to_mono_16k() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/testing/fixtures/watch-mode-en-original.wav");
        let decoded = decode_audio_file_to_mono_16k(&fixture.to_string_lossy());

        assert!(decoded.len() > 16_000, "fixture should contain more than one second");
    }

    fn encode_pcm_i16_base64(samples: &[i16]) -> String {
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        BASE64_STANDARD.encode(bytes)
    }

    struct RealtimeAudioIntegrationResult {
        source: String,
        translation: String,
        response_count: u32,
        commit_to_first_asr_ms: Option<u64>,
        commit_to_asr_completed_ms: Option<u64>,
        commit_to_first_translation_delta_ms: Option<u64>,
        commit_to_response_done_ms: Option<u64>,
        total_ms: u64,
    }

    const LEGACY_AUDIO_INTEGRATION_WIRE_DIALECT: &str =
        "bailian-omni-realtime-ws-v1";

    fn authorize_legacy_audio_integration_adapter(
        provider: &ProviderDraftInput,
    ) -> Result<(), ProviderRuntimeError> {
        let authority = authorize_bailian_model_operation_before_provider_access(
            provider,
            &provider.model,
            "native_translate",
        )?
        .ok_or_else(|| {
            ProviderRuntimeError::new(
                "model_protocol.profile_declaration_missing",
                format!(
                    "model_protocol.profile_declaration_missing: legacy realtime audio integration requires an exact typed Bailian voice profile for '{}'",
                    provider.model
                ),
            )
        })?;
        if authority.wire_dialect != LEGACY_AUDIO_INTEGRATION_WIRE_DIALECT {
            return Err(ProviderRuntimeError::new(
                "model_protocol.wire_dialect_mismatch",
                format!(
                    "model_protocol.wire_dialect_mismatch: legacy realtime audio integration implements '{}' but model '{}' is authorized for '{}'",
                    LEGACY_AUDIO_INTEGRATION_WIRE_DIALECT,
                    provider.model,
                    authority.wire_dialect
                ),
            ));
        }

        Err(ProviderRuntimeError::new(
            "model_protocol.adapter_unavailable",
            format!(
                "model_protocol.adapter_unavailable: legacy realtime audio integration has no enabled typed adapter for '{}' and cannot use manifest authority alone",
                authority.wire_dialect
            ),
        ))
    }

    fn run_realtime_audio_file_integration(
        provider: ProviderDraftInput,
        audio_path: &str,
    ) -> Result<RealtimeAudioIntegrationResult, ProviderRuntimeError> {
        authorize_legacy_audio_integration_adapter(&provider)?;
        let overall_started = Instant::now();
        let samples = decode_audio_file_to_mono_16k(audio_path);
        if samples.is_empty() {
            return Err(ProviderRuntimeError::new(
                "request.invalid",
                format!("integration audio file decoded to zero samples: {audio_path}"),
            ));
        }

        let (mut socket, websocket_timeout) = WebSocketTransport::default()
            .connect_provider(&provider, "native_translate")?;

        let request_id = format!("audio-integration-{}", now_unix_seconds_marker());
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

        let commit_started = Instant::now();
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
        let mut commit_to_first_asr_ms = None;
        let mut commit_to_asr_completed_ms = None;
        let mut commit_to_first_translation_delta_ms = None;
        let mut commit_to_response_done_ms = None;
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
                        Some("conversation.item.input_audio_transcription.delta") => {
                            commit_to_first_asr_ms.get_or_insert_with(|| {
                                commit_started.elapsed().as_millis().min(u64::MAX as u128) as u64
                            });
                        }
                        Some("conversation.item.input_audio_transcription.completed") => {
                            let elapsed =
                                commit_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                            commit_to_first_asr_ms.get_or_insert(elapsed);
                            commit_to_asr_completed_ms = Some(elapsed);
                            source = value["transcript"].as_str().unwrap_or("").to_string();
                        }
                        Some("response.audio_transcript.delta") => {
                            let delta = value["delta"].as_str().unwrap_or("");
                            if !delta.is_empty() {
                                commit_to_first_translation_delta_ms.get_or_insert_with(|| {
                                    commit_started.elapsed().as_millis().min(u64::MAX as u128)
                                        as u64
                                });
                            }
                            translation.push_str(delta);
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
                            commit_to_response_done_ms = Some(
                                commit_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                            );
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
        Ok(RealtimeAudioIntegrationResult {
            source,
            translation,
            response_count,
            commit_to_first_asr_ms,
            commit_to_asr_completed_ms,
            commit_to_first_translation_delta_ms,
            commit_to_response_done_ms,
            total_ms: overall_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        })
    }

    #[test]
    fn livetranslate_cannot_reach_legacy_omni_audio_integration_socket() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/testing/fixtures/watch-mode-en-original.wav");
        let (connect_url, connection_count, stop, server) =
            spawn_counted_loopback_ws_server();
        let client = thread::spawn(move || {
            let mut provider = livetranslate_provider(connect_url);
            provider.timeout_ms = 1_000;
            run_realtime_audio_file_integration(provider, &fixture.to_string_lossy())
        });

        let result = client.join().expect("integration client should not panic");
        stop.store(true, AtomicOrdering::SeqCst);
        server.join().expect("counter server should stop");

        let error = match result {
            Ok(_) => panic!("LiveTranslate must not enter an Omni-only test adapter"),
            Err(error) => error,
        };
        assert_eq!(
            connection_count.load(AtomicOrdering::SeqCst),
            0,
            "protocol admission must fail before any paid-capable connection"
        );
        assert_eq!(error.code, "model_protocol.wire_dialect_mismatch");
    }

    #[test]
    fn legacy_omni_audio_integration_rejects_manifest_only_and_unknown_models_before_io() {
        for (model, expected_code) in [
            (
                "qwen3.5-omni-plus-realtime",
                "model_protocol.adapter_unavailable",
            ),
            (
                "qwen-new-voice-realtime",
                "model_protocol.model_not_registered",
            ),
        ] {
            let mut provider = provider_draft(
                "template-dashscope-realtime",
                "provider-dashscope-audio-integration",
                "dashscope",
                "DashScope audio integration",
                model,
                "https://dashscope.aliyuncs.com/api/v1".to_string(),
                "websocket",
                Some("cn-beijing".to_string()),
                "audio-realtime-integration",
            );
            provider.realtime_protocol = Some("dashscope-omni".to_string());
            if model == "qwen-new-voice-realtime" {
                declare_exact_unknown_bailian_voice_model(&mut provider);
            }

            let result = run_realtime_audio_file_integration(
                provider,
                "this-path-must-not-be-read-before-protocol-admission.wav",
            );
            let error = match result {
                Ok(_) => panic!("{model} must not enter the legacy audio integration adapter"),
                Err(error) => error,
            };
            assert_eq!(error.code, expected_code, "unexpected result for {model}");
        }
    }

    fn llm_integration_audio_only() -> bool {
        std::env::var("OMNI_LLM_TEST_AUDIO_ONLY")
            .ok()
            .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
    }

    fn run_llm_integration_audio_scenario(
        gateway: &ProviderGateway,
        audio_config: &LlmIntegrationProviderConfig,
        fallback_audio_test_file: Option<&str>,
    ) {
        assert!(
            std::env::var(&audio_config.api_key_env).is_ok(),
            "missing API key env var {} for {}",
            audio_config.api_key_env,
            audio_config.name
        );
        let audio_path = audio_config
            .test_file
            .as_deref()
            .or(fallback_audio_test_file)
            .expect("audio integration config must set audio.testFile or audioTestFile");
        assert!(
            PathBuf::from(audio_path).exists(),
            "audio integration test file does not exist: {}",
            audio_path
        );
        let result = run_realtime_audio_file_integration(
            realtime_audio_provider_from_integration_config(audio_config),
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
        println!("  source:         {:?}", result.source);
        println!("  source_chars:   {}", result.source.chars().count());
        println!("  translation:    {:?}", result.translation);
        println!(
            "  translation_chars: {}",
            result.translation.chars().count()
        );
        println!("  response_count: {}", result.response_count);
        println!(
            "  commit_to_first_asr_ms: {:?}",
            result.commit_to_first_asr_ms
        );
        println!(
            "  commit_to_asr_completed_ms: {:?}",
            result.commit_to_asr_completed_ms
        );
        println!(
            "  commit_to_first_translation_delta_ms: {:?}",
            result.commit_to_first_translation_delta_ms
        );
        println!(
            "  commit_to_response_done_ms: {:?}",
            result.commit_to_response_done_ms
        );
        println!("  total_ms: {}", result.total_ms);
        println!("=== END AUDIO REALTIME ===");
        println!();

        let source_len = result.source.chars().count();
        let translation_len = result.translation.chars().count();
        assert!(
            result.response_count >= 1,
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
                    realtime_audio_provider_from_integration_config(audio_config),
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
                speech.audio.pcm_i16.len() >= speech_config.minimum_pcm_samples.unwrap_or(1_600),
                "provider {} returned too few realtime speech PCM samples: {}",
                audio_config.name,
                speech.audio.pcm_i16.len()
            );
            assert!(speech.audio_seconds > 0.0);
        }
    }

    #[test]
    #[ignore = "live provider smoke; needs scripts/testing/llm-integration.config.json and API keys (npm run test:llm-integration)"]
    fn llm_integration_provider_smoke_calls_configured_models() {
        let config = load_llm_integration_config();
        let audio_only = llm_integration_audio_only();

        let gateway = ProviderGateway::new();
        if !audio_only {
            assert!(
                !config.providers.is_empty(),
                "LLM integration config must contain at least one provider"
            );
        }
        for provider_config in config.providers.into_iter().filter(|_| !audio_only) {
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

        assert!(
            !audio_only || config.audio.is_some(),
            "audio-only integration config must contain an audio provider"
        );
        if let Some(audio_config) = config.audio.as_ref() {
            run_llm_integration_audio_scenario(
                &gateway,
                audio_config,
                config.audio_test_file.as_deref(),
            );
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
