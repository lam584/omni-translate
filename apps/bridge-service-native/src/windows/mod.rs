use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io;
use std::num::{NonZeroU16, NonZeroU32};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::ptr;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use omni_bridge_protocol::{
    audio_pipe_path, control_pipe_path, source_pipe_path, TranslationPlaybackStatusAck,
    TranslationPlaybackStatusEvent, TranslationPlaybackStatusKind, TranslationStreamState,
    DEFAULT_PIPE_NAME, MAX_AUDIO_FRAME_HEADER_BYTES, MAX_AUDIO_FRAME_PAYLOAD_BYTES,
    MAX_CONTROL_MESSAGE_BYTES,
};
use omni_bridge_service::{
    accepted_audio_frame_ack, classify_driver_health_with_device_evidence,
    classify_process_loopback_capability, decode_pcm16le,
    mix_control_for_translation_frame, mix_for_monitor, mix_for_monitor_with_metrics,
    rejected_audio_frame_ack, should_exit_after_control_command, singleton_mutex_name,
    validate_translation_frame, AudioFrameHeader, AudioFramePacer, AudioRouteDirection,
    AudioSampleFormat, CaptureBackend, DriverInstallState, MixControl, ProcessLoopbackStatus,
    SourceCaptureMode, TranslationAudioSink,
    BRIDGE_PROTOCOL_VERSION, INTERNAL_CHANNEL_COUNT, INTERNAL_SAMPLE_RATE_HZ,
    PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD,
};
use omni_logging::{panic_hook, LogLevel, Logger};
use rodio::{buffer::SamplesBuffer, DeviceSinkBuilder, MixerDeviceSink, Player};
use serde_json::{json, Value};
use wasapi::{
    initialize_mta, Device, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcessId};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Wdk::System::SystemServices::RtlGetVersion;

mod capture_process;
mod audio_client;
mod virtual_mic;
mod win32;

use self::audio_client::{
    handle_physical_translation_frame, handle_virtual_mic_frame, spawn_audio_pipe_server,
};
#[cfg(test)]
use self::audio_client::handle_virtual_mic_frame_with_writer;
use self::capture_process::ProcessLoopbackCaptureWorker;
use self::virtual_mic::{
    apply_virtual_mic_driver_status, probe_virtual_mic_output, stop_virtual_mic_session,
    virtual_mic_generation, virtual_mic_output_status_for_error,
    write_stereo_f32_to_virtual_mic, VirtualMicCapability, VirtualMicWriteError,
    VirtualMicWriteOutcome,
};
#[cfg(test)]
use self::capture_process::{fail_process_loopback_route, take_process_capture_chunk};

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
// Driver status normally supplies this budget. Keep the fallback tied to the
// canonical one-second 48 kHz stereo PCM16 geometry instead of a frame-count
// magic number so a transient status-query failure retains the same contract.
const OMNI_SOURCE_DRIVER_MAX_BUFFERED_BYTES_FALLBACK: u32 =
    INTERNAL_SAMPLE_RATE_HZ
        * INTERNAL_CHANNEL_COUNT as u32
        * std::mem::size_of::<i16>() as u32;
const OMNI_MONITOR_SOURCE_QUEUE_CAPACITY: usize = 25;
const OMNI_MONITOR_SOURCE_BATCH_FRAMES: usize = 4_800;
const OMNI_SOURCE_STALE_AFTER_MS: u64 = 500;
const OMNI_SOURCE_SUMMARY_INTERVAL_SECS: u64 = 5;
const TRANSLATION_MAX_PROJECTED_LATENCY_MS: u64 = 5_000;
const TRANSLATION_PLAYBACK_QUEUE_CAPACITY: usize = 128;
const PLAYBACK_WORKER_POLL_INTERVAL_MS: u64 = 10;
const PHYSICAL_TRANSLATION_STREAM_STARTUP_BUFFER_MS: u64 = 4_000;
const PHYSICAL_TRANSLATION_STREAM_STARTUP_MAX_WAIT_MS: u64 = 4_500;
const VIRTUAL_MIC_TERMINAL_LEDGER_CAPACITY: usize = 128;
const PROCESS_LOOPBACK_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

fn source_pacer_ingress_capacity(driver_max_buffered_bytes: u32) -> usize {
    let max_buffered_bytes = if driver_max_buffered_bytes == 0 {
        OMNI_SOURCE_DRIVER_MAX_BUFFERED_BYTES_FALLBACK
    } else {
        driver_max_buffered_bytes
    } as usize;
    max_buffered_bytes.div_ceil(OMNI_SOURCE_CHUNK_BYTES).max(1)
}
// `wasapi::AudioClient::new_application_loopback_client` maps false to
// PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.
const INCLUDE_BRIDGE_PROCESS_TREE_IN_LOOPBACK: bool = false;
#[allow(dead_code, reason = "legacy endpoint-loopback diagnostics are not selectable at runtime")]
const OMNI_CAPTURE_DIAGNOSTICS_INTERVAL_SECS: u64 = 5;
#[allow(dead_code, reason = "legacy endpoint-loopback diagnostics are not selectable at runtime")]
const OMNI_SOURCE_RESTART_BACKOFF_MS: [u64; 4] = [250, 500, 1_000, 2_000];
const MONITOR_VIRTUAL_PLAYBACK_LOOP: &str = "monitor.virtual-playback-loop";

struct VirtualMicCueProgress {
    chunk_count: u32,
    next_chunk_index: u32,
    write_in_flight: bool,
}

#[derive(Default)]
struct VirtualMicCueLedger {
    active: HashMap<String, VirtualMicCueProgress>,
    terminal: VecDeque<String>,
}

enum VirtualMicChunkAdmission {
    Write { emit_queued: bool },
    Duplicate,
}

impl VirtualMicCueLedger {
    fn begin(
        &mut self,
        cue_id: &str,
        chunk_index: u32,
        chunk_count: u32,
    ) -> Result<VirtualMicChunkAdmission, &'static str> {
        if self.terminal.iter().any(|terminal| terminal == cue_id) {
            return Ok(VirtualMicChunkAdmission::Duplicate);
        }
        if !self.active.contains_key(cue_id) {
            if chunk_index != 0 {
                return Err("virtual-mic-first-chunk-missing");
            }
            self.active.insert(
                cue_id.to_string(),
                VirtualMicCueProgress {
                    chunk_count,
                    next_chunk_index: 0,
                    write_in_flight: true,
                },
            );
            return Ok(VirtualMicChunkAdmission::Write { emit_queued: true });
        }

        let progress = self.active.get_mut(cue_id).unwrap();
        if progress.chunk_count != chunk_count {
            return Err("virtual-mic-chunk-count-changed");
        }
        if chunk_index < progress.next_chunk_index {
            return Ok(VirtualMicChunkAdmission::Duplicate);
        }
        if progress.write_in_flight || chunk_index != progress.next_chunk_index {
            return Err("virtual-mic-chunk-out-of-order");
        }
        progress.write_in_flight = true;
        Ok(VirtualMicChunkAdmission::Write { emit_queued: false })
    }

    fn complete_success(&mut self, cue_id: &str, chunk_index: u32) -> Option<(bool, bool)> {
        let progress = self.active.get_mut(cue_id)?;
        if !progress.write_in_flight || progress.next_chunk_index != chunk_index {
            return None;
        }
        progress.write_in_flight = false;
        progress.next_chunk_index = progress.next_chunk_index.saturating_add(1);
        let is_first = chunk_index == 0;
        let is_final = progress.next_chunk_index == progress.chunk_count;
        if is_final {
            self.active.remove(cue_id);
            self.remember_terminal(cue_id);
        }
        Some((is_first, is_final))
    }

    fn complete_terminal(&mut self, cue_id: &str) -> bool {
        if self.terminal.iter().any(|terminal| terminal == cue_id) {
            return false;
        }
        self.active.remove(cue_id);
        self.remember_terminal(cue_id);
        true
    }

    fn remember_terminal(&mut self, cue_id: &str) {
        if self.terminal.len() == VIRTUAL_MIC_TERMINAL_LEDGER_CAPACITY {
            self.terminal.pop_front();
        }
        self.terminal.push_back(cue_id.to_string());
    }

    fn reset(&mut self) {
        self.active.clear();
        self.terminal.clear();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessLoopbackTerminalEvidence {
    generation: u64,
    status: String,
    timestamp_ms: u64,
    detail: Option<String>,
}

impl ProcessLoopbackTerminalEvidence {
    fn new(generation: u64, status: &str, detail: Option<String>) -> Self {
        Self {
            generation,
            status: status.to_string(),
            timestamp_ms: unix_ms(),
            detail,
        }
    }

    fn authorizes_shutdown(&self, requested_generation: u64) -> bool {
        self.generation == requested_generation
            && matches!(self.status.as_str(), "stopped" | "not-active")
    }
}

#[derive(Default)]
struct ProcessLoopbackLifecycleState {
    active_generation: Option<u64>,
    shutdown_requested: bool,
    blocked_generation: Option<u64>,
    terminal: Option<ProcessLoopbackTerminalEvidence>,
}

#[derive(Default)]
struct ProcessLoopbackLifecycle {
    state: Mutex<ProcessLoopbackLifecycleState>,
    changed: Condvar,
}

impl ProcessLoopbackLifecycle {
    fn begin_generation(&self, generation: u64) -> bool {
        let mut lifecycle = self.state.lock().unwrap();
        if lifecycle.shutdown_requested {
            return false;
        }
        lifecycle.active_generation = Some(generation);
        true
    }

    fn publish_terminal(&self, evidence: ProcessLoopbackTerminalEvidence) {
        let mut lifecycle = self.state.lock().unwrap();
        if lifecycle.active_generation == Some(evidence.generation) {
            lifecycle.active_generation = None;
        }
        lifecycle.terminal = Some(evidence);
        self.changed.notify_all();
    }

    fn shutdown_is_requested(&self) -> bool {
        self.state.lock().unwrap().shutdown_requested
    }

    fn request_shutdown(&self, fallback_generation: u64) -> u64 {
        let mut lifecycle = self.state.lock().unwrap();
        let blocked_generation = lifecycle
            .blocked_generation
            .filter(|_| lifecycle.shutdown_requested)
            .unwrap_or_else(|| {
                lifecycle
                    .active_generation
                    .unwrap_or(fallback_generation)
            });
        lifecycle.shutdown_requested = true;
        lifecycle.blocked_generation = Some(blocked_generation);
        blocked_generation
    }

    #[cfg(test)]
    fn request_shutdown_and_wait(
        &self,
        fallback_generation: u64,
        timeout: Duration,
    ) -> Result<ProcessLoopbackTerminalEvidence, String> {
        let blocked_generation = self.request_shutdown(fallback_generation);
        self.wait_for_shutdown_terminal(blocked_generation, timeout)
    }

    fn wait_for_shutdown_terminal(
        &self,
        blocked_generation: u64,
        timeout: Duration,
    ) -> Result<ProcessLoopbackTerminalEvidence, String> {
        let mut lifecycle = self.state.lock().unwrap();
        if let Some(terminal) = lifecycle
            .terminal
            .as_ref()
            .filter(|terminal| terminal.generation == blocked_generation)
        {
            return Ok(terminal.clone());
        }
        let Some(active_generation) = lifecycle.active_generation else {
            let evidence = ProcessLoopbackTerminalEvidence::new(
                blocked_generation,
                "not-active",
                None,
            );
            lifecycle.terminal = Some(evidence.clone());
            self.changed.notify_all();
            return Ok(evidence);
        };
        let (lifecycle, wait_result) = self
            .changed
            .wait_timeout_while(lifecycle, timeout, |current| {
                current
                    .terminal
                    .as_ref()
                    .is_none_or(|terminal| terminal.generation != active_generation)
            })
            .map_err(|_| {
                "process loopback lifecycle lock was poisoned during shutdown".to_string()
            })?;
        if let Some(terminal) = lifecycle
            .terminal
            .as_ref()
            .filter(|terminal| terminal.generation == active_generation)
        {
            return Ok(terminal.clone());
        }
        let active = lifecycle
            .active_generation
            .map(|generation| generation.to_string())
            .unwrap_or_else(|| "none".to_string());
        Err(format!(
            "process loopback generation {active_generation} did not publish terminal evidence within {} ms (activeGeneration={active}, timedOut={})",
            timeout.as_millis(),
            wait_result.timed_out(),
        ))
    }

    #[cfg(test)]
    fn active_generation(&self) -> Option<u64> {
        self.state.lock().unwrap().active_generation
    }
}

#[derive(Default)]
struct BridgeState {
    bridge_process_id: u32,
    bridge_instance_id: String,
    session_id: Option<String>,
    bridge_state: String,
    lifecycle_state: String,
    driver_health: String,
    driver_version: Option<String>,
    bridge_version: String,
    source_capture_mode: SourceCaptureMode,
    capture_backend: CaptureBackend,
    process_loopback_supported: bool,
    process_loopback_status: ProcessLoopbackStatus,
    windows_build_number: Option<u32>,
    excluded_process_id: Option<u32>,
    process_loopback_failure_detail: Option<String>,
    process_loopback_shutdown_requested_generation: Option<u64>,
    process_loopback_terminal_generation: Option<u64>,
    process_loopback_terminal_status: Option<String>,
    process_loopback_terminal_timestamp_ms: Option<u64>,
    process_loopback_terminal_detail: Option<String>,
    process_loopback_lifecycle: Arc<ProcessLoopbackLifecycle>,
    virtual_render_device_id: String,
    physical_playback_device_id: String,
    resolved_physical_playback_device_id: String,
    physical_playback_status: String,
    playback_owner_generation: u64,
    init_epoch: u64,
    playback_owner_reservation: u64,
    physical_playback_level: u64,
    translation_playback_enabled: bool,
    source_monitor_playback_enabled: bool,
    monitor_playback_state: String,
    mix_control: MixControl,
    queued_frames: usize,
    source_frames_captured: u64,
    translated_frames_accepted: u64,
    virtual_mic_output_requested: bool,
    virtual_mic_frames_written: u64,
    virtual_mic_write_failures: u64,
    virtual_mic_last_generation: u64,
    virtual_mic_output_supported: bool,
    virtual_mic_output_status: String,
    virtual_mic_capture_endpoint_name: Option<String>,
    virtual_mic_format: Option<String>,
    virtual_mic_buffered_bytes: u64,
    virtual_mic_max_buffered_bytes: u64,
    virtual_mic_consumed_bytes: u64,
    virtual_mic_dropped_bytes: u64,
    virtual_mic_underrun_bytes: u64,
    virtual_mic_rejected_writes: u64,
    virtual_mic_session_active: bool,
    virtual_mic_cue_ledger: VirtualMicCueLedger,
    physical_translation_stream_ledger: PhysicalTranslationStreamLedger,
    translation_generation: u64,
    translation_arrival_sequence: u64,
    translation_queue_end_timestamp_ms: u64,
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
    translation_status_outbox: Option<Arc<Mutex<TranslationStatusOutbox>>>,
    translation_cue_authorities: Mutex<HashMap<String, TranslationCueAuthority>>,
}

#[derive(Clone)]
struct TranslationCueAuthority {
    session_id: String,
    bridge_instance_id: String,
    source_generation: u64,
    source_generation_token: String,
    playback_owner_generation: u64,
    physical_playback_device_id: String,
}

impl BridgeState {
    fn emit_translation_status_with_authority(
        &self,
        authority: TranslationCueAuthority,
        cue_id: Option<&str>,
        status: TranslationPlaybackStatusKind,
        reason: &str,
        error_code: Option<&str>,
    ) {
        let Some(outbox) = self.translation_status_outbox.as_ref() else {
            return;
        };
        let mut outbox = outbox.lock().unwrap();
        let status_id = outbox.next_status_id();
        outbox.push(TranslationPlaybackStatusEvent {
            event_type: "bridge.translation.status".to_string(),
            request_id: status_id.clone(),
            status_id,
            session_id: authority.session_id,
            bridge_instance_id: authority.bridge_instance_id,
            source_generation: authority.source_generation,
            source_generation_token: authority.source_generation_token,
            playback_owner_generation: authority.playback_owner_generation,
            physical_playback_device_id: authority.physical_playback_device_id,
            cue_id: cue_id.unwrap_or("-").to_string(),
            playback_status: status,
            reason: reason.to_string(),
            error_code: error_code.map(str::to_string),
            timestamp_ms: unix_ms(),
        });
    }

    fn new(bridge_version: String) -> Self {
        let windows_build_number = windows_build_number();
        let (process_loopback_supported, process_loopback_status) =
            classify_process_loopback_capability(windows_build_number);
        let bridge_process_id = std::process::id();
        Self {
            bridge_process_id,
            bridge_instance_id: uuid::Uuid::new_v4().simple().to_string(),
            bridge_state: "stopped".to_string(),
            lifecycle_state: "idle".to_string(),
            driver_health: "not-installed".to_string(),
            bridge_version,
            process_loopback_supported,
            process_loopback_status,
            windows_build_number,
            monitor_playback_state: "idle".to_string(),
            physical_playback_status: "uninitialized".to_string(),
            source_worker_phase: "capture-disabled".to_string(),
            virtual_mic_output_status: "unknown".to_string(),
            // A source generation is only compared for equality/authority; it
            // is not an array index. Seeding it with the producer PID makes a
            // real process restart observable even when both processes create
            // their first source subscription at the same local offset.
            source_generation: u64::from(bridge_process_id) << 32,
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

    fn emit_translation_status(
        &self,
        cue_id: Option<&str>,
        status: TranslationPlaybackStatusKind,
        reason: &str,
        error_code: Option<&str>,
    ) {
        let cue_authority = cue_id.and_then(|cue_id| {
            let mut authorities = self.translation_cue_authorities.lock().unwrap();
            if status.is_terminal() {
                authorities.remove(cue_id)
            } else {
                authorities.get(cue_id).cloned()
            }
        });
        // Status is formal evidence for an already accepted cue. If no ledger
        // entry exists, borrowing the current owner would let an old or
        // malformed frame terminalize a different incarnation's reused cueId.
        let Some(authority) = cue_authority else {
            return;
        };
        self.emit_translation_status_with_authority(
            authority,
            cue_id,
            status,
            reason,
            error_code,
        );
    }

    fn bind_translation_cue_authority(&self, header: &AudioFrameHeader) {
        let Some(cue_id) = header.cue_id.as_deref().filter(|value| !value.trim().is_empty()) else {
            return;
        };
        let Some(bridge_instance_id) = header.bridge_instance_id.clone() else {
            return;
        };
        let Some(source_generation) = header.source_generation else {
            return;
        };
        let Some(source_generation_token) = header.source_generation_token.clone() else {
            return;
        };
        let Some(playback_owner_generation) = header.playback_owner_generation else {
            return;
        };
        let Some(physical_playback_device_id) = header.physical_playback_device_id.clone() else {
            return;
        };
        self.translation_cue_authorities.lock().unwrap().insert(
            cue_id.to_string(),
            TranslationCueAuthority {
                session_id: header.session_id.clone(),
                bridge_instance_id,
                source_generation,
                source_generation_token,
                playback_owner_generation,
                physical_playback_device_id,
            },
        );
    }

    fn next_translation_arrival_sequence(&mut self) -> u64 {
        self.translation_arrival_sequence = self
            .translation_arrival_sequence
            .checked_add(1)
            .expect("translation arrival sequence exhausted");
        self.translation_arrival_sequence
    }
}

fn record_process_loopback_terminal_evidence(
    state: &Arc<Mutex<BridgeState>>,
    evidence: &ProcessLoopbackTerminalEvidence,
) {
    let mut current = state.lock().unwrap();
    current.process_loopback_terminal_generation = Some(evidence.generation);
    current.process_loopback_terminal_status = Some(evidence.status.clone());
    current.process_loopback_terminal_timestamp_ms = Some(evidence.timestamp_ms);
    current.process_loopback_terminal_detail = evidence.detail.clone();
}

fn translation_cue_authority_from_header(
    header: &AudioFrameHeader,
) -> Option<TranslationCueAuthority> {
    Some(TranslationCueAuthority {
        session_id: header.session_id.clone(),
        bridge_instance_id: header.bridge_instance_id.clone()?,
        source_generation: header.source_generation?,
        source_generation_token: header.source_generation_token.clone()?,
        playback_owner_generation: header.playback_owner_generation?,
        physical_playback_device_id: header.physical_playback_device_id.clone()?,
    })
}

fn virtual_mic_ledger_key(header: &AudioFrameHeader) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        header.cue_id.as_deref().unwrap_or_default(),
        header.session_id,
        header.bridge_instance_id.as_deref().unwrap_or_default(),
        header.source_generation.unwrap_or_default(),
        header.source_generation_token.as_deref().unwrap_or_default(),
        header.playback_owner_generation.unwrap_or_default(),
        header.physical_playback_device_id.as_deref().unwrap_or_default(),
    )
}

fn source_generation_token(state: &BridgeState, generation: u64) -> String {
    format!(
        "{}:{}:{generation}",
        state.bridge_instance_id,
        state.session_id.as_deref().unwrap_or("no-session")
    )
}

include!("translation.rs");

struct PlaybackOutput {
    device_id: String,
    resolved_device_id: String,
    _sink: MixerDeviceSink,
    source_player: Player,
    translation_player: Player,
    source_pending_samples: Vec<f32>,
    source_volume: f32,
    duck_until: Option<Instant>,
    stream_ducking: bool,
    translation_generation: Option<u64>,
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
    diagnostic_child_tone: Option<DiagnosticChildTone>,
}

include!("diagnostic_child.rs");

impl BridgeHost {
    fn from_args(args: &[String]) -> Self {
        Self {
            pipe_name: read_arg(args, "--pipe-name").unwrap_or_else(|| DEFAULT_PIPE_NAME.into()),
            runtime_root: PathBuf::from(read_arg(args, "--runtime-root").unwrap_or_else(|| ".".to_string())),
            bridge_version: read_arg(args, "--bridge-version").unwrap_or_else(|| "0.1.0".to_string()),
            diagnostic_child_tone: DiagnosticChildTone::from_args(args),
        }
    }

    fn run(self) -> Result<(), String> {
        init_service_logging(&self.runtime_root);
        let _singleton_mutex = acquire_singleton_mutex(&self.pipe_name)?;
        let pid_file = write_runtime_pid_file(&self.runtime_root)?;
        let control_pipe = control_pipe_path(&self.pipe_name);
        let audio_pipe = audio_pipe_path(&self.pipe_name);
        let source_pipe = source_pipe_path(&self.pipe_name);
        let translation_status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let mut initial_state = BridgeState::new(self.bridge_version);
        initial_state.translation_status_outbox = Some(translation_status_outbox.clone());
        let state = Arc::new(Mutex::new(initial_state));
        let (playback_tx, playback_rx) = mpsc::sync_channel::<PlaybackCommand>(128);
        let (playback_control_tx, playback_control_rx) =
            mpsc::channel::<PlaybackControlCommand>();
        let (source_tx, source_rx) = mpsc::sync_channel::<Vec<u8>>(32);
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(
            TRANSLATION_PLAYBACK_QUEUE_CAPACITY,
        )));

        PlaybackWorker::new(
            playback_rx,
            playback_control_rx,
            state.clone(),
            translation_queue.clone(),
        )
        .spawn();
        DriverCaptureWorker::new(
            state.clone(),
            self.runtime_root.clone(),
            playback_tx.clone(),
            source_tx.clone(),
        )
        .spawn();
        ProcessLoopbackCaptureWorker::new(
            state.clone(),
            self.runtime_root.clone(),
            playback_tx.clone(),
            playback_control_tx.clone(),
            translation_queue.clone(),
            source_tx,
        )
        .spawn();
        if let Some(diagnostic_child_tone) = self.diagnostic_child_tone {
            spawn_diagnostic_child_tone_launcher(diagnostic_child_tone);
        }

        let watchdog_state = state.clone();
        let watchdog_runtime_root = self.runtime_root.clone();
        thread::spawn(move || run_source_watchdog(watchdog_state, watchdog_runtime_root));
        spawn_audio_pipe_server(
            audio_pipe.clone(),
            state.clone(),
            self.runtime_root.clone(),
            playback_tx.clone(),
            playback_control_tx.clone(),
            translation_queue.clone(),
        );
        spawn_source_pipe_server(
            source_pipe.clone(),
            state.clone(),
            source_rx,
            translation_status_outbox,
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
                "processLoopbackSupported": state.lock().unwrap().process_loopback_supported,
            })
        );
        NamedPipeControlServer::new(
            control_pipe,
            state,
            playback_tx,
            playback_control_tx,
            translation_queue,
            self.runtime_root,
            pid_file,
        )
        .serve();
        Ok(())
    }
}

