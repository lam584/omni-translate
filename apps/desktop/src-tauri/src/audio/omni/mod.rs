use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::Manager;
use tungstenite::client::{connect_with_config, IntoClientRequest};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

#[cfg(test)]
thread_local! {
    static TEST_OMNI_CONNECT_URI_OVERRIDE: std::cell::RefCell<Option<tungstenite::http::Uri>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_test_omni_connect_uri_override(uri: &str) {
    let uri = uri
        .parse::<tungstenite::http::Uri>()
        .expect("test Omni connect override must be a valid URI");
    TEST_OMNI_CONNECT_URI_OVERRIDE.with(|slot| {
        assert!(
            slot.borrow().is_none(),
            "test Omni connect override must be consumed before another is registered"
        );
        *slot.borrow_mut() = Some(uri);
    });
}

fn connect_without_redirects(
    request: tungstenite::handshake::client::Request,
) -> tungstenite::Result<(
    tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    tungstenite::handshake::client::Response,
)> {
    #[cfg(test)]
    let request = {
        let mut request = request;
        TEST_OMNI_CONNECT_URI_OVERRIDE.with(|slot| {
            if let Some(uri) = slot.borrow_mut().take() {
                *request.uri_mut() = uri;
            }
        });
        request
    };
    // Authentication is already attached to this request. A redirect must not
    // replay that credential to another origin.
    connect_with_config(request, None, 0)
}

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

mod audio_pump;
mod audio_origin;
mod asr_event_processor;
mod connection;
mod connection_coordinator;
mod event_processor;
mod config;
mod provider_input_budget;
mod realtime_socket;
mod response_lifecycle;
mod response_ledger;
pub(crate) use self::realtime_socket::{
    RealtimeSocket, RealtimeSocketConnector, TungsteniteConnector,
};
pub(crate) mod session_errors;
#[cfg(test)]
mod local_ws_reconnect_tests;
#[cfg(test)]
mod replay_tests;
#[cfg(test)]
mod watch_report_replay_tests;
mod session_worker;
mod socket_event_processor;
mod translated_pcm_authority;

pub(crate) use self::session_worker::{start_omni, OmniHandle};
use self::session_worker::reconnect_socket;
use self::socket_event_processor::{
    OmniSocketEventContext, OmniSocketEventProcessor, OmniSocketEventState,
};

use crate::audio::pcm_resample::{
    base64_decode_to_i16, base64_encode_pcm16 as base64_encode_i16,
    pcm16_chunk_rms as asr_chunk_rms,
};
use crate::audio::realtime_ws::backoff_delay;
use self::audio_pump::{OmniAudioPump, OmniAudioPumpState};
#[cfg(test)]
use self::audio_pump::should_anchor_manual_turn_to_first_audible_append;
use self::asr_event_processor::{OmniAsrEventProcessor, OmniAsrEventState};
use self::connection::OmniConnection;
use self::connection_coordinator::{
    completed_manual_response_decision_for_gate,
    manual_turn_cue_to_discard,
    should_route_uncorrelated_completed_transcription, ManualResponseDecision,
    OmniCommitState, OmniConnectedSession, OmniConnectionCoordinator, OmniReconnectState,
    MANUAL_RESPONSE_TIMEOUT_SECS,
};
#[cfg(test)]
use self::connection_coordinator::{
    completed_manual_response_decision,
    MANUAL_COMMIT_INTERVAL_SECS, MANUAL_COMMIT_MIN_AUDIO_SAMPLES,
};
use self::event_processor::{
    OmniAudioOutputState, OmniEventProcessor, OmniReadinessState, OmniSubtitleEventState,
};
use self::config::OmniSessionConfig;
use self::provider_input_budget::ProviderInputBudget;
use self::session_errors::{
    classify_connect_error, classify_provider_error, split_error_markers, with_error_markers,
    SessionErrorCode,
};

const OMNI_RECONNECT_MAX_RETRIES: usize = 5;
const OMNI_INITIAL_CONNECT_RETRIES: usize = 3;
const OMNI_WRITE_TIMEOUT_SECS: u64 = 10;
const OMNI_READ_TIMEOUT_MS: u64 = 200;
const OMNI_VAD_WARNING_INTERVAL_SECS: u64 = 30;
const TRANSCRIPTION_COMPLETED_TIMEOUT_MS: u64 = 30_000;
const OMNI_OUTPUT_SAMPLE_RATE_HZ: u32 = 24_000;
// Realtime native audio deltas may be as small as 20 ms. Capacity must permit
// the full five-second time budget plus lifecycle control frames; projected
// audio duration, not item count, remains the authoritative admission limit.
const OMNI_PLAYBACK_QUEUE_CAPACITY: usize = 260;
const OMNI_PLAYBACK_MAX_QUEUE_AGE: Duration = Duration::from_secs(5);
// Also buffers continuous input while a manual provider response is active.
// DashScope does not preserve appends made during response streaming in the
// next input buffer. 4,000 20 ms frames cover the longest allowed response
// gate plus scheduling jitter without an unbounded channel-to-provider
// backlog; once response.done arrives the normal pump drains this queue.
const OMNI_PRE_SESSION_AUDIO_QUEUE_LIMIT: usize = 4_000;
const OMNI_PRE_SESSION_AUDIO_DRAIN_PER_TICK: usize = 4;
const OMNI_ASR_MIN_CHUNK_RMS: f32 = 0.002;
// Forty 20 ms frames keep 800 ms of trailing silence, matching the server-VAD
// boundary while allowing manual routes to commit natural pauses promptly.
const OMNI_ASR_SILENCE_GRACE_CHUNKS: u32 = 40;
const OMNI_INTER_CHUNK_THROTTLE_MS: u64 = 18;
const PROVIDER_INPUT_PCM_DUMP_MAX_SAMPLES: usize = 16_000 * 90;
const PROVIDER_INPUT_PREFILTER_FILE: &str = "provider-input-prefilter-48k-stereo.f32le.frames";
const PROVIDER_INPUT_PREFILTER_MAGIC: &[u8; 8] = b"OMNIPR01";

#[derive(Debug)]
struct ProviderInputPcmDump {
    file: std::fs::File,
    path: String,
    samples_written: usize,
    max_samples: usize,
    write_failed: bool,
    strict_paid_authority: bool,
}

impl ProviderInputPcmDump {
    fn from_env<R: tauri::Runtime>(
        app: &AppHandle<R>,
        strict_budget_max_samples: Option<usize>,
        strict_paid_authority: bool,
    ) -> Result<Option<Self>, String> {
        let path = std::env::var("OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(path) = path else {
            return if strict_paid_authority {
                Err("strict paid provider authority requires OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH before connect".to_string())
            } else {
                Ok(None)
            };
        };
        match Self::open_path(
            path.clone(),
            strict_budget_max_samples.unwrap_or(PROVIDER_INPUT_PCM_DUMP_MAX_SAMPLES),
            strict_paid_authority,
        ) {
            Ok(dump) => {
                let _ = diag_log(
                    app,
                    "omni",
                    "info",
                    format!("[WATCH] provider input PCM dump enabled: {path}"),
                );
                Ok(Some(dump))
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
                if strict_paid_authority {
                    Err(error)
                } else {
                    Ok(None)
                }
            }
        }
    }

    fn open_path(
        path: String,
        max_samples: usize,
        strict_paid_authority: bool,
    ) -> Result<Self, String> {
        let mut options = OpenOptions::new();
        options.write(true);
        if strict_paid_authority {
            options.create_new(true);
        } else {
            options.create(true).truncate(true);
        }
        let mut file = options.open(&path).map_err(|error| {
            if strict_paid_authority {
                format!(
                    "strict paid provider input PCM dump must be a new exclusive file: path={path} error={error}"
                )
            } else {
                format!("provider input PCM dump open failed: path={path} error={error}")
            }
        })?;
        if strict_paid_authority {
            file.flush().map_err(|error| {
                format!(
                    "strict paid provider input PCM dump initial flush failed: path={path} error={error}"
                )
            })?;
        }
        Ok(Self {
            file,
            path,
            samples_written: 0,
            max_samples,
            write_failed: false,
            strict_paid_authority,
        })
    }

    fn append<R: tauri::Runtime>(
        &mut self,
        app: &AppHandle<R>,
        samples: &[i16],
    ) -> Result<(), String> {
        let result = self.append_samples(samples);
        if let Err(error) = &result {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[WATCH] provider input PCM dump write failed: path={} error={error}",
                    self.path
                ),
            );
        }
        if self.strict_paid_authority {
            result
        } else {
            Ok(())
        }
    }

    fn append_samples(&mut self, samples: &[i16]) -> Result<(), String> {
        if self.write_failed || samples.is_empty() || self.samples_written >= self.max_samples {
            if self.strict_paid_authority && !samples.is_empty() {
                return Err(format!(
                    "strict paid provider input PCM dump is not writable: path={} samplesWritten={} maxSamples={}",
                    self.path, self.samples_written, self.max_samples
                ));
            }
            return Ok(());
        }
        let remaining = self.max_samples - self.samples_written;
        let samples = if samples.len() > remaining && self.strict_paid_authority {
            return Err(format!(
                "strict paid provider input PCM dump would exceed its cap: path={} attemptedSamples={} remainingSamples={remaining}",
                self.path,
                samples.len()
            ));
        } else if samples.len() > remaining {
            &samples[..remaining]
        } else {
            samples
        };
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let write_result = self.file.write_all(&bytes).and_then(|_| {
            if self.strict_paid_authority {
                self.file.flush()
            } else {
                Ok(())
            }
        });
        if let Err(error) = write_result {
            self.write_failed = true;
            return Err(error.to_string());
        }
        self.samples_written += samples.len();
        Ok(())
    }
}

