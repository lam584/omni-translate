fn handle_source_subscriber(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    source_rx: &Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    translation_status_outbox: &Arc<Mutex<TranslationStatusOutbox>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    runtime_root: &Path,
) {
    let subscription = {
        let source_rx = source_rx.lock().unwrap();
        let mut current = state.lock().unwrap();
        match process_source_route_failure(&current) {
            Some(failure) => Err((source_route_error_header(&current, &failure), failure)),
            None => {
                let generations = begin_source_subscription(&mut current);
                drop(current);
                while source_rx.try_recv().is_ok() {}
                Ok(generations)
            }
        }
    };
    let (my_generation, previous_generation) = match subscription {
        Ok(generations) => generations,
        Err((header, failure)) => {
            if write_pending_translation_statuses(handle, translation_status_outbox).is_ok() {
                let _ = write_framed_source_status(handle, &header);
            }
            append_bridge_service_log(
                runtime_root,
                &format!(
                    "event=source_subscription_rejected errorCode={} detail={}",
                    failure.code, failure.detail,
                ),
            );
            return;
        }
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
        let (owns_subscription, route_failure) = {
            let current = state.lock().unwrap();
            (
                source_subscription_is_owner(&current, my_generation),
                process_source_route_failure(&current)
                    .map(|failure| (source_route_error_header(&current, &failure), failure)),
            )
        };
        if !owns_subscription {
            append_bridge_service_log(
                runtime_root,
                &format!("source subscriber handoff: generation={my_generation}"),
            );
            break;
        }
        if write_pending_translation_statuses(handle, translation_status_outbox).is_err() {
            break;
        }
        if let Some((header, failure)) = route_failure {
            let _ = write_framed_source_status(handle, &header);
            append_bridge_service_log(
                runtime_root,
                &format!(
                    "event=source_subscription_failed generation={my_generation} errorCode={} detail={}",
                    failure.code, failure.detail,
                ),
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
        let bridge_process_id = current.bridge_process_id;
        let bridge_instance_id = current.bridge_instance_id.clone();
        let source_generation_token = source_generation_token(&current, my_generation);
        let source_stream_id = match current.source_capture_mode {
            SourceCaptureMode::VirtualDriver => "omni-virtual-speaker",
            SourceCaptureMode::ProcessExclusion => "omni-process-loopback-exclusion",
            SourceCaptureMode::None => "omni-no-source-capture",
        };
        drop(current);
        frame_index += 1;
        let frame_id = format!("driver-source-{frame_index}");
        let header = AudioFrameHeader {
            event_type: event_type.to_string(),
            request_id: frame_id.clone(),
            session_id,
            frame_id,
            stream_id: source_stream_id.to_string(),
            sample_rate_hz: INTERNAL_SAMPLE_RATE_HZ,
            sample_format: AudioSampleFormat::PcmS16le,
            channel_count: INTERNAL_CHANNEL_COUNT,
            frame_count: payload.len() / (INTERNAL_CHANNEL_COUNT as usize * 2),
            timestamp_ms: unix_ms(),
            payload_bytes: payload.len(),
            bridge_process_id: Some(bridge_process_id),
            bridge_instance_id: Some(bridge_instance_id),
            source_generation: Some(my_generation),
            source_generation_token: Some(source_generation_token),
            cue_id: None,
            created_at_ms: None,
            estimated_duration_ms: None,
            chunk_index: None,
            chunk_count: None,
            stream_state: None,
            translated_audio_enhancement_applied: false,
            translation_sink: None,
            route_direction: None,
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
    playback_control_rx: mpsc::Receiver<PlaybackControlCommand>,
    state: Arc<Mutex<BridgeState>>,
    translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
) {
    let mut output: Option<PlaybackOutput> = None;
    let mut physical_stream: Option<ActivePhysicalTranslationStream> = None;
    let mut cancelled_physical_streams = std::collections::HashSet::new();
    // Provider cue boundaries can overlap slightly. Buffer the next cue until
    // the current one has drained, preserving stream order at the one physical
    // playback sink without rejecting the new cue's valid start frame.
    let mut pending_physical_streams = VecDeque::new();
    loop {
        apply_playback_control_commands(
            &playback_control_rx,
            &mut output,
            &state,
            &translation_queue,
            &mut physical_stream,
            &mut cancelled_physical_streams,
            &mut pending_physical_streams,
        );
        finish_completed_physical_stream(&mut output, &state, &mut physical_stream);
        finish_completed_translation(&output, &state, &translation_queue);

        if physical_stream.is_none() {
            if let Some(command) = pending_physical_streams.pop_front() {
                play_physical_translation_stream(
                    command,
                    &mut output,
                    &state,
                    &mut physical_stream,
                    &mut cancelled_physical_streams,
                );
                continue;
            }
        }

        let disconnected = match playback_rx.recv_timeout(Duration::from_millis(
            PLAYBACK_WORKER_POLL_INTERVAL_MS,
        )) {
            Ok(PlaybackCommand::FlushSource) => {
                if let Some(output) = output.as_mut() {
                    flush_source_pending(output);
                    output.source_player.clear();
                    output.source_player.play();
                    output.source_pending_samples.clear();
                }
                state.lock().unwrap().monitor_source_queued_frames = 0;
                false
            }
            Ok(PlaybackCommand::Play(job)) => {
                play_source_job(job, &mut output, &state);
                false
            }
            Ok(PlaybackCommand::TranslationStream(command)) => {
                let cue_id = command.job.cue_id.as_deref().unwrap_or_default();
                if physical_stream
                    .as_ref()
                    .is_some_and(|active| active.cue_id != cue_id)
                {
                    pending_physical_streams.push_back(command);
                } else {
                    play_physical_translation_stream(
                        command,
                        &mut output,
                        &state,
                        &mut physical_stream,
                        &mut cancelled_physical_streams,
                    );
                }
                false
            }
            Ok(PlaybackCommand::TranslationQueued) | Err(mpsc::RecvTimeoutError::Timeout) => false,
            Err(mpsc::RecvTimeoutError::Disconnected) => true,
        };
        if disconnected {
            break;
        }
        apply_playback_control_commands(
            &playback_control_rx,
            &mut output,
            &state,
            &translation_queue,
            &mut physical_stream,
            &mut cancelled_physical_streams,
            &mut pending_physical_streams,
        );
        if physical_stream.is_none() {
            start_next_translation(&mut output, &state, &translation_queue);
        }
    }
}

fn play_physical_translation_stream(
    command: PhysicalTranslationStreamCommand,
    output: &mut Option<PlaybackOutput>,
    state: &Arc<Mutex<BridgeState>>,
    active: &mut Option<ActivePhysicalTranslationStream>,
    cancelled: &mut std::collections::HashSet<String>,
) {
    let PhysicalTranslationStreamCommand { job, state: stream_state } = command;
    let cue_id = job.cue_id.clone().unwrap_or_default();
    if cancelled.contains(&cue_id) {
        if matches!(stream_state, TranslationStreamState::End | TranslationStreamState::Abort) {
            cancelled.remove(&cue_id);
        }
        return;
    }
    if stream_state == TranslationStreamState::Abort {
        if active.as_ref().is_some_and(|current| current.cue_id == cue_id) {
            if let Some(output) = output.as_mut() {
                output.translation_player.clear();
                output.stream_ducking = false;
                output.source_player.set_volume(output.source_volume);
            }
            *active = None;
            let mut current = state.lock().unwrap();
            current.physical_translation_stream_ledger.finish(&cue_id);
            current.monitor_playback_state = "ready".to_string();
            current.emit_translation_status(
                Some(&cue_id),
                TranslationPlaybackStatusKind::RouteFailed,
                "physical-playback-stream-aborted",
                Some("bridge.translation-playback-failed"),
            );
        }
        return;
    }
    if stream_state == TranslationStreamState::End {
        if let Some(current) = active.as_mut().filter(|current| current.cue_id == cue_id) {
            current.ended = true;
        }
        return;
    }
    if stream_state == TranslationStreamState::Start {
        if active.is_some() {
            let mut current = state.lock().unwrap();
            current.dropped_frame_count += job.playback_duration_ms
                .saturating_mul(INTERNAL_SAMPLE_RATE_HZ as u64) / 1_000;
            current.last_error_code = Some("bridge.queue-overflow".to_string());
            current.emit_translation_status(
                Some(&cue_id),
                TranslationPlaybackStatusKind::RouteFailed,
                "physical-stream-overlap",
                Some("bridge.queue-overflow"),
            );
            return;
        }
        if output.as_ref().map(|current| current.device_id.as_str()) != Some(job.device_id.as_str()) {
            *output = match open_playback_output(&job.device_id) {
                Ok(next) => Some(next),
                Err(error) => {
                    let mut current = state.lock().unwrap();
                    current.physical_translation_stream_ledger.finish(&cue_id);
                    current.last_error_code = Some("bridge.translation-playback-failed".to_string());
                    current.emit_translation_status(
                        Some(&cue_id),
                        TranslationPlaybackStatusKind::RouteFailed,
                        &format!("physical-output-open-failed:{error}"),
                        Some("bridge.translation-playback-failed"),
                    );
                    return;
                }
            };
        }
        *active = Some(ActivePhysicalTranslationStream {
            cue_id: cue_id.clone(),
            created_at_ms: job.created_at_ms,
            estimated_duration_ms: job.estimated_duration_ms,
            playback_frames: 0,
            translation_generation: job.translation_generation,
            ended: false,
        });
        let mut current = state.lock().unwrap();
        current.monitor_playback_state = "playing".to_string();
        current.emit_translation_status(Some(&cue_id), TranslationPlaybackStatusKind::Queued, "accepted-stream", None);
        current.emit_translation_status(Some(&cue_id), TranslationPlaybackStatusKind::Started, "physical-playback-stream-started", None);
        if job.ducking_enabled {
            let output = output.as_mut().expect("physical output was opened before stream start");
            output.stream_ducking = true;
            output.source_player.set_volume(ducked_source_volume(
                output.source_volume,
                job.ducking_depth_percent,
            ));
        }
    }
    let Some(stream) = active.as_mut().filter(|current| {
        current.cue_id == cue_id && current.translation_generation == job.translation_generation
    }) else { return; };
    let Some(output) = output.as_mut() else { return; };
    flush_source_pending(output);
    output.translation_generation = Some(job.translation_generation);
    output.translation_player.set_volume(job.volume);
    output.translation_player.play();
    let frames = job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
    output.translation_player.append(SamplesBuffer::new(
        NonZeroU16::new(INTERNAL_CHANNEL_COUNT).unwrap(),
        NonZeroU32::new(INTERNAL_SAMPLE_RATE_HZ).unwrap(),
        job.samples,
    ));
    stream.playback_frames = stream.playback_frames.saturating_add(frames);
    stream.estimated_duration_ms = stream
        .estimated_duration_ms
        .saturating_add(job.playback_duration_ms);
    let mut current = state.lock().unwrap();
    current.resolved_physical_playback_device_id = output.resolved_device_id.clone();
    current.playback_frames_written = current.playback_frames_written.saturating_add(frames);
    current.translation_queue_end_timestamp_ms = unix_ms().saturating_add(
        output.translation_player.len() as u64 * 1_000,
    );
}

fn apply_playback_control_commands(
    playback_control_rx: &mpsc::Receiver<PlaybackControlCommand>,
    output: &mut Option<PlaybackOutput>,
    state: &Arc<Mutex<BridgeState>>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
    physical_stream: &mut Option<ActivePhysicalTranslationStream>,
    cancelled_physical_streams: &mut std::collections::HashSet<String>,
    pending_physical_streams: &mut VecDeque<PhysicalTranslationStreamCommand>,
) {
    while let Ok(command) = playback_control_rx.try_recv() {
        let PlaybackControlCommand::StopAll(request) = command else {
            let PlaybackControlCommand::AbortTranslationStream { cue_id, reason, error_code } = command else { unreachable!() };
            if physical_stream.as_ref().is_some_and(|stream| stream.cue_id == cue_id) {
                if let Some(output) = output.as_mut() {
                    output.translation_player.clear();
                    output.stream_ducking = false;
                    output.source_player.set_volume(output.source_volume);
                }
                *physical_stream = None;
            }
            pending_physical_streams.retain(|pending| {
                pending.job.cue_id.as_deref() != Some(cue_id.as_str())
            });
            let mut current = state.lock().unwrap();
            cancelled_physical_streams.insert(cue_id.clone());
            current.physical_translation_stream_ledger.finish(&cue_id);
            current.monitor_playback_state = "ready".to_string();
            current.emit_translation_status(
                Some(&cue_id),
                TranslationPlaybackStatusKind::RouteFailed,
                &reason,
                Some(&error_code),
            );
            continue;
        };
        if let Some(output) = output.as_mut() {
            output.source_pending_samples.clear();
            output.source_player.clear();
            let stops_current_translation = output
                .translation_generation
                .map(|generation| generation <= request.stop_through_generation)
                .unwrap_or(true);
            if stops_current_translation {
                output.translation_player.clear();
                output.translation_generation = None;
                output.stream_ducking = false;
                output.source_player.set_volume(output.source_volume);
            }
        }
        *physical_stream = None;
        cancelled_physical_streams.clear();
        pending_physical_streams.clear();
        if request.recreate_output {
            *output = None;
        }
        let mut current = state.lock().unwrap();
        let queue = translation_queue.lock().unwrap();
        current.monitor_source_queued_frames = 0;
        current.translation_queue_end_timestamp_ms = queue.projected_end_ms(unix_ms());
        current.monitor_playback_state = if queue.active.is_some() {
            "playing"
        } else if queue.pending.is_empty() {
            "stopped"
        } else {
            "queued"
        }
        .to_string();
        drop(queue);
        drop(current);
        service_log(
            LogLevel::Info,
            &format!("{}:{}", file!(), line!()),
            &format!(
                "event=translation_playback_stop_applied reason={} errorCode={} stoppedThroughGeneration={} terminatedCues={}",
                request.reason,
                request.error_code.as_deref().unwrap_or("-"),
                request.stop_through_generation,
                request.terminated_cues.len(),
            ),
        );
    }
}

fn write_framed_source_status(
    handle: HANDLE,
    header: &impl serde::Serialize,
) -> Result<(), io::Error> {
    let header = serde_json::to_vec(header).map_err(io::Error::other)?;
    write_all(handle, &(header.len() as u32).to_le_bytes())?;
    write_all(handle, &header)
}

fn read_translation_status_ack(handle: HANDLE) -> Result<TranslationPlaybackStatusAck, io::Error> {
    let header_size = read_exact(handle, 4)?;
    let header_size = u32::from_le_bytes(
        header_size
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid ack header size"))?,
    ) as usize;
    if header_size == 0 || header_size > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "translation status ack header size is invalid",
        ));
    }
    let header = read_exact(handle, header_size)?;
    let ack: TranslationPlaybackStatusAck =
        serde_json::from_slice(&header).map_err(io::Error::other)?;
    if ack.event_type != "bridge.translation.status.ack" || ack.status_id.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "translation status ack has an invalid type or statusId",
        ));
    }
    Ok(ack)
}

