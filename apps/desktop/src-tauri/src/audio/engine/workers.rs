fn run_route_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    input_completion_rx: Option<mpsc::Receiver<RouteInputCompletionRequest>>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
    bridge_source_context: Option<BridgeSourceWorkerContext>,
) -> Result<(), String> {
    spec.ensure_feedback_backend_available()?;
    if spec.uses_bridge_source() {
        return run_bridge_source_route_worker(
            app,
            store,
            direction,
            spec,
            stop_rx,
            input_completion_rx.ok_or_else(|| {
                "Bridge source worker started without an input-completion receiver".to_string()
            })?,
            stt_sender,
            init_done,
            bridge_source_context.ok_or_else(|| {
                "Bridge source worker started without an authoritative capture generation"
                    .to_string()
            })?,
        );
    }

    let initialized = initialize_capture_route(&app, direction, &spec)?;
    if let Some(ref flag) = init_done {
        flag.store(true, Ordering::Relaxed);
    }
    if initialized.init_elapsed.as_secs() >= 2 {
        diag_log_detail(
            &app,
            "audio",
            "info",
            format!(
                "设备初始化完成（耗时 {:.1}s）",
                initialized.init_elapsed.as_secs_f64(),
            ),
            format!(
                "direction={} device={}",
                direction, initialized.effective_device_id
            ),
        );
    }

    run_capture_loop(app, store, direction, spec, initialized, stop_rx, stt_sender)
}