/// Durable framing for the exact 48 kHz stereo f32 chunks consumed by the
/// production Omni pump before resampling, RMS gating, silence grace, and the
/// provider-input budget decision. Keeping chunk boundaries is essential:
/// the trailing-silence allowance is expressed in chunks rather than time.
#[derive(Debug)]
struct ProviderInputPrefilterDump {
    file: std::fs::File,
    path: String,
    strict_paid_authority: bool,
}

impl ProviderInputPrefilterDump {
    fn from_provider_pcm_path(
        provider_pcm_path: Option<&str>,
        strict_paid_authority: bool,
    ) -> Result<Option<Self>, String> {
        if !strict_paid_authority {
            return Ok(None);
        }
        let provider_pcm_path = provider_pcm_path.ok_or_else(|| {
            "strict paid provider authority requires a provider PCM path before creating prefilter authority".to_string()
        })?;
        let parent = Path::new(provider_pcm_path).parent().ok_or_else(|| {
            format!("strict paid provider PCM path has no parent: {provider_pcm_path}")
        })?;
        let path = parent.join(PROVIDER_INPUT_PREFILTER_FILE);
        let path_text = path.to_string_lossy().into_owned();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                format!(
                    "strict paid provider prefilter authority must be a new exclusive file: path={path_text} error={error}"
                )
            })?;
        file.write_all(PROVIDER_INPUT_PREFILTER_MAGIC)
            .and_then(|_| file.flush())
            .map_err(|error| {
                format!(
                    "strict paid provider prefilter authority header write failed: path={path_text} error={error}"
                )
            })?;
        Ok(Some(Self {
            file,
            path: path_text,
            strict_paid_authority,
        }))
    }

    fn append_chunk<R: tauri::Runtime>(
        &mut self,
        app: &AppHandle<R>,
        raw_chunk: &[u8],
    ) -> Result<(), String> {
        let result = self.append_chunk_bytes(raw_chunk);
        if let Err(error) = &result {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[WATCH] provider prefilter authority write failed: path={} error={error}",
                    self.path
                ),
            );
        }
        if self.strict_paid_authority {
            result
        } else {
            Ok(())
        }
    }

    fn append_chunk_bytes(&mut self, raw_chunk: &[u8]) -> Result<(), String> {
        let byte_length = u32::try_from(raw_chunk.len()).map_err(|_| {
            format!(
                "provider prefilter authority chunk exceeds u32 framing: path={} bytes={}",
                self.path,
                raw_chunk.len()
            )
        })?;
        self.file
            .write_all(&byte_length.to_le_bytes())
            .and_then(|_| self.file.write_all(raw_chunk))
            .and_then(|_| self.file.flush())
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RealtimeAudioMode {
    Manual,
    ServerVad,
    SemanticVad,
}

impl RealtimeAudioMode {
    pub(crate) fn from_config_value(value: Option<&str>, model: &str) -> Result<Self, String> {
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
            None => Err(format!(
                "模型 {model} 缺少显式 realtimeAudioMode；运行时不会按模型名推断协议"
            )),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::ServerVad => "server_vad",
            Self::SemanticVad => "semantic_vad",
        }
    }

    pub(crate) fn uses_manual_commit(self) -> bool {
        self == Self::Manual
    }

    pub(crate) fn turn_detection(self) -> Value {
        match self {
            Self::Manual => Value::Null,
            Self::ServerVad => json!({
              "type": "server_vad",
              "threshold": 0.0,
              "silence_duration_ms": 800
            }),
            Self::SemanticVad => json!({
              "type": "semantic_vad",
              "threshold": 0.5,
              "silence_duration_ms": 800
            }),
        }
    }
}

