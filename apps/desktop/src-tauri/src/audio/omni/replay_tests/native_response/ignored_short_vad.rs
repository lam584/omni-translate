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

fn contiguous_empty_vad_steps(next_start_ms: Option<u64>) -> Vec<ScriptStep> {
    let mut steps = vec![
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "item-empty-split",
            "audio_start_ms": 22060
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-empty-split",
            "transcript": ""
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_stopped",
            "item_id": "item-empty-split",
            "audio_end_ms": 22320
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "resp-empty-split",
                "input_item_id": "item-empty-split",
                "status": "completed",
                "output": [{
                    "status": "completed",
                    "content": [{ "type": "text", "text": "   " }]
                }]
            }
        })),
    ];
    if let Some(audio_start_ms) = next_start_ms {
        steps.push(ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "item-continuation",
            "audio_start_ms": audio_start_ms
        })));
    }
    steps
}

fn report_has_native_empty_response(harness: &ReplayHarness) -> bool {
    harness.store().watch_session_report.snapshot()
        .expect("replay should retain a report").cues.iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response")
}

#[test]
fn replay_contiguous_same_continuity_260ms_empty_vad_split_is_ignored() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(Some(22320)), harness.shared.clone());
    for _ in 0..5 { socket = harness.tick(socket, &mut slice); }
    assert!(
        !report_has_native_empty_response(&harness),
        "report={:?} diagnostics={:?}",
        harness.store().watch_session_report.snapshot(),
        slice.event_diagnostics,
    );
    let snapshot = harness.store().snapshot();
    assert!(!snapshot.subtitle_overlay.recent_cues.iter().any(|cue| cue.translation_state == Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)));
}

#[test]
fn replay_contiguous_empty_vad_successor_arriving_5ms_after_defer_deadline_is_ignored() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(None), harness.shared.clone());
    for _ in 0..4 { socket = harness.tick(socket, &mut slice); }

    std::thread::sleep(std::time::Duration::from_millis(125));
    socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Event(json!({
        "type": "input_audio_buffer.speech_started",
        "item_id": "item-continuation",
        "audio_start_ms": 22320
    }))], harness.shared.clone());
    let _socket = harness.tick(socket, &mut slice);

    assert!(
        !report_has_native_empty_response(&harness),
        "an already-buffered contiguous server boundary must win over the local expiry timer: report={:?} diagnostics={:?}",
        harness.store().watch_session_report.snapshot(),
        slice.event_diagnostics,
    );
}

#[test]
fn replay_expired_empty_vad_is_not_starved_by_successful_non_speech_frames() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(None), harness.shared.clone());
    for _ in 0..4 { socket = harness.tick(socket, &mut slice); }

    std::thread::sleep(std::time::Duration::from_millis(125));
    socket = ScriptedRealtimeSocket::new((0..3).map(|index| ScriptStep::Event(json!({
        "type": "conversation.item.input_audio_transcription.delta",
        "item_id": format!("unrelated-item-{index}"),
        "text": "unrelated late delta",
        "stash": ""
    }))).collect(), harness.shared.clone());
    for _ in 0..3 { socket = harness.tick(socket, &mut slice); }

    assert!(
        report_has_native_empty_response(&harness),
        "successful non-speech traffic must not starve an expired deferred terminal",
    );
}

#[test]
fn replay_very_late_contiguous_speech_does_not_override_expired_empty_vad() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(None), harness.shared.clone());
    for _ in 0..4 { socket = harness.tick(socket, &mut slice); }

    std::thread::sleep(std::time::Duration::from_millis(200));
    socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Event(json!({
        "type": "input_audio_buffer.speech_started",
        "item_id": "item-too-late-continuation",
        "audio_start_ms": 22320
    }))], harness.shared.clone());
    let _socket = harness.tick(socket, &mut slice);

    assert!(
        report_has_native_empty_response(&harness),
        "a very late equal server boundary must not override the bounded local terminal",
    );
}

