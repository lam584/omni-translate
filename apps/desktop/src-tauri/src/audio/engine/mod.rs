use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use wasapi::{
    initialize_mta, Device, DeviceEnumerator, Direction, Role, SampleType, StreamMode, WaveFormat,
};

use super::diagnostics::{diag_log, diag_log_detail};
use crate::common::MapErrToString;
use crate::runtime::events::emit_runtime_snapshot;
use crate::runtime::state::RuntimeStateStore;

use super::contracts::{AudioDeviceRuntime, AudioRuntimeSnapshot, SubtitleCueRuntime};
use super::events::AUDIO_RUNTIME_SNAPSHOT_EVENT;
use super::state::{AudioRouteHandle, AudioStateStore, CapturedSegmentAudio};
use super::time_utils::{ms_marker, now_marker, unix_ms};
use crate::bridge::contracts::BridgeTranslationFrameHeader;
use crate::bridge::ipc::check_bridge_health;
use crate::bridge::state::BridgeStateStore;

mod retry;
mod samples;

use self::retry::{
    with_audio_init_retry, AudioInitError, RetryAction, AUDIO_INIT_BASE_DELAY_MS,
    AUDIO_INIT_MAX_RETRIES, AUDIO_MAX_DEVICE_FALLBACK, DEVICE_INIT_TIMEOUT_SECS,
};
use self::samples::{
    bytes_to_f32_stereo, calculate_chunk_db, drain_sample_chunks, f32_stereo_to_bytes,
    pcm16le_to_f32le,
};