/// 48 kHz stereo f32 capture -> 16 kHz mono i16, as the DashScope wire
/// format expects. Thin fixed-rate front for the shared capture resampler.
fn resample_48k_stereo_to_16k_mono(input: &[u8]) -> Vec<i16> {
    crate::audio::pcm_resample::resample_capture_to_mono_i16(input, 16_000)
}

fn initial_connect_backoff(retry_count: usize) -> Duration {
    Duration::from_millis(250_u64 << retry_count.saturating_sub(1))
}

/// Build the authenticated DashScope realtime WebSocket request shared by the
/// initial connect and the reconnect path. Callers keep their own
/// provider-kind guard because the rejection wording differs; the URL, request
/// and auth-header construction are byte-for-byte identical in both places.
fn build_dashscope_ws_request(
    provider: &ProviderDraftInput,
) -> Result<tungstenite::handshake::client::Request, String> {
    let authority = crate::audio::events::authorize_bailian_native_translate(provider)?;
    let ws_url = to_websocket_url(&provider.base_url, &provider.model)
        .map_err(|error| format!("无法构建 WebSocket URL: {}", error.message))?;
    if ws_url.path() != authority.endpoint_path {
        return Err(format!(
            "model_protocol.endpoint_family_mismatch: profile '{}' requires endpoint path '{}' but request resolved '{}'",
            authority.profile_id,
            authority.endpoint_path,
            ws_url.path()
        ));
    }
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("无法创建 WebSocket 请求: {error}"))?;
    apply_ws_auth(provider, request.headers_mut())
        .map_err(|error| format!("无法应用认证头: {}", error.message))?;
    Ok(request)
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use super::audio_pump::manual_turn_has_audible_input;
    use super::protocol::{
        build_livetranslate_session_update_with_languages, is_session_ready_event,
        resolve_livetranslate_language, resolve_livetranslate_output_mode,
        should_use_native_output_fallback,
    };
    use base64::Engine;
    use tempfile::tempdir;

    #[test]
    fn strict_prefilter_dump_preserves_exact_chunk_boundaries() {
        let directory = tempdir().expect("tempdir");
        let provider_pcm_path = directory.path().join("provider-input-16k-mono.pcm");
        let provider_pcm_path = provider_pcm_path.to_string_lossy().into_owned();
        let mut dump = ProviderInputPrefilterDump::from_provider_pcm_path(
            Some(&provider_pcm_path),
            true,
        )
        .expect("strict prefilter authority")
        .expect("strict mode enables the dump");
        dump.append_chunk_bytes(&[1, 2, 3]).expect("first chunk");
        dump.append_chunk_bytes(&[4, 5]).expect("second chunk");
        drop(dump);

        let bytes = std::fs::read(directory.path().join(PROVIDER_INPUT_PREFILTER_FILE))
            .expect("prefilter authority bytes");
        assert_eq!(&bytes[..8], PROVIDER_INPUT_PREFILTER_MAGIC);
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 3);
        assert_eq!(&bytes[12..15], &[1, 2, 3]);
        assert_eq!(u32::from_le_bytes(bytes[15..19].try_into().unwrap()), 2);
        assert_eq!(&bytes[19..], &[4, 5]);
    }

    #[test]
    fn strict_prefilter_dump_is_exclusive_and_non_strict_is_disabled() {
        let directory = tempdir().expect("tempdir");
        let provider_pcm_path = directory.path().join("provider-input-16k-mono.pcm");
        let provider_pcm_path = provider_pcm_path.to_string_lossy().into_owned();
        let first = ProviderInputPrefilterDump::from_provider_pcm_path(
            Some(&provider_pcm_path),
            true,
        )
        .expect("first strict authority")
        .expect("strict authority enabled");
        assert!(ProviderInputPrefilterDump::from_provider_pcm_path(
            Some(&provider_pcm_path),
            true,
        )
        .is_err());
        drop(first);
        assert!(ProviderInputPrefilterDump::from_provider_pcm_path(
            Some(&provider_pcm_path),
            false,
        )
        .expect("non-strict mode")
        .is_none());
    }

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
    fn text_only_omni_session_omits_audio_output_fields() {
        let session = build_omni_session_update_with_output_mode(
            "qwen3.5-omni-plus-realtime",
            "Tina",
            "translate naturally",
            RealtimeAudioMode::Manual,
            "zh-CN",
            OmniOutputMode::TextOnly,
        );

        assert_eq!(session.pointer("/session/modalities"), Some(&json!(["text"])));
        assert!(session.pointer("/session/voice").is_none());
        assert!(session.pointer("/session/output_audio_format").is_none());
        assert_eq!(
            session
                .pointer("/session/input_audio_format")
                .and_then(Value::as_str),
            Some("pcm16")
        );
    }

    #[test]
    fn text_only_livetranslate_session_keeps_translation_input_contract() {
        let session = build_omni_session_update_with_output_mode(
            "qwen3.5-livetranslate-flash-realtime",
            "Cherry",
            "translate naturally",
            RealtimeAudioMode::ServerVad,
            "zh-CN",
            OmniOutputMode::TextOnly,
        );

        assert_eq!(session.pointer("/session/modalities"), Some(&json!(["text"])));
        assert!(session.pointer("/session/voice").is_none());
        assert!(session.pointer("/session/output_audio_format").is_none());
        assert_eq!(
            session
                .pointer("/session/input_audio_format")
                .and_then(Value::as_str),
            Some("pcm")
        );
        assert_eq!(
            session
                .pointer("/session/translation/language")
                .and_then(Value::as_str),
            Some("zh")
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
    fn silence_grace_cannot_arm_another_manual_commit() {
        assert!(!manual_turn_has_audible_input(
            false,
            OMNI_ASR_MIN_CHUNK_RMS * 0.5,
        ));
        assert!(manual_turn_has_audible_input(
            false,
            OMNI_ASR_MIN_CHUNK_RMS,
        ));
        assert!(manual_turn_has_audible_input(
            true,
            OMNI_ASR_MIN_CHUNK_RMS * 0.5,
        ));
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
    fn livetranslate_session_normalizes_explicit_source_and_target_languages() {
        let session = build_livetranslate_session_update_with_languages(
            "Cherry",
            "translate naturally",
            RealtimeAudioMode::ServerVad,
            "en-US",
            "zh-Hans",
            OmniOutputMode::TextOnly,
        );

        assert_eq!(
            session
                .pointer("/session/input_audio_transcription/language")
                .and_then(Value::as_str),
            Some("en")
        );
        assert_eq!(
            session
                .pointer("/session/translation/language")
                .and_then(Value::as_str),
            Some("zh")
        );
    }

    #[test]
    fn livetranslate_language_contract_defaults_auto_source_and_rejects_unknown_codes() {
        let authority = crate::audio::bailian_protocol::livetranslate_test_authority();
        assert_eq!(
            resolve_livetranslate_language(
                &authority,
                "auto",
                "en",
            ),
            Ok("en".to_string())
        );
        assert!(resolve_livetranslate_language(
            &authority,
            "xx-Unknown",
            "en",
        )
        .is_err());
    }

    #[test]
    fn livetranslate_audio_output_falls_back_to_text_for_unsupported_target() {
        let authority = crate::audio::bailian_protocol::livetranslate_test_authority();
        assert_eq!(
            resolve_livetranslate_output_mode(
                &authority,
                "sw",
                OmniOutputMode::TextAndAudio,
            ),
            Ok(OmniOutputMode::TextOnly)
        );
    }

    #[test]
    fn session_created_or_updated_releases_audio_for_provider_variants() {
        assert!(is_session_ready_event("session.created"));
        assert!(is_session_ready_event("session.updated"));
    }

    #[test]
    fn unsupported_voice_error_is_classified() {
        assert!(session_errors::is_unsupported_voice_error(
            "COMMON_ERROR",
            "<400> InternalError.Algo.InvalidParameter: Voice 'Cherry' is not supported."
        ));
        assert!(session_errors::is_unsupported_voice_error(
            "InternalError.Algo.InvalidParameter",
            "bad request"
        ));
        assert!(!session_errors::is_unsupported_voice_error(
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
        assert_eq!(
            OmniOutputMode::from_speech_config(&speech),
            OmniOutputMode::TextAndAudio
        );
    }

    #[test]
    fn omni_output_mode_is_text_only_without_an_active_native_sink() {
        let speech = OmniSpeechConfig::from_config(&json!({
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": false,
                "virtualMicOutputEnabled": false
            }
        }));

        assert!(speech.enabled);
        assert!(!speech.any_output());
        assert_eq!(
            OmniOutputMode::from_speech_config(&speech),
            OmniOutputMode::TextOnly
        );
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
    fn omni_speech_config_routes_process_exclusion_audio_to_bridge() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "process-exclusion",
                "outputSpeechEnabled": true
            },
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": true
            }
        });

        let speech = OmniSpeechConfig::from_config(&config);
        let route = super::super::speech::SpeechOutputRoutePlan::for_configured_route(
            "inbound",
            speech.local_playback_enabled,
            speech.virtual_mic_output_enabled,
            speech.bridge_playback_enabled,
        );

        assert!(speech.any_output());
        assert!(!route.play_to_speaker);
        assert!(!route.write_to_virtual_mic);
        assert!(route.write_to_bridge_playback);
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
        assert!(speech.echo_guard_enabled());
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

mod protocol;
use self::response_lifecycle::{
    ResponseDeadlineBudget, ResponseLifecycle, ResponseStallAction,
};
use self::response_ledger::ResponseLedger;

pub(crate) use self::protocol::{
    build_dashscope_audio_append, build_dashscope_input_audio_commit,
    build_dashscope_response_create_for_protocol, build_dashscope_session_update,
    build_dashscope_text_item,
    apply_watch_release_livetranslate_corpus,
    build_omni_session_update_for_provider_with_output_mode, OmniOutputMode, OmniSpeechConfig,
    native_response_id_from_event,
    resolve_livetranslate_language, resolve_livetranslate_output_mode,
};
use self::translated_pcm_authority::TranslatedPcmAuthority;
use self::protocol::{
    check_vad_warning, elapsed_ms_since,
    ensure_transcription_cue_id, handle_response_done, handle_session_ready_event,
    manual_turn_response_stream_active,
    next_omni_cue_id, record_native_playback_stale,
    reset_manual_turn_input_state, reset_omni_turn_state,
    resolve_completed_transcription, resolve_native_response_source_text,
    response_stream_owns_current_cue,
    extract_response_done_text,
    set_socket_read_timeout, set_socket_write_timeout, start_omni_playback,
    try_reconnect, write_live_source_to_cue, write_native_output_preview_to_cue,
    update_native_response_cue_source,
    OmniEventDiagnostics, OmniPlaybackCommand, OmniPlaybackEnqueueOutcome,
    OmniPlaybackOverflowReason, OmniPlaybackQueue, OmniPlaybackWorker,
};
#[cfg(test)]
use self::protocol::{write_native_output_final_to_cue, write_native_translation_to_cue};
#[cfg(test)]
use protocol::{build_omni_session_update, build_omni_session_update_with_output_mode};
#[cfg(test)]
mod native_translation_tests {
    use super::protocol::write_committed_native_translation_to_cue;
    use super::*;

    #[test]
    fn generated_omni_cue_ids_are_unique_without_waiting_for_the_clock() {
        let first = next_omni_cue_id("inbound");
        let second = next_omni_cue_id("inbound");

        assert_ne!(first, second);
        let first_tick = first
            .rsplit('-')
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .expect("numeric first cue suffix");
        let second_tick = second
            .rsplit('-')
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .expect("numeric second cue suffix");
        assert!(second_tick > first_tick);
    }

    #[test]
    fn native_omni_deltas_share_one_uncommitted_live_cue() {
        let store = AudioStateStore::new();
        let mut current_cue_id = None;

        let first_id = write_live_source_to_cue(
            &store,
            "inbound",
            &mut current_cue_id,
            "With or",
            false,
        );
        let second_id = write_live_source_to_cue(
            &store,
            "inbound",
            &mut current_cue_id,
            "With or without you",
            false,
        );
        let preview_id = write_native_output_preview_to_cue(
            &store,
            "inbound",
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
    fn qwen_audio_watch_vad_rejects_playback_residual_and_splits_at_short_pauses() {
        let session = build_omni_session_update(
            "qwen-audio-3.0-realtime-plus",
            "longanqian",
            "translate naturally",
            RealtimeAudioMode::ServerVad,
            "zh-CN",
        );

        assert_eq!(
            session
                .pointer("/session/turn_detection/threshold")
                .and_then(Value::as_f64),
            Some(0.5)
        );
        assert_eq!(
            session
                .pointer("/session/turn_detection/silence_duration_ms")
                .and_then(Value::as_u64),
            Some(400)
        );
    }

    #[test]
    fn qwen35_omni_semantic_vad_splits_continuous_watch_audio_at_fixture_pauses() {
        let session = build_omni_session_update(
            "qwen3.5-omni-plus-realtime",
            "longanqian",
            "translate naturally",
            RealtimeAudioMode::SemanticVad,
            "zh-CN",
        );

        assert_eq!(
            session
                .pointer("/session/turn_detection/type")
                .and_then(Value::as_str),
            Some("semantic_vad")
        );
        assert_eq!(
            session
                .pointer("/session/turn_detection/threshold")
                .and_then(Value::as_f64),
            Some(0.5)
        );
        assert_eq!(
            session
                .pointer("/session/turn_detection/silence_duration_ms")
                .and_then(Value::as_u64),
            Some(400)
        );
    }

    #[test]
    fn qwen35_release_models_split_continuous_watch_audio_at_fixture_pauses() {
        for model in ["qwen3.5-omni-flash-realtime", "qwen3.5-livetranslate-flash-realtime"] {
            for (audio_mode, expected_type) in [
                (RealtimeAudioMode::ServerVad, "server_vad"),
                (RealtimeAudioMode::SemanticVad, "semantic_vad"),
            ] {
                let session = build_omni_session_update(
                    model,
                    "longanqian",
                    "translate naturally",
                    audio_mode,
                    "zh-CN",
                );
                assert_eq!(
                    session
                        .pointer("/session/turn_detection/type")
                        .and_then(Value::as_str),
                    Some(expected_type),
                    "{model} {audio_mode:?}",
                );
                assert_eq!(
                    session
                        .pointer("/session/turn_detection/silence_duration_ms")
                        .and_then(Value::as_u64),
                    Some(400),
                    "{model} {audio_mode:?}",
                );
            }
        }
    }

    #[test]
    fn empty_completed_transcription_only_reuses_a_correlated_delta() {
        let empty_final = resolve_completed_transcription(
            "Oh, my dilemma.",
            "",
            false,
        );
        assert_eq!(empty_final.display_text, "Oh, my dilemma.");
        assert_eq!(empty_final.response_gate_text, "");
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-Crf"),
                Some("item-Crf"),
                Some(&empty_final.response_gate_text),
            ),
            Some(ManualResponseDecision::SkipEmpty),
        );

        let correlated_empty_final = resolve_completed_transcription(
            "A valid same-item delta",
            "",
            true,
        );
        assert_eq!(
            correlated_empty_final.response_gate_text,
            "A valid same-item delta",
        );

        let non_empty_final =
            resolve_completed_transcription("older hypothesis", "final transcript", false);
        assert_eq!(non_empty_final.display_text, "final transcript");
        assert_eq!(non_empty_final.response_gate_text, "final transcript");
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

        assert!(!cue.committed, "translation final must not synthesize a source final");
        assert!(cue.translation_committed);
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
    fn native_output_preview_promotes_complete_sentences_and_keeps_one_live_tail() {
        let store = AudioStateStore::new();
        let mut current_cue_id = None;

        let cue_id = write_native_output_preview_to_cue(
            &store,
            "inbound",
            &mut current_cue_id,
            "First source. Second source is still live",
            "第一句。第二句仍在输出",
        );

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == cue_id)
            .expect("native output preview cue");
        assert_eq!(cue.display_segments.len(), 2);
        assert!(!cue.display_segments[0].pending);
        assert!(cue.display_segments[1].pending);
        assert_eq!(
            cue.display_segments.iter().filter(|segment| segment.pending).count(),
            1
        );

        write_native_output_final_to_cue(
            &store,
            "inbound",
            &mut current_cue_id,
            "First source. Second source is complete.",
            "第一句。第二句完成。",
        );
        let finalized = store.snapshot();
        let cue = finalized
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == cue_id)
            .expect("finalized native output cue");
        assert!(cue.display_segments.iter().all(|segment| !segment.pending));
    }

    #[test]
    fn native_output_preview_force_wraps_long_text_with_only_last_chunk_live() {
        let store = AudioStateStore::new();
        let mut current_cue_id = None;
        let long_translation = "这是一个没有句号但会持续快速输出并且长度足以被字幕显示规则切成多个可读行的实时翻译片段";

        let cue_id = write_native_output_preview_to_cue(
            &store,
            "inbound",
            &mut current_cue_id,
            "This is a long source hypothesis without terminal punctuation that keeps growing quickly across the overlay.",
            long_translation,
        );

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == cue_id)
            .expect("wrapped native output cue");
        assert!(cue.display_segments.len() > 1);
        assert_eq!(
            cue.display_segments.iter().filter(|segment| segment.pending).count(),
            1
        );
        assert!(cue.display_segments.last().is_some_and(|segment| segment.pending));
    }

    #[test]
    fn native_output_preview_marks_mismatched_source_and_translation_tails() {
        let store = AudioStateStore::new();
        let mut current_cue_id = None;

        let cue_id = write_native_output_preview_to_cue(
            &store,
            "inbound",
            &mut current_cue_id,
            "source one\nsource two\nsource three\nsource four",
            "译文一\n译文二\n译文三",
        );

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == cue_id)
            .expect("mismatched native output preview cue");
        assert_eq!(cue.display_segments.len(), 4);
        assert_eq!(cue.display_segments[2].translated_text, "译文三");
        assert!(cue.display_segments[2].pending);
        assert_eq!(cue.display_segments[3].source_text, "source four");
        assert!(cue.display_segments[3].pending);
    }

    #[test]
    fn committed_partial_native_translation_never_pairs_unrelated_rows() {
        let store = AudioStateStore::new();
        // Regression: watch-mode turn where the realtime model only translated
        // the tail sentences of the audio window. Index pairing used to put the
        // translation under the wrong source sentences and leave the remaining
        // committed rows rendered as "翻译失败" forever.
        let source = "I want to see you send text with your brain. Okay. His hands are paralyzed, but we're going to film him so you can see they're not moving.";
        let translated = "他的手瘫痪了，但我们正在拍摄，所以你能看到它们没有动。";

        write_committed_native_translation_to_cue(&store, "omni-cue-partial", source, translated);

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-partial")
            .expect("partial native translation cue");

        assert!(!cue.committed, "translation final must not synthesize a source final");
        assert!(cue.translation_committed);
        assert_eq!(
            cue.translated_text.replace('\n', ""),
            translated.replace('\n', "")
        );
        // No row may pair a source sentence with a translation of a different
        // sentence: every row carries either source text or translated text.
        assert!(cue
            .display_segments
            .iter()
            .all(|segment| segment.source_text.is_empty() || segment.translated_text.is_empty()));
        // Source rows all come first, translation rows follow as one block.
        let first_translated = cue
            .display_segments
            .iter()
            .position(|segment| !segment.translated_text.is_empty())
            .expect("translation rows present");
        assert!(first_translated > 0);
        assert!(cue.display_segments[..first_translated]
            .iter()
            .all(|segment| !segment.source_text.is_empty()));
        assert!(cue.display_segments[first_translated..]
            .iter()
            .all(|segment| segment.source_text.is_empty()));
        assert!(cue.display_segments.iter().all(|segment| !segment.pending));
    }

    #[test]
    fn committed_native_translation_keeps_index_pairing_when_lines_align() {
        let store = AudioStateStore::new();

        write_committed_native_translation_to_cue(
            &store,
            "omni-cue-aligned",
            "First source. Second source.",
            "第一句。第二句。",
        );

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-aligned")
            .expect("aligned native translation cue");

        assert!(!cue.committed, "translation final must not synthesize a source final");
        assert!(cue.translation_committed);
        assert_eq!(cue.display_segments.len(), 2);
        assert_eq!(cue.display_segments[0].source_text, "First source.");
        assert_eq!(cue.display_segments[0].translated_text, "第一句。");
        assert_eq!(cue.display_segments[1].source_text, "Second source.");
        assert_eq!(cue.display_segments[1].translated_text, "第二句。");
    }

    #[test]
    fn committing_a_native_cue_clears_every_pending_display_segment() {
        let store = AudioStateStore::new();

        write_native_translation_to_cue(
            &store,
            "omni-cue-commit",
            "source still live",
            "译文仍在输出",
            false,
            true,
        );
        store.commit_subtitle_cue("omni-cue-commit");

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-commit")
            .expect("committed native cue");
        assert!(cue.committed);
        assert!(cue.display_segments.iter().all(|segment| !segment.pending));
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
