use std::net::TcpStream;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::Manager;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message};

use super::state::AudioStateStore;
use crate::bridge::ipc::write_virtual_mic_frame;
use crate::diagnostics::events::append_diagnostics_log;
use crate::diagnostics::model_trace::{ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway;

const OMNI_RECONNECT_MAX_RETRIES: usize = 5;
const OMNI_INITIAL_CONNECT_RETRIES: usize = 3;
const OMNI_WRITE_TIMEOUT_SECS: u64 = 10;
const OMNI_READ_TIMEOUT_MS: u64 = 200;
const OMNI_VAD_WARNING_INTERVAL_SECS: u64 = 30;
const TRANSCRIPTION_COMPLETED_TIMEOUT_MS: u64 = 30_000;
const OMNI_OUTPUT_SAMPLE_RATE_HZ: u32 = 24_000;

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

    #[test]
    fn session_update_omits_empty_voice() {
        let session = build_omni_session_update(
            "qwen3.5-omni-plus-realtime",
            "",
            "translate naturally",
            false,
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
                .pointer("/session/turn_detection/type")
                .and_then(Value::as_str),
            Some("semantic_vad")
        );
    }

    #[test]
    fn initial_connect_backoff_is_short_and_bounded() {
        assert_eq!(initial_connect_backoff(1), Duration::from_millis(250));
        assert_eq!(initial_connect_backoff(2), Duration::from_millis(500));
        assert_eq!(initial_connect_backoff(3), Duration::from_millis(1_000));
    }

    #[test]
    fn session_update_keeps_non_empty_voice() {
        let session = build_omni_session_update(
            "qwen3.5-omni-plus-realtime",
            "Tina",
            "translate naturally",
            true,
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
            false,
            "zh-CN",
        );

        assert_eq!(
            session
                .pointer("/session/translation/language")
                .and_then(Value::as_str),
            Some("zh-CN")
        );
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
            "[Omni] 正在重新连接实时翻译服务 (第 {}/{})...",
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

fn is_livetranslate_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("livetranslate")
}

fn build_omni_session_update(
    model: &str,
    voice: &str,
    instructions: &str,
    vad_bypass: bool,
    target_language: &str,
) -> Value {
    let turn_detection = if vad_bypass {
        Value::Null
    } else {
        json!({
          "type": "semantic_vad",
          "threshold": 0.5,
          "silence_duration_ms": 800
        })
    };
    let mut session_cfg = json!({
      "type": "session.update",
      "session": {
        "modalities": ["text", "audio"],
        "instructions": instructions,
        "input_audio_format": "pcm",
        "sample_rate": 16000,
        "output_audio_format": "pcm",
        "turn_detection": turn_detection
      }
    });
    let trimmed_voice = voice.trim();
    if !trimmed_voice.is_empty() {
        session_cfg["session"]["voice"] = json!(trimmed_voice);
    }
    if is_livetranslate_model(model) {
        let trimmed_target = target_language.trim();
        if !trimmed_target.is_empty() {
            session_cfg["session"]["translation"] = json!({
              "language": trimmed_target
            });
        }
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
        Self {
            enabled: speech_enabled || device_output_enabled,
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
                        let _ = append_diagnostics_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[AUDIO] playback request received: cue_id={cue_id} samples={} sample_rate_hz={sample_rate_hz} duration_ms={duration_ms} enabled={} local_playback={} virtual_mic={}",
                                samples.len(),
                                cfg.enabled,
                                cfg.local_playback_enabled,
                                cfg.virtual_mic_output_enabled
                            ),
                            None,
                            None,
                            None,
                        );
                        if !cfg.any_output() {
                            let _ = append_diagnostics_log(
                                &app,
                                "omni",
                                "warning",
                                format!(
                                    "[AUDIO] speech output disabled, skipping {} samples for cue_id={cue_id}; enabled={} local_playback={} virtual_mic={}",
                                    samples.len(),
                                    cfg.enabled,
                                    cfg.local_playback_enabled,
                                    cfg.virtual_mic_output_enabled
                                ),
                                None,
                                None,
                                None,
                            );
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
                                    let _ = append_diagnostics_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[AUDIO] speaker playback completed: cue_id={cue_id} frames={frames} sample_rate_hz={sample_rate_hz}"
                                        ),
                                        None,
                                        None,
                                        None,
                                    );
                                    frames
                                }
                                Err(error) => {
                                    let _ = append_diagnostics_log(
                                        &app,
                                        "omni",
                                        "error",
                                        format!(
                                            "[AUDIO] speaker playback failed: cue_id={cue_id} error={error}"
                                        ),
                                        None,
                                        None,
                                        None,
                                    );
                                    0
                                }
                            }
                        } else {
                            0
                        };

                        let vmic_frames = if output_route.write_to_virtual_mic {
                            let req_id = format!("omni-play-{}", unix_ms());
                            match write_virtual_mic_frame(
                                &app,
                                &cue_id,
                                &req_id,
                                &samples,
                                sample_rate_hz,
                                1,
                            )
                            {
                                Ok(frames) => {
                                    let _ = append_diagnostics_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[AUDIO] virtual mic write completed: cue_id={cue_id} request_id={req_id} frames={frames} sample_rate_hz={sample_rate_hz}"
                                        ),
                                        None,
                                        None,
                                        None,
                                    );
                                    frames
                                }
                                Err(error) => {
                                    let _ = append_diagnostics_log(
                                        &app,
                                        "omni",
                                        "error",
                                        format!(
                                            "[AUDIO] virtual mic write failed: cue_id={cue_id} request_id={req_id} error={error}"
                                        ),
                                        None,
                                        None,
                                        None,
                                    );
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
                        let _ = append_diagnostics_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[AUDIO] 播放完成: cue_id={cue_id} speaker={speaker_frames} frames, vmic={vmic_frames} frames"
                            ),
                            None,
                            None,
                            None,
                        );
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
    provider: ProviderDraftInput,
    voice: String,
    instructions: String,
    vad_bypass: bool,
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
) -> Result<(mpsc::Sender<Vec<u8>>, OmniHandle), String> {
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    store.set_stt_connected(false, 0);
    let _ = append_diagnostics_log(
        &app,
        "omni",
        "info",
        "正在启动 Omni 实时翻译...",
        Some(format!("model={} voice={}", provider.model, voice)),
        None,
        None,
    );

    let app_handle = app.clone();
    let model = provider.model.clone();
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
            if let Err(error) = run_omni_worker(
                app_handle.clone(),
                &audio_state,
                provider,
                voice,
                instructions,
                vad_bypass,
                target_language,
                subtitle_translate_active,
                speech_config,
                trace,
                audio_rx,
                stop_rx,
            ) {
                audio_state.set_stt_connected(false, 0);
                let _ = append_diagnostics_log(
                    &app_handle,
                    "omni",
                    "error",
                    format!("Omni 实时翻译出错: {error}"),
                    Some(format!("model={model}")),
                    None,
                    None,
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| format!("无法启动 Omni 线程: {error}"))?;

    Ok((
        audio_tx,
        OmniHandle {
            stop_tx,
            join_handle,
        },
    ))
}

fn run_omni_worker(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    voice: String,
    instructions: String,
    vad_bypass: bool,
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
          "vadBypass": vad_bypass,
          "targetLanguage": target_language.clone(),
          "subtitleTranslateActive": subtitle_translate_active,
        }),
    );
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 实时翻译仅支持 dashscope provider，当前为 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let ws_url = gateway::to_websocket_url(&provider.base_url, &provider.model)
        .map_err(|error| format!("无法构建 WebSocket URL: {}", error.message))?;

    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("无法创建 WebSocket 请求: {error}"))?;
    gateway::apply_ws_auth(&provider, request.headers_mut())
        .map_err(|error| format!("无法应用认证头: {}", error.message))?;

    let initial_connect_started = SystemTime::now();
    let mut initial_attempt = 0usize;
    let (mut socket, _) = loop {
        initial_attempt += 1;
        match connect(request.clone()) {
            Ok(connected) => break connected,
            Err(error) if initial_attempt <= OMNI_INITIAL_CONNECT_RETRIES => {
                let _ = append_diagnostics_log(
                    &app,
                    "omni",
                    "warning",
                    format!(
                        "[CONNECT] Omni 初次连接失败，准备重试: attempt={initial_attempt}/{} error={error}",
                        OMNI_INITIAL_CONNECT_RETRIES + 1
                    ),
                    None,
                    None,
                    None,
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
                return Err(format!("无法连接 Omni 服务: {error}"));
            }
        }
    };
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);

    store.set_stt_connected(true, 0);
    let _ = append_diagnostics_log(
        &app,
        "omni",
        "info",
        format!("[CONNECT] 已连接 Omni 服务, model={}", provider.model),
        None,
        None,
        None,
    );

    let mut active_voice = voice.clone();
    let mut voice_fallback_applied = false;
    let session_cfg = build_omni_session_update(
        &provider.model,
        &active_voice,
        &instructions,
        vad_bypass,
        &target_language,
    );
    trace_call.record_ws_send("session.update", session_cfg.clone());
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("无法发送 Omni session 配置: {error}"))?;

    let _ = append_diagnostics_log(&app, "omni", "debug",
    format!("[SESSION] 已发送 session.update: modalities=[text,audio] voice={voice} instructions_len={}", instructions.len()), None, None, None);

    if vad_bypass {
        let _ = append_diagnostics_log(
            &app,
            "omni",
            "info",
            "[VAD] 当前模式: manual (VAD bypass 已启用，每10秒自动 commit)",
            None,
            None,
            None,
        );
    } else {
        let _ = append_diagnostics_log(
            &app,
            "omni",
            "info",
            "[VAD] turn_detection 配置: type=semantic_vad threshold=0.5 silence_duration_ms=800",
            None,
            None,
            None,
        );
    }

    let mut current_cue_id: Option<String> = None;
    let mut pending_source_text = String::new();
    let mut pending_translated_text = String::new();
    let mut buffer_size: u64 = 0;
    let mut reconnect_count = 0usize;
    let mut chunk_count: u64 = 0;
    let mut last_vad_event_time = SystemTime::now();
    let mut vad_event_count: u64 = 0;
    let mut last_commit_time = SystemTime::now();
    let mut st_skip_logged = false;
    let mut transcription_completed_flag = false;
    let mut transcription_completed_at: Option<SystemTime> = None;
    let mut last_waiting_log_chunk_count: u64 = 0;
    let mut pending_audio_delta_count: u64 = 0;
    let mut pending_audio_delta_base64_bytes: u64 = 0;
    let mut pending_audio_response_id: Option<String> = None;

    let (playback_tx, playback_join) = start_omni_playback(app.clone(), speech_config);
    let mut pending_audio_buffer: Vec<i16> = Vec::new();

    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = socket.close(None);
            store.set_stt_connected(false, buffer_size);
            let _ = append_diagnostics_log(
                &app,
                "omni",
                "info",
                format!(
                    "[STOP] Omni worker 已停止, 共发送 {} 个音频块, {} 字节",
                    chunk_count, buffer_size
                ),
                None,
                None,
                None,
            );
            if let Ok(elapsed) = last_vad_event_time.elapsed() {
                if elapsed.as_secs() >= OMNI_VAD_WARNING_INTERVAL_SECS && chunk_count > 0 {
                    let _ = append_diagnostics_log(&app, "omni", "warning",
            format!("[VAD] 尚无 VAD 事件（已等待 {}s, 已发送 {} 块音频, {} 字节, VAD 事件计数={})",
              elapsed.as_secs(), chunk_count, buffer_size, vad_event_count),
            None, None, None);
                }
            }
            let _ = playback_tx.send(OmniPlaybackCommand::Stop);
            let _ = playback_join.join();
            emit_audio_snapshot(&app, store)?;
            break;
        }

        let mut chunks_sent_this_tick = 0usize;
        while let Ok(raw_chunk) = audio_rx.try_recv() {
            let asr_chunk = resample_48k_stereo_to_16k_mono(&raw_chunk);
            if asr_chunk.is_empty() {
                let _ = append_diagnostics_log(
                    &app,
                    "omni",
                    "warning",
                    "[TRACE] resync 采样空帧被丢弃",
                    None,
                    None,
                    None,
                );
                continue;
            }
            buffer_size = buffer_size.wrapping_add(raw_chunk.len() as u64);
            chunk_count += 1;
            chunks_sent_this_tick += 1;

            if chunk_count == 1 {
                let _ = append_diagnostics_log(
                    &app,
                    "omni",
                    "info",
                    format!(
                        "[AUDIO] 首个音频块已发送 ({} samples @ 16kHz)",
                        asr_chunk.len()
                    ),
                    None,
                    None,
                    None,
                );
            }
            if chunk_count % 100 == 0 {
                let _ = append_diagnostics_log(
                    &app,
                    "omni",
                    "debug",
                    format!(
                        "[AUDIO] 已发送 {} 个音频块 ({} 字节)",
                        chunk_count, buffer_size
                    ),
                    None,
                    None,
                    None,
                );
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
                }),
            );
            if let Err(error) = socket.send(Message::Text(append.to_string().into())) {
                let _ = append_diagnostics_log(
                    &app,
                    "omni",
                    "warning",
                    format!("[AUDIO] 发送失败: {error}"),
                    None,
                    None,
                    None,
                );
                if reconnect_count < OMNI_RECONNECT_MAX_RETRIES {
                    reconnect_count += 1;
                    pending_audio_buffer.clear();
                    notify_reconnecting(store, reconnect_count);
                    thread::sleep(backoff_delay(reconnect_count));
                    socket = reconnect_socket(
                        app.clone(),
                        &provider,
                        &active_voice,
                        &instructions,
                        vad_bypass,
                        &target_language,
                    )?;
                    let retry_b64 = base64_encode_i16(&asr_chunk);
                    let retry_append = json!({
                      "type": "input_audio_buffer.append",
                      "audio": retry_b64
                    });
                    if let Err(e) = socket.send(Message::Text(retry_append.to_string().into())) {
                        store.set_stt_connected(false, buffer_size);
                        return Err(format!("重连后发送音频数据仍然失败: {e}"));
                    }
                    store.set_stt_connected(true, buffer_size);
                    continue;
                }
                store.set_stt_connected(false, buffer_size);
                return Err(format!("Omni WebSocket 发送失败且重连次数已用完: {error}"));
            }
            store.set_stt_connected(true, buffer_size);

            if chunks_sent_this_tick > 1 {
                thread::sleep(Duration::from_millis(18));
            }
        }

        if chunk_count > 0
            && chunks_sent_this_tick == 0
            && chunk_count % 500 == 0
            && last_waiting_log_chunk_count != chunk_count
        {
            last_waiting_log_chunk_count = chunk_count;
            let _ = append_diagnostics_log(
                &app,
                "omni",
                "debug",
                format!("[AUDIO] 等待音频数据... (已发送 {} 块)", chunk_count),
                None,
                None,
                None,
            );
        }

        if vad_bypass {
            if let Ok(elapsed) = last_commit_time.elapsed() {
                if elapsed.as_secs() >= 10 && chunk_count > 0 {
                    let commit_msg = json!({ "type": "input_audio_buffer.commit" });
                    trace_call.record_ws_send("input_audio_buffer.commit", commit_msg.clone());
                    if let Err(error) = socket.send(Message::Text(commit_msg.to_string().into())) {
                        let _ = append_diagnostics_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[VAD] bypass commit 发送失败: {error}"),
                            None,
                            None,
                            None,
                        );
                    } else {
                        let _ = append_diagnostics_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[VAD] bypass: 已发送 commit (距上次 {:.0}s, 已发送 {} 块音频)",
                                elapsed.as_secs_f64(),
                                chunk_count
                            ),
                            None,
                            None,
                            None,
                        );
                        last_commit_time = SystemTime::now();
                    }
                    let create_msg = json!({ "type": "response.create" });
                    trace_call.record_ws_send("response.create", create_msg.clone());
                    if let Err(error) = socket.send(Message::Text(create_msg.to_string().into())) {
                        let _ = append_diagnostics_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[VAD] bypass response.create 发送失败: {error}"),
                            None,
                            None,
                            None,
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
                    let _ = append_diagnostics_log(&app, "omni", "warning",
            format!("[STATE] transcription_completed_flag 超时复位（{elapsed_ms}ms 内未收到 response.done 或 speech_started），允许新转录事件通过"),
            None, None, None);
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
                            "session.created" => {
                                let session_id = evt["session"]["id"].as_str().unwrap_or("?");
                                let _ = append_diagnostics_log(
                                    &app,
                                    "omni",
                                    "info",
                                    format!("[EVENT] session.created: id={session_id}"),
                                    None,
                                    None,
                                    None,
                                );
                            }
                            "session.updated" => {
                                let _ = append_diagnostics_log(
                                    &app,
                                    "omni",
                                    "debug",
                                    "[EVENT] session.updated: session 配置已确认",
                                    None,
                                    None,
                                    None,
                                );
                            }
                            "input_audio_buffer.speech_started" => {
                                last_vad_event_time = SystemTime::now();
                                vad_event_count += 1;
                                let cue_id = format!("omni-cue-{}", unix_ms());
                                store.update_or_push_stt_cue(&cue_id, "", false);
                                current_cue_id = Some(cue_id.clone());
                                pending_source_text.clear();
                                pending_translated_text.clear();
                                pending_audio_buffer.clear();
                                transcription_completed_flag = false;
                                transcription_completed_at = None;
                                let _ = append_diagnostics_log(&app, "omni", "info",
                  format!("[VAD] speech_started received (VAD 事件计数={vad_event_count}) → cue_id={cue_id}, 源文本/翻译文本已清空"), None, None, None);
                            }
                            "conversation.item.input_audio_transcription.delta" => {
                                if transcription_completed_flag {
                                    let _ = append_diagnostics_log(&app, "omni", "debug",
                    "[EVENT] transcription.delta 跳过（transcription.completed 之后）", None, None, None);
                                    continue;
                                }
                                last_vad_event_time = SystemTime::now();
                                vad_event_count += 1;
                                let text_val = evt["text"].as_str().unwrap_or("");
                                let stash = evt["stash"].as_str().unwrap_or("");
                                pending_source_text = format!("{text_val}{stash}");
                                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                if let Some(ref id) = current_cue_id {
                                    store.update_or_push_stt_cue(id, &pending_source_text, false);
                                }
                                let _ = append_diagnostics_log(&app, "omni", "trace",
                  format!("[EVENT] transcription.delta → cue_id={cue_id_str} text=\"{text_val}\" stash=\"{stash}\" pending=\"{pending_source_text}\""),
                  None, None, None);
                            }
                            "conversation.item.input_audio_transcription.completed" => {
                                last_vad_event_time = SystemTime::now();
                                vad_event_count += 1;
                                let source = evt["transcript"].as_str().unwrap_or("");
                                pending_source_text = source.to_string();
                                transcription_completed_flag = true;
                                transcription_completed_at = Some(SystemTime::now());
                                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                if let Some(ref id) = current_cue_id {
                                    store.update_or_push_stt_cue(id, &pending_source_text, false);
                                }
                                let _ = append_diagnostics_log(&app, "omni", "info",
                  format!("[EVENT] transcription.completed → cue_id={cue_id_str} source=\"{source}\""),
                  None, None, None);
                            }
                            "response.audio_transcript.delta"
                            | "response.audio_transcript.text" => {
                                let delta = evt["delta"]
                                    .as_str()
                                    .or_else(|| evt["text"].as_str())
                                    .unwrap_or("");
                                pending_translated_text.push_str(delta);
                                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                if !subtitle_translate_active {
                                    if let Some(ref id) = current_cue_id {
                                        store.update_subtitle_cue_translation(
                                            id,
                                            pending_translated_text.clone(),
                                            false,
                                        );
                                    }
                                } else if !st_skip_logged {
                                    st_skip_logged = true;
                                    let _ = append_diagnostics_log(&app, "omni", "info",
                    format!("[TRANS] subtitle_translate_active=true, Omni 跳过写入翻译文本（转由 subtitle_translate worker 处理）, cue_id={cue_id_str}"),
                    None, None, None);
                                }
                                let _ = append_diagnostics_log(&app, "omni", "trace",
                  format!("[EVENT] audio_transcript.delta → cue_id={cue_id_str} delta=\"{delta}\" total_len={}",
                    pending_translated_text.len()),
                  None, None, None);
                            }
                            "response.audio_transcript.done" => {
                                let transcript = evt["transcript"].as_str().unwrap_or("");
                                if !transcript.is_empty() {
                                    pending_translated_text = transcript.to_string();
                                }
                                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                                let _ = append_diagnostics_log(&app, "omni", "debug",
                  format!("[EVENT] audio_transcript.done → cue_id={cue_id_str} transcript=\"{}\"",
                    pending_translated_text),
                  None, None, None);
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
                                                || pending_audio_delta_count % 25 == 0
                                            {
                                                let response_id = pending_audio_response_id
                                                    .as_deref()
                                                    .unwrap_or("(none)");
                                                let _ = append_diagnostics_log(
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
                                                    None,
                                                    None,
                                                    None,
                                                );
                                            }
                                        }
                                        Err(e) => {
                                            let _ = append_diagnostics_log(
                                                &app,
                                                "omni",
                                                "warning",
                                                format!("[AUDIO] base64 decode failed: {e}"),
                                                None,
                                                None,
                                                None,
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
                                    let _ = append_diagnostics_log(
                                        &app,
                                        "omni",
                                        "info",
                                        format!(
                                            "[AUDIO] native audio.done: response_id={response_id} deltas={} base64_bytes={} samples={sample_count} sample_rate_hz={OMNI_OUTPUT_SAMPLE_RATE_HZ} duration_ms={duration_ms}; sent_to_playback_thread cue_id={cue_id}"
                                            ,
                                            pending_audio_delta_count,
                                            pending_audio_delta_base64_bytes
                                        ),
                                        None,
                                        None,
                                        None,
                                    );
                                } else {
                                    let response_id =
                                        pending_audio_response_id.as_deref().unwrap_or("(none)");
                                    let _ = append_diagnostics_log(
                                        &app,
                                        "omni",
                                        "warning",
                                        format!(
                                            "[AUDIO] native audio.done received with empty buffer: response_id={response_id} deltas={} base64_bytes={}",
                                            pending_audio_delta_count,
                                            pending_audio_delta_base64_bytes
                                        ),
                                        None,
                                        None,
                                        None,
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
                                let _ = append_diagnostics_log(&app, "omni", "info",
                  format!("[VAD] speech_stopped received (VAD 事件计数={vad_event_count})"), None, None, None);
                            }
                            "response.done" => {
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
                                if subtitle_translate_active {
                                    if !pending_source_text.is_empty() {
                                        let src_preview = if pending_source_text.len() > 200 {
                                            format!("{}...", &pending_source_text[..200])
                                        } else {
                                            pending_source_text.clone()
                                        };
                                        store.update_or_push_stt_cue(
                                            &cue_id,
                                            &pending_source_text,
                                            false,
                                        );
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
                                        let _ = append_diagnostics_log(&app, "omni", "info",
                      format!("[EVENT] response.done → ST_SOURCE_ONLY{st_flag} cue_id={cue_id} src=\"{src_preview}\" src_len={source_len} cue_state=[{cue_state}] (翻译留给 subtitle_translate worker)"),
                      None, None, None);
                                    } else {
                                        let _ = append_diagnostics_log(&app, "omni", "warning",
                      format!("[EVENT] response.done → SKIP{st_flag} cue_id={cue_id} 源文本为空！"),
                      None, None, None);
                                    }
                                } else if !pending_translated_text.is_empty() {
                                    let source = if pending_source_text.is_empty() {
                                        pending_translated_text.clone()
                                    } else {
                                        pending_source_text.clone()
                                    };
                                    store.update_or_push_stt_cue(&cue_id, &source, true);
                                    store.update_subtitle_cue_translation(
                                        &cue_id,
                                        pending_translated_text.clone(),
                                        true,
                                    );
                                    let _ = append_diagnostics_log(&app, "omni", "info",
                    format!("[EVENT] response.done → COMMIT{st_flag} cue_id={cue_id} source_len={source_len} translated_len={translated_len} translated=\"{}\"",
                      pending_translated_text),
                    None, None, None);
                                } else if !pending_source_text.is_empty() {
                                    let src_preview = if pending_source_text.len() > 150 {
                                        format!("{}...", &pending_source_text[..150])
                                    } else {
                                        pending_source_text.clone()
                                    };
                                    store.update_or_push_stt_cue(
                                        &cue_id,
                                        &pending_source_text,
                                        true,
                                    );
                                    let _ = append_diagnostics_log(&app, "omni", "info",
                    format!("[EVENT] response.done → COMMIT(仅源文本, 无翻译){st_flag} cue_id={cue_id} src=\"{src_preview}\" src_len={source_len} translated_len={translated_len}"),
                    None, None, None);
                                } else {
                                    let _ = append_diagnostics_log(&app, "omni", "warning",
                    format!("[EVENT] response.done → SKIP{st_flag} cue_id={cue_id} 源文本和翻译文本均为空!"),
                    None, None, None);
                                }
                                let _ = append_diagnostics_log(&app, "omni", "debug",
                  format!("[STATE] 重置: current_cue_id=None, pending_source_text cleared, pending_translated_text cleared"),
                  None, None, None);
                                pending_source_text.clear();
                                pending_translated_text.clear();
                                current_cue_id = None;
                                transcription_completed_flag = false;
                                transcription_completed_at = None;
                            }
                            "error" => {
                                let err_code = evt["error"]["code"].as_str().unwrap_or("?");
                                let err_msg =
                                    evt["error"]["message"].as_str().unwrap_or("未知错误");
                                let _ = append_diagnostics_log(&app, "omni", "error",
                  format!("[EVENT] error: code={err_code} message=\"{err_msg}\" raw={text}"),
                  None, None, None);
                                let handled_voice_fallback =
                                    is_unsupported_voice_error(err_code, err_msg)
                                        && !voice_fallback_applied
                                        && !active_voice.trim().is_empty()
                                        && reconnect_count < OMNI_RECONNECT_MAX_RETRIES;
                                if handled_voice_fallback {
                                    let rejected_voice = active_voice.clone();
                                    voice_fallback_applied = true;
                                    active_voice.clear();
                                    reconnect_count += 1;
                                    pending_audio_buffer.clear();
                                    let _ = append_diagnostics_log(
                    &app,
                    "omni",
                    "warning",
                    format!(
                      "[VOICE] Provider rejected voice '{rejected_voice}'. Reconnecting without voice to use provider default."
                    ),
                    Some(format!("errorCode={err_code}")),
                    None,
                    None,
                  );
                                    notify_reconnecting(store, reconnect_count);
                                    socket = reconnect_socket(
                                        app.clone(),
                                        &provider,
                                        &active_voice,
                                        &instructions,
                                        vad_bypass,
                                        &target_language,
                                    )?;
                                    store.set_stt_connected(true, buffer_size);
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
                                    "[VAD] 未识别 VAD 事件"
                                } else {
                                    "[EVENT] 未识别事件"
                                };
                                let preview = if text.len() > 600 {
                                    format!("{}...({} bytes)", &text[..600], text.len())
                                } else {
                                    text.to_string()
                                };
                                let _ = append_diagnostics_log(
                                    &app,
                                    "omni",
                                    "debug",
                                    format!("{prefix}: type=\"{other}\" raw={preview}"),
                                    None,
                                    None,
                                    None,
                                );
                            }
                        }
                    } else {
                        let _ = append_diagnostics_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[EVENT] JSON 解析失败: {text}"),
                            None,
                            None,
                            None,
                        );
                    }
                }
                Message::Close(_) => {
                    let _ = append_diagnostics_log(
                        &app,
                        "omni",
                        "warning",
                        "[SOCKET] WebSocket 已关闭",
                        None,
                        None,
                        None,
                    );
                    if reconnect_count < OMNI_RECONNECT_MAX_RETRIES {
                        reconnect_count += 1;
                        pending_audio_buffer.clear();
                        notify_reconnecting(store, reconnect_count);
                        thread::sleep(backoff_delay(reconnect_count));
                        socket = reconnect_socket(
                            app.clone(),
                            &provider,
                            &active_voice,
                            &instructions,
                            vad_bypass,
                            &target_language,
                        )?;
                        store.set_stt_connected(true, buffer_size);
                        continue;
                    }
                    store.set_stt_connected(false, buffer_size);
                    return Err("Omni WebSocket 连接已关闭且重连次数已用完。".to_string());
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
                    let _ = append_diagnostics_log(
                        &app,
                        "omni",
                        "verbose",
                        format!("[SOCKET_TRACE] Read 超时（预期行为）: {err_str}"),
                        None,
                        None,
                        None,
                    );
                }

                if err_str.contains("timed out")
                    || err_str.contains("WouldBlock")
                    || err_str.contains("10060")
                {
                    if cfg!(debug_assertions) {
                        let _ = append_diagnostics_log(
                            &app,
                            "omni",
                            "verbose",
                            "[SOCKET_TRACE] 仅为 read 会话超时或非阻塞回调，忽略",
                            None,
                            None,
                            None,
                        );
                    }
                } else {
                    let _ = append_diagnostics_log(
                        &app,
                        "omni",
                        "error",
                        format!("[SOCKET_FATAL] 发生了硬致死错误!: {error}"),
                        None,
                        None,
                        None,
                    );
                    let _ = append_diagnostics_log(
                        &app,
                        "omni",
                        "warning",
                        format!("[SOCKET] 读错误: {error}"),
                        None,
                        None,
                        None,
                    );
                    if reconnect_count < OMNI_RECONNECT_MAX_RETRIES {
                        reconnect_count += 1;
                        pending_audio_buffer.clear();
                        notify_reconnecting(store, reconnect_count);
                        thread::sleep(backoff_delay(reconnect_count));
                        socket = reconnect_socket(
                            app.clone(),
                            &provider,
                            &active_voice,
                            &instructions,
                            vad_bypass,
                            &target_language,
                        )?;
                        store.set_stt_connected(true, buffer_size);
                        continue;
                    }
                    store.set_stt_connected(false, buffer_size);
                    return Err(format!("Omni WebSocket 读错误且重连次数已用完: {error}"));
                }
            }
        }

        if let Ok(elapsed) = last_vad_event_time.elapsed() {
            if elapsed.as_secs() >= OMNI_VAD_WARNING_INTERVAL_SECS && chunk_count > 0 {
                let _ = append_diagnostics_log(&app, "omni", "warning",
          format!("[VAD] 尚无 VAD 事件（已等待 {}s, 已发送 {} 块音频, {} 字节, VAD 事件计数={})",
            elapsed.as_secs(), chunk_count, buffer_size, vad_event_count),
          None, None, None);
                last_vad_event_time = SystemTime::now();
            }
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
    vad_bypass: bool,
    target_language: &str,
) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, String>
{
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 重连仅支持 dashscope provider，当前为 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let ws_url = gateway::to_websocket_url(&provider.base_url, &provider.model)
        .map_err(|error| format!("无法构建 WebSocket URL: {}", error.message))?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("无法创建 WebSocket 请求: {error}"))?;
    gateway::apply_ws_auth(provider, request.headers_mut())
        .map_err(|error| format!("无法应用认证头: {}", error.message))?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("无法重新连接 Omni 服务: {error}"))?;
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);

    let session_cfg = build_omni_session_update(
        &provider.model,
        voice,
        instructions,
        vad_bypass,
        target_language,
    );
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("无法重发 Omni session 配置: {error}"))?;

    let _ = append_diagnostics_log(
        &app,
        "omni",
        "info",
        "已重新连接 Omni 服务。",
        None,
        None,
        None,
    );
    Ok(socket)
}

