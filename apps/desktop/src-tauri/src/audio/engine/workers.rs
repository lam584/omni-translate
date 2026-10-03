#[path = "workers/capture_diagnostics.rs"]
mod capture_diagnostics;
#[path = "workers/capture_route.rs"]
mod capture_route;
use capture_diagnostics::AecTapQueueClock;
#[path = "workers/capture_pump_timing.rs"]
mod capture_pump_timing;
use capture_pump_timing::{Part as CapturePart, Observation as CaptureObservation};
#[path = "workers/capture_queue_provenance.rs"]
mod capture_queue_provenance;
#[path = "workers/capture_packet_segments.rs"]
mod capture_packet_segments;
#[path = "workers/capture_pipeline.rs"]
mod capture_pipeline;
#[path = "workers/capture_tail.rs"]
mod capture_tail;
#[path = "workers/capture_tail_owner.rs"]
mod capture_tail_owner;

const ECHO_CANCEL_RESET_DIAGNOSTIC_LEVEL: &str = "warning";

fn run_route_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    input_completion_rx: Option<mpsc::Receiver<RouteInputCompletionRequest>>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
    native_capture_start: Option<NativeCaptureStartAck>,
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

    let native_capture_start = native_capture_start.ok_or("native capture worker missing Start owner")?;
    run_capture_loop(app, store, direction, spec, initialized, stop_rx, stt_sender, native_capture_start)
}

/// Runs the capture loop for an already-initialized WASAPI route. Shared by the
/// cold-start worker and the pre-warmed route activation path so there is a
/// single owner of `start_stream` plus the flow-health capture loop.
fn capture_event_wait_required(next_packet_size: Option<u32>) -> bool {
    next_packet_size.is_none_or(|frames| frames == 0)
}

