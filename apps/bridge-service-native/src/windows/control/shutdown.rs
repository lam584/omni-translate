// Generation-bound Bridge shutdown lives in this separate include so the
// control dispatcher remains below the repository's module-size boundary.

fn handle_bridge_shutdown(
    request_id: &str,
    state: &Arc<Mutex<BridgeState>>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
    terminal_timeout: Duration,
) -> Value {
    let (shutdown_generation, process_loopback_lifecycle) = {
        let mut current = state.lock().unwrap();
        let process_loopback_lifecycle = current.process_loopback_lifecycle.clone();
        // Close the generation gate while holding BridgeState. A worker that
        // observed the old source state but has not activated yet can no
        // longer cross begin_generation after this point.
        let shutdown_generation =
            process_loopback_lifecycle.request_shutdown(current.source_generation);
        current.process_loopback_shutdown_requested_generation = Some(shutdown_generation);
        current.source_subscriber_active = false;
        current.source_generation = current.source_generation.wrapping_add(1);
        current.source_capture_mode = SourceCaptureMode::None;
        current.capture_backend = CaptureBackend::None;
        current.source_pending_bytes = 0;
        current.source_pacer_queued_frames = 0;
        current.monitor_source_queued_frames = 0;
        current.virtual_mic_session_active = false;
        current.reset_translation_cue_ledgers();
        current.update_progress("process-loopback-stopping");
        request_playback_stop(
            &mut current,
            translation_queue,
            playback_control_tx,
            "bridge-shutdown",
            None,
        );
        (shutdown_generation, process_loopback_lifecycle)
    };

    if let Err(error) = stop_virtual_mic_session() {
        service_log(
            LogLevel::Warning,
            request_id,
            &format!(
                "event=virtual_mic_session_stop status=failed reason=bridge-shutdown errorCode={} detail={}",
                error.code, error.detail,
            ),
        );
    }

    let terminal_evidence = match process_loopback_lifecycle
        .wait_for_shutdown_terminal(shutdown_generation, terminal_timeout)
    {
        Ok(evidence) => evidence,
        Err(detail) => {
            service_log(
                LogLevel::Error,
                request_id,
                &format!(
                    "event=process_loopback_shutdown status=failed generation={shutdown_generation} error={detail}"
                ),
            );
            let mut current = state.lock().unwrap();
            current.bridge_state = "degraded".to_string();
            current.lifecycle_state = "error".to_string();
            current.process_loopback_failure_detail = Some(detail.clone());
            current.last_error_code = Some("bridge.timeout".to_string());
            current.update_progress("process-loopback-shutdown-timeout");
            return bridge_error(request_id, "bridge.timeout", &detail, &current);
        }
    };
    record_process_loopback_terminal_evidence(state, &terminal_evidence);
    if !terminal_evidence.authorizes_shutdown(shutdown_generation) {
        let detail = format!(
            "process loopback shutdown terminal was rejected: requestedGeneration={shutdown_generation}, terminalGeneration={}, terminalStatus={}",
            terminal_evidence.generation, terminal_evidence.status,
        );
        service_log(
            LogLevel::Error,
            request_id,
            &format!("event=process_loopback_shutdown status=failed error={detail}"),
        );
        let mut current = state.lock().unwrap();
        current.bridge_state = "degraded".to_string();
        current.lifecycle_state = "error".to_string();
        current.process_loopback_failure_detail = Some(detail.clone());
        current.last_error_code =
            Some("bridge.process-loopback-capture-failed".to_string());
        current.update_progress("process-loopback-shutdown-terminal-rejected");
        return bridge_error(
            request_id,
            "bridge.process-loopback-capture-failed",
            &detail,
            &current,
        );
    }
    service_log(
        LogLevel::Info,
        request_id,
        &format!(
            "event=process_loopback_shutdown status=terminal requestedGeneration={shutdown_generation} terminalGeneration={} terminalStatus={}",
            terminal_evidence.generation, terminal_evidence.status,
        ),
    );
    let mut current = state.lock().unwrap();
    current.session_id = None;
    current.bridge_state = "stopped".to_string();
    current.lifecycle_state = "stopped".to_string();
    current.physical_playback_status = "uninitialized".to_string();
    current.resolved_physical_playback_device_id.clear();
    current.update_progress("process-loopback-terminal");
    state_snapshot(request_id, &current)
}
