use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

use crate::{log_error, log_info};
use crate::runtime::events::emit_runtime_snapshot;

use super::contracts::{
    reconcile_bridge_snapshot, AudioRouteDirection, AudioSampleFormat, BridgeInitRequest,
    BridgeProcessLoopbackProbeRequest, BridgeProcessLoopbackProbeResponse, BridgeRuntimeSnapshot,
    BridgeShutdownRequest, BridgeSourceFlushRequest, BridgeStateQuery, BridgeStateResponse,
    BridgeTranslationFrameAck, BridgeTranslationFrameHeader, DriverBridgeCommand,
    DriverBridgeErrorEvent, DriverBridgeEvent, TranslationAudioSink,
    TranslationStreamState,
};
use super::state::BridgeStateStore;

const BRIDGE_CONNECT_RETRIES: usize = 40;
const BRIDGE_CONNECT_DELAY_MS: u64 = 100;
const IPC_READ_TIMEOUT_SECS: u64 = 5;

pub(crate) use super::clients::BridgeIpcClient;
pub(crate) use super::clients::{BridgeAudioWriter, BridgeProcessSupervisor};

include!("ipc/process.rs");

include!("ipc/transport.rs");

pub(crate) struct BridgeInitializationFailure {
    snapshot: BridgeRuntimeSnapshot,
    message: String,
}

impl BridgeInitializationFailure {
    pub(crate) fn into_parts(self) -> (BridgeRuntimeSnapshot, String) {
        (self.snapshot, self.message)
    }

    fn transport(snapshot: &BridgeRuntimeSnapshot, message: String) -> Self {
        Self {
            snapshot: snapshot.clone(),
            message,
        }
    }
}

fn apply_initialize_error(
    snapshot: &BridgeRuntimeSnapshot,
    error: DriverBridgeErrorEvent,
) -> BridgeInitializationFailure {
    let mut failed = snapshot.clone();
    failed.process_status = "running".to_string();
    failed.bridge_state = error.bridge_state;
    failed.lifecycle_state = "error".to_string();
    failed.install_phase = "ready".to_string();
    failed.driver_health = error.driver_health;
    failed.source_capture_mode = error.source_capture_mode;
    failed.capture_backend = error.capture_backend;
    failed.process_loopback_supported = error.process_loopback_supported;
    failed.process_loopback_status = error.process_loopback_status;
    failed.windows_build_number = error.windows_build_number;
    failed.process_loopback_minimum_windows_build =
        error.process_loopback_minimum_windows_build;
    failed.process_loopback_failure_detail = error
        .process_loopback_failure_detail
        .or_else(|| Some(error.message.clone()));
    failed.last_error_code = Some(error.code.clone());
    failed.last_handshake_at = Some(crate::shared::time::now_unix_seconds_marker());
    reconcile_bridge_snapshot(&mut failed);
    BridgeInitializationFailure {
        snapshot: failed,
        message: format!("{}: {}", error.code, error.message),
    }
}

pub(crate) fn initialize_bridge(
    snapshot: &BridgeRuntimeSnapshot,
) -> Result<BridgeRuntimeSnapshot, BridgeInitializationFailure> {
    let session_id = snapshot
        .session_id
        .clone()
        .unwrap_or_else(super::new_bridge_session_id);
    let event = write_command(
        &snapshot.pipe_path,
        &DriverBridgeCommand::Init(BridgeInitRequest {
            request_id: format!("bridge-init-{}", now_unix_ms()),
            protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
            session_id: session_id.clone(),
            install_channel: snapshot.install_channel.clone(),
            target_device_id: snapshot.target_device_id.clone(),
            virtual_render_device_id: snapshot.virtual_render_device_id.clone(),
            physical_playback_device_id: snapshot.physical_playback_device_id.clone(),
            previous_playback_owner_generation: snapshot.playback_owner_generation,
            physical_playback_level: snapshot.physical_playback_level,
            mix_control: snapshot.mix_control.clone(),
            monitor_playback_enabled: snapshot.monitor_playback_enabled,
            translation_playback_enabled: snapshot.translation_playback_enabled,
            virtual_mic_output_requested: snapshot.virtual_mic_output_requested,
            source_capture_mode: snapshot.source_capture_mode,
            expected_driver_version: snapshot.expected_driver_version.clone(),
            expected_bridge_version: snapshot.expected_bridge_version.clone(),
        }),
    )
    .map_err(|message| BridgeInitializationFailure::transport(snapshot, message))?;

    let mut next = snapshot.clone();
    match event {
        DriverBridgeEvent::InitAck(ack) => {
            next.session_id = Some(session_id);
            next.bridge_state = ack.bridge_state;
            next.bridge_process_id = ack.bridge_process_id;
            next.bridge_instance_id = ack.bridge_instance_id;
            next.source_generation = ack.source_generation;
            next.source_generation_token = ack.source_generation_token;
            next.driver_health = ack.driver_health;
            next.driver_version = ack.active_driver_version;
            next.source_capture_mode = ack.source_capture_mode;
            next.capture_backend = ack.capture_backend;
            next.process_loopback_supported = ack.process_loopback_supported;
            next.process_loopback_status = ack.process_loopback_status;
            next.windows_build_number = ack.windows_build_number;
            next.process_loopback_minimum_windows_build =
                ack.process_loopback_minimum_windows_build;
            next.process_loopback_failure_detail = ack.process_loopback_failure_detail;
            next.physical_playback_status = ack.physical_playback_status;
            next.resolved_physical_playback_device_id =
                ack.resolved_physical_playback_device_id;
            next.playback_owner_generation = ack.playback_owner_generation;
            if ack.virtual_mic_output_status != "unknown" {
                next.virtual_mic_output_supported = ack.virtual_mic_output_supported;
                next.virtual_mic_output_status = ack.virtual_mic_output_status;
                next.capture_endpoint_name = ack.capture_endpoint_name;
                next.virtual_mic_format = ack.virtual_mic_format;
            }
            next.lifecycle_state = if next.bridge_state == "running" {
                "ready".to_string()
            } else {
                "error".to_string()
            };
            next.process_status = if next.bridge_state == "running" {
                "running".to_string()
            } else {
                "error".to_string()
            };
            next.install_phase = if next.bridge_state == "running" {
                "ready".to_string()
            } else {
                "rollback-required".to_string()
            };
            next.last_handshake_at = Some(crate::shared::time::now_unix_seconds_marker());
            if next.source_capture_mode == super::contracts::SourceCaptureMode::ProcessExclusion
                && next.process_loopback_status
                    == super::contracts::ProcessLoopbackStatus::Ready
            {
                next.last_error_code = None;
            } else if next.driver_health == "not-installed" {
                next.last_error_code = Some("driver.not-installed".to_string());
            } else if next.driver_health == "version-mismatch" {
                next.last_error_code = Some("driver.version-mismatch".to_string());
            } else {
                next.last_error_code = None;
            }
            reconcile_bridge_snapshot(&mut next);
            Ok(next)
        }
        DriverBridgeEvent::Error(error) => Err(apply_initialize_error(snapshot, error)),
        _ => Err(BridgeInitializationFailure::transport(
            snapshot,
            "Bridge Service 初始化响应无效。".to_string(),
        )),
    }
}

