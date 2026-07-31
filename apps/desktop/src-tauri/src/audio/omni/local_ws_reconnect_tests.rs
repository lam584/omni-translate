//! In-process fake realtime WS server: the REAL Omni client path
//! (`TungsteniteConnector` → `reconnect_socket` → URL building, headers,
//! session.update replay) runs a full disconnect→reconnect lifecycle against
//! a scripted local server inside `cargo test` — no DashScope key, no network.

use std::net::TcpListener;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tauri::Manager;
use tungstenite::Message;

use super::realtime_socket::{RealtimeSocket, RealtimeSocketConnector, TungsteniteConnector};
use super::*;
use crate::audio::state::AudioStateStore;

fn local_provider(port: u16) -> ProviderDraftInput {
    serde_json::from_value(json!({
        "templateId": "t",
        "providerId": "p-local",
        "kind": "dashscope",
        "displayName": "local fake realtime",
        "model": "qwen3.5-omni-plus-realtime",
        "baseUrl": format!("ws://127.0.0.1:{port}"),
        "transport": "websocket",
        "authRef": {
            "kind": "header",
            "reference": "unused",
            "headerName": "Authorization",
            // 'none' skips credential resolution entirely — the lifecycle
            // under test is the socket, not the vault.
            "scheme": "none"
        },
        "region": null,
        "streamEnabled": true,
        "timeoutMs": 1000,
        "systemPromptTemplate": ""
    }))
    .expect("local provider fixture")
}

/// Accepts `sessions` connections; for each: record the client's first
/// message (the session.update replay), answer with session.created, then
/// drop the connection (scripted provider-side disconnect).
fn spawn_scripted_server(
    listener: TcpListener,
    sessions: usize,
    received: Arc<Mutex<Vec<Value>>>,
    ready_tx: mpsc::Sender<()>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let _ = ready_tx.send(());
        for index in 0..sessions {
            let (stream, _) = listener.accept().expect("accept scripted connection");
            let mut ws = tungstenite::accept(stream).expect("websocket handshake");
            let first = ws.read().expect("client session.update");
            if let Message::Text(text) = &first {
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    received.lock().expect("received log").push(value);
                }
            }
            ws.send(Message::Text(
                json!({ "type": "session.created", "session": { "id": format!("session-{index}") } })
                    .to_string()
                    .into(),
            ))
            .expect("session.created reply");
            // Scripted provider-side disconnect: send Close and drop the TCP
            // stream outright. (No drain loop — the client under test keeps
            // its socket open until the reconnect path replaces it, so a
            // blocking server-side read here would deadlock the script.)
            let _ = ws.close(None);
            let _ = ws.flush();
            drop(ws);
        }
    })
}

/// Reads the next Text frame, treating the client's 200ms read timeouts as
/// normal poll ticks rather than failures.
fn read_text_with_retries<S: RealtimeSocket>(socket: &mut S) -> String {
    for _ in 0..100 {
        match socket.read_message() {
            Ok(Message::Text(text)) => return text.to_string(),
            Ok(_) => continue,
            Err(error) => {
                let text = error.to_string();
                if text.contains("timed out") || text.contains("WouldBlock") {
                    continue;
                }
                panic!("socket read failed: {error}");
            }
        }
    }
    panic!("no text frame arrived within the retry budget");
}

#[test]
fn real_client_survives_a_scripted_disconnect_and_replays_session_config() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind local ws server");
    let port = listener.local_addr().expect("local addr").port();
    let received = Arc::new(Mutex::new(Vec::new()));
    let (ready_tx, ready_rx) = mpsc::channel();
    let server = spawn_scripted_server(listener, 2, received.clone(), ready_tx);
    ready_rx.recv().expect("server ready");

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock tauri app");
    app.manage(AudioStateStore::new());
    let handle = app.handle().clone();
    let store = handle.state::<AudioStateStore>();
    let provider = local_provider(port);
    let connector = TungsteniteConnector;

    // Session 1: the real client connects and replays its session config.
    let mut socket = connector
        .reconnect(
            &handle,
            &provider,
            "Ethan",
            "",
            RealtimeAudioMode::Manual,
            OmniOutputMode::TextOnly,
            "zh-CN",
        )
        .expect("first session establishes");
    let created = read_text_with_retries(&mut socket);
    assert!(created.contains("session.created"));

    // The provider drops the connection; the next reads eventually fail or
    // deliver Close — that is what the worker feeds into try_reconnect.
    let mut saw_disconnect = false;
    for _ in 0..50 {
        match socket.read() {
            Ok(Message::Close(_)) => {
                saw_disconnect = true;
                break;
            }
            Err(error) => {
                let text = error.to_string();
                // Read timeouts are normal poll ticks; anything else is the
                // provider-side disconnect surfacing.
                if !(text.contains("timed out") || text.contains("WouldBlock")) {
                    saw_disconnect = true;
                    break;
                }
            }
            Ok(_) => continue,
        }
    }
    assert!(saw_disconnect, "scripted server must drop the first session");
    // Shadowing would keep the first TCP connection alive until end of scope
    // and block the scripted server's second accept — release it explicitly.
    drop(socket);

    // Session 2 via the REAL retry path (backoff, store transitions, cue).
    let mut reconnect_count = 0usize;
    let mut pending_audio = vec![1_i16, -1];
    let mut socket = try_reconnect(
        &connector,
        &mut reconnect_count,
        &mut pending_audio,
        &store,
        &handle,
        &provider,
        "Ethan",
        "",
        RealtimeAudioMode::Manual,
        OmniOutputMode::TextOnly,
        "zh-CN",
        0,
        "scripted provider disconnect",
    )
    .expect("reconnect against the local server succeeds");
    assert_eq!(reconnect_count, 0, "successful reconnect resets the retry counter");
    assert!(pending_audio.is_empty(), "stale response audio is dropped on reconnect");
    let created = read_text_with_retries(&mut socket);
    assert!(created.contains("session.created"));
    drop(socket);

    server.join().expect("scripted server thread");

    // Both sessions received the full session.update replay from the client.
    let received = received.lock().expect("received log");
    assert_eq!(received.len(), 2, "both sessions must see the config replay");
    for update in received.iter() {
        assert_eq!(update["type"], "session.update");
        assert_eq!(update["session"]["modalities"], json!(["text"]));
        assert!(update["session"].get("voice").is_none());
        assert!(update["session"].get("output_audio_format").is_none());
        assert!(update["session"]["turn_detection"].is_null());
    }

    // Store lifecycle: reconnecting was surfaced (progress cue) and the final
    // state is connected.
    let snapshot = store.snapshot();
    assert!(snapshot.stt_connected, "final state must be connected");
    assert_eq!(snapshot.stt_connection.state, "connected");
    assert!(
        snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.source_text.contains("正在重新连接")),
        "the reconnect progress cue must reach the overlay"
    );
}
