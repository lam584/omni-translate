use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io;
use std::num::{NonZeroU16, NonZeroU32};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use omni_bridge_protocol::{
    audio_pipe_path, control_pipe_path, source_pipe_path, DEFAULT_PIPE_NAME,
    MAX_AUDIO_FRAME_HEADER_BYTES, MAX_AUDIO_FRAME_PAYLOAD_BYTES, MAX_CONTROL_MESSAGE_BYTES,
};
use omni_bridge_service::{
    accepted_audio_frame_ack, classify_driver_health_with_device_evidence, decode_pcm16le,
    mix_control_for_translation_frame, mix_for_monitor, mix_for_monitor_with_metrics,
    should_exit_after_control_command, singleton_mutex_name, validate_translation_frame,
    AudioFrameHeader, AudioFramePacer, DriverInstallState, MixControl, BRIDGE_PROTOCOL_VERSION,
    INTERNAL_CHANNEL_COUNT, INTERNAL_SAMPLE_RATE_HZ,
};
use omni_logging::{panic_hook, LogLevel, Logger};
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

static SERVICE_LOGGER: OnceLock<Logger> = OnceLock::new();

/// Route one bridge service log line through the shared logger (dynamic
/// level + 10MB×3 rotation + background writer thread). Falls back to stderr
/// in the narrow window before `BridgeHost::run` initializes the logger,
/// where no file destination exists yet.
pub(crate) fn service_log(level: LogLevel, source: &str, message: &str) {
    match SERVICE_LOGGER.get() {
        Some(logger) => logger.log(level, source, message),
        None => eprintln!("{message}"),
    }
}

fn init_service_logging(runtime_root: &Path) {
    let _ = SERVICE_LOGGER.set(Logger::with_env_level(
        runtime_root.join("bridge-service.log"),
        "bridge",
        LogLevel::Info,
    ));
    // No session id yet: the desktop session id only arrives with the
    // `bridge.init` handshake (SERVICE_LOGGER picks it up there).
    panic_hook::install(
        runtime_root.join("bridge-service.log"),
        runtime_root.join("panic.log"),
        "bridge",
        None,
    );
}

trait MapErrToString<T> {
    fn map_err_str(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> MapErrToString<T> for Result<T, E> {
    fn map_err_str(self) -> Result<T, String> {
        self.map_err(|error| format!("{error}"))
    }
}

use omni_bridge_service::probe_support::{
    DriverStatus, DRIVER_STATUS_BASE_SIZE, IOCTL_OMNI_BRIDGE_QUERY_STATUS,
    IOCTL_OMNI_BRIDGE_READ_PCM, IOCTL_OMNI_BRIDGE_RESET, OMNI_BRIDGE_DEVICE_PATH,
};

const OMNI_SOURCE_CHUNK_BYTES: usize = 960 * INTERNAL_CHANNEL_COUNT as usize * 2;
const OMNI_SOURCE_FRAME_INTERVAL_MS: u64 = 20;
const OMNI_SOURCE_QUEUE_CAPACITY: usize = 5;
const OMNI_MONITOR_SOURCE_QUEUE_CAPACITY: usize = 25;
const OMNI_MONITOR_SOURCE_BATCH_FRAMES: usize = 4_800;
const OMNI_SOURCE_STALE_AFTER_MS: u64 = 500;
const OMNI_SOURCE_SUMMARY_INTERVAL_SECS: u64 = 5;
#[allow(
    dead_code,
    reason = "driverless WASAPI fallback diagnostics are retained for recovery builds"
)]
const OMNI_CAPTURE_DIAGNOSTICS_INTERVAL_SECS: u64 = 5;
#[allow(
    dead_code,
    reason = "driverless WASAPI fallback restart policy is retained for recovery builds"
)]
const OMNI_SOURCE_RESTART_BACKOFF_MS: [u64; 4] = [250, 500, 1_000, 2_000];
const MONITOR_VIRTUAL_PLAYBACK_LOOP: &str = "monitor.virtual-playback-loop";

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

struct BridgeHost {
    pipe_name: String,
    runtime_root: PathBuf,
    bridge_version: String,
}

