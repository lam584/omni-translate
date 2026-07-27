use std::collections::VecDeque;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};
use url::Url;

use super::diagnostics::diag_log;
use super::engine::emit_audio_snapshot;
use super::omni::OmniHandle;
use super::pcm_resample::{
    base64_encode_pcm16, pcm16_chunk_rms, resample_capture_to_mono_i16, SilenceGate,
};
use super::realtime_ws::{self, attempt_backoff_delay};
use super::state::AudioStateStore;
use super::time_utils::unix_ms;
use crate::diagnostics::model_trace::{ModelTraceCall, ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway_parts::auth::{apply_ws_auth, apply_ws_custom_headers};

const GEMINI_READ_TIMEOUT_MS: u64 = 200;
const GEMINI_WRITE_TIMEOUT_SECS: u64 = 10;
const GEMINI_INPUT_SAMPLE_RATE_HZ: u32 = 16_000;
const GEMINI_ASR_MIN_CHUNK_RMS: f32 = 0.002;
const GEMINI_ASR_SILENCE_GRACE_CHUNKS: u32 = 60;
const GEMINI_PRE_SESSION_AUDIO_QUEUE_LIMIT: usize = 500;
const GEMINI_PRE_SESSION_AUDIO_DRAIN_PER_TICK: usize = 4;
const GEMINI_RECONNECT_MAX_RETRIES: usize = 5;
const GEMINI_MANUAL_ACTIVITY_INTERVAL_SECS: u64 = 10;
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

pub(crate) fn build_setup(
    model: &str,
    instructions: &str,
    mode: GeminiActivityMode,
    target_language: &str,
    resumption_handle: Option<&str>,
) -> Value {
    let model_name = if model.starts_with("models/") {
        model.to_string()
    } else {
        format!("models/{model}")
    };
    // Live connections are cut server-side after ~10-15 minutes; declaring
    // sessionResumption lets us resume the conversation on the next socket.
    let session_resumption = match resumption_handle {
        Some(handle) => json!({ "handle": handle }),
        None => json!({}),
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
            },
            "contextWindowCompression": { "slidingWindow": {} },
            "sessionResumption": session_resumption
        }
    })
}

