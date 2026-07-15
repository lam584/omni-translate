/// Owns the fallback WASAPI loopback capture lifecycle. The driver worker is
/// selected by the production supervisor; this worker remains an explicit,
/// testable fallback for installations without a functioning driver stream.
#[allow(dead_code, reason = "explicit driverless capture fallback retained for installations without a working driver stream")]
struct WasapiCaptureWorker {
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    source_tx: mpsc::SyncSender<Vec<u8>>,
}

#[allow(dead_code, reason = "constructor belongs to the retained driverless capture fallback")]
impl WasapiCaptureWorker {
    fn new(
        state: Arc<Mutex<BridgeState>>,
        runtime_root: PathBuf,
        playback_tx: mpsc::SyncSender<PlaybackCommand>,
        source_tx: mpsc::SyncSender<Vec<u8>>,
    ) -> Self {
        Self { state, runtime_root, playback_tx, source_tx }
    }

    fn run(self) {
        run_wasapi_source_worker(self.state, self.runtime_root, self.playback_tx, self.source_tx)
    }
}

#[allow(dead_code, reason = "driverless capture fallback entrypoint is selected only by recovery builds")]
fn run_wasapi_source_worker(
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    source_tx: mpsc::SyncSender<Vec<u8>>,
) {
    let _ = initialize_mta();
    let mut restart_index = 0_usize;
    loop {
        let (active, generation, device_id) = {
            let current = state.lock().unwrap();
            (
                current.source_subscriber_active,
                current.source_generation,
                current.virtual_render_device_id.clone(),
            )
        };
        if !active || device_id.is_empty() {
            state.lock().unwrap().source_worker_phase = "waiting-subscriber".to_string();
            thread::sleep(Duration::from_millis(25));
            continue;
        }

        {
            let mut current = state.lock().unwrap();
            current.update_progress("opening-wasapi-loopback");
        }
        match capture_wasapi_source_generation(
            &state,
            &runtime_root,
            &playback_tx,
            &source_tx,
            generation,
            &device_id,
        ) {
            Ok(()) => restart_index = 0,
            Err(error) => {
                let delay_ms = OMNI_SOURCE_RESTART_BACKOFF_MS
                    [restart_index.min(OMNI_SOURCE_RESTART_BACKOFF_MS.len() - 1)];
                restart_index = (restart_index + 1).min(OMNI_SOURCE_RESTART_BACKOFF_MS.len() - 1);
                {
                    let mut current = state.lock().unwrap();
                    current.capture_restart_count += 1;
                    current.set_error(
                        "wasapi-loopback-restarting",
                        format!("capture.wasapi-loopback-failed:{error}"),
                    );
                }
                append_bridge_service_log(
                    &runtime_root,
                    &format!(
                        "event=wasapi_loopback_restart generation={generation} delayMs={delay_ms} error={error}"
                    ),
                );
                thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }
}

#[allow(dead_code, reason = "driverless capture generation is retained for recovery builds")]
fn capture_wasapi_source_generation(
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    source_tx: &mpsc::SyncSender<Vec<u8>>,
    generation: u64,
    requested_device_id: &str,
) -> Result<(), String> {
    let enumerator = DeviceEnumerator::new().map_err_str()?;
    let device = find_render_device(&enumerator, requested_device_id)?;
    let effective_device_id = device.get_id().map_err_str()?;
    let mut audio_client = device.get_iaudioclient().map_err_str()?;
    let desired_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        INTERNAL_SAMPLE_RATE_HZ as usize,
        INTERNAL_CHANNEL_COUNT as usize,
        None,
    );
    let (_, min_time) = audio_client.get_device_period().map_err_str()?;
    audio_client
        .initialize_client(
            &desired_format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: min_time,
            },
        )
        .map_err_str()?;
    let event_handle = audio_client.set_get_eventhandle().map_err_str()?;
    let capture_client = audio_client.get_audiocaptureclient().map_err_str()?;
    audio_client.start_stream().map_err_str()?;

    append_bridge_service_log(
        runtime_root,
        &format!(
            "event=wasapi_loopback_started generation={generation} device={effective_device_id}"
        ),
    );
    {
        let mut current = state.lock().unwrap();
        current.update_progress("wasapi-loopback-running");
        current.last_error_code = None;
    }

    let mut sample_bytes = VecDeque::new();
    let bytes_per_frame = desired_format.get_blockalign() as usize;
    let float_chunk_bytes = 960 * INTERNAL_CHANNEL_COUNT as usize * std::mem::size_of::<f32>();
    let mut diagnostics_started_at = Instant::now();
    let mut diagnostics_peak = 0.0_f32;
    let mut diagnostics_square_sum = 0.0_f64;
    let mut diagnostics_sample_count = 0_u64;
    let mut diagnostics_silent_packets = 0_u64;
    let mut diagnostics_invalid_samples = 0_u64;

    loop {
        let (active, current_generation) = {
            let current = state.lock().unwrap();
            (current.source_subscriber_active, current.source_generation)
        };
        if !active || current_generation != generation {
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
                diagnostics_silent_packets += 1;
                state.lock().unwrap().capture_silent_packet_count += 1;
            }
            append_capture_packet(&mut sample_bytes, packet, buffer_info.flags.silent);
        }
        while sample_bytes.len() >= float_chunk_bytes {
            let mut payload = Vec::with_capacity(OMNI_SOURCE_CHUNK_BYTES);
            for _ in 0..(960 * INTERNAL_CHANNEL_COUNT as usize) {
                let bytes = [
                    sample_bytes.pop_front().unwrap(),
                    sample_bytes.pop_front().unwrap(),
                    sample_bytes.pop_front().unwrap(),
                    sample_bytes.pop_front().unwrap(),
                ];
                let (sample, invalid) = sanitize_capture_sample(f32::from_le_bytes(bytes));
                if invalid {
                    diagnostics_invalid_samples += 1;
                }
                diagnostics_peak = diagnostics_peak.max(sample.abs());
                diagnostics_square_sum += (sample as f64) * (sample as f64);
                diagnostics_sample_count += 1;
                payload.extend_from_slice(&((sample * i16::MAX as f32) as i16).to_le_bytes());
            }
            {
                let mut current = state.lock().unwrap();
                current.capture_packet_count += 1;
                current.capture_frames_received += 960;
                current.capture_peak = diagnostics_peak;
                current.capture_rms = capture_rms(diagnostics_square_sum, diagnostics_sample_count);
                current.capture_invalid_sample_count += diagnostics_invalid_samples;
                current.source_worker_last_progress_timestamp_ms = Some(unix_ms());
            }
            diagnostics_invalid_samples = 0;
            dispatch_source_frame(state, runtime_root, playback_tx, source_tx, payload);
        }
        if diagnostics_started_at.elapsed()
            >= Duration::from_secs(OMNI_CAPTURE_DIAGNOSTICS_INTERVAL_SECS)
        {
            let rms = capture_rms(diagnostics_square_sum, diagnostics_sample_count);
            append_bridge_service_log(
                runtime_root,
                &format!(
                    "event=wasapi_capture_summary generation={generation} peak={diagnostics_peak:.6} rms={rms:.6} silentPackets={diagnostics_silent_packets} invalidSamples={} samples={diagnostics_sample_count}",
                    state.lock().unwrap().capture_invalid_sample_count
                ),
            );
            diagnostics_started_at = Instant::now();
            diagnostics_peak = 0.0;
            diagnostics_square_sum = 0.0;
            diagnostics_sample_count = 0;
            diagnostics_silent_packets = 0;
        }
        event_handle.wait_for_event(100).map_err_str()?;
    }
}

