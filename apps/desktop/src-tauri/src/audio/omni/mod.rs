use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::Manager;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message};

use super::contracts::SubtitleDisplaySegmentRuntime;
use super::diagnostics::{diag_log, diag_log_detail};
use super::engine::emit_audio_snapshot;
use super::state::AudioStateStore;
use super::time_utils::{ms_marker, unix_ms};
use crate::bridge::ipc::write_virtual_mic_frame;
use crate::diagnostics::model_trace::{ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway;

mod codec;

use self::codec::{
    asr_chunk_rms, base64_decode_to_i16, base64_encode_i16, resample_48k_stereo_to_16k_mono,
};

const OMNI_RECONNECT_MAX_RETRIES: usize = 5;
const OMNI_INITIAL_CONNECT_RETRIES: usize = 3;
const OMNI_WRITE_TIMEOUT_SECS: u64 = 10;
const OMNI_READ_TIMEOUT_MS: u64 = 200;
const OMNI_VAD_WARNING_INTERVAL_SECS: u64 = 30;
const TRANSCRIPTION_COMPLETED_TIMEOUT_MS: u64 = 30_000;
const OMNI_OUTPUT_SAMPLE_RATE_HZ: u32 = 24_000;
const OMNI_PRE_SESSION_AUDIO_QUEUE_LIMIT: usize = 500;
const OMNI_PRE_SESSION_AUDIO_DRAIN_PER_TICK: usize = 4;
const OMNI_ASR_MIN_CHUNK_RMS: f32 = 0.002;
const OMNI_ASR_SILENCE_GRACE_CHUNKS: u32 = 60;
const PROVIDER_INPUT_PCM_DUMP_MAX_SAMPLES: usize = 16_000 * 90;

struct ProviderInputPcmDump {
    file: std::fs::File,
    path: String,
    samples_written: usize,
    max_samples: usize,
    write_failed: bool,
}

impl ProviderInputPcmDump {
    fn from_env(app: &AppHandle) -> Option<Self> {
        let path = std::env::var("OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        match OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
        {
            Ok(file) => {
                let _ = diag_log(
                    app,
                    "omni",
                    "info",
                    format!("[WATCH] provider input PCM dump enabled: {path}"),
                );
                Some(Self {
                    file,
                    path,
                    samples_written: 0,
                    max_samples: PROVIDER_INPUT_PCM_DUMP_MAX_SAMPLES,
                    write_failed: false,
                })
            }
            Err(error) => {
                let _ = diag_log(
                    app,
                    "omni",
                    "warning",
                    format!(
                        "[WATCH] provider input PCM dump open failed: path={path} error={error}"
                    ),
                );
                None
            }
        }
    }

    fn append(&mut self, app: &AppHandle, samples: &[i16]) {
        if self.write_failed || samples.is_empty() || self.samples_written >= self.max_samples {
            return;
        }
        let remaining = self.max_samples - self.samples_written;
        let samples = if samples.len() > remaining {
            &samples[..remaining]
        } else {
            samples
        };
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        if let Err(error) = self.file.write_all(&bytes) {
            self.write_failed = true;
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[WATCH] provider input PCM dump write failed: path={} error={error}",
                    self.path
                ),
            );
            return;
        }
        self.samples_written += samples.len();
        if self.samples_written >= self.max_samples {
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[WATCH] provider input PCM dump reached cap: path={} samples={}",
                    self.path, self.samples_written
                ),
            );
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeAudioMode {
    Manual,
    ServerVad,
    SemanticVad,
}

impl RealtimeAudioMode {
    pub fn from_config_value(value: Option<&str>, model: &str) -> Result<Self, String> {
        match value {
            Some("manual") => Ok(Self::Manual),
            Some("server_vad") => Ok(Self::ServerVad),
            Some("semantic_vad") => Ok(Self::SemanticVad),
            Some("gemini_auto_activity") | Some("gemini_manual_activity") => Err(format!(
                "妯″瀷 {model} 閰嶇疆浜?Gemini 瀹炴椂璇煶妯″紡锛屼絾褰撳墠鐪嬬墖妯″紡鐨?Omni/DashScope 瀹炴椂閾捐矾涓嶆敮鎸?Gemini Live 鍗忚"
            )),
            Some(other) => Err(format!(
                "妯″瀷 {model} 閰嶇疆浜嗕笉鏀寔鐨勫疄鏃惰闊虫ā寮? {other}"
            )),
            None => Ok(default_realtime_audio_mode(model)),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::ServerVad => "server_vad",
            Self::SemanticVad => "semantic_vad",
        }
    }

    pub fn uses_manual_commit(self) -> bool {
        self == Self::Manual
    }

    pub fn turn_detection(self) -> Value {
        match self {
            Self::Manual => Value::Null,
            Self::ServerVad => json!({
              "type": "server_vad",
              "threshold": 0.0,
              "silence_duration_ms": 800
            }),
            Self::SemanticVad => json!({
              "type": "semantic_vad",
              "eagerness": "auto"
            }),
        }
    }
}

pub fn default_realtime_audio_mode(model: &str) -> RealtimeAudioMode {
    if is_livetranslate_model(model) {
        RealtimeAudioMode::ServerVad
    } else {
        RealtimeAudioMode::Manual
    }
}

fn backoff_delay(retry_count: usize) -> Duration {
    let seconds = (1u64 << retry_count).min(10);
    Duration::from_secs(seconds)
}

fn initial_connect_backoff(retry_count: usize) -> Duration {
    Duration::from_millis(250_u64 << retry_count.saturating_sub(1))
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn session_update_omits_empty_voice() {
        let session = build_omni_session_update(
            "qwen3.5-omni-plus-realtime",
            "",
            "translate naturally",
            RealtimeAudioMode::ServerVad,
            "zh-CN",
        );

        assert!(session.pointer("/session/voice").is_none());
        assert_eq!(
            session
                .pointer("/session/instructions")
                .and_then(Value::as_str),
            Some("translate naturally")
        );
        assert_eq!(
            session
                .pointer("/session/input_audio_format")
                .and_then(Value::as_str),
            Some("pcm16")
        );
        assert_eq!(
            session
                .pointer("/session/output_audio_format")
                .and_then(Value::as_str),
            Some("pcm")
        );
        assert_eq!(
            session
                .pointer("/session/turn_detection/type")
                .and_then(Value::as_str),
            Some("server_vad")
        );
        assert_eq!(
            session
                .pointer("/session/turn_detection/threshold")
                .and_then(Value::as_f64),
            Some(0.0)
        );
    }

    #[test]
    fn initial_connect_backoff_is_short_and_bounded() {
        assert_eq!(initial_connect_backoff(1), Duration::from_millis(250));
        assert_eq!(initial_connect_backoff(2), Duration::from_millis(500));
        assert_eq!(initial_connect_backoff(3), Duration::from_millis(1_000));
    }

    #[test]
    fn pre_session_audio_drain_is_bounded_to_avoid_starving_websocket_reads() {
        assert!(OMNI_PRE_SESSION_AUDIO_DRAIN_PER_TICK > 0);
        assert!(OMNI_PRE_SESSION_AUDIO_DRAIN_PER_TICK < OMNI_PRE_SESSION_AUDIO_QUEUE_LIMIT);
    }

    #[test]
    fn asr_chunk_rms_distinguishes_silence_from_audible_audio() {
        assert_eq!(asr_chunk_rms(&[0, 0, 0]), 0.0);
        assert!(asr_chunk_rms(&[0, 512, -512]) > OMNI_ASR_MIN_CHUNK_RMS);
    }

    #[test]
    fn asr_silence_grace_is_short_enough_for_watch_tail() {
        assert!(OMNI_ASR_SILENCE_GRACE_CHUNKS >= 30);
        assert!(OMNI_ASR_SILENCE_GRACE_CHUNKS <= 100);
    }

    #[test]
    fn native_output_fallback_only_applies_when_secondary_source_is_empty() {
        assert!(should_use_native_output_fallback(
            true,
            false,
            "",
            "我听不懂你在说什么，能再说一遍吗？"
        ));
        assert!(!should_use_native_output_fallback(
            true, false, "hello", "你好"
        ));
        assert!(!should_use_native_output_fallback(false, false, "", "你好"));
        assert!(!should_use_native_output_fallback(true, true, "", "你好"));
        assert!(!should_use_native_output_fallback(true, false, "", ""));
    }

    #[test]
    fn session_update_keeps_non_empty_voice() {
        let session = build_omni_session_update(
            "qwen3.5-omni-plus-realtime",
            "Tina",
            "translate naturally",
            RealtimeAudioMode::Manual,
            "zh-CN",
        );

        assert_eq!(
            session.pointer("/session/voice").and_then(Value::as_str),
            Some("Tina")
        );
        assert!(session
            .pointer("/session/turn_detection")
            .is_some_and(Value::is_null));
    }

    #[test]
    fn livetranslate_session_update_includes_translation_target() {
        let session = build_omni_session_update(
            "qwen3.5-livetranslate-flash-realtime",
            "Cherry",
            "translate naturally",
            RealtimeAudioMode::ServerVad,
            "zh-CN",
        );

        assert_eq!(
            session
                .pointer("/session/translation/language")
                .and_then(Value::as_str),
            Some("zh")
        );
        assert_eq!(
            session
                .pointer("/session/input_audio_transcription/model")
                .and_then(Value::as_str),
            Some("qwen3-asr-flash-realtime")
        );
        assert_eq!(
            session
                .pointer("/session/input_audio_transcription/language")
                .and_then(Value::as_str),
            Some("en")
        );
        assert_eq!(
            session
                .pointer("/session/input_audio_format")
                .and_then(Value::as_str),
            Some("pcm")
        );
    }

    #[test]
    fn session_created_or_updated_releases_audio_for_provider_variants() {
        assert!(is_session_ready_event("session.created"));
        assert!(is_session_ready_event("session.updated"));
    }

    #[test]
    fn unsupported_voice_error_is_classified() {
        assert!(is_unsupported_voice_error(
            "COMMON_ERROR",
            "<400> InternalError.Algo.InvalidParameter: Voice 'Cherry' is not supported."
        ));
        assert!(is_unsupported_voice_error(
            "InternalError.Algo.InvalidParameter",
            "bad request"
        ));
        assert!(!is_unsupported_voice_error(
            "COMMON_ERROR",
            "rate limit exceeded"
        ));
    }

    #[test]
    fn omni_speech_config_uses_current_session_config() {
        let config = json!({
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": true,
                "virtualMicOutputEnabled": false
            }
        });

        let speech = OmniSpeechConfig::from_config(&config);

        assert!(speech.any_output());
        assert!(speech.enabled);
        assert!(speech.local_playback_enabled);
        assert!(!speech.virtual_mic_output_enabled);
    }

    #[test]
    fn omni_speech_config_accepts_device_output_toggle() {
        let config = json!({
            "devices": {
                "outputSpeechEnabled": true,
                "virtualMicOutputEnabled": true
            },
            "speech": {
                "enabled": false,
                "localPlaybackEnabled": true
            }
        });

        let speech = OmniSpeechConfig::from_config(&config);

        assert!(speech.any_output());
        assert!(speech.enabled);
        assert!(speech.local_playback_enabled);
        assert!(speech.virtual_mic_output_enabled);
    }

    #[test]
    fn omni_speech_config_disables_local_playback_with_virtual_driver_feedback_prevention() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver"
            },
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": true,
                "virtualMicOutputEnabled": true
            }
        });

        let speech = OmniSpeechConfig::from_config(&config);
        let route = super::super::speech::SpeechOutputRoutePlan::new(
            speech.local_playback_enabled,
            speech.virtual_mic_output_enabled,
        );

        assert!(!route.play_to_speaker);
        assert!(route.write_to_virtual_mic);
    }

    #[test]
    fn omni_speech_config_defaults_to_disabled() {
        let speech = OmniSpeechConfig::from_config(&json!({}));

        assert!(!speech.any_output());
        assert!(!speech.enabled);
        assert!(speech.local_playback_enabled);
        assert!(!speech.virtual_mic_output_enabled);
    }

    #[test]
    fn omni_speech_config_disables_native_playback_for_subtitle_tts_source() {
        let speech = OmniSpeechConfig::from_config(&json!({
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": true,
                "translationAudioSource": "subtitle-tts"
            }
        }));

        assert!(!speech.any_output());
        assert!(!speech.enabled);
    }

    #[test]
    fn base64_roundtrip_encode_decode() {
        let original: Vec<i16> = vec![0, 100, -100, i16::MAX, i16::MIN, 12345, -12345];
        let encoded = base64_encode_i16(&original);
        let decoded = base64_decode_to_i16(&encoded).expect("decode should succeed");
        assert_eq!(original, decoded);
    }

    #[test]
    fn base64_decode_rejects_odd_byte_count() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([0u8, 1u8, 2u8]);
        let result = base64_decode_to_i16(&encoded);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("odd byte count"));
    }

    #[test]
    fn base64_decode_empty() {
        let decoded = base64_decode_to_i16("").expect("empty input should succeed");
        assert!(decoded.is_empty());
    }
}