/// Runs the capture loop for an already-initialized WASAPI route. Shared by the
/// cold-start worker and the pre-warmed route activation path so there is a
/// single owner of `start_stream` plus the flow-health capture loop.
fn run_capture_loop(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    initialized: InitializedCaptureRoute,
    stop_rx: mpsc::Receiver<()>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
) -> Result<(), String> {
    let InitializedCaptureRoute {
        _device,
        effective_device_id,
        audio_client,
        capture_client,
        event_handle,
        buffer_frame_count,
        desired_format,
        init_elapsed: _,
    } = initialized;

    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(
        100 * desired_format.get_blockalign() as usize * (1024 + 2 * buffer_frame_count as usize),
    );
    let mut processor = RouteProcessor::new(spec.clone());

    store.mark_route_started(
        direction,
        &spec.route_id,
        &spec.requested_device_id,
        &effective_device_id,
    );
    emit_audio_snapshot(&app, store)?;

    if spec.echo_cancel_enabled() {
        store.reset_echo_canceller()?;
        diag_log_detail(
            &app,
            "audio",
            "info",
            "event=echo_cancel_reset",
            format!(
                "direction={} reason=route-start device={} captureFormat=48000-f32-stereo resetCovers=device-switch,route-restart,format-change",
                direction, effective_device_id,
            ),
        );
        let gate = crate::audio::echo_cancel::webrtc_aec3_build_gate();
        let stats = store.echo_canceller_stats().ok_or_else(|| {
            "WebRTC AEC3 production engine disappeared before capture startup".to_string()
        })?;
        diag_log_detail(
            &app,
            "audio",
            "info",
            "event=echo_cancel_backend",
            format!(
                "backend={} frameMs=10 renderSubmitFormat=48000-f32-stereo renderClock=wasapi-submit-position endpointRenderPadding=same-client-get-current-padding webRtcAec3Ready={} msvcBuildVerified={} linkedBackendPresent={} fixtureVerified={} dependency=\"{}\" reason=\"{}\"",
                stats.backend,
                gate.ready,
                gate.msvc_build_verified,
                gate.linked_backend_present,
                gate.fixture_verified,
                gate.dependency,
                gate.reason,
            ),
        );
    }

    audio_client.start_stream().map_err_str()?;
    // The stream is bound and the route now reports ready. Microphone capture is
    // expected to deliver packets promptly, but system loopback legitimately has
    // no frames while every media source is paused. Keep Watch alive in that
    // state so users can start it before pressing play.
    let capture_started_at = Instant::now();
    let mut inbound_wait_logged = false;
    let mut echo_diagnostics = EchoCancelDiagnostics::new();
    let mut aec_delay_estimator = AecDelayEstimator::new(SAMPLE_RATE_HZ as u32, CHANNEL_COUNT);
    let mut current_aec_delay_samples = 0_usize;
    let mut last_delay_diagnostic_at: Option<Instant> = None;
    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = audio_client.stop_stream();
            break;
        }

        if processor.frames_captured == 0
            && capture_started_at.elapsed() >= Duration::from_secs(AUDIO_FLOW_HEALTH_WINDOW_SECS)
        {
            if should_fail_on_initial_frame_stall(direction) {
                let _ = audio_client.stop_stream();
                return Err(audio_flow_stall_error(direction, capture_started_at.elapsed()));
            }
            if !inbound_wait_logged {
                diag_log_detail(
                    &app,
                    "audio",
                    "info",
                    "系统音频流已绑定，正在等待媒体开始播放。",
                    format!(
                        "direction={direction} routeId={} elapsedMs={} framesCaptured=0",
                        spec.route_id,
                        capture_started_at.elapsed().as_millis(),
                    ),
                );
                inbound_wait_logged = true;
            }
        }

        let chunk_len = desired_format.get_blockalign() as usize * CHUNK_FRAMES;
        let queued_bytes_before_read = sample_queue.len();
        let buffer_info = capture_client
            .read_from_device_to_deque(&mut sample_queue)
            .map_err_str()?;
        if spec.echo_cancel_enabled()
            && (sample_queue.len() >= chunk_len
                || buffer_info.flags.data_discontinuity
                || buffer_info.flags.timestamp_error)
        {
            let block_align = desired_format.get_blockalign() as usize;
            let (queue_head_device_frame_index, queue_head_qpc_100ns, queued_capture_frames) =
                capture_queue_head_clock(
                    buffer_info.index,
                    buffer_info.timestamp,
                    queued_bytes_before_read,
                    block_align,
                    SAMPLE_RATE_HZ as u32,
                );
            let capture_padding_frames = audio_client.get_current_padding().ok();
            let render_clock = store.echo_render_clock_snapshot();
            let playback_active = store.inbound_speaker_playback_active();
            let render_clock_age_ms = playback_active
                .then(|| {
                    render_clock
                        .last_observed_at
                        .map(|observed| observed.elapsed().as_secs_f64() * 1_000.0)
                })
                .flatten();
            let (render_endpoint_padding_frames, render_reference_lead_frames) =
                active_render_delay_frames(
                    playback_active,
                    render_clock.endpoint_padding_frames,
                    render_clock.reference_lead_frames,
                );
            let estimate = aec_delay_estimator.observe_capture(CaptureClockObservation {
                device_frame_index: queue_head_device_frame_index,
                packet_qpc_100ns: queue_head_qpc_100ns,
                observed_qpc_100ns: qpc_now_100ns(),
                capture_padding_frames,
                capture_buffer_frames: buffer_frame_count,
                render_clock_age_ms,
                // A completed playback leaves its final endpoint observation
                // in diagnostics. Never reinterpret that stale padding as a
                // delay for later near-end-only capture frames.
                render_endpoint_padding_frames,
                render_reference_lead_frames,
                render_submitted_frames: render_clock.submitted_frames,
                render_discontinuity_count: render_clock.discontinuity_count,
                data_discontinuity: buffer_info.flags.data_discontinuity,
                timestamp_error: buffer_info.flags.timestamp_error,
            });
            current_aec_delay_samples = estimate.delay_samples;
            if estimate.aec_reset_required {
                store.reset_echo_canceller()?;
                diag_log_detail(
                    &app,
                    "audio",
                    "warn",
                    "event=echo_cancel_reset",
                    format!(
                        "direction={} reason={} dataDiscontinuity={} timestampError={} capturePaddingInvalid={} delayResetRequired={} packetDeviceFrameIndex={} queueHeadDeviceFrameIndex={} packetTimestamp100ns={} queueHeadTimestamp100ns={} queuedCaptureFrames={} paddingFrames={:?} bufferFrames={} delayMs={:.1} delaySource={} estimatorResetCount={} timestampErrorCount={}",
                        direction,
                        estimate.aec_reset_reason.unwrap_or("unknown"),
                        buffer_info.flags.data_discontinuity,
                        buffer_info.flags.timestamp_error,
                        estimate.capture_padding_invalid,
                        estimate.delay_reset_required,
                        buffer_info.index,
                        queue_head_device_frame_index,
                        buffer_info.timestamp,
                        queue_head_qpc_100ns,
                        queued_capture_frames,
                        estimate.capture_padding_frames,
                        buffer_frame_count,
                        estimate.delay_ms,
                        estimate.source,
                        aec_delay_estimator.reset_count(),
                        aec_delay_estimator.timestamp_error_count(),
                    ),
                );
            }
            if last_delay_diagnostic_at
                .map(|last| last.elapsed() >= Duration::from_secs(5))
                .unwrap_or(true)
            {
                diag_log_detail(
                    &app,
                    "audio",
                    "info",
                    "event=echo_cancel_delay",
                    format!(
                        "direction={} delayMs={:.1} delaySamples={} packetAgeMs={:?} capturePaddingFrames={:?} renderClock=wasapi-submit-position renderPlayerPositionMs={:?} renderClockAgeMs={:?} renderSubmittedFrames={:?} endpointRenderPaddingFrames={:?} renderReferenceLeadFrames={:?} effectiveRenderReferenceLeadFrames={:?} renderDiscontinuities={} lastRenderDiscontinuity={:?} source={}",
                        direction,
                        estimate.delay_ms,
                        estimate.delay_samples,
                        estimate.packet_age_ms,
                        estimate.capture_padding_frames,
                        render_clock.player_position.map(|position| position.as_millis()),
                        estimate.render_clock_age_ms,
                        estimate.render_submitted_frames,
                        estimate.render_endpoint_padding_frames,
                        estimate.render_reference_lead_frames,
                        estimate.effective_render_reference_lead_frames,
                        render_clock.discontinuity_count,
                        render_clock.last_discontinuity_reason,
                        estimate.source,
                    ),
                );
                last_delay_diagnostic_at = Some(Instant::now());
            }
        }

        for (chunk_index, chunk) in drain_sample_chunks(&mut sample_queue, chunk_len)
            .into_iter()
            .enumerate()
        {
            let chunk = if spec.echo_cancel_enabled() {
                let f32_chunk = bytes_to_f32_stereo(&chunk);
                let delay_samples = current_aec_delay_samples.saturating_sub(
                    chunk_index
                        .saturating_mul(CHUNK_FRAMES)
                        .saturating_mul(CHANNEL_COUNT),
                );
                let cancellation = store.process_echo_capture(&f32_chunk, delay_samples)?;
                // AEC3 output is the capture stream. Playback state is logged
                // only as context and cannot delete a capture block.
                let playback_active = store.inbound_speaker_playback_active();
                store.record_aec3_capture_chunk(playback_active);
                let cleaned_bytes = f32_stereo_to_bytes(&cancellation.samples);
                echo_diagnostics.record(
                    calculate_chunk_db(&chunk),
                    calculate_chunk_db(&cleaned_bytes),
                    playback_active,
                );
                echo_diagnostics.maybe_log(&app, store, direction);
                cleaned_bytes
            } else {
                chunk
            };

            process_captured_chunk(
                &app,
                store,
                direction,
                &mut processor,
                &stt_sender,
                chunk,
                sample_queue.len(),
            )?;
        }

        let _ = event_handle.wait_for_event(500);
    }

    Ok(())
}

