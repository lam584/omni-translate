use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::Message;

use super::*;
use crate::provider::gateway::ProviderGateway;
use crate::provider::gateway_parts::transport::set_test_websocket_connect_override;

fn provider(model: &str) -> ProviderDraftInput {
    // Harmless test-only token; the override is always a loopback WS URL.
    std::env::set_var("OMNI_TASK_TTS_LOCAL_REPLAY", "local-replay-only");
    serde_json::from_value(json!({
        "templateId": "template-task-test", "providerId": "provider-task-test", "kind": "dashscope",
        "displayName": "Task local replay", "model": model, "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
        "transport": "websocket", "region": "cn-beijing", "streamEnabled": true, "timeoutMs": 1000,
        "authRef": { "kind": "env-ref", "reference": "OMNI_TASK_TTS_LOCAL_REPLAY", "headerName": "Authorization", "scheme": "bearer" },
        "systemPromptTemplate": "", "modelRegistryVersion": 2
    })).unwrap()
}

fn serve(serve: impl FnOnce(tungstenite::WebSocket<TcpStream>) + Send + 'static) -> thread::JoinHandle<()> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    set_test_websocket_connect_override(&format!("ws://{}/api-ws/v1/inference", listener.local_addr().unwrap()));
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Err(error) => panic!("local replay accept failed: {error}"),
            }
        };
        // Windows accepted sockets inherit the listener's nonblocking mode.
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
        let socket = tungstenite::accept_hdr(stream, |request: &tungstenite::handshake::server::Request, response| {
            assert_eq!(request.uri().path(), "/api-ws/v1/inference");
            assert_eq!(request.headers().get("Authorization").unwrap().to_str().unwrap(), "Bearer local-replay-only");
            Ok(response)
        }).unwrap();
        serve(socket);
    })
}

fn event(id: &str, name: &str, output: Value) -> Message {
    Message::Text(json!({ "header": { "task_id": id, "event": name }, "payload": { "output": output } }).to_string().into())
}

#[test]
fn gateway_task_tts_replays_both_exact_models_through_authorized_bearer_connection() {
    for model in ["qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"] {
        let server = serve(move |mut socket| {
            let run: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(run["payload"]["model"], model);
            assert_eq!(run["payload"]["parameters"]["format"], "pcm");
            assert_eq!(run["payload"]["parameters"]["sample_rate"], 24000);
            assert_eq!(run["payload"]["parameters"]["language_hints"], json!(["zh"]));
            let id = run["header"]["task_id"].as_str().unwrap();
            socket.get_mut().set_read_timeout(Some(Duration::from_millis(25))).unwrap();
            assert!(matches!(socket.read(), Err(tungstenite::Error::Io(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)));
            socket.get_mut().set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            socket.send(event(id, "task-started", json!({}))).unwrap();
            let text: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(text["header"]["action"], "continue-task");
            assert_eq!(text["header"]["task_id"], id);
            let finish: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(finish["header"]["action"], "finish-task");
            assert_eq!(finish["header"]["task_id"], id);
            socket.send(event(id, "result-generated", json!({ "type": "sentence-begin", "sentence": { "index": 0 }, "original_text": "你好" }))).unwrap();
            socket.send(event(id, "result-generated", json!({ "type": "sentence-synthesis", "sentence": { "index": 0 } }))).unwrap();
            socket.send(Message::Binary(vec![1, 0, 255, 255].into())).unwrap();
            socket.send(event(id, "result-generated", json!({ "type": "sentence-end", "sentence": { "index": 0 }, "original_text": "你好" }))).unwrap();
            socket.send(event(id, "task-finished", json!({}))).unwrap();
        });
        let result = ProviderGateway::new().synthesize_tts(provider(model), "你好".into(), "zh-CN".into(), "longanlingxi".into()).unwrap();
        assert_eq!(result.model, model);
        assert_eq!(result.audio.sample_rate_hz, 24000);
        assert_eq!(result.audio.channel_count, 1);
        assert_eq!(result.audio.pcm_i16, [1, -1]);
        server.join().unwrap();
    }
}

#[test]
fn task_tts_close_without_task_finished_is_not_partial_audio_success() {
    let server = serve(|mut socket| {
        let run: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        let id = run["header"]["task_id"].as_str().unwrap();
        socket.send(event(id, "task-started", json!({}))).unwrap();
        socket.read().unwrap();
        socket.read().unwrap();
        socket.send(event(id, "result-generated", json!({ "type": "sentence-begin", "sentence": { "index": 0 }, "original_text": "你好" }))).unwrap();
        socket.send(event(id, "result-generated", json!({ "type": "sentence-synthesis", "sentence": { "index": 0 } }))).unwrap();
        socket.send(Message::Binary(vec![1, 0].into())).unwrap();
        socket.close(None).unwrap();
    });
    let error = synthesize(provider("qwen-audio-3.0-tts-flash"), "你好".into(), "zh".into(), "longanlingxi".into()).unwrap_err();
    assert_eq!(error.code, "task.invalid_lifecycle");
    assert!(error.message.contains("role=speech-output"));
    assert!(!error.message.contains("audio.device"));
    server.join().unwrap();
}
