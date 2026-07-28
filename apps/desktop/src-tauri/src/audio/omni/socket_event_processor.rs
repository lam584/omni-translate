use super::*;

pub(super) struct OmniSocketEventState<S: RealtimeSocket, R: tauri::Runtime = tauri::Wry> {
    pub(super) socket: S,
    pub(super) trace_call: crate::diagnostics::model_trace::ModelTraceCall<R>,
    pub(super) reconnect_count: usize,
    pub(super) pending_audio_buffer: Vec<i16>,
    pub(super) active_voice: String,
    pub(super) voice_fallback_applied: bool,
    pub(super) session_ready_for_audio: bool,
    pub(super) event_diagnostics: OmniEventDiagnostics,
    pub(super) current_cue_id: Option<String>,
    pub(super) pending_source_text: String,
    pub(super) pending_translated_text: String,
    pub(super) st_skip_logged: bool,
    pub(super) pending_audio_delta_count: u64,
    pub(super) pending_audio_delta_base64_bytes: u64,
    pub(super) pending_audio_response_id: Option<String>,
    pub(super) last_vad_event_time: SystemTime,
    pub(super) vad_event_count: u64,
    pub(super) transcription_completed_flag: bool,
    pub(super) transcription_completed_at: Option<SystemTime>,
    pub(super) manual_response_pending: bool,
    pub(super) manual_response_item_id: Option<String>,
}

pub(super) struct OmniSocketEventContext<'a, R: tauri::Runtime = tauri::Wry> {
    pub(super) app: &'a AppHandle<R>,
    pub(super) store: &'a AudioStateStore,
    pub(super) direction: &'a str,
    pub(super) session_generation: u64,
    pub(super) session_started_at: &'a SystemTime,
    pub(super) subtitle_translate_active: bool,
    pub(super) native_translation_reuse_active: bool,
    pub(super) total_input_chunks: u64,
    pub(super) first_audio_sent_ms: Option<u64>,
    pub(super) first_audible_chunk_ms: Option<u64>,
    pub(super) chunk_count: u64,
    pub(super) total_silence_skipped_before_first_audible: u64,
    pub(super) playback_tx: &'a mpsc::SyncSender<OmniPlaybackCommand>,
    pub(super) readiness_sent: &'a AtomicBool,
    pub(super) readiness_tx: &'a mpsc::Sender<Result<u64, String>>,
    pub(super) provider: &'a ProviderDraftInput,
    pub(super) instructions: &'a str,
    pub(super) audio_mode: RealtimeAudioMode,
    pub(super) target_language: &'a str,
    pub(super) buffer_size: u64,
    pub(super) pre_session_audio_queue_len: usize,
    pub(super) pre_session_audio_dropped: u64,
    pub(super) echo_guard_enabled: bool,
}

pub(super) struct OmniSocketPollResult<S: RealtimeSocket, R: tauri::Runtime = tauri::Wry> {
    pub(super) state: OmniSocketEventState<S, R>,
    pub(super) skip_tick: bool,
    /// The socket was replaced by a reconnect during this poll. The provider
    /// session and its input buffer are gone, so the worker must reset the
    /// manual response gate and the commit timer.
    pub(super) socket_reconnected: bool,
}

pub(super) struct OmniSocketEventProcessor;

