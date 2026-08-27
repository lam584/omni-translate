use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn is_rejected_empty_manual_commit(
    audio_mode: RealtimeAudioMode,
    manual_response_pending: bool,
    manual_response_requested: bool,
    manual_response_item_id: Option<&str>,
    sent_audio_since_commit: bool,
    audio_samples_since_commit: u64,
    provider_error_code: &str,
    provider_error_message: &str,
) -> bool {
    audio_mode.uses_manual_commit()
        && manual_response_pending
        && !manual_response_requested
        && manual_response_item_id.is_none()
        && !sent_audio_since_commit
        && audio_samples_since_commit == 0
        && is_released_empty_audio_commit_error(provider_error_code, provider_error_message)
}

pub(super) struct ManualResponseCreateContext<'a, R: tauri::Runtime> {
    pub(super) app: &'a AppHandle<R>,
    pub(super) store: &'a AudioStateStore,
    pub(super) provider: &'a ProviderDraftInput,
    pub(super) source: &'a str,
    pub(super) cue_id: Option<&'a str>,
    pub(super) item_id: Option<&'a str>,
    pub(super) echo_guard_enabled: bool,
}

pub(super) fn send_manual_response_create<S, R>(
    socket: &mut S,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    event_diagnostics: &mut OmniEventDiagnostics,
    context: ManualResponseCreateContext<'_, R>,
) -> bool
where
    S: RealtimeSocket,
    R: tauri::Runtime,
{
    let ManualResponseCreateContext {
        app,
        store,
        provider,
        source,
        cue_id,
        item_id,
        echo_guard_enabled,
    } = context;
    let protocol = crate::audio::events::resolve_realtime_profile(provider, &provider.model)
        .protocol_dialect;
    let Some(create_message) =
        protocol.and_then(super::super::build_dashscope_response_create_for_protocol)
    else {
        let _ = diag_log(
            app,
            "omni",
            "warning",
            "event=manual_response_gate action=skip_explicit_response reason=protocol_managed_response",
        );
        return false;
    };

    trace_call.record_ws_send("response.create", create_message.clone());
    if let Err(error) =
        socket.send_message(Message::Text(create_message.to_string().into()))
    {
        let _ = diag_log(
            app,
            "omni",
            "warning",
            format!("event=manual_response_gate action=create_failed error={error}"),
        );
        return false;
    }

    if let Some(cue_id) = cue_id {
        event_diagnostics.capture_native_response_owner(
            cue_id.to_string(),
            item_id.map(str::to_owned),
        );
        store.approve_subtitle_cue_translation(cue_id);
    }
    event_diagnostics.begin_native_response_lifecycle(None);
    let (playback_active, playback_recent) =
        store.inbound_speaker_playback_context(Duration::from_secs(4));
    let _ = diag_log(
        app,
        "omni",
        "info",
        format!(
            "event=manual_response_gate action=create contentGate=disabled sourceLen={} echoGuardEnabled={} playbackActive={} playbackRecent={} sourceStartedDuringPlayback={:?} sourceContinuityId={} sourceContinuityActive={}",
            source.chars().count(),
            echo_guard_enabled,
            playback_active,
            playback_recent,
            event_diagnostics.source_started_during_playback,
            event_diagnostics.source_continuity_id,
            event_diagnostics.source_continuity_active,
        ),
    );
    true
}
