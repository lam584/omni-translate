/// Owns a single capture route's lifecycle dependencies.
///
/// Keeping the channel, route specification and UI handle together prevents
/// the thread launcher from becoming a second orchestration implementation.
struct RouteWorker {
    app: AppHandle,
    direction: String,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
}

impl RouteWorker {
    fn run(self, store: &AudioStateStore) -> Result<(), String> {
        run_route_worker(
            self.app,
            store,
            &self.direction,
            self.spec,
            self.stop_rx,
            self.stt_sender,
            self.init_done,
        )
    }
}

fn run_route_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    if direction == "inbound" && spec.feedback_loop_prevention == "virtual-driver" {
        return run_bridge_source_route_worker(
            app, store, direction, spec, stop_rx, stt_sender, init_done,
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

    audio_client.start_stream().map_err_str()?;
    // The stream is bound and the route now reports ready. Microphone capture is
    // expected to deliver packets promptly, but system loopback legitimately has
    // no frames while every media source is paused. Keep Watch alive in that
    // state so users can start it before pressing play.
    let capture_started_at = Instant::now();
    let mut inbound_wait_logged = false;
    let mut echo_diagnostics = EchoCancelDiagnostics::new();
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

        capture_client
            .read_from_device_to_deque(&mut sample_queue)
            .map_err_str()?;

        let chunk_len = desired_format.get_blockalign() as usize * CHUNK_FRAMES;
        for chunk in drain_sample_chunks(&mut sample_queue, chunk_len) {
            let (chunk, suppress_asr) = if spec.echo_cancel_enabled() {
                let f32_chunk = bytes_to_f32_stereo(&chunk);
                let cancellation = store.subtract_echo(&f32_chunk, ECHO_CANCEL_DELAY_SAMPLES);
                let cleaned_bytes = f32_stereo_to_bytes(&cancellation.samples);
                echo_diagnostics.record(
                    calculate_chunk_db(&chunk),
                    calculate_chunk_db(&cleaned_bytes),
                    cancellation.suppress_asr,
                );
                echo_diagnostics.maybe_log(&app, store, direction);
                (cleaned_bytes, cancellation.suppress_asr)
            } else {
                (chunk, false)
            };

            process_captured_chunk(
                &app,
                store,
                direction,
                &mut processor,
                &stt_sender,
                suppress_asr,
                chunk,
                sample_queue.len(),
            )?;
        }

        let _ = event_handle.wait_for_event(500);
    }

    Ok(())
}

fn run_bridge_source_route_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: &str,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let bridge_snapshot = app.state::<BridgeStateStore>().snapshot();
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
    loop {
        let mut source_pipe = loop {
            if stop_rx.try_recv().is_ok() {
                return Ok(());
            }
            match OpenOptions::new()
                .read(true)
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
            let payload = match read_bridge_source_payload(&mut source_pipe) {
                Ok(BridgeSourceEnvelope::Frame(payload)) => {
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
                Ok(BridgeSourceEnvelope::Heartbeat) => {
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
                    false,
                    chunk,
                    sample_queue.len(),
                )?;
            }
        }
    }
}

/// Periodic echo-cancel (AEC) effectiveness probe for one capture session.
/// Accumulates per-chunk energy before and after `subtract_echo` and reports
/// interval averages plus the reference-buffer depth through the diagnostics
/// chain so the echo path is observable while a session runs.
struct EchoCancelDiagnostics {
    subtract_count: u64,
    interval_chunks: u64,
    interval_pre_db_sum: f64,
    interval_post_db_sum: f64,
    asr_suppressed_chunks: u64,
    last_summary_at: Instant,
}

impl EchoCancelDiagnostics {
    fn new() -> Self {
        Self {
            subtract_count: 0,
            interval_chunks: 0,
            interval_pre_db_sum: 0.0,
            interval_post_db_sum: 0.0,
            asr_suppressed_chunks: 0,
            last_summary_at: Instant::now(),
        }
    }

    fn record(&mut self, pre_db: f32, post_db: f32, suppress_asr: bool) {
        self.subtract_count += 1;
        self.interval_chunks += 1;
        self.interval_pre_db_sum += pre_db as f64;
        self.interval_post_db_sum += post_db as f64;
        if suppress_asr {
            self.asr_suppressed_chunks += 1;
        }
    }