/// Delivers status events in FIFO order and removes an event only after the
/// Desktop explicitly acknowledges the stable `statusId`. A pipe write can
/// succeed immediately before the reader disappears, so successful
/// `WriteFile` alone is never treated as delivery. Disconnects and malformed
/// or mismatched acknowledgements leave the front event available for replay
/// on the next source-pipe connection.
fn write_pending_translation_statuses(
    handle: HANDLE,
    outbox: &Arc<Mutex<TranslationStatusOutbox>>,
) -> Result<(), io::Error> {
    loop {
        let header = outbox.lock().unwrap().front().cloned();
        let Some(header) = header else {
            return Ok(());
        };
        write_framed_source_status(handle, &header)?;
        let ack = read_translation_status_ack(handle)?;
        if !outbox.lock().unwrap().acknowledge(&ack) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "translation status ack did not match the pending event: expected={} actual={}",
                    header.status_id, ack.status_id
                ),
            ));
        }
    }
}

fn finish_completed_translation(
    output: &Option<PlaybackOutput>,
    state: &Arc<Mutex<BridgeState>>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
) {
    let playback_empty = output
        .as_ref()
        .map(|current| current.translation_player.empty())
        .unwrap_or(true);
    if !playback_empty {
        return;
    }
    let now_ms = unix_ms();
    let mut current = state.lock().unwrap();
    let mut queue = translation_queue.lock().unwrap();
    let Some(completed) = queue.finish_active() else {
        return;
    };
    current.translation_queue_end_timestamp_ms = queue.projected_end_ms(now_ms);
    current.monitor_playback_state = if queue.pending.is_empty() {
        "ready"
    } else {
        "queued"
    }
    .to_string();
    current.emit_translation_status(
        completed.cue_id.as_deref(),
        TranslationPlaybackStatusKind::Completed,
        "physical-playback-completed",
        None,
    );
    drop(queue);
    drop(current);
    service_log(
        LogLevel::Info,
        completed.cue_id.as_deref().unwrap_or("-"),
        &format!(
            "event=translation_playback_status status=completed cueId={} totalAgeMs={} estimatedDurationMs={}",
            completed.cue_id.as_deref().unwrap_or("-"),
            now_ms.saturating_sub(completed.created_at_ms),
            completed.estimated_duration_ms,
        ),
    );
}