pub(crate) fn apply_query(snapshot: &mut BridgeRuntimeSnapshot, query: BridgeStateResponse) {
    snapshot.bridge_state = query.bridge_state;
    snapshot.bridge_process_id = query.bridge_process_id;
    snapshot.bridge_instance_id = query.bridge_instance_id;
    snapshot.lifecycle_state = query.lifecycle_state;
    snapshot.driver_health = query.driver_health;
    snapshot.driver_version = query.driver_version;
    snapshot.bridge_version = query.bridge_version;
    snapshot.source_capture_mode = query.source_capture_mode;
    snapshot.capture_backend = query.capture_backend;
    snapshot.process_loopback_supported = query.process_loopback_supported;
    snapshot.process_loopback_status = query.process_loopback_status;
    snapshot.windows_build_number = query.windows_build_number;
    snapshot.process_loopback_minimum_windows_build =
        query.process_loopback_minimum_windows_build;
    snapshot.excluded_process_id = query.excluded_process_id;
    snapshot.process_loopback_failure_detail = query.process_loopback_failure_detail;
    snapshot.capture_lifecycle_state = query.capture_lifecycle_state;
    snapshot.capture_restart_count = query.capture_restart_count;
    snapshot.capture_packet_count = query.capture_packet_count;
    snapshot.capture_frames_received = query.capture_frames_received;
    snapshot.capture_peak = query.capture_peak;
    snapshot.capture_rms = query.capture_rms;
    snapshot.capture_silent_packet_count = query.capture_silent_packet_count;
    snapshot.capture_invalid_sample_count = query.capture_invalid_sample_count;
    snapshot.resolved_physical_playback_device_id = query.resolved_physical_playback_device_id;
    snapshot.physical_playback_status = query.physical_playback_status;
    snapshot.playback_owner_generation = query.playback_owner_generation;
    snapshot.monitor_buffered_ms = query.monitor_buffered_ms;
    snapshot.monitor_underrun_count = query.monitor_underrun_count;
    snapshot.monitor_overrun_count = query.monitor_overrun_count;
    snapshot.queued_frames = query.queued_frames;
    snapshot.last_frame_timestamp_ms = query.last_frame_timestamp_ms;
    snapshot.source_frames_captured = query.source_frames_captured;
    snapshot.translated_frames_accepted = query.translated_frames_accepted;
    snapshot.virtual_mic_frames_written = query.virtual_mic_frames_written;
    snapshot.virtual_mic_write_failures = query.virtual_mic_write_failures;
    snapshot.virtual_mic_last_generation = query.virtual_mic_last_generation;
    if query.virtual_mic_output_status != "unknown" {
        snapshot.virtual_mic_output_supported = query.virtual_mic_output_supported;
        snapshot.virtual_mic_output_status = query.virtual_mic_output_status;
        snapshot.capture_endpoint_name = query.capture_endpoint_name;
        snapshot.virtual_mic_format = query.virtual_mic_format;
    }
    snapshot.virtual_mic_buffered_bytes = query.virtual_mic_buffered_bytes;
    snapshot.virtual_mic_max_buffered_bytes = query.virtual_mic_max_buffered_bytes;
    snapshot.virtual_mic_consumed_bytes = query.virtual_mic_consumed_bytes;
    snapshot.virtual_mic_dropped_bytes = query.virtual_mic_dropped_bytes;
    snapshot.virtual_mic_underrun_bytes = query.virtual_mic_underrun_bytes;
    snapshot.virtual_mic_rejected_writes = query.virtual_mic_rejected_writes;
    snapshot.virtual_mic_session_active = query.virtual_mic_session_active;
    snapshot.translation_queue_end_timestamp_ms = query.translation_queue_end_timestamp_ms;
    snapshot.playback_frames_written = query.playback_frames_written;
    snapshot.underrun_count = query.underrun_count;
    snapshot.dropped_frame_count = query.dropped_frame_count;
    snapshot.driver_buffered_bytes = query.driver_buffered_bytes;
    snapshot.driver_max_buffered_bytes = query.driver_max_buffered_bytes;
    snapshot.driver_captured_bytes = query.driver_captured_bytes;
    snapshot.driver_delivered_bytes = query.driver_delivered_bytes;
    snapshot.driver_dropped_bytes = query.driver_dropped_bytes;
    snapshot.source_pending_bytes = query.source_pending_bytes;
    snapshot.source_pacer_queued_frames = query.source_pacer_queued_frames;
    snapshot.monitor_source_queued_frames = query.monitor_source_queued_frames;
    snapshot.stale_source_frames_dropped = query.stale_source_frames_dropped;
    snapshot.source_subscriber_active = query.source_subscriber_active;
    snapshot.source_generation = query.source_generation;
    snapshot.source_generation_token = query.source_generation_token;
    snapshot.source_worker_phase = query.source_worker_phase;
    snapshot.source_worker_last_progress_timestamp_ms =
        query.source_worker_last_progress_timestamp_ms;
    snapshot.source_read_calls = query.source_read_calls;
    snapshot.source_zero_byte_reads = query.source_zero_byte_reads;
    snapshot.source_monitor_playback_enabled = query.source_monitor_playback_enabled;
    snapshot.translation_playback_enabled = query.translation_playback_enabled;
    snapshot.monitor_playback_state = query.monitor_playback_state;
    snapshot.last_error_code = query.last_error_code;
    snapshot.process_status = if matches!(snapshot.bridge_state.as_str(), "running" | "degraded") {
        "running".to_string()
    } else {
        "stopped".to_string()
    };
    snapshot.install_phase = if snapshot.bridge_state == "running" {
        "ready".to_string()
    } else if snapshot.driver_health == "not-installed" {
        "planned".to_string()
    } else {
        "rollback-required".to_string()
    };
    reconcile_bridge_snapshot(snapshot);
}