pub(crate) fn process_loopback_route_start_error(
    bridge: &crate::bridge::contracts::BridgeRuntimeSnapshot,
) -> Option<String> {
    use crate::bridge::contracts::ProcessLoopbackStatus;

    if !bridge.process_loopback_supported
        || bridge.process_loopback_status == ProcessLoopbackStatus::Unsupported
    {
        return Some(format!(
            "Windows process audio exclusion is unavailable (build={}, minimumBuild={}): {} | code: bridge.process-loopback-unsupported | recommended: open-diagnostics",
            bridge
                .windows_build_number
                .map(|build| build.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            bridge.process_loopback_minimum_windows_build,
            bridge
                .process_loopback_failure_detail
                .as_deref()
                .unwrap_or("process-loopback capability probe did not pass")
        ));
    }
    if bridge.process_loopback_status != ProcessLoopbackStatus::Failed {
        return None;
    }
    let code = bridge
        .last_error_code
        .as_deref()
        .filter(|code| code.starts_with("bridge.process-loopback-"))
        .unwrap_or("bridge.process-loopback-activation-failed");
    let action = if code == "bridge.process-loopback-capture-failed" {
        "restart-bridge"
    } else {
        "open-diagnostics"
    };
    Some(format!(
        "Process-loopback source route failed: {} | code: {code} | recommended: {action}",
        bridge
            .process_loopback_failure_detail
            .as_deref()
            .unwrap_or("process-loopback activation failed without diagnostic detail")
    ))
}

fn accept_bridge_source_identity(
    app: &AppHandle,
    store: &AudioStateStore,
    worker_context: &BridgeSourceWorkerContext,
    identity: &BridgeSourceFrameIdentity,
    is_pcm_frame: bool,
) -> bool {
    let bridge_state = app.state::<BridgeStateStore>();
    let mut disposition = BridgeSourceIdentityDisposition::Reject(
        "bridge-source-identity-not-evaluated".to_string(),
    );
    let authoritative = bridge_state.update_snapshot(|current| {
        disposition = bridge_source_identity_disposition(current, identity);
        let accepted =
            apply_bridge_source_identity_observation(current, identity, &disposition, is_pcm_frame);
        if accepted && is_pcm_frame {
            // Keep the disposition/current-owner check, snapshot mutation and
            // accepted-frame evidence under the Bridge state lock. A restart
            // cannot otherwise interleave after acceptance but before the
            // diagnostic ledger records which owner supplied the frame.
            store.record_bridge_source_frame_accepted(identity.clone());
        }
    });
    match disposition {
        BridgeSourceIdentityDisposition::Current => {
            worker_context.rebind(authoritative);
            true
        }
        BridgeSourceIdentityDisposition::Rebind => {
            worker_context.rebind(authoritative);
            diag_log_detail(
                app,
                "bridge",
                "info",
                "event=bridge_source_generation_rebound",
                format!(
                    "bridgeProcessId={} bridgeInstanceId={} sessionId={} sourceGeneration={} sourceGenerationToken={} frameTimestampMs={} readTimestampMs={}",
                    identity.bridge_process_id,
                    identity.bridge_instance_id,
                    identity.session_id,
                    identity.source_generation,
                    identity.source_generation_token,
                    identity.frame_timestamp_ms,
                    identity.read_timestamp_ms,
                ),
            );
            true
        }
        BridgeSourceIdentityDisposition::Reject(reason) => {
            if is_pcm_frame {
                store.record_bridge_source_frame_rejected(identity.clone());
            }
            diag_log_detail(
                app,
                "bridge",
                "warning",
                "event=stale_bridge_source_frame_rejected",
                format!(
                    "reason={reason} envelopeType={} bridgeProcessId={} bridgeInstanceId={} sessionId={} sourceGeneration={} sourceGenerationToken={} frameTimestampMs={} readTimestampMs={}",
                    if is_pcm_frame { "frame" } else { "heartbeat" },
                    identity.bridge_process_id,
                    identity.bridge_instance_id,
                    identity.session_id,
                    identity.source_generation,
                    identity.source_generation_token,
                    identity.frame_timestamp_ms,
                    identity.read_timestamp_ms,
                ),
            );
            false
        }
    }
}

fn run_bridge_source_route_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    input_completion_rx: mpsc::Receiver<RouteInputCompletionRequest>,
    mut stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
    bridge_source_context: BridgeSourceWorkerContext,
) -> Result<(), String> {
    let bridge_snapshot = validate_bridge_source_startup(&spec, &bridge_source_context)?;
    let mut processor = RouteProcessor::new(spec);
    let mut sample_queue = VecDeque::new();
    let mut initialized = false;
    let init_start = Instant::now();
    let mut last_not_ready_log_at = None;
    let mut reconnect_started_at: Option<Instant> = None;
    let mut heartbeat_count = 0_u64;
    let mut pcm_frame_count = 0_u64;
    let mut pcm_bytes = 0_u64;
    let mut ignored_envelope_count = 0_u64;
    let mut last_pcm_at: Option<Instant> = None;
    let mut last_summary_at = Instant::now();
    let mut first_heartbeat_logged = false;
    let mut first_pcm_logged = false;
    let mut provider_input_completed = false;
    loop {
        let mut source_pipe = loop {
            if stop_rx.try_recv().is_ok() {
                return Ok(());
            }
            observe_bridge_input_completion_request(
                &app,
                store,
                direction,
                &input_completion_rx,
                &mut processor,
                &mut sample_queue,
                &mut stt_sender,
                &mut provider_input_completed,
            )?;
            match OpenOptions::new()
                .read(true)
                .write(true)
                .open(&bridge_snapshot.source_pipe_path)
            {
                Ok(pipe) => break pipe,
                Err(error) => {
                    let elapsed = init_start.elapsed();
                    if last_not_ready_log_at
                        .map(|logged_at: Instant| logged_at.elapsed() >= Duration::from_secs(2))
                        .unwrap_or(true)
                    {
                        diag_log_detail(
                            &app,
                            "audio",
                            "warning",
                            "Bridge source pipe is not ready.",
                            error.to_string(),
                        );
                        last_not_ready_log_at = Some(Instant::now());
                    }
                    if !initialized {
                        if let Some(timeout_error) = bridge_source_timeout_error(elapsed) {
                            return Err(timeout_error);
                        }
                    } else if reconnect_started_at.is_none() {
                        reconnect_started_at = Some(Instant::now());
                        diag_log_detail(
                            &app,
                            "audio",
                            "warning",
                            "Bridge source reconnection started.",
                            format!("timeoutSecs={}", BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS),
                        );
                    }
                    thread::sleep(Duration::from_millis(BRIDGE_SOURCE_PIPE_RETRY_MS));
                }
            }
        };
        if !initialized {
            diag_log_detail(
                &app,
                "audio",
                "info",
                "event=bridge_source_pipe_connected",
                format!("pipe={}", bridge_snapshot.source_pipe_path),
            );
            if let Some(ref flag) = init_done {
                flag.store(true, Ordering::Relaxed);
            }
            store.mark_route_started(
                direction,
                &processor.spec.route_id,
                &processor.spec.requested_device_id,
                &bridge_snapshot.source_pipe_path,
            );
            emit_audio_snapshot(&app, store)?;
            initialized = true;
        } else if reconnect_started_at.is_some() {
            reconnect_started_at = None;
            diag_log_detail(
                &app,
                "audio",
                "info",
                "event=bridge_source_pipe_reconnected",
                format!("pipe={}", bridge_snapshot.source_pipe_path),
            );
        }
        loop {
            if stop_rx.try_recv().is_ok() {
                return Ok(());
            }
            observe_bridge_input_completion_request(
                &app,
                store,
                direction,
                &input_completion_rx,
                &mut processor,
                &mut sample_queue,
                &mut stt_sender,
                &mut provider_input_completed,
            )?;
            let payload = match read_bridge_source_payload(&mut source_pipe) {
                Ok(BridgeSourceEnvelope::Frame { payload, identity }) => {
                    if !accept_bridge_source_identity(
                        &app,
                        store,
                        &bridge_source_context,
                        &identity,
                        true,
                    ) {
                        continue;
                    }
                    if provider_input_completed {
                        ignored_envelope_count = ignored_envelope_count.saturating_add(1);
                        continue;
                    }
                    pcm_frame_count += 1;
                    pcm_bytes += payload.len() as u64;
                    last_pcm_at = Some(Instant::now());
                    if !first_pcm_logged {
                        diag_log_detail(
                            &app,
                            "audio",
                            "info",
                            "event=bridge_source_first_pcm",
                            format!(
                                "frameCount={} payloadBytes={}",
                                pcm_frame_count,
                                payload.len()
                            ),
                        );
                        first_pcm_logged = true;
                    }
                    payload
                }
                Ok(BridgeSourceEnvelope::Heartbeat(identity)) => {
                    if !accept_bridge_source_identity(
                        &app,
                        store,
                        &bridge_source_context,
                        &identity,
                        false,
                    ) {
                        continue;
                    }
                    heartbeat_count += 1;
                    if !first_heartbeat_logged {
                        diag_log_detail(
                            &app,
                            "audio",
                            "info",
                            "event=bridge_source_first_heartbeat",
                            "payloadBytes=0".to_string(),
                        );
                        first_heartbeat_logged = true;
                    }
                    log_bridge_source_consumer_summary(
                        &app,
                        &mut last_summary_at,
                        heartbeat_count,
                        pcm_frame_count,
                        pcm_bytes,
                        ignored_envelope_count,
                        last_pcm_at,
                    );
                    continue;
                }
                Ok(BridgeSourceEnvelope::RouteError { code, message }) => {
                    return Err(bridge_source_route_error(&code, &message));
                }
                Ok(BridgeSourceEnvelope::TranslationStatus {
                    status_id,
                    session_id,
                    bridge_instance_id,
                    source_generation,
                    source_generation_token,
                    playback_owner_generation,
                    physical_playback_device_id,
                    cue_id,
                    status,
                    reason,
                    error_code,
                    timestamp_ms,
                }) => {
                    if !handle_bridge_translation_status(
                        &app,
                        store,
                        &mut source_pipe,
                        &status_id,
                        &session_id,
                        &bridge_instance_id,
                        source_generation,
                        &source_generation_token,
                        playback_owner_generation,
                        &physical_playback_device_id,
                        &cue_id,
                        &status,
                        &reason,
                        error_code.as_deref(),
                        timestamp_ms,
                    ) {
                        sample_queue.clear();
                        break;
                    }
                    continue;
                }
                Ok(BridgeSourceEnvelope::Ignored(reason)) => {
                    ignored_envelope_count += 1;
                    diag_log_detail(
                        &app,
                        "audio",
                        "warning",
                        "event=bridge_source_envelope_ignored",
                        reason,
                    );
                    continue;
                }
                Err(error) => {
                    sample_queue.clear();
                    diag_log_detail(
                        &app,
                        "audio",
                        "warning",
                        "Bridge source pipe disconnected. Reconnecting.",
                        error,
                    );
                    if let Some(reconnect_start) = reconnect_started_at {
                        let reconnect_elapsed = reconnect_start.elapsed();
                        if reconnect_elapsed >= Duration::from_secs(BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS) {
                            return Err(format!(
                                "Bridge source pipe reconnection timed out after {}s. The bridge process may be a zombie. | recommended: restart-bridge",
                                BRIDGE_SOURCE_RECONNECT_TIMEOUT_SECS
                            ));
                        }
                    }
                    break;
                }
            };
            log_bridge_source_consumer_summary(
                &app,
                &mut last_summary_at,
                heartbeat_count,
                pcm_frame_count,
                pcm_bytes,
                ignored_envelope_count,
                last_pcm_at,
            );
            sample_queue.extend(pcm16le_to_f32le(&payload));
            let chunk_len = CHUNK_FRAMES * CHANNEL_COUNT * std::mem::size_of::<f32>();
            for chunk in drain_sample_chunks(&mut sample_queue, chunk_len) {
                process_captured_chunk(
                    &app,
                    store,
                    direction,
                    &mut processor,
                    &stt_sender,
                    chunk,
                    sample_queue.len(),
                )?;
            }
        }
    }
}

