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
use super::glossary::GlossaryContext;
use super::omni::{OmniHandle, RealtimeAudioMode};
use super::realtime_cue::commit_realtime_cue;
use super::pcm_resample::{
    base64_encode_pcm16, pcm16_chunk_rms, resample_capture_to_mono_i16, SilenceGate,
};
use super::realtime_ws::{self, attempt_backoff_delay};
use super::state::AudioStateStore;
use super::time_utils::unix_ms;
use crate::diagnostics::model_trace::{ModelTraceCall, ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway_parts::auth::{apply_ws_auth, apply_ws_custom_headers};

const OPENAI_READ_TIMEOUT_MS: u64 = 200;
const OPENAI_WRITE_TIMEOUT_SECS: u64 = 10;
const OPENAI_MANUAL_COMMIT_INTERVAL_SECS: u64 = 10;
const OPENAI_INPUT_SAMPLE_RATE_HZ: u32 = 24_000;
const OPENAI_ASR_MIN_CHUNK_RMS: f32 = 0.002;
const MAX_AUDIO_CHUNKS_PER_TICK: usize = 8;
const OPENAI_ASR_SILENCE_GRACE_CHUNKS: u32 = 60;
const OPENAI_PRE_SESSION_AUDIO_QUEUE_LIMIT: usize = 500;
const OPENAI_PRE_SESSION_AUDIO_DRAIN_PER_TICK: usize = 4;
const OPENAI_RECONNECT_MAX_RETRIES: usize = 5;
const OPENAI_INPUT_TRANSCRIPTION_MODEL: &str = "gpt-4o-mini-transcribe";
/// The translation endpoint streams continuously without turn boundaries, so
/// cue segmentation happens client-side on delta idle gaps.
const TRANSLATION_CUE_IDLE_COMMIT_MS: u64 = 1_500;
const TRANSLATION_CUE_TERMINAL_COMMIT_MS: u64 = 600;
const SESSION_CLOSE_DRAIN_TIMEOUT_MS: u64 = 3_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenAiRealtimeDialect {
    /// GA conversation session on /v1/realtime (gpt-realtime-2.1 family).
    Conversation,
    /// Dedicated streaming translation endpoint /v1/realtime/translations
    /// (gpt-realtime-translate): emits source + translated transcript deltas.
    Translation,
    /// Transcription-only session on /v1/realtime?intent=transcription
    /// (gpt-realtime-whisper, gpt-4o-(mini-)transcribe, whisper-1).
    Transcription,
    /// Beta-era flat session shape spoken by OpenAI-realtime-style Chinese
    /// providers (Zhipu GLM glm-realtime-*): flat session fields, 16 kHz
    /// input, `response.text.delta` output events.
    FlatCompat,
}

#[cfg(test)]
pub(crate) fn resolve_dialect(model: &str) -> OpenAiRealtimeDialect {
    let lower = model.to_ascii_lowercase();
    if lower.contains("glm") {
        OpenAiRealtimeDialect::FlatCompat
    } else if lower.contains("translate") {
        OpenAiRealtimeDialect::Translation
    } else if lower.contains("transcribe") || lower.contains("whisper") {
        OpenAiRealtimeDialect::Transcription
    } else {
        OpenAiRealtimeDialect::Conversation
    }
}

fn resolve_provider_dialect(provider: &ProviderDraftInput) -> Result<OpenAiRealtimeDialect, String> {
    let protocol = super::events::resolve_realtime_profile(provider, &provider.model)
        .protocol_dialect
        .ok_or_else(|| format!("provider '{}' has no realtime protocol", provider.provider_id))?;
    dialect_from_protocol(protocol)
}

pub(crate) fn dialect_from_protocol(
    protocol: super::events::RealtimeProtocol,
) -> Result<OpenAiRealtimeDialect, String> {
    use super::events::RealtimeProtocol;

    match protocol {
        RealtimeProtocol::OpenAiConversation => Ok(OpenAiRealtimeDialect::Conversation),
        RealtimeProtocol::OpenAiTranslation => Ok(OpenAiRealtimeDialect::Translation),
        RealtimeProtocol::OpenAiTranscription => Ok(OpenAiRealtimeDialect::Transcription),
        RealtimeProtocol::OpenAiFlat => Ok(OpenAiRealtimeDialect::FlatCompat),
        protocol => Err(format!("not an OpenAI realtime protocol: {protocol:?}")),
    }
}

fn dialect_input_rate(dialect: OpenAiRealtimeDialect) -> u32 {
    match dialect {
        OpenAiRealtimeDialect::FlatCompat => 16_000,
        _ => OPENAI_INPUT_SAMPLE_RATE_HZ,
    }
}

fn build_realtime_base_url(base_url: &str) -> Result<Url, String> {
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
    url.set_query(None);
    Ok(url)
}

pub(crate) fn build_openai_realtime_url(base_url: &str, model: &str) -> Result<Url, String> {
    let mut url = build_realtime_base_url(base_url)?;
    url.query_pairs_mut().clear().append_pair("model", model);
    Ok(url)
}

pub(crate) fn build_openai_translation_url(base_url: &str, model: &str) -> Result<Url, String> {
    let mut url = build_realtime_base_url(base_url)?;
    let path = url.path().trim_end_matches('/').to_string();
    if !path.ends_with("/translations") {
        url.set_path(&format!("{path}/translations"));
    }
    url.query_pairs_mut().clear().append_pair("model", model);
    Ok(url)
}

pub(crate) fn build_openai_transcription_url(base_url: &str) -> Result<Url, String> {
    let mut url = build_realtime_base_url(base_url)?;
    url.query_pairs_mut()
        .clear()
        .append_pair("intent", "transcription");
    Ok(url)
}

pub(crate) fn build_ws_url(dialect: OpenAiRealtimeDialect, base_url: &str, model: &str) -> Result<Url, String> {
    match dialect {
        OpenAiRealtimeDialect::Conversation | OpenAiRealtimeDialect::FlatCompat => {
            build_openai_realtime_url(base_url, model)
        }
        OpenAiRealtimeDialect::Translation => build_openai_translation_url(base_url, model),
        OpenAiRealtimeDialect::Transcription => build_openai_transcription_url(base_url),
    }
}

/// ISO 639-1 base code for the translation endpoint's output language.
fn normalize_translation_language(lang: &str) -> String {
    let base = lang
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if base.is_empty() {
        "zh".to_string()
    } else {
        base
    }
}

fn openai_turn_detection(mode: RealtimeAudioMode, create_response: bool) -> Value {
    match mode {
        RealtimeAudioMode::Manual => Value::Null,
        RealtimeAudioMode::ServerVad => json!({
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
            "create_response": create_response,
            "interrupt_response": false
        }),
        RealtimeAudioMode::SemanticVad => json!({
            "type": "semantic_vad",
            "eagerness": "auto",
            "create_response": create_response,
            "interrupt_response": false
        }),
    }
}

pub(crate) fn build_conversation_session_update(
    instructions: &str,
    mode: RealtimeAudioMode,
    target_language: &str,
    subtitle_translate_active: bool,
) -> Value {
    let instructions = format!(
        "{instructions}\nTranslate or transcribe the incoming audio for watch-mode subtitles. Target language: {target_language}. Output concise subtitle text only."
    );
    // With an external subtitle-translate worker the realtime model must not
    // produce responses; input transcription alone feeds the source cues.
    let create_response = !subtitle_translate_active;
    json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": instructions,
            "output_modalities": ["text"],
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": OPENAI_INPUT_SAMPLE_RATE_HZ },
                    "transcription": { "model": OPENAI_INPUT_TRANSCRIPTION_MODEL },
                    "turn_detection": openai_turn_detection(mode, create_response)
                }
            }
        }
    })
}

