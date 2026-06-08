use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message};
use url::Url;

use super::diagnostics::diag_log;
use super::engine::emit_audio_snapshot;
use super::omni::OmniHandle;
use super::state::AudioStateStore;
use super::time_utils::unix_ms;
use crate::diagnostics::model_trace::{ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway;

const GEMINI_READ_TIMEOUT_MS: u64 = 200;
const GEMINI_WRITE_TIMEOUT_SECS: u64 = 10;
const GEMINI_LIVE_SERVICE: &str =
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeminiActivityMode {
    Auto,
    Manual,
}

impl GeminiActivityMode {
    pub fn from_config_value(value: &str) -> Result<Self, String> {
        match value {
            "gemini_auto_activity" => Ok(Self::Auto),
            "gemini_manual_activity" => Ok(Self::Manual),
            other => Err(format!("unsupported Gemini Live activity mode: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "gemini_auto_activity",
            Self::Manual => "gemini_manual_activity",
        }
    }
}

pub fn is_gemini_activity_mode(value: &str) -> bool {
    matches!(value, "gemini_auto_activity" | "gemini_manual_activity")
}

pub fn build_gemini_live_url(base_url: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(base_url.trim()).map_err(|error| format!("invalid Gemini base URL: {error}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        "wss" | "ws" => url.scheme(),
        other => return Err(format!("unsupported Gemini Live URL scheme: {other}")),
    }
    .to_string();
    url.set_scheme(&scheme)
        .map_err(|_| format!("unsupported Gemini Live URL scheme: {scheme}"))?;
    url.set_path(&format!("/ws/{GEMINI_LIVE_SERVICE}"));
    Ok(url)
}

fn build_setup(
    model: &str,
    instructions: &str,
    mode: GeminiActivityMode,
    target_language: &str,
) -> Value {
    let model_name = if model.starts_with("models/") {
        model.to_string()
    } else {
        format!("models/{model}")
    };
    json!({
        "setup": {
            "model": model_name,
            "generationConfig": {
                "responseModalities": ["TEXT"]
            },
            "systemInstruction": {
                "parts": [{
                    "text": format!("{instructions}\nTranslate incoming audio into concise subtitles. Target language: {target_language}.")
                }]
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "realtimeInputConfig": {
                "automaticActivityDetection": {
                    "disabled": mode == GeminiActivityMode::Manual
                }
            }
        }
    })
}

fn audio_message(chunk: &[u8]) -> Value {
    json!({
        "realtimeInput": {
            "audio": {
                "mimeType": "audio/pcm;rate=16000",
                "data": base64::engine::general_purpose::STANDARD.encode(chunk)
            }
        }
    })
}

fn activity_start_message() -> Value {
    json!({ "realtimeInput": { "activityStart": {} } })
}

fn activity_end_message() -> Value {
    json!({ "realtimeInput": { "activityEnd": {} } })
}

fn audio_stream_end_message() -> Value {
    json!({ "realtimeInput": { "audioStreamEnd": true } })
}

fn set_socket_timeouts(socket: &mut tungstenite::WebSocket<MaybeTlsStream<std::net::TcpStream>>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(GEMINI_READ_TIMEOUT_MS)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(GEMINI_WRITE_TIMEOUT_SECS)));
        }
        MaybeTlsStream::Rustls(stream) => {
            let inner = stream.get_mut();
            let _ = inner.set_read_timeout(Some(Duration::from_millis(GEMINI_READ_TIMEOUT_MS)));
            let _ = inner.set_write_timeout(Some(Duration::from_secs(GEMINI_WRITE_TIMEOUT_SECS)));
        }
        _ => {}
    }
}

fn collect_model_text(value: &Value) -> String {
    fn walk(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
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
    walk(value, &mut out);
    out
}

fn transcription_text<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer)?.get("text").and_then(Value::as_str)
}

