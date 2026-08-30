use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
pub(super) fn start_diagnostic_audio_route(
    app: &AppHandle,
    run_marker: &str,
    output_device_id: &str,
    config: Value,
    feedback_loop_prevention: &str,
) {
    match start_audio_route_inner(
        app.clone(),
        &app.state::<AudioStateStore>(),
        "inbound".to_string(),
        config.clone(),
    ) {
        Ok(snapshot) => {
            readiness::mark_route_ready();
            let _ = append_diagnostics_log(
                app,
                "runtime",
                "info",
                "watch_mode.diagnostic_autostart_route_started",
                Some(format!(
                    "runMarker={} status={} outputDeviceId={}",
                    if run_marker.is_empty() {
                        "-"
                    } else {
                        run_marker
                    },
                    snapshot.status,
                    if output_device_id.is_empty() {
                        "-"
                    } else {
                        output_device_id
                    }
                )),
                None,
                None,
            );
            schedule_process_exclusion_restart(
                app,
                run_marker,
                config,
                feedback_loop_prevention,
            );
            schedule_capture(app, run_marker);
        }
        Err(error) => {
            readiness::fail("route", "watch.route.start-failed", error.clone());
            let _ = append_diagnostics_log(
                app,
                "runtime",
                "error",
                "watch_mode.diagnostic_autostart_route_failed",
                Some(error),
                None,
                None,
            );
        }
    }
}
#[derive(Clone)]
pub(super) struct ProcessExclusionSourceObservation {
    pub(super) bridge: BridgeRuntimeSnapshot,
    pub(super) frame: crate::audio::state::BridgeSourceFrameIdentity,
}
pub(super) fn query_and_cache_bridge_runtime(
    app: &AppHandle,
) -> Result<BridgeRuntimeSnapshot, String> {
    let bridge_state = app.state::<BridgeStateStore>();
    let cached = bridge_state.snapshot();
    let query = BridgeIpcClient::new(&cached).query_state(true)?;
    Ok(bridge_state.update_snapshot(|current| {
        apply_bridge_query(current, query);
    }))
}
fn process_exclusion_source_is_ready(
    bridge: &BridgeRuntimeSnapshot,
    frame: &crate::audio::state::BridgeSourceFrameIdentity,
) -> bool {
    bridge.process_status == "running"
        && bridge.bridge_state == "running"
        && bridge.source_capture_mode == SourceCaptureMode::ProcessExclusion
        && bridge.capture_backend == CaptureBackend::WasapiProcessExclusion
        && bridge.process_loopback_status == ProcessLoopbackStatus::Ready
        && bridge.physical_playback_status == "ready"
        && !bridge.resolved_physical_playback_device_id.trim().is_empty()
        && bridge.playback_owner_generation > 0
        && bridge.source_subscriber_active
        && bridge.bridge_process_id == Some(frame.bridge_process_id)
        && bridge.excluded_process_id == Some(frame.bridge_process_id)
        && bridge.bridge_instance_id.as_deref() == Some(frame.bridge_instance_id.as_str())
        && bridge.session_id.as_deref() == Some(frame.session_id.as_str())
        && bridge.source_generation == frame.source_generation
        && bridge.source_generation_token.as_deref()
            == Some(frame.source_generation_token.as_str())
        && bridge.source_frames_captured > 0
        && bridge.last_frame_timestamp_ms.is_some()
}