const SAMPLE_RATE_HZ: usize = 48_000;
const CHANNEL_COUNT: usize = 2;
const CHUNK_FRAMES: usize = 960;
const SPEECH_THRESHOLD_DB: f32 = -42.0;
const SILENCE_HOLD_CHUNKS: usize = 6;
const ECHO_CANCEL_DELAY_SAMPLES: usize = 9_600;
const BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS: u64 = 15;
pub fn bootstrap_audio_runtime(
    app: &AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    let (render_devices, capture_devices) = enumerate_devices()?;
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
        if let Err(error) = check_bridge_health(&bridge_snapshot.pipe_path) {
            diag_log_detail(
                &app,
                "audio",
                "warning",
                "Bridge health check failed before starting inbound audio route.",
                error.clone(),
            );
            return Err(format!(
                "Bridge Service is not responding: {}. Please restart the bridge service before starting the audio route.",
                error
            ));
        }
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
            if let Err(error) = run_route_worker(
                app_handle.clone(),
                &audio_state,
                &route_direction,
                worker_spec,
                stop_rx,
                stt_sender,
                Some(init_done_for_worker),
            ) {
                let (message, recommended_action) =
                    if let Some(pos) = error.find(" | recommended: ") {
                        let msg = error[..pos].to_string();
                        let action = error[pos + " | recommended: ".len()..].to_string();
                        (msg, Some(action))
                    } else {
                        (error.clone(), None)
                    };
                audio_state.mark_route_error(&route_direction, message, recommended_action);
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

pub fn emit_audio_snapshot(app: &AppHandle, store: &AudioStateStore) -> Result<(), String> {
    app.emit(AUDIO_RUNTIME_SNAPSHOT_EVENT, store.snapshot())
        .map_err_str()?;
    if let Some(runtime_state) = app.try_state::<RuntimeStateStore>() {
        emit_runtime_snapshot(app, &runtime_state).map_err_str()?;
    }
    Ok(())
}

fn enumerate_devices() -> Result<(Vec<AudioDeviceRuntime>, Vec<AudioDeviceRuntime>), String> {
    let _ = initialize_mta().ok();
    let enumerator = DeviceEnumerator::new().map_err_str()?;

    let default_render_id = enumerator
        .get_default_device_for_role(&Direction::Render, &Role::Console)
        .ok()
        .and_then(|device| device.get_id().ok());
    let default_capture_id = enumerator
        .get_default_device_for_role(&Direction::Capture, &Role::Communications)
        .ok()
        .and_then(|device| device.get_id().ok())
        .or_else(|| {
            enumerator
                .get_default_device(&Direction::Capture)
                .ok()
                .and_then(|device| device.get_id().ok())
        });

    let render_devices = collect_direction_devices(
        &enumerator,
        &Direction::Render,
        default_render_id.as_deref(),
    )?;
    let capture_devices = collect_direction_devices(
        &enumerator,
        &Direction::Capture,
        default_capture_id.as_deref(),
    )?;
    Ok((render_devices, capture_devices))
}

fn collect_direction_devices(
    enumerator: &DeviceEnumerator,
    direction: &Direction,
    default_device_id: Option<&str>,
) -> Result<Vec<AudioDeviceRuntime>, String> {
    let collection = enumerator.get_device_collection(direction).map_err_str()?;
    let mut devices = Vec::new();
    for device_result in &collection {
        let device = device_result.map_err_str()?;
        let device_id = device.get_id().map_err_str()?;
        devices.push(AudioDeviceRuntime {
            device_id: device_id.clone(),
            label: device
                .get_friendlyname()
                .unwrap_or_else(|_| "Unknown Device".to_string()),
            interface_name: device
                .get_interface_friendlyname()
                .unwrap_or_else(|_| "Unknown Interface".to_string()),
            direction: if *direction == Direction::Render {
                "render".to_string()
            } else {
                "capture".to_string()
            },
            is_default: default_device_id == Some(device_id.as_str()),
            state: format!(
                "{:?}",
                device
                    .get_state()
                    .unwrap_or(wasapi::DeviceState::NotPresent)
            ),
        });
    }
    Ok(devices)
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

fn run_route_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    if direction == "inbound" && spec.feedback_loop_prevention == "virtual-driver" {
        return run_bridge_source_route_worker(
            app, store, direction, spec, stop_rx, stt_sender, init_done,
        );
    }

    let init_start = Instant::now();
    let _ = initialize_mta().ok();

    let device_fallback_ids: Vec<String> =
        if direction == "inbound" && spec.feedback_loop_prevention != "virtual-driver" {
            let enumerator = DeviceEnumerator::new().map_err_str()?;
            let default_id = enumerator
                .get_default_device(&Direction::Render)
                .ok()
                .and_then(|d| d.get_id().ok())
                .unwrap_or_default();
            let mut ids = collect_render_device_ids(&enumerator).unwrap_or_default();
            if !ids.is_empty() && ids[0] != default_id {
                ids.retain(|id| id != &default_id);
                ids.insert(0, default_id);
            }
            ids
        } else {
            Vec::new()
        };
    let mut device_fallback_index = 0usize;
    let using_device_fallback = !device_fallback_ids.is_empty();

    let mut full_retry_count = 0usize;
    let (
        _device,
        effective_device_id,
        audio_client,
        capture_client,
        event_handle,
        buffer_frame_count,
        desired_format,
    ) = 'outer: loop {
        let enumerator = DeviceEnumerator::new().map_err_str()?;
        let device = if using_device_fallback && device_fallback_index < device_fallback_ids.len() {
            let target_id = &device_fallback_ids[device_fallback_index];
            match find_device_by_id(&enumerator, &spec.wasapi_direction(), target_id) {
                Some(d) => d,
                None => {
                    device_fallback_index += 1;
                    full_retry_count = 0;
                    continue 'outer;
                }
            }
        } else {
            pick_device(&enumerator, &spec).map_err_str()?
        };
        let effective_device_id = device.get_id().map_err_str()?;
        let device_state = device
            .get_state()
            .map(|s| format!("{:?}", s))
            .unwrap_or_else(|_| "Unknown".to_string());
        let device_label = device
            .get_friendlyname()
            .unwrap_or_else(|_| "Unknown".to_string());

        diag_log_detail(
            &app,
            "audio",
            "debug",
            format!(
                "尝试初始化设备: {} (id={} state={})",
                device_label, effective_device_id, device_state
            ),
            format!("direction={}", direction),
        );

        let mut audio_client = match with_audio_init_retry(
            device.get_iaudioclient(),
            &app,
            direction,
            &effective_device_id,
            "获取 AudioClient 失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(client) => client,
            Err(RetryAction::Retry) => {
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };

        let desired_format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            SAMPLE_RATE_HZ,
            CHANNEL_COUNT,
            None,
        );
        let (_, min_time) = match with_audio_init_retry(
            audio_client.get_device_period(),
            &app,
            direction,
            &effective_device_id,
            "获取设备周期失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(period) => period,
            Err(RetryAction::Retry) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: min_time,
        };

        let mut init_retry_count = 0usize;
        let init_result = loop {
            match audio_client.initialize_client(&desired_format, &spec.capture_direction(), &mode)
            {
                Ok(()) => break Ok(()),
                Err(error) => {
                    let classified = AudioInitError::from_string(error.to_string());
                    if classified.is_retriable() && init_retry_count < AUDIO_INIT_MAX_RETRIES {
                        init_retry_count += 1;
                        let delay_ms =
                            AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((init_retry_count - 1) as u32);
                        diag_log_detail(
                            &app,
                            "audio",
                            "debug",
                            format!(
                                "初始化客户端失败 ({}/{} 次重试)，{}ms 后重试...",
                                init_retry_count, AUDIO_INIT_MAX_RETRIES, delay_ms
                            ),
                            format!("direction={} device={}", direction, effective_device_id),
                        );
                        thread::sleep(Duration::from_millis(delay_ms));
                        continue;
                    }
                    if classified.is_retriable() && full_retry_count < AUDIO_INIT_MAX_RETRIES {
                        full_retry_count += 1;
                        let delay_ms =
                            AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32);
                        diag_log_detail(
                            &app,
                            "audio",
                            "debug",
                            format!(
                                "初始化客户端失败（内层耗尽），全链路 {}/{} 次重试，{}ms 后重试...",
                                full_retry_count, AUDIO_INIT_MAX_RETRIES, delay_ms
                            ),
                            format!(
                                "direction={} device={} error={}",
                                direction,
                                effective_device_id,
                                classified.message()
                            ),
                        );
                        drop(audio_client);
                        drop(device);
                        drop(enumerator);
                        thread::sleep(Duration::from_millis(delay_ms));
                        continue 'outer;
                    }
                    if classified.is_retriable()
                        && using_device_fallback
                        && device_fallback_index + 1 < device_fallback_ids.len()
                    {
                        device_fallback_index += 1;
                        full_retry_count = 0;
                        diag_log_detail(
                            &app,
                            "audio",
                            "debug",
                            format!(
                                "当前设备初始化失败（{}），切换到备用设备重试...",
                                classified.message()
                            ),
                            format!("direction={}", direction),
                        );
                        drop(audio_client);
                        drop(device);
                        drop(enumerator);
                        thread::sleep(Duration::from_millis(500));
                        continue 'outer;
                    }
                    break Err(classified);
                }
            }
        };

        match init_result {
            Ok(()) => {}
            Err(classified) => {
                diag_log_detail(
                    &app,
                    "audio",
                    "warning",
                    format!("音频采集初始化最终失败: {}", classified.message()),
                    format!(
                        "direction={} recommended={}",
                        direction,
                        classified.recommended_action()
                    ),
                );
                break Err(format!(
                    "{} | recommended: {}",
                    classified.message(),
                    classified.recommended_action()
                ));
            }
        }

        let event_handle = match with_audio_init_retry(
            audio_client.set_get_eventhandle(),
            &app,
            direction,
            &effective_device_id,
            "获取事件句柄失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(handle) => handle,
            Err(RetryAction::Retry) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };
        let buffer_frame_count = match with_audio_init_retry(
            audio_client.get_buffer_size(),
            &app,
            direction,
            &effective_device_id,
            "获取缓冲区大小失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(count) => count,
            Err(RetryAction::Retry) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };
        let capture_client = match audio_client.get_audiocaptureclient() {
            Ok(client) => client,
            Err(error) => {
                let classified = AudioInitError::from_string(error.to_string());
                if using_device_fallback && device_fallback_index + 1 < device_fallback_ids.len() {
                    let current_label = device
                        .get_friendlyname()
                        .unwrap_or_else(|_| "Unknown".to_string());
                    device_fallback_index += 1;
                    full_retry_count = 0;
                    let next_id = &device_fallback_ids[device_fallback_index];
                    diag_log_detail(
                        &app,
                        "audio",
                        "debug",
                        format!(
                            "设备 \"{}\" 不支持 Loopback 采集（{}），切换到备用设备 {} ...",
                            current_label,
                            classified.message(),
                            next_id
                        ),
                        format!("direction={}", direction),
                    );
                    drop(audio_client);
                    drop(device);
                    drop(enumerator);
                    thread::sleep(Duration::from_millis(500));
                    continue 'outer;
                }
                if classified.is_retriable() && full_retry_count < AUDIO_INIT_MAX_RETRIES {
                    full_retry_count += 1;
                    let delay_ms =
                        AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32);
                    diag_log_detail(
                        &app,
                        "audio",
                        "debug",
                        format!(
                            "获取采集客户端失败 ({}/{} 次重试)，{}ms 后重试...",
                            full_retry_count, AUDIO_INIT_MAX_RETRIES, delay_ms
                        ),
                        format!(
                            "direction={} device={} error={}",
                            direction,
                            effective_device_id,
                            classified.message()
                        ),
                    );
                    drop(audio_client);
                    drop(device);
                    drop(enumerator);
                    thread::sleep(Duration::from_millis(delay_ms));
                    continue;
                }
                diag_log_detail(
                    &app,
                    "audio",
                    "warning",
                    format!("音频采集初始化最终失败: {}", classified.message()),
                    format!(
                        "direction={} recommended={}",
                        direction,
                        classified.recommended_action()
                    ),
                );
                break Err(format!(
                    "{} | recommended: {}",
                    classified.message(),
                    classified.recommended_action()
                ));
            }
        };

        break Ok((
            device,
            effective_device_id,
            audio_client,
            capture_client,
            event_handle,
            buffer_frame_count,
            desired_format,
        ));
    }?;

    if let Some(ref flag) = init_done {
        flag.store(true, Ordering::Relaxed);
    }
    let init_elapsed = init_start.elapsed();
    if init_elapsed.as_secs() >= 2 {
        diag_log_detail(
            &app,
            "audio",
            "info",
            format!("设备初始化完成（耗时 {:.1}s）", init_elapsed.as_secs_f64(),),
            format!("direction={} device={}", direction, effective_device_id),
        );
    }

    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(
        100 * desired_format.get_blockalign() as usize * (1024 + 2 * buffer_frame_count as usize),
    );
    let mut processor = RouteProcessor::new(spec.clone());

    store.mark_route_started(
        direction,
        &spec.route_id,
        &spec.requested_device_id,
        &effective_device_id,
    );
    emit_audio_snapshot(&app, store)?;

    audio_client.start_stream().map_err_str()?;
    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = audio_client.stop_stream();
            break;
        }

        capture_client
            .read_from_device_to_deque(&mut sample_queue)
            .map_err_str()?;

        let chunk_len = desired_format.get_blockalign() as usize * CHUNK_FRAMES;
        for chunk in drain_sample_chunks(&mut sample_queue, chunk_len) {
            let chunk = if spec.echo_cancel_enabled() {
                let f32_chunk = bytes_to_f32_stereo(&chunk);
                let cleaned = store.subtract_echo(&f32_chunk, ECHO_CANCEL_DELAY_SAMPLES);
                f32_stereo_to_bytes(&cleaned)
            } else {
                chunk
            };

            process_captured_chunk(
                &app,
                store,
                direction,
                &mut processor,
                &stt_sender,
                chunk,
                sample_queue.len(),
            )?;
        }

        let _ = event_handle.wait_for_event(500);
    }

    Ok(())
}