fn set_socket_write_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_write_timeout(Some(Duration::from_secs(OMNI_WRITE_TIMEOUT_SECS)));
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream
                .get_mut()
                .set_write_timeout(Some(Duration::from_secs(OMNI_WRITE_TIMEOUT_SECS)));
        }
        _ => {}
    }
}

fn set_socket_read_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(OMNI_READ_TIMEOUT_MS)));
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(OMNI_READ_TIMEOUT_MS)));
        }
        _ => {}
    }
}

fn notify_reconnecting(store: &AudioStateStore, attempt: usize) {
    use super::contracts::SubtitleCueRuntime;
    let cue = SubtitleCueRuntime {
        cue_id: format!("omni-reconnecting-{}", unix_ms()),
        route_direction: "inbound".to_string(),
        source_text: format!(
            "[Omni] 姝ｅ湪閲嶆柊杩炴帴瀹炴椂缈昏瘧鏈嶅姟 (绗?{}/{})...",
            attempt, OMNI_RECONNECT_MAX_RETRIES
        ),
        display_source_text: String::new(),
        display_segments: Vec::new(),
        translated_text: String::new(),
        started_at: ms_marker(unix_ms()),
        ended_at: ms_marker(unix_ms()),
        committed: true,
    };
    store.push_subtitle_cue(cue);
}

fn try_reconnect(
    reconnect_count: &mut usize,
    pending_audio_buffer: &mut Vec<i16>,
    store: &AudioStateStore,
    app: &AppHandle,
    provider: &ProviderDraftInput,
    active_voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
    buffer_size: u64,
) -> Result<tungstenite::WebSocket<MaybeTlsStream<TcpStream>>, String> {
    if *reconnect_count >= OMNI_RECONNECT_MAX_RETRIES {
        store.set_stt_connected(false, buffer_size);
        return Err("Omni WebSocket reconnect retry limit exhausted".to_string());
    }
    *reconnect_count += 1;
    pending_audio_buffer.clear();
    notify_reconnecting(store, *reconnect_count);
    thread::sleep(backoff_delay(*reconnect_count));
    let socket = reconnect_socket(
        app.clone(),
        provider,
        active_voice,
        instructions,
        audio_mode,
        target_language,
    )?;
    store.set_stt_connected(true, buffer_size);
    Ok(socket)
}

fn check_vad_warning(
    app: &AppHandle,
    last_vad_event_time: &SystemTime,
    chunk_count: u64,
    vad_event_count: u64,
    buffer_size: u64,
) -> bool {
    if let Ok(elapsed) = last_vad_event_time.elapsed() {
        if elapsed.as_secs() >= OMNI_VAD_WARNING_INTERVAL_SECS && chunk_count > 0 {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[VAD] 灏氭棤 VAD 浜嬩欢锛堝凡绛夊緟 {}s, 宸插彂閫?{} 鍧楅煶棰? {} 瀛楄妭, VAD 浜嬩欢璁℃暟={})",
                    elapsed.as_secs(),
                    chunk_count,
                    buffer_size,
                    vad_event_count
                ),
            );
            return true;
        }
    }
    false
}

fn handle_session_ready_event(
    app: &AppHandle,
    event_type: &str,
    evt: &Value,
    session_ready_for_audio: &mut bool,
    pre_session_audio_dropped: u64,
    pre_session_audio_queue_len: usize,
) {
    match event_type {
        "session.created" => {
            let became_ready = !*session_ready_for_audio;
            *session_ready_for_audio = true;
            let session_id = evt["session"]["id"].as_str().unwrap_or("?");
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] session.created: id={session_id} audioReady=true queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                    pre_session_audio_queue_len
                ),
            );
            if became_ready {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "info",
                    "watch_mode.omni_session_ready",
                    format!(
                        "event={} queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                        event_type, pre_session_audio_queue_len
                    ),
                );
            }
        }
        "session.updated" if is_session_ready_event(event_type) => {
            let became_ready = !*session_ready_for_audio;
            *session_ready_for_audio = true;
            let _ = diag_log(
                app,
                "omni",
                "debug",
                format!(
                    "[EVENT] session.updated: session config confirmed audioReady=true queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                    pre_session_audio_queue_len
                ),
            );
            if became_ready {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "info",
                    "watch_mode.omni_session_ready",
                    format!(
                        "event={} queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                        event_type, pre_session_audio_queue_len
                    ),
                );
            }
        }
        _ => {}
    }
}

fn is_session_ready_event(event_type: &str) -> bool {
    matches!(event_type, "session.created" | "session.updated")
}

#[derive(Debug, Default, Clone)]
struct OmniEventDiagnostics {
    readiness_event: Option<String>,
    current_cue_origin: Option<String>,
    last_asr_delta_text: String,
    last_asr_delta_at_ms: Option<u64>,
    last_asr_completed_text: String,
    last_asr_completed_at_ms: Option<u64>,
    empty_asr_completed_count: u64,
    first_non_empty_asr_completed_at_ms: Option<u64>,
    last_output_done_text: String,
    last_output_done_at_ms: Option<u64>,
    first_response_done_at_ms: Option<u64>,
    response_done_count: u64,
}

