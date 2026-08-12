use super::*;

/// A completed transcription starts the model response but must not release
/// the next manual commit until response.done. The production Flash ordering
/// previously overlapped response.create calls and ended in InternalError.
#[test]
fn replay_manual_gate_serializes_response_create_until_response_done() {
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

    let socket = harness.tick(socket, &mut slice);
    assert!(slice.manual_response_pending);
    assert!(slice.manual_response_requested);
    assert_eq!(response_create_count(&harness), 1);
    assert_no_next_commit(&harness);

    let socket = harness.tick(socket, &mut slice);
    assert!(slice.manual_response_pending);
    assert!(slice.manual_response_requested);
    assert_eq!(response_create_count(&harness), 1, "replayed final must not create a second response");

    let socket = harness.tick(socket, &mut slice);
    assert!(slice.manual_response_pending, "a text delta must not release the gate");
    assert_no_next_commit(&harness);

    let socket = harness.tick(socket, &mut slice);
    assert!(slice.manual_response_pending, "response.text.done must wait for response.done");
    assert_eq!(slice.pending_translated_text, "当前译文");
    assert_no_next_commit(&harness);

    let socket = harness.tick(socket, &mut slice);
    assert!(!slice.manual_response_pending, "response.done releases the next manual turn");
    assert!(!slice.manual_response_requested);
    assert!(slice.sent_audio_since_commit, "response.done retains accepted next-turn audio");
    assert!(slice.manual_turn_audio_after_response);
    assert_eq!(slice.audio_samples_since_commit, MANUAL_COMMIT_MIN_AUDIO_SAMPLES);
    let _socket = harness.tick(socket, &mut slice);
    assert_eq!(
        harness.sent_types().iter().filter(|kind| kind.as_str() == "input_audio_buffer.commit").count(),
        1,
        "the turn accumulated while the response streamed commits after response.done",
    );
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