fn run_bridge_source_route_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let bridge_snapshot = app.state::<BridgeStateStore>().snapshot();
    let mut processor = RouteProcessor::new(spec);
    let mut sample_queue = VecDeque::new();
    let mut initialized = false;
    let init_start = Instant::now();
    let mut last_not_ready_log_at = None;
    let mut reconnect_started_at: Option<Instant> = None;
    let mut heartbeat_count = 0_u64;
    let mut pcm_frame_count = 0_u64;
    let mut pcm_bytes = 0_u64;
    let mut ignored_envelope_count = 0_u64;
    let mut last_pcm_at: Option<Instant> = None;
    let mut last_summary_at = Instant::now();
    let mut first_heartbeat_logged = false;
    let mut first_pcm_logged = false;
    loop {
        let mut source_pipe = loop {
            if stop_rx.try_recv().is_ok() {
                return Ok(());
            }
            match OpenOptions::new()
                .read(true)
                .open(&bridge_snapshot.source_pipe_path)
            {
                Ok(pipe) => break pipe,
                Err(error) => {
                    let elapsed = init_start.elapsed();
                    if last_not_ready_log_at
                        .map(|logged_at: Instant| logged_at.elapsed() >= Duration::from_secs(2))
                        .unwrap_or(true)
                    {
                        diag_log_detail(
                            &app,
                            "audio",
                            "warning",
                            "Bridge source pipe is not ready.",
                            error.to_string(),
                        );
                        last_not_ready_log_at = Some(Instant::now());
                    }
                    if !initialized {
                        if let Some(timeout_error) = bridge_source_timeout_error(elapsed) {
                            return Err(timeout_error);
                        }
                    } else if reconnect_started_at.is_none() {
                        reconnect_started_at = Some(Instant::now());
                        diag_log_detail(
                            &app,
                            "audio",
                            "warning",
                            "Bridge source reconnection started.",
                            format!("timeoutSecs={}", BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS),
                        );
                    }
                    thread::sleep(Duration::from_millis(250));
                }
            }
        };
        if !initialized {
            diag_log_detail(
                &app,
                "audio",
                "info",
                "event=bridge_source_pipe_connected",
                format!("pipe={}", bridge_snapshot.source_pipe_path),
            );
            if let Some(ref flag) = init_done {
                flag.store(true, Ordering::Relaxed);
            }
            store.mark_route_started(
                direction,
                &processor.spec.route_id,
                &processor.spec.requested_device_id,
                &bridge_snapshot.source_pipe_path,
            );
            emit_audio_snapshot(&app, store)?;
            initialized = true;
        } else if reconnect_started_at.is_some() {
            reconnect_started_at = None;
            diag_log_detail(
                &app,
                "audio",
                "info",
                "event=bridge_source_pipe_reconnected",
                format!("pipe={}", bridge_snapshot.source_pipe_path),
            );
        }
        loop {
            if stop_rx.try_recv().is_ok() {
                return Ok(());
            }
            let payload = match read_bridge_source_payload(&mut source_pipe) {
                Ok(BridgeSourceEnvelope::Frame(payload)) => {
                    pcm_frame_count += 1;
                    pcm_bytes += payload.len() as u64;
                    last_pcm_at = Some(Instant::now());
                    if !first_pcm_logged {
                        diag_log_detail(
                            &app,
                            "audio",
                            "info",
                            "event=bridge_source_first_pcm",
                            format!(
                                "frameCount={} payloadBytes={}",
                                pcm_frame_count,
                                payload.len()
                            ),
                        );
                        first_pcm_logged = true;
                    }
                    payload
                }
                Ok(BridgeSourceEnvelope::Heartbeat) => {
                    heartbeat_count += 1;
                    if !first_heartbeat_logged {
                        diag_log_detail(
                            &app,
                            "audio",
                            "info",
                            "event=bridge_source_first_heartbeat",
                            "payloadBytes=0".to_string(),
                        );
                        first_heartbeat_logged = true;
                    }
                    log_bridge_source_consumer_summary(
                        &app,
                        &mut last_summary_at,
                        heartbeat_count,
                        pcm_frame_count,
                        pcm_bytes,
                        ignored_envelope_count,
                        last_pcm_at,
                    );
                    continue;
                }
                Ok(BridgeSourceEnvelope::Ignored(reason)) => {
                    ignored_envelope_count += 1;
                    diag_log_detail(
                        &app,
                        "audio",
                        "warning",
                        "event=bridge_source_envelope_ignored",
                        reason,
                    );
                    continue;
                }
                Err(error) => {
                    sample_queue.clear();
                    diag_log_detail(
                        &app,
                        "audio",
                        "warning",
                        "Bridge source pipe disconnected. Reconnecting.",
                        error,
                    );
                    if let Some(reconnect_start) = reconnect_started_at {
                        let reconnect_elapsed = reconnect_start.elapsed();
                        if reconnect_elapsed >= Duration::from_secs(BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS) {
                            return Err(format!(
                                "Bridge source pipe reconnection timed out after {}s. The bridge process may be a zombie. | recommended: restart-bridge",
                                BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS
                            ));
                        }
                    }
                    break;
                }
            };
            log_bridge_source_consumer_summary(
                &app,
                &mut last_summary_at,
                heartbeat_count,
                pcm_frame_count,
                pcm_bytes,
                ignored_envelope_count,
                last_pcm_at,
            );
            sample_queue.extend(pcm16le_to_f32le(&payload));
            let chunk_len = CHUNK_FRAMES * CHANNEL_COUNT * std::mem::size_of::<f32>();
            for chunk in drain_sample_chunks(&mut sample_queue, chunk_len) {
                process_captured_chunk(
                    &app,
                    store,
                    direction,
                    &mut processor,
                    &stt_sender,
                    chunk,
                    sample_queue.len(),
                )?;
            }
        }
    }
}

