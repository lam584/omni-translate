use super::*;

#[test]
fn replay_new_delta_then_unmapped_old_final_isolates_cues() {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    harness.subtitle_translate_active = true;
    let mut slice = WorkerSlice::new();
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-current".to_string());
    slice.last_commit_time = SystemTime::now();

    let current_delta_socket = ScriptedRealtimeSocket::new(
        vec![ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-current",
            "delta": "the current turn in progress"
        }))],
        harness.shared.clone(),
    );
    let current_delta_socket = harness.tick(current_delta_socket, &mut slice);
    let current_cue_id = slice.current_cue_id.clone().expect("current delta cue");
    assert_eq!(slice.pending_source_text, "the current turn in progress");
    assert!(
        !harness
            .store()
            .subtitle_cue_translation_allowed(&current_cue_id),
        "the active manual turn remains deferred until its matching final"
    );

    std::thread::sleep(Duration::from_millis(2));
    let old_final_socket = ScriptedRealtimeSocket::new(
        vec![ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-old-unmapped",
            "transcript": "the late old final"
        }))],
        harness.shared.clone(),
    );
    drop(current_delta_socket);
    let old_final_socket = harness.tick(old_final_socket, &mut slice);

    assert_eq!(slice.current_cue_id.as_deref(), Some(current_cue_id.as_str()));
    assert_eq!(slice.pending_source_text, "the current turn in progress");
    assert!(slice.manual_response_pending);
    assert!(!slice.manual_response_requested);
    assert!(
        !harness.sent_types().iter().any(|kind| kind == "response.create"),
        "an uncorrelated old final must not cross the current turn's gate"
    );

    let snapshot = harness.store().snapshot();
    let current_cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == current_cue_id)
        .expect("current cue remains present");
    assert_eq!(current_cue.source_text, "the current turn in progress");
    assert!(!current_cue.committed);
    let isolated_cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == "the late old final")
        .expect("isolated old final cue");
    assert_ne!(isolated_cue.cue_id, current_cue_id);
    assert!(isolated_cue.committed, "Provider ASR completed owns source finality");
    assert!(harness
        .store()
        .subtitle_source_is_final(&isolated_cue.cue_id));
    assert!(!isolated_cue.translation_committed);
    assert!(isolated_cue.translated_text.is_empty());
    assert_eq!(
        isolated_cue.translation_state,
        Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Pending)
    );
    assert!(
        harness
            .store()
            .subtitle_cue_translation_allowed(&isolated_cue.cue_id),
        "an already-mismatched final has no response gate left to approve it"
    );

    let current_final_socket = ScriptedRealtimeSocket::new(
        vec![ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-current",
            "transcript": "the current turn final"
        }))],
        harness.shared.clone(),
    );
    drop(old_final_socket);
    let _socket = harness.tick(current_final_socket, &mut slice);

    assert!(slice.manual_response_pending);
    assert!(slice.manual_response_requested);
    assert_eq!(
        harness
            .sent_types()
            .iter()
            .filter(|kind| kind.as_str() == "response.create")
            .count(),
        1
    );
    assert!(
        harness
            .store()
            .subtitle_cue_translation_allowed(&current_cue_id),
        "the matching final releases only the current turn's deferred cue"
    );
    let snapshot = harness.store().snapshot();
    let current_cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == current_cue_id)
        .expect("current cue is finalized in place");
    assert_eq!(current_cue.source_text, "the current turn final");
    assert!(current_cue.committed, "the matching ASR completion is a source final");
    assert!(harness.store().subtitle_source_is_final(&current_cue_id));
    assert!(!current_cue.translation_committed);
    assert!(current_cue.translated_text.is_empty());
    assert_eq!(
        current_cue.translation_state,
        Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Pending)
    );
    assert_eq!(
        snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .filter(|cue| cue.source_text == "the late old final")
            .count(),
        1,
        "the late final remains isolated after the current turn completes"
    );
}