fn elapsed_ms_since(start: &SystemTime) -> u64 {
    start
        .elapsed()
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn should_use_native_output_fallback(
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
    source_text: &str,
    translated_text: &str,
) -> bool {
    subtitle_translate_active
        && !native_translation_reuse_active
        && source_text.trim().is_empty()
        && !translated_text.trim().is_empty()
}

#[allow(clippy::too_many_arguments)]
fn handle_response_done(
    app: &AppHandle,
    store: &AudioStateStore,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall,
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
    session_started_at: &SystemTime,
) {
    let response_done_at_ms = elapsed_ms_since(session_started_at);
    event_diagnostics.response_done_count = event_diagnostics.response_done_count.saturating_add(1);
    event_diagnostics
        .first_response_done_at_ms
        .get_or_insert(response_done_at_ms);
    let cue_id = current_cue_id
        .take()
        .unwrap_or_else(|| format!("omni-cue-{}", unix_ms()));
    let source_len = pending_source_text.len();
    let translated_len = pending_translated_text.len();
    let st_flag = if subtitle_translate_active {
        " st_active=true"
    } else {
        ""
    };
    trace_call.output(
        "response.done",
        json!({
          "cueId": cue_id,
          "sourceText": pending_source_text.clone(),
          "translatedText": pending_translated_text.clone(),
          "sourceLen": source_len,
          "translatedLen": translated_len,
          "subtitleTranslateActive": subtitle_translate_active,
        }),
    );
    let readiness_event = event_diagnostics
        .readiness_event
        .as_deref()
        .unwrap_or("(none)");
    let cue_origin = event_diagnostics
        .current_cue_origin
        .as_deref()
        .unwrap_or("(none)");
    let _ = diag_log(
        app,
        "omni",
        "info",
        format!(
            "[EVENT_CONTEXT] response.done cue_id={cue_id} responseDoneCount={} responseDoneAtMs={} firstResponseDoneAtMs={} readinessEvent={} cueOrigin={} sourceLen={} translatedLen={} lastAsrDeltaAtMs={} lastAsrDelta=\"{}\" lastAsrCompletedAtMs={} lastAsrCompleted=\"{}\" firstNonEmptyAsrCompletedAtMs={} emptyAsrCompletedCount={} lastOutputDoneAtMs={} lastOutputDone=\"{}\" st_active={} nativeTranslationReuse={}",
            event_diagnostics.response_done_count,
            response_done_at_ms,
            event_diagnostics.first_response_done_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            readiness_event,
            cue_origin,
            source_len,
            translated_len,
            event_diagnostics.last_asr_delta_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_asr_delta_text,
            event_diagnostics.last_asr_completed_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_asr_completed_text,
            event_diagnostics.first_non_empty_asr_completed_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.empty_asr_completed_count,
            event_diagnostics.last_output_done_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_output_done_text,
            subtitle_translate_active,
            native_translation_reuse_active,
        ),
    );
    if subtitle_translate_active {
        if native_translation_reuse_active && !pending_translated_text.trim().is_empty() {
            let source = if pending_source_text.trim().is_empty() {
                pending_translated_text.clone()
            } else {
                pending_source_text.clone()
            };
            write_native_translation_to_cue(
                store,
                &cue_id,
                &source,
                pending_translated_text,
                true,
                false,
            );
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] response.done -> ST_NATIVE_TRANSLATION_COMMIT{st_flag} cue_id={cue_id} source_len={} translated_len={translated_len} translated=\"{}\"",
                    source.len(),
                    pending_translated_text
                ),
            );
        } else if !pending_source_text.is_empty() {
            let src_preview = if pending_source_text.len() > 200 {
                format!("{}...", &pending_source_text[..200])
            } else {
                pending_source_text.clone()
            };
            store.update_or_push_stt_cue(&cue_id, pending_source_text, false);
            let snapshot = store.snapshot();
            let cue_state = snapshot
                .subtitle_overlay
                .recent_cues
                .iter()
                .find(|c| c.cue_id == cue_id)
                .map(|c| {
                    format!(
                        "committed={} translated_empty={} src_len={}B",
                        c.committed,
                        c.translated_text.is_empty(),
                        c.source_text.len()
                    )
                })
                .unwrap_or_else(|| "cue_not_found".to_string());
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] response.done 鈫?ST_SOURCE_ONLY{st_flag} cue_id={cue_id} src=\"{src_preview}\" src_len={source_len} cue_state=[{cue_state}] (缈昏瘧鐣欑粰 subtitle_translate worker)"
                ),
            );
        } else if should_use_native_output_fallback(
            subtitle_translate_active,
            native_translation_reuse_active,
            pending_source_text,
            pending_translated_text,
        ) {
            write_native_translation_to_cue(
                store,
                &cue_id,
                pending_translated_text,
                pending_translated_text,
                true,
                false,
            );
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[EVENT] response.done -> ST_NATIVE_OUTPUT_FALLBACK{st_flag} cue_id={cue_id} source_len=0 translated_len={translated_len} translated=\"{}\" reason=empty_source_text",
                    pending_translated_text
                ),
            );
        } else {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!("[EVENT] response.done 鈫?SKIP{st_flag} cue_id={cue_id} 婧愭枃鏈负绌猴紒"),
            );
        }
    } else if !pending_translated_text.is_empty() {
        let source = if pending_source_text.is_empty() {
            pending_translated_text.clone()
        } else {
            pending_source_text.clone()
        };
        store.update_or_push_stt_cue(&cue_id, &source, true);
        store.update_subtitle_cue_translation(&cue_id, pending_translated_text.clone(), true);
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!(
                "[EVENT] response.done 鈫?COMMIT{st_flag} cue_id={cue_id} source_len={source_len} translated_len={translated_len} translated=\"{}\"",
                pending_translated_text
            ),
        );
    } else if !pending_source_text.is_empty() {
        let src_preview = if pending_source_text.len() > 150 {
            format!("{}...", &pending_source_text[..150])
        } else {
            pending_source_text.clone()
        };
        store.update_or_push_stt_cue(&cue_id, pending_source_text, true);
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!(
                "[EVENT] response.done 鈫?COMMIT(浠呮簮鏂囨湰, 鏃犵炕璇?{st_flag} cue_id={cue_id} src=\"{src_preview}\" src_len={source_len} translated_len={translated_len}"
            ),
        );
    } else {
        let _ = diag_log(
            app,
            "omni",
            "warning",
            format!(
                "[EVENT] response.done 鈫?SKIP{st_flag} cue_id={cue_id} 婧愭枃鏈拰缈昏瘧鏂囨湰鍧囦负绌?"
            ),
        );
    }
    let _ = diag_log(
        app,
        "omni",
        "debug",
        "[STATE] 閲嶇疆: current_cue_id=None, pending_source_text cleared, pending_translated_text cleared".to_string(),
    );
    pending_source_text.clear();
    pending_translated_text.clear();
    *current_cue_id = None;
    event_diagnostics.current_cue_origin = None;
    *transcription_completed_flag = false;
    *transcription_completed_at = None;
}

fn is_livetranslate_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("livetranslate")
}

fn ensure_transcription_cue_id(current_cue_id: &mut Option<String>) -> String {
    current_cue_id
        .get_or_insert_with(|| format!("omni-cue-{}", unix_ms()))
        .clone()
}

fn write_native_translation_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
    committed: bool,
    segment_pending: bool,
) {
    if translated_text.trim().is_empty() {
        return;
    }
    let display_source_text = if source_text.trim().is_empty() {
        translated_text.trim().to_string()
    } else {
        source_text.trim().to_string()
    };
    store.update_or_push_stt_cue(cue_id, &display_source_text, false);
    store.update_subtitle_cue_display_segments(
        cue_id,
        display_source_text.clone(),
        vec![SubtitleDisplaySegmentRuntime {
            source_text: display_source_text,
            translated_text: translated_text.to_string(),
            pending: segment_pending,
        }],
        translated_text.to_string(),
        committed,
    );
}

fn normalize_livetranslate_language(language: &str, fallback: &str) -> String {
    let trimmed = language.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "zh-cn" | "zh-hans" | "zh_cn" | "zh" | "chinese" => "zh".to_string(),
        "en-us" | "en-gb" | "en" | "english" => "en".to_string(),
        _ => lower
            .split(['-', '_'])
            .next()
            .filter(|part| !part.is_empty())
            .unwrap_or(fallback)
            .to_string(),
    }
}