impl BridgeHost {
    fn from_args(args: &[String]) -> Self {
        Self {
            pipe_name: read_arg(args, "--pipe-name").unwrap_or_else(|| DEFAULT_PIPE_NAME.into()),
            runtime_root: PathBuf::from(
                read_arg(args, "--runtime-root").unwrap_or_else(|| ".".to_string()),
            ),
            bridge_version: read_arg(args, "--bridge-version")
                .unwrap_or_else(|| "0.1.0".to_string()),
        }
    }

    fn run(self) -> Result<(), String> {
        init_service_logging(&self.runtime_root);
        let _singleton_mutex = acquire_singleton_mutex(&self.pipe_name)?;
        let pid_file = write_runtime_pid_file(&self.runtime_root)?;
        let control_pipe = control_pipe_path(&self.pipe_name);
        let audio_pipe = audio_pipe_path(&self.pipe_name);
        let source_pipe = source_pipe_path(&self.pipe_name);
        let state = Arc::new(Mutex::new(BridgeState::new(self.bridge_version)));
        let (playback_tx, playback_rx) = mpsc::sync_channel::<PlaybackCommand>(128);
        let (source_tx, source_rx) = mpsc::sync_channel::<Vec<u8>>(32);

        PlaybackWorker::new(playback_rx, state.clone()).spawn();
        DriverCaptureWorker::new(
            state.clone(),
            self.runtime_root.clone(),
            playback_tx.clone(),
            source_tx,
        )
        .spawn();

        let watchdog_state = state.clone();
        let watchdog_runtime_root = self.runtime_root.clone();
        thread::spawn(move || run_source_watchdog(watchdog_state, watchdog_runtime_root));
        spawn_audio_pipe_server(
            audio_pipe.clone(),
            state.clone(),
            self.runtime_root.clone(),
            playback_tx.clone(),
        );
        spawn_source_pipe_server(
            source_pipe.clone(),
            state.clone(),
            source_rx,
            playback_tx.clone(),
            self.runtime_root.clone(),
        );
        println!(
            "{}",
            json!({
                "type": "bridge-service.ready",
                "pipePath": control_pipe,
                "audioPipePath": audio_pipe,
                "sourcePipePath": source_pipe,
                "runtimeRoot": self.runtime_root,
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            })
        );
        NamedPipeControlServer::new(
            control_pipe,
            state,
            playback_tx,
            self.runtime_root,
            pid_file,
        )
        .serve();
        Ok(())
    }
}

struct PlaybackWorker {
    receiver: mpsc::Receiver<PlaybackCommand>,
    state: Arc<Mutex<BridgeState>>,
}

impl PlaybackWorker {
    fn new(receiver: mpsc::Receiver<PlaybackCommand>, state: Arc<Mutex<BridgeState>>) -> Self {
        Self { receiver, state }
    }

    fn spawn(self) {
        thread::spawn(move || run_playback_worker(self.receiver, self.state));
    }
}

struct NamedPipeControlServer {
    pipe_name: String,
    state: Arc<Mutex<BridgeState>>,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    runtime_root: PathBuf,
    pid_file: RuntimePidFile,
}

impl NamedPipeControlServer {
    fn new(
        pipe_name: String,
        state: Arc<Mutex<BridgeState>>,
        playback_tx: mpsc::SyncSender<PlaybackCommand>,
        runtime_root: PathBuf,
        pid_file: RuntimePidFile,
    ) -> Self {
        Self {
            pipe_name,
            state,
            playback_tx,
            runtime_root,
            pid_file,
        }
    }

    fn serve(self) {
        serve_named_pipe(&self.pipe_name, move |handle| {
            handle_control_client(
                handle,
                &self.state,
                &self.playback_tx,
                &self.runtime_root,
                &self.pid_file.path,
            )
        });
    }
}

pub(super) fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    BridgeHost::from_args(&args).run()
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

fn spawn_audio_pipe_server(
    pipe_name: String,
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
) {
    thread::spawn(move || {
        serve_named_pipe(&pipe_name, move |handle| {
            handle_audio_client(handle, &state, &runtime_root, &playback_tx)
        });
    });
}

