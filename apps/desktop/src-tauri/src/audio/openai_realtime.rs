use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message};
use url::Url;

use super::diagnostics::diag_log;
use super::engine::emit_audio_snapshot;
use super::omni::{OmniHandle, RealtimeAudioMode};
use super::state::AudioStateStore;
use super::time_utils::unix_ms;
use crate::diagnostics::model_trace::{ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway;

const OPENAI_READ_TIMEOUT_MS: u64 = 200;
const OPENAI_WRITE_TIMEOUT_SECS: u64 = 10;
const OPENAI_MANUAL_COMMIT_INTERVAL_SECS: u64 = 10;

pub fn build_openai_realtime_url(base_url: &str, model: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(base_url.trim()).map_err(|error| format!("invalid OpenAI base URL: {error}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        "wss" | "ws" => url.scheme(),
        other => return Err(format!("unsupported OpenAI realtime URL scheme: {other}")),
    }
    .to_string();
    url.set_scheme(&scheme)
        .map_err(|_| format!("unsupported OpenAI realtime URL scheme: {scheme}"))?;

    let path = url.path().trim_end_matches('/').to_string();
    let realtime_path = if path.is_empty() || path == "/" {
        "/v1/realtime".to_string()
    } else if path.ends_with("/realtime") {
        path
    } else {
        format!("{path}/realtime")
    };
    url.set_path(&realtime_path);
    url.query_pairs_mut().clear().append_pair("model", model);
    Ok(url)
}

fn set_socket_timeouts(socket: &mut tungstenite::WebSocket<MaybeTlsStream<std::net::TcpStream>>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(OPENAI_READ_TIMEOUT_MS)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(OPENAI_WRITE_TIMEOUT_SECS)));
        }
        MaybeTlsStream::Rustls(stream) => {
            let inner = stream.get_mut();
            let _ = inner.set_read_timeout(Some(Duration::from_millis(OPENAI_READ_TIMEOUT_MS)));
            let _ = inner.set_write_timeout(Some(Duration::from_secs(OPENAI_WRITE_TIMEOUT_SECS)));
        }
        _ => {}
    }
}

fn build_session_update(
    model: &str,
    instructions: &str,
    mode: RealtimeAudioMode,
    target_language: &str,
) -> Value {
    let instructions = format!(
        "{instructions}\nTranslate or transcribe the incoming audio for watch-mode subtitles. Target language: {target_language}. Output concise subtitle text only."
    );
    json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "model": model,
            "instructions": instructions,
            "output_modalities": ["text"],
            "audio": {
                "input": {
                    "format": {
                        "type": "audio/pcm",
                        "rate": 24000
                    },
                    "turn_detection": mode.turn_detection()
                }
            }
        }
    })
}

fn build_response_create() -> Value {
    json!({
        "type": "response.create",
        "response": {
            "modalities": ["text"]
        }
    })
}

fn extract_text_delta(evt: &Value) -> Option<&str> {
    evt.pointer("/delta")
        .and_then(Value::as_str)
        .or_else(|| evt.pointer("/text").and_then(Value::as_str))
        .or_else(|| evt.pointer("/transcript").and_then(Value::as_str))
}

fn response_done_text(evt: &Value) -> String {
    fn walk(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                if let Some(text) = map
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| map.get("transcript").and_then(Value::as_str))
                {
                    out.push_str(text);
                }
                for child in map.values() {
                    walk(child, out);
                }
            }
            Value::Array(items) => {
                for child in items {
                    walk(child, out);
                }
            }
            _ => {}
        }
    }

    let mut out = String::new();
    walk(evt.pointer("/response").unwrap_or(evt), &mut out);
    out
}

fn commit_response_messages() -> [Value; 2] {
    [
        json!({ "type": "input_audio_buffer.commit" }),
        build_response_create(),
    ]
}

