fn stop_existing_process(
    snapshot: &BridgeRuntimeSnapshot,
    state: &BridgeStateStore,
) -> Result<(), String> {
    if let Some(mut process) = state.take_process() {
        let authority =
            ManagedBridgePidAuthority::claim(&snapshot.runtime_root, process.child.id())?;
        let _ = process.child.kill();
        if let Err(error) = process.child.wait() {
            if let Some(authority) = authority {
                authority.restore()?;
            }
            return Err(format!("bridge.managed-process-wait-failed: {error}"));
        }
        if let Some(authority) = authority {
            authority.release()?;
        }
    }
    Ok(())
}

fn cleanup_existing_bridge_process(
    snapshot: &BridgeRuntimeSnapshot,
    state: &BridgeStateStore,
) -> Result<(), String> {
    stop_existing_process(snapshot, state)?;
    let _ = BridgeIpcClient::new(snapshot).stop();
    thread::sleep(Duration::from_millis(150));
    BridgeProcessSupervisor::new(snapshot).terminate_stale()
}

fn start_bridge_from_snapshot<R: tauri::Runtime>(
    snapshot: &BridgeRuntimeSnapshot,
    bridge_state: &BridgeStateStore,
    app: &AppHandle<R>,
) -> Result<(), String> {
    run_bridge_start_with_playback_ownership(snapshot, bridge_state, app, || {
        launch_bridge_process(snapshot, bridge_state, app)?;
        match BridgeIpcClient::new(snapshot).initialize() {
            Ok(initialized) => {
                bridge_state.update_snapshot(|current| *current = initialized);
                Ok(())
            }
            Err(failure) => {
                let (failed_snapshot, message) = failure.into_parts();
                bridge_state.update_snapshot(|current| *current = failed_snapshot);
                Err(message)
            }
        }
    })
}
