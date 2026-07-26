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

use crate::log_error;
use crate::runtime::events::emit_runtime_snapshot;

use super::contracts::{
    reconcile_bridge_snapshot, BridgeInitRequest, BridgeRuntimeSnapshot, BridgeShutdownRequest,
    BridgeSourceFlushRequest, BridgeStateQuery, BridgeStateResponse, BridgeTranslationFrameAck,
    BridgeTranslationFrameHeader, DriverBridgeCommand, DriverBridgeEvent,
};
use super::state::BridgeStateStore;

const BRIDGE_CONNECT_RETRIES: usize = 40;
const BRIDGE_CONNECT_DELAY_MS: u64 = 100;
const IPC_READ_TIMEOUT_SECS: u64 = 5;

pub use super::clients::BridgeIpcClient;
pub(crate) use super::clients::{BridgeAudioWriter, BridgeProcessSupervisor};

include!("ipc/process.rs");

include!("ipc/transport.rs");

pub fn initialize_bridge(
    snapshot: &BridgeRuntimeSnapshot,
) -> Result<BridgeRuntimeSnapshot, String> {
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
            physical_playback_level: snapshot.physical_playback_level,
            mix_control: snapshot.mix_control.clone(),
            monitor_playback_enabled: snapshot.monitor_playback_enabled,
            expected_driver_version: snapshot.expected_driver_version.clone(),
            expected_bridge_version: snapshot.expected_bridge_version.clone(),
        }),
    )?;

    let mut next = snapshot.clone();
    match event {
        DriverBridgeEvent::InitAck(ack) => {
            next.session_id = Some(session_id);
            next.bridge_state = ack.bridge_state;
            next.driver_health = ack.driver_health;
            next.driver_version = ack.active_driver_version;
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
            if next.driver_health == "not-installed" {
                next.last_error_code = Some("driver.not-installed".to_string());
            } else if next.driver_health == "version-mismatch" {
                next.last_error_code = Some("driver.version-mismatch".to_string());
            } else {
                next.last_error_code = None;
            }
            reconcile_bridge_snapshot(&mut next);
            Ok(next)
        }
        DriverBridgeEvent::Error(error) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Bridge Service 初始化响应无效。".to_string()),
    }
}

pub fn apply_query(snapshot: &mut BridgeRuntimeSnapshot, query: BridgeStateResponse) {
    snapshot.bridge_state = query.bridge_state;
    snapshot.lifecycle_state = query.lifecycle_state;
    snapshot.driver_health = query.driver_health;
    snapshot.driver_version = query.driver_version;
    snapshot.bridge_version = query.bridge_version;
    snapshot.capture_backend = query.capture_backend;
    snapshot.capture_lifecycle_state = query.capture_lifecycle_state;
    snapshot.capture_restart_count = query.capture_restart_count;
    snapshot.capture_packet_count = query.capture_packet_count;
    snapshot.capture_frames_received = query.capture_frames_received;
    snapshot.capture_peak = query.capture_peak;
    snapshot.capture_rms = query.capture_rms;
    snapshot.capture_silent_packet_count = query.capture_silent_packet_count;
    snapshot.capture_invalid_sample_count = query.capture_invalid_sample_count;
    snapshot.resolved_physical_playback_device_id = query.resolved_physical_playback_device_id;
    snapshot.monitor_buffered_ms = query.monitor_buffered_ms;
    snapshot.monitor_underrun_count = query.monitor_underrun_count;
    snapshot.monitor_overrun_count = query.monitor_overrun_count;
    snapshot.queued_frames = query.queued_frames;
    snapshot.last_frame_timestamp_ms = query.last_frame_timestamp_ms;
    snapshot.source_frames_captured = query.source_frames_captured;
    snapshot.translated_frames_accepted = query.translated_frames_accepted;
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
    snapshot.source_worker_phase = query.source_worker_phase;
    snapshot.source_worker_last_progress_timestamp_ms =
        query.source_worker_last_progress_timestamp_ms;
    snapshot.source_read_calls = query.source_read_calls;
    snapshot.source_zero_byte_reads = query.source_zero_byte_reads;
    snapshot.monitor_playback_state = query.monitor_playback_state;
    snapshot.last_error_code = query.last_error_code;
    snapshot.process_status = if snapshot.bridge_state == "running" {
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

#[allow(dead_code, reason = "legacy driver install-state loader is retained for upgrade compatibility")]
pub fn load_install_state(snapshot: &mut BridgeRuntimeSnapshot) -> Result<(), String> {
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
                lifecycle_state: "ready".to_string(),
                driver_health: "running".to_string(),
                driver_version: Some("1.2.3".to_string()),
                bridge_version: "0.2.0".to_string(),
                capture_backend: "wasapi-endpoint-loopback".to_string(),
                capture_lifecycle_state: "wasapi-loopback-running".to_string(),
                capture_restart_count: 1,
                capture_packet_count: 2,
                capture_frames_received: 1920,
                capture_peak: 0.25,
                capture_rms: 0.125,
                capture_silent_packet_count: 3,
                capture_invalid_sample_count: 4,
                resolved_physical_playback_device_id: "real-speaker-1".to_string(),
                monitor_buffered_ms: 80,
                monitor_underrun_count: 0,
                monitor_overrun_count: 0,
                queued_frames: 4,
                source_frames_captured: 10,
                translated_frames_accepted: 8,
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
                source_worker_phase: "driver-read-returned".to_string(),
                source_worker_last_progress_timestamp_ms: Some(122),
                source_read_calls: 9,
                source_zero_byte_reads: 1,
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
        assert_eq!(
            snapshot.recommended_action.as_deref(),
            Some("open-diagnostics")
        );
    }

    #[test]
    fn workspace_root_resolves_to_repository_root() {
        let root = workspace_root();

        assert_eq!(
            root.file_name().and_then(|value| value.to_str()),
            Some("omni-translate")
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
    }
}
