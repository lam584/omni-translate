//! Task WebSocket adapters, deliberately separate from the Omni realtime worker.
mod asr;
mod lifecycle;
mod worker;

pub(crate) use lifecycle::{TaskError, TaskRole};
pub(crate) use asr::run_asr;
pub(crate) use worker::synthesize;

pub(crate) const ASR_ADAPTER_ID: &str = "desktop-qwen-audio-task-asr-v1";
pub(crate) const TTS_ADAPTER_ID: &str = "desktop-qwen-audio-task-tts-v1";
pub(crate) const ASR_DIALECT_ID: &str = "bailian-qwen-audio-asr-task-ws-v1";
pub(crate) const TTS_DIALECT_ID: &str = "bailian-speech-synthesizer-duplex-task-ws-v1";

pub(crate) fn is_asr_model(model: &str) -> bool {
    matches!(model, "qwen-audio-3.0-asr-flash-streaming" | "qwen-audio-3.1-asr-flash-streaming")
}

pub(crate) fn is_tts_model(model: &str) -> bool {
    matches!(model, "qwen-audio-3.0-tts-plus" | "qwen-audio-3.0-tts-flash")
}
pub(crate) const DEFAULT_TTS_VOICE: &str = "longanhuan_v3.6";

pub(crate) fn resolve_tts_voice(voice: &str) -> String {
    if voice.trim().is_empty() || voice.trim().eq_ignore_ascii_case("auto") {
        DEFAULT_TTS_VOICE.to_string()
    } else {
        voice.to_string()
    }
}
