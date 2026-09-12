use super::*;

/// A fast continuous source can finish two VAD input turns before the first
/// native translation starts streaming. The ownership tracker must preserve
/// both stopped turns in FIFO order instead of letting the second stop replace
/// the first owner and strand a source-only cue as "calling LLM".
#[test]
fn replay_two_stopped_turns_before_first_response_keep_fifo_ownership() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let source_one = "You'll see how we're going to bring extinct species back to life.";
    let translated_one = "您将看到我们将如何让灭绝物种复活。";
    let source_two = "What?";
    let translated_two = "什么？";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-one",
            "delta": source_one
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-two",
            "delta": source_two
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "response_id": "response-one",
            "transcript": translated_one
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": { "id": "response-one" }
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-one",
            "transcript": source_one
        })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "response_id": "response-two",
            "transcript": translated_two
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": { "id": "response-two" }
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-two",
            "transcript": source_two
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..3 {
        socket = harness.tick(socket, &mut slice);
    }
    std::thread::sleep(Duration::from_millis(2));
    for _ in 3..12 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let first = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source_one)
        .expect("first source cue");
    let second = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source_two)
        .expect("second source cue");
    assert!(first.committed);
    assert!(second.committed);
    assert_eq!(first.translated_text, translated_one);
    assert_eq!(second.translated_text, translated_two);
    assert!(snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .filter(|cue| !cue.committed)
        .all(|cue| cue.source_text.trim().is_empty()));
}
