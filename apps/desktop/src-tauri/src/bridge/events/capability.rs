fn emit_bridge_notification<R: tauri::Runtime>(
    app: &AppHandle<R>,
    runtime_state: &RuntimeStateStore,
    id: &str,
    message: &str,
) {
    if let Err(error) = emit_runtime_notification(
        app,
        runtime_state,
        RuntimeNotification::info(id, "bridge-runtime", message, now_unix_seconds_marker()),
    ) {
        log_bridge_event(
            app,
            "warning",
            "Bridge runtime notification emit failed.",
            Some(format!("id={id} error={error}")),
        );
    }
}

fn log_bridge_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    level: &str,
    summary: impl Into<String>,
    detail: Option<String>,
) {
    let _ = append_diagnostics_log_quiet(app, "bridge", level, summary, detail, None, None);
}

pub(crate) fn get_bridge_runtime_snapshot(
    state: State<'_, BridgeStateStore>,
) -> super::contracts::BridgeRuntimeSnapshot {
    state.snapshot()
}

fn mark_process_loopback_probe_failed(
    bridge_state: &BridgeStateStore,
    detail: String,
    process_start_failed: bool,
) {
    bridge_state.update_snapshot(|current| {
        if process_start_failed {
            current.process_status = "error".to_string();
        }
        current.process_loopback_status = ProcessLoopbackStatus::Failed;
        current.process_loopback_failure_detail = Some(detail);
        current.last_error_code =
            Some("bridge.process-loopback-activation-failed".to_string());
        reconcile_bridge_snapshot(current);
    });
}

fn process_loopback_probe_launch_snapshot(
    snapshot: &BridgeRuntimeSnapshot,
) -> BridgeRuntimeSnapshot {
    let mut neutral = snapshot.clone();
    neutral.session_id = None;
    neutral.process_status = "starting".to_string();
    neutral.bridge_state = "stopped".to_string();
    neutral.lifecycle_state = "idle".to_string();
    neutral.source_capture_mode = SourceCaptureMode::None;
    neutral.capture_backend = CaptureBackend::None;
    neutral.source_monitor_playback_enabled = false;
    neutral.monitor_playback_enabled = false;
    neutral.translation_playback_enabled = false;
    neutral.source_subscriber_active = false;
    neutral.source_pending_bytes = 0;
    neutral.source_pacer_queued_frames = 0;
    neutral.monitor_source_queued_frames = 0;
    neutral.capture_lifecycle_state = "capture-disabled".to_string();
    neutral.source_worker_phase = "capture-disabled".to_string();
    neutral.pipe_path = format!(r"\\.\pipe\{}", neutral.pipe_name);
    neutral
}

fn process_loopback_probe_uses_active_route_health(snapshot: &BridgeRuntimeSnapshot) -> bool {
    snapshot.process_status != "stopped"
        && snapshot.source_capture_mode == SourceCaptureMode::ProcessExclusion
}

/// Probes application-loopback exclusion independently of the selected route.
/// A stopped Bridge is launched in `sourceCaptureMode=none`; the command only
/// creates and immediately releases a WASAPI application-loopback client, so
/// no source subscriber, capture generation, or virtual-driver probe is used.
pub(crate) fn probe_process_loopback_capability<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime_state: State<'_, RuntimeStateStore>,
    bridge_state: State<'_, BridgeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    let _lifecycle_operation = bridge_state.lock_lifecycle_operation();
    let started_at = Instant::now();
    let active_route_owns_health =
        process_loopback_probe_uses_active_route_health(&bridge_state.snapshot());
    if !active_route_owns_health {
        bridge_state.update_snapshot(|current| {
            current.process_loopback_status = ProcessLoopbackStatus::Probing;
            current.process_loopback_failure_detail = None;
            if current
                .last_error_code
                .as_deref()
                .is_some_and(|code| code.starts_with("bridge.process-loopback-"))
            {
                current.last_error_code = None;
            }
            reconcile_bridge_snapshot(current);
        });
        emit_runtime_snapshot(&app, &runtime_state).map_err(|error| error.to_string())?;
    }

    let mut snapshot = bridge_state.snapshot();
    let process_start_needed = snapshot.process_status != "running";
    if process_start_needed {
        snapshot = process_loopback_probe_launch_snapshot(&snapshot);
        if let Err(error) = launch_bridge_process(&snapshot, &bridge_state, &app) {
            mark_process_loopback_probe_failed(&bridge_state, error.clone(), true);
            log_bridge_event(
                &app,
                "warning",
                "Process-loopback capability probe could not start a neutral Bridge.",
                Some(error),
            );
            let _ = emit_runtime_snapshot(&app, &runtime_state);
            return Ok(build_runtime_snapshot(&app, &runtime_state));
        }
        bridge_state.update_snapshot(|current| {
            current.process_status = "running".to_string();
        });
        snapshot = bridge_state.snapshot();
    }

    match BridgeIpcClient::new(&snapshot).probe_process_loopback() {
        Ok(probe) => {
            let probe_process_id = probe.probe_process_id;
            let status = probe.process_loopback_status;
            let source_capture_mode = probe.source_capture_mode;
            let capture_backend = probe.capture_backend;
            bridge_state.update_snapshot(|current| {
                apply_process_loopback_probe(current, probe)
            });
            log_bridge_event(
                &app,
                "info",
                "Process-loopback capability probe completed.",
                Some(format!(
                    "status={} bridgePid={} sourceCaptureMode={} captureBackend={} elapsedMs={}",
                    status.as_str(),
                    probe_process_id,
                    source_capture_mode.as_str(),
                    capture_backend.as_str(),
                    started_at.elapsed().as_millis()
                )),
            );
        }
        Err(error) => {
            mark_process_loopback_probe_failed(&bridge_state, error.clone(), false);
            log_bridge_event(
                &app,
                "warning",
                "Process-loopback capability probe IPC failed.",
                Some(error),
            );
        }
    }
    emit_runtime_snapshot(&app, &runtime_state).map_err(|error| error.to_string())?;
    Ok(build_runtime_snapshot(&app, &runtime_state))
}
