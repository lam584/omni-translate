use std::collections::VecDeque;
use std::io::BufRead;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::diagnostics::events::append_diagnostics_log_quiet;
use crate::log_debug;
use crate::log_error;
use crate::log_info;
use crate::runtime::contracts::{RuntimeNotification, RuntimeSnapshot};
use crate::runtime::events::{
    build_runtime_snapshot, emit_runtime_notification, emit_runtime_snapshot,
};
use crate::runtime::state::RuntimeStateStore;
use crate::shared::time::now_unix_seconds_marker;

use super::contracts::{
    reconcile_bridge_snapshot, BridgeMixControl, BridgeRuntimeSnapshot, CaptureBackend,
    ProcessLoopbackStatus, SourceCaptureMode,
};
use super::installer::{apply_driver_probe, probe_driver, run_elevated_driver_operation};
use super::ipc::{
    apply_process_loopback_probe, apply_query, bridge_cli_path, BridgeIpcClient,
    BridgeProcessSupervisor,
};
use super::state::BridgeStateStore;

const DRIVER_STATE_STALE_THRESHOLD: Duration = Duration::from_secs(300);
const BRIDGE_STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
const BRIDGE_POST_KILL_SETTLE_MS: u64 = 50;
/// Upper bound of bridge stderr lines kept in memory for the startup-failure
/// report; older lines are evicted, and every line is persisted to the
/// diagnostics log instead of accumulating without bound.
const BRIDGE_STDERR_MAX_LINES: usize = 200;

fn verify_post_operation_driver_probe(bridge_state: &BridgeStateStore) -> Result<(), String> {
    match probe_driver(&bridge_state.snapshot(), false) {
        Ok(probe) => {
            bridge_state.update_snapshot(|current| apply_driver_probe(current, probe));
            Ok(())
        }
        Err(error) => {
            bridge_state.update_snapshot(|current| {
                current.driver_probe_state = "failed".to_string();
                current.last_error_code = Some("driver.probe-failed".to_string());
                current.driver_detail = Some(error.clone());
                current.install_phase = "verification-failed".to_string();
            });
            Err(format!(
                "driver.probe-failed: 驱动操作已执行，但无法验证安装结果：{error}"
            ))
        }
    }
}

