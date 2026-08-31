use super::*;

#[derive(Clone, Debug)]
struct ProcessLoopbackCaptureFailure {
    detail: String,
    stop_failed: bool,
}

impl From<String> for ProcessLoopbackCaptureFailure {
    fn from(detail: String) -> Self {
        Self {
            detail,
            // Capture failed without an observed IAudioClient::Stop failure.
            // This distinguishes capture-failed from stop-failed diagnostics;
            // neither failure is shutdown authority.
            stop_failed: false,
        }
    }
}

fn process_loopback_terminal_status(
    capture_result: &Result<(), ProcessLoopbackCaptureFailure>,
) -> &'static str {
    match capture_result {
        Ok(()) => "stopped",
        Err(error) if error.stop_failed => "stop-failed",
        Err(_) => "capture-failed",
    }
}

/// Captures the system render mix while excluding the bridge process tree.
/// This is a distinct backend: activation or capture failures stop the route
/// and are never converted into driver or endpoint-loopback fallbacks.
pub(super) struct ProcessLoopbackCaptureWorker {
    state: Arc<Mutex<BridgeState>>,
    lifecycle: Arc<ProcessLoopbackLifecycle>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: mpsc::Sender<PlaybackControlCommand>,
    translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
    source_tx: mpsc::SyncSender<Vec<u8>>,
}

impl ProcessLoopbackCaptureWorker {
    pub(super) fn new(
        state: Arc<Mutex<BridgeState>>,
        runtime_root: PathBuf,
        playback_tx: mpsc::SyncSender<PlaybackCommand>,
        playback_control_tx: mpsc::Sender<PlaybackControlCommand>,
        translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
        source_tx: mpsc::SyncSender<Vec<u8>>,
    ) -> Self {
        let lifecycle = state.lock().unwrap().process_loopback_lifecycle.clone();
        Self {
            state,
            lifecycle,
            runtime_root,
            playback_tx,
            playback_control_tx,
            translation_queue,
            source_tx,
        }
    }

    pub(super) fn spawn(self) {
        thread::spawn(move || run_process_loopback_source_worker(self));
    }
}

fn run_process_loopback_source_worker(worker: ProcessLoopbackCaptureWorker) {
    if let Err(error) = initialize_mta().ok() {
        fail_process_loopback_route(
            &worker.state,
            &worker.playback_control_tx,
            &worker.translation_queue,
            format!("failed to initialize COM for process loopback: {error}"),
        );
        return;
    }
    loop {
        let generation = {
            let current = worker.state.lock().unwrap();
            if current.source_capture_mode != SourceCaptureMode::ProcessExclusion
                || current.process_loopback_status != ProcessLoopbackStatus::Ready
                || !current.source_subscriber_active
            {
                drop(current);
                thread::sleep(Duration::from_millis(25));
                continue;
            }
            current.source_generation
        };
        if !worker.lifecycle.begin_generation(generation) {
            return;
        }
        {
            let mut current = worker.state.lock().unwrap();
            current.process_loopback_terminal_generation = None;
            current.process_loopback_terminal_status = None;
            current.process_loopback_terminal_timestamp_ms = None;
            current.process_loopback_terminal_detail = None;
            current.update_progress("opening-process-loopback");
        }
        let capture_result = capture_process_loopback_generation(
            &worker.state,
            &worker.runtime_root,
            &worker.playback_tx,
            &worker.source_tx,
            generation,
        );
        let terminal_evidence = ProcessLoopbackTerminalEvidence::new(
            generation,
            process_loopback_terminal_status(&capture_result),
            capture_result
                .as_ref()
                .err()
                .map(|error| error.detail.clone()),
        );
        record_process_loopback_terminal_evidence(&worker.state, &terminal_evidence);
        worker.lifecycle.publish_terminal(terminal_evidence);
        let shutdown_requested = worker.lifecycle.shutdown_is_requested();
        match capture_result {
            Ok(()) => {}
            Err(error) => {
                append_bridge_service_log(
                    &worker.runtime_root,
                    &format!(
                        "event=process_loopback_failed generation={generation} error={}",
                        error.detail,
                    ),
                );
                fail_process_loopback_route(
                    &worker.state,
                    &worker.playback_control_tx,
                    &worker.translation_queue,
                    error.detail,
                );
            }
        }
        if shutdown_requested {
            return;
        }
    }
}