pub fn start_gemini_live(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    instructions: String,
    mode: GeminiActivityMode,
    target_language: String,
) -> Result<(mpsc::Sender<Vec<u8>>, OmniHandle), String> {
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    store.set_stt_connected(false, 0);
    let app_handle = app.clone();
    let model = provider.model.clone();
    let join_handle = thread::Builder::new()
        .name("gemini-live".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            if let Err(error) = run_gemini_worker(
                app_handle.clone(),
                &audio_state,
                provider,
                instructions,
                mode,
                target_language,
                audio_rx,
                stop_rx,
            ) {
                audio_state.set_stt_connected(false, 0);
                let _ = diag_log(
                    &app_handle,
                    "gemini-live",
                    "error",
                    format!("Gemini Live error: {error}; model={model}"),
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| format!("failed to spawn Gemini Live thread: {error}"))?;

    Ok((
        audio_tx,
        OmniHandle {
            stop_tx,
            join_handle,
        },
    ))
}

fn run_gemini_worker(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    instructions: String,
    mode: GeminiActivityMode,
    target_language: String,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let ws_url = build_gemini_live_url(&provider.base_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("failed to create Gemini Live request: {error}"))?;
    gateway::apply_ws_auth(&provider, request.headers_mut())
        .map_err(|error| format!("failed to apply Gemini Live auth: {}", error.message))?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("failed to connect Gemini Live: {error}"))?;
    set_socket_timeouts(&mut socket);

    let trace = ModelTraceRecorder::new(
        app.clone(),
        ModelTraceContext::new(
            provider.provider_id.clone(),
            provider.model.clone(),
            "gemini-live",
        )
        .with_route_mode("watch"),
    );
    let mut trace_call = trace.call("gemini.websocket_session");
    let setup = build_setup(&provider.model, &instructions, mode, &target_language);
    trace_call.record_ws_send("setup", setup.clone());
    socket
        .send(Message::Text(setup.to_string().into()))
        .map_err(|error| format!("failed to send Gemini setup: {error}"))?;

    store.set_stt_connected(true, 0);
    let _ = emit_audio_snapshot(&app, store);
    let _ = diag_log(
        &app,
        "gemini-live",
        "info",
        format!(
            "Gemini Live connected model={} mode={}",
            provider.model,
            mode.as_str()
        ),
    );

    let mut cue_id: Option<String> = None;
    let mut source_text = String::new();
    let mut output_text = String::new();
    let mut buffer_size = 0u64;
    let mut manual_activity_started = false;

    loop {
        if stop_rx.try_recv().is_ok() {
            if mode == GeminiActivityMode::Manual && manual_activity_started {
                let _ = socket.send(Message::Text(activity_end_message().to_string().into()));
            } else if mode == GeminiActivityMode::Auto {
                let _ = socket.send(Message::Text(audio_stream_end_message().to_string().into()));
            }
            let _ = socket.close(None);
            store.set_stt_connected(false, buffer_size);
            let _ = emit_audio_snapshot(&app, store);
            return Ok(());
        }

        while let Ok(chunk) = audio_rx.try_recv() {
            if mode == GeminiActivityMode::Manual && !manual_activity_started {
                let msg = activity_start_message();
                trace_call.record_ws_send("realtimeInput.activityStart", msg.clone());
                socket
                    .send(Message::Text(msg.to_string().into()))
                    .map_err(|error| format!("failed to send Gemini activityStart: {error}"))?;
                manual_activity_started = true;
            }
            buffer_size = buffer_size.saturating_add(chunk.len() as u64);
            let msg = audio_message(&chunk);
            trace_call.record_ws_send("realtimeInput.audio", json!({"bytes": chunk.len()}));
            socket
                .send(Message::Text(msg.to_string().into()))
                .map_err(|error| format!("failed to send Gemini audio: {error}"))?;
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(evt) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                trace_call.record_ws_recv("serverMessage", evt.clone());
                if evt.get("setupComplete").is_some() {
                    continue;
                }

                if let Some(input) = transcription_text(&evt, "/serverContent/inputTranscription") {
                    if cue_id.is_none() {
                        cue_id = Some(format!("gemini-cue-{}", unix_ms()));
                    }
                    source_text.push_str(input);
                    if let Some(id) = cue_id.as_deref() {
                        store.update_or_push_stt_cue(id, &source_text, false);
                        let _ = emit_audio_snapshot(&app, store);
                    }
                }

                if let Some(output) = transcription_text(&evt, "/serverContent/outputTranscription")
                {
                    if cue_id.is_none() {
                        cue_id = Some(format!("gemini-cue-{}", unix_ms()));
                    }
                    output_text.push_str(output);
                    if let Some(id) = cue_id.as_deref() {
                        store.update_subtitle_cue_translation(id, output_text.clone(), false);
                        let _ = emit_audio_snapshot(&app, store);
                    }
                }

                let model_text = collect_model_text(
                    evt.pointer("/serverContent/modelTurn")
                        .unwrap_or(&Value::Null),
                );
                if !model_text.trim().is_empty() {
                    if cue_id.is_none() {
                        cue_id = Some(format!("gemini-cue-{}", unix_ms()));
                    }
                    output_text.push_str(&model_text);
                    if let Some(id) = cue_id.as_deref() {
                        if source_text.trim().is_empty() {
                            store.update_or_push_stt_cue(id, &output_text, false);
                        }
                        store.update_subtitle_cue_translation(id, output_text.clone(), false);
                        let _ = emit_audio_snapshot(&app, store);
                    }
                }

                let turn_complete = evt
                    .pointer("/serverContent/turnComplete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if turn_complete {
                    if let Some(id) = cue_id.as_deref() {
                        let source = if source_text.trim().is_empty() {
                            output_text.as_str()
                        } else {
                            source_text.as_str()
                        };
                        store.update_or_push_stt_cue(id, source, true);
                        if !output_text.trim().is_empty() {
                            store.update_subtitle_cue_translation(id, output_text.clone(), true);
                        }
                        let _ = emit_audio_snapshot(&app, store);
                    }
                    cue_id = None;
                    source_text.clear();
                    output_text.clear();
                    manual_activity_started = false;
                }
            }
            Ok(Message::Close(_)) => return Err("Gemini Live socket closed".to_string()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => return Err(format!("Gemini Live socket read failed: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_live_url_uses_bidi_generate_content_endpoint() {
        let url = build_gemini_live_url("https://generativelanguage.googleapis.com/v1beta/openai")
            .unwrap();
        assert_eq!(
            url.as_str(),
            "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        );
    }

    #[test]
    fn setup_maps_auto_and_manual_activity_modes() {
        let auto = build_setup(
            "gemini-2.5-flash-live",
            "translate",
            GeminiActivityMode::Auto,
            "zh",
        );
        assert_eq!(
            auto.pointer("/setup/realtimeInputConfig/automaticActivityDetection/disabled")
                .and_then(Value::as_bool),
            Some(false)
        );

        let manual = build_setup(
            "gemini-2.5-flash-live",
            "translate",
            GeminiActivityMode::Manual,
            "zh",
        );
        assert_eq!(
            manual
                .pointer("/setup/realtimeInputConfig/automaticActivityDetection/disabled")
                .and_then(Value::as_bool),
            Some(true)
        );
    }
}
