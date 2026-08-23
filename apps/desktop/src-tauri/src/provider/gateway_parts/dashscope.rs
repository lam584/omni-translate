use std::time::Instant;

use serde_json::{json, Value};

use super::super::contracts::{ProviderDraftInput, ProviderRuntimeError, ProviderSmokeResult};
use super::routing::{build_messages, build_translation_system_prompt_with_glossary};
use super::shared::{
    finish_websocket_result, impl_provider_adapter_execute, new_streaming_smoke_result,
    push_response_completed, push_translation_completed, push_usage_event,
    record_translation_delta, record_usage_update, DeltaCallback, ProviderCallContext,
};
use super::transport::{
    join_url, normalize_dashscope_compatible_base_url, normalize_transport_error,
    parse_dashscope_error, read_json_frame, send_json_frame, ProviderHttpClient, WebSocketFrame,
    WebSocketTransport,
};

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

    let (mut socket, websocket_timeout) = WebSocketTransport::default().connect_provider(provider)?;
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
            WebSocketFrame::Closed => break,
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
    on_delta: DeltaCallback<'_>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    let provider = context.provider;
    let (mut socket, websocket_timeout) = WebSocketTransport::default().connect_provider(provider)?;

    let safe_id = context.request_id.replace(':', "_").replace('-', "_");
    let instructions = build_translation_system_prompt_with_glossary(
        provider,
        context.source_language,
        context.target_language,
        context.glossary_prompt,
    );

    let audio_mode = crate::audio::omni::RealtimeAudioMode::from_config_value(
        Some(&crate::audio::events::resolve_realtime_profile(provider, &provider.model).realtime_audio_mode),
        &provider.model,
    )
    .map_err(|error| ProviderRuntimeError::new("request.invalid", error))?;
    // Provider smoke/probe only needs translated text. Requesting audio causes
    // DashScope to emit response.audio_transcript.* instead of response.text.*
    // and spends output-audio capacity that the probe discards.
    let mut session_update = crate::audio::omni::build_omni_session_update_for_provider_with_output_mode(
        provider,
        "",
        &instructions,
        audio_mode,
        context.source_language,
        context.target_language,
        crate::audio::omni::OmniOutputMode::TextOnly,
    );
    session_update["event_id"] = json!(format!("evt_{}_session", safe_id));
    send_json_frame(
        &mut socket,
        &session_update,
        "DashScope Realtime session.update 发送失败",
    )?;

    let mut item_create = crate::audio::omni::build_dashscope_text_item(context.source_text);
    item_create["event_id"] = json!(format!("evt_{}_item", safe_id));
    send_json_frame(
        &mut socket,
        &item_create,
        "DashScope Realtime conversation.item.create 发送失败",
    )?;

    let mut response_create = crate::audio::omni::build_dashscope_response_create();
    response_create["event_id"] = json!(format!("evt_{}_resp", safe_id));
    send_json_frame(
        &mut socket,
        &response_create,
        "DashScope Realtime response.create 发送失败",
    )?;

    let started = Instant::now();
    let mut result = new_streaming_smoke_result(
        context,
        "websocket",
        format!("{} Realtime WebSocket 会话已建立。", provider.display_name),
    );

    loop {
        match read_json_frame(
            &mut socket,
            websocket_timeout,
            "无法解析 DashScope Realtime WebSocket 响应",
        )? {
            WebSocketFrame::Json(value) => {
                let event_type = crate::audio::realtime_ws::server_event_type(&value, "");

                if matches!(
                    event_type,
                    "response.text.delta"
                        | "response.text.text"
                        | "response.audio_transcript.delta"
                        | "response.audio_transcript.text"
                ) {
                    if let Some(delta) = crate::audio::realtime_ws::server_text_delta(&value) {
                        record_translation_delta(
                            &mut result,
                            &started,
                            delta,
                            format!("收到 DashScope Realtime 增量文本: {}", delta),
                            on_delta,
                        )?;
                    }
                }

                if matches!(
                    event_type,
                    "response.text.done" | "response.audio_transcript.done"
                ) {
                    if let Some(text) = crate::audio::realtime_ws::server_text_delta(&value) {
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
                        push_usage_event(&mut result, input, output);
                    }
                    push_translation_completed(&mut result, "DashScope Realtime 响应已完成。");
                    break;
                }
            }
            WebSocketFrame::Closed => break,
            WebSocketFrame::Ignored => {}
        }
    }

    finish_websocket_result(
        result,
        "DashScope Realtime WebSocket completed without translation text.",
    )
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