fn build_omni_session_update(
    model: &str,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Value {
    let is_livetranslate = is_livetranslate_model(model);
    let input_audio_format = if is_livetranslate { "pcm" } else { "pcm16" };
    let turn_detection = audio_mode.turn_detection();
    let mut session_cfg = json!({
      "type": "session.update",
      "session": {
        "modalities": ["text", "audio"],
        "instructions": instructions,
        "input_audio_format": input_audio_format,
        "sample_rate": 16000,
        "output_audio_format": "pcm",
        "turn_detection": turn_detection
      }
    });
    let trimmed_voice = voice.trim();
    if !trimmed_voice.is_empty() {
        session_cfg["session"]["voice"] = json!(trimmed_voice);
    }
    if is_livetranslate {
        let source_language = "en";
        let target_language = normalize_livetranslate_language(target_language, "zh");
        session_cfg["session"]["input_audio_transcription"] = json!({
          "model": "qwen3-asr-flash-realtime",
          "language": source_language
        });
        session_cfg["session"]["translation"] = json!({
          "language": target_language
        });
    }
    session_cfg
}

fn is_unsupported_voice_error(code: &str, message: &str) -> bool {
    let lower_message = message.to_ascii_lowercase();
    code == "InternalError.Algo.InvalidParameter"
        || (lower_message.contains("voice") && lower_message.contains("not supported"))
        || (message.contains("InvalidParameter") && lower_message.contains("voice"))
}

enum OmniPlaybackCommand {
    Play {
        samples: Vec<i16>,
        cue_id: String,
        sample_rate_hz: u32,
    },
    Stop,
}

pub(crate) struct OmniSpeechConfig {
    enabled: bool,
    local_playback_enabled: bool,
    virtual_mic_output_enabled: bool,
    speaker_device_id: Option<String>,
    speaker_output_level: u64,
}

impl OmniSpeechConfig {
    pub(crate) fn from_config(config_value: &Value) -> Self {
        let speech_enabled = config_value
            .pointer("/speech/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let device_output_enabled = config_value
            .pointer("/devices/outputSpeechEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let native_audio_enabled =
            super::speech::resolve_translation_audio_source(config_value, true)
                == super::speech::TranslationAudioSource::OmniNative;
        Self {
            enabled: native_audio_enabled && (speech_enabled || device_output_enabled),
            local_playback_enabled: super::speech::desktop_direct_playback_enabled_for_config(
                config_value,
            ),
            virtual_mic_output_enabled: config_value
                .pointer("/speech/virtualMicOutputEnabled")
                .and_then(Value::as_bool)
                .or_else(|| {
                    config_value
                        .pointer("/devices/virtualMicOutputEnabled")
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false),
            speaker_device_id: config_value
                .pointer("/devices/outputDeviceId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
            speaker_output_level: config_value
                .pointer("/devices/outputLevel")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(100),
        }
    }

    fn any_output(&self) -> bool {
        self.enabled && (self.local_playback_enabled || self.virtual_mic_output_enabled)
    }
}

fn start_omni_playback(
    app: AppHandle,
    speech_config: OmniSpeechConfig,
) -> (mpsc::Sender<OmniPlaybackCommand>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<OmniPlaybackCommand>();
    let join = thread::Builder::new()
        .name("omni-playback".to_string())
        .spawn(move || {
            let audio_state = app.state::<AudioStateStore>();
            loop {
                let cmd = match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(cmd) => cmd,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                match cmd {
                    OmniPlaybackCommand::Stop => {
                        audio_state.update_speech(|s| {
                            s.dispatch_state = "idle".to_string();
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);
                        break;
                    }
                    OmniPlaybackCommand::Play {
                        samples,
                        cue_id,
                        sample_rate_hz,
                    } => {
                        let cfg = &speech_config;
                        let duration_ms =
                            ((samples.len() as u64) * 1000).saturating_div(sample_rate_hz as u64);
                        let _ = diag_log(&app, "omni", "info",
                            format!(
                                "[AUDIO] playback request received: cue_id={cue_id} samples={} sample_rate_hz={sample_rate_hz} duration_ms={duration_ms} enabled={} local_playback={} virtual_mic={}",
                                samples.len(),
                                cfg.enabled,
                                cfg.local_playback_enabled,
                                cfg.virtual_mic_output_enabled
                            ));
                        if !cfg.any_output() {
                            let _ = diag_log(&app, "omni", "warning",
                                format!(
                                    "[AUDIO] speech output disabled, skipping {} samples for cue_id={cue_id}; enabled={} local_playback={} virtual_mic={}",
                                    samples.len(),
                                    cfg.enabled,
                                    cfg.local_playback_enabled,
                                    cfg.virtual_mic_output_enabled
                                ));
                            continue;
                        }
                        audio_state.update_speech(|s| {
                            s.dispatch_state = "playing".to_string();
                            s.output_target =
                                match (cfg.local_playback_enabled, cfg.virtual_mic_output_enabled) {
                                    (true, true) => "both".to_string(),
                                    (false, true) => "virtual-mic".to_string(),
                                    _ => "speaker".to_string(),
                                };
                            s.current_cue_id = Some(cue_id.clone());
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);

                        let output_route = super::speech::SpeechOutputRoutePlan::new(
                            cfg.local_playback_enabled,
                            cfg.virtual_mic_output_enabled,
                        );
                        let speaker_frames = if output_route.play_to_speaker {
                            let echo_reference = super::speech::i16_to_f32(&samples);
                            audio_state.push_echo_reference(&echo_reference, sample_rate_hz, 1);
                            let result = super::speech::play_to_speaker(
                                &samples,
                                sample_rate_hz,
                                1,
                                cfg.speaker_device_id.as_deref(),
                                cfg.speaker_output_level,
                            );
                            match result {
                                Ok(frames) => {
                                    let _ = diag_log(&app, "omni", "info",
                                        format!(
                                            "[AUDIO] speaker playback completed: cue_id={cue_id} frames={frames} sample_rate_hz={sample_rate_hz}"
                                        ));
                                    frames
                                }
                                Err(error) => {
                                    let _ = diag_log(&app, "omni", "error",
                                        format!(
                                            "[AUDIO] speaker playback failed: cue_id={cue_id} error={error}"
                                        ));
                                    0
                                }
                            }
                        } else {
                            0
                        };

                        let vmic_frames = if output_route.write_to_virtual_mic {
                            let req_id = format!("omni-play-{}", unix_ms());
                            let vmic_samples = super::speech::scale_i16_by_output_level(
                                &samples,
                                cfg.speaker_output_level,
                            );
                            match write_virtual_mic_frame(
                                &app,
                                &cue_id,
                                &req_id,
                                &vmic_samples,
                                sample_rate_hz,
                                1,
                            )
                            {
                                Ok(frames) => {
                                    let _ = diag_log(&app, "omni", "info",
                                        format!(
                                            "[AUDIO] virtual mic write completed: cue_id={cue_id} request_id={req_id} frames={frames} sample_rate_hz={sample_rate_hz}"
                                        ));
                                    frames
                                }
                                Err(error) => {
                                    let _ = diag_log(&app, "omni", "error",
                                        format!(
                                            "[AUDIO] virtual mic write failed: cue_id={cue_id} request_id={req_id} error={error}"
                                        ));
                                    0
                                }
                            }
                        } else {
                            0
                        };

                        audio_state.update_speech(|s| {
                            s.dispatch_state = "waiting-subtitle".to_string();
                            s.current_cue_id = None;
                            s.speaker_frames_written += speaker_frames;
                            s.virtual_mic_frames_written += vmic_frames;
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);
                        let _ = diag_log(&app, "omni", "info",
                            format!(
                                "[AUDIO] 鎾斁瀹屾垚: cue_id={cue_id} speaker={speaker_frames} frames, vmic={vmic_frames} frames"
                            ));
                    }
                }
            }
        })
        .expect("failed to spawn omni-playback thread");
    (tx, join)
}

pub struct OmniHandle {
    pub stop_tx: mpsc::Sender<()>,
    #[allow(dead_code)]
    pub join_handle: JoinHandle<()>,
}

pub fn start_omni(
    app: AppHandle,
    store: &AudioStateStore,
    direction: String,
    session_generation: u64,
    provider: ProviderDraftInput,
    voice: String,
    instructions: String,
    audio_mode: RealtimeAudioMode,
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
) -> Result<
    (
        mpsc::Sender<Vec<u8>>,
        OmniHandle,
        mpsc::Receiver<Result<u64, String>>,
    ),
    String,
> {
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (readiness_tx, readiness_rx) = mpsc::channel::<Result<u64, String>>();
    let readiness_sent = Arc::new(AtomicBool::new(false));

    store.set_stt_connected(false, 0);
    store
        .live_session_events
        .clear(&provider.model, &ms_marker(unix_ms()));
    let _ = diag_log_detail(
        &app,
        "omni",
        "info",
        "姝ｅ湪鍚姩 Omni 瀹炴椂缈昏瘧...",
        format!("model={} voice={}", provider.model, voice),
    );

    let app_handle = app.clone();
    let model = provider.model.clone();
    let worker_direction = direction.clone();
    let readiness_tx_for_worker = readiness_tx.clone();
    let readiness_sent_for_worker = readiness_sent.clone();
    let trace = ModelTraceRecorder::new(
        app.clone(),
        ModelTraceContext::new(
            provider.provider_id.clone(),
            provider.model.clone(),
            "omni-realtime",
        )
        .with_session_id(ms_marker(unix_ms()))
        .with_route_mode("watch"),
    );

    let join_handle = thread::Builder::new()
        .name("omni".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            let result = run_omni_worker(
                app_handle.clone(),
                &audio_state,
                worker_direction.clone(),
                session_generation,
                readiness_tx_for_worker.clone(),
                readiness_sent_for_worker.clone(),
                provider,
                voice,
                instructions,
                audio_mode,
                target_language,
                subtitle_translate_active,
                speech_config,
                trace,
                audio_rx,
                stop_rx,
            );
            if let Err(error) = result {
                audio_state.set_stt_connected(false, 0);
                let _ = audio_state.mark_omni_session_failed(
                    &worker_direction,
                    session_generation,
                    error.clone(),
                );
                if !readiness_sent_for_worker.swap(true, Ordering::SeqCst) {
                    let _ = readiness_tx_for_worker.send(Err(error.clone()));
                }
                let _ = diag_log_detail(
                    &app_handle,
                    "omni",
                    "error",
                    format!("Omni 瀹炴椂缈昏瘧鍑洪敊: {error}"),
                    format!("model={model}"),
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
                let _ =
                    audio_state.clear_omni_session(&worker_direction, session_generation, error);
            } else {
                if !readiness_sent_for_worker.swap(true, Ordering::SeqCst) {
                    let _ = readiness_tx_for_worker.send(Err(
                        "Omni worker exited before session readiness".to_string(),
                    ));
                }
                let _ = audio_state.clear_omni_session(
                    &worker_direction,
                    session_generation,
                    "worker_exit",
                );
            }
        })
        .map_err(|error| format!("鏃犳硶鍚姩 Omni 绾跨▼: {error}"))?;

    Ok((
        audio_tx,
        OmniHandle {
            stop_tx,
            join_handle,
        },
        readiness_rx,
    ))
}

fn run_omni_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: String,
    session_generation: u64,
    readiness_tx: mpsc::Sender<Result<u64, String>>,
    readiness_sent: Arc<AtomicBool>,
    provider: ProviderDraftInput,
    voice: String,
    instructions: String,
    audio_mode: RealtimeAudioMode,
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
    trace: ModelTraceRecorder,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let mut trace_call = trace.call("omni.websocket_session");
    trace_call.input(
        "connect",
        json!({
          "providerId": provider.provider_id.clone(),
          "kind": provider.kind.clone(),
          "model": provider.model.clone(),
          "baseUrl": provider.base_url.clone(),
          "voice": voice.clone(),
          "instructions": instructions.clone(),
          "realtimeAudioMode": audio_mode.as_str(),
          "targetLanguage": target_language.clone(),
          "subtitleTranslateActive": subtitle_translate_active,
        }),
    );
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 瀹炴椂缈昏瘧浠呮敮鎸?dashscope provider锛屽綋鍓嶄负 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let ws_url = gateway::to_websocket_url(&provider.base_url, &provider.model)
        .map_err(|error| format!("鏃犳硶鏋勫缓 WebSocket URL: {}", error.message))?;

    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("鏃犳硶鍒涘缓 WebSocket 璇锋眰: {error}"))?;
    gateway::apply_ws_auth(&provider, request.headers_mut())
        .map_err(|error| format!("鏃犳硶搴旂敤璁よ瘉澶? {}", error.message))?;

    let initial_connect_started = SystemTime::now();
    let mut initial_attempt = 0usize;
    let (mut socket, _) = loop {
        initial_attempt += 1;
        match connect(request.clone()) {
            Ok(connected) => break connected,
            Err(error) if initial_attempt <= OMNI_INITIAL_CONNECT_RETRIES => {
                let _ = diag_log(
                    &app,
                    "omni",
                    "warning",
                    format!(
                        "[CONNECT] Omni 鍒濇杩炴帴澶辫触锛屽噯澶囬噸璇? attempt={initial_attempt}/{} error={error}",
                        OMNI_INITIAL_CONNECT_RETRIES + 1
                    ),
                );
                thread::sleep(initial_connect_backoff(initial_attempt));
            }
            Err(error) => {
                let elapsed_ms = initial_connect_started
                    .elapsed()
                    .map(|elapsed| elapsed.as_millis())
                    .unwrap_or_default();
                trace_call.error(format!(
                    "initial websocket connect failed attempts={initial_attempt} elapsedMs={elapsed_ms} error={error}"
                ));
                return Err(format!("鏃犳硶杩炴帴 Omni 鏈嶅姟: {error}"));
            }
        }
    };
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);

    let session_started_at = SystemTime::now();
    let ws_connect_ms = initial_connect_started.elapsed().unwrap_or_default().as_millis() as u64;
    store.set_stt_connected(true, 0);
    store.live_session_events.record_milestone("preconnect_started", ws_connect_ms);
    let _ = diag_log(
        &app,
        "omni",
        "info",
        format!("[CONNECT] 宸茶繛鎺?Omni 鏈嶅姟, model={}", provider.model),
    );

    let mut active_voice = voice.clone();
    let mut voice_fallback_applied = false;
    let session_cfg = build_omni_session_update(
        &provider.model,
        &active_voice,
        &instructions,
        audio_mode,
        &target_language,
    );
    let input_audio_format = session_cfg
        .pointer("/session/input_audio_format")
        .and_then(Value::as_str)
        .unwrap_or("(missing)");
    let turn_detection_summary = session_cfg
        .pointer("/session/turn_detection")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "(missing)".to_string());
    let _ = diag_log_detail(
        &app,
        "omni",
        "info",
        "watch_mode.omni_session_config",
        format!(
            "model={} realtimeAudioMode={} inputAudioFormat={} isLivetranslate={} subtitleTranslateActive={} turnDetection={}",
            provider.model,
            audio_mode.as_str(),
            input_audio_format,
            is_livetranslate_model(&provider.model),
            subtitle_translate_active,
            turn_detection_summary,
        ),
    );
    trace_call.record_ws_send("session.update", session_cfg.clone());
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("鏃犳硶鍙戦€?Omni session 閰嶇疆: {error}"))?;

    let _ = diag_log(
        &app,
        "omni",
        "debug",
        format!(
            "[SESSION] 宸插彂閫?session.update: modalities=[text,audio] voice={voice} instructions_len={}",
            instructions.len()
        ),
    );

    if audio_mode.uses_manual_commit() {
        let _ = diag_log(
            &app,
            "omni",
            "info",
            "[VAD] 褰撳墠妯″紡: manual (VAD bypass 宸插惎鐢紝姣?0绉掕嚜鍔?commit)",
        );
    } else {
        let _ = diag_log(
            &app,
            "omni",
            "info",
            "[VAD] turn_detection 閰嶇疆: type=server_vad threshold=0.0 silence_duration_ms=800",
        );
    }

    let mut current_cue_id: Option<String> = None;
    let mut pending_source_text = String::new();
    let mut pending_translated_text = String::new();
    let mut buffer_size: u64 = 0;
    let mut reconnect_count = 0usize;
    let mut chunk_count: u64 = 0;
    let mut sent_audio_since_commit = false;
    let mut last_vad_event_time = SystemTime::now();
    let mut vad_event_count: u64 = 0;
    let mut last_commit_time = SystemTime::now();
    let mut st_skip_logged = false;
    let native_translation_reuse_active =
        subtitle_translate_active && is_livetranslate_model(&provider.model);
    let mut transcription_completed_flag = false;
    let mut transcription_completed_at: Option<SystemTime> = None;
    let mut event_diagnostics = OmniEventDiagnostics::default();
    let mut last_waiting_log_chunk_count: u64 = 0;
    let mut pending_audio_delta_count: u64 = 0;
    let mut pending_audio_delta_base64_bytes: u64 = 0;
    let mut pending_audio_response_id: Option<String> = None;
    let mut session_ready_for_audio = false;
    let mut pre_session_audio_queue: VecDeque<Vec<u8>> = VecDeque::new();
    let mut pre_session_audio_dropped: u64 = 0;
    let mut silence_chunks_skipped: u64 = 0;
    let mut silence_grace_chunks_sent: u32 = 0;
    let mut has_sent_audible_audio = false;
    let mut total_input_chunks: u64 = 0;
    let mut first_audible_chunk_ms: Option<u64> = None;
    let mut total_silence_skipped_before_first_audible: u64 = 0;
    let mut first_audio_sent_ms: Option<u64> = None;

    let (playback_tx, playback_join) = start_omni_playback(app.clone(), speech_config);
    let mut pending_audio_buffer: Vec<i16> = Vec::new();
    let mut provider_input_dump = ProviderInputPcmDump::from_env(&app);

    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = socket.close(None);
            store.set_stt_connected(false, buffer_size);
            let _ = diag_log(
                &app,
                "omni",
                "info",
                format!(
                    "[STOP] Omni worker 宸插仠姝? 鍏卞彂閫?{} 涓煶棰戝潡, {} 瀛楄妭",
                    chunk_count, buffer_size
                ),
            );
            check_vad_warning(
                &app,
                &last_vad_event_time,
                chunk_count,
                vad_event_count,
                buffer_size,
            );
            let _ = playback_tx.send(OmniPlaybackCommand::Stop);
            let _ = playback_join.join();
            emit_audio_snapshot(&app, store)?;
            break;
        }

        let mut chunks_sent_this_tick = 0usize;
        let mut pre_session_chunks_drained_this_tick = 0usize;
        loop {
            let raw_chunk = if session_ready_for_audio {
                match pre_session_audio_queue
                    .pop_front()
                    .or_else(|| audio_rx.try_recv().ok())
                {
                    Some(chunk) => chunk,
                    None => break,
                }
            } else {
                match audio_rx.try_recv() {
                    Ok(chunk) => {
                        pre_session_chunks_drained_this_tick += 1;
                        if pre_session_audio_queue.len() >= OMNI_PRE_SESSION_AUDIO_QUEUE_LIMIT {
                            pre_session_audio_queue.pop_front();
                            pre_session_audio_dropped += 1;
                        }
                        pre_session_audio_queue.push_back(chunk);
                        if pre_session_audio_queue.len() == 1
                            || pre_session_audio_queue.len().is_multiple_of(100)
                        {
                            let _ = diag_log(
                                &app,
                                "omni",
                                "debug",
                                format!(
                                    "[SESSION] buffering audio before session ready: queued={} dropped={pre_session_audio_dropped}",
                                    pre_session_audio_queue.len()
                                ),
                            );
                        }
                        if pre_session_chunks_drained_this_tick
                            >= OMNI_PRE_SESSION_AUDIO_DRAIN_PER_TICK
                        {
                            break;
                        }
                        continue;
                    }
                    Err(_) => break,
                }
            };
            let asr_chunk = resample_48k_stereo_to_16k_mono(&raw_chunk);
            if asr_chunk.is_empty() {
                let _ = diag_log(
                    &app,
                    "omni",
                    "warning",
                    "[TRACE] resampled empty ASR frame dropped",
                );
                continue;
            }
            let chunk_rms = asr_chunk_rms(&asr_chunk);
            total_input_chunks += 1;
            if chunk_rms < OMNI_ASR_MIN_CHUNK_RMS {
                if has_sent_audible_audio
                    && silence_grace_chunks_sent < OMNI_ASR_SILENCE_GRACE_CHUNKS
                {
                    silence_grace_chunks_sent += 1;
                } else {
                    silence_chunks_skipped = silence_chunks_skipped.saturating_add(1);
                    if silence_chunks_skipped == 1 || silence_chunks_skipped.is_multiple_of(250) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "debug",
                            format!(
                                "event=omni.asr_silence_chunk_skipped skipped={} rms={:.6} threshold={:.6}",
                                silence_chunks_skipped, chunk_rms, OMNI_ASR_MIN_CHUNK_RMS
                            ),
                        );
                    }
                    continue;
                }
            } else {
                if !has_sent_audible_audio {
                    first_audible_chunk_ms = Some(elapsed_ms_since(&session_started_at));
                    total_silence_skipped_before_first_audible = silence_chunks_skipped;
                    store.live_session_events.record_audio_diagnostic(
                        first_audible_chunk_ms,
                        Some(silence_chunks_skipped),
                        None,
                    );
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[AUDIO] first audible chunk: elapsed_ms={} rms={:.6} threshold={:.6} silence_skipped_before={} total_input_chunks={}",
                            first_audible_chunk_ms.unwrap_or(0),
                            chunk_rms,
                            OMNI_ASR_MIN_CHUNK_RMS,
                            silence_chunks_skipped,
                            total_input_chunks,
                        ),
                    );
                }
                has_sent_audible_audio = true;
                silence_grace_chunks_sent = 0;
                silence_chunks_skipped = 0;
            }
            buffer_size = buffer_size.wrapping_add(raw_chunk.len() as u64);
            chunk_count += 1;
            sent_audio_since_commit = true;
            chunks_sent_this_tick += 1;

            if chunk_count == 1 {
                let elapsed = elapsed_ms_since(&session_started_at);
                first_audio_sent_ms = Some(elapsed);
                store.live_session_events.record_milestone(
                    "first_audio_sent",
                    elapsed,
                );
                let _ = diag_log(
                    &app,
                    "omni",
                    "info",
                    format!(
                        "[AUDIO] 棣栦釜闊抽鍧楀凡鍙戦€?({} samples @ 16kHz)",
                        asr_chunk.len()
                    ),
                );
            }
            if chunk_count.is_multiple_of(100) {
                let _ = diag_log(
                    &app,
                    "omni",
                    "debug",
                    format!(
                        "[AUDIO] 宸插彂閫?{} 涓煶棰戝潡 ({} 瀛楄妭)",
                        chunk_count, buffer_size
                    ),
                );
            }
            if let Some(dump) = provider_input_dump.as_mut() {
                dump.append(&app, &asr_chunk);
            }
            let b64 = base64_encode_i16(&asr_chunk);
            let append = json!({
              "type": "input_audio_buffer.append",
              "audio": b64
            });
            trace_call.record_ws_send(
                "input_audio_buffer.append",
                json!({
                  "type": "input_audio_buffer.append",
                  "rawBytes": raw_chunk.len(),
                  "resampledSamples": asr_chunk.len(),
                  "audio": append["audio"].clone(),
                  "chunkCount": chunk_count,
                  "rms": chunk_rms,
                }),
            );
            if let Err(error) = socket.send(Message::Text(append.to_string().into())) {
                let _ = diag_log(
                    &app,
                    "omni",
                    "warning",
                    format!("[AUDIO] 鍙戦€佸け璐? {error}"),
                );
                match try_reconnect(
                    &mut reconnect_count,
                    &mut pending_audio_buffer,
                    store,
                    &app,
                    &provider,
                    &active_voice,
                    &instructions,
                    audio_mode,
                    &target_language,
                    buffer_size,
                ) {
                    Ok(new_socket) => {
                        socket = new_socket;
                        let retry_b64 = base64_encode_i16(&asr_chunk);
                        let retry_append = json!({
                          "type": "input_audio_buffer.append",
                          "audio": retry_b64
                        });
                        if let Err(e) = socket.send(Message::Text(retry_append.to_string().into()))
                        {
                            store.set_stt_connected(false, buffer_size);
                            return Err(format!("閲嶈繛鍚庡彂閫侀煶棰戞暟鎹粛鐒跺け璐? {e}"));
                        }
                        continue;
                    }
                    Err(_) => {
                        return Err(format!(
                            "Omni WebSocket 鍙戦€佸け璐ヤ笖閲嶈繛娆℃暟宸茬敤瀹? {error}"
                        ));
                    }
                }
            }
            store.set_stt_connected(true, buffer_size);

            if chunks_sent_this_tick > 1 {
                thread::sleep(Duration::from_millis(18));
            }
        }

        if chunk_count > 0
            && chunks_sent_this_tick == 0
            && chunk_count.is_multiple_of(500)
            && last_waiting_log_chunk_count != chunk_count
        {
            last_waiting_log_chunk_count = chunk_count;
            let _ = diag_log(
                &app,
                "omni",
                "debug",
                format!("[AUDIO] 绛夊緟闊抽鏁版嵁... (宸插彂閫?{} 鍧?", chunk_count),
            );
        }

        if audio_mode.uses_manual_commit() {
            if let Ok(elapsed) = last_commit_time.elapsed() {
                if elapsed.as_secs() >= 10 && sent_audio_since_commit {
                    let commit_msg = json!({ "type": "input_audio_buffer.commit" });
                    trace_call.record_ws_send("input_audio_buffer.commit", commit_msg.clone());
                    if let Err(error) = socket.send(Message::Text(commit_msg.to_string().into())) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[VAD] bypass commit 鍙戦€佸け璐? {error}"),
                        );
                    } else {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[VAD] bypass: 宸插彂閫?commit (璺濅笂娆?{:.0}s, 宸插彂閫?{} 鍧楅煶棰?",
                                elapsed.as_secs_f64(),
                                chunk_count
                            ),
                        );
                        last_commit_time = SystemTime::now();
                        sent_audio_since_commit = false;
                    }
                    let create_msg = json!({ "type": "response.create" });
                    trace_call.record_ws_send("response.create", create_msg.clone());
                    if let Err(error) = socket.send(Message::Text(create_msg.to_string().into())) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[VAD] bypass response.create 鍙戦€佸け璐? {error}"),
                        );
                    }
                }
            }
        }

        if transcription_completed_flag {
            if let Some(ref t) = transcription_completed_at {
                let elapsed_ms = t.elapsed().unwrap_or_default().as_millis();
                if elapsed_ms > TRANSCRIPTION_COMPLETED_TIMEOUT_MS as u128 {
                    transcription_completed_flag = false;
                    transcription_completed_at = None;
                    let _ = diag_log(
                        &app,
                        "omni",
                        "warning",
                        format!(
                            "[STATE] transcription_completed_flag reset after {elapsed_ms}ms without response.done or speech_started"
                        ),
                    );
                }
            }
        }

        match socket.read() {
            Ok(msg) => match msg {
                Message::Text(text) => {
                    if let Ok(evt) = serde_json::from_str::<Value>(&text) {
                        let event_type = evt["type"].as_str().unwrap_or("(unknown)");
                        trace_call.record_ws_recv(event_type, evt.clone());
                        match event_type {
                            "session.created" | "session.updated" => {
                                let was_ready_for_audio = session_ready_for_audio;
                                handle_session_ready_event(
                                    &app,
                                    event_type,
                                    &evt,
                                    &mut session_ready_for_audio,
                                    pre_session_audio_dropped,
                                    pre_session_audio_queue.len(),
                                );
                                if !was_ready_for_audio && session_ready_for_audio {
                                    event_diagnostics.readiness_event =
                                        Some(event_type.to_string());
                                    store.live_session_events.record_milestone(
                                        "session_ready",
                                        elapsed_ms_since(&session_started_at),
                                    );
                                    store.live_session_events.record_session_ready(
                                        pre_session_audio_queue.len() as u64,
                                        pre_session_audio_dropped,
                                    );
                                    let marked_ready = store
                                        .mark_omni_session_ready(&direction, session_generation);
                                    if !marked_ready {
                                        let _ = diag_log_detail(
                                            &app,
                                            "omni",
                                            "warning",
                                            "watch_mode.omni_session_late_ready",
                                            format!(
                                                "direction={direction} generation={session_generation} event={event_type} reason=session_not_active_or_generation_mismatch"
                                            ),
                                        );
                                    }
                                    if !readiness_sent.swap(true, Ordering::SeqCst) {
                                        let _ = readiness_tx.send(Ok(session_generation));
                                    }
                                }
                            }
                            "input_audio_buffer.speech_started" => {
                                last_vad_event_time = SystemTime::now();
                                vad_event_count += 1;
                                if vad_event_count == 1 {
                                    let speech_ms = elapsed_ms_since(&session_started_at);
                                    store.live_session_events.record_milestone(
                                        "first_speech_started",
                                        speech_ms,
                                    );
                                    store.live_session_events.record_audio_diagnostic(
                                        None,
                                        None,
                                        Some(total_input_chunks),
                                    );
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[VAD] first_speech_started: elapsed_ms={} first_audio_sent_ms={:?} first_audible_chunk_ms={:?} total_input_chunks={} chunks_sent_to_server={} silence_skipped_before_audible={} subtitle_translate_active={}",
                                            speech_ms,
                                            first_audio_sent_ms,
                                            first_audible_chunk_ms,
                                            total_input_chunks,
                                            chunk_count,
                                            total_silence_skipped_before_first_audible,
                                            subtitle_translate_active,
                                        ),
                                    );
                                }
                                let cue_id = format!("omni-cue-{}", unix_ms());
                                store.update_or_push_stt_cue(&cue_id, "", false);
                                current_cue_id = Some(cue_id.clone());
                                event_diagnostics.current_cue_origin =
                                    Some("speech_started".to_string());
                                pending_source_text.clear();
                                pending_translated_text.clear();
                                pending_audio_buffer.clear();
                                transcription_completed_flag = false;
                                transcription_completed_at = None;
                                let _ = diag_log(
                                    &app,
                                    "omni",
                                    "info",
                                    format!(
                                        "[VAD] speech_started received event_count={vad_event_count} cue_id={cue_id}"
                                    ),
                                );
                            }
                            "conversation.item.input_audio_transcription.delta"
                            | "conversation.item.input_audio_transcription.text" => {
                                if transcription_completed_flag && !subtitle_translate_active {
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "debug",
                                        "[EVENT] transcription.delta skipped after transcription.completed",
                                    );
                                    continue;
                                }
                                last_vad_event_time = SystemTime::now();
                                vad_event_count += 1;
                                let text_val = evt["text"]
                                    .as_str()
                                    .or_else(|| evt["delta"].as_str())
                                    .unwrap_or("");
                                let stash = evt["stash"].as_str().unwrap_or("");
                                pending_source_text = format!("{text_val}{stash}");
                                if subtitle_translate_active && current_cue_id.is_none() {
                                    ensure_transcription_cue_id(&mut current_cue_id);
                                    event_diagnostics.current_cue_origin =
                                        Some("transcription_delta".to_string());
                                }
                                event_diagnostics.last_asr_delta_text = pending_source_text.clone();
                                event_diagnostics.last_asr_delta_at_ms =
                                    Some(elapsed_ms_since(&session_started_at));
                                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                if let Some(ref id) = current_cue_id {
                                    store.update_or_push_stt_cue(id, &pending_source_text, false);
                                }
                                store.live_session_events.push_asr_delta(
                                    event_type,
                                    stash,
                                    &pending_source_text,
                                );
                                let _ = diag_log(
                                    &app,
                                    "omni",
                                    "trace",
                                    format!(
                                        "[EVENT] transcription.delta 鈫?cue_id={cue_id_str} text=\"{text_val}\" stash=\"{stash}\" pending=\"{pending_source_text}\""
                                    ),
                                );
                            }
                            "conversation.item.input_audio_transcription.completed" => {
                                last_vad_event_time = SystemTime::now();
                                vad_event_count += 1;
                                let source = evt["transcript"].as_str().unwrap_or("");
                                pending_source_text = source.to_string();
                                event_diagnostics.last_asr_completed_text =
                                    pending_source_text.clone();
                                event_diagnostics.last_asr_completed_at_ms =
                                    Some(elapsed_ms_since(&session_started_at));
                                if pending_source_text.trim().is_empty() {
                                    event_diagnostics.empty_asr_completed_count = event_diagnostics
                                        .empty_asr_completed_count
                                        .saturating_add(1);
                                } else {
                                    event_diagnostics
                                        .first_non_empty_asr_completed_at_ms
                                        .get_or_insert_with(|| {
                                            elapsed_ms_since(&session_started_at)
                                        });
                                }
                                store.live_session_events.push_asr_delta(
                                    "conversation.item.input_audio_transcription.completed",
                                    "",
                                    source,
                                );
                                if subtitle_translate_active
                                    && !pending_source_text.trim().is_empty()
                                {
                                    let cue_id = ensure_transcription_cue_id(&mut current_cue_id);
                                    if event_diagnostics.current_cue_origin.is_none() {
                                        event_diagnostics.current_cue_origin =
                                            Some("transcription_completed".to_string());
                                    }
                                    store.update_or_push_stt_cue(
                                        &cue_id,
                                        &pending_source_text,
                                        false,
                                    );
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[EVENT] transcription.completed -> ST_SOURCE_READY cue_id={cue_id} source=\"{source}\""
                                        ),
                                    );
                                    if native_translation_reuse_active {
                                        transcription_completed_flag = true;
                                        transcription_completed_at = Some(SystemTime::now());
                                    } else {
                                        pending_source_text.clear();
                                        current_cue_id = None;
                                        transcription_completed_flag = false;
                                        transcription_completed_at = None;
                                    }
                                } else {
                                    transcription_completed_flag = true;
                                    transcription_completed_at = Some(SystemTime::now());
                                    let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                    if let Some(ref id) = current_cue_id {
                                        store.update_or_push_stt_cue(
                                            id,
                                            &pending_source_text,
                                            false,
                                        );
                                    }
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[EVENT] transcription.completed 鈫?cue_id={cue_id_str} source=\"{source}\""
                                        ),
                                    );
                                }
                            }
                            "response.audio_transcript.delta"
                            | "response.audio_transcript.text" => {
                                let delta = if event_type == "response.audio_transcript.text" {
                                    let text = evt["text"].as_str().unwrap_or("");
                                    let stash = evt["stash"].as_str().unwrap_or("");
                                    pending_translated_text = format!("{text}{stash}");
                                    pending_translated_text.as_str()
                                } else {
                                    let delta = evt["delta"].as_str().unwrap_or("");
                                    pending_translated_text.push_str(delta);
                                    delta
                                };
                                store
                                    .live_session_events
                                    .push_output_delta(event_type, delta, "");
                                if native_translation_reuse_active {
                                    let cue_id = ensure_transcription_cue_id(&mut current_cue_id);
                                    if event_diagnostics.current_cue_origin.is_none() {
                                        event_diagnostics.current_cue_origin =
                                            Some("native_audio_transcript_delta".to_string());
                                    }
                                    write_native_translation_to_cue(
                                        &store,
                                        &cue_id,
                                        &pending_source_text,
                                        &pending_translated_text,
                                        false,
                                        true,
                                    );
                                    if !st_skip_logged {
                                        st_skip_logged = true;
                                        let _ = diag_log(
                                            &app,
                                            "omni",
                                            "info",
                                            format!(
                                                "[TRANS_NATIVE_PREVIEW] subtitle_translate_active=true livetranslate=true using native response.audio_transcript for low-latency subtitle cue_id={cue_id}"
                                            ),
                                        );
                                    }
                                } else if subtitle_translate_active && !st_skip_logged {
                                    st_skip_logged = true;
                                    let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[TRANS] subtitle_translate_active=true livetranslate=false skip native response.audio_transcript cue_id={cue_id_str}"
                                        ),
                                    );
                                } else if let Some(ref id) = current_cue_id {
                                    store.update_subtitle_cue_translation(
                                        id,
                                        pending_translated_text.clone(),
                                        false,
                                    );
                                }
                                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                let _ = diag_log(
                                    &app,
                                    "omni",
                                    "trace",
                                    format!(
                                        "[EVENT] audio_transcript.delta 鈫?cue_id={cue_id_str} delta=\"{delta}\" total_len={}",
                                        pending_translated_text.len()
                                    ),
                                );
                            }
                            "response.audio_transcript.done" => {
                                let transcript = evt["transcript"].as_str().unwrap_or("");
                                if !transcript.is_empty() {
                                    pending_translated_text = transcript.to_string();
                                }
                                event_diagnostics.last_output_done_text =
                                    pending_translated_text.clone();
                                event_diagnostics.last_output_done_at_ms =
                                    Some(elapsed_ms_since(&session_started_at));
                                store.live_session_events.push_output_delta(
                                    "response.audio_transcript.done",
                                    "",
                                    &pending_translated_text,
                                );
                                if native_translation_reuse_active
                                    && !pending_translated_text.trim().is_empty()
                                {
                                    let cue_id = ensure_transcription_cue_id(&mut current_cue_id);
                                    if event_diagnostics.current_cue_origin.is_none() {
                                        event_diagnostics.current_cue_origin =
                                            Some("native_audio_transcript_done".to_string());
                                    }
                                    write_native_translation_to_cue(
                                        &store,
                                        &cue_id,
                                        &pending_source_text,
                                        &pending_translated_text,
                                        false,
                                        false,
                                    );
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[TRANS_NATIVE_FINAL] subtitle_translate_active=true livetranslate=true native transcript ready for subtitle-tts cue_id={cue_id} translated_len={}",
                                            pending_translated_text.len()
                                        ),
                                    );
                                }
                                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                let _ = diag_log(
                                    &app,
                                    "omni",
                                    "debug",
                                    format!(
                                        "[EVENT] audio_transcript.done 鈫?cue_id={cue_id_str} transcript=\"{}\"",
                                        pending_translated_text
                                    ),
                                );
                            }
                            "response.audio.delta" => {
                                if let Some(delta) = evt["delta"].as_str() {
                                    match base64_decode_to_i16(delta) {
                                        Ok(samples) => {
                                            pending_audio_delta_count += 1;
                                            pending_audio_delta_base64_bytes += delta.len() as u64;
                                            if pending_audio_response_id.is_none() {
                                                pending_audio_response_id = evt["response_id"]
                                                    .as_str()
                                                    .map(ToString::to_string);
                                            }
                                            pending_audio_buffer.extend_from_slice(&samples);
                                            if pending_audio_delta_count == 1
                                                || pending_audio_delta_count.is_multiple_of(25)
                                            {
                                                let response_id = pending_audio_response_id
                                                    .as_deref()
                                                    .unwrap_or("(none)");
                                                let _ = diag_log(
                                                    &app,
                                                    "omni",
                                                    "debug",
                                                    format!(
                                                        "[AUDIO] native audio.delta received: response_id={response_id} deltas={} delta_b64_len={} decoded_samples={} buffered_samples={} sample_rate_hz={OMNI_OUTPUT_SAMPLE_RATE_HZ}",
                                                        pending_audio_delta_count,
                                                        delta.len(),
                                                        samples.len(),
                                                        pending_audio_buffer.len()
                                                    ),
                                                );
                                            }
                                        }
                                        Err(e) => {
                                            let _ = diag_log(
                                                &app,
                                                "omni",
                                                "warning",
                                                format!("[AUDIO] base64 decode failed: {e}"),
                                            );
                                        }
                                    }
                                }
                            }
                            "response.audio.done" => {
                                if !pending_audio_buffer.is_empty() {
                                    let cue_id = format!("omni-audio-{}", unix_ms());
                                    let sample_count = pending_audio_buffer.len();
                                    let duration_ms = ((sample_count as u64) * 1000)
                                        .saturating_div(OMNI_OUTPUT_SAMPLE_RATE_HZ as u64);
                                    let response_id =
                                        pending_audio_response_id.as_deref().unwrap_or("(none)");
                                    let _ = playback_tx.send(OmniPlaybackCommand::Play {
                                        samples: std::mem::take(&mut pending_audio_buffer),
                                        cue_id: cue_id.clone(),
                                        sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
                                    });
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[AUDIO] native audio.done: response_id={response_id} deltas={} base64_bytes={} samples={sample_count} sample_rate_hz={OMNI_OUTPUT_SAMPLE_RATE_HZ} duration_ms={duration_ms}; sent_to_playback_thread cue_id={cue_id}",
                                            pending_audio_delta_count,
                                            pending_audio_delta_base64_bytes
                                        ),
                                    );
                                } else {
                                    let response_id =
                                        pending_audio_response_id.as_deref().unwrap_or("(none)");
                                    let _ = diag_log(
                                        &app,
                                        "omni",
                                        "warning",
                                        format!(
                                            "[AUDIO] native audio.done received with empty buffer: response_id={response_id} deltas={} base64_bytes={}",
                                            pending_audio_delta_count,
                                            pending_audio_delta_base64_bytes
                                        ),
                                    );
                                }
                                pending_audio_buffer.clear();
                                pending_audio_delta_count = 0;
                                pending_audio_delta_base64_bytes = 0;
                                pending_audio_response_id = None;
                            }
                            "input_audio_buffer.speech_stopped" => {
                                last_vad_event_time = SystemTime::now();
                                vad_event_count += 1;
                                let _ = diag_log(
                                    &app,
                                    "omni",
                                    "info",
                                    format!(
                                        "[VAD] speech_stopped received (VAD 浜嬩欢璁℃暟={vad_event_count})"
                                    ),
                                );
                            }
                            "response.done" => {
                                handle_response_done(
                                    &app,
                                    store,
                                    &mut trace_call,
                                    &mut current_cue_id,
                                    &mut pending_source_text,
                                    &mut pending_translated_text,
                                    subtitle_translate_active,
                                    native_translation_reuse_active,
                                    &mut transcription_completed_flag,
                                    &mut transcription_completed_at,
                                    &mut event_diagnostics,
                                    &session_started_at,
                                );
                                store.live_session_events.push_output_delta(
                                    "response.done",
                                    "",
                                    "",
                                );
                            }
                            "error" => {
                                let err_code = evt["error"]["code"].as_str().unwrap_or("?");
                                let err_msg =
                                    evt["error"]["message"].as_str().unwrap_or("鏈煡閿欒");
                                let _ = diag_log(
                                    &app,
                                    "omni",
                                    "error",
                                    format!(
                                        "[EVENT] error: code={err_code} message=\"{err_msg}\" raw={text}"
                                    ),
                                );
                                let handled_voice_fallback =
                                    is_unsupported_voice_error(err_code, err_msg)
                                        && !voice_fallback_applied
                                        && !active_voice.trim().is_empty()
                                        && reconnect_count < OMNI_RECONNECT_MAX_RETRIES;
                                if handled_voice_fallback {
                                    let rejected_voice = active_voice.clone();
                                    voice_fallback_applied = true;
                                    active_voice.clear();
                                    let _ = diag_log_detail(
                                        &app,
                                        "omni",
                                        "warning",
                                        format!(
                                            "[VOICE] Provider rejected voice '{rejected_voice}'. Reconnecting without voice to use provider default."
                                        ),
                                        format!("errorCode={err_code}"),
                                    );
                                    match try_reconnect(
                                        &mut reconnect_count,
                                        &mut pending_audio_buffer,
                                        store,
                                        &app,
                                        &provider,
                                        &active_voice,
                                        &instructions,
                                        audio_mode,
                                        &target_language,
                                        buffer_size,
                                    ) {
                                        Ok(new_socket) => socket = new_socket,
                                        Err(_) => {}
                                    }
                                } else {
                                    trace_call.error(format!(
                                        "model error code={err_code} message={err_msg} raw={text}"
                                    ));
                                }
                            }
                            other => {
                                let is_vad_related = other.starts_with("input_audio_buffer.")
                                    || other.starts_with("conversation.item.input_audio");
                                let prefix = if is_vad_related {
                                    "[VAD] unknown VAD event"
                                } else {
                                    "[EVENT] unknown event"
                                };
                                let preview = if text.len() > 600 {
                                    format!("{}...({} bytes)", &text[..600], text.len())
                                } else {
                                    text.to_string()
                                };
                                let _ = diag_log(
                                    &app,
                                    "omni",
                                    "debug",
                                    format!("{prefix}: type=\"{other}\" raw={preview}"),
                                );
                            }
                        }
                    } else {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[EVENT] JSON 瑙ｆ瀽澶辫触: {text}"),
                        );
                    }
                }
                Message::Close(_) => {
                    let _ = diag_log(&app, "omni", "warning", "[SOCKET] WebSocket closed");
                    match try_reconnect(
                        &mut reconnect_count,
                        &mut pending_audio_buffer,
                        store,
                        &app,
                        &provider,
                        &active_voice,
                        &instructions,
                        audio_mode,
                        &target_language,
                        buffer_size,
                    ) {
                        Ok(new_socket) => {
                            socket = new_socket;
                            continue;
                        }
                        Err(_) => {
                            return Err(
                                "Omni WebSocket closed and reconnect retry limit exhausted"
                                    .to_string(),
                            );
                        }
                    }
                }
                _ => {}
            },
            Err(error) => {
                let err_str = error.to_string();
                if err_str.contains("timed out")
                    || err_str.contains("WouldBlock")
                    || err_str.contains("10060")
                {
                    continue;
                }
                if cfg!(debug_assertions) {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "verbose",
                        format!("[SOCKET_TRACE] Read 瓒呮椂锛堥鏈熻涓猴級: {err_str}"),
                    );
                }

                if err_str.contains("timed out")
                    || err_str.contains("WouldBlock")
                    || err_str.contains("10060")
                {
                    if cfg!(debug_assertions) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "verbose",
                            "[SOCKET_TRACE] read timeout or non-blocking callback ignored",
                        );
                    }
                } else {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "error",
                        format!("[SOCKET_FATAL] 鍙戠敓浜嗙‖鑷存閿欒!: {error}"),
                    );
                    let _ = diag_log(
                        &app,
                        "omni",
                        "warning",
                        format!("[SOCKET] 璇婚敊璇? {error}"),
                    );
                    match try_reconnect(
                        &mut reconnect_count,
                        &mut pending_audio_buffer,
                        store,
                        &app,
                        &provider,
                        &active_voice,
                        &instructions,
                        audio_mode,
                        &target_language,
                        buffer_size,
                    ) {
                        Ok(new_socket) => {
                            socket = new_socket;
                            continue;
                        }
                        Err(_) => {
                            return Err(format!(
                                "Omni WebSocket 璇婚敊璇笖閲嶈繛娆℃暟宸茬敤瀹? {error}"
                            ));
                        }
                    }
                }
            }
        }

        if check_vad_warning(
            &app,
            &last_vad_event_time,
            chunk_count,
            vad_event_count,
            buffer_size,
        ) {
            last_vad_event_time = SystemTime::now();
        }
        emit_audio_snapshot(&app, store)?;
        thread::sleep(Duration::from_millis(10));
    }

    Ok(())
}

