use std::io::{BufRead, BufReader};
use std::time::Instant;

use serde_json::{json, Value};

use super::super::contracts::{ProviderDraftInput, ProviderRuntimeError, ProviderSmokeResult};
use super::routing::build_messages;
use super::shared::{
    impl_provider_adapter_execute, new_streaming_smoke_result, push_response_completed,
    push_translation_completed, record_translation_delta, record_usage_update, DeltaCallback,
    ProviderCallContext,
};
use super::transport::{join_url, normalize_transport_error, parse_openai_error, ProviderHttpClient};

/// Stateful protocol boundary for OpenAI-compatible providers.
///
/// The adapter itself is intentionally stateless today, while the explicit
/// type keeps provider protocol ownership out of the gateway facade and gives
/// tests a stable dependency seam.
#[derive(Clone, Debug, Default)]
pub(crate) struct OpenAiProviderAdapter;

impl_provider_adapter_execute!(OpenAiProviderAdapter);

pub(super) fn execute(
    context: &ProviderCallContext<'_>,
    transport_effective: &str,
    on_delta: DeltaCallback<'_>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    let provider = context.provider;
    let endpoint = join_url(&provider.base_url, "chat/completions")?;
    log::info!(
        "[omni][provider-gateway] openai HTTP request url={} model={} transport={}",
        endpoint,
        provider.model,
        transport_effective
    );
    let client = ProviderHttpClient::new(provider.timeout_ms)?;
    let messages = build_messages(
        provider,
        context.source_text,
        context.source_language,
        context.target_language,
        &[],
    );
    let payload = json!({
      "model": provider.model,
      "stream": transport_effective == "streaming-http",
      "messages": messages,
      "temperature": provider.temperature,
      "max_tokens": provider.max_output_tokens,
      "modalities": provider.response_modalities
    });
    let response = client.post_json(endpoint, provider, &payload)?;

    if !response.status().is_success() {
        return Err(parse_openai_error(response));
    }

    let mut result = new_streaming_smoke_result(
        context,
        transport_effective,
        format!("{} 已建立请求会话。", provider.display_name),
    );
    let started = Instant::now();

    if transport_effective == "streaming-http" {
        let mut reasoning_transcript = String::new();
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
                record_translation_delta(
                    &mut result,
                    &started,
                    &delta,
                    format!("收到增量文本: {}", delta),
                    on_delta,
                )?;
            }

            if let Some(reasoning_delta) = extract_openai_reasoning_delta(&value) {
                if result.first_event_latency_ms.is_none() {
                    result.first_event_latency_ms = Some(started.elapsed().as_millis() as u64);
                }
                result.stream_observed = true;
                reasoning_transcript.push_str(&reasoning_delta);
            }

            if let Some((input_tokens, output_tokens)) = extract_openai_usage(&value) {
                record_usage_update(&mut result, input_tokens, output_tokens);
            }
        }

        if result.transcript.trim().is_empty() {
            if let Some(translation) = extract_translation_from_reasoning(&reasoning_transcript) {
                result.transcript = translation;
            }
        }

        if !result.transcript.is_empty() {
            push_translation_completed(&mut result, "流式翻译分段已完成。");
        }
    } else {
        let value: Value = response.json().map_err(normalize_transport_error)?;
        let text = extract_openai_completion_text(&value)?;
        result.first_event_latency_ms = Some(started.elapsed().as_millis() as u64);
        result.transcript = text;
        if let Some((input_tokens, output_tokens)) = extract_openai_usage(&value) {
            result.input_tokens = Some(input_tokens);
            result.output_tokens = Some(output_tokens);
        }
        push_translation_completed(&mut result, "HTTP 请求已完成整段翻译。");
    }

    push_response_completed(&mut result);

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

fn extract_openai_reasoning_delta(value: &Value) -> Option<String> {
    value
        .pointer("/choices/0/delta/reasoning_content")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            value
                .pointer("/choices/0/message/reasoning_content")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn extract_translation_from_reasoning(reasoning: &str) -> Option<String> {
    const MARKERS: [&str; 4] = ["Final decision:", "Decision:", "Translation:", "Final:"];

    reasoning.lines().rev().find_map(|raw_line| {
        let line = raw_line.trim();
        MARKERS.iter().find_map(|marker| {
            line.find(marker).and_then(|index| {
                let candidate = line[index + marker.len()..].trim();
                (!candidate.is_empty()).then(|| candidate.to_string())
            })
        })
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