#[allow(dead_code, reason = "packet helper belongs to the retained driverless capture fallback")]
fn append_capture_packet(sample_bytes: &mut VecDeque<u8>, mut packet: Vec<u8>, silent: bool) {
    if silent {
        packet.fill(0);
    }
    sample_bytes.extend(packet);
}

#[allow(dead_code, reason = "sample sanitizer belongs to the retained driverless capture fallback")]
fn sanitize_capture_sample(sample: f32) -> (f32, bool) {
    if sample.is_finite() {
        (sample.clamp(-1.0, 1.0), false)
    } else {
        (0.0, true)
    }
}

#[allow(dead_code, reason = "RMS helper belongs to the retained driverless capture fallback")]
fn capture_rms(square_sum: f64, sample_count: u64) -> f32 {
    if sample_count == 0 {
        0.0
    } else {
        (square_sum / sample_count as f64).sqrt() as f32
    }
}

#[allow(dead_code, reason = "device lookup belongs to the retained driverless capture fallback")]
fn find_render_device(
    enumerator: &DeviceEnumerator,
    requested_device_id: &str,
) -> Result<Device, String> {
    let collection = enumerator
        .get_device_collection(&Direction::Render)
        .map_err_str()?;
    for device_result in &collection {
        let device = device_result.map_err_str()?;
        let id_matches = device
            .get_id()
            .map(|id| id == requested_device_id)
            .unwrap_or(false);
        let name_matches = device
            .get_friendlyname()
            .map(|name| name.contains("Omni Translate Virtual Speaker"))
            .unwrap_or(false);
        if id_matches || name_matches {
            return Ok(device);
        }
    }
    Err(format!(
        "configured virtual render endpoint was not found: {requested_device_id}"
    ))
}

