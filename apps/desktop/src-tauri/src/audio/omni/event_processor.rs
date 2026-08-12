use super::*;

pub(super) struct OmniAudioOutputState {
    pub(super) pending_audio_delta_count: u64,
    pub(super) pending_audio_delta_base64_bytes: u64,
    pub(super) pending_audio_response_id: Option<String>,
    pub(super) pending_audio_buffer: Vec<i16>,
    pub(super) pending_audio_stream_cue_id: Option<String>,
    pub(super) pending_audio_stream_chunk_index: u32,
    pub(super) pending_audio_stream_created_at_ms: Option<u64>,
    pub(super) pending_audio_stream_aborted: bool,
}

pub(super) struct OmniSubtitleEventState {
    pub(super) current_cue_id: Option<String>,
    pub(super) pending_source_text: String,
    pub(super) pending_translated_text: String,
    pub(super) st_skip_logged: bool,
    pub(super) event_diagnostics: OmniEventDiagnostics,
}

pub(super) struct OmniEventProcessor;

pub(super) struct OmniReadinessState {
    pub(super) session_ready_for_audio: bool,
    pub(super) event_diagnostics: OmniEventDiagnostics,
}

impl OmniEventProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn process_session_ready<R: tauri::Runtime>(
        mut state: OmniReadinessState,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        direction: &str,
        session_generation: u64,
        session_started_at: &SystemTime,
        event_type: &str,
        evt: &Value,
        queued_audio_chunks: usize,
        dropped_audio_chunks: u64,
        readiness_sent: &AtomicBool,
        readiness_tx: &mpsc::Sender<Result<u64, String>>,
    ) -> OmniReadinessState {
        let was_ready_for_audio = state.session_ready_for_audio;
        handle_session_ready_event(
            app,
            event_type,
            evt,
            &mut state.session_ready_for_audio,
            dropped_audio_chunks,
            queued_audio_chunks,
        );
        if !was_ready_for_audio && state.session_ready_for_audio {
            state.event_diagnostics.readiness_event = Some(event_type.to_string());
            store.watch_session_report.record_session_ready(
                event_type,
                elapsed_ms_since(session_started_at),
                queued_audio_chunks as u64,
                dropped_audio_chunks,
            );
            if !store.mark_omni_session_ready(direction, session_generation) {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "warning",
                    "watch_mode.omni_session_late_ready",
                    format!(
                        "direction={direction} generation={session_generation} event={event_type} reason=session_not_active_or_generation_mismatch"
                    ),
                );
            }
            if !readiness_sent.swap(true, Ordering::SeqCst) {
                let _ = readiness_tx.send(Ok(session_generation));
            }
        }
        state
    }

    pub(super) fn log_unknown_event<R: tauri::Runtime>(app: &AppHandle<R>, event_type: &str, raw_text: &str) {
        let is_vad_related = event_type.starts_with("input_audio_buffer.")
            || event_type.starts_with("conversation.item.input_audio");
        let prefix = if is_vad_related {
            "[VAD] unknown VAD event"
        } else {
            "[EVENT] unknown event"
        };
        let preview = if raw_text.len() > 600 {
            format!("{}...({} bytes)", crate::audio::str_utils::truncate_chars(raw_text, 600), raw_text.len())
        } else {
            raw_text.to_string()
        };
        let _ = diag_log(
            app,
            "omni",
            "debug",
            format!("{prefix}: type=\"{event_type}\" raw={preview}"),
        );
    }

    pub(super) fn expire_stale_transcription<R: tauri::Runtime>(
        app: &AppHandle<R>,
        completed: &mut bool,
        completed_at: &mut Option<SystemTime>,
    ) {
        if !*completed {
            return;
        }
        let Some(timestamp) = completed_at.as_ref() else {
            return;
        };
        let elapsed_ms = timestamp.elapsed().unwrap_or_default().as_millis();
        if elapsed_ms > TRANSCRIPTION_COMPLETED_TIMEOUT_MS as u128 {
            *completed = false;
            *completed_at = None;
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[STATE] transcription_completed_flag reset after {elapsed_ms}ms without response.done or speech_started"
                ),
            );
        }
    }

    pub(super) fn process_audio_delta<R: tauri::Runtime>(
        state: OmniAudioOutputState,
        app: &AppHandle<R>,
        evt: &Value,
        direction: &str,
        cue_id: Option<&str>,
        playback_queue: &OmniPlaybackQueue,
    ) -> OmniAudioOutputState {
        let OmniAudioOutputState {
            mut pending_audio_delta_count,
            mut pending_audio_delta_base64_bytes,
            mut pending_audio_response_id,
            mut pending_audio_buffer,
            mut pending_audio_stream_cue_id,
            mut pending_audio_stream_chunk_index,
            mut pending_audio_stream_created_at_ms,
            mut pending_audio_stream_aborted,
        } = state;
        if let Some(delta) = evt["delta"].as_str() {
            match base64_decode_to_i16(delta) {
                Ok(samples) => {
                    pending_audio_delta_count += 1;
                    pending_audio_delta_base64_bytes += delta.len() as u64;
                    if pending_audio_response_id.is_none() {
                        pending_audio_response_id = evt["response_id"]
                            .as_str()
                            .map(ToString::to_string);
                    }
                    if !pending_audio_stream_aborted {
                        pending_audio_buffer.extend_from_slice(&samples);
                    }
                    let audio_state = app.state::<AudioStateStore>();
                    if let (Some(cue_id), Some(config)) = (
                        cue_id.filter(|value| !value.trim().is_empty()),
                        audio_state.active_omni_speech_config(),
                    ) {
                        let output_route = crate::audio::speech::SpeechOutputRoutePlan::for_configured_route(
                            direction,
                            config.local_playback_enabled,
                            config.virtual_mic_output_enabled,
                            config.bridge_playback_enabled,
                        );
                        if output_route.write_to_bridge_playback && !pending_audio_stream_aborted {
                            if pending_audio_stream_cue_id.as_deref().is_some_and(|active| active != cue_id) {
                                let active = pending_audio_stream_cue_id.take().unwrap();
                                playback_queue.abort_stream(
                                    &active,
                                    pending_audio_stream_chunk_index,
                                    pending_audio_stream_created_at_ms.unwrap_or_else(unix_ms),
                                );
                                pending_audio_stream_chunk_index = 0;
                                pending_audio_stream_created_at_ms = None;
                                pending_audio_stream_aborted = true;
                                pending_audio_buffer.clear();
                                audio_state.watch_session_report.record_session_issue(
                                    "output",
                                    "native-playback-stream-overlap",
                                    "error",
                                    "A second native audio cue started before the active Bridge playback stream ended.",
                                );
                            } else {
                                let created_at_ms = *pending_audio_stream_created_at_ms
                                    .get_or_insert_with(unix_ms);
                                let raw = std::mem::take(&mut pending_audio_buffer);
                                if !raw.is_empty() {
                                    let stream_state = if pending_audio_stream_cue_id.is_none() {
                                        omni_bridge_protocol::TranslationStreamState::Start
                                    } else {
                                        omni_bridge_protocol::TranslationStreamState::Chunk
                                    };
                                    let chunk_duration_ms = (raw.len() as u64)
                                        .saturating_mul(1_000)
                                        .div_ceil(OMNI_OUTPUT_SAMPLE_RATE_HZ as u64);
                                    let enqueue = playback_queue.enqueue(OmniPlaybackCommand::Stream {
                                        samples: raw,
                                        cue_id: cue_id.to_string(),
                                        sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
                                        queued_at: Instant::now(),
                                        created_at_ms,
                                        estimated_duration_ms: chunk_duration_ms,
                                        chunk_index: pending_audio_stream_chunk_index,
                                        stream_state,
                                    });
                                    if matches!(
                                        enqueue,
                                        OmniPlaybackEnqueueOutcome::Overflow { .. }
                                            | OmniPlaybackEnqueueOutcome::Stopped
                                    ) {
                                        playback_queue.abort_stream(
                                            cue_id,
                                            pending_audio_stream_chunk_index,
                                            created_at_ms,
                                        );
                                        pending_audio_stream_cue_id = None;
                                        pending_audio_stream_chunk_index = 0;
                                        pending_audio_stream_created_at_ms = None;
                                        pending_audio_stream_aborted = true;
                                        audio_state.watch_session_report.record_session_issue(
                                            "output", "native-playback-stream-overflow", "error",
                                            "Native audio stream exceeded the bounded playback scheduler.",
                                        );
                                    }
                                    if !pending_audio_stream_aborted {
                                        pending_audio_stream_cue_id = Some(cue_id.to_string());
                                        pending_audio_stream_chunk_index =
                                            pending_audio_stream_chunk_index.saturating_add(1);
                                    }
                                }
                            }
                        }
                    }
                    if pending_audio_delta_count == 1
                        || pending_audio_delta_count.is_multiple_of(25)
                    {
                        let response_id = pending_audio_response_id
                            .as_deref()
                            .unwrap_or("(none)");
                        let _ = diag_log(
                            &app,
                            "omni",
                            "debug",
                            format!(
                                "[AUDIO] native audio.delta received: response_id={response_id} deltas={} delta_b64_len={} decoded_samples={} buffered_samples={} sample_rate_hz={OMNI_OUTPUT_SAMPLE_RATE_HZ}",
                                pending_audio_delta_count,
                                delta.len(),
                                samples.len(),
                                pending_audio_buffer.len()
                            ),
                        );
                    }
                }
                Err(e) => {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "warning",
                        format!("[AUDIO] base64 decode failed: {e}"),
                    );
                }
            }
        }
        OmniAudioOutputState {
            pending_audio_delta_count,
            pending_audio_delta_base64_bytes,
            pending_audio_response_id,
            pending_audio_buffer,
            pending_audio_stream_cue_id,
            pending_audio_stream_chunk_index,
            pending_audio_stream_created_at_ms,
            pending_audio_stream_aborted,
        }
    }

    pub(super) fn process_audio_done<R: tauri::Runtime>(
        state: OmniAudioOutputState,
        app: &AppHandle<R>,
        playback_queue: &OmniPlaybackQueue,
        cue_id: Option<&str>,
        _direction: &str,
    ) -> OmniAudioOutputState {
        let OmniAudioOutputState {
            mut pending_audio_delta_count,
            mut pending_audio_delta_base64_bytes,
            mut pending_audio_response_id,
            mut pending_audio_buffer,
            mut pending_audio_stream_cue_id,
            mut pending_audio_stream_chunk_index,
            mut pending_audio_stream_created_at_ms,
            mut pending_audio_stream_aborted,
        } = state;
        if let Some(stream_cue_id) = pending_audio_stream_cue_id.take() {
            let created_at_ms = pending_audio_stream_created_at_ms.unwrap_or_else(unix_ms);
            let result = playback_queue.enqueue(OmniPlaybackCommand::Stream {
                samples: Vec::new(),
                cue_id: stream_cue_id,
                sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
                queued_at: Instant::now(),
                created_at_ms,
                estimated_duration_ms: 0,
                chunk_index: pending_audio_stream_chunk_index,
                stream_state: omni_bridge_protocol::TranslationStreamState::End,
            });
            if matches!(result, OmniPlaybackEnqueueOutcome::Overflow { .. } | OmniPlaybackEnqueueOutcome::Stopped) {
                playback_queue.abort_stream(
                    cue_id.unwrap_or("unknown-native-cue"),
                    pending_audio_stream_chunk_index,
                    created_at_ms,
                );
                app.state::<AudioStateStore>().watch_session_report.record_session_issue(
                    "output", "native-playback-stream-overflow", "error",
                    "Native audio stream end could not enter the bounded playback scheduler.",
                );
            }
            pending_audio_stream_chunk_index = 0;
            pending_audio_stream_created_at_ms = None;
            pending_audio_buffer.clear();
        }
        if !pending_audio_buffer.is_empty() {
            let sample_count = pending_audio_buffer.len();
            let duration_ms = ((sample_count as u64) * 1000)
                .div_ceil(OMNI_OUTPUT_SAMPLE_RATE_HZ as u64);
            let response_id =
                pending_audio_response_id.as_deref().unwrap_or("(none)");
            let audio_state = app.state::<AudioStateStore>();
            let Some(cue_id) = cue_id.filter(|value| !value.trim().is_empty()) else {
                let detail = format!(
                    "原生翻译音频无法关联到实际字幕 cue，已拒绝进入播放队列。responseId={response_id}"
                );
                audio_state.watch_session_report.record_session_issue(
                    "output",
                    "native-playback-missing-cue",
                    "error",
                    &detail,
                );
                let _ = diag_log(
                    app,
                    "omni",
                    "error",
                    format!(
                        "[AUDIO] native audio.done route failed: response_id={response_id} reason=missing-subtitle-cue samples={sample_count}"
                    ),
                );
                pending_audio_buffer.clear();
                pending_audio_delta_count = 0;
                pending_audio_delta_base64_bytes = 0;
                pending_audio_response_id = None;
                return OmniAudioOutputState {
                    pending_audio_delta_count,
                    pending_audio_delta_base64_bytes,
                    pending_audio_response_id,
                    pending_audio_buffer,
                    pending_audio_stream_cue_id,
                    pending_audio_stream_chunk_index,
                    pending_audio_stream_created_at_ms,
                    pending_audio_stream_aborted,
                };
            };
            let created_at_ms = unix_ms();
            let enqueue_status = match playback_queue.enqueue(OmniPlaybackCommand::Play {
                samples: std::mem::take(&mut pending_audio_buffer),
                cue_id: cue_id.to_string(),
                sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
                queued_at: Instant::now(),
                created_at_ms,
                estimated_duration_ms: duration_ms,
            }) {
                OmniPlaybackEnqueueOutcome::Queued => "queued",
                OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { dropped_cue_ids } => {
                    record_native_playback_stale(
                        app,
                        &audio_state,
                        &dropped_cue_ids,
                        "realtime-budget-at-enqueue",
                    );
                    "queued_after_stale_drop"
                }
                OmniPlaybackEnqueueOutcome::Overflow {
                    reason,
                    dropped_cue_ids,
                } => {
                    record_native_playback_stale(
                        app,
                        &audio_state,
                        &dropped_cue_ids,
                        "realtime-budget-at-enqueue",
                    );
                    let reason = match reason {
                        OmniPlaybackOverflowReason::QueueFull => "queue-full-with-fresh-pending",
                        OmniPlaybackOverflowReason::RealtimeBudget => {
                            "projected-start-outside-realtime-budget"
                        }
                    };
                    audio_state.watch_session_report.record_session_issue(
                        "output",
                        "native-playback-queue-overflow",
                        "error",
                        &format!(
                            "原生翻译语音无法在实时预算内开始，且没有可淘汰的过期 pending cue。cueId={cue_id} reason={reason}"
                        ),
                    );
                    let _ = diag_log(
                        app,
                        "omni",
                        "error",
                        format!(
                            "[AUDIO] native playback queue overflow: cue_id={cue_id} reason={reason}"
                        ),
                    );
                    "dropped_overflow"
                }
                OmniPlaybackEnqueueOutcome::Terminated => "dropped_terminated",
                OmniPlaybackEnqueueOutcome::Stopped => "dropped_stopped",
            };
            let log_level = if enqueue_status == "queued" {
                "info"
            } else {
                "warning"
            };
            let _ = diag_log(
                &app,
                "omni",
                log_level,
                format!(
                    "[AUDIO] native audio.done: response_id={response_id} deltas={} base64_bytes={} samples={sample_count} sample_rate_hz={OMNI_OUTPUT_SAMPLE_RATE_HZ} duration_ms={duration_ms}; playback_status={enqueue_status} cue_id={cue_id}",
                    pending_audio_delta_count,
                    pending_audio_delta_base64_bytes
                ),
            );
        } else {
            let response_id =
                pending_audio_response_id.as_deref().unwrap_or("(none)");
            let _ = diag_log(
                &app,
                "omni",
                "warning",
                format!(
                    "[AUDIO] native audio.done received with empty buffer: response_id={response_id} deltas={} base64_bytes={}",
                    pending_audio_delta_count,
                    pending_audio_delta_base64_bytes
                ),
            );
        }
        pending_audio_buffer.clear();
        pending_audio_delta_count = 0;
        pending_audio_delta_base64_bytes = 0;
        pending_audio_response_id = None;
        pending_audio_stream_aborted = false;
        OmniAudioOutputState {
            pending_audio_delta_count,
            pending_audio_delta_base64_bytes,
            pending_audio_response_id,
            pending_audio_buffer,
            pending_audio_stream_cue_id,
            pending_audio_stream_chunk_index,
            pending_audio_stream_created_at_ms,
            pending_audio_stream_aborted,
        }
    }

    pub(super) fn process_transcript_delta<R: tauri::Runtime>(
        state: OmniSubtitleEventState,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        direction: &str,
        evt: &Value,
        event_type: &str,
        subtitle_translate_active: bool,
        native_translation_reuse_active: bool,
    ) -> OmniSubtitleEventState {
        let OmniSubtitleEventState {
            current_cue_id,
            pending_source_text,
            mut pending_translated_text,
            mut st_skip_logged,
            mut event_diagnostics,
        } = state;
        let delta = if matches!(
            event_type,
            "response.audio_transcript.text"
                | "response.output_audio_transcript.text"
                | "response.output_text.text"
                | "response.transcript.text"
                | "response.text.text"
        ) {
            let text = evt["text"].as_str().unwrap_or("");
            let stash = evt["stash"].as_str().unwrap_or("");
            pending_translated_text = format!("{text}{stash}");
            pending_translated_text.as_str()
        } else {
            let delta = evt["delta"].as_str().unwrap_or("");
            pending_translated_text.push_str(delta);
            delta
        };
        event_diagnostics.claim_native_response_owner_for_response(
            native_response_id_from_event(evt),
            current_cue_id.as_deref(),
        );
        // In secondary subtitle mode the native realtime response is only a
        // control-plane transcript; the subtitle worker owns the visible
        // translation and publication. Do not record the native text as an
        // unpublished model output, otherwise every successful secondary cue
        // is reported as `model-output-not-published`.
        if !subtitle_translate_active || native_translation_reuse_active {
            if let Some(cue_id) = event_diagnostics
                .native_response_cue_id
                .as_deref()
                .or(current_cue_id.as_deref())
            {
                store.watch_session_report.push_output_delta_for_cue(
                    cue_id,
                    event_type,
                    delta,
                    "",
                );
            } else {
                store
                    .watch_session_report
                    .push_output_delta(event_type, delta, "");
            }
        }
        let response_source_text = resolve_native_response_source_text(
            store,
            event_diagnostics.native_response_cue_id.as_deref(),
            current_cue_id.as_deref(),
            &pending_source_text,
        );
        if native_translation_reuse_active {
            let cue_id = ensure_transcription_cue_id(
                direction,
                &mut event_diagnostics.native_response_cue_id,
            );
            if event_diagnostics.current_cue_origin.is_none() {
                event_diagnostics.current_cue_origin =
                    Some("native_audio_transcript_delta".to_string());
            }
            write_native_translation_to_cue(
                &store,
                &cue_id,
                &response_source_text,
                &pending_translated_text,
                false,
                true,
            );
            if !st_skip_logged {
                st_skip_logged = true;
                let _ = diag_log(
                    &app,
                    "omni",
                    "info",
                    format!(
                        "[TRANS_NATIVE_PREVIEW] subtitle_translate_active=true livetranslate=true using native response.audio_transcript for low-latency subtitle cue_id={cue_id}"
                    ),
                );
            }
        } else if subtitle_translate_active {
            if !st_skip_logged {
                st_skip_logged = true;
                let cue_id_str = event_diagnostics
                    .native_response_cue_id
                    .as_deref()
                    .unwrap_or("(none)");
                let _ = diag_log(
                    &app,
                    "omni",
                    "info",
                    format!(
                        "[TRANS] subtitle_translate_active=true livetranslate=false skip native response.audio_transcript cue_id={cue_id_str}"
                    ),
                );
            }
        } else {
            write_native_output_preview_to_cue(
                store,
                direction,
                &mut event_diagnostics.native_response_cue_id,
                &response_source_text,
                &pending_translated_text,
            );
        }
        let cue_id_str = event_diagnostics
            .native_response_cue_id
            .as_deref()
            .unwrap_or("(none)");
        let _ = diag_log(
            &app,
            "omni",
            "trace",
            format!(
                "[EVENT] {event_type} → cue_id={cue_id_str} delta=\"{delta}\" total_len={}",
                pending_translated_text.len()
            ),
        );
        OmniSubtitleEventState {
            current_cue_id,
            pending_source_text,
            pending_translated_text,
            st_skip_logged,
            event_diagnostics,
        }
    }

    pub(super) fn process_transcript_done<R: tauri::Runtime>(
        state: OmniSubtitleEventState,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        direction: &str,
        evt: &Value,
        event_type: &str,
        session_started_at: &SystemTime,
        subtitle_translate_active: bool,
        native_translation_reuse_active: bool,
    ) -> OmniSubtitleEventState {
        let OmniSubtitleEventState {
            current_cue_id,
            pending_source_text,
            mut pending_translated_text,
            st_skip_logged,
            mut event_diagnostics,
        } = state;
        let transcript = extract_response_done_text(evt);
        if !transcript.is_empty() {
            pending_translated_text = transcript;
        }
        event_diagnostics.last_output_done_text =
            pending_translated_text.clone();
        event_diagnostics.last_output_done_at_ms =
            Some(elapsed_ms_since(&session_started_at));
        event_diagnostics.claim_native_response_owner_for_response(
            native_response_id_from_event(evt),
            current_cue_id.as_deref(),
        );
        if !subtitle_translate_active || native_translation_reuse_active {
            if let Some(cue_id) = event_diagnostics
                .native_response_cue_id
                .as_deref()
                .or(current_cue_id.as_deref())
            {
                store.watch_session_report.push_output_delta_for_cue(
                    cue_id,
                    event_type,
                    "",
                    &pending_translated_text,
                );
            } else {
                store.watch_session_report.push_output_delta(
                    event_type,
                    "",
                    &pending_translated_text,
                );
            }
        }
        let response_source_text = resolve_native_response_source_text(
            store,
            event_diagnostics.native_response_cue_id.as_deref(),
            current_cue_id.as_deref(),
            &pending_source_text,
        );
        if native_translation_reuse_active
            && !pending_translated_text.trim().is_empty()
        {
            let cue_id = ensure_transcription_cue_id(
                direction,
                &mut event_diagnostics.native_response_cue_id,
            );
            if event_diagnostics.current_cue_origin.is_none() {
                event_diagnostics.current_cue_origin =
                    Some("native_audio_transcript_done".to_string());
            }
            write_native_translation_to_cue(
                &store,
                &cue_id,
                &response_source_text,
                &pending_translated_text,
                false,
                false,
            );
            let _ = diag_log(
                &app,
                "omni",
                "info",
                format!(
                    "[TRANS_NATIVE_FINAL] subtitle_translate_active=true livetranslate=true native transcript ready for subtitle-tts cue_id={cue_id} translated_len={}",
                    pending_translated_text.len()
                ),
            );
        } else if !subtitle_translate_active && !pending_translated_text.trim().is_empty() {
            let cue_id = write_native_output_final_to_cue(
                store,
                direction,
                &mut event_diagnostics.native_response_cue_id,
                &response_source_text,
                &pending_translated_text,
            );
            if event_diagnostics.current_cue_origin.is_none() {
                event_diagnostics.current_cue_origin =
                    Some("native_audio_transcript_done".to_string());
            }
            let _ = diag_log(
                &app,
                "omni",
                "debug",
                format!(
                    "[TRANS_NATIVE_FINAL] native transcript display segments finalized cue_id={cue_id} translated_len={}",
                    pending_translated_text.len()
                ),
            );
        }
        let cue_id_str = event_diagnostics
            .native_response_cue_id
            .as_deref()
            .unwrap_or("(none)");
        let _ = diag_log(
            &app,
            "omni",
            "debug",
            format!(
                "[EVENT] {event_type} → cue_id={cue_id_str} transcript=\"{}\"",
                pending_translated_text
            ),
        );
        OmniSubtitleEventState {
            current_cue_id,
            pending_source_text,
            pending_translated_text,
            st_skip_logged,
            event_diagnostics,
        }
    }
}

