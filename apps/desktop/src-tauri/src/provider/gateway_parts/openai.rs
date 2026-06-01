use std::io::{BufRead, BufReader};
use std::time::Instant;

use serde_json::{json, Value};

use super::super::contracts::{
    ProviderDraftInput, ProviderRuntimeError, ProviderSmokeResult, ProviderStreamEventRecord,
};
use super::auth::build_reqwest_headers;
use super::routing::{build_messages, build_routing_decision};
use super::transport::{build_client, join_url, normalize_transport_error, parse_openai_error};

pub(super) fn execute(
    provider: &ProviderDraftInput,
    transport_effective: &str,
    request_id: &str,
    source_text: &str,
    source_language: &str,
    target_language: &str,
    on_delta: &mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    let endpoint = join_url(&provider.base_url, "chat/completions")?;
    log::info!(
        "[omni][provider-gateway] openai HTTP request url={} model={} transport={}",
        endpoint,
        provider.model,
        transport_effective
    );
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
        let reader = BufReader::new(response);
        for raw_line in reader.lines() {
            let raw_line = raw_line.map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("OpenAI Compatible SSE read failed: {error}"),
                )
                .retriable(true)
            })?;
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
                on_delta(&delta)?;
                result.event_log.push(ProviderStreamEventRecord {
                    event_type: "translation.delta".to_string(),
                    summary: format!("收到增量文本: {}", delta),
                    segment_id: Some("segment-1".to_string()),
                    text_delta: Some(delta),
                    text: None,
                    audio_chunk_ref: None,
                });
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

fn extract_openai_delta(value: &Value) -> Option<String> {
    value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            value
                .pointer("/choices/0/delta/content/0/text")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn extract_openai_completion_text(value: &Value) -> Result<String, ProviderRuntimeError> {
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            value
                .pointer("/choices/0/message/content/0/text")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .ok_or_else(|| {
            ProviderRuntimeError::new(
                "response.unparseable",
                "OpenAI Compatible 返回中缺少可解析文本。",
            )
        })
}

fn extract_openai_usage(value: &Value) -> Option<(u64, u64)> {
    Some((
        value.pointer("/usage/prompt_tokens")?.as_u64()?,
        value.pointer("/usage/completion_tokens")?.as_u64()?,
    ))
}