fn resample_48k_stereo_to_16k_mono(input: &[u8]) -> Vec<i16> {
    let sample_count = input.len() / 4;
    if sample_count == 0 {
        return Vec::new();
    }

    let stereo_float: Vec<f32> = input
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();

    let mono_len = sample_count / 2;
    let mut mono = Vec::with_capacity(mono_len);
    for i in 0..mono_len {
        let left = stereo_float[i * 2];
        let right = stereo_float[i * 2 + 1];
        mono.push((left + right) * 0.5);
    }

    let ratio = 48_000.0 / 16_000.0;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    let mut resampled = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_idx = (i as f64 * ratio) as usize;
        if src_idx < mono.len() {
            resampled.push(mono[src_idx]);
        }
    }

    resampled
        .iter()
        .map(|sample| {
            let clamped = sample.clamp(-1.0, 1.0);
            (clamped * 32767.0) as i16
        })
        .collect()
}

fn base64_encode_i16(samples: &[i16]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();

    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

fn base64_decode_to_i16(encoded: &str) -> Result<Vec<i16>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("base64 decode error: {e}"))?;
    if bytes.len() % 2 != 0 {
        return Err("odd byte count for i16 PCM".to_string());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}

fn unix_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

fn ms_marker(value: u64) -> String {
    format!("unix-ms:{}", value)
}

