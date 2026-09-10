use super::*;

#[test]
fn shutdown_drain_releases_manual_response_audio_defer() {
    assert!(should_defer_manual_audio_for_response(true, true, false));
    assert!(!should_defer_manual_audio_for_response(true, true, true));
    assert!(!should_defer_manual_audio_for_response(false, true, false));
    assert!(!should_defer_manual_audio_for_response(true, false, false));
}

#[test]
fn provider_audio_pacer_deducts_processing_time_from_the_media_interval() {
    let started_at = Instant::now();
    let mut pacer = audio_pump::ProviderAudioPacer::default();

    assert_eq!(pacer.delay_before_append(started_at, 320), Duration::ZERO);
    pacer.record_successful_append(320);

    assert_eq!(
        pacer.delay_before_append(started_at + Duration::from_millis(5), 320),
        Duration::from_millis(15),
    );
}

#[test]
fn provider_audio_pacer_absorbs_outer_tick_work_without_long_term_drift() {
    let started_at = Instant::now();
    let mut now = started_at;
    let mut pacer = audio_pump::ProviderAudioPacer::default();

    for chunk_index in 0..100 {
        now += pacer.delay_before_append(now, 320);
        pacer.record_successful_append(320);
        now += Duration::from_millis(5);
        if (chunk_index + 1) % 8 == 0 {
            now += Duration::from_millis(10);
        }
    }

    assert!(
        now.duration_since(started_at) < Duration::from_millis(2_050),
        "processing and outer tick work must consume the absolute media deadline instead of accumulating on top of it",
    );
}

#[test]
fn provider_audio_pacer_avoids_the_formal_run_long_media_backlog() {
    let started_at = Instant::now();
    let mut now = started_at;
    let mut pacer = audio_pump::ProviderAudioPacer::default();
    let full_chunks = 2_013_045_u64 / 320;

    for chunk_index in 0..full_chunks {
        now += pacer.delay_before_append(now, 320);
        pacer.record_successful_append(320);
        now += Duration::from_millis(5);
        if (chunk_index + 1) % 8 == 0 {
            now += Duration::from_millis(10);
        }
    }

    let media_duration = Duration::from_secs_f64((full_chunks * 320) as f64 / 16_000.0);
    assert!(
        now.duration_since(started_at) <= media_duration + Duration::from_millis(50),
        "the formal 126-second input must not accumulate the prior fifteen-second local send backlog",
    );
}

#[test]
fn provider_audio_pacer_bounds_catch_up_after_a_long_stall() {
    let started_at = Instant::now();
    let stalled_at = started_at + Duration::from_millis(500);
    let mut pacer = audio_pump::ProviderAudioPacer::default();
    assert_eq!(pacer.delay_before_append(started_at, 320), Duration::ZERO);
    pacer.record_successful_append(320);

    for _ in 0..8 {
        assert_eq!(pacer.delay_before_append(stalled_at, 320), Duration::ZERO);
        pacer.record_successful_append(320);
    }
    assert_eq!(
        pacer.delay_before_append(stalled_at, 320),
        Duration::from_millis(20),
        "catch-up must be bounded to one eight-chunk pump tick",
    );
}

#[test]
fn provider_audio_pacer_uses_samples_for_variable_chunk_deadlines() {
    let started_at = Instant::now();
    let mut pacer = audio_pump::ProviderAudioPacer::default();

    assert_eq!(pacer.delay_before_append(started_at, 160), Duration::ZERO);
    pacer.record_successful_append(160);
    assert_eq!(
        pacer.delay_before_append(started_at + Duration::from_millis(3), 640),
        Duration::from_millis(7),
    );
    pacer.record_successful_append(640);
    assert_eq!(
        pacer.delay_before_append(started_at + Duration::from_millis(20), 320),
        Duration::from_millis(30),
    );
}

#[test]
fn provider_audio_pacer_does_not_expand_catch_up_for_a_large_chunk() {
    let started_at = Instant::now();
    let stalled_at = started_at + Duration::from_millis(500);
    let mut pacer = audio_pump::ProviderAudioPacer::default();
    assert_eq!(pacer.delay_before_append(started_at, 320), Duration::ZERO);
    pacer.record_successful_append(320);

    assert_eq!(pacer.delay_before_append(stalled_at, 2_720), Duration::ZERO);
    pacer.record_successful_append(2_720);
    assert_eq!(
        pacer.delay_before_append(stalled_at, 320),
        Duration::from_millis(30),
        "a large next chunk must not enlarge the fixed 140ms catch-up media budget",
    );
}

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