fn log_bridge_source_consumer_summary(
    app: &AppHandle,
    last_summary_at: &mut Instant,
    heartbeat_count: u64,
    pcm_frame_count: u64,
    pcm_bytes: u64,
    ignored_envelope_count: u64,
    last_pcm_at: Option<Instant>,
) {
    if last_summary_at.elapsed() < Duration::from_secs(5) {
        return;
    }
    diag_log_detail(
        app,
        "audio",
        "info",
        "event=bridge_source_consumer_summary",
        format!(
            "heartbeats={} pcmFrames={} pcmBytes={} ignoredEnvelopes={} lastPcmAgeMs={}",
            heartbeat_count,
            pcm_frame_count,
            pcm_bytes,
            ignored_envelope_count,
            last_pcm_at
                .map(|timestamp| timestamp.elapsed().as_millis().to_string())
                .unwrap_or_else(|| "none".to_string()),
        ),
    );
    *last_summary_at = Instant::now();
}

fn bridge_source_timeout_error(elapsed: Duration) -> Option<String> {
    (elapsed >= Duration::from_secs(DEVICE_INIT_TIMEOUT_SECS)).then(|| {
        format!(
            "Bridge source pipe initialization timed out ({}s). | recommended: restart-bridge",
            DEVICE_INIT_TIMEOUT_SECS
        )
    })
}