impl OmniSocketEventProcessor {
    pub(super) fn poll<C: RealtimeSocketConnector, R: tauri::Runtime>(
        state: OmniSocketEventState<C::Socket, R>,
        context: OmniSocketEventContext<'_, R>,
        connector: &C,
    ) -> Result<OmniSocketPollResult<C::Socket, R>, String> {
        let OmniSocketEventState { mut socket, mut trace_call, mut reconnect_count, mut pending_audio_buffer, mut active_voice, mut voice_fallback_applied, mut session_ready_for_audio, mut event_diagnostics, mut current_cue_id, mut pending_source_text, mut pending_translated_text, mut st_skip_logged, mut pending_audio_delta_count, mut pending_audio_delta_base64_bytes, mut pending_audio_response_id, mut last_vad_event_time, mut vad_event_count, mut transcription_completed_flag, mut transcription_completed_at, mut manual_response_pending, mut manual_response_item_id } = state;
        let OmniSocketEventContext {
            app, store, direction, session_generation, session_started_at,
            subtitle_translate_active, native_translation_reuse_active,
            total_input_chunks, first_audio_sent_ms, first_audible_chunk_ms,
            chunk_count, total_silence_skipped_before_first_audible, playback_tx,
            readiness_sent, readiness_tx, provider, instructions, audio_mode,
            target_language, buffer_size, pre_session_audio_queue_len,
            pre_session_audio_dropped, echo_guard_enabled,
        } = context;
let mut socket_reconnected = false;
match socket.read_message() {
    Ok(msg) => match msg {
        Message::Text(text) => {
            if let Ok(evt) = serde_json::from_str::<Value>(&text) {
                let event_type = evt["type"].as_str().unwrap_or("(unknown)");
                trace_call.record_ws_recv(event_type, evt.clone());
                match event_type {
                    "session.created" | "session.updated" => {
                        let readiness = OmniEventProcessor::process_session_ready(
                            OmniReadinessState {
                                session_ready_for_audio,
                                event_diagnostics,
                            },
                            &app,
                            store,
                            &direction,
                            session_generation,
                            &session_started_at,
                            event_type,
                            &evt,
                                    pre_session_audio_queue_len,
                            pre_session_audio_dropped,
                            &readiness_sent,
                            &readiness_tx,
                        );
                        session_ready_for_audio = readiness.session_ready_for_audio;
                        event_diagnostics = readiness.event_diagnostics;
                    }
                    "input_audio_buffer.committed" => {
                        if audio_mode.uses_manual_commit() {
                            let committed_item_id = evt["item_id"]
                                .as_str()
                                .filter(|item_id| !item_id.trim().is_empty());
                            if manual_response_pending
                                && manual_response_item_id.is_none()
                                && committed_item_id.is_some()
                            {
                                manual_response_item_id = committed_item_id.map(str::to_owned);
                                let _ = diag_log(
                                    app,
                                    "omni",
                                    "debug",
                                    format!(
                                        "event=manual_response_gate state=commit_correlated itemId={}",
                                        committed_item_id.unwrap_or_default()
                                    ),
                                );
                            } else {
                                let _ = diag_log(
                                    app,
                                    "omni",
                                    "warning",
                                    format!(
                                        "event=manual_response_gate action=ignore_commit_ack pending={} expectedItemId={} receivedItemId={}",
                                        manual_response_pending,
                                        manual_response_item_id.as_deref().unwrap_or("(none)"),
                                        committed_item_id.unwrap_or("(none)"),
                                    ),
                                );
                            }
                        }
                    }
                    event_type if matches!(
                        event_type,
                        "input_audio_buffer.speech_started"
                            | "conversation.item.input_audio_transcription.delta"
                            | "conversation.item.input_audio_transcription.text"
                            | "conversation.item.input_audio_transcription.completed"
                    ) => {
                        if audio_mode.uses_manual_commit()
                            && event_type
                                == "conversation.item.input_audio_transcription.completed"
                        {
                            let completed_item_id = evt["item_id"]
                                .as_str()
                                .filter(|item_id| !item_id.trim().is_empty());
                            if !manual_response_pending
                                || manual_response_item_id.as_deref() != completed_item_id
                            {
                                if should_route_uncorrelated_completed_transcription(
                                    evt["transcript"].as_str(),
                                ) {
                                    // The gate timed out (or reset), but this
                                    // completed item still carries the tail of
                                    // the user's turn. Fall through so the ASR
                                    // processor completes the display cue; the
                                    // mismatched gate below never arms
                                    // response.create for it.
                                    let _ = diag_log(
                                        app,
                                        "omni",
                                        "info",
                                        format!(
                                            "event=manual_response_gate action=route_late_transcription reason=item_id_mismatch pending={} expectedItemId={} receivedItemId={}",
                                            manual_response_pending,
                                            manual_response_item_id.as_deref().unwrap_or("(none)"),
                                            completed_item_id.unwrap_or("(none)"),
                                        ),
                                    );
                                } else {
                                    let _ = diag_log(
                                        app,
                                        "omni",
                                        "warning",
                                        format!(
                                            "event=manual_response_gate action=ignore_transcription reason=item_id_mismatch pending={} expectedItemId={} receivedItemId={}",
                                            manual_response_pending,
                                            manual_response_item_id.as_deref().unwrap_or("(none)"),
                                            completed_item_id.unwrap_or("(none)"),
                                        ),
                                    );
                                    return Ok(OmniSocketPollResult { state: OmniSocketEventState { socket, trace_call, reconnect_count, pending_audio_buffer, active_voice, voice_fallback_applied, session_ready_for_audio, event_diagnostics, current_cue_id, pending_source_text, pending_translated_text, st_skip_logged, pending_audio_delta_count, pending_audio_delta_base64_bytes, pending_audio_response_id, last_vad_event_time, vad_event_count, transcription_completed_flag, transcription_completed_at, manual_response_pending, manual_response_item_id }, skip_tick: true, socket_reconnected });
                                }
                            }
                        }
                        let output = OmniAsrEventProcessor::process(
                            OmniAsrEventState {
                                last_vad_event_time,
                                vad_event_count,
                                current_cue_id,
                                pending_source_text,
                                pending_translated_text,
                                pending_audio_buffer,
                                transcription_completed_flag,
                                transcription_completed_at,
                                event_diagnostics,
                            },
                            &app,
                            store,
                            &direction,
                            &evt,
                            event_type,
                            &session_started_at,
                            subtitle_translate_active,
                            native_translation_reuse_active,
                            audio_mode.uses_manual_commit()
                                && subtitle_translate_active
                                && !native_translation_reuse_active,
                            total_input_chunks,
                            first_audio_sent_ms,
                            first_audible_chunk_ms,
                            chunk_count,
                            total_silence_skipped_before_first_audible,
                        );
                        last_vad_event_time = output.state.last_vad_event_time;
                        vad_event_count = output.state.vad_event_count;
                        current_cue_id = output.state.current_cue_id;
                        pending_source_text = output.state.pending_source_text;
                        pending_translated_text = output.state.pending_translated_text;
                        pending_audio_buffer = output.state.pending_audio_buffer;
                        transcription_completed_flag = output.state.transcription_completed_flag;
                        transcription_completed_at = output.state.transcription_completed_at;
                        event_diagnostics = output.state.event_diagnostics;
                        if audio_mode.uses_manual_commit() {
                            let completed_source_text = output.completed_source_text.as_deref();
                            let completed_cue_id = output.completed_cue_id.as_deref();
                            let now_ms = elapsed_ms_since(session_started_at);
                            let recent_output_age_ms = event_diagnostics
                                .last_output_done_at_ms
                                .map(|timestamp| now_ms.saturating_sub(timestamp));
                            let echo_activity = store
                                .recent_echo_suppression(MANUAL_ECHO_ACTIVITY_WINDOW);
                            let echo_dominated_input = recent_echo_input_is_dominated(
                                echo_activity.total_chunks,
                                echo_activity.suppressed_chunks,
                            );
                            if let Some(decision) = classify_completed_manual_response(
                                manual_response_pending,
                                manual_response_item_id.as_deref(),
                                evt["item_id"].as_str(),
                                completed_source_text,
                                &event_diagnostics.last_output_done_text,
                                recent_output_age_ms,
                                echo_guard_enabled,
                                echo_dominated_input,
                            ) {
                                let source = completed_source_text.unwrap_or_default();
                                let mut reset_turn = matches!(
                                    decision,
                                    ManualResponseDecision::SkipEmpty
                                        | ManualResponseDecision::SkipRecentOutputEcho
                                        | ManualResponseDecision::SkipEchoDominatedPlayback
                                );
                                match decision {
                                    ManualResponseDecision::Create => {
                                        let create_msg = json!({ "type": "response.create" });
                                        trace_call.record_ws_send(
                                            "response.create",
                                            create_msg.clone(),
                                        );
                                        if let Err(error) = socket.send_message(Message::Text(
                                            create_msg.to_string().into(),
                                        )) {
                                            let _ = diag_log(
                                                app,
                                                "omni",
                                                "warning",
                                                format!(
                                                    "event=manual_response_gate action=create_failed error={error}"
                                                ),
                                            );
                                            reset_turn = true;
                                        } else {
                                            if let Some(cue_id) = completed_cue_id {
                                                store.approve_subtitle_cue_translation(cue_id);
                                            }
                                            let _ = diag_log(
                                                app,
                                                "omni",
                                                "info",
                                                format!(
                                                    "event=manual_response_gate action=create sourceLen={}",
                                                    source.chars().count()
                                                ),
                                            );
                                        }
                                    }
                                    ManualResponseDecision::SkipEmpty => {
                                        let _ = diag_log(
                                            app,
                                            "omni",
                                            "info",
                                            "event=manual_response_gate action=skip reason=empty_transcription",
                                        );
                                    }
                                    ManualResponseDecision::SkipRecentOutputEcho => {
                                        let _ = diag_log(
                                            app,
                                            "omni",
                                            "warning",
                                            format!(
                                                "event=manual_response_gate action=skip reason=recent_output_echo sourceLen={} outputAgeMs={}",
                                                source.chars().count(),
                                                recent_output_age_ms.unwrap_or(u64::MAX),
                                            ),
                                        );
                                    }
                                    ManualResponseDecision::SkipEchoDominatedPlayback => {
                                        let _ = diag_log(
                                            app,
                                            "omni",
                                            "warning",
                                            format!(
                                                "event=manual_response_gate action=skip reason=echo_dominated_playback sourceLen={} outputAgeMs={} echoChunks={} suppressedChunks={}",
                                                source.chars().count(),
                                                recent_output_age_ms.unwrap_or(u64::MAX),
                                                echo_activity.total_chunks,
                                                echo_activity.suppressed_chunks,
                                            ),
                                        );
                                    }
                                }
                                if reset_turn {
                                    // A skipped turn never issued response.create, so any
                                    // buffered output audio/text belongs to the previous
                                    // turn's still-streaming response. Only the gate and
                                    // the skipped turn's input state may be reset here;
                                    // output state resets at response.done / audio.done.
                                    let response_stream_active =
                                        manual_turn_response_stream_active(
                                            pending_audio_delta_count,
                                            pending_audio_buffer.len(),
                                            pending_audio_response_id.as_deref(),
                                            &pending_translated_text,
                                        );
                                    if response_stream_owns_current_cue(
                                        response_stream_active,
                                        subtitle_translate_active,
                                        native_translation_reuse_active,
                                    ) {
                                        let _ = diag_log(
                                            app,
                                            "omni",
                                            "debug",
                                            "event=manual_response_gate action=keep_streaming_response_state",
                                        );
                                    } else {
                                        if let Some(cue_id) = manual_turn_cue_to_discard(
                                            completed_cue_id,
                                            current_cue_id.as_deref(),
                                        ) {
                                            store.discard_uncommitted_subtitle_cue(cue_id);
                                        }
                                        reset_manual_turn_input_state(
                                            &mut current_cue_id,
                                            &mut pending_source_text,
                                            &mut transcription_completed_flag,
                                            &mut transcription_completed_at,
                                            &mut event_diagnostics,
                                        );
                                    }
                                }
                                manual_response_pending = false;
                                manual_response_item_id = None;
                            }
                        }
                        if output.skip_tick {
                            return Ok(OmniSocketPollResult { state: OmniSocketEventState { socket, trace_call, reconnect_count, pending_audio_buffer, active_voice, voice_fallback_applied, session_ready_for_audio, event_diagnostics, current_cue_id, pending_source_text, pending_translated_text, st_skip_logged, pending_audio_delta_count, pending_audio_delta_base64_bytes, pending_audio_response_id, last_vad_event_time, vad_event_count, transcription_completed_flag, transcription_completed_at, manual_response_pending, manual_response_item_id }, skip_tick: true, socket_reconnected });
                        }
                    }
                    "response.audio_transcript.delta"
                    | "response.audio_transcript.text" => {
                        let output = OmniEventProcessor::process_transcript_delta(
                            OmniSubtitleEventState {
                                current_cue_id,
                                pending_source_text,
                                pending_translated_text,
                                st_skip_logged,
                                event_diagnostics,
                            },
                            &app,
                            store,
                            &direction,
                            &evt,
                            event_type,
                            subtitle_translate_active,
                            native_translation_reuse_active,
                        );
                        current_cue_id = output.current_cue_id;
                        pending_source_text = output.pending_source_text;
                        pending_translated_text = output.pending_translated_text;
                        st_skip_logged = output.st_skip_logged;
                        event_diagnostics = output.event_diagnostics;
                    }
                    "response.audio_transcript.done" => {
                        let output = OmniEventProcessor::process_transcript_done(
                            OmniSubtitleEventState {
                                current_cue_id,
                                pending_source_text,
                                pending_translated_text,
                                st_skip_logged,
                                event_diagnostics,
                            },
                            &app,
                            store,
                            &direction,
                            &evt,
                            &session_started_at,
                            subtitle_translate_active,
                            native_translation_reuse_active,
                        );
                        current_cue_id = output.current_cue_id;
                        pending_source_text = output.pending_source_text;
                        pending_translated_text = output.pending_translated_text;
                        st_skip_logged = output.st_skip_logged;
                        event_diagnostics = output.event_diagnostics;
                    }
                    "response.audio.delta" => {
                        let output = OmniEventProcessor::process_audio_delta(
                            OmniAudioOutputState {
                                pending_audio_delta_count,
                                pending_audio_delta_base64_bytes,
                                pending_audio_response_id,
                                pending_audio_buffer,
                            },
                            &app,
                            &evt,
                        );
                        pending_audio_delta_count = output.pending_audio_delta_count;
                        pending_audio_delta_base64_bytes = output.pending_audio_delta_base64_bytes;
                        pending_audio_response_id = output.pending_audio_response_id;
                        pending_audio_buffer = output.pending_audio_buffer;
                    }
                    "response.audio.done" => {
                        let output = OmniEventProcessor::process_audio_done(
                            OmniAudioOutputState {
                                pending_audio_delta_count,
                                pending_audio_delta_base64_bytes,
                                pending_audio_response_id,
                                pending_audio_buffer,
                            },
                            &app,
                            &playback_tx,
                        );
                        pending_audio_delta_count = output.pending_audio_delta_count;
                        pending_audio_delta_base64_bytes = output.pending_audio_delta_base64_bytes;
                        pending_audio_response_id = output.pending_audio_response_id;
                        pending_audio_buffer = output.pending_audio_buffer;
                    }
                    "input_audio_buffer.speech_stopped" => {
                        last_vad_event_time = SystemTime::now();
                        vad_event_count += 1;
                        let _ = diag_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[VAD] speech_stopped received (VAD 浜嬩欢璁℃暟={vad_event_count})"
                            ),
                        );
                    }
                    "response.done" => {
                        handle_response_done(
                            &app,
                            store,
                            &mut trace_call,
                            &direction,
                            &mut current_cue_id,
                            &mut pending_source_text,
                            &mut pending_translated_text,
                            subtitle_translate_active,
                            native_translation_reuse_active,
                            &mut transcription_completed_flag,
                            &mut transcription_completed_at,
                            &mut event_diagnostics,
                            &session_started_at,
                        );
                        store.live_session_events.push_output_delta(
                            "response.done",
                            "",
                            "",
                        );
                    }
                    "error" => {
                        let reconnect_state = OmniConnectionCoordinator::handle_provider_error(
                            OmniReconnectState {
                                socket,
                                reconnect_count,
                                pending_audio_buffer,
                                active_voice,
                                voice_fallback_applied,
                                socket_reconnected: false,
                            },
                            connector,
                            &app,
                            store,
                            &provider,
                            &instructions,
                            audio_mode,
                            &target_language,
                            buffer_size,
                            &mut trace_call,
                            &evt,
                            &text,
                        )?;
                        socket = reconnect_state.socket;
                        reconnect_count = reconnect_state.reconnect_count;
                        pending_audio_buffer = reconnect_state.pending_audio_buffer;
                        active_voice = reconnect_state.active_voice;
                        voice_fallback_applied = reconnect_state.voice_fallback_applied;
                        socket_reconnected = reconnect_state.socket_reconnected;
                    }
                    other => {
                        OmniEventProcessor::log_unknown_event(&app, other, &text);
                    }
                }
            } else {
                let _ = diag_log(
                    &app,
                    "omni",
                    "warning",
                    format!("[EVENT] JSON 瑙ｆ瀽澶辫触: {text}"),
                );
            }
        }
        Message::Close(_) => {
            let reconnect_state = OmniConnectionCoordinator::reconnect_after_close(
                OmniReconnectState {
                    socket,
                    reconnect_count,
                    pending_audio_buffer,
                    active_voice,
                    voice_fallback_applied,
                    socket_reconnected: false,
                },
                connector,
                &app,
                store,
                &provider,
                &instructions,
                audio_mode,
                &target_language,
                buffer_size,
            )?;
            socket = reconnect_state.socket;
            reconnect_count = reconnect_state.reconnect_count;
            pending_audio_buffer = reconnect_state.pending_audio_buffer;
            active_voice = reconnect_state.active_voice;
            voice_fallback_applied = reconnect_state.voice_fallback_applied;
            socket_reconnected = reconnect_state.socket_reconnected;
            return Ok(OmniSocketPollResult { state: OmniSocketEventState { socket, trace_call, reconnect_count, pending_audio_buffer, active_voice, voice_fallback_applied, session_ready_for_audio, event_diagnostics, current_cue_id, pending_source_text, pending_translated_text, st_skip_logged, pending_audio_delta_count, pending_audio_delta_base64_bytes, pending_audio_response_id, last_vad_event_time, vad_event_count, transcription_completed_flag, transcription_completed_at, manual_response_pending, manual_response_item_id }, skip_tick: true, socket_reconnected });
        }
        _ => {}
    },
    Err(error) => {
        let reconnect_state = OmniConnectionCoordinator::recover_read_error(
            OmniReconnectState {
                socket,
                reconnect_count,
                pending_audio_buffer,
                active_voice,
                voice_fallback_applied,
                socket_reconnected: false,
            },
            connector,
            &app,
            store,
            &provider,
            &instructions,
            audio_mode,
            &target_language,
            buffer_size,
            error,
        )?;
        socket = reconnect_state.socket;
        reconnect_count = reconnect_state.reconnect_count;
        pending_audio_buffer = reconnect_state.pending_audio_buffer;
        active_voice = reconnect_state.active_voice;
        voice_fallback_applied = reconnect_state.voice_fallback_applied;
        socket_reconnected = reconnect_state.socket_reconnected;
        return Ok(OmniSocketPollResult { state: OmniSocketEventState { socket, trace_call, reconnect_count, pending_audio_buffer, active_voice, voice_fallback_applied, session_ready_for_audio, event_diagnostics, current_cue_id, pending_source_text, pending_translated_text, st_skip_logged, pending_audio_delta_count, pending_audio_delta_base64_bytes, pending_audio_response_id, last_vad_event_time, vad_event_count, transcription_completed_flag, transcription_completed_at, manual_response_pending, manual_response_item_id }, skip_tick: true, socket_reconnected });
    }
}

        Ok(OmniSocketPollResult { state: OmniSocketEventState { socket, trace_call, reconnect_count, pending_audio_buffer, active_voice, voice_fallback_applied, session_ready_for_audio, event_diagnostics, current_cue_id, pending_source_text, pending_translated_text, st_skip_logged, pending_audio_delta_count, pending_audio_delta_base64_bytes, pending_audio_response_id, last_vad_event_time, vad_event_count, transcription_completed_flag, transcription_completed_at, manual_response_pending, manual_response_item_id }, skip_tick: false, socket_reconnected })
    }
}
