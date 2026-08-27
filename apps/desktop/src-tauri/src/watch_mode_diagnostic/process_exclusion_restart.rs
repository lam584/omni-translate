use super::*;

pub(super) fn schedule_process_exclusion_restart(
    app: &AppHandle,
    run_marker: &str,
    config: Value,
    feedback_loop_prevention: &str,
) {
    let restart_after_ms = match process_exclusion_restart_after_ms() {
        Ok(Some(value)) if feedback_loop_prevention == "process-exclusion" => value,
        Ok(_) => return,
        Err(error) => {
            let _ = append_diagnostics_log(
                app,
                "runtime",
                "error",
                "event=process_exclusion_restart_config_failed",
                Some(format!(
                    "runMarker={} error={}",
                    if run_marker.is_empty() { "-" } else { run_marker },
                    error.replace(char::is_whitespace, "_"),
                )),
                None,
                None,
            );
            return;
        }
    };

    let app = app.clone();
    let run_marker = run_marker.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(restart_after_ms)).await;
        let started_at_unix_ms = crate::audio::time_utils::unix_ms();
        let playback_drain_started = Instant::now();
        loop {
            if !app
                .state::<AudioStateStore>()
                .inbound_speaker_playback_active()
            {
                tokio::time::sleep(PROCESS_EXCLUSION_RESTART_PLAYBACK_IDLE_CONFIRMATION).await;
                if !app
                    .state::<AudioStateStore>()
                    .inbound_speaker_playback_active()
                {
                    break;
                }
            }
            if playback_drain_started.elapsed()
                >= PROCESS_EXCLUSION_RESTART_PLAYBACK_DRAIN_TIMEOUT
            {
                log_process_exclusion_restart_failure(
                    &app,
                    &run_marker,
                    "playback-drain",
                    started_at_unix_ms,
                    "translated speaker playback did not reach a stable idle window before the controlled Bridge restart",
                );
                return;
            }
            tokio::time::sleep(PROCESS_EXCLUSION_RESTART_POLL).await;
        }
        let old = match wait_for_process_exclusion_source(&app, None).await {
            Ok(observation) => observation,
            Err(error) => {
                log_process_exclusion_restart_failure(
                    &app,
                    &run_marker,
                    "before",
                    started_at_unix_ms,
                    &error,
                );
                return;
            }
        };
        let old_instance_id = old.frame.bridge_instance_id.clone();
        let _ = append_diagnostics_log(
            &app,
            "runtime",
            "info",
            "event=process_exclusion_restart_before",
            Some(format!(
                "runMarker={} startedAtUnixMs={started_at_unix_ms} bridgeProcessId={} bridgeInstanceId={} sessionId={} sourceGeneration={} sourceGenerationToken={} lastFrameTimestampMs={} lastFrameReadTimestampMs={} sourceFrames={} sourceSubscriberActive={} excludedProcessId={}",
                if run_marker.is_empty() { "-" } else { run_marker.as_str() },
                old.frame.bridge_process_id,
                old.frame.bridge_instance_id,
                old.frame.session_id,
                old.frame.source_generation,
                old.frame.source_generation_token,
                old.frame.frame_timestamp_ms,
                old.frame.read_timestamp_ms,
                old.bridge.source_frames_captured,
                old.bridge.source_subscriber_active,
                old.bridge.excluded_process_id.unwrap_or_default(),
            )),
            None,
            None,
        );

        // Revoke the old source identity before declaring the restart trigger.
        // Buffered bytes from the old named pipe must cross this rejection
        // barrier before the old process is terminated.
        let mut old_identity_revoked = false;
        app.state::<BridgeStateStore>().update_snapshot(|current| {
            if current.bridge_process_id == Some(old.frame.bridge_process_id)
                && current.bridge_instance_id.as_deref()
                    == Some(old.frame.bridge_instance_id.as_str())
                && current.session_id.as_deref() == Some(old.frame.session_id.as_str())
                && current.source_generation == old.frame.source_generation
            {
                current.source_generation_token = None;
                old_identity_revoked = true;
            }
        });
        if !old_identity_revoked {
            log_process_exclusion_restart_failure(
                &app,
                &run_marker,
                "identity-revoke",
                started_at_unix_ms,
                "Bridge source identity changed before the controlled restart barrier",
            );
            return;
        }
        let restart_triggered_at_unix_ms = crate::audio::time_utils::unix_ms();
        let _ = append_diagnostics_log(
            &app,
            "runtime",
            "info",
            "event=process_exclusion_restart_triggered",
            Some(format!(
                "runMarker={} restartTriggeredAtUnixMs={restart_triggered_at_unix_ms} oldBridgeProcessId={} oldSessionId={} oldSourceGeneration={} oldSourceGenerationToken={}",
                if run_marker.is_empty() { "-" } else { run_marker.as_str() },
                old.frame.bridge_process_id,
                old.frame.session_id,
                old.frame.source_generation,
                old.frame.source_generation_token,
            )),
            None,
            None,
        );

        let restart_app = app.clone();
        let restart_result = tauri::async_runtime::spawn_blocking(move || {
            repair_driver_runtime(
                restart_app.clone(),
                restart_app.state::<RuntimeStateStore>(),
                restart_app.state::<BridgeStateStore>(),
                config,
                "restart-bridge".to_string(),
            )
        })
        .await
        .map_err(|error| format!("Bridge restart task failed: {error}"))
        .and_then(|result| result);
        if let Err(error) = restart_result {
            log_process_exclusion_restart_failure(
                &app,
                &run_marker,
                "restart",
                started_at_unix_ms,
                &error,
            );
            return;
        }

        let mut new = match wait_for_process_exclusion_source(&app, Some(&old)).await {
            Ok(observation) => observation,
            Err(error) => {
                log_process_exclusion_restart_failure(
                    &app,
                    &run_marker,
                    "recovery",
                    started_at_unix_ms,
                    &error,
                );
                return;
            }
        };
        let old_accepted_at_rebind = app
            .state::<AudioStateStore>()
            .bridge_source_runtime_evidence()
            .accepted_for_instance(&old_instance_id);
        // Prove the new generation remains live after its first frame and give
        // any delayed old-pipe bytes time to hit the rejection barrier.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let settled_bridge = match query_and_cache_bridge_runtime(&app) {
            Ok(bridge)
                if bridge.bridge_process_id == new.bridge.bridge_process_id
                    && bridge.bridge_instance_id == new.bridge.bridge_instance_id
                    && bridge.session_id == new.bridge.session_id
                    && bridge.source_generation == new.bridge.source_generation
                    && bridge.source_generation_token == new.bridge.source_generation_token
                    && bridge.source_frames_captured > new.bridge.source_frames_captured
                    && bridge.source_subscriber_active
                    && bridge.process_loopback_status == ProcessLoopbackStatus::Ready =>
            {
                bridge
            }
            Ok(bridge) => {
                log_process_exclusion_restart_failure(
                    &app,
                    &run_marker,
                    "post-recovery-continuity",
                    started_at_unix_ms,
                    &format!(
                        "new source generation did not continue growing: firstFrames={} settledFrames={} settledSubscriber={} settledStatus={}",
                        new.bridge.source_frames_captured,
                        bridge.source_frames_captured,
                        bridge.source_subscriber_active,
                        bridge.process_loopback_status.as_str(),
                    ),
                );
                return;
            }
            Err(error) => {
                log_process_exclusion_restart_failure(
                    &app,
                    &run_marker,
                    "post-recovery-query",
                    started_at_unix_ms,
                    &error,
                );
                return;
            }
        };
        new.bridge = settled_bridge;
        let recovered_at_unix_ms = crate::audio::time_utils::unix_ms();
        let evidence_after = app
            .state::<AudioStateStore>()
            .bridge_source_runtime_evidence();
        let old_frames_after_restart = evidence_after
            .accepted_for_instance(&old_instance_id)
            .saturating_sub(old_accepted_at_rebind);
        let old_frame_rejected_count = evidence_after.rejected_for_instance_since(
            &old_instance_id,
            restart_triggered_at_unix_ms,
        );
        let downtime_ms = new
            .frame
            .read_timestamp_ms
            .saturating_sub(restart_triggered_at_unix_ms);
        let status = if old_frames_after_restart == 0 {
            "passed"
        } else {
            "failed"
        };
        let _ = append_diagnostics_log(
            &app,
            "runtime",
            if status == "passed" { "info" } else { "error" },
            "event=process_exclusion_restart_after",
            Some(format!(
                "status={status} runMarker={} recoveredAtUnixMs={recovered_at_unix_ms} bridgeProcessId={} bridgeInstanceId={} sessionId={} sourceGeneration={} sourceGenerationToken={} firstFrameTimestampMs={} firstFrameReadTimestampMs={} sourceFrames={} sourceSubscriberActive={} processLoopbackStatus={} captureBackend={} excludedProcessId={} oldFramesAfterRestart={} oldFrameRejectedCount={} totalRejectedFrames={}",
                if run_marker.is_empty() { "-" } else { run_marker.as_str() },
                new.frame.bridge_process_id,
                new.frame.bridge_instance_id,
                new.frame.session_id,
                new.frame.source_generation,
                new.frame.source_generation_token,
                new.frame.frame_timestamp_ms,
                new.frame.read_timestamp_ms,
                new.bridge.source_frames_captured,
                new.bridge.source_subscriber_active,
                new.bridge.process_loopback_status.as_str(),
                new.bridge.capture_backend.as_str(),
                new.bridge.excluded_process_id.unwrap_or_default(),
                old_frames_after_restart,
                old_frame_rejected_count,
                evidence_after.rejected_frame_count,
            )),
            None,
            None,
        );
        let _ = append_diagnostics_log(
            &app,
            "runtime",
            if status == "passed" { "info" } else { "error" },
            "event=process_exclusion_restart_summary",
            Some(format!(
                "status={status} runMarker={} startedAtUnixMs={started_at_unix_ms} restartTriggeredAtUnixMs={restart_triggered_at_unix_ms} oldBridgeProcessId={} newBridgeProcessId={} oldBridgeInstanceId={} newBridgeInstanceId={} oldSessionId={} newSessionId={} oldSourceGeneration={} newSourceGeneration={} oldSourceGenerationToken={} newSourceGenerationToken={} oldLastFrameTimestampMs={} oldLastFrameReadTimestampMs={} newFirstFrameTimestampMs={} newFirstFrameReadTimestampMs={} recoveredAtMs={recovered_at_unix_ms} recoveredAtUnixMs={recovered_at_unix_ms} downtimeMs={downtime_ms} oldFramesAfterRestart={} oldFrameRejectedCount={} excludedProcessId={} processLoopbackStatus={} captureBackend={} sourceFramesBefore={} sourceFramesAfter={} sourceSubscriberActive={}",
                if run_marker.is_empty() { "-" } else { run_marker.as_str() },
                old.frame.bridge_process_id,
                new.frame.bridge_process_id,
                old.frame.bridge_instance_id,
                new.frame.bridge_instance_id,
                old.frame.session_id,
                new.frame.session_id,
                old.frame.source_generation,
                new.frame.source_generation,
                old.frame.source_generation_token,
                new.frame.source_generation_token,
                old.frame.frame_timestamp_ms,
                old.frame.read_timestamp_ms,
                new.frame.frame_timestamp_ms,
                new.frame.read_timestamp_ms,
                old_frames_after_restart,
                old_frame_rejected_count,
                new.bridge.excluded_process_id.unwrap_or_default(),
                new.bridge.process_loopback_status.as_str(),
                new.bridge.capture_backend.as_str(),
                old.bridge.source_frames_captured,
                new.bridge.source_frames_captured,
                new.bridge.source_subscriber_active,
            )),
            None,
            None,
        );
    });
}
