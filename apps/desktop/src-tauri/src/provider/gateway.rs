use std::io::ErrorKind;
use std::net::TcpStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Error as WebSocketError, Message, WebSocket};
use url::Url;

use crate::diagnostics::model_trace::ModelTraceRecorder;
use crate::storage::credential::{CredentialVault, KeyringCredentialVault};

use super::contracts::{
    ProviderDraftInput, ProviderModelCatalogRuntime, ProviderModelRuntime,
    ProviderProbeCheckRuntime, ProviderProbeProfileRuntime, ProviderRoutingDecision,
    ProviderRuntimeError, ProviderSmokeResult, ProviderStreamEventRecord, TtsAudioChunk,
    TtsSynthesisResult,
};

const LATENCY_BUDGET_MS: u64 = 1200;
const MIN_WEBSOCKET_TIMEOUT_MS: u64 = 1000;

pub struct ProviderGateway;

impl ProviderGateway {
    pub fn new() -> Self {
        Self
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
        let endpoint = match resolve_models_endpoint(&provider) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                return ProviderModelCatalogRuntime {
                    provider_id: provider.provider_id,
                    endpoint: String::new(),
                    fetched_at: now_marker(),
                    models: Vec::new(),
                    error: Some(error),
                }
            }
        };

        let fetch_result = (|| -> Result<Vec<ProviderModelRuntime>, ProviderRuntimeError> {
            let client = build_client(provider.timeout_ms)?;
            let response = client
                .get(endpoint.clone())
                .headers(build_reqwest_headers(&provider)?)
                .send()
                .map_err(normalize_transport_error)?;

            if !response.status().is_success() {
                let error = match provider.kind.as_str() {
                    "dashscope" => parse_dashscope_error(response),
                    _ => parse_openai_error(response),
                };
                return Err(error);
            }

            let value: Value = response.json().map_err(normalize_transport_error)?;
            parse_model_catalog_response(&value)
        })();

        match fetch_result {
            Ok(models) => ProviderModelCatalogRuntime {
                provider_id: provider.provider_id,
                endpoint,
                fetched_at: now_marker(),
                models,
                error: None,
            },
            Err(error) => ProviderModelCatalogRuntime {
                provider_id: provider.provider_id,
                endpoint,
                fetched_at: now_marker(),
                models: Vec::new(),
                error: Some(error),
            },
        }
    }

    pub fn probe(&self, provider: ProviderDraftInput) -> ProviderProbeProfileRuntime {
        let smoke = self.execute_smoke(
            provider.clone(),
            "请把这句中文翻译成英文，并保留语气自然。".to_string(),
            "zh-CN".to_string(),
            "en-US".to_string(),
        );

        let checked_at = now_marker();
        let response_shape_stable = smoke.status == "completed"
            && smoke
                .event_log
                .iter()
                .any(|item| item.event_type == "translation.completed")
            && smoke
                .event_log
                .iter()
                .any(|item| item.event_type == "response.completed");
        let error_shape_stable = smoke.error.is_none()
            || smoke
                .error
                .as_ref()
                .map(|error| !error.code.is_empty() && !error.message.is_empty())
                .unwrap_or(false);
        let verdict = if smoke.error.is_some() || !response_shape_stable {
            "unavailable"
        } else if smoke.stream_observed
            && smoke.first_event_latency_ms.unwrap_or(smoke.duration_ms) <= LATENCY_BUDGET_MS
        {
            "available"
        } else if smoke.stream_observed && error_shape_stable {
            "realtime-risk"
        } else {
            "unavailable"
        };
        let routing_decision = build_routing_decision(
            verdict,
            smoke.first_event_latency_ms.unwrap_or(smoke.duration_ms),
            smoke.fallback_applied,
        );
        let checks = vec![
            ProviderProbeCheckRuntime {
                id: format!("{}-streaming", provider.provider_id),
                key: "streaming".to_string(),
                label: "流式能力".to_string(),
                status: if smoke.stream_observed {
                    "pass".to_string()
                } else {
                    "fail".to_string()
                },
                summary: if smoke.stream_observed {
                    format!(
                        "已观察到增量事件，实际传输模式为 {}。",
                        smoke.transport_effective
                    )
                } else {
                    format!("未观察到增量事件，当前为 {}。", smoke.transport_effective)
                },
            },
            ProviderProbeCheckRuntime {
                id: format!("{}-latency", provider.provider_id),
                key: "latency".to_string(),
                label: "实时适用性".to_string(),
                status: if smoke.first_event_latency_ms.unwrap_or(smoke.duration_ms)
                    <= LATENCY_BUDGET_MS
                {
                    "pass".to_string()
                } else {
                    "warn".to_string()
                },
                summary: format!(
                    "首个有效事件耗时 {} ms，预算 {} ms。",
                    smoke.first_event_latency_ms.unwrap_or(smoke.duration_ms),
                    LATENCY_BUDGET_MS
                ),
            },
            ProviderProbeCheckRuntime {
                id: format!("{}-errors", provider.provider_id),
                key: "error-shape".to_string(),
                label: "错误结构".to_string(),
                status: if error_shape_stable {
                    "pass".to_string()
                } else {
                    "fail".to_string()
                },
                summary: match smoke.error.as_ref() {
                    Some(error) => format!(
                        "已归一化为 {}，可直接给 UI 与 Diagnostics 使用。",
                        error.code
                    ),
                    None => "本次请求未触发上游错误，当前归一化链路可用。".to_string(),
                },
            },
            ProviderProbeCheckRuntime {
                id: format!("{}-response-shape", provider.provider_id),
                key: "response-shape".to_string(),
                label: "响应格式稳定性".to_string(),
                status: if response_shape_stable {
                    "pass".to_string()
                } else {
                    "fail".to_string()
                },
                summary: if response_shape_stable {
                    "已完整得到 translation.completed 与 response.completed。".to_string()
                } else {
                    "返回事件不完整，当前不建议接入实时主链路。".to_string()
                },
            },
        ];

        ProviderProbeProfileRuntime {
            id: format!(
                "probe-{}-{}",
                provider.provider_id,
                normalize_timestamp(&checked_at)
            ),
            template_id: provider.template_id,
            provider_id: provider.provider_id,
            verdict: verdict.to_string(),
            checked_at,
            measured_latency_ms: smoke.first_event_latency_ms.unwrap_or(smoke.duration_ms),
            latency_budget_ms: LATENCY_BUDGET_MS,
            stream_supported: smoke.stream_observed,
            error_shape_stable,
            response_shape_stable,
            transport_requested: smoke.transport_requested,
            transport_effective: smoke.transport_effective,
            fallback_applied: smoke.fallback_applied,
            checks,
            guidance: build_probe_guidance(verdict, &routing_decision, smoke.fallback_applied),
            routing_decision,
            error: smoke.error,
        }
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

        let execution = match provider.kind.as_str() {
            "openai-compatible" => self.execute_openai(
                &provider,
                &transport_effective,
                &request_id,
                &source_text,
                &source_language,
                &target_language,
            ),
            "dashscope" => self.execute_dashscope(
                &provider,
                &transport_effective,
                &request_id,
                &source_text,
                &source_language,
                &target_language,
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
                routing_decision: build_routing_decision(
                    "unavailable",
                    LATENCY_BUDGET_MS,
                    fallback_applied,
                ),
                error: Some(error),
            },
        }
    }

    #[allow(dead_code)]
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
        if provider.kind != "dashscope" {
            return Err(ProviderRuntimeError::new(
                "request.invalid",
                format!(
                    "Realtime audio synthesis only supports dashscope providers, got {}",
                    provider.kind
                ),
            ));
        }

        let websocket_timeout = resolve_websocket_timeout(provider.timeout_ms);
        let websocket_url = to_websocket_url(&provider.base_url, &provider.model)?;
        let mut request = websocket_url
            .as_str()
            .into_client_request()
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("failed to create realtime audio websocket request: {error}"),
                )
            })?;
        apply_ws_auth(&provider, request.headers_mut())?;
        apply_ws_custom_headers(&provider, request.headers_mut())?;
        let (mut socket, _) = connect(request).map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("realtime audio websocket connect failed: {error}"),
            )
        })?;
        apply_websocket_timeouts(&mut socket, websocket_timeout)?;

        let request_id = format!("realtime-audio-{}", now_marker());
        let safe_id = request_id.replace([':', '-'], "_");
        let mut session = json!({
          "event_id": format!("evt_{}_session", safe_id),
          "type": "session.update",
          "session": {
            "modalities": ["text", "audio"],
            "instructions": format!(
              "You are a speech synthesizer. Read the user-provided {} text aloud exactly. Do not translate, explain, summarize, or add words.",
              target_language
            ),
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "sample_rate": 24000,
            "turn_detection": null
          }
        });
        let trimmed_voice = voice.trim();
        if !trimmed_voice.is_empty() {
            session["session"]["voice"] = json!(trimmed_voice);
        }
        socket
            .send(Message::Text(session.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("realtime audio session.update failed: {error}"),
                )
            })?;

        let item_create = json!({
          "event_id": format!("evt_{}_item", safe_id),
          "type": "conversation.item.create",
          "item": {
            "type": "message",
            "role": "user",
            "content": [
              {
                "type": "input_text",
                "text": text
              }
            ]
          }
        });
        socket
            .send(Message::Text(item_create.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("realtime audio conversation.item.create failed: {error}"),
                )
            })?;

        let response_create = json!({
          "event_id": format!("evt_{}_resp", safe_id),
          "type": "response.create",
          "response": {
            "modalities": ["audio", "text"]
          }
        });
        socket
            .send(Message::Text(response_create.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("realtime audio response.create failed: {error}"),
                )
            })?;

        let started_at = Instant::now();
        let mut pcm_i16 = Vec::new();
        let mut audio_delta_count = 0_u64;
        let mut event_log = vec![ProviderStreamEventRecord {
            event_type: "realtime-audio.requested".to_string(),
            summary: format!("{} realtime audio request started.", provider.display_name),
            segment_id: None,
            text_delta: None,
            text: None,
            audio_chunk_ref: None,
        }];

        loop {
            let message = socket
                .read()
                .map_err(|error| normalize_websocket_read_error(error, websocket_timeout))?;
            match message {
                Message::Text(frame) => {
                    let value: Value = serde_json::from_str(frame.as_str()).map_err(|error| {
                        ProviderRuntimeError::new(
                            "response.unparseable",
                            format!("failed to parse realtime audio websocket frame: {error}"),
                        )
                    })?;
                    let event_type = value.pointer("/type").and_then(Value::as_str).unwrap_or("");
                    match event_type {
                        "response.audio.delta" => {
                            if let Some(delta) = value.pointer("/delta").and_then(Value::as_str) {
                                let samples = decode_realtime_audio_delta(delta)?;
                                pcm_i16.extend_from_slice(&samples);
                                audio_delta_count += 1;
                            }
                        }
                        "response.audio.done" => {
                            break;
                        }
                        "response.done" if !pcm_i16.is_empty() => {
                            break;
                        }
                        "error" => {
                            let code = value
                                .pointer("/error/code")
                                .and_then(Value::as_str)
                                .unwrap_or("realtime.error");
                            let message = value
                                .pointer("/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("realtime audio request failed");
                            return Err(ProviderRuntimeError::new(code, message));
                        }
                        _ => {}
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }

        if pcm_i16.is_empty() {
            return Err(ProviderRuntimeError::new(
                "response.empty_audio",
                "Realtime audio response completed without response.audio.delta.",
            ));
        }

        let duration_ms = started_at.elapsed().as_millis() as u64;
        let audio_seconds = pcm_i16.len() as f64 / 24_000_f64;
        event_log.push(ProviderStreamEventRecord {
            event_type: "realtime-audio.completed".to_string(),
            summary: format!(
                "Realtime audio completed: deltas={} samples={}.",
                audio_delta_count,
                pcm_i16.len()
            ),
            segment_id: None,
            text_delta: None,
            text: None,
            audio_chunk_ref: Some(request_id.clone()),
        });

        Ok(TtsSynthesisResult {
            request_id: request_id.clone(),
            provider_id: provider.provider_id.clone(),
            model: provider.model,
            voice_preset_id: voice,
            duration_ms,
            audio_seconds,
            audio: TtsAudioChunk {
                sample_rate_hz: 24_000,
                channel_count: 1,
                pcm_i16,
            },
            event_log,
        })
    }

    fn execute_openai(
        &self,
        provider: &ProviderDraftInput,
        transport_effective: &str,
        request_id: &str,
        source_text: &str,
        source_language: &str,
        target_language: &str,
    ) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
        let endpoint = join_url(&provider.base_url, "chat/completions")?;
        let client = build_client(provider.timeout_ms)?;
        let messages = build_messages(provider, source_text, source_language, target_language, &[]);
        let payload = json!({
          "model": provider.model,
          "stream": transport_effective == "streaming-http",
          "messages": messages,
          "temperature": provider.temperature,
          "max_tokens": provider.max_output_tokens,
          "modalities": provider.response_modalities
        });
        let response = client
            .post(endpoint)
            .headers(build_reqwest_headers(provider)?)
            .json(&payload)
            .send()
            .map_err(normalize_transport_error)?;

        if !response.status().is_success() {
            return Err(parse_openai_error(response));
        }

        let mut result = ProviderSmokeResult {
            request_id: request_id.to_string(),
            provider_id: provider.provider_id.clone(),
            status: "completed".to_string(),
            transport_requested: transport_effective.to_string(),
            transport_effective: transport_effective.to_string(),
            fallback_applied: false,
            stream_observed: false,
            duration_ms: 0,
            first_event_latency_ms: None,
            transcript: String::new(),
            source_language: source_language.to_string(),
            target_language: target_language.to_string(),
            event_log: vec![ProviderStreamEventRecord {
                event_type: "session.started".to_string(),
                summary: format!("{} 已建立请求会话。", provider.display_name),
                segment_id: None,
                text_delta: None,
                text: None,
                audio_chunk_ref: None,
            }],
            input_tokens: None,
            output_tokens: None,
            audio_seconds: None,
            routing_decision: build_routing_decision("available", 0, false),
            error: None,
        };
        let started = Instant::now();

        if transport_effective == "streaming-http" {
            let body = response.text().map_err(normalize_transport_error)?;
            let mut reasoning_transcript = String::new();
            for raw_line in body.lines() {
                let line = raw_line.trim();
                if !line.starts_with("data:") {
                    continue;
                }

                let payload = line.trim_start_matches("data:").trim();
                if payload == "[DONE]" {
                    break;
                }

                let value: Value = serde_json::from_str(payload).map_err(|error| {
                    ProviderRuntimeError::new(
                        "response.unparseable",
                        format!("无法解析 OpenAI Compatible SSE 事件: {error}"),
                    )
                })?;

                if let Some(delta) = extract_openai_delta(&value) {
                    if result.first_event_latency_ms.is_none() {
                        result.first_event_latency_ms = Some(started.elapsed().as_millis() as u64);
                    }
                    result.stream_observed = true;
                    result.transcript.push_str(&delta);
                    result.event_log.push(ProviderStreamEventRecord {
                        event_type: "translation.delta".to_string(),
                        summary: format!("收到增量文本: {}", delta),
                        segment_id: Some("segment-1".to_string()),
                        text_delta: Some(delta),
                        text: None,
                        audio_chunk_ref: None,
                    });
                } else if let Some(delta) = extract_openai_reasoning_delta(&value) {
                    if result.first_event_latency_ms.is_none() {
                        result.first_event_latency_ms = Some(started.elapsed().as_millis() as u64);
                    }
                    result.stream_observed = true;
                    reasoning_transcript.push_str(&delta);
                }

                if let Some((input_tokens, output_tokens)) = extract_openai_usage(&value) {
                    result.input_tokens = Some(input_tokens);
                    result.output_tokens = Some(output_tokens);
                    result.event_log.push(ProviderStreamEventRecord {
                        event_type: "usage.updated".to_string(),
                        summary: format!(
                            "usage 已更新: input={} / output={}",
                            input_tokens, output_tokens
                        ),
                        segment_id: None,
                        text_delta: None,
                        text: None,
                        audio_chunk_ref: None,
                    });
                }
            }

            if result.transcript.trim().is_empty() {
                if let Some(text) = extract_translation_from_reasoning(&reasoning_transcript) {
                    result.transcript = sanitize_model_translation(&text);
                }
            }

            if !result.transcript.is_empty() {
                result.event_log.push(ProviderStreamEventRecord {
                    event_type: "translation.completed".to_string(),
                    summary: "流式翻译分段已完成。".to_string(),
                    segment_id: Some("segment-1".to_string()),
                    text_delta: None,
                    text: Some(result.transcript.clone()),
                    audio_chunk_ref: None,
                });
            }
        } else {
            let value: Value = response.json().map_err(normalize_transport_error)?;
            let text = extract_openai_completion_text(&value)?;
            result.first_event_latency_ms = Some(started.elapsed().as_millis() as u64);
            result.transcript = text.clone();
            if let Some((input_tokens, output_tokens)) = extract_openai_usage(&value) {
                result.input_tokens = Some(input_tokens);
                result.output_tokens = Some(output_tokens);
            }
            result.event_log.push(ProviderStreamEventRecord {
                event_type: "translation.completed".to_string(),
                summary: "HTTP 请求已完成整段翻译。".to_string(),
                segment_id: Some("segment-1".to_string()),
                text_delta: None,
                text: Some(text),
                audio_chunk_ref: None,
            });
        }

        result.event_log.push(ProviderStreamEventRecord {
            event_type: "response.completed".to_string(),
            summary: "Provider 响应已结束。".to_string(),
            segment_id: None,
            text_delta: None,
            text: None,
            audio_chunk_ref: None,
        });

        Ok(result)
    }

    fn execute_dashscope(
        &self,
        provider: &ProviderDraftInput,
        transport_effective: &str,
        request_id: &str,
        source_text: &str,
        source_language: &str,
        target_language: &str,
    ) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
        if transport_effective == "websocket" {
            return self.execute_dashscope_websocket(
                provider,
                request_id,
                source_text,
                source_language,
                target_language,
            );
        }

        let endpoint = join_url(
            &provider.base_url,
            "services/aigc/text-generation/generation",
        )?;
        let client = build_client(provider.timeout_ms)?;
        let payload = json!({
          "model": provider.model,
          "input": {
            "messages": build_messages(provider, source_text, source_language, target_language, &[])
          },
          "parameters": {
            "result_format": "message",
            "incremental_output": false,
            "temperature": provider.temperature,
            "max_tokens": provider.max_output_tokens
          }
        });
        let response = client
            .post(endpoint)
            .headers(build_reqwest_headers(provider)?)
            .json(&payload)
            .send()
            .map_err(normalize_transport_error)?;

        if !response.status().is_success() {
            return Err(parse_dashscope_error(response));
        }

        let value: Value = response.json().map_err(normalize_transport_error)?;
        let text = extract_dashscope_text(&value)?;
        Ok(ProviderSmokeResult {
            request_id: request_id.to_string(),
            provider_id: provider.provider_id.clone(),
            status: "completed".to_string(),
            transport_requested: transport_effective.to_string(),
            transport_effective: transport_effective.to_string(),
            fallback_applied: false,
            stream_observed: false,
            duration_ms: 0,
            first_event_latency_ms: Some(0),
            transcript: text.clone(),
            source_language: source_language.to_string(),
            target_language: target_language.to_string(),
            event_log: vec![
                ProviderStreamEventRecord {
                    event_type: "session.started".to_string(),
                    summary: format!("{} 已建立请求会话。", provider.display_name),
                    segment_id: None,
                    text_delta: None,
                    text: None,
                    audio_chunk_ref: None,
                },
                ProviderStreamEventRecord {
                    event_type: "translation.completed".to_string(),
                    summary: "DashScope HTTP 返回完整文本。".to_string(),
                    segment_id: Some("segment-1".to_string()),
                    text_delta: None,
                    text: Some(text),
                    audio_chunk_ref: None,
                },
                ProviderStreamEventRecord {
                    event_type: "response.completed".to_string(),
                    summary: "Provider 响应已结束。".to_string(),
                    segment_id: None,
                    text_delta: None,
                    text: None,
                    audio_chunk_ref: None,
                },
            ],
            input_tokens: value.pointer("/usage/input_tokens").and_then(Value::as_u64),
            output_tokens: value
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64),
            audio_seconds: None,
            routing_decision: build_routing_decision("available", 0, false),
            error: None,
        })
    }

    fn execute_dashscope_websocket(
        &self,
        provider: &ProviderDraftInput,
        request_id: &str,
        source_text: &str,
        source_language: &str,
        target_language: &str,
    ) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
        if provider.model.to_ascii_lowercase().contains("realtime") {
            return self.execute_dashscope_realtime_websocket(
                provider,
                request_id,
                source_text,
                source_language,
                target_language,
            );
        }

        let websocket_timeout = resolve_websocket_timeout(provider.timeout_ms);
        let websocket_url = to_websocket_url(&provider.base_url, &provider.model)?;
        let mut request = websocket_url
            .as_str()
            .into_client_request()
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("无法创建 WebSocket 请求: {error}"),
                )
            })?;
        apply_ws_auth(provider, request.headers_mut())?;
        apply_ws_custom_headers(provider, request.headers_mut())?;
        let (mut socket, _) = connect(request).map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("DashScope WebSocket 建链失败: {error}"),
            )
        })?;
        apply_websocket_timeouts(&mut socket, websocket_timeout)?;
        let payload = json!({
          "request_id": request_id,
          "model": provider.model,
          "input": {
            "messages": build_messages(provider, source_text, source_language, target_language, &[])
          },
          "parameters": {
            "stream": true,
            "region": provider.region
          }
        });
        socket
            .send(Message::Text(payload.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("DashScope WebSocket 发送失败: {error}"),
                )
            })?;

        let started = Instant::now();
        let mut result = ProviderSmokeResult {
            request_id: request_id.to_string(),
            provider_id: provider.provider_id.clone(),
            status: "completed".to_string(),
            transport_requested: "websocket".to_string(),
            transport_effective: "websocket".to_string(),
            fallback_applied: false,
            stream_observed: false,
            duration_ms: 0,
            first_event_latency_ms: None,
            transcript: String::new(),
            source_language: source_language.to_string(),
            target_language: target_language.to_string(),
            event_log: vec![ProviderStreamEventRecord {
                event_type: "session.started".to_string(),
                summary: format!("{} WebSocket 会话已建立。", provider.display_name),
                segment_id: None,
                text_delta: None,
                text: None,
                audio_chunk_ref: None,
            }],
            input_tokens: None,
            output_tokens: None,
            audio_seconds: None,
            routing_decision: build_routing_decision("available", 0, false),
            error: None,
        };

        loop {
            let message = socket
                .read()
                .map_err(|error| normalize_websocket_read_error(error, websocket_timeout))?;
            match message {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(text.as_str()).map_err(|error| {
                        ProviderRuntimeError::new(
                            "response.unparseable",
                            format!("无法解析 DashScope WebSocket 响应: {error}"),
                        )
                    })?;

                    if let Some(delta) = extract_dashscope_delta(&value) {
                        if result.first_event_latency_ms.is_none() {
                            result.first_event_latency_ms =
                                Some(started.elapsed().as_millis() as u64);
                        }
                        result.stream_observed = true;
                        result.transcript.push_str(&delta);
                        result.event_log.push(ProviderStreamEventRecord {
                            event_type: "translation.delta".to_string(),
                            summary: format!("收到 DashScope 增量文本: {}", delta),
                            segment_id: Some("segment-1".to_string()),
                            text_delta: Some(delta),
                            text: None,
                            audio_chunk_ref: None,
                        });
                    }

                    if let Some((input_tokens, output_tokens)) = extract_dashscope_usage(&value) {
                        result.input_tokens = Some(input_tokens);
                        result.output_tokens = Some(output_tokens);
                        result.event_log.push(ProviderStreamEventRecord {
                            event_type: "usage.updated".to_string(),
                            summary: format!(
                                "usage 已更新: input={} / output={}",
                                input_tokens, output_tokens
                            ),
                            segment_id: None,
                            text_delta: None,
                            text: None,
                            audio_chunk_ref: None,
                        });
                    }

                    if extract_dashscope_completed(&value) {
                        result.event_log.push(ProviderStreamEventRecord {
                            event_type: "translation.completed".to_string(),
                            summary: "DashScope WebSocket 分段已完成。".to_string(),
                            segment_id: Some("segment-1".to_string()),
                            text_delta: None,
                            text: Some(result.transcript.clone()),
                            audio_chunk_ref: None,
                        });
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }

        result.event_log.push(ProviderStreamEventRecord {
            event_type: "response.completed".to_string(),
            summary: "Provider 响应已结束。".to_string(),
            segment_id: None,
            text_delta: None,
            text: None,
            audio_chunk_ref: None,
        });

        Ok(result)
    }

    fn execute_dashscope_realtime_websocket(
        &self,
        provider: &ProviderDraftInput,
        request_id: &str,
        source_text: &str,
        source_language: &str,
        target_language: &str,
    ) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
        let websocket_timeout = resolve_websocket_timeout(provider.timeout_ms);
        let websocket_url = to_websocket_url(&provider.base_url, &provider.model)?;
        let mut request = websocket_url
            .as_str()
            .into_client_request()
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("无法创建 WebSocket 请求: {error}"),
                )
            })?;
        apply_ws_auth(provider, request.headers_mut())?;
        apply_ws_custom_headers(provider, request.headers_mut())?;
        let (mut socket, _) = connect(request).map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("DashScope Realtime WebSocket 建链失败: {error}"),
            )
        })?;
        apply_websocket_timeouts(&mut socket, websocket_timeout)?;

        let safe_id = request_id.replace([':', '-'], "_");
        let instructions = format!(
      "promptTemplateId={}\nsourceLanguage={}\ntargetLanguage={}\n请输出自然、简洁、可直接展示的翻译。",
      provider.system_prompt_template, source_language, target_language,
    );

        let session_update = json!({
          "event_id": format!("evt_{}_session", safe_id),
          "type": "session.update",
          "session": {
            "modalities": provider.response_modalities,
            "instructions": instructions,
            "turn_detection": null
          }
        });
        socket
            .send(Message::Text(session_update.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("DashScope Realtime session.update 发送失败: {error}"),
                )
            })?;

        let item_create = json!({
          "event_id": format!("evt_{}_item", safe_id),
          "type": "conversation.item.create",
          "item": {
            "type": "message",
            "role": "user",
            "content": [
              {
                "type": "input_text",
                "text": source_text
              }
            ]
          }
        });
        socket
            .send(Message::Text(item_create.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("DashScope Realtime conversation.item.create 发送失败: {error}"),
                )
            })?;

        let response_create = json!({
          "event_id": format!("evt_{}_resp", safe_id),
          "type": "response.create"
        });
        socket
            .send(Message::Text(response_create.to_string().into()))
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("DashScope Realtime response.create 发送失败: {error}"),
                )
            })?;

        let started = Instant::now();
        let mut result = ProviderSmokeResult {
            request_id: request_id.to_string(),
            provider_id: provider.provider_id.clone(),
            status: "completed".to_string(),
            transport_requested: "websocket".to_string(),
            transport_effective: "websocket".to_string(),
            fallback_applied: false,
            stream_observed: false,
            duration_ms: 0,
            first_event_latency_ms: None,
            transcript: String::new(),
            source_language: source_language.to_string(),
            target_language: target_language.to_string(),
            event_log: vec![ProviderStreamEventRecord {
                event_type: "session.started".to_string(),
                summary: format!("{} Realtime WebSocket 会话已建立。", provider.display_name),
                segment_id: None,
                text_delta: None,
                text: None,
                audio_chunk_ref: None,
            }],
            input_tokens: None,
            output_tokens: None,
            audio_seconds: None,
            routing_decision: build_routing_decision("available", 0, false),
            error: None,
        };

        loop {
            let message = socket
                .read()
                .map_err(|error| normalize_websocket_read_error(error, websocket_timeout))?;
            match message {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(text.as_str()).map_err(|error| {
                        ProviderRuntimeError::new(
                            "response.unparseable",
                            format!("无法解析 DashScope Realtime WebSocket 响应: {error}"),
                        )
                    })?;

                    let event_type = value.pointer("/type").and_then(Value::as_str).unwrap_or("");

                    if event_type == "response.text.delta" {
                        if let Some(delta) = value.pointer("/delta").and_then(Value::as_str) {
                            if result.first_event_latency_ms.is_none() {
                                result.first_event_latency_ms =
                                    Some(started.elapsed().as_millis() as u64);
                            }
                            result.stream_observed = true;
                            result.transcript.push_str(delta);
                            result.event_log.push(ProviderStreamEventRecord {
                                event_type: "translation.delta".to_string(),
                                summary: format!("收到 DashScope Realtime 增量文本: {}", delta),
                                segment_id: Some("segment-1".to_string()),
                                text_delta: Some(delta.to_string()),
                                text: None,
                                audio_chunk_ref: None,
                            });
                        }
                    }

                    if event_type == "response.text.done" {
                        if let Some(text) = value.pointer("/text").and_then(Value::as_str) {
                            result.transcript = text.to_string();
                        }
                    }

                    if event_type == "response.done" {
                        if let Some(usage) = value.pointer("/response/usage") {
                            result.input_tokens =
                                usage.pointer("/input_tokens").and_then(Value::as_u64);
                            result.output_tokens =
                                usage.pointer("/output_tokens").and_then(Value::as_u64);
                            let input = result.input_tokens.unwrap_or(0);
                            let output = result.output_tokens.unwrap_or(0);
                            result.event_log.push(ProviderStreamEventRecord {
                                event_type: "usage.updated".to_string(),
                                summary: format!(
                                    "usage 已更新: input={} / output={}",
                                    input, output
                                ),
                                segment_id: None,
                                text_delta: None,
                                text: None,
                                audio_chunk_ref: None,
                            });
                        }
                        result.event_log.push(ProviderStreamEventRecord {
                            event_type: "translation.completed".to_string(),
                            summary: "DashScope Realtime 响应已完成。".to_string(),
                            segment_id: Some("segment-1".to_string()),
                            text_delta: None,
                            text: Some(result.transcript.clone()),
                            audio_chunk_ref: None,
                        });
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }

        result.event_log.push(ProviderStreamEventRecord {
            event_type: "response.completed".to_string(),
            summary: "Provider 响应已结束。".to_string(),
            segment_id: None,
            text_delta: None,
            text: None,
            audio_chunk_ref: None,
        });

        Ok(result)
    }
}

