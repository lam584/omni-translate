use super::*;

#[test]
fn replay_short_server_vad_whitespace_response_is_dropped_without_failure_cue() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    harness
        .store()
        .update_or_push_stt_cue("existing-committed-cue", "必须保留。", true);
    let mut slice = WorkerSlice::new();
    let steps = vec![
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "item-short-vad",
            "audio_start_ms": 21680
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-short-vad",
            "transcript": "我。"
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_stopped",
            "item_id": "item-short-vad",
            "audio_end_ms": 21740
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "resp-short-vad",
                "input_item_id": "item-short-vad",
                "status": "completed",
                "output": [{
                    "status": "completed",
                    "content": [{ "type": "text", "text": "   \t" }]
                }]
            }
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-short-vad",
            "transcript": "我。"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..5 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    assert!(snapshot.subtitle_overlay.recent_cues.iter().any(|cue| {
        cue.cue_id == "existing-committed-cue" && cue.source_text == "必须保留。" && cue.committed
    }));
    assert!(!snapshot.subtitle_overlay.recent_cues.iter().any(|cue| {
        cue.translation_state
            == Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
            || cue.translated_text.contains("实时模型已结束本轮响应")
            || !cue.translated_text.is_empty()
    }));
    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("short-VAD replay should retain a report");
    assert!(!report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
    assert_eq!(report.cues.len(), 1, "unexpected report cues: {:?}", report.cues);
    assert_eq!(report.cues[0].cue_id, "existing-committed-cue");
    assert_eq!(report.cues[0].source_text, "必须保留。");
}