fn reconnect_socket(
    app: AppHandle,
    provider: &ProviderDraftInput,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, String>
{
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 閲嶈繛浠呮敮鎸?dashscope provider锛屽綋鍓嶄负 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let ws_url = gateway::to_websocket_url(&provider.base_url, &provider.model)
        .map_err(|error| format!("鏃犳硶鏋勫缓 WebSocket URL: {}", error.message))?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("鏃犳硶鍒涘缓 WebSocket 璇锋眰: {error}"))?;
    gateway::apply_ws_auth(provider, request.headers_mut())
        .map_err(|error| format!("鏃犳硶搴旂敤璁よ瘉澶? {}", error.message))?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("鏃犳硶閲嶆柊杩炴帴 Omni 鏈嶅姟: {error}"))?;
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);

    let session_cfg = build_omni_session_update(
        &provider.model,
        voice,
        instructions,
        audio_mode,
        target_language,
    );
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("鏃犳硶閲嶅彂 Omni session 閰嶇疆: {error}"))?;

    let _ = diag_log(&app, "omni", "info", "reconnected to Omni service");
    Ok(socket)
}

#[cfg(test)]
mod native_translation_tests {
    use super::*;

    #[test]
    fn native_translation_writes_display_segment_for_secondary_tts() {
        let store = AudioStateStore::new();

        write_native_translation_to_cue(
            &store,
            "omni-cue-test",
            "hello world",
            "你好，世界。",
            true,
            false,
        );

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-test")
            .expect("native translation cue");

        assert!(cue.committed);
        assert_eq!(cue.source_text, "hello world");
        assert_eq!(cue.translated_text, "你好，世界。");
        assert_eq!(cue.display_segments.len(), 1);
        assert!(!cue.display_segments[0].pending);
        assert_eq!(cue.display_segments[0].translated_text, "你好，世界。");
    }