fn resolve_websocket_timeout(timeout_ms: u64) -> Duration {
    Duration::from_millis(timeout_ms.max(MIN_WEBSOCKET_TIMEOUT_MS))
}

fn apply_websocket_timeouts(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Duration,
) -> Result<(), ProviderRuntimeError> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => apply_tcp_stream_timeouts(stream, timeout),
        MaybeTlsStream::Rustls(stream) => apply_tcp_stream_timeouts(stream.get_mut(), timeout),
        _ => Ok(()),
    }
}

fn apply_tcp_stream_timeouts(
    stream: &mut TcpStream,
    timeout: Duration,
) -> Result<(), ProviderRuntimeError> {
    stream.set_read_timeout(Some(timeout)).map_err(|error| {
        ProviderRuntimeError::new(
            "transport.unavailable",
            format!("无法设置 WebSocket 读超时: {error}"),
        )
    })?;
    stream.set_write_timeout(Some(timeout)).map_err(|error| {
        ProviderRuntimeError::new(
            "transport.unavailable",
            format!("无法设置 WebSocket 写超时: {error}"),
        )
    })?;
    Ok(())
}

fn normalize_websocket_read_error(
    error: WebSocketError,
    timeout: Duration,
) -> ProviderRuntimeError {
    match error {
        WebSocketError::Io(io_error)
            if matches!(io_error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
        {
            ProviderRuntimeError::new(
                "timeout",
                format!(
                    "DashScope WebSocket 在 {} 秒内未返回新的响应事件。",
                    timeout.as_secs().max(1)
                ),
            )
            .retriable(true)
            .with_suggestion("请检查 API Key、模型名与网络连通性，或改用 HTTP 模式继续配置。")
        }
        other => ProviderRuntimeError::new(
            "transport.unavailable",
            format!("DashScope WebSocket 接收失败: {other}"),
        )
        .retriable(true)
        .with_suggestion("请检查 WebSocket 入口、网络连通性和代理设置。"),
    }
}

fn decode_realtime_audio_delta(delta: &str) -> Result<Vec<i16>, ProviderRuntimeError> {
    let bytes = BASE64_STANDARD.decode(delta).map_err(|error| {
        ProviderRuntimeError::new(
            "response.unparseable",
            format!("failed to decode realtime audio delta: {error}"),
        )
    })?;
    if bytes.len() % 2 != 0 {
        return Err(ProviderRuntimeError::new(
            "response.unparseable",
            "realtime audio delta has odd byte length",
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect())
}

fn build_client(timeout_ms: u64) -> Result<Client, ProviderRuntimeError> {
    Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1000)))
        .build()
        .map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("无法创建 HTTP client: {error}"),
            )
        })
}