struct PlaybackWorker {
    receiver: mpsc::Receiver<PlaybackCommand>,
    control_receiver: mpsc::Receiver<PlaybackControlCommand>,
    state: Arc<Mutex<BridgeState>>,
    translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
}

impl PlaybackWorker {
    fn new(
        receiver: mpsc::Receiver<PlaybackCommand>,
        control_receiver: mpsc::Receiver<PlaybackControlCommand>,
        state: Arc<Mutex<BridgeState>>,
        translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
    ) -> Self {
        Self {
            receiver,
            control_receiver,
            state,
            translation_queue,
        }
    }

    fn spawn(self) {
        thread::spawn(move || {
            run_playback_worker(
                self.receiver,
                self.control_receiver,
                self.state,
                self.translation_queue,
            )
        });
    }
}

struct NamedPipeControlServer {
    pipe_name: String,
    state: Arc<Mutex<BridgeState>>,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: mpsc::Sender<PlaybackControlCommand>,
    translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
    runtime_root: PathBuf,
    pid_file: RuntimePidFile,
}

impl NamedPipeControlServer {
    fn new(
        pipe_name: String,
        state: Arc<Mutex<BridgeState>>,
        playback_tx: mpsc::SyncSender<PlaybackCommand>,
        playback_control_tx: mpsc::Sender<PlaybackControlCommand>,
        translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
        runtime_root: PathBuf,
        pid_file: RuntimePidFile,
    ) -> Self {
        Self {
            pipe_name,
            state,
            playback_tx,
            playback_control_tx,
            translation_queue,
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
                &self.playback_control_tx,
                &self.translation_queue,
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

fn spawn_source_pipe_server(
    pipe_name: String,
    state: Arc<Mutex<BridgeState>>,
    source_rx: mpsc::Receiver<Vec<u8>>,
    translation_status_outbox: Arc<Mutex<TranslationStatusOutbox>>,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    runtime_root: PathBuf,
) {
    let source_rx = Arc::new(Mutex::new(source_rx));
    thread::spawn(move || {
        serve_named_pipe(&pipe_name, move |handle| {
            handle_source_subscriber(
                handle,
                &state,
                &source_rx,
                &translation_status_outbox,
                &playback_tx,
                &runtime_root,
            )
        });
    });
}

fn handle_control_client(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
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
            handle_control(
                command,
                state,
                playback_tx,
                playback_control_tx,
                translation_queue,
                runtime_root,
            )
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
    if control_response_authorizes_exit(should_exit, &response) {
        flush_file_buffers(handle);
        let _ = fs::remove_file(pid_path);
        std::process::exit(0);
    }
}

fn control_response_authorizes_exit(exit_requested: bool, response: &Value) -> bool {
    let requested_generation = response["processLoopbackShutdownRequestedGeneration"].as_u64();
    let terminal_generation = response["processLoopbackTerminalGeneration"].as_u64();
    exit_requested
        && response["type"] == "bridge.state.snapshot"
        && requested_generation.is_some()
        && requested_generation == terminal_generation
        && matches!(
            response["processLoopbackTerminalStatus"].as_str(),
            Some("stopped" | "not-active")
        )
        && response["processLoopbackTerminalTimestampMs"].is_number()
        && response["bridgeState"] == "stopped"
        && response["lifecycleState"] == "stopped"
}

include!("control.rs");

fn translation_dispatch_error(
    header: &AudioFrameHeader,
) -> Option<(&'static str, &'static str, &'static str)> {
    match (header.translation_sink, header.route_direction) {
        (Some(TranslationAudioSink::PhysicalPlayback), Some(AudioRouteDirection::Inbound)) => None,
        (Some(TranslationAudioSink::VirtualMic), Some(AudioRouteDirection::Outbound)) => None,
        _ => Some((
            "bridge.invalid-audio-direction",
            "invalid-translation-sink-direction",
            "translation frames require physical-playback/inbound or virtual-mic/outbound",
        )),
    }
}

fn translation_frame_has_current_authority(
    current: &BridgeState,
    header: &AudioFrameHeader,
) -> bool {
    !header.session_id.trim().is_empty()
        && header.session_id == current.session_id.as_deref().unwrap_or_default()
        && header.bridge_instance_id.as_deref() == Some(current.bridge_instance_id.as_str())
        && header.source_generation == Some(current.source_generation)
        && header.source_generation_token.as_deref()
            == Some(source_generation_token(current, current.source_generation).as_str())
        && header.playback_owner_generation == Some(current.playback_owner_generation)
        && !current.resolved_physical_playback_device_id.trim().is_empty()
        && header.physical_playback_device_id.as_deref()
            == Some(current.resolved_physical_playback_device_id.as_str())
}

fn handle_audio_client(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
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
    if !translation_frame_has_current_authority(&current, &header) {
        let code = "bridge.translation-generation-ended";
        let ack = rejected_audio_frame_ack(
            &header,
            code,
            "translation frame belongs to a superseded or incomplete authority tuple",
        );
        current.dropped_frame_count += header.frame_count as u64;
        service_log(
            LogLevel::Warning,
            &header.request_id,
            &format!(
                "event=translation_frame_rejected status=nack cueId={} errorCode={} reason=authority-mismatch",
                header.cue_id.as_deref().unwrap_or("-"),
                code,
            ),
        );
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    if let Some((code, reason, message)) = translation_dispatch_error(&header) {
        let ack = rejected_audio_frame_ack(&header, code, message);
        current.dropped_frame_count += header.frame_count as u64;
        current.last_error_code = Some(code.to_string());
        service_log(
            LogLevel::Error,
            &header.request_id,
            &format!(
                "event=translation_playback_status status=route-failed cueId={} sink={} routeDirection={} errorCode={code} reason={reason}",
                header.cue_id.as_deref().unwrap_or("-"),
                header
                    .translation_sink
                    .map(TranslationAudioSink::as_str)
                    .unwrap_or("missing"),
                header
                    .route_direction
                    .map(AudioRouteDirection::as_str)
                    .unwrap_or("missing"),
            ),
        );
        current.emit_translation_status(
            header.cue_id.as_deref(),
            TranslationPlaybackStatusKind::RouteFailed,
            reason,
            Some(code),
        );
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    if header.translation_sink == Some(TranslationAudioSink::PhysicalPlayback)
        && current.source_capture_mode == SourceCaptureMode::ProcessExclusion
        && current.process_loopback_status != ProcessLoopbackStatus::Ready
    {
        let code = current
            .last_error_code
            .as_deref()
            .filter(|code| code.starts_with("bridge.process-loopback-"))
            .unwrap_or("bridge.process-loopback-capture-failed")
            .to_string();
        let ack = rejected_audio_frame_ack(
            &header,
            &code,
            "process-exclusion route is not ready; translation playback was not queued",
        );
        current.dropped_frame_count += header.frame_count as u64;
        service_log(
            LogLevel::Error,
            &header.request_id,
            &format!(
                "event=translation_frame_rejected status=nack cueId={} errorCode={code}",
                header.cue_id.as_deref().unwrap_or("-")
            ),
        );
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    if header.translation_sink == Some(TranslationAudioSink::PhysicalPlayback)
        && current.translation_playback_enabled
        && current.physical_playback_status != "ready"
    {
        let code = "bridge.translation-generation-ended";
        let ack = rejected_audio_frame_ack(
            &header,
            code,
            "physical translation frame belongs to a superseded playback owner",
        );
        current.dropped_frame_count += header.frame_count as u64;
        service_log(
            LogLevel::Warning,
            &header.request_id,
            &format!(
                "event=translation_frame_rejected status=nack cueId={} errorCode={} expectedBridgeInstanceId={} actualBridgeInstanceId={} expectedSourceGeneration={} actualSourceGeneration={} expectedPlaybackOwnerGeneration={} actualPlaybackOwnerGeneration={} expectedEndpointId={} actualEndpointId={}",
                header.cue_id.as_deref().unwrap_or("-"),
                code,
                current.bridge_instance_id,
                header.bridge_instance_id.as_deref().unwrap_or("-"),
                current.source_generation,
                header.source_generation.map(|value| value.to_string()).unwrap_or_else(|| "-".to_string()),
                current.playback_owner_generation,
                header.playback_owner_generation.map(|value| value.to_string()).unwrap_or_else(|| "-".to_string()),
                current.resolved_physical_playback_device_id,
                header.physical_playback_device_id.as_deref().unwrap_or("-"),
            ),
        );
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
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
    current.bind_translation_cue_authority(&header);
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
    if header.translation_sink == Some(TranslationAudioSink::VirtualMic) {
        handle_virtual_mic_frame(
            handle,
            state,
            runtime_root,
            &header,
            &payload,
            &monitor_samples,
            current,
        );
    } else {
        handle_physical_translation_frame(
            handle,
            runtime_root,
            playback_tx,
            playback_control_tx,
            translation_queue,
            &header,
            &payload,
            monitor_samples,
            current,
        );
    }
}

include!("capture.rs");
include!("playback.rs");
#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    use serde_json::{json, Value};
    use tempfile::TempDir;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Pipes::CreatePipe;

    use super::{
        append_capture_packet, apply_playback_control_commands, begin_source_subscription,
        dispatch_source_frame,
        end_source_subscription,
        capture_route_is_ready, classify_process_loopback_capability,
        control_response_authorizes_exit, fail_process_loopback_route,
        finish_completed_physical_stream, handle_bridge_shutdown, handle_control,
        handle_physical_translation_frame,
        handle_virtual_mic_frame_with_writer,
        handle_process_loopback_probe,
        flush_source_capture,
        ducked_source_volume, is_omni_virtual_playback_device_name,
        monitor_source_queue_needs_drop, normalized_device_name,
        complete_translation_command_is_ready, pending_physical_stream_command_is_ready,
        playback_volume, play_physical_translation_stream,
        take_ready_physical_stream_command,
        process_source_route_failure, publish_diagnostic_file, record_source_read_result,
        sanitize_capture_sample,
        request_playback_stop,
        start_next_translation, take_process_capture_chunk,
        source_playback_job_is_stale, source_route_error_header,
        source_subscription_is_owner, source_monitor_playback_enabled, source_watchdog_summary,
        state_snapshot, translation_dispatch_error, physical_stream_ready_to_start,
        translation_frame_has_current_authority,
        virtual_mic_ledger_key,
        ActivePhysicalTranslationStream, AudioFrameHeader, AudioRouteDirection, BridgeHost,
        CaptureBackend, PhysicalTranslationStreamCommand, PlaybackCommand,
        PlaybackControlCommand, PlaybackJob,
        ProcessLoopbackStatus, SourceCaptureMode, TranslationEnqueueFailureReason,
        TranslationPlaybackQueue, TranslationPlaybackStatusAck,
        TranslationAudioSink, TranslationPlaybackStatusKind, TranslationStatusOutbox,
        TranslationStreamState,
        translation_non_playback_reason, translation_playback_enabled,
        translation_would_miss_realtime_budget,
        BRIDGE_PROTOCOL_VERSION, INTERNAL_CHANNEL_COUNT, INTERNAL_SAMPLE_RATE_HZ,
        AudioFramePacer, OMNI_SOURCE_CHUNK_BYTES, OMNI_SOURCE_FRAME_INTERVAL_MS,
        OMNI_SOURCE_DRIVER_MAX_BUFFERED_BYTES_FALLBACK,
        PHYSICAL_TRANSLATION_STREAM_STARTUP_BUFFER_MS,
        PHYSICAL_TRANSLATION_STREAM_STARTUP_MAX_WAIT_MS,
        PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD,
        source_pacer_ingress_capacity,
        BridgeState, DriverStatus, ProcessLoopbackTerminalEvidence,
        VirtualMicChunkAdmission, VirtualMicCueLedger, VirtualMicWriteOutcome,
    };

    #[test]
    fn driver_startup_burst_fits_derived_pacer_ingress_and_catches_up_on_media_clock() {
        const LEGACY_PACER_CAPACITY: usize = 5;

        let capacity = source_pacer_ingress_capacity(
            OMNI_SOURCE_DRIVER_MAX_BUFFERED_BYTES_FALLBACK,
        );
        assert_eq!(capacity, 50);
        assert_eq!(source_pacer_ingress_capacity(192_001), 51);
        assert_eq!(source_pacer_ingress_capacity(0), capacity);
        assert_eq!(
            capacity * OMNI_SOURCE_CHUNK_BYTES,
            OMNI_SOURCE_DRIVER_MAX_BUFFERED_BYTES_FALLBACK as usize,
        );

        let mut legacy = AudioFramePacer::new(
            LEGACY_PACER_CAPACITY,
            Duration::from_millis(OMNI_SOURCE_FRAME_INTERVAL_MS),
        );
        for frame in 0..capacity {
            legacy.push(frame, Duration::ZERO);
        }
        assert_eq!(legacy.queued_frames(), LEGACY_PACER_CAPACITY);
        assert_eq!(
            legacy.dropped_frame_count(),
            (capacity - LEGACY_PACER_CAPACITY) as u64,
            "the former five-frame ingress cannot own a legal one-second driver burst",
        );

        let mut derived = AudioFramePacer::new(
            capacity,
            Duration::from_millis(OMNI_SOURCE_FRAME_INTERVAL_MS),
        );
        for frame in 0..capacity {
            derived.push(frame, Duration::ZERO);
        }
        assert_eq!(derived.queued_frames(), capacity);
        assert_eq!(derived.dropped_frame_count(), 0);

        assert_eq!(derived.poll(Duration::ZERO), Some(0));
        let resumed_at = Duration::from_secs(1);
        for expected in 1..capacity {
            assert_eq!(derived.poll(resumed_at), Some(expected));
        }
        assert_eq!(derived.queued_frames(), 0);
        assert_eq!(derived.dropped_frame_count(), 0);
    }

    fn translation_job(cue_id: &str, created_at_ms: u64, duration_ms: u64) -> PlaybackJob {
        PlaybackJob {
            samples: vec![0.0; 960 * 2],
            device_id: "default".to_string(),
            volume: 1.0,
            source_frame: false,
            ducking_enabled: false,
            ducking_depth_percent: 0,
            queued_at: std::time::Instant::now(),
            source_generation: 0,
            cue_id: Some(cue_id.to_string()),
            created_at_ms,
            estimated_duration_ms: duration_ms,
            playback_duration_ms: duration_ms,
            translation_generation: 0,
            translation_arrival_sequence: 0,
        }
    }

    #[test]
    fn shutdown_timeout_fails_closed_without_exit_authority() {
        let state = Arc::new(Mutex::new(BridgeState {
            source_capture_mode: SourceCaptureMode::ProcessExclusion,
            capture_backend: CaptureBackend::WasapiProcessExclusion,
            process_loopback_status: ProcessLoopbackStatus::Ready,
            source_subscriber_active: true,
            source_generation: 91,
            ..BridgeState::default()
        }));
        let lifecycle = state
            .lock()
            .unwrap()
            .process_loopback_lifecycle
            .clone();
        assert!(lifecycle.begin_generation(91));
        let (playback_control_tx, _playback_control_rx) = mpsc::channel();
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));

        let response = handle_bridge_shutdown(
            "shutdown-timeout",
            &state,
            &playback_control_tx,
            &translation_queue,
            Duration::ZERO,
        );

        assert_eq!(response["type"], "bridge.error");
        assert_eq!(response["code"], "bridge.timeout");
        assert!(!control_response_authorizes_exit(true, &response));
        let current = state.lock().unwrap();
        assert!(!current.source_subscriber_active);
        assert_eq!(current.source_capture_mode, SourceCaptureMode::None);
        assert_eq!(current.lifecycle_state, "error");
    }

    #[test]
    fn idle_shutdown_ack_carries_generation_bound_terminal_exit_authority() {
        let state = Arc::new(Mutex::new(BridgeState {
            source_generation: 117,
            ..BridgeState::default()
        }));
        let (playback_control_tx, _playback_control_rx) = mpsc::channel();
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));

        let response = handle_bridge_shutdown(
            "shutdown-idle",
            &state,
            &playback_control_tx,
            &translation_queue,
            Duration::ZERO,
        );

        assert_eq!(response["type"], "bridge.state.snapshot");
        assert_eq!(response["processLoopbackShutdownRequestedGeneration"], 117);
        assert_eq!(response["processLoopbackTerminalGeneration"], 117);
        assert_eq!(response["processLoopbackTerminalStatus"], "not-active");
        assert!(response["processLoopbackTerminalTimestampMs"].is_number());
        assert!(control_response_authorizes_exit(true, &response));
    }

    #[test]
    fn shutdown_exit_authority_rejects_stale_or_failed_terminal_evidence() {
        let valid = json!({
            "type": "bridge.state.snapshot",
            "bridgeState": "stopped",
            "lifecycleState": "stopped",
            "processLoopbackShutdownRequestedGeneration": 131,
            "processLoopbackTerminalGeneration": 131,
            "processLoopbackTerminalStatus": "stopped",
            "processLoopbackTerminalTimestampMs": 9_001,
        });
        assert!(control_response_authorizes_exit(true, &valid));

        let mut stale = valid.clone();
        stale["processLoopbackTerminalGeneration"] = json!(130);
        assert!(!control_response_authorizes_exit(true, &stale));

        let mut failed = valid.clone();
        failed["processLoopbackTerminalStatus"] = json!("stop-failed");
        assert!(!control_response_authorizes_exit(true, &failed));

        let mut degraded = valid;
        degraded["bridgeState"] = json!("degraded");
        degraded["lifecycleState"] = json!("error");
        assert!(!control_response_authorizes_exit(true, &degraded));
    }

    fn assert_failed_terminal_remains_fail_closed_across_reentry(terminal_status: &str) {
        let state = Arc::new(Mutex::new(BridgeState {
            source_capture_mode: SourceCaptureMode::ProcessExclusion,
            capture_backend: CaptureBackend::WasapiProcessExclusion,
            process_loopback_status: ProcessLoopbackStatus::Ready,
            source_subscriber_active: true,
            source_generation: 149,
            ..BridgeState::default()
        }));
        let lifecycle = state
            .lock()
            .unwrap()
            .process_loopback_lifecycle
            .clone();
        assert!(lifecycle.begin_generation(149));
        let (playback_control_tx, _playback_control_rx) = mpsc::channel();
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let first_state = state.clone();
        let first_playback_control_tx = playback_control_tx.clone();
        let first_translation_queue = translation_queue.clone();
        let first_shutdown = std::thread::spawn(move || {
            handle_bridge_shutdown(
                "shutdown-stop-failed-first",
                &first_state,
                &first_playback_control_tx,
                &first_translation_queue,
                Duration::from_secs(1),
            )
        });
        loop {
            if lifecycle.state.lock().unwrap().shutdown_requested {
                break;
            }
            std::thread::yield_now();
        }
        lifecycle.publish_terminal(ProcessLoopbackTerminalEvidence::new(
            149,
            terminal_status,
            Some(format!("{terminal_status} detail")),
        ));

        let first_response = first_shutdown.join().unwrap();
        assert_eq!(first_response["type"], "bridge.error");
        assert_eq!(
            first_response["code"],
            "bridge.process-loopback-capture-failed"
        );
        assert!(!control_response_authorizes_exit(true, &first_response));

        let second_response = handle_bridge_shutdown(
            "shutdown-stop-failed-second",
            &state,
            &playback_control_tx,
            &translation_queue,
            Duration::ZERO,
        );
        assert_eq!(second_response["type"], "bridge.error");
        assert_eq!(
            second_response["code"],
            "bridge.process-loopback-capture-failed"
        );
        assert!(!control_response_authorizes_exit(true, &second_response));

        let current = state.lock().unwrap();
        assert_eq!(current.bridge_state, "degraded");
        assert_eq!(current.lifecycle_state, "error");
        assert_eq!(
            current.process_loopback_shutdown_requested_generation,
            Some(149)
        );
        assert_eq!(current.process_loopback_terminal_generation, Some(149));
        assert_eq!(
            current.process_loopback_terminal_status.as_deref(),
            Some(terminal_status)
        );
    }

    #[test]
    fn shutdown_stop_failed_terminal_remains_fail_closed_across_reentry() {
        assert_failed_terminal_remains_fail_closed_across_reentry("stop-failed");
    }

    #[test]
    fn shutdown_capture_failed_terminal_remains_fail_closed_across_reentry() {
        assert_failed_terminal_remains_fail_closed_across_reentry("capture-failed");
    }

    #[test]
    fn shutdown_mismatched_terminal_generation_returns_error_without_exit_authority() {
        let state = Arc::new(Mutex::new(BridgeState {
            source_capture_mode: SourceCaptureMode::ProcessExclusion,
            capture_backend: CaptureBackend::WasapiProcessExclusion,
            process_loopback_status: ProcessLoopbackStatus::Ready,
            source_subscriber_active: true,
            source_generation: 163,
            ..BridgeState::default()
        }));
        let lifecycle = state
            .lock()
            .unwrap()
            .process_loopback_lifecycle
            .clone();
        {
            let mut current = lifecycle.state.lock().unwrap();
            current.active_generation = Some(163);
            current.terminal = Some(ProcessLoopbackTerminalEvidence::new(
                162, "stopped", None,
            ));
        }
        let (playback_control_tx, _playback_control_rx) = mpsc::channel();
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));

        let response = handle_bridge_shutdown(
            "shutdown-stale-terminal",
            &state,
            &playback_control_tx,
            &translation_queue,
            Duration::ZERO,
        );

        assert_eq!(response["type"], "bridge.error");
        assert_eq!(response["code"], "bridge.timeout");
        assert!(!control_response_authorizes_exit(true, &response));
        let current = state.lock().unwrap();
        assert_eq!(current.bridge_state, "degraded");
        assert_eq!(current.lifecycle_state, "error");
    }

