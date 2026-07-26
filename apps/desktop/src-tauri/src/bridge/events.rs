use std::collections::VecDeque;
use std::io::BufRead;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::diagnostics::events::append_diagnostics_log_quiet;
use crate::log_debug;
use crate::log_error;
use crate::log_info;
use crate::runtime::contracts::{RuntimeNotification, RuntimeSnapshot};
use crate::runtime::events::{
    build_runtime_snapshot, emit_runtime_notification, emit_runtime_snapshot,
};
use crate::runtime::state::{now_marker, RuntimeStateStore};

use super::contracts::{reconcile_bridge_snapshot, BridgeMixControl, BridgeRuntimeSnapshot};
use super::installer::{apply_driver_probe, probe_driver, run_elevated_driver_operation};
use super::ipc::{apply_query, bridge_cli_path, BridgeIpcClient, BridgeProcessSupervisor};
use super::state::BridgeStateStore;

const DRIVER_STATE_STALE_THRESHOLD: Duration = Duration::from_secs(300);
const BRIDGE_STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
const BRIDGE_POST_KILL_SETTLE_MS: u64 = 50;
/// Upper bound of bridge stderr lines kept in memory for the startup-failure
/// report; older lines are evicted, and every line is persisted to the
/// diagnostics log instead of accumulating without bound.
const BRIDGE_STDERR_MAX_LINES: usize = 200;

fn extract_driver_string(config: &Value, pointer: &str, default: &str) -> String {
    config
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

fn apply_driver_config(snapshot: &mut BridgeRuntimeSnapshot, config: &Value) {
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
    snapshot.monitor_playback_enabled = config
        .pointer("/speech/localPlaybackEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(snapshot.monitor_playback_enabled);
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
                started_at: now_marker(),
                finished_at: now_marker(),
            });
        }
        reconcile_bridge_snapshot(current);
    });
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

fn fail_driver_preflight(
    app: &AppHandle,
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

fn stop_existing_process(state: &BridgeStateStore) {
    if let Some(mut process) = state.take_process() {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
}

fn cleanup_existing_bridge_process(
    snapshot: &BridgeRuntimeSnapshot,
    state: &BridgeStateStore,
) -> Result<(), String> {
    stop_existing_process(state);
    let _ = BridgeIpcClient::new(snapshot).stop();
    thread::sleep(Duration::from_millis(150));
    BridgeProcessSupervisor::new(snapshot).terminate_stale()
}

/// Returns true when the cached driver state is stale or unhealthy enough
/// to warrant a full driver probe. On startup refresh, healthy cached state
/// (driver_health=running, no errors) skips the expensive probe_driver call.
fn should_probe_driver_on_startup_refresh(snapshot: &BridgeRuntimeSnapshot) -> bool {
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

fn start_bridge_from_snapshot(
    snapshot: &BridgeRuntimeSnapshot,
    bridge_state: &BridgeStateStore,
    app: &AppHandle,
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
    let initialized = BridgeIpcClient::new(snapshot).initialize()?;
    bridge_state.update_snapshot(|current| *current = initialized);
    Ok(())
}

fn emit_bridge_notification(
    app: &AppHandle,
    runtime_state: &RuntimeStateStore,
    id: &str,
    message: &str,
) {
    if let Err(error) = emit_runtime_notification(
        app,
        runtime_state,
        RuntimeNotification::info(id, "bridge-runtime", message, now_marker()),
    ) {
        log_bridge_event(
            app,
            "warning",
            "Bridge runtime notification emit failed.",
            Some(format!("id={id} error={error}")),
        );
    }
}

fn log_bridge_event(
    app: &AppHandle,
    level: &str,
    summary: impl Into<String>,
    detail: Option<String>,
) {
    let _ = append_diagnostics_log_quiet(app, "bridge", level, summary, detail, None, None);
}

#[tauri::command]
pub fn get_bridge_runtime_snapshot(
    state: State<'_, BridgeStateStore>,
) -> super::contracts::BridgeRuntimeSnapshot {
    state.snapshot()
}

// `(async)` runs the IPC path off the main thread so blocking driver probing
// cannot starve the event loop. The plain fn stays callable by `bridge_v2`.
#[tauri::command(async)]
pub fn refresh_bridge_runtime(
    app: AppHandle,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
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
                        now_marker(),
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
pub fn start_bridge_service(
    app: AppHandle,
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

#[tauri::command]
pub fn stop_bridge_service(
    app: AppHandle,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    let snapshot = bridge_state.snapshot();
    cleanup_existing_bridge_process(&snapshot, &bridge_state)?;

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
            now_marker(),
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(build_runtime_snapshot(&app, &runtime_state))
}

#[tauri::command]
pub fn install_driver_runtime(
    app: AppHandle,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
    config: Value,
) -> Result<RuntimeSnapshot, String> {
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
    let operation = match run_elevated_driver_operation(&snapshot, "install") {
        Ok(operation) => operation,
        Err(error) => {
            record_driver_operation_error(&bridge_state, &error);
            return Err(error);
        }
    };
    bridge_state.update_snapshot(|current| {
        *current = snapshot.clone();
        current.last_driver_operation = Some(operation.clone());
        current.install_phase = "starting-bridge".to_string();
    });
    if let Ok(probe) = probe_driver(&bridge_state.snapshot(), false) {
        bridge_state.update_snapshot(|current| apply_driver_probe(current, probe));
    }

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

#[tauri::command]
pub fn uninstall_driver_runtime(
    app: AppHandle,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    let snapshot = bridge_state.snapshot();
    log_bridge_event(
        &app,
        "info",
        "收到驱动卸载命令。",
        Some(format!("runtimeRoot={}", snapshot.runtime_root)),
    );
    cleanup_existing_bridge_process(&snapshot, &bridge_state)?;
    bridge_state
        .update_snapshot(|current| current.install_phase = "waiting-for-elevation".to_string());
    let operation = match run_elevated_driver_operation(&snapshot, "uninstall") {
        Ok(operation) => operation,
        Err(error) => {
            record_driver_operation_error(&bridge_state, &error);
            return Err(error);
        }
    };
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
    if let Ok(probe) = probe_driver(&bridge_state.snapshot(), false) {
        bridge_state.update_snapshot(|current| apply_driver_probe(current, probe));
    }
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

#[tauri::command]
pub fn repair_driver_runtime(
    app: AppHandle,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
    config: Value,
    action: String,
) -> Result<RuntimeSnapshot, String> {
    if action == "restart-bridge" {
        let _ = stop_bridge_service(app.clone(), runtime_state.clone(), bridge_state.clone())?;
        return start_bridge_service(app, runtime_state, bridge_state, config);
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
    let operation = match run_elevated_driver_operation(&snapshot, elevated_action) {
        Ok(operation) => operation,
        Err(error) => {
            record_driver_operation_error(&bridge_state, &error);
            return Err(error);
        }
    };
    bridge_state.update_snapshot(|current| {
        *current = snapshot.clone();
        current.last_driver_operation = Some(operation.clone());
    });
    if let Ok(probe) = probe_driver(&bridge_state.snapshot(), false) {
        bridge_state.update_snapshot(|current| apply_driver_probe(current, probe));
    }

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
