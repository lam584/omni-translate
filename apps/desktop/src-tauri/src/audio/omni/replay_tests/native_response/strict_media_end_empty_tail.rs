use super::*;

use crate::audio::contracts::WatchSessionReportRuntime;

const MEDIA_SHA256: &str = "cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f";
const AUTHORITATIVE_REFERENCE_FRAMES: u64 = 2_013_045;
const AUTHENTICATED_MEDIA_END_MS: u64 = 125_816;
const OBSERVED_EMPTY_TAIL_START_MS: u64 = 125_900;

fn event(id: &str, mut value: serde_json::Value) -> serde_json::Value {
    value["event_id"] = json!(id);
    value
}

fn activate_strict_livetranslate(harness: &mut ReplayHarness) -> (WorkerSlice, Vec<ScriptStep>) {
    harness.output_mode = OmniOutputMode::TextOnly;
    let client_update =
        crate::audio::omni::protocol::build_omni_session_update_for_provider_with_output_mode(
            &harness.provider,
            "Ethan",
            "",
            RealtimeAudioMode::ServerVad,
            "en",
            "zh-CN",
            OmniOutputMode::TextOnly,
        );
    let provider_authority =
        crate::audio::events::authorize_bailian_native_translate(&harness.provider)
            .expect("strict replay provider must authorize");
    let mut slice = WorkerSlice::new();
    slice.session_ready_for_audio = false;
    slice
        .event_diagnostics
        .livetranslate_server_state
        .record_client_session_update(&provider_authority, &client_update)
        .expect("production session.update parser must bind strict replay");
    let mut echoed_session = client_update["session"].clone();
    echoed_session["id"] = json!("session-strict-tail");
    echoed_session["object"] = json!("realtime.session");
    echoed_session["model"] = json!("qwen3.5-livetranslate-flash-realtime");
    let activation = vec![
        ScriptStep::Event(event(
            "event-session-created",
            json!({
                "type": "session.created",
                "session": {
                    "id": "session-strict-tail",
                    "object": "realtime.session",
                    "model": "qwen3.5-livetranslate-flash-realtime"
                }
            }),
        )),
        ScriptStep::Event(event(
            "event-session-updated",
            json!({ "type": "session.updated", "session": echoed_session }),
        )),
    ];
    (slice, activation)
}

fn completed_empty_tail_steps(
    audio_start_ms: u64,
    include_empty_source_final: bool,
) -> Vec<ScriptStep> {
    let mut steps = vec![
        ScriptStep::Event(event(
            "event-tail-speech-started",
            json!({
                "type": "input_audio_buffer.speech_started",
                "item_id": "item-strict-tail",
                "audio_start_ms": audio_start_ms
            }),
        )),
        ScriptStep::Event(event(
            "event-tail-source-item",
            json!({
                "type": "conversation.item.created",
                "previous_item_id": "previous-item",
                "item": {
                    "id": "item-strict-tail",
                    "object": "realtime.item",
                    "type": "message",
                    "status": "in_progress",
                    "role": "user",
                    "content": []
                }
            }),
        )),
        ScriptStep::Event(event(
            "event-tail-speech-stopped",
            json!({
                "type": "input_audio_buffer.speech_stopped",
                "item_id": "item-strict-tail",
                "audio_end_ms": audio_start_ms + 400
            }),
        )),
        ScriptStep::Event(event(
            "event-tail-response-created",
            json!({
                "type": "response.created",
                "response": {
                    "id": "resp-strict-tail",
                    "conversation_id": "conversation-strict-tail",
                    "object": "realtime.response",
                    "status": "in_progress",
                    "modalities": ["text"],
                    "output": []
                }
            }),
        )),
        ScriptStep::Event(event(
            "event-tail-output-added",
            json!({
                "type": "response.output_item.added",
                "response_id": "resp-strict-tail",
                "output_index": 0,
                "item": {
                    "id": "output-strict-tail",
                    "object": "realtime.item",
                    "type": "message",
                    "status": "in_progress",
                    "role": "assistant",
                    "content": []
                }
            }),
        )),
        ScriptStep::Event(event(
            "event-tail-output-done",
            json!({
                "type": "response.output_item.done",
                "response_id": "resp-strict-tail",
                "output_index": 0,
                "item": {
                    "id": "output-strict-tail",
                    "object": "realtime.item",
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "  " }]
                }
            }),
        )),
        ScriptStep::Event(event(
            "event-tail-response-done",
            json!({
                "type": "response.done",
                "response": {
                    "id": "resp-strict-tail",
                    "conversation_id": "conversation-strict-tail",
                    "object": "realtime.response",
                    "status": "completed",
                    "modalities": ["text"],
                    "output": [{
                        "id": "output-strict-tail",
                        "object": "realtime.item",
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "  " }]
                    }]
                }
            }),
        )),
    ];
    if include_empty_source_final {
        steps.insert(
            3,
            ScriptStep::Event(event(
                "event-tail-source-completed",
                json!({
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item-strict-tail",
                    "content_index": 0,
                    "transcript": "",
                    "language": "",
                    "emotion": ""
                }),
            )),
        );
    }
    steps
}