#[derive(Debug, PartialEq)]
enum BridgeSourceEnvelope {
    Frame(Vec<u8>),
    Heartbeat,
    Ignored(String),
}

fn read_bridge_source_payload(source_pipe: &mut impl Read) -> Result<BridgeSourceEnvelope, String> {
    let mut header_size = [0_u8; 4];
    source_pipe
        .read_exact(&mut header_size)
        .map_err(|error| format!("Bridge source header size read failed: {error}"))?;
    let header_size = u32::from_le_bytes(header_size) as usize;
    if header_size == 0 || header_size > 64 * 1024 {
        return Err("Bridge source header size is invalid.".to_string());
    }
    let mut header_bytes = vec![0_u8; header_size];
    source_pipe
        .read_exact(&mut header_bytes)
        .map_err(|error| format!("Bridge source header read failed: {error}"))?;
    let header: BridgeTranslationFrameHeader =
        serde_json::from_slice(&header_bytes).map_err_str()?;
    let mut payload = vec![0_u8; header.payload_bytes];
    source_pipe
        .read_exact(&mut payload)
        .map_err(|error| format!("Bridge source payload read failed: {error}"))?;
    if header.event_type == "bridge.source.heartbeat" {
        return Ok(BridgeSourceEnvelope::Heartbeat);
    }
    if header.event_type != "bridge.source.frame" {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=unexpected-event-type eventType={}",
            header.event_type
        )));
    }
    if header.sample_rate_hz != SAMPLE_RATE_HZ as u32 {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=sample-rate-mismatch actual={} expected={}",
            header.sample_rate_hz, SAMPLE_RATE_HZ
        )));
    }
    if header.channel_count != CHANNEL_COUNT as u16 {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=channel-count-mismatch actual={} expected={}",
            header.channel_count, CHANNEL_COUNT
        )));
    }
    Ok(BridgeSourceEnvelope::Frame(payload))
}