pub(super) async fn wait_for_process_exclusion_source(
    app: &AppHandle,
    previous: Option<&ProcessExclusionSourceObservation>,
) -> Result<ProcessExclusionSourceObservation, String> {
    let started = Instant::now();
    let mut last_detail = "no Bridge state query completed".to_string();
    while started.elapsed() < PROCESS_EXCLUSION_RESTART_RECOVERY_TIMEOUT {
        match query_and_cache_bridge_runtime(app) {
            Ok(bridge) => {
                let evidence = app
                    .state::<AudioStateStore>()
                    .bridge_source_runtime_evidence();
                let frame = bridge.bridge_instance_id.as_deref().and_then(|instance_id| {
                    if previous.is_some() {
                        bridge
                            .source_generation_token
                            .as_deref()
                            .and_then(|token| evidence.first_frame_for_generation(token))
                            .cloned()
                    } else {
                        evidence
                            .last_accepted
                            .as_ref()
                            .filter(|identity| identity.bridge_instance_id == instance_id)
                            .cloned()
                    }
                });
                if let Some(frame) = frame {
                    let changed = previous.is_none_or(|old| {
                        bridge.bridge_process_id != old.bridge.bridge_process_id
                            && bridge.bridge_instance_id != old.bridge.bridge_instance_id
                            && bridge.session_id != old.bridge.session_id
                            && bridge.source_generation != old.bridge.source_generation
                            && bridge.source_generation_token
                                != old.bridge.source_generation_token
                            && bridge.playback_owner_generation
                                > old.bridge.playback_owner_generation
                    });
                    if changed && process_exclusion_source_is_ready(&bridge, &frame) {
                        return Ok(ProcessExclusionSourceObservation { bridge, frame });
                    }
                }
                last_detail = format!(
                    "bridgeProcessId={} bridgeInstanceId={} sessionId={} sourceGeneration={} sourceGenerationToken={} sourceFramesCaptured={} sourceSubscriberActive={} processLoopbackStatus={} physicalPlaybackStatus={} playbackOwnerGeneration={} resolvedPhysicalPlaybackDeviceId={} excludedProcessId={} evidenceAcceptedFrames={}",
                    bridge
                        .bridge_process_id
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "none".to_string()),
                    bridge.bridge_instance_id.as_deref().unwrap_or("none"),
                    bridge.session_id.as_deref().unwrap_or("none"),
                    bridge.source_generation,
                    bridge.source_generation_token.as_deref().unwrap_or("none"),
                    bridge.source_frames_captured,
                    bridge.source_subscriber_active,
                    bridge.process_loopback_status.as_str(),
                    bridge.physical_playback_status,
                    bridge.playback_owner_generation,
                    bridge.resolved_physical_playback_device_id,
                    bridge
                        .excluded_process_id
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "none".to_string()),
                    evidence.accepted_frame_count,
                );
            }
            Err(error) => last_detail = error,
        }
        tokio::time::sleep(PROCESS_EXCLUSION_RESTART_POLL).await;
    }
    Err(format!(
        "process-exclusion source did not reach an identity-bound ready state within {}ms: {last_detail}",
        PROCESS_EXCLUSION_RESTART_RECOVERY_TIMEOUT.as_millis()
    ))
}

pub(super) fn log_process_exclusion_restart_failure(
    app: &AppHandle,
    run_marker: &str,
    stage: &str,
    started_at_unix_ms: u64,
    error: &str,
) {
    let _ = append_diagnostics_log(
        app,
        "runtime",
        "error",
        "event=process_exclusion_restart_summary",
        Some(format!(
            "status=failed runMarker={} stage={stage} startedAtUnixMs={started_at_unix_ms} recoveredAtMs=0 recoveredAtUnixMs=0 error={}",
            if run_marker.is_empty() { "-" } else { run_marker },
            error.replace(char::is_whitespace, "_"),
        )),
        None,
        None,
    );
}

/// The live Watch matrix must stop the same desktop process that owns the
/// in-memory report. Launching a second executable with `tauri invoke` creates
/// another app instance and can never read that report. Keep this diagnostic
/// escape hatch opt-in and bounded: normal application sessions neither stop
/// automatically nor write a report to disk.
fn schedule_capture(app: &AppHandle, run_marker: &str) {
    if std::env::var("OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY").as_deref() == Ok("1") {
        match strict_paid_terminal_config_with_environment(|name| std::env::var(name).ok()) {
            Ok(config) => schedule_evidence_driven_capture(app, config),
            Err(error) => {
                readiness::fail("terminal", "watch.terminal.config-invalid", error.clone());
                let _ = append_diagnostics_log(
                    app,
                    "runtime",
                    "error",
                    "watch_mode.evidence_driven_terminal_config_failed",
                    Some(error),
                    None,
                    None,
                );
                if env_flag_enabled("OMNI_WATCH_MODE_EXIT_AFTER_REPORT") {
                    app.exit(2);
                }
            }
        }
        return;
    }
    schedule_timer_capture(app, run_marker);
}