fn log_bridge_source_consumer_summary(
    app: &AppHandle,
    last_summary_at: &mut Instant,
    heartbeat_count: u64,
    pcm_frame_count: u64,
    pcm_bytes: u64,
    ignored_envelope_count: u64,
    last_pcm_at: Option<Instant>,
) {
    if last_summary_at.elapsed() < Duration::from_secs(5) {
        return;
    }
    diag_log_detail(
        app,
        "audio",
        "info",
        "event=bridge_source_consumer_summary",
        format!(
            "heartbeats={} pcmFrames={} pcmBytes={} ignoredEnvelopes={} lastPcmAgeMs={}",
            heartbeat_count,
            pcm_frame_count,
            pcm_bytes,
            ignored_envelope_count,
            last_pcm_at
                .map(|timestamp| timestamp.elapsed().as_millis().to_string())
                .unwrap_or_else(|| "none".to_string()),
        ),
    );
    *last_summary_at = Instant::now();
}

fn bridge_source_timeout_error(elapsed: Duration) -> Option<String> {
    (elapsed >= Duration::from_secs(DEVICE_INIT_TIMEOUT_SECS)).then(|| {
        format!(
            "Bridge source pipe initialization timed out ({}s). | recommended: restart-bridge",
            DEVICE_INIT_TIMEOUT_SECS
        )
    })
}

