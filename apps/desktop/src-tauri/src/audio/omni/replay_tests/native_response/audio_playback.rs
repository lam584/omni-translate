use super::*;

#[test]
fn replay_next_speech_started_preserves_prior_native_audio_buffer() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.audio.delta",
            "response_id": "response-one",
            "delta": "AQACAA=="
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..4 {
        socket = harness.tick(socket, &mut slice);
    }

    assert_eq!(slice.pending_audio_buffer, vec![1, 2]);
    assert_eq!(slice.pending_audio_delta_count, 1);
    assert_eq!(
        slice.pending_audio_response_id.as_deref(),
        Some("response-one")
    );
}

#[test]
fn replay_audio_done_after_response_done_keeps_the_subtitle_cue_identity() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let source = "Actual source cue";
    let translated = "实际译文";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-audio-owner",
            "delta": source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.created",
            "response": { "id": "response-audio-owner" }
        })),
        ScriptStep::Event(json!({
            "type": "response.audio.delta",
            "response_id": "response-audio-owner",
            "delta": "AQACAA=="
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "response-audio-owner",
                "output": [{ "content": [{ "type": "text", "text": translated }] }]
            }
        })),
        ScriptStep::Event(json!({
            "type": "response.audio.done",
            "response_id": "response-audio-owner"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..7 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source)
        .expect("response subtitle cue");
    assert_eq!(cue.translated_text, translated);
    assert_eq!(harness.playback_tx.pending_cue_ids(), [cue.cue_id.as_str()]);
    assert!(harness
        .playback_tx
        .pending_cue_ids()
        .iter()
        .all(|cue_id| !cue_id.starts_with("omni-audio-")));
}