fn emit_audio_snapshot(app: &AppHandle, store: &AudioStateStore) -> Result<(), String> {
    use crate::audio::engine;
    engine::emit_audio_snapshot(app, store)
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
    #[ignore = "需要 API key 和网络连接"]
    fn omni_integration_ogg_to_subtitle() {
        let mut raw = Vec::new();
        std::fs::File::open(TEST_PCM)
            .expect("找不到 test_16k_mono.pcm，请先运行 Python 脚本生成")
            .read_to_end(&mut raw)
            .expect("读取 PCM 失败");

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
        println!("共 {} 个音频块", chunks.len());

        let request = TEST_WS_URL.into_client_request().unwrap();
        let (mut socket, _) = connect(request).unwrap();
        set_socket_read_timeout(&mut socket);
        println!("[TEST] 已连接");

        let session_cfg = json!({
          "type": "session.update",
          "session": {
            "modalities": ["text", "audio"],
            "voice": "Ethan",
            "instructions": "你是一个实时翻译助手，请将听到的外语内容翻译成中文输出。",
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "output_audio_format": "pcm",
            "turn_detection": { "type": "semantic_vad", "threshold": 0.5, "silence_duration_ms": 800 }
          }
        });
        socket
            .send(Message::Text(session_cfg.to_string().into()))
            .unwrap();
        println!("[TEST] session.update 已发送 (sample_rate=16000, semantic_vad)");

        let msg = socket.read().unwrap();
        if let Message::Text(text) = &msg {
            let evt: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(
                evt["type"].as_str().unwrap(),
                "session.created",
                "session 创建失败: {text}"
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
        println!("[TEST] session.updated OK, 开始发送音频...");

        let start = Instant::now();
        for (i, chunk) in chunks.iter().enumerate() {
            let b64 = base64_encode_i16(chunk);
            let append = json!({ "type": "input_audio_buffer.append", "audio": b64 });
            socket
                .send(Message::Text(append.to_string().into()))
                .unwrap();
            if i % 200 == 0 {
                println!("[TEST] 音频 {}/{}", i + 1, chunks.len());
            }
            std::thread::sleep(std::time::Duration::from_millis(18));
        }
        println!(
            "[TEST] 全部 {} 块发送完成 ({:.1}s)",
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

        assert!(got_speech_started, "VAD 未触发 speech_started");
        assert!(
            !source.is_empty() || !translated.is_empty(),
            "未收到任何文本输出"
        );
        println!("✅ 集成测试通过！");
    }
}