fn extract_driver_string(config: &Value, pointer: &str, default: &str) -> String {
    config
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

fn apply_driver_config(snapshot: &mut BridgeRuntimeSnapshot, config: &Value) {
    snapshot.source_capture_mode = match config
        .pointer("/devices/feedbackLoopPrevention")
        .and_then(Value::as_str)
    {
        Some("virtual-driver") => SourceCaptureMode::VirtualDriver,
        Some("process-exclusion") => SourceCaptureMode::ProcessExclusion,
        _ => SourceCaptureMode::None,
    };
    snapshot.install_channel =
        extract_driver_string(config, "/driver/installChannel", &snapshot.install_channel);
    snapshot.install_phase =
        extract_driver_string(config, "/driver/installPhase", &snapshot.install_phase);
    snapshot.target_device_id =
        extract_driver_string(config, "/driver/targetDeviceId", &snapshot.target_device_id);
    snapshot.virtual_render_device_id = extract_driver_string(
        config,
        "/devices/virtualRenderDeviceId",
        &snapshot.virtual_render_device_id,
    );
    snapshot.physical_playback_device_id = extract_driver_string(
        config,
        "/devices/outputDeviceId",
        &snapshot.physical_playback_device_id,
    );
    snapshot.physical_playback_level = config
        .pointer("/devices/outputLevel")
        .and_then(Value::as_u64)
        .unwrap_or(snapshot.physical_playback_level)
        .min(100);
    let local_playback_enabled = config
        .pointer("/speech/localPlaybackEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(snapshot.monitor_playback_enabled);
    snapshot.monitor_playback_enabled = local_playback_enabled;
    snapshot.translation_playback_enabled = local_playback_enabled
        && snapshot.source_capture_mode == SourceCaptureMode::VirtualDriver;
    snapshot.virtual_mic_output_requested = config
        .pointer("/speech/virtualMicOutputEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if snapshot.source_capture_mode == SourceCaptureMode::ProcessExclusion {
        // The bridge is the only authorized translated-audio renderer in this
        // mode. Source monitoring remains independently disabled by the native
        // capture backend so original system audio is not replayed twice.
        snapshot.monitor_playback_enabled = true;
        snapshot.translation_playback_enabled = true;
    }
    snapshot.mix_control = BridgeMixControl {
        keep_original_audio: config
            .pointer("/devices/inboundRoute/mixControl/keepOriginalAudio")
            .and_then(Value::as_bool)
            .unwrap_or(snapshot.mix_control.keep_original_audio),
        translated_audio_enabled: config
            .pointer("/devices/inboundRoute/mixControl/translatedAudioEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(snapshot.mix_control.translated_audio_enabled),
        translated_audio_gain_db: config
            .pointer("/devices/inboundRoute/mixControl/translatedAudioGainDb")
            .and_then(Value::as_f64)
            .map(|value| value as f32)
            .unwrap_or(snapshot.mix_control.translated_audio_gain_db),
        translated_audio_auto_gain_enabled: config
            .pointer("/devices/inboundRoute/mixControl/translatedAudioAutoGainEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(snapshot.mix_control.translated_audio_auto_gain_enabled),
        original_audio_gain_db: config
            .pointer("/devices/inboundRoute/mixControl/originalAudioGainDb")
            .and_then(Value::as_f64)
            .map(|value| value as f32)
            .unwrap_or(snapshot.mix_control.original_audio_gain_db),
        ducking_enabled: config
            .pointer("/devices/inboundRoute/mixControl/duckingEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(snapshot.mix_control.ducking_enabled),
        ducking_depth_percent: config
            .pointer("/devices/inboundRoute/mixControl/duckingDepthPercent")
            .and_then(Value::as_u64)
            .unwrap_or(snapshot.mix_control.ducking_depth_percent),
        monitor_mode: extract_driver_string(
            config,
            "/devices/inboundRoute/mixControl/monitorMode",
            &snapshot.mix_control.monitor_mode,
        ),
    };
    snapshot.expected_driver_version = extract_driver_string(
        config,
        "/driver/expectedDriverVersion",
        &snapshot.expected_driver_version,
    );
    snapshot.expected_bridge_version = extract_driver_string(
        config,
        "/driver/expectedBridgeVersion",
        &snapshot.expected_bridge_version,
    );
    reconcile_bridge_snapshot(snapshot);
}

fn record_driver_operation_error(state: &BridgeStateStore, error: &str) {
    state.update_snapshot(|current| {
        current.install_phase = "rollback-required".to_string();
        current.last_error_code = Some(
            error
                .split(':')
                .next()
                .unwrap_or("driver.operation-failed")
                .to_string(),
        );
        current.driver_detail = Some(error.to_string());
        let log_path = error
            .split("[logPath=")
            .nth(1)
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or_default()
            .to_string();
        if !log_path.is_empty() {
            current.last_driver_operation = Some(super::contracts::DriverOperationResult {
                schema_version: 1,
                operation_id: error
                    .split("[operationId=")
                    .nth(1)
                    .and_then(|value| value.split(']').next())
                    .unwrap_or("failed")
                    .to_string(),
                action: "failed".to_string(),
                succeeded: false,
                phase: "failed".to_string(),
                error_code: current.last_error_code.clone(),
                summary: error.to_string(),
                log_path,
                started_at: now_unix_seconds_marker(),
                finished_at: now_unix_seconds_marker(),
            });
        }
        reconcile_bridge_snapshot(current);
    });
}

/// Run an elevated driver operation, recording the failure into bridge state
/// before propagating it. Shared by install/uninstall/repair, which each ran
/// this record-and-return sequence identically apart from the action name.
fn run_elevated_driver_operation_or_record(
    snapshot: &BridgeRuntimeSnapshot,
    bridge_state: &BridgeStateStore,
    action: &str,
) -> Result<super::contracts::DriverOperationResult, String> {
    run_elevated_driver_operation(snapshot, action).map_err(|error| {
        record_driver_operation_error(bridge_state, &error);
        error
    })
}

fn record_bridge_start_error(state: &BridgeStateStore, error_code: &str, detail: String) {
    state.update_snapshot(|current| {
        current.process_status = "error".to_string();
        current.bridge_state = "degraded".to_string();
        current.lifecycle_state = "error".to_string();
        current.install_phase = "rollback-required".to_string();
        current.last_error_code = Some(error_code.to_string());
        current.driver_detail = Some(detail);
        reconcile_bridge_snapshot(current);
    });
}

fn driver_signature_preflight_error(
    probe: &super::contracts::DriverProbeResult,
    repair: bool,
) -> Option<String> {
    if probe.signature_enforcement_bypassed && probe.memory_integrity_enabled {
        return Some(
            "driver.memory-integrity-enabled: 使用临时禁用驱动程序签名强制时，请先关闭 Windows 安全中心 > 设备安全性 > 内核隔离 > 内存完整性，重启后再次选择临时禁用签名强制。"
                .to_string(),
        );
    }

    if !probe.test_signing_enabled && !probe.signature_enforcement_bypassed {
        return Some(if probe.secure_boot_enabled == Some(true) {
            "driver.secure-boot-enabled: Secure Boot 已开启。请先在 BIOS/UEFI 中关闭 Secure Boot，再以管理员 PowerShell 运行 .\\scripts\\installer\\enable-test-signing.ps1 并重启 Windows。".to_string()
        } else if repair {
            "driver.testsigning-disabled: 请启用 TESTSIGNING 并重启 Windows 后再重新安装驱动。"
                .to_string()
        } else {
            "driver.testsigning-disabled: 请以管理员 PowerShell 运行 .\\scripts\\installer\\enable-test-signing.ps1，启用 TESTSIGNING 后重启 Windows，再次点击安装。".to_string()
        });
    }

    None
}

fn fail_driver_preflight<R: tauri::Runtime>(
    app: &AppHandle<R>,
    runtime_state: &RuntimeStateStore,
    bridge_state: &BridgeStateStore,
    error: String,
) -> Result<RuntimeSnapshot, String> {
    record_driver_operation_error(bridge_state, &error);
    let _ = emit_runtime_snapshot(app, runtime_state);
    Err(error)
}

fn build_started_process(snapshot: &BridgeRuntimeSnapshot) -> Result<std::process::Child, String> {
    let cli_path = bridge_cli_path();
    if !cli_path.exists() {
        return Err(format!(
            "Bridge Service 构建产物不存在，请先执行 npm run build:bridge-service-native。missing={}.",
            cli_path.display()
        ));
    }

    /*
        return Err(
            "系统未安装 Node.js，Bridge 服务需要 Node.js 运行环境。请安装 Node.js 后重试。"
                .to_string(),
        );
    */

    Command::new(&cli_path)
        .arg("--pipe-name")
        .arg(&snapshot.pipe_name)
        .arg("--runtime-root")
        .arg(&snapshot.runtime_root)
        .arg("--bridge-version")
        .arg(&snapshot.expected_bridge_version)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Node.js 进程: {}", error))
}

/// Returns true when the cached driver state is stale or unhealthy enough
/// to warrant a full driver probe. On startup refresh, healthy cached state
/// (driver_health=running, no errors) skips the expensive probe_driver call.
fn should_probe_driver_on_startup_refresh(snapshot: &BridgeRuntimeSnapshot) -> bool {
    // Process loopback is a driver-independent capture backend. Refreshing an
    // active process-exclusion route must never launch the virtual-driver
    // PowerShell probe, even when the cached driver fields are unknown, stale,
    // or report a previous driver error.
    if snapshot.source_capture_mode == SourceCaptureMode::ProcessExclusion {
        return false;
    }

    if snapshot.driver_health == "not-installed"
        || snapshot.driver_health == "version-mismatch"
        || snapshot.driver_health == "unknown"
        || snapshot.driver_probe_state == "failed"
        || snapshot.driver_probe_state == "idle"
        || snapshot
            .last_error_code
            .as_deref()
            .map(|code| code.starts_with("driver."))
            .unwrap_or(false)
    {
        return true;
    }

    // Check if the cached driver state file is missing or stale (>5 min).
    let state_path = Path::new(&snapshot.runtime_root).join("driver-install-state.json");
    let stale = match std::fs::metadata(&state_path) {
        Ok(meta) => {
            let age = SystemTime::now()
                .duration_since(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH))
                .unwrap_or_default();
            age > DRIVER_STATE_STALE_THRESHOLD
        }
        Err(_) => true,
    };
    if stale {
        return true;
    }

    false
}

fn should_probe_bridge_pipe_on_refresh(snapshot: &BridgeRuntimeSnapshot) -> bool {
    snapshot.process_status == "running"
        || snapshot.driver_health == "running"
        || snapshot.ioctl_available
        || snapshot.bridge_state == "degraded"
        || snapshot
            .last_error_code
            .as_deref()
            .map(|code| code.starts_with("bridge."))
            .unwrap_or(false)
}

fn should_report_bridge_query_failure(snapshot: &BridgeRuntimeSnapshot) -> bool {
    snapshot.process_status == "running"
        || snapshot.bridge_state == "degraded"
        || snapshot
            .last_error_code
            .as_deref()
            .map(|code| code.starts_with("bridge."))
            .unwrap_or(false)
}

fn should_use_full_bridge_pipe_query(snapshot: &BridgeRuntimeSnapshot) -> bool {
    snapshot.process_status == "running" && snapshot.session_id.is_some()
}

fn launch_bridge_process<R: tauri::Runtime>(
    snapshot: &BridgeRuntimeSnapshot,
    bridge_state: &BridgeStateStore,
    app: &AppHandle<R>,
) -> Result<(), String> {
    cleanup_existing_bridge_process(snapshot, bridge_state)?;
    BridgeProcessSupervisor::new(snapshot).ensure_runtime_root()?;
    bridge_state.update_snapshot(|current| *current = snapshot.clone());

    let mut child = build_started_process(snapshot)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stderr_lines = Arc::new(Mutex::new(VecDeque::<String>::new()));

    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    if let Some(stdout) = stdout {
        let ready_tx_clone: std::sync::mpsc::Sender<Result<String, String>> = ready_tx.clone();
        thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if line.contains("bridge-service.ready") {
                    let _ = ready_tx_clone.send(Ok(line));
                    return;
                }
            }
        });
    }
    if let Some(stderr) = stderr {
        let stderr_lines = Arc::clone(&stderr_lines);
        let app_handle = app.clone();
        thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut lines) = stderr_lines.lock() {
                    if lines.len() >= BRIDGE_STDERR_MAX_LINES {
                        lines.pop_front();
                    }
                    lines.push_back(line.clone());
                }
                // Persist instead of accumulating: after the bridge eprintln
                // consolidation, stderr output is exceptional and every line
                // is worth a diagnostics record.
                let _ = append_diagnostics_log_quiet(
                    &app_handle,
                    "bridge",
                    "warning",
                    format!("bridge-service stderr: {line}"),
                    None,
                    Some(format!("{}:{}", file!(), line!())),
                    None,
                );
            }
        });
    }

    let ready_received = ready_rx.recv_timeout(BRIDGE_STARTUP_TIMEOUT).is_ok();

    if !ready_received {
        let _ = child.kill();
        let _ = child.wait();
        thread::sleep(Duration::from_millis(BRIDGE_POST_KILL_SETTLE_MS));
        let stderr_output = stderr_lines
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();

        if !stderr_output.is_empty() {
            log_bridge_event(
                app,
                "error",
                "Bridge Service 启动失败，stderr 输出:",
                Some(stderr_output.clone()),
            );
        }

        log_bridge_event(
            app,
            "warning",
            "Bridge Service 未在预期时间内返回就绪信号。",
            Some(format!("timeoutMs={}", BRIDGE_STARTUP_TIMEOUT.as_millis())),
        );
        record_bridge_start_error(
            bridge_state,
            "bridge.start-timeout",
            format!(
                "Bridge Service startup timed out after {} seconds.{}",
                BRIDGE_STARTUP_TIMEOUT.as_secs(),
                if stderr_output.is_empty() {
                    String::new()
                } else {
                    format!(
                        " stderr: {}",
                        &stderr_output[..stderr_output.len().min(500)]
                    )
                }
            ),
        );
        return Err(format!(
            "Bridge Service 未在 {} 秒内就绪。{}",
            BRIDGE_STARTUP_TIMEOUT.as_secs(),
            if stderr_output.is_empty() {
                String::new()
            } else {
                format!(
                    " stderr: {}",
                    &stderr_output[..stderr_output.len().min(500)]
                )
            }
        ));
    }

    bridge_state.set_process(child);
    Ok(())
}

