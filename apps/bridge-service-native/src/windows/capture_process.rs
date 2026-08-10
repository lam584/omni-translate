use super::*;

/// Captures the system render mix while excluding the bridge process tree.
/// This is a distinct backend: activation or capture failures stop the route
/// and are never converted into driver or endpoint-loopback fallbacks.
pub(super) struct ProcessLoopbackCaptureWorker {
    state: Arc<Mutex<BridgeState>>,
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
        Self {
            state,
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
        {
            let mut current = worker.state.lock().unwrap();
            current.update_progress("opening-process-loopback");
        }
        match capture_process_loopback_generation(
            &worker.state,
            &worker.runtime_root,
            &worker.playback_tx,
            &worker.source_tx,
            generation,
        ) {
            Ok(()) => {}
            Err(error) => {
                append_bridge_service_log(
                    &worker.runtime_root,
                    &format!(
                        "event=process_loopback_failed generation={generation} error={error}"
                    ),
                );
                fail_process_loopback_route(
                    &worker.state,
                    &worker.playback_control_tx,
                    &worker.translation_queue,
                    error,
                );
            }
        }
    }
}

fn capture_process_loopback_generation(
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    source_tx: &mpsc::SyncSender<Vec<u8>>,
    generation: u64,
) -> Result<(), String> {
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
    {
        let mut current = state.lock().unwrap();
        if current.source_capture_mode != SourceCaptureMode::ProcessExclusion
            || !current.source_subscriber_active
            || current.source_generation != generation
        {
            drop(current);
            let _ = audio_client.stop_stream();
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
            let _ = audio_client.stop_stream();
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
        event_handle.wait_for_event(100).map_err_str()?;
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