fn schedule_timer_capture(app: &AppHandle, run_marker: &str) {
    let duration_ms = std::env::var("OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        // Keep the user-requested matrix duration intact up to the runner's
        // documented two-hour ceiling.
        .map(bounded_autostart_capture_duration_ms);
    let report_path = std::env::var("OMNI_WATCH_MODE_REPORT_PATH")
        .unwrap_or_default()
        .trim()
        .to_string();

    let (Some(duration_ms), false) = (duration_ms, report_path.is_empty()) else {
        return;
    };

    let app = app.clone();
    let run_marker = run_marker.to_string();
    let exit_after_report = env_flag_enabled("OMNI_WATCH_MODE_EXIT_AFTER_REPORT");
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(duration_ms)).await;
        let stop_result = stop_audio_route(app.clone(), "inbound".to_string()).await;
        if let Err(error) = &stop_result {
            let _ = append_diagnostics_log(
                &app,
                "runtime",
                "error",
                "watch_mode.diagnostic_auto_stop_failed",
                Some(format!("runMarker={run_marker} error={error}")),
                None,
                None,
            );
        }

        // `stop_audio_route` marks the report completed before returning, but
        // the renderer receipt crosses a browser frame and can arrive a few
        // hundred milliseconds later. Preserve that final evidence before
        // taking the immutable snapshot.
        tokio::time::sleep(Duration::from_millis(750)).await;
        let report = app
            .state::<AudioStateStore>()
            .watch_session_report
            .snapshot();
        let report_completed = report
            .as_ref()
            .is_some_and(|report| report.status == "completed");
        let write_path = report_path.clone();
        let write_result = tauri::async_runtime::spawn_blocking(move || {
            let report = report.ok_or_else(|| "Watch session report is missing".to_string())?;
            write_report_atomic(&write_path, &report)
        })
        .await
        .map_err(|error| format!("report writer task failed: {error}"))
        .and_then(|result| result);

        let succeeded = stop_result.is_ok() && report_completed && write_result.is_ok();
        let (level, message, detail) = if succeeded {
            (
                "info",
                "watch_mode.diagnostic_report_saved",
                format!(
                    "runMarker={run_marker} durationMs={duration_ms} reportPath={report_path} stopOk=true reportCompleted=true"
                ),
            )
        } else {
            (
                "error",
                "watch_mode.diagnostic_report_capture_failed",
                format!(
                    "runMarker={run_marker} durationMs={duration_ms} reportPath={report_path} stopOk={} reportCompleted={report_completed} reportSaved={} stopError={} writeError={}",
                    stop_result.is_ok(),
                    write_result.is_ok(),
                    stop_result
                        .as_ref()
                        .err()
                        .map(String::as_str)
                        .unwrap_or("-"),
                    write_result
                        .as_ref()
                        .err()
                        .map(String::as_str)
                        .unwrap_or("-"),
                ),
            )
        };
        let _ = append_diagnostics_log(
            &app,
            "runtime",
            level,
            message,
            Some(detail),
            None,
            None,
        );
        if exit_after_report {
            app.exit(if succeeded { 0 } else { 1 });
        }
    });
}

type StrictCaptureFailure = (TerminalAuthorityRecorder, &'static str, String);

fn strict_capture_failure(
    recorder: TerminalAuthorityRecorder,
    error_code: &'static str,
    error: impl Into<String>,
) -> StrictCaptureFailure {
    (recorder, error_code, error.into())
}

fn strict_provider_terminal_error_code(error: &str) -> &'static str {
    if error.contains("watch.capture-input-fence-timeout") {
        "capture-input-fence-timeout"
    } else if error.contains("watch.capture-input-fence-disconnected") {
        "capture-input-fence-disconnected"
    } else if error.contains("watch.capture-input-fence") {
        "capture-input-fence-failed"
    } else if error.contains("watch.capture-join-timeout") {
        "capture-join-timeout"
    } else if error.contains("watch.capture-join-disconnected") {
        "capture-join-disconnected"
    } else if error.contains("livetranslate-session-finished-timeout") {
        "provider-finish-timeout"
    } else if error.contains("livetranslate-session-finished-before-finish") {
        "provider-finish-protocol-order-invalid"
    } else if error.contains("watch.provider-finish-authority-missing") {
        "provider-finish-authority-invalid"
    } else if error.contains("watch.provider-owner-missing") {
        "provider-owner-missing"
    } else {
        "provider-finish-failed"
    }
}

