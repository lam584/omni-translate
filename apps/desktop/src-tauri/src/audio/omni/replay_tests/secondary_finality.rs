use super::*;

/// A realtime provider may deliver an earlier ASR final after server VAD has
/// already opened the next cue. The secondary subtitle path must keep that
/// final attached to the item that produced its deltas; otherwise the LLM is
/// handed audio from the previous turn and the visible translations repeat.
#[test]
fn replay_secondary_late_asr_final_stays_with_original_cue() {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.subtitle_translate_active = true;
    let mut slice = WorkerSlice::new();
    let steps = vec![
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-one",
            "text": "first sentence",
            "stash": ""
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-two",
            "text": "second sentence",
            "stash": ""
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-one",
            "transcript": "first sentence"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-two",
            "transcript": "second sentence"
        })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.delta",
            "response_id": "native-preview-must-stay-hidden",
            "delta": "不得写入的原生预览"
        })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "response_id": "native-preview-must-stay-hidden",
            "transcript": "不得写入的原生终稿"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for (index, _) in [0, 1, 2, 3, 4, 5, 6, 7].iter().enumerate() {
        socket = harness.tick(socket, &mut slice);
        if index == 1 {
            // Cue ids use millisecond timestamps; ensure the second VAD
            // event represents a genuinely new cue in this deterministic
            // replay rather than a same-millisecond id collision.
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    let cues = harness.store().snapshot().subtitle_overlay.recent_cues;
    let source_texts: Vec<_> = cues.iter().map(|cue| cue.source_text.as_str()).collect();
    assert_eq!(
        source_texts
            .iter()
            .filter(|&&source| source == "first sentence")
            .count(),
        1
    );
    assert_eq!(
        source_texts
            .iter()
            .filter(|&&source| source == "second sentence")
            .count(),
        1
    );
    assert!(cues.iter().all(|cue| {
        cue.source_text != "first sentence second sentence"
            && cue.source_text != "second sentence first sentence"
    }));
    assert!(cues.iter().all(|cue| cue.committed));
    assert!(cues
        .iter()
        .all(|cue| harness.store().subtitle_source_is_final(&cue.cue_id)));
    assert!(cues.iter().all(|cue| {
        !cue.translation_committed
            && cue.translated_text.is_empty()
            && cue.translation_state
                == Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Pending)
    }));
}
