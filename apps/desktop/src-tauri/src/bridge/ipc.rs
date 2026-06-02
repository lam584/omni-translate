use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

pub fn bridge_cli_path() -> PathBuf {
    let release_path = workspace_root()
        .join("apps")
        .join("bridge-service-native")
        .join("target")
        .join("release")
        .join("omni-bridge-service.exe");
    if release_path.exists() {
        return release_path;
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for candidate in &[
                exe_dir
                    .join("resources")
                    .join("bridge-service-native")
                    .join("omni-bridge-service.exe"),
                exe_dir
                    .join("bridge-service-native")
                    .join("omni-bridge-service.exe"),
                exe_dir
                    .parent()
                    .unwrap_or(exe_dir)
                    .join("bridge-service-native")
                    .join("omni-bridge-service.exe"),
            ] {
                if candidate.exists() {
                    return candidate.clone();
                }
            }
        }
    }

    release_path
}

#[allow(dead_code)]
pub fn driver_state_path(runtime_root: &str) -> PathBuf {
    Path::new(runtime_root).join("driver-install-state.json")
}

pub fn bridge_pid_path(runtime_root: &str) -> PathBuf {
    Path::new(runtime_root).join("bridge-service.pid")
}

fn normalized_executable_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

pub fn process_path_matches_expected_bridge(actual: &Path, expected: &Path) -> bool {
    normalized_executable_path(actual) == normalized_executable_path(expected)
}

