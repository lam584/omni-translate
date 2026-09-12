use super::*;

/// The legacy replay provider is manifest-only. Even a correlated ASR final
/// must fail closed instead of granting the Omni-only response.create write.
/// The pure manual-gate tests in connection_coordinator retain the product
/// transition for a future enabled Omni adapter.
#[test]
fn replay_matching_asr_progress_cannot_bypass_manifest_only_response_authority() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    let mut slice = WorkerSlice::new();
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-long".to_string());
    slice.last_commit_time = backdated(MANUAL_RESPONSE_TIMEOUT_SECS + 1);
    slice.event_diagnostics.last_asr_delta_item_id = Some("item-long".to_string());
    slice.event_diagnostics.last_asr_delta_at_ms =
        Some(elapsed_ms_since(&harness.session_started_at));
    slice.sent_audio_since_commit = true;
    slice.manual_turn_audio_after_response = true;
    slice.audio_samples_since_commit = MANUAL_COMMIT_MIN_AUDIO_SAMPLES;
    slice.manual_turn_started_at = Some(backdated(MANUAL_COMMIT_INTERVAL_SECS + 1));

    let socket = ScriptedRealtimeSocket::new(
        vec![ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-long",
            "transcript": "the complete middle translation source"
        }))],
        harness.shared.clone(),
    );
    let _socket = harness.tick(socket, &mut slice);

    assert!(!slice.manual_response_pending);
    assert!(!slice.manual_response_requested);
    assert_eq!(response_create_count(&harness), 0);
    assert_no_next_commit(&harness);
    let snapshot = harness.store().snapshot();
    let completed_cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == "the complete middle translation source")
        .expect("completed source cue");
    assert!(completed_cue.committed, "Provider ASR completed owns source finality");
    assert!(!completed_cue.translation_committed);
    assert!(completed_cue.translated_text.is_empty());
    assert_eq!(
        completed_cue.translation_state,
        Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Pending)
    );
}

#[test]
fn replay_unrelated_asr_progress_does_not_extend_the_manual_response_gate() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    let mut slice = WorkerSlice::new();
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-stalled".to_string());
    slice.last_commit_time = backdated(MANUAL_RESPONSE_TIMEOUT_SECS + 1);
    slice.event_diagnostics.last_asr_delta_item_id = Some("item-other".to_string());
    slice.event_diagnostics.last_asr_delta_at_ms =
        Some(elapsed_ms_since(&harness.session_started_at));

    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Idle], harness.shared.clone());
    let _socket = harness.tick(socket, &mut slice);

    assert!(!slice.manual_response_pending);
    assert!(slice.manual_response_item_id.is_none());
    assert_eq!(response_create_count(&harness), 0);
}

/// A manifest-only Omni profile cannot start this socket state machine. This
/// replay proves the first paid client mutation is rejected; duplicate-final
/// serialization and response.done release remain covered by the pure gate
/// and response state-machine tests without fabricating connection authority.
#[test]
fn replay_manifest_only_omni_response_create_fails_closed() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    let mut slice = WorkerSlice::new();
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-current".to_string());
    slice.sent_audio_since_commit = true;
    slice.manual_turn_audio_after_response = true;
    slice.audio_samples_since_commit = MANUAL_COMMIT_MIN_AUDIO_SAMPLES;
    slice.manual_turn_started_at = Some(backdated(MANUAL_COMMIT_INTERVAL_SECS + 1));

    let socket = ScriptedRealtimeSocket::new(
        vec![
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "item-current",
                "transcript": "the current translated turn"
            })),
            // DashScope can replay the same final before response.done. This
            // must not send another response.create for the committed item.
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "item-current",
                "transcript": "the current translated turn"
            })),
            ScriptStep::Event(json!({ "type": "response.text.delta", "delta": "当前" })),
            ScriptStep::Event(json!({ "type": "response.text.done", "text": "当前译文" })),
            ScriptStep::Event(json!({ "type": "response.done" })),
            ScriptStep::Idle,
        ],
        harness.shared.clone(),
    );

    let _socket = harness.tick(socket, &mut slice);
    assert!(!slice.manual_response_pending);
    assert!(!slice.manual_response_requested);
    assert_eq!(response_create_count(&harness), 0);
    assert_no_next_commit(&harness);
}

fn response_create_count(harness: &ReplayHarness) -> usize {
    harness.sent_types().iter().filter(|kind| kind.as_str() == "response.create").count()
}

fn assert_no_next_commit(harness: &ReplayHarness) {
    assert!(
        !harness.sent_types().iter().any(|kind| kind == "input_audio_buffer.commit"),
        "the buffered next turn must not overlap the active response",
    );
}