/// Builds the attributable error raised when a route binds its stream but never
/// captures a frame within [`AUDIO_FLOW_HEALTH_WINDOW_SECS`]. The trailing
/// `| code:` / `| recommended:` markers are parsed by the route worker error
/// handler into the snapshot's `last_error_code` / `recommended_action` so the
/// UI can surface a translated message and a concrete next step.
fn audio_flow_stall_error(direction: &str, elapsed: Duration) -> String {
    let source = if direction == "inbound" {
        "系统音频"
    } else {
        "麦克风"
    };
    format!(
        "{source}采集已就绪，但在 {} 秒内没有捕获到任何音频帧，设备可能已静音或被其他应用以独占模式占用。 | code: audio.flow-stalled | recommended: check-audio-source",
        elapsed.as_secs().max(1)
    )
}

fn should_fail_on_initial_frame_stall(direction: &str) -> bool {
    direction != "inbound"
}

fn active_render_delay_frames(
    playback_active: bool,
    endpoint_padding_frames: Option<u32>,
    reference_lead_frames: Option<u32>,
) -> (Option<u32>, Option<u32>) {
    if playback_active {
        (endpoint_padding_frames, reference_lead_frames)
    } else {
        (None, None)
    }
}

fn capture_queue_head_clock(
    packet_device_frame_index: u64,
    packet_qpc_100ns: u64,
    queued_bytes_before_read: usize,
    block_align: usize,
    sample_rate_hz: u32,
) -> (u64, u64, u64) {
    if block_align == 0 || sample_rate_hz == 0 {
        return (packet_device_frame_index, packet_qpc_100ns, 0);
    }
    let queued_frames = (queued_bytes_before_read / block_align) as u64;
    let queued_duration_100ns = queued_frames
        .saturating_mul(10_000_000)
        .saturating_div(u64::from(sample_rate_hz));
    (
        packet_device_frame_index.saturating_sub(queued_frames),
        packet_qpc_100ns.saturating_sub(queued_duration_100ns),
        queued_frames,
    )
}