fn play_source_job(
    job: PlaybackJob,
    output: &mut Option<PlaybackOutput>,
    state: &Arc<Mutex<BridgeState>>,
) {
    debug_assert!(job.source_frame);
    if output.as_ref().map(|current| current.device_id.as_str()) != Some(job.device_id.as_str()) {
        *output = match open_playback_output(&job.device_id) {
            Ok(next) => Some(next),
            Err(error) => {
                let mut current = state.lock().unwrap();
                current.last_error_code = Some(if error == MONITOR_VIRTUAL_PLAYBACK_LOOP {
                    error
                } else {
                    format!("monitor.playback-failed:{error}")
                });
                current.monitor_playback_state = "blocked".to_string();
                return;
            }
        };
    }
    let Some(output) = output.as_mut() else {
        return;
    };
    state.lock().unwrap().resolved_physical_playback_device_id =
        output.resolved_device_id.clone();
    let frames = job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
    let generation = state.lock().unwrap().source_generation;
    if source_playback_job_is_stale(job.source_generation, generation, job.queued_at.elapsed()) {
        state.lock().unwrap().stale_source_frames_dropped += frames;
        return;
    }
    if monitor_source_queue_needs_drop(output.source_player.len()) {
        let mut current = state.lock().unwrap();
        current.monitor_overrun_count += 1;
        current.stale_source_frames_dropped += frames;
        return;
    }
    output.source_volume = job.volume;
    if !output.stream_ducking
        && output
            .duck_until
            .map(|deadline| Instant::now() >= deadline)
            .unwrap_or(false)
    {
        output.source_player.set_volume(job.volume);
        output.duck_until = None;
    }
    if output.duck_until.is_none() && !output.stream_ducking {
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
}

fn start_next_translation(
    output: &mut Option<PlaybackOutput>,
    state: &Arc<Mutex<BridgeState>>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
) {
    let now_ms = unix_ms();
    let job = {
        let mut current = state.lock().unwrap();
        let mut queue = translation_queue.lock().unwrap();
        let outcome = queue.start_next(now_ms);
        for dropped in &outcome.dropped {
            let dropped_frames =
                dropped.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
            current.dropped_frame_count += dropped_frames;
            service_log(
                LogLevel::Warning,
                dropped.cue_id.as_deref().unwrap_or("-"),
                &format!(
                    "event=translation_playback_status status=stale-dropped cueId={} reason=realtime-budget-before-start projectedAtMs={now_ms}",
                    dropped.cue_id.as_deref().unwrap_or("-"),
                ),
            );
            current.emit_translation_status(
                dropped.cue_id.as_deref(),
                TranslationPlaybackStatusKind::StaleDropped,
                "realtime-budget-before-start",
                None,
            );
        }
        current.translation_queue_end_timestamp_ms = queue.projected_end_ms(now_ms);
        current.monitor_playback_state = if outcome.job.is_some() {
            "queued"
        } else if queue.pending.is_empty() {
            "ready"
        } else {
            "queued"
        }
        .to_string();
        outcome.job
    };
    let Some(job) = job else {
        return;
    };
    if output.as_ref().map(|current| current.device_id.as_str()) != Some(job.device_id.as_str()) {
        *output = match open_playback_output(&job.device_id) {
            Ok(next) => Some(next),
            Err(error) => {
                let (error_code, error_detail) = if error == MONITOR_VIRTUAL_PLAYBACK_LOOP {
                    (error.clone(), error)
                } else {
                    ("bridge.translation-playback-failed".to_string(), error)
                };
                let failure_reason = format!("physical-output-open-failed:{error_detail}");
                let mut current = state.lock().unwrap();
                let mut queue = translation_queue.lock().unwrap();
                let failed = queue.finish_active();
                current.translation_queue_end_timestamp_ms = queue.projected_end_ms(unix_ms());
                current.dropped_frame_count += failed
                    .as_ref()
                    .map(|active| active.playback_frames)
                    .unwrap_or_default();
                current.last_error_code = Some(error_code.clone());
                current.monitor_playback_state = "blocked".to_string();
                current.emit_translation_status(
                    job.cue_id.as_deref(),
                    TranslationPlaybackStatusKind::RouteFailed,
                    &failure_reason,
                    Some(&error_code),
                );
                drop(queue);
                drop(current);
                service_log(
                    LogLevel::Error,
                    job.cue_id.as_deref().unwrap_or("-"),
                    &format!(
                        "event=translation_playback_status status=route-failed cueId={} errorCode={error_code} detail={error_detail}",
                        job.cue_id.as_deref().unwrap_or("-"),
                    ),
                );
                return;
            }
        };
    }
    let Some(output) = output.as_mut() else {
        return;
    };
    flush_source_pending(output);
    if output.translation_generation.is_some()
        && output.translation_generation != Some(job.translation_generation)
    {
        output.translation_player.clear();
    }
    output.translation_generation = Some(job.translation_generation);
    output.translation_player.play();
    output.translation_player.set_volume(job.volume);
    service_log(
        LogLevel::Info,
        job.cue_id.as_deref().unwrap_or("-"),
        &format!(
            "event=translation_playback_status status=started cueId={} queueAgeMs={} estimatedDurationMs={}",
            job.cue_id.as_deref().unwrap_or("-"),
            now_ms.saturating_sub(job.created_at_ms),
            job.estimated_duration_ms,
        ),
    );
    state.lock().unwrap().emit_translation_status(
        job.cue_id.as_deref(),
        TranslationPlaybackStatusKind::Started,
        "physical-playback-started",
        None,
    );
    let frames = job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
    let buffer = SamplesBuffer::new(
        NonZeroU16::new(INTERNAL_CHANNEL_COUNT).unwrap(),
        NonZeroU32::new(INTERNAL_SAMPLE_RATE_HZ).unwrap(),
        job.samples,
    );
    if job.ducking_enabled {
        output.source_player.set_volume(ducked_source_volume(
            output.source_volume,
            job.ducking_depth_percent,
        ));
        output.duck_until = Some(
            Instant::now()
                + Duration::from_secs_f64(frames as f64 / INTERNAL_SAMPLE_RATE_HZ as f64),
        );
    }
    output.translation_player.append(buffer);
    let mut current = state.lock().unwrap();
    current.resolved_physical_playback_device_id = output.resolved_device_id.clone();
    current.playback_frames_written += frames;
    current.monitor_playback_state = "playing".to_string();
}

fn playback_volume(output_level: u64) -> f32 {
    output_level.min(100) as f32 / 100.0
}

fn ducked_source_volume(source_volume: f32, ducking_depth_percent: u64) -> f32 {
    source_volume * 10.0_f32.powf(-(ducking_depth_percent as f32) / 200.0)
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
        source_volume: 1.0,
        duck_until: None,
        stream_ducking: false,
        translation_generation: None,
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
    let mut normalized = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_whitespace() {
            continue;
        }
        normalized.extend(ch.to_lowercase());
    }
    normalized
}

fn is_omni_virtual_playback_device_name(name: &str) -> bool {
    name.contains("Omni Translate Virtual Speaker")
}