// Timeout is only a wake to do another real packet query, never health.
fn capture_event_wait_result(result: Result<(), wasapi::WasapiError>) -> Result<(), String> {
    match result {
        Ok(()) | Err(wasapi::WasapiError::EventTimeout) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn capture_stop_requested(stop_rx: &mpsc::Receiver<()>) -> Result<bool, String> {
    match stop_rx.try_recv() {
        Ok(()) => Ok(true),
        Err(mpsc::TryRecvError::Empty) => Ok(false),
        Err(mpsc::TryRecvError::Disconnected) => Err("native capture stop owner disconnected".into()),
    }
}

/// Accept stop on the producer before any later native work or publication.
fn accept_native_capture_stop(
    stop_rx: &mpsc::Receiver<()>, guard: &crate::audio::state::NativeCaptureProducerGuard,
) -> Result<bool, String> {
    let requested = capture_stop_requested(stop_rx)?;
    if requested { guard.stopping(); }
    Ok(requested)
}

fn initialize_capture_echo_diagnostics(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: &RouteSpec,
    effective_device_id: &str,
    pipeline: &capture_pipeline::CapturePipeline,
    guard: &crate::audio::state::NativeCaptureProducerGuard,
) -> Result<(), String> {
    if spec.echo_cancel_enabled() {
        let tap_qpc = if store.aec_diagnostic_tap_enabled() { qpc_now_100ns() } else { None };
        let native_generation_before = guard.diagnostic_owner_identity().1;
        let reset_result = store.reset_echo_canceller_with_diagnostic("route-start", tap_qpc, 0);
        pipeline.record_aec_reset_receipt(store, direction, guard, "route-start",
            native_generation_before, &reset_result);
        reset_result?;
        capture_diagnostics::log_route_start(app, store, direction, effective_device_id)?;
    }
    Ok(())
}


/// Only called after AEC/dispatch returned. A wait never publishes health.
#[allow(clippy::too_many_arguments)]
fn query_native_capture_and_wait(
    capture_client: &wasapi::AudioCaptureClient, event_handle: &wasapi::Handle,
    stop_rx: &mpsc::Receiver<()>, guard: &crate::audio::state::NativeCaptureProducerGuard,
    mut work: crate::audio::state::NativeCaptureWork, queue: &mut VecDeque<u8>,
    tail_owner: &mut capture_tail_owner::CaptureTailOwner, native_start: &NativeCaptureStartAck,
    pipeline: &mut capture_pipeline::CapturePipeline, app: &AppHandle, store: &AudioStateStore,
    direction: &str, spec: &RouteSpec, stt_sender: &Option<mpsc::Sender<Vec<u8>>>,
    timing: &capture_pump_timing::Handle,
) -> Result<bool, String> {
    let mut size = capture_pump_timing::measure_observed(timing, CapturePart::QueryPacket, || {
        let result = capture_client.get_next_packet_size().map_err(|error| {
            tail_owner.query_failed(native_start, queue);
            error.to_string()
        });
        let observation = result.as_ref().ok().map(|size| CaptureObservation::Query { packet_size: *size })
            .unwrap_or(CaptureObservation::None);
        (result, observation)
    })?;
    let at = Instant::now();
    let mut queried_at = at;
    if accept_native_capture_stop(stop_rx, guard)? { return Ok(true); }
    tail_owner.observe_query(at, native_start, queue, size)?;
    if spec.echo_cancel_enabled() {
        let queued_before_tail = queue.len();
        if let Some(tail) = tail_owner.take_ready(Instant::now(), native_start, queue)? {
            let dequeue = pipeline.observe_dequeue(store, direction, guard, queued_before_tail,
                queue.len(), Some(tail.pcm.len()), "partial-tail", None, 1)?;
            // Never publish the pre-processing Empty as proof of completed work.
            if accept_native_capture_stop(stop_rx, guard)? { return Ok(true); }
            let receipt = capture_tail_owner::tail_receipt(&tail.evidence);
            capture_pump_timing::measure(timing, CapturePart::TailProcess, ||
                pipeline.process_chunk(app, store, direction, spec, stt_sender, tail.pcm,
                    queue.len(), guard, Some(receipt), None, dequeue.as_ref().map(|r| (r, 0))))?;
            size = capture_pump_timing::measure_observed(timing, CapturePart::QueryPacket, || {
                let result = capture_client.get_next_packet_size().map_err(|error| {
                    tail_owner.query_failed(native_start, queue);
                    error.to_string()
                });
                let observation = result.as_ref().ok().map(|size| CaptureObservation::Query { packet_size: *size })
                    .unwrap_or(CaptureObservation::None);
                (result, observation)
            })?;
            let after_work = Instant::now();
            queried_at = after_work;
            if accept_native_capture_stop(stop_rx, guard)? { return Ok(true); }
            tail_owner.observe_query(after_work, native_start, queue, size)?;
        }
    }
    work.residual_bytes = queue.len();
    guard.publish_query(queried_at, crate::audio::state::NativeCaptureQuery::from_packet_size(size), work);
    if capture_event_wait_required(size) {
        capture_pump_timing::measure_observed(timing, CapturePart::EventWait, || {
            let result = event_handle.wait_for_event(20);
            let status = match &result {
                Ok(()) => capture_pump_timing::WaitStatus::Signaled,
                Err(wasapi::WasapiError::EventTimeout) => capture_pump_timing::WaitStatus::TimedOut,
                Err(_) => capture_pump_timing::WaitStatus::Failed,
            };
            (capture_event_wait_result(result), CaptureObservation::Wait { status, timeout_ms: 20 })
        })?;
    }
    Ok(false)
}

fn run_capture_loop(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    initialized: InitializedCaptureRoute,
    stop_rx: mpsc::Receiver<()>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    native_capture_start: NativeCaptureStartAck,
) -> Result<(), String> {
    let mut producer_guard = native_capture_start.producer_guard();
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
    capture_route::ensure_local_aec_probe_capture_route(
        &spec, stt_sender.is_some(), &effective_device_id,
    )?;
    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(
        100 * desired_format.get_blockalign() as usize * (1024 + 2 * buffer_frame_count as usize),
    );
    let timing = if store.aec_diagnostic_tap_enabled() {
        capture_pump_timing::new_handle(producer_guard.diagnostic_owner_identity().0,
            unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() }, effective_device_id.clone())
    } else { None };
    let mut pipeline = capture_pipeline::CapturePipeline::new(spec.clone());
    pipeline.capture_timing = timing.clone();
    let mut tail_owner = capture_tail_owner::CaptureTailOwner::new(CHUNK_FRAMES)?;
    let block_align = desired_format.get_blockalign() as usize;
    pipeline.bind_capture_queue(&effective_device_id, &producer_guard, sample_queue.len(),
        store.aec_diagnostic_tap_enabled())?;

    store.mark_route_started(
        direction,
        &spec.route_id,
        &spec.requested_device_id,
        &effective_device_id,
    );
    emit_audio_snapshot(&app, store)?;

    initialize_capture_echo_diagnostics(&app, store, direction, &spec, &effective_device_id,
        &pipeline, &producer_guard)?;

    if let Err(error) = native_capture_start.observe_native_start(audio_client.start_stream().map_err_str()) {
        if spec.echo_cancel_enabled() {
            // The route-start reset already happened before WASAPI start. Even
            // when start fails, close that reset event stream with one native
            // terminal snapshot so diagnostics cannot report a stale window.
            pipeline.diagnostics.log_final(&app, store, direction);
        }
        return Err(error);
    }
    // The stream is bound and the route now reports ready. Microphone capture is
    // expected to deliver packets promptly, but system loopback legitimately has
    // no frames while every media source is paused. Keep Watch alive in that
    // state so users can start it before pressing play.
    let capture_started_at = Instant::now();
    let mut inbound_wait_logged = false;
    let capture_result = (|| -> Result<(), String> {
      loop {
        if accept_native_capture_stop(&stop_rx, &producer_guard)? { break; }

        if pipeline.processor.frames_captured == 0
            && capture_started_at.elapsed() >= Duration::from_secs(AUDIO_FLOW_HEALTH_WINDOW_SECS)
        {
            if should_fail_on_initial_frame_stall(direction) {
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
        producer_guard.begin_work(queued_bytes_before_read);
        let buffer_info = capture_pump_timing::measure_observed(&timing, CapturePart::ReadPacket, || {
            let result = capture_client.read_from_device_to_deque(&mut sample_queue).map_err_str();
            let observation = result.as_ref().ok().map(|info| CaptureObservation::Packet {
                device_frame_index: info.index, qpc_100ns: info.timestamp,
                frames: (sample_queue.len() - queued_bytes_before_read) / block_align,
                data_discontinuity: info.flags.data_discontinuity,
                timestamp_error: info.flags.timestamp_error, silent: info.flags.silent,
            }).unwrap_or(CaptureObservation::None);
            (result, observation)
        })?;
        let packet_received_at = Instant::now();
        let captured_frames = (sample_queue.len() - queued_bytes_before_read)
            / desired_format.get_blockalign() as usize;
        let completed_work = capture_pump_timing::measure(&timing, CapturePart::WorkAccounting,
            || Ok::<_, String>(producer_guard.record_buffer_packet(
                captured_frames, &buffer_info, sample_queue.len(),
                || calculate_chunk_db(&sample_queue.make_contiguous()[queued_bytes_before_read..]),
            )))?;
        let boundary = capture_pump_timing::measure(&timing, CapturePart::PacketAdmission, ||
            pipeline.admit_native_packet(store, direction, &spec, &buffer_info,
                captured_frames, queued_bytes_before_read, &sample_queue, block_align, &producer_guard))?;
        if captured_frames > 0 { tail_owner.mutated()?; }
        if let Some(permit) = boundary {
            let proof = permit.proof();
            let metadata = pipeline.capture_metadata()?;
            let receipt = capture_pipeline::boundary_receipt(proof, metadata)?;
            let before = sample_queue.len();
            let prefix = pipeline.take_boundary_prefix(&mut sample_queue, permit)?;
            let dequeue = pipeline.observe_dequeue(store, direction, &producer_guard, before,
                sample_queue.len(), Some(prefix.len()), "packet-boundary", None, 1)?;
            tail_owner.mutated()?;
            // The old real prefix finishes BEFORE new-packet reset/preparation.
            // A stop/error cannot be converted into successful segment completion.
            if accept_native_capture_stop(&stop_rx, &producer_guard)? { return Ok(()); }
            capture_pump_timing::measure(&timing, CapturePart::BoundaryProcess, ||
                pipeline.process_chunk(&app, store, direction, &spec, &stt_sender, prefix,
                    sample_queue.len(), &producer_guard, None, Some(receipt),
                    dequeue.as_ref().map(|r| (r, 0))))?;
        }
        let queued_prefix_at_prepare = sample_queue.len().checked_sub(
            captured_frames.checked_mul(block_align).ok_or("capture packet byte count overflow")?)
            .ok_or("capture packet disappeared before preparation")?;
        capture_pump_timing::measure(&timing, CapturePart::PreparePacket, ||
            pipeline.prepare_packet(&app, store, direction, &spec, &audio_client, &buffer_info,
                captured_frames, queued_prefix_at_prepare, sample_queue.len(), block_align,
                buffer_frame_count, &producer_guard))?;
        pipeline.normal_dequeue_ready()?;
        let queued_before_dequeue = sample_queue.len();
        let chunks = capture_pump_timing::measure(&timing, CapturePart::Dequeue,
            || Ok::<_, String>(drain_sample_chunks(&mut sample_queue, chunk_len)))?;
        // drain_sample_chunks eagerly removes every full chunk before processing.
        // Witness that actual single FIFO mutation even if a later stop/error
        // prevents some removed chunks from reaching AEC/dispatch.
        let dequeued_bytes = chunks.iter().try_fold(0_usize, |total, chunk| total.checked_add(chunk.len()));
        let dequeue = pipeline.observe_dequeue(store, direction, &producer_guard,
            queued_before_dequeue, sample_queue.len(), dequeued_bytes,
            "full-chunk-batch", Some(chunk_len), chunks.len())?;
        for (chunk_index, chunk) in chunks.into_iter().enumerate() {
            tail_owner.mutated()?;
            if accept_native_capture_stop(&stop_rx, &producer_guard)? { return Ok(()); }
            capture_pump_timing::measure(&timing, CapturePart::FullChunkProcess, ||
                pipeline.process_chunk(&app, store, direction, &spec, &stt_sender, chunk,
                    sample_queue.len(), &producer_guard, None, None, dequeue.as_ref().and_then(|r|
                        chunk_index.checked_mul(chunk_len).map(|offset| (r, offset)))))?;
        }
        if captured_frames > 0 {
            // The read's real acquisition time, bound to its remaining suffix after full chunks.
            tail_owner.observe_packet(packet_received_at, &native_capture_start, &sample_queue)?;
        }

        if query_native_capture_and_wait(
            &capture_client, &event_handle, &stop_rx, &producer_guard, completed_work,
            &mut sample_queue, &mut tail_owner, &native_capture_start, &mut pipeline,
            &app, store, direction, &spec, &stt_sender, &timing,
        )? { break; }
      }
      Ok(())
    })();

    let native_stop_succeeded = std::cell::Cell::new(false);
    producer_guard.finish_capture(capture_result,
        || {
            let result = audio_client.stop_stream().map_err_str();
            native_stop_succeeded.set(result.is_ok());
            result
        },
        || {
            // Serialization/persistence is deferred until native Stop returned.
            // Failure is retained explicitly, never labelled as a successful stop.
            if let Some(mut receipt) = capture_pump_timing::receipt(&timing) {
                receipt["nativeStopSucceeded"] = serde_json::json!(native_stop_succeeded.get());
                if !native_stop_succeeded.get() { receipt["diagnosticIncomplete"] = serde_json::json!(true); }
                store.persist_aec_capture_pump_diagnostic(receipt);
            }
            if spec.echo_cancel_enabled() { pipeline.diagnostics.log_final(&app, store, direction); }
        },
    )
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


#[cfg(test)]
mod placeholder_cue_tests {
    use super::{
        active_render_delay_frames, capture_queue_head_clock, should_push_placeholder_cue,
    };

    #[test]
    fn capture_backlog_is_drained_before_waiting_for_another_event() {
        let queued_packet_sizes = [Some(960), Some(480), Some(0), None];
        let wait_decisions = queued_packet_sizes.map(super::capture_event_wait_required);

        assert_eq!(wait_decisions, [false, false, true, true]);
    }

    #[test]
    fn capture_wait_timeout_is_not_a_query_and_other_wait_failures_propagate() {
        assert!(super::capture_event_wait_result(Err(wasapi::WasapiError::EventTimeout)).is_ok());
        assert!(super::capture_event_wait_result(Err(wasapi::WasapiError::UnexpectedWaitResult(7))).is_err());
    }

    #[test]
    fn accepted_native_stop_marks_owner_terminal_before_another_publication() {
        let owner = crate::audio::state::NativeCaptureStartAck::new();
        owner.observe_native_start(Ok::<(), String>(())).unwrap();
        let guard = owner.producer_guard();
        let (tx, rx) = std::sync::mpsc::channel();
        assert!(!super::accept_native_capture_stop(&rx, &guard).unwrap());
        assert!(!owner.health().terminal);
        tx.send(()).unwrap();
        assert!(super::accept_native_capture_stop(&rx, &guard).unwrap());
        assert!(owner.health().terminal);
        guard.publish_query(std::time::Instant::now(), crate::audio::state::NativeCaptureQuery::Empty,
            crate::audio::state::NativeCaptureWork::default());
        assert!(owner.health().terminal);
        assert_eq!(owner.health().successful_queries, 0);
        drop(tx);
        assert!(super::accept_native_capture_stop(&rx, &guard).is_err());
    }

    #[test]
    fn capture_stop_request_and_owner_drop_are_not_live_idle() {
        let (tx, rx) = std::sync::mpsc::channel();
        assert!(!super::capture_stop_requested(&rx).unwrap());
        tx.send(()).unwrap();
        assert!(super::capture_stop_requested(&rx).unwrap());
        drop(tx);
        assert!(super::capture_stop_requested(&rx).is_err());
    }

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

#[cfg(test)]
mod aec_tap_clock_tests {
    use super::{AecCaptureFrameMetadata, AecTapQueueClock, CHUNK_FRAMES};
    use super::capture_diagnostics::aec_tap_chunk_metadata;

    const BLOCK_ALIGN: usize = 8;
    const CHUNK_BYTES: usize = CHUNK_FRAMES * BLOCK_ALIGN;

    #[test]
    fn discontinuity_prefix_recovers_inside_a_large_packet_without_queue_empty() {
        let residual = CHUNK_BYTES / 4;
        let mut clock = AecTapQueueClock::default();

        clock.observe_packet(residual, residual + 2 * CHUNK_BYTES, true, false, true);
        assert!(!clock.next_chunk_valid());
        clock.consume_bytes(CHUNK_BYTES);
        assert!(clock.next_chunk_valid());
        clock.consume_bytes(CHUNK_BYTES);

        clock.observe_packet(residual, residual + CHUNK_BYTES, false, false, true);
        assert!(clock.next_chunk_valid());
    }

    #[test]
    fn timestamp_error_remains_invalid_across_packets_until_its_residual_drains() {
        let residual = CHUNK_BYTES / 4;
        let mut clock = AecTapQueueClock::default();

        clock.observe_packet(residual, residual + CHUNK_BYTES, false, true, false);
        assert!(!clock.next_chunk_valid());
        clock.consume_bytes(CHUNK_BYTES);

        clock.observe_packet(residual, residual + CHUNK_BYTES, false, false, true);
        assert!(!clock.next_chunk_valid());
        clock.consume_bytes(CHUNK_BYTES);

        clock.observe_packet(residual, residual + CHUNK_BYTES, false, false, true);
        assert!(clock.next_chunk_valid());
    }

    #[test]
    fn anchor_arithmetic_failure_invalidates_the_whole_packet_until_a_new_anchor() {
        let mut clock = AecTapQueueClock::default();

        clock.observe_packet(CHUNK_BYTES, 3 * CHUNK_BYTES, false, false, false);
        for _ in 0..3 {
            assert!(!clock.next_chunk_valid());
            clock.consume_bytes(CHUNK_BYTES);
        }
        // Draining bytes alone cannot rehabilitate an underflowed/overflowed
        // anchor; a later fully reconstructable packet is required.
        assert!(!clock.next_chunk_valid());
        clock.observe_packet(0, CHUNK_BYTES, false, false, true);
        assert!(clock.next_chunk_valid());
    }

    #[test]
    fn a_second_discontinuity_extends_only_the_current_invalid_prefix() {
        let residual = CHUNK_BYTES / 2;
        let mut clock = AecTapQueueClock::default();

        clock.observe_packet(residual, residual + 2 * CHUNK_BYTES, true, false, true);
        assert!(!clock.next_chunk_valid());
        clock.consume_bytes(CHUNK_BYTES);
        assert!(clock.next_chunk_valid());

        clock.observe_packet(residual, residual + CHUNK_BYTES, true, false, true);
        assert!(!clock.next_chunk_valid());
        clock.consume_bytes(CHUNK_BYTES);
        clock.observe_packet(residual, residual + CHUNK_BYTES, false, false, true);
        assert!(clock.next_chunk_valid());
    }

    #[test]
    fn chunk_clock_offsets_never_rewrite_the_actual_packet_clocks_or_flags() {
        let packet = AecCaptureFrameMetadata {
            packet_device_frame_index: 9_600, packet_qpc_100ns: 2_000_000,
            queue_head_device_frame_index: 9_120, queue_head_qpc_100ns: 1_900_000,
            observed_qpc_100ns: Some(2_100_000), continuity_id: 42, delay_samples: 1920,
            timestamp_error: true, data_discontinuity: true, queue_head_clock_valid: false,
        };
        let chunk = aec_tap_chunk_metadata(packet, 2, 0);
        assert_eq!(chunk.packet_device_frame_index, packet.packet_device_frame_index);
        assert_eq!(chunk.packet_qpc_100ns, packet.packet_qpc_100ns);
        assert_eq!(chunk.queue_head_device_frame_index, 11_040);
        assert_eq!(chunk.queue_head_qpc_100ns, 2_300_000);
        assert_eq!(chunk.observed_qpc_100ns, packet.observed_qpc_100ns);
        assert_eq!(chunk.continuity_id, 42);
        assert_eq!(chunk.delay_samples, 0);
        assert!(chunk.timestamp_error && chunk.data_discontinuity);
        assert!(!chunk.queue_head_clock_valid);
        let overflow = aec_tap_chunk_metadata(AecCaptureFrameMetadata {
            queue_head_device_frame_index: u64::MAX, queue_head_clock_valid: true, ..packet
        }, 1, 0);
        assert!(!overflow.queue_head_clock_valid);
    }
}