#[cfg(test)]
mod audio_done_tests {
    use super::*;
    use serde_json::json;
    use tauri::Manager;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        app
    }

    fn buffered_audio() -> OmniAudioOutputState {
        OmniAudioOutputState {
            pending_audio_delta_count: 1,
            pending_audio_delta_base64_bytes: 8,
            pending_audio_response_id: Some("resp-audio".to_string()),
            pending_audio_buffer: vec![1, -1, 2, -2],
            pending_audio_stream_cue_id: None,
            pending_audio_stream_chunk_index: 0,
            pending_audio_stream_created_at_ms: None,
            pending_audio_stream_aborted: false,
        }
    }

    #[test]
    fn native_audio_done_uses_the_actual_subtitle_cue_id() {
        let app = app();
        let queue = OmniPlaybackQueue::new(2);

        let state = OmniEventProcessor::process_audio_done(
            buffered_audio(),
            &app.handle().clone(),
            &queue,
            Some("omni-cue-inbound-actual"),
            "inbound",
        );

        assert!(state.pending_audio_buffer.is_empty());
        assert_eq!(queue.pending_cue_ids(), ["omni-cue-inbound-actual"]);
    }

    #[test]
    fn native_audio_without_a_subtitle_owner_is_rejected_instead_of_fabricating_a_cue() {
        let app = app();
        let handle = app.handle().clone();
        let store = handle.state::<AudioStateStore>();
        store
            .watch_session_report
            .begin_or_reuse("test", "native-audio-cue-owner");
        let queue = OmniPlaybackQueue::new(2);

        let state = OmniEventProcessor::process_audio_done(
            buffered_audio(),
            &handle,
            &queue,
            None,
            "inbound",
        );

        assert!(state.pending_audio_buffer.is_empty());
        assert!(queue.pending_cue_ids().is_empty());
        let report = store.watch_session_report.snapshot().expect("watch report");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "native-playback-missing-cue"));
    }

    #[test]
    fn subtitle_native_output_stays_with_response_owner_when_next_asr_cue_opens() {
        let app = app();
        let handle = app.handle().clone();
        let store = handle.state::<AudioStateStore>();
        store
            .watch_session_report
            .begin_or_reuse("test", "subtitle-response-owner");
        store
            .watch_session_report
            .record_source("cue-original", "inbound", "authoritative source", true);
        store
            .watch_session_report
            .record_source("cue-next", "inbound", "next hypothesis", false);

        let mut event_diagnostics = OmniEventDiagnostics::default();
        event_diagnostics.capture_native_response_owner(
            "cue-original".to_string(),
            Some("item-original".to_string()),
        );
        let delta = OmniEventProcessor::process_transcript_delta(
            OmniSubtitleEventState {
                current_cue_id: Some("cue-next".to_string()),
                pending_source_text: "next hypothesis".to_string(),
                pending_translated_text: String::new(),
                st_skip_logged: false,
                event_diagnostics,
            },
            &handle,
            &store,
            "inbound",
            &json!({
                "type": "response.output_text.delta",
                "response_id": "resp-original",
                "delta": "译文"
            }),
            "response.output_text.delta",
            true,
            false,
        );
        let done = OmniEventProcessor::process_transcript_done(
            delta,
            &handle,
            &store,
            "inbound",
            &json!({
                "type": "response.output_text.done",
                "response": {
                    "id": "resp-original",
                    "status": "completed",
                    "output": [{"content": [{"text": "译文"}]}]
                }
            }),
            "response.output_text.done",
            &SystemTime::now(),
            true,
            false,
        );

        assert_eq!(done.event_diagnostics.native_response_cue_id.as_deref(), Some("cue-original"));
        let report = store.watch_session_report.snapshot().expect("watch report");
        let original = report.cues.iter().find(|cue| cue.cue_id == "cue-original").expect("owner cue");
        let next = report.cues.iter().find(|cue| cue.cue_id == "cue-next").expect("next cue");
        assert!(original.llm_text.is_empty(), "secondary subtitle mode must not publish native response text");
        assert!(
            original.events.iter().all(|event| event.stage != "model"),
            "secondary subtitle mode must leave native response output to the subtitle worker"
        );
        assert!(next.llm_text.is_empty(), "next ASR cue must not receive prior response output");
    }
}