fn process_captured_chunk(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    processor: &mut RouteProcessor,
    stt_sender: &Option<mpsc::Sender<Vec<u8>>>,
    chunk: Vec<u8>,
    queued_bytes: usize,
) -> Result<(), String> {
    if let Some(stt_tx) = stt_sender {
        if let Err(error) = stt_tx.send(chunk.clone()) {
            let message = format!("audio route sender unavailable for {direction}: {error}");
            let _ = diag_log_detail(
                app,
                "audio",
                "error",
                "watch_mode.omni_sender_unavailable",
                format!("direction={direction} error={error}"),
            );
            return Err(format!("{message} | recommended: restart-route"));
        }
    }
    let update = processor.ingest_chunk(&chunk, queued_bytes);
    store.update_route_metrics(
        direction,
        &update.capture_state,
        &update.pre_buffer_state,
        &update.vad_state,
        update.buffer_ahead_ms,
        update.frames_captured,
        update.last_energy_db,
        Some(now_unix_millis_marker()),
        update.active_segment_id.clone(),
    );
    if let Some(segment) = update.finalized_segment {
        store.increment_segment_count(direction);
        store.cache_segment_audio(segment.audio);
        if should_push_placeholder_cue(direction, stt_sender.is_some()) {
            store.push_subtitle_cue(segment.cue);
        }
    }
    emit_audio_snapshot(app, store)
}

