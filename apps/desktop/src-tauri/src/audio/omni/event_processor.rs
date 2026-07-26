use super::*;

pub(super) struct OmniAudioOutputState {
    pub(super) pending_audio_delta_count: u64,
    pub(super) pending_audio_delta_base64_bytes: u64,
    pub(super) pending_audio_response_id: Option<String>,
    pub(super) pending_audio_buffer: Vec<i16>,
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
    pub(super) fn process_session_ready(
        mut state: OmniReadinessState,
        app: &AppHandle,
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
            store.live_session_events.record_milestone(
                "session_ready",
                elapsed_ms_since(session_started_at),
            );
            store
                .live_session_events
                .record_session_ready(queued_audio_chunks as u64, dropped_audio_chunks);
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

    pub(super) fn log_unknown_event(app: &AppHandle, event_type: &str, raw_text: &str) {
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

    pub(super) fn expire_stale_transcription(
        app: &AppHandle,
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

    pub(super) fn process_audio_delta(
        state: OmniAudioOutputState,
        app: &AppHandle,
        evt: &Value,
    ) -> OmniAudioOutputState {
        let OmniAudioOutputState {
            mut pending_audio_delta_count,
            mut pending_audio_delta_base64_bytes,
            mut pending_audio_response_id,
            mut pending_audio_buffer,
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
                    pending_audio_buffer.extend_from_slice(&samples);
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
        }
    }

    pub(super) fn process_audio_done(
        state: OmniAudioOutputState,
        app: &AppHandle,
        playback_tx: &mpsc::SyncSender<OmniPlaybackCommand>,
    ) -> OmniAudioOutputState {
        let OmniAudioOutputState {
            mut pending_audio_delta_count,
            mut pending_audio_delta_base64_bytes,
            mut pending_audio_response_id,
            mut pending_audio_buffer,
        } = state;
        if !pending_audio_buffer.is_empty() {
            let cue_id = format!("omni-audio-{}", unix_ms());
            let sample_count = pending_audio_buffer.len();
            let duration_ms = ((sample_count as u64) * 1000)
                .saturating_div(OMNI_OUTPUT_SAMPLE_RATE_HZ as u64);
            let response_id =
                pending_audio_response_id.as_deref().unwrap_or("(none)");
            let enqueue_status = match playback_tx.try_send(OmniPlaybackCommand::Play {
                samples: std::mem::take(&mut pending_audio_buffer),
                cue_id: cue_id.clone(),
                sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
                queued_at: Instant::now(),
            }) {
                Ok(()) => "queued",
                Err(mpsc::TrySendError::Full(_)) => "dropped_queue_full",
                Err(mpsc::TrySendError::Disconnected(_)) => "dropped_disconnected",
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
        OmniAudioOutputState {
            pending_audio_delta_count,
            pending_audio_delta_base64_bytes,
            pending_audio_response_id,
            pending_audio_buffer,
        }
    }

    pub(super) fn process_transcript_delta(
        state: OmniSubtitleEventState,
        app: &AppHandle,
        store: &AudioStateStore,
        evt: &Value,
        event_type: &str,
        subtitle_translate_active: bool,
        native_translation_reuse_active: bool,
    ) -> OmniSubtitleEventState {
        let OmniSubtitleEventState {
            mut current_cue_id,
            pending_source_text,
            mut pending_translated_text,
            mut st_skip_logged,
            mut event_diagnostics,
        } = state;
        let delta = if event_type == "response.audio_transcript.text" {
            let text = evt["text"].as_str().unwrap_or("");
            let stash = evt["stash"].as_str().unwrap_or("");
            pending_translated_text = format!("{text}{stash}");
            pending_translated_text.as_str()
        } else {
            let delta = evt["delta"].as_str().unwrap_or("");
            pending_translated_text.push_str(delta);
            delta
        };
        store
            .live_session_events
            .push_output_delta(event_type, delta, "");
        if native_translation_reuse_active {
            let cue_id = ensure_transcription_cue_id(&mut current_cue_id);
            if event_diagnostics.current_cue_origin.is_none() {
                event_diagnostics.current_cue_origin =
                    Some("native_audio_transcript_delta".to_string());
            }
            write_native_translation_to_cue(
                &store,
                &cue_id,
                &pending_source_text,
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
                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
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
                &mut current_cue_id,
                &pending_source_text,
                &pending_translated_text,
            );
        }
        let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
        let _ = diag_log(
            &app,
            "omni",
            "trace",
            format!(
                "[EVENT] audio_transcript.delta → cue_id={cue_id_str} delta=\"{delta}\" total_len={}",
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

    pub(super) fn process_transcript_done(
        state: OmniSubtitleEventState,
        app: &AppHandle,
        store: &AudioStateStore,
        evt: &Value,
        session_started_at: &SystemTime,
        subtitle_translate_active: bool,
        native_translation_reuse_active: bool,
    ) -> OmniSubtitleEventState {
        let OmniSubtitleEventState {
            mut current_cue_id,
            pending_source_text,
            mut pending_translated_text,
            st_skip_logged,
            mut event_diagnostics,
        } = state;
        let transcript = evt["transcript"].as_str().unwrap_or("");
        if !transcript.is_empty() {
            pending_translated_text = transcript.to_string();
        }
        event_diagnostics.last_output_done_text =
            pending_translated_text.clone();
        event_diagnostics.last_output_done_at_ms =
            Some(elapsed_ms_since(&session_started_at));
        store.live_session_events.push_output_delta(
            "response.audio_transcript.done",
            "",
            &pending_translated_text,
        );
        if native_translation_reuse_active
            && !pending_translated_text.trim().is_empty()
        {
            let cue_id = ensure_transcription_cue_id(&mut current_cue_id);
            if event_diagnostics.current_cue_origin.is_none() {
                event_diagnostics.current_cue_origin =
                    Some("native_audio_transcript_done".to_string());
            }
            write_native_translation_to_cue(
                &store,
                &cue_id,
                &pending_source_text,
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
                &mut current_cue_id,
                &pending_source_text,
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
        let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
        let _ = diag_log(
            &app,
            "omni",
            "debug",
            format!(
                "[EVENT] audio_transcript.done → cue_id={cue_id_str} transcript=\"{}\"",
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