fn build_reqwest_headers(provider: &ProviderDraftInput) -> Result<HeaderMap, ProviderRuntimeError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    apply_auth_header(provider, &mut headers)?;
    apply_custom_headers(provider, &mut headers)?;
    Ok(headers)
}

fn apply_auth_header(
    provider: &ProviderDraftInput,
    headers: &mut HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    let secret = resolve_secret(&provider.auth_ref)?;
    if let Some(secret) = secret {
        let header_name = HeaderName::from_bytes(provider.auth_ref.header_name.as_bytes())
            .map_err(|error| {
                ProviderRuntimeError::new("request.invalid", format!("非法认证头字段: {error}"))
            })?;
        let value = match provider.auth_ref.scheme.as_str() {
            "bearer" => format!("Bearer {secret}"),
            "api-key" => secret,
            _ => secret,
        };
        let header_value = HeaderValue::from_str(&value).map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法认证头值: {error}"))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

pub(crate) fn apply_ws_auth(
    provider: &ProviderDraftInput,
    headers: &mut tungstenite::http::HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    let secret = resolve_secret(&provider.auth_ref)?;
    if let Some(secret) = secret {
        let header_name = tungstenite::http::header::HeaderName::from_bytes(
            provider.auth_ref.header_name.as_bytes(),
        )
        .map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法认证头字段: {error}"))
        })?;
        let value = match provider.auth_ref.scheme.as_str() {
            "bearer" => format!("Bearer {secret}"),
            "api-key" => secret,
            _ => secret,
        };
        let header_value = tungstenite::http::HeaderValue::from_str(&value).map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法认证头值: {error}"))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

fn apply_custom_headers(
    provider: &ProviderDraftInput,
    headers: &mut HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    for header in provider
        .custom_headers
        .iter()
        .filter(|item| item.enabled && !item.name.trim().is_empty())
    {
        let header_name =
            HeaderName::from_bytes(header.name.trim().as_bytes()).map_err(|error| {
                ProviderRuntimeError::new("request.invalid", format!("非法自定义头字段: {error}"))
            })?;
        let header_value = HeaderValue::from_str(header.value.trim()).map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法自定义头值: {error}"))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

fn apply_ws_custom_headers(
    provider: &ProviderDraftInput,
    headers: &mut tungstenite::http::HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    for header in provider
        .custom_headers
        .iter()
        .filter(|item| item.enabled && !item.name.trim().is_empty())
    {
        let header_name =
            tungstenite::http::header::HeaderName::from_bytes(header.name.trim().as_bytes())
                .map_err(|error| {
                    ProviderRuntimeError::new(
                        "request.invalid",
                        format!("非法自定义头字段: {error}"),
                    )
                })?;
        let header_value =
            tungstenite::http::HeaderValue::from_str(header.value.trim()).map_err(|error| {
                ProviderRuntimeError::new("request.invalid", format!("非法自定义头值: {error}"))
            })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

fn resolve_secret(
    auth_ref: &super::contracts::ProviderAuthRefInput,
) -> Result<Option<String>, ProviderRuntimeError> {
    match auth_ref.scheme.as_str() {
        "none" => Ok(None),
        _ => match auth_ref.kind.as_str() {
            "credential-ref" => {
                let vault = KeyringCredentialVault::new();
                match vault.read_secret(&auth_ref.reference) {
                    Ok(Some(secret)) => Ok(Some(secret)),
                    Ok(None) => Err(ProviderRuntimeError::new(
                        "auth.invalid",
                        "Credential Manager 中不存在对应密钥引用。",
                    )
                    .with_suggestion("请先在 Providers 页面保存 API Key。")),
                    Err(error) => Err(ProviderRuntimeError::new("auth.invalid", error)),
                }
            }
            "env-ref" => std::env::var(&auth_ref.reference).map(Some).map_err(|_| {
                ProviderRuntimeError::new("auth.invalid", "环境变量中不存在对应密钥引用。")
                    .with_suggestion("请检查 env-ref 对应的环境变量名。")
            }),
            _ => Err(ProviderRuntimeError::new(
                "auth.invalid",
                "不支持的认证引用类型。",
            )),
        },
    }
}

fn build_messages(
    provider: &ProviderDraftInput,
    source_text: &str,
    source_language: &str,
    target_language: &str,
    glossary_package_ids: &[String],
) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut system_text = format!(
    "promptTemplateId={}\nsourceLanguage={}\ntargetLanguage={}\n请输出自然、简洁、可直接展示的翻译。",
    provider.system_prompt_template,
    source_language,
    target_language,
  );
    system_text.push_str(
        "\nOutput only the translated text. Do not include explanations, markdown, reasoning, or <think> tags.",
    );
    if !glossary_package_ids.is_empty() {
        system_text.push_str(&format!(
            "\nglossaryPackageIds={}",
            glossary_package_ids.join(",")
        ));
    }
    messages.push(json!({ "role": "system", "content": system_text }));
    messages.push(json!({ "role": "user", "content": source_text }));
    messages
}

fn resolve_transport(provider: &ProviderDraftInput) -> (String, bool) {
    match provider.kind.as_str() {
        "openai-compatible" => match provider.transport.as_str() {
            "http" => ("http".to_string(), false),
            "streaming-http" => {
                if provider.stream_enabled {
                    ("streaming-http".to_string(), false)
                } else {
                    ("http".to_string(), true)
                }
            }
            "websocket" => ("streaming-http".to_string(), true),
            _ => ("http".to_string(), true),
        },
        "dashscope" => match provider.transport.as_str() {
            "websocket" => {
                if provider.stream_enabled {
                    ("websocket".to_string(), false)
                } else {
                    ("http".to_string(), true)
                }
            }
            "http" => ("http".to_string(), false),
            "streaming-http" => ("http".to_string(), true),
            _ => ("http".to_string(), true),
        },
        _ => ("http".to_string(), true),
    }
}

fn build_routing_decision(
    verdict: &str,
    latency_ms: u64,
    fallback_applied: bool,
) -> ProviderRoutingDecision {
    match verdict {
        "available" => ProviderRoutingDecision {
            subtitle_priority: "balanced".to_string(),
            speech_disposition: "ready".to_string(),
            rationale: if fallback_applied {
                "已做传输回退，但当前延迟和结构稳定性仍满足实时要求。".to_string()
            } else {
                format!("当前延迟 {} ms，允许字幕与译音并行。", latency_ms)
            },
        },
        "realtime-risk" => ProviderRoutingDecision {
            subtitle_priority: "subtitle-first".to_string(),
            speech_disposition: "deferred".to_string(),
            rationale: format!(
                "当前延迟 {} ms 超过预算，优先保证字幕不断流，译音进入 deferred。",
                latency_ms
            ),
        },
        _ => ProviderRoutingDecision {
            subtitle_priority: "subtitle-first".to_string(),
            speech_disposition: "queued".to_string(),
            rationale: "当前 Provider 不可用或响应结构不稳定，禁止进入实时主链路。".to_string(),
        },
    }
}

fn build_probe_guidance(
    verdict: &str,
    routing_decision: &ProviderRoutingDecision,
    fallback_applied: bool,
) -> Vec<String> {
    let mut guidance = vec![routing_decision.rationale.clone()];
    if fallback_applied {
        guidance.push(
            "本次探测已发生 transport fallback，请检查模板默认传输模式是否与上游一致。".to_string(),
        );
    }
    match verdict {
        "available" => {
            guidance.push("可直接用于真实 Provider 连通性测试与后续字幕/译音主链路。".to_string())
        }
        "realtime-risk" => {
            guidance.push("建议保留字幕优先，默认关闭译音叠加，避免阻塞实时字幕。".to_string())
        }
        _ => guidance.push("建议先修复认证、请求路径或响应格式，再重新探测。".to_string()),
    }
    guidance
}

fn join_url(base_url: &str, path: &str) -> Result<String, ProviderRuntimeError> {
    let base = base_url.trim_end_matches('/');
    if base.is_empty() {
        return Err(ProviderRuntimeError::new(
            "request.invalid",
            "Base URL 不能为空。",
        ));
    }

    Ok(format!("{base}/{}", path.trim_start_matches('/')))
}

fn resolve_models_endpoint(provider: &ProviderDraftInput) -> Result<String, ProviderRuntimeError> {
    match provider.kind.as_str() {
        "dashscope" => join_url(
            &normalize_dashscope_compatible_base_url(&provider.base_url),
            "models",
        ),
        "openai-compatible" => join_url(&provider.base_url, "models"),
        _ => Err(ProviderRuntimeError::new(
            "request.invalid",
            "当前 Provider 不支持拉取模型目录。",
        )),
    }
}

fn normalize_dashscope_compatible_base_url(base_url: &str) -> String {
    if base_url.contains("/compatible-mode/v1") {
        return base_url.trim_end_matches('/').to_string();
    }

    if base_url.contains("/api/v1") {
        return base_url
            .replace("/api/v1", "/compatible-mode/v1")
            .trim_end_matches('/')
            .to_string();
    }

    format!("{}/compatible-mode/v1", base_url.trim_end_matches('/'))
}

fn parse_model_catalog_response(
    value: &Value,
) -> Result<Vec<ProviderModelRuntime>, ProviderRuntimeError> {
    let entries = value
        .pointer("/data")
        .and_then(Value::as_array)
        .or_else(|| value.pointer("/models").and_then(Value::as_array))
        .ok_or_else(|| {
            ProviderRuntimeError::new("response.unparseable", "模型目录响应中缺少 data 数组。")
        })?;

    let models = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }

            Some(ProviderModelRuntime {
                id: id.to_string(),
                display_name: entry
                    .get("display_name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(id)
                    .to_string(),
                owned_by: entry
                    .get("owned_by")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                created_at: entry.get("created").and_then(Value::as_u64),
                capabilities: derive_model_capabilities(id),
            })
        })
        .collect::<Vec<_>>();

    if models.is_empty() {
        return Err(ProviderRuntimeError::new(
            "response.unparseable",
            "模型目录响应中没有可用模型条目。",
        ));
    }

    Ok(models)
}

fn derive_model_capabilities(model_id: &str) -> Vec<String> {
    let normalized = model_id.to_ascii_lowercase();
    let mut capabilities = vec!["translation".to_string()];

    if normalized.contains("realtime") || normalized.contains("live") {
        capabilities.push("realtime-translation".to_string());
    }

    if normalized.contains("tts")
        || normalized.contains("speech")
        || normalized.contains("audio")
        || normalized.contains("cosyvoice")
        || normalized.contains("sambert")
    {
        capabilities.push("text-to-speech".to_string());
    }

    capabilities
}

pub(crate) fn to_websocket_url(base_url: &str, model: &str) -> Result<Url, ProviderRuntimeError> {
    let mut url = Url::parse(base_url).map_err(|error| {
        ProviderRuntimeError::new("request.invalid", format!("非法 Base URL: {error}"))
    })?;
    match url.scheme() {
        "http" => url.set_scheme("ws").map_err(|_| {
            ProviderRuntimeError::new("request.invalid", "无法把 HTTP 入口转换为 WS。")
        })?,
        "https" => url.set_scheme("wss").map_err(|_| {
            ProviderRuntimeError::new("request.invalid", "无法把 HTTPS 入口转换为 WSS。")
        })?,
        "ws" | "wss" => {}
        _ => {
            return Err(ProviderRuntimeError::new(
                "request.invalid",
                "不支持的 WebSocket URL 协议。",
            ))
        }
    }

    // DashScope realtime translation follows the documented fixed websocket route.
    url.set_path("/api-ws/v1/realtime");
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        query.append_pair("model", model);
    }

    Ok(url)
}

fn normalize_transport_error(error: reqwest::Error) -> ProviderRuntimeError {
    if error.is_timeout() {
        return ProviderRuntimeError::new("timeout", format!("上游请求超时: {error}"))
            .retriable(true)
            .with_suggestion("可适当提高 timeoutMs，或优先保留字幕优先模式。");
    }

    ProviderRuntimeError::new("transport.unavailable", format!("上游传输不可用: {error}"))
        .retriable(true)
        .with_suggestion("请检查 baseUrl、网络连通性和代理设置。")
}

fn parse_openai_error(response: Response) -> ProviderRuntimeError {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let provider_code = value
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("OpenAI Compatible 上游返回错误");
    map_error_from_status_and_code(status, provider_code, message).with_http_status(status)
}

fn parse_dashscope_error(response: Response) -> ProviderRuntimeError {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let provider_code = value
        .pointer("/code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = value
        .pointer("/message")
        .and_then(Value::as_str)
        .unwrap_or("DashScope 上游返回错误");
    map_error_from_status_and_code(status, provider_code, message).with_http_status(status)
}

fn map_error_from_status_and_code(
    status: u16,
    provider_code: &str,
    message: &str,
) -> ProviderRuntimeError {
    let provider_code_lower = provider_code.to_ascii_lowercase();
    let message_lower = message.to_ascii_lowercase();

    if status == 401 || status == 403 {
        return ProviderRuntimeError::new("auth.invalid", message)
            .with_provider_code(provider_code)
            .with_suggestion("请检查认证头和 Credential Manager 中的密钥。");
    }

    if status == 429 || provider_code_lower.contains("rate") {
        return ProviderRuntimeError::new("rate-limited", message)
            .with_provider_code(provider_code)
            .with_suggestion("请降低请求频率或切换到字幕优先降级模式。")
            .retriable(true);
    }

    if provider_code_lower.contains("model") || message_lower.contains("model") {
        return ProviderRuntimeError::new("model.unsupported", message)
            .with_provider_code(provider_code)
            .with_suggestion("请确认模型名与当前 transport 是否匹配。");
    }

    if status == 408 {
        return ProviderRuntimeError::new("timeout", message)
            .with_provider_code(provider_code)
            .retriable(true);
    }

    if status >= 500 {
        return ProviderRuntimeError::new("upstream.internal", message)
            .with_provider_code(provider_code)
            .retriable(true)
            .with_suggestion("上游暂时不可用，可稍后重试或切换 Provider。")
            .with_http_status(status);
    }

    ProviderRuntimeError::new("request.invalid", message)
        .with_provider_code(provider_code)
        .with_http_status(status)
}

fn extract_openai_delta(value: &Value) -> Option<String> {
    extract_openai_text_at(value, "/choices/0/delta/content")
        .or_else(|| extract_openai_text_at(value, "/choices/0/delta/text"))
        .or_else(|| extract_openai_text_at(value, "/choices/0/text"))
        .or_else(|| extract_openai_text_at(value, "/delta"))
}

fn extract_openai_reasoning_delta(value: &Value) -> Option<String> {
    extract_openai_text_at(value, "/choices/0/delta/reasoning_content")
        .or_else(|| extract_openai_text_at(value, "/choices/0/message/reasoning_content"))
}

fn extract_openai_completion_text(value: &Value) -> Result<String, ProviderRuntimeError> {
    extract_openai_text_at(value, "/choices/0/message/content")
        .or_else(|| extract_openai_text_at(value, "/choices/0/text"))
        .or_else(|| extract_openai_text_at(value, "/response"))
        .or_else(|| {
            value
                .pointer("/choices/0/message/reasoning_content")
                .and_then(Value::as_str)
                .and_then(extract_translation_from_reasoning)
        })
        .map(|text| sanitize_model_translation(&text))
        .ok_or_else(|| {
            ProviderRuntimeError::new(
                "response.unparseable",
                "OpenAI Compatible 返回中缺少可解析文本。",
            )
        })
}

fn extract_openai_text_at(value: &Value, pointer: &str) -> Option<String> {
    let value = value.pointer(pointer)?;
    extract_text_value(value).filter(|text| !text.trim().is_empty())
}

fn extract_text_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(ToString::to_string)
                        .or_else(|| {
                            item.get("text")
                                .and_then(Value::as_str)
                                .map(ToString::to_string)
                        })
                        .or_else(|| {
                            item.get("content")
                                .and_then(Value::as_str)
                                .map(ToString::to_string)
                        })
                })
                .collect::<Vec<_>>()
                .join("");
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| {
                object
                    .get("content")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            }),
        _ => None,
    }
}