fn capture_process_loopback_generation(
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    source_tx: &mpsc::SyncSender<Vec<u8>>,
    generation: u64,
) -> Result<(), ProcessLoopbackCaptureFailure> {
    let mut audio_client = wasapi::AudioClient::new_application_loopback_client(
        unsafe { GetCurrentProcessId() },
        INCLUDE_BRIDGE_PROCESS_TREE_IN_LOOPBACK,
    )
    .map_err_str()?;
    let desired_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        INTERNAL_SAMPLE_RATE_HZ as usize,
        INTERNAL_CHANNEL_COUNT as usize,
        None,
    );
    audio_client
        .initialize_client(
            &desired_format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: 200_000,
            },
        )
        .map_err_str()?;
    let event_handle = audio_client.set_get_eventhandle().map_err_str()?;
    let capture_client = audio_client.get_audiocaptureclient().map_err_str()?;
    audio_client.start_stream().map_err_str()?;
    let capture_result = capture_started_process_loopback_generation(
        state,
        runtime_root,
        playback_tx,
        source_tx,
        generation,
        &desired_format,
        &event_handle,
        &capture_client,
    );
    let stop_result = audio_client.stop_stream().map_err_str();
    // The lifecycle terminal is published by the worker only after this
    // function returns. Drop every COM capture object before crossing that
    // evidence boundary so a shutdown ACK cannot outrun AudioSrv teardown.
    drop(capture_client);
    drop(event_handle);
    drop(audio_client);
    match (capture_result, stop_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(capture_error), Ok(())) => Err(ProcessLoopbackCaptureFailure::from(capture_error)),
        (Ok(()), Err(stop_error)) => Err(ProcessLoopbackCaptureFailure {
            detail: format!(
                "failed to stop process loopback generation {generation}: {stop_error}"
            ),
            stop_failed: true,
        }),
        (Err(capture_error), Err(stop_error)) => Err(ProcessLoopbackCaptureFailure {
            detail: format!(
                "{capture_error}; failed to stop process loopback generation {generation}: {stop_error}"
            ),
            stop_failed: true,
        }),
    }
}