fn run_to_deferred_tail(
    harness: &ReplayHarness,
    mut socket: ScriptedRealtimeSocket,
    slice: &mut WorkerSlice,
    event_count: usize,
) -> ScriptedRealtimeSocket {
    for _ in 0..event_count {
        socket = harness.tick(socket, slice);
    }
    std::thread::sleep(Duration::from_millis(205));
    harness.tick(socket, slice)
}

fn assert_native_empty_response(report: &WatchSessionReportRuntime) {
    assert!(report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.code == "strict-post-reference-empty-response-omission"));
}

#[test]
fn replay_strict_completed_empty_tail_at_authenticated_media_end_is_ignored() {
    let mut harness = ReplayHarness::new_with_strict_media_end_authority(
        RealtimeAudioMode::ServerVad,
        AUTHORITATIVE_REFERENCE_FRAMES,
        16_000,
        MEDIA_SHA256,
    );
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    steps.extend(completed_empty_tail_steps(
        OBSERVED_EMPTY_TAIL_START_MS,
        true,
    ));
    let event_count = steps.len();
    let socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    let _socket = run_to_deferred_tail(&harness, socket, &mut slice, event_count);

    let snapshot = harness.store().snapshot();
    assert!(snapshot.subtitle_overlay.recent_cues.is_empty());
    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("report");
    assert!(!report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.code == "strict-post-reference-empty-response-omission")
        .expect("strict tail omission must remain auditable");
    assert_eq!(issue.severity, "warning");
    let event = report
        .events
        .iter()
        .find(|event| event.kind == "strict-post-reference-empty-response-omission")
        .expect("strict tail event");
    assert!(event.final_event);
    assert!(event.accepted);
    let detail = event.detail.as_deref().expect("authority detail");
    for evidence in [
        "audioStartMs=125900",
        "mediaEndMs=125816",
        "authoritativeReferenceFrames=2013045",
        "inputSampleRateHz=16000",
        MEDIA_SHA256,
        "runMarker=strict-media-end-run",
        "cellId=pairwise-live::qwen3.5-livetranslate-flash-realtime::echo-cancel::default-speaker",
        "leaseId=strict-media-end-lease",
        "providerInputMaxSamples=2173045",
        "sessionGeneration=1",
    ] {
        assert!(
            detail.contains(evidence),
            "missing audit evidence: {evidence}"
        );
    }
}

#[test]
fn replay_strict_completed_empty_before_authenticated_media_end_remains_failed() {
    let mut harness = ReplayHarness::new_with_strict_media_end_authority(
        RealtimeAudioMode::ServerVad,
        AUTHORITATIVE_REFERENCE_FRAMES,
        16_000,
        MEDIA_SHA256,
    );
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    steps.extend(completed_empty_tail_steps(
        AUTHENTICATED_MEDIA_END_MS - 1,
        true,
    ));
    let event_count = steps.len();
    let socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    let _socket = run_to_deferred_tail(&harness, socket, &mut slice, event_count);

    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("report");
    assert_native_empty_response(&report);
}

#[test]
fn replay_strict_missing_media_end_authority_remains_failed() {
    let mut harness =
        ReplayHarness::new_with_strict_missing_media_end_authority(RealtimeAudioMode::ServerVad);
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    steps.extend(completed_empty_tail_steps(
        OBSERVED_EMPTY_TAIL_START_MS,
        true,
    ));
    let event_count = steps.len();
    let socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    let _socket = run_to_deferred_tail(&harness, socket, &mut slice, event_count);

    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("report");
    assert_native_empty_response(&report);
}