fn build_translation_session_update(target_language: &str) -> Value {
    json!({
        "type": "session.update",
        "session": {
            "audio": {
                "input": { "format": "pcm16" },
                "output": {
                    "format": "pcm16",
                    "language": normalize_translation_language(target_language)
                }
            }
        }
    })
}

fn build_transcription_session_update(model: &str, mode: RealtimeAudioMode) -> Value {
    let mut transcription = json!({ "model": model });
    // Manual transcription profiles stream with explicit commits and use the
    // low-delay caption tier. This is profile-driven so deployment aliases do
    // not change the wire schema.
    let turn_detection = if mode == RealtimeAudioMode::Manual {
        transcription["delay"] = Value::String("low".to_string());
        Value::Null
    } else {
        match mode {
            RealtimeAudioMode::Manual => Value::Null,
            _ => json!({
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500
            }),
        }
    };
    json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": OPENAI_INPUT_SAMPLE_RATE_HZ },
                    "transcription": transcription,
                    "turn_detection": turn_detection
                }
            }
        }
    })
}

/// Beta-era flat session shape (GLM realtime and similar compat providers).
/// GLM selects the model via this session field, not the URL query.
fn build_flat_session_update(
    model: &str,
    instructions: &str,
    mode: RealtimeAudioMode,
    target_language: &str,
    subtitle_translate_active: bool,
) -> Value {
    let instructions = format!(
        "{instructions}\nTranslate or transcribe the incoming audio for watch-mode subtitles. Target language: {target_language}. Output concise subtitle text only."
    );
    // With an external subtitle-translate worker the model must not answer
    // itself, otherwise both race to write the same cue's translation.
    let turn_detection = match (mode, subtitle_translate_active) {
        (RealtimeAudioMode::Manual, _) => Value::Null,
        (_, true) => json!({ "type": "server_vad", "create_response": false }),
        (_, false) => json!({ "type": "server_vad" }),
    };
    json!({
        "type": "session.update",
        "session": {
            "model": model,
            "modalities": ["text"],
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "sample_rate": 16000,
            "output_audio_format": "pcm",
            "input_audio_transcription": {},
            "turn_detection": turn_detection
        }
    })
}

pub(crate) fn build_session_update(
    dialect: OpenAiRealtimeDialect,
    model: &str,
    instructions: &str,
    mode: RealtimeAudioMode,
    target_language: &str,
    subtitle_translate_active: bool,
) -> Value {
    match dialect {
        OpenAiRealtimeDialect::Conversation => build_conversation_session_update(
            instructions,
            mode,
            target_language,
            subtitle_translate_active,
        ),
        OpenAiRealtimeDialect::Translation => build_translation_session_update(target_language),
        OpenAiRealtimeDialect::Transcription => build_transcription_session_update(model, mode),
        OpenAiRealtimeDialect::FlatCompat => build_flat_session_update(
            model,
            instructions,
            mode,
            target_language,
            subtitle_translate_active,
        ),
    }
}

pub(crate) fn build_response_create() -> Value {
    json!({
        "type": "response.create",
        "response": {
            "output_modalities": ["text"]
        }
    })
}

/// Beta field name (`modalities`) for flat-compat providers.
fn build_response_create_flat() -> Value {
    json!({
        "type": "response.create",
        "response": {
            "modalities": ["text"]
        }
    })
}

pub(crate) fn audio_append_event(dialect: OpenAiRealtimeDialect, audio_b64: &str) -> Value {
    // The translation endpoint namespaces its client events under `session.`.
    let event_type = match dialect {
        OpenAiRealtimeDialect::Translation => "session.input_audio_buffer.append",
        _ => "input_audio_buffer.append",
    };
    json!({ "type": event_type, "audio": audio_b64 })
}

