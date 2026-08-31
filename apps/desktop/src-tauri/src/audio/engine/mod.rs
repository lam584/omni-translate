use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{Read, Write};
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

use super::contracts::{
    AudioRuntimeSnapshot, SubtitleCueRuntime, SubtitleTranslationStateRuntime,
};
use super::events::AUDIO_RUNTIME_SNAPSHOT_EVENT;
use super::state::{
    AudioRouteHandle, AudioStateStore, BridgeSourceFrameIdentity, CapturedSegmentAudio,
    RouteInputCompletionEvidence, RouteInputCompletionRequest,
};
use super::time_utils::{ms_marker, now_unix_millis_marker, unix_ms};
use crate::bridge::contracts::BridgeTranslationFrameHeader;

const AUDIO_CAPTURE_FAILED_CODE: &str = "audio.capture-failed";

#[cfg(test)]
use crate::bridge::contracts::AudioSampleFormat;
use crate::bridge::state::BridgeStateStore;

mod retry;
mod samples;
mod device_catalog;
mod device_initializer;
mod aec_timing;
mod bridge_source_io;
mod bridge_playback_ack;
mod bridge_source_startup;
mod bridge_worker_authority;
mod echo_diagnostics;
mod route_join;

use self::bridge_source_io::{
    apply_bridge_source_identity_observation, bridge_source_identity_disposition,
    bridge_source_route_error, read_bridge_source_payload, BridgeSourceEnvelope,
    BridgeSourceIdentityDisposition,
};
#[cfg(test)]
use self::bridge_source_io::{
    bridge_translation_status_disposition, write_bridge_translation_status_ack,
    BridgeTranslationStatusDisposition,
};
use self::bridge_playback_ack::handle_bridge_translation_status;
use self::bridge_source_startup::validate_bridge_source_startup;
use self::bridge_worker_authority::{
    apply_bridge_source_worker_error_if_current,
    log_stale_bridge_source_failure,
    BridgeSourceWorkerContext,
};
#[cfg(test)]
use self::bridge_worker_authority::{
    apply_process_loopback_capture_failure_if_current,
    commit_bridge_source_worker_error_if_current,
};
use self::echo_diagnostics::EchoCancelDiagnostics;
use self::route_join::{route_join_terminal_result, wait_for_route_join, RouteJoinWaitError};

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
use self::aec_timing::{qpc_now_100ns, AecDelayEstimator, CaptureClockObservation};

const SAMPLE_RATE_HZ: usize = 48_000;
const CHANNEL_COUNT: usize = 2;
const CHUNK_FRAMES: usize = 960;
// Bluetooth headset inputs commonly keep a low, steady noise floor around
// -40 dB. Treating that as speech creates phantom segments while nobody talks.
const SPEECH_THRESHOLD_DB: f32 = -32.0;
const SILENCE_HOLD_CHUNKS: usize = 6;
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