#[test]
fn replay_strict_tail_with_late_nonempty_asr_remains_fail_closed() {
    let mut harness = ReplayHarness::new_with_strict_media_end_authority(
        RealtimeAudioMode::ServerVad,
        AUTHORITATIVE_REFERENCE_FRAMES,
        16_000,
        MEDIA_SHA256,
    );
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    steps.extend(completed_empty_tail_steps(
        OBSERVED_EMPTY_TAIL_START_MS,
        false,
    ));
    steps.push(ScriptStep::Event(event(
        "event-tail-late-source",
        json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-strict-tail",
            "content_index": 0,
            "transcript": "Late source speech.",
            "language": "en",
            "emotion": "neutral"
        }),
    )));
    let event_count = steps.len();
    let socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    let _socket = run_to_deferred_tail(&harness, socket, &mut slice, event_count);

    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("report");
    assert!(report
        .cues
        .iter()
        .any(|cue| cue.source_text == "Late source speech."));
    assert_native_empty_response(&report);
}

#[test]
fn replay_deadline_expired_same_owner_admitted_asr_precedes_empty_tail_flush() {
    let mut harness = ReplayHarness::new_with_strict_media_end_authority(
        RealtimeAudioMode::ServerVad,
        AUTHORITATIVE_REFERENCE_FRAMES,
        16_000,
        MEDIA_SHA256,
    );
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    steps.extend(completed_empty_tail_steps(
        OBSERVED_EMPTY_TAIL_START_MS,
        false,
    ));
    let deferred_event_count = steps.len();
    steps.push(ScriptStep::Event(event(
        "event-tail-late-source-after-deadline",
        json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-strict-tail",
            "content_index": 0,
            "transcript": "Late source speech after deadline.",
            "language": "en",
            "emotion": "neutral"
        }),
    )));
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..deferred_event_count {
        socket = harness.tick(socket, &mut slice);
    }

    std::thread::sleep(Duration::from_millis(125));
    let _socket = harness.tick(socket, &mut slice);

    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("report");
    assert!(report
        .cues
        .iter()
        .any(|cue| cue.source_text == "Late source speech after deadline."));
    assert_native_empty_response(&report);
}

#[test]
fn replay_deadline_expired_wrong_owner_asr_cannot_precede_empty_tail_flush() {
    let mut harness = ReplayHarness::new_with_strict_media_end_authority(
        RealtimeAudioMode::ServerVad,
        AUTHORITATIVE_REFERENCE_FRAMES,
        16_000,
        MEDIA_SHA256,
    );
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    let mut tail_steps = completed_empty_tail_steps(OBSERVED_EMPTY_TAIL_START_MS, true);
    tail_steps.insert(
        tail_steps.len() - 1,
        ScriptStep::Event(event(
            "event-other-source-item",
            json!({
                "type": "conversation.item.created",
                "previous_item_id": "item-strict-tail",
                "item": {
                    "id": "item-other",
                    "object": "realtime.item",
                    "type": "message",
                    "status": "in_progress",
                    "role": "user",
                    "content": []
                }
            }),
        )),
    );
    steps.extend(tail_steps);
    let deferred_event_count = steps.len();
    steps.push(ScriptStep::Event(event(
        "event-other-late-source-after-deadline",
        json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-other",
            "content_index": 0,
            "transcript": "Different item source.",
            "language": "en",
            "emotion": "neutral"
        }),
    )));
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..deferred_event_count {
        socket = harness.tick(socket, &mut slice);
    }

    std::thread::sleep(Duration::from_millis(125));
    let _socket = harness.tick(socket, &mut slice);

    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("report");
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "strict-post-reference-empty-response-omission"));
    assert!(!report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
}

#[test]
fn replay_deadline_expired_malformed_same_owner_asr_flushes_before_error() {
    let mut harness = ReplayHarness::new_with_strict_media_end_authority(
        RealtimeAudioMode::ServerVad,
        AUTHORITATIVE_REFERENCE_FRAMES,
        16_000,
        MEDIA_SHA256,
    );
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen3.5-livetranslate-flash-realtime");
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    steps.extend(completed_empty_tail_steps(
        OBSERVED_EMPTY_TAIL_START_MS,
        false,
    ));
    let deferred_event_count = steps.len();
    steps.push(ScriptStep::Event(event(
        "event-tail-malformed-source-after-deadline",
        json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-strict-tail",
            "transcript": "Malformed source without content index.",
            "language": "en",
            "emotion": "neutral"
        }),
    )));
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..deferred_event_count {
        socket = harness.tick(socket, &mut slice);
    }

    std::thread::sleep(Duration::from_millis(125));
    let error = match harness.try_tick(socket, &mut slice) {
        Ok(_) => panic!("malformed ASR must fail typed admission"),
        Err(error) => error,
    };

    assert!(error.contains("content_index"), "unexpected error: {error}");
    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("report");
    assert_native_empty_response(&report);
}

#[path = "trailing_empty_vad.rs"]
mod trailing_empty_vad;