fn process_captured_chunk(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    processor: &mut RouteProcessor,
    stt_sender: &Option<mpsc::Sender<Vec<u8>>>,
    chunk: Vec<u8>,
    queued_bytes: usize,
) -> Result<(), String> {
    if let Some(stt_tx) = stt_sender {
        if let Err(error) = stt_tx.send(chunk.clone()) {
            let message = format!("audio route sender unavailable for {direction}: {error}");
            let _ = diag_log_detail(
                app,
                "audio",
                "error",
                "watch_mode.omni_sender_unavailable",
                format!("direction={direction} error={error}"),
            );
            return Err(format!("{message} | recommended: restart-route"));
        }
    }
    let update = processor.ingest_chunk(&chunk, queued_bytes);
    store.update_route_metrics(
        direction,
        &update.capture_state,
        &update.pre_buffer_state,
        &update.vad_state,
        update.buffer_ahead_ms,
        update.frames_captured,
        update.last_energy_db,
        Some(now_marker()),
        update.active_segment_id.clone(),
    );
    if let Some(segment) = update.finalized_segment {
        store.increment_segment_count(direction);
        store.cache_segment_audio(segment.audio);
        if direction != "inbound" {
            store.push_subtitle_cue(segment.cue);
        }
    }
    emit_audio_snapshot(app, store)
}

#[derive(Clone)]
struct RouteSpec {
    route_id: String,
    direction: String,
    requested_device_id: String,
    #[allow(dead_code)]
    source_language: String,
    #[allow(dead_code)]
    target_language: String,
    skip_local_vad: bool,
    feedback_loop_prevention: String,
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
        let requested_device_id =
            if direction == "inbound" && feedback_loop_prevention == "virtual-driver" {
                config.pointer("/devices/virtualRenderDeviceId")
            } else {
                config.pointer(&format!("{route_prefix}/input/deviceId"))
            }
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
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
        let model = config
            .pointer("/provider/model")
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
        })
    }

    fn echo_cancel_enabled(&self) -> bool {
        self.direction == "inbound" && self.feedback_loop_prevention == "echo-cancel"
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