/// Uses the transcription-session handshake (`session.created`/`updated`)?
/// The translation endpoint has no documented handshake event.
fn dialect_has_ready_handshake(dialect: OpenAiRealtimeDialect) -> bool {
    dialect != OpenAiRealtimeDialect::Translation
}

fn uses_timed_manual_commit(
    dialect: OpenAiRealtimeDialect,
    mode: RealtimeAudioMode,
    _model: &str,
) -> bool {
    match dialect {
        OpenAiRealtimeDialect::Translation => false,
        OpenAiRealtimeDialect::Transcription => mode.uses_manual_commit(),
        OpenAiRealtimeDialect::Conversation | OpenAiRealtimeDialect::FlatCompat => {
            mode.uses_manual_commit()
        }
    }
}

/// Manual-commit follow-up: conversation sessions also ask for a response
/// unless an external translator owns the output.
pub(crate) fn manual_commit_messages(
    dialect: OpenAiRealtimeDialect,
    subtitle_translate_active: bool,
) -> Vec<Value> {
    let mut messages = vec![json!({ "type": "input_audio_buffer.commit" })];
    if subtitle_translate_active {
        return messages;
    }
    match dialect {
        OpenAiRealtimeDialect::Conversation => messages.push(build_response_create()),
        OpenAiRealtimeDialect::FlatCompat => messages.push(build_response_create_flat()),
        _ => {}
    }
    messages
}

fn should_commit_translation_cue(idle_ms: u64, source_text: &str) -> bool {
    if idle_ms >= TRANSLATION_CUE_IDLE_COMMIT_MS {
        return true;
    }
    let terminal = source_text
        .trim_end()
        .chars()
        .last()
        .map(|c| "。．.!?！？…".contains(c))
        .unwrap_or(false);
    terminal && idle_ms >= TRANSLATION_CUE_TERMINAL_COMMIT_MS
}

fn extract_text_delta(evt: &Value) -> Option<&str> {
    super::realtime_ws::server_text_delta(evt)
}

/// Response payloads carry text under both "text" and "transcript" keys.
fn response_done_text(evt: &Value) -> String {
    realtime_ws::collect_text_fields(evt.pointer("/response").unwrap_or(evt), true)
}

type OpenAiSocket = realtime_ws::WsSocket;

fn connect_openai_socket(
    provider: &ProviderDraftInput,
    dialect: OpenAiRealtimeDialect,
) -> Result<OpenAiSocket, String> {
    let ws_url = build_ws_url(dialect, &provider.base_url, &provider.model)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("failed to create OpenAI realtime request: {error}"))?;
    apply_ws_auth(provider, request.headers_mut())
        .map_err(|error| format!("failed to apply OpenAI realtime auth: {}", error.message))?;
    apply_ws_custom_headers(provider, request.headers_mut()).map_err(|error| {
        format!(
            "failed to apply OpenAI realtime custom headers: {}",
            error.message
        )
    })?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("failed to connect OpenAI Realtime: {error}"))?;
    realtime_ws::set_socket_timeouts(
        &mut socket,
        Some(Duration::from_millis(OPENAI_READ_TIMEOUT_MS)),
        Some(Duration::from_secs(OPENAI_WRITE_TIMEOUT_SECS)),
    );
    Ok(socket)
}

/// Per-turn subtitle cue accumulation shared by the three dialects.
struct CueState {
    direction: String,
    glossary: GlossaryContext,
    cue_id: Option<String>,
    source_text: String,
    output_text: String,
    last_delta_at: Instant,
}

impl CueState {
    fn new(direction: String, glossary: GlossaryContext) -> Self {
        Self {
            direction,
            glossary,
            cue_id: None,
            source_text: String::new(),
            output_text: String::new(),
            last_delta_at: Instant::now(),
        }
    }

    fn ensure_cue_id(&mut self) -> String {
        // Direction inside the id drives the created cue's route_direction
        // (see cue_lifecycle::route_direction_from_cue_id).
        self.cue_id
            .get_or_insert_with(|| format!("openai-cue-{}-{}", self.direction, unix_ms()))
            .clone()
    }

    fn reset(&mut self) {
        self.cue_id = None;
        self.source_text.clear();
        self.output_text.clear();
    }

    fn is_open(&self) -> bool {
        self.cue_id.is_some()
    }

    fn commit(&mut self, app: &AppHandle, store: &AudioStateStore) {
        let calibrated_output =
            self.glossary.calibrate(&self.source_text, &self.output_text);
        if let Some(cue_id) = self.cue_id.as_deref() {
            if !calibrated_output.trim().is_empty() {
                store.watch_session_report.record_model_final_for_cue(
                    cue_id,
                    "openai-realtime",
                    &calibrated_output,
                    true,
                    None,
                    None,
                );
            }
        }
        commit_realtime_cue(
            app,
            store,
            self.cue_id.as_deref(),
            &self.source_text,
            &calibrated_output,
        );
        self.reset();
    }
}

pub(crate) fn start_openai_realtime(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    direction: String,
    instructions: String,
    audio_mode: RealtimeAudioMode,
    target_language: String,
    subtitle_translate_active: bool,
    glossary: GlossaryContext,
) -> Result<(mpsc::Sender<Vec<u8>>, OmniHandle), String> {
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let stt_epoch = store.begin_stt_session_epoch();
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
                stt_epoch,
                provider,
                direction,
                instructions,
                audio_mode,
                target_language,
                subtitle_translate_active,
                glossary,
                audio_rx,
                stop_rx,
            ) {
                let error = crate::audio::omni::session_errors::report_realtime_worker_failure(
                    &app_handle, "openai", &error,
                );
                let _ = audio_state.set_stt_connected_if_current(stt_epoch, false, 0);
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
        OmniHandle::new(stop_tx, join_handle),
    ))
}

