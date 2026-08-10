use super::*;

/// Native server-VAD providers may begin the next speech window just before
/// the prior turn's output and ASR final arrive. The response used to commit a
/// translation-only cue, then the late ASR final created a second uncommitted
/// cue that displayed "calling LLM translation" forever even though no
/// secondary translation worker was active.
#[test]
fn replay_native_response_done_before_asr_final_reconciles_one_committed_cue() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let source = "This is a one billion dollar rocket ship, a future technology that";
    let translated = "这是一艘价值十亿美元的火箭。";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-prior",
            "delta": source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "transcript": translated
        })),
        ScriptStep::Event(json!({ "type": "response.done" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-prior",
            "transcript": source
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..7 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let matching: Vec<_> = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .filter(|cue| cue.source_text == source)
        .collect();
    assert_eq!(matching.len(), 1, "the ASR final must not create a duplicate cue");
    let cue = matching[0];
    assert!(cue.committed);
    assert_eq!(cue.translated_text, translated);
    assert!(cue.display_segments.iter().all(|segment| !segment.pending));
    assert!(snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .filter(|cue| !cue.committed)
        .all(|cue| cue.source_text.trim().is_empty()));
}

/// response.done closes the response owner even when the provider returned no
/// text. The source must therefore enter an explicit failure terminal; leaving
/// it live would strand it as "translating" after the next turn takes ownership.
#[test]
fn replay_native_empty_response_reaches_failure_terminal_and_keeps_late_asr_final() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let source = "To bring extinct";
    let final_source = "To bring extinct species back to life.";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-empty-response",
            "delta": source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": { "status": "completed" }
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-empty-response",
            "transcript": final_source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..5 {
        socket = harness.tick(socket, &mut slice);
    }
    std::thread::sleep(Duration::from_millis(2));
    let _socket = harness.tick(socket, &mut slice);

    let snapshot = harness.store().snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == final_source)
        .expect("source cue should remain visible");
    assert!(cue.committed);
    assert!(cue.translation_committed);
    assert_eq!(
        cue.translated_text,
        "[翻译失败] 实时模型已结束本轮响应，但没有返回可用译文。"
    );
    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("completed-empty replay should retain a report");
    assert!(report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.code == "native-response-cancelled"));
    assert!(snapshot.subtitle_overlay.recent_cues.iter().any(|cue| {
        !cue.committed && cue.source_text.trim().is_empty()
    }));
}

/// Qwen Audio reports a server-VAD barge-in as a cancelled response with
/// `turn_detected`, not as a completed response with an empty translation.
/// Keep that distinction visible so diagnostics point to turn overlap instead
/// of blaming an empty model result.
#[test]
fn replay_turn_detected_response_uses_cancellation_terminal() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("dashscope", "qwen-audio-3.0-realtime-plus");
    let mut slice = WorkerSlice::new();
    let source = "Future technology that will one day take";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-turn-detected",
            "delta": source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.text.delta",
            "delta": "不完整"
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "resp-turn-detected",
                "status": "cancelled",
                "status_details": { "reason": "turn_detected" },
                "output": [{
                    "content": [{ "type": "text", "text": "不完整的译文" }]
                }]
            }
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..5 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source)
        .expect("cancelled response should still terminalize its source cue");
    assert!(cue.committed);
    assert!(cue.translation_committed);
    assert_eq!(cue.translated_text, "[翻译失败] 实时响应被后续语音打断。");
    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("cancelled replay should retain a report");
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.code == "native-response-cancelled")
        .expect("turn_detected cancellation should be a session-level warning");
    assert_eq!(issue.category, "model");
    assert_eq!(issue.severity, "warning");
    assert!(issue.message.contains("status=cancelled"));
    assert!(issue.message.contains("reason=turn_detected"));
    assert!(!report
        .cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .any(|issue| issue.code == "native-empty-response"));
}

/// A cancelled response can beat both ASR delta and ASR final. Because that
/// response owner has no provider item id, the later identified transcript is
/// not structurally correlated: keep the terminal response cue and the late
/// source cue instead of guessing from timing or content.
#[test]
fn replay_cancelled_response_without_item_lineage_preserves_both_cues() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let final_source = "You.";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "resp-before-asr",
                "status": "cancelled",
                "status_details": { "reason": "turn_detected" }
            }
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-before-asr",
            "transcript": final_source
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    let mut response_cue_id = None;
    for index in 0..4 {
        socket = harness.tick(socket, &mut slice);
        if index == 0 {
            response_cue_id = slice.current_cue_id.clone();
        }
        if index == 2 {
            assert!(
                slice.current_cue_id.is_none(),
                "response.done must release the response-owned input cue",
            );
            assert!(slice
                .event_diagnostics
                .asr_cue_for_input_item("item-before-asr")
                .is_none());
            assert!(slice
                .event_diagnostics
                .native_response_cue_for_input_item("item-before-asr")
                .is_none());
        }
        if index == 3 {
            assert_ne!(
                slice.current_cue_id.as_deref(),
                response_cue_id.as_deref(),
                "an unresolved final must allocate an independent cue",
            );
        }
    }

    let snapshot = harness.store().snapshot();
    let terminal_cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.translated_text == "[翻译失败] 实时响应被后续语音打断。")
        .expect("cancelled response must retain its terminal cue");
    assert!(terminal_cue.committed);
    assert!(terminal_cue.translation_committed);

    let late_source_cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == final_source)
        .expect("uncorrelated late ASR final must remain visible");
    let cue_debug = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .map(|cue| {
            format!(
                "{}|source={:?}|translated={:?}|committed={}",
                cue.cue_id, cue.source_text, cue.translated_text, cue.committed,
            )
        })
        .collect::<Vec<_>>();
    assert_ne!(
        late_source_cue.cue_id, terminal_cue.cue_id,
        "unresolved cues: {cue_debug:?}",
    );
    assert!(!late_source_cue.committed);
    assert!(late_source_cue.translated_text.is_empty());
}