    fn bind_test_cue_authority(state: &BridgeState, cue_id: &str) {
        let mut header = omni_bridge_protocol::translation_header_fixture();
        header.cue_id = Some(cue_id.to_string());
        header.session_id = state
            .session_id
            .clone()
            .unwrap_or_else(|| "test-session".to_string());
        header.bridge_instance_id = Some(state.bridge_instance_id.clone());
        header.source_generation = Some(state.source_generation);
        header.source_generation_token = Some(super::source_generation_token(
            state,
            state.source_generation,
        ));
        header.playback_owner_generation = Some(state.playback_owner_generation);
        header.physical_playback_device_id = Some(
            (!state.resolved_physical_playback_device_id.is_empty())
                .then(|| state.resolved_physical_playback_device_id.clone())
                .unwrap_or_else(|| "test-endpoint".to_string()),
        );
        state.bind_translation_cue_authority(&header);
    }

    #[test]
    fn source_flush_ack_waits_until_worker_applies_flush() {
        let state = Arc::new(Mutex::new(BridgeState::new("test".to_string())));
        let (playback_tx, playback_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let state_for_flush = Arc::clone(&state);
        std::thread::spawn(move || {
            let response = flush_source_capture("flush-1", &state_for_flush, &playback_tx);
            let _ = result_tx.send(response);
        });

        assert!(
            result_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "bridge.source.flush must not ACK while FlushSource is only queued"
        );
        let PlaybackCommand::FlushSource { applied_tx } = playback_rx.recv().unwrap() else {
            panic!("expected FlushSource");
        };
        applied_tx.unwrap().send(()).unwrap();
        assert_eq!(
            result_rx.recv_timeout(Duration::from_secs(1)).unwrap()["type"],
            "bridge.state.snapshot"
        );
    }

    struct TestResponsePipe {
        read_handle: HANDLE,
        write_handle: HANDLE,
    }

    impl TestResponsePipe {
        fn new() -> Self {
            let mut read_handle = std::ptr::null_mut();
            let mut write_handle = std::ptr::null_mut();
            let created = unsafe {
                CreatePipe(
                    &mut read_handle,
                    &mut write_handle,
                    std::ptr::null(),
                    0,
                )
            };
            assert_ne!(created, 0, "test response pipe should be created");
            Self {
                read_handle,
                write_handle,
            }
        }

        fn read_json(&self) -> Value {
            let length = super::read_exact(self.read_handle, 4).expect("response length");
            let length = u32::from_le_bytes(length.try_into().unwrap()) as usize;
            let body = super::read_exact(self.read_handle, length).expect("response body");
            serde_json::from_slice(&body).expect("response json")
        }
    }

    impl Drop for TestResponsePipe {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.read_handle);
                CloseHandle(self.write_handle);
            }
        }
    }

    fn physical_translation_header(
        cue_id: &str,
        stream_state: Option<TranslationStreamState>,
    ) -> AudioFrameHeader {
        let mut header = omni_bridge_protocol::translation_header_fixture();
        header.request_id = format!("request-{cue_id}");
        header.frame_id = format!("frame-{cue_id}");
        header.cue_id = Some(cue_id.to_string());
        header.estimated_duration_ms = Some(100);
        header.chunk_index = stream_state.map(|_| 0);
        header.stream_state = stream_state;
        header
    }

    #[test]
    fn virtual_mic_cue_ledger_emits_one_start_and_one_terminal_for_paced_chunks() {
        let mut ledger = VirtualMicCueLedger::default();
        assert!(matches!(
            ledger.begin("cue-1", 0, 3).unwrap(),
            VirtualMicChunkAdmission::Write { emit_queued: true }
        ));
        assert_eq!(ledger.complete_success("cue-1", 0), Some((true, false)));
        assert!(matches!(
            ledger.begin("cue-1", 0, 3).unwrap(),
            VirtualMicChunkAdmission::Duplicate
        ));
        assert!(matches!(
            ledger.begin("cue-1", 1, 3).unwrap(),
            VirtualMicChunkAdmission::Write { emit_queued: false }
        ));
        assert_eq!(ledger.complete_success("cue-1", 1), Some((false, false)));
        assert!(matches!(
            ledger.begin("cue-1", 2, 3).unwrap(),
            VirtualMicChunkAdmission::Write { emit_queued: false }
        ));
        assert_eq!(ledger.complete_success("cue-1", 2), Some((false, true)));
        assert!(matches!(
            ledger.begin("cue-1", 2, 3).unwrap(),
            VirtualMicChunkAdmission::Duplicate
        ));
        assert_eq!(ledger.terminal.len(), 1);
    }

    #[test]
    fn virtual_mic_cue_ledger_terminalizes_failures_exactly_once() {
        let mut ledger = VirtualMicCueLedger::default();
        assert!(ledger.begin("cue-failed", 1, 2).is_err());
        assert!(ledger.complete_terminal("cue-failed"));
        assert!(!ledger.complete_terminal("cue-failed"));
        assert!(matches!(
            ledger.begin("cue-failed", 1, 2).unwrap(),
            VirtualMicChunkAdmission::Duplicate
        ));
    }

    #[test]
    fn playback_volume_normalizes_and_clamps_output_level() {
        assert_eq!(playback_volume(0), 0.0);
        assert_eq!(playback_volume(66), 0.66);
        assert_eq!(playback_volume(100), 1.0);
        assert_eq!(playback_volume(101), 1.0);
    }

    #[test]
    fn stream_ducking_uses_the_source_volume_and_configured_depth() {
        assert!((ducked_source_volume(0.5, 60) - 0.250_593_6).abs() < 0.000_001);
        assert_eq!(ducked_source_volume(0.5, 0), 0.5);
    }

    #[test]
    fn only_inbound_physical_translation_can_enter_the_physical_queue() {
        let mut header = omni_bridge_protocol::translation_header_fixture();
        assert_eq!(translation_dispatch_error(&header), None);

        header.route_direction = Some(AudioRouteDirection::Outbound);
        let error = translation_dispatch_error(&header).expect("outbound physical playback");
        assert_eq!(error.0, "bridge.invalid-audio-direction");

        header.translation_sink = Some(TranslationAudioSink::VirtualMic);
        assert_eq!(translation_dispatch_error(&header), None);
    }

    #[test]
    fn missing_translation_sink_metadata_is_rejected() {
        let mut header = omni_bridge_protocol::translation_header_fixture();
        header.translation_sink = None;
        assert_eq!(
            translation_dispatch_error(&header).map(|error| error.0),
            Some("bridge.invalid-audio-direction")
        );
        header.translation_sink = Some(TranslationAudioSink::PhysicalPlayback);
        header.route_direction = None;
        assert_eq!(
            translation_dispatch_error(&header).map(|error| error.0),
            Some("bridge.invalid-audio-direction")
        );
    }

    #[test]
    fn diagnostic_child_evidence_is_published_without_a_partial_target_file() {
        let root = TempDir::new().expect("temporary diagnostic root");
        let pid_path = root.path().join("child.pid");

        publish_diagnostic_file(&pid_path, b"42936").expect("publish child pid");

        assert_eq!(
            std::fs::read_to_string(&pid_path).expect("published child pid"),
            "42936"
        );
        assert!(
            !root.path().join("child.pid.tmp").exists(),
            "the staging file must disappear at the publish boundary"
        );
    }

    #[test]
    fn translation_status_outbox_preserves_terminal_until_delivery_is_acknowledged() {
        let outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = BridgeState {
            session_id: Some("session-status".to_string()),
            translation_status_outbox: Some(outbox.clone()),
            ..BridgeState::default()
        };
        bind_test_cue_authority(&state, "cue-status");

        state.emit_translation_status(
            Some("cue-status"),
            TranslationPlaybackStatusKind::RouteFailed,
            "physical-output-open-failed",
            Some("bridge.translation-playback-failed"),
        );

        let mut pending = outbox.lock().unwrap();
        let status = pending.front().expect("status event").clone();
        assert_eq!(status.event_type, "bridge.translation.status");
        assert!(status.status_id.starts_with("bridge-translation-status-"));
        assert_eq!(status.session_id, "session-status");
        assert_eq!(status.cue_id, "cue-status");
        assert_eq!(
            status.playback_status,
            TranslationPlaybackStatusKind::RouteFailed
        );
        assert_eq!(
            status.error_code.as_deref(),
            Some("bridge.translation-playback-failed")
        );
        let status_id = status.status_id.clone();
        assert_eq!(
            pending.front().map(|event| event.status_id.as_str()),
            Some(status_id.as_str()),
            "an unacknowledged terminal must remain available for reconnect"
        );
        assert!(!pending.acknowledge(&TranslationPlaybackStatusAck {
            event_type: "bridge.translation.status.ack".to_string(),
            status_id: "different-status".to_string(),
            session_id: "session-status".to_string(),
            bridge_instance_id: status.bridge_instance_id.clone(),
            source_generation: status.source_generation,
            source_generation_token: status.source_generation_token.clone(),
            playback_owner_generation: status.playback_owner_generation,
            physical_playback_device_id: status.physical_playback_device_id.clone(),
        }));
        assert_eq!(
            pending.front().map(|event| event.status_id.as_str()),
            Some(status_id.as_str()),
            "a mismatched acknowledgement must not remove the replayable event"
        );
        assert!(pending.acknowledge(&TranslationPlaybackStatusAck {
            event_type: "bridge.translation.status.ack".to_string(),
            status_id,
            session_id: "session-status".to_string(),
            bridge_instance_id: status.bridge_instance_id,
            source_generation: status.source_generation,
            source_generation_token: status.source_generation_token,
            playback_owner_generation: status.playback_owner_generation,
            physical_playback_device_id: status.physical_playback_device_id,
        }));
        assert!(pending.front().is_none());
    }

    #[test]
    fn delayed_terminal_status_retains_the_cue_write_authority_after_state_rebind() {
        let outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let mut state = BridgeState {
            session_id: Some("session-old".to_string()),
            bridge_instance_id: "instance-old".to_string(),
            source_generation: 41,
            playback_owner_generation: 73,
            resolved_physical_playback_device_id: "physical-old".to_string(),
            translation_status_outbox: Some(outbox.clone()),
            ..BridgeState::default()
        };
        let mut header = omni_bridge_protocol::translation_header_fixture();
        header.session_id = "session-old".to_string();
        header.bridge_instance_id = Some("instance-old".to_string());
        header.source_generation = Some(41);
        header.source_generation_token = Some("instance-old:session-old:41".to_string());
        header.playback_owner_generation = Some(73);
        header.physical_playback_device_id = Some("physical-old".to_string());
        header.cue_id = Some("cue-delayed".to_string());
        state.bind_translation_cue_authority(&header);

        state.session_id = Some("session-new".to_string());
        state.bridge_instance_id = "instance-new".to_string();
        state.source_generation = 42;
        state.playback_owner_generation = 74;
        state.resolved_physical_playback_device_id = "physical-new".to_string();
        state.emit_translation_status(
            Some("cue-delayed"),
            TranslationPlaybackStatusKind::Completed,
            "physical-playback-completed",
            None,
        );

        let pending = outbox.lock().unwrap();
        let delayed = pending.front().unwrap();
        assert_eq!(delayed.session_id, "session-old");
        assert_eq!(delayed.bridge_instance_id, "instance-old");
        assert_eq!(delayed.source_generation, 41);
        assert_eq!(delayed.source_generation_token, "instance-old:session-old:41");
        assert_eq!(delayed.playback_owner_generation, 73);
        assert_eq!(delayed.physical_playback_device_id, "physical-old");
    }

    #[test]
    fn unbound_malformed_cue_cannot_fabricate_a_terminal_from_current_authority() {
        let outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = BridgeState {
            session_id: Some("session-new".to_string()),
            bridge_instance_id: "instance-new".to_string(),
            source_generation: 42,
            playback_owner_generation: 74,
            resolved_physical_playback_device_id: "physical-new".to_string(),
            translation_status_outbox: Some(outbox.clone()),
            ..BridgeState::default()
        };
        state.emit_translation_status(
            Some("cue-from-malformed-old-frame"),
            TranslationPlaybackStatusKind::RouteFailed,
            "invalid-translation-sink-direction",
            Some("bridge.invalid-audio-direction"),
        );

        assert!(
            outbox.lock().unwrap().front().is_none(),
            "an unbound cue must not inherit the current owner tuple"
        );
    }

    #[test]
    fn physical_playback_disabled_still_rejects_authorityless_complete_frame() {
        let state = BridgeState {
            session_id: Some("session".to_string()),
            bridge_instance_id: "instance".to_string(),
            source_generation: 42,
            playback_owner_generation: 74,
            resolved_physical_playback_device_id: "endpoint".to_string(),
            translation_playback_enabled: false,
            ..BridgeState::default()
        };
        let mut header = omni_bridge_protocol::translation_header_fixture();
        header.session_id = "session".to_string();
        header.bridge_instance_id = None;
        header.source_generation = None;
        header.source_generation_token = None;
        header.playback_owner_generation = None;
        header.physical_playback_device_id = None;

        assert!(!translation_frame_has_current_authority(&state, &header));
    }

    #[test]
    fn virtual_mic_rejects_same_session_stale_source_generation() {
        let state = BridgeState {
            session_id: Some("session".to_string()),
            bridge_instance_id: "instance".to_string(),
            source_generation: 43,
            playback_owner_generation: 74,
            resolved_physical_playback_device_id: "endpoint".to_string(),
            ..BridgeState::default()
        };
        let mut header = omni_bridge_protocol::translation_header_fixture();
        header.translation_sink = Some(TranslationAudioSink::VirtualMic);
        header.route_direction = Some(AudioRouteDirection::Outbound);
        header.session_id = "session".to_string();
        header.bridge_instance_id = Some("instance".to_string());
        header.source_generation = Some(42);
        header.source_generation_token = Some("instance:session:42".to_string());
        header.playback_owner_generation = Some(74);
        header.physical_playback_device_id = Some("endpoint".to_string());

        assert!(!translation_frame_has_current_authority(&state, &header));
    }

    #[test]
    fn virtual_mic_write_in_flight_rebind_keeps_terminal_on_old_authority() {
        let runtime_root = TempDir::new().unwrap();
        let outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = Arc::new(Mutex::new(BridgeState {
            session_id: Some("session".to_string()),
            bridge_instance_id: "instance".to_string(),
            source_generation: 42,
            playback_owner_generation: 74,
            resolved_physical_playback_device_id: "endpoint".to_string(),
            virtual_mic_output_requested: true,
            translation_status_outbox: Some(outbox.clone()),
            ..BridgeState::default()
        }));
        let mut header = omni_bridge_protocol::translation_header_fixture();
        header.translation_sink = Some(TranslationAudioSink::VirtualMic);
        header.route_direction = Some(AudioRouteDirection::Outbound);
        header.session_id = "session".to_string();
        header.bridge_instance_id = Some("instance".to_string());
        header.source_generation = Some(42);
        header.source_generation_token = Some("instance:session:42".to_string());
        header.playback_owner_generation = Some(74);
        header.physical_playback_device_id = Some("endpoint".to_string());
        header.cue_id = Some("reused-cue".to_string());
        header.chunk_index = Some(0);
        header.chunk_count = Some(1);
        state.lock().unwrap().bind_translation_cue_authority(&header);
        let pipe = TestResponsePipe::new();
        let state_during_write = Arc::clone(&state);
        let header_for_new_owner = header.clone();
        let current = state.lock().unwrap();

        handle_virtual_mic_frame_with_writer(
            pipe.write_handle,
            &state,
            runtime_root.path(),
            &header,
            &[0_u8; 4],
            &[0.25, 0.25],
            current,
            move |_, _| {
                let mut next = state_during_write.lock().unwrap();
                next.source_generation = 43;
                next.playback_owner_generation = 75;
                let mut new_header = header_for_new_owner;
                new_header.source_generation = Some(43);
                new_header.source_generation_token = Some("instance:session:43".to_string());
                new_header.playback_owner_generation = Some(75);
                next.bind_translation_cue_authority(&new_header);
                let new_key = virtual_mic_ledger_key(&new_header);
                next.virtual_mic_cue_ledger.begin(&new_key, 0, 1).unwrap();
                Ok(VirtualMicWriteOutcome {
                    frames_written: 1,
                    capture_endpoint_name: "virtual-mic".to_string(),
                    format: "pcm16".to_string(),
                    driver_status: DriverStatus::default(),
                })
            },
        );

        let ack = pipe.read_json();
        assert_eq!(ack["type"], "bridge.translation.nack");
        assert_eq!(ack["acceptedFrames"], 0);
        assert_eq!(ack["errorCode"], "bridge.translation-generation-ended");
        let status = outbox.lock().unwrap().front().cloned().unwrap();
        assert_eq!(status.source_generation, 42);
        assert_eq!(status.playback_owner_generation, 74);
        let current = state.lock().unwrap();
        let mut new_header = header.clone();
        new_header.source_generation = Some(43);
        new_header.source_generation_token = Some("instance:session:43".to_string());
        new_header.playback_owner_generation = Some(75);
        assert!(current
            .virtual_mic_cue_ledger
            .active
            .contains_key(&virtual_mic_ledger_key(&new_header)));
    }

    #[test]
    fn translation_status_ids_are_stable_in_queue_and_unique_per_emission() {
        let outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = BridgeState {
            session_id: Some("session-status".to_string()),
            translation_status_outbox: Some(outbox.clone()),
            ..BridgeState::default()
        };
        bind_test_cue_authority(&state, "cue-status");

        state.emit_translation_status(
            Some("cue-status"),
            TranslationPlaybackStatusKind::Queued,
            "accepted",
            None,
        );
        state.emit_translation_status(
            Some("cue-status"),
            TranslationPlaybackStatusKind::RouteFailed,
            "capture-failed",
            Some("bridge.process-loopback-capture-failed"),
        );

        let pending = outbox.lock().unwrap();
        assert_eq!(pending.pending.len(), 2);
        assert_ne!(pending.pending[0].status_id, pending.pending[1].status_id);
        assert_eq!(pending.pending[0].request_id, pending.pending[0].status_id);
        assert_eq!(pending.pending[1].request_id, pending.pending[1].status_id);
    }

    #[test]
    fn process_loopback_capability_obeys_the_documented_windows_build_gate() {
        assert_eq!(
            classify_process_loopback_capability(Some(
                PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD - 1
            )),
            (false, ProcessLoopbackStatus::Unsupported)
        );
        assert_eq!(
            classify_process_loopback_capability(Some(
                PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD
            )),
            (true, ProcessLoopbackStatus::Unknown)
        );
        assert_eq!(
            classify_process_loopback_capability(None),
            (false, ProcessLoopbackStatus::Failed)
        );
    }

    #[test]
    fn proactive_process_loopback_probe_is_transient_and_preserves_the_capture_route() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.source_capture_mode = SourceCaptureMode::VirtualDriver;
            current.capture_backend = CaptureBackend::DriverVirtualSpeaker;
            current.source_generation = 17;
        }
        let state_during_activation = state.clone();

        let response = handle_process_loopback_probe(
            "process-probe-ready",
            &state,
            Some(PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD),
            move || {
                let current = state_during_activation.lock().unwrap();
                assert_eq!(
                    current.process_loopback_status,
                    ProcessLoopbackStatus::Probing,
                    "the observable capability state must transition through probing"
                );
                assert_eq!(current.source_generation, 17);
                Ok(())
            },
        );

        assert_eq!(response["type"], "bridge.process-loopback.probe.ack");
        assert_eq!(response["processLoopbackStatus"], "ready");
        assert_eq!(response["sourceCaptureMode"], "virtual-driver");
        assert_eq!(response["captureBackend"], "driver-virtual-speaker");
        let current = state.lock().unwrap();
        assert_eq!(current.process_loopback_status, ProcessLoopbackStatus::Ready);
        assert_eq!(current.source_capture_mode, SourceCaptureMode::VirtualDriver);
        assert_eq!(current.capture_backend, CaptureBackend::DriverVirtualSpeaker);
        assert_eq!(current.source_generation, 17);
        assert_eq!(current.source_subscriber_active, false);
    }

    #[test]
    fn proactive_probe_never_transitions_an_active_process_route_through_probing() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.source_capture_mode = SourceCaptureMode::ProcessExclusion;
            current.capture_backend = CaptureBackend::WasapiProcessExclusion;
            current.process_loopback_supported = true;
            current.process_loopback_status = ProcessLoopbackStatus::Ready;
            current.bridge_state = "running".to_string();
            current.lifecycle_state = "ready".to_string();
            current.source_subscriber_active = true;
            current.source_generation = 23;
        }
        let mut activated = false;

        let response = handle_process_loopback_probe(
            "process-probe-active",
            &state,
            Some(PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD),
            || {
                activated = true;
                Ok(())
            },
        );

        assert!(!activated, "an active route is already the capability proof");
        assert_eq!(response["processLoopbackStatus"], "ready");
        assert_eq!(response["sourceCaptureMode"], "process-exclusion");
        assert_eq!(response["captureBackend"], "wasapi-process-exclusion");
        let current = state.lock().unwrap();
        assert_eq!(current.process_loopback_status, ProcessLoopbackStatus::Ready);
        assert_eq!(current.source_generation, 23);
        assert!(process_source_route_failure(&current).is_none());
    }

    #[test]
    fn proactive_probe_cannot_overwrite_a_process_route_started_during_activation() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.source_capture_mode = SourceCaptureMode::VirtualDriver;
            current.capture_backend = CaptureBackend::DriverVirtualSpeaker;
        }
        let state_during_activation = state.clone();

        let response = handle_process_loopback_probe(
            "process-probe-route-race",
            &state,
            Some(PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD),
            move || {
                let mut current = state_during_activation.lock().unwrap();
                current.source_capture_mode = SourceCaptureMode::ProcessExclusion;
                current.capture_backend = CaptureBackend::WasapiProcessExclusion;
                current.process_loopback_supported = true;
                current.process_loopback_status = ProcessLoopbackStatus::Ready;
                current.source_subscriber_active = true;
                current.source_generation = 29;
                Ok(())
            },
        );

        assert_eq!(response["processLoopbackStatus"], "ready");
        assert_eq!(response["sourceCaptureMode"], "process-exclusion");
        let current = state.lock().unwrap();
        assert_eq!(current.process_loopback_status, ProcessLoopbackStatus::Ready);
        assert_eq!(current.source_generation, 29);
        assert!(process_source_route_failure(&current).is_none());
    }

    #[test]
    fn proactive_process_loopback_probe_reports_unsupported_without_activation() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        let response = handle_process_loopback_probe(
            "process-probe-unsupported",
            &state,
            Some(PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD - 1),
            || -> Result<(), String> { panic!("unsupported builds must not activate WASAPI") },
        );

        assert_eq!(response["processLoopbackSupported"], false);
        assert_eq!(response["processLoopbackStatus"], "unsupported");
        assert_eq!(
            response["errorCode"],
            "bridge.process-loopback-unsupported"
        );
        assert!(response["processLoopbackFailureDetail"]
            .as_str()
            .unwrap()
            .contains("requires Windows build"));
    }

    #[test]
    fn proactive_process_loopback_probe_preserves_activation_failure_detail() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        let response = handle_process_loopback_probe(
            "process-probe-failed",
            &state,
            Some(PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD),
            || Err("ActivateAudioInterfaceAsync returned 0x80004005".to_string()),
        );

        assert_eq!(response["processLoopbackSupported"], true);
        assert_eq!(response["processLoopbackStatus"], "failed");
        assert_eq!(
            response["errorCode"],
            "bridge.process-loopback-activation-failed"
        );
        assert_eq!(
            response["processLoopbackFailureDetail"],
            "ActivateAudioInterfaceAsync returned 0x80004005"
        );
    }

    #[test]
    fn process_exclusion_disables_only_source_monitoring() {
        assert!(!source_monitor_playback_enabled(
            SourceCaptureMode::ProcessExclusion,
            true
        ));
        assert!(source_monitor_playback_enabled(
            SourceCaptureMode::VirtualDriver,
            true
        ));
        assert!(!source_monitor_playback_enabled(
            SourceCaptureMode::VirtualDriver,
            false
        ));
    }

    #[test]
    fn process_exclusion_forces_translation_playback_independently_of_source_monitoring() {
        assert!(translation_playback_enabled(
            SourceCaptureMode::ProcessExclusion,
            false,
        ));
        assert!(!translation_playback_enabled(
            SourceCaptureMode::VirtualDriver,
            false,
        ));
        assert!(translation_playback_enabled(
            SourceCaptureMode::VirtualDriver,
            true,
        ));
    }

    #[test]
    fn source_flush_rejects_a_disconnected_playback_boundary_consumer() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_tx, playback_rx) = mpsc::sync_channel(1);
        drop(playback_rx);
        let (playback_control_tx, _playback_control_rx) = mpsc::channel();

        let response = handle_control(
            json!({
                "type": "bridge.source.flush",
                "requestId": "source-flush-disconnected",
            }),
            &state,
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            runtime_root.path(),
        );

        assert_eq!(response["type"], "bridge.error");
        assert_eq!(response["code"], "bridge.source-flush-failed");
    }

    #[test]
    fn virtual_driver_translation_init_binds_an_explicit_physical_playback_owner() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        state.lock().unwrap().driver_health = "ready".to_string();
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_tx, _playback_rx) = mpsc::sync_channel(2);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        let rebind = std::thread::spawn(move || {
            let PlaybackControlCommand::RebindPhysicalOutput {
                device_id,
                response_tx,
            } = playback_control_rx.recv().unwrap()
            else {
                panic!("expected physical playback rebind control");
            };
            assert_eq!(device_id, "hda-speaker");
            response_tx.send(Ok(device_id)).unwrap();
        });

        let response = handle_control(
            json!({
                "type": "bridge.init",
                "requestId": "virtual-driver-physical-owner",
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "sessionId": "session-virtual",
                "sourceCaptureMode": "virtual-driver",
                "physicalPlaybackDeviceId": "hda-speaker",
                "previousPlaybackOwnerGeneration": 41,
                "monitorPlaybackEnabled": false,
                "translationPlaybackEnabled": true
            }),
            &state,
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            runtime_root.path(),
        );

        rebind.join().unwrap();
        assert_eq!(response["type"], "bridge.init.ack");
        assert_eq!(response["bridgeState"], "running");
        assert_eq!(response["physicalPlaybackStatus"], "ready");
        assert_eq!(response["resolvedPhysicalPlaybackDeviceId"], "hda-speaker");
        assert!(response["playbackOwnerGeneration"].as_u64().unwrap() > 41);
    }

    #[test]
    fn intentionally_unplayed_translation_has_an_explicit_terminal_reason() {
        assert_eq!(
            translation_non_playback_reason(false, true, false),
            Some("translation-playback-disabled")
        );
        assert_eq!(
            translation_non_playback_reason(true, false, true),
            Some("translated-audio-muted")
        );
        assert_eq!(
            translation_non_playback_reason(true, true, true),
            Some("empty-translation-audio")
        );
        assert_eq!(translation_non_playback_reason(true, true, false), None);
    }

    #[test]
    fn process_route_device_switch_preserves_source_and_recreates_translation_output() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("session-1".to_string());
            current.source_capture_mode = SourceCaptureMode::ProcessExclusion;
            current.capture_backend = CaptureBackend::WasapiProcessExclusion;
            current.process_loopback_supported = true;
            current.process_loopback_status = ProcessLoopbackStatus::Ready;
            current.windows_build_number = Some(PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD);
            current.physical_playback_device_id = "speaker-a".to_string();
            current.source_subscriber_active = true;
            current.source_generation = 9;
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        translation_queue
            .lock()
            .unwrap()
            .enqueue(translation_job("old-device-cue", 1_000, 1_000), 1_000)
            .unwrap();
        let (playback_tx, playback_rx) = mpsc::sync_channel(2);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        let rebind = std::thread::spawn(move || {
            let PlaybackControlCommand::StopAll(stop) = playback_control_rx.recv().unwrap()
            else {
                panic!("accepted translation work must be terminalized before physical output rebind");
            };
            assert_eq!(stop.reason, "physical-playback-device-changed");
            assert_eq!(stop.terminated_cues.len(), 1);
            assert_eq!(
                stop.terminated_cues[0].cue_id.as_deref(),
                Some("old-device-cue")
            );
            let PlaybackControlCommand::RebindPhysicalOutput {
                device_id,
                response_tx,
            } = playback_control_rx.recv().unwrap()
            else {
                panic!("expected physical playback rebind control");
            };
            assert_eq!(device_id, "speaker-b");
            response_tx.send(Ok(device_id)).unwrap();
        });

        let response = handle_control(
            json!({
                "type": "bridge.init",
                "requestId": "device-change",
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "sessionId": "session-1",
                "sourceCaptureMode": "process-exclusion",
                "physicalPlaybackDeviceId": "speaker-b",
                "previousPlaybackOwnerGeneration": 9_000_000_000_000_u64,
                "physicalPlaybackLevel": 50,
                "monitorPlaybackEnabled": false,
                "translationPlaybackEnabled": false
            }),
            &state,
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            runtime_root.path(),
        );

        assert_eq!(response["type"], "bridge.init.ack");
        rebind.join().unwrap();
        assert!(playback_rx.try_recv().is_err());
        let current = state.lock().unwrap();
        assert_eq!(current.physical_playback_device_id, "speaker-b");
        assert!(current.source_subscriber_active);
        assert_eq!(current.process_loopback_status, ProcessLoopbackStatus::Ready);
        assert_eq!(current.capture_backend, CaptureBackend::WasapiProcessExclusion);
        assert_eq!(current.physical_playback_status, "ready");
        assert_eq!(current.resolved_physical_playback_device_id, "speaker-b");
        assert_eq!(current.playback_owner_generation, 9_000_000_000_001);
        assert!(translation_queue.lock().unwrap().pending.is_empty());
        assert_eq!(
            current.source_generation, 9,
            "an output-device change must not rebuild the source capture backend"
        );
    }

    #[test]
    fn process_route_rebind_failure_is_fail_closed() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("session-1".to_string());
            current.source_capture_mode = SourceCaptureMode::ProcessExclusion;
            current.capture_backend = CaptureBackend::WasapiProcessExclusion;
            current.process_loopback_supported = true;
            current.process_loopback_status = ProcessLoopbackStatus::Ready;
            current.windows_build_number = Some(PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD);
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_tx, _playback_rx) = mpsc::sync_channel(2);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        let rebind = std::thread::spawn(move || {
            let PlaybackControlCommand::RebindPhysicalOutput { response_tx, .. } =
                playback_control_rx.recv().unwrap()
            else {
                panic!("expected physical playback rebind control");
            };
            response_tx
                .send(Err("configured endpoint is unavailable".to_string()))
                .unwrap();
        });

        let response = handle_control(
            json!({
                "type": "bridge.init",
                "requestId": "rebind-failure",
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "sessionId": "session-1",
                "sourceCaptureMode": "process-exclusion",
                "physicalPlaybackDeviceId": "speaker-missing",
                "physicalPlaybackLevel": 50,
                "monitorPlaybackEnabled": false,
                "translationPlaybackEnabled": true
            }),
            &state,
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            runtime_root.path(),
        );

        rebind.join().unwrap();
        assert_eq!(response["type"], "bridge.error");
        assert_eq!(response["code"], "bridge.physical-playback-rebind-failed");
        let current = state.lock().unwrap();
        assert_eq!(current.physical_playback_status, "failed");
        assert_eq!(current.lifecycle_state, "error");
        assert_eq!(current.bridge_state, "degraded");
        assert!(current.resolved_physical_playback_device_id.is_empty());
    }

    #[test]
    fn concurrent_init_stale_completion_cannot_overwrite_new_owner() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_tx, _playback_rx) = mpsc::sync_channel(2);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        let run_init = |request_id: &'static str, endpoint: &'static str| {
            let state = Arc::clone(&state);
            let queue = Arc::clone(&translation_queue);
            let playback_tx = playback_tx.clone();
            let control_tx = playback_control_tx.clone();
            let root = runtime_root.path().to_path_buf();
            std::thread::spawn(move || {
                handle_control(
                    json!({
                        "type": "bridge.init",
                        "requestId": request_id,
                        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                        "sessionId": format!("session-{request_id}"),
                        "sourceCaptureMode": "none",
                        "physicalPlaybackDeviceId": endpoint,
                        "previousPlaybackOwnerGeneration": 100,
                        "monitorPlaybackEnabled": false,
                        "translationPlaybackEnabled": true
                    }),
                    &state,
                    &playback_tx,
                    &control_tx,
                    &queue,
                    &root,
                )
            })
        };

        let init_a = run_init("a", "speaker-a");
        let PlaybackControlCommand::RebindPhysicalOutput { response_tx: a_tx, .. } =
            playback_control_rx.recv().unwrap()
        else {
            panic!("expected init A rebind");
        };
        let init_b = run_init("b", "speaker-b");
        let PlaybackControlCommand::RebindPhysicalOutput { response_tx: b_tx, .. } =
            playback_control_rx.recv().unwrap()
        else {
            panic!("expected init B rebind");
        };
        b_tx.send(Ok("speaker-b".to_string())).unwrap();
        let response_b = init_b.join().unwrap();
        a_tx.send(Ok("speaker-a".to_string())).unwrap();
        let response_a = init_a.join().unwrap();

        assert_eq!(response_b["type"], "bridge.init.ack");
        assert_eq!(response_a["type"], "bridge.error");
        let current = state.lock().unwrap();
        assert_eq!(current.session_id.as_deref(), Some("session-b"));
        assert_eq!(current.physical_playback_device_id, "speaker-b");
        assert_eq!(current.resolved_physical_playback_device_id, "speaker-b");
    }

    #[test]
    fn reinit_volume_only_terminalizes_pending_translation_before_owner_change() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("session-1".to_string());
            current.source_capture_mode = SourceCaptureMode::None;
            current.capture_backend = CaptureBackend::None;
            current.physical_playback_device_id = "speaker-a".to_string();
            current.physical_playback_level = 25;
            current.source_generation = 9;
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        translation_queue
            .lock()
            .unwrap()
            .enqueue(translation_job("same-device-cue", 1_000, 1_000), 1_000)
            .unwrap();
        let (playback_tx, playback_rx) = mpsc::sync_channel(2);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();

        let response = handle_control(
            json!({
                "type": "bridge.init",
                "requestId": "volume-change",
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "sessionId": "session-1",
                "sourceCaptureMode": "none",
                "physicalPlaybackDeviceId": "speaker-a",
                "physicalPlaybackLevel": 75,
                "monitorPlaybackEnabled": false,
                "translationPlaybackEnabled": false
            }),
            &state,
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            runtime_root.path(),
        );

        assert_eq!(response["type"], "bridge.init.ack");
        assert!(translation_queue.lock().unwrap().pending.is_empty());
        assert!(playback_rx.try_recv().is_err());
        let PlaybackControlCommand::StopAll(stop) = playback_control_rx.try_recv().unwrap() else {
            panic!("accepted cue must receive an old-owner terminal before reinit");
        };
        assert_eq!(stop.reason, "bridge-init-owner-change");
        assert_eq!(stop.terminated_cues.len(), 1);
        assert_eq!(stop.terminated_cues[0].cue_id.as_deref(), Some("same-device-cue"));
        let current = state.lock().unwrap();
        assert_eq!(current.physical_playback_level, 75);
        assert_eq!(current.source_generation, 9);
    }

    #[test]
    fn reinit_from_a_capture_backend_to_none_terminates_cues_and_rejects_old_source() {
        for previous_mode in [
            SourceCaptureMode::VirtualDriver,
            SourceCaptureMode::ProcessExclusion,
        ] {
            let runtime_root = TempDir::new().unwrap();
            let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
            {
                let mut current = state.lock().unwrap();
                current.session_id = Some("session-1".to_string());
                current.source_capture_mode = previous_mode;
                current.capture_backend = match previous_mode {
                    SourceCaptureMode::VirtualDriver => CaptureBackend::DriverVirtualSpeaker,
                    SourceCaptureMode::ProcessExclusion => {
                        CaptureBackend::WasapiProcessExclusion
                    }
                    SourceCaptureMode::None => unreachable!(),
                };
                current.process_loopback_status = ProcessLoopbackStatus::Ready;
                current.physical_playback_device_id = "speaker-a".to_string();
                current.source_subscriber_active = true;
                current.source_generation = 7;
                current.translation_playback_enabled = true;
            }
            let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
            {
                let mut queue = translation_queue.lock().unwrap();
                queue
                    .enqueue(translation_job("active", 1_000, 1_000), 1_000)
                    .unwrap();
                queue.start_next(1_000).job.unwrap();
                queue
                    .enqueue(translation_job("pending", 1_000, 1_000), 1_000)
                    .unwrap();
            }
            let (playback_tx, playback_rx) = mpsc::sync_channel(4);
            let (playback_control_tx, playback_control_rx) = mpsc::channel();

            let response = handle_control(
                json!({
                    "type": "bridge.init",
                    "requestId": "capture-to-none",
                    "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                    "sessionId": "session-1",
                    "sourceCaptureMode": "none",
                    "physicalPlaybackDeviceId": "speaker-a",
                    "physicalPlaybackLevel": 50,
                    "monitorPlaybackEnabled": false,
                    "translationPlaybackEnabled": false
                }),
                &state,
                &playback_tx,
                &playback_control_tx,
                &translation_queue,
                runtime_root.path(),
            );

            assert_eq!(response["type"], "bridge.init.ack");
            let PlaybackControlCommand::StopAll(stop) =
                playback_control_rx.try_recv().unwrap() else {
                    panic!("expected stop-all playback control");
                };
            assert_eq!(stop.reason, "capture-mode-changed");
            assert_eq!(stop.terminated_cues.len(), 2);
            assert!(stop
                .terminated_cues
                .iter()
                .all(|terminal| terminal.status == TranslationPlaybackStatusKind::StaleDropped));
            {
                let current = state.lock().unwrap();
                assert_eq!(current.source_capture_mode, SourceCaptureMode::None);
                assert_eq!(current.capture_backend, CaptureBackend::None);
                assert!(!current.source_subscriber_active);
                assert_eq!(current.source_generation, 8);
            }

            let (source_tx, source_rx) = mpsc::sync_channel(1);
            let payload = vec![1_u8; 960 * INTERNAL_CHANNEL_COUNT as usize * 2];
            assert!(!dispatch_source_frame(
                &state,
                Path::new("."),
                &playback_tx,
                &source_tx,
                7,
                previous_mode,
                payload,
            ));
            assert!(source_rx.try_recv().is_err());
            assert!(playback_rx.try_recv().is_err());
        }
    }

    #[test]
    fn full_translation_queue_rejects_new_cue_without_evicting_fresh_pending() {
        let mut queue = TranslationPlaybackQueue::new(2);
        queue.enqueue(translation_job("oldest", 1_000, 1_000), 1_000).unwrap();
        queue.enqueue(translation_job("middle", 1_000, 1_000), 1_000).unwrap();

        let failure = queue
            .enqueue(translation_job("newest", 1_000, 1_000), 1_000)
            .expect_err("fresh pending cues must not be evicted to admit a new cue");

        assert_eq!(failure.reason, TranslationEnqueueFailureReason::QueueFull);
        assert!(failure.dropped.is_empty());
        assert_eq!(queue.pending.len(), 2);
        assert_eq!(queue.pending[0].cue_id.as_deref(), Some("oldest"));
        assert_eq!(queue.pending[1].cue_id.as_deref(), Some("middle"));
    }

    #[test]
    fn translation_queue_drops_only_expired_pending_cues_before_enqueue() {
        let mut queue = TranslationPlaybackQueue::new(8);
        queue.enqueue(translation_job("oldest", 1_000, 3_000), 1_000).unwrap();
        queue.enqueue(translation_job("middle", 7_000, 1_000), 1_000).unwrap();

        let outcome = queue
            .enqueue(translation_job("newest", 7_001, 1_000), 7_001)
            .expect("the expired oldest cue may be removed while the fresh cue is retained");

        assert_eq!(outcome.dropped.len(), 1);
        assert_eq!(outcome.dropped[0].cue_id.as_deref(), Some("oldest"));
        assert_eq!(outcome.projected_start_ms, 8_001);
        assert_eq!(queue.pending[0].cue_id.as_deref(), Some("middle"));
        assert_eq!(queue.pending[1].cue_id.as_deref(), Some("newest"));
    }

    #[test]
    fn translation_queue_never_interrupts_active_or_evicts_fresh_pending_for_congestion() {
        let mut queue = TranslationPlaybackQueue::new(1);
        queue.enqueue(translation_job("playing", 1_000, 4_000), 1_000).unwrap();
        let started = queue.start_next(1_000).job.expect("first cue should start");
        assert_eq!(started.cue_id.as_deref(), Some("playing"));
        queue.enqueue(translation_job("pending", 1_000, 1_000), 1_000).unwrap();

        let failure = queue
            .enqueue(translation_job("newest", 1_000, 1_000), 1_000)
            .expect_err("a fresh pending cue must make the bounded queue reject the newcomer");

        assert_eq!(queue.active.as_ref().and_then(|active| active.cue_id.as_deref()), Some("playing"));
        assert_eq!(failure.reason, TranslationEnqueueFailureReason::QueueFull);
        assert!(failure.dropped.is_empty());
        assert_eq!(queue.pending[0].cue_id.as_deref(), Some("pending"));
    }

    #[test]
    fn translation_worker_rechecks_expiry_immediately_before_start() {
        let mut queue = TranslationPlaybackQueue::new(2);
        queue.enqueue(translation_job("expired-before-start", 1_000, 1_000), 1_000).unwrap();

        let outcome = queue.start_next(7_001);

        assert!(outcome.job.is_none());
        assert_eq!(outcome.dropped.len(), 1);
        assert_eq!(outcome.dropped[0].cue_id.as_deref(), Some("expired-before-start"));
        assert!(queue.active.is_none());
    }

    #[test]
    fn active_cue_that_fills_the_budget_causes_explicit_overflow_without_interruption() {
        let mut queue = TranslationPlaybackQueue::new(2);
        queue.enqueue(translation_job("long-active", 1_000, 6_000), 1_000).unwrap();
        queue.start_next(1_000).job.unwrap();

        let failure = queue
            .enqueue(translation_job("cannot-start-in-time", 1_000, 1_000), 1_000)
            .expect_err("the active cue cannot be interrupted to admit a late newcomer");

        assert_eq!(failure.reason, TranslationEnqueueFailureReason::RealtimeBudget);
        assert!(failure.dropped.is_empty());
        assert_eq!(
            queue.active.as_ref().and_then(|active| active.cue_id.as_deref()),
            Some("long-active")
        );
        assert!(queue.pending.is_empty());
    }

    #[test]
    fn stream_arriving_while_complete_cue_is_active_is_accepted_without_interrupting_complete() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.translation_playback_enabled = true;
            current.physical_playback_status = "ready".to_string();
            current.physical_playback_device_id = "default".to_string();
        }
        let now_ms = super::unix_ms();
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        {
            let mut queue = translation_queue.lock().unwrap();
            queue
                .enqueue(translation_job("complete-a", now_ms, 100), now_ms)
                .unwrap();
            queue.start_next(now_ms).job.unwrap();
        }
        let (playback_tx, playback_rx) = mpsc::sync_channel(2);
        let (playback_control_tx, _playback_control_rx) = mpsc::channel();
        let header = physical_translation_header(
            "stream-b",
            Some(TranslationStreamState::Start),
        );
        let payload = vec![0_u8; header.payload_bytes];
        let pipe = TestResponsePipe::new();

        handle_physical_translation_frame(
            pipe.write_handle,
            runtime_root.path(),
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            &header,
            &payload,
            vec![0.0; INTERNAL_CHANNEL_COUNT as usize * header.frame_count],
            state.lock().unwrap(),
        );

        let ack = pipe.read_json();
        assert_eq!(
            ack["type"],
            "bridge.translation.ack",
            "a valid stream start must wait behind complete-a instead of being mislabeled as queue overflow"
        );
        assert_eq!(
            translation_queue
                .lock()
                .unwrap()
                .active
                .as_ref()
                .and_then(|active| active.cue_id.as_deref()),
            Some("complete-a"),
            "admitting stream-b must not interrupt the active complete cue"
        );
        let PlaybackCommand::TranslationStream(command) = playback_rx.try_recv().unwrap() else {
            panic!("accepted stream-b should be handed to the cross-mode scheduler");
        };
        assert_eq!(command.job.cue_id.as_deref(), Some("stream-b"));
    }

    #[test]
    fn rebinding_route_rejects_new_complete_and_stream_work_before_acceptance() {
        for stream_state in [None, Some(TranslationStreamState::Start)] {
            let runtime_root = TempDir::new().unwrap();
            let status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
            let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
            {
                let mut current = state.lock().unwrap();
                current.session_id = Some("session-rebinding".to_string());
                current.translation_status_outbox = Some(status_outbox.clone());
                current.translation_playback_enabled = true;
                current.physical_playback_status = "rebinding".to_string();
                current.physical_playback_device_id = "hda-speaker".to_string();
            }
            let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
            let (playback_tx, playback_rx) = mpsc::sync_channel(2);
            let (playback_control_tx, _playback_control_rx) = mpsc::channel();
            let header = physical_translation_header("rebind-race", stream_state);
            let payload = vec![0_u8; header.payload_bytes];
            let pipe = TestResponsePipe::new();

            handle_physical_translation_frame(
                pipe.write_handle,
                runtime_root.path(),
                &playback_tx,
                &playback_control_tx,
                &translation_queue,
                &header,
                &payload,
                vec![0.0; INTERNAL_CHANNEL_COUNT as usize * header.frame_count],
                state.lock().unwrap(),
            );

            let ack = pipe.read_json();
            assert_eq!(ack["type"], "bridge.translation.nack");
            assert_eq!(ack["errorCode"], "bridge.translation-generation-ended");
            assert!(translation_queue.lock().unwrap().active.is_none());
            assert!(translation_queue.lock().unwrap().pending.is_empty());
            assert!(!state.lock().unwrap().physical_translation_stream_active());
            assert!(playback_rx.try_recv().is_err());
            assert!(
                status_outbox.lock().unwrap().pending.is_empty(),
                "a frame rejected before acceptance must not manufacture a terminal status"
            );
        }
    }

    #[test]
    fn complete_arriving_while_stream_is_active_waits_without_superseding_stream() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.translation_playback_enabled = true;
            current.physical_playback_status = "ready".to_string();
            current.physical_playback_device_id = "default".to_string();
            current
                .physical_translation_stream_ledger
                .admit("stream-a", 0, TranslationStreamState::Start, 0)
                .unwrap();
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_tx, _playback_rx) = mpsc::sync_channel(2);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        let header = physical_translation_header("complete-b", None);
        let payload = vec![0_u8; header.payload_bytes];
        let pipe = TestResponsePipe::new();

        handle_physical_translation_frame(
            pipe.write_handle,
            runtime_root.path(),
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            &header,
            &payload,
            vec![0.0; INTERNAL_CHANNEL_COUNT as usize * header.frame_count],
            state.lock().unwrap(),
        );

        let ack = pipe.read_json();
        assert_eq!(ack["type"], "bridge.translation.ack");
        assert_eq!(
            translation_queue
                .lock()
                .unwrap()
                .pending
                .front()
                .and_then(|job| job.cue_id.as_deref()),
            Some("complete-b"),
            "complete-b should be retained for playback after stream-a"
        );
        assert!(
            state.lock().unwrap().physical_translation_stream_active(),
            "complete-b must not stale-drop the active stream-a"
        );
        assert!(
            playback_control_rx.try_recv().is_err(),
            "waiting complete-b must not emit TerminateTranslationStream for stream-a"
        );
    }

    #[test]
    fn stream_abort_is_rejected_when_the_terminal_cannot_reach_the_playback_worker() {
        let runtime_root = TempDir::new().unwrap();
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.translation_playback_enabled = true;
            current.physical_playback_status = "ready".to_string();
            current.physical_playback_device_id = "default".to_string();
            current
                .physical_translation_stream_ledger
                .admit("stream-abort", 0, TranslationStreamState::Start, 0)
                .unwrap();
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_tx, _playback_rx) = mpsc::sync_channel(1);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        drop(playback_control_rx);
        let mut header = physical_translation_header(
            "stream-abort",
            Some(TranslationStreamState::Abort),
        );
        header.chunk_index = Some(1);
        let pipe = TestResponsePipe::new();

        handle_physical_translation_frame(
            pipe.write_handle,
            runtime_root.path(),
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            &header,
            &[],
            Vec::new(),
            state.lock().unwrap(),
        );

        let ack = pipe.read_json();
        assert_eq!(ack["type"], "bridge.translation.nack");
        assert_eq!(ack["errorCode"], "bridge.translation-playback-failed");
        assert!(
            state.lock().unwrap().physical_translation_stream_active(),
            "a failed Abort handoff must remain retryable instead of losing the only terminal owner"
        );
    }

    #[test]
    fn accepted_abort_owns_the_only_terminal_against_late_natural_completion() {
        let runtime_root = TempDir::new().unwrap();
        let status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("session-abort".to_string());
            current.translation_status_outbox = Some(status_outbox.clone());
            current.translation_playback_enabled = true;
            current.physical_playback_status = "ready".to_string();
            current.physical_playback_device_id = "hda-speaker".to_string();
            current
                .physical_translation_stream_ledger
                .admit("stream-abort-race", 0, TranslationStreamState::Start, 0)
                .unwrap();
            bind_test_cue_authority(&current, "stream-abort-race");
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_tx, _playback_rx) = mpsc::sync_channel(1);
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        let mut header = physical_translation_header(
            "stream-abort-race",
            Some(TranslationStreamState::Abort),
        );
        header.chunk_index = Some(1);
        let pipe = TestResponsePipe::new();

        handle_physical_translation_frame(
            pipe.write_handle,
            runtime_root.path(),
            &playback_tx,
            &playback_control_tx,
            &translation_queue,
            &header,
            &[],
            Vec::new(),
            state.lock().unwrap(),
        );
        assert_eq!(pipe.read_json()["type"], "bridge.translation.ack");

        let mut output = None;
        let mut physical_stream = Some(ActivePhysicalTranslationStream {
            cue_id: "stream-abort-race".to_string(),
            created_at_ms: 1_000,
            estimated_duration_ms: 100,
            playback_frames: 960,
            translation_generation: 0,
            buffering_started_at: std::time::Instant::now(),
            playback_started: true,
            ducking_enabled: false,
            ducking_depth_percent: 0,
            ended: true,
        });
        finish_completed_physical_stream(&mut output, &state, &mut physical_stream);
        let mut cancelled = std::collections::HashSet::new();
        let mut pending = std::collections::VecDeque::new();
        apply_playback_control_commands(
            &playback_control_rx,
            &mut output,
            &state,
            &translation_queue,
            &mut physical_stream,
            &mut cancelled,
            &mut pending,
        );

        let statuses = status_outbox.lock().unwrap();
        assert_eq!(statuses.pending.len(), 1);
        assert_eq!(
            statuses.pending[0].playback_status,
            TranslationPlaybackStatusKind::RouteFailed
        );
        assert_eq!(statuses.pending[0].cue_id, "stream-abort-race");
        assert!(physical_stream.is_none());
    }

    #[test]
    fn process_exclusion_readiness_is_independent_of_driver_health() {
        assert!(capture_route_is_ready(
            SourceCaptureMode::ProcessExclusion,
            "not-installed",
            ProcessLoopbackStatus::Ready,
        ));
        assert!(!capture_route_is_ready(
            SourceCaptureMode::ProcessExclusion,
            "running",
            ProcessLoopbackStatus::Failed,
        ));
        assert!(!capture_route_is_ready(
            SourceCaptureMode::VirtualDriver,
            "not-installed",
            ProcessLoopbackStatus::Ready,
        ));
    }

    #[test]
    fn translation_realtime_budget_uses_projected_start_time() {
        assert!(!translation_would_miss_realtime_budget(1_000, 6_000));
        assert!(translation_would_miss_realtime_budget(1_000, 6_001));
        assert!(!translation_would_miss_realtime_budget(2_000, 1_000));
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
        assert_eq!(host.runtime_root, std::path::PathBuf::from("C:\\bridge-runtime"));
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
        assert!(state.source_subscriber_active);
        assert_eq!(state.source_worker_phase, "subscriber-connected");
        let first_progress = state.source_worker_last_progress_timestamp_ms;
        assert!(first_progress.is_some());
        let (gen_b, _) = begin_source_subscription(&mut state);
        assert_ne!(gen_a, gen_b);
        assert!(!source_subscription_is_owner(&state, gen_a));
        assert!(!end_source_subscription(&mut state, gen_a));
        assert!(source_subscription_is_owner(&state, gen_b));
        assert_eq!(state.source_worker_phase, "subscriber-connected");
        assert!(end_source_subscription(&mut state, gen_b));
        assert!(!state.source_subscriber_active);
        assert_eq!(state.source_worker_phase, "waiting-subscriber");
        assert!(state.source_worker_last_progress_timestamp_ms >= first_progress);
    }

    #[test]
    fn silent_process_packet_continues_the_ready_source_generation() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.source_capture_mode = SourceCaptureMode::ProcessExclusion;
            current.capture_backend = CaptureBackend::WasapiProcessExclusion;
            current.process_loopback_supported = true;
            current.process_loopback_status = ProcessLoopbackStatus::Ready;
            current.source_subscriber_active = true;
            current.source_generation = 41;
        }
        let float_samples = 960 * INTERNAL_CHANNEL_COUNT as usize;
        let mut sample_bytes = std::collections::VecDeque::new();
        append_capture_packet(
            &mut sample_bytes,
            vec![0x7f; float_samples * std::mem::size_of::<f32>()],
            true,
        );
        let mut peak = 0.0;
        let mut square_sum = 0.0;
        let mut sample_count = 0;
        let (payload, invalid) = take_process_capture_chunk(
            &mut sample_bytes,
            &mut peak,
            &mut square_sum,
            &mut sample_count,
        )
        .expect("one silent WASAPI packet must produce one source chunk");
        assert_eq!(payload.len(), 960 * INTERNAL_CHANNEL_COUNT as usize * 2);
        assert!(payload.iter().all(|byte| *byte == 0));
        assert_eq!(invalid, 0);
        assert_eq!(peak, 0.0);

        let (playback_tx, playback_rx) = mpsc::sync_channel(1);
        let (source_tx, source_rx) = mpsc::sync_channel(1);
        assert!(dispatch_source_frame(
            &state,
            Path::new("."),
            &playback_tx,
            &source_tx,
            41,
            SourceCaptureMode::ProcessExclusion,
            payload,
        ));
        assert!(source_rx.try_recv().unwrap().iter().all(|byte| *byte == 0));
        assert!(playback_rx.try_recv().is_err());
        let current = state.lock().unwrap();
        assert_eq!(current.process_loopback_status, ProcessLoopbackStatus::Ready);
        assert!(current.source_subscriber_active);
        assert_eq!(current.source_generation, 41);
        assert_eq!(current.source_frames_captured, 960);
        assert_eq!(current.last_error_code, None);
    }

    #[test]
    fn missing_physical_endpoint_fails_only_the_translation_cue() {
        let status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("missing-endpoint-session".to_string());
            current.source_capture_mode = SourceCaptureMode::ProcessExclusion;
            current.capture_backend = CaptureBackend::WasapiProcessExclusion;
            current.process_loopback_supported = true;
            current.process_loopback_status = ProcessLoopbackStatus::Ready;
            current.bridge_state = "running".to_string();
            current.lifecycle_state = "ready".to_string();
            current.source_subscriber_active = true;
            current.source_generation = 77;
            current.translation_status_outbox = Some(status_outbox.clone());
            bind_test_cue_authority(&current, "missing-endpoint-cue");
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let now_ms = super::unix_ms();
        let mut job = translation_job("missing-endpoint-cue", now_ms, 20);
        job.device_id = format!("omni-definitely-missing-endpoint-{}", uuid::Uuid::new_v4());
        translation_queue
            .lock()
            .unwrap()
            .enqueue(job, now_ms)
            .unwrap();
        let mut output = None;

        start_next_translation(&mut output, &state, &translation_queue);

        assert!(output.is_none(), "a missing endpoint must never start physical playback");
        let queue = translation_queue.lock().unwrap();
        assert!(queue.active.is_none());
        assert!(queue.pending.is_empty());
        drop(queue);
        let pending = status_outbox.lock().unwrap();
        assert_eq!(pending.pending.len(), 1);
        let terminal = &pending.pending[0];
        assert_eq!(terminal.cue_id, "missing-endpoint-cue");
        assert_eq!(terminal.playback_status, TranslationPlaybackStatusKind::RouteFailed);
        assert_eq!(
            terminal.error_code.as_deref(),
            Some("bridge.translation-playback-failed")
        );
        assert!(terminal.reason.starts_with("physical-output-open-failed:"));
        drop(pending);
        let current = state.lock().unwrap();
        assert_eq!(current.playback_frames_written, 0);
        assert_eq!(current.process_loopback_status, ProcessLoopbackStatus::Ready);
        assert!(current.source_subscriber_active);
        assert_eq!(current.source_generation, 77);
        assert_eq!(current.bridge_state, "running");
        assert_eq!(current.lifecycle_state, "ready");
    }

    #[test]
    fn stale_capture_generation_cannot_dispatch_to_source_or_monitor() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.source_capture_mode = SourceCaptureMode::VirtualDriver;
            current.source_subscriber_active = true;
            current.source_generation = 8;
            current.source_monitor_playback_enabled = true;
            current.mix_control.keep_original_audio = true;
        }
        let (playback_tx, playback_rx) = mpsc::sync_channel(2);
        let (source_tx, source_rx) = mpsc::sync_channel(2);
        let payload = vec![1_u8; 960 * INTERNAL_CHANNEL_COUNT as usize * 2];

        assert!(!dispatch_source_frame(
            &state,
            Path::new("."),
            &playback_tx,
            &source_tx,
            7,
            SourceCaptureMode::VirtualDriver,
            payload.clone(),
        ));
        assert!(source_rx.try_recv().is_err());
        assert!(playback_rx.try_recv().is_err());
        {
            let current = state.lock().unwrap();
            assert_eq!(current.source_frames_captured, 0);
            assert_eq!(current.source_released_frames, 0);
            assert_eq!(current.stale_source_frames_dropped, 960);
        }

        assert!(!dispatch_source_frame(
            &state,
            Path::new("."),
            &playback_tx,
            &source_tx,
            8,
            SourceCaptureMode::ProcessExclusion,
            payload.clone(),
        ));
        assert!(source_rx.try_recv().is_err());
        assert!(playback_rx.try_recv().is_err());
        assert_eq!(state.lock().unwrap().stale_source_frames_dropped, 1_920);

        assert!(dispatch_source_frame(
            &state,
            Path::new("."),
            &playback_tx,
            &source_tx,
            8,
            SourceCaptureMode::VirtualDriver,
            payload.clone(),
        ));
        assert_eq!(source_rx.try_recv().unwrap(), payload);
        assert!(matches!(playback_rx.try_recv(), Ok(PlaybackCommand::Play(_))));
        let current = state.lock().unwrap();
        assert_eq!(current.source_worker_phase, "source-frame-delivered");
        assert!(current.source_worker_last_progress_timestamp_ms.is_some());
        assert!(current.last_frame_timestamp_ms.is_some());
    }

    #[test]
    fn runtime_process_capture_failure_stops_the_route_without_backend_fallback() {
        let status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = std::sync::Arc::new(std::sync::Mutex::new(BridgeState::new(
            "0.1.0".to_string(),
        )));
        {
            let mut current = state.lock().unwrap();
            current.source_capture_mode = SourceCaptureMode::ProcessExclusion;
            current.capture_backend = CaptureBackend::WasapiProcessExclusion;
            current.process_loopback_supported = true;
            current.process_loopback_status = ProcessLoopbackStatus::Ready;
            current.source_subscriber_active = true;
            current.source_generation = 7;
            current.bridge_state = "running".to_string();
            current.lifecycle_state = "ready".to_string();
            current.translation_status_outbox = Some(status_outbox.clone());
            bind_test_cue_authority(&current, "active-cue");
            bind_test_cue_authority(&current, "pending-cue");
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        {
            let mut queue = translation_queue.lock().unwrap();
            queue
                .enqueue(translation_job("active-cue", 1_000, 1_000), 1_000)
                .unwrap();
            queue.start_next(1_000).job.unwrap();
            queue
                .enqueue(translation_job("pending-cue", 1_000, 1_000), 1_000)
                .unwrap();
        }
        let (playback_control_tx, playback_control_rx) = std::sync::mpsc::channel();

        let stop = fail_process_loopback_route(
            &state,
            &playback_control_tx,
            &translation_queue,
            "WASAPI process capture stopped".to_string(),
        )
        .expect("the process route must produce a stop request");

        let PlaybackControlCommand::StopAll(received) = playback_control_rx.try_recv().unwrap() else {
            panic!("expected stop-all playback control");
        };
        assert_eq!(received, stop);
        assert_eq!(stop.reason, "process-loopback-capture-failed");
        assert_eq!(
            stop.error_code.as_deref(),
            Some("bridge.process-loopback-capture-failed")
        );
        assert_eq!(stop.terminated_cues.len(), 2);
        assert!(stop
            .terminated_cues
            .iter()
            .all(|terminal| terminal.status == TranslationPlaybackStatusKind::RouteFailed));
        assert_eq!(
            stop.terminated_cues
                .iter()
                .filter_map(|terminal| terminal.cue_id.as_deref())
                .collect::<Vec<_>>(),
            vec!["active-cue", "pending-cue"]
        );
        {
            let pending_statuses = status_outbox.lock().unwrap();
            assert_eq!(pending_statuses.pending.len(), 2);
            assert_eq!(
                pending_statuses
                    .pending
                    .iter()
                    .map(|event| (event.cue_id.as_str(), event.playback_status))
                    .collect::<Vec<_>>(),
                vec![
                    ("active-cue", TranslationPlaybackStatusKind::RouteFailed),
                    ("pending-cue", TranslationPlaybackStatusKind::RouteFailed),
                ],
                "every cue terminal must remain queued ahead of source.error"
            );
        }
        {
            let mut pending_statuses = status_outbox.lock().unwrap();
            let first = pending_statuses.pending[0].clone();
            let second = pending_statuses.pending[1].clone();
            assert!(
                !pending_statuses.acknowledge(&TranslationPlaybackStatusAck {
                    event_type: "bridge.translation.status.ack".to_string(),
                    status_id: second.status_id.clone(),
                    session_id: second.session_id.clone(),
                    bridge_instance_id: second.bridge_instance_id.clone(),
                    source_generation: second.source_generation,
                    source_generation_token: second.source_generation_token.clone(),
                    playback_owner_generation: second.playback_owner_generation,
                    physical_playback_device_id: second.physical_playback_device_id.clone(),
                }),
                "the second capture-failure terminal cannot bypass the unacknowledged front"
            );
            assert!(pending_statuses.acknowledge(&TranslationPlaybackStatusAck {
                event_type: "bridge.translation.status.ack".to_string(),
                status_id: first.status_id,
                session_id: first.session_id,
                bridge_instance_id: first.bridge_instance_id,
                source_generation: first.source_generation,
                source_generation_token: first.source_generation_token,
                playback_owner_generation: first.playback_owner_generation,
                physical_playback_device_id: first.physical_playback_device_id,
            }));
            assert_eq!(pending_statuses.front().map(|event| event.cue_id.as_str()), Some("pending-cue"));
            assert!(pending_statuses.acknowledge(&TranslationPlaybackStatusAck {
                event_type: "bridge.translation.status.ack".to_string(),
                status_id: second.status_id,
                session_id: second.session_id,
                bridge_instance_id: second.bridge_instance_id,
                source_generation: second.source_generation,
                source_generation_token: second.source_generation_token,
                playback_owner_generation: second.playback_owner_generation,
                physical_playback_device_id: second.physical_playback_device_id,
            }));
            assert!(pending_statuses.front().is_none());
        }
        let queue = translation_queue.lock().unwrap();
        assert!(queue.active.is_none());
        assert!(queue.pending.is_empty());
        drop(queue);
        let current = state.lock().unwrap();
        assert_eq!(current.source_capture_mode, SourceCaptureMode::ProcessExclusion);
        assert_eq!(current.capture_backend, CaptureBackend::WasapiProcessExclusion);
        assert_eq!(current.process_loopback_status, ProcessLoopbackStatus::Failed);
        assert!(!current.source_subscriber_active);
        assert_eq!(current.source_generation, 8);
        assert_eq!(current.bridge_state, "degraded");
        assert_eq!(current.lifecycle_state, "error");
        assert_eq!(
            current.last_error_code.as_deref(),
            Some("bridge.process-loopback-capture-failed")
        );

        let failure = process_source_route_failure(&current)
            .expect("a failed process route must reject the active or next subscriber");
        let header = source_route_error_header(&current, &failure);
        assert_eq!(header["type"], "bridge.source.error");
        assert_eq!(
            header["errorCode"],
            "bridge.process-loopback-capture-failed"
        );
        assert_eq!(header["payloadBytes"], 0);
    }

    #[test]
    fn stop_control_cannot_be_lost_when_the_bounded_playback_queue_is_full() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        {
            let mut queue = translation_queue.lock().unwrap();
            queue
                .enqueue(translation_job("active", 1_000, 1_000), 1_000)
                .unwrap();
            queue.start_next(1_000).job.unwrap();
            queue
                .enqueue(translation_job("pending", 1_000, 1_000), 1_000)
                .unwrap();
        }
        let (playback_tx, _playback_rx) = mpsc::sync_channel(1);
        playback_tx.send(PlaybackCommand::TranslationQueued).unwrap();
        assert!(matches!(
            playback_tx.try_send(PlaybackCommand::TranslationQueued),
            Err(mpsc::TrySendError::Full(_))
        ));
        let (playback_control_tx, playback_control_rx) = mpsc::channel();

        let stop = request_playback_stop(
            &mut state.lock().unwrap(),
            &translation_queue,
            &playback_control_tx,
            "process-loopback-capture-failed",
            Some("bridge.process-loopback-capture-failed"),
        );

        assert_eq!(stop.terminated_cues.len(), 2);
        assert!(translation_queue.lock().unwrap().active.is_none());
        assert!(translation_queue.lock().unwrap().pending.is_empty());
        assert!(matches!(
            playback_control_rx.try_recv(),
            Ok(PlaybackControlCommand::StopAll(_))
        ));
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
        state.last_frame_timestamp_ms = Some(900);
        state.source_read_calls = 1;
        let summary = source_watchdog_summary(&state, 7000);
        assert!(summary.contains("event=source_watchdog"));
        assert!(summary.contains("sourceSubscriberActive=true"));
        assert!(summary.contains("workerPhase=reading-driver"));
        assert!(summary.contains("lastProgressAgeMs=6000"));
        assert!(summary.contains("lastDeliveryAgeMs=6100"));
    }

    #[test]
    fn source_watchdog_keeps_true_no_subscriber_distinct_from_delivery_stall() {
        let mut state = BridgeState::new("0.1.0".to_string());
        state.source_generation = 11;
        state.source_subscriber_active = false;
        state.source_worker_phase = "waiting-subscriber".to_string();
        state.source_worker_last_progress_timestamp_ms = Some(1_000);

        let summary = source_watchdog_summary(&state, 7_000);

        assert!(summary.contains("sourceSubscriberActive=false"));
        assert!(summary.contains("sourceGeneration=11"));
        assert!(summary.contains("lastProgressAgeMs=6000"));
        assert!(summary.contains("lastDeliveryAgeMs=none"));
    }

    #[test]
    fn state_snapshot_includes_source_diagnostics() {
        let mut state = BridgeState::new("0.1.0".to_string());
        state.driver_captured_bytes = 12;
        state.driver_delivered_bytes = 8;
        state.source_generation = 3;
        state.source_read_calls = 4;
        state.source_capture_mode = SourceCaptureMode::ProcessExclusion;
        state.capture_backend = super::CaptureBackend::WasapiProcessExclusion;
        state.process_loopback_supported = true;
        state.process_loopback_status = ProcessLoopbackStatus::Ready;
        state.session_id = Some("session-1".to_string());
        let snapshot = state_snapshot("request-1", &state);
        assert_eq!(snapshot["bridgeProcessId"], std::process::id());
        assert_eq!(snapshot["bridgeInstanceId"], state.bridge_instance_id);
        assert_eq!(snapshot["driverCapturedBytes"], 12);
        assert_eq!(snapshot["driverDeliveredBytes"], 8);
        assert_eq!(snapshot["sourceGeneration"], 3);
        assert_eq!(
            snapshot["sourceGenerationToken"],
            format!("{}:session-1:3", state.bridge_instance_id)
        );
        assert_eq!(snapshot["sourceReadCalls"], 4);
        assert_eq!(snapshot["sourceCaptureMode"], "process-exclusion");
        assert_eq!(snapshot["captureBackend"], "wasapi-process-exclusion");
        assert_eq!(snapshot["processLoopbackSupported"], true);
        assert_eq!(snapshot["processLoopbackStatus"], "ready");
        assert_eq!(
            snapshot["processLoopbackMinimumWindowsBuild"],
            PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD
        );
    }

    #[test]
    fn physical_stream_waits_for_a_bounded_startup_buffer() {
        let target_frames = INTERNAL_SAMPLE_RATE_HZ as u64
            * PHYSICAL_TRANSLATION_STREAM_STARTUP_BUFFER_MS
            / 1_000;
        assert!(!physical_stream_ready_to_start(
            target_frames - 1,
            false,
            Duration::from_millis(PHYSICAL_TRANSLATION_STREAM_STARTUP_MAX_WAIT_MS - 1),
        ));
        assert!(physical_stream_ready_to_start(
            target_frames,
            false,
            Duration::ZERO,
        ));
    }

    #[test]
    fn physical_stream_startup_is_forced_by_end_or_max_wait() {
        assert!(physical_stream_ready_to_start(1, true, Duration::ZERO));
        assert!(physical_stream_ready_to_start(
            1,
            false,
            Duration::from_millis(PHYSICAL_TRANSLATION_STREAM_STARTUP_MAX_WAIT_MS),
        ));
    }

    #[test]
    fn pending_physical_stream_drains_only_for_the_active_cue() {
        let mut cue_b = PhysicalTranslationStreamCommand {
            job: translation_job("cue-b", 1_000, 100),
            state: TranslationStreamState::Start,
        };
        cue_b.job.translation_arrival_sequence = 2;
        assert!(pending_physical_stream_command_is_ready(
            None,
            Some(&cue_b),
            false,
            None,
        ));
        assert!(pending_physical_stream_command_is_ready(
            Some("cue-b"),
            Some(&cue_b),
            true,
            Some(1),
        ));
        assert!(!pending_physical_stream_command_is_ready(
            Some("cue-a"),
            Some(&cue_b),
            false,
            None,
        ));
        assert!(!pending_physical_stream_command_is_ready(
            None,
            Some(&cue_b),
            true,
            None,
        ));
        assert!(!pending_physical_stream_command_is_ready(
            None,
            Some(&cue_b),
            false,
            Some(1),
        ));
        assert!(!pending_physical_stream_command_is_ready(
            Some("cue-a"),
            None,
            false,
            None,
        ));
    }

    #[test]
    fn idle_cross_mode_scheduler_selects_the_earliest_accepted_cue() {
        let mut stream = PhysicalTranslationStreamCommand {
            job: translation_job("stream", 1_000, 100),
            state: TranslationStreamState::Start,
        };
        stream.job.translation_arrival_sequence = 2;

        assert!(pending_physical_stream_command_is_ready(
            None,
            Some(&stream),
            false,
            Some(3),
        ));
        assert!(!complete_translation_command_is_ready(
            false,
            false,
            Some(3),
            Some(2),
        ));

        stream.job.translation_arrival_sequence = 4;
        assert!(!pending_physical_stream_command_is_ready(
            None,
            Some(&stream),
            false,
            Some(3),
        ));
        assert!(complete_translation_command_is_ready(
            false,
            false,
            Some(3),
            Some(4),
        ));
    }

    #[test]
    fn active_cross_mode_cue_retains_the_sink_until_its_terminal() {
        let mut next_stream = PhysicalTranslationStreamCommand {
            job: translation_job("stream-b", 1_000, 100),
            state: TranslationStreamState::Start,
        };
        next_stream.job.translation_arrival_sequence = 2;

        assert!(!pending_physical_stream_command_is_ready(
            None,
            Some(&next_stream),
            true,
            None,
        ));
        assert!(!complete_translation_command_is_ready(
            true,
            false,
            Some(3),
            None,
        ));
    }

    #[test]
    fn active_stream_continuation_bypasses_a_later_stream_start_at_the_pending_head() {
        let mut later_start = PhysicalTranslationStreamCommand {
            job: translation_job("stream-b", 1_000, 100),
            state: TranslationStreamState::Start,
        };
        later_start.job.translation_arrival_sequence = 2;
        let mut active_chunk = PhysicalTranslationStreamCommand {
            job: translation_job("stream-a", 1_000, 100),
            state: TranslationStreamState::Chunk,
        };
        active_chunk.job.translation_arrival_sequence = 3;
        let mut pending = std::collections::VecDeque::from([later_start, active_chunk]);

        let ready = take_ready_physical_stream_command(
            Some("stream-a"),
            &mut pending,
            false,
            None,
        );
        assert_eq!(
            ready.and_then(|command| command.job.cue_id),
            Some("stream-a".to_string()),
        );
        assert_eq!(
            pending.front().and_then(|command| command.job.cue_id.as_deref()),
            Some("stream-b"),
            "a later stream Start must retain its FIFO position while the active cue drains"
        );
    }

    #[test]
    fn stopped_generation_stream_command_cannot_mutate_worker_playback_state() {
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        state.lock().unwrap().translation_generation = 2;
        let mut stale_end = PhysicalTranslationStreamCommand {
            job: translation_job("stopped-stream", 1_000, 100),
            state: TranslationStreamState::End,
        };
        stale_end.job.translation_generation = 1;
        let mut active = Some(ActivePhysicalTranslationStream {
            cue_id: "stopped-stream".to_string(),
            created_at_ms: 1_000,
            estimated_duration_ms: 100,
            playback_frames: 0,
            translation_generation: 1,
            buffering_started_at: std::time::Instant::now(),
            playback_started: false,
            ducking_enabled: false,
            ducking_depth_percent: 0,
            ended: false,
        });
        let mut output = None;
        let mut cancelled = std::collections::HashSet::new();

        play_physical_translation_stream(
            stale_end,
            &mut output,
            &state,
            &mut active,
            &mut cancelled,
        );

        assert!(
            !active.as_ref().unwrap().ended,
            "a command accepted before StopAll must not mutate worker state after the generation advances"
        );
        assert!(output.is_none());
    }

    #[test]
    fn stop_all_terminal_prevents_a_late_natural_completion_terminal() {
        let status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("session-stop".to_string());
            current.translation_status_outbox = Some(status_outbox.clone());
            current
                .physical_translation_stream_ledger
                .admit("stopped-completion", 0, TranslationStreamState::Start, 0)
                .unwrap();
            bind_test_cue_authority(&current, "stopped-completion");
        }
        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_control_tx, playback_control_rx) = mpsc::channel();
        let mut physical_stream = Some(ActivePhysicalTranslationStream {
            cue_id: "stopped-completion".to_string(),
            created_at_ms: 1_000,
            estimated_duration_ms: 100,
            playback_frames: 960,
            translation_generation: 0,
            buffering_started_at: std::time::Instant::now(),
            playback_started: true,
            ducking_enabled: false,
            ducking_depth_percent: 0,
            ended: true,
        });

        request_playback_stop(
            &mut state.lock().unwrap(),
            &translation_queue,
            &playback_control_tx,
            "session-changed",
            None,
        );
        let mut output = None;
        finish_completed_physical_stream(&mut output, &state, &mut physical_stream);
        let mut cancelled = std::collections::HashSet::new();
        let mut pending = std::collections::VecDeque::new();
        apply_playback_control_commands(
            &playback_control_rx,
            &mut output,
            &state,
            &translation_queue,
            &mut physical_stream,
            &mut cancelled,
            &mut pending,
        );

        let statuses = status_outbox.lock().unwrap();
        assert_eq!(statuses.pending.len(), 1);
        assert_eq!(
            statuses.pending[0].playback_status,
            TranslationPlaybackStatusKind::StaleDropped
        );
        assert_eq!(statuses.pending[0].cue_id, "stopped-completion");
    }

    #[test]
    fn old_generation_completion_cannot_claim_a_reused_cue_id() {
        let status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("session-new-generation".to_string());
            current.translation_status_outbox = Some(status_outbox.clone());
            current.translation_generation = 2;
            current
                .physical_translation_stream_ledger
                .admit("reused-cue", 0, TranslationStreamState::Start, 2)
                .unwrap();
        }
        let mut physical_stream = Some(ActivePhysicalTranslationStream {
            cue_id: "reused-cue".to_string(),
            created_at_ms: 1_000,
            estimated_duration_ms: 100,
            playback_frames: 960,
            translation_generation: 1,
            buffering_started_at: std::time::Instant::now(),
            playback_started: true,
            ducking_enabled: false,
            ducking_depth_percent: 0,
            ended: true,
        });
        let mut output = None;

        finish_completed_physical_stream(&mut output, &state, &mut physical_stream);

        assert!(status_outbox.lock().unwrap().pending.is_empty());
        let current = state.lock().unwrap();
        assert_eq!(
            current
                .physical_translation_stream_ledger
                .active
                .get("reused-cue")
                .map(|cursor| cursor.translation_generation),
            Some(2),
            "an old local worker snapshot must not steal terminal ownership from the new generation"
        );
    }

    #[test]
    fn committed_completion_remains_the_only_terminal_when_stop_arrives_later() {
        let status_outbox = Arc::new(Mutex::new(TranslationStatusOutbox::default()));
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        {
            let mut current = state.lock().unwrap();
            current.session_id = Some("session-completed".to_string());
            current.translation_status_outbox = Some(status_outbox.clone());
            current
                .physical_translation_stream_ledger
                .admit("completed-before-stop", 0, TranslationStreamState::Start, 0)
                .unwrap();
            bind_test_cue_authority(&current, "completed-before-stop");
        }
        let mut physical_stream = Some(ActivePhysicalTranslationStream {
            cue_id: "completed-before-stop".to_string(),
            created_at_ms: 1_000,
            estimated_duration_ms: 100,
            playback_frames: 960,
            translation_generation: 0,
            buffering_started_at: std::time::Instant::now(),
            playback_started: true,
            ducking_enabled: false,
            ducking_depth_percent: 0,
            ended: true,
        });
        let mut output = None;
        finish_completed_physical_stream(&mut output, &state, &mut physical_stream);

        let translation_queue = Arc::new(Mutex::new(TranslationPlaybackQueue::new(4)));
        let (playback_control_tx, _playback_control_rx) = mpsc::channel();
        let stop = request_playback_stop(
            &mut state.lock().unwrap(),
            &translation_queue,
            &playback_control_tx,
            "session-changed",
            None,
        );

        assert!(stop.terminated_cues.is_empty());
        let statuses = status_outbox.lock().unwrap();
        assert_eq!(statuses.pending.len(), 1);
        assert_eq!(
            statuses.pending[0].playback_status,
            TranslationPlaybackStatusKind::Completed
        );
        assert_eq!(statuses.pending[0].cue_id, "completed-before-stop");
    }
}
