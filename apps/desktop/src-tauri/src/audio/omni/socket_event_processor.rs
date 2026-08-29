use super::connection_coordinator::{
    is_idle_preconnect_session, is_released_empty_audio_commit_error, provider_error_code, provider_error_message,
};
use super::session_errors::is_provider_idle_timeout_error;
use super::*;
use crate::audio::glossary::GlossaryContext;

#[path = "socket_event_processor/manual_response.rs"]
mod manual_response;
use manual_response::{
    is_rejected_empty_manual_commit, send_manual_response_create, ManualResponseCreateContext,
};
#[path = "socket_event_processor/response_stall.rs"]
mod response_stall;
use response_stall::{
    maintain_response_lifecycle, ResponseStallContext, ResponseStallReconnectState,
};
#[path = "socket_event_processor/state.rs"]
mod state;
pub(super) use state::{OmniSocketEventContext, OmniSocketEventState, OmniSocketPollResult};

pub(super) struct OmniSocketEventProcessor;

#[cfg(test)]
#[path = "socket_event_processor/empty_commit_tests.rs"]
mod empty_commit_tests;

impl OmniSocketEventProcessor {
    pub(super) fn poll<C: RealtimeSocketConnector, R: tauri::Runtime>(
        state: OmniSocketEventState<C::Socket, R>,
        context: OmniSocketEventContext<'_, R>,
        connector: &C,
    ) -> Result<OmniSocketPollResult<C::Socket, R>, String> {
        let OmniSocketEventState {
            mut socket,
            mut trace_call,
            mut reconnect_count,
            mut pending_audio_buffer,
            mut active_voice,
            mut voice_fallback_applied,
            mut session_ready_for_audio,
            mut event_diagnostics,
            mut current_cue_id,
            mut pending_source_text,
            mut pending_translated_text,
            mut st_skip_logged,
            mut pending_audio_delta_count,
            mut pending_audio_delta_base64_bytes,
            mut pending_audio_response_id,
            mut pending_audio_stream_cue_id,
            mut pending_audio_stream_chunk_index,
            mut pending_audio_stream_created_at_ms,
            mut pending_audio_stream_aborted,
            mut last_vad_event_time,
            mut vad_event_count,
            mut transcription_completed_flag,
            mut transcription_completed_at,
            mut manual_response_pending,
            mut manual_response_requested,
            mut manual_response_item_id,
            mut manual_response_released_at,
            sent_audio_since_commit,
            audio_samples_since_commit,
            manual_turn_audio_after_response,
        } = state;
        let OmniSocketEventContext {
            app,
            store,
            direction,
            session_generation,
            session_started_at,
            subtitle_translate_active,
            native_translation_reuse_active,
            total_input_chunks,
            first_audio_sent_ms,
            first_audible_chunk_ms,
            chunk_count,
            total_silence_skipped_before_first_audible,
            playback_tx,
            readiness_sent,
            readiness_tx,
            provider,
            provider_input_budget,
            instructions,
            glossary,
            audio_mode,
            output_mode,
            source_language,
            target_language,
            buffer_size,
            pre_session_audio_queue_len,
            pre_session_audio_dropped,
            echo_guard_enabled,
        } = context;
        event_diagnostics.set_response_ledger_generation(session_generation);
        let mut socket_reconnected = false;
        let mut stop_worker = false;
        // Every poll exit repackages the same 21 worker-state fields into an
        // OmniSocketPollResult; a local macro keeps that field list in one place.
        // Only skip_tick varies: reconnect exits pass true, the per-tick return false.
        macro_rules! poll_result {
            ($skip:expr) => {
                Ok(OmniSocketPollResult {
                    state: OmniSocketEventState {
                        socket,
                        trace_call,
                        reconnect_count,
                        pending_audio_buffer,
                        active_voice,
                        voice_fallback_applied,
                        session_ready_for_audio,
                        event_diagnostics,
                        current_cue_id,
                        pending_source_text,
                        pending_translated_text,
                        st_skip_logged,
                        pending_audio_delta_count,
                        pending_audio_delta_base64_bytes,
                        pending_audio_response_id,
                        pending_audio_stream_cue_id,
                        pending_audio_stream_chunk_index,
                        pending_audio_stream_created_at_ms,
                        pending_audio_stream_aborted,
                        last_vad_event_time,
                        vad_event_count,
                        transcription_completed_flag,
                        transcription_completed_at,
                        manual_response_pending,
                        manual_response_requested,
                        manual_response_item_id,
                        manual_response_released_at,
                        sent_audio_since_commit,
                        audio_samples_since_commit,
                        manual_turn_audio_after_response,
                    },
                    skip_tick: $skip,
                    socket_reconnected,
                    stop_worker,
                })
            };
        }
        match socket.read_message() {
            Ok(msg) => match msg {
        Message::Text(text) => {
            if let Ok(evt) = serde_json::from_str::<Value>(&text) {
                let event_type = crate::audio::realtime_ws::server_event_type(&evt, "(unknown)");
                trace_call.record_ws_recv(event_type, evt.clone());
                match event_type {
                    "response.created" => event_diagnostics.begin_native_response_lifecycle(
                        native_response_id_from_event(&evt),
                    ),
                    response_event
                        if response_event.starts_with("response.")
                            && response_event != "response.done" =>
                    {
                        event_diagnostics.note_native_response_progress(
                            native_response_id_from_event(&evt),
                        );
                    }
                    _ => {}
                }
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
                        let committed_item_id = evt["item_id"]
                            .as_str()
                            .filter(|item_id| !item_id.trim().is_empty());
                        if let (Some(item_id), Some(cue_id)) = (
                            committed_item_id,
                            current_cue_id.clone(),
                        ) {
                            event_diagnostics.record_asr_cue_owner(item_id, cue_id);
                        }
                        if audio_mode.uses_manual_commit() {
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
                        let mut routed_uncorrelated_completed_transcription = false;
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
                                    routed_uncorrelated_completed_transcription = true;
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
                                    return poll_result!(true);
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
                            routed_uncorrelated_completed_transcription,
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
                        let completed_source_text = output.completed_source_text.as_deref();
                        let completed_cue_id = output.completed_cue_id.as_deref();
                        if audio_mode.uses_manual_commit() {
                            if let Some(decision) = completed_manual_response_decision_for_gate(
                                manual_response_pending,
                                manual_response_requested,
                                manual_response_item_id.as_deref(),
                                evt["item_id"].as_str(),
                                completed_source_text,
                            ) {
                                let mut reset_turn = decision == ManualResponseDecision::SkipEmpty;
                                match decision {
                                    ManualResponseDecision::Create => {
                                        manual_response_requested = send_manual_response_create(
                                            &mut socket,
                                            &mut trace_call,
                                            &mut event_diagnostics,
                                            ManualResponseCreateContext {
                                                app,
                                                store,
                                                provider,
                                                source: completed_source_text.unwrap_or_default(),
                                                cue_id: completed_cue_id,
                                                item_id: evt["item_id"].as_str(),
                                                echo_guard_enabled,
                                            },
                                        );
                                        if !manual_response_requested {
                                            reset_turn = true;
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
                                    manual_response_pending = false;
                                    manual_response_requested = false;
                                    manual_response_item_id = None;
                                } else {
                                    // Keep one manual response in flight until
                                    // response.done. Releasing the gate as soon
                                    // as ASR completes lets the next commit and
                                    // response.create overlap the current model
                                    // response; Flash has returned InternalError
                                    // for that production ordering, and response
                                    // ownership can then drift between cues.
                                    let _ = diag_log(
                                        app,
                                        "omni",
                                        "debug",
                                        "event=manual_response_gate state=awaiting_response_done",
                                    );
                                }
                            }
                        }
                        if routed_uncorrelated_completed_transcription {
                            let late_cue_id = completed_cue_id.map(str::to_owned);
                            let late_completion_owns_current_cue = late_cue_id.as_deref().is_some()
                                && late_cue_id.as_deref() == current_cue_id.as_deref();
                            let response_stream_active = manual_turn_response_stream_active(
                                pending_audio_delta_count,
                                pending_audio_buffer.len(),
                                pending_audio_response_id.as_deref(),
                                &pending_translated_text,
                            );
                            if late_completion_owns_current_cue
                                && !response_stream_owns_current_cue(
                                    response_stream_active,
                                    subtitle_translate_active,
                                    native_translation_reuse_active,
                                )
                            {
                                // The late final remains visible in the cue store, but it
                                // must not keep the mutable input pointer that belongs to
                                // the newer pending manual turn. Otherwise that turn's
                                // final can overwrite the late source cue.
                                reset_manual_turn_input_state(
                                    &mut current_cue_id,
                                    &mut pending_source_text,
                                    &mut transcription_completed_flag,
                                    &mut transcription_completed_at,
                                    &mut event_diagnostics,
                                );
                                let _ = diag_log(
                                    app,
                                    "omni",
                                    "debug",
                                    format!(
                                        "event=manual_response_gate action=release_late_transcription_cue cueId={}",
                                        late_cue_id.as_deref().unwrap_or("(none)"),
                                    ),
                                );
                            }
                        }
                        if output.skip_tick {
                            return poll_result!(true);
                        }
                    }
                    "response.audio_transcript.delta"
                    | "response.audio_transcript.text"
                    | "response.output_audio_transcript.delta"
                    | "response.output_audio_transcript.text"
                    | "response.output_text.delta"
                    | "response.output_text.text"
                    | "response.transcript.delta"
                    | "response.transcript.text"
                    | "response.text.delta"
                    | "response.text.text" => {
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
                    "response.audio_transcript.done"
                    | "response.output_audio_transcript.done"
                    | "response.output_item.done"
                    | "response.output_text.done"
                    | "response.content_part.done"
                    | "response.transcript.done"
                    | "response.text.done" => {
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
                            event_type,
                            &session_started_at,
                            subtitle_translate_active,
                            native_translation_reuse_active,
                            output_mode,
                        );
                        current_cue_id = output.current_cue_id;
                        pending_source_text = output.pending_source_text;
                        pending_translated_text = output.pending_translated_text;
                        st_skip_logged = output.st_skip_logged;
                        event_diagnostics = output.event_diagnostics;
                    }
                    "response.created" => {
                        event_diagnostics.claim_native_response_owner_for_event(
                            &evt,
                            current_cue_id.as_deref(),
                        );
                    }
                    "response.audio.delta" => {
                        event_diagnostics.claim_native_response_owner_for_event(
                            &evt,
                            current_cue_id.as_deref(),
                        );
                        let audio_delta_cue_id = native_response_id_from_event(&evt)
                            .and_then(|response_id| event_diagnostics.native_response_cue_for_response_id(response_id))
                            .or_else(|| current_cue_id.clone());
                        let output = OmniEventProcessor::process_audio_delta(
                            OmniAudioOutputState {
                                pending_audio_delta_count,
                                pending_audio_delta_base64_bytes,
                                pending_audio_response_id,
                                pending_audio_buffer,
                                pending_audio_stream_cue_id,
                                pending_audio_stream_chunk_index,
                                pending_audio_stream_created_at_ms,
                                pending_audio_stream_aborted,
                            },
                            &app,
                            &evt,
                            direction,
                            audio_delta_cue_id.as_deref(),
                            playback_tx,
                        );
                        pending_audio_delta_count = output.pending_audio_delta_count;
                        pending_audio_delta_base64_bytes = output.pending_audio_delta_base64_bytes;
                        pending_audio_response_id = output.pending_audio_response_id;
                        pending_audio_buffer = output.pending_audio_buffer;
                        pending_audio_stream_cue_id = output.pending_audio_stream_cue_id;
                        pending_audio_stream_chunk_index = output.pending_audio_stream_chunk_index;
                        pending_audio_stream_created_at_ms = output.pending_audio_stream_created_at_ms;
                        pending_audio_stream_aborted = output.pending_audio_stream_aborted;
                    }
                    "response.audio.done" => {
                        let audio_response_id = native_response_id_from_event(&evt)
                            .or(pending_audio_response_id.as_deref());
                        event_diagnostics.claim_native_response_owner_for_event(
                            &evt,
                            current_cue_id.as_deref(),
                        );
                        let audio_cue_id = audio_response_id
                            .and_then(|response_id| {
                                event_diagnostics
                                    .native_response_cue_for_response_id(response_id)
                            })
                            .or_else(|| {
                                if audio_response_id.is_none() {
                                    event_diagnostics.native_response_cue_id.clone()
                                } else {
                                    None
                                }
                            });
                        let output = OmniEventProcessor::process_audio_done(
                            OmniAudioOutputState {
                                pending_audio_delta_count,
                                pending_audio_delta_base64_bytes,
                                pending_audio_response_id,
                                pending_audio_buffer,
                                pending_audio_stream_cue_id,
                                pending_audio_stream_chunk_index,
                                pending_audio_stream_created_at_ms,
                                pending_audio_stream_aborted,
                            },
                            &app,
                            &playback_tx,
                            audio_cue_id.as_deref(),
                            direction,
                        );
                        pending_audio_delta_count = output.pending_audio_delta_count;
                        pending_audio_delta_base64_bytes = output.pending_audio_delta_base64_bytes;
                        pending_audio_response_id = output.pending_audio_response_id;
                        pending_audio_buffer = output.pending_audio_buffer;
                        pending_audio_stream_cue_id = output.pending_audio_stream_cue_id;
                        pending_audio_stream_chunk_index = output.pending_audio_stream_chunk_index;
                        pending_audio_stream_created_at_ms = output.pending_audio_stream_created_at_ms;
                        pending_audio_stream_aborted = output.pending_audio_stream_aborted;
                    }
                    "input_audio_buffer.speech_stopped" => {
                        event_diagnostics.begin_native_response_lifecycle(None);
                        last_vad_event_time = SystemTime::now();
                        vad_event_count += 1;
                        if let Some(cue_id) = current_cue_id.clone() {
                            // Subtitle translation still has a native response
                            // stream whose output must remain attached to the
                            // source cue that caused it. The secondary worker
                            // owns publication, but not response identity.
                            let authoritative_item_id = evt["item_id"]
                                .as_str()
                                .map(str::trim)
                                .filter(|item_id| !item_id.is_empty())
                                .map(str::to_string);
                            let item_id = authoritative_item_id
                                .or_else(|| event_diagnostics.current_vad_item_id.clone())
                                .or_else(|| event_diagnostics.last_asr_delta_item_id.clone());
                            event_diagnostics.current_vad_item_id = item_id.clone();
                            if let Some(item_id) = item_id.as_deref() {
                                // speech_stopped carries the provider item that
                                // will own both the ASR final and automatic
                                // response. Prefer it over delta timing, while
                                // retaining the prior delta-derived fallback
                                // for compatible providers that omit item_id.
                                event_diagnostics
                                    .record_asr_cue_owner(item_id, cue_id.clone());
                            }
                            event_diagnostics.capture_native_response_owner(
                                cue_id.clone(),
                                item_id.clone(),
                            );
                            let _ = diag_log(
                                &app,
                                "omni",
                                "debug",
                                format!(
                                    "[VAD] native response ownership queued cue_id={cue_id} item_id={} pendingOwners={} subtitleTranslateActive={} nativeTranslationReuse={}",
                                    item_id.as_deref().unwrap_or("(none)"),
                                    event_diagnostics.pending_native_response_owner_count(),
                                    subtitle_translate_active,
                                    native_translation_reuse_active,
                                ),
                            );
                        }
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
                            crate::audio::events::is_livetranslate_route_model(
                                provider,
                                &provider.model,
                            ),
                            &mut transcription_completed_flag,
                            &mut transcription_completed_at,
                            &mut event_diagnostics,
                            &session_started_at,
                            &evt,
                            glossary,
                        );
                        store.watch_session_report.push_output_delta(
                            "response.done",
                            "",
                            "",
                        );
                        if audio_mode.uses_manual_commit() && manual_response_pending {
                            manual_response_pending = false;
                            manual_response_requested = false;
                            manual_response_item_id = None;
                            manual_response_released_at = Some(SystemTime::now());
                            // The audio pump remains writable while a response
                            // streams. Its accepted PCM already belongs to the
                            // provider's next input buffer, so preserve the
                            // matching counters here. The next worker tick can
                            // commit that bounded turn now that response.create
                            // serialization is released. Clearing the counters
                            // used to strand the accepted PCM until another
                            // second arrived, making each later response absorb
                            // the entire previous response window.
                            let _ = diag_log(
                                app,
                                "omni",
                                "debug",
                                format!(
                                    "event=manual_response_gate state=response_done_released providerBufferReset=false bufferedSamples={} bufferedAudible={}",
                                    audio_samples_since_commit,
                                    sent_audio_since_commit,
                                ),
                            );
                        }
                    }
                    // The shutdown wrapper marks an authoritative
                    // `session.finished` before this processor receives it.
                    // Return the accumulated state immediately so the worker
                    // can accept that terminal acknowledgement instead of
                    // running response-stall recovery against a socket the
                    // provider is now entitled to close.
                    "session.finished" => return poll_result!(false),
                    "error" => {
                        if is_idle_preconnect_session(
                            store,
                            direction,
                            session_ready_for_audio,
                            total_input_chunks,
                        ) && is_provider_idle_timeout_error(
                            provider_error_code(&evt),
                            provider_error_message(&evt),
                        ) {
                            let _ = diag_log(
                                app,
                                "omni",
                                "info",
                                "[PRECONNECT] provider idle timeout; closing parked session without reconnect",
                            );
                            stop_worker = true;
                            return poll_result!(true);
                        }
                        let provider_error_code = provider_error_code(&evt);
                        let provider_error_message = provider_error_message(&evt);
                        let ignored_released_empty_commit = is_rejected_empty_manual_commit(
                            audio_mode,
                            manual_response_pending,
                            manual_response_requested,
                            manual_response_item_id.as_deref(),
                            sent_audio_since_commit,
                            audio_samples_since_commit,
                            provider_error_code,
                            provider_error_message,
                        );
                        if ignored_released_empty_commit {
                            // This commit was accepted locally and rejected as
                            // empty by the provider before it created an ASR
                            // item. Release the gate so normal later audio can
                            // form the next turn; no model response exists for
                            // this rejected commit.
                            manual_response_pending = false;
                            manual_response_requested = false;
                            manual_response_item_id = None;
                            let detail = format!(
                                "Provider rejected an already-cleared manual input buffer; released the empty commit gate. code={provider_error_code} message={provider_error_message}"
                            );
                            store.watch_session_report.record_session_issue(
                                "model",
                                "provider-empty-audio-commit-ignored",
                                "warning",
                                &detail,
                            );
                            let _ = diag_log(app, "omni", "warning", detail);
                        } else {
                            store.watch_session_report.record_provider_error(
                                current_cue_id.as_deref(),
                                &direction,
                                "dashscope-native-realtime",
                                provider_error_code,
                                provider_error_message,
                                &text,
                            );
                            let reconnect_state =
                                OmniConnectionCoordinator::handle_provider_error(
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
                                    output_mode,
                                    source_language,
                                    &target_language,
                                    buffer_size,
                                    provider_input_budget,
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
                output_mode,
                source_language,
                &target_language,
                buffer_size,
                provider_input_budget,
            )?;
            socket = reconnect_state.socket;
            reconnect_count = reconnect_state.reconnect_count;
            pending_audio_buffer = reconnect_state.pending_audio_buffer;
            active_voice = reconnect_state.active_voice;
            voice_fallback_applied = reconnect_state.voice_fallback_applied;
            socket_reconnected = reconnect_state.socket_reconnected;
            return poll_result!(true);
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
            output_mode,
            source_language,
            &target_language,
            buffer_size,
            error,
            provider_input_budget,
        )?;
        socket = reconnect_state.socket;
        reconnect_count = reconnect_state.reconnect_count;
        pending_audio_buffer = reconnect_state.pending_audio_buffer;
        active_voice = reconnect_state.active_voice;
        voice_fallback_applied = reconnect_state.voice_fallback_applied;
        socket_reconnected = reconnect_state.socket_reconnected;
        return poll_result!(true);
            }
        }

        let stall = maintain_response_lifecycle(
            ResponseStallReconnectState {
                socket,
                reconnect_count,
                pending_audio_buffer,
                active_voice,
                voice_fallback_applied,
            },
            &mut trace_call,
            &mut event_diagnostics,
            ResponseStallContext {
                app,
                store,
                provider,
                instructions,
                audio_mode,
                output_mode,
                source_language,
                target_language,
                buffer_size,
                provider_input_budget,
                current_cue_id: current_cue_id.as_deref(),
                pending_source_text: &pending_source_text,
                subtitle_translate_active,
                playback_tx,
                pending_audio_stream_cue_id: pending_audio_stream_cue_id.as_deref(),
                pending_audio_stream_chunk_index,
                pending_audio_stream_created_at_ms,
            },
            connector,
        )?;
        socket = stall.state.socket;
        reconnect_count = stall.state.reconnect_count;
        pending_audio_buffer = stall.state.pending_audio_buffer;
        active_voice = stall.state.active_voice;
        voice_fallback_applied = stall.state.voice_fallback_applied;
        if stall.socket_reconnected {
            socket_reconnected = true;
            return poll_result!(true);
        }

        poll_result!(false)
    }
}