/// Some OpenAI-compatible realtime providers put the final text only in the
/// response.done output envelope instead of sending a transcript.done event.
#[test]
fn replay_response_done_nested_output_commits_native_translation() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let source = "This is literally the future.";
    let translated = "这就是未来。";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-nested-output",
            "delta": source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "output": [{
                    "content": [{ "type": "text", "text": translated }]
                }]
            }
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
        .expect("nested response output should create a cue");
    assert!(cue.committed);
    assert_eq!(cue.translated_text, translated);
}

/// Exact ordering observed in the production watch-mode log: the first ASR
/// final is already visible, then server VAD opens the second input cue before
/// the first native transcript/response.done arrives. Each response must stay
/// attached to the input cue captured at speech_stopped.
#[test]
fn replay_next_speech_started_does_not_steal_prior_native_response() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let source_one = "This is a one billion dollar rocket ship.";
    let translated_one = "这是一艘价值十亿美元的火箭飞船。";
    let source_two = "Oh my gosh, the future is about to be epic.";
    let translated_two = "天哪，未来将会非常精彩。";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-one",
            "delta": source_one
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-one",
            "transcript": source_one
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "transcript": translated_one
        })),
        ScriptStep::Event(json!({ "type": "response.done" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-two",
            "delta": source_two
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-two",
            "transcript": source_two
        })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "transcript": translated_two
        })),
        ScriptStep::Event(json!({ "type": "response.done" })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..4 {
        socket = harness.tick(socket, &mut slice);
    }
    // Production VAD turns are naturally separated in time; keep the replay's
    // millisecond-based cue ids distinct as well.
    std::thread::sleep(Duration::from_millis(2));
    for _ in 4..12 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let first = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source_one)
        .expect("first source cue");
    let second = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source_two)
        .expect("second source cue");
    assert!(first.committed);
    assert!(second.committed);
    assert_eq!(first.translated_text, translated_one);
    assert_eq!(second.translated_text, translated_two);
    assert!(snapshot.subtitle_overlay.recent_cues.iter().all(|cue| {
        cue.translated_text.trim().is_empty()
            || normalize_for_replay_assert(&cue.source_text)
                != normalize_for_replay_assert(&cue.translated_text)
    }));
}

/// A fast continuous source can finish two VAD input turns before the first
/// native translation starts streaming. The ownership tracker must preserve
/// both stopped turns in FIFO order instead of letting the second stop replace
/// the first owner and strand a source-only cue as "calling LLM".
#[test]
fn replay_two_stopped_turns_before_first_response_keep_fifo_ownership() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let source_one = "You'll see how we're going to bring extinct species back to life.";
    let translated_one = "您将看到我们将如何让灭绝物种复活。";
    let source_two = "What?";
    let translated_two = "什么？";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-one",
            "delta": source_one
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-two",
            "delta": source_two
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "response_id": "response-one",
            "transcript": translated_one
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": { "id": "response-one" }
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-one",
            "transcript": source_one
        })),
        ScriptStep::Event(json!({
            "type": "response.audio_transcript.done",
            "response_id": "response-two",
            "transcript": translated_two
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": { "id": "response-two" }
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-two",
            "transcript": source_two
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..3 {
        socket = harness.tick(socket, &mut slice);
    }
    std::thread::sleep(Duration::from_millis(2));
    for _ in 3..12 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let first = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source_one)
        .expect("first source cue");
    let second = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source_two)
        .expect("second source cue");
    assert!(first.committed);
    assert!(second.committed);
    assert_eq!(first.translated_text, translated_one);
    assert_eq!(second.translated_text, translated_two);
    assert!(snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .filter(|cue| !cue.committed)
        .all(|cue| cue.source_text.trim().is_empty()));
}

#[test]
fn replay_next_speech_started_preserves_prior_native_audio_buffer() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.audio.delta",
            "response_id": "response-one",
            "delta": "AQACAA=="
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..4 {
        socket = harness.tick(socket, &mut slice);
    }

    assert_eq!(slice.pending_audio_buffer, vec![1, 2]);
    assert_eq!(slice.pending_audio_delta_count, 1);
    assert_eq!(
        slice.pending_audio_response_id.as_deref(),
        Some("response-one")
    );
}

#[test]
fn replay_audio_done_after_response_done_keeps_the_subtitle_cue_identity() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let source = "Actual source cue";
    let translated = "实际译文";
    let steps = vec![
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-audio-owner",
            "delta": source
        })),
        ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_stopped" })),
        ScriptStep::Event(json!({
            "type": "response.created",
            "response": { "id": "response-audio-owner" }
        })),
        ScriptStep::Event(json!({
            "type": "response.audio.delta",
            "response_id": "response-audio-owner",
            "delta": "AQACAA=="
        })),
        ScriptStep::Event(json!({
            "type": "response.done",
            "response": {
                "id": "response-audio-owner",
                "output": [{ "content": [{ "type": "text", "text": translated }] }]
            }
        })),
        ScriptStep::Event(json!({
            "type": "response.audio.done",
            "response_id": "response-audio-owner"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..7 {
        socket = harness.tick(socket, &mut slice);
    }

    let snapshot = harness.store().snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == source)
        .expect("response subtitle cue");
    assert_eq!(cue.translated_text, translated);
    assert_eq!(harness.playback_tx.pending_cue_ids(), [cue.cue_id.as_str()]);
    assert!(harness
        .playback_tx
        .pending_cue_ids()
        .iter()
        .all(|cue_id| !cue_id.starts_with("omni-audio-")));
}

fn normalize_for_replay_assert(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
