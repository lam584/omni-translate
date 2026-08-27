//! Helpers shared by the provider protocol adapters.
//!
//! DashScope and OpenAI-compatible adapters speak different wire protocols
//! but produce the same `ProviderSmokeResult` shape; the result bookkeeping
//! lives here so each adapter only describes protocol-specific decoding.

use std::time::Instant;

use super::super::contracts::{
    ProviderDraftInput, ProviderRuntimeError, ProviderSmokeResult, ProviderStreamEventRecord,
};
use super::routing::build_routing_decision;

/// Borrowed per-request inputs shared by every provider protocol adapter.
pub(super) struct ProviderCallContext<'a> {
    pub(super) provider: &'a ProviderDraftInput,
    pub(super) request_id: &'a str,
    pub(super) source_text: &'a str,
    pub(super) source_language: &'a str,
    pub(super) target_language: &'a str,
    pub(super) glossary_prompt: Option<&'a str>,
}

/// Streaming delta sink shared by the provider protocol adapters.
pub(super) type DeltaCallback<'a> = &'a mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>;

/// Implements the adapter-facing `execute` seam by bundling the request into
/// a `ProviderCallContext` and delegating to the module-level `execute`.
macro_rules! impl_provider_adapter_execute {
    ($adapter:ty) => {
        impl $adapter {
            pub(crate) fn execute(
                &self,
                provider: &ProviderDraftInput,
                transport_effective: &str,
                request_id: &str,
                source_text: &str,
                source_language: &str,
                target_language: &str,
                glossary_prompt: Option<&str>,
                on_delta: &mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>,
            ) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
                let context = ProviderCallContext {
                    provider,
                    request_id,
                    source_text,
                    source_language,
                    target_language,
                    glossary_prompt,
                };
                execute(&context, transport_effective, on_delta)
            }
        }
    };
}
pub(super) use impl_provider_adapter_execute;

/// Builds the completed-by-default smoke result skeleton with the
/// `session.started` event already recorded.
pub(super) fn new_streaming_smoke_result(
    context: &ProviderCallContext<'_>,
    transport: &str,
    session_summary: String,
) -> ProviderSmokeResult {
    ProviderSmokeResult {
        request_id: context.request_id.to_string(),
        provider_id: context.provider.provider_id.clone(),
        status: "completed".to_string(),
        transport_requested: transport.to_string(),
        transport_effective: transport.to_string(),
        fallback_applied: false,
        stream_observed: false,
        duration_ms: 0,
        first_event_latency_ms: None,
        transcript: String::new(),
        source_language: context.source_language.to_string(),
        target_language: context.target_language.to_string(),
        event_log: vec![ProviderStreamEventRecord {
            event_type: "session.started".to_string(),
            summary: session_summary,
            segment_id: None,
            text_delta: None,
            text: None,
            audio_chunk_ref: None,
        }],
        input_tokens: None,
        output_tokens: None,
        audio_seconds: None,
        connection_attempts: 1,
        connection_count: 1,
        connection_opened: true,
        connection_closed: true,
        connection_owner: None,
        connection_generation: None,
        routing_decision: build_routing_decision("available", 0, false),
        error: None,
    }
}

/// Records a streamed translation delta: first-event latency, transcript,
/// downstream callback and event log entry.
fn normalize_stream_delta(previous: &str, incoming: &str) -> Option<String> {
    if incoming.is_empty() {
        return None;
    }
    if previous.is_empty() {
        return Some(incoming.to_string());
    }
    if incoming == previous || previous.starts_with(incoming) {
        // Some websocket adapters expose cumulative text, and a delayed
        // frame can therefore repeat the current transcript or be an older
        // prefix. Neither frame adds visible translation.
        return None;
    }
    if incoming.starts_with(previous) {
        return Some(incoming[previous.len()..].to_string());
    }
    Some(incoming.to_string())
}

pub(super) fn record_translation_delta(
    result: &mut ProviderSmokeResult,
    started: &Instant,
    delta: &str,
    summary: String,
    on_delta: &mut dyn FnMut(&str) -> Result<(), ProviderRuntimeError>,
) -> Result<(), ProviderRuntimeError> {
    let Some(normalized_delta) = normalize_stream_delta(&result.transcript, delta) else {
        return Ok(());
    };
    if result.first_event_latency_ms.is_none() {
        result.first_event_latency_ms = Some(started.elapsed().as_millis() as u64);
    }
    result.stream_observed = true;
    result.transcript.push_str(&normalized_delta);
    on_delta(&normalized_delta)?;
    result.event_log.push(ProviderStreamEventRecord {
        event_type: "translation.delta".to_string(),
        summary,
        segment_id: Some("segment-1".to_string()),
        text_delta: Some(normalized_delta),
        text: None,
        audio_chunk_ref: None,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_stream_delta;

    #[test]
    fn cumulative_stream_text_is_reduced_to_the_new_suffix() {
        assert_eq!(
            normalize_stream_delta("你好", "你好，世界"),
            Some("，世界".to_string())
        );
        assert_eq!(normalize_stream_delta("你好", "你好"), None);
        assert_eq!(normalize_stream_delta("你好", "你"), None);
    }

    #[test]
    fn ordinary_incremental_stream_text_is_preserved() {
        assert_eq!(
            normalize_stream_delta("你好", " 世界"),
            Some(" 世界".to_string())
        );
    }
}

/// Appends a `usage.updated` event without touching the token counters.
pub(super) fn push_usage_event(
    result: &mut ProviderSmokeResult,
    input_tokens: u64,
    output_tokens: u64,
) {
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

/// Stores the token counters and appends the matching `usage.updated` event.
pub(super) fn record_usage_update(
    result: &mut ProviderSmokeResult,
    input_tokens: u64,
    output_tokens: u64,
) {
    result.input_tokens = Some(input_tokens);
    result.output_tokens = Some(output_tokens);
    push_usage_event(result, input_tokens, output_tokens);
}

/// Appends the `translation.completed` event carrying the current transcript.
pub(super) fn push_translation_completed(result: &mut ProviderSmokeResult, summary: &str) {
    let text = result.transcript.clone();
    result.event_log.push(ProviderStreamEventRecord {
        event_type: "translation.completed".to_string(),
        summary: summary.to_string(),
        segment_id: Some("segment-1".to_string()),
        text_delta: None,
        text: Some(text),
        audio_chunk_ref: None,
    });
}

/// Appends the terminal `response.completed` event.
pub(super) fn push_response_completed(result: &mut ProviderSmokeResult) {
    result.event_log.push(ProviderStreamEventRecord {
        event_type: "response.completed".to_string(),
        summary: "Provider 响应已结束。".to_string(),
        segment_id: None,
        text_delta: None,
        text: None,
        audio_chunk_ref: None,
    });
}

/// Seals a websocket run: records `response.completed` and rejects empty text.
pub(super) fn finish_websocket_result(
    mut result: ProviderSmokeResult,
    empty_message: &'static str,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    push_response_completed(&mut result);

    if result.transcript.trim().is_empty() {
        return Err(ProviderRuntimeError::new("response.empty", empty_message));
    }

    Ok(result)
}