async fn wait_for_input_complete_marker(
    path: &str,
    expected: &ExpectedInputCompleteIdentity,
    timeout: Duration,
) -> Result<InputCompleteMarker, String> {
    let started = Instant::now();
    loop {
        match std::fs::read(path) {
            Ok(bytes) => return parse_input_complete_marker(&bytes, expected),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("failed to read input-complete marker {path}: {error}"))
            }
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "input-complete marker was not observed within {}ms: {path}",
                timeout.as_millis()
            ));
        }
        tokio::time::sleep(INPUT_COMPLETE_POLL).await;
    }
}

async fn run_evidence_driven_capture(
    app: AppHandle,
    config: &StrictPaidTerminalConfig,
    mut recorder: TerminalAuthorityRecorder,
) -> Result<TerminalAuthorityRecorder, StrictCaptureFailure> {
    let marker = match wait_for_input_complete_marker(
        &config.input_complete_path,
        &config.identity,
        config.input_completion_watchdog,
    )
    .await
    {
        Ok(marker) => marker,
        Err(error) => {
            let code = if std::path::Path::new(&config.input_complete_path).exists() {
                "input-complete-invalid"
            } else {
                "input-complete-timeout"
            };
            return Err(strict_capture_failure(recorder, code, error));
        }
    };
    let Some(media_playback_completed_at_unix_ms) =
        marker.media_playback_completed_at_unix_ms
    else {
        return Err(strict_capture_failure(
            recorder,
            "input-complete-invalid",
            "input-complete marker is missing mediaPlaybackCompletedAtUnixMs",
        ));
    };
    recorder.push(
        "mediaPlaybackCompleted",
        media_playback_completed_at_unix_ms,
        json!({
            "authority": "runner-input-complete-marker",
            "authoritativeTransformedReferenceFrames": marker.authoritative_transformed_reference_frames,
            "boundedCaptureGraceFrames": marker.bounded_capture_grace_frames,
            "maxExternalAudioSamples": marker.max_external_audio_samples,
        }),
    );
    recorder.push(
        "inputCompleteSignaled",
        marker.signaled_at_unix_ms,
        json!({
            "authority": "runner-immutable-input-complete-marker",
            "markerCompletedAtUnixMs": marker.completed_at_unix_ms,
        }),
    );
    let provider_app = app.clone();
    let provider_task = tauri::async_runtime::spawn_blocking(move || {
        let state = provider_app.state::<AudioStateStore>();
        finish_strict_watch_provider_after_input_complete(&provider_app, &state)
    });
    let provider_phase_cap = config
        .provider_shutdown_timeout
        .saturating_add(PROVIDER_FINISH_OBSERVATION_GRACE);
    let input_completion = match tokio::time::timeout(provider_phase_cap, provider_task).await {
        Ok(Ok(Ok(input_completion))) => input_completion,
        Ok(Ok(Err(error))) => {
            let code = strict_provider_terminal_error_code(&error);
            return Err(strict_capture_failure(recorder, code, error));
        }
        Ok(Err(error)) => {
            return Err(strict_capture_failure(
                recorder,
                "provider-owner-task-failed",
                format!("Provider owner task failed: {error}"),
            ));
        }
        Err(_) => {
            return Err(strict_capture_failure(
                recorder,
                "provider-finish-timeout",
                format!(
                    "Provider terminal owner did not complete within {}ms (+{}ms receipt grace)",
                    config.provider_shutdown_timeout.as_millis(),
                    PROVIDER_FINISH_OBSERVATION_GRACE.as_millis(),
                ),
            ));
        }
    };
    recorder.push(
        "inputCompleteObserved",
        input_completion.observed_at_unix_ms,
        json!({
            "authority": "desktop-input-complete-watcher-and-capture-owner",
            "markerSignaledAtUnixMs": marker.signaled_at_unix_ms,
            "markerCompletedAtUnixMs": marker.completed_at_unix_ms,
            "acceptedExactlyOnce": true,
            "sourceSequence": input_completion.provider_input_closed_source_sequence,
            "captureProducerFenced": true,
            "providerInputSenderReleased": input_completion.provider_sender_released,
            "statusConsumerRetained": input_completion.status_consumer_retained,
            "paddedTailBytes": input_completion.padded_tail_bytes,
        }),
    );

    let playback_drain = match wait_for_local_playback_quiescence(
        &app,
        config.local_playback_drain_timeout,
    )
    .await
    {
        Ok(evidence) => evidence,
        Err(error) => {
            return Err(strict_capture_failure(
                recorder,
                "local-playback-drain-timeout",
                error,
            ));
        }
    };

    let finalize_app = app.clone();
    let finalize_result = tauri::async_runtime::spawn_blocking(move || {
        let state = finalize_app.state::<AudioStateStore>();
        finalize_strict_watch_inbound_after_terminal_drain(&finalize_app, &state)
    })
    .await;
    match finalize_result {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            let code = if error.contains("watch.capture-join-timeout") {
                "capture-join-timeout"
            } else if error.contains("watch.capture-join-disconnected") {
                "capture-join-disconnected"
            } else {
                "terminal-teardown-failed"
            };
            return Err(strict_capture_failure(recorder, code, error));
        }
        Err(error) => {
            return Err(strict_capture_failure(
                recorder,
                "terminal-teardown-task-failed",
                format!("terminal teardown task failed: {error}"),
            ));
        }
    }

    let lifecycle = match app
        .state::<AudioStateStore>()
        .strict_watch_terminal_lifecycle_snapshot()
    {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return Err(strict_capture_failure(
                recorder,
                "terminal-owner-evidence-incomplete",
                error,
            ))
        }
    };
    if lifecycle.identity.run_marker != config.identity.run_marker
        || lifecycle.identity.cell_id != config.identity.cell_id
        || lifecycle.identity.lease_id != config.identity.lease_id
    {
        return Err(strict_capture_failure(
            recorder,
            "terminal-owner-identity-mismatch",
            "Provider/renderer terminal lifecycle identity did not match the input-complete request",
        ));
    }
    append_terminal_lifecycle_events(&mut recorder, &lifecycle);
    recorder.push(
        "localPlaybackQuiescent",
        unix_ms_now(),
        json!({
            "stableForMs": LOCAL_PLAYBACK_IDLE_CONFIRMATION.as_millis(),
            "speakerPlaybackActive": false,
            "drainBudgetMs": playback_drain.budget.as_millis(),
            "initialPendingAudioFrames": playback_drain.initial_pending_audio_frames,
            "outputSampleRateHz": playback_drain.output_sample_rate_hz,
            "usedFallbackCap": playback_drain.used_fallback_cap,
        }),
    );

    let report = app
        .state::<AudioStateStore>()
        .watch_session_report
        .snapshot();
    if !report
        .as_ref()
        .is_some_and(|report| report.status == "completed")
    {
        return Err(strict_capture_failure(
            recorder,
            "report-write-timeout",
            "Watch session report was missing or not completed after terminal drain",
        ));
    }
    let write_path = config.report_path.clone();
    let write_task = tauri::async_runtime::spawn_blocking(move || {
        let report = report.ok_or_else(|| "Watch session report is missing".to_string())?;
        write_json_immutable(&write_path, "Watch report", &report)
            .map_err(|error| error.to_string())
    });
    let report_receipt = match tokio::time::timeout(config.report_write_timeout, write_task).await {
        Ok(Ok(Ok(receipt))) => receipt,
        Ok(Ok(Err(error))) => {
            let code = if error.starts_with("immutable-exists:") {
                "report-write-immutable-exists"
            } else if error.starts_with("serialize-failed:") {
                "report-write-serialization-failed"
            } else {
                "report-write-io-failed"
            };
            return Err(strict_capture_failure(
                recorder,
                code,
                error,
            ))
        }
        Ok(Err(error)) => {
            return Err(strict_capture_failure(
                recorder,
                "report-write-task-failed",
                format!("report writer task failed: {error}"),
            ))
        }
        Err(_) => {
            return Err(strict_capture_failure(
                recorder,
                "report-write-timeout",
                format!(
                    "report writer did not complete within {}ms",
                    config.report_write_timeout.as_millis(),
                ),
            ))
        }
    };
    recorder.push(
        "reportWritten",
        unix_ms_now(),
        json!({
            "reportPath": report_receipt.relative_path,
            "byteLength": report_receipt.byte_length,
            "sha256": report_receipt.sha256,
        }),
    );
    Ok(recorder)
}

