use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use wasapi::{initialize_mta, Device, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use super::diagnostics::{diag_log, diag_log_detail};
use crate::common::MapErrToString;
use crate::runtime::events::{emit_runtime_notification, emit_runtime_snapshot};
use crate::runtime::state::RuntimeStateStore;

use super::contracts::{AudioRuntimeSnapshot, SubtitleCueRuntime};
use super::events::AUDIO_RUNTIME_SNAPSHOT_EVENT;
use super::state::{AudioRouteHandle, AudioStateStore, CapturedSegmentAudio};
use super::time_utils::{ms_marker, now_unix_millis_marker, unix_ms};
use crate::bridge::contracts::BridgeTranslationFrameHeader;
use crate::bridge::state::BridgeStateStore;

mod retry;
mod samples;
mod device_catalog;
mod device_initializer;

use self::retry::{
    with_audio_init_retry, AudioInitError, RetryAction, AUDIO_INIT_BASE_DELAY_MS,
    AUDIO_INIT_MAX_RETRIES, AUDIO_MAX_DEVICE_FALLBACK, DEVICE_INIT_TIMEOUT_SECS,
};
use self::samples::{
    bytes_to_f32_stereo, calculate_chunk_db, drain_sample_chunks, f32_stereo_to_bytes,
    pcm16le_to_f32le,
};
use self::device_catalog::AudioDeviceCatalog;
use self::device_initializer::{initialize_capture_route, InitializedCaptureRoute};

const SAMPLE_RATE_HZ: usize = 48_000;
const CHANNEL_COUNT: usize = 2;
const CHUNK_FRAMES: usize = 960;
// Bluetooth headset inputs commonly keep a low, steady noise floor around
// -40 dB. Treating that as speech creates phantom segments while nobody talks.
const SPEECH_THRESHOLD_DB: f32 = -32.0;
const SILENCE_HOLD_CHUNKS: usize = 6;
const ECHO_CANCEL_DELAY_SAMPLES: usize = 9_600;
const BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS: u64 = 15;
const BRIDGE_SOURCE_PIPE_RETRY_MS: u64 = 250;
const DEVICE_FALLBACK_DELAY_MS: u64 = 500;
// Once a route reports ready (stream bound + capturing), real audio frames must
// begin flowing within this window. A muted device or an exclusive-mode conflict
// binds the stream but never delivers frames; that must surface as an
// attributable failure instead of a silent "started but zero frames" success.
const AUDIO_FLOW_HEALTH_WINDOW_SECS: u64 = 4;

/// Application-facing lifecycle boundary for a capture route.
/// The engine retains low-level device routines; callers use this supervisor
/// so route start/stop orchestration has one explicit owner.
pub(crate) struct AudioRouteSupervisor<'a> {
    app: AppHandle,
    store: &'a AudioStateStore,
}

impl<'a> AudioRouteSupervisor<'a> {
    pub(crate) fn new(app: AppHandle, store: &'a AudioStateStore) -> Self {
        Self { app, store }
    }

    pub(crate) fn start(
        &self,
        direction: &str,
        config: Value,
        stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    ) -> Result<AudioRuntimeSnapshot, String> {
        start_route(self.app.clone(), self.store, direction, config, stt_sender)
    }

    pub(crate) fn stop(&self, direction: &str) -> Result<AudioRuntimeSnapshot, String> {
        stop_route(self.app.clone(), self.store, direction)
    }
}

pub fn bootstrap_audio_runtime(
    app: &AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    let (render_devices, capture_devices) = AudioDeviceCatalog::enumerate()?;
    store.replace_devices(render_devices, capture_devices);
    let snapshot = store.snapshot();
    diag_log_detail(
        app,
        "audio",
        "info",
        "已刷新音频设备列表。",
        format!(
            "render={} capture={}",
            snapshot.render_devices.len(),
            snapshot.capture_devices.len()
        ),
    );
    emit_audio_snapshot(app, store)?;
    Ok(snapshot)
}

pub fn refresh_devices(
    app: &AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    bootstrap_audio_runtime(app, store)
}

