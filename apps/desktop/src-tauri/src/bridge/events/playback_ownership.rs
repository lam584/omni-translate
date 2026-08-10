const DESKTOP_PLAYBACK_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

fn run_bridge_start_with_playback_ownership<R: tauri::Runtime>(
    snapshot: &BridgeRuntimeSnapshot,
    bridge_state: &BridgeStateStore,
    app: &AppHandle<R>,
    start: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if snapshot.source_capture_mode != SourceCaptureMode::ProcessExclusion {
        let result = start();
        if result.is_ok() {
            release_desktop_playback_ownership(app);
        }
        return result;
    }
    let error_code =
        crate::audio::playback_ownership::PLAYBACK_OWNERSHIP_BARRIER_ERROR_CODE;
    let Some(audio_state) = app.try_state::<crate::audio::state::AudioStateStore>() else {
        let error = format!(
            "{error_code}: AudioStateStore is unavailable before process-exclusion Bridge Init"
        );
        record_bridge_start_error(bridge_state, error_code, error.clone());
        return Err(error);
    };
    let result = audio_state
        .desktop_playback_ownership()
        .run_after_process_exclusion_drain(DESKTOP_PLAYBACK_DRAIN_TIMEOUT, start);
    result.map_err(|error| {
        if error.starts_with(error_code) {
            audio_state.watch_session_report.record_session_issue(
                "output",
                error_code,
                "error",
                &error,
            );
            let _ = append_diagnostics_log_quiet(
                app,
                "bridge",
                "error",
                "Process-exclusion Bridge Init blocked by Desktop playback ownership barrier.",
                Some(error.clone()),
                Some(format!("{}:{}", file!(), line!())),
                None,
            );
            record_bridge_start_error(bridge_state, error_code, error.clone());
        }
        error
    })
}

fn release_desktop_playback_ownership<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(audio_state) = app.try_state::<crate::audio::state::AudioStateStore>() {
        audio_state.desktop_playback_ownership().release_to_desktop();
    }
}
