use super::*;

fn previous_steps() -> Vec<ScriptStep> {
    completed_empty_tail_steps(60_000, true).into_iter().map(|step| {
        let ScriptStep::Event(value) = step else { unreachable!() };
        let mut value: Value = serde_json::from_str(&value.to_string()
            .replace("strict-tail", "previous")
            .replace("event-tail", "event-previous")).unwrap();
        match value["type"].as_str().unwrap() {
            "input_audio_buffer.speech_stopped" => value["audio_end_ms"] = json!(67_920),
            "conversation.item.input_audio_transcription.completed" => {
                value["transcript"] = json!("Previous committed source.");
            }
            "response.output_item.done" => value["item"]["content"][0]["text"] = json!("前驱译文。"),
            "response.done" => value["response"]["output"][0]["content"][0]["text"] = json!("前驱译文。"),
            _ => {}
        }
        ScriptStep::Event(value)
    }).collect()
}

fn tail_steps() -> Vec<ScriptStep> {
    let mut steps = completed_empty_tail_steps(67_920, true);
    for step in &mut steps {
        if let ScriptStep::Event(value) = step {
            if value["type"] == "input_audio_buffer.speech_stopped" {
                value["audio_end_ms"] = json!(69_360);
            }
        }
    }
    steps
}

fn replay(previous: Vec<ScriptStep>, tail: Vec<ScriptStep>) -> (ReplayHarness, WorkerSlice) {
    replay_model(previous, tail, false)
}

fn replay_model(previous: Vec<ScriptStep>, tail: Vec<ScriptStep>, v2: bool) -> (ReplayHarness, WorkerSlice) {
    // This case is before the media end: no post-reference omission authority.
    let mut harness = ReplayHarness::new_with_strict_missing_media_end_authority(RealtimeAudioMode::ServerVad);
    if v2 {
        harness.provider.model = "qwen3.8-livetranslate-flash-realtime".to_string();
        harness.provider.base_url = "https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1".to_string();
        // These are parsed socket replays, not external input/paid-budget calls.
        harness.provider_input_budget = ProviderInputBudget::disabled_for_test();
    }
    harness.store().watch_session_report.begin_or_reuse("dashscope", &harness.provider.model);
    let (mut slice, mut steps) = activate_strict_livetranslate(&mut harness);
    if v2 {
        for step in &mut steps {
            if let ScriptStep::Event(value) = step {
                value["session"]["model"] = json!("qwen3.8-livetranslate-flash-realtime");
            }
        }
    }
    steps.extend(previous);
    steps.extend(tail);
    let count = steps.len();
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..count { socket = harness.tick(socket, &mut slice); }
    (harness, slice)
}

fn idle_after_old_deadline(harness: &ReplayHarness, slice: &mut WorkerSlice) {
    std::thread::sleep(Duration::from_millis(205));
    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Idle], harness.shared.clone());
    let _ = harness.tick(socket, slice);
}

fn assert_no_terminal_error(harness: &ReplayHarness) {
    let report = harness.store().watch_session_report.snapshot().unwrap();
    assert!(!report.cues.iter().flat_map(|cue| &cue.issues).chain(report.issues.iter())
        .any(|issue| matches!(issue.code.as_str(), "native-empty-response" | "translation-terminal-error")));
    assert!(!harness.store().snapshot().subtitle_overlay.recent_cues.iter().any(|cue| {
        cue.translation_state == Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
    }));
}

fn assert_previous_final(harness: &ReplayHarness) {
    let snapshot = harness.store().snapshot();
    let previous = snapshot.subtitle_overlay.recent_cues.iter()
        .find(|cue| cue.source_text == "Previous committed source.").expect("previous source retained");
    assert!(previous.committed && previous.translation_committed);
    assert_eq!(previous.translated_text, "前驱译文。");
    assert!(harness.store().subtitle_source_is_final(&previous.cue_id));
}

#[test]
fn replay_trailing_empty_vad_67920_69360_survives_old_deadline_without_boundary() {
    let (harness, mut slice) = replay(previous_steps(), tail_steps());
    assert_previous_final(&harness);
    idle_after_old_deadline(&harness, &mut slice);
    assert_no_terminal_error(&harness);
    assert_previous_final(&harness);
    assert_eq!(harness.store().snapshot().subtitle_overlay.recent_cues.len(), 2,
        "no lifecycle boundary means no discard, even after the old deadline");
}

