use super::*;

pub(super) struct ResponseStallReconnectState<S> {
    pub(super) socket: S,
    pub(super) reconnect_count: usize,
    pub(super) pending_audio_buffer: Vec<i16>,
    pub(super) active_voice: String,
    pub(super) voice_fallback_applied: bool,
}

pub(super) struct ResponseStallContext<'a, R: tauri::Runtime> {
    pub(super) app: &'a AppHandle<R>,
    pub(super) store: &'a AudioStateStore,
    pub(super) provider: &'a ProviderDraftInput,
    pub(super) instructions: &'a str,
    pub(super) audio_mode: RealtimeAudioMode,
    pub(super) output_mode: OmniOutputMode,
    pub(super) source_language: &'a str,
    pub(super) target_language: &'a str,
    pub(super) buffer_size: u64,
    pub(super) provider_input_budget: &'a ProviderInputBudget,
    pub(super) current_cue_id: Option<&'a str>,
    pub(super) pending_source_text: &'a str,
    pub(super) subtitle_translate_active: bool,
    pub(super) playback_tx: &'a OmniPlaybackQueue,
    pub(super) pending_audio_stream_cue_id: Option<&'a str>,
    pub(super) pending_audio_stream_chunk_index: u32,
    pub(super) pending_audio_stream_created_at_ms: Option<u64>,
}

pub(super) struct ResponseStallPoll<S> {
    pub(super) state: ResponseStallReconnectState<S>,
    pub(super) socket_reconnected: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn maintain_response_lifecycle<C, R>(
    state: ResponseStallReconnectState<C::Socket>,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    event_diagnostics: &mut OmniEventDiagnostics,
    context: ResponseStallContext<'_, R>,
    connector: &C,
) -> Result<ResponseStallPoll<C::Socket>, String>
where
    C: RealtimeSocketConnector,
    R: tauri::Runtime,
{
    let protocol = crate::audio::events::resolve_realtime_profile(
        context.provider,
        &context.provider.model,
    )
    .protocol_dialect;
    let allow_cancel = protocol == Some(crate::audio::events::RealtimeProtocol::DashscopeOmni);
    let action = event_diagnostics.native_response_stall_action(
        Instant::now(),
        context.provider.timeout_ms,
        allow_cancel,
    );
    match action {
        ResponseStallAction::None => Ok(ResponseStallPoll {
            state,
            socket_reconnected: false,
        }),
        ResponseStallAction::Cancel { response_id } => {
            send_single_omni_cancel(
                state,
                trace_call,
                event_diagnostics,
                context,
                connector,
                &response_id,
            )
        }
        ResponseStallAction::Reconnect => {
            reconnect_stalled_response(state, event_diagnostics, context, connector)
        }
    }
}

fn send_single_omni_cancel<C, R>(
    mut state: ResponseStallReconnectState<C::Socket>,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    event_diagnostics: &mut OmniEventDiagnostics,
    context: ResponseStallContext<'_, R>,
    connector: &C,
    response_id: &str,
) -> Result<ResponseStallPoll<C::Socket>, String>
where
    C: RealtimeSocketConnector,
    R: tauri::Runtime,
{
    let message = json!({
        "event_id": format!("event_response_cancel_{}", unix_ms()),
        "type": "response.cancel",
        "response_id": response_id,
    });
    trace_call.record_ws_send("response.cancel", message.clone());
    if let Err(error) = state
        .socket
        .send_message(Message::Text(message.to_string().into()))
    {
        let _ = diag_log(
            context.app,
            "omni",
            "warning",
            format!(
                "event=response_stall action=cancel_failed responseId={response_id} error={error}"
            ),
        );
        return reconnect_stalled_response(state, event_diagnostics, context, connector);
    }
    event_diagnostics.mark_native_response_cancel_sent(Instant::now());
    let _ = diag_log(
        context.app,
        "omni",
        "warning",
        format!(
            "event=response_stall action=cancel_once responseId={response_id} graceMs={}",
            super::super::response_lifecycle::OMNI_CANCEL_GRACE.as_millis(),
        ),
    );
    Ok(ResponseStallPoll {
        state,
        socket_reconnected: false,
    })
}

fn reconnect_stalled_response<C, R>(
    state: ResponseStallReconnectState<C::Socket>,
    event_diagnostics: &mut OmniEventDiagnostics,
    context: ResponseStallContext<'_, R>,
    connector: &C,
) -> Result<ResponseStallPoll<C::Socket>, String>
where
    C: RealtimeSocketConnector,
    R: tauri::Runtime,
{
    terminalize_stalled_cue(event_diagnostics, &context);
    let reconnect = OmniConnectionCoordinator::reconnect_after_close(
        OmniReconnectState {
            socket: state.socket,
            reconnect_count: state.reconnect_count,
            pending_audio_buffer: state.pending_audio_buffer,
            active_voice: state.active_voice,
            voice_fallback_applied: state.voice_fallback_applied,
            socket_reconnected: false,
        },
        connector,
        context.app,
        context.store,
        context.provider,
        context.instructions,
        context.audio_mode,
        context.output_mode,
        context.source_language,
        context.target_language,
        context.buffer_size,
        context.provider_input_budget,
    )?;
    Ok(ResponseStallPoll {
        state: ResponseStallReconnectState {
            socket: reconnect.socket,
            reconnect_count: reconnect.reconnect_count,
            pending_audio_buffer: reconnect.pending_audio_buffer,
            active_voice: reconnect.active_voice,
            voice_fallback_applied: reconnect.voice_fallback_applied,
        },
        socket_reconnected: true,
    })
}

fn terminalize_stalled_cue<R: tauri::Runtime>(
    event_diagnostics: &OmniEventDiagnostics,
    context: &ResponseStallContext<'_, R>,
) {
    let cue_id = event_diagnostics
        .native_response_cue_id
        .as_deref()
        .or(context.current_cue_id);
    let Some(cue_id) = cue_id else {
        return;
    };
    if !context.pending_source_text.trim().is_empty() {
        context
            .store
            .update_or_push_stt_cue(cue_id, context.pending_source_text, true);
    }
    let translation_is_final = context
        .store
        .snapshot()
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == cue_id)
        .is_some_and(|cue| cue.translation_committed);
    if !context.subtitle_translate_active && !translation_is_final {
        context.store.mark_current_subtitle_translation_error(
            cue_id,
            super::super::protocol::NATIVE_FAILED_TRANSLATION_FAILURE.to_string(),
        );
    }
    if let Some(stream_cue_id) = context.pending_audio_stream_cue_id {
        context.playback_tx.abort_stream(
            stream_cue_id,
            context.pending_audio_stream_chunk_index,
            context
                .pending_audio_stream_created_at_ms
                .unwrap_or_else(unix_ms),
        );
    }
    context.store.watch_session_report.record_model_error_for_cue(
        cue_id,
        "dashscope-native-realtime",
        "native-response-stalled",
        "实时模型响应超时，连接已重建。",
        false,
        None,
    );
    let _ = diag_log(
        context.app,
        "omni",
        "error",
        format!(
            "event=response_stall action=terminalize_and_reconnect cueId={cue_id}"
        ),
    );
}