#[test]
fn replay_admission_invalid_contiguous_speech_fails_closed_after_expiry() {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(None), harness.shared.clone());
    for _ in 0..4 { socket = harness.tick(socket, &mut slice); }

    std::thread::sleep(std::time::Duration::from_millis(125));
    harness.provider.model = "qwen3.5-livetranslate-flash-realtime".to_string();
    harness.provider.template_realtime_protocol = Some("dashscope-livetranslate".to_string());
    harness.provider.region = Some("cn-beijing".to_string());
    harness.provider.base_url = "https://dashscope.aliyuncs.com/api/v1".to_string();
    socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Event(json!({
        "event_id": "event-invalid-continuation",
        "type": "input_audio_buffer.speech_started",
        "item_id": "item-invalid-continuation",
        "audio_start_ms": 22320
    }))], harness.shared.clone());

    let error = match harness.try_tick(socket, &mut slice) {
        Ok(_) => panic!("speech_started before an admitted LiveTranslate session must fail admission"),
        Err(error) => error,
    };
    assert!(error.contains("event_order_invalid"), "unexpected admission error: {error}");
    assert!(
        report_has_native_empty_response(&harness),
        "admission failure must fail-closed flush the already-expired deferred terminal",
    );
}

#[test]
fn replay_isolated_260ms_empty_vad_still_fails_after_bounded_deferral() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(None), harness.shared.clone());
    for _ in 0..4 { socket = harness.tick(socket, &mut slice); }
    std::thread::sleep(std::time::Duration::from_millis(200));
    let _socket = harness.tick(socket, &mut slice);
    assert!(report_has_native_empty_response(&harness));
}

#[test]
fn replay_noncontiguous_260ms_empty_vad_still_fails() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(Some(22341)), harness.shared.clone());
    for _ in 0..5 { socket = harness.tick(socket, &mut slice); }
    assert!(report_has_native_empty_response(&harness));
}

#[test]
fn replay_different_continuity_260ms_empty_vad_still_fails() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut socket = ScriptedRealtimeSocket::new(contiguous_empty_vad_steps(None), harness.shared.clone());
    for _ in 0..4 { socket = harness.tick(socket, &mut slice); }
    slice.event_diagnostics.last_asr_completed_at_ms = None;
    socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Event(json!({
        "type": "input_audio_buffer.speech_started",
        "item_id": "item-new-continuity",
        "audio_start_ms": 22320
    }))], harness.shared.clone());
    let _socket = harness.tick(socket, &mut slice);
    assert!(report_has_native_empty_response(&harness));
}

#[test]
fn replay_late_nonempty_asr_prevents_contiguous_empty_vad_drop() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut steps = contiguous_empty_vad_steps(None);
    steps.push(ScriptStep::Event(json!({
        "type": "conversation.item.input_audio_transcription.completed",
        "item_id": "item-empty-split",
        "transcript": "Authoritative late source."
    })));
    steps.push(ScriptStep::Event(json!({
        "type": "input_audio_buffer.speech_started",
        "item_id": "item-continuation",
        "audio_start_ms": 22320
    })));
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..6 { socket = harness.tick(socket, &mut slice); }
    assert!(report_has_native_empty_response(&harness));
    assert!(harness.store().snapshot().subtitle_overlay.recent_cues.iter().any(|cue| {
        cue.source_text == "Authoritative late source."
    }));
}

#[test]
fn replay_second_empty_response_terminalizes_first_deferred_owner() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.store().watch_session_report.begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let mut steps = contiguous_empty_vad_steps(None);
    steps.extend([
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "item-second-empty",
            "audio_start_ms": 23000
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-second-empty",
            "transcript": ""
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_stopped",
            "item_id": "item-second-empty",
            "audio_end_ms": 23300
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "resp-second-empty",
                "input_item_id": "item-second-empty",
                "status": "completed",
                "output": [{"status": "completed", "content": [{"type": "text", "text": " "}]}]
            }
        })),
    ]);
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..8 { socket = harness.tick(socket, &mut slice); }
    assert!(report_has_native_empty_response(&harness));
}
