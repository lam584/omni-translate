use super::*;

#[test]
fn replay_livetranslate_text_only_events_publish_text_and_stash_then_final_text() {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.output_mode = OmniOutputMode::TextOnly;
    let mut slice = WorkerSlice::new();
    let source = "Good morning.";
    let translated = "早上好。";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-text-only",
            "delta": source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-text-only",
            "transcript": source
        })),
        ScriptStep::Event(json!({
            "type": "response.text.text",
            "text": "早上",
            "stash": "好"
        })),
        ScriptStep::Event(json!({
            "type": "response.text.done",
            "text": translated
        })),
        ScriptStep::Event(json!({ "type": "response.done" })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..5 {
        socket = harness.tick(socket, &mut slice);
    }
    assert_eq!(slice.pending_translated_text, "早上好");

    socket = harness.tick(socket, &mut slice);
    assert_eq!(slice.pending_translated_text, translated);
    let _socket = harness.tick(socket, &mut slice);

    let snapshot = harness.store().snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source)
        .expect("text-only response should stay attached to its source cue");
    assert!(cue.committed);
    assert_eq!(cue.translated_text, translated);
}

/// Replay 1 — commit → reconnect → the OLD item's transcription.completed.
/// The reconnect voids the awaited item; the late completed event must still
/// complete a display cue while the gate never arms response.create for it.
#[test]
fn replay_commit_then_reconnect_then_old_item_completed() {
    let harness = ReplayHarness::new(
        RealtimeAudioMode::Manual,
        vec![vec![
            ScriptStep::Event(json!({ "type": "session.updated", "session": { "id": "s2" } })),
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "item-old",
                "transcript": "the tail of the pre-reconnect turn"
            })),
        ]],
    );
    let mut slice = WorkerSlice::new();
    // Post-commit state: the gate awaits item-old on the OLD session.
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-old".to_string());

    // Tick 1: the provider closes the socket → reconnect + gate reset.
    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Close], harness.shared.clone());
    let socket = harness.tick(socket, &mut slice);
    assert_eq!(harness.shared.lock().unwrap().reconnect_count, 1);
    assert!(!slice.manual_response_pending, "reconnect must drop the manual gate");
    assert!(slice.manual_response_item_id.is_none());
    assert!(
        !slice.session_ready_for_audio,
        "audio must wait for the new session to confirm"
    );

    // Tick 2: the new session confirms.
    let socket = harness.tick(socket, &mut slice);
    assert!(slice.session_ready_for_audio, "session.updated re-arms audio");

    // Tick 3: the OLD item's transcription arrives on the NEW session.
    let _socket = harness.tick(socket, &mut slice);

    let snapshot = harness.store().snapshot();
    let cue_texts = cue_source_texts(&snapshot);
    assert!(
        cue_texts.iter().any(|text| text.contains("the tail of the pre-reconnect turn")),
        "late completed transcription must reach the overlay; cues: {cue_texts:?}"
    );
    assert!(
        !harness.sent_types().iter().any(|kind| kind == "response.create"),
        "a stale item must never arm response.create; sent: {:?}",
        harness.sent_types()
    );
    assert!(!slice.manual_response_pending, "gate stays closed at end of replay");
}

/// Replay 2 — speech_started → delta → disconnect → reconnect → delta.
/// The pre-reconnect uncommitted cue must not absorb the post-reconnect turn:
/// the new delta opens a NEW cue and the stale uncommitted cue is discarded.
#[test]
fn replay_streaming_turn_across_a_reconnect() {
    let harness = ReplayHarness::new(
        RealtimeAudioMode::ServerVad,
        vec![vec![
            ScriptStep::Event(json!({ "type": "session.updated", "session": { "id": "s2" } })),
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.delta",
                "item_id": "item-new",
                "delta": "the new turn after reconnect"
            })),
        ]],
    );
    let mut slice = WorkerSlice::new();

    let socket = ScriptedRealtimeSocket::new(
        vec![
            ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.delta",
                "item_id": "item-pre",
                "delta": "half a pre-reconnect sent"
            })),
            ScriptStep::Close,
        ],
        harness.shared.clone(),
    );

    let socket = harness.tick(socket, &mut slice); // speech_started → new cue
    let first_cue_id = slice.current_cue_id.clone().expect("speech_started opens a cue");
    let socket = harness.tick(socket, &mut slice); // delta streams into the cue
    assert_eq!(slice.pending_source_text, "half a pre-reconnect sent");

    let socket = harness.tick(socket, &mut slice); // disconnect → reconnect + reset
    assert_eq!(harness.shared.lock().unwrap().reconnect_count, 1);
    assert!(slice.current_cue_id.is_none(), "reconnect releases the streaming cue");
    assert!(!slice.session_ready_for_audio);
    let after_reset = harness.store().snapshot();
    assert!(
        !after_reset
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == first_cue_id && !cue.committed),
        "the stale uncommitted cue must be discarded on reconnect"
    );

    let socket = harness.tick(socket, &mut slice); // session.updated on the new socket
    assert!(slice.session_ready_for_audio);
    let _socket = harness.tick(socket, &mut slice); // post-reconnect delta

    let second_cue_id = slice.current_cue_id.clone().expect("new delta opens a new cue");
    assert_ne!(first_cue_id, second_cue_id, "turns must not merge across a reconnect");
    assert_eq!(slice.pending_source_text, "the new turn after reconnect");
    let snapshot = harness.store().snapshot();
    assert!(
        snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == second_cue_id && cue.source_text.contains("the new turn")),
        "the post-reconnect turn must stream into its own cue"
    );
}