fn append_terminal_lifecycle_events(
    recorder: &mut TerminalAuthorityRecorder,
    lifecycle: &StrictWatchTerminalLifecycleSnapshot,
) {
    let append = &lifecycle.last_provider_append;
    recorder.push(
        "lastProviderAppend",
        append.observed_at_unix_ms,
        json!({
            "authority": "desktop-provider-socket-send-owner",
            "sourceSequence": append.source_sequence,
            "appendIndex": append.append_index,
            "samples": append.samples,
            "acceptedSamplesTotal": append.accepted_samples_total,
        }),
    );
    let finish = &lifecycle.session_finish_sent;
    recorder.push(
        "sessionFinishSent",
        finish.observed_at_unix_ms,
        json!({
            "authority": "desktop-livetranslate-socket-owner",
            "sourceSequence": finish.source_sequence,
            "finishCount": finish.finish_count,
            "lastProviderAppendSourceSequence": finish.last_provider_append_source_sequence,
            "providerInputClosedSourceSequence": finish.provider_input_closed_source_sequence,
            "providerWritesAfterFinish": finish.provider_writes_after_finish,
        }),
    );
    let response = &lifecycle.last_response_terminal;
    recorder.push(
        response.stage,
        response.observed_at_unix_ms,
        json!({
            "authority": "desktop-provider-socket-event-owner",
            "sourceSequence": response.source_sequence,
            "responseId": response.response_id,
            "semantics": if response.stage == "lastResponseAudioDone" {
                "last-provider-audio-response-completed"
            } else {
                "last-provider-response-completed"
            },
        }),
    );
    let finished = &lifecycle.session_finished_received;
    recorder.push(
        "sessionFinishedReceived",
        finished.observed_at_unix_ms,
        json!({
            "authority": "desktop-livetranslate-socket-owner",
            "sourceSequence": finished.source_sequence,
            "finishCount": finished.finish_count,
            "providerWritesAfterFinish": finished.provider_writes_after_finish,
        }),
    );
    let ack = &lifecycle.final_renderer_ack;
    recorder.push(
        "finalRendererAck",
        ack.observed_at_unix_ms,
        json!({
            "authority": "desktop-renderer-receipt-owner",
            "sourceSequence": ack.source_sequence,
            "cueId": ack.cue_id,
            "responseId": ack.response_id,
            "cueSequence": ack.cue_sequence,
            "lastCueSequence": ack.last_cue_sequence,
            "coversLastCue": ack.cue_sequence == ack.last_cue_sequence,
            "receiptAuthority": ack.receipt_authority,
            "receiptId": ack.receipt_id,
        }),
    );
}

