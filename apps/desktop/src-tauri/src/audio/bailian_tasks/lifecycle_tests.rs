use super::*;

const ID: &str = "11111111-1111-4111-8111-111111111111";

fn event(name: &str, output: Value) -> Message {
    Message::Text(json!({ "header": { "task_id": ID, "event": name }, "payload": { "output": output } }).to_string().into())
}

fn task(role: TaskRole) -> TaskLifecycle {
    let mut task = TaskLifecycle::new(role, ID.into()).unwrap();
    task.run(if role == TaskRole::Asr { "qwen-audio-3.1-asr-flash-streaming" } else { "qwen-audio-3.0-tts-plus" }, "longanlingxi", "zh").unwrap();
    task.receive(event("task-started", json!({}))).unwrap();
    if role == TaskRole::Tts { task.continue_text("测试").unwrap(); }
    task
}

fn asr(id: u64, begin: bool, final_sentence: bool, text: &str) -> Message {
    event("result-generated", json!({ "sentence": {
        "sentence_id": id, "sentence_begin": begin, "sentence_end": final_sentence,
        "begin_time": 100, "end_time": if final_sentence { Some(500) } else { None }, "text": text
    } }))
}

fn tts(kind: &str, index: u64) -> Message {
    event("result-generated", json!({ "type": kind, "sentence": { "index": index, "words": [] }, "original_text": "测试" }))
}

#[test]
fn run_preserves_all_exact_models_and_different_media_contracts() {
    for model in ["qwen-audio-3.0-asr-flash-streaming", "qwen-audio-3.1-asr-flash-streaming", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"] {
        let role = if super::super::is_asr_model(model) { TaskRole::Asr } else { TaskRole::Tts };
        let mut task = TaskLifecycle::new(role, ID.into()).unwrap();
        let run = task.run(model, "longanlingxi", "en").unwrap();
        assert_eq!(run["payload"]["model"], model);
        assert_eq!(run["payload"]["parameters"]["format"], "pcm");
        assert_eq!(run["payload"]["parameters"]["sample_rate"], if role == TaskRole::Asr { 16000 } else { 24000 });
        assert_eq!(run["header"]["task_id"], ID);
        assert!(task.audio_input(&[0, 0]).is_err());
        assert!(task.continue_text("too early").is_err());
        assert!(task.finish().is_err());
    }
}

#[test]
fn task_uuid_and_exact_model_scope_fail_closed() {
    assert!(TaskLifecycle::new(TaskRole::Asr, "not-uuid".into()).is_err());
    for model in ["qwen3-asr-flash-realtime", "fun-asr-realtime", "cosyvoice-v3-plus", "qwen-audio-3.1-tts-flash"] {
        let mut task = TaskLifecycle::new(TaskRole::Asr, ID.into()).unwrap();
        assert_eq!(task.run(model, "", "").unwrap_err().failure, TaskFailure::Authority);
    }
}

#[test]
fn asr_preview_is_replaceable_and_only_sentence_end_commits() {
    let mut task = task(TaskRole::Asr);
    assert_eq!(task.receive(asr(1, true, false, "识")).unwrap(), TaskOutput::Transcript { sentence_id: 1, text: "识".into(), final_sentence: false });
    assert_eq!(task.receive(asr(1, false, false, "识别中")).unwrap(), TaskOutput::Transcript { sentence_id: 1, text: "识别中".into(), final_sentence: false });
    task.finish().unwrap();
    assert_eq!(task.receive(asr(1, false, true, "识别完成")).unwrap(), TaskOutput::Transcript { sentence_id: 1, text: "识别完成".into(), final_sentence: true });
    assert_eq!(task.receive(event("task-finished", json!({}))).unwrap(), TaskOutput::Finished);
    assert!(task.finished());
    assert!(task.receive(asr(2, false, true, "late")).is_err());
}

#[test]
fn asr_final_only_sentence_is_valid_but_duplicate_or_skipped_identity_is_not() {
    let mut task = task(TaskRole::Asr);
    task.receive(asr(1, false, true, "一句")).unwrap();
    assert_eq!(task.receive(asr(1, false, true, "重复")).unwrap_err().failure, TaskFailure::Sentence);
    assert_eq!(task.receive(asr(2, false, true, "poisoned")).unwrap_err().failure, TaskFailure::Lifecycle);
    let mut task = self::task(TaskRole::Asr);
    assert_eq!(task.receive(asr(2, false, true, "跳号")).unwrap_err().failure, TaskFailure::Sentence);
}