fn dispatch(harness: &ReplayHarness, slice: &mut WorkerSlice, steps: Vec<ScriptStep>) {
    let count = steps.len();
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..count { socket = harness.tick(socket, slice); }
}

fn input_fence(harness: &ReplayHarness, slice: &mut WorkerSlice) {
    crate::audio::omni::protocol::resolve_trailing_empty_vad_on_input_fence(
        &harness.handle(), &harness.store(), &mut slice.event_diagnostics,
    );
}

fn omission_count(harness: &ReplayHarness) -> usize {
    harness.store().watch_session_report.snapshot().unwrap().issues.iter()
        .filter(|issue| issue.code == "trailing-empty-vad").count()
}

fn assert_failed_tail(harness: &ReplayHarness) {
    assert_native_empty_response(&harness.store().watch_session_report.snapshot().unwrap());
    assert_eq!(omission_count(harness), 0);
}

fn next_speech() -> ScriptStep {
    ScriptStep::Event(event("next-speech", json!({
        "type":"input_audio_buffer.speech_started", "item_id":"item-next", "audio_start_ms":70_000
    })))
}

#[test]
fn replay_trailing_empty_vad_67920_69360_discards_only_at_input_fence() {
    let (harness, mut slice) = replay(previous_steps(), tail_steps());
    idle_after_old_deadline(&harness, &mut slice);
    assert_no_terminal_error(&harness);
    assert_eq!(omission_count(&harness), 0);
    input_fence(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_no_terminal_error(&harness);
    assert_previous_final(&harness);
    assert_eq!(harness.store().snapshot().subtitle_overlay.recent_cues.len(), 1);
    assert_eq!(omission_count(&harness), 1, "boundary resolution is exactly once");
}

#[test]
fn replay_trailing_empty_vad_67920_69360_discards_only_on_continuity_switch() {
    let (harness, mut slice) = replay(previous_steps(), tail_steps());
    idle_after_old_deadline(&harness, &mut slice);
    assert_eq!(omission_count(&harness), 0);
    slice.event_diagnostics.last_asr_completed_at_ms = None;
    dispatch(&harness, &mut slice, vec![next_speech()]);
    assert_no_terminal_error(&harness);
    assert_previous_final(&harness);
    assert_eq!(omission_count(&harness), 1);
}

#[test]
fn replay_trailing_empty_vad_same_continuity_speech_is_not_a_resolution_boundary() {
    let (harness, mut slice) = replay(previous_steps(), tail_steps());
    idle_after_old_deadline(&harness, &mut slice);
    slice.event_diagnostics.last_asr_completed_at_ms = Some(elapsed_ms_since(&harness.session_started_at));
    dispatch(&harness, &mut slice, vec![next_speech()]);
    assert_no_terminal_error(&harness);
    assert_eq!(omission_count(&harness), 0);
    input_fence(&harness, &mut slice);
    assert_eq!(omission_count(&harness), 1);
    assert_previous_final(&harness);
}

#[test]
fn replay_trailing_empty_vad_input_fence_before_response_done_resolves_when_evidence_completes() {
    let mut tail = tail_steps();
    let done = tail.pop().unwrap();
    let (harness, mut slice) = replay(previous_steps(), tail);
    input_fence(&harness, &mut slice);
    assert_eq!(omission_count(&harness), 0);
    dispatch(&harness, &mut slice, vec![done]);
    assert_eq!(omission_count(&harness), 1);
    assert_no_terminal_error(&harness);
    assert_previous_final(&harness);
}

#[test]
fn replay_trailing_empty_vad_nonmatching_predecessor_boundary_fails() {
    for start in [67_919, 67_921] {
        let mut tail = tail_steps();
        if let ScriptStep::Event(value) = &mut tail[0] { value["audio_start_ms"] = json!(start); }
        let (harness, mut slice) = replay(previous_steps(), tail);
        idle_after_old_deadline(&harness, &mut slice);
        input_fence(&harness, &mut slice);
        assert_failed_tail(&harness);
        assert_previous_final(&harness);
    }
}

#[test]
fn replay_trailing_empty_vad_standalone_1440ms_is_not_a_duration_exception() {
    let (harness, mut slice) = replay(Vec::new(), tail_steps());
    idle_after_old_deadline(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
}

#[test]
fn replay_trailing_empty_vad_nonempty_asr_snapshot_then_empty_final_fails() {
    let mut tail = tail_steps();
    tail.insert(3, ScriptStep::Event(event("tail-nonempty-asr", json!({
        "type":"conversation.item.input_audio_transcription.text", "item_id":"item-strict-tail",
        "content_index":0, "text":"Real source delta.", "stash":"", "language":"en", "emotion":"neutral"
    }))));
    let (harness, mut slice) = replay(previous_steps(), tail);
    idle_after_old_deadline(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
    assert_previous_final(&harness);
}

#[test]
fn replay_trailing_empty_vad_discarded_partial_translation_fails() {
    let mut tail = tail_steps();
    let before_done = tail.iter().position(|step| matches!(step,
        ScriptStep::Event(value) if value["type"] == "response.output_item.done")).unwrap();
    tail.splice(before_done..before_done, [
        ScriptStep::Event(event("tail-content-added", json!({
            "type":"response.content_part.added", "response_id":"resp-strict-tail", "item_id":"output-strict-tail",
            "output_index":0, "content_index":0, "part":{"type":"text", "text":""}
        }))),
        ScriptStep::Event(event("tail-partial-translation", json!({
            "type":"response.text.text", "response_id":"resp-strict-tail", "item_id":"output-strict-tail",
            "output_index":0, "content_index":0, "text":"不能忽略的部分译文", "stash":""
        }))),
        ScriptStep::Event(event("tail-empty-text-done", json!({
            "type":"response.text.done", "response_id":"resp-strict-tail", "item_id":"output-strict-tail",
            "output_index":0, "content_index":0, "text":""
        }))),
        ScriptStep::Event(event("tail-content-done", json!({
            "type":"response.content_part.done", "response_id":"resp-strict-tail", "item_id":"output-strict-tail",
            "output_index":0, "content_index":0, "part":{"type":"text", "text":""}
        }))),
    ]);
    let (harness, mut slice) = replay(previous_steps(), tail);
    idle_after_old_deadline(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
    assert_previous_final(&harness);
}

#[test]
fn replay_trailing_empty_vad_failed_predecessor_does_not_authorize_discard() {
    let mut previous = previous_steps();
    if let Some(ScriptStep::Event(value)) = previous.last_mut() { value["response"]["status"] = json!("failed"); }
    let (harness, mut slice) = replay(previous, tail_steps());
    idle_after_old_deadline(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
}

#[test]
fn replay_trailing_empty_vad_uncommitted_predecessor_source_does_not_authorize_discard() {
    let mut previous = previous_steps();
    for step in &mut previous {
        if let ScriptStep::Event(value) = step {
            if value["type"] == "conversation.item.input_audio_transcription.completed" {
                value["type"] = json!("conversation.item.input_audio_transcription.text");
                value["text"] = json!("Previous committed source.");
                value["stash"] = json!("");
                value["language"] = json!("en");
                value["emotion"] = json!("neutral");
                value.as_object_mut().unwrap().remove("transcript");
            }
        }
    }
    let (harness, mut slice) = replay(previous, tail_steps());
    idle_after_old_deadline(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
}

#[test]
fn replay_trailing_empty_vad_missing_empty_asr_completion_fails() {
    let tail = tail_steps().into_iter().filter(|step| !matches!(step,
        ScriptStep::Event(value) if value["type"] == "conversation.item.input_audio_transcription.completed")).collect();
    let (harness, mut slice) = replay(previous_steps(), tail);
    idle_after_old_deadline(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
}

#[test]
fn replay_trailing_empty_vad_nonempty_current_translation_is_preserved() {
    let mut tail = tail_steps();
    for step in &mut tail {
        if let ScriptStep::Event(value) = step {
            match value["type"].as_str().unwrap() {
                "response.output_item.done" => value["item"]["content"][0]["text"] = json!("保留这条译文。"),
                "response.done" => value["response"]["output"][0]["content"][0]["text"] = json!("保留这条译文。"),
                _ => {}
            }
        }
    }
    let (harness, mut slice) = replay(previous_steps(), tail);
    idle_after_old_deadline(&harness, &mut slice);
    input_fence(&harness, &mut slice);
    assert_eq!(omission_count(&harness), 0);
    assert!(harness.store().snapshot().subtitle_overlay.recent_cues.iter()
        .any(|cue| cue.translated_text == "保留这条译文。" && cue.translation_committed));
    assert_previous_final(&harness);
}

#[test]
fn replay_trailing_empty_vad_late_ownership_contradiction_fails_closed() {
    let (harness, mut slice) = replay(previous_steps(), tail_steps());
    idle_after_old_deadline(&harness, &mut slice);
    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Event(event("bad-tail-owner", json!({
        "type":"response.output_item.done", "response_id":"resp-strict-tail", "output_index":0,
        "item":{"id":"different-output-owner", "object":"realtime.item", "type":"message",
            "status":"completed", "role":"assistant", "content":[]}
    })))], harness.shared.clone());
    assert!(harness.try_tick(socket, &mut slice).is_err());
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
    assert_previous_final(&harness);
}

#[test]
fn replay_trailing_empty_vad_v2_67920_69360_and_nonempty_asr_delta_counterexample() {
    for nonempty_delta in [false, true] {
        let mut tail = tail_steps();
        if nonempty_delta {
            tail.insert(3, ScriptStep::Event(event("v2-tail-nonempty-asr-delta", json!({
                "type":"conversation.item.input_audio_transcription.delta", "item_id":"item-strict-tail",
                "content_index":0, "delta":"A real source fragment."
            }))));
        }
        let (harness, mut slice) = replay_model(previous_steps(), tail, true);
        idle_after_old_deadline(&harness, &mut slice);
        input_fence(&harness, &mut slice);
        if nonempty_delta {
            assert_failed_tail(&harness);
        } else {
            assert_no_terminal_error(&harness);
            assert_eq!(omission_count(&harness), 1);
        }
        assert_previous_final(&harness);
    }
}

#[test]
fn replay_trailing_empty_vad_late_nonempty_asr_after_candidate_is_fail_closed() {
    let (harness, mut slice) = replay_model(previous_steps(), tail_steps(), true);
    idle_after_old_deadline(&harness, &mut slice);
    assert_no_terminal_error(&harness);
    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Event(event("late-asr-delta", json!({
        "type":"conversation.item.input_audio_transcription.delta", "item_id":"item-strict-tail",
        "content_index":0, "delta":"Late real source."
    })))], harness.shared.clone());
    assert!(harness.try_tick(socket, &mut slice).is_err(), "typed terminal must reject late ASR");
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
    assert_previous_final(&harness);
}

#[test]
fn replay_trailing_empty_vad_predecessor_failure_after_candidate_cancels_omission() {
    let (harness, mut slice) = replay(previous_steps(), tail_steps());
    let previous = harness.store().snapshot().subtitle_overlay.recent_cues.iter()
        .find(|cue| cue.source_text == "Previous committed source.").unwrap().cue_id.clone();
    // Final translations are immutable. A real source revision first reopens
    // translation; its later failure invalidates the captured predecessor proof.
    harness.store().update_or_push_stt_cue(&previous, "Revised predecessor source.", true);
    harness.store().mark_current_subtitle_translation_error(&previous, "predecessor failure".to_string());
    assert!(harness.store().snapshot().subtitle_overlay.recent_cues.iter().any(|cue| {
        cue.cue_id == previous && !cue.translation_committed
            && cue.translation_state == Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
    }));
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
}

#[test]
fn replay_trailing_empty_vad_missing_offsets_are_rejected_before_candidate() {
    for missing in ["audio_start_ms", "audio_end_ms"] {
        let (harness, mut slice) = replay(previous_steps(), Vec::new());
        let mut tail = tail_steps();
        let index = tail.iter().position(|step| matches!(step,
            ScriptStep::Event(value) if value.get(missing).is_some())).unwrap();
        if let ScriptStep::Event(value) = &mut tail[index] { value.as_object_mut().unwrap().remove(missing); }
        let mut socket = ScriptedRealtimeSocket::new(tail, harness.shared.clone());
        for _ in 0..index { socket = harness.tick(socket, &mut slice); }
        assert!(harness.try_tick(socket, &mut slice).is_err());
        input_fence(&harness, &mut slice);
        assert_eq!(omission_count(&harness), 0);
        assert_previous_final(&harness);
    }
}

#[test]
fn replay_trailing_empty_vad_current_visible_output_cancels_candidate() {
    let (harness, mut slice) = replay(previous_steps(), tail_steps());
    let current = slice.event_diagnostics.native_response_cue_for_input_item("item-strict-tail")
        .expect("completed owner remains addressable");
    harness.store().update_subtitle_cue_translation(&current, "Visible partial output".to_string(), false);
    input_fence(&harness, &mut slice);
    assert_failed_tail(&harness);
    assert_previous_final(&harness);
}
