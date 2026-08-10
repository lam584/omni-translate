use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub(crate) use omni_bridge_protocol::{
    AudioFrameAck as BridgeTranslationFrameAck, AudioFrameHeader as BridgeTranslationFrameHeader,
    AudioRouteDirection, AudioSampleFormat, CaptureBackend, MixControl as BridgeMixControl,
    ProcessLoopbackStatus, SourceCaptureMode, TranslationAudioSink,
};

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeRuntimeSnapshot {
    /// Authoritative native producer identity. These values are absent only
    /// before the Bridge has completed its first handshake.
    pub bridge_process_id: Option<u32>,
    pub bridge_instance_id: Option<String>,
    #[ts(type = "'stopped' | 'starting' | 'running' | 'error'")]
    pub process_status: String,
    #[ts(type = "'development' | 'release'")]
    pub install_channel: String,
    #[ts(type = "'idle' | 'planned' | 'probing' | 'elevation-required' | 'waiting-for-elevation' | 'waiting-for-restart' | 'installing-driver' | 'uninstalling-driver' | 'starting-bridge' | 'verifying' | 'rollback-required' | 'ready'")]
    pub install_phase: String,
    pub target_device_id: String,
    pub virtual_render_device_id: String,
    pub physical_playback_device_id: String,
    pub physical_playback_level: u64,
    pub mix_control: BridgeMixControl,
    pub monitor_playback_enabled: bool,
    pub translation_playback_enabled: bool,
    pub virtual_mic_output_requested: bool,
    pub expected_driver_version: String,
    pub expected_bridge_version: String,
    #[ts(type = "'stopped' | 'starting' | 'running' | 'degraded'")]
    pub bridge_state: String,
    #[ts(type = "'idle' | 'initializing' | 'ready' | 'writing' | 'draining' | 'stopped' | 'error'")]
    pub lifecycle_state: String,
    #[ts(type = "'not-installed' | 'damaged' | 'version-mismatch' | 'running'")]
    pub driver_health: String,
    pub driver_version: Option<String>,
    pub bridge_version: String,
    pub source_capture_mode: SourceCaptureMode,
    pub capture_backend: CaptureBackend,
    pub process_loopback_supported: bool,
    pub process_loopback_status: ProcessLoopbackStatus,
    pub windows_build_number: Option<u32>,
    pub process_loopback_minimum_windows_build: u32,
    pub excluded_process_id: Option<u32>,
    pub process_loopback_failure_detail: Option<String>,
    pub capture_lifecycle_state: String,
    pub capture_restart_count: u64,
    pub capture_packet_count: u64,
    pub capture_frames_received: u64,
    pub capture_peak: f32,
    pub capture_rms: f32,
    pub capture_silent_packet_count: u64,
    pub capture_invalid_sample_count: u64,
    pub resolved_physical_playback_device_id: String,
    pub monitor_buffered_ms: usize,
    pub monitor_underrun_count: u64,
    pub monitor_overrun_count: u64,
    pub queued_frames: usize,
    pub source_frames_captured: u64,
    pub translated_frames_accepted: u64,
    pub translation_queue_end_timestamp_ms: u64,
    pub playback_frames_written: u64,
    pub underrun_count: u64,
    pub dropped_frame_count: u64,
    pub driver_buffered_bytes: u64,
    pub driver_max_buffered_bytes: u64,
    pub driver_captured_bytes: u64,
    pub driver_delivered_bytes: u64,
    pub driver_dropped_bytes: u64,
    pub source_pending_bytes: usize,
    pub source_pacer_queued_frames: usize,
    pub monitor_source_queued_frames: usize,
    pub stale_source_frames_dropped: u64,
    pub source_subscriber_active: bool,
    pub source_generation: u64,
    pub source_generation_token: Option<String>,
    pub source_worker_phase: String,
    pub source_worker_last_progress_timestamp_ms: Option<u64>,
    pub source_read_calls: u64,
    pub source_zero_byte_reads: u64,
    pub source_monitor_playback_enabled: bool,
    pub monitor_playback_state: String,
    pub last_frame_timestamp_ms: Option<u64>,
    #[ts(type = "('driver.not-installed' | 'driver.version-mismatch' | 'driver.write-failed' | 'driver.testsigning-disabled' | 'driver.secure-boot-enabled' | 'driver.memory-integrity-enabled' | 'driver.reboot-required' | 'driver.audio-probe-failed' | 'driver.duplicate-root-devices' | 'driver.endpoint-missing' | 'driver.ioctl-unavailable' | 'driver.abi-mismatch' | 'driver.elevation-cancelled' | 'driver.probe-failed' | 'driver.operation-failed' | 'bridge.not-ready' | 'bridge.queue-overflow' | 'bridge.permission-denied' | 'bridge.timeout' | 'bridge.session-mismatch' | 'bridge.singleton-already-running' | 'bridge.process-loopback-unsupported' | 'bridge.process-loopback-activation-failed' | 'bridge.process-loopback-capture-failed' | 'bridge.playback-ownership-barrier-failed' | 'bridge.translation-output-bypass' | 'bridge.translation-playback-failed' | 'bridge.virtual-mic-output-unavailable' | 'bridge.virtual-mic-driver-unavailable' | 'bridge.virtual-mic-format-unsupported' | 'bridge.virtual-mic-session-failed' | 'bridge.virtual-mic-write-failed' | 'monitor.virtual-playback-loop' | 'installer.rollback-triggered') | null")]
    pub last_error_code: Option<String>,
    #[ts(type = "('reinstall-driver' | 'restart-bridge' | 'rollback-driver' | 'open-diagnostics') | null")]
    pub recommended_action: Option<String>,
    pub pipe_name: String,
    pub pipe_path: String,
    pub audio_pipe_path: String,
    pub source_pipe_path: String,
    pub runtime_root: String,
    pub session_id: Option<String>,
    pub last_handshake_at: Option<String>,
    pub rollback_supported: bool,
    #[ts(type = "'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown'")]
    pub status: String,
    #[ts(type = "'idle' | 'probing' | 'ready' | 'failed'")]
    pub driver_probe_state: String,
    pub test_signing_enabled: bool,
    pub signature_enforcement_bypassed: bool,
    pub memory_integrity_enabled: bool,
    pub secure_boot_enabled: Option<bool>,
    #[ts(type = "'idle' | 'waiting-for-elevation' | 'detected' | 'cancelled' | 'unavailable'")]
    pub secure_boot_probe_status: String,
    pub root_device_count: usize,
    pub root_instance_ids: Vec<String>,
    pub endpoint_name: Option<String>,
    pub capture_endpoint_name: Option<String>,
    pub virtual_mic_output_supported: bool,
    #[ts(type = "'unknown' | 'probing' | 'ready' | 'unsupported' | 'failed'")]
    pub virtual_mic_output_status: String,
    pub virtual_mic_format: Option<String>,
    pub virtual_mic_frames_written: u64,
    pub virtual_mic_write_failures: u64,
    pub virtual_mic_last_generation: u64,
    pub virtual_mic_buffered_bytes: u64,
    pub virtual_mic_max_buffered_bytes: u64,
    pub virtual_mic_consumed_bytes: u64,
    pub virtual_mic_dropped_bytes: u64,
    pub virtual_mic_underrun_bytes: u64,
    pub virtual_mic_rejected_writes: u64,
    pub virtual_mic_session_active: bool,
    pub abi_version: Option<String>,
    pub ioctl_available: bool,
    pub last_driver_operation: Option<DriverOperationResult>,
    pub driver_detail: Option<String>,
}