#[test]
fn wrong_task_and_wrong_envelope_fail_closed() {
    let mut task = task(TaskRole::Asr);
    let other = Message::Text(json!({ "header": { "task_id": "22222222-2222-4222-8222-222222222222", "event": "task-finished" }, "payload": {} }).to_string().into());
    assert_eq!(task.receive(other).unwrap_err().failure, TaskFailure::Identity);
    for text in ["not JSON", "{}", "{\"type\":\"response.done\"}"] {
        let mut task = self::task(TaskRole::Asr);
        assert_eq!(task.receive(Message::Text(text.into())).unwrap_err().failure, TaskFailure::InvalidFrame);
    }
}

#[test]
fn duplicate_started_premature_finished_and_non_task_events_are_rejected() {
    for name in ["task-started", "task-finished", "response.done", "session.finished"] {
        let mut task = task(TaskRole::Asr);
        assert_eq!(task.receive(event(name, json!({}))).unwrap_err().failure, TaskFailure::Lifecycle);
    }
}

#[test]
fn incomplete_sentence_cannot_be_promoted_by_task_finished() {
    for role in [TaskRole::Asr, TaskRole::Tts] {
        let mut task = task(role);
        task.receive(if role == TaskRole::Asr { asr(1, true, false, "pending") } else { tts("sentence-begin", 0) }).unwrap();
        task.finish().unwrap();
        assert_eq!(task.receive(event("task-finished", json!({}))).unwrap_err().failure, TaskFailure::Sentence);
    }
}

#[test]
fn asr_missing_finality_and_invalid_terminal_time_fail_closed() {
    for sentence in [
        json!({ "sentence_id": 1, "sentence_begin": true, "text": "x", "begin_time": 0 }),
        json!({ "sentence_id": 1, "sentence_end": true, "text": "x", "begin_time": 100, "end_time": 50 }),
        json!({ "sentence_id": 1, "sentence_end": "true", "text": "x", "begin_time": 0, "end_time": 1 }),
    ] {
        let mut task = task(TaskRole::Asr);
        assert_eq!(task.receive(event("result-generated", json!({ "sentence": sentence }))).unwrap_err().failure, TaskFailure::Sentence);
    }
}

#[test]
fn heartbeat_does_not_open_or_commit_a_sentence() {
    let mut task = task(TaskRole::Asr);
    let output = json!({ "sentence": { "sentence_id": 0, "heartbeat": true, "sentence_end": false, "begin_time": 0, "end_time": null, "text": "" } });
    assert_eq!(task.receive(event("result-generated", output)).unwrap(), TaskOutput::Metadata);
    task.finish().unwrap();
    task.receive(event("task-finished", json!({}))).unwrap();
}

#[test]
fn tts_binary_is_licensed_by_exact_sentence_metadata_and_pcm_alignment() {
    let mut task = task(TaskRole::Tts);
    task.finish().unwrap();
    task.receive(tts("sentence-begin", 0)).unwrap();
    task.receive(tts("sentence-synthesis", 0)).unwrap();
    assert_eq!(task.receive(Message::Binary(vec![0xff, 0x7f, 0x00, 0x80].into())).unwrap(), TaskOutput::Audio(vec![32767, -32768]));
    task.receive(tts("sentence-end", 0)).unwrap();
    task.receive(event("task-finished", json!({}))).unwrap();
    for bytes in [vec![], vec![0], vec![0, 0]] {
        let mut task = self::task(TaskRole::Tts);
        assert_eq!(task.receive(Message::Binary(bytes.into())).unwrap_err().failure, TaskFailure::InvalidFrame);
    }
}

#[test]
fn tts_wrong_sentence_and_missing_binary_do_not_finish() {
    let mut task = task(TaskRole::Tts);
    task.receive(tts("sentence-begin", 0)).unwrap();
    assert_eq!(task.receive(tts("sentence-synthesis", 1)).unwrap_err().failure, TaskFailure::Sentence);
    let mut task = self::task(TaskRole::Tts);
    task.receive(tts("sentence-begin", 0)).unwrap();
    task.receive(tts("sentence-synthesis", 0)).unwrap();
    assert_eq!(task.receive(tts("sentence-end", 0)).unwrap_err().failure, TaskFailure::InvalidFrame);
}

#[test]
fn tts_duplicate_finality_and_changed_terminal_text_fail() {
    let mut task = task(TaskRole::Tts);
    task.receive(tts("sentence-begin", 0)).unwrap();
    task.receive(tts("sentence-synthesis", 0)).unwrap();
    task.receive(Message::Binary(vec![0, 0].into())).unwrap();
    task.receive(tts("sentence-end", 0)).unwrap();
    assert_eq!(task.receive(tts("sentence-end", 0)).unwrap_err().failure, TaskFailure::Sentence);
    let mut task = self::task(TaskRole::Tts);
    task.receive(tts("sentence-begin", 0)).unwrap();
    task.receive(tts("sentence-synthesis", 0)).unwrap();
    task.receive(Message::Binary(vec![0, 0].into())).unwrap();
    let changed = event("result-generated", json!({ "type": "sentence-end", "sentence": { "index": 0 }, "original_text": "changed" }));
    assert_eq!(task.receive(changed).unwrap_err().failure, TaskFailure::Sentence);
}

#[test]
fn wrong_frame_and_provider_failure_preserve_role() {
    for role in [TaskRole::Asr, TaskRole::Tts] {
        let mut task = task(role);
        let failure = Message::Text(json!({ "header": { "task_id": ID, "event": "task-failed", "error_code": "BAD", "error_message": "provider failure" }, "payload": {} }).to_string().into());
        let error = task.receive(failure).unwrap_err();
        assert_eq!(error.role, role);
        assert_eq!(error.failure, TaskFailure::Provider);
        assert!(error.to_string().contains(&format!("role={}", role.model_role())));
        assert!(!error.to_string().contains("audio.device"));
        let mut task = self::task(role);
        assert_eq!(task.receive(Message::Close(None)).unwrap_err().failure, TaskFailure::InvalidFrame);
    }
}

#[test]
fn bcp47_tts_language_is_normalized_without_changing_model_or_voice() {
    let mut task = TaskLifecycle::new(TaskRole::Tts, ID.into()).unwrap();
    let run = task.run("qwen-audio-3.0-tts-flash", "longanlingxi", "zh-CN").unwrap();
    assert_eq!(run["payload"]["parameters"]["language_hints"], json!(["zh"]));
    assert_eq!(run["payload"]["parameters"]["voice"], "longanlingxi");
    let mut task = TaskLifecycle::new(TaskRole::Tts, ID.into()).unwrap();
    assert_eq!(task.run("qwen-audio-3.0-tts-flash", "longanlingxi", "unsupported").unwrap_err().failure, TaskFailure::Sentence);
}

#[test]
fn tts_empty_sentence_audio_and_duplicate_binary_fail_closed() {
    let mut task = task(TaskRole::Tts);
    task.receive(tts("sentence-begin", 0)).unwrap();
    assert_eq!(task.receive(tts("sentence-end", 0)).unwrap_err().failure, TaskFailure::Sentence);
    let mut task = self::task(TaskRole::Tts);
    task.receive(tts("sentence-begin", 0)).unwrap();
    task.receive(tts("sentence-synthesis", 0)).unwrap();
    task.receive(Message::Binary(vec![0, 0].into())).unwrap();
    assert_eq!(task.receive(Message::Binary(vec![0, 0].into())).unwrap_err().failure, TaskFailure::InvalidFrame);
}

#[test]
fn compact_heartbeat_is_not_a_sentence_and_provider_failure_can_interrupt_binary() {
    let mut task = task(TaskRole::Asr);
    assert_eq!(task.receive(event("result-generated", json!({ "sentence": { "heartbeat": true, "sentence_id": 0 } }))).unwrap(), TaskOutput::Metadata);
    let mut task = self::task(TaskRole::Tts);
    task.receive(tts("sentence-begin", 0)).unwrap();
    task.receive(tts("sentence-synthesis", 0)).unwrap();
    let failure = Message::Text(json!({ "header": { "task_id": ID, "event": "task-failed", "error_code": "SERVER_ERROR", "error_message": "engine failed" }, "payload": {} }).to_string().into());
    assert_eq!(task.receive(failure).unwrap_err().failure, TaskFailure::Provider);
}

#[test]
fn native_ws_asr_replay_commits_only_the_tail_final_after_finish() {
    use std::net::TcpListener;
    use std::time::Duration;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut server = tungstenite::accept(stream).unwrap();
        let run: Value = serde_json::from_str(server.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(run["payload"]["model"], "qwen-audio-3.0-asr-flash-streaming");
        server.send(event("task-started", json!({}))).unwrap();
        assert!(matches!(server.read().unwrap(), Message::Binary(_)));
        server.send(asr(1, true, false, "停止前")).unwrap();
        let finish: Value = serde_json::from_str(server.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(finish["header"]["action"], "finish-task");
        server.send(asr(1, false, true, "停止后的尾句")).unwrap();
        server.send(event("task-finished", json!({}))).unwrap();
    });
    let (mut socket, _) = tungstenite::connect(format!("ws://{address}/api-ws/v1/inference")).unwrap();
    let mut task = TaskLifecycle::new(TaskRole::Asr, ID.into()).unwrap();
    let run = task.run("qwen-audio-3.0-asr-flash-streaming", "", "").unwrap();
    socket.send(Message::Text(run.to_string().into())).unwrap();
    assert!(task.audio_input(&[0, 0]).is_err());
    assert_eq!(task.receive(socket.read().unwrap()).unwrap(), TaskOutput::Started);
    task.audio_input(&[0, 0]).unwrap();
    socket.send(Message::Binary(vec![0, 0].into())).unwrap();
    assert!(matches!(task.receive(socket.read().unwrap()).unwrap(), TaskOutput::Transcript { final_sentence: false, .. }));
    let finish = task.finish().unwrap();
    socket.send(Message::Text(finish.to_string().into())).unwrap();
    assert!(matches!(task.receive(socket.read().unwrap()).unwrap(), TaskOutput::Transcript { text, final_sentence: true, .. } if text == "停止后的尾句"));
    assert_eq!(task.receive(socket.read().unwrap()).unwrap(), TaskOutput::Finished);
    server.join().unwrap();
}

#[test]
fn native_ws_tts_replay_decodes_24k_pcm_and_requires_both_sentence_and_task_finality() {
    use std::net::TcpListener;
    use std::time::Duration;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut server = tungstenite::accept(stream).unwrap();
        let run: Value = serde_json::from_str(server.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(run["payload"]["parameters"]["sample_rate"], 24000);
        server.send(event("task-started", json!({}))).unwrap();
        server.read().unwrap();
        server.read().unwrap();
        server.send(tts("sentence-begin", 0)).unwrap();
        server.send(tts("sentence-synthesis", 0)).unwrap();
        server.send(Message::Binary(vec![0x00, 0x80, 0xff, 0x7f].into())).unwrap();
        server.send(tts("sentence-end", 0)).unwrap();
        server.send(event("task-finished", json!({}))).unwrap();
    });
    let (mut socket, _) = tungstenite::connect(format!("ws://{address}/api-ws/v1/inference")).unwrap();
    let mut task = TaskLifecycle::new(TaskRole::Tts, ID.into()).unwrap();
    let run = task.run("qwen-audio-3.0-tts-plus", "longanlingxi", "zh").unwrap();
    socket.send(Message::Text(run.to_string().into())).unwrap();
    task.receive(socket.read().unwrap()).unwrap();
    socket.send(Message::Text(task.continue_text("测试").unwrap().to_string().into())).unwrap();
    socket.send(Message::Text(task.finish().unwrap().to_string().into())).unwrap();
    let mut samples = Vec::new();
    while !task.finished() {
        if let TaskOutput::Audio(chunk) = task.receive(socket.read().unwrap()).unwrap() { samples.extend(chunk); }
    }
    assert_eq!(samples, [-32768, 32767]);
    server.join().unwrap();
}
