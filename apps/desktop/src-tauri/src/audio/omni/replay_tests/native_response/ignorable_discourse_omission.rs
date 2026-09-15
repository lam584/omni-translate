use super::*;

/// r96 c03 retained evidence: a source-final standalone discourse
/// acknowledgement received a completed response whose transcript was only
/// whitespace. The exact closed-set omission is retained as diagnostic
/// evidence, but it must not fabricate a translation failure cue.
#[test]
fn replay_completed_empty_okay_is_an_ignorable_discourse_omission() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let mut slice = WorkerSlice::new();
    let steps = vec![
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "item-r96-okay",
            "audio_start_ms": 5680
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_stopped",
            "item_id": "item-r96-okay",
            "audio_end_ms": 6060
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-r96-okay",
            "transcript": "Okay."
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "resp-r96-okay",
                "status": "completed",
                "output": [{
                    "status": "completed",
                    "content": [{ "type": "audio", "transcript": "  " }]
                }]
            }
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..4 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    assert!(!snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .any(|cue| cue.source_text == "Okay."));
    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("ignored discourse omission should retain a report");
    assert!(!report.cues.iter().any(|cue| cue.source_text == "Okay."));
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.code == "ignorable-discourse-omission")
        .expect("the omission classification must remain auditable");
    assert_eq!(issue.category, "model");
    assert_eq!(issue.severity, "warning");
    assert!(issue.cue_id.as_deref().is_some_and(|cue_id| cue_id.starts_with("omni-cue-inbound-")));
    let event = report
        .events
        .iter()
        .find(|event| event.kind == "ignorable-discourse-omission")
        .expect("the completed response evidence must remain in the timeline");
    assert_eq!(event.stage, "model");
    assert_eq!(event.text, "Okay.");
    assert!(event.final_event);
    assert!(event.accepted);
    assert!(event
        .detail
        .as_deref()
        .is_some_and(|detail| detail.contains("responseId=resp-r96-okay")
            && detail.contains("responseStatus=completed")));
    assert!(!report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
}

#[test]
fn replay_completed_empty_acknowledgement_with_core_fact_remains_fail_closed() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let mut slice = WorkerSlice::new();
    let source = "Okay, 842 miles.";
    let steps = vec![
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "item-factual-okay",
            "audio_start_ms": 5680
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_stopped",
            "item_id": "item-factual-okay",
            "audio_end_ms": 6060
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-factual-okay",
            "transcript": source
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": { "id": "resp-factual-okay", "status": "completed" }
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..4 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source)
        .expect("factual source must remain visible");
    assert_eq!(
        cue.translation_state,
        Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
    );
    let report = harness.store().watch_session_report.snapshot().expect("report");
    assert!(report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.code == "ignorable-discourse-omission"));
}

#[test]
fn replay_partial_okay_without_source_final_remains_fail_closed() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let mut slice = WorkerSlice::new();
    let steps = vec![
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "item-partial-okay",
            "audio_start_ms": 5680
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-partial-okay",
            "delta": "Okay."
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_stopped",
            "item_id": "item-partial-okay",
            "audio_end_ms": 6060
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": { "id": "resp-partial-okay", "status": "completed" }
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..4 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == "Okay.")
        .expect("unfinalized source must not be discarded");
    assert_eq!(
        cue.translation_state,
        Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
    );
    let report = harness.store().watch_session_report.snapshot().expect("report");
    assert!(report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.code == "ignorable-discourse-omission"));
}