    fn maybe_log(&mut self, app: &AppHandle, store: &AudioStateStore, direction: &str) {
        if self.last_summary_at.elapsed() < Duration::from_secs(5) {
            return;
        }
        let (reference_depth, reference_empty) = store.echo_reference_diagnostics();
        let chunks = self.interval_chunks.max(1) as f64;
        let avg_pre_db = self.interval_pre_db_sum / chunks;
        let avg_post_db = self.interval_post_db_sum / chunks;
        diag_log_detail(
            app,
            "audio",
            "info",
            "event=echo_cancel_summary",
            format!(
                "direction={} subtractCount={} asrSuppressedChunks={} refBufferDepthSamples={} refBufferEmpty={} avgPreDb={:.1} avgPostDb={:.1} avgRemovedDb={:.1}",
                direction,
                self.subtract_count,
                self.asr_suppressed_chunks,
                reference_depth,
                reference_empty,
                avg_pre_db,
                avg_post_db,
                avg_pre_db - avg_post_db,
            ),
        );
        self.interval_chunks = 0;
        self.interval_pre_db_sum = 0.0;
        self.interval_post_db_sum = 0.0;
        self.last_summary_at = Instant::now();
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
/// `| recommended:` marker is parsed by the route worker error handler into the
/// snapshot's `recommended_action` so the UI can surface a concrete next step.
fn audio_flow_stall_error(direction: &str, elapsed: Duration) -> String {
    let source = if direction == "inbound" {
        "系统音频"
    } else {
        "麦克风"
    };
    format!(
        "{source}采集已就绪，但在 {} 秒内没有捕获到任何音频帧，设备可能已静音或被其他应用以独占模式占用。 | recommended: check-audio-source",
        elapsed.as_secs().max(1)
    )
}

fn should_fail_on_initial_frame_stall(direction: &str) -> bool {
    direction != "inbound"
}

#[derive(Debug, PartialEq)]
enum BridgeSourceEnvelope {
    Frame(Vec<u8>),
    Heartbeat,
    Ignored(String),
}

fn read_bridge_source_payload(source_pipe: &mut impl Read) -> Result<BridgeSourceEnvelope, String> {
    let mut header_size = [0_u8; 4];
    source_pipe
        .read_exact(&mut header_size)
        .map_err(|error| format!("Bridge source header size read failed: {error}"))?;
    let header_size = u32::from_le_bytes(header_size) as usize;
    if header_size == 0 || header_size > 64 * 1024 {
        return Err("Bridge source header size is invalid.".to_string());
    }
    let mut header_bytes = vec![0_u8; header_size];
    source_pipe
        .read_exact(&mut header_bytes)
        .map_err(|error| format!("Bridge source header read failed: {error}"))?;
    let header: BridgeTranslationFrameHeader =
        serde_json::from_slice(&header_bytes).map_err_str()?;
    let mut payload = vec![0_u8; header.payload_bytes];
    source_pipe
        .read_exact(&mut payload)
        .map_err(|error| format!("Bridge source payload read failed: {error}"))?;
    if header.event_type == "bridge.source.heartbeat" {
        return Ok(BridgeSourceEnvelope::Heartbeat);
    }
    if header.event_type != "bridge.source.frame" {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=unexpected-event-type eventType={}",
            header.event_type
        )));
    }
    if header.sample_rate_hz != SAMPLE_RATE_HZ as u32 {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=sample-rate-mismatch actual={} expected={}",
            header.sample_rate_hz, SAMPLE_RATE_HZ
        )));
    }
    if header.channel_count != CHANNEL_COUNT as u16 {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=channel-count-mismatch actual={} expected={}",
            header.channel_count, CHANNEL_COUNT
        )));
    }
    Ok(BridgeSourceEnvelope::Frame(payload))
}

fn process_captured_chunk(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    processor: &mut RouteProcessor,
    stt_sender: &Option<mpsc::Sender<Vec<u8>>>,
    suppress_asr: bool,
    chunk: Vec<u8>,
    queued_bytes: usize,
) -> Result<(), String> {
    if !suppress_asr {
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
        Some(now_marker()),
        update.active_segment_id.clone(),
    );
    if let Some(segment) = update.finalized_segment {
        store.increment_segment_count(direction);
        store.cache_segment_audio(segment.audio);
        if direction != "inbound" {
            store.push_subtitle_cue(segment.cue);
        }
    }
    emit_audio_snapshot(app, store)
}
