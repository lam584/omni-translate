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
use super::sentence::SubtitleDisplaySegmenter;
use super::state::AudioStateStore;
use super::time_utils::{ms_marker, unix_ms};
use crate::bridge::ipc::BridgeAudioWriter;
use crate::diagnostics::model_trace::{ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway_parts::{
    auth::apply_ws_auth,
    transport::to_websocket_url,
};

mod codec;
mod audio_pump;
mod asr_event_processor;
mod connection;
mod connection_coordinator;
mod event_processor;
mod config;
mod session_worker;
mod socket_event_processor;

pub use self::session_worker::{start_omni, OmniHandle};
use self::session_worker::reconnect_socket;
use self::socket_event_processor::{
    OmniSocketEventContext, OmniSocketEventProcessor, OmniSocketEventState,
};

use self::codec::{
    asr_chunk_rms, base64_decode_to_i16, base64_encode_i16, resample_48k_stereo_to_16k_mono,
};
use self::audio_pump::{OmniAudioPump, OmniAudioPumpState};
use self::asr_event_processor::{OmniAsrEventProcessor, OmniAsrEventState};
use self::connection::OmniConnection;
use self::connection_coordinator::{
    OmniCommitState, OmniConnectedSession, OmniConnectionCoordinator, OmniReconnectState,
};
use self::event_processor::{
    OmniAudioOutputState, OmniEventProcessor, OmniReadinessState, OmniSubtitleEventState,
};
use self::config::OmniSessionConfig;

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
const OMNI_INTER_CHUNK_THROTTLE_MS: u64 = 18;
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
                "模型 {model} 配置了 Gemini 实时语音模式，但当前看片模式的 Omni/DashScope 实时链路不支持 Gemini Live 协议"
            )),
            Some(other) => Err(format!(
                "模型 {model} 配置了不支持的实时语音模式: {other}"
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

include!("protocol.rs");
#[cfg(test)]
mod native_translation_tests {
    use super::*;

    #[test]
    fn native_omni_deltas_share_one_uncommitted_live_cue() {
        let store = AudioStateStore::new();
        let mut current_cue_id = None;

        let first_id = write_live_source_to_cue(&store, &mut current_cue_id, "With or");
        let second_id = write_live_source_to_cue(
            &store,
            &mut current_cue_id,
            "With or without you",
        );
        let preview_id = write_native_output_preview_to_cue(
            &store,
            &mut current_cue_id,
            "With or without you",
            "translated partial",
        );

        assert_eq!(first_id, second_id);
        assert_eq!(second_id, preview_id);
        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == preview_id)
            .expect("live Omni cue");
        assert_eq!(cue.source_text, "With or without you");
        assert_eq!(cue.translated_text, "translated partial");
        assert!(!cue.committed);
    }

    #[test]
    fn empty_completed_transcription_keeps_the_last_delta_hypothesis() {
        assert_eq!(
            preserve_last_non_empty_transcription("Oh, my dilemma.", ""),
            "Oh, my dilemma."
        );
        assert_eq!(
            preserve_last_non_empty_transcription("older hypothesis", "final transcript"),
            "final transcript"
        );
    }

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

    #[test]
    fn native_translation_breaks_long_source_and_translation_into_display_rows() {
        let store = AudioStateStore::new();
        let source = "Project Aurora has a one billion dollar reliability fund. The first research station is planned for Mars. Its construction budget is five hundred million dollars. Inside the station, an artificial biosphere keeps air, water, and plants in balance.";
        let translated = "极光项目拥有十亿美元的可靠性基金。第一个研究站计划建在火星上。它的建设预算是五亿美元。研究站内的人工生物圈维持空气、水和植物的平衡。";

        write_native_translation_to_cue(&store, "omni-cue-long", source, translated, true, false);

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-long")
            .expect("native translation cue");

        assert!(cue.display_segments.len() >= 3);
        assert!(cue.display_source_text.contains('\n'));
        assert!(cue.translated_text.contains('\n'));
        assert!(cue.display_segments.iter().all(|segment| {
            segment.source_text.chars().count() <= 120
                && segment.translated_text.chars().count() <= 120
        }));
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
                            println!("[TEST] ✅ speech_started");
                        }
                        "conversation.item.input_audio_transcription.delta" => {
                            let txt = evt["text"].as_str().unwrap_or("");
                            let st = evt["stash"].as_str().unwrap_or("");
                            println!("[TEST] src_delta: {}{}", txt, st);
                        }
                        "conversation.item.input_audio_transcription.completed" => {
                            source = evt["transcript"].as_str().unwrap_or("").to_string();
                            println!("[TEST] ✅ src_completed: {source}");
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
                            println!("[TEST] ✅ trans_done: {translated}");
                        }
                        "response.done" => {
                            println!("[TEST] ✅ response.done");
                            break;
                        }
                        "error" => {
                            let err = &evt["error"];
                            println!(
                                "[TEST] ❌ error: {}",
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
