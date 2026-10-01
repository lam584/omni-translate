//! Qwen-Audio Task TTS facade. No Omni/realtime authorization or HTTP fallback.
use std::time::Instant;

use crate::audio::bailian_tasks::{self, TaskError};
use crate::provider::contracts::{ProviderDraftInput, ProviderRuntimeError, ProviderStreamEventRecord, TtsAudioChunk, TtsSynthesisResult};

fn runtime_error(provider: &ProviderDraftInput, error: TaskError) -> ProviderRuntimeError {
    let context = serde_json::json!({ "modelRole": "speech-output", "modelId": provider.model,
        "providerId": provider.provider_id, "modelReference": format!("{}::{}", provider.template_id, provider.model) });
    ProviderRuntimeError::new(error.code(), format!("{error} | modelContext: {context}"))
}

pub(crate) fn synthesize(
    provider: ProviderDraftInput, text: String, language: String, voice: String,
) -> Result<TtsSynthesisResult, ProviderRuntimeError> {
    let voice = bailian_tasks::resolve_tts_voice(&voice);
    let started = Instant::now();
    let (request_id, pcm_i16) = bailian_tasks::synthesize(&provider, &text, &voice, &language).map_err(|error| runtime_error(&provider, error))?;
    let audio_seconds = pcm_i16.len() as f64 / 24000.0;
    Ok(TtsSynthesisResult {
        request_id, provider_id: provider.provider_id, model: provider.model, voice_preset_id: voice,
        duration_ms: started.elapsed().as_millis() as u64, audio_seconds,
        audio: TtsAudioChunk { sample_rate_hz: 24000, channel_count: 1, pcm_i16 },
        event_log: vec![ProviderStreamEventRecord::new("task.tts.finished", "role=speech-output task-finished after all sentence audio/finality")],
    })
}

#[cfg(test)]
#[path = "task_tts_tests.rs"]
mod tests;

/// Audio dispatch tests use the same production gateway/connector while never
/// sending credentials outside loopback. No production connection override API.
#[cfg(test)]
pub(crate) fn set_loopback_replay_endpoint(endpoint: &str) {
    let url = url::Url::parse(endpoint).unwrap();
    assert_eq!(url.scheme(), "ws");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/api-ws/v1/inference");
    crate::provider::gateway_parts::transport::set_test_websocket_connect_override(endpoint);
}
