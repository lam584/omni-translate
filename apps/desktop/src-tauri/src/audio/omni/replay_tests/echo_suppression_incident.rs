use serde_json::Value;

use super::*;

const ECHO_SUPPRESSION_INCIDENT_REPLAY: &str = include_str!(
    "../../../../fixtures/session-traces/watch-2026-08-09-echo-suppression-incident-replay.json"
);

fn response_create_count(harness: &ReplayHarness) -> usize {
    harness
        .sent_types()
        .iter()
        .filter(|kind| kind.as_str() == "response.create")
        .count()
}

fn set_speaker_playback(harness: &ReplayHarness, context: &str) {
    let store = harness.store();
    store.update_speech(|speech| {
        speech.dispatch_state = "playing".to_string();
        speech.output_target = "speaker".to_string();
    });
    assert!(store.inbound_speaker_playback_active());
    if context == "recent" {
        // Establish the same post-playback telemetry window that the runtime
        // logs beside a final. It is deliberately not an ASR/text gate.
        store.update_speech(|speech| {
            speech.dispatch_state = "waiting-subtitle".to_string();
        });
        assert_eq!(
            store.inbound_speaker_playback_context(Duration::from_secs(4)),
            (false, true),
        );
    }
}

/// Regression authority for the 14 `echo-suppressed` events in the Plus
/// Watch incident.  This crosses the real manual gate, cue ownership, output
/// publication and completion handling instead of only testing the content
/// classification helper.  Playback state is exercised as diagnostic context
/// in both its active and four-second post-playback forms.
#[test]
fn replay_historical_echo_suppression_shapes_publish_every_non_empty_final_once() {
    let fixture: Value = serde_json::from_str(ECHO_SUPPRESSION_INCIDENT_REPLAY)
        .expect("valid de-identified incident replay fixture");
    assert_eq!(fixture["schemaVersion"].as_u64(), Some(1));
    assert_eq!(
        fixture["incidentId"].as_str(),
        Some("watch-2026-08-09-echo-suppression"),
    );
    let events = fixture["events"].as_array().expect("incident events");
    assert_eq!(events.len(), 14, "fixture must cover all historical rejects");

    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("de-identified-incident", "qwen3.5-omni-plus-realtime");
    let mut slice = WorkerSlice::new();
    let mut previous_offset = 0;
    let mut reasons = std::collections::BTreeSet::new();
    let mut processed_count = 0;

    for event in events {
        let offset_ms = event["offsetMs"].as_u64().expect("ordered offset");
        assert!(offset_ms >= previous_offset, "fixture offsets must be ordered");
        previous_offset = offset_ms;
        let item_id = event["itemId"].as_str().expect("item id");
        let reason = event["historicalReason"].as_str().expect("historical reason");
        let playback_context = event["playbackContext"].as_str().expect("playback context");
        let source = event["source"].as_str().expect("non-empty source");
        let translation = event["translation"].as_str().expect("translation");
        assert!(!source.trim().is_empty());
        reasons.insert(reason);
        processed_count += 1;
        set_speaker_playback(&harness, playback_context);

        // This is the exact gate state after a committed one-second manual
        // input buffer. The scripted socket then replays a provider duplicate
        // before response.created, text completion and response.done.
        slice.manual_response_pending = true;
        slice.manual_response_requested = false;
        slice.manual_response_item_id = Some(item_id.to_string());
        slice.sent_audio_since_commit = true;
        slice.manual_turn_audio_after_response = true;
        slice.audio_samples_since_commit = MANUAL_COMMIT_MIN_AUDIO_SAMPLES;
        slice.manual_turn_started_at = Some(backdated(MANUAL_COMMIT_INTERVAL_SECS));
        let socket = ScriptedRealtimeSocket::new(
            vec![
                ScriptStep::Event(json!({
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": item_id,
                    "transcript": source,
                })),
                ScriptStep::Event(json!({
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": item_id,
                    "transcript": source,
                })),
                ScriptStep::Event(json!({
                    "type": "response.created",
                    "response": { "id": format!("response-{item_id}") },
                })),
                ScriptStep::Event(json!({
                    "type": "response.text.delta",
                    "response_id": format!("response-{item_id}"),
                    "delta": translation,
                })),
                ScriptStep::Event(json!({
                    "type": "response.text.done",
                    "response_id": format!("response-{item_id}"),
                    "text": translation,
                })),
                ScriptStep::Event(json!({
                    "type": "response.done",
                    "response": { "id": format!("response-{item_id}"), "status": "completed" },
                })),
            ],
            harness.shared.clone(),
        );

        let socket = harness.tick(socket, &mut slice);
        assert_eq!(response_create_count(&harness), processed_count);
        assert!(slice.manual_response_requested, "non-empty final must claim one response");
        let socket = harness.tick(socket, &mut slice);
        assert_eq!(
            response_create_count(&harness),
            processed_count,
            "duplicate completed event must not create a second response",
        );
        let socket = harness.tick(socket, &mut slice);
        let socket = harness.tick(socket, &mut slice);
        let socket = harness.tick(socket, &mut slice);
        let _socket = harness.tick(socket, &mut slice);
        assert!(!slice.manual_response_pending, "response.done must release this item");
    }

    assert_eq!(
        reasons,
        std::collections::BTreeSet::from([
            "recent-output-echo",
            "echo-chain-fragment",
            "short-cjk-output-echo",
        ]),
    );
    let snapshot = harness.store().snapshot();
    for event in events {
        let source = event["source"].as_str().unwrap();
        let translation = event["translation"].as_str().unwrap();
        let matching = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .filter(|cue| cue.source_text == source)
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1, "source must retain one cue: {source:?}");
        let cue = matching[0];
        assert!(cue.committed, "cue must be published: {source:?}");
        assert!(cue.translation_committed, "translation must be final: {source:?}");
        assert_eq!(cue.translated_text, translation);
    }

    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("incident replay watch report");
    let serialized = serde_json::to_string(&report).expect("serialize incident report");
    for forbidden in [
        "recent-output-echo",
        "echo-chain-fragment",
        "short-cjk-output-echo",
        "native-playback-queue-expired",
        "native-playback-queue-overflow",
        "native-playback-stream-stale-dropped",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "normal incident replay must not emit {forbidden}",
        );
    }
}