impl Default for BridgeRuntimeSnapshot {
    fn default() -> Self {
        let runtime_root = default_runtime_root();
        let pipe_name = omni_bridge_protocol::DEFAULT_PIPE_NAME.to_string();

        Self {
            bridge_process_id: None,
            bridge_instance_id: None,
            process_status: "stopped".to_string(),
            install_channel: "development".to_string(),
            install_phase: "planned".to_string(),
            target_device_id: "virtual-mic-default".to_string(),
            virtual_render_device_id: "omni-virtual-speaker-default".to_string(),
            physical_playback_device_id: "speaker-default".to_string(),
            physical_playback_level: 100,
            mix_control: BridgeMixControl::default(),
            monitor_playback_enabled: true,
            translation_playback_enabled: true,
            virtual_mic_output_requested: false,
            expected_driver_version: "0.10.0-dev".to_string(),
            expected_bridge_version: "0.1.0".to_string(),
            bridge_state: "stopped".to_string(),
            lifecycle_state: "idle".to_string(),
            driver_health: "not-installed".to_string(),
            driver_version: None,
            bridge_version: "0.1.0".to_string(),
            source_capture_mode: SourceCaptureMode::None,
            capture_backend: CaptureBackend::None,
            process_loopback_supported: false,
            process_loopback_status: ProcessLoopbackStatus::Unknown,
            windows_build_number: None,
            process_loopback_minimum_windows_build: 20_348,
            excluded_process_id: None,
            process_loopback_failure_detail: None,
            capture_lifecycle_state: "idle".to_string(),
            capture_restart_count: 0,
            capture_packet_count: 0,
            capture_frames_received: 0,
            capture_peak: 0.0,
            capture_rms: 0.0,
            capture_silent_packet_count: 0,
            capture_invalid_sample_count: 0,
            resolved_physical_playback_device_id: String::new(),
            monitor_buffered_ms: 0,
            monitor_underrun_count: 0,
            monitor_overrun_count: 0,
            queued_frames: 0,
            source_frames_captured: 0,
            translated_frames_accepted: 0,
            translation_queue_end_timestamp_ms: 0,
            playback_frames_written: 0,
            underrun_count: 0,
            dropped_frame_count: 0,
            driver_buffered_bytes: 0,
            driver_max_buffered_bytes: 0,
            driver_captured_bytes: 0,
            driver_delivered_bytes: 0,
            driver_dropped_bytes: 0,
            source_pending_bytes: 0,
            source_pacer_queued_frames: 0,
            monitor_source_queued_frames: 0,
            stale_source_frames_dropped: 0,
            source_subscriber_active: false,
            source_generation: 0,
            source_generation_token: None,
            source_worker_phase: "idle".to_string(),
            source_worker_last_progress_timestamp_ms: None,
            source_read_calls: 0,
            source_zero_byte_reads: 0,
            source_monitor_playback_enabled: false,
            monitor_playback_state: "idle".to_string(),
            last_frame_timestamp_ms: None,
            last_error_code: Some("driver.not-installed".to_string()),
            recommended_action: Some("reinstall-driver".to_string()),
            pipe_path: omni_bridge_protocol::control_pipe_path(&pipe_name),
            audio_pipe_path: omni_bridge_protocol::audio_pipe_path(&pipe_name),
            source_pipe_path: omni_bridge_protocol::source_pipe_path(&pipe_name),
            pipe_name,
            runtime_root,
            session_id: None,
            last_handshake_at: None,
            rollback_supported: true,
            status: "warning".to_string(),
            driver_probe_state: "idle".to_string(),
            test_signing_enabled: false,
            signature_enforcement_bypassed: false,
            memory_integrity_enabled: false,
            secure_boot_enabled: None,
            secure_boot_probe_status: "idle".to_string(),
            root_device_count: 0,
            root_instance_ids: Vec::new(),
            endpoint_name: None,
            capture_endpoint_name: None,
            virtual_mic_output_supported: false,
            virtual_mic_output_status: "unknown".to_string(),
            virtual_mic_format: None,
            virtual_mic_frames_written: 0,
            virtual_mic_write_failures: 0,
            virtual_mic_last_generation: 0,
            virtual_mic_buffered_bytes: 0,
            virtual_mic_max_buffered_bytes: 0,
            virtual_mic_consumed_bytes: 0,
            virtual_mic_dropped_bytes: 0,
            virtual_mic_underrun_bytes: 0,
            virtual_mic_rejected_writes: 0,
            virtual_mic_session_active: false,
            abi_version: None,
            ioctl_available: false,
            last_driver_operation: None,
            driver_detail: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriverProbeResult {
    pub schema_version: u32,
    pub driver_health: String,
    pub error_code: Option<String>,
    pub test_signing_enabled: bool,
    pub signature_enforcement_bypassed: bool,
    pub memory_integrity_enabled: bool,
    pub secure_boot_enabled: Option<bool>,
    pub secure_boot_probe_status: String,
    pub root_device_count: usize,
    pub root_instance_ids: Vec<String>,
    pub endpoint_name: Option<String>,
    pub capture_endpoint_name: Option<String>,
    pub virtual_mic_output_supported: bool,
    #[ts(type = "'unknown' | 'probing' | 'ready' | 'unsupported' | 'failed'")]
    pub virtual_mic_output_status: String,
    pub virtual_mic_format: Option<String>,
    pub abi_version: Option<String>,
    pub ioctl_available: bool,
    pub installed_driver_version: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriverOperationResult {
    pub schema_version: u32,
    pub operation_id: String,
    pub action: String,
    pub succeeded: bool,
    pub phase: String,
    pub error_code: Option<String>,
    pub summary: String,
    pub log_path: String,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "legacy driver install-state schema is retained for upgrade compatibility")]
pub(crate) struct DriverInstallStateFile {
    pub protocol_version: String,
    pub install_channel: String,
    pub driver_version: String,
    pub bridge_version: String,
    pub driver_health: String,
    pub installed_at: String,
    pub target_device_id: String,
    #[serde(default)]
    pub virtual_render_device_id: String,
    #[serde(default)]
    pub driver_backend: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
pub(crate) enum DriverBridgeCommand {
    #[serde(rename = "bridge.init")]
    Init(BridgeInitRequest),
    #[serde(rename = "bridge.process-loopback.probe")]
    ProcessLoopbackProbe(BridgeProcessLoopbackProbeRequest),
    #[serde(rename = "bridge.state.query")]
    StateQuery(BridgeStateQuery),
    #[serde(rename = "bridge.frame.write")]
    WriteFrame(BridgeWriteFrameRequest),
    #[serde(rename = "bridge.shutdown")]
    Shutdown(BridgeShutdownRequest),
    #[serde(rename = "bridge.source.flush")]
    SourceFlush(BridgeSourceFlushRequest),
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
pub(crate) enum DriverBridgeEvent {
    #[serde(rename = "bridge.init.ack")]
    InitAck(BridgeInitResponse),
    #[serde(rename = "bridge.process-loopback.probe.ack")]
    ProcessLoopbackProbeAck(BridgeProcessLoopbackProbeResponse),
    #[serde(rename = "bridge.state.snapshot")]
    StateSnapshot(BridgeStateResponse),
    #[serde(rename = "bridge.frame.ack")]
    FrameAck(BridgeWriteFrameAck),
    #[serde(rename = "bridge.error")]
    Error(DriverBridgeErrorEvent),
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeInitRequest {
    pub request_id: String,
    #[ts(type = "'2026-08-10-audio-routing-v6'")]
    pub protocol_version: String,
    pub session_id: String,
    #[ts(type = "'development' | 'release'")]
    pub install_channel: String,
    pub target_device_id: String,
    pub virtual_render_device_id: String,
    pub physical_playback_device_id: String,
    pub physical_playback_level: u64,
    pub mix_control: BridgeMixControl,
    pub monitor_playback_enabled: bool,
    pub translation_playback_enabled: bool,
    pub virtual_mic_output_requested: bool,
    pub source_capture_mode: SourceCaptureMode,
    pub expected_driver_version: String,
    pub expected_bridge_version: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeInitResponse {
    pub request_id: String,
    #[ts(type = "'2026-08-10-audio-routing-v6'")]
    pub protocol_version: String,
    #[ts(type = "'stopped' | 'starting' | 'running' | 'degraded'")]
    pub bridge_state: String,
    #[serde(default)]
    #[ts(optional)]
    pub bridge_process_id: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub bridge_instance_id: Option<String>,
    #[serde(default)]
    pub source_generation: u64,
    #[serde(default)]
    #[ts(optional)]
    pub source_generation_token: Option<String>,
    #[ts(type = "'not-installed' | 'damaged' | 'version-mismatch' | 'running'")]
    pub driver_health: String,
    #[ts(optional)]
    pub active_driver_version: Option<String>,
    pub source_capture_mode: SourceCaptureMode,
    pub capture_backend: CaptureBackend,
    pub process_loopback_supported: bool,
    pub process_loopback_status: ProcessLoopbackStatus,
    #[ts(optional)]
    pub windows_build_number: Option<u32>,
    pub process_loopback_minimum_windows_build: u32,
    #[ts(optional)]
    pub process_loopback_failure_detail: Option<String>,
    #[serde(default)]
    pub virtual_mic_output_supported: bool,
    #[serde(default = "default_virtual_mic_output_status")]
    #[ts(type = "'unknown' | 'probing' | 'ready' | 'unsupported' | 'failed'")]
    pub virtual_mic_output_status: String,
    #[serde(default)]
    #[ts(optional)]
    pub capture_endpoint_name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub virtual_mic_format: Option<String>,
}

fn default_virtual_mic_output_status() -> String {
    "unknown".to_string()
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeProcessLoopbackProbeRequest {
    pub request_id: String,
    #[ts(type = "'2026-08-10-audio-routing-v6'")]
    pub protocol_version: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeProcessLoopbackProbeResponse {
    pub request_id: String,
    #[ts(type = "'2026-08-10-audio-routing-v6'")]
    pub protocol_version: String,
    pub process_loopback_supported: bool,
    pub process_loopback_status: ProcessLoopbackStatus,
    #[ts(optional)]
    pub windows_build_number: Option<u32>,
    pub process_loopback_minimum_windows_build: u32,
    #[ts(optional)]
    pub process_loopback_failure_detail: Option<String>,
    #[ts(optional)]
    #[ts(type = "'bridge.process-loopback-unsupported' | 'bridge.process-loopback-activation-failed'")]
    pub error_code: Option<String>,
    pub probe_process_id: u32,
    pub source_capture_mode: SourceCaptureMode,
    pub capture_backend: CaptureBackend,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeStateQuery {
    pub request_id: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeSourceFlushRequest {
    pub request_id: String,
}

const fn default_process_loopback_minimum_windows_build() -> u32 {
    20_348
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeStateResponse {
    pub request_id: String,
    #[ts(type = "'2026-08-10-audio-routing-v6'")]
    pub protocol_version: String,
    #[ts(type = "'stopped' | 'starting' | 'running' | 'degraded'")]
    pub bridge_state: String,
    #[serde(default)]
    #[ts(optional)]
    pub bridge_process_id: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub bridge_instance_id: Option<String>,
    #[ts(type = "'idle' | 'initializing' | 'ready' | 'writing' | 'draining' | 'stopped' | 'error'")]
    pub lifecycle_state: String,
    #[ts(type = "'not-installed' | 'damaged' | 'version-mismatch' | 'running'")]
    pub driver_health: String,
    #[ts(optional)]
    pub driver_version: Option<String>,
    pub bridge_version: String,
    #[serde(default)]
    pub source_capture_mode: SourceCaptureMode,
    #[serde(default)]
    pub capture_backend: CaptureBackend,
    #[serde(default)]
    pub process_loopback_supported: bool,
    #[serde(default)]
    pub process_loopback_status: ProcessLoopbackStatus,
    #[serde(default)]
    #[ts(optional)]
    pub windows_build_number: Option<u32>,
    #[serde(default = "default_process_loopback_minimum_windows_build")]
    pub process_loopback_minimum_windows_build: u32,
    #[serde(default)]
    #[ts(optional)]
    pub excluded_process_id: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub process_loopback_failure_detail: Option<String>,
    #[serde(default)]
    pub capture_lifecycle_state: String,
    #[serde(default)]
    pub capture_restart_count: u64,
    #[serde(default)]
    pub capture_packet_count: u64,
    #[serde(default)]
    pub capture_frames_received: u64,
    #[serde(default)]
    pub capture_peak: f32,
    #[serde(default)]
    pub capture_rms: f32,
    #[serde(default)]
    pub capture_silent_packet_count: u64,
    #[serde(default)]
    pub capture_invalid_sample_count: u64,
    #[serde(default)]
    pub resolved_physical_playback_device_id: String,
    #[serde(default)]
    pub monitor_buffered_ms: usize,
    #[serde(default)]
    pub monitor_underrun_count: u64,
    #[serde(default)]
    pub monitor_overrun_count: u64,
    pub queued_frames: usize,
    #[serde(default)]
    pub source_frames_captured: u64,
    #[serde(default)]
    pub translated_frames_accepted: u64,
    #[serde(default)]
    pub virtual_mic_frames_written: u64,
    #[serde(default)]
    pub virtual_mic_write_failures: u64,
    #[serde(default)]
    pub virtual_mic_last_generation: u64,
    #[serde(default)]
    pub virtual_mic_output_supported: bool,
    #[serde(default = "default_virtual_mic_output_status")]
    #[ts(type = "'unknown' | 'probing' | 'ready' | 'unsupported' | 'failed'")]
    pub virtual_mic_output_status: String,
    #[serde(default)]
    #[ts(optional)]
    pub capture_endpoint_name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub virtual_mic_format: Option<String>,
    #[serde(default)]
    pub virtual_mic_buffered_bytes: u64,
    #[serde(default)]
    pub virtual_mic_max_buffered_bytes: u64,
    #[serde(default)]
    pub virtual_mic_consumed_bytes: u64,
    #[serde(default)]
    pub virtual_mic_dropped_bytes: u64,
    #[serde(default)]
    pub virtual_mic_underrun_bytes: u64,
    #[serde(default)]
    pub virtual_mic_rejected_writes: u64,
    #[serde(default)]
    pub virtual_mic_session_active: bool,
    #[serde(default)]
    pub translation_queue_end_timestamp_ms: u64,
    #[serde(default)]
    pub playback_frames_written: u64,
    #[serde(default)]
    pub underrun_count: u64,
    #[serde(default)]
    pub dropped_frame_count: u64,
    #[serde(default)]
    pub driver_buffered_bytes: u64,
    #[serde(default)]
    pub driver_max_buffered_bytes: u64,
    #[serde(default)]
    pub driver_captured_bytes: u64,
    #[serde(default)]
    pub driver_delivered_bytes: u64,
    #[serde(default)]
    pub driver_dropped_bytes: u64,
    #[serde(default)]
    pub source_pending_bytes: usize,
    #[serde(default)]
    pub source_pacer_queued_frames: usize,
    #[serde(default)]
    pub monitor_source_queued_frames: usize,
    #[serde(default)]
    pub stale_source_frames_dropped: u64,
    #[serde(default)]
    pub source_subscriber_active: bool,
    #[serde(default)]
    pub source_generation: u64,
    #[serde(default)]
    #[ts(optional)]
    pub source_generation_token: Option<String>,
    #[serde(default)]
    pub source_worker_phase: String,
    #[serde(default)]
    #[ts(optional)]
    pub source_worker_last_progress_timestamp_ms: Option<u64>,
    #[serde(default)]
    pub source_read_calls: u64,
    #[serde(default)]
    pub source_zero_byte_reads: u64,
    #[serde(default)]
    pub source_monitor_playback_enabled: bool,
    #[serde(default)]
    pub translation_playback_enabled: bool,
    #[serde(default)]
    pub monitor_playback_state: String,
    #[ts(optional)]
    pub last_frame_timestamp_ms: Option<u64>,
    #[ts(optional)]
    #[ts(type = "'driver.not-installed' | 'driver.version-mismatch' | 'driver.write-failed' | 'driver.testsigning-disabled' | 'driver.secure-boot-enabled' | 'driver.memory-integrity-enabled' | 'driver.reboot-required' | 'driver.audio-probe-failed' | 'driver.duplicate-root-devices' | 'driver.endpoint-missing' | 'driver.ioctl-unavailable' | 'driver.abi-mismatch' | 'driver.elevation-cancelled' | 'driver.probe-failed' | 'driver.operation-failed' | 'bridge.not-ready' | 'bridge.queue-overflow' | 'bridge.permission-denied' | 'bridge.timeout' | 'bridge.session-mismatch' | 'bridge.singleton-already-running' | 'bridge.process-loopback-unsupported' | 'bridge.process-loopback-activation-failed' | 'bridge.process-loopback-capture-failed' | 'bridge.playback-ownership-barrier-failed' | 'bridge.translation-output-bypass' | 'bridge.translation-playback-failed' | 'bridge.virtual-mic-output-unavailable' | 'bridge.virtual-mic-driver-unavailable' | 'bridge.virtual-mic-format-unsupported' | 'bridge.virtual-mic-session-failed' | 'bridge.virtual-mic-write-failed' | 'monitor.virtual-playback-loop' | 'installer.rollback-triggered'")]
    pub last_error_code: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeAudioFrame {
    pub frame_id: String,
    pub stream_id: String,
    #[ts(type = "'pcm16le'")]
    pub encoding: String,
    #[ts(type = "'mono' | 'stereo'")]
    pub channel_layout: String,
    #[ts(type = "16000 | 24000 | 48000")]
    pub sample_rate_hz: u32,
    #[ts(type = "1 | 2")]
    pub channel_count: u16,
    pub frame_count: usize,
    pub timestamp_ms: u64,
    pub payload_ref: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeWriteFrameRequest {
    pub request_id: String,
    pub session_id: String,
    pub frame: BridgeAudioFrame,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeWriteFrameAck {
    pub request_id: String,
    pub frame_id: String,
    pub accepted_at: String,
    pub queue_depth: usize,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeShutdownRequest {
    pub request_id: String,
    pub session_id: String,
    #[ts(type = "'session-ended' | 'installer-rollback' | 'manual-stop'")]
    pub reason: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriverBridgeErrorEvent {
    #[ts(optional)]
    pub request_id: Option<String>,
    #[ts(type = "'driver.not-installed' | 'driver.version-mismatch' | 'driver.write-failed' | 'driver.testsigning-disabled' | 'driver.secure-boot-enabled' | 'driver.memory-integrity-enabled' | 'driver.reboot-required' | 'driver.audio-probe-failed' | 'driver.duplicate-root-devices' | 'driver.endpoint-missing' | 'driver.ioctl-unavailable' | 'driver.abi-mismatch' | 'driver.elevation-cancelled' | 'driver.probe-failed' | 'driver.operation-failed' | 'bridge.not-ready' | 'bridge.queue-overflow' | 'bridge.permission-denied' | 'bridge.timeout' | 'bridge.session-mismatch' | 'bridge.singleton-already-running' | 'bridge.process-loopback-unsupported' | 'bridge.process-loopback-activation-failed' | 'bridge.process-loopback-capture-failed' | 'bridge.playback-ownership-barrier-failed' | 'bridge.translation-output-bypass' | 'bridge.translation-playback-failed' | 'bridge.virtual-mic-output-unavailable' | 'bridge.virtual-mic-driver-unavailable' | 'bridge.virtual-mic-format-unsupported' | 'bridge.virtual-mic-session-failed' | 'bridge.virtual-mic-write-failed' | 'monitor.virtual-playback-loop' | 'installer.rollback-triggered'")]
    pub code: String,
    pub message: String,
    pub retriable: bool,
    #[ts(type = "'stopped' | 'starting' | 'running' | 'degraded'")]
    pub bridge_state: String,
    #[ts(type = "'not-installed' | 'damaged' | 'version-mismatch' | 'running'")]
    pub driver_health: String,
    #[serde(default)]
    pub source_capture_mode: SourceCaptureMode,
    #[serde(default)]
    pub capture_backend: CaptureBackend,
    #[serde(default)]
    pub process_loopback_supported: bool,
    #[serde(default)]
    pub process_loopback_status: ProcessLoopbackStatus,
    #[serde(default)]
    #[ts(optional)]
    pub windows_build_number: Option<u32>,
    #[serde(default = "default_process_loopback_minimum_windows_build")]
    pub process_loopback_minimum_windows_build: u32,
    #[serde(default)]
    #[ts(optional)]
    pub process_loopback_failure_detail: Option<String>,
    #[ts(optional)]
    #[ts(type = "'reinstall-driver' | 'restart-bridge' | 'rollback-driver' | 'open-diagnostics'")]
    pub suggested_action: Option<String>,
}

/// Bridge runtime state (pid files, elevated operation results) lives under
/// the diagnostics root, so installed builds write to `%LOCALAPPDATA%` while
/// dev builds keep using the workspace `artifacts/diagnostics/logs` tree.
pub(crate) fn default_runtime_root() -> String {
    std::path::Path::new(&crate::diagnostics::state::default_diagnostics_root())
        .join("logs")
        .to_string_lossy()
        .to_string()
}

fn has_installed_driver_evidence(snapshot: &BridgeRuntimeSnapshot) -> bool {
    snapshot.root_device_count > 0
        || snapshot.endpoint_name.is_some()
        || snapshot.abi_version.is_some()
        || snapshot.ioctl_available
}

pub(crate) fn reconcile_bridge_snapshot(snapshot: &mut BridgeRuntimeSnapshot) {
    let bridge_ok = snapshot.bridge_state == "running";
    let driver_ok = snapshot.driver_health == "running";
    let capture_route_ok = match snapshot.source_capture_mode {
        SourceCaptureMode::VirtualDriver => driver_ok,
        SourceCaptureMode::ProcessExclusion => {
            snapshot.process_loopback_supported
                && snapshot.process_loopback_status == ProcessLoopbackStatus::Ready
        }
        SourceCaptureMode::None => true,
    };
    let driver_present = driver_ok || has_installed_driver_evidence(snapshot);
    let restart_required = snapshot
        .last_error_code
        .as_deref()
        .map(|code| {
            code == "bridge.singleton-already-running"
                || code == "bridge.session-mismatch"
                || code.starts_with("bridge.stale-")
        })
        .unwrap_or(false);

    snapshot.status = if bridge_ok && capture_route_ok && !restart_required {
        "ready".to_string()
    } else if snapshot.source_capture_mode == SourceCaptureMode::ProcessExclusion
        && snapshot.process_loopback_status == ProcessLoopbackStatus::Unsupported
    {
        "unsupported".to_string()
    } else {
        "warning".to_string()
    };

    snapshot.recommended_action = if restart_required {
        Some("restart-bridge".to_string())
    } else if snapshot.source_capture_mode == SourceCaptureMode::ProcessExclusion
        && (!snapshot.process_loopback_supported
            || snapshot.process_loopback_status == ProcessLoopbackStatus::Unsupported)
    {
        Some("open-diagnostics".to_string())
    } else if !bridge_ok {
        if snapshot.source_capture_mode == SourceCaptureMode::VirtualDriver
            && snapshot.driver_health == "not-installed"
            && !driver_present
        {
            Some("reinstall-driver".to_string())
        } else if snapshot.source_capture_mode == SourceCaptureMode::VirtualDriver
            && snapshot.driver_health == "version-mismatch"
        {
            Some("rollback-driver".to_string())
        } else {
            Some("restart-bridge".to_string())
        }
    } else {
        Some("open-diagnostics".to_string())
    };
}

#[cfg(test)]
mod tests {
    use super::{
        reconcile_bridge_snapshot, BridgeProcessLoopbackProbeRequest, BridgeRuntimeSnapshot,
        DriverBridgeCommand, DriverBridgeEvent,
    };

    #[test]
    fn process_loopback_probe_wire_contract_is_typed() {
        let command = DriverBridgeCommand::ProcessLoopbackProbe(
            BridgeProcessLoopbackProbeRequest {
                request_id: "probe-request".to_string(),
                protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
            },
        );
        let encoded = serde_json::to_value(command).expect("probe command must serialize");
        assert_eq!(encoded["type"], "bridge.process-loopback.probe");
        assert_eq!(encoded["requestId"], "probe-request");
        assert_eq!(
            encoded["protocolVersion"],
            omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION
        );

        let event: DriverBridgeEvent = serde_json::from_value(serde_json::json!({
            "type": "bridge.process-loopback.probe.ack",
            "requestId": "probe-request",
            "protocolVersion": omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION,
            "processLoopbackSupported": true,
            "processLoopbackStatus": "ready",
            "windowsBuildNumber": 26100,
            "processLoopbackMinimumWindowsBuild": 20348,
            "processLoopbackFailureDetail": null,
            "errorCode": null,
            "probeProcessId": 4242,
            "sourceCaptureMode": "none",
            "captureBackend": "none"
        }))
        .expect("probe ack must deserialize through the tagged event union");

        let DriverBridgeEvent::ProcessLoopbackProbeAck(ack) = event else {
            panic!("probe ack deserialized into the wrong event variant");
        };
        assert_eq!(ack.request_id, "probe-request");
        assert_eq!(ack.probe_process_id, 4242);
        assert!(ack.process_loopback_supported);
    }

    #[test]
    fn reconcile_maps_bridge_recovery_errors_to_restart_action() {
        for error_code in [
            "bridge.singleton-already-running",
            "bridge.session-mismatch",
            "bridge.stale-process-path-mismatch",
        ] {
            let mut snapshot = BridgeRuntimeSnapshot {
                bridge_state: "running".to_string(),
                driver_health: "running".to_string(),
                last_error_code: Some(error_code.to_string()),
                ..Default::default()
            };

            reconcile_bridge_snapshot(&mut snapshot);

            assert_eq!(snapshot.status, "warning");
            assert_eq!(
                snapshot.recommended_action.as_deref(),
                Some("restart-bridge")
            );
        }
    }

    #[test]
    fn reconcile_keeps_a_clean_running_bridge_ready() {
        let mut snapshot = BridgeRuntimeSnapshot {
            bridge_state: "running".to_string(),
            driver_health: "running".to_string(),
            ..Default::default()
        };

        reconcile_bridge_snapshot(&mut snapshot);

        assert_eq!(snapshot.status, "ready");
        assert_eq!(
            snapshot.recommended_action.as_deref(),
            Some("open-diagnostics")
        );
    }

    #[test]
    fn reconcile_prefers_bridge_restart_when_driver_probe_evidence_exists() {
        let mut snapshot = BridgeRuntimeSnapshot {
            bridge_state: "degraded".to_string(),
            driver_health: "not-installed".to_string(),
            last_error_code: Some("driver.not-installed".to_string()),
            root_device_count: 1,
            root_instance_ids: vec!["ROOT\\MEDIA\\0000".to_string()],
            endpoint_name: Some("Speakers (Omni Translate Virtual Speaker)".to_string()),
            abi_version: Some("0x20260810".to_string()),
            ioctl_available: true,
            ..Default::default()
        };

        reconcile_bridge_snapshot(&mut snapshot);

        assert_eq!(snapshot.status, "warning");
        assert_eq!(
            snapshot.recommended_action.as_deref(),
            Some("restart-bridge")
        );
    }
}