include!("events/capability.rs");
include!("events/playback_ownership.rs");
include!("events/lifecycle.rs");

// `(async)` runs the IPC path off the main thread so blocking driver probing
// cannot starve the event loop. The plain fn stays callable by `bridge_v2`.
pub(crate) fn refresh_bridge_runtime<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    let _lifecycle_operation = bridge_state.lock_lifecycle_operation();
    let t0 = Instant::now();
    let snapshot = bridge_state.snapshot();
    log_debug!(
        &app,
        "bridge",
        "refresh_bridge_runtime 开始",
        format!(
            "processStatus={} bridgeState={}",
            snapshot.process_status, snapshot.bridge_state
        )
    );
    let skip_probe = !should_probe_driver_on_startup_refresh(&snapshot);
    if skip_probe {
        log_debug!(
            &app,
            "bridge",
            "refresh_bridge_runtime skipping driver probe (cached healthy state)",
            format!("driverHealth={}", snapshot.driver_health)
        );
        bridge_state.update_snapshot(|current| {
            current.driver_probe_state = "cached".to_string();
        });
        emit_runtime_snapshot(&app, &runtime_state).map_err(|error| error.to_string())?;
    } else {
        bridge_state.update_snapshot(|current| {
            current.driver_probe_state = "probing".to_string();
        });
        emit_runtime_snapshot(&app, &runtime_state).map_err(|error| error.to_string())?;
    }
    if !skip_probe {
        let probe_result = probe_driver(&snapshot, false);
        bridge_state.update_snapshot(|current| match probe_result {
            Ok(probe) => apply_driver_probe(current, probe),
            Err(error) => {
                current.driver_probe_state = "failed".to_string();
                current.last_error_code = Some("driver.probe-failed".to_string());
                current.driver_detail = Some(error);
            }
        });
    }
    let snapshot = bridge_state.snapshot();
    if should_probe_bridge_pipe_on_refresh(&snapshot) {
        let query_result = BridgeIpcClient::new(&snapshot)
            .query_state(!should_use_full_bridge_pipe_query(&snapshot));
        match query_result {
            Ok(query) => {
                log_info!(
                    &app,
                    "bridge",
                    "query_state 成功",
                    format!(
                        "driverHealth={} bridgeState={}",
                        query.driver_health, query.bridge_state
                    ),
                    t0.elapsed().as_millis()
                );
                bridge_state.update_snapshot(|current| apply_query(current, query));
            }
            Err(error) => {
                if !should_report_bridge_query_failure(&snapshot) {
                    log_debug!(
                        &app,
                        "bridge",
                        "query_state skipped missing idle bridge",
                        format!("pipe={} error={}", snapshot.pipe_path, error)
                    );
                    emit_runtime_snapshot(&app, &runtime_state)
                        .map_err(|error| error.to_string())?;
                    return Ok(build_runtime_snapshot(&app, &runtime_state));
                }
                log_error!(
                    &app,
                    "bridge",
                    "query_state 失败",
                    format!("pipe={} error={}", snapshot.pipe_path, error),
                    t0.elapsed().as_millis()
                );
                bridge_state.update_snapshot(|current| {
                    current.process_status = "error".to_string();
                    current.bridge_state = "degraded".to_string();
                    current.lifecycle_state = "error".to_string();
                    current.last_error_code = Some("bridge.timeout".to_string());
                    current.recommended_action = Some("restart-bridge".to_string());
                    current.status = "warning".to_string();
                });
                emit_runtime_notification(
                    &app,
                    &runtime_state,
                    RuntimeNotification::warning(
                        "bridge-refresh-failed",
                        "bridge-runtime",
                        &error,
                        now_unix_seconds_marker(),
                    ),
                )
                .map_err(|emit_error| emit_error.to_string())?;
                log_bridge_event(&app, "warning", "Bridge 状态刷新失败。", Some(error));
            }
        }
    }

    emit_runtime_snapshot(&app, &runtime_state).map_err(|error| error.to_string())?;
    Ok(build_runtime_snapshot(&app, &runtime_state))
}