pub fn start_openai_realtime(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    instructions: String,
    audio_mode: RealtimeAudioMode,
    target_language: String,
) -> Result<(mpsc::Sender<Vec<u8>>, OmniHandle), String> {
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    store.set_stt_connected(false, 0);
    let app_handle = app.clone();
    let model = provider.model.clone();
    let join_handle = thread::Builder::new()
        .name("openai-realtime".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            if let Err(error) = run_openai_worker(
                app_handle.clone(),
                &audio_state,
                provider,
                instructions,
                audio_mode,
                target_language,
                audio_rx,
                stop_rx,
            ) {
                audio_state.set_stt_connected(false, 0);
                let _ = diag_log(
                    &app_handle,
                    "openai-realtime",
                    "error",
                    format!("OpenAI Realtime error: {error}; model={model}"),
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| format!("failed to spawn OpenAI realtime thread: {error}"))?;

    Ok((
        audio_tx,
        OmniHandle {
            stop_tx,
            join_handle,
        },
    ))
}

fn run_openai_worker(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    instructions: String,
    audio_mode: RealtimeAudioMode,
    target_language: String,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let ws_url = build_openai_realtime_url(&provider.base_url, &provider.model)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("failed to create OpenAI realtime request: {error}"))?;
    gateway::apply_ws_auth(&provider, request.headers_mut())
        .map_err(|error| format!("failed to apply OpenAI realtime auth: {}", error.message))?;
    request.headers_mut().insert(
        "OpenAI-Beta",
        "realtime=v1"
            .parse()
            .map_err(|error| format!("failed to build OpenAI-Beta header: {error}"))?,
    );

    let (mut socket, _) =
        connect(request).map_err(|error| format!("failed to connect OpenAI Realtime: {error}"))?;
    set_socket_timeouts(&mut socket);

    let trace = ModelTraceRecorder::new(
        app.clone(),
        ModelTraceContext::new(
            provider.provider_id.clone(),
            provider.model.clone(),
            "openai-realtime",
        )
        .with_route_mode("watch"),
    );
    let mut trace_call = trace.call("openai.websocket_session");
    let session =
        build_session_update(&provider.model, &instructions, audio_mode, &target_language);
    trace_call.record_ws_send("session.update", session.clone());
    socket
        .send(Message::Text(session.to_string().into()))
        .map_err(|error| format!("failed to send OpenAI session.update: {error}"))?;

    store.set_stt_connected(true, 0);
    let _ = emit_audio_snapshot(&app, store);
    let _ = diag_log(
        &app,
        "openai-realtime",
        "info",
        format!(
            "OpenAI Realtime connected model={} realtimeAudioMode={}",
            provider.model,
            audio_mode.as_str()
        ),
    );

    let mut cue_id: Option<String> = None;
    let mut source_text = String::new();
    let mut output_text = String::new();
    let mut buffer_size = 0u64;
    let mut last_manual_commit = SystemTime::now();
    let mut sent_audio_since_commit = false;

    loop {
        if stop_rx.try_recv().is_ok() {
            if audio_mode.uses_manual_commit() && sent_audio_since_commit {
                for msg in commit_response_messages() {
                    let _ = socket.send(Message::Text(msg.to_string().into()));
                }
            }
            let _ = socket.close(None);
            store.set_stt_connected(false, buffer_size);
            let _ = emit_audio_snapshot(&app, store);
            return Ok(());
        }

        while let Ok(chunk) = audio_rx.try_recv() {
            buffer_size = buffer_size.saturating_add(chunk.len() as u64);
            let audio = base64::engine::general_purpose::STANDARD.encode(&chunk);
            let append = json!({ "type": "input_audio_buffer.append", "audio": audio });
            trace_call.record_ws_send(
                "input_audio_buffer.append",
                json!({"type": "input_audio_buffer.append", "bytes": chunk.len()}),
            );
            socket
                .send(Message::Text(append.to_string().into()))
                .map_err(|error| format!("failed to send OpenAI audio chunk: {error}"))?;
            sent_audio_since_commit = true;
        }

        if audio_mode.uses_manual_commit()
            && sent_audio_since_commit
            && last_manual_commit.elapsed().unwrap_or_default().as_secs()
                >= OPENAI_MANUAL_COMMIT_INTERVAL_SECS
        {
            for msg in commit_response_messages() {
                trace_call
                    .record_ws_send(msg["type"].as_str().unwrap_or("client.event"), msg.clone());
                socket
                    .send(Message::Text(msg.to_string().into()))
                    .map_err(|error| format!("failed to send OpenAI manual commit: {error}"))?;
            }
            last_manual_commit = SystemTime::now();
            sent_audio_since_commit = false;
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(evt) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let event_type = evt["type"].as_str().unwrap_or("(unknown)");
                trace_call.record_ws_recv(event_type, evt.clone());
                match event_type {
                    "input_audio_buffer.speech_started" => {
                        let id = format!("openai-cue-{}", unix_ms());
                        cue_id = Some(id.clone());
                        source_text.clear();
                        output_text.clear();
                        store.update_or_push_stt_cue(&id, "", false);
                        let _ = emit_audio_snapshot(&app, store);
                    }
                    "conversation.item.input_audio_transcription.delta"
                    | "conversation.item.input_audio_transcription.text" => {
                        if cue_id.is_none() {
                            cue_id = Some(format!("openai-cue-{}", unix_ms()));
                        }
                        if let Some(delta) = extract_text_delta(&evt) {
                            source_text.push_str(delta);
                            if let Some(id) = cue_id.as_deref() {
                                store.update_or_push_stt_cue(id, &source_text, false);
                                let _ = emit_audio_snapshot(&app, store);
                            }
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        if cue_id.is_none() {
                            cue_id = Some(format!("openai-cue-{}", unix_ms()));
                        }
                        if let Some(text) = extract_text_delta(&evt) {
                            source_text = text.to_string();
                            if let Some(id) = cue_id.as_deref() {
                                store.update_or_push_stt_cue(id, &source_text, false);
                                let _ = emit_audio_snapshot(&app, store);
                            }
                        }
                    }
                    "response.output_text.delta" | "response.audio_transcript.delta" => {
                        if cue_id.is_none() {
                            cue_id = Some(format!("openai-cue-{}", unix_ms()));
                        }
                        if let Some(delta) = extract_text_delta(&evt) {
                            output_text.push_str(delta);
                            if let Some(id) = cue_id.as_deref() {
                                if source_text.trim().is_empty() {
                                    store.update_or_push_stt_cue(id, &output_text, false);
                                }
                                store.update_subtitle_cue_translation(
                                    id,
                                    output_text.clone(),
                                    false,
                                );
                                let _ = emit_audio_snapshot(&app, store);
                            }
                        }
                    }
                    "response.output_text.done" | "response.audio_transcript.done" => {
                        if let Some(text) = extract_text_delta(&evt) {
                            output_text = text.to_string();
                            if let Some(id) = cue_id.as_deref() {
                                if source_text.trim().is_empty() {
                                    store.update_or_push_stt_cue(id, &output_text, false);
                                }
                                store.update_subtitle_cue_translation(
                                    id,
                                    output_text.clone(),
                                    false,
                                );
                                let _ = emit_audio_snapshot(&app, store);
                            }
                        }
                    }
                    "response.done" => {
                        let done_text = response_done_text(&evt);
                        if !done_text.trim().is_empty() && output_text.trim().is_empty() {
                            output_text = done_text;
                        }
                        if cue_id.is_none() {
                            cue_id = Some(format!("openai-cue-{}", unix_ms()));
                        }
                        if let Some(id) = cue_id.as_deref() {
                            let source = if source_text.trim().is_empty() {
                                output_text.as_str()
                            } else {
                                source_text.as_str()
                            };
                            store.update_or_push_stt_cue(id, source, true);
                            if !output_text.trim().is_empty() {
                                store.update_subtitle_cue_translation(
                                    id,
                                    output_text.clone(),
                                    true,
                                );
                            }
                            let _ = emit_audio_snapshot(&app, store);
                        }
                        cue_id = None;
                        source_text.clear();
                        output_text.clear();
                    }
                    "error" => {
                        let message = evt
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown OpenAI realtime error");
                        trace_call.error(message);
                        let _ = diag_log(&app, "openai-realtime", "error", message.to_string());
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return Err("OpenAI realtime socket closed".to_string()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => return Err(format!("OpenAI realtime socket read failed: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_realtime_url_uses_v1_realtime_endpoint() {
        let url = build_openai_realtime_url("https://api.openai.com/v1", "gpt-realtime").unwrap();
        assert_eq!(
            url.as_str(),
            "wss://api.openai.com/v1/realtime?model=gpt-realtime"
        );
    }

    #[test]
    fn openai_realtime_url_preserves_proxy_path_prefix() {
        let url = build_openai_realtime_url("https://proxy.example.com/openai/v1", "gpt-realtime")
            .unwrap();
        assert_eq!(
            url.as_str(),
            "wss://proxy.example.com/openai/v1/realtime?model=gpt-realtime"
        );
    }

    #[test]
    fn session_update_maps_audio_modes() {
        let manual =
            build_session_update("gpt-realtime", "translate", RealtimeAudioMode::Manual, "zh");
        assert!(manual
            .pointer("/session/audio/input/turn_detection")
            .unwrap()
            .is_null());

        let semantic = build_session_update(
            "gpt-realtime",
            "translate",
            RealtimeAudioMode::SemanticVad,
            "zh",
        );
        assert_eq!(
            semantic
                .pointer("/session/audio/input/turn_detection/type")
                .and_then(Value::as_str),
            Some("semantic_vad")
        );
    }
}
