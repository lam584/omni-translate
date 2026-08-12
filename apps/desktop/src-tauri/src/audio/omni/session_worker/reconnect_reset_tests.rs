use super::*;

#[test]
fn every_manual_turn_anchors_on_its_first_successful_audible_append() {
    assert!(should_anchor_manual_turn_to_first_audible_append(RealtimeAudioMode::Manual, false, true));
    assert!(!should_anchor_manual_turn_to_first_audible_append(RealtimeAudioMode::Manual, true, true));
    assert!(!should_anchor_manual_turn_to_first_audible_append(RealtimeAudioMode::ServerVad, false, true));
}

#[test]
fn reconnect_reset_marks_the_session_not_ready_for_audio() {
    let store = AudioStateStore::new();
    let mut manual_response_pending = true;
    let mut manual_response_requested = true;
    let mut manual_response_item_id = Some("item-old".to_string());
    let mut sent_audio_since_commit = true;
    let mut audio_samples_since_commit = 32_000_u64;
    let mut manual_turn_audio_after_response = true;
    let mut last_commit_time = SystemTime::now();
    let mut manual_turn_started_at = Some(SystemTime::now());
    let mut manual_turn_started_during_playback = Some(true);
    let mut current_cue_id = Some("cue-old".to_string());
    let mut pending_source_text = "half a sentence".to_string();
    let mut pending_translated_text = "半句译文".to_string();
    let mut transcription_completed_flag = true;
    let mut transcription_completed_at = Some(SystemTime::now());
    let mut event_diagnostics = OmniEventDiagnostics::default();
    let mut pending_audio_buffer = vec![1_i16, -1];
    let mut pending_audio_delta_count = 3_u64;
    let mut pending_audio_delta_base64_bytes = 4_096_u64;
    let mut pending_audio_response_id = Some("resp-old".to_string());
    let mut pending_audio_stream_cue_id = Some("cue-stream-old".to_string());
    let mut pending_audio_stream_chunk_index = 3_u32;
    let mut pending_audio_stream_created_at_ms = Some(1_u64);
    let mut pending_audio_stream_aborted = true;
    let mut session_ready_for_audio = true;

    reset_session_state_after_reconnect(
        &store, &mut manual_response_pending, &mut manual_response_requested,
        &mut manual_response_item_id, &mut sent_audio_since_commit,
        &mut audio_samples_since_commit, &mut manual_turn_audio_after_response,
        &mut last_commit_time, &mut manual_turn_started_at,
        &mut manual_turn_started_during_playback, &mut current_cue_id,
        &mut pending_source_text, &mut pending_translated_text,
        &mut transcription_completed_flag, &mut transcription_completed_at,
        &mut event_diagnostics, &mut pending_audio_buffer,
        &mut pending_audio_delta_count, &mut pending_audio_delta_base64_bytes,
        &mut pending_audio_response_id, &mut pending_audio_stream_cue_id,
        &mut pending_audio_stream_chunk_index, &mut pending_audio_stream_created_at_ms,
        &mut pending_audio_stream_aborted,
        &mut session_ready_for_audio,
    );

    assert!(!session_ready_for_audio, "audio must buffer until the new session confirms");
    assert!(!manual_response_pending);
    assert!(!manual_response_requested);
    assert!(manual_response_item_id.is_none());
    assert!(!sent_audio_since_commit);
    assert_eq!(audio_samples_since_commit, 0);
    assert!(!manual_turn_audio_after_response);
    assert!(manual_turn_started_at.is_none());
    assert!(manual_turn_started_during_playback.is_none());
    assert!(current_cue_id.is_none());
    assert!(pending_audio_buffer.is_empty());
    assert_eq!(pending_audio_delta_count, 0);
    assert!(pending_audio_response_id.is_none());
    assert!(pending_audio_stream_cue_id.is_none());
    assert_eq!(pending_audio_stream_chunk_index, 0);
    assert!(pending_audio_stream_created_at_ms.is_none());
    assert!(!pending_audio_stream_aborted);
    assert!(last_commit_time.elapsed().unwrap_or_default() < Duration::from_secs(MANUAL_COMMIT_INTERVAL_SECS));
}