fn extract_translation_from_reasoning(reasoning: &str) -> Option<String> {
    const MARKERS: [&str; 8] = [
        "Final decision:",
        "Decision:",
        "Translation:",
        "Final:",
        "译文：",
        "译文:",
        "最终译文：",
        "最终答案：",
    ];

    for raw_line in reasoning.lines().rev() {
        let line = raw_line.trim();
        for marker in MARKERS {
            if let Some(index) = line.find(marker) {
                let candidate = clean_reasoning_candidate(&line[index + marker.len()..]);
                if is_displayable_translation_candidate(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

#[allow(dead_code)]
fn extract_longest_cjk_candidate(text: &str) -> Option<String> {
    let mut best = String::new();
    let mut current = String::new();
    for ch in text.chars() {
        if is_cjk(ch)
            || matches!(
                ch,
                '，' | '。' | '、' | '；' | '：' | '！' | '？' | '（' | '）'
            )
        {
            current.push(ch);
        } else {
            if current.chars().filter(|ch| is_cjk(*ch)).count()
                > best.chars().filter(|ch| is_cjk(*ch)).count()
            {
                best = current.clone();
            }
            current.clear();
        }
    }

    if current.chars().filter(|ch| is_cjk(*ch)).count()
        > best.chars().filter(|ch| is_cjk(*ch)).count()
    {
        best = current;
    }

    let best = clean_reasoning_candidate(&best);
    if is_displayable_translation_candidate(&best) {
        Some(best)
    } else {
        None
    }
}

fn clean_reasoning_candidate(text: &str) -> String {
    sanitize_model_translation(text)
}

fn sanitize_model_translation(text: &str) -> String {
    let mut text = text
        .replace("<think>", "")
        .replace("</think>", "")
        .replace("` tags in the final output", "");

    if let Some(index) = find_first_noise_marker(&text) {
        text.truncate(index);
    }

    let mut text = text.trim();
    for prefix in [
        "Literal:",
        "Translation:",
        "Final:",
        "Final answer:",
        "Final decision:",
        "Decision:",
        "Answer:",
        "Result:",
        "Output:",
        "Translated text:",
    ] {
        if let Some(stripped) = text.strip_prefix(prefix) {
            text = stripped.trim();
            break;
        }
    }

    text.trim()
        .trim_start_matches(|ch: char| {
            ch.is_whitespace()
                || ch == '*'
                || ch == '-'
                || ch == ':'
                || ch == '：'
                || ch == '`'
                || ch == '"'
                || ch == '\''
        })
        .trim_end_matches(|ch: char| ch.is_whitespace() || ch == '`' || ch == '"' || ch == '\'')
        .to_string()
}

fn find_first_noise_marker(text: &str) -> Option<usize> {
    [
        "Thinking Process:",
        "Analyze the Request",
        "Analyze the Source Text",
        "**Analyze",
        "The prompt says",
        "Output only the translated text",
        "I am currently in the thinking block",
    ]
    .iter()
    .filter_map(|marker| text.find(marker))
    .min()
}

fn is_displayable_translation_candidate(text: &str) -> bool {
    let text = text.trim();
    if text.len() < 3
        || text.contains("Thinking Process")
        || text.contains("Analyze the")
        || text.contains("The prompt says")
        || text.contains("final output")
        || text.contains("<think>")
        || text.contains("</think>")
    {
        return false;
    }

    let cjk_count = text.chars().filter(|ch| is_cjk(*ch)).count();
    if cjk_count == 0 {
        return false;
    }

    let ascii_alpha_count = text.chars().filter(|ch| ch.is_ascii_alphabetic()).count();
    ascii_alpha_count <= cjk_count
}

fn is_cjk(ch: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&ch)
        || ('\u{f900}'..='\u{faff}').contains(&ch)
        || ('\u{20000}'..='\u{2a6df}').contains(&ch)
        || ('\u{2a700}'..='\u{2b73f}').contains(&ch)
        || ('\u{2b740}'..='\u{2b81f}').contains(&ch)
        || ('\u{2b820}'..='\u{2ceaf}').contains(&ch)
}

fn extract_openai_usage(value: &Value) -> Option<(u64, u64)> {
    Some((
        value.pointer("/usage/prompt_tokens")?.as_u64()?,
        value.pointer("/usage/completion_tokens")?.as_u64()?,
    ))
}

fn extract_dashscope_text(value: &Value) -> Result<String, ProviderRuntimeError> {
    value
        .pointer("/output/text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            value
                .pointer("/output/choices/0/message/content/0/text")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| {
            value
                .pointer("/output/choices/0/message/content")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .ok_or_else(|| {
            ProviderRuntimeError::new("response.unparseable", "DashScope 返回中缺少可解析文本。")
        })
}

fn extract_dashscope_delta(value: &Value) -> Option<String> {
    value
        .pointer("/output/text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            value
                .pointer("/event/textDelta")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn extract_dashscope_usage(value: &Value) -> Option<(u64, u64)> {
    Some((
        value.pointer("/usage/input_tokens")?.as_u64()?,
        value.pointer("/usage/output_tokens")?.as_u64()?,
    ))
}

fn extract_dashscope_completed(value: &Value) -> bool {
    value.pointer("/event/type").and_then(Value::as_str) == Some("response.completed")
        || value
            .pointer("/output/finish_reason")
            .and_then(Value::as_str)
            .is_some()
}

fn now_marker() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("unix:{}", duration.as_secs()),
        Err(_) => "unix:0".to_string(),
    }
}

fn normalize_timestamp(timestamp: &str) -> String {
    timestamp.replace(':', "-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::contracts::ProviderAuthRefInput;
    use rodio::{Decoder, Source};
    use serde::Deserialize;
    use std::collections::HashMap;
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::thread;
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
            "This is a one billion dollar rocket ship.".to_string(),
            "en-US".to_string(),
            "zh-CN".to_string(),
        );

        assert_eq!(smoke.status, "completed");
        assert_eq!(smoke.transcript, "这是一艘价值十亿美元的火箭飞船。");
        assert!(smoke.stream_observed);
    }

    #[test]
    fn openai_completion_reads_array_content() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "火箭" },
                        { "type": "text", "text": "飞船" }
                    ]
                }
            }]
        });

        let text = extract_openai_completion_text(&value).expect("text should parse");

        assert_eq!(text, "火箭飞船");
    }

    #[test]
    fn openai_completion_extracts_translation_from_reasoning_content() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "reasoning_content": "Thinking Process:\n* Draft: 这是一艘火箭。\nDecision: 这是一艘价值十亿美元的火箭飞船。"
                }
            }]
        });

        let text = extract_openai_completion_text(&value).expect("reasoning text should parse");

        assert_eq!(text, "这是一艘价值十亿美元的火箭飞船。");
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
            .any(|item| item == "realtime-translation"));
    }

    #[test]
    fn dashscope_model_catalog_switches_to_compatible_mode_endpoint() {
        let endpoint = resolve_models_endpoint(&dashscope_provider(
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

        let websocket_timeout = resolve_websocket_timeout(provider.timeout_ms);
        let websocket_url = to_websocket_url(&provider.base_url, &provider.model)?;
        let mut request = websocket_url
            .as_str()
            .into_client_request()
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("failed to create realtime audio websocket request: {error}"),
                )
            })?;
        apply_ws_auth(&provider, request.headers_mut())?;
        apply_ws_custom_headers(&provider, request.headers_mut())?;
        let (mut socket, _) = connect(request).map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("realtime audio websocket connect failed: {error}"),
            )
        })?;
        apply_websocket_timeouts(&mut socket, websocket_timeout)?;

        let request_id = format!("audio-integration-{}", now_marker());
        let safe_id = request_id.replace([':', '-'], "_");
        let session_update = json!({
            "event_id": format!("evt_{}_session", safe_id),
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "voice": "Ethan",
                "instructions": "Transcribe the input audio and translate it to Chinese. Keep the response concise.",
                "input_audio_format": "pcm",
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