struct DriverIoClient {
    device: fs::File,
}

impl DriverIoClient {
    fn open() -> Result<Self, io::Error> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(OMNI_BRIDGE_DEVICE_PATH)
            .map(|device| Self { device })
    }

    fn query_status(&self) -> Result<DriverStatus, io::Error> {
        query_driver_status(&self.device)
    }

    fn read_pcm(&self, payload: &mut [u8]) -> Result<usize, io::Error> {
        read_driver_pcm(&self.device, payload)
    }

    fn reset(&self) -> Result<(), io::Error> {
        reset_driver_ring(&self.device)
    }
}

/// Owns the native driver capture loop dependencies for one bridge host.
struct DriverCaptureWorker {
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    source_tx: mpsc::SyncSender<Vec<u8>>,
}

impl DriverCaptureWorker {
    fn new(
        state: Arc<Mutex<BridgeState>>,
        runtime_root: PathBuf,
        playback_tx: mpsc::SyncSender<PlaybackCommand>,
        source_tx: mpsc::SyncSender<Vec<u8>>,
    ) -> Self {
        Self { state, runtime_root, playback_tx, source_tx }
    }

    fn run(self) {
        run_driver_source_worker(self.state, self.runtime_root, self.playback_tx, self.source_tx)
    }
}

fn run_driver_source_worker(
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    source_tx: mpsc::SyncSender<Vec<u8>>,
) {
    let mut last_driver_open_error = None;
    loop {
        {
            let mut current = state.lock().unwrap();
            current.update_progress("opening-driver");
        }
        let driver = match DriverIoClient::open() {
            Ok(driver) => driver,
            Err(error) => {
                let error = error.to_string();
                let mut current = state.lock().unwrap();
                current.set_error("driver-open-failed", format!("driver.open-failed:{error}"));
                let generation = current.source_generation;
                drop(current);
                if last_driver_open_error.as_deref() != Some(error.as_str()) {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!("driver open failed: generation={generation} error={error}"),
                    );
                    last_driver_open_error = Some(error);
                }
                thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        if last_driver_open_error.take().is_some() {
            append_bridge_service_log(&runtime_root, "driver open recovered");
        }
        {
            let mut current = state.lock().unwrap();
            current.update_progress("driver-open");
        }
        append_bridge_service_log(&runtime_root, "event=driver_open_success");
        match driver.query_status() {
            Ok(status) => {
                update_driver_status(&state, &status);
                append_bridge_service_log(
                    &runtime_root,
                    &format!(
                        "event=driver_status abiVersion={} ringCapacityBytes={} maxBufferedBytes={} capturedBytes={} deliveredBytes={} bufferedBytes={} droppedBytes={}",
                        status.abi_version,
                        status.ring_capacity_bytes,
                        status.max_buffered_bytes,
                        status.captured_bytes,
                        status.delivered_bytes,
                        status.buffered_bytes,
                        status.dropped_bytes,
                    ),
                );
            }
            Err(error) => append_bridge_service_log(
                &runtime_root,
                &format!("event=driver_status_failed error={error}"),
            ),
        }
        let started_at = Instant::now();
        let mut pending_bytes = VecDeque::new();
        let mut pacer = AudioFramePacer::new(
            OMNI_SOURCE_QUEUE_CAPACITY,
            Duration::from_millis(OMNI_SOURCE_FRAME_INTERVAL_MS),
        );
        let mut last_dropped_frames = 0_u64;
        let mut last_underruns = 0_u64;
        let mut released_frames = 0_u64;
        let mut last_summary_at = Instant::now();
        let mut source_generation = u64::MAX;
        let mut idle_since = Instant::now();
        let mut first_read_generation = u64::MAX;
        let mut first_non_empty_generation = u64::MAX;
        loop {
            let (active, current_generation) = {
                let current = state.lock().unwrap();
                (current.source_subscriber_active, current.source_generation)
            };
            if !active {
                {
                    let mut current = state.lock().unwrap();
                    if current.source_worker_phase != "waiting-subscriber" {
                        current.update_progress("waiting-subscriber");
                    }
                }
                if source_generation != current_generation {
                    pacer.clear();
                    pending_bytes.clear();
                    let _ = driver.reset();
                    source_generation = current_generation;
                }
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            if source_generation != current_generation {
                pacer.clear();
                pending_bytes.clear();
                let _ = driver.reset();
                source_generation = current_generation;
                idle_since = Instant::now();
                first_read_generation = u64::MAX;
                first_non_empty_generation = u64::MAX;
                append_bridge_service_log(
                    &runtime_root,
                    &format!("event=source_generation_active generation={source_generation}"),
                );
            }
            let mut released = false;
            if let Some(frame) = pacer.poll(started_at.elapsed()) {
                released_frames += 1;
                if released_frames == 1 {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!(
                            "source pacer started: frameBytes={} intervalMs={} queueCapacity={}",
                            OMNI_SOURCE_CHUNK_BYTES,
                            OMNI_SOURCE_FRAME_INTERVAL_MS,
                            OMNI_SOURCE_QUEUE_CAPACITY
                        ),
                    );
                }
                dispatch_source_frame(&state, &runtime_root, &playback_tx, &source_tx, frame);
                released = true;
            }

            let mut bytes_read = 0;
            if pacer.queued_frames() < OMNI_SOURCE_QUEUE_CAPACITY {
                let mut payload = vec![0_u8; OMNI_SOURCE_CHUNK_BYTES];
                {
                    let mut current = state.lock().unwrap();
                    current.update_progress("reading-driver");
                    current.source_read_calls += 1;
                }
                if first_read_generation != source_generation {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!("event=driver_read_begin generation={source_generation}"),
                    );
                    first_read_generation = source_generation;
                }
                bytes_read = match driver.read_pcm(&mut payload) {
                    Ok(bytes_read) => {
                        let bytes_read = bytes_read - (bytes_read % 4);
                        let mut current = state.lock().unwrap();
                        current.update_progress("driver-read-returned");
                        record_source_read_result(&mut current, bytes_read);
                        bytes_read
                    }
                    Err(error) => {
                        let mut current = state.lock().unwrap();
                        current
                            .set_error("driver-read-failed", format!("driver.read-failed:{error}"));
                        let generation = current.source_generation;
                        drop(current);
                        append_bridge_service_log(
                            &runtime_root,
                            &format!("driver read failed: generation={generation} error={error}"),
                        );
                        break;
                    }
                };
                payload.truncate(bytes_read);
                if bytes_read > 0 && first_non_empty_generation != source_generation {
                    append_bridge_service_log(
                        &runtime_root,
                        &format!(
                            "event=driver_read_first_pcm generation={source_generation} bytesRead={bytes_read}"
                        ),
                    );
                    first_non_empty_generation = source_generation;
                }
                if !payload.is_empty() {
                    idle_since = Instant::now();
                    pending_bytes.extend(payload);
                    let now = started_at.elapsed();
                    while pending_bytes.len() >= OMNI_SOURCE_CHUNK_BYTES {
                        let pcm16_frame: Vec<u8> =
                            pending_bytes.drain(..OMNI_SOURCE_CHUNK_BYTES).collect();
                        pacer.push(pcm16_frame, now);
                    }
                }
            }

            let dropped_frames = pacer.dropped_frame_count();
            if dropped_frames > last_dropped_frames {
                let dropped = dropped_frames - last_dropped_frames;
                state.lock().unwrap().dropped_frame_count +=
                    dropped * (OMNI_SOURCE_CHUNK_BYTES as u64 / 4);
                last_dropped_frames = dropped_frames;
            }

            if !released {
                if let Some(frame) = pacer.poll(started_at.elapsed()) {
                    released_frames += 1;
                    if released_frames == 1 {
                        append_bridge_service_log(
                            &runtime_root,
                            &format!(
                                "source pacer started: frameBytes={} intervalMs={} queueCapacity={}",
                                OMNI_SOURCE_CHUNK_BYTES,
                                OMNI_SOURCE_FRAME_INTERVAL_MS,
                                OMNI_SOURCE_QUEUE_CAPACITY
                            ),
                        );
                    }
                    dispatch_source_frame(&state, &runtime_root, &playback_tx, &source_tx, frame);
                    released = true;
                }
            }

            let underruns = pacer.underrun_count();
            if underruns > last_underruns {
                state.lock().unwrap().underrun_count += underruns - last_underruns;
                last_underruns = underruns;
            }
            state.lock().unwrap().queued_frames = pacer.queued_frames();
            {
                let mut current = state.lock().unwrap();
                current.source_pending_bytes = pending_bytes.len();
                current.source_pacer_queued_frames = pacer.queued_frames();
            }

            if pacer.queued_frames() == 0
                && !pending_bytes.is_empty()
                && idle_since.elapsed() >= Duration::from_millis(OMNI_SOURCE_STALE_AFTER_MS)
            {
                pending_bytes.clear();
                state.lock().unwrap().source_pending_bytes = 0;
            }

            if last_summary_at.elapsed() >= Duration::from_secs(OMNI_SOURCE_SUMMARY_INTERVAL_SECS) {
                if let Ok(status) = driver.query_status() {
                    update_driver_status(&state, &status);
                }
                let (
                    driver_buffered_bytes,
                    driver_dropped_bytes,
                    monitor_source_queued_frames,
                    stale_source_frames_dropped,
                ) = {
                    let current = state.lock().unwrap();
                    (
                        current.driver_buffered_bytes,
                        current.driver_dropped_bytes,
                        current.monitor_source_queued_frames,
                        current.stale_source_frames_dropped,
                    )
                };
                append_bridge_service_log(
                    &runtime_root,
                    &format!(
                        "source pacer summary: releasedFrames={} queuedFrames={} pendingBytes={} underruns={} droppedFrames={} driverBufferedBytes={} driverDroppedBytes={} monitorQueuedFrames={} staleSourceFramesDropped={}",
                        released_frames,
                        pacer.queued_frames(),
                        pending_bytes.len(),
                        pacer.underrun_count(),
                        pacer.dropped_frame_count(),
                        driver_buffered_bytes,
                        driver_dropped_bytes,
                        monitor_source_queued_frames,
                        stale_source_frames_dropped,
                    ),
                );
                last_summary_at = Instant::now();
            }

            if bytes_read == 0 && !released {
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
}

fn dispatch_source_frame(
    state: &Arc<Mutex<BridgeState>>,
    _runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    source_tx: &mpsc::SyncSender<Vec<u8>>,
    payload: Vec<u8>,
) {
    let Ok(samples) = decode_pcm16le(&payload) else {
        return;
    };
    let frame_count = samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
    let mut current = state.lock().unwrap();
    current.source_frames_captured += frame_count;
    current.source_released_frames += 1;
    current.last_frame_timestamp_ms = Some(unix_ms());
    let monitor_samples = mix_for_monitor(
        &samples,
        &[],
        INTERNAL_SAMPLE_RATE_HZ,
        INTERNAL_CHANNEL_COUNT,
        &current.mix_control,
    );
    if current.monitor_playback_enabled && !monitor_samples.is_empty() {
        let result = playback_tx.try_send(PlaybackCommand::Play(PlaybackJob {
            samples: monitor_samples,
            device_id: current.physical_playback_device_id.clone(),
            volume: playback_volume(current.physical_playback_level),
            source_frame: true,
            ducking_enabled: current.mix_control.ducking_enabled,
            ducking_depth_percent: current.mix_control.ducking_depth_percent,
            queued_at: Instant::now(),
            source_generation: current.source_generation,
        }));
        if result.is_err() {
            current.dropped_frame_count += frame_count;
        }
    }
    if source_tx.try_send(payload.clone()).is_err() {
        current.dropped_frame_count += frame_count;
    }
    drop(current);
}

fn append_bridge_service_log(runtime_root: &Path, message: &str) {
    let _ = fs::create_dir_all(runtime_root);
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime_root.join("bridge-service.log"))
    {
        let _ = writeln!(log, "{} {}", unix_ms(), message);
    }
}

fn update_driver_status(state: &Arc<Mutex<BridgeState>>, status: &DriverStatus) {
    let mut current = state.lock().unwrap();
    current.driver_buffered_bytes = status.buffered_bytes as u64;
    current.driver_max_buffered_bytes = status.max_buffered_bytes as u64;
    current.driver_captured_bytes = status.captured_bytes;
    current.driver_delivered_bytes = status.delivered_bytes;
    current.driver_dropped_bytes = status.dropped_bytes;
}

fn run_source_watchdog(state: Arc<Mutex<BridgeState>>, runtime_root: PathBuf) {
    loop {
        thread::sleep(Duration::from_secs(OMNI_SOURCE_SUMMARY_INTERVAL_SECS));
        let summary = {
            let current = state.lock().unwrap();
            source_watchdog_summary(&current, unix_ms())
        };
        append_bridge_service_log(&runtime_root, &summary);
    }
}

fn record_source_read_result(state: &mut BridgeState, bytes_read: usize) {
    state.source_bytes_read += bytes_read as u64;
    if bytes_read == 0 {
        state.source_zero_byte_reads += 1;
    }
}

fn source_watchdog_summary(state: &BridgeState, now_ms: u64) -> String {
    let last_progress_age_ms = state
        .source_worker_last_progress_timestamp_ms
        .map(|timestamp| now_ms.saturating_sub(timestamp))
        .unwrap_or(0);
    format!(
        "event=source_watchdog captureBackend=wasapi-endpoint-loopback sourceSubscriberActive={} sourceGeneration={} workerPhase={} lastProgressAgeMs={} captureRestarts={} capturePackets={} captureFrames={} capturePeak={:.6} captureRms={:.6} captureSilentPackets={} captureInvalidSamples={} monitorBufferedMs={} monitorUnderruns={} monitorOverruns={} readCalls={} zeroByteReads={} bytesRead={} capturedBytes={} deliveredBytes={} bufferedBytes={} droppedBytes={} pacerQueuedFrames={} pendingBytes={} releasedFrames={} underruns={}",
        state.source_subscriber_active,
        state.source_generation,
        state.source_worker_phase,
        last_progress_age_ms,
        state.capture_restart_count,
        state.capture_packet_count,
        state.capture_frames_received,
        state.capture_peak,
        state.capture_rms,
        state.capture_silent_packet_count,
        state.capture_invalid_sample_count,
        state.monitor_source_queued_frames * OMNI_SOURCE_FRAME_INTERVAL_MS as usize,
        state.monitor_underrun_count,
        state.monitor_overrun_count,
        state.source_read_calls,
        state.source_zero_byte_reads,
        state.source_bytes_read,
        state.driver_captured_bytes,
        state.driver_delivered_bytes,
        state.driver_buffered_bytes,
        state.driver_dropped_bytes,
        state.source_pacer_queued_frames,
        state.source_pending_bytes,
        state.source_released_frames,
        state.underrun_count,
    )
}

fn read_driver_pcm(driver: &fs::File, payload: &mut [u8]) -> Result<usize, io::Error> {
    let mut bytes_read = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_READ_PCM,
            ptr::null(),
            0,
            payload.as_mut_ptr().cast(),
            payload.len() as u32,
            &mut bytes_read,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(bytes_read as usize)
    }
}

fn reset_driver_ring(driver: &fs::File) -> Result<(), io::Error> {
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_RESET,
            ptr::null(),
            0,
            ptr::null_mut(),
            0,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn query_driver_status(driver: &fs::File) -> Result<DriverStatus, io::Error> {
    let mut status = DriverStatus::default();
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_QUERY_STATUS,
            ptr::null(),
            0,
            (&mut status as *mut DriverStatus).cast(),
            std::mem::size_of::<DriverStatus>() as u32,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else if bytes_returned < DRIVER_STATUS_BASE_SIZE {
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!(
                "driver status returned {bytes_returned} byte(s); expected at least {DRIVER_STATUS_BASE_SIZE}"
            ),
        ))
    } else {
        Ok(status)
    }
}
