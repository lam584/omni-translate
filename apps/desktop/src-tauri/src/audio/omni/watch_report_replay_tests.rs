use std::time::SystemTime;

use serde_json::{json, Value};
use tauri::Manager;

use super::connection_coordinator::{
    completed_manual_response_decision, ManualResponseDecision,
};
use super::{OmniAsrEventProcessor, OmniAsrEventState, OmniEventDiagnostics};
use crate::audio::state::AudioStateStore;

const CONTENT_GATE_REPLAY: &str = include_str!(
    "../../../fixtures/session-traces/watch-2026-08-09-content-gate-replay.json"
);

fn initial_asr_state() -> OmniAsrEventState {
    OmniAsrEventState {
        last_vad_event_time: SystemTime::now(),
        vad_event_count: 0,
        current_cue_id: None,
        pending_source_text: String::new(),
        pending_translated_text: String::new(),
        pending_audio_buffer: Vec::new(),
        transcription_completed_flag: false,
        transcription_completed_at: None,
        event_diagnostics: OmniEventDiagnostics::default(),
    }
}

#[test]
fn real_watch_timing_replay_runs_through_asr_processor_and_keeps_every_source() {
    let fixture: Value = serde_json::from_str(CONTENT_GATE_REPLAY).expect("valid replay fixture");
    assert_eq!(fixture["schemaVersion"].as_u64(), Some(2));
    let events = fixture["events"].as_array().expect("fixture events");
    let expected_sources = fixture["expectedCompletedSources"]
        .as_array()
        .expect("expected completed sources")
        .iter()
        .map(|source| source.as_str().expect("expected source text"))
        .collect::<Vec<_>>();
    let expected_raw_provider_finals = events
        .iter()
        .filter(|event| event["kind"].as_str() == Some("completed"))
        .map(|event| event["text"].as_str().expect("completed provider text"))
        .collect::<Vec<_>>();

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock tauri app");
    app.manage(AudioStateStore::new());
    let handle = app.handle().clone();
    let store = handle.state::<AudioStateStore>();
    store
        .watch_session_report
        .begin_or_reuse("de-identified-fixture", "timing-replay");
    let session_started_at = SystemTime::now();
    let mut state = initial_asr_state();
    let mut completed_sources = Vec::new();
    let mut previous_offset = None;
    let mut empty_provider_completion_count = 0;

    for event in events {
        let offset_ms = event["offsetMs"].as_u64().expect("event offset");
        if let Some(previous) = previous_offset {
            assert!(offset_ms >= previous, "fixture events must stay ordered");
        }
        previous_offset = Some(offset_ms);

        let item_id = event["itemId"].as_str().expect("provider item id");
        let kind = event["kind"].as_str().expect("event kind");
        let text = event["text"].as_str().expect("event text");
        let (event_type, provider_event) = match kind {
            "delta" => (
                "conversation.item.input_audio_transcription.delta",
                json!({
                    "type": "conversation.item.input_audio_transcription.delta",
                    "item_id": item_id,
                    "delta": text,
                }),
            ),
            "completed" => {
                if text.trim().is_empty() {
                    empty_provider_completion_count += 1;
                }
                (
                    "conversation.item.input_audio_transcription.completed",
                    json!({
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": item_id,
                        "transcript": text,
                    }),
                )
            }
            unexpected => panic!("unexpected replay event kind: {unexpected}"),
        };

        let output = OmniAsrEventProcessor::process(
            state,
            &handle,
            &store,
            "inbound",
            &provider_event,
            event_type,
            &session_started_at,
            true,
            false,
            false,
            0,
            None,
            None,
            0,
            0,
        );
        if kind == "completed" {
            let resolved = output
                .completed_source_text
                .as_deref()
                .expect("completed event must return its effective source");
            assert_eq!(
                completed_manual_response_decision(
                    true,
                    Some(item_id),
                    Some(item_id),
                    Some(resolved),
                ),
                Some(ManualResponseDecision::Create),
                "real Watch source must cross the response gate at offset {offset_ms}",
            );
            completed_sources.push(resolved.to_string());
        }
        state = output.state;
    }

    assert_eq!(empty_provider_completion_count, 1);
    assert_eq!(previous_offset, Some(56_281));
    assert_eq!(completed_sources, expected_sources);

    let overlay_snapshot = store.snapshot();
    let overlay_sources = overlay_snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .map(|cue| cue.source_text.as_str())
        .collect::<Vec<_>>();
    for source in &expected_sources {
        assert_eq!(
            overlay_sources.iter().filter(|candidate| *candidate == source).count(),
            1,
            "ASR processor/cue store must retain source: {source:?}",
        );
    }

    let report = store
        .watch_session_report
        .snapshot()
        .expect("active replay report");
    let final_provider_sources = report
        .events
        .iter()
        .filter(|event| {
            event.stage == "source"
                && event.kind == "conversation.item.input_audio_transcription.completed"
                && event.final_event
                && event.accepted
        })
        .map(|event| event.text.as_str())
        .collect::<Vec<_>>();
    assert_eq!(final_provider_sources, expected_raw_provider_finals);

    let serialized = serde_json::to_string(&report).expect("serialize replay report");
    for forbidden in [
        ["echo", "suppressed"].join("-"),
        ["echo", "chain", "fragment"].join("-"),
    ] {
        assert!(
            !serialized.contains(&forbidden),
            "new report writer must not emit historical content-drop state: {forbidden}",
        );
    }
}