fn capture_started_process_loopback_generation(
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    source_tx: &mpsc::SyncSender<Vec<u8>>,
    generation: u64,
    desired_format: &WaveFormat,
    event_handle: &wasapi::Handle,
    capture_client: &wasapi::AudioCaptureClient,
) -> Result<(), String> {
    {
        let mut current = state.lock().unwrap();
        if current.source_capture_mode != SourceCaptureMode::ProcessExclusion
            || !current.source_subscriber_active
            || current.source_generation != generation
        {
            return Ok(());
        }
        current.process_loopback_status = ProcessLoopbackStatus::Ready;
        current.excluded_process_id = Some(unsafe { GetCurrentProcessId() });
        current.process_loopback_failure_detail = None;
        current.last_error_code = None;
        current.update_progress("process-loopback-running");
    }
    append_bridge_service_log(
        runtime_root,
        &format!(
            "event=process_loopback_started generation={generation} excludedProcessId={}",
            unsafe { GetCurrentProcessId() }
        ),
    );

    let bytes_per_frame = desired_format.get_blockalign() as usize;
    let mut sample_bytes = VecDeque::new();
    let mut diagnostics_peak = 0.0_f32;
    let mut diagnostics_square_sum = 0.0_f64;
    let mut diagnostics_sample_count = 0_u64;

    loop {
        let should_continue = {
            let current = state.lock().unwrap();
            current.source_capture_mode == SourceCaptureMode::ProcessExclusion
                && current.source_subscriber_active
                && current.source_generation == generation
        };
        if !should_continue {
            return Ok(());
        }
        while let Some(packet_frames) = capture_client
            .get_next_packet_size()
            .map_err_str()?
            .filter(|frames| *frames > 0)
        {
            let mut packet = vec![0_u8; packet_frames as usize * bytes_per_frame];
            let (frames_read, buffer_info) =
                capture_client.read_from_device(&mut packet).map_err_str()?;
            packet.truncate(frames_read as usize * bytes_per_frame);
            if buffer_info.flags.silent {
                state.lock().unwrap().capture_silent_packet_count += 1;
            }
            append_capture_packet(&mut sample_bytes, packet, buffer_info.flags.silent);
        }
        while let Some((payload, invalid_samples)) = take_process_capture_chunk(
            &mut sample_bytes,
            &mut diagnostics_peak,
            &mut diagnostics_square_sum,
            &mut diagnostics_sample_count,
        ) {
            {
                let mut current = state.lock().unwrap();
                current.capture_packet_count += 1;
                current.capture_frames_received += 960;
                current.capture_peak = diagnostics_peak;
                current.capture_rms =
                    capture_rms(diagnostics_square_sum, diagnostics_sample_count);
                current.capture_invalid_sample_count += invalid_samples;
                current.source_worker_last_progress_timestamp_ms = Some(unix_ms());
            }
            dispatch_source_frame(
                state,
                runtime_root,
                playback_tx,
                source_tx,
                generation,
                SourceCaptureMode::ProcessExclusion,
                payload,
            );
        }
        // `wasapi::Handle::wait_for_event` reports a normal `WAIT_TIMEOUT` as
        // `EventTimeout`. Process loopback is allowed to have short periods
        // without an audio packet (for example while an endpoint is idle), so
        // that result must return to the state check above rather than tear
        // down the healthy capture route and its source subscriber.
        wait_for_process_capture_event(event_handle.wait_for_event(100))?;
    }
}

