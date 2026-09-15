use std::collections::HashSet;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::super::contracts::{
    ProviderDraftInput, ProviderErrorFrameEvidence, ProviderFirstServerEventEvidence,
    ProviderProbeWireEvidence, ProviderRuntimeError, ProviderSessionAuthorityEvidence,
    ProviderSmokeResult,
    ProviderStreamEventRecord, ProviderWebSocketCloseEvidence, ProviderWebSocketTraceEntry,
};
use super::routing::build_messages;
use super::shared::{
    finish_websocket_result, impl_provider_adapter_execute, new_streaming_smoke_result,
    push_response_completed, push_translation_completed, record_translation_delta,
    record_usage_update, DeltaCallback, ProviderCallContext,
};
use super::transport::{
    apply_websocket_timeouts, join_url, normalize_dashscope_compatible_base_url,
    normalize_transport_error, parse_dashscope_error, read_json_frame, remaining_before,
    resolve_websocket_timeout, send_json_frame, to_websocket_url, ProviderHttpClient,
    WebSocketFrame, WebSocketTransport,
};

#[path = "dashscope/livetranslate_probe.rs"]
mod livetranslate_probe;
use livetranslate_probe::execute_livetranslate_session_probe;

/// Stateful protocol boundary for DashScope HTTP and realtime WebSocket calls.
#[derive(Clone, Debug, Default)]
pub(crate) struct DashScopeProviderAdapter;

impl_provider_adapter_execute!(DashScopeProviderAdapter);

pub(super) fn execute(
    context: &ProviderCallContext<'_>,
    transport_effective: &str,
    on_delta: DeltaCallback<'_>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    if transport_effective == "websocket" {
        return execute_websocket(context, on_delta);
    }

    let provider = context.provider;
    let voice_profiles = crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(
        &provider.model,
    )
    .map_err(|error| {
        ProviderRuntimeError::new(
            "request.invalid",
            format!("{}: unable to inspect Bailian HTTP model authority", error.code()),
        )
    })?;
    if !voice_profiles.is_empty() {
        crate::audio::events::authorize_bailian_model_operation(
            provider,
            &provider.model,
            "text_generation",
        )
        .map_err(|error| ProviderRuntimeError::new("request.invalid", error))?;
        return Err(ProviderRuntimeError::new(
            "request.invalid",
            "model_protocol.operation_not_supported: Bailian voice profiles cannot use the compatible-mode chat/completions endpoint",
        ));
    }
    let text_generation_authorized = provider
        .local_model_capability_registry
        .iter()
        .any(|entry| {
            entry.model_id == provider.model
                && entry
                    .capabilities
                    .iter()
                    .any(|capability| capability == "text-generation")
        });
    if !text_generation_authorized {
        return Err(ProviderRuntimeError::new(
            "request.invalid",
            format!(
                "model_protocol.model_not_registered: DashScope HTTP model '{}' lacks an exact text-generation registry declaration",
                provider.model
            ),
        ));
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
    let client = ProviderHttpClient::new(provider.timeout_ms)?;
    let payload = json!({
      "model": provider.model,
      "messages": build_messages(provider, context.source_text, context.source_language, context.target_language, context.glossary_prompt),
      "temperature": provider.temperature,
      "max_tokens": provider.max_output_tokens
    });
    let response = client.post_json(endpoint, provider, &payload)?;

    if !response.status().is_success() {
        return Err(parse_dashscope_error(response));
    }

    let value: Value = response.json().map_err(normalize_transport_error)?;
    let text = extract_dashscope_text(&value)?;
    let mut result = new_streaming_smoke_result(
        context,
        transport_effective,
        format!("{} 已建立请求会话。", provider.display_name),
    );
    result.first_event_latency_ms = Some(0);
    result.transcript = text;
    push_translation_completed(&mut result, "DashScope HTTP 返回完整文本。");
    push_response_completed(&mut result);
    result.input_tokens = value
        .pointer("/usage/input_tokens")
        .or_else(|| value.pointer("/usage/prompt_tokens"))
        .and_then(Value::as_u64);
    result.output_tokens = value
        .pointer("/usage/output_tokens")
        .or_else(|| value.pointer("/usage/completion_tokens"))
        .and_then(Value::as_u64);
    Ok(result)
}

fn execute_websocket(
    context: &ProviderCallContext<'_>,
    on_delta: DeltaCallback<'_>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    let provider = context.provider;
    let profile = crate::audio::events::resolve_realtime_profile(provider, &provider.model);
    if matches!(
        profile.protocol_dialect,
        Some(
            crate::audio::events::RealtimeProtocol::DashscopeOmni
                | crate::audio::events::RealtimeProtocol::DashscopeLivetranslate
                | crate::audio::events::RealtimeProtocol::DashscopeAsr
        )
    ) {
        return execute_realtime_websocket(context, on_delta);
    }

    let (mut socket, websocket_timeout) =
        WebSocketTransport::default().connect_provider(provider, "native_translate")?;
    let payload = json!({
      "request_id": context.request_id,
      "model": provider.model,
      "input": {
        "messages": build_messages(provider, context.source_text, context.source_language, context.target_language, context.glossary_prompt)
      },
      "parameters": {
        "stream": true,
        "region": provider.region
      }
    });
    send_json_frame(&mut socket, &payload, "DashScope WebSocket 发送失败")?;

    let started = Instant::now();
    let mut result = new_streaming_smoke_result(
        context,
        "websocket",
        format!("{} WebSocket 会话已建立。", provider.display_name),
    );

    loop {
        match read_json_frame(&mut socket, websocket_timeout, "无法解析 DashScope WebSocket 响应")? {
            WebSocketFrame::Json(value) => {
                if let Some(delta) = extract_dashscope_delta(&value) {
                    record_translation_delta(
                        &mut result,
                        &started,
                        &delta,
                        format!("收到 DashScope 增量文本: {}", delta),
                        on_delta,
                    )?;
                }

                if let Some((input_tokens, output_tokens)) = extract_dashscope_usage(&value) {
                    record_usage_update(&mut result, input_tokens, output_tokens);
                }

                if extract_dashscope_completed(&value) {
                    push_translation_completed(&mut result, "DashScope WebSocket 分段已完成。");
                    break;
                }
            }
            WebSocketFrame::Closed(_) => break,
            WebSocketFrame::Binary => {}
            WebSocketFrame::Ignored => {}
        }
    }

    finish_websocket_result(
        result,
        "DashScope WebSocket completed without translation text.",
    )
}

fn execute_realtime_websocket(
    context: &ProviderCallContext<'_>,
    _on_delta: DeltaCallback<'_>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    let provider = context.provider;
    let realtime_profile =
        crate::audio::events::resolve_realtime_profile(provider, &provider.model);
    if context.livetranslate_session_probe
        && realtime_profile.protocol_dialect
            == Some(crate::audio::events::RealtimeProtocol::DashscopeLivetranslate)
    {
        return execute_livetranslate_session_probe(context);
    }
    Err(ProviderRuntimeError::new(
        "request.invalid",
        "model_protocol.operation_not_supported: LiveTranslate accepts audio/image input and requires session.finish -> session.finished; the text translation gateway cannot create a conforming session",
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
