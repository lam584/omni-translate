use super::*;

/// State portion of the post-reconnect reset, kept free of `AppHandle` so the
/// reconnect contract stays directly unit-testable.
#[allow(clippy::too_many_arguments)]
pub(in crate::audio::omni) fn reset_session_state_after_reconnect(
    store: &AudioStateStore,
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
    *manual_response_pending = false;
    *manual_response_requested = false;
    *manual_response_item_id = None;
    *sent_audio_since_commit = false;
    *audio_samples_since_commit = 0;
    *manual_turn_audio_after_response = false;
    *last_commit_time = SystemTime::now();
    *manual_turn_started_at = None;
    *manual_turn_started_during_playback = None;
    if let Some(cue_id) = current_cue_id.as_deref() {
        store.discard_uncommitted_subtitle_cue(cue_id);
    }
    reset_omni_turn_state(
        current_cue_id,
        pending_source_text,
        pending_translated_text,
        transcription_completed_flag,
        transcription_completed_at,
        event_diagnostics,
    );
    pending_audio_buffer.clear();
    *pending_audio_delta_count = 0;
    *pending_audio_delta_base64_bytes = 0;
    *pending_audio_response_id = None;
    *pending_audio_stream_cue_id = None;
    *pending_audio_stream_chunk_index = 0;
    *pending_audio_stream_created_at_ms = None;
    *pending_audio_stream_aborted = false;
    *session_ready_for_audio = false;
}
