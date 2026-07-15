fn handle_source_subscriber(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    source_rx: &Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    runtime_root: &Path,
) {
    let (my_generation, previous_generation) = {
        let source_rx = source_rx.lock().unwrap();
        let mut current = state.lock().unwrap();
        let generations = begin_source_subscription(&mut current);
        drop(current);
        while source_rx.try_recv().is_ok() {}
        generations
    };
    append_bridge_service_log(
        runtime_root,
        &format!(
            "source subscriber connected: generation={my_generation} previousGeneration={previous_generation}"
        ),
    );
    if source_subscription_is_owner(&state.lock().unwrap(), my_generation) {
        let _ = playback_tx.try_send(PlaybackCommand::FlushSource);
    }
    let mut frame_index = 0_u64;
    loop {
        if !source_subscription_is_owner(&state.lock().unwrap(), my_generation) {
            append_bridge_service_log(
                runtime_root,
                &format!("source subscriber handoff: generation={my_generation}"),
            );
            break;
        }
        let payload = {
            let source_rx = source_rx.lock().unwrap();
            let current = state.lock().unwrap();
            if !source_subscription_is_owner(&current, my_generation) {
                drop(current);
                drop(source_rx);
                append_bridge_service_log(
                    runtime_root,
                    &format!("source subscriber handoff: generation={my_generation}"),
                );
                break;
            }
            source_rx.try_recv()
        };
        let (event_type, payload) = match payload {
            Ok(payload) => ("bridge.source.frame", payload),
            Err(mpsc::TryRecvError::Empty) => {
                thread::sleep(Duration::from_millis(25));
                ("bridge.source.heartbeat", Vec::new())
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
        };
        let current = state.lock().unwrap();
        if !source_subscription_is_owner(&current, my_generation) {
            drop(current);
            append_bridge_service_log(
                runtime_root,
                &format!("source subscriber handoff: generation={my_generation}"),
            );
            break;
        }
        let Some(session_id) = current.session_id.clone() else {
            continue;
        };
        drop(current);
        frame_index += 1;
        let frame_id = format!("driver-source-{frame_index}");
        let header = AudioFrameHeader {
            event_type: event_type.to_string(),
            request_id: frame_id.clone(),
            session_id,
            frame_id,
            stream_id: "omni-virtual-speaker".to_string(),
            sample_rate_hz: INTERNAL_SAMPLE_RATE_HZ,
            channel_count: INTERNAL_CHANNEL_COUNT,
            frame_count: payload.len() / (INTERNAL_CHANNEL_COUNT as usize * 2),
            timestamp_ms: unix_ms(),
            payload_bytes: payload.len(),
        };
        if write_framed_audio(handle, &header, &payload).is_err() {
            break;
        }
    }
    let mut current = state.lock().unwrap();
    if end_source_subscription(&mut current, my_generation) {
        let next_generation = current.source_generation;
        drop(current);
        let _ = playback_tx.try_send(PlaybackCommand::FlushSource);
        append_bridge_service_log(
            runtime_root,
            &format!(
                "source subscriber disconnected: generation={my_generation} nextGeneration={next_generation}"
            ),
        );
    }
}

fn begin_source_subscription(state: &mut BridgeState) -> (u64, u64) {
    let previous_generation = state.source_generation;
    state.source_generation = state.source_generation.wrapping_add(1);
    state.source_subscriber_active = true;
    (state.source_generation, previous_generation)
}

fn source_subscription_is_owner(state: &BridgeState, generation: u64) -> bool {
    state.source_subscriber_active && state.source_generation == generation
}

fn end_source_subscription(state: &mut BridgeState, generation: u64) -> bool {
    if !source_subscription_is_owner(state, generation) {
        return false;
    }
    state.source_subscriber_active = false;
    state.source_generation = state.source_generation.wrapping_add(1);
    true
}

fn write_framed_audio(
    handle: HANDLE,
    header: &AudioFrameHeader,
    payload: &[u8],
) -> Result<(), io::Error> {
    let header = serde_json::to_vec(header).map_err(io::Error::other)?;
    write_all(handle, &(header.len() as u32).to_le_bytes())?;
    write_all(handle, &header)?;
    write_all(handle, payload)
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn run_playback_worker(
    playback_rx: mpsc::Receiver<PlaybackCommand>,
    state: Arc<Mutex<BridgeState>>,
) {
    let mut output: Option<PlaybackOutput> = None;
    while let Ok(command) = playback_rx.recv() {
        if matches!(command, PlaybackCommand::FlushSource) {
            if let Some(output) = output.as_mut() {
                flush_source_pending(output);
                output.source_player.clear();
                output.source_player.play();
                output.source_pending_samples.clear();
            }
            state.lock().unwrap().monitor_source_queued_frames = 0;
            continue;
        }
        let PlaybackCommand::Play(job) = command else {
            continue;
        };
        state.lock().unwrap().monitor_playback_state = "playing".to_string();
        if output.as_ref().map(|current| current.device_id.as_str()) != Some(job.device_id.as_str())
        {
            output = match open_playback_output(&job.device_id) {
                Ok(next) => Some(next),
                Err(error) => {
                    let mut current = state.lock().unwrap();
                    current.last_error_code = Some(if error == MONITOR_VIRTUAL_PLAYBACK_LOOP {
                        error
                    } else {
                        format!("monitor.playback-failed:{error}")
                    });
                    current.monitor_playback_state = "blocked".to_string();
                    continue;
                }
            };
        }
        if let Some(output) = output.as_mut() {
            state.lock().unwrap().resolved_physical_playback_device_id =
                output.resolved_device_id.clone();
            let frames = job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
            if job.source_frame {
                let generation = state.lock().unwrap().source_generation;
                if source_playback_job_is_stale(
                    job.source_generation,
                    generation,
                    job.queued_at.elapsed(),
                ) {
                    state.lock().unwrap().stale_source_frames_dropped += frames;
                    continue;
                }
                if monitor_source_queue_needs_drop(output.source_player.len()) {
                    let mut current = state.lock().unwrap();
                    current.monitor_overrun_count += 1;
                    current.stale_source_frames_dropped += frames;
                    continue;
                }
            }
            if job.source_frame
                && output
                    .duck_until
                    .map(|deadline| Instant::now() >= deadline)
                    .unwrap_or(false)
            {
                output.source_player.set_volume(job.volume);
                output.duck_until = None;
            }
            if job.source_frame {
                if output.duck_until.is_none() {
                    output.source_player.set_volume(job.volume);
                }
                output.source_pending_samples.extend(job.samples);
                if output.source_pending_samples.len()
                    >= OMNI_MONITOR_SOURCE_BATCH_FRAMES * INTERNAL_CHANNEL_COUNT as usize
                {
                    flush_source_pending(output);
                }
                state.lock().unwrap().monitor_source_queued_frames =
                    output.source_player.len() * 5 + pending_source_chunks(output);
            } else {
                flush_source_pending(output);
                output.translation_player.set_volume(job.volume);
                let buffer = SamplesBuffer::new(
                    NonZeroU16::new(INTERNAL_CHANNEL_COUNT).unwrap(),
                    NonZeroU32::new(INTERNAL_SAMPLE_RATE_HZ).unwrap(),
                    job.samples,
                );
                if job.ducking_enabled {
                    output.source_player.set_volume(
                        job.volume * 10.0_f32.powf(-(job.ducking_depth_percent as f32) / 200.0),
                    );
                    output.duck_until = Some(
                        Instant::now()
                            + Duration::from_secs_f64(
                                frames as f64 / INTERNAL_SAMPLE_RATE_HZ as f64,
                            ),
                    );
                }
                output.translation_player.append(buffer);
            }
            {
                let mut current = state.lock().unwrap();
                current.playback_frames_written += frames;
                current.monitor_playback_state = "ready".to_string();
            }
        }
    }
}

fn playback_volume(output_level: u64) -> f32 {
    output_level.min(100) as f32 / 100.0
}

fn flush_source_pending(output: &mut PlaybackOutput) {
    if output.source_pending_samples.is_empty() {
        return;
    }
    let samples = std::mem::take(&mut output.source_pending_samples);
    let buffer = SamplesBuffer::new(
        NonZeroU16::new(INTERNAL_CHANNEL_COUNT).unwrap(),
        NonZeroU32::new(INTERNAL_SAMPLE_RATE_HZ).unwrap(),
        samples,
    );
    output.source_player.append(buffer);
}

fn pending_source_chunks(output: &PlaybackOutput) -> usize {
    let frames = output.source_pending_samples.len() / INTERNAL_CHANNEL_COUNT as usize;
    frames.div_ceil(960)
}

fn source_playback_job_is_stale(
    job_generation: u64,
    current_generation: u64,
    queued_for: Duration,
) -> bool {
    job_generation != current_generation
        || queued_for > Duration::from_millis(OMNI_SOURCE_STALE_AFTER_MS)
}

fn monitor_source_queue_needs_drop(queued_sources: usize) -> bool {
    queued_sources >= OMNI_MONITOR_SOURCE_QUEUE_CAPACITY
}

fn open_playback_output(device_id: &str) -> Result<PlaybackOutput, String> {
    let host = cpal::default_host();
    let device = if device_id.trim().is_empty()
        || matches!(
            device_id.trim(),
            "default" | "speaker-default" | "system-output-default"
        ) {
        host.default_output_device()
            .ok_or_else(|| "default playback device not found".to_string())?
    } else {
        host.output_devices()
            .map_err_str()?
            .find(|device| playback_device_matches(device, device_id))
            .ok_or_else(|| format!("configured playback device not found: {device_id}"))?
    };
    if is_omni_virtual_playback_device(&device) {
        return Err(MONITOR_VIRTUAL_PLAYBACK_LOOP.to_string());
    }
    let resolved_device_id = device
        .id()
        .map(|id| id.1)
        .unwrap_or_else(|_| device_id.to_string());
    let sink = DeviceSinkBuilder::from_device(device)
        .and_then(|builder| builder.open_sink_or_fallback())
        .map_err_str()?;
    let source_player = Player::connect_new(sink.mixer());
    let translation_player = Player::connect_new(sink.mixer());
    Ok(PlaybackOutput {
        device_id: device_id.to_string(),
        resolved_device_id,
        _sink: sink,
        source_player,
        translation_player,
        source_pending_samples: Vec::new(),
        duck_until: None,
    })
}

fn is_omni_virtual_playback_device(device: &cpal::Device) -> bool {
    device
        .description()
        .map(|description| is_omni_virtual_playback_device_name(description.name()))
        .unwrap_or(false)
}

fn playback_device_matches(device: &cpal::Device, requested: &str) -> bool {
    device.id().map(|id| id.1 == requested).unwrap_or(false)
        || device
            .description()
            .map(|description| {
                normalized_device_name(description.name())
                    .contains(&normalized_device_name(requested))
            })
            .unwrap_or(false)
}

fn normalized_device_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_omni_virtual_playback_device_name(name: &str) -> bool {
    name.contains("Omni Translate Virtual Speaker")
}
