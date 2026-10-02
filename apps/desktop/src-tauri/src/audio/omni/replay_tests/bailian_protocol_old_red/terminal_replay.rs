use super::*;

#[test]
fn production_replay_failed_response_never_commits_cue_or_strict_terminal() {
    for response_status in ["failed", "incomplete"] {
        let (harness, mut slice, mut steps) = exact_livetranslate_replay();
        harness
            .store()
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        steps.extend(livetranslate_source_steps());
        steps.extend(livetranslate_text_response_steps(response_status, "completed"));
        run_steps(&harness, &mut slice, steps)
            .expect("a typed failed response is consumed as a terminal failure");

        let snapshot = harness.store().snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.source_text == "source phrase")
            .expect("the production source cue must remain inspectable");
        assert!(!cue.translation_committed);
        assert_eq!(
            cue.translation_state,
            Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error),
            "partial Provider text may remain inspectable, but its cue must be terminally failed"
        );
        let terminal_error = harness
            .store()
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("failed Provider response must poison strict terminal authority");
        assert!(terminal_error.contains("failed Provider responses"), "{terminal_error}");
    }
}

#[test]
fn production_replay_completed_response_rejects_noncompleted_output_item() {
    for item_status in ["failed", "incomplete"] {
        let (harness, mut slice, mut steps) = exact_livetranslate_replay();
        steps.extend(livetranslate_source_steps());
        let response_steps = livetranslate_text_response_steps("completed", item_status);
        let final_index = response_steps.len() - 1;
        steps.extend(response_steps.into_iter().take(final_index));
        run_steps(&harness, &mut slice, steps).unwrap();

        let final_socket = ScriptedRealtimeSocket::new(
            vec![ScriptStep::Event(
                livetranslate_text_response_steps("completed", item_status)
                    .pop()
                    .and_then(|step| match step {
                        ScriptStep::Event(event) => Some(event),
                        _ => None,
                    })
                    .expect("final response.done fixture"),
            )],
            harness.shared.clone(),
        );
        let error = match harness.try_tick(final_socket, &mut slice) {
            Ok(_) => panic!("completed response with a non-completed item must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("terminal status"), "{error}");
        let snapshot = harness.store().snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.source_text == "source phrase")
            .expect("the production source cue must remain inspectable");
        assert!(!cue.translation_committed);
    }
}

#[test]
fn production_replay_normalizes_audio_text_alias_before_strict_terminal_commit() {
    let (harness, mut slice, mut steps) = exact_livetranslate_replay();
    let store = harness.store();
    store
        .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
        .unwrap();
    run_steps(&harness, &mut slice, std::mem::take(&mut steps))
        .expect("the production typed session.updated must authorize Provider input");
    store.record_strict_watch_provider_append(16_000).unwrap();
    store.record_strict_watch_provider_input_closed().unwrap();
    store.record_strict_watch_session_finish_sent().unwrap();
    steps.extend(livetranslate_source_steps());
    steps.extend([
        ScriptStep::Event(with_event_id(
            "event-response-created",
            json!({
                "type":"response.created",
                "response":{
                    "id":"response-audio",
                    "conversation_id":"conversation-1",
                    "object":"realtime.response",
                    "status":"in_progress",
                    "modalities":["audio","text"],
                    "output":[]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-output-added",
            json!({
                "type":"response.output_item.added",
                "response_id":"response-audio",
                "output_index":0,
                "item":{
                    "id":"output-audio",
                    "object":"realtime.item",
                    "type":"message",
                    "status":"in_progress",
                    "role":"assistant",
                    "content":[]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-output-done",
            json!({
                "type":"response.output_item.done",
                "response_id":"response-audio",
                "output_index":0,
                "item":{
                    "id":"output-audio",
                    "object":"realtime.item",
                    "type":"message",
                    "status":"completed",
                    "role":"assistant",
                    "content":[{"type":"audio","text":"文档译音文本"}]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-response-done",
            json!({
                "type":"response.done",
                "response":{
                    "id":"response-audio",
                    "conversation_id":"conversation-1",
                    "object":"realtime.response",
                    "status":"completed",
                    "modalities":["audio","text"],
                    "output":[{
                        "id":"output-audio",
                        "object":"realtime.item",
                        "type":"message",
                        "status":"completed",
                        "role":"assistant",
                        "content":[{"type":"audio","transcript":"文档译音文本"}]
                    }]
                }
            }),
        )),
    ]);
    run_steps(&harness, &mut slice, steps).unwrap();

    let snapshot = store.snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == "source phrase")
        .expect("the normalized response must resolve the production source cue");
    assert!(cue.translation_committed);
    assert_eq!(cue.translated_text, "文档译音文本");
    store
        .record_strict_watch_renderer_cue_submitted(&cue.cue_id, "response-audio")
        .unwrap();
    store
        .record_strict_watch_renderer_ack(
            &cue.cue_id,
            "bridge-translation-status-ack",
            "receipt-audio",
        )
        .unwrap();
    store.record_strict_watch_session_finished_received().unwrap();
    let terminal = store.strict_watch_terminal_lifecycle_snapshot().unwrap();
    assert_eq!(terminal.last_response_terminal.response_id, "response-audio");
    assert_eq!(terminal.final_renderer_ack.cue_id, cue.cue_id);
}
