use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::num::{NonZeroU16, NonZeroU32};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use omni_bridge_service::{
    accepted_audio_frame_ack, classify_driver_health_with_device_evidence, decode_pcm16le,
    mix_for_monitor, should_exit_after_control_command, singleton_mutex_name,
    validate_translation_frame, AudioFrameHeader, AudioFramePacer, DriverInstallState, MixControl,
    BRIDGE_PROTOCOL_VERSION, INTERNAL_CHANNEL_COUNT, INTERNAL_SAMPLE_RATE_HZ,
};
use rodio::{buffer::SamplesBuffer, DeviceSinkBuilder, MixerDeviceSink, Player};
use serde_json::{json, Value};
use wasapi::{
    initialize_mta, Device, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::System::IO::DeviceIoControl;

mod win32;

use self::win32::{
    flush_file_buffers, read_exact, read_line, serve_named_pipe, wide_string, write_all,
    write_framed_json,
};

trait MapErrToString<T> {
    fn map_err_str(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> MapErrToString<T> for Result<T, E> {
    fn map_err_str(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

const OMNI_BRIDGE_DEVICE_PATH: &str = r"\\.\OmniTranslateVirtualAudio";
const OMNI_SOURCE_CHUNK_BYTES: usize = 960 * INTERNAL_CHANNEL_COUNT as usize * 2;
const OMNI_SOURCE_FRAME_INTERVAL_MS: u64 = 20;
const OMNI_SOURCE_QUEUE_CAPACITY: usize = 5;
const OMNI_MONITOR_SOURCE_QUEUE_CAPACITY: usize = 25;
const OMNI_MONITOR_SOURCE_BATCH_FRAMES: usize = 4_800;
const OMNI_SOURCE_STALE_AFTER_MS: u64 = 500;
const OMNI_SOURCE_SUMMARY_INTERVAL_SECS: u64 = 5;
#[allow(dead_code)]
const OMNI_CAPTURE_DIAGNOSTICS_INTERVAL_SECS: u64 = 5;
#[allow(dead_code)]
const OMNI_SOURCE_RESTART_BACKOFF_MS: [u64; 4] = [250, 500, 1_000, 2_000];
const MONITOR_VIRTUAL_PLAYBACK_LOOP: &str = "monitor.virtual-playback-loop";
const FILE_DEVICE_OMNI_TRANSLATE: u32 = 0x8337;
const METHOD_BUFFERED: u32 = 0;
const FILE_READ_DATA: u32 = 0x0001;
const FILE_WRITE_DATA: u32 = 0x0002;
const IOCTL_OMNI_BRIDGE_READ_PCM: u32 =
    (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_READ_DATA << 14) | (0x800 << 2) | METHOD_BUFFERED;
const IOCTL_OMNI_BRIDGE_QUERY_STATUS: u32 =
    (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_READ_DATA << 14) | (0x801 << 2) | METHOD_BUFFERED;
const IOCTL_OMNI_BRIDGE_RESET: u32 =
    (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_WRITE_DATA << 14) | (0x802 << 2) | METHOD_BUFFERED;

#[repr(C)]
#[derive(Default)]
struct DriverStatus {
    abi_version: u32,
    ring_capacity_bytes: u32,
    buffered_bytes: u32,
    max_buffered_bytes: u32,
    captured_bytes: u64,
    delivered_bytes: u64,
    dropped_bytes: u64,
    render_streams_created: u64,
    render_run_transitions: u64,
    render_set_write_packet_calls: u64,
    render_read_bytes_calls: u64,
    loopback_capture_read_calls: u64,
}

const DRIVER_STATUS_BASE_SIZE: u32 = 40;

#[derive(Default)]
struct BridgeState {
    session_id: Option<String>,
    bridge_state: String,
    lifecycle_state: String,
    driver_health: String,
    driver_version: Option<String>,
    bridge_version: String,
    virtual_render_device_id: String,
    physical_playback_device_id: String,
    resolved_physical_playback_device_id: String,
    physical_playback_level: u64,
    monitor_playback_enabled: bool,
    monitor_playback_state: String,
    mix_control: MixControl,
    queued_frames: usize,
    source_frames_captured: u64,
    translated_frames_accepted: u64,
    playback_frames_written: u64,
    underrun_count: u64,
    dropped_frame_count: u64,
    driver_buffered_bytes: u64,
    driver_max_buffered_bytes: u64,
    driver_captured_bytes: u64,
    driver_delivered_bytes: u64,
    driver_dropped_bytes: u64,
    source_pending_bytes: usize,
    source_pacer_queued_frames: usize,
    monitor_source_queued_frames: usize,
    stale_source_frames_dropped: u64,
    source_subscriber_active: bool,
    source_generation: u64,
    source_worker_phase: String,
    source_worker_last_progress_timestamp_ms: Option<u64>,
    source_read_calls: u64,
    source_zero_byte_reads: u64,
    source_bytes_read: u64,
    source_released_frames: u64,
    capture_restart_count: u64,
    capture_packet_count: u64,
    capture_frames_received: u64,
    capture_peak: f32,
    capture_rms: f32,
    capture_silent_packet_count: u64,
    capture_invalid_sample_count: u64,
    monitor_underrun_count: u64,
    monitor_overrun_count: u64,
    last_frame_timestamp_ms: Option<u64>,
    last_error_code: Option<String>,
}

impl BridgeState {
    fn new(bridge_version: String) -> Self {
        Self {
            bridge_state: "stopped".to_string(),
            lifecycle_state: "idle".to_string(),
            driver_health: "not-installed".to_string(),
            bridge_version,
            monitor_playback_state: "idle".to_string(),
            source_worker_phase: "starting".to_string(),
            mix_control: MixControl::default(),
            ..Self::default()
        }
    }

    fn update_progress(&mut self, phase: &str) {
        self.source_worker_phase = phase.to_string();
        self.source_worker_last_progress_timestamp_ms = Some(unix_ms());
    }

    fn set_error(&mut self, phase: &str, error: String) {
        self.update_progress(phase);
        self.last_error_code = Some(error);
    }
}

struct PlaybackJob {
    samples: Vec<f32>,
    device_id: String,
    volume: f32,
    source_frame: bool,
    ducking_enabled: bool,
    ducking_depth_percent: u64,
    queued_at: Instant,
    source_generation: u64,
}

enum PlaybackCommand {
    Play(PlaybackJob),
    FlushSource,
}

struct PlaybackOutput {
    device_id: String,
    resolved_device_id: String,
    _sink: MixerDeviceSink,
    source_player: Player,
    translation_player: Player,
    source_pending_samples: Vec<f32>,
    duck_until: Option<Instant>,
}

struct RuntimePidFile {
    path: PathBuf,
}

struct SingletonMutex {
    handle: HANDLE,
}

impl Drop for SingletonMutex {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

impl Drop for RuntimePidFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let pipe_name = read_arg(&args, "--pipe-name").unwrap_or_else(|| "omni-bridge-ipc".into());
    let runtime_root = read_arg(&args, "--runtime-root").unwrap_or_else(|| ".".to_string());
    let bridge_version = read_arg(&args, "--bridge-version").unwrap_or_else(|| "0.1.0".to_string());
    let _singleton_mutex = acquire_singleton_mutex(&pipe_name)?;
    let runtime_root_path = PathBuf::from(&runtime_root);
    let pid_file = write_runtime_pid_file(&runtime_root_path)?;
    let control_pipe = format!(r"\\.\pipe\{pipe_name}");
    let audio_pipe = format!(r"\\.\pipe\{pipe_name}-audio");
    let source_pipe = format!(r"\\.\pipe\{pipe_name}-source");
    let state = Arc::new(Mutex::new(BridgeState::new(bridge_version)));
    let (playback_tx, playback_rx) = mpsc::sync_channel::<PlaybackCommand>(128);
    let (source_tx, source_rx) = mpsc::sync_channel::<Vec<u8>>(32);
    let playback_state = state.clone();
    thread::spawn(move || run_playback_worker(playback_rx, playback_state));
    let driver_source_state = state.clone();
    let driver_source_playback_tx = playback_tx.clone();
    let driver_source_runtime_root = runtime_root_path.clone();
    thread::spawn(move || {
        run_driver_source_worker(
            driver_source_state,
            driver_source_runtime_root,
            driver_source_playback_tx,
            source_tx,
        )
    });
    let watchdog_state = state.clone();
    let watchdog_runtime_root = runtime_root_path.clone();
    thread::spawn(move || run_source_watchdog(watchdog_state, watchdog_runtime_root));
    let audio_state = state.clone();
    let audio_playback_tx = playback_tx.clone();
    let audio_runtime_root = runtime_root_path.clone();
    let audio_pipe_clone = audio_pipe.clone();
    thread::spawn(move || {
        serve_named_pipe(&audio_pipe_clone, move |handle| {
            handle_audio_client(
                handle,
                &audio_state,
                &audio_runtime_root,
                &audio_playback_tx,
            )
        });
    });
    let source_state = state.clone();
    let source_rx = Arc::new(Mutex::new(source_rx));
    let source_pipe_clone = source_pipe.clone();
    let source_playback_tx = playback_tx.clone();
    let source_runtime_root = runtime_root_path.clone();
    thread::spawn(move || {
        serve_named_pipe(&source_pipe_clone, move |handle| {
            handle_source_subscriber(
                handle,
                &source_state,
                &source_rx,
                &source_playback_tx,
                &source_runtime_root,
            )
        });
    });
    println!(
        "{}",
        json!({
            "type": "bridge-service.ready",
            "pipePath": control_pipe,
            "audioPipePath": audio_pipe,
            "sourcePipePath": source_pipe,
            "runtimeRoot": runtime_root,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        })
    );
    serve_named_pipe(&control_pipe, move |handle| {
        handle_control_client(
            handle,
            &state,
            &playback_tx,
            Path::new(&runtime_root),
            &pid_file.path,
        )
    });
    Ok(())
}

fn acquire_singleton_mutex(pipe_name: &str) -> Result<SingletonMutex, String> {
    let name = wide_string(&singleton_mutex_name(pipe_name));
    let handle = unsafe { CreateMutexW(ptr::null_mut(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(format!(
            "bridge.singleton-create-failed: {}",
            io::Error::last_os_error()
        ));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            CloseHandle(handle);
        }
        return Err("bridge.singleton-already-running".to_string());
    }
    Ok(SingletonMutex { handle })
}

fn write_runtime_pid_file(runtime_root: &Path) -> Result<RuntimePidFile, String> {
    fs::create_dir_all(runtime_root).map_err_str()?;
    let path = runtime_root.join("bridge-service.pid");
    fs::write(&path, std::process::id().to_string()).map_err_str()?;
    Ok(RuntimePidFile { path })
}

fn read_arg(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn handle_control_client(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    runtime_root: &Path,
    pid_path: &Path,
) {
    let line = match read_line(handle) {
        Ok(line) => line,
        Err(error) => {
            eprintln!("failed to read control command: {error}");
            return;
        }
    };
    let mut should_exit = false;
    let response = match serde_json::from_str::<Value>(&line) {
        Ok(command) => {
            should_exit =
                should_exit_after_control_command(command["type"].as_str().unwrap_or_default());
            handle_control(command, state, playback_tx, runtime_root)
        }
        Err(error) => json!({
            "type": "bridge.error",
            "code": "bridge.timeout",
            "message": format!("invalid JSON command: {error}"),
            "retriable": false,
            "bridgeState": "degraded",
            "driverHealth": "damaged",
        }),
    };
    let _ = write_all(handle, format!("{response}\n").as_bytes());
    if should_exit {
        flush_file_buffers(handle);
        let _ = fs::remove_file(pid_path);
        std::process::exit(0);
    }
}

fn handle_control(
    command: Value,
    state: &Arc<Mutex<BridgeState>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    runtime_root: &Path,
) -> Value {
    let request_id = command["requestId"].as_str().unwrap_or_default();
    match command["type"].as_str().unwrap_or_default() {
        "bridge.init" => {
            let mut current = state.lock().unwrap();
            let protocol_version = command["protocolVersion"].as_str().unwrap_or_default();
            if protocol_version != BRIDGE_PROTOCOL_VERSION {
                return bridge_error(
                    request_id,
                    "driver.version-mismatch",
                    "desktop and native bridge protocol versions do not match",
                    &current,
                );
            }
            let install_state = read_install_state(runtime_root);
            let control_device_available = driver_control_device_available();
            current.driver_health = classify_driver_health_with_device_evidence(
                install_state.as_ref(),
                command["expectedDriverVersion"]
                    .as_str()
                    .unwrap_or_default(),
                command["expectedBridgeVersion"]
                    .as_str()
                    .unwrap_or_default(),
                control_device_available,
            )
            .to_string();
            if current.driver_health == "running" && !control_device_available {
                current.driver_health = "damaged".to_string();
                current.last_error_code = Some("driver.control-device-unavailable".to_string());
            }
            current.driver_version = install_state
                .as_ref()
                .map(|value| value.driver_version.clone());
            current.session_id = command["sessionId"].as_str().map(str::to_string);
            current.virtual_render_device_id = command["virtualRenderDeviceId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            current.physical_playback_device_id = command["physicalPlaybackDeviceId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            current.physical_playback_level = command["physicalPlaybackLevel"]
                .as_u64()
                .unwrap_or(100)
                .min(100);
            current.monitor_playback_enabled =
                command["monitorPlaybackEnabled"].as_bool().unwrap_or(true);
            current.mix_control =
                serde_json::from_value(command["mixControl"].clone()).unwrap_or_default();
            current.bridge_state = if current.driver_health == "running" {
                "running".to_string()
            } else {
                "degraded".to_string()
            };
            current.lifecycle_state = if current.driver_health == "running" {
                "ready".to_string()
            } else {
                "error".to_string()
            };
            json!({
                "type": "bridge.init.ack",
                "requestId": request_id,
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "bridgeState": current.bridge_state,
                "driverHealth": current.driver_health,
                "activeDriverVersion": current.driver_version,
            })
        }
        "bridge.state.query" => state_snapshot(request_id, &state.lock().unwrap()),
        "bridge.source.flush" => {
            let mut current = state.lock().unwrap();
            current.source_subscriber_active = false;
            current.source_generation = current.source_generation.wrapping_add(1);
            current.source_pending_bytes = 0;
            current.source_pacer_queued_frames = 0;
            current.monitor_source_queued_frames = 0;
            let _ = playback_tx.send(PlaybackCommand::FlushSource);
            state_snapshot(request_id, &current)
        }
        "bridge.shutdown" => {
            let mut current = state.lock().unwrap();
            current.session_id = None;
            current.bridge_state = "stopped".to_string();
            current.lifecycle_state = "stopped".to_string();
            state_snapshot(request_id, &current)
        }
        _ => bridge_error(
            request_id,
            "bridge.timeout",
            "unsupported control command",
            &state.lock().unwrap(),
        ),
    }
}

fn read_install_state(runtime_root: &Path) -> Option<DriverInstallState> {
    let bytes = fs::read(runtime_root.join("driver-install-state.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn driver_control_device_available() -> bool {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(OMNI_BRIDGE_DEVICE_PATH)
        .is_ok()
}

fn state_snapshot(request_id: &str, state: &BridgeState) -> Value {
    json!({
        "type": "bridge.state.snapshot",
        "requestId": request_id,
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "bridgeState": state.bridge_state,
        "lifecycleState": state.lifecycle_state,
        "driverHealth": state.driver_health,
        "driverVersion": state.driver_version,
        "bridgeVersion": state.bridge_version,
        "captureBackend": "wasapi-endpoint-loopback",
        "captureLifecycleState": state.source_worker_phase,
        "captureRestartCount": state.capture_restart_count,
        "capturePacketCount": state.capture_packet_count,
        "captureFramesReceived": state.capture_frames_received,
        "capturePeak": state.capture_peak,
        "captureRms": state.capture_rms,
        "captureSilentPacketCount": state.capture_silent_packet_count,
        "captureInvalidSampleCount": state.capture_invalid_sample_count,
        "resolvedPhysicalPlaybackDeviceId": state.resolved_physical_playback_device_id,
        "monitorBufferedMs": state.monitor_source_queued_frames * OMNI_SOURCE_FRAME_INTERVAL_MS as usize,
        "monitorUnderrunCount": state.monitor_underrun_count,
        "monitorOverrunCount": state.monitor_overrun_count,
        "queuedFrames": state.queued_frames,
        "sourceFramesCaptured": state.source_frames_captured,
        "translatedFramesAccepted": state.translated_frames_accepted,
        "playbackFramesWritten": state.playback_frames_written,
        "underrunCount": state.underrun_count,
        "droppedFrameCount": state.dropped_frame_count,
        "driverBufferedBytes": state.driver_buffered_bytes,
        "driverMaxBufferedBytes": state.driver_max_buffered_bytes,
        "driverCapturedBytes": state.driver_captured_bytes,
        "driverDeliveredBytes": state.driver_delivered_bytes,
        "driverDroppedBytes": state.driver_dropped_bytes,
        "sourcePendingBytes": state.source_pending_bytes,
        "sourcePacerQueuedFrames": state.source_pacer_queued_frames,
        "monitorSourceQueuedFrames": state.monitor_source_queued_frames,
        "staleSourceFramesDropped": state.stale_source_frames_dropped,
        "sourceSubscriberActive": state.source_subscriber_active,
        "sourceGeneration": state.source_generation,
        "sourceWorkerPhase": state.source_worker_phase,
        "sourceWorkerLastProgressTimestampMs": state.source_worker_last_progress_timestamp_ms,
        "sourceReadCalls": state.source_read_calls,
        "sourceZeroByteReads": state.source_zero_byte_reads,
        "monitorPlaybackState": state.monitor_playback_state,
        "lastFrameTimestampMs": state.last_frame_timestamp_ms,
        "lastErrorCode": state.last_error_code,
    })
}

fn bridge_error(request_id: &str, code: &str, message: &str, state: &BridgeState) -> Value {
    json!({
        "type": "bridge.error",
        "requestId": request_id,
        "code": code,
        "message": message,
        "retriable": true,
        "bridgeState": state.bridge_state,
        "driverHealth": state.driver_health,
        "suggestedAction": "open-diagnostics",
    })
}

fn handle_audio_client(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
) {
    let Ok(header_len_bytes) = read_exact(handle, 4) else {
        return;
    };
    let header_len = u32::from_le_bytes(header_len_bytes.try_into().unwrap()) as usize;
    let Ok(header_bytes) = read_exact(handle, header_len) else {
        return;
    };
    let Ok(header) = serde_json::from_slice::<AudioFrameHeader>(&header_bytes) else {
        return;
    };
    let Ok(payload) = read_exact(handle, header.payload_bytes) else {
        return;
    };
    let mut current = state.lock().unwrap();
    let samples = match validate_translation_frame(current.session_id.as_deref(), &header, &payload)
    {
        Ok(samples) => samples,
        Err(ack) => {
            current.dropped_frame_count += header.frame_count as u64;
            current.last_error_code = ack.error_code.clone();
            drop(current);
            let _ = write_framed_json(handle, &ack);
            return;
        }
    };
    current.translated_frames_accepted += header.frame_count as u64;
    current.last_frame_timestamp_ms = Some(header.timestamp_ms);
    let monitor_samples = mix_for_monitor(
        &[],
        &samples,
        header.sample_rate_hz,
        header.channel_count,
        &current.mix_control,
    );
    if current.monitor_playback_enabled && !monitor_samples.is_empty() {
        let playback_frames = monitor_samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
        match playback_tx.try_send(PlaybackCommand::Play(PlaybackJob {
            samples: monitor_samples,
            device_id: current.physical_playback_device_id.clone(),
            volume: playback_volume(current.physical_playback_level),
            source_frame: false,
            ducking_enabled: current.mix_control.ducking_enabled,
            ducking_depth_percent: current.mix_control.ducking_depth_percent,
            queued_at: Instant::now(),
            source_generation: current.source_generation,
        })) {
            Ok(()) => current.monitor_playback_state = "queued".to_string(),
            Err(_) => {
                current.dropped_frame_count += playback_frames;
                current.last_error_code = Some("bridge.queue-overflow".to_string());
            }
        }
    }
    let playback_frames_written = current.playback_frames_written;
    let _ = fs::create_dir_all(runtime_root);
    let _ = fs::write(runtime_root.join("last-translation-frame.pcm"), payload);
    let ack = accepted_audio_frame_ack(&header, playback_frames_written);
    drop(current);
    let _ = write_framed_json(handle, &ack);
}

#[allow(dead_code)]
fn run_wasapi_source_worker(
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    source_tx: mpsc::SyncSender<Vec<u8>>,
) {
    let _ = initialize_mta();
    let mut restart_index = 0_usize;
    loop {
        let (active, generation, device_id) = {
            let current = state.lock().unwrap();
            (
                current.source_subscriber_active,
                current.source_generation,
                current.virtual_render_device_id.clone(),
            )
        };
        if !active || device_id.is_empty() {
            state.lock().unwrap().source_worker_phase = "waiting-subscriber".to_string();
            thread::sleep(Duration::from_millis(25));
            continue;
        }

        {
            let mut current = state.lock().unwrap();
            current.update_progress("opening-wasapi-loopback");
        }
        match capture_wasapi_source_generation(
            &state,
            &runtime_root,
            &playback_tx,
            &source_tx,
            generation,
            &device_id,
        ) {
            Ok(()) => restart_index = 0,
            Err(error) => {
                let delay_ms = OMNI_SOURCE_RESTART_BACKOFF_MS
                    [restart_index.min(OMNI_SOURCE_RESTART_BACKOFF_MS.len() - 1)];
                restart_index = (restart_index + 1).min(OMNI_SOURCE_RESTART_BACKOFF_MS.len() - 1);
                {
                    let mut current = state.lock().unwrap();
                    current.capture_restart_count += 1;
                    current.set_error(
                        "wasapi-loopback-restarting",
                        format!("capture.wasapi-loopback-failed:{error}"),
                    );
                }
                append_bridge_service_log(
                    &runtime_root,
                    &format!(
                        "event=wasapi_loopback_restart generation={generation} delayMs={delay_ms} error={error}"
                    ),
                );
                thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }
}

#[allow(dead_code)]
fn capture_wasapi_source_generation(
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    source_tx: &mpsc::SyncSender<Vec<u8>>,
    generation: u64,
    requested_device_id: &str,
) -> Result<(), String> {
    let enumerator = DeviceEnumerator::new().map_err_str()?;
    let device = find_render_device(&enumerator, requested_device_id)?;
    let effective_device_id = device.get_id().map_err_str()?;
    let mut audio_client = device.get_iaudioclient().map_err_str()?;
    let desired_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        INTERNAL_SAMPLE_RATE_HZ as usize,
        INTERNAL_CHANNEL_COUNT as usize,
        None,
    );
    let (_, min_time) = audio_client.get_device_period().map_err_str()?;
    audio_client
        .initialize_client(
            &desired_format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: min_time,
            },
        )
        .map_err_str()?;
    let event_handle = audio_client.set_get_eventhandle().map_err_str()?;
    let capture_client = audio_client.get_audiocaptureclient().map_err_str()?;
    audio_client.start_stream().map_err_str()?;

    append_bridge_service_log(
        runtime_root,
        &format!(
            "event=wasapi_loopback_started generation={generation} device={effective_device_id}"
        ),
    );
    {
        let mut current = state.lock().unwrap();
        current.update_progress("wasapi-loopback-running");
        current.last_error_code = None;
    }

    let mut sample_bytes = VecDeque::new();
    let bytes_per_frame = desired_format.get_blockalign() as usize;
    let float_chunk_bytes = 960 * INTERNAL_CHANNEL_COUNT as usize * std::mem::size_of::<f32>();
    let mut diagnostics_started_at = Instant::now();
    let mut diagnostics_peak = 0.0_f32;
    let mut diagnostics_square_sum = 0.0_f64;
    let mut diagnostics_sample_count = 0_u64;
    let mut diagnostics_silent_packets = 0_u64;
    let mut diagnostics_invalid_samples = 0_u64;

    loop {
        let (active, current_generation) = {
            let current = state.lock().unwrap();
            (current.source_subscriber_active, current.source_generation)
        };
        if !active || current_generation != generation {
            let _ = audio_client.stop_stream();
            return Ok(());
        }

        while let Some(packet_frames) = capture_client
            .get_next_packet_size()
            .map_err_str()?
            .filter(|frames| *frames > 0)
        {
            let mut packet = vec![0_u8; packet_frames as usize * bytes_per_frame];
            let (frames_read, buffer_info) =
                capture_client.read_from_device(&mut packet).map_err_str()?;
            packet.truncate(frames_read as usize * bytes_per_frame);
            if buffer_info.flags.silent {
                diagnostics_silent_packets += 1;
                state.lock().unwrap().capture_silent_packet_count += 1;
            }
            append_capture_packet(&mut sample_bytes, packet, buffer_info.flags.silent);
        }
        while sample_bytes.len() >= float_chunk_bytes {
            let mut payload = Vec::with_capacity(OMNI_SOURCE_CHUNK_BYTES);
            for _ in 0..(960 * INTERNAL_CHANNEL_COUNT as usize) {
                let bytes = [
                    sample_bytes.pop_front().unwrap(),
                    sample_bytes.pop_front().unwrap(),
                    sample_bytes.pop_front().unwrap(),
                    sample_bytes.pop_front().unwrap(),
                ];
                let (sample, invalid) = sanitize_capture_sample(f32::from_le_bytes(bytes));
                if invalid {
                    diagnostics_invalid_samples += 1;
                }
                diagnostics_peak = diagnostics_peak.max(sample.abs());
                diagnostics_square_sum += (sample as f64) * (sample as f64);
                diagnostics_sample_count += 1;
                payload.extend_from_slice(&((sample * i16::MAX as f32) as i16).to_le_bytes());
            }
            {
                let mut current = state.lock().unwrap();
                current.capture_packet_count += 1;
                current.capture_frames_received += 960;
                current.capture_peak = diagnostics_peak;
                current.capture_rms = capture_rms(diagnostics_square_sum, diagnostics_sample_count);
                current.capture_invalid_sample_count += diagnostics_invalid_samples;
                current.source_worker_last_progress_timestamp_ms = Some(unix_ms());
            }
            diagnostics_invalid_samples = 0;
            dispatch_source_frame(state, runtime_root, playback_tx, source_tx, payload);
        }
        if diagnostics_started_at.elapsed()
            >= Duration::from_secs(OMNI_CAPTURE_DIAGNOSTICS_INTERVAL_SECS)
        {
            let rms = capture_rms(diagnostics_square_sum, diagnostics_sample_count);
            append_bridge_service_log(
                runtime_root,
                &format!(
                    "event=wasapi_capture_summary generation={generation} peak={diagnostics_peak:.6} rms={rms:.6} silentPackets={diagnostics_silent_packets} invalidSamples={} samples={diagnostics_sample_count}",
                    state.lock().unwrap().capture_invalid_sample_count
                ),
            );
            diagnostics_started_at = Instant::now();
            diagnostics_peak = 0.0;
            diagnostics_square_sum = 0.0;
            diagnostics_sample_count = 0;
            diagnostics_silent_packets = 0;
        }
        event_handle.wait_for_event(100).map_err_str()?;
    }
}

#[allow(dead_code)]
fn append_capture_packet(sample_bytes: &mut VecDeque<u8>, mut packet: Vec<u8>, silent: bool) {
    if silent {
        packet.fill(0);
    }
    sample_bytes.extend(packet);
}

#[allow(dead_code)]
fn sanitize_capture_sample(sample: f32) -> (f32, bool) {
    if sample.is_finite() {
        (sample.clamp(-1.0, 1.0), false)
    } else {
        (0.0, true)
    }
}

#[allow(dead_code)]
fn capture_rms(square_sum: f64, sample_count: u64) -> f32 {
    if sample_count == 0 {
        0.0
    } else {
        (square_sum / sample_count as f64).sqrt() as f32
    }
}

#[allow(dead_code)]
fn find_render_device(
    enumerator: &DeviceEnumerator,
    requested_device_id: &str,
) -> Result<Device, String> {
    let collection = enumerator
        .get_device_collection(&Direction::Render)
        .map_err_str()?;
    for device_result in &collection {
        let device = device_result.map_err_str()?;
        let id_matches = device
            .get_id()
            .map(|id| id == requested_device_id)
            .unwrap_or(false);
        let name_matches = device
            .get_friendlyname()
            .map(|name| name.contains("Omni Translate Virtual Speaker"))
            .unwrap_or(false);
        if id_matches || name_matches {
            return Ok(device);
        }
    }
    Err(format!(
        "configured virtual render endpoint was not found: {requested_device_id}"
    ))
}

fn run_driver_source_worker(
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    source_tx: mpsc::SyncSender<Vec<u8>>,
) {
    let mut last_driver_open_error = None;
    loop {
        {
            let mut current = state.lock().unwrap();
            current.update_progress("opening-driver");
        }
        let driver = match OpenOptions::new()
            .read(true)
            .write(true)
            .open(OMNI_BRIDGE_DEVICE_PATH)
        {
            Ok(driver) => driver,
            Err(error) => {
                let error = error.to_string();
                let mut current = state.lock().unwrap();
                current.set_error("driver-open-failed", format!("driver.open-failed:{error}"));
                let generation = current.source_generation;
                drop(current);
                if last_driver_open_error.as_deref() != Some(error.as_str()) {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!("driver open failed: generation={generation} error={error}"),
                    );
                    last_driver_open_error = Some(error);
                }
                thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        if last_driver_open_error.take().is_some() {
            append_bridge_service_log(&runtime_root, "driver open recovered");
        }
        {
            let mut current = state.lock().unwrap();
            current.update_progress("driver-open");
        }
        append_bridge_service_log(&runtime_root, "event=driver_open_success");
        match query_driver_status(&driver) {
            Ok(status) => {
                update_driver_status(&state, &status);
                append_bridge_service_log(
                    &runtime_root,
                    &format!(
                        "event=driver_status abiVersion={} ringCapacityBytes={} maxBufferedBytes={} capturedBytes={} deliveredBytes={} bufferedBytes={} droppedBytes={}",
                        status.abi_version,
                        status.ring_capacity_bytes,
                        status.max_buffered_bytes,
                        status.captured_bytes,
                        status.delivered_bytes,
                        status.buffered_bytes,
                        status.dropped_bytes,
                    ),
                );
            }
            Err(error) => append_bridge_service_log(
                &runtime_root,
                &format!("event=driver_status_failed error={error}"),
            ),
        }
        let started_at = Instant::now();
        let mut pending_bytes = VecDeque::new();
        let mut pacer = AudioFramePacer::new(
            OMNI_SOURCE_QUEUE_CAPACITY,
            Duration::from_millis(OMNI_SOURCE_FRAME_INTERVAL_MS),
        );
        let mut last_dropped_frames = 0_u64;
        let mut last_underruns = 0_u64;
        let mut released_frames = 0_u64;
        let mut last_summary_at = Instant::now();
        let mut source_generation = u64::MAX;
        let mut idle_since = Instant::now();
        let mut first_read_generation = u64::MAX;
        let mut first_non_empty_generation = u64::MAX;
        loop {
            let (active, current_generation) = {
                let current = state.lock().unwrap();
                (current.source_subscriber_active, current.source_generation)
            };
            if !active {
                {
                    let mut current = state.lock().unwrap();
                    if current.source_worker_phase != "waiting-subscriber" {
                        current.update_progress("waiting-subscriber");
                    }
                }
                if source_generation != current_generation {
                    pacer.clear();
                    pending_bytes.clear();
                    let _ = reset_driver_ring(&driver);
                    source_generation = current_generation;
                }
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            if source_generation != current_generation {
                pacer.clear();
                pending_bytes.clear();
                let _ = reset_driver_ring(&driver);
                source_generation = current_generation;
                idle_since = Instant::now();
                first_read_generation = u64::MAX;
                first_non_empty_generation = u64::MAX;
                append_bridge_service_log(
                    &runtime_root,
                    &format!("event=source_generation_active generation={source_generation}"),
                );
            }
            let mut released = false;
            if let Some(frame) = pacer.poll(started_at.elapsed()) {
                released_frames += 1;
                if released_frames == 1 {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!(
                            "source pacer started: frameBytes={} intervalMs={} queueCapacity={}",
                            OMNI_SOURCE_CHUNK_BYTES,
                            OMNI_SOURCE_FRAME_INTERVAL_MS,
                            OMNI_SOURCE_QUEUE_CAPACITY
                        ),
                    );
                }
                dispatch_source_frame(&state, &runtime_root, &playback_tx, &source_tx, frame);
                released = true;
            }

            let mut bytes_read = 0;
            if pacer.queued_frames() < OMNI_SOURCE_QUEUE_CAPACITY {
                let mut payload = vec![0_u8; OMNI_SOURCE_CHUNK_BYTES];
                {
                    let mut current = state.lock().unwrap();
                    current.update_progress("reading-driver");
                    current.source_read_calls += 1;
                }
                if first_read_generation != source_generation {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!("event=driver_read_begin generation={source_generation}"),
                    );
                    first_read_generation = source_generation;
                }
                bytes_read = match read_driver_pcm(&driver, &mut payload) {
                    Ok(bytes_read) => {
                        let bytes_read = bytes_read - (bytes_read % 4);
                        let mut current = state.lock().unwrap();
                        current.update_progress("driver-read-returned");
                        record_source_read_result(&mut current, bytes_read);
                        bytes_read
                    }
                    Err(error) => {
                        let mut current = state.lock().unwrap();
                        current
                            .set_error("driver-read-failed", format!("driver.read-failed:{error}"));
                        let generation = current.source_generation;
                        drop(current);
                        append_bridge_service_log(
                            &runtime_root,
                            &format!("driver read failed: generation={generation} error={error}"),
                        );
                        break;
                    }
                };
                payload.truncate(bytes_read);
                if bytes_read > 0 && first_non_empty_generation != source_generation {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!(
                            "event=driver_read_first_pcm generation={source_generation} bytesRead={bytes_read}"
                        ),
                    );
                    first_non_empty_generation = source_generation;
                }
                if !payload.is_empty() {
                    idle_since = Instant::now();
                    pending_bytes.extend(payload);
                    let now = started_at.elapsed();
                    while pending_bytes.len() >= OMNI_SOURCE_CHUNK_BYTES {
                        let pcm16_frame: Vec<u8> =
                            pending_bytes.drain(..OMNI_SOURCE_CHUNK_BYTES).collect();
                        pacer.push(pcm16_frame, now);
                    }
                }
            }

            let dropped_frames = pacer.dropped_frame_count();
            if dropped_frames > last_dropped_frames {
                let dropped = dropped_frames - last_dropped_frames;
                state.lock().unwrap().dropped_frame_count +=
                    dropped * (OMNI_SOURCE_CHUNK_BYTES as u64 / 4);
                last_dropped_frames = dropped_frames;
            }

            if !released {
                if let Some(frame) = pacer.poll(started_at.elapsed()) {
                    released_frames += 1;
                    if released_frames == 1 {
                        append_bridge_service_log(
                            &runtime_root,
                            &format!(
                                "source pacer started: frameBytes={} intervalMs={} queueCapacity={}",
                                OMNI_SOURCE_CHUNK_BYTES,
                                OMNI_SOURCE_FRAME_INTERVAL_MS,
                                OMNI_SOURCE_QUEUE_CAPACITY
                            ),
                        );
                    }
                    dispatch_source_frame(&state, &runtime_root, &playback_tx, &source_tx, frame);
                    released = true;
                }
            }

            let underruns = pacer.underrun_count();
            if underruns > last_underruns {
                state.lock().unwrap().underrun_count += underruns - last_underruns;
                last_underruns = underruns;
            }
            state.lock().unwrap().queued_frames = pacer.queued_frames();
            {
                let mut current = state.lock().unwrap();
                current.source_pending_bytes = pending_bytes.len();
                current.source_pacer_queued_frames = pacer.queued_frames();
            }

            if pacer.queued_frames() == 0
                && !pending_bytes.is_empty()
                && idle_since.elapsed() >= Duration::from_millis(OMNI_SOURCE_STALE_AFTER_MS)
            {
                pending_bytes.clear();
                state.lock().unwrap().source_pending_bytes = 0;
            }

            if last_summary_at.elapsed() >= Duration::from_secs(OMNI_SOURCE_SUMMARY_INTERVAL_SECS) {
                if let Ok(status) = query_driver_status(&driver) {
                    update_driver_status(&state, &status);
                }
                let (
                    driver_buffered_bytes,
                    driver_dropped_bytes,
                    monitor_source_queued_frames,
                    stale_source_frames_dropped,
                ) = {
                    let current = state.lock().unwrap();
                    (
                        current.driver_buffered_bytes,
                        current.driver_dropped_bytes,
                        current.monitor_source_queued_frames,
                        current.stale_source_frames_dropped,
                    )
                };
                append_bridge_service_log(
                    &runtime_root,
                    &format!(
                        "source pacer summary: releasedFrames={} queuedFrames={} pendingBytes={} underruns={} droppedFrames={} driverBufferedBytes={} driverDroppedBytes={} monitorQueuedFrames={} staleSourceFramesDropped={}",
                        released_frames,
                        pacer.queued_frames(),
                        pending_bytes.len(),
                        pacer.underrun_count(),
                        pacer.dropped_frame_count(),
                        driver_buffered_bytes,
                        driver_dropped_bytes,
                        monitor_source_queued_frames,
                        stale_source_frames_dropped,
                    ),
                );
                last_summary_at = Instant::now();
            }

            if bytes_read == 0 && !released {
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
}

fn dispatch_source_frame(
    state: &Arc<Mutex<BridgeState>>,
    _runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    source_tx: &mpsc::SyncSender<Vec<u8>>,
    payload: Vec<u8>,
) {
    let Ok(samples) = decode_pcm16le(&payload) else {
        return;
    };
    let frame_count = samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
    let mut current = state.lock().unwrap();
    current.source_frames_captured += frame_count;
    current.source_released_frames += 1;
    current.last_frame_timestamp_ms = Some(unix_ms());
    let monitor_samples = mix_for_monitor(
        &samples,
        &[],
        INTERNAL_SAMPLE_RATE_HZ,
        INTERNAL_CHANNEL_COUNT,
        &current.mix_control,
    );
    if current.monitor_playback_enabled && !monitor_samples.is_empty() {
        let result = playback_tx.try_send(PlaybackCommand::Play(PlaybackJob {
            samples: monitor_samples,
            device_id: current.physical_playback_device_id.clone(),
            volume: playback_volume(current.physical_playback_level),
            source_frame: true,
            ducking_enabled: current.mix_control.ducking_enabled,
            ducking_depth_percent: current.mix_control.ducking_depth_percent,
            queued_at: Instant::now(),
            source_generation: current.source_generation,
        }));
        if result.is_err() {
            current.dropped_frame_count += frame_count;
        }
    }
    if source_tx.try_send(payload.clone()).is_err() {
        current.dropped_frame_count += frame_count;
    }
    drop(current);
}

fn append_bridge_service_log(runtime_root: &Path, message: &str) {
    let _ = fs::create_dir_all(runtime_root);
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime_root.join("bridge-service.log"))
    {
        let _ = writeln!(log, "{} {}", unix_ms(), message);
    }
}

fn update_driver_status(state: &Arc<Mutex<BridgeState>>, status: &DriverStatus) {
    let mut current = state.lock().unwrap();
    current.driver_buffered_bytes = status.buffered_bytes as u64;
    current.driver_max_buffered_bytes = status.max_buffered_bytes as u64;
    current.driver_captured_bytes = status.captured_bytes;
    current.driver_delivered_bytes = status.delivered_bytes;
    current.driver_dropped_bytes = status.dropped_bytes;
}

fn run_source_watchdog(state: Arc<Mutex<BridgeState>>, runtime_root: PathBuf) {
    loop {
        thread::sleep(Duration::from_secs(OMNI_SOURCE_SUMMARY_INTERVAL_SECS));
        let summary = {
            let current = state.lock().unwrap();
            source_watchdog_summary(&current, unix_ms())
        };
        append_bridge_service_log(&runtime_root, &summary);
    }
}

fn record_source_read_result(state: &mut BridgeState, bytes_read: usize) {
    state.source_bytes_read += bytes_read as u64;
    if bytes_read == 0 {
        state.source_zero_byte_reads += 1;
    }
}

fn source_watchdog_summary(state: &BridgeState, now_ms: u64) -> String {
    let last_progress_age_ms = state
        .source_worker_last_progress_timestamp_ms
        .map(|timestamp| now_ms.saturating_sub(timestamp))
        .unwrap_or(0);
    format!(
        "event=source_watchdog captureBackend=wasapi-endpoint-loopback sourceSubscriberActive={} sourceGeneration={} workerPhase={} lastProgressAgeMs={} captureRestarts={} capturePackets={} captureFrames={} capturePeak={:.6} captureRms={:.6} captureSilentPackets={} captureInvalidSamples={} monitorBufferedMs={} monitorUnderruns={} monitorOverruns={} readCalls={} zeroByteReads={} bytesRead={} capturedBytes={} deliveredBytes={} bufferedBytes={} droppedBytes={} pacerQueuedFrames={} pendingBytes={} releasedFrames={} underruns={}",
        state.source_subscriber_active,
        state.source_generation,
        state.source_worker_phase,
        last_progress_age_ms,
        state.capture_restart_count,
        state.capture_packet_count,
        state.capture_frames_received,
        state.capture_peak,
        state.capture_rms,
        state.capture_silent_packet_count,
        state.capture_invalid_sample_count,
        state.monitor_source_queued_frames * OMNI_SOURCE_FRAME_INTERVAL_MS as usize,
        state.monitor_underrun_count,
        state.monitor_overrun_count,
        state.source_read_calls,
        state.source_zero_byte_reads,
        state.source_bytes_read,
        state.driver_captured_bytes,
        state.driver_delivered_bytes,
        state.driver_buffered_bytes,
        state.driver_dropped_bytes,
        state.source_pacer_queued_frames,
        state.source_pending_bytes,
        state.source_released_frames,
        state.underrun_count,
    )
}

fn read_driver_pcm(driver: &fs::File, payload: &mut [u8]) -> Result<usize, io::Error> {
    let mut bytes_read = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_READ_PCM,
            ptr::null(),
            0,
            payload.as_mut_ptr().cast(),
            payload.len() as u32,
            &mut bytes_read,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(bytes_read as usize)
    }
}

fn reset_driver_ring(driver: &fs::File) -> Result<(), io::Error> {
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_RESET,
            ptr::null(),
            0,
            ptr::null_mut(),
            0,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn query_driver_status(driver: &fs::File) -> Result<DriverStatus, io::Error> {
    let mut status = DriverStatus::default();
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_QUERY_STATUS,
            ptr::null(),
            0,
            (&mut status as *mut DriverStatus).cast(),
            std::mem::size_of::<DriverStatus>() as u32,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else if bytes_returned < DRIVER_STATUS_BASE_SIZE {
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!(
                "driver status returned {bytes_returned} byte(s); expected at least {DRIVER_STATUS_BASE_SIZE}"
            ),
        ))
    } else {
        Ok(status)
    }
}

fn handle_source_subscriber(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    source_rx: &Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    runtime_root: &Path,
) {
    let (my_generation, previous_generation) = {
        let source_rx = source_rx.lock().unwrap();
        let mut current = state.lock().unwrap();
        let generations = begin_source_subscription(&mut current);
        drop(current);
        while source_rx.try_recv().is_ok() {}
        generations
    };
    append_bridge_service_log(
        runtime_root,
        &format!(
            "source subscriber connected: generation={my_generation} previousGeneration={previous_generation}"
        ),
    );
    if source_subscription_is_owner(&state.lock().unwrap(), my_generation) {
        let _ = playback_tx.try_send(PlaybackCommand::FlushSource);
    }
    let mut frame_index = 0_u64;
    loop {
        if !source_subscription_is_owner(&state.lock().unwrap(), my_generation) {
            append_bridge_service_log(
                runtime_root,
                &format!("source subscriber handoff: generation={my_generation}"),
            );
            break;
        }
        let payload = {
            let source_rx = source_rx.lock().unwrap();
            let current = state.lock().unwrap();
            if !source_subscription_is_owner(&current, my_generation) {
                drop(current);
                drop(source_rx);
                append_bridge_service_log(
                    runtime_root,
                    &format!("source subscriber handoff: generation={my_generation}"),
                );
                break;
            }
            source_rx.try_recv()
        };
        let (event_type, payload) = match payload {
            Ok(payload) => ("bridge.source.frame", payload),
            Err(mpsc::TryRecvError::Empty) => {
                thread::sleep(Duration::from_millis(25));
                ("bridge.source.heartbeat", Vec::new())
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
        };
        let current = state.lock().unwrap();
        if !source_subscription_is_owner(&current, my_generation) {
            drop(current);
            append_bridge_service_log(
                runtime_root,
                &format!("source subscriber handoff: generation={my_generation}"),
            );
            break;
        }
        let Some(session_id) = current.session_id.clone() else {
            continue;
        };
        drop(current);
        frame_index += 1;
        let frame_id = format!("driver-source-{frame_index}");
        let header = AudioFrameHeader {
            event_type: event_type.to_string(),
            request_id: frame_id.clone(),
            session_id,
            frame_id,
            stream_id: "omni-virtual-speaker".to_string(),
            sample_rate_hz: INTERNAL_SAMPLE_RATE_HZ,
            channel_count: INTERNAL_CHANNEL_COUNT,
            frame_count: payload.len() / (INTERNAL_CHANNEL_COUNT as usize * 2),
            timestamp_ms: unix_ms(),
            payload_bytes: payload.len(),
        };
        if write_framed_audio(handle, &header, &payload).is_err() {
            break;
        }
    }
    let mut current = state.lock().unwrap();
    if end_source_subscription(&mut current, my_generation) {
        let next_generation = current.source_generation;
        drop(current);
        let _ = playback_tx.try_send(PlaybackCommand::FlushSource);
        append_bridge_service_log(
            runtime_root,
            &format!(
                "source subscriber disconnected: generation={my_generation} nextGeneration={next_generation}"
            ),
        );
    }
}

fn begin_source_subscription(state: &mut BridgeState) -> (u64, u64) {
    let previous_generation = state.source_generation;
    state.source_generation = state.source_generation.wrapping_add(1);
    state.source_subscriber_active = true;
    (state.source_generation, previous_generation)
}

fn source_subscription_is_owner(state: &BridgeState, generation: u64) -> bool {
    state.source_subscriber_active && state.source_generation == generation
}

fn end_source_subscription(state: &mut BridgeState, generation: u64) -> bool {
    if !source_subscription_is_owner(state, generation) {
        return false;
    }
    state.source_subscriber_active = false;
    state.source_generation = state.source_generation.wrapping_add(1);
    true
}

fn write_framed_audio(
    handle: HANDLE,
    header: &AudioFrameHeader,
    payload: &[u8],
) -> Result<(), io::Error> {
    let header = serde_json::to_vec(header).map_err(io::Error::other)?;
    write_all(handle, &(header.len() as u32).to_le_bytes())?;
    write_all(handle, &header)?;
    write_all(handle, payload)
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn run_playback_worker(
    playback_rx: mpsc::Receiver<PlaybackCommand>,
    state: Arc<Mutex<BridgeState>>,
) {
    let mut output: Option<PlaybackOutput> = None;
    while let Ok(command) = playback_rx.recv() {
        if matches!(command, PlaybackCommand::FlushSource) {
            if let Some(output) = output.as_mut() {
                flush_source_pending(output);
                output.source_player.clear();
                output.source_player.play();
                output.source_pending_samples.clear();
            }
            state.lock().unwrap().monitor_source_queued_frames = 0;
            continue;
        }
        let PlaybackCommand::Play(job) = command else {
            continue;
        };
        state.lock().unwrap().monitor_playback_state = "playing".to_string();
        if output.as_ref().map(|current| current.device_id.as_str()) != Some(job.device_id.as_str())
        {
            output = match open_playback_output(&job.device_id) {
                Ok(next) => Some(next),
                Err(error) => {
                    let mut current = state.lock().unwrap();
                    current.last_error_code = Some(if error == MONITOR_VIRTUAL_PLAYBACK_LOOP {
                        error
                    } else {
                        format!("monitor.playback-failed:{error}")
                    });
                    current.monitor_playback_state = "blocked".to_string();
                    continue;
                }
            };
        }
        if let Some(output) = output.as_mut() {
            state.lock().unwrap().resolved_physical_playback_device_id =
                output.resolved_device_id.clone();
            let frames = job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
            if job.source_frame {
                let generation = state.lock().unwrap().source_generation;
                if source_playback_job_is_stale(
                    job.source_generation,
                    generation,
                    job.queued_at.elapsed(),
                ) {
                    state.lock().unwrap().stale_source_frames_dropped += frames;
                    continue;
                }
                if monitor_source_queue_needs_drop(output.source_player.len()) {
                    let mut current = state.lock().unwrap();
                    current.monitor_overrun_count += 1;
                    current.stale_source_frames_dropped += frames;
                    continue;
                }
            }
            if job.source_frame
                && output
                    .duck_until
                    .map(|deadline| Instant::now() >= deadline)
                    .unwrap_or(false)
            {
                output.source_player.set_volume(job.volume);
                output.duck_until = None;
            }
            if job.source_frame {
                if output.duck_until.is_none() {
                    output.source_player.set_volume(job.volume);
                }
                output.source_pending_samples.extend(job.samples);
                if output.source_pending_samples.len()
                    >= OMNI_MONITOR_SOURCE_BATCH_FRAMES * INTERNAL_CHANNEL_COUNT as usize
                {
                    flush_source_pending(output);
                }
                state.lock().unwrap().monitor_source_queued_frames =
                    output.source_player.len() * 5 + pending_source_chunks(output);
            } else {
                flush_source_pending(output);
                output.translation_player.set_volume(job.volume);
                let buffer = SamplesBuffer::new(
                    NonZeroU16::new(INTERNAL_CHANNEL_COUNT).unwrap(),
                    NonZeroU32::new(INTERNAL_SAMPLE_RATE_HZ).unwrap(),
                    job.samples,
                );
                if job.ducking_enabled {
                    output.source_player.set_volume(
                        job.volume * 10.0_f32.powf(-(job.ducking_depth_percent as f32) / 200.0),
                    );
                    output.duck_until = Some(
                        Instant::now()
                            + Duration::from_secs_f64(
                                frames as f64 / INTERNAL_SAMPLE_RATE_HZ as f64,
                            ),
                    );
                }
                output.translation_player.append(buffer);
            }
            {
                let mut current = state.lock().unwrap();
                current.playback_frames_written += frames;
                current.monitor_playback_state = "ready".to_string();
            }
        }
    }
}

fn playback_volume(output_level: u64) -> f32 {
    output_level.min(100) as f32 / 100.0
}

fn flush_source_pending(output: &mut PlaybackOutput) {
    if output.source_pending_samples.is_empty() {
        return;
    }
    let samples = std::mem::take(&mut output.source_pending_samples);
    let buffer = SamplesBuffer::new(
        NonZeroU16::new(INTERNAL_CHANNEL_COUNT).unwrap(),
        NonZeroU32::new(INTERNAL_SAMPLE_RATE_HZ).unwrap(),
        samples,
    );
    output.source_player.append(buffer);
}

fn pending_source_chunks(output: &PlaybackOutput) -> usize {
    let frames = output.source_pending_samples.len() / INTERNAL_CHANNEL_COUNT as usize;
    frames.div_ceil(960)
}

fn source_playback_job_is_stale(
    job_generation: u64,
    current_generation: u64,
    queued_for: Duration,
) -> bool {
    job_generation != current_generation
        || queued_for > Duration::from_millis(OMNI_SOURCE_STALE_AFTER_MS)
}

fn monitor_source_queue_needs_drop(queued_sources: usize) -> bool {
    queued_sources >= OMNI_MONITOR_SOURCE_QUEUE_CAPACITY
}

fn open_playback_output(device_id: &str) -> Result<PlaybackOutput, String> {
    let host = cpal::default_host();
    let device = if device_id.trim().is_empty()
        || matches!(
            device_id.trim(),
            "default" | "speaker-default" | "system-output-default"
        ) {
        host.default_output_device()
            .ok_or_else(|| "default playback device not found".to_string())?
    } else {
        host.output_devices()
            .map_err_str()?
            .find(|device| playback_device_matches(device, device_id))
            .ok_or_else(|| format!("configured playback device not found: {device_id}"))?
    };
    if is_omni_virtual_playback_device(&device) {
        return Err(MONITOR_VIRTUAL_PLAYBACK_LOOP.to_string());
    }
    let resolved_device_id = device
        .id()
        .map(|id| id.1)
        .unwrap_or_else(|_| device_id.to_string());
    let sink = DeviceSinkBuilder::from_device(device)
        .and_then(|builder| builder.open_sink_or_fallback())
        .map_err_str()?;
    let source_player = Player::connect_new(sink.mixer());
    let translation_player = Player::connect_new(sink.mixer());
    Ok(PlaybackOutput {
        device_id: device_id.to_string(),
        resolved_device_id,
        _sink: sink,
        source_player,
        translation_player,
        source_pending_samples: Vec::new(),
        duck_until: None,
    })
}

fn is_omni_virtual_playback_device(device: &cpal::Device) -> bool {
    device
        .description()
        .map(|description| is_omni_virtual_playback_device_name(description.name()))
        .unwrap_or(false)
}

fn playback_device_matches(device: &cpal::Device, requested: &str) -> bool {
    device.id().map(|id| id.1 == requested).unwrap_or(false)
        || device
            .description()
            .map(|description| {
                normalized_device_name(description.name())
                    .contains(&normalized_device_name(requested))
            })
            .unwrap_or(false)
}

fn normalized_device_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_omni_virtual_playback_device_name(name: &str) -> bool {
    name.contains("Omni Translate Virtual Speaker")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        append_capture_packet, begin_source_subscription, end_source_subscription,
        is_omni_virtual_playback_device_name, monitor_source_queue_needs_drop,
        normalized_device_name, playback_volume, record_source_read_result,
        sanitize_capture_sample, source_playback_job_is_stale, source_subscription_is_owner,
        source_watchdog_summary, state_snapshot, BridgeState,
    };

    #[test]
    fn playback_volume_normalizes_and_clamps_output_level() {
        assert_eq!(playback_volume(0), 0.0);
        assert_eq!(playback_volume(66), 0.66);
        assert_eq!(playback_volume(100), 1.0);
        assert_eq!(playback_volume(101), 1.0);
    }

    #[test]
    fn stale_source_playback_jobs_are_dropped() {
        assert!(!source_playback_job_is_stale(
            4,
            4,
            Duration::from_millis(100)
        ));
        assert!(source_playback_job_is_stale(
            4,
            4,
            Duration::from_millis(501)
        ));
        assert!(source_playback_job_is_stale(3, 4, Duration::from_millis(1)));
    }

    #[test]
    fn monitor_source_queue_drops_new_frames_at_emergency_limit() {
        assert!(!monitor_source_queue_needs_drop(24));
        assert!(monitor_source_queue_needs_drop(25));
    }

    #[test]
    fn silent_wasapi_capture_packet_is_zero_filled() {
        let mut sample_bytes = std::collections::VecDeque::new();
        append_capture_packet(&mut sample_bytes, vec![0x3f, 0x80, 0x00, 0x00], true);
        assert_eq!(sample_bytes, [0, 0, 0, 0]);
    }

    #[test]
    fn audible_wasapi_capture_packet_is_preserved() {
        let mut sample_bytes = std::collections::VecDeque::new();
        append_capture_packet(&mut sample_bytes, vec![1, 2, 3, 4], false);
        assert_eq!(sample_bytes, [1, 2, 3, 4]);
    }

    #[test]
    fn invalid_wasapi_capture_samples_are_replaced_with_silence() {
        assert_eq!(sanitize_capture_sample(f32::NAN), (0.0, true));
        assert_eq!(sanitize_capture_sample(f32::INFINITY), (0.0, true));
        assert_eq!(sanitize_capture_sample(2.0), (1.0, false));
    }

    #[test]
    fn virtual_speaker_is_rejected_as_monitor_playback_device() {
        assert!(is_omni_virtual_playback_device_name(
            "扬声器 (Omni Translate Virtual Speaker)"
        ));
        assert!(!is_omni_virtual_playback_device_name("USB Audio Device"));
    }

    #[test]
    fn physical_playback_name_matching_ignores_case_and_spaces() {
        let resolved = normalized_device_name("Headphones (iBasso-DC-Series)");
        let requested = normalized_device_name("ibasso-dc-series");

        assert!(resolved.contains(&requested));
    }

    #[test]
    fn source_subscriber_generation_ownership_prevents_stale_cleanup() {
        let mut state = BridgeState::new("0.1.0".to_string());
        let (gen_a, _) = begin_source_subscription(&mut state);
        assert!(gen_a > 0);
        let (gen_b, _) = begin_source_subscription(&mut state);
        assert_ne!(gen_a, gen_b);
        assert!(!source_subscription_is_owner(&state, gen_a));
        assert!(!end_source_subscription(&mut state, gen_a));
        assert!(source_subscription_is_owner(&state, gen_b));
        assert!(end_source_subscription(&mut state, gen_b));
        assert!(!state.source_subscriber_active);
    }

    #[test]
    fn source_read_result_tracks_zero_and_non_empty_reads() {
        let mut state = BridgeState::new("0.1.0".to_string());
        record_source_read_result(&mut state, 0);
        record_source_read_result(&mut state, 3840);
        assert_eq!(state.source_zero_byte_reads, 1);
        assert_eq!(state.source_bytes_read, 3840);
    }

    #[test]
    fn source_watchdog_reports_stalled_driver_read() {
        let mut state = BridgeState::new("0.1.0".to_string());
        state.source_subscriber_active = true;
        state.source_generation = 7;
        state.source_worker_phase = "reading-driver".to_string();
        state.source_worker_last_progress_timestamp_ms = Some(1000);
        state.source_read_calls = 1;
        let summary = source_watchdog_summary(&state, 7000);
        assert!(summary.contains("event=source_watchdog"));
        assert!(summary.contains("sourceSubscriberActive=true"));
        assert!(summary.contains("workerPhase=reading-driver"));
        assert!(summary.contains("lastProgressAgeMs=6000"));
    }

    #[test]
    fn state_snapshot_includes_source_diagnostics() {
        let mut state = BridgeState::new("0.1.0".to_string());
        state.driver_captured_bytes = 12;
        state.driver_delivered_bytes = 8;
        state.source_generation = 3;
        state.source_read_calls = 4;
        let snapshot = state_snapshot("request-1", &state);
        assert_eq!(snapshot["driverCapturedBytes"], 12);
        assert_eq!(snapshot["driverDeliveredBytes"], 8);
        assert_eq!(snapshot["sourceGeneration"], 3);
        assert_eq!(snapshot["sourceReadCalls"], 4);
    }
}