/// Whether a finalized VAD segment should surface a placeholder subtitle cue
/// ("检测到麦克风片段 N"). These exist only to show microphone activity when
/// no recognition session is attached: inbound never shows them (loopback can
/// be legitimately silent), and once outbound has an ASR/realtime sender the
/// session emits the real transcript cues, so the placeholder would otherwise
/// pollute the translate queue with untranslatable diagnostic text.
fn should_push_placeholder_cue(direction: &str, has_recognition_sender: bool) -> bool {
    direction != "inbound" && !has_recognition_sender
}

#[cfg(test)]
mod placeholder_cue_tests {
    use super::{
        active_render_delay_frames, capture_queue_head_clock, should_push_placeholder_cue,
    };

    #[test]
    fn outbound_without_sender_shows_placeholder_but_with_sender_does_not() {
        // Mic-only, no recognition session: keep the activity placeholder.
        assert!(should_push_placeholder_cue("outbound", false));
        // Mic with a real ASR/realtime session: the session emits transcript
        // cues, so no placeholder must be pushed.
        assert!(!should_push_placeholder_cue("outbound", true));
        // Inbound never surfaces placeholders regardless of sender presence.
        assert!(!should_push_placeholder_cue("inbound", false));
        assert!(!should_push_placeholder_cue("inbound", true));
    }

    #[test]
    fn inactive_playback_cannot_reuse_stale_render_padding_as_delay() {
        assert_eq!(
            active_render_delay_frames(false, Some(960), Some(480)),
            (None, None)
        );
        assert_eq!(
            active_render_delay_frames(true, Some(960), Some(480)),
            (Some(960), Some(480))
        );
    }

    #[test]
    fn capture_delay_is_anchored_to_the_first_frame_already_in_the_chunk_queue() {
        // One 10 ms 48 kHz stereo-f32 packet (480 * 8 bytes) is already
        // waiting when the next packet arrives.
        assert_eq!(
            capture_queue_head_clock(9_600, 2_000_000, 480 * 8, 8, 48_000),
            (9_120, 1_900_000, 480)
        );
    }
}