fn read_bridge_pid(runtime_root: &str) -> Result<Option<u32>, String> {
    let path = bridge_pid_path(runtime_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    parse_bridge_pid(&raw).map(Some)
}

fn parse_bridge_pid(raw: &str) -> Result<u32, String> {
    raw.trim()
        .parse::<u32>()
        .map_err(|error| format!("bridge.stale-pid-invalid: {error}"))
}

#[derive(Debug, PartialEq, Eq)]
enum StaleBridgeProcessAction {
    RemovePidFile,
    Terminate(u32),
}

fn decide_stale_bridge_process_action(
    pid: u32,
    current_pid: u32,
    actual_path: Option<&Path>,
    expected_path: &Path,
) -> Result<StaleBridgeProcessAction, String> {
    if pid == current_pid {
        return Err("bridge.stale-pid-points-to-desktop-process".to_string());
    }
    let Some(actual_path) = actual_path else {
        return Ok(StaleBridgeProcessAction::RemovePidFile);
    };
    if !process_path_matches_expected_bridge(actual_path, expected_path) {
        return Err(format!(
            "bridge.stale-process-path-mismatch: pid={pid} actual={} expected={}",
            actual_path.display(),
            expected_path.display()
        ));
    }
    Ok(StaleBridgeProcessAction::Terminate(pid))
}

#[cfg(windows)]
fn query_process_executable_path(pid: u32) -> Result<Option<PathBuf>, String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(None)
        } else {
            Err(format!("bridge.stale-process-open-failed: {error}"))
        };
    }
    let mut path = vec![0_u16; 32_768];
    let mut len = path.len() as u32;
    let queried = unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut len) };
    unsafe {
        CloseHandle(process);
    }
    if queried == 0 {
        return Err(format!(
            "bridge.stale-process-query-failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    path.truncate(len as usize);
    Ok(Some(PathBuf::from(String::from_utf16_lossy(&path))))
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if process.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(())
        } else {
            Err(format!("bridge.stale-process-open-failed: {error}"))
        };
    }
    let terminated = unsafe { TerminateProcess(process, 0) };
    unsafe {
        CloseHandle(process);
    }
    if terminated == 0 {
        Err(format!(
            "bridge.stale-process-terminate-failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

pub fn terminate_stale_bridge_process(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    let Some(pid) = read_bridge_pid(&snapshot.runtime_root)? else {
        return Ok(());
    };
    let pid_path = bridge_pid_path(&snapshot.runtime_root);
    let actual_path = query_process_executable_path(pid)?;
    let expected_path = bridge_cli_path();
    match decide_stale_bridge_process_action(
        pid,
        std::process::id(),
        actual_path.as_deref(),
        &expected_path,
    )? {
        StaleBridgeProcessAction::RemovePidFile => {
            let _ = fs::remove_file(pid_path);
        }
        StaleBridgeProcessAction::Terminate(pid) => {
            terminate_process(pid)?;
            let _ = fs::remove_file(pid_path);
        }
    }
    Ok(())
}

fn write_command(
    pipe_path: &str,
    command: &DriverBridgeCommand,
) -> Result<DriverBridgeEvent, String> {
    write_command_with_retry(
        pipe_path,
        command,
        BRIDGE_CONNECT_RETRIES,
        Duration::from_millis(BRIDGE_CONNECT_DELAY_MS),
    )
}

fn write_command_with_retry(
    pipe_path: &str,
    command: &DriverBridgeCommand,
    connect_retries: usize,
    connect_delay: Duration,
) -> Result<DriverBridgeEvent, String> {
    for attempt in 0..connect_retries {
        match OpenOptions::new().read(true).write(true).open(pipe_path) {
            Ok(mut pipe) => {
                let payload = serde_json::to_string(command).map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] failed to serialize command pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;
                pipe.write_all(payload.as_bytes()).map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe write failed pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;
                pipe.write_all(b"\n").map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe write newline failed pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;
                pipe.flush().map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe flush failed pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;

                let mut reader = BufReader::new(pipe);
                let mut response = String::new();
                reader.read_line(&mut response).map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe read failed pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;
                return serde_json::from_str(response.trim()).map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe response parse failed pipe={} response={} err={}",
                        pipe_path,
                        response.trim(),
                        error
                    );
                    error.to_string()
                });
            }
            Err(_) => {
                if connect_retries > 1 && (attempt == 0 || attempt == connect_retries - 1) {
                    log::warn!(
                        "[omni][bridge-ipc] pipe not ready (attempt {}/{}) pipe={}",
                        attempt + 1,
                        connect_retries,
                        pipe_path
                    );
                }
                thread::sleep(connect_delay)
            }
        }
    }

    if connect_retries > 1 {
        log::error!(
            "[omni][bridge-ipc] pipe never ready after {} retries pipe={}",
            connect_retries,
            pipe_path
        );
    }
    Err("Bridge Service named pipe 未在预期时间内就绪。".to_string())
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

pub fn query_state(pipe_path: &str) -> Result<BridgeStateResponse, String> {
    match write_command(
        pipe_path,
        &DriverBridgeCommand::StateQuery(BridgeStateQuery {
            request_id: format!("bridge-state-{}", now_unix_ms()),
        }),
    )? {
        DriverBridgeEvent::StateSnapshot(snapshot) => Ok(snapshot),
        DriverBridgeEvent::Error(error) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Bridge Service 返回了意外响应。".to_string()),
    }
}

pub fn initialize_bridge(
    snapshot: &BridgeRuntimeSnapshot,
) -> Result<BridgeRuntimeSnapshot, String> {
    let session_id = snapshot
        .session_id
        .clone()
        .unwrap_or_else(|| format!("bridge-session-{}", Uuid::new_v4()));
    let event = write_command(
        &snapshot.pipe_path,
        &DriverBridgeCommand::Init(BridgeInitRequest {
            request_id: format!("bridge-init-{}", now_unix_ms()),
            protocol_version: "2026-06-02".to_string(),
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
            next.last_handshake_at = Some(crate::runtime::state::now_marker());
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
    snapshot.queued_frames = query.queued_frames;
    snapshot.last_frame_timestamp_ms = query.last_frame_timestamp_ms;
    snapshot.source_frames_captured = query.source_frames_captured;
    snapshot.translated_frames_accepted = query.translated_frames_accepted;
    snapshot.playback_frames_written = query.playback_frames_written;
    snapshot.underrun_count = query.underrun_count;
    snapshot.dropped_frame_count = query.dropped_frame_count;
    snapshot.driver_buffered_bytes = query.driver_buffered_bytes;
    snapshot.driver_max_buffered_bytes = query.driver_max_buffered_bytes;
    snapshot.driver_dropped_bytes = query.driver_dropped_bytes;
    snapshot.source_pending_bytes = query.source_pending_bytes;
    snapshot.source_pacer_queued_frames = query.source_pacer_queued_frames;
    snapshot.monitor_source_queued_frames = query.monitor_source_queued_frames;
    snapshot.stale_source_frames_dropped = query.stale_source_frames_dropped;
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

#[allow(dead_code)]
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

pub fn write_virtual_mic_frame(
    app: &AppHandle,
    cue_id: &str,
    request_id: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Result<u64, String> {
    write_bridge_audio_frame(
        app,
        "bridge.translation.frame",
        cue_id,
        request_id,
        samples,
        sample_rate_hz,
        channel_count,
    )
}

fn accepted_translation_frames(ack: &BridgeTranslationFrameAck) -> Result<u64, String> {
    if let Some(error_code) = ack.error_code.as_deref() {
        return Err(format!(
            "{}: {}",
            error_code,
            ack.message
                .as_deref()
                .unwrap_or("Bridge Service rejected the translation frame.")
        ));
    }
    if ack.event_type != "bridge.translation.ack" {
        return Err(
            "Bridge Service returned an invalid translation frame acknowledgement.".to_string(),
        );
    }
    Ok(ack.accepted_frames as u64)
}

fn write_bridge_audio_frame(
    app: &AppHandle,
    event_type: &str,
    cue_id: &str,
    request_id: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Result<u64, String> {
    let bridge_state = app.state::<BridgeStateStore>();
    let snapshot = bridge_state.snapshot();
    if snapshot.process_status != "running" || snapshot.bridge_state != "running" {
        log_error!(
            app,
            "bridge",
            "Bridge Service 未运行，无法写入虚拟麦克风帧",
            format!(
                "cueId={} processStatus={} bridgeState={}",
                cue_id, snapshot.process_status, snapshot.bridge_state
            )
        );
        return Err("Bridge Service 未启动或尚未完成握手。".to_string());
    }

    let session_id = snapshot.session_id.clone().ok_or_else(|| {
        log_error!(
            app,
            "bridge",
            "Bridge Service 会话不存在，无法写入虚拟麦克风帧",
            format!("cueId={}", cue_id)
        );
        "Bridge Service 会话不存在。".to_string()
    })?;

    let frame_id = format!("{}-{}", cue_id, Uuid::new_v4());
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let header = BridgeTranslationFrameHeader {
        event_type: event_type.to_string(),
        request_id: request_id.to_string(),
        session_id,
        frame_id,
        stream_id: cue_id.to_string(),
        sample_rate_hz,
        channel_count,
        frame_count: samples.len() / channel_count as usize,
        timestamp_ms: now_unix_ms(),
        payload_bytes: bytes.len(),
    };
    let header_bytes = serde_json::to_vec(&header).map_err(|error| error.to_string())?;
    let mut audio_pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&snapshot.audio_pipe_path)
        .map_err(|error| format!("Bridge audio pipe open failed: {}", error))?;
    audio_pipe
        .write_all(&(header_bytes.len() as u32).to_le_bytes())
        .and_then(|_| audio_pipe.write_all(&header_bytes))
        .and_then(|_| audio_pipe.write_all(&bytes))
        .and_then(|_| audio_pipe.flush())
        .map_err(|error| format!("Bridge audio pipe write failed: {}", error))?;
    let mut ack_size = [0_u8; 4];
    audio_pipe
        .read_exact(&mut ack_size)
        .map_err(|error| format!("Bridge audio pipe ack size read failed: {}", error))?;
    let mut ack_bytes = vec![0_u8; u32::from_le_bytes(ack_size) as usize];
    audio_pipe
        .read_exact(&mut ack_bytes)
        .map_err(|error| format!("Bridge audio pipe ack read failed: {}", error))?;
    let ack: BridgeTranslationFrameAck =
        serde_json::from_slice(&ack_bytes).map_err(|error| error.to_string())?;

    if let Some(error_code) = ack.error_code.as_deref() {
        bridge_state.update_snapshot(|current| {
            current.last_error_code = Some(error_code.to_string());
            reconcile_bridge_snapshot(current);
        });
        return accepted_translation_frames(&ack);
    }
    let accepted_frames = accepted_translation_frames(&ack)?;
    bridge_state.update_snapshot(|current| {
        current.translated_frames_accepted += ack.accepted_frames as u64;
        current.playback_frames_written = ack.playback_frames_written;
        current.last_frame_timestamp_ms = Some(now_unix_ms());
        current.last_error_code = None;
        reconcile_bridge_snapshot(current);
    });
    let runtime_state = app.state::<crate::runtime::state::RuntimeStateStore>();
    let _ = emit_runtime_snapshot(app, &runtime_state);
    Ok(accepted_frames)
    /*
        _ => Err("Bridge Service 写帧响应无效。".to_string()),
    */
}

pub fn stop_bridge_process(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    let _ = write_command_with_retry(
        &snapshot.pipe_path,
        &build_shutdown_command(snapshot),
        1,
        Duration::ZERO,
    );
    Ok(())
}

pub fn flush_bridge_source(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    let _ = write_command_with_retry(
        &snapshot.pipe_path,
        &DriverBridgeCommand::SourceFlush(BridgeSourceFlushRequest {
            request_id: format!("bridge-source-flush-{}", now_unix_ms()),
        }),
        1,
        Duration::ZERO,
    );
    Ok(())
}

fn build_shutdown_command(snapshot: &BridgeRuntimeSnapshot) -> DriverBridgeCommand {
    DriverBridgeCommand::Shutdown(BridgeShutdownRequest {
        request_id: format!("bridge-shutdown-{}", now_unix_ms()),
        session_id: snapshot
            .session_id
            .clone()
            .unwrap_or_else(|| "desktop-cleanup".to_string()),
        reason: "manual-stop".to_string(),
    })
}

pub fn ensure_bridge_runtime_root(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    std::fs::create_dir_all(&snapshot.runtime_root).map_err(|error| error.to_string())
}

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
            protocol_version: "2026-06-02".to_string(),
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
                protocol_version: "2026-06-02".to_string(),
                bridge_state: "running".to_string(),
                lifecycle_state: "ready".to_string(),
                driver_health: "running".to_string(),
                driver_version: Some("1.2.3".to_string()),
                bridge_version: "0.2.0".to_string(),
                queued_frames: 4,
                source_frames_captured: 10,
                translated_frames_accepted: 8,
                playback_frames_written: 16,
                underrun_count: 1,
                dropped_frame_count: 2,
                driver_buffered_bytes: 3,
                driver_max_buffered_bytes: 19_200,
                driver_dropped_bytes: 4,
                source_pending_bytes: 5,
                source_pacer_queued_frames: 1,
                monitor_source_queued_frames: 2,
                stale_source_frames_dropped: 6,
                monitor_playback_state: "playing".to_string(),
                last_frame_timestamp_ms: Some(123),
                last_error_code: None,
            },
        );

        assert_eq!(snapshot.process_status, "running");
        assert_eq!(snapshot.install_phase, "ready");
        assert_eq!(snapshot.status, "ready");
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
        assert_eq!(
            bridge_cli_path(),
            root.join("apps")
                .join("bridge-service-native")
                .join("target")
                .join("release")
                .join("omni-bridge-service.exe")
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
}
