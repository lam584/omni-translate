use super::*;

/// After a WebSocket reconnect the provider session and its input buffer are
/// gone: an awaited `input_audio_buffer.committed` ack or
/// `transcription.completed` will never arrive, and a streaming response
/// cannot resume. Drop the manual response gate and the stale turn/output
/// state, restart the commit timer so the next audible chunk cannot create a
/// tiny empty turn, and mark the session not ready for audio: the new socket has not confirmed
/// its `session.update` yet, so audio must buffer in the pre-session queue
/// until the new `session.created`/`session.updated` arrives.
#[allow(clippy::too_many_arguments)]
pub(in crate::audio::omni) fn reset_manual_gate_after_reconnect<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    audio_mode: RealtimeAudioMode,
    manual_response_pending: &mut bool,
    manual_response_requested: &mut bool,
    manual_response_item_id: &mut Option<String>,
    sent_audio_since_commit: &mut bool,
    audio_samples_since_commit: &mut u64,
    manual_turn_audio_after_response: &mut bool,
    last_commit_time: &mut SystemTime,
    manual_turn_started_at: &mut Option<SystemTime>,
    manual_turn_started_during_playback: &mut Option<bool>,
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
    pending_audio_buffer: &mut Vec<i16>,
    pending_audio_delta_count: &mut u64,
    pending_audio_delta_base64_bytes: &mut u64,
    pending_audio_response_id: &mut Option<String>,
    pending_audio_stream_cue_id: &mut Option<String>,
    pending_audio_stream_chunk_index: &mut u32,
    pending_audio_stream_created_at_ms: &mut Option<u64>,
    pending_audio_stream_aborted: &mut bool,
    session_ready_for_audio: &mut bool,
) {
    if audio_mode.uses_manual_commit() && *manual_response_pending {
        let _ = diag_log(
            app,
            "omni",
            "warning",
            "event=manual_response_gate action=reset_after_reconnect reason=server_session_lost",
        );
    }
    reset_session_state_after_reconnect(
        store,
        manual_response_pending,
        manual_response_requested,
        manual_response_item_id,
        sent_audio_since_commit,
        audio_samples_since_commit,
        manual_turn_audio_after_response,
        last_commit_time,
        manual_turn_started_at,
        manual_turn_started_during_playback,
        current_cue_id,
        pending_source_text,
        pending_translated_text,
        transcription_completed_flag,
        transcription_completed_at,
        event_diagnostics,
        pending_audio_buffer,
        pending_audio_delta_count,
        pending_audio_delta_base64_bytes,
        pending_audio_response_id,
        pending_audio_stream_cue_id,
        pending_audio_stream_chunk_index,
        pending_audio_stream_created_at_ms,
        pending_audio_stream_aborted,
        session_ready_for_audio,
    );
}