fn schedule_evidence_driven_capture(app: &AppHandle, config: StrictPaidTerminalConfig) {
    let app = app.clone();
    let exit_after_report = env_flag_enabled("OMNI_WATCH_MODE_EXIT_AFTER_REPORT");
    tauri::async_runtime::spawn(async move {
        let recorder = TerminalAuthorityRecorder::new(
            config.identity.clone(),
            config.producer.clone(),
            unix_ms_now(),
        );
        let (authority, succeeded, error_detail) =
            match run_evidence_driven_capture(app.clone(), &config, recorder).await {
                Ok(recorder) => (recorder.complete(unix_ms_now()), true, None),
                Err((recorder, error_code, error)) => (
                    recorder.fail(unix_ms_now(), error_code, error.clone()),
                    false,
                    Some(format!("errorCode={error_code} error={error}")),
                ),
            };
        let authority_path = config.terminal_authority_path.clone();
        let authority_write = tauri::async_runtime::spawn_blocking(move || {
            write_terminal_authority_immutable(&authority_path, &authority)
        })
        .await
        .map_err(|error| format!("terminal authority writer task failed: {error}"))
        .and_then(|result| result);
        let final_success = succeeded && authority_write.is_ok();
        let _ = append_diagnostics_log(
            &app,
            "runtime",
            if final_success { "info" } else { "error" },
            if final_success {
                "watch_mode.evidence_driven_terminal_saved"
            } else {
                "watch_mode.evidence_driven_terminal_failed"
            },
            Some(format!(
                "runMarker={} terminalAuthorityPath={} authoritySaved={} {}",
                config.identity.run_marker,
                config.terminal_authority_path,
                authority_write.is_ok(),
                error_detail.as_deref().unwrap_or("status=completed"),
            )),
            None,
            None,
        );
        if exit_after_report {
            app.exit(if final_success { 0 } else { 1 });
        }
    });
}

