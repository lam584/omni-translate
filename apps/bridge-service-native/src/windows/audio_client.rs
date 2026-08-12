use super::*;

pub(super) fn spawn_audio_pipe_server(
    pipe_name: String,
    state: Arc<Mutex<BridgeState>>,
    runtime_root: PathBuf,
    playback_tx: mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: mpsc::Sender<PlaybackControlCommand>,
    translation_queue: Arc<Mutex<TranslationPlaybackQueue>>,
) {
    thread::spawn(move || {
        serve_named_pipe(&pipe_name, move |handle| {
            handle_audio_client(
                handle,
                &state,
                &runtime_root,
                &playback_tx,
                &playback_control_tx,
                &translation_queue,
            )
        });
    });
}

pub(super) fn handle_virtual_mic_frame(
    handle: HANDLE,
    state: &Arc<Mutex<BridgeState>>,
    runtime_root: &Path,
    header: &AudioFrameHeader,
    payload: &[u8],
    monitor_samples: &[f32],
    mut current: std::sync::MutexGuard<'_, BridgeState>,
) {
    let chunk_index = header.chunk_index.unwrap_or_default();
    let chunk_count = header.chunk_count.unwrap_or(1);
    let cue_id = header.cue_id.clone();
    let cue_key = cue_id.as_deref().unwrap_or_default();
    if !current.virtual_mic_output_requested {
        let code = "bridge.virtual-mic-output-unavailable";
        current.dropped_frame_count += header.frame_count as u64;
        current.last_error_code = Some(code.to_string());
        if current.virtual_mic_cue_ledger.complete_terminal(cue_key) {
            current.emit_translation_status(
                cue_id.as_deref(),
                TranslationPlaybackStatusKind::RouteFailed,
                "virtual-mic-output-not-requested",
                Some(code),
            );
        }
        let ack = rejected_audio_frame_ack(
            header,
            code,
            "virtual microphone output was not enabled during bridge.init",
        );
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    let admission = match current
        .virtual_mic_cue_ledger
        .begin(cue_key, chunk_index, chunk_count)
    {
        Ok(VirtualMicChunkAdmission::Duplicate) => {
            let ack = accepted_audio_frame_ack(header, current.playback_frames_written);
            drop(current);
            let _ = write_framed_json(handle, &ack);
            return;
        }
        Ok(admission) => admission,
        Err(reason) => {
            let code = "bridge.invalid-pcm-payload";
            let emit_terminal = current.virtual_mic_cue_ledger.complete_terminal(cue_key);
            current.dropped_frame_count += header.frame_count as u64;
            current.last_error_code = Some(code.to_string());
            if emit_terminal {
                current.emit_translation_status(
                    cue_id.as_deref(),
                    TranslationPlaybackStatusKind::RouteFailed,
                    reason,
                    Some(code),
                );
            }
            let ack = rejected_audio_frame_ack(
                header,
                code,
                "virtual microphone cue chunks must be ordered and keep a stable chunkCount",
            );
            drop(current);
            let _ = write_framed_json(handle, &ack);
            return;
        }
    };
    if let Some(reason) = translation_non_playback_reason(
        true,
        current.mix_control.translated_audio_enabled,
        monitor_samples.is_empty(),
    ) {
        current.dropped_frame_count += header.frame_count as u64;
        if current.virtual_mic_cue_ledger.complete_terminal(cue_key) {
            emit_translation_terminal(
                &current,
                &TranslationCueTerminal {
                    cue_id: header.cue_id.clone(),
                    status: TranslationPlaybackStatusKind::StaleDropped,
                    reason: reason.to_string(),
                    error_code: None,
                },
            );
        }
        let ack = accepted_audio_frame_ack(header, current.playback_frames_written);
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }

    let generation = virtual_mic_generation(current.session_id.as_deref().unwrap_or_default());
    let request_id = header.request_id.clone();
    if matches!(
        admission,
        VirtualMicChunkAdmission::Write { emit_queued: true }
    ) {
        current.emit_translation_status(
            cue_id.as_deref(),
            TranslationPlaybackStatusKind::Queued,
            "virtual-mic-write-queued",
            None,
        );
    }
    drop(current);
    let write_result = write_stereo_f32_to_virtual_mic(generation, monitor_samples);
    let mut current = state.lock().unwrap();
    match write_result {
        Ok(outcome) => {
            let driver_frames = outcome.frames_written;
            let lifecycle = current
                .virtual_mic_cue_ledger
                .complete_success(cue_key, chunk_index);
            let (emit_started, emit_completed) = lifecycle.unwrap_or((false, false));
            current.translated_frames_accepted += header.frame_count as u64;
            current.virtual_mic_frames_written = current
                .virtual_mic_frames_written
                .saturating_add(driver_frames);
            current.virtual_mic_last_generation = generation;
            current.virtual_mic_output_supported = true;
            current.virtual_mic_output_status = "ready".to_string();
            current.virtual_mic_capture_endpoint_name = Some(outcome.capture_endpoint_name);
            current.virtual_mic_format = Some(outcome.format);
            apply_virtual_mic_driver_status(&mut current, &outcome.driver_status);
            current.virtual_mic_session_active = true;
            current.last_error_code = None;
            service_log(
                LogLevel::Info,
                &request_id,
                &format!(
                    "event=virtual_mic_write status={} cueId={} generation={generation} chunkIndex={chunk_index} chunkCount={chunk_count} inputFrames={} driverFrames={driver_frames}",
                    if emit_completed { "completed" } else { "chunk-written" },
                    cue_id.as_deref().unwrap_or("-"),
                    header.frame_count,
                ),
            );
            if emit_started {
                current.emit_translation_status(
                    cue_id.as_deref(),
                    TranslationPlaybackStatusKind::Started,
                    "virtual-mic-write-started",
                    None,
                );
            }
            if emit_completed {
                current.emit_translation_status(
                    cue_id.as_deref(),
                    TranslationPlaybackStatusKind::Completed,
                    "virtual-mic-written",
                    None,
                );
            }
            let _ = fs::create_dir_all(runtime_root);
            let _ = fs::write(runtime_root.join("last-translation-frame.pcm"), payload);
            let ack = accepted_audio_frame_ack(header, current.playback_frames_written);
            drop(current);
            let _ = write_framed_json(handle, &ack);
        }
        Err(error) => {
            let emit_terminal = current.virtual_mic_cue_ledger.complete_terminal(cue_key);
            current.dropped_frame_count += header.frame_count as u64;
            current.virtual_mic_write_failures =
                current.virtual_mic_write_failures.saturating_add(1);
            current.virtual_mic_output_status =
                virtual_mic_output_status_for_error(error.code).to_string();
            current.virtual_mic_output_supported =
                current.virtual_mic_output_status != "unsupported";
            current.virtual_mic_session_active = false;
            current.last_error_code = Some(error.code.to_string());
            service_log(
                LogLevel::Error,
                &request_id,
                &format!(
                    "event=virtual_mic_write status=route-failed cueId={} generation={generation} errorCode={} detail={}",
                    cue_id.as_deref().unwrap_or("-"),
                    error.code,
                    error.detail,
                ),
            );
            if emit_terminal {
                current.emit_translation_status(
                    cue_id.as_deref(),
                    TranslationPlaybackStatusKind::RouteFailed,
                    "virtual-mic-write-failed",
                    Some(error.code),
                );
            }
            let ack = rejected_audio_frame_ack(header, error.code, &error.detail);
            drop(current);
            let _ = write_framed_json(handle, &ack);
        }
    }
}

pub(super) fn handle_physical_translation_frame(
    handle: HANDLE,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
    header: &AudioFrameHeader,
    payload: &[u8],
    monitor_samples: Vec<f32>,
    mut current: std::sync::MutexGuard<'_, BridgeState>,
) {
    if let Some(stream_state) = header.stream_state {
        handle_physical_translation_stream_frame(
            handle,
            runtime_root,
            playback_tx,
            playback_control_tx,
            translation_queue,
            header,
            payload,
            monitor_samples,
            current,
            stream_state,
        );
        return;
    }
    if current.physical_translation_stream_active() {
        let ack = rejected_audio_frame_ack(
            header,
            "bridge.queue-overflow",
            "complete translation cues cannot enter playback while an open-ended physical stream is active",
        );
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    if let Some(reason) = translation_non_playback_reason(
        current.translation_playback_enabled,
        current.mix_control.translated_audio_enabled,
        monitor_samples.is_empty(),
    ) {
        current.dropped_frame_count += header.frame_count as u64;
        emit_translation_terminal(
            &current,
            &TranslationCueTerminal {
                cue_id: header.cue_id.clone(),
                status: TranslationPlaybackStatusKind::StaleDropped,
                reason: reason.to_string(),
                error_code: None,
            },
        );
    } else {
        let playback_frames = monitor_samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
        let now_ms = unix_ms();
        let created_at_ms = header.created_at_ms.unwrap_or(now_ms);
        let duration_ms = playback_frames
            .saturating_mul(1_000)
            .div_ceil(INTERNAL_SAMPLE_RATE_HZ as u64);
        let job = PlaybackJob {
            samples: monitor_samples,
            device_id: current.physical_playback_device_id.clone(),
            volume: playback_volume(current.physical_playback_level),
            source_frame: false,
            ducking_enabled: current.mix_control.ducking_enabled,
            ducking_depth_percent: current.mix_control.ducking_depth_percent,
            queued_at: Instant::now(),
            source_generation: current.source_generation,
            cue_id: header.cue_id.clone(),
            created_at_ms,
            estimated_duration_ms: header.estimated_duration_ms.unwrap_or(duration_ms),
            playback_duration_ms: duration_ms,
            translation_generation: current.translation_generation,
        };
        let enqueue_result = translation_queue.lock().unwrap().enqueue(job, now_ms);
        match enqueue_result {
            Ok(outcome) => {
                for dropped in &outcome.dropped {
                    let dropped_frames =
                        dropped.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
                    current.dropped_frame_count += dropped_frames;
                    service_log(
                        LogLevel::Warning,
                        dropped.cue_id.as_deref().unwrap_or("-"),
                        &format!(
                            "event=translation_playback_status status=stale-dropped cueId={} reason=realtime-budget replacementCueId={}",
                            dropped.cue_id.as_deref().unwrap_or("-"),
                            header.cue_id.as_deref().unwrap_or("-"),
                        ),
                    );
                    current.emit_translation_status(
                        dropped.cue_id.as_deref(),
                        TranslationPlaybackStatusKind::StaleDropped,
                        "realtime-budget",
                        None,
                    );
                }
                current.monitor_playback_state = "queued".to_string();
                current.translation_queue_end_timestamp_ms = outcome.projected_end_ms;
                let _ = playback_tx.try_send(PlaybackCommand::TranslationQueued);
                service_log(
                    LogLevel::Info,
                    &header.request_id,
                    &format!(
                        "event=translation_playback_status status=queued cueId={} projectedStartMs={} durationMs={duration_ms} droppedPendingCues={}",
                        header.cue_id.as_deref().unwrap_or("-"),
                        outcome.projected_start_ms,
                        outcome.dropped.len(),
                    ),
                );
                current.emit_translation_status(
                    header.cue_id.as_deref(),
                    TranslationPlaybackStatusKind::Queued,
                    "accepted",
                    None,
                );
            }
            Err(failure) => {
                for dropped in &failure.dropped {
                    let dropped_frames =
                        dropped.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
                    current.dropped_frame_count += dropped_frames;
                    service_log(
                        LogLevel::Warning,
                        dropped.cue_id.as_deref().unwrap_or("-"),
                        &format!(
                            "event=translation_playback_status status=stale-dropped cueId={} reason=realtime-budget replacementCueId={}",
                            dropped.cue_id.as_deref().unwrap_or("-"),
                            header.cue_id.as_deref().unwrap_or("-"),
                        ),
                    );
                    current.emit_translation_status(
                        dropped.cue_id.as_deref(),
                        TranslationPlaybackStatusKind::StaleDropped,
                        "realtime-budget",
                        None,
                    );
                }
                current.translation_queue_end_timestamp_ms =
                    translation_queue.lock().unwrap().projected_end_ms(now_ms);
                current.dropped_frame_count += playback_frames;
                current.last_error_code = Some("bridge.queue-overflow".to_string());
                let failure_detail = match failure.reason {
                    TranslationEnqueueFailureReason::QueueFull => {
                        "translation queue is full and every pending cue is still within its realtime budget"
                    }
                    TranslationEnqueueFailureReason::RealtimeBudget => {
                        "translation would start outside the 5 second realtime budget and no expired pending cue can be removed"
                    }
                };
                let ack = rejected_audio_frame_ack(
                    header,
                    "bridge.queue-overflow",
                    failure_detail,
                );
                service_log(
                    LogLevel::Warning,
                    &header.request_id,
                    &format!(
                        "event=translation_playback_status status=route-failed cueId={} projectedStartMs={} createdAtMs={} reason={:?} errorCode=bridge.queue-overflow",
                        failure.job.cue_id.as_deref().unwrap_or("-"),
                        failure.projected_start_ms,
                        failure.job.created_at_ms,
                        failure.reason,
                    ),
                );
                current.emit_translation_status(
                    failure.job.cue_id.as_deref(),
                    TranslationPlaybackStatusKind::RouteFailed,
                    "queue-overflow",
                    Some("bridge.queue-overflow"),
                );
                drop(current);
                let _ = write_framed_json(handle, &ack);
                return;
            }
        }
    }
    current.translated_frames_accepted += header.frame_count as u64;
    let ack = accepted_audio_frame_ack(header, current.playback_frames_written);
    let _ = fs::create_dir_all(runtime_root);
    let _ = fs::write(runtime_root.join("last-translation-frame.pcm"), payload);
    drop(current);
    let _ = write_framed_json(handle, &ack);
}

#[allow(clippy::too_many_arguments)]
fn handle_physical_translation_stream_frame(
    handle: HANDLE,
    runtime_root: &Path,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
    header: &AudioFrameHeader,
    payload: &[u8],
    monitor_samples: Vec<f32>,
    mut current: std::sync::MutexGuard<'_, BridgeState>,
    stream_state: TranslationStreamState,
) {
    let Some(cue_id) = header.cue_id.as_deref().filter(|value| !value.trim().is_empty()) else {
        let ack = rejected_audio_frame_ack(header, "bridge.invalid-audio-frame", "physical translation streams require cueId");
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    };
    let Some(chunk_index) = header.chunk_index else {
        let ack = rejected_audio_frame_ack(header, "bridge.invalid-audio-frame", "physical translation streams require chunkIndex");
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    };
    if matches!(stream_state, TranslationStreamState::End | TranslationStreamState::Abort)
        && !monitor_samples.is_empty()
    {
        let ack = rejected_audio_frame_ack(header, "bridge.invalid-audio-frame", "physical translation stream end must have an empty payload");
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    if !matches!(stream_state, TranslationStreamState::End | TranslationStreamState::Abort)
        && monitor_samples.is_empty()
    {
        let ack = rejected_audio_frame_ack(header, "bridge.invalid-audio-frame", "physical translation stream audio chunks must not be empty");
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    if let Some(reason) = translation_non_playback_reason(
        current.translation_playback_enabled,
        current.mix_control.translated_audio_enabled,
        !matches!(stream_state, TranslationStreamState::End | TranslationStreamState::Abort)
            && monitor_samples.is_empty(),
    ) {
        let ack = rejected_audio_frame_ack(header, "bridge.translation-playback-disabled", reason);
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    let (next_ledger, admission) = match prepare_physical_stream_admission(
        &current.physical_translation_stream_ledger,
        cue_id,
        chunk_index,
        stream_state,
    ) {
        Ok(value) => value,
        Err(detail) => {
            let ack = rejected_audio_frame_ack(header, "bridge.invalid-audio-frame", detail);
            drop(current);
            let _ = write_framed_json(handle, &ack);
            return;
        }
    };
    if admission == PhysicalStreamAdmission::Start {
        let queue = translation_queue.lock().unwrap();
        if queue.active.is_some() || !queue.pending.is_empty() {
            let ack = rejected_audio_frame_ack(
                header,
                "bridge.queue-overflow",
                "physical translation stream cannot start while a complete cue is queued or playing",
            );
            drop(queue);
            drop(current);
            let _ = write_framed_json(handle, &ack);
            return;
        }
    }
    if admission == PhysicalStreamAdmission::Duplicate {
        let ack = accepted_audio_frame_ack(header, current.playback_frames_written);
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    if stream_state == TranslationStreamState::Abort {
        current.physical_translation_stream_ledger.finish(cue_id);
        let _ = playback_control_tx.send(PlaybackControlCommand::AbortTranslationStream {
            cue_id: cue_id.to_string(),
            reason: "physical-playback-stream-aborted".to_string(),
            error_code: "bridge.translation-playback-failed".to_string(),
        });
        let ack = accepted_audio_frame_ack(header, current.playback_frames_written);
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    let playback_frames = monitor_samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
    let now_ms = unix_ms();
    let duration_ms = playback_frames
        .saturating_mul(1_000)
        .div_ceil(INTERNAL_SAMPLE_RATE_HZ as u64);
    let job = PlaybackJob {
        samples: monitor_samples,
        device_id: current.physical_playback_device_id.clone(),
        volume: playback_volume(current.physical_playback_level),
        source_frame: false,
        ducking_enabled: current.mix_control.ducking_enabled,
        ducking_depth_percent: current.mix_control.ducking_depth_percent,
        queued_at: Instant::now(),
        source_generation: current.source_generation,
        cue_id: Some(cue_id.to_string()),
        created_at_ms: header.created_at_ms.unwrap_or(now_ms),
        estimated_duration_ms: header.estimated_duration_ms.unwrap_or(duration_ms),
        playback_duration_ms: duration_ms,
        translation_generation: current.translation_generation,
    };
    if playback_tx
        .try_send(PlaybackCommand::TranslationStream(PhysicalTranslationStreamCommand {
            job,
            state: stream_state,
        }))
        .is_err()
    {
        let ack = rejected_audio_frame_ack(header, "bridge.queue-overflow", "physical translation stream command queue is full");
        drop(current);
        let _ = write_framed_json(handle, &ack);
        return;
    }
    current.physical_translation_stream_ledger = next_ledger;
    current.translated_frames_accepted += header.frame_count as u64;
    service_log(
        LogLevel::Info,
        &header.request_id,
        &format!(
            "event=translation_stream_frame status=accepted cueId={cue_id} streamState={} chunkIndex={chunk_index} frames={}",
            stream_state.as_str(),
            header.frame_count,
        ),
    );
    let ack = accepted_audio_frame_ack(header, current.playback_frames_written);
    let _ = fs::create_dir_all(runtime_root);
    let _ = fs::write(runtime_root.join("last-translation-frame.pcm"), payload);
    drop(current);
    let _ = write_framed_json(handle, &ack);
}