pub(crate) fn apply_process_loopback_probe(
    snapshot: &mut BridgeRuntimeSnapshot,
    probe: BridgeProcessLoopbackProbeResponse,
) {
    snapshot.process_loopback_supported = probe.process_loopback_supported;
    snapshot.process_loopback_status = probe.process_loopback_status;
    snapshot.windows_build_number = probe.windows_build_number;
    snapshot.process_loopback_minimum_windows_build =
        probe.process_loopback_minimum_windows_build;
    snapshot.process_loopback_failure_detail = probe.process_loopback_failure_detail;
    snapshot.source_capture_mode = probe.source_capture_mode;
    snapshot.capture_backend = probe.capture_backend;
    if let Some(error_code) = probe.error_code {
        snapshot.last_error_code = Some(error_code);
    } else if snapshot
        .last_error_code
        .as_deref()
        .is_some_and(|code| code.starts_with("bridge.process-loopback-"))
    {
        snapshot.last_error_code = None;
    }
    reconcile_bridge_snapshot(snapshot);
}

/// A framed source-pipe error is emitted only after the native Bridge has
/// atomically failed the process-loopback generation and stopped translation
/// playback. Mirror that authoritative failure into the Desktop cache before
/// the audio/runtime snapshots are emitted; otherwise a retry can incorrectly
/// reuse a cached `ready` capability and reconnect to the dead generation.
pub(crate) fn mark_process_loopback_capture_failed(
    snapshot: &mut BridgeRuntimeSnapshot,
    detail: String,
) {
    snapshot.process_status = "running".to_string();
    snapshot.bridge_state = "degraded".to_string();
    snapshot.lifecycle_state = "error".to_string();
    snapshot.process_loopback_status = super::contracts::ProcessLoopbackStatus::Failed;
    snapshot.process_loopback_failure_detail = Some(detail);
    snapshot.capture_lifecycle_state = "failed".to_string();
    snapshot.source_subscriber_active = false;
    snapshot.source_worker_phase = "process-loopback-failed".to_string();
    snapshot.last_error_code = Some("bridge.process-loopback-capture-failed".to_string());
    reconcile_bridge_snapshot(snapshot);
}

#[allow(dead_code, reason = "legacy driver install-state loader is retained for upgrade compatibility")]
pub(crate) fn load_install_state(snapshot: &mut BridgeRuntimeSnapshot) -> Result<(), String> {
    let path = driver_state_path(&snapshot.runtime_root);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            log::warn!(
                "[omni][bridge-ipc] driver install state not found path={}",
                path.display()
            );
            snapshot.driver_health = "not-installed".to_string();
            snapshot.bridge_state = "stopped".to_string();
            snapshot.lifecycle_state = "idle".to_string();
            snapshot.driver_version = None;
            snapshot.last_error_code = Some("driver.not-installed".to_string());
            snapshot.install_phase = "planned".to_string();
            snapshot.process_status = "stopped".to_string();
            reconcile_bridge_snapshot(snapshot);
            return Ok(());
        }
        Err(error) => {
            log::error!(
                "[omni][bridge-ipc] failed to read driver install state path={} err={}",
                path.display(),
                error
            );
            return Err(error.to_string());
        }
    };

    let contents = contents.strip_prefix('\u{feff}').unwrap_or(&contents);

    let install_state: super::contracts::DriverInstallStateFile =
        serde_json::from_str(contents).map_err(|error| error.to_string())?;
    snapshot.install_channel = install_state.install_channel;
    snapshot.driver_version = Some(install_state.driver_version.clone());
    snapshot.bridge_version = install_state.bridge_version;
    snapshot.driver_health = install_state.driver_health;
    snapshot.target_device_id = install_state.target_device_id;
    if !install_state.virtual_render_device_id.is_empty() {
        snapshot.virtual_render_device_id = install_state.virtual_render_device_id;
    }
    if install_state.driver_backend != "sysvad-wave-rt" {
        snapshot.driver_health = "damaged".to_string();
        snapshot.last_error_code = Some("driver.version-mismatch".to_string());
    }
    snapshot.install_phase = if snapshot.driver_health == "running" {
        "ready".to_string()
    } else {
        "rollback-required".to_string()
    };
    snapshot.last_error_code = if snapshot.driver_health == "running" {
        None
    } else {
        Some("driver.version-mismatch".to_string())
    };
    reconcile_bridge_snapshot(snapshot);
    Ok(())
}