    #[test]
    fn native_translation_preview_keeps_display_segment_pending() {
        let store = AudioStateStore::new();

        write_native_translation_to_cue(&store, "omni-cue-preview", "", "实时字幕", false, true);

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-preview")
            .expect("native preview cue");

        assert!(!cue.committed);
        assert_eq!(cue.source_text, "实时字幕");
        assert_eq!(cue.translated_text, "实时字幕");
        assert_eq!(cue.display_segments.len(), 1);
        assert!(cue.display_segments[0].pending);
    }
}

// Network diagnostics live in scripts/diagnostics/omni-realtime.
#[cfg(any())]
mod tests {
    use super::*;
    use std::io::Read;
    use std::time::Instant;
    use tungstenite::client::IntoClientRequest;
    use tungstenite::{connect, Message};

    const TEST_API_KEY_ENV: &str = "DASHSCOPE_API_KEY";
    const TEST_MODEL: &str = "qwen3.5-omni-plus-realtime-2026-03-15";
    const TEST_WS_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime-2026-03-15";
    const TEST_PCM: &str = "../../test/test_16k_mono.pcm";

    #[test]
    #[ignore = "requires API key and network access"]
    fn omni_integration_ogg_to_subtitle() {
        let mut raw = Vec::new();
        std::fs::File::open(TEST_PCM)
            .expect("鎵句笉鍒?test_16k_mono.pcm锛岃鍏堣繍琛?Python 鑴氭湰鐢熸垚")
            .read_to_end(&mut raw)
            .expect("璇诲彇 PCM 澶辫触");

        let samples: Vec<i16> = raw
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        println!(
            "PCM: {} samples ({:.1}s)",
            samples.len(),
            samples.len() as f64 / 16000.0
        );

        let chunk_sz = 320usize;
        let chunks: Vec<&[i16]> = samples.chunks(chunk_sz).collect();
        println!("鍏?{} 涓煶棰戝潡", chunks.len());

        let request = TEST_WS_URL.into_client_request().unwrap();
        let (mut socket, _) = connect(request).unwrap();
        set_socket_read_timeout(&mut socket);
        println!("[TEST] connected");

        let session_cfg = json!({
          "type": "session.update",
          "session": {
            "modalities": ["text", "audio"],
            "voice": "Ethan",
            "instructions": "Translate incoming audio into Chinese subtitles.",
            "input_audio_format": "pcm16",
            "sample_rate": 16000,
            "output_audio_format": "pcm",
            "turn_detection": { "type": "server_vad", "threshold": 0.0, "silence_duration_ms": 800 }
          }
        });
        socket
            .send(Message::Text(session_cfg.to_string().into()))
            .unwrap();
        println!("[TEST] session.update 宸插彂閫?(sample_rate=16000, server_vad)");

        let msg = socket.read().unwrap();
        if let Message::Text(text) = &msg {
            let evt: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(
                evt["type"].as_str().unwrap(),
                "session.created",
                "session 鍒涘缓澶辫触: {text}"
            );
            println!("[TEST] session.created OK");
        }

        while let Ok(msg) = socket.read() {
            if let Message::Text(text) = &msg {
                let evt: serde_json::Value = serde_json::from_str(text).unwrap();
                if evt["type"].as_str() == Some("session.updated") {
                    break;
                }
            }
        }
        println!("[TEST] session.updated OK, 寮€濮嬪彂閫侀煶棰?..");

        let start = Instant::now();
        for (i, chunk) in chunks.iter().enumerate() {
            let b64 = base64_encode_i16(chunk);
            let append = json!({ "type": "input_audio_buffer.append", "audio": b64 });
            socket
                .send(Message::Text(append.to_string().into()))
                .unwrap();
            if i % 200 == 0 {
                println!("[TEST] 闊抽 {}/{}", i + 1, chunks.len());
            }
            std::thread::sleep(std::time::Duration::from_millis(18));
        }
        println!(
            "[TEST] 鍏ㄩ儴 {} 鍧楀彂閫佸畬鎴?({:.1}s)",
            chunks.len(),
            start.elapsed().as_secs_f64()
        );

        let mut got_speech_started = false;
        let mut source = String::new();
        let mut translated = String::new();
        let timeout = std::time::Duration::from_secs(60);

        loop {
            if start.elapsed() > timeout {
                break;
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    let evt: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let t = evt["type"].as_str().unwrap_or("?");

                    match t {
                        "input_audio_buffer.speech_started" => {
                            got_speech_started = true;
                            println!("[TEST] 鉁?speech_started");
                        }
                        "conversation.item.input_audio_transcription.delta" => {
                            let txt = evt["text"].as_str().unwrap_or("");
                            let st = evt["stash"].as_str().unwrap_or("");
                            println!("[TEST] src_delta: {}{}", txt, st);
                        }
                        "conversation.item.input_audio_transcription.completed" => {
                            source = evt["transcript"].as_str().unwrap_or("").to_string();
                            println!("[TEST] 鉁?src_completed: {source}");
                        }
                        "response.audio_transcript.delta" => {
                            let d = evt["delta"].as_str().unwrap_or("");
                            translated.push_str(d);
                            println!("[TEST] trans_delta: {d}");
                        }
                        "response.audio_transcript.done" => {
                            let tr = evt["transcript"].as_str().unwrap_or("");
                            if !tr.is_empty() {
                                translated = tr.to_string();
                            }
                            println!("[TEST] 鉁?trans_done: {translated}");
                        }
                        "response.done" => {
                            println!("[TEST] 鉁?response.done");
                            break;
                        }
                        "error" => {
                            let err = &evt["error"];
                            println!(
                                "[TEST] 鉂?error: {}",
                                err["message"].as_str().unwrap_or("?")
                            );
                            break;
                        }
                        _ => {}
                    }
                }
                Ok(Message::Close(_)) => {
                    println!("[TEST] WS closed");
                    break;
                }
                Err(e) => {
                    if e.to_string().contains("timed out") || e.to_string().contains("TimedOut") {
                        println!("[TEST] read timeout");
                    } else {
                        println!("[TEST] read error: {e}");
                    }
                    break;
                }
                _ => {}
            }
        }

        println!("\n===== TEST RESULT =====");
        println!("speech_started: {got_speech_started}");
        println!("source: '{source}'");
        println!("translated: '{translated}'");

        assert!(got_speech_started, "VAD 鏈Е鍙?speech_started");
        assert!(
            !source.is_empty() || !translated.is_empty(),
            "no text output was received"
        );
        println!("integration test passed");
    }
}