// `(async)` runs the IPC path off the main thread so blocking process launch
// cannot starve the event loop. The plain fn stays callable by `bridge_v2`.
#[tauri::command(async)]
pub(crate) fn start_bridge_service<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
    config: Value,
) -> Result<RuntimeSnapshot, String> {
    let _lifecycle_operation = bridge_state.lock_lifecycle_operation();
    start_bridge_service_serialized(app, runtime_state, bridge_state.clone(), config)
}

fn start_bridge_service_serialized<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
    config: Value,
) -> Result<RuntimeSnapshot, String> {
    let t0 = Instant::now();
    let mut snapshot = bridge_state.snapshot();
    apply_driver_config(&mut snapshot, &config);
    log_info!(
        &app,
        "bridge",
        "start_bridge_service 开始",
        format!(
            "runtimeRoot={} pipeName={}",
            snapshot.runtime_root, snapshot.pipe_name
        )
    );
    snapshot.session_id = Some(super::new_bridge_session_id());
    snapshot.process_status = "starting".to_string();
    snapshot.pipe_path = format!(r"\\.\pipe\{}", snapshot.pipe_name);
    if let Err(error) = start_bridge_from_snapshot(&snapshot, &bridge_state, &app) {
        let current_error = bridge_state.snapshot().last_error_code;
        if !current_error
            .as_deref()
            .map(|code| code.starts_with("bridge."))
            .unwrap_or(false)
        {
            record_bridge_start_error(&bridge_state, "bridge.start-failed", error.clone());
        }
        if let Err(emit_error) = emit_runtime_snapshot(&app, &runtime_state) {
            log_bridge_event(
                &app,
                "warning",
                "Bridge 启动失败状态无法同步到运行时快照。",
                Some(emit_error.to_string()),
            );
        }
        return Err(error);
    }
    log_info!(
        &app,
        "bridge",
        "Bridge Service 已启动",
        format!(
            "pipe={} session={}",
            snapshot.pipe_path,
            snapshot.session_id.as_deref().unwrap_or("-")
        ),
        t0.elapsed().as_millis()
    );
    emit_bridge_notification(
        &app,
        &runtime_state,
        "bridge-started",
        "Bridge Service 已启动并完成 Driver Bridge Contract 握手。",
    );
    Ok(build_runtime_snapshot(&app, &runtime_state))
}