fn spawn_source_pipe_server(
    pipe_name: String,
    state: Arc<Mutex<BridgeState>>,
    source_rx: mpsc::Receiver<Vec<u8>>,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    runtime_root: PathBuf,
) {
    let source_rx = Arc::new(Mutex::new(source_rx));
    thread::spawn(move || {
        serve_named_pipe(&pipe_name, move |handle| {
            handle_source_subscriber(handle, &state, &source_rx, &playback_tx, &runtime_root)
        });
    });
}

fn handle_control_client(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    runtime_root: &Path,
    pid_path: &Path,
) {
    let line = match read_line(handle, MAX_CONTROL_MESSAGE_BYTES) {
        Ok(line) => line,
        Err(error) => {
            service_log(
                LogLevel::Error,
                &format!("{}:{}", file!(), line!()),
                &format!("failed to read control command: {error}"),
            );
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
            // Correlate bridge-service.log lines with the desktop session:
            // every subsequent line carries the trailing ` sid=<value>` token.
            if let Some(logger) = SERVICE_LOGGER.get() {
                logger.set_session_id(current.session_id.clone());
            }
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
    if header_len == 0 || header_len > MAX_AUDIO_FRAME_HEADER_BYTES {
        return;
    }
    let Ok(header_bytes) = read_exact(handle, header_len) else {
        return;
    };
    let Ok(header) = serde_json::from_slice::<AudioFrameHeader>(&header_bytes) else {
        return;
    };
    if header.payload_bytes > MAX_AUDIO_FRAME_PAYLOAD_BYTES {
        return;
    }
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
    let playback_mix = mix_control_for_translation_frame(
        &current.mix_control,
        header.translated_audio_enhancement_applied,
    );
    let (monitor_samples, enhancement) = mix_for_monitor_with_metrics(
        &[],
        &samples,
        header.sample_rate_hz,
        header.channel_count,
        &playback_mix,
    );
    if let Some(metrics) = enhancement {
        service_log(
            LogLevel::Info,
            &header.request_id,
            &format!(
                "event=translation_gain_applied preprocessed={} activeRmsDbfs={:?} inputPeakDbfs={:?} autoGainDb={:.3} requestedGainDb={:.3} appliedGainDb={:.3} peakLimited={} muted={}",
                header.translated_audio_enhancement_applied,
                metrics.active_rms_dbfs,
                metrics.input_peak_dbfs,
                metrics.auto_gain_db,
                metrics.requested_gain_db,
                metrics.applied_gain_db,
                metrics.peak_limited,
                metrics.muted,
            ),
        );
    }
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

include!("capture.rs");
include!("playback.rs");
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        append_capture_packet, begin_source_subscription, end_source_subscription,
        is_omni_virtual_playback_device_name, monitor_source_queue_needs_drop,
        normalized_device_name, playback_volume, record_source_read_result,
        sanitize_capture_sample, source_playback_job_is_stale, source_subscription_is_owner,
        source_watchdog_summary, state_snapshot, BridgeHost, BridgeState,
    };

    #[test]
    fn playback_volume_normalizes_and_clamps_output_level() {
        assert_eq!(playback_volume(0), 0.0);
        assert_eq!(playback_volume(66), 0.66);
        assert_eq!(playback_volume(100), 1.0);
        assert_eq!(playback_volume(101), 1.0);
    }

    #[test]
    fn bridge_host_reads_runtime_arguments_once_at_composition_root() {
        let host = BridgeHost::from_args(&[
            "omni-bridge-service".to_string(),
            "--pipe-name".to_string(),
            "test-control".to_string(),
            "--runtime-root".to_string(),
            "C:\\bridge-runtime".to_string(),
            "--bridge-version".to_string(),
            "2.0.0-test".to_string(),
        ]);

        assert_eq!(host.pipe_name, "test-control");
        assert_eq!(
            host.runtime_root,
            std::path::PathBuf::from("C:\\bridge-runtime")
        );
        assert_eq!(host.bridge_version, "2.0.0-test");
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