struct OpenAiSessionRuntime {
    socket: OpenAiSocket,
    session_ready: bool,
}

fn open_session(
    app: &AppHandle,
    provider: &ProviderDraftInput,
    dialect: OpenAiRealtimeDialect,
    session_update: &Value,
    trace_call: &mut ModelTraceCall,
) -> Result<OpenAiSessionRuntime, String> {
    let mut socket = connect_openai_socket(provider, dialect)?;
    trace_call.record_ws_send("session.update", session_update.clone());
    socket
        .send(Message::Text(session_update.to_string().into()))
        .map_err(|error| format!("failed to send OpenAI session.update: {error}"))?;
    let _ = diag_log(
        app,
        "openai-realtime",
        "info",
        format!(
            "OpenAI Realtime connected model={} dialect={dialect:?}",
            provider.model
        ),
    );
    Ok(OpenAiSessionRuntime {
        socket,
        // No documented ready handshake on the translation endpoint; treat
        // the accepted upgrade + session.update as ready.
        session_ready: !dialect_has_ready_handshake(dialect),
    })
}

#[allow(clippy::too_many_arguments)]
fn run_openai_worker(
    app: AppHandle,
    store: &AudioStateStore,
    stt_epoch: u64,
    provider: ProviderDraftInput,
    direction: String,
    instructions: String,
    audio_mode: RealtimeAudioMode,
    target_language: String,
    subtitle_translate_active: bool,
    glossary: GlossaryContext,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let dialect = resolve_provider_dialect(&provider)?;
    let session_update = build_session_update(
        dialect,
        &provider.model,
        &instructions,
        audio_mode,
        &target_language,
        subtitle_translate_active,
    );

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

    let mut session = open_session(&app, &provider, dialect, &session_update, &mut trace_call)?;
    if session.session_ready {
        let _ = store.set_stt_connected_if_current(stt_epoch, true, 0);
        let _ = emit_audio_snapshot(&app, store);
    }

    let timed_manual_commit = uses_timed_manual_commit(dialect, audio_mode, &provider.model);
    let input_rate = dialect_input_rate(dialect);
    let mut cue = CueState::new(direction, glossary);
    let mut gate = SilenceGate::new(OPENAI_ASR_MIN_CHUNK_RMS, OPENAI_ASR_SILENCE_GRACE_CHUNKS);
    let mut pre_session_queue: VecDeque<String> = VecDeque::new();
    let mut buffer_size = 0u64;
    let mut last_manual_commit = Instant::now();
    let mut audible_since_commit = false;
    let mut reconnect_retries = 0usize;

    'session_loop: loop {
        // The three send paths below all recover the same way: attempt a
        // reconnect and bail out of the worker when the retry budget is spent.
        // A local macro keeps that 10-argument call and its bail-out in one
        // place while preserving the `return`/`continue 'session_loop` control
        // flow a helper function could not express.
        macro_rules! reconnect_or_bail {
            () => {
                if !try_reconnect(
                    &app,
                    store,
                    stt_epoch,
                    &provider,
                    dialect,
                    &session_update,
                    &mut session,
                    &mut cue,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err("OpenAI realtime reconnect retries exhausted".to_string());
                }
            };
        }
        if stop_rx.try_recv().is_ok() {
            shutdown_session(
                &app,
                store,
                stt_epoch,
                dialect,
                &mut session,
                &mut cue,
                timed_manual_commit,
                audible_since_commit,
                subtitle_translate_active,
                buffer_size,
                &mut trace_call,
            );
            return Ok(());
        }

        // Drain captured audio: resample to 24k mono pcm16, gate silence,
        // send when the session is ready, otherwise queue (bounded).
        let mut send_failed = false;
        for _ in 0..MAX_AUDIO_CHUNKS_PER_TICK {
            let Ok(chunk) = audio_rx.try_recv() else {
                break;
            };
            let samples = resample_capture_to_mono_i16(&chunk, input_rate);
            if samples.is_empty() {
                continue;
            }
            let rms = pcm16_chunk_rms(&samples);
            if !gate.should_send(rms) {
                continue;
            }
            if rms >= OPENAI_ASR_MIN_CHUNK_RMS {
                audible_since_commit = true;
            }
            let encoded = base64_encode_pcm16(&samples);
            if session.session_ready {
                buffer_size = buffer_size.saturating_add((samples.len() * 2) as u64);
                trace_call.record_ws_send(
                    "input_audio_buffer.append",
                    json!({"type": "input_audio_buffer.append", "bytes": samples.len() * 2}),
                );
                let append = audio_append_event(dialect, &encoded);
                if session
                    .socket
                    .send(Message::Text(append.to_string().into()))
                    .is_err()
                {
                    pre_session_queue.push_back(encoded);
                    send_failed = true;
                    break;
                }
            } else {
                if pre_session_queue.len() >= OPENAI_PRE_SESSION_AUDIO_QUEUE_LIMIT {
                    pre_session_queue.pop_front();
                }
                pre_session_queue.push_back(encoded);
            }
        }

        if send_failed {
            reconnect_or_bail!();
            continue 'session_loop;
        }

        // Replay queued pre-session audio a few chunks per tick so socket
        // reads never starve.
        if session.session_ready {
            for _ in 0..OPENAI_PRE_SESSION_AUDIO_DRAIN_PER_TICK {
                let Some(encoded) = pre_session_queue.pop_front() else {
                    break;
                };
                let append = audio_append_event(dialect, &encoded);
                if session
                    .socket
                    .send(Message::Text(append.to_string().into()))
                    .is_err()
                {
                    pre_session_queue.push_front(encoded);
                    reconnect_or_bail!();
                    continue 'session_loop;
                }
            }
        }

        // Timed manual commit for push-to-talk style sessions.
        if session.session_ready
            && timed_manual_commit
            && audible_since_commit
            && last_manual_commit.elapsed().as_secs() >= OPENAI_MANUAL_COMMIT_INTERVAL_SECS
        {
            for msg in manual_commit_messages(dialect, subtitle_translate_active) {
                trace_call
                    .record_ws_send(msg["type"].as_str().unwrap_or("client.event"), msg.clone());
                if session
                    .socket
                    .send(Message::Text(msg.to_string().into()))
                    .is_err()
                {
                    reconnect_or_bail!();
                    continue 'session_loop;
                }
            }
            last_manual_commit = Instant::now();
            audible_since_commit = false;
        }

        // Idle-gap cue segmentation for the boundary-less translation stream.
        if dialect == OpenAiRealtimeDialect::Translation && cue.is_open() {
            let idle_ms = cue.last_delta_at.elapsed().as_millis() as u64;
            if should_commit_translation_cue(idle_ms, &cue.source_text) {
                cue.commit(&app, store);
            }
        }

        match session.socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(evt) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let event_type = super::realtime_ws::server_event_type(&evt, "(unknown)");
                trace_call.record_ws_recv(event_type, evt.clone());
                handle_server_event(
                    &app,
                    store,
                    stt_epoch,
                    dialect,
                    subtitle_translate_active,
                    event_type,
                    &evt,
                    &mut session,
                    &mut cue,
                    buffer_size,
                    &mut reconnect_retries,
                    &mut trace_call,
                );
            }
            Ok(Message::Close(_)) => {
                let _ = diag_log(
                    &app,
                    "openai-realtime",
                    "warning",
                    "OpenAI realtime socket closed by server; reconnecting".to_string(),
                );
                if !try_reconnect(
                    &app,
                    store,
                    stt_epoch,
                    &provider,
                    dialect,
                    &session_update,
                    &mut session,
                    &mut cue,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err("OpenAI realtime socket closed and reconnects exhausted".to_string());
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                let _ = diag_log(
                    &app,
                    "openai-realtime",
                    "warning",
                    format!("OpenAI realtime socket read failed: {error}; reconnecting"),
                );
                if !try_reconnect(
                    &app,
                    store,
                    stt_epoch,
                    &provider,
                    dialect,
                    &session_update,
                    &mut session,
                    &mut cue,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err(format!(
                        "OpenAI realtime socket read failed after retries: {error}"
                    ));
                }
            }
        }
    }
}