pub(crate) fn stop_bridge_service<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    let _lifecycle_operation = bridge_state.lock_lifecycle_operation();
    stop_bridge_service_serialized(app, runtime_state, bridge_state.clone())
}

fn stop_bridge_service_serialized<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    let snapshot = bridge_state.snapshot();
    cleanup_existing_bridge_process(&snapshot, &bridge_state)?;
    release_desktop_playback_ownership(&app);

    bridge_state.update_snapshot(|current| {
        current.process_status = "stopped".to_string();
        current.bridge_state = "stopped".to_string();
        current.lifecycle_state = "stopped".to_string();
        current.session_id = None;
        current.install_phase = if current.driver_health == "running" {
            "ready".to_string()
        } else {
            current.install_phase.clone()
        };
        reconcile_bridge_snapshot(current);
    });
    log_bridge_event(&app, "info", "Bridge Service 已停止。", None);

    emit_runtime_notification(
        &app,
        &runtime_state,
        RuntimeNotification::info(
            "bridge-stopped",
            "bridge-runtime",
            "Bridge Service 已停止。",
            now_unix_seconds_marker(),
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(build_runtime_snapshot(&app, &runtime_state))
}

pub(crate) fn install_driver_runtime<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
    config: Value,
) -> Result<RuntimeSnapshot, String> {
    let _lifecycle_operation = bridge_state.lock_lifecycle_operation();
    let mut snapshot = bridge_state.snapshot();
    cleanup_existing_bridge_process(&snapshot, &bridge_state)?;
    apply_driver_config(&mut snapshot, &config);
    log_bridge_event(
        &app,
        "info",
        "收到驱动安装命令。",
        Some(format!(
            "runtimeRoot={} driverVersion={} bridgeVersion={}",
            snapshot.runtime_root,
            snapshot.expected_driver_version,
            snapshot.expected_bridge_version
        )),
    );
    snapshot.install_phase = "installing-driver".to_string();
    bridge_state.update_snapshot(|current| *current = snapshot.clone());

    let probe = probe_driver(&snapshot, false)?;
    bridge_state.update_snapshot(|current| apply_driver_probe(current, probe.clone()));
    if let Some(error) = driver_signature_preflight_error(&probe, false) {
        return fail_driver_preflight(&app, &runtime_state, &bridge_state, error);
    }
    bridge_state
        .update_snapshot(|current| current.install_phase = "waiting-for-elevation".to_string());
    let operation = run_elevated_driver_operation_or_record(&snapshot, &bridge_state, "install")?;
    bridge_state.update_snapshot(|current| {
        *current = snapshot.clone();
        current.last_driver_operation = Some(operation.clone());
        current.install_phase = "starting-bridge".to_string();
    });
    verify_post_operation_driver_probe(&bridge_state)?;

    let mut started = bridge_state.snapshot();
    started.session_id = Some(super::new_bridge_session_id());
    started.process_status = "starting".to_string();
    start_bridge_from_snapshot(&started, &bridge_state, &app)?;
    bridge_state.update_snapshot(|current| current.install_phase = "ready".to_string());
    log_bridge_event(
        &app,
        "info",
        "开发通道驱动安装与 Bridge 握手完成。",
        Some(snapshot.runtime_root.clone()),
    );

    emit_bridge_notification(
        &app,
        &runtime_state,
        "driver-installed",
        "开发通道驱动资产、Bridge Service 和握手校验已完成。",
    );
    Ok(build_runtime_snapshot(&app, &runtime_state))
}

pub(crate) fn uninstall_driver_runtime<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    let _lifecycle_operation = bridge_state.lock_lifecycle_operation();
    let snapshot = bridge_state.snapshot();
    log_bridge_event(
        &app,
        "info",
        "收到驱动卸载命令。",
        Some(format!("runtimeRoot={}", snapshot.runtime_root)),
    );
    cleanup_existing_bridge_process(&snapshot, &bridge_state)?;
    release_desktop_playback_ownership(&app);
    bridge_state
        .update_snapshot(|current| current.install_phase = "waiting-for-elevation".to_string());
    let operation = run_elevated_driver_operation_or_record(&snapshot, &bridge_state, "uninstall")?;
    bridge_state.update_snapshot(|current| {
        current.process_status = "stopped".to_string();
        current.bridge_state = "stopped".to_string();
        current.lifecycle_state = "idle".to_string();
        current.driver_health = "not-installed".to_string();
        current.driver_version = None;
        current.install_phase = "planned".to_string();
        current.session_id = None;
        current.last_error_code = Some("driver.not-installed".to_string());
        current.last_driver_operation = Some(operation.clone());
        reconcile_bridge_snapshot(current);
    });
    verify_post_operation_driver_probe(&bridge_state)?;
    log_bridge_event(
        &app,
        "info",
        "开发通道驱动已卸载。",
        Some(snapshot.runtime_root),
    );

    emit_bridge_notification(
        &app,
        &runtime_state,
        "driver-uninstalled",
        "开发通道驱动资产与 Bridge Service 已卸载。",
    );
    Ok(build_runtime_snapshot(&app, &runtime_state))
}

