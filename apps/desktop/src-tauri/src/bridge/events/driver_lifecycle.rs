fn restart_bridge_quietly_after_driver_failure<R: tauri::Runtime>(
    app: &AppHandle<R>,
    runtime_state: &RuntimeStateStore,
    bridge_state: &BridgeStateStore,
) {
    let mut restarted = bridge_state.snapshot();
    restarted.session_id = Some(super::new_bridge_session_id());
    restarted.process_status = "starting".to_string();
    if let Err(error) = start_bridge_from_snapshot(&restarted, bridge_state, app) {
        log_bridge_event(
            app,
            "warning",
            "驱动操作中断后重新拉起 Bridge 服务未成功。",
            Some(error),
        );
    }
    let _ = emit_runtime_snapshot(app, runtime_state);
}

fn fail_driver_preflight<R: tauri::Runtime>(
    app: &AppHandle<R>,
    runtime_state: &RuntimeStateStore,
    bridge_state: &BridgeStateStore,
    error: String,
) -> Result<RuntimeSnapshot, String> {
    record_driver_operation_error(bridge_state, &error);
    restart_bridge_quietly_after_driver_failure(app, runtime_state, bridge_state);
    let _ = emit_runtime_snapshot(app, runtime_state);
    Err(error)
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

    let probe = match probe_driver(&snapshot, false) {
        Ok(probe) => probe,
        Err(error) => {
            restart_bridge_quietly_after_driver_failure(&app, &runtime_state, &bridge_state);
            return Err(error);
        }
    };
    bridge_state.update_snapshot(|current| apply_driver_probe(current, probe.clone()));
    if let Some(error) = driver_signature_preflight_error(&probe, false) {
        return fail_driver_preflight(&app, &runtime_state, &bridge_state, error);
    }
    bridge_state
        .update_snapshot(|current| current.install_phase = "waiting-for-elevation".to_string());
    let operation = match run_elevated_driver_operation_or_record(&snapshot, &bridge_state, "install") {
        Ok(operation) => operation,
        Err(error) => {
            restart_bridge_quietly_after_driver_failure(&app, &runtime_state, &bridge_state);
            return Err(error);
        }
    };
    bridge_state.update_snapshot(|current| {
        *current = snapshot.clone();
        current.last_driver_operation = Some(operation.clone());
        current.install_phase = "starting-bridge".to_string();
    });
    if let Err(error) = verify_post_operation_driver_probe(&bridge_state) {
        restart_bridge_quietly_after_driver_failure(&app, &runtime_state, &bridge_state);
        return Err(error);
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
    let probe = match probe_driver(&snapshot, false) {
        Ok(probe) => probe,
        Err(error) => {
            restart_bridge_quietly_after_driver_failure(&app, &runtime_state, &bridge_state);
            return Err(error);
        }
    };
    bridge_state.update_snapshot(|current| apply_driver_probe(current, probe.clone()));
    if let Some(error) = driver_signature_preflight_error(&probe, true) {
        return fail_driver_preflight(&app, &runtime_state, &bridge_state, error);
    }
    bridge_state
        .update_snapshot(|current| current.install_phase = "waiting-for-elevation".to_string());
    let elevated_action = "reinstall";
    let operation = match run_elevated_driver_operation_or_record(&snapshot, &bridge_state, elevated_action) {
        Ok(operation) => operation,
        Err(error) => {
            restart_bridge_quietly_after_driver_failure(&app, &runtime_state, &bridge_state);
            return Err(error);
        }
    };
    bridge_state.update_snapshot(|current| {
        *current = snapshot.clone();
        current.last_driver_operation = Some(operation.clone());
    });
    if let Err(error) = verify_post_operation_driver_probe(&bridge_state) {
        restart_bridge_quietly_after_driver_failure(&app, &runtime_state, &bridge_state);
        return Err(error);
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