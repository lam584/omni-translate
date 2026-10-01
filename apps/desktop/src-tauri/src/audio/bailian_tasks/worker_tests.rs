use std::net::{TcpListener, TcpStream};
use std::thread;

use serde_json::json;

use super::*;

const ID: &str = "11111111-1111-4111-8111-111111111111";

fn provider(model: &str) -> ProviderDraftInput {
    serde_json::from_value(json!({
        "templateId": "template-task-test", "providerId": "provider-task-test", "kind": "dashscope",
        "displayName": "Task local replay", "model": model, "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
        "transport": "websocket", "region": "cn-beijing", "streamEnabled": true, "timeoutMs": 1000,
        "authRef": { "kind": "env-ref", "reference": "OMNI_TASK_LOCAL_REPLAY", "headerName": "Authorization", "scheme": "bearer" },
        "systemPromptTemplate": "", "modelRegistryVersion": 2
    })).unwrap()
}

fn message(name: &str, output: Value) -> Message {
    Message::Text(json!({ "header": { "event": name, "task_id": ID }, "payload": { "output": output } }).to_string().into())
}

fn local_session(role: TaskRole, serve: impl FnOnce(tungstenite::WebSocket<TcpStream>) + Send + 'static) -> (TaskSession, thread::JoinHandle<()>) {
    let provider = provider(if role == TaskRole::Asr { "qwen-audio-3.1-asr-flash-streaming" } else { "qwen-audio-3.0-tts-flash" });
    let authority = crate::audio::events::authorize_bailian_model_operation(&provider, &provider.model, role.operation()).unwrap();
    validate_authority(&provider, role, &authority).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
        serve(tungstenite::accept(stream).unwrap());
    });
    let (mut socket, _) = tungstenite::connect(format!("ws://{address}/api-ws/v1/inference")).unwrap();
    realtime_ws::set_socket_timeouts(&mut socket, Some(Duration::from_millis(10)), Some(Duration::from_millis(100)));
    let mut lifecycle = TaskLifecycle::new(role, ID.into()).unwrap();
    let run = lifecycle.run(&provider.model, "longanlingxi", "zh").unwrap();
    let mut session = TaskSession { socket, lifecycle, authority, timeout: Duration::from_millis(100), deadline: Some(Instant::now() + Duration::from_millis(100)), draining: false, finishing: false, idle_deadline: Instant::now() + Duration::from_secs(60) };
    session.send_json(&run).unwrap();
    (session, server)
}

#[test]
fn loopback_asr_gates_binary_and_drains_final_after_finish() {
    let (mut session, server) = local_session(TaskRole::Asr, |mut server| {
        let run: Value = serde_json::from_str(server.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(run["payload"]["model"], "qwen-audio-3.1-asr-flash-streaming");
        server.get_mut().set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        assert!(matches!(server.read(), Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)));
        server.get_mut().set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        server.send(message("task-started", json!({}))).unwrap();
        assert!(matches!(server.read().unwrap(), Message::Binary(bytes) if bytes.as_ref() == [1, 0, 2, 0]));
        let finish: Value = serde_json::from_str(server.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(finish["header"]["action"], "finish-task");
        server.send(message("result-generated", json!({ "sentence": { "sentence_id": 1, "sentence_end": true, "begin_time": 0, "end_time": 50, "text": "停止时的尾句" } }))).unwrap();
        server.send(message("task-finished", json!({}))).unwrap();
    });
    assert_eq!(session.send_pcm(vec![1, 0]).unwrap_err().failure, TaskFailure::Lifecycle);
    session.wait_started().unwrap();
    session.send_pcm(vec![1, 0, 2, 0]).unwrap();
    session.begin_drain();
    session.finish().unwrap();
    let mut final_seen = false;
    while !session.finished() {
        if let Some(TaskOutput::Transcript { text, final_sentence, .. }) = session.poll().unwrap() {
            assert_eq!(text, "停止时的尾句");
            final_seen = final_sentence;
        }
    }
    assert!(final_seen);
    server.join().unwrap();
}

#[test]
fn loopback_tts_requires_sentence_metadata_binary_and_task_finished() {
    let (mut session, server) = local_session(TaskRole::Tts, |mut server| {
        server.read().unwrap();
        server.send(message("task-started", json!({}))).unwrap();
        let text: Value = serde_json::from_str(server.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(text["header"]["action"], "continue-task");
        assert_eq!(text["payload"]["input"]["text"], "你好");
        server.read().unwrap();
        server.send(message("result-generated", json!({ "type": "sentence-begin", "sentence": { "index": 0 }, "original_text": "你好" }))).unwrap();
        server.send(message("result-generated", json!({ "type": "sentence-synthesis", "sentence": { "index": 0 } }))).unwrap();
        server.send(Message::Binary(vec![1, 0, 255, 255].into())).unwrap();
        server.send(message("result-generated", json!({ "type": "sentence-end", "sentence": { "index": 0 }, "original_text": "你好" }))).unwrap();
        server.send(message("task-finished", json!({}))).unwrap();
    });
    session.wait_started().unwrap();
    session.continue_text("你好").unwrap();
    session.finish().unwrap();
    let mut samples = Vec::new();
    while !session.finished() {
        if let Some(TaskOutput::Audio(chunk)) = session.poll().unwrap() { samples.extend(chunk); }
    }
    assert_eq!(samples, [1, -1]);
    server.join().unwrap();
}

#[test]
fn loopback_missing_start_and_missing_stop_terminal_are_typed_timeouts() {
    for stop_drain in [false, true] {
        let (mut session, server) = local_session(TaskRole::Asr, move |mut server| {
            server.read().unwrap();
            if stop_drain {
                server.send(message("task-started", json!({}))).unwrap();
                server.read().unwrap();
            }
            thread::sleep(Duration::from_millis(160));
        });
        let error = if stop_drain {
            session.wait_started().unwrap();
            session.begin_drain();
            session.finish().unwrap();
            loop { if let Err(error) = session.poll() { break error; } }
        } else { session.wait_started().unwrap_err() };
        assert_eq!(error.failure, if stop_drain { TaskFailure::StopDrain } else { TaskFailure::Timeout });
        assert_eq!(error.role, TaskRole::Asr);
        server.join().unwrap();
    }
}

#[test]
fn loopback_cross_task_wrong_frame_and_early_close_fail_closed() {
    for failure in [0, 1, 2] {
        let (mut session, server) = local_session(TaskRole::Asr, move |mut server| {
            server.read().unwrap();
            server.send(message("task-started", json!({}))).unwrap();
            match failure {
                0 => server.send(Message::Text(json!({ "header": { "event": "task-failed", "task_id": "other" }, "payload": {} }).to_string().into())).unwrap(),
                1 => server.send(Message::Binary(vec![0, 0].into())).unwrap(),
                _ => server.close(None).unwrap(),
            }
        });
        session.wait_started().unwrap();
        let error = loop { if let Err(error) = session.poll() { break error; } };
        assert_eq!(error.failure, match failure { 0 => TaskFailure::Identity, 1 => TaskFailure::InvalidFrame, _ => TaskFailure::Lifecycle });
        server.join().unwrap();
    }
}

#[test]
fn authority_cannot_be_shared_with_omni_wrong_role_model_or_pcm_rate() {
    let provider = provider("qwen-audio-3.0-asr-flash-streaming");
    let authority = crate::audio::events::authorize_bailian_model_operation(&provider, &provider.model, "asr").unwrap();
    for tamper in [0, 1, 2, 3, 4] {
        let mut authority = authority.clone();
        match tamper {
            0 => authority.adapter_id = "desktop-livetranslate-session-v1".into(),
            1 => authority.operation = "tts".into(),
            2 => authority.exact_model_id = "fun-asr-realtime".into(),
            3 => authority.requested_audio_input.as_mut().unwrap().sample_rate_hz = 24000,
            _ => authority.wire_dialect = "bailian-omni-realtime-ws-v2".into(),
        }
        assert_eq!(validate_authority(&provider, TaskRole::Asr, &authority).unwrap_err().failure, TaskFailure::Authority);
    }
}

#[test]
fn active_idle_timeout_is_typed_and_control_frames_do_not_count_as_task_progress() {
    let (mut session, server) = local_session(TaskRole::Asr, |mut server| {
        server.read().unwrap();
        server.send(message("task-started", json!({}))).unwrap();
        thread::sleep(Duration::from_millis(30));
    });
    session.wait_started().unwrap();
    session.idle_deadline = Instant::now() - Duration::from_millis(1);
    let error = session.poll().unwrap_err();
    assert_eq!(error.failure, TaskFailure::Timeout);
    assert_eq!(error.role, TaskRole::Asr);
    server.join().unwrap();
}

#[test]
fn stop_drain_has_one_absolute_deadline_even_if_stop_is_repeated() {
    let (mut session, server) = local_session(TaskRole::Asr, |mut server| {
        server.read().unwrap();
        server.send(message("task-started", json!({}))).unwrap();
        server.read().unwrap();
        thread::sleep(Duration::from_millis(160));
    });
    session.wait_started().unwrap();
    session.begin_drain();
    let deadline = session.deadline.unwrap();
    thread::sleep(Duration::from_millis(10));
    session.begin_drain();
    assert_eq!(session.deadline, Some(deadline));
    session.finish().unwrap();
    assert_eq!(session.deadline, Some(deadline));
    let error = loop { if let Err(error) = session.poll() { break error; } };
    assert_eq!(error.failure, TaskFailure::StopDrain);
    assert!(error.to_string().contains("role=primary-audio"));
    server.join().unwrap();
}
