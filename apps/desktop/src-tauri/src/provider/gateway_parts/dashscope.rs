use std::time::Instant;

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

use super::super::contracts::{
    ProviderDraftInput, ProviderRuntimeError, ProviderSmokeResult, ProviderStreamEventRecord,
};
use super::auth::{apply_ws_auth, apply_ws_custom_headers, build_reqwest_headers};
use super::routing::{build_messages, build_routing_decision};
use super::transport::{
    apply_websocket_timeouts, build_client, join_url, normalize_dashscope_compatible_base_url,
    normalize_transport_error, normalize_websocket_read_error, parse_dashscope_error,
    resolve_websocket_timeout, to_websocket_url,
};

pub(super) fn execute(
    provider: &ProviderDraftInput,
    transport_effective: &str,
    request_id: &str,
    source_text: &str,
    source_language: &str,
    target_language: &str,
    on_delta: &mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    if transport_effective == "websocket" {
        return execute_websocket(
            provider,
            request_id,
            source_text,
            source_language,
            target_language,
            on_delta,
        );
    }

    let compatible_base_url = normalize_dashscope_compatible_base_url(&provider.base_url);
    let endpoint = join_url(&compatible_base_url, "chat/completions")?;
    log::info!(
        "[omni][provider-gateway] dashscope compatible HTTP request url={} model={} requested_transport={} effective_transport={}",
        endpoint,
        provider.model,
        provider.transport,
        transport_effective
    );
    let client = build_client(provider.timeout_ms)?;
    let payload = json!({
      "model": provider.model,
      "messages": build_messages(provider, source_text, source_language, target_language, &[]),
      "temperature": provider.temperature,
      "max_tokens": provider.max_output_tokens
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
        input_tokens: value
            .pointer("/usage/input_tokens")
            .or_else(|| value.pointer("/usage/prompt_tokens"))
            .and_then(Value::as_u64),
        output_tokens: value
            .pointer("/usage/output_tokens")
            .or_else(|| value.pointer("/usage/completion_tokens"))
            .and_then(Value::as_u64),
        audio_seconds: None,
        routing_decision: build_routing_decision("available", 0, false),
        error: None,
    })
}

fn execute_websocket(
    provider: &ProviderDraftInput,
    request_id: &str,
    source_text: &str,
    source_language: &str,
    target_language: &str,
    on_delta: &mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    if provider.model.to_ascii_lowercase().contains("realtime") {
        return execute_realtime_websocket(
            provider,
            request_id,
            source_text,
            source_language,
            target_language,
            on_delta,
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
                        result.first_event_latency_ms = Some(started.elapsed().as_millis() as u64);
                    }
                    result.stream_observed = true;
                    result.transcript.push_str(&delta);
                    on_delta(&delta)?;
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

    if result.transcript.trim().is_empty() {
        return Err(ProviderRuntimeError::new(
            "response.empty",
            "DashScope WebSocket completed without translation text.",
        ));
    }

    Ok(result)
}

fn execute_realtime_websocket(
    provider: &ProviderDraftInput,
    request_id: &str,
    source_text: &str,
    source_language: &str,
    target_language: &str,
    on_delta: &mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>,
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

    let safe_id = request_id.replace(':', "_").replace('-', "_");
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
                        on_delta(delta)?;
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
                            summary: format!("usage 已更新: input={} / output={}", input, output),
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

    if result.transcript.trim().is_empty() {
        return Err(ProviderRuntimeError::new(
            "response.empty",
            "DashScope Realtime WebSocket completed without translation text.",
        ));
    }

    Ok(result)
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
        .or_else(|| {
            value
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| {
            value
                .pointer("/choices/0/message/content/0/text")
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