include!("ipc/audio_writer.rs");

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::bridge::contracts::DriverInstallStateFile;

    #[test]
    fn load_install_state_marks_missing_driver_as_not_installed() {
        let temp_dir = TempDir::new().expect("temp dir should build");
        let mut snapshot = BridgeRuntimeSnapshot {
            runtime_root: temp_dir.path().to_string_lossy().to_string(),
            driver_health: "running".to_string(),
            ..Default::default()
        };

        load_install_state(&mut snapshot).expect("missing install state should not fail");

        assert_eq!(snapshot.driver_health, "not-installed");
        assert_eq!(snapshot.install_phase, "planned");
        assert_eq!(snapshot.process_status, "stopped");
        assert_eq!(
            snapshot.last_error_code.as_deref(),
            Some("driver.not-installed")
        );
    }

    #[test]
    fn load_install_state_applies_saved_driver_state() {
        let temp_dir = TempDir::new().expect("temp dir should build");
        let mut snapshot = BridgeRuntimeSnapshot {
            runtime_root: temp_dir.path().to_string_lossy().to_string(),
            ..Default::default()
        };

        let state = DriverInstallStateFile {
            protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
            install_channel: "release".to_string(),
            driver_version: "1.2.3".to_string(),
            bridge_version: "0.2.0".to_string(),
            driver_health: "running".to_string(),
            installed_at: "unix:1".to_string(),
            target_device_id: "virtual-mic-7".to_string(),
            virtual_render_device_id: "virtual-speaker-7".to_string(),
            driver_backend: "sysvad-wave-rt".to_string(),
        };
        fs::write(
            driver_state_path(&snapshot.runtime_root),
            serde_json::to_string(&state).expect("install state json should serialize"),
        )
        .expect("install state file should write");

        load_install_state(&mut snapshot).expect("install state should load");

        assert_eq!(snapshot.install_channel, "release");
        assert_eq!(snapshot.driver_version.as_deref(), Some("1.2.3"));
        assert_eq!(snapshot.bridge_version, "0.2.0");
        assert_eq!(snapshot.target_device_id, "virtual-mic-7");
        assert_eq!(snapshot.install_phase, "ready");
        assert_eq!(snapshot.status, "warning");
        assert_eq!(
            snapshot.recommended_action.as_deref(),
            Some("restart-bridge")
        );
    }

    #[test]
    fn apply_query_promotes_running_bridge_to_ready_runtime() {
        let mut snapshot = BridgeRuntimeSnapshot::default();
        apply_query(
            &mut snapshot,
            BridgeStateResponse {
                request_id: "bridge-state-1".to_string(),
                protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
                bridge_state: "running".to_string(),
                bridge_process_id: Some(4242),
                bridge_instance_id: Some("bridge-instance-1".to_string()),
                lifecycle_state: "ready".to_string(),
                driver_health: "running".to_string(),
                driver_version: Some("1.2.3".to_string()),
                bridge_version: "0.2.0".to_string(),
                source_capture_mode: super::super::contracts::SourceCaptureMode::VirtualDriver,
                capture_backend: super::super::contracts::CaptureBackend::DriverVirtualSpeaker,
                process_loopback_supported: false,
                process_loopback_status: super::super::contracts::ProcessLoopbackStatus::Unknown,
                windows_build_number: None,
                process_loopback_minimum_windows_build: 20_348,
                excluded_process_id: None,
                process_loopback_failure_detail: None,
                capture_lifecycle_state: "wasapi-loopback-running".to_string(),
                capture_restart_count: 1,
                capture_packet_count: 2,
                capture_frames_received: 1920,
                capture_peak: 0.25,
                capture_rms: 0.125,
                capture_silent_packet_count: 3,
                capture_invalid_sample_count: 4,
                resolved_physical_playback_device_id: "real-speaker-1".to_string(),
                physical_playback_status: "ready".to_string(),
                playback_owner_generation: 42,
                monitor_buffered_ms: 80,
                monitor_underrun_count: 0,
                monitor_overrun_count: 0,
                queued_frames: 4,
                source_frames_captured: 10,
                translated_frames_accepted: 8,
                virtual_mic_frames_written: 960,
                virtual_mic_write_failures: 0,
                virtual_mic_last_generation: 42,
                virtual_mic_output_supported: true,
                virtual_mic_output_status: "ready".to_string(),
                capture_endpoint_name: Some(
                    "Microphone (Omni Translate Virtual Microphone)".to_string(),
                ),
                virtual_mic_format: Some("48000Hz/mono/pcm16".to_string()),
                virtual_mic_buffered_bytes: 1_920,
                virtual_mic_max_buffered_bytes: 480_000,
                virtual_mic_consumed_bytes: 960,
                virtual_mic_dropped_bytes: 0,
                virtual_mic_underrun_bytes: 0,
                virtual_mic_rejected_writes: 0,
                virtual_mic_session_active: true,
                translation_queue_end_timestamp_ms: 0,
                playback_frames_written: 16,
                underrun_count: 1,
                dropped_frame_count: 2,
                driver_buffered_bytes: 3,
                driver_max_buffered_bytes: 19_200,
                driver_captured_bytes: 7,
                driver_delivered_bytes: 6,
                driver_dropped_bytes: 4,
                source_pending_bytes: 5,
                source_pacer_queued_frames: 1,
                monitor_source_queued_frames: 2,
                stale_source_frames_dropped: 6,
                source_subscriber_active: true,
                source_generation: 2,
                source_generation_token: Some(
                    "bridge-instance-1:session-1:2".to_string(),
                ),
                source_worker_phase: "driver-read-returned".to_string(),
                source_worker_last_progress_timestamp_ms: Some(122),
                source_read_calls: 9,
                source_zero_byte_reads: 1,
                source_monitor_playback_enabled: true,
                translation_playback_enabled: true,
                monitor_playback_state: "playing".to_string(),
                last_frame_timestamp_ms: Some(123),
                last_error_code: None,
            },
        );

        assert_eq!(snapshot.process_status, "running");
        assert_eq!(snapshot.install_phase, "ready");
        assert_eq!(snapshot.status, "ready");
        assert_eq!(snapshot.driver_captured_bytes, 7);
        assert_eq!(snapshot.driver_delivered_bytes, 6);
        assert_eq!(snapshot.capture_peak, 0.25);
        assert_eq!(snapshot.capture_rms, 0.125);
        assert_eq!(snapshot.capture_silent_packet_count, 3);
        assert_eq!(snapshot.capture_invalid_sample_count, 4);
        assert_eq!(
            snapshot.resolved_physical_playback_device_id,
            "real-speaker-1"
        );
        assert!(snapshot.source_subscriber_active);
        assert_eq!(snapshot.source_generation, 2);
        assert_eq!(snapshot.source_read_calls, 9);
        assert_eq!(snapshot.source_zero_byte_reads, 1);
        assert!(snapshot.virtual_mic_output_supported);
        assert_eq!(snapshot.virtual_mic_output_status, "ready");
        assert_eq!(snapshot.virtual_mic_frames_written, 960);
        assert_eq!(snapshot.virtual_mic_buffered_bytes, 1_920);
        assert_eq!(
            snapshot.recommended_action.as_deref(),
            Some("open-diagnostics")
        );
    }

    #[test]
    fn proactive_process_loopback_probe_updates_only_capability_and_observed_route_fields() {
        let mut snapshot = BridgeRuntimeSnapshot {
            process_status: "running".to_string(),
            source_capture_mode: super::super::contracts::SourceCaptureMode::VirtualDriver,
            capture_backend: super::super::contracts::CaptureBackend::DriverVirtualSpeaker,
            source_generation: 19,
            last_error_code: Some("bridge.process-loopback-activation-failed".to_string()),
            ..Default::default()
        };

        apply_process_loopback_probe(
            &mut snapshot,
            BridgeProcessLoopbackProbeResponse {
                request_id: "probe-ready".to_string(),
                protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
                process_loopback_supported: true,
                process_loopback_status:
                    super::super::contracts::ProcessLoopbackStatus::Ready,
                windows_build_number: Some(26_100),
                process_loopback_minimum_windows_build: 20_348,
                process_loopback_failure_detail: None,
                error_code: None,
                probe_process_id: 42,
                source_capture_mode:
                    super::super::contracts::SourceCaptureMode::VirtualDriver,
                capture_backend:
                    super::super::contracts::CaptureBackend::DriverVirtualSpeaker,
            },
        );

        assert!(snapshot.process_loopback_supported);
        assert_eq!(
            snapshot.process_loopback_status,
            super::super::contracts::ProcessLoopbackStatus::Ready
        );
        assert_eq!(snapshot.windows_build_number, Some(26_100));
        assert_eq!(snapshot.source_generation, 19);
        assert_eq!(
            snapshot.source_capture_mode,
            super::super::contracts::SourceCaptureMode::VirtualDriver
        );
        assert_eq!(snapshot.last_error_code, None);
    }

    #[test]
    fn proactive_process_loopback_probe_preserves_typed_failure_snapshot() {
        let mut snapshot = BridgeRuntimeSnapshot::default();
        apply_process_loopback_probe(
            &mut snapshot,
            BridgeProcessLoopbackProbeResponse {
                request_id: "probe-unsupported".to_string(),
                protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
                process_loopback_supported: false,
                process_loopback_status:
                    super::super::contracts::ProcessLoopbackStatus::Unsupported,
                windows_build_number: Some(19_045),
                process_loopback_minimum_windows_build: 20_348,
                process_loopback_failure_detail: Some(
                    "requires Windows build 20348".to_string(),
                ),
                error_code: Some("bridge.process-loopback-unsupported".to_string()),
                probe_process_id: 42,
                source_capture_mode: super::super::contracts::SourceCaptureMode::None,
                capture_backend: super::super::contracts::CaptureBackend::None,
            },
        );

        assert!(!snapshot.process_loopback_supported);
        assert_eq!(
            snapshot.process_loopback_status,
            super::super::contracts::ProcessLoopbackStatus::Unsupported
        );
        assert_eq!(snapshot.windows_build_number, Some(19_045));
        assert_eq!(
            snapshot.last_error_code.as_deref(),
            Some("bridge.process-loopback-unsupported")
        );
        assert_eq!(
            snapshot.process_loopback_failure_detail.as_deref(),
            Some("requires Windows build 20348")
        );
    }

    #[test]
    fn process_loopback_init_error_preserves_capability_evidence_in_snapshot() {
        let snapshot = BridgeRuntimeSnapshot {
            process_status: "starting".to_string(),
            source_capture_mode: super::super::contracts::SourceCaptureMode::ProcessExclusion,
            ..Default::default()
        };
        let failure = apply_initialize_error(
            &snapshot,
            DriverBridgeErrorEvent {
                request_id: Some("bridge-init-test".to_string()),
                code: "bridge.process-loopback-unsupported".to_string(),
                message: "requires Windows build 20348; detected build 19045".to_string(),
                retriable: false,
                bridge_state: "degraded".to_string(),
                driver_health: "not-installed".to_string(),
                source_capture_mode:
                    super::super::contracts::SourceCaptureMode::ProcessExclusion,
                capture_backend:
                    super::super::contracts::CaptureBackend::WasapiProcessExclusion,
                process_loopback_supported: false,
                process_loopback_status:
                    super::super::contracts::ProcessLoopbackStatus::Unsupported,
                windows_build_number: Some(19_045),
                process_loopback_minimum_windows_build: 20_348,
                process_loopback_failure_detail: Some(
                    "requires Windows build 20348; detected build 19045".to_string(),
                ),
                suggested_action: Some("open-diagnostics".to_string()),
            },
        );
        let (failed, message) = failure.into_parts();

        assert_eq!(failed.process_status, "running");
        assert_eq!(failed.bridge_state, "degraded");
        assert_eq!(failed.lifecycle_state, "error");
        assert_eq!(
            failed.process_loopback_status,
            super::super::contracts::ProcessLoopbackStatus::Unsupported
        );
        assert!(!failed.process_loopback_supported);
        assert_eq!(failed.windows_build_number, Some(19_045));
        assert_eq!(failed.process_loopback_minimum_windows_build, 20_348);
        assert_eq!(
            failed.last_error_code.as_deref(),
            Some("bridge.process-loopback-unsupported")
        );
        assert_eq!(failed.status, "unsupported");
        assert_eq!(
            failed.recommended_action.as_deref(),
            Some("open-diagnostics")
        );
        assert!(message.contains("bridge.process-loopback-unsupported"));
    }

    #[test]
    fn injected_sidecar_activation_error_preserves_hresult_for_desktop() {
        let event: DriverBridgeEvent = serde_json::from_value(serde_json::json!({
            "type": "bridge.error",
            "requestId": "injected-activation-failure",
            "code": "bridge.process-loopback-activation-failed",
            "message": "ActivateAudioInterfaceAsync injected HRESULT=0x88890004",
            "retriable": true,
            "bridgeState": "degraded",
            "driverHealth": "not-installed",
            "sourceCaptureMode": "process-exclusion",
            "captureBackend": "wasapi-process-exclusion",
            "processLoopbackSupported": true,
            "processLoopbackStatus": "failed",
            "windowsBuildNumber": 20348,
            "processLoopbackMinimumWindowsBuild": 20348,
            "processLoopbackFailureDetail": "ActivateAudioInterfaceAsync injected HRESULT=0x88890004",
            "suggestedAction": "open-diagnostics"
        }))
        .expect("the real sidecar bridge.error envelope must satisfy the Desktop contract");
        let DriverBridgeEvent::Error(error) = event else {
            panic!("expected bridge.error");
        };
        let input = BridgeRuntimeSnapshot {
            process_status: "starting".to_string(),
            source_capture_mode: super::super::contracts::SourceCaptureMode::ProcessExclusion,
            ..Default::default()
        };
        let (failed, message) = apply_initialize_error(&input, error).into_parts();

        assert_eq!(failed.bridge_state, "degraded");
        assert_eq!(failed.lifecycle_state, "error");
        assert_eq!(
            failed.process_loopback_status,
            super::super::contracts::ProcessLoopbackStatus::Failed
        );
        assert!(failed.process_loopback_supported);
        assert_eq!(
            failed.last_error_code.as_deref(),
            Some("bridge.process-loopback-activation-failed")
        );
        assert!(failed
            .process_loopback_failure_detail
            .as_deref()
            .unwrap()
            .contains("HRESULT=0x88890004"));
        assert!(message.contains("HRESULT=0x88890004"));
    }

    #[test]
    fn source_error_invalidates_cached_process_loopback_readiness() {
        let mut snapshot = BridgeRuntimeSnapshot {
            process_status: "running".to_string(),
            bridge_state: "running".to_string(),
            lifecycle_state: "ready".to_string(),
            source_capture_mode: super::super::contracts::SourceCaptureMode::ProcessExclusion,
            capture_backend: super::super::contracts::CaptureBackend::WasapiProcessExclusion,
            process_loopback_supported: true,
            process_loopback_status: super::super::contracts::ProcessLoopbackStatus::Ready,
            source_subscriber_active: true,
            source_worker_phase: "process-loopback-running".to_string(),
            last_error_code: None,
            ..Default::default()
        };

        mark_process_loopback_capture_failed(
            &mut snapshot,
            "WASAPI capture stream failed".to_string(),
        );

        assert_eq!(snapshot.process_status, "running");
        assert_eq!(snapshot.bridge_state, "degraded");
        assert_eq!(snapshot.lifecycle_state, "error");
        assert_eq!(
            snapshot.process_loopback_status,
            super::super::contracts::ProcessLoopbackStatus::Failed
        );
        assert_eq!(snapshot.capture_lifecycle_state, "failed");
        assert!(!snapshot.source_subscriber_active);
        assert_eq!(snapshot.source_worker_phase, "process-loopback-failed");
        assert_eq!(
            snapshot.last_error_code.as_deref(),
            Some("bridge.process-loopback-capture-failed")
        );
        assert_eq!(snapshot.status, "warning");
        assert_eq!(
            snapshot.recommended_action.as_deref(),
            Some("restart-bridge")
        );
    }

    #[test]
    fn workspace_root_resolves_to_repository_root() {
        let root = workspace_root();

        // The repository can be checked out (or worktree'd) under any
        // directory name, so identify the root by its repo markers instead of
        // its basename: the workspace package.json and the layout that
        // `assets_root` depends on.
        assert!(
            root.join("package.json").is_file(),
            "workspace root {} lacks package.json",
            root.display()
        );
        assert!(
            root.join("apps").join("desktop").join("src-tauri").is_dir(),
            "workspace root {} lacks apps/desktop/src-tauri",
            root.display()
        );
        assert!(
            root.join("scripts").join("installer").is_dir(),
            "workspace root {} lacks scripts/installer (assets_root contract)",
            root.display()
        );

        let [preferred, legacy] = bridge_cli_release_candidates();
        assert_eq!(
            preferred,
            root.join("target")
                .join("release")
                .join("omni-bridge-service.exe")
        );
        assert_eq!(
            legacy,
            root.join("apps")
                .join("bridge-service-native")
                .join("target")
                .join("release")
                .join("omni-bridge-service.exe")
        );
        assert!(
            bridge_cli_release_candidates().contains(&bridge_cli_path()),
            "bridge_cli_path must resolve within the release candidate chain in a dev checkout"
        );
    }

    #[test]
    fn distributed_release_accepts_a_bridge_next_to_the_desktop_executable() {
        let exe_dir = Path::new(r"E:\omni-paid-worker\target\release");
        let candidates = installed_bridge_cli_candidates(exe_dir);
        assert_eq!(candidates[0], exe_dir.join("omni-bridge-service.exe"));
    }

    #[test]
    fn relocated_release_checks_its_runtime_workspace_before_the_build_checkout() {
        let exe_path = Path::new(r"E:\watch-worker\target\release\omni-desktop-shell.exe");
        let exe_dir = exe_path.parent().unwrap();
        let bridge_candidates = installed_bridge_cli_candidates(exe_dir);
        assert_eq!(
            bridge_candidates[0],
            Path::new(r"E:\watch-worker\target\release\omni-bridge-service.exe")
        );
        assert_eq!(
            relocated_workspace_root(exe_path).as_deref(),
            Some(Path::new(r"E:\watch-worker"))
        );
        assert_eq!(
            relocated_workspace_root(Path::new(r"C:\Program Files\Omni\desktop\omni-desktop-shell.exe")),
            None,
            "an arbitrary installed ancestor must never become an executable asset root"
        );
    }

    #[test]
    fn assets_root_prefers_the_dev_checkout() {
        assert_eq!(
            assets_root(),
            workspace_root(),
            "a dev checkout carries scripts/installer, so assets_root must resolve to it"
        );
    }

    #[test]
    fn bridge_pid_path_uses_the_runtime_root() {
        assert_eq!(
            bridge_pid_path(r"C:\runtime"),
            Path::new(r"C:\runtime").join("bridge-service.pid")
        );
    }

    #[test]
    fn process_path_match_is_case_and_separator_insensitive() {
        assert!(process_path_matches_expected_bridge(
            Path::new(r"C:\Omni\bridge.exe"),
            Path::new("c:/omni/bridge.exe"),
        ));
        assert!(!process_path_matches_expected_bridge(
            Path::new(r"C:\Omni\bridge.exe"),
            Path::new(r"C:\Other\bridge.exe"),
        ));
    }

    #[test]
    fn stale_bridge_pid_parser_rejects_invalid_content() {
        assert_eq!(parse_bridge_pid(" 42 ").unwrap(), 42);
        assert!(parse_bridge_pid("not-a-pid")
            .unwrap_err()
            .starts_with("bridge.stale-pid-invalid:"));
    }

    #[test]
    fn stale_bridge_recovery_decision_is_exact_and_bounded() {
        let expected = Path::new(r"C:\Omni\omni-bridge-service.exe");

        assert_eq!(
            decide_stale_bridge_process_action(42, 1, None, expected).unwrap(),
            StaleBridgeProcessAction::RemovePidFile
        );
        assert_eq!(
            decide_stale_bridge_process_action(
                42,
                1,
                Some(Path::new("c:/omni/omni-bridge-service.exe")),
                expected,
            )
            .unwrap(),
            StaleBridgeProcessAction::Terminate(42)
        );
        assert_eq!(
            decide_stale_bridge_process_action(42, 42, Some(expected), expected).unwrap_err(),
            "bridge.stale-pid-points-to-desktop-process"
        );
        assert!(decide_stale_bridge_process_action(
            42,
            1,
            Some(Path::new(r"C:\Other\omni-bridge-service.exe")),
            expected,
        )
        .unwrap_err()
        .starts_with("bridge.stale-process-path-mismatch:"));
    }

    #[test]
    fn shutdown_command_uses_remote_cleanup_session_without_local_handshake() {
        let snapshot = BridgeRuntimeSnapshot::default();
        let DriverBridgeCommand::Shutdown(command) = build_shutdown_command(&snapshot) else {
            panic!("expected shutdown command");
        };
        assert_eq!(command.session_id, "desktop-cleanup");
        assert_eq!(command.reason, "manual-stop");

        let mut active = snapshot;
        active.session_id = Some("session-1".to_string());
        let DriverBridgeCommand::Shutdown(command) = build_shutdown_command(&active) else {
            panic!("expected shutdown command");
        };
        assert_eq!(command.session_id, "session-1");
    }

    #[test]
    fn pipe_connection_timeout_returns_a_stable_error() {
        let error = match write_command_with_retry(
            r"\\.\pipe\omni-bridge-missing-test-pipe",
            &DriverBridgeCommand::StateQuery(BridgeStateQuery {
                request_id: "state-timeout".to_string(),
            }),
            1,
            Duration::ZERO,
        ) {
            Ok(_) => panic!("missing pipe should time out"),
            Err(error) => error,
        };
        assert_eq!(error, "Bridge Service named pipe 未在预期时间内就绪。");
    }

    #[test]
    fn quiet_cleanup_probe_does_not_retry_a_missing_pipe() {
        let started_at = std::time::Instant::now();
        let result = write_command_once_quiet(
            r"\\.\pipe\omni-bridge-missing-cleanup-test-pipe",
            &DriverBridgeCommand::StateQuery(BridgeStateQuery {
                request_id: "quiet-cleanup".to_string(),
            }),
        );
        assert!(result.is_err());
        assert!(started_at.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn source_flush_cannot_report_success_when_the_bridge_rejects_the_boundary() {
        let mut snapshot = BridgeRuntimeSnapshot::default();
        snapshot.pipe_path = r"\\.\pipe\omni-bridge-missing-source-flush-test-pipe".to_string();

        let error = flush_bridge_source(&snapshot)
            .expect_err("a missing Bridge cannot acknowledge the source flush boundary");

        assert!(!error.trim().is_empty());
    }

    #[test]
    fn control_response_limit_excludes_the_line_terminator() {
        let maximum_payload = "x".repeat(omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES);

        assert_eq!(
            control_response_payload_len(&format!("{maximum_payload}\n")),
            omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES
        );
        assert_eq!(
            control_response_payload_len(&format!("{maximum_payload}\r\n")),
            omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES
        );
        assert_eq!(
            control_response_payload_len(&format!("{maximum_payload}x\n")),
            omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES + 1
        );
    }

    #[test]
    fn fast_state_query_does_not_retry_a_missing_pipe() {
        let started_at = std::time::Instant::now();
        let result = query_state_fast(r"\\.\pipe\omni-bridge-missing-fast-test-pipe");
        assert!(result.is_err());
        assert!(started_at.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn translation_ack_surfaces_framed_nack_details() {
        let error = accepted_translation_frames(&BridgeTranslationFrameAck {
            event_type: "bridge.translation.nack".to_string(),
            request_id: "request-1".to_string(),
            frame_id: "frame-1".to_string(),
            session_id: "session-1".to_string(),
            bridge_instance_id: "bridge-instance-1".to_string(),
            source_generation: 1,
            source_generation_token: "bridge-instance-1:session-1:1".to_string(),
            playback_owner_generation: 1,
            physical_playback_device_id: "physical-endpoint-1".to_string(),
            accepted_frames: 0,
            playback_frames_written: 0,
            error_code: Some("bridge.session-mismatch".to_string()),
            message: Some("wrong session".to_string()),
        })
        .expect_err("nack should fail");
        assert_eq!(error, "bridge.session-mismatch: wrong session");
    }

    #[test]
    fn translation_ack_accepts_success_frames() {
        assert_eq!(
            accepted_translation_frames(&BridgeTranslationFrameAck {
                event_type: "bridge.translation.ack".to_string(),
                request_id: "request-1".to_string(),
                frame_id: "frame-1".to_string(),
                session_id: "session-1".to_string(),
                bridge_instance_id: "bridge-instance-1".to_string(),
                source_generation: 1,
                source_generation_token: "bridge-instance-1:session-1:1".to_string(),
                playback_owner_generation: 1,
                physical_playback_device_id: "physical-endpoint-1".to_string(),
                accepted_frames: 32,
                playback_frames_written: 64,
                error_code: None,
                message: None,
            })
            .expect("ack should succeed"),
            32
        );
    }

    #[test]
    fn virtual_mic_pacing_uses_twenty_millisecond_mono_chunks() {
        let samples = vec![0; 961];
        let chunks = virtual_mic_pacing_chunks(&samples, 24_000, 1).unwrap();
        assert_eq!(
            chunks.iter().map(|chunk| chunk.len()).collect::<Vec<_>>(),
            vec![480, 480, 1]
        );
    }

    #[test]
    fn virtual_mic_pacing_preserves_stereo_frame_boundaries() {
        let samples = vec![0; 1_922];
        let chunks = virtual_mic_pacing_chunks(&samples, 24_000, 2).unwrap();
        assert_eq!(
            chunks.iter().map(|chunk| chunk.len()).collect::<Vec<_>>(),
            vec![960, 960, 2]
        );
    }

    #[test]
    fn virtual_mic_pacing_rejects_invalid_audio_format() {
        assert!(virtual_mic_pacing_chunks(&[0], 0, 1).is_err());
        assert!(virtual_mic_pacing_chunks(&[0], 24_000, 0).is_err());
        assert!(virtual_mic_pacing_chunks(&[0, 1, 2], 24_000, 2).is_err());
    }

    #[test]
    fn process_playback_keeps_a_long_cue_that_would_overflow_chunk_queue_in_one_bridge_job() {
        // Four seconds would become 200 driver-paced jobs, exceeding Bridge's
        // 128-pending-job translation queue. Process playback must submit the
        // same PCM as one cue-level job instead.
        let samples = vec![0; 24_000 * 2 * 4];
        let virtual_mic_chunks = virtual_mic_pacing_chunks(&samples, 24_000, 2).unwrap();
        let chunks = process_playback_cue_chunks(&samples, 24_000, 2).unwrap();

        assert_eq!(virtual_mic_chunks.len(), 200);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), samples.len());
        assert!(std::ptr::eq(chunks[0].as_ptr(), samples.as_ptr()));
    }

    #[test]
    fn process_playback_does_not_enqueue_an_empty_cue() {
        assert!(process_playback_cue_chunks(&[], 24_000, 1)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn translation_header_preserves_upstream_cue_timing() {
        let header = translation_frame_header(
            "bridge.translation.frame",
            "request-timing",
            "session-timing".to_string(),
            "cue-timing",
            AudioRouteDirection::Inbound,
            TranslationAudioSink::PhysicalPlayback,
            48_000,
            2,
            96_000,
            192_000,
            1_750_000_000_123,
            1_000,
            None,
            None,
            None,
            Some(4242),
            Some("bridge-instance-timing".to_string()),
            Some(3),
            Some("bridge-instance-timing:session-timing:3".to_string()),
            Some(7),
            Some("physical-endpoint-timing".to_string()),
        );

        assert_eq!(header.cue_id.as_deref(), Some("cue-timing"));
        assert_eq!(header.created_at_ms, Some(1_750_000_000_123));
        assert_eq!(header.estimated_duration_ms, Some(1_000));
        assert_eq!(
            header.translation_sink,
            Some(TranslationAudioSink::PhysicalPlayback)
        );
        assert_eq!(header.route_direction, Some(AudioRouteDirection::Inbound));
        assert_eq!(header.frame_count, 96_000);
        assert_eq!(header.payload_bytes, 192_000);
        assert_eq!(header.chunk_index, None);
        assert_eq!(header.chunk_count, None);
        assert_eq!(header.bridge_process_id, Some(4242));
        assert_eq!(
            header.bridge_instance_id.as_deref(),
            Some("bridge-instance-timing")
        );
        assert!(header.timestamp_ms >= header.created_at_ms.unwrap());
    }

    fn translation_owner_snapshot(
        session_id: Option<&str>,
        bridge_instance_id: Option<&str>,
    ) -> BridgeRuntimeSnapshot {
        let session = session_id.map(str::to_string);
        let instance = bridge_instance_id.map(str::to_string);
        BridgeRuntimeSnapshot {
            process_status: "running".to_string(),
            bridge_state: "running".to_string(),
            lifecycle_state: "ready".to_string(),
            session_id: session.clone(),
            bridge_instance_id: instance.clone(),
            source_generation: 1,
            source_generation_token: instance
                .zip(session)
                .map(|(instance, session)| format!("{instance}:{session}:1")),
            physical_playback_status: "ready".to_string(),
            resolved_physical_playback_device_id: "physical-endpoint".to_string(),
            playback_owner_generation: 1,
            ..Default::default()
        }
    }

    #[test]
    fn translation_owner_change_marks_late_old_generation_write_as_terminated() {
        let old = translation_owner_snapshot(Some("session-old"), Some("instance-old"));
        let expected = BridgeTranslationSinkOwner::from_snapshot(&old).unwrap();
        let new = translation_owner_snapshot(Some("session-new"), Some("instance-new"));

        let error = translation_write_error_for_owner(
            Some(&expected),
            &new,
            "Bridge audio pipe write failed: broken pipe".to_string(),
        );

        assert!(is_bridge_translation_generation_ended_error(&error));
        assert!(error.contains("session-old"));
        assert!(error.contains("instance-new"));
    }

    #[test]
    fn stopped_restart_window_terminates_the_previous_translation_owner() {
        let old = translation_owner_snapshot(Some("session-old"), Some("instance-old"));
        let expected = BridgeTranslationSinkOwner::from_snapshot(&old).unwrap();
        let stopped = translation_owner_snapshot(None, Some("instance-old"));

        let error = translation_write_error_for_owner(
            Some(&expected),
            &stopped,
            "Bridge Service was stopped before the late chunk".to_string(),
        );

        assert!(is_bridge_translation_generation_ended_error(&error));
        assert!(error.contains("currentOwner=[sessionId=- bridgeInstanceId=-]"));
    }

    #[test]
    fn current_translation_owner_write_failure_remains_hard() {
        let current = translation_owner_snapshot(Some("session-current"), Some("instance-current"));
        let expected = BridgeTranslationSinkOwner::from_snapshot(&current).unwrap();
        let cause = "Bridge audio pipe write failed: access denied".to_string();

        let error = translation_write_error_for_owner(Some(&expected), &current, cause.clone());

        assert_eq!(error, cause);
        assert!(!is_bridge_translation_generation_ended_error(&error));
    }

    #[test]
    fn session_mismatch_nack_proves_the_pipe_owner_superseded_the_snapshot() {
        let stale = translation_owner_snapshot(Some("session-stale"), Some("instance-stale"));
        let expected = BridgeTranslationSinkOwner::from_snapshot(&stale).unwrap();

        let error = translation_generation_ended_error(
            &expected,
            &stale,
            "bridge.session-mismatch: wrong session".to_string(),
        );

        assert!(is_bridge_translation_generation_ended_error(&error));
        assert!(error.contains("bridge.session-mismatch"));
    }

    #[test]
    fn translation_owner_requires_complete_ready_playback_authority() {
        assert!(BridgeTranslationSinkOwner::from_snapshot(&translation_owner_snapshot(
            Some("session"),
            Some("instance")
        ))
        .is_some());
        assert!(BridgeTranslationSinkOwner::from_snapshot(&translation_owner_snapshot(
            Some("session"),
            None
        ))
        .is_none());
        assert!(BridgeTranslationSinkOwner::from_snapshot(&translation_owner_snapshot(
            None,
            Some("instance")
        ))
        .is_none());
        let mut not_ready = translation_owner_snapshot(Some("session"), Some("instance"));
        not_ready.physical_playback_status = "rebinding".to_string();
        assert!(BridgeTranslationSinkOwner::from_snapshot(&not_ready).is_none());

        let mut missing_endpoint = translation_owner_snapshot(Some("session"), Some("instance"));
        missing_endpoint.resolved_physical_playback_device_id.clear();
        assert!(BridgeTranslationSinkOwner::from_snapshot(&missing_endpoint).is_none());

        let mut missing_generation = translation_owner_snapshot(Some("session"), Some("instance"));
        missing_generation.playback_owner_generation = 0;
        assert!(BridgeTranslationSinkOwner::from_snapshot(&missing_generation).is_none());
    }
}