pub(crate) fn repair_driver_runtime<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
    config: Value,
    action: String,
) -> Result<RuntimeSnapshot, String> {
    let _lifecycle_operation = bridge_state.lock_lifecycle_operation();
    if action == "restart-bridge" {
        let _ = stop_bridge_service_serialized(
            app.clone(),
            runtime_state.clone(),
            bridge_state.clone(),
        )?;
        return start_bridge_service_serialized(app, runtime_state, bridge_state.clone(), config);
    }

    let mut snapshot = bridge_state.snapshot();
    apply_driver_config(&mut snapshot, &config);
    log_bridge_event(
        &app,
        "info",
        "收到驱动修复命令。",
        Some(format!(
            "action={} runtimeRoot={}",
            action, snapshot.runtime_root
        )),
    );
    snapshot.install_phase = "verifying".to_string();
    cleanup_existing_bridge_process(&snapshot, &bridge_state)?;
    let probe = probe_driver(&snapshot, false)?;
    bridge_state.update_snapshot(|current| apply_driver_probe(current, probe.clone()));
    if let Some(error) = driver_signature_preflight_error(&probe, true) {
        return fail_driver_preflight(&app, &runtime_state, &bridge_state, error);
    }
    bridge_state
        .update_snapshot(|current| current.install_phase = "waiting-for-elevation".to_string());
    let elevated_action = "reinstall";
    let operation =
        run_elevated_driver_operation_or_record(&snapshot, &bridge_state, elevated_action)?;
    bridge_state.update_snapshot(|current| {
        *current = snapshot.clone();
        current.last_driver_operation = Some(operation.clone());
    });
    verify_post_operation_driver_probe(&bridge_state)?;

    let mut restarted = bridge_state.snapshot();
    restarted.session_id = Some(super::new_bridge_session_id());
    restarted.process_status = "starting".to_string();
    start_bridge_from_snapshot(&restarted, &bridge_state, &app)?;
    bridge_state.update_snapshot(|current| current.install_phase = "ready".to_string());
    log_bridge_event(
        &app,
        "info",
        format!("已执行驱动修复动作：{}。", action),
        Some(snapshot.runtime_root.clone()),
    );

    emit_bridge_notification(
        &app,
        &runtime_state,
        "driver-repaired",
        "驱动修复链路已执行，并重新完成 Bridge 握手。",
    );
    Ok(build_runtime_snapshot(&app, &runtime_state))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_driver_config, process_loopback_probe_launch_snapshot,
        process_loopback_probe_uses_active_route_health,
        run_bridge_start_with_playback_ownership, should_probe_driver_on_startup_refresh,
    };
    use crate::audio::state::AudioStateStore;
    use crate::bridge::contracts::{
        BridgeRuntimeSnapshot, CaptureBackend, SourceCaptureMode,
    };
    use crate::bridge::state::BridgeStateStore;
    use serde_json::json;
    use std::sync::mpsc;
    use std::sync::TryLockError;
    use std::thread;
    use std::time::Duration;
    use tauri::Manager;

    type MockApp = tauri::App<tauri::test::MockRuntime>;
    type MockAppHandle = tauri::AppHandle<tauri::test::MockRuntime>;

    const CONCURRENCY_TEST_TIMEOUT: Duration = Duration::from_secs(2);

    fn lifecycle_test_app() -> MockApp {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock lifecycle app should build");
        app.manage(AudioStateStore::new());
        app.manage(BridgeStateStore::new());
        app
    }

    fn route_snapshot(mode: SourceCaptureMode) -> BridgeRuntimeSnapshot {
        BridgeRuntimeSnapshot {
            process_status: "starting".to_string(),
            source_capture_mode: mode,
            capture_backend: match mode {
                SourceCaptureMode::None => CaptureBackend::None,
                SourceCaptureMode::VirtualDriver => CaptureBackend::DriverVirtualSpeaker,
                SourceCaptureMode::ProcessExclusion => CaptureBackend::WasapiProcessExclusion,
            },
            ..Default::default()
        }
    }

    fn commit_started_route(bridge_state: &BridgeStateStore, mode: SourceCaptureMode) {
        bridge_state.update_snapshot(|current| {
            current.process_status = "running".to_string();
            current.bridge_state = "running".to_string();
            current.lifecycle_state = "ready".to_string();
            current.source_capture_mode = mode;
            current.capture_backend = match mode {
                SourceCaptureMode::None => CaptureBackend::None,
                SourceCaptureMode::VirtualDriver => CaptureBackend::DriverVirtualSpeaker,
                SourceCaptureMode::ProcessExclusion => CaptureBackend::WasapiProcessExclusion,
            };
        });
    }

    fn simulated_start(
        app: MockAppHandle,
        mode: SourceCaptureMode,
        attempting: mpsc::Sender<()>,
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> Result<(), String> {
        let bridge_state = app.state::<BridgeStateStore>();
        attempting.send(()).unwrap();
        let _operation = bridge_state.lock_lifecycle_operation();
        let snapshot = route_snapshot(mode);
        run_bridge_start_with_playback_ownership(&snapshot, &bridge_state, &app, || {
            entered.send(()).unwrap();
            release
                .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
                .map_err(|error| error.to_string())?;
            commit_started_route(&bridge_state, mode);
            Ok(())
        })
    }

    fn simulated_stop(
        app: MockAppHandle,
        attempting: mpsc::Sender<()>,
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> Result<(), String> {
        let bridge_state = app.state::<BridgeStateStore>();
        attempting.send(()).unwrap();
        let _operation = bridge_state.lock_lifecycle_operation();
        entered.send(()).unwrap();
        release
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .map_err(|error| error.to_string())?;
        bridge_state.update_snapshot(|current| {
            current.process_status = "stopped".to_string();
            current.bridge_state = "stopped".to_string();
            current.lifecycle_state = "stopped".to_string();
            current.source_capture_mode = SourceCaptureMode::None;
            current.capture_backend = CaptureBackend::None;
        });
        app.state::<AudioStateStore>()
            .desktop_playback_ownership()
            .release_to_desktop();
        Ok(())
    }

    fn assert_second_operation_is_blocked(
        attempting: &mpsc::Receiver<()>,
        entered: &mpsc::Receiver<()>,
    ) {
        attempting
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .expect("second lifecycle operation should reach the native gate");
        assert!(matches!(
            entered.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }

    #[test]
    fn lifecycle_gate_reports_would_block_while_an_operation_owns_it() {
        let bridge_state = BridgeStateStore::new();
        let _operation = bridge_state.lock_lifecycle_operation();
        assert!(matches!(
            bridge_state.try_lock_lifecycle_operation(),
            Err(TryLockError::WouldBlock)
        ));
    }

    #[test]
    fn process_exclusion_refresh_never_probes_the_virtual_driver() {
        let snapshot = BridgeRuntimeSnapshot {
            source_capture_mode: SourceCaptureMode::ProcessExclusion,
            driver_health: "unknown".to_string(),
            driver_probe_state: "failed".to_string(),
            last_error_code: Some("driver.probe-failed".to_string()),
            runtime_root: "definitely-missing-process-loopback-runtime-root".to_string(),
            ..Default::default()
        };

        assert!(!should_probe_driver_on_startup_refresh(&snapshot));
    }

    #[test]
    fn proactive_process_loopback_probe_launch_is_neutral_and_preserves_driver_evidence() {
        let snapshot = BridgeRuntimeSnapshot {
            process_status: "stopped".to_string(),
            driver_health: "running".to_string(),
            driver_version: Some("0.10.0-dev".to_string()),
            source_capture_mode: SourceCaptureMode::VirtualDriver,
            capture_backend: CaptureBackend::DriverVirtualSpeaker,
            source_generation: 22,
            source_subscriber_active: true,
            monitor_playback_enabled: true,
            translation_playback_enabled: true,
            session_id: Some("old-session".to_string()),
            ..Default::default()
        };

        let neutral = process_loopback_probe_launch_snapshot(&snapshot);

        assert_eq!(neutral.process_status, "starting");
        assert_eq!(neutral.source_capture_mode, SourceCaptureMode::None);
        assert_eq!(neutral.capture_backend, CaptureBackend::None);
        assert_eq!(neutral.session_id, None);
        assert!(!neutral.monitor_playback_enabled);
        assert!(!neutral.source_monitor_playback_enabled);
        assert!(!neutral.translation_playback_enabled);
        assert_eq!(neutral.driver_health, "running");
        assert_eq!(neutral.driver_version.as_deref(), Some("0.10.0-dev"));
        assert_eq!(neutral.source_generation, 22);
        assert!(!neutral.source_subscriber_active);
    }

    #[test]
    fn proactive_probe_does_not_publish_probing_over_active_process_route_health() {
        let active = BridgeRuntimeSnapshot {
            process_status: "running".to_string(),
            source_capture_mode: SourceCaptureMode::ProcessExclusion,
            capture_backend: CaptureBackend::WasapiProcessExclusion,
            ..Default::default()
        };
        assert!(process_loopback_probe_uses_active_route_health(&active));

        let stopped = BridgeRuntimeSnapshot {
            process_status: "stopped".to_string(),
            source_capture_mode: SourceCaptureMode::ProcessExclusion,
            ..Default::default()
        };
        assert!(!process_loopback_probe_uses_active_route_health(&stopped));

        let virtual_driver = BridgeRuntimeSnapshot {
            process_status: "running".to_string(),
            source_capture_mode: SourceCaptureMode::VirtualDriver,
            ..Default::default()
        };
        assert!(!process_loopback_probe_uses_active_route_health(
            &virtual_driver
        ));
    }

    #[test]
    fn virtual_driver_refresh_keeps_existing_probe_behavior() {
        let snapshot = BridgeRuntimeSnapshot {
            source_capture_mode: SourceCaptureMode::VirtualDriver,
            driver_health: "unknown".to_string(),
            ..Default::default()
        };

        assert!(should_probe_driver_on_startup_refresh(&snapshot));
    }

    #[test]
    fn virtual_driver_initialization_enables_its_bridge_translation_player() {
        let mut snapshot = BridgeRuntimeSnapshot::default();

        apply_driver_config(
            &mut snapshot,
            &json!({
                "devices": {
                    "feedbackLoopPrevention": "virtual-driver",
                    "outputDeviceId": "speaker-default"
                },
                "speech": { "localPlaybackEnabled": true }
            }),
        );

        assert_eq!(snapshot.source_capture_mode, SourceCaptureMode::VirtualDriver);
        assert!(snapshot.monitor_playback_enabled);
        assert!(snapshot.translation_playback_enabled);
        assert_eq!(snapshot.physical_playback_device_id, "speaker-default");
    }

    #[test]
    fn neutral_bridge_does_not_claim_translation_playback() {
        let mut snapshot = BridgeRuntimeSnapshot::default();

        apply_driver_config(
            &mut snapshot,
            &json!({
                "devices": { "feedbackLoopPrevention": "none" },
                "speech": { "localPlaybackEnabled": true }
            }),
        );

        assert_eq!(snapshot.source_capture_mode, SourceCaptureMode::None);
        assert!(!snapshot.translation_playback_enabled);
    }

    #[test]
    fn lifecycle_gate_serializes_process_then_nonprocess_start_and_commits_one_owner() {
        let app = lifecycle_test_app();
        let (first_attempting_tx, first_attempting_rx) = mpsc::channel();
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (first_release_tx, first_release_rx) = mpsc::channel();
        let first_app = app.handle().clone();
        let first = thread::spawn(move || {
            simulated_start(
                first_app,
                SourceCaptureMode::ProcessExclusion,
                first_attempting_tx,
                first_entered_tx,
                first_release_rx,
            )
        });
        first_attempting_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();
        first_entered_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();

        let (second_attempting_tx, second_attempting_rx) = mpsc::channel();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let (second_release_tx, second_release_rx) = mpsc::channel();
        let second_app = app.handle().clone();
        let second = thread::spawn(move || {
            simulated_start(
                second_app,
                SourceCaptureMode::VirtualDriver,
                second_attempting_tx,
                second_entered_tx,
                second_release_rx,
            )
        });
        assert_second_operation_is_blocked(&second_attempting_rx, &second_entered_rx);

        first_release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second_entered_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();
        second_release_tx.send(()).unwrap();
        second.join().unwrap().unwrap();

        let snapshot = app.state::<BridgeStateStore>().snapshot();
        assert_eq!(snapshot.process_status, "running");
        assert_eq!(snapshot.source_capture_mode, SourceCaptureMode::VirtualDriver);
        assert_eq!(snapshot.capture_backend, CaptureBackend::DriverVirtualSpeaker);
        assert_eq!(
            app.state::<AudioStateStore>()
                .desktop_playback_ownership()
                .test_snapshot(),
            ("desktop", 3, 0)
        );
    }

    #[test]
    fn lifecycle_gate_serializes_nonprocess_then_process_start_and_keeps_desktop_closed() {
        let app = lifecycle_test_app();
        let (first_attempting_tx, first_attempting_rx) = mpsc::channel();
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (first_release_tx, first_release_rx) = mpsc::channel();
        let first_app = app.handle().clone();
        let first = thread::spawn(move || {
            simulated_start(
                first_app,
                SourceCaptureMode::VirtualDriver,
                first_attempting_tx,
                first_entered_tx,
                first_release_rx,
            )
        });
        first_attempting_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();
        first_entered_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();

        let (second_attempting_tx, second_attempting_rx) = mpsc::channel();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let (second_release_tx, second_release_rx) = mpsc::channel();
        let second_app = app.handle().clone();
        let second = thread::spawn(move || {
            simulated_start(
                second_app,
                SourceCaptureMode::ProcessExclusion,
                second_attempting_tx,
                second_entered_tx,
                second_release_rx,
            )
        });
        assert_second_operation_is_blocked(&second_attempting_rx, &second_entered_rx);

        first_release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second_entered_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();
        second_release_tx.send(()).unwrap();
        second.join().unwrap().unwrap();

        let snapshot = app.state::<BridgeStateStore>().snapshot();
        assert_eq!(snapshot.process_status, "running");
        assert_eq!(
            snapshot.source_capture_mode,
            SourceCaptureMode::ProcessExclusion
        );
        assert_eq!(
            snapshot.capture_backend,
            CaptureBackend::WasapiProcessExclusion
        );
        assert_eq!(
            app.state::<AudioStateStore>()
                .desktop_playback_ownership()
                .test_snapshot(),
            ("process-exclusion", 3, 0)
        );
    }

    #[test]
    fn lifecycle_gate_serializes_process_start_then_stop_and_releases_desktop_last() {
        let app = lifecycle_test_app();
        let (start_attempting_tx, start_attempting_rx) = mpsc::channel();
        let (start_entered_tx, start_entered_rx) = mpsc::channel();
        let (start_release_tx, start_release_rx) = mpsc::channel();
        let start_app = app.handle().clone();
        let start = thread::spawn(move || {
            simulated_start(
                start_app,
                SourceCaptureMode::ProcessExclusion,
                start_attempting_tx,
                start_entered_tx,
                start_release_rx,
            )
        });
        start_attempting_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();
        start_entered_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();

        let (stop_attempting_tx, stop_attempting_rx) = mpsc::channel();
        let (stop_entered_tx, stop_entered_rx) = mpsc::channel();
        let (stop_release_tx, stop_release_rx) = mpsc::channel();
        let stop_app = app.handle().clone();
        let stop = thread::spawn(move || {
            simulated_stop(
                stop_app,
                stop_attempting_tx,
                stop_entered_tx,
                stop_release_rx,
            )
        });
        assert_second_operation_is_blocked(&stop_attempting_rx, &stop_entered_rx);

        start_release_tx.send(()).unwrap();
        start.join().unwrap().unwrap();
        stop_entered_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .unwrap();
        stop_release_tx.send(()).unwrap();
        stop.join().unwrap().unwrap();

        let snapshot = app.state::<BridgeStateStore>().snapshot();
        assert_eq!(snapshot.process_status, "stopped");
        assert_eq!(snapshot.source_capture_mode, SourceCaptureMode::None);
        assert_eq!(snapshot.capture_backend, CaptureBackend::None);
        assert_eq!(
            app.state::<AudioStateStore>()
                .desktop_playback_ownership()
                .test_snapshot(),
            ("desktop", 3, 0)
        );
    }

    #[test]
    fn failed_process_start_keeps_desktop_playback_closed_without_fallback() {
        let app = lifecycle_test_app();
        let bridge_state = app.state::<BridgeStateStore>();
        let _operation = bridge_state.lock_lifecycle_operation();
        let snapshot = route_snapshot(SourceCaptureMode::ProcessExclusion);

        let error = run_bridge_start_with_playback_ownership(
            &snapshot,
            &bridge_state,
            app.handle(),
            || Err("injected-process-init-failure".to_string()),
        )
        .expect_err("failed process Init must not fall back to Desktop playback");

        assert_eq!(error, "injected-process-init-failure");
        assert_eq!(bridge_state.snapshot().source_capture_mode, SourceCaptureMode::None);
        assert_eq!(
            app.state::<AudioStateStore>()
                .desktop_playback_ownership()
                .test_snapshot(),
            ("process-exclusion", 2, 0)
        );
    }
}