pub(super) fn write_terminal_authority_immutable(
    authority_path: &str,
    authority: &TerminalAuthority,
) -> Result<(), String> {
    write_json_immutable(authority_path, "Terminal authority", authority)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ImmutableJsonReceipt {
    pub(super) relative_path: String,
    pub(super) byte_length: u64,
    pub(super) sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ImmutableJsonWriteError {
    code: &'static str,
    detail: String,
}

impl std::fmt::Display for ImmutableJsonWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

fn immutable_write_error(
    code: &'static str,
    label: &str,
    output_path: &str,
    error: impl std::fmt::Display,
) -> ImmutableJsonWriteError {
    ImmutableJsonWriteError {
        code,
        detail: format!("{label} {output_path}: {error}"),
    }
}

pub(super) fn write_json_immutable<T: Serialize>(
    output_path: &str,
    label: &str,
    value: &T,
) -> Result<ImmutableJsonReceipt, ImmutableJsonWriteError> {
    use std::io::Write;

    let path = std::path::PathBuf::from(output_path);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| immutable_write_error("invalid-path", label, output_path, "path has no file name"))?;
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|error| immutable_write_error("create-parent-failed", label, output_path, error))?;
    }
    if path.exists() {
        return Err(immutable_write_error(
            "immutable-exists",
            label,
            output_path,
            "immutable target already exists",
        ));
    }
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.{}.tmp",
        Uuid::new_v4().simple()
    ));
    let result = (|| -> Result<ImmutableJsonReceipt, ImmutableJsonWriteError> {
        let json = serde_json::to_vec_pretty(value)
            .map_err(|error| immutable_write_error("serialize-failed", label, output_path, error))?;
        let byte_length = u64::try_from(json.len()).map_err(|error| {
            immutable_write_error("length-overflow", label, output_path, error)
        })?;
        let sha256 = format!("{:x}", Sha256::digest(&json));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| immutable_write_error("create-temp-failed", label, output_path, error))?;
        file.write_all(&json)
            .map_err(|error| immutable_write_error("write-failed", label, output_path, error))?;
        file.sync_all()
            .map_err(|error| immutable_write_error("sync-failed", label, output_path, error))?;
        drop(file);
        std::fs::hard_link(&temporary_path, &path).map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::AlreadyExists {
                "immutable-exists"
            } else {
                "publish-failed"
            };
            immutable_write_error(code, label, output_path, error)
        })?;
        std::fs::remove_file(&temporary_path)
            .map_err(|error| immutable_write_error("remove-temp-failed", label, output_path, error))?;
        Ok(ImmutableJsonReceipt {
            relative_path: file_name.to_string(),
            byte_length,
            sha256,
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

pub(super) fn write_report_atomic(
    report_path: &str,
    report: &crate::audio::contracts::WatchSessionReportRuntime,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(report_path);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Watch report path has no file name: {report_path}"))?;
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.{}.tmp",
        Uuid::new_v4().simple()
    ));
    let result = (|| -> Result<(), String> {
        let json = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
        std::fs::write(&temporary_path, json).map_err(|error| error.to_string())?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&temporary_path, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}