pub fn start_route(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    config: Value,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
) -> Result<AudioRuntimeSnapshot, String> {
    stop_route(app.clone(), store, direction)?;

    let spec = RouteSpec::from_config(&config, direction)?;

    // Fast path: if an idle pre-warmed device is parked for this exact target,
    // activate it in place (the warm thread transitions itself into the shared
    // capture loop) and skip the expensive cold `initialize_capture_route`.
    let stt_sender = match store.warmer().try_activate(direction, &spec, stt_sender) {
        Ok(handle) => {
            store.insert_session(direction, handle);
            diag_log_detail(
                &app,
                "audio",
                "info",
                format!("命中预热 {} 采集设备，跳过冷启动。", direction),
                format!(
                    "routeId={} device={}",
                    spec.route_id, spec.requested_device_id
                ),
            );
            return Ok(store.snapshot());
        }
        Err(stt_sender) => stt_sender,
    };

    let effective_device_id =
        if direction == "inbound" && spec.feedback_loop_prevention == "virtual-driver" {
            spec.requested_device_id.clone()
        } else {
            let enumerator = DeviceEnumerator::new().map_err_str()?;
            let device = pick_device(&enumerator, &spec)?;
            device.get_id().map_err_str()?
        };

    let waits_for_bridge_source =
        direction == "inbound" && spec.feedback_loop_prevention == "virtual-driver";
    if waits_for_bridge_source {
        let bridge_snapshot = app.state::<BridgeStateStore>().snapshot();
        diag_log_detail(
            &app,
            "audio",
            "info",
            "Inbound route delegated Bridge readiness to the capture worker.",
            format!("pipe={} reconnectTimeoutSecs={BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS}", bridge_snapshot.pipe_path),
        );
    }
    if !waits_for_bridge_source {
        store.mark_route_started(
            direction,
            &spec.route_id,
            &spec.requested_device_id,
            &effective_device_id,
        );
    }
    diag_log_detail(
        &app,
        "audio",
        "info",
        format!("已启动 {} 音频采集。", direction),
        format!("routeId={} device={}", spec.route_id, effective_device_id),
    );
    if direction == "inbound" && stt_sender.is_none() {
        diag_log(
            &app,
            "audio",
            "warning",
            "inbound 音频采集已启动但没有 STT/Omni sender，音频将只做本地 VAD 而不进行语音识别，subtitles 不会产生任何 cue！",
        );
    }
    emit_audio_snapshot(&app, store)?;

    let (stop_tx, stop_rx) = mpsc::channel();
    let route_direction = direction.to_string();
    let app_handle = app.clone();
    let worker_spec = spec.clone();

    let init_done = Arc::new(AtomicBool::new(false));
    let init_done_for_worker = init_done.clone();
    let init_done_for_watchdog = init_done.clone();

    let join_handle = thread::Builder::new()
        .name(format!("audio-{}", direction))
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            let worker = RouteWorker {
                app: app_handle.clone(),
                direction: route_direction.clone(),
                spec: worker_spec,
                stop_rx,
                stt_sender,
                init_done: Some(init_done_for_worker),
            };
            if let Err(error) = worker.run(&audio_state) {
                let (message, error_code, recommended_action) =
                    crate::audio::omni::session_errors::split_error_markers(&error);
                notify_route_worker_error(
                    &app_handle,
                    &route_direction,
                    &message,
                    error_code.as_deref(),
                );
                audio_state.mark_route_error(
                    &route_direction,
                    message,
                    error_code,
                    recommended_action,
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err_str()?;

    {
        let watchdog_app = app.clone();
        let watchdog_dir = direction.to_string();
        thread::Builder::new()
            .name(format!("audio-watchdog-{}", direction))
            .spawn(move || {
                thread::sleep(Duration::from_secs(DEVICE_INIT_TIMEOUT_SECS));
                if !init_done_for_watchdog.load(Ordering::Relaxed) {
                    diag_log(
                        &watchdog_app,
                        "audio",
                        "warning",
                        format!(
                            "{} 音频设备初始化已超过 {} 秒，设备驱动可能无响应，建议切换音频设备后重试。",
                            watchdog_dir, DEVICE_INIT_TIMEOUT_SECS,
                        ),
                    );
                }
            })
            .ok();
    }

    store.insert_session(
        direction,
        AudioRouteHandle {
            stop_tx,
            join_handle,
        },
    );
    Ok(store.snapshot())
}

pub fn stop_route(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
) -> Result<AudioRuntimeSnapshot, String> {
    if let Some(handle) = store.take_session(direction) {
        store.mark_route_stopping(direction);
        emit_audio_snapshot(&app, store)?;
        let _ = handle.stop_tx.send(());
        let (done_tx, done_rx) = mpsc::channel();
        let join_app = app.clone();
        let join_direction = direction.to_string();
        let marked = Arc::new(AtomicBool::new(false));
        let marked_for_join = marked.clone();
        thread::Builder::new()
            .name(format!("audio-stop-join-{direction}"))
            .spawn(move || {
                let _ = handle.join_handle.join();
                let _ = done_tx.send(());
                if !marked_for_join.swap(true, Ordering::SeqCst) {
                    let audio_state = join_app.state::<AudioStateStore>();
                    if audio_state.mark_route_stopped_if_stopping(&join_direction) {
                        let _ = emit_audio_snapshot(&join_app, &audio_state);
                    }
                }
            })
            .map_err_str()?;

        match done_rx.recv_timeout(Duration::from_millis(1_500)) {
            Ok(()) => {
                if !marked.swap(true, Ordering::SeqCst) {
                    let _ = store.mark_route_stopped_if_stopping(direction);
                }
                diag_log(
                    &app,
                    "audio",
                    "info",
                    format!("已停止 {} 音频采集。", direction),
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = diag_log_detail(
                    &app,
                    "audio",
                    "warning",
                    "watch_mode.route_stop_timeout",
                    format!("direction={direction} timeoutMs=1500"),
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !marked.swap(true, Ordering::SeqCst) {
                    let _ = store.mark_route_stopped_if_stopping(direction);
                }
            }
        }
    } else {
        store.mark_route_stopped(direction);
        diag_log(
            &app,
            "audio",
            "info",
            format!("已停止 {} 音频采集。", direction),
        );
    }
    emit_audio_snapshot(&app, store)?;
    Ok(store.snapshot())
}

pub fn clear_cues(
    app: &AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    store.clear_subtitle_cues();
    diag_log(app, "audio", "info", "已清空字幕与音频缓存队列。");
    emit_audio_snapshot(app, store)?;
    Ok(store.snapshot())
}

pub fn emit_audio_snapshot<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
) -> Result<(), String> {
    app.emit(AUDIO_RUNTIME_SNAPSHOT_EVENT, store.snapshot())
        .map_err_str()?;
    if let Some(runtime_state) = app.try_state::<RuntimeStateStore>() {
        emit_runtime_snapshot(app, &runtime_state).map_err_str()?;
    }
    Ok(())
}

/// Route worker failures used to only update the audio snapshot, leaving
/// users outside the session page unaware of a dead capture chain. Push an
/// error-level runtime notification (source `audio-engine`) so the global
/// toast host can surface it; the id embeds the error code for dedupe.
fn notify_route_worker_error(
    app: &AppHandle,
    direction: &str,
    message: &str,
    error_code: Option<&str>,
) {
    let Some(runtime_state) = app.try_state::<RuntimeStateStore>() else {
        return;
    };
    let text = match error_code {
        Some(code) => format!("音频链路已中断（{direction}）: {message} [{code}]"),
        None => format!("音频链路已中断（{direction}）: {message}"),
    };
    let _ = emit_runtime_notification(
        app,
        &runtime_state,
        crate::runtime::contracts::RuntimeNotification::error(
            &format!("audio-engine-{direction}-{}", error_code.unwrap_or("worker-error")),
            "audio-engine",
            &text,
            ms_marker(unix_ms()),
        ),
    );
}

fn pick_device(enumerator: &DeviceEnumerator, spec: &RouteSpec) -> Result<Device, String> {
    let direction = spec.wasapi_direction();
    if !spec.requested_device_id.is_empty() {
        let collection = enumerator.get_device_collection(&direction).map_err_str()?;
        for device_result in &collection {
            let device = device_result.map_err_str()?;
            let device_id = device.get_id().map_err_str()?;
            if device_id == spec.requested_device_id {
                return Ok(device);
            }
            if spec.feedback_loop_prevention == "virtual-driver"
                && device
                    .get_friendlyname()
                    .map(|name| name.contains("Omni Translate Virtual Speaker"))
                    .unwrap_or(false)
            {
                return Ok(device);
            }
        }
    }

    if spec.feedback_loop_prevention == "virtual-driver" {
        return Err(
            "Omni Translate Virtual Speaker was not found. Select subtitles-only mode or temporary AEC fallback."
                .to_string(),
        );
    }

    enumerator.get_default_device(&direction).map_err_str()
}

fn collect_render_device_ids(enumerator: &DeviceEnumerator) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    let direction = Direction::Render;
    let collection = enumerator.get_device_collection(&direction).map_err_str()?;
    for device_result in &collection {
        match device_result {
            Ok(device) => {
                if let Ok(device_id) = device.get_id() {
                    ids.push(device_id);
                }
            }
            Err(_) => continue,
        }
        if ids.len() >= AUDIO_MAX_DEVICE_FALLBACK {
            break;
        }
    }
    Ok(ids)
}

fn find_device_by_id(
    enumerator: &DeviceEnumerator,
    direction: &Direction,
    target_id: &str,
) -> Option<Device> {
    let collection = enumerator.get_device_collection(direction).ok()?;
    for device_result in &collection {
        let Ok(device) = device_result else { continue };
        if let Ok(device_id) = device.get_id() {
            if device_id == target_id {
                return Some(device);
            }
        }
    }
    None
}

include!("workers.rs");
include!("warm_route.rs");
#[derive(Clone)]
pub(crate) struct RouteSpec {
    route_id: String,
    direction: String,
    requested_device_id: String,
    #[allow(dead_code, reason = "language metadata is retained for route diagnostics and future local STT")]
    source_language: String,
    #[allow(dead_code, reason = "language metadata is retained for route diagnostics and future local STT")]
    target_language: String,
    skip_local_vad: bool,
    feedback_loop_prevention: String,
    aec_enabled: bool,
}

impl RouteSpec {
    fn from_config(config: &Value, direction: &str) -> Result<Self, String> {
        let route_prefix = if direction == "outbound" {
            "/devices/outboundRoute"
        } else {
            "/devices/inboundRoute"
        };
        let route_id = config
            .pointer(&format!("{route_prefix}/routeId"))
            .and_then(Value::as_str)
            .unwrap_or(if direction == "outbound" {
                "audio-route-outbound-mic"
            } else {
                "audio-route-inbound-watch"
            })
            .to_string();
        let feedback_loop_prevention = config
            .pointer("/devices/feedbackLoopPrevention")
            .and_then(Value::as_str)
            .unwrap_or("none")
            .to_string();
        let aec_enabled = config
            .pointer("/devices/aecEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let route_device_id =
            if direction == "inbound" && feedback_loop_prevention == "virtual-driver" {
                config.pointer("/devices/virtualRenderDeviceId")
            } else {
                config.pointer(&format!("{route_prefix}/input/deviceId"))
            }
            .and_then(Value::as_str)
            .unwrap_or_default();
        let requested_device_id = if direction == "inbound"
            && feedback_loop_prevention != "virtual-driver"
            && matches!(
                route_device_id.trim(),
                "" | "default" | "speaker-default" | "system-output-default"
            )
        {
            config
                .pointer("/devices/outputDeviceId")
                .and_then(Value::as_str)
                .filter(|device_id| !device_id.trim().is_empty())
                .unwrap_or(route_device_id)
                .to_string()
        } else {
            route_device_id.to_string()
        };
        let source_language = config
            .pointer("/subtitles/sourceLanguage")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .to_string();
        let target_language = config
            .pointer("/subtitles/targetLanguage")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN")
            .to_string();
        // The realtime model actually bound to this route decides whether the
        // provider does server-side VAD (omni/livetranslate realtime models),
        // in which case local VAD gating must not swallow frames.
        let model = config
            .pointer(if direction == "outbound" {
                "/devices/outboundVoiceModelId"
            } else {
                "/devices/inboundVoiceModelId"
            })
            .and_then(Value::as_str)
            .unwrap_or("");
        let lower_model = model.to_lowercase();
        let skip_local_vad = lower_model.contains("realtime")
            && (lower_model.contains("omni") || lower_model.contains("livetranslate"));
        Ok(Self {
            route_id,
            direction: direction.to_string(),
            requested_device_id,
            source_language,
            target_language,
            skip_local_vad,
            feedback_loop_prevention,
            aec_enabled,
        })
    }

    fn echo_cancel_enabled(&self) -> bool {
        self.direction == "inbound"
            && self.feedback_loop_prevention == "echo-cancel"
            && self.aec_enabled
    }

    fn wasapi_direction(&self) -> Direction {
        if self.direction == "outbound" {
            Direction::Capture
        } else {
            Direction::Render
        }
    }

    fn capture_direction(&self) -> Direction {
        // WASAPI loopback uses a render endpoint initialized as a capture stream.
        Direction::Capture
    }
}

struct RouteUpdate {
    capture_state: String,
    pre_buffer_state: String,
    vad_state: String,
    buffer_ahead_ms: u64,
    frames_captured: u64,
    last_energy_db: f32,
    active_segment_id: Option<String>,
    finalized_segment: Option<FinalizedSegment>,
}

struct FinalizedSegment {
    cue: SubtitleCueRuntime,
    audio: CapturedSegmentAudio,
}

struct ActiveSegment {
    segment_id: String,
    started_at_ms: u64,
    peak_db: f32,
    voiced_chunks: u64,
    audio_bytes: Vec<u8>,
}

struct RouteProcessor {
    spec: RouteSpec,
    chunk_index: u64,
    frames_captured: u64,
    segment_index: u64,
    silence_chunks: usize,
    active_segment: Option<ActiveSegment>,
    skip_local_vad: bool,
}

impl RouteProcessor {
    fn new(spec: RouteSpec) -> Self {
        let skip_local_vad = spec.skip_local_vad;
        Self {
            spec,
            chunk_index: 0,
            frames_captured: 0,
            segment_index: 0,
            silence_chunks: 0,
            active_segment: None,
            skip_local_vad,
        }
    }

    fn ingest_chunk(&mut self, chunk: &[u8], queued_bytes: usize) -> RouteUpdate {
        self.chunk_index += 1;
        self.frames_captured += CHUNK_FRAMES as u64;
        let energy_db = calculate_chunk_db(chunk);
        let speech_detected = energy_db >= SPEECH_THRESHOLD_DB;
        let buffer_ahead_ms = (queued_bytes as u64 * 1_000)
            / (SAMPLE_RATE_HZ as u64 * CHANNEL_COUNT as u64 * std::mem::size_of::<f32>() as u64);
        let pre_buffer_state = if self.chunk_index >= 6 {
            "ready"
        } else if self.chunk_index >= 2 {
            "primed"
        } else {
            "cold"
        };

        let mut finalized_segment = None;
        if self.skip_local_vad {
            RouteUpdate {
                capture_state: if speech_detected {
                    "capturing".to_string()
                } else {
                    "buffering".to_string()
                },
                pre_buffer_state: pre_buffer_state.to_string(),
                vad_state: if speech_detected {
                    "speech".to_string()
                } else {
                    "silence".to_string()
                },
                buffer_ahead_ms,
                frames_captured: self.frames_captured,
                last_energy_db: energy_db,
                active_segment_id: None,
                finalized_segment,
            }
        } else {
            if speech_detected {
                self.silence_chunks = 0;
                if self.active_segment.is_none() {
                    self.segment_index += 1;
                    self.active_segment = Some(ActiveSegment {
                        segment_id: format!(
                            "{}-segment-{}",
                            self.spec.route_id, self.segment_index
                        ),
                        started_at_ms: unix_ms(),
                        peak_db: energy_db,
                        voiced_chunks: 0,
                        audio_bytes: Vec::new(),
                    });
                }

                if let Some(active_segment) = self.active_segment.as_mut() {
                    active_segment.voiced_chunks += 1;
                    if energy_db > active_segment.peak_db {
                        active_segment.peak_db = energy_db;
                    }
                    active_segment.audio_bytes.extend_from_slice(chunk);
                }
            } else if self.active_segment.is_some() {
                self.silence_chunks += 1;
                if self.silence_chunks >= SILENCE_HOLD_CHUNKS {
                    finalized_segment = self.finish_segment();
                    self.silence_chunks = 0;
                }
            }

            RouteUpdate {
                capture_state: if speech_detected {
                    "capturing".to_string()
                } else {
                    "buffering".to_string()
                },
                pre_buffer_state: pre_buffer_state.to_string(),
                vad_state: if speech_detected {
                    "speech".to_string()
                } else {
                    "silence".to_string()
                },
                buffer_ahead_ms,
                frames_captured: self.frames_captured,
                last_energy_db: energy_db,
                active_segment_id: self
                    .active_segment
                    .as_ref()
                    .map(|segment| segment.segment_id.clone()),
                finalized_segment,
            }
        }
    }

    fn finish_segment(&mut self) -> Option<FinalizedSegment> {
        let active_segment = self.active_segment.take()?;
        let started_at = ms_marker(active_segment.started_at_ms);
        let ended_at_ms = unix_ms();
        let duration_ms = ended_at_ms.saturating_sub(active_segment.started_at_ms);
        let source_text = if self.spec.direction == "inbound" {
            format!(
                "检测到系统音频片段 {}，持续 {} ms。",
                self.segment_index, duration_ms
            )
        } else {
            format!(
                "检测到麦克风片段 {}，持续 {} ms。",
                self.segment_index, duration_ms
            )
        };

        let cue = SubtitleCueRuntime {
            cue_id: format!("cue-{}-{}", self.spec.direction, self.segment_index),
            route_direction: self.spec.direction.clone(),
            source_text,
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: String::new(),
            started_at,
            ended_at: ms_marker(ended_at_ms),
            committed: false,
        };

        Some(FinalizedSegment {
            audio: CapturedSegmentAudio {
                cue_id: cue.cue_id.clone(),
                route_direction: cue.route_direction.clone(),
                sample_rate_hz: SAMPLE_RATE_HZ as u32,
                channel_count: CHANNEL_COUNT as u16,
                pcm_f32le: active_segment.audio_bytes,
            },
            cue,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn speech_chunk(level: f32) -> Vec<u8> {
        let mut chunk = Vec::with_capacity(CHUNK_FRAMES * CHANNEL_COUNT * 4);
        for _ in 0..(CHUNK_FRAMES * CHANNEL_COUNT) {
            chunk.extend_from_slice(&level.to_le_bytes());
        }
        chunk
    }

    #[test]
    fn route_processor_turns_speech_and_silence_into_subtitle_cue() {
        let mut processor = RouteProcessor::new(RouteSpec::from_config(
      &json!({
        "devices": {
          "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
        },
        "subtitles": { "sourceLanguage": "auto", "targetLanguage": "zh-CN" }
      }),
      "inbound",
    ).expect("route spec should parse"));

        for _ in 0..8 {
            let update = processor.ingest_chunk(&speech_chunk(0.4), 0);
            assert_eq!(update.vad_state, "speech");
            assert!(update.active_segment_id.is_some());
        }

        let mut finalized = None;
        for _ in 0..SILENCE_HOLD_CHUNKS {
            let update = processor.ingest_chunk(&speech_chunk(0.0001), 0);
            if update.finalized_segment.is_some() {
                finalized = update.finalized_segment;
            }
        }

        let cue = finalized
            .expect("subtitle cue should be emitted after trailing silence")
            .cue;
        assert_eq!(cue.route_direction, "inbound");
        assert!(!cue.committed);
        assert!(cue.translated_text.is_empty());
    }

    #[test]
    fn route_processor_ignores_bluetooth_headset_noise_floor() {
        let mut processor = RouteProcessor::new(RouteSpec::from_config(
            &json!({
              "devices": {
                "outboundRoute": { "routeId": "outbound-route", "input": { "deviceId": "mic-7" } }
              },
              "subtitles": { "sourceLanguage": "zh-CN", "targetLanguage": "en-US" }
            }),
            "outbound",
        ).expect("route spec should parse"));

        for _ in 0..20 {
            let update = processor.ingest_chunk(&speech_chunk(0.02), 0);
            assert_eq!(update.vad_state, "silence");
            assert!(update.active_segment_id.is_none());
            assert!(update.finalized_segment.is_none());
        }
    }

    #[test]
    fn route_spec_reads_outbound_device_id_from_config() {
        let spec = RouteSpec::from_config(
            &json!({
              "devices": {
                "outboundRoute": { "routeId": "outbound-route", "input": { "deviceId": "mic-7" } }
              },
              "subtitles": { "sourceLanguage": "zh-CN", "targetLanguage": "en-US" }
            }),
            "outbound",
        )
        .expect("route spec should parse");

        assert_eq!(spec.route_id, "outbound-route");
        assert_eq!(spec.requested_device_id, "mic-7");
        assert_eq!(spec.target_language, "en-US");
        assert!(!spec.echo_cancel_enabled());
        assert_eq!(spec.capture_direction(), Direction::Capture);
    }

    #[test]
    fn route_spec_skips_local_vad_only_for_realtime_omni_models_of_the_route_direction() {
        let config = json!({
          "devices": {
            "inboundVoiceModelId": "qwen3.5-omni-plus-realtime",
            "outboundVoiceModelId": "gpt-4o-mini-transcribe",
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } },
            "outboundRoute": { "routeId": "outbound-route", "input": { "deviceId": "mic-7" } }
          }
        });

        let inbound = RouteSpec::from_config(&config, "inbound").expect("inbound spec");
        assert!(inbound.skip_local_vad, "omni realtime model does server-side VAD");

        let outbound = RouteSpec::from_config(&config, "outbound").expect("outbound spec");
        assert!(!outbound.skip_local_vad, "non-realtime outbound model keeps local VAD");

        let unset = RouteSpec::from_config(&json!({ "devices": {} }), "inbound").expect("unset spec");
        assert!(!unset.skip_local_vad, "missing model id keeps local VAD");
    }

    #[test]
    fn route_spec_uses_capture_direction_for_inbound_loopback_capture() {
        let spec = RouteSpec::from_config(
            &json!({
              "devices": {
                "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
              }
            }),
            "inbound",
        )
        .expect("route spec should parse");

        assert_eq!(spec.capture_direction(), Direction::Capture);
    }

    #[test]
    fn route_spec_resolves_default_inbound_alias_to_configured_output_device() {
        let spec = RouteSpec::from_config(
            &json!({
              "devices": {
                "outputDeviceId": "{physical-render-endpoint}",
                "inboundRoute": {
                  "routeId": "inbound-route",
                  "input": { "deviceId": "system-output-default" }
                }
              }
            }),
            "inbound",
        )
        .expect("route spec should parse");

        assert_eq!(spec.requested_device_id, "{physical-render-endpoint}");
    }

    #[test]
    fn route_spec_defaults_feedback_loop_prevention_to_none() {
        let spec = RouteSpec::from_config(
            &json!({
              "devices": {
                "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
              }
            }),
            "inbound",
        )
        .expect("route spec should parse");

        assert_eq!(spec.feedback_loop_prevention, "none");
        assert!(!spec.echo_cancel_enabled());
    }

    #[test]
    fn route_spec_uses_virtual_speaker_for_isolated_inbound_capture() {
        let spec = RouteSpec::from_config(
            &json!({
              "devices": {
                "feedbackLoopPrevention": "virtual-driver",
                "virtualRenderDeviceId": "omni-virtual-speaker-default",
                "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "physical-speaker" } }
              }
            }),
            "inbound",
        )
        .expect("route spec should parse");

        assert_eq!(spec.requested_device_id, "omni-virtual-speaker-default");
    }

    #[test]
    fn route_spec_enables_echo_cancel_for_inbound_only() {
        let config = json!({
          "devices": {
            "feedbackLoopPrevention": "echo-cancel",
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } },
            "outboundRoute": { "routeId": "outbound-route", "input": { "deviceId": "mic-1" } }
          }
        });

        let inbound = RouteSpec::from_config(&config, "inbound").expect("route spec should parse");
        let outbound =
            RouteSpec::from_config(&config, "outbound").expect("route spec should parse");

        assert!(inbound.echo_cancel_enabled());
        assert!(!outbound.echo_cancel_enabled());
    }

    #[test]
    fn route_spec_disables_echo_cancel_when_aec_toggle_off() {
        let config = json!({
          "devices": {
            "feedbackLoopPrevention": "echo-cancel",
            "aecEnabled": false,
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
          }
        });

        let inbound = RouteSpec::from_config(&config, "inbound").expect("route spec should parse");

        assert!(!inbound.echo_cancel_enabled());
    }

    #[test]
    fn route_spec_defaults_aec_toggle_to_enabled_when_missing() {
        let config = json!({
          "devices": {
            "feedbackLoopPrevention": "echo-cancel",
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
          }
        });

        let inbound = RouteSpec::from_config(&config, "inbound").expect("route spec should parse");

        assert!(inbound.aec_enabled);
        assert!(inbound.echo_cancel_enabled());
    }

    #[test]
    fn bridge_source_pcm16le_converts_to_float_samples() {
        let bytes = pcm16le_to_f32le(&[0, 0, 0xff, 0x7f, 0x00, 0x80]);
        let samples = bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[1], 1.0);
        assert!(samples[2] < -1.0);
    }

    #[test]
    fn bridge_source_envelope_reads_inline_pcm() {
        let payload = vec![1_u8, 0, 2, 0];
        let header = BridgeTranslationFrameHeader {
            event_type: "bridge.source.frame".to_string(),
            request_id: "request-1".to_string(),
            session_id: "session-1".to_string(),
            frame_id: "frame-1".to_string(),
            stream_id: "stream-1".to_string(),
            sample_rate_hz: SAMPLE_RATE_HZ as u32,
            channel_count: CHANNEL_COUNT as u16,
            frame_count: 1,
            timestamp_ms: 1,
            payload_bytes: payload.len(),
        };
        let header = serde_json::to_vec(&header).unwrap();
        let mut envelope = Vec::new();
        envelope.extend_from_slice(&(header.len() as u32).to_le_bytes());
        envelope.extend_from_slice(&header);
        envelope.extend_from_slice(&payload);
        assert_eq!(
            read_bridge_source_payload(&mut std::io::Cursor::new(envelope)).unwrap(),
            BridgeSourceEnvelope::Frame(payload)
        );
    }

    #[test]
    fn bridge_source_envelope_ignores_heartbeat() {
        let header = BridgeTranslationFrameHeader {
            event_type: "bridge.source.heartbeat".to_string(),
            request_id: "request-1".to_string(),
            session_id: "session-1".to_string(),
            frame_id: "frame-1".to_string(),
            stream_id: "stream-1".to_string(),
            sample_rate_hz: SAMPLE_RATE_HZ as u32,
            channel_count: CHANNEL_COUNT as u16,
            frame_count: 0,
            timestamp_ms: 1,
            payload_bytes: 0,
        };
        let header = serde_json::to_vec(&header).unwrap();
        let mut envelope = Vec::new();
        envelope.extend_from_slice(&(header.len() as u32).to_le_bytes());
        envelope.extend_from_slice(&header);
        assert_eq!(
            read_bridge_source_payload(&mut std::io::Cursor::new(envelope)).unwrap(),
            BridgeSourceEnvelope::Heartbeat
        );
    }

    #[test]
    fn bridge_source_envelope_reports_sample_rate_mismatch() {
        let header = BridgeTranslationFrameHeader {
            event_type: "bridge.source.frame".to_string(),
            request_id: "request-1".to_string(),
            session_id: "session-1".to_string(),
            frame_id: "frame-1".to_string(),
            stream_id: "stream-1".to_string(),
            sample_rate_hz: 16_000,
            channel_count: CHANNEL_COUNT as u16,
            frame_count: 0,
            timestamp_ms: 1,
            payload_bytes: 0,
        };
        let header = serde_json::to_vec(&header).unwrap();
        let mut envelope = Vec::new();
        envelope.extend_from_slice(&(header.len() as u32).to_le_bytes());
        envelope.extend_from_slice(&header);
        assert_eq!(
            read_bridge_source_payload(&mut std::io::Cursor::new(envelope)).unwrap(),
            BridgeSourceEnvelope::Ignored(
                "reason=sample-rate-mismatch actual=16000 expected=48000".to_string()
            )
        );
    }

    #[test]
    fn audio_flow_stall_error_is_attributable_with_recommended_action() {
        let error = audio_flow_stall_error("inbound", Duration::from_secs(AUDIO_FLOW_HEALTH_WINDOW_SECS));
        assert!(error.contains("没有捕获到任何音频帧"));
        let (message, action) = error
            .split_once(" | recommended: ")
            .expect("stall error should carry a recommended action");
        assert!(!message.trim().is_empty());
        assert_eq!(action, "check-audio-source");
    }

    #[test]
    fn inbound_loopback_waits_for_media_instead_of_failing_the_watch_route() {
        assert!(!should_fail_on_initial_frame_stall("inbound"));
        assert!(should_fail_on_initial_frame_stall("outbound"));
    }

    #[test]
    fn bridge_source_timeout_recommends_bridge_restart() {
        assert!(
            bridge_source_timeout_error(Duration::from_secs(DEVICE_INIT_TIMEOUT_SECS - 1))
                .is_none()
        );
        assert_eq!(
            bridge_source_timeout_error(Duration::from_secs(DEVICE_INIT_TIMEOUT_SECS)).as_deref(),
            Some(
                "Bridge source pipe initialization timed out (10s). | recommended: restart-bridge"
            )
        );
    }

    #[test]
    fn audio_state_keeps_recent_cues_bounded() {
        let store = AudioStateStore::new();
        for index in 0..16 {
            store.push_subtitle_cue(SubtitleCueRuntime {
                cue_id: format!("cue-{index}"),
                route_direction: "inbound".to_string(),
                source_text: format!("source-{index}"),
                display_source_text: String::new(),
                display_segments: Vec::new(),
                translated_text: format!("translated-{index}"),
                started_at: "unix-ms:1".to_string(),
                ended_at: "unix-ms:2".to_string(),
                committed: true,
            });
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.subtitle_overlay.recent_cues.len(), 12);
        assert_eq!(snapshot.subtitle_overlay.queue_depth, 12);
        assert_eq!(snapshot.subtitle_overlay.dropped_cue_count, 4);
    }
}