fn audio_message(encoded_pcm16: &str) -> Value {
    json!({
        "realtimeInput": {
            "audio": {
                "mimeType": format!("audio/pcm;rate={GEMINI_INPUT_SAMPLE_RATE_HZ}"),
                "data": encoded_pcm16
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

/// Manual mode: close the current activity window every interval so the
/// model actually produces output mid-session (an end-only-at-stop cycle
/// yields nothing until the route stops).
fn should_cycle_manual_activity(
    mode: GeminiActivityMode,
    activity_started: bool,
    audible_since_activity: bool,
    elapsed_secs: u64,
) -> bool {
    mode == GeminiActivityMode::Manual
        && activity_started
        && audible_since_activity
        && elapsed_secs >= GEMINI_MANUAL_ACTIVITY_INTERVAL_SECS
}

type GeminiSocket = realtime_ws::WsSocket;

/// Gemini model turns only ever carry text under "text" parts.
fn collect_model_text(value: &Value) -> String {
    realtime_ws::collect_text_fields(value, false)
}

fn transcription_text<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer)?.get("text").and_then(Value::as_str)
}

fn parse_resumption_update(evt: &Value) -> Option<String> {
    let update = evt.get("sessionResumptionUpdate")?;
    let resumable = update
        .get("resumable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !resumable {
        return None;
    }
    update
        .get("newHandle")
        .and_then(Value::as_str)
        .filter(|handle| !handle.is_empty())
        .map(str::to_string)
}

fn is_go_away_message(evt: &Value) -> bool {
    evt.get("goAway").is_some()
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

    let stt_epoch = store.begin_stt_session_epoch();
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
                stt_epoch,
                provider,
                instructions,
                mode,
                target_language,
                audio_rx,
                stop_rx,
            ) {
                let error = crate::audio::omni::session_errors::report_realtime_worker_failure(
                    &app_handle, "gemini", &error,
                );
                let _ = audio_state.set_stt_connected_if_current(stt_epoch, false, 0);
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

struct GeminiSessionRuntime {
    socket: GeminiSocket,
    session_ready: bool,
}

fn open_gemini_session(
    app: &AppHandle,
    provider: &ProviderDraftInput,
    instructions: &str,
    mode: GeminiActivityMode,
    target_language: &str,
    resumption_handle: Option<&str>,
    trace_call: &mut ModelTraceCall,
) -> Result<GeminiSessionRuntime, String> {
    let ws_url = build_gemini_live_url(&provider.base_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("failed to create Gemini Live request: {error}"))?;
    apply_ws_auth(provider, request.headers_mut())
        .map_err(|error| format!("failed to apply Gemini Live auth: {}", error.message))?;
    apply_ws_custom_headers(provider, request.headers_mut()).map_err(|error| {
        format!(
            "failed to apply Gemini Live custom headers: {}",
            error.message
        )
    })?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("failed to connect Gemini Live: {error}"))?;
    realtime_ws::set_socket_timeouts(
        &mut socket,
        Some(Duration::from_millis(GEMINI_READ_TIMEOUT_MS)),
        Some(Duration::from_secs(GEMINI_WRITE_TIMEOUT_SECS)),
    );

    let setup = build_setup(
        &provider.model,
        instructions,
        mode,
        target_language,
        resumption_handle,
    );
    trace_call.record_ws_send("setup", setup.clone());
    socket
        .send(Message::Text(setup.to_string().into()))
        .map_err(|error| format!("failed to send Gemini setup: {error}"))?;
    let _ = diag_log(
        app,
        "gemini-live",
        "info",
        format!(
            "Gemini Live connected model={} mode={} resumed={}",
            provider.model,
            mode.as_str(),
            resumption_handle.is_some()
        ),
    );
    Ok(GeminiSessionRuntime {
        socket,
        session_ready: false,
    })
}

struct GeminiCueState {
    cue_id: Option<String>,
    source_text: String,
    output_text: String,
}

impl GeminiCueState {
    fn new() -> Self {
        Self {
            cue_id: None,
            source_text: String::new(),
            output_text: String::new(),
        }
    }

    fn ensure_cue_id(&mut self) -> String {
        self.cue_id
            .get_or_insert_with(|| format!("gemini-cue-{}", unix_ms()))
            .clone()
    }

    fn reset(&mut self) {
        self.cue_id = None;
        self.source_text.clear();
        self.output_text.clear();
    }

    fn commit(&mut self, app: &AppHandle, store: &AudioStateStore) {
        if let Some(id) = self.cue_id.as_deref() {
            let source = if self.source_text.trim().is_empty() {
                self.output_text.as_str()
            } else {
                self.source_text.as_str()
            };
            if !source.trim().is_empty() {
                store.update_or_push_stt_cue(id, source, true);
                if !self.output_text.trim().is_empty() {
                    store.update_subtitle_cue_translation(id, self.output_text.clone(), true);
                }
                let _ = emit_audio_snapshot(app, store);
            }
        }
        self.reset();
    }
}

#[allow(clippy::too_many_arguments)]
fn run_gemini_worker(
    app: AppHandle,
    store: &AudioStateStore,
    stt_epoch: u64,
    provider: ProviderDraftInput,
    instructions: String,
    mode: GeminiActivityMode,
    target_language: String,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
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

    let mut resumption_handle: Option<String> = None;
    let mut session = open_gemini_session(
        &app,
        &provider,
        &instructions,
        mode,
        &target_language,
        None,
        &mut trace_call,
    )?;

    let mut cue = GeminiCueState::new();
    let mut gate = SilenceGate::new(GEMINI_ASR_MIN_CHUNK_RMS, GEMINI_ASR_SILENCE_GRACE_CHUNKS);
    let mut pre_session_queue: VecDeque<String> = VecDeque::new();
    let mut buffer_size = 0u64;
    let mut manual_activity_started = false;
    let mut audible_since_activity = false;
    let mut activity_window_started_at = Instant::now();
    let mut reconnect_retries = 0usize;

    let reconnect = |session: &mut GeminiSessionRuntime,
                         cue: &mut GeminiCueState,
                         manual_activity_started: &mut bool,
                         resumption_handle: &Option<String>,
                         reconnect_retries: &mut usize,
                         trace_call: &mut ModelTraceCall|
     -> bool {
        cue.commit(&app, store);
        *manual_activity_started = false;
        let _ = store.set_stt_connected_if_current(stt_epoch, false, 0);
        let _ = emit_audio_snapshot(&app, store);
        while *reconnect_retries < GEMINI_RECONNECT_MAX_RETRIES {
            *reconnect_retries += 1;
            let delay = attempt_backoff_delay(*reconnect_retries);
            let _ = diag_log(
                &app,
                "gemini-live",
                "warning",
                format!(
                    "Gemini Live reconnect attempt {}/{} in {}s (resumable={})",
                    reconnect_retries,
                    GEMINI_RECONNECT_MAX_RETRIES,
                    delay.as_secs(),
                    resumption_handle.is_some()
                ),
            );
            thread::sleep(delay);
            match open_gemini_session(
                &app,
                &provider,
                &instructions,
                mode,
                &target_language,
                resumption_handle.as_deref(),
                trace_call,
            ) {
                Ok(new_session) => {
                    *session = new_session;
                    return true;
                }
                Err(error) => {
                    let _ = diag_log(
                        &app,
                        "gemini-live",
                        "error",
                        format!("Gemini Live reconnect failed: {error}"),
                    );
                }
            }
        }
        false
    };

    'session_loop: loop {
        if stop_rx.try_recv().is_ok() {
            if mode == GeminiActivityMode::Manual && manual_activity_started {
                let _ = session
                    .socket
                    .send(Message::Text(activity_end_message().to_string().into()));
            } else if mode == GeminiActivityMode::Auto {
                let _ = session
                    .socket
                    .send(Message::Text(audio_stream_end_message().to_string().into()));
            }
            cue.commit(&app, store);
            let _ = session.socket.close(None);
            let _ = store.set_stt_connected_if_current(stt_epoch, false, buffer_size);
            let _ = emit_audio_snapshot(&app, store);
            return Ok(());
        }

        // Drain captured audio: 48k stereo f32 -> 16k mono pcm16, gate
        // silence, queue until setupComplete.
        let mut transport_failed = false;
        while let Ok(chunk) = audio_rx.try_recv() {
            let samples = resample_capture_to_mono_i16(&chunk, GEMINI_INPUT_SAMPLE_RATE_HZ);
            if samples.is_empty() {
                continue;
            }
            let rms = pcm16_chunk_rms(&samples);
            if !gate.should_send(rms) {
                continue;
            }
            if rms >= GEMINI_ASR_MIN_CHUNK_RMS {
                audible_since_activity = true;
            }
            let encoded = base64_encode_pcm16(&samples);
            if session.session_ready {
                if !send_gemini_audio(
                    &mut session,
                    &encoded,
                    mode,
                    &mut manual_activity_started,
                    &mut activity_window_started_at,
                    &mut buffer_size,
                    &mut trace_call,
                ) {
                    pre_session_queue.push_back(encoded);
                    transport_failed = true;
                    break;
                }
            } else {
                if pre_session_queue.len() >= GEMINI_PRE_SESSION_AUDIO_QUEUE_LIMIT {
                    pre_session_queue.pop_front();
                }
                pre_session_queue.push_back(encoded);
            }
        }

        if transport_failed {
            if !reconnect(
                &mut session,
                &mut cue,
                &mut manual_activity_started,
                &resumption_handle,
                &mut reconnect_retries,
                &mut trace_call,
            ) {
                return Err("Gemini Live reconnect retries exhausted".to_string());
            }
            continue 'session_loop;
        }

        if session.session_ready {
            for _ in 0..GEMINI_PRE_SESSION_AUDIO_DRAIN_PER_TICK {
                let Some(encoded) = pre_session_queue.pop_front() else {
                    break;
                };
                if !send_gemini_audio(
                    &mut session,
                    &encoded,
                    mode,
                    &mut manual_activity_started,
                    &mut activity_window_started_at,
                    &mut buffer_size,
                    &mut trace_call,
                ) {
                    pre_session_queue.push_front(encoded);
                    if !reconnect(
                        &mut session,
                        &mut cue,
                        &mut manual_activity_started,
                        &resumption_handle,
                        &mut reconnect_retries,
                        &mut trace_call,
                    ) {
                        return Err("Gemini Live reconnect retries exhausted".to_string());
                    }
                    continue 'session_loop;
                }
            }
        }

        if session.session_ready
            && should_cycle_manual_activity(
                mode,
                manual_activity_started,
                audible_since_activity,
                activity_window_started_at.elapsed().as_secs(),
            )
        {
            let msg = activity_end_message();
            trace_call.record_ws_send("realtimeInput.activityEnd", msg.clone());
            if session
                .socket
                .send(Message::Text(msg.to_string().into()))
                .is_err()
            {
                if !reconnect(
                    &mut session,
                    &mut cue,
                    &mut manual_activity_started,
                    &resumption_handle,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err("Gemini Live reconnect retries exhausted".to_string());
                }
                continue 'session_loop;
            }
            // Next audible chunk re-opens the window with activityStart.
            manual_activity_started = false;
            audible_since_activity = false;
        }

        match session.socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(evt) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                trace_call.record_ws_recv("serverMessage", evt.clone());
                if evt.get("setupComplete").is_some() {
                    session.session_ready = true;
                    reconnect_retries = 0;
                    let _ = store.set_stt_connected_if_current(stt_epoch, true, buffer_size);
                    let _ = emit_audio_snapshot(&app, store);
                    continue;
                }
                if let Some(handle) = parse_resumption_update(&evt) {
                    resumption_handle = Some(handle);
                    continue;
                }
                if is_go_away_message(&evt) {
                    let _ = diag_log(
                        &app,
                        "gemini-live",
                        "warning",
                        format!(
                            "Gemini Live goAway received (timeLeft={:?}); reconnecting proactively",
                            evt.pointer("/goAway/timeLeft").and_then(Value::as_str)
                        ),
                    );
                    if !reconnect(
                        &mut session,
                        &mut cue,
                        &mut manual_activity_started,
                        &resumption_handle,
                        &mut reconnect_retries,
                        &mut trace_call,
                    ) {
                        return Err("Gemini Live goAway and reconnects exhausted".to_string());
                    }
                    continue 'session_loop;
                }
                if evt
                    .pointer("/serverContent/interrupted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let _ = diag_log(
                        &app,
                        "gemini-live",
                        "info",
                        "Gemini Live generation interrupted".to_string(),
                    );
                }

                if let Some(input) = transcription_text(&evt, "/serverContent/inputTranscription") {
                    let id = cue.ensure_cue_id();
                    cue.source_text.push_str(input);
                    store.update_or_push_stt_cue(&id, &cue.source_text, false);
                    let _ = emit_audio_snapshot(&app, store);
                }

                if let Some(output) = transcription_text(&evt, "/serverContent/outputTranscription")
                {
                    let id = cue.ensure_cue_id();
                    cue.output_text.push_str(output);
                    store.update_subtitle_cue_translation(&id, cue.output_text.clone(), false);
                    let _ = emit_audio_snapshot(&app, store);
                }

                let model_text = collect_model_text(
                    evt.pointer("/serverContent/modelTurn")
                        .unwrap_or(&Value::Null),
                );
                if !model_text.trim().is_empty() {
                    let id = cue.ensure_cue_id();
                    cue.output_text.push_str(&model_text);
                    if cue.source_text.trim().is_empty() {
                        store.update_or_push_stt_cue(&id, &cue.output_text, false);
                    }
                    store.update_subtitle_cue_translation(&id, cue.output_text.clone(), false);
                    let _ = emit_audio_snapshot(&app, store);
                }

                let turn_complete = evt
                    .pointer("/serverContent/turnComplete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if turn_complete {
                    cue.commit(&app, store);
                    manual_activity_started = false;
                }
            }
            Ok(Message::Close(_)) => {
                let _ = diag_log(
                    &app,
                    "gemini-live",
                    "warning",
                    "Gemini Live socket closed by server; reconnecting".to_string(),
                );
                if !reconnect(
                    &mut session,
                    &mut cue,
                    &mut manual_activity_started,
                    &resumption_handle,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err("Gemini Live socket closed and reconnects exhausted".to_string());
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                let _ = diag_log(
                    &app,
                    "gemini-live",
                    "warning",
                    format!("Gemini Live socket read failed: {error}; reconnecting"),
                );
                if !reconnect(
                    &mut session,
                    &mut cue,
                    &mut manual_activity_started,
                    &resumption_handle,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err(format!(
                        "Gemini Live socket read failed after retries: {error}"
                    ));
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn send_gemini_audio(
    session: &mut GeminiSessionRuntime,
    encoded: &str,
    mode: GeminiActivityMode,
    manual_activity_started: &mut bool,
    activity_window_started_at: &mut Instant,
    buffer_size: &mut u64,
    trace_call: &mut ModelTraceCall,
) -> bool {
    if mode == GeminiActivityMode::Manual && !*manual_activity_started {
        let msg = activity_start_message();
        trace_call.record_ws_send("realtimeInput.activityStart", msg.clone());
        if session
            .socket
            .send(Message::Text(msg.to_string().into()))
            .is_err()
        {
            return false;
        }
        *manual_activity_started = true;
        *activity_window_started_at = Instant::now();
    }
    *buffer_size = buffer_size.saturating_add((encoded.len() / 4 * 3) as u64);
    trace_call.record_ws_send(
        "realtimeInput.audio",
        json!({"bytes": encoded.len() / 4 * 3}),
    );
    session
        .socket
        .send(Message::Text(audio_message(encoded).to_string().into()))
        .is_ok()
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
            None,
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
            None,
        );
        assert_eq!(
            manual
                .pointer("/setup/realtimeInputConfig/automaticActivityDetection/disabled")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn setup_declares_session_resumption_and_carries_handle_on_reconnect() {
        let fresh = build_setup(
            "gemini-3.1-flash-live-preview",
            "translate",
            GeminiActivityMode::Auto,
            "zh",
            None,
        );
        assert!(fresh
            .pointer("/setup/sessionResumption")
            .is_some_and(|v| v.is_object() && v.get("handle").is_none()));
        assert!(fresh
            .pointer("/setup/contextWindowCompression/slidingWindow")
            .is_some());

        let resumed = build_setup(
            "gemini-3.1-flash-live-preview",
            "translate",
            GeminiActivityMode::Auto,
            "zh",
            Some("handle-123"),
        );
        assert_eq!(
            resumed
                .pointer("/setup/sessionResumption/handle")
                .and_then(Value::as_str),
            Some("handle-123")
        );
    }

    #[test]
    fn resumption_update_parsing_requires_resumable_handle() {
        let resumable = json!({
            "sessionResumptionUpdate": { "resumable": true, "newHandle": "h1" }
        });
        assert_eq!(parse_resumption_update(&resumable).as_deref(), Some("h1"));

        let not_resumable = json!({
            "sessionResumptionUpdate": { "resumable": false, "newHandle": "h2" }
        });
        assert!(parse_resumption_update(&not_resumable).is_none());

        let empty_handle = json!({
            "sessionResumptionUpdate": { "resumable": true, "newHandle": "" }
        });
        assert!(parse_resumption_update(&empty_handle).is_none());
    }

    #[test]
    fn go_away_message_is_detected() {
        assert!(is_go_away_message(&json!({ "goAway": { "timeLeft": "10s" } })));
        assert!(!is_go_away_message(&json!({ "serverContent": {} })));
    }

    #[test]
    fn manual_activity_cycles_only_with_audible_audio_and_interval() {
        assert!(should_cycle_manual_activity(
            GeminiActivityMode::Manual,
            true,
            true,
            GEMINI_MANUAL_ACTIVITY_INTERVAL_SECS
        ));
        assert!(!should_cycle_manual_activity(
            GeminiActivityMode::Manual,
            true,
            false,
            GEMINI_MANUAL_ACTIVITY_INTERVAL_SECS
        ));
        assert!(!should_cycle_manual_activity(
            GeminiActivityMode::Manual,
            true,
            true,
            GEMINI_MANUAL_ACTIVITY_INTERVAL_SECS - 1
        ));
        assert!(!should_cycle_manual_activity(
            GeminiActivityMode::Auto,
            true,
            true,
            GEMINI_MANUAL_ACTIVITY_INTERVAL_SECS
        ));
    }
}