pub(crate) fn bootstrap_audio_runtime(
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

pub(crate) fn refresh_devices(
    app: &AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    bootstrap_audio_runtime(app, store)
}

pub(crate) fn start_route(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    config: Value,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
) -> Result<AudioRuntimeSnapshot, String> {
    stop_route(app.clone(), store, direction)?;

    let spec = RouteSpec::from_config(&config, direction)?;
    spec.ensure_feedback_backend_available()?;
    if spec.echo_cancel_enabled() {
        // Construct the real production engine before any route is marked
        // started. A closed gate or missing linked AEC3 backend is a hard
        // launch failure; the legacy Rust implementation is shadow-only.
        store.activate_production_echo_canceller()?;
    }

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
        if spec.uses_bridge_source() {
            spec.requested_device_id.clone()
        } else {
            let enumerator = DeviceEnumerator::new().map_err_str()?;
            let device = pick_device(&enumerator, &spec)?;
            device.get_id().map_err_str()?
        };

    let waits_for_bridge_source = spec.uses_bridge_source();
    let (input_completion_tx, input_completion_rx) = if waits_for_bridge_source {
        let (tx, rx) = mpsc::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let bridge_source_context = if waits_for_bridge_source {
        let bridge_snapshot = app.state::<BridgeStateStore>().snapshot();
        diag_log_detail(
            &app,
            "audio",
            "info",
            "Inbound route delegated Bridge readiness to the capture worker.",
            format!(
                "pipe={} reconnectTimeoutSecs={BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS} sessionId={} sourceGeneration={}",
                bridge_snapshot.pipe_path,
                bridge_snapshot.session_id.as_deref().unwrap_or("none"),
                bridge_snapshot.source_generation,
            ),
        );
        Some(BridgeSourceWorkerContext::new(
            store.inbound_route_generation(),
            bridge_snapshot,
        ))
    } else {
        None
    };
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
    if stt_sender.is_none() {
        diag_log(
            &app,
            "audio",
            "warning",
            format!("{direction} 音频采集已启动但没有 STT/Omni sender，音频将只做本地 VAD 而不进行语音识别，subtitles 不会产生任何 cue！"),
        );
    }
    emit_audio_snapshot(&app, store)?;

    let (stop_tx, stop_rx) = mpsc::channel();
    let route_direction = direction.to_string();
    let app_handle = app.clone();
    let worker_spec = spec.clone();
    let failure_context = bridge_source_context.clone();

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
                input_completion_rx,
                stt_sender,
                init_done: Some(init_done_for_worker),
                bridge_source_context,
            };
            if let Err(error) = worker.run(&audio_state) {
                let (mut message, mut error_code, mut recommended_action) =
                    crate::audio::omni::session_errors::split_error_markers(&error);
                if error_code.is_none() {
                    let _ = diag_log_detail(
                        &app_handle,
                        "audio-engine",
                        "error",
                        format!("audio capture worker exited: direction={route_direction}"),
                        error.clone(),
                    );
                    message = "音频采集线程异常退出，请检查音频设备后重试".to_string();
                    error_code = Some(AUDIO_CAPTURE_FAILED_CODE.to_string());
                    recommended_action = Some("check-audio-device".to_string());
                }
                let state_applied = if let Some(context) = failure_context.as_ref() {
                    apply_bridge_source_worker_error_if_current(
                        &app_handle,
                        &audio_state,
                        context,
                        &route_direction,
                        &message,
                        error_code.as_deref(),
                        recommended_action.as_deref(),
                    )
                } else if error_code.as_deref()
                    == Some("bridge.process-loopback-capture-failed")
                {
                    false
                } else {
                    audio_state.mark_route_error(
                        &route_direction,
                        message.clone(),
                        error_code.clone(),
                        recommended_action.clone(),
                    );
                    true
                };
                if !state_applied {
                    if let Some(context) = failure_context.as_ref() {
                        log_stale_bridge_source_failure(
                            &app_handle,
                            context,
                            &message,
                            "worker-authority-mismatch",
                        );
                    }
                    return;
                }
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
    if let Some(input_completion_tx) = input_completion_tx {
        store.store_route_input_completion_sender(direction, input_completion_tx);
    }
    Ok(store.snapshot())
}

pub(crate) fn stop_route(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
) -> Result<AudioRuntimeSnapshot, String> {
    let _ = store.take_route_input_completion_sender(direction);
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

        let join_wait = wait_for_route_join(&done_rx, Duration::from_millis(1_500));
        match join_wait {
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
            Err(RouteJoinWaitError::Timeout) => {
                let _ = diag_log_detail(
                    &app,
                    "audio",
                    "warning",
                    "watch_mode.route_stop_timeout",
                    format!("direction={direction} timeoutMs=1500"),
                );
            }
            Err(RouteJoinWaitError::Disconnected) => {}
        }
        route_join_terminal_result(direction, join_wait)?;
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

pub(crate) fn clear_cues(
    app: &AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    store.clear_subtitle_cues();
    diag_log(app, "audio", "info", "已清空字幕与音频缓存队列。");
    emit_audio_snapshot(app, store)?;
    Ok(store.snapshot())
}

pub(crate) fn emit_audio_snapshot<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
) -> Result<(), String> {
    let (snapshot, subtitle_deltas, emit_audio, emit_runtime) = store.prepare_event_dispatch();
    for delta in subtitle_deltas {
        app.emit(super::events::SUBTITLE_DELTA_EVENT, delta)
            .map_err_str()?;
    }
    if emit_audio {
        app.emit(AUDIO_RUNTIME_SNAPSHOT_EVENT, snapshot)
            .map_err_str()?;
    }
    if emit_runtime {
        if let Some(runtime_state) = app.try_state::<RuntimeStateStore>() {
            emit_runtime_snapshot(app, &runtime_state).map_err_str()?;
        }
    }
    Ok(())
}

/// Route worker failures used to only update the audio snapshot, leaving
/// users outside the session page unaware of a dead capture chain. Push an
/// error-level runtime notification (source `audio-engine`) so the global
/// toast host can surface it; the id embeds the error code for dedupe.
fn notify_route_worker_error<R: tauri::Runtime>(
    app: &AppHandle<R>,
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
            if same_windows_audio_device_id(&device_id, &spec.requested_device_id) {
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

    if !spec.requested_device_id.is_empty() {
        return Err(format!(
            "requested audio endpoint was not found; default endpoint fallback is forbidden: {}",
            spec.requested_device_id
        ));
    }

    enumerator.get_default_device(&direction).map_err_str()
}

fn same_windows_audio_device_id(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
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
            if same_windows_audio_device_id(&device_id, target_id) {
                return Some(device);
            }
        }
    }
    None
}

include!("input_completion.rs");
include!("provider_input_fence.rs");
include!("route_worker.rs");
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
        let configured_aec_enabled = config
            .pointer("/devices/aecEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // `echo-cancel` names the WebRTC AEC3 capture backend; it is not a
        // route that may silently run with processing disabled. Preserve the
        // legacy toggle for other modes/outbound microphone processing, but
        // force the effective inbound backend on whenever this mode is chosen.
        let aec_enabled = feedback_loop_prevention == "echo-cancel"
            || configured_aec_enabled;
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
        let skip_local_vad = super::events::resolve_model_provider_from_config_value(config, model)
            .map(|provider| super::events::resolve_realtime_profile(&provider, &provider.model).server_segmentation)
            .unwrap_or(false);
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

    fn ensure_feedback_backend_available(&self) -> Result<(), String> {
        if self.direction != "inbound" || self.feedback_loop_prevention != "echo-cancel" {
            return Ok(());
        }
        let gate = crate::audio::echo_cancel::webrtc_aec3_build_gate();
        if gate.ready {
            return Ok(());
        }
        Err(format!(
            "WebRTC AEC3 当前不可用，echo-cancel 路线未启动，也不会静默回退到旧 Rust AEC。请选择进程级排除或 Virtual Driver。dependency={} msvcBuildVerified={} linkedBackendPresent={} fixtureVerified={} reason={}",
            gate.dependency,
            gate.msvc_build_verified,
            gate.linked_backend_present,
            gate.fixture_verified,
            gate.reason,
        ))
    }

    fn uses_bridge_source(&self) -> bool {
        self.direction == "inbound"
            && matches!(
                self.feedback_loop_prevention.as_str(),
                "virtual-driver" | "process-exclusion"
            )
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
            self.route_update(
                speech_detected,
                pre_buffer_state,
                buffer_ahead_ms,
                energy_db,
                None,
                finalized_segment,
            )
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

            let active_segment_id = self
                .active_segment
                .as_ref()
                .map(|segment| segment.segment_id.clone());
            self.route_update(
                speech_detected,
                pre_buffer_state,
                buffer_ahead_ms,
                energy_db,
                active_segment_id,
                finalized_segment,
            )
        }
    }

    /// Assembles a `RouteUpdate` from the per-tick capture metrics. The
    /// `capture_state`/`vad_state` labels derive from `speech_detected`; only
    /// `active_segment_id` and `finalized_segment` differ between the
    /// skip-VAD and local-VAD paths.
    fn route_update(
        &self,
        speech_detected: bool,
        pre_buffer_state: &str,
        buffer_ahead_ms: u64,
        energy_db: f32,
        active_segment_id: Option<String>,
        finalized_segment: Option<FinalizedSegment>,
    ) -> RouteUpdate {
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
            active_segment_id,
            finalized_segment,
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
            revision: None,
            sequence: None,
            route_direction: self.spec.direction.clone(),
            source_text,
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: String::new(),
            started_at,
            ended_at: ms_marker(ended_at_ms),
            committed: false,
            translation_committed: false,
            translation_state: Some(SubtitleTranslationStateRuntime::Pending),
        };

        Some(FinalizedSegment {
            audio: CapturedSegmentAudio {
                cue_id: cue.cue_id.clone(),
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
    use std::cell::Cell;
    use std::sync::atomic::AtomicUsize;

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

    /// Config with a single outbound mic route + zh-CN→en-US subtitles,
    /// shared by the outbound route-spec tests.
    fn outbound_mic7_config() -> serde_json::Value {
        json!({
          "devices": {
            "outboundRoute": { "routeId": "outbound-route", "input": { "deviceId": "mic-7" } }
          },
          "subtitles": { "sourceLanguage": "zh-CN", "targetLanguage": "en-US" }
        })
    }

    /// Config with a single inbound speaker (loopback) route, shared by the
    /// inbound route-spec tests.
    fn inbound_speaker1_config() -> serde_json::Value {
        json!({
          "devices": {
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
          }
        })
    }

    #[test]
    fn windows_audio_endpoint_identity_is_case_insensitive() {
        assert!(same_windows_audio_device_id(
            "{0.0.0.00000000}.{A609DEE5-4FFD-49D6-B7F2-705CFA934363}",
            "{0.0.0.00000000}.{a609dee5-4ffd-49d6-b7f2-705cfa934363}",
        ));
        assert!(!same_windows_audio_device_id(
            "{0.0.0.00000000}.{a609dee5-4ffd-49d6-b7f2-705cfa934363}",
            "{0.0.0.00000000}.{27efe749-03d9-4ac0-88c6-2838b0beec7a}",
        ));
    }

    #[test]
    fn route_processor_ignores_bluetooth_headset_noise_floor() {
        let mut processor = RouteProcessor::new(
            RouteSpec::from_config(&outbound_mic7_config(), "outbound")
                .expect("route spec should parse"),
        );

        for _ in 0..20 {
            let update = processor.ingest_chunk(&speech_chunk(0.02), 0);
            assert_eq!(update.vad_state, "silence");
            assert!(update.active_segment_id.is_none());
            assert!(update.finalized_segment.is_none());
        }
    }

    #[test]
    fn route_spec_reads_outbound_device_id_from_config() {
        let spec = RouteSpec::from_config(&outbound_mic7_config(), "outbound")
            .expect("route spec should parse");

        assert_eq!(spec.route_id, "outbound-route");
        assert_eq!(spec.requested_device_id, "mic-7");
        assert_eq!(spec.target_language, "en-US");
        assert!(!spec.echo_cancel_enabled());
        assert_eq!(spec.capture_direction(), Direction::Capture);
    }

    #[test]
    fn route_spec_skips_local_vad_only_for_manifest_authorized_realtime_models_of_the_route_direction() {
        let config = json!({
          "providers": [{
            "templateId": "template-dashscope-realtime",
            "providerId": "dashscope",
            "kind": "dashscope",
            "displayName": "DashScope",
            "model": "qwen3.5-livetranslate-flash-realtime",
            "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
            "transport": "websocket",
            "region": "cn-beijing",
            "authRef": { "kind": "system", "reference": "dashscope", "headerName": "Authorization", "scheme": "bearer" },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": "",
            "sceneModelAssignments": [],
            "localModelCapabilityRegistry": []
          }],
          "devices": {
            "inboundVoiceModelId": "qwen3.5-livetranslate-flash-realtime",
            "outboundVoiceModelId": "gpt-4o-mini-transcribe",
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } },
            "outboundRoute": { "routeId": "outbound-route", "input": { "deviceId": "mic-7" } }
          }
        });

        let inbound = RouteSpec::from_config(&config, "inbound").expect("inbound spec");
        assert!(inbound.skip_local_vad, "the exact enabled manifest profile does server-side VAD");

        let outbound = RouteSpec::from_config(&config, "outbound").expect("outbound spec");
        assert!(!outbound.skip_local_vad, "non-realtime outbound model keeps local VAD");

        let unset = RouteSpec::from_config(&json!({ "devices": {} }), "inbound").expect("unset spec");
        assert!(!unset.skip_local_vad, "missing model id keeps local VAD");

        let mut manifest_only = config.clone();
        manifest_only["providers"][0]["model"] = json!("qwen3.5-omni-plus-realtime");
        manifest_only["devices"]["inboundVoiceModelId"] =
            json!("qwen3.5-omni-plus-realtime");
        let denied = RouteSpec::from_config(&manifest_only, "inbound")
            .expect("manifest-only route spec remains locally processable");
        assert!(
            !denied.skip_local_vad,
            "a manifest-only adapter must not authorize server segmentation"
        );
    }

    #[test]
    fn route_spec_uses_exact_manifest_profile_for_registry_vad_policy() {
        let config = json!({
          "providers": [{
            "templateId": "template-dashscope-realtime",
            "providerId": "dashscope",
            "kind": "dashscope",
            "displayName": "DashScope",
            "model": "qwen3.5-livetranslate-flash-realtime",
            "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
            "transport": "websocket",
            "region": "cn-beijing",
            "authRef": { "kind": "system", "reference": "dashscope", "headerName": "Authorization", "scheme": "bearer" },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": "",
            "sceneModelAssignments": [],
            "localModelCapabilityRegistry": [{
              "id": "alias", "modelId": "qwen3.5-livetranslate-flash-realtime",
              "capabilities": ["speech-to-speech"],
              "registryVersion": "bailian-model-protocol-registry/v1",
              "profileId": "bailian.livetranslate.realtime.ws",
              "profileVersion": 1,
              "realtimeProtocol": "dashscope-livetranslate",
              "realtimeAudioMode": "server_vad",
              "interactionCapabilities": ["streaming", "auto_vad"]
            }]
          }],
          "devices": {
            "inboundVoiceModelId": "qwen3.5-livetranslate-flash-realtime",
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
          }
        });
        let spec = RouteSpec::from_config(&config, "inbound").expect("inbound spec");
        assert!(spec.skip_local_vad);
    }

    #[test]
    fn route_spec_uses_capture_direction_for_inbound_loopback_capture() {
        let spec = RouteSpec::from_config(&inbound_speaker1_config(), "inbound")
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
        let spec = RouteSpec::from_config(&inbound_speaker1_config(), "inbound")
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
    fn echo_cancel_mode_forces_aec3_even_when_legacy_toggle_is_false() {
        let config = json!({
          "devices": {
            "feedbackLoopPrevention": "echo-cancel",
            "aecEnabled": false,
            "inboundRoute": { "routeId": "inbound-route", "input": { "deviceId": "speaker-1" } }
          }
        });

        let inbound = RouteSpec::from_config(&config, "inbound").expect("route spec should parse");

        assert!(inbound.aec_enabled);
        assert!(inbound.echo_cancel_enabled());
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
    #[cfg(not(feature = "webrtc-aec3"))]
    fn echo_cancel_route_is_blocked_while_the_aec3_build_gate_is_closed() {
        let config = json!({
            "devices": {
                "outputDeviceId": "speaker-1",
                "feedbackLoopPrevention": "echo-cancel",
                "aecEnabled": true,
            }
        });
        let inbound = RouteSpec::from_config(&config, "inbound").expect("inbound spec");
        let error = inbound
            .ensure_feedback_backend_available()
            .expect_err("legacy AEC must not silently back the public echo-cancel route");
        assert!(error.contains("WebRTC AEC3 当前不可用"));
        assert!(error.contains("不会静默回退到旧 Rust AEC"));
        assert!(error.contains("x86_64-pc-windows-msvc"));
    }

    #[test]
    #[cfg(feature = "webrtc-aec3")]
    fn echo_cancel_route_is_available_only_in_the_linked_aec3_build() {
        let config = json!({
            "devices": {
                "outputDeviceId": "speaker-1",
                "feedbackLoopPrevention": "echo-cancel",
                "aecEnabled": false,
            }
        });
        let inbound = RouteSpec::from_config(&config, "inbound").expect("inbound spec");

        assert!(inbound.echo_cancel_enabled());
        inbound
            .ensure_feedback_backend_available()
            .expect("linked verified AEC3 route should be available");
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

    /// Builds a bridge audio frame header for envelope tests; only the event
    /// type / sample rate / frame count / payload size vary between cases.
    fn bridge_frame_header(
        event_type: &str,
        sample_rate_hz: u32,
        frame_count: usize,
        payload_bytes: usize,
    ) -> BridgeTranslationFrameHeader {
        BridgeTranslationFrameHeader {
            event_type: event_type.to_string(),
            request_id: "request-1".to_string(),
            session_id: "session-1".to_string(),
            frame_id: "frame-1".to_string(),
            stream_id: "stream-1".to_string(),
            sample_rate_hz,
            sample_format: AudioSampleFormat::PcmS16le,
            channel_count: CHANNEL_COUNT as u16,
            frame_count,
            timestamp_ms: 1,
            payload_bytes,
            bridge_process_id: Some(42),
            bridge_instance_id: Some("bridge-instance-1".to_string()),
            playback_owner_generation: None,
            source_generation: Some(7),
            source_generation_token: Some(
                "bridge-instance-1:session-1:7".to_string(),
            ),
            physical_playback_device_id: None,
            cue_id: None,
            created_at_ms: None,
            estimated_duration_ms: None,
            chunk_index: None,
            chunk_count: None,
            stream_state: None,
            translated_audio_enhancement_applied: false,
            translation_sink: None,
            route_direction: None,
        }
    }

    fn playback_authority(session_id: &str) -> crate::audio::state::TranslationPlaybackAuthority {
        crate::audio::state::TranslationPlaybackAuthority {
            session_id: session_id.to_string(),
            bridge_instance_id: "bridge-instance-1".to_string(),
            source_generation: 7,
            source_generation_token: format!("bridge-instance-1:{session_id}:7"),
            playback_owner_generation: 11,
            physical_playback_device_id: "physical-endpoint-1".to_string(),
        }
    }

    /// Length-prefixes the serialized header and appends the PCM payload,
    /// matching the bridge source wire framing.
    fn bridge_source_envelope_bytes(
        header: &BridgeTranslationFrameHeader,
        payload: &[u8],
    ) -> Vec<u8> {
        bridge_source_json_envelope_bytes(&serde_json::to_value(header).unwrap(), payload)
    }

    fn bridge_source_json_envelope_bytes(header: &Value, payload: &[u8]) -> Vec<u8> {
        let header = serde_json::to_vec(header).unwrap();
        let mut envelope = Vec::new();
        envelope.extend_from_slice(&(header.len() as u32).to_le_bytes());
        envelope.extend_from_slice(&header);
        envelope.extend_from_slice(payload);
        envelope
    }

    #[test]
    fn bridge_source_envelope_reads_inline_pcm() {
        let payload = vec![1_u8, 0, 2, 0];
        let header =
            bridge_frame_header("bridge.source.frame", SAMPLE_RATE_HZ as u32, 1, payload.len());
        let envelope = bridge_source_envelope_bytes(&header, &payload);
        let BridgeSourceEnvelope::Frame {
            payload: parsed_payload,
            identity,
        } = read_bridge_source_payload(&mut std::io::Cursor::new(envelope)).unwrap()
        else {
            panic!("expected source frame");
        };
        assert_eq!(parsed_payload, payload);
        assert_eq!(identity.bridge_process_id, 42);
        assert_eq!(identity.bridge_instance_id, "bridge-instance-1");
        assert_eq!(identity.session_id, "session-1");
        assert_eq!(identity.source_generation, 7);
        assert_eq!(
            identity.source_generation_token,
            "bridge-instance-1:session-1:7"
        );
        assert_eq!(identity.frame_timestamp_ms, 1);
        assert!(identity.read_timestamp_ms > 0);
    }

    #[test]
    fn bridge_source_envelope_ignores_heartbeat() {
        let header =
            bridge_frame_header("bridge.source.heartbeat", SAMPLE_RATE_HZ as u32, 0, 0);
        let envelope = bridge_source_envelope_bytes(&header, &[]);
        let BridgeSourceEnvelope::Heartbeat(identity) =
            read_bridge_source_payload(&mut std::io::Cursor::new(envelope)).unwrap()
        else {
            panic!("expected source heartbeat");
        };
        assert_eq!(identity.bridge_process_id, 42);
        assert_eq!(identity.source_generation, 7);
    }

    #[test]
    fn bridge_source_identity_rebinds_only_the_current_process_incarnation() {
        let mut current = crate::bridge::contracts::BridgeRuntimeSnapshot {
            bridge_process_id: Some(42),
            bridge_instance_id: Some("bridge-instance-new".to_string()),
            session_id: Some("session-new".to_string()),
            source_generation: 100,
            source_generation_token: Some(
                "bridge-instance-new:session-new:100".to_string(),
            ),
            ..Default::default()
        };
        let new_subscription = BridgeSourceFrameIdentity {
            bridge_process_id: 42,
            bridge_instance_id: "bridge-instance-new".to_string(),
            session_id: "session-new".to_string(),
            source_generation: 101,
            source_generation_token:
                "bridge-instance-new:session-new:101".to_string(),
            frame_timestamp_ms: 1_000,
            read_timestamp_ms: 1_001,
        };
        assert_eq!(
            bridge_source_identity_disposition(&current, &new_subscription),
            BridgeSourceIdentityDisposition::Rebind
        );
        let disposition = bridge_source_identity_disposition(&current, &new_subscription);
        assert!(apply_bridge_source_identity_observation(
            &mut current,
            &new_subscription,
            &disposition,
            true,
        ));
        assert!(current.source_subscriber_active);
        assert_eq!(current.source_worker_phase, "source-frame-delivered");
        assert_eq!(current.source_worker_last_progress_timestamp_ms, Some(1_001));
        assert_eq!(current.last_frame_timestamp_ms, Some(1_000));
        assert_eq!(
            bridge_source_identity_disposition(&current, &new_subscription),
            BridgeSourceIdentityDisposition::Current
        );

        let old_process_frame = BridgeSourceFrameIdentity {
            bridge_process_id: 41,
            bridge_instance_id: "bridge-instance-old".to_string(),
            session_id: "session-old".to_string(),
            source_generation: 99,
            source_generation_token:
                "bridge-instance-old:session-old:99".to_string(),
            frame_timestamp_ms: 999,
            read_timestamp_ms: 1_002,
        };
        let old_disposition = bridge_source_identity_disposition(&current, &old_process_frame);
        assert!(matches!(
            &old_disposition,
            BridgeSourceIdentityDisposition::Reject(reason)
                if reason.contains("bridge-process-mismatch")
        ));
        let generation = current.source_generation;
        assert!(!apply_bridge_source_identity_observation(
            &mut current,
            &old_process_frame,
            &old_disposition,
            true,
        ));
        assert_eq!(current.source_generation, generation);
    }

    #[test]
    fn revoked_bridge_source_incarnation_cannot_rebind_with_a_higher_generation() {
        let current = crate::bridge::contracts::BridgeRuntimeSnapshot {
            bridge_process_id: Some(42),
            bridge_instance_id: Some("bridge-instance".to_string()),
            session_id: Some("session".to_string()),
            source_generation: 7,
            source_generation_token: None,
            ..Default::default()
        };
        let old_sidecar_reconnect = BridgeSourceFrameIdentity {
            bridge_process_id: 42,
            bridge_instance_id: "bridge-instance".to_string(),
            session_id: "session".to_string(),
            source_generation: 8,
            source_generation_token: "bridge-instance:session:8".to_string(),
            frame_timestamp_ms: 1_000,
            read_timestamp_ms: 1_001,
        };

        assert_eq!(
            bridge_source_identity_disposition(&current, &old_sidecar_reconnect),
            BridgeSourceIdentityDisposition::Reject(
                "bridge-source-incarnation-revoked".to_string()
            ),
        );
    }

    #[test]
    fn bridge_source_heartbeat_reasserts_current_subscriber_without_faking_pcm_progress() {
        let mut current = crate::bridge::contracts::BridgeRuntimeSnapshot {
            bridge_process_id: Some(42),
            bridge_instance_id: Some("bridge-instance".to_string()),
            session_id: Some("session".to_string()),
            source_generation: 7,
            source_generation_token: Some("bridge-instance:session:7".to_string()),
            source_subscriber_active: false,
            source_worker_last_progress_timestamp_ms: Some(900),
            last_frame_timestamp_ms: Some(800),
            ..Default::default()
        };
        let heartbeat = BridgeSourceFrameIdentity {
            bridge_process_id: 42,
            bridge_instance_id: "bridge-instance".to_string(),
            session_id: "session".to_string(),
            source_generation: 7,
            source_generation_token: "bridge-instance:session:7".to_string(),
            frame_timestamp_ms: 1_000,
            read_timestamp_ms: 1_001,
        };
        let disposition = bridge_source_identity_disposition(&current, &heartbeat);

        assert!(apply_bridge_source_identity_observation(
            &mut current,
            &heartbeat,
            &disposition,
            false,
        ));
        assert!(current.source_subscriber_active);
        assert_eq!(current.source_worker_last_progress_timestamp_ms, Some(900));
        assert_eq!(current.last_frame_timestamp_ms, Some(800));
    }

    #[test]
    fn bridge_source_error_envelope_surfaces_process_capture_failure_immediately() {
        let mut header = serde_json::to_value(bridge_frame_header(
            "bridge.source.error",
            SAMPLE_RATE_HZ as u32,
            0,
            0,
        ))
        .unwrap();
        header["errorCode"] = Value::String(
            "bridge.process-loopback-capture-failed".to_string(),
        );
        header["message"] = Value::String("WASAPI process capture stopped".to_string());
        let envelope = bridge_source_json_envelope_bytes(&header, &[]);

        let parsed = read_bridge_source_payload(&mut std::io::Cursor::new(envelope)).unwrap();
        assert_eq!(
            parsed,
            BridgeSourceEnvelope::RouteError {
                code: "bridge.process-loopback-capture-failed".to_string(),
                message: "WASAPI process capture stopped".to_string(),
            }
        );
        let BridgeSourceEnvelope::RouteError { code, message } = parsed else {
            panic!("expected a route failure envelope");
        };
        let route_error = bridge_source_route_error(&code, &message);
        assert!(route_error.contains("| code: bridge.process-loopback-capture-failed"));
        assert!(route_error.contains("| recommended: restart-bridge"));
    }

    #[test]
    fn activation_failure_keeps_its_typed_hresult_at_route_start() {
        let bridge = crate::bridge::contracts::BridgeRuntimeSnapshot {
            bridge_state: "degraded".to_string(),
            lifecycle_state: "error".to_string(),
            source_capture_mode:
                crate::bridge::contracts::SourceCaptureMode::ProcessExclusion,
            capture_backend:
                crate::bridge::contracts::CaptureBackend::WasapiProcessExclusion,
            process_loopback_supported: true,
            process_loopback_status:
                crate::bridge::contracts::ProcessLoopbackStatus::Failed,
            process_loopback_failure_detail: Some(
                "ActivateAudioInterfaceAsync injected HRESULT=0x88890004".to_string(),
            ),
            last_error_code: Some(
                "bridge.process-loopback-activation-failed".to_string(),
            ),
            ..Default::default()
        };

        let error = process_loopback_route_start_error(&bridge)
            .expect("a failed process route must stop Watch startup");
        let (message, code, action) =
            crate::audio::omni::session_errors::split_error_markers(&error);
        assert!(message.contains("HRESULT=0x88890004"));
        assert_eq!(
            code.as_deref(),
            Some("bridge.process-loopback-activation-failed")
        );
        assert_eq!(action.as_deref(), Some("open-diagnostics"));
    }

    #[test]
    fn bridge_translation_status_envelope_preserves_cue_terminal_failure() {
        let mut header = serde_json::to_value(bridge_frame_header(
            "bridge.translation.status",
            SAMPLE_RATE_HZ as u32,
            0,
            0,
        ))
        .unwrap();
        header["statusId"] = Value::String("bridge-status-output-failure".to_string());
        header["cueId"] = Value::String("cue-output-failure".to_string());
        header["playbackStatus"] = Value::String("route-failed".to_string());
        header["reason"] = Value::String("physical-output-open-failed".to_string());
        header["errorCode"] =
            Value::String("bridge.translation-playback-failed".to_string());
        header["playbackOwnerGeneration"] = Value::from(11_u64);
        header["physicalPlaybackDeviceId"] =
            Value::String("physical-endpoint-1".to_string());
        let envelope = bridge_source_json_envelope_bytes(&header, &[]);

        assert_eq!(
            read_bridge_source_payload(&mut std::io::Cursor::new(envelope)).unwrap(),
            BridgeSourceEnvelope::TranslationStatus {
                status_id: "bridge-status-output-failure".to_string(),
                session_id: "session-1".to_string(),
                bridge_instance_id: "bridge-instance-1".to_string(),
                source_generation: 7,
                source_generation_token: "bridge-instance-1:session-1:7".to_string(),
                playback_owner_generation: 11,
                physical_playback_device_id: "physical-endpoint-1".to_string(),
                cue_id: "cue-output-failure".to_string(),
                status: "route-failed".to_string(),
                reason: "physical-output-open-failed".to_string(),
                error_code: Some("bridge.translation-playback-failed".to_string()),
                timestamp_ms: 1,
            }
        );
    }

    #[test]
    fn bridge_translation_status_without_stable_id_is_rejected() {
        let mut header = serde_json::to_value(bridge_frame_header(
            "bridge.translation.status",
            SAMPLE_RATE_HZ as u32,
            0,
            0,
        ))
        .unwrap();
        header["cueId"] = Value::String("cue-without-status-id".to_string());
        header["playbackStatus"] = Value::String("completed".to_string());
        header["reason"] = Value::String("physical-playback-completed".to_string());
        header["playbackOwnerGeneration"] = Value::from(11_u64);
        header["physicalPlaybackDeviceId"] =
            Value::String("physical-endpoint-1".to_string());
        let envelope = bridge_source_json_envelope_bytes(&header, &[]);

        assert!(read_bridge_source_payload(&mut std::io::Cursor::new(envelope))
            .unwrap_err()
            .contains("statusId"));
    }

    #[test]
    fn bridge_translation_status_ack_is_length_prefixed_and_replay_stable() {
        let mut wire = Vec::new();
        write_bridge_translation_status_ack(
            &mut wire,
            "bridge-status-output-failure",
            &playback_authority("session-1"),
        )
        .unwrap();

        let header_size = u32::from_le_bytes(wire[..4].try_into().unwrap()) as usize;
        let ack: omni_bridge_protocol::TranslationPlaybackStatusAck =
            serde_json::from_slice(&wire[4..4 + header_size]).unwrap();
        assert_eq!(ack.event_type, "bridge.translation.status.ack");
        assert_eq!(ack.status_id, "bridge-status-output-failure");
        assert_eq!(ack.session_id, "session-1");
    }

    #[test]
    fn failed_status_ack_keeps_desktop_receipt_for_idempotent_replay() {
        struct BrokenAckWriter;
        impl Write for BrokenAckWriter {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated source disconnect",
                ))
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let store = AudioStateStore::new();
        assert!(store.accept_bridge_translation_status_once("bridge-status-retry"));
        assert!(write_bridge_translation_status_ack(
            &mut BrokenAckWriter,
            "bridge-status-retry",
            &playback_authority("session-1"),
        )
        .is_err());
        assert!(
            !store.accept_bridge_translation_status_once("bridge-status-retry"),
            "the replay must be ACKed without recording its terminal twice"
        );
    }

    #[test]
    fn stale_session_status_is_deduped_and_acknowledged_without_report_application() {
        let store = AudioStateStore::new();
        assert_eq!(
            bridge_translation_status_disposition(
                &store,
                Some("active-session"),
                "bridge-status-old-session",
                "old-session",
            ),
            BridgeTranslationStatusDisposition::SessionMismatch
        );
        assert_eq!(
            bridge_translation_status_disposition(
                &store,
                Some("active-session"),
                "bridge-status-old-session",
                "old-session",
            ),
            BridgeTranslationStatusDisposition::DuplicateReplay
        );

        let mut wire = Vec::new();
        write_bridge_translation_status_ack(
            &mut wire,
            "bridge-status-old-session",
            &playback_authority("old-session"),
        )
        .unwrap();
        let header_size = u32::from_le_bytes(wire[..4].try_into().unwrap()) as usize;
        let ack: omni_bridge_protocol::TranslationPlaybackStatusAck =
            serde_json::from_slice(&wire[4..4 + header_size]).unwrap();
        assert_eq!(ack.status_id, "bridge-status-old-session");
        assert_eq!(ack.session_id, "old-session");
    }

    #[test]
    fn bridge_source_envelope_reports_sample_rate_mismatch() {
        let header = bridge_frame_header("bridge.source.frame", 16_000, 0, 0);
        let envelope = bridge_source_envelope_bytes(&header, &[]);
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

    fn ready_process_bridge_snapshot(
        session_id: &str,
        source_generation: u64,
    ) -> crate::bridge::contracts::BridgeRuntimeSnapshot {
        crate::bridge::contracts::BridgeRuntimeSnapshot {
            bridge_process_id: Some(42),
            bridge_instance_id: Some(format!("instance-{session_id}")),
            process_status: "running".to_string(),
            bridge_state: "running".to_string(),
            lifecycle_state: "ready".to_string(),
            driver_health: "running".to_string(),
            source_capture_mode:
                crate::bridge::contracts::SourceCaptureMode::ProcessExclusion,
            capture_backend:
                crate::bridge::contracts::CaptureBackend::WasapiProcessExclusion,
            process_loopback_supported: true,
            process_loopback_status:
                crate::bridge::contracts::ProcessLoopbackStatus::Ready,
            capture_lifecycle_state: "capturing".to_string(),
            source_worker_phase: "process-loopback-capturing".to_string(),
            source_generation,
            source_generation_token: Some(format!(
                "instance-{session_id}:{session_id}:{source_generation}"
            )),
            session_id: Some(session_id.to_string()),
            last_error_code: None,
            ..Default::default()
        }
    }

    #[test]
    fn old_bridge_worker_failure_cannot_pollute_new_ready_route_generation() {
        let audio_state = AudioStateStore::new();
        let bridge_state = BridgeStateStore::new();
        let old_snapshot = ready_process_bridge_snapshot("old-session", 7);
        bridge_state.update_snapshot(|current| *current = old_snapshot.clone());
        let old_context = BridgeSourceWorkerContext::new(
            audio_state.inbound_route_generation(),
            old_snapshot,
        );

        audio_state.bump_inbound_route_generation();
        audio_state.mark_route_started(
            "inbound",
            "new-watch-route",
            "system-output-default",
            r"\\.\pipe\omni-new-source",
        );
        let new_snapshot = ready_process_bridge_snapshot("new-session", 8);
        bridge_state.update_snapshot(|current| *current = new_snapshot.clone());

        let prepare_calls = Cell::new(0usize);
        let bridge_commits = Cell::new(0usize);
        let notifications = Cell::new(0usize);
        let applied = commit_bridge_source_worker_error_if_current(
            &audio_state,
            &old_context,
            "inbound",
            "old capture failed",
            Some("bridge.process-loopback-capture-failed"),
            Some("select-audio-route"),
            || {
                prepare_calls.set(prepare_calls.get() + 1);
                Some(())
            },
            |_| {
                bridge_commits.set(bridge_commits.get() + 1);
                apply_process_loopback_capture_failure_if_current(
                    &bridge_state,
                    &old_context,
                    "old capture failed",
                    None,
                )
            },
            || notifications.set(notifications.get() + 1),
        );

        assert!(!applied);
        assert_eq!(prepare_calls.get(), 0);
        assert_eq!(bridge_commits.get(), 0);
        assert_eq!(notifications.get(), 0);
        let bridge = bridge_state.snapshot();
        assert_eq!(bridge.session_id.as_deref(), Some("new-session"));
        assert_eq!(bridge.source_generation, 8);
        assert_eq!(bridge.bridge_state, "running");
        assert_eq!(
            bridge.process_loopback_status,
            crate::bridge::contracts::ProcessLoopbackStatus::Ready
        );
        assert_eq!(bridge.last_error_code, None);
        let audio = audio_state.snapshot();
        assert_eq!(audio.inbound.route_id, "new-watch-route");
        assert_eq!(audio.inbound.capture_state, "capturing");
        assert_eq!(audio.inbound.last_error_code, None);
    }

    #[test]
    fn bridge_worker_failure_authority_follows_a_live_restart_rebind() {
        let old = ready_process_bridge_snapshot("old-session", 7);
        let context = BridgeSourceWorkerContext::new(3, old);
        let failure_context = context.clone();
        let mut new = ready_process_bridge_snapshot("new-session", 8);
        new.bridge_process_id = Some(43);
        new.bridge_instance_id = Some("instance-new-session".to_string());
        new.source_generation_token =
            Some("instance-new-session:new-session:8".to_string());

        context.rebind(new.clone());

        assert_eq!(failure_context.snapshot().bridge_process_id, Some(43));
        assert_eq!(
            failure_context.snapshot().session_id.as_deref(),
            Some("new-session")
        );
        assert_eq!(failure_context.snapshot().source_generation, 8);
    }

    #[test]
    fn current_bridge_worker_failure_marks_bridge_audio_and_watch_report_failed() {
        let audio_state = AudioStateStore::new();
        audio_state
            .watch_session_report
            .begin_or_reuse("process-exclusion", "watch-model");
        let route_generation = audio_state.bump_inbound_route_generation();
        audio_state.mark_route_started(
            "inbound",
            "current-watch-route",
            "system-output-default",
            r"\\.\pipe\omni-current-source",
        );
        let bridge_state = BridgeStateStore::new();
        let current_snapshot = ready_process_bridge_snapshot("current-session", 11);
        bridge_state.update_snapshot(|current| *current = current_snapshot.clone());
        let context = BridgeSourceWorkerContext::new(route_generation, current_snapshot);

        let notifications = Cell::new(0usize);
        let applied = commit_bridge_source_worker_error_if_current(
            &audio_state,
            &context,
            "inbound",
            "current capture failed",
            Some("bridge.process-loopback-capture-failed"),
            Some("select-audio-route"),
            || Some(()),
            |_| {
                apply_process_loopback_capture_failure_if_current(
                    &bridge_state,
                    &context,
                    "current capture failed",
                    None,
                )
            },
            || notifications.set(notifications.get() + 1),
        );

        assert!(applied);
        assert_eq!(notifications.get(), 1);
        let bridge = bridge_state.snapshot();
        assert_eq!(bridge.bridge_state, "degraded");
        assert_eq!(
            bridge.process_loopback_status,
            crate::bridge::contracts::ProcessLoopbackStatus::Failed
        );
        assert_eq!(
            bridge.last_error_code.as_deref(),
            Some("bridge.process-loopback-capture-failed")
        );
        let audio = audio_state.snapshot();
        assert_eq!(audio.inbound.capture_state, "buffering");
        assert_eq!(
            audio.inbound.last_error_code.as_deref(),
            Some("bridge.process-loopback-capture-failed")
        );
        let report = audio_state
            .watch_session_report
            .snapshot()
            .expect("active Watch report should retain the current failure");
        assert!(report.issues.iter().any(|issue| {
            issue.code == "bridge-process-loopback-capture-failed"
                && issue.severity == "error"
        }));
    }

    #[test]
    fn generation_bump_inside_query_phase_blocks_every_old_worker_side_effect() {
        let audio_state = AudioStateStore::new();
        audio_state
            .watch_session_report
            .begin_or_reuse("process-exclusion", "watch-model");
        let generation = audio_state.bump_inbound_route_generation();
        audio_state.mark_route_started(
            "inbound",
            "current-watch-route",
            "system-output-default",
            r"\\.\pipe\omni-current-source",
        );
        let context = BridgeSourceWorkerContext::new(
            generation,
            ready_process_bridge_snapshot("current-session", 11),
        );
        let bridge_commits = Cell::new(0usize);
        let notifications = Cell::new(0usize);

        let applied = commit_bridge_source_worker_error_if_current(
            &audio_state,
            &context,
            "inbound",
            "superseded capture failed",
            Some("bridge.process-loopback-capture-failed"),
            Some("select-audio-route"),
            || {
                audio_state.bump_inbound_route_generation();
                Some(())
            },
            |_| {
                bridge_commits.set(bridge_commits.get() + 1);
                true
            },
            || notifications.set(notifications.get() + 1),
        );

        assert!(!applied);
        assert_eq!(bridge_commits.get(), 0);
        assert_eq!(notifications.get(), 0);
        let audio = audio_state.snapshot();
        assert_eq!(audio.inbound.capture_state, "capturing");
        assert_eq!(audio.inbound.last_error_code, None);
        let report = audio_state.watch_session_report.snapshot().unwrap();
        assert!(report.issues.is_empty());
    }

    #[test]
    fn blocking_query_allows_concurrent_start_and_stop_to_revoke_old_worker_commit() {
        let audio_state = Arc::new(AudioStateStore::new());
        audio_state
            .watch_session_report
            .begin_or_reuse("process-exclusion", "watch-model");
        let generation = audio_state.bump_inbound_route_generation();
        audio_state.mark_route_started(
            "inbound",
            "current-watch-route",
            "system-output-default",
            r"\\.\pipe\omni-current-source",
        );
        let context = BridgeSourceWorkerContext::new(
            generation,
            ready_process_bridge_snapshot("current-session", 11),
        );
        let bridge_commits = Arc::new(AtomicUsize::new(0));
        let notifications = Arc::new(AtomicUsize::new(0));
        let (query_entered_tx, query_entered_rx) = mpsc::channel();
        let (query_release_tx, query_release_rx) = mpsc::channel();
        let worker_state = Arc::clone(&audio_state);
        let worker_bridge_commits = Arc::clone(&bridge_commits);
        let worker_notifications = Arc::clone(&notifications);

        let worker = thread::spawn(move || {
            commit_bridge_source_worker_error_if_current(
                &worker_state,
                &context,
                "inbound",
                "superseded capture failed",
                Some("bridge.process-loopback-capture-failed"),
                Some("select-audio-route"),
                || {
                    query_entered_tx.send(()).unwrap();
                    query_release_rx
                        .recv_timeout(Duration::from_secs(2))
                        .unwrap();
                    Some(())
                },
                |_| {
                    worker_bridge_commits.fetch_add(1, Ordering::SeqCst);
                    true
                },
                || {
                    worker_notifications.fetch_add(1, Ordering::SeqCst);
                },
            )
        });

        query_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        // These represent a new inbound start followed by stop. Both bumps,
        // and even the route pipeline lock, remain available while the old
        // worker's bounded Bridge query is blocked.
        assert_eq!(audio_state.bump_inbound_route_generation(), generation + 1);
        assert_eq!(audio_state.bump_inbound_route_generation(), generation + 2);
        let pipeline = audio_state.lock_inbound_pipeline();
        drop(pipeline);
        query_release_tx.send(()).unwrap();

        assert!(!worker.join().unwrap());
        assert_eq!(bridge_commits.load(Ordering::SeqCst), 0);
        assert_eq!(notifications.load(Ordering::SeqCst), 0);
        let audio = audio_state.snapshot();
        assert_eq!(audio.inbound.capture_state, "capturing");
        assert_eq!(audio.inbound.last_error_code, None);
        let report = audio_state.watch_session_report.snapshot().unwrap();
        assert!(report.issues.is_empty());
    }

    #[test]
    fn audio_state_preserves_completed_subtitle_history() {
        let store = AudioStateStore::new();
        for index in 0..16 {
            store.push_subtitle_cue(SubtitleCueRuntime {
                cue_id: format!("cue-{index}"),
                revision: None,
                sequence: None,
                route_direction: "inbound".to_string(),
                source_text: format!("source-{index}"),
                display_source_text: String::new(),
                display_segments: Vec::new(),
                translated_text: format!("translated-{index}"),
                started_at: "unix-ms:1".to_string(),
                ended_at: "unix-ms:2".to_string(),
                committed: true,
                translation_committed: true,
                translation_state: Some(SubtitleTranslationStateRuntime::Final),
            });
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.subtitle_overlay.recent_cues.len(), 16);
        assert_eq!(snapshot.subtitle_overlay.queue_depth, 16);
        assert_eq!(snapshot.subtitle_overlay.dropped_cue_count, 0);
    }
}
