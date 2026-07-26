use serde::{Deserialize, Serialize};

pub use omni_bridge_protocol::{
    AudioFrameAck as BridgeTranslationFrameAck, AudioFrameHeader as BridgeTranslationFrameHeader,
    MixControl as BridgeMixControl,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRuntimeSnapshot {
    pub process_status: String,
    pub install_channel: String,
    pub install_phase: String,
    pub target_device_id: String,
    pub virtual_render_device_id: String,
    pub physical_playback_device_id: String,
    pub physical_playback_level: u64,
    pub mix_control: BridgeMixControl,
    pub monitor_playback_enabled: bool,
    pub expected_driver_version: String,
    pub expected_bridge_version: String,
    pub bridge_state: String,
    pub lifecycle_state: String,
    pub driver_health: String,
    pub driver_version: Option<String>,
    pub bridge_version: String,
    pub capture_backend: String,
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
    pub source_worker_phase: String,
    pub source_worker_last_progress_timestamp_ms: Option<u64>,
    pub source_read_calls: u64,
    pub source_zero_byte_reads: u64,
    pub monitor_playback_state: String,
    pub last_frame_timestamp_ms: Option<u64>,
    pub last_error_code: Option<String>,
    pub recommended_action: Option<String>,
    pub pipe_name: String,
    pub pipe_path: String,
    pub audio_pipe_path: String,
    pub source_pipe_path: String,
    pub runtime_root: String,
    pub session_id: Option<String>,
    pub last_handshake_at: Option<String>,
    pub rollback_supported: bool,
    pub status: String,
    pub driver_probe_state: String,
    pub test_signing_enabled: bool,
    pub signature_enforcement_bypassed: bool,
    pub memory_integrity_enabled: bool,
    pub secure_boot_enabled: Option<bool>,
    pub secure_boot_probe_status: String,
    pub root_device_count: usize,
    pub root_instance_ids: Vec<String>,
    pub endpoint_name: Option<String>,
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
            process_status: "stopped".to_string(),
            install_channel: "development".to_string(),
            install_phase: "planned".to_string(),
            target_device_id: "virtual-mic-default".to_string(),
            virtual_render_device_id: "omni-virtual-speaker-default".to_string(),
            physical_playback_device_id: "speaker-default".to_string(),
            physical_playback_level: 100,
            mix_control: BridgeMixControl::default(),
            monitor_playback_enabled: true,
            expected_driver_version: "0.10.0-dev".to_string(),
            expected_bridge_version: "0.1.0".to_string(),
            bridge_state: "stopped".to_string(),
            lifecycle_state: "idle".to_string(),
            driver_health: "not-installed".to_string(),
            driver_version: None,
            bridge_version: "0.1.0".to_string(),
            capture_backend: "wasapi-endpoint-loopback".to_string(),
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
            source_worker_phase: "idle".to_string(),
            source_worker_last_progress_timestamp_ms: None,
            source_read_calls: 0,
            source_zero_byte_reads: 0,
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
            abi_version: None,
            ioctl_available: false,
            last_driver_operation: None,
            driver_detail: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverProbeResult {
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
    pub abi_version: Option<String>,
    pub ioctl_available: bool,
    pub installed_driver_version: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverOperationResult {
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "legacy driver install-state schema is retained for upgrade compatibility")]
pub struct DriverInstallStateFile {
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DriverBridgeCommand {
    #[serde(rename = "bridge.init")]
    Init(BridgeInitRequest),
    #[serde(rename = "bridge.state.query")]
    StateQuery(BridgeStateQuery),
    #[serde(rename = "bridge.frame.write")]
    WriteFrame(BridgeWriteFrameRequest),
    #[serde(rename = "bridge.shutdown")]
    Shutdown(BridgeShutdownRequest),
    #[serde(rename = "bridge.source.flush")]
    SourceFlush(BridgeSourceFlushRequest),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DriverBridgeEvent {
    #[serde(rename = "bridge.init.ack")]
    InitAck(BridgeInitResponse),
    #[serde(rename = "bridge.state.snapshot")]
    StateSnapshot(BridgeStateResponse),
    #[serde(rename = "bridge.frame.ack")]
    FrameAck(BridgeWriteFrameAck),
    #[serde(rename = "bridge.error")]
    Error(DriverBridgeErrorEvent),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInitRequest {
    pub request_id: String,
    pub protocol_version: String,
    pub session_id: String,
    pub install_channel: String,
    pub target_device_id: String,
    pub virtual_render_device_id: String,
    pub physical_playback_device_id: String,
    pub physical_playback_level: u64,
    pub mix_control: BridgeMixControl,
    pub monitor_playback_enabled: bool,
    pub expected_driver_version: String,
    pub expected_bridge_version: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInitResponse {
    pub request_id: String,
    pub protocol_version: String,
    pub bridge_state: String,
    pub driver_health: String,
    pub active_driver_version: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStateQuery {
    pub request_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSourceFlushRequest {
    pub request_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStateResponse {
    pub request_id: String,
    pub protocol_version: String,
    pub bridge_state: String,
    pub lifecycle_state: String,
    pub driver_health: String,
    pub driver_version: Option<String>,
    pub bridge_version: String,
    #[serde(default)]
    pub capture_backend: String,
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
    pub source_worker_phase: String,
    #[serde(default)]
    pub source_worker_last_progress_timestamp_ms: Option<u64>,
    #[serde(default)]
    pub source_read_calls: u64,
    #[serde(default)]
    pub source_zero_byte_reads: u64,
    #[serde(default)]
    pub monitor_playback_state: String,
    pub last_frame_timestamp_ms: Option<u64>,
    pub last_error_code: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAudioFrame {
    pub frame_id: String,
    pub stream_id: String,
    pub encoding: String,
    pub channel_layout: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub frame_count: usize,
    pub timestamp_ms: u64,
    pub payload_ref: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeWriteFrameRequest {
    pub request_id: String,
    pub session_id: String,
    pub frame: BridgeAudioFrame,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeWriteFrameAck {
    pub request_id: String,
    pub frame_id: String,
    pub accepted_at: String,
    pub queue_depth: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeShutdownRequest {
    pub request_id: String,
    pub session_id: String,
    pub reason: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverBridgeErrorEvent {
    pub request_id: Option<String>,
    pub code: String,
    pub message: String,
    pub retriable: bool,
    pub bridge_state: String,
    pub driver_health: String,
    pub suggested_action: Option<String>,
}

pub fn default_runtime_root() -> String {
    super::ipc::workspace_root()
        .join("artifacts")
        .join("diagnostics")
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

pub fn reconcile_bridge_snapshot(snapshot: &mut BridgeRuntimeSnapshot) {
    let bridge_ok = snapshot.bridge_state == "running";
    let driver_ok = snapshot.driver_health == "running";
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

    snapshot.status = if bridge_ok && driver_ok && !restart_required {
        "ready".to_string()
    } else {
        "warning".to_string()
    };

    snapshot.recommended_action = if restart_required {
        Some("restart-bridge".to_string())
    } else if !bridge_ok {
        if snapshot.driver_health == "not-installed" && !driver_present {
            Some("reinstall-driver".to_string())
        } else if snapshot.driver_health == "version-mismatch" {
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
    use super::{reconcile_bridge_snapshot, BridgeRuntimeSnapshot};

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
            abi_version: Some("0x20260604".to_string()),
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