/// Appends a transcription delta to the cue's source text and republishes the
/// in-progress cue snapshot. Shared by the conversation- and session-namespace
/// source-transcript delta events.
fn push_source_delta(app: &AppHandle, store: &AudioStateStore, cue: &mut CueState, delta: &str) {
    let id = cue.ensure_cue_id();
    cue.source_text.push_str(delta);
    cue.last_delta_at = Instant::now();
    store.update_or_push_stt_cue(&id, &cue.source_text, false);
    let _ = emit_audio_snapshot(app, store);
}

/// Mirrors the current translated output into `id`, seeding the source row when
/// no transcription arrived, then republishes the cue snapshot. Shared by the
/// translated-text delta/done events across the GA/beta/session namespaces.
fn publish_output_translation(app: &AppHandle, store: &AudioStateStore, cue: &CueState, id: &str) {
    if cue.source_text.trim().is_empty() {
        store.update_or_push_stt_cue(id, &cue.output_text, false);
    }
    store.update_subtitle_cue_translation(id, cue.output_text.clone(), false);
    let _ = emit_audio_snapshot(app, store);
}

#[allow(clippy::too_many_arguments)]
fn handle_server_event(
    app: &AppHandle,
    store: &AudioStateStore,
    stt_epoch: u64,
    dialect: OpenAiRealtimeDialect,
    subtitle_translate_active: bool,
    event_type: &str,
    evt: &Value,
    session: &mut OpenAiSessionRuntime,
    cue: &mut CueState,
    buffer_size: u64,
    reconnect_retries: &mut usize,
    trace_call: &mut ModelTraceCall,
) {
    match event_type {
        "session.created" | "session.updated" => {
            if !session.session_ready {
                session.session_ready = true;
                let _ = store.set_stt_connected_if_current(stt_epoch, true, buffer_size);
                let _ = emit_audio_snapshot(app, store);
            }
            *reconnect_retries = 0;
        }
        "input_audio_buffer.speech_started" => {
            cue.reset();
            let id = cue.ensure_cue_id();
            store.update_or_push_stt_cue(&id, "", false);
            let _ = emit_audio_snapshot(app, store);
        }
        // Source transcript (conversation + transcription sessions).
        "conversation.item.input_audio_transcription.delta"
        | "conversation.item.input_audio_transcription.text" => {
            if let Some(delta) = extract_text_delta(evt) {
                push_source_delta(app, store, cue, delta);
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            if let Some(text) = extract_text_delta(evt) {
                if !text.trim().is_empty() {
                    cue.source_text = text.to_string();
                }
            }
            let finalize_now =
                dialect == OpenAiRealtimeDialect::Transcription || subtitle_translate_active;
            if finalize_now {
                // The external subtitle-translate worker picks up committed
                // cues; the realtime model produces no response here.
                cue.commit(app, store);
            } else if let Some(id) = cue.cue_id.as_deref() {
                store.update_or_push_stt_cue(id, &cue.source_text, false);
                let _ = emit_audio_snapshot(app, store);
            }
        }
        // Translated text (conversation sessions; GA + beta + flat-compat
        // event names — GLM emits response.text.delta).
        "response.output_audio_transcript.delta"
        | "response.output_text.delta"
        | "response.audio_transcript.delta"
        | "response.text.delta" => {
            if let Some(delta) = extract_text_delta(evt) {
                let id = cue.ensure_cue_id();
                store.watch_session_report.record_model_delta_for_cue(
                    &id,
                    "openai-realtime",
                    delta,
                    true,
                    None,
                    None,
                );
                cue.output_text.push_str(delta);
                publish_output_translation(app, store, cue, &id);
            }
        }
        "response.output_audio_transcript.done"
        | "response.output_text.done"
        | "response.audio_transcript.done"
        | "response.text.done" => {
            if let Some(text) = extract_text_delta(evt) {
                if !text.trim().is_empty() {
                    cue.output_text = text.to_string();
                }
                let id = cue.ensure_cue_id();
                store.watch_session_report.record_model_final_for_cue(
                    &id,
                    "openai-realtime",
                    &cue.output_text,
                    true,
                    None,
                    None,
                );
                publish_output_translation(app, store, cue, &id);
            }
        }
        "response.done" => {
            let done_text = response_done_text(evt);
            if !done_text.trim().is_empty() && cue.output_text.trim().is_empty() {
                cue.output_text = done_text;
            }
            cue.commit(app, store);
        }
        // Translation endpoint stream (session.* namespace).
        "session.input_transcript.delta" => {
            if let Some(delta) = extract_text_delta(evt) {
                push_source_delta(app, store, cue, delta);
            }
        }
        "session.output_transcript.delta" => {
            if let Some(delta) = extract_text_delta(evt) {
                let id = cue.ensure_cue_id();
                store.watch_session_report.record_model_delta_for_cue(
                    &id,
                    "openai-translation",
                    delta,
                    true,
                    None,
                    None,
                );
                cue.output_text.push_str(delta);
                cue.last_delta_at = Instant::now();
                publish_output_translation(app, store, cue, &id);
            }
        }
        "session.output_audio.delta" => {
            // Subtitle-only integration: translated audio is intentionally
            // dropped (no speech output path for OpenAI providers yet).
        }
        "error" => {
            let message = evt
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("unknown OpenAI realtime error");
            trace_call.error(message);
            if let Some(cue_id) = cue.cue_id.as_deref() {
                store.watch_session_report.record_model_error_for_cue(
                    cue_id,
                    "openai-realtime",
                    "provider.error",
                    message,
                    false,
                    None,
                );
            }
            let _ = diag_log(app, "openai-realtime", "error", message.to_string());
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn try_reconnect(
    app: &AppHandle,
    store: &AudioStateStore,
    stt_epoch: u64,
    provider: &ProviderDraftInput,
    dialect: OpenAiRealtimeDialect,
    session_update: &Value,
    session: &mut OpenAiSessionRuntime,
    cue: &mut CueState,
    reconnect_retries: &mut usize,
    trace_call: &mut ModelTraceCall,
) -> bool {
    // The interrupted turn cannot be resumed on a fresh session; flush what
    // we have so the overlay keeps the partial subtitle.
    let retry_cue_id = cue.cue_id.clone();
    cue.commit(app, store);
    let _ = store.set_stt_connected_if_current(stt_epoch, false, 0);
    let _ = emit_audio_snapshot(app, store);

    while *reconnect_retries < OPENAI_RECONNECT_MAX_RETRIES {
        *reconnect_retries += 1;
        if let Some(cue_id) = retry_cue_id.as_deref() {
            store.watch_session_report.record_retry_for_cue(
                cue_id,
                "openai-realtime",
                &format!("reconnect-{}", *reconnect_retries),
                "OpenAI realtime transport reconnect",
            );
        }
        let delay = attempt_backoff_delay(*reconnect_retries);
        let _ = diag_log(
            app,
            "openai-realtime",
            "warning",
            format!(
                "OpenAI realtime reconnect attempt {}/{} in {}s",
                reconnect_retries,
                OPENAI_RECONNECT_MAX_RETRIES,
                delay.as_secs()
            ),
        );
        thread::sleep(delay);
        match open_session(app, provider, dialect, session_update, trace_call) {
            Ok(new_session) => {
                *session = new_session;
                if session.session_ready {
                    let _ = store.set_stt_connected_if_current(stt_epoch, true, 0);
                    let _ = emit_audio_snapshot(app, store);
                }
                return true;
            }
            Err(error) => {
                if let Some(cue_id) = retry_cue_id.as_deref() {
                    store.watch_session_report.record_model_error_for_cue(
                        cue_id,
                        "openai-realtime",
                        "transport.reconnect",
                        &error,
                        *reconnect_retries >= OPENAI_RECONNECT_MAX_RETRIES,
                        Some(&format!("reconnect-{}", *reconnect_retries)),
                    );
                }
                let _ = diag_log(
                    app,
                    "openai-realtime",
                    "error",
                    format!("OpenAI realtime reconnect failed: {error}"),
                );
            }
        }
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn shutdown_session(
    app: &AppHandle,
    store: &AudioStateStore,
    stt_epoch: u64,
    dialect: OpenAiRealtimeDialect,
    session: &mut OpenAiSessionRuntime,
    cue: &mut CueState,
    timed_manual_commit: bool,
    audible_since_commit: bool,
    subtitle_translate_active: bool,
    buffer_size: u64,
    trace_call: &mut ModelTraceCall,
) {
    match dialect {
        OpenAiRealtimeDialect::Translation => {
            // Flush pending translation output: session.close, then drain
            // events until session.closed (bounded) so tail text isn't lost.
            let close = json!({ "type": "session.close" });
            trace_call.record_ws_send("session.close", close.clone());
            let _ = session.socket.send(Message::Text(close.to_string().into()));
            let deadline = Instant::now() + Duration::from_millis(SESSION_CLOSE_DRAIN_TIMEOUT_MS);
            while Instant::now() < deadline {
                match session.socket.read() {
                    Ok(Message::Text(text)) => {
                        let Ok(evt) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        let event_type = super::realtime_ws::server_event_type(&evt, "(unknown)");
                        trace_call.record_ws_recv(event_type, evt.clone());
                        match event_type {
                            "session.closed" => break,
                            "session.input_transcript.delta"
                            | "session.output_transcript.delta" => {
                                if let Some(delta) = extract_text_delta(&evt) {
                                    let id = cue.ensure_cue_id();
                                    if event_type == "session.input_transcript.delta" {
                                        cue.source_text.push_str(delta);
                                        store.update_or_push_stt_cue(&id, &cue.source_text, false);
                                    } else {
                                        store.watch_session_report.record_model_delta_for_cue(
                                            &id,
                                            "openai-translation",
                                            delta,
                                            true,
                                            None,
                                            None,
                                        );
                                        cue.output_text.push_str(delta);
                                        store.update_subtitle_cue_translation(
                                            &id,
                                            cue.output_text.clone(),
                                            false,
                                        );
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(error))
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            || error.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(_) => break,
                }
            }
        }
        _ => {
            if timed_manual_commit && audible_since_commit {
                for msg in manual_commit_messages(dialect, subtitle_translate_active) {
                    let _ = session.socket.send(Message::Text(msg.to_string().into()));
                }
            }
        }
    }
    cue.commit(app, store);
    let _ = session.socket.close(None);
    let _ = store.set_stt_connected_if_current(stt_epoch, false, buffer_size);
    let _ = emit_audio_snapshot(app, store);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialect_resolution_by_model_name() {
        assert_eq!(
            resolve_dialect("gpt-realtime-translate"),
            OpenAiRealtimeDialect::Translation
        );
        assert_eq!(
            resolve_dialect("gpt-realtime-whisper"),
            OpenAiRealtimeDialect::Transcription
        );
        assert_eq!(
            resolve_dialect("gpt-4o-mini-transcribe"),
            OpenAiRealtimeDialect::Transcription
        );
        assert_eq!(
            resolve_dialect("whisper-1"),
            OpenAiRealtimeDialect::Transcription
        );
        assert_eq!(
            resolve_dialect("gpt-realtime-2.1"),
            OpenAiRealtimeDialect::Conversation
        );
        assert_eq!(
            resolve_dialect("gpt-realtime"),
            OpenAiRealtimeDialect::Conversation
        );
        assert_eq!(
            resolve_dialect("glm-realtime-flash"),
            OpenAiRealtimeDialect::FlatCompat
        );
        assert_eq!(
            resolve_dialect("glm-realtime-air"),
            OpenAiRealtimeDialect::FlatCompat
        );
    }

    #[test]
    fn flat_compat_uses_16k_input_and_beta_session_shape() {
        assert_eq!(dialect_input_rate(OpenAiRealtimeDialect::FlatCompat), 16_000);
        assert_eq!(
            dialect_input_rate(OpenAiRealtimeDialect::Conversation),
            24_000
        );

        let session = build_flat_session_update(
            "glm-realtime-flash",
            "translate",
            RealtimeAudioMode::ServerVad,
            "zh",
            false,
        );
        assert_eq!(
            session.pointer("/session/model").and_then(Value::as_str),
            Some("glm-realtime-flash")
        );
        assert_eq!(
            session
                .pointer("/session/input_audio_format")
                .and_then(Value::as_str),
            Some("pcm16")
        );
        assert_eq!(
            session
                .pointer("/session/sample_rate")
                .and_then(Value::as_u64),
            Some(16_000)
        );
        assert_eq!(
            session
                .pointer("/session/turn_detection/type")
                .and_then(Value::as_str),
            Some("server_vad")
        );
        assert!(session
            .pointer("/session/input_audio_transcription")
            .is_some());
        // No create_response override on the default path.
        assert!(session
            .pointer("/session/turn_detection/create_response")
            .is_none());
        // Flat shape must not carry the GA nested audio config.
        assert!(session.pointer("/session/audio").is_none());

        let manual = build_flat_session_update(
            "glm-realtime-flash",
            "translate",
            RealtimeAudioMode::Manual,
            "zh",
            false,
        );
        assert!(manual
            .pointer("/session/turn_detection")
            .is_some_and(Value::is_null));

        let with_external_translator = build_flat_session_update(
            "glm-realtime-flash",
            "translate",
            RealtimeAudioMode::ServerVad,
            "zh",
            true,
        );
        assert_eq!(
            with_external_translator
                .pointer("/session/turn_detection/create_response")
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn flat_compat_manual_commit_uses_beta_modalities() {
        let messages = manual_commit_messages(OpenAiRealtimeDialect::FlatCompat, false);
        assert_eq!(messages.len(), 2);
        assert!(messages[1].pointer("/response/modalities").is_some());
        assert!(messages[1].pointer("/response/output_modalities").is_none());
    }

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
    fn translation_url_appends_translations_path() {
        let url =
            build_openai_translation_url("https://api.openai.com/v1", "gpt-realtime-translate")
                .unwrap();
        assert_eq!(
            url.as_str(),
            "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate"
        );
    }

    #[test]
    fn transcription_url_uses_intent_without_model() {
        let url = build_openai_transcription_url("https://api.openai.com/v1").unwrap();
        assert_eq!(
            url.as_str(),
            "wss://api.openai.com/v1/realtime?intent=transcription"
        );
    }

    #[test]
    fn conversation_session_update_uses_ga_structure() {
        let session = build_conversation_session_update(
            "translate",
            RealtimeAudioMode::ServerVad,
            "zh",
            false,
        );
        assert_eq!(
            session.pointer("/session/type").and_then(Value::as_str),
            Some("realtime")
        );
        assert_eq!(
            session
                .pointer("/session/audio/input/format/rate")
                .and_then(Value::as_u64),
            Some(24_000)
        );
        assert_eq!(
            session
                .pointer("/session/audio/input/transcription/model")
                .and_then(Value::as_str),
            Some(OPENAI_INPUT_TRANSCRIPTION_MODEL)
        );
        assert_eq!(
            session
                .pointer("/session/audio/input/turn_detection/create_response")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn conversation_session_update_manual_mode_disables_turn_detection() {
        let session =
            build_conversation_session_update("translate", RealtimeAudioMode::Manual, "zh", false);
        assert!(session
            .pointer("/session/audio/input/turn_detection")
            .is_some_and(Value::is_null));
    }

    #[test]
    fn conversation_session_update_with_external_translator_disables_responses() {
        let session = build_conversation_session_update(
            "translate",
            RealtimeAudioMode::ServerVad,
            "zh",
            true,
        );
        assert_eq!(
            session
                .pointer("/session/audio/input/turn_detection/create_response")
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn translation_session_update_normalizes_language() {
        let session = build_translation_session_update("zh-CN");
        assert_eq!(
            session
                .pointer("/session/audio/output/language")
                .and_then(Value::as_str),
            Some("zh")
        );
        assert_eq!(
            session
                .pointer("/session/audio/input/format")
                .and_then(Value::as_str),
            Some("pcm16")
        );

        assert_eq!(normalize_translation_language("en-US"), "en");
        assert_eq!(normalize_translation_language("ja"), "ja");
        assert_eq!(normalize_translation_language(""), "zh");
    }

    #[test]
    fn transcription_session_update_whisper_uses_low_delay_manual_commit() {
        let session =
            build_transcription_session_update("gpt-realtime-whisper", RealtimeAudioMode::Manual);
        assert_eq!(
            session.pointer("/session/type").and_then(Value::as_str),
            Some("transcription")
        );
        assert_eq!(
            session
                .pointer("/session/audio/input/transcription/delay")
                .and_then(Value::as_str),
            Some("low")
        );
        assert!(session
            .pointer("/session/audio/input/turn_detection")
            .is_some_and(Value::is_null));
    }

    #[test]
    fn transcription_session_update_4o_uses_server_vad() {
        let session = build_transcription_session_update(
            "gpt-4o-mini-transcribe",
            RealtimeAudioMode::ServerVad,
        );
        assert_eq!(
            session
                .pointer("/session/audio/input/turn_detection/type")
                .and_then(Value::as_str),
            Some("server_vad")
        );
        assert!(session
            .pointer("/session/audio/input/transcription/delay")
            .is_none());
    }

    #[test]
    fn response_create_uses_ga_output_modalities() {
        let payload = build_response_create();
        assert!(payload.pointer("/response/output_modalities").is_some());
        assert!(payload.pointer("/response/modalities").is_none());
    }

    #[test]
    fn translation_dialect_never_uses_timed_commit() {
        assert!(!uses_timed_manual_commit(
            OpenAiRealtimeDialect::Translation,
            RealtimeAudioMode::Manual,
            "gpt-realtime-translate"
        ));
        assert!(!uses_timed_manual_commit(
            OpenAiRealtimeDialect::Transcription,
            RealtimeAudioMode::ServerVad,
            "gpt-realtime-whisper"
        ));
        assert!(uses_timed_manual_commit(
            OpenAiRealtimeDialect::Transcription,
            RealtimeAudioMode::Manual,
            "deployment-blue"
        ));
        assert!(uses_timed_manual_commit(
            OpenAiRealtimeDialect::Conversation,
            RealtimeAudioMode::Manual,
            "gpt-realtime-2.1"
        ));
        assert!(!uses_timed_manual_commit(
            OpenAiRealtimeDialect::Conversation,
            RealtimeAudioMode::ServerVad,
            "gpt-realtime-2.1"
        ));
    }

    #[test]
    fn manual_commit_skips_response_create_with_external_translator() {
        let with_translator = manual_commit_messages(OpenAiRealtimeDialect::Conversation, true);
        assert_eq!(with_translator.len(), 1);
        let without_translator = manual_commit_messages(OpenAiRealtimeDialect::Conversation, false);
        assert_eq!(without_translator.len(), 2);
        let transcription = manual_commit_messages(OpenAiRealtimeDialect::Transcription, false);
        assert_eq!(transcription.len(), 1);
    }

    #[test]
    fn translation_cue_commits_on_idle_or_terminal_punctuation() {
        assert!(should_commit_translation_cue(1_500, "still going"));
        assert!(!should_commit_translation_cue(700, "still going"));
        assert!(should_commit_translation_cue(700, "一句话说完了。"));
        assert!(should_commit_translation_cue(600, "Done."));
        assert!(!should_commit_translation_cue(100, "Done."));
    }

    #[test]
    fn audio_append_uses_session_namespace_for_translation() {
        assert_eq!(
            audio_append_event(OpenAiRealtimeDialect::Translation, "abc")["type"],
            "session.input_audio_buffer.append"
        );
        assert_eq!(
            audio_append_event(OpenAiRealtimeDialect::Conversation, "abc")["type"],
            "input_audio_buffer.append"
        );
    }
}