fn wait_for_process_capture_event(
    event_wait: Result<(), wasapi::WasapiError>,
) -> Result<(), String> {
    match event_wait {
        Ok(()) | Err(wasapi::WasapiError::EventTimeout) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn take_process_capture_chunk(
    sample_bytes: &mut VecDeque<u8>,
    diagnostics_peak: &mut f32,
    diagnostics_square_sum: &mut f64,
    diagnostics_sample_count: &mut u64,
) -> Option<(Vec<u8>, u64)> {
    const FLOAT_CHUNK_BYTES: usize =
        960 * INTERNAL_CHANNEL_COUNT as usize * std::mem::size_of::<f32>();
    if sample_bytes.len() < FLOAT_CHUNK_BYTES {
        return None;
    }
    let mut payload = Vec::with_capacity(OMNI_SOURCE_CHUNK_BYTES);
    let mut invalid_samples = 0_u64;
    for _ in 0..(960 * INTERNAL_CHANNEL_COUNT as usize) {
        let bytes = [
            sample_bytes.pop_front().unwrap(),
            sample_bytes.pop_front().unwrap(),
            sample_bytes.pop_front().unwrap(),
            sample_bytes.pop_front().unwrap(),
        ];
        let (sample, invalid) = sanitize_capture_sample(f32::from_le_bytes(bytes));
        invalid_samples += u64::from(invalid);
        *diagnostics_peak = (*diagnostics_peak).max(sample.abs());
        *diagnostics_square_sum += (sample as f64) * (sample as f64);
        *diagnostics_sample_count += 1;
        payload.extend_from_slice(&((sample * i16::MAX as f32) as i16).to_le_bytes());
    }
    Some((payload, invalid_samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_process_loopback_event_timeout_keeps_capture_route_alive() {
        assert!(wait_for_process_capture_event(Err(wasapi::WasapiError::EventTimeout)).is_ok());
    }

    #[test]
    fn shutdown_barrier_rejects_generation_activation_without_waiting() {
        let lifecycle = ProcessLoopbackLifecycle::default();
        let terminal = lifecycle
            .request_shutdown_and_wait(41, Duration::ZERO)
            .expect("an idle lifecycle can publish terminal evidence immediately");
        assert_eq!(terminal.generation, 41);
        assert_eq!(terminal.status, "not-active");
        assert!(!lifecycle.begin_generation(41));
        assert!(!lifecycle.begin_generation(42));
        assert_eq!(lifecycle.active_generation(), None);
    }

    #[test]
    fn shutdown_wait_accepts_only_the_active_generation_terminal() {
        let lifecycle = Arc::new(ProcessLoopbackLifecycle::default());
        assert!(lifecycle.begin_generation(73));
        let waiter_lifecycle = lifecycle.clone();
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let waiter = thread::spawn(move || {
            result_tx
                .send(waiter_lifecycle.request_shutdown_and_wait(
                    74,
                    Duration::from_secs(1),
                ))
                .unwrap();
        });
        loop {
            if lifecycle.state.lock().unwrap().shutdown_requested {
                break;
            }
            thread::yield_now();
        }
        lifecycle.publish_terminal(ProcessLoopbackTerminalEvidence::new(
            72,
            "stopped",
            None,
        ));
        assert!(result_rx.try_recv().is_err());
        let expected = ProcessLoopbackTerminalEvidence::new(73, "stopped", None);
        lifecycle.publish_terminal(expected.clone());
        assert_eq!(result_rx.recv().unwrap().unwrap(), expected);
        waiter.join().unwrap();
    }

    #[test]
    fn active_generation_without_terminal_evidence_times_out_fail_closed() {
        let lifecycle = ProcessLoopbackLifecycle::default();
        assert!(lifecycle.begin_generation(91));
        let error = lifecycle
            .request_shutdown_and_wait(91, Duration::ZERO)
            .expect_err("shutdown cannot infer terminal evidence from a timeout");
        assert!(error.contains("generation 91"), "{error}");
        assert_eq!(lifecycle.active_generation(), Some(91));
    }

    #[test]
    fn capture_failure_with_successful_stop_is_not_a_stopped_terminal() {
        let capture_result = Err(ProcessLoopbackCaptureFailure::from(
            "capture event failed".to_string(),
        ));
        assert_eq!(
            process_loopback_terminal_status(&capture_result),
            "capture-failed"
        );

        let stop_failure = Err(ProcessLoopbackCaptureFailure {
            detail: "IAudioClient::Stop failed".to_string(),
            stop_failed: true,
        });
        assert_eq!(
            process_loopback_terminal_status(&stop_failure),
            "stop-failed"
        );
    }
}

pub(super) fn fail_process_loopback_route(
    state: &Arc<Mutex<BridgeState>>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
    detail: String,
) -> Option<PlaybackStopRequest> {
    let mut current = state.lock().unwrap();
    if current.source_capture_mode != SourceCaptureMode::ProcessExclusion {
        return None;
    }
    current.capture_restart_count += 1;
    current.process_loopback_status = ProcessLoopbackStatus::Failed;
    current.process_loopback_failure_detail = Some(detail);
    current.last_error_code = Some("bridge.process-loopback-capture-failed".to_string());
    current.bridge_state = "degraded".to_string();
    current.lifecycle_state = "error".to_string();
    current.source_subscriber_active = false;
    current.source_generation = current.source_generation.wrapping_add(1);
    current.update_progress("process-loopback-failed");
    Some(request_playback_stop(
        &mut current,
        translation_queue,
        playback_control_tx,
        "process-loopback-capture-failed",
        Some("bridge.process-loopback-capture-failed"),
    ))
}
