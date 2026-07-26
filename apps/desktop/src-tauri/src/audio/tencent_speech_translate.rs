//! Tencent Cloud realtime speech translation (实时语音翻译) WebSocket adapter.
//!
//! Single-stream ASR + Hunyuan translation for watch-mode subtitles: the
//! service consumes 16 kHz / 16 bit / mono PCM as binary WebSocket frames
//! (~200 ms each) and pushes JSON text frames whose `result` carries
//! full-sentence `source_text` / `target_text` snapshots (not deltas).
//! Protocol reference: https://cloud.tencent.com/document/product/1093/127565
//!
//! Unlike the OpenAI/Gemini links there is deliberately no silence gate:
//! Tencent drops the connection after ~15 s without audio data, and
//! watch-mode audio is continuous anyway. RMS is still tracked for
//! diagnostics only.
//!
//! Auth is entirely URL-based: the sorted query string (without the `wss://`
//! prefix and without `signature` itself) is signed with
//! HmacSha1(SecretKey) -> Base64 -> URL-encode and appended as the final
//! `signature` parameter. The credential vault stores the combined
//! `appid|SecretId|SecretKey` string under the provider's auth_ref.

use std::collections::VecDeque;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use tauri::{AppHandle, Manager};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};
use uuid::Uuid;

use super::diagnostics::diag_log;
use super::engine::emit_audio_snapshot;
use super::omni::OmniHandle;
use super::pcm_resample::{pcm16_chunk_rms, resample_capture_to_mono_i16};
use super::realtime_ws::{self, attempt_backoff_delay};
use super::state::AudioStateStore;
use super::time_utils::unix_ms;
use crate::diagnostics::model_trace::{ModelTraceCall, ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway_parts::auth::resolve_secret;

const TENCENT_HOST: &str = "asr.cloud.tencent.com";
const TENCENT_DIAG_CATEGORY: &str = "tencent-speech-translate";
const TENCENT_READ_TIMEOUT_MS: u64 = 200;
const TENCENT_WRITE_TIMEOUT_SECS: u64 = 10;
const TENCENT_INPUT_SAMPLE_RATE_HZ: u32 = 16_000;
/// ~200 ms of 16 kHz mono pcm16 per binary frame (3200 samples = 6400 bytes).
const TENCENT_FRAME_SAMPLES: usize = 3_200;
const TENCENT_SIGNATURE_TTL_SECS: u64 = 3_600;
const TENCENT_PRE_SESSION_AUDIO_QUEUE_LIMIT: usize = 500;
const TENCENT_PRE_SESSION_AUDIO_DRAIN_PER_TICK: usize = 4;
const TENCENT_RECONNECT_MAX_RETRIES: usize = 5;
const TENCENT_END_DRAIN_TIMEOUT_MS: u64 = 1_000;
const TENCENT_AUDIBLE_MIN_CHUNK_RMS: f32 = 0.002;
const TENCENT_DEFAULT_TRANS_MODEL: &str = "hunyuan-translation";

type TencentSocket = realtime_ws::WsSocket;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

struct TencentCredentials {
    appid: String,
    secret_id: String,
    secret_key: String,
}

/// The vault stores one combined string: `appid|SecretId|SecretKey`.
fn parse_combined_credential(secret: &str) -> Result<TencentCredentials, String> {
    let parts: Vec<&str> = secret.split('|').map(str::trim).collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("腾讯凭据格式应为 appid|SecretId|SecretKey".to_string());
    }
    Ok(TencentCredentials {
        appid: parts[0].to_string(),
        secret_id: parts[1].to_string(),
        secret_key: parts[2].to_string(),
    })
}

// ---------------------------------------------------------------------------
// URL signing
// ---------------------------------------------------------------------------

/// Session query parameters (unsigned, values not URL-encoded). Every value
/// here is URL-safe by construction, so the same literal string doubles as
/// both signing base and request query.
fn build_query_params(
    secret_id: &str,
    source: &str,
    target: &str,
    trans_model: &str,
    voice_id: &str,
    timestamp: u64,
    nonce: u64,
) -> Vec<(String, String)> {
    vec![
        ("secretid".to_string(), secret_id.to_string()),
        ("timestamp".to_string(), timestamp.to_string()),
        (
            "expired".to_string(),
            (timestamp + TENCENT_SIGNATURE_TTL_SECS).to_string(),
        ),
        ("nonce".to_string(), nonce.to_string()),
        ("source".to_string(), source.to_string()),
        ("target".to_string(), target.to_string()),
        ("trans_model".to_string(), trans_model.to_string()),
        ("voice_format".to_string(), "1".to_string()),
        ("voice_id".to_string(), voice_id.to_string()),
    ]
}

/// Signing base: `host/path?k1=v1&k2=v2...` with keys in ascending
/// lexicographic order, no `wss://` prefix, no `signature`, values as-is.
fn build_signing_base(appid: &str, params: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort_by(|left, right| left.0.cmp(&right.0));
    let query = sorted
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    format!("{TENCENT_HOST}/asr/speech_translate/{appid}?{query}")
}

fn hmac_sha1_base64(secret_key: &str, payload: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret_key.as_bytes())
        .expect("HMAC-SHA1 accepts keys of any length");
    mac.update(payload.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

fn url_encode_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Full connect URL: `wss://` + signing base + URL-encoded signature last.
fn build_signed_ws_url(credentials: &TencentCredentials, params: &[(String, String)]) -> String {
    let signing_base = build_signing_base(&credentials.appid, params);
    let signature = hmac_sha1_base64(&credentials.secret_key, &signing_base);
    format!(
        "wss://{signing_base}&signature={}",
        url_encode_component(&signature)
    )
}

fn fresh_nonce() -> u64 {
    ((Uuid::new_v4().as_u128() % 999_999_999) as u64) + 1
}

// ---------------------------------------------------------------------------
// Language / model mapping
// ---------------------------------------------------------------------------

/// Tencent expects bare ISO 639-1 codes (`zh-CN` -> `zh`).
fn normalize_language_code(lang: &str, fallback: &str) -> String {
    let base = lang
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if base.is_empty() {
        fallback.to_string()
    } else {
        base
    }
}

/// `provider.model` maps straight to `trans_model` (hunyuan-translation /
/// hunyuan-translation-lite; anything else passes through as-is).
fn resolve_trans_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        TENCENT_DEFAULT_TRANS_MODEL.to_string()
    } else {
        trimmed.to_string()
    }
}

// ---------------------------------------------------------------------------
// Server event parsing
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct TencentResult {
    source_text: String,
    target_text: String,
    sentence_end: bool,
}

/// Tencent encodes booleans inconsistently across doc revisions; accept both
/// JSON `true` and the integer `1`.
fn flag_is_set(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(other) => other.as_i64() == Some(1),
        None => false,
    }
}

/// `code != 0` means a server-side error frame.
fn event_error_code(evt: &Value) -> Option<i64> {
    let code = evt.get("code").and_then(Value::as_i64)?;
    if code == 0 {
        None
    } else {
        Some(code)
    }
}

fn event_message(evt: &Value) -> &str {
    evt.get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown Tencent speech translate error")
}

/// Auth-shaped failures are permanent for the current credentials; retrying
/// with a fresh signature cannot fix them, so the worker must exit instead
/// of reconnecting.
fn is_auth_error(code: i64, message: &str) -> bool {
    if (4001..=4003).contains(&code) {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    lower.contains("signature")
        || lower.contains("authorization")
        || message.contains("鉴权")
        || message.contains("签名")
}

/// `final == 1`: the server finished this stream (normally after `end`).
fn is_final_frame(evt: &Value) -> bool {
    flag_is_set(evt.get("final"))
}

/// Extract the recognition/translation payload. Heartbeat and confirmation
/// frames carry no `result` (or an empty one) and are skipped, except that
/// an empty result flagged `sentence_end` still closes the open cue.
fn parse_result(evt: &Value) -> Option<TencentResult> {
    let result = evt.get("result")?.as_object()?;
    let source_text = result
        .get("source_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let target_text = result
        .get("target_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sentence_end = flag_is_set(result.get("sentence_end"));
    if source_text.trim().is_empty() && target_text.trim().is_empty() && !sentence_end {
        return None;
    }
    Some(TencentResult {
        source_text,
        target_text,
        sentence_end,
    })
}

// ---------------------------------------------------------------------------
// Audio framing
// ---------------------------------------------------------------------------

fn pcm16_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

/// Drain as many full ~200 ms frames as the accumulator holds; the sub-frame
/// remainder stays in place for the next capture chunk.
fn drain_full_frames(accumulator: &mut Vec<i16>) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    while accumulator.len() >= TENCENT_FRAME_SAMPLES {
        let remainder = accumulator.split_off(TENCENT_FRAME_SAMPLES);
        frames.push(pcm16_to_le_bytes(accumulator));
        *accumulator = remainder;
    }
    frames
}

fn push_bounded_frame(queue: &mut VecDeque<Vec<u8>>, frame: Vec<u8>) {
    if queue.len() >= TENCENT_PRE_SESSION_AUDIO_QUEUE_LIMIT {
        queue.pop_front();
    }
    queue.push_back(frame);
}

// ---------------------------------------------------------------------------
// Cue state
// ---------------------------------------------------------------------------

/// One open subtitle cue per in-flight sentence. Result frames carry the
/// full current-sentence text, so updates overwrite instead of appending;
/// `sentence_end` commits the cue and the next result opens a fresh one.
struct TencentCueState {
    cue_id: Option<String>,
    source_text: String,
    target_text: String,
}

impl TencentCueState {
    fn new() -> Self {
        Self {
            cue_id: None,
            source_text: String::new(),
            target_text: String::new(),
        }
    }

    fn ensure_cue_id(&mut self) -> String {
        self.cue_id
            .get_or_insert_with(|| format!("tencent-cue-{}", unix_ms()))
            .clone()
    }

    fn reset(&mut self) {
        self.cue_id = None;
        self.source_text.clear();
        self.target_text.clear();
    }

    fn display_source(&self) -> &str {
        if self.source_text.trim().is_empty() {
            self.target_text.as_str()
        } else {
            self.source_text.as_str()
        }
    }

    fn apply_result(&mut self, app: &AppHandle, store: &AudioStateStore, result: &TencentResult) {
        let id = self.ensure_cue_id();
        self.source_text = result.source_text.clone();
        self.target_text = result.target_text.clone();
        store.update_or_push_stt_cue(&id, self.display_source(), false);
        if !self.target_text.trim().is_empty() {
            store.update_subtitle_cue_translation(&id, self.target_text.clone(), false);
        }
        let _ = emit_audio_snapshot(app, store);
        if result.sentence_end {
            self.commit(app, store);
        }
    }

    fn commit(&mut self, app: &AppHandle, store: &AudioStateStore) {
        if let Some(id) = self.cue_id.as_deref() {
            let source = self.display_source();
            if !source.trim().is_empty() {
                store.update_or_push_stt_cue(id, source, true);
                if !self.target_text.trim().is_empty() {
                    store.update_subtitle_cue_translation(id, self.target_text.clone(), true);
                }
                let _ = emit_audio_snapshot(app, store);
            }
        }
        self.reset();
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

pub fn start_tencent_speech_translate(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    source_language: String,
    target_language: String,
) -> Result<(mpsc::Sender<Vec<u8>>, OmniHandle), String> {
    // Resolve + parse the combined credential up front so configuration
    // errors surface synchronously to the route layer.
    let secret = resolve_secret(&provider.auth_ref)
        .map_err(|error| format!("腾讯凭据读取失败: {}", error.message))?
        .ok_or_else(|| "腾讯凭据缺失：请在 Providers 页面保存 appid|SecretId|SecretKey".to_string())?;
    let credentials = parse_combined_credential(&secret)?;

    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let stt_epoch = store.begin_stt_session_epoch();
    store.set_stt_connected(false, 0);
    let app_handle = app.clone();
    let model = provider.model.clone();
    let join_handle = thread::Builder::new()
        .name("tencent-speech-translate".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            if let Err(error) = run_tencent_worker(
                app_handle.clone(),
                &audio_state,
                stt_epoch,
                provider,
                credentials,
                source_language,
                target_language,
                audio_rx,
                stop_rx,
            ) {
                let _ = audio_state.set_stt_connected_if_current(stt_epoch, false, 0);
                diag_log(
                    &app_handle,
                    TENCENT_DIAG_CATEGORY,
                    "error",
                    format!("Tencent speech translate error: {error}; model={model}"),
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| format!("failed to spawn Tencent speech translate thread: {error}"))?;

    Ok((
        audio_tx,
        OmniHandle {
            stop_tx,
            join_handle,
        },
    ))
}

/// Connect/request errors can echo the full request URL, which embeds the
/// replayable signature and secretid; truncate anything past the query
/// boundary before the message reaches diagnostics logs.
fn sanitize_connect_error(error: &tungstenite::Error) -> String {
    let formatted = error.to_string();
    match formatted.split_once('?') {
        Some((prefix, _)) => format!("{prefix}?<signed-query-redacted>"),
        None => formatted,
    }
}

/// Fresh signed connection. Every attempt regenerates voice_id, timestamp,
/// and nonce, and re-signs the URL (a reused signature would be rejected
/// once expired and a reused voice_id would collide server-side).
fn open_tencent_session(
    app: &AppHandle,
    credentials: &TencentCredentials,
    source: &str,
    target: &str,
    trans_model: &str,
    trace_call: &mut ModelTraceCall,
) -> Result<TencentSocket, String> {
    let voice_id = Uuid::new_v4().to_string();
    let timestamp = unix_ms() / 1_000;
    let nonce = fresh_nonce();
    let params = build_query_params(
        &credentials.secret_id,
        source,
        target,
        trans_model,
        &voice_id,
        timestamp,
        nonce,
    );
    let ws_url = build_signed_ws_url(credentials, &params);
    let request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| {
            format!(
                "failed to create Tencent speech translate request: {}",
                sanitize_connect_error(&error)
            )
        })?;
    let (mut socket, _) = connect(request).map_err(|error| {
        format!(
            "failed to connect Tencent speech translate: {}",
            sanitize_connect_error(&error)
        )
    })?;
    realtime_ws::set_socket_timeouts(
        &mut socket,
        Some(Duration::from_millis(TENCENT_READ_TIMEOUT_MS)),
        Some(Duration::from_secs(TENCENT_WRITE_TIMEOUT_SECS)),
    );
    // Never trace or log the signed URL: it embeds secretid + signature.
    trace_call.record_ws_send(
        "session.open",
        json!({
            "voiceId": voice_id,
            "transModel": trans_model,
            "source": source,
            "target": target,
            "timestamp": timestamp,
        }),
    );
    diag_log(
        app,
        TENCENT_DIAG_CATEGORY,
        "info",
        format!(
            "Tencent speech translate connected voice_id={voice_id} trans_model={trans_model} source={source} target={target}"
        ),
    );
    Ok(socket)
}

#[allow(clippy::too_many_arguments)]
fn run_tencent_worker(
    app: AppHandle,
    store: &AudioStateStore,
    stt_epoch: u64,
    provider: ProviderDraftInput,
    credentials: TencentCredentials,
    source_language: String,
    target_language: String,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let source = normalize_language_code(&source_language, "en");
    let target = normalize_language_code(&target_language, "zh");
    let trans_model = resolve_trans_model(&provider.model);

    let trace = ModelTraceRecorder::new(
        app.clone(),
        ModelTraceContext::new(
            provider.provider_id.clone(),
            provider.model.clone(),
            "tencent-speech-translate",
        )
        .with_route_mode("watch"),
    );
    let mut trace_call = trace.call("tencent.websocket_session");

    let mut socket = open_tencent_session(
        &app,
        &credentials,
        &source,
        &target,
        &trans_model,
        &mut trace_call,
    )?;
    // No session handshake event exists: an accepted upgrade is ready (a bad
    // signature comes back immediately as a code!=0 frame).
    let _ = store.set_stt_connected_if_current(stt_epoch, true, 0);
    let _ = emit_audio_snapshot(&app, store);

    let mut cue = TencentCueState::new();
    let mut sample_accumulator: Vec<i16> = Vec::new();
    let mut pending_frames: VecDeque<Vec<u8>> = VecDeque::new();
    let mut buffer_size = 0u64;
    let mut total_chunks = 0u64;
    let mut audible_chunks = 0u64;
    let mut reconnect_retries = 0usize;

    let reconnect = |socket: &mut TencentSocket,
                     cue: &mut TencentCueState,
                     reconnect_retries: &mut usize,
                     trace_call: &mut ModelTraceCall|
     -> bool {
        // The interrupted sentence cannot resume under a fresh voice_id;
        // keep the partial subtitle on screen as committed.
        cue.commit(&app, store);
        let _ = store.set_stt_connected_if_current(stt_epoch, false, 0);
        let _ = emit_audio_snapshot(&app, store);
        while *reconnect_retries < TENCENT_RECONNECT_MAX_RETRIES {
            *reconnect_retries += 1;
            let delay = attempt_backoff_delay(*reconnect_retries);
            diag_log(
                &app,
                TENCENT_DIAG_CATEGORY,
                "warning",
                format!(
                    "Tencent speech translate reconnect attempt {}/{} in {}s",
                    reconnect_retries,
                    TENCENT_RECONNECT_MAX_RETRIES,
                    delay.as_secs()
                ),
            );
            thread::sleep(delay);
            match open_tencent_session(
                &app,
                &credentials,
                &source,
                &target,
                &trans_model,
                trace_call,
            ) {
                Ok(new_socket) => {
                    *socket = new_socket;
                    let _ = store.set_stt_connected_if_current(stt_epoch, true, 0);
                    let _ = emit_audio_snapshot(&app, store);
                    return true;
                }
                Err(error) => {
                    diag_log(
                        &app,
                        TENCENT_DIAG_CATEGORY,
                        "error",
                        format!("Tencent speech translate reconnect failed: {error}"),
                    );
                }
            }
        }
        false
    };

    'session_loop: loop {
        if stop_rx.try_recv().is_ok() {
            shutdown_session(
                &app,
                store,
                stt_epoch,
                &mut socket,
                &mut cue,
                &mut sample_accumulator,
                &mut pending_frames,
                buffer_size,
                &mut trace_call,
            );
            diag_log(
                &app,
                TENCENT_DIAG_CATEGORY,
                "info",
                format!(
                    "Tencent speech translate stopped; chunks={total_chunks} audible={audible_chunks}"
                ),
            );
            return Ok(());
        }

        // Drain captured audio: 48k stereo f32 -> 16k mono pcm16, batched
        // into ~200 ms binary frames. No silence gate (see module docs).
        let mut transport_failed = false;
        while let Ok(chunk) = audio_rx.try_recv() {
            let samples = resample_capture_to_mono_i16(&chunk, TENCENT_INPUT_SAMPLE_RATE_HZ);
            if samples.is_empty() {
                continue;
            }
            total_chunks += 1;
            if pcm16_chunk_rms(&samples) >= TENCENT_AUDIBLE_MIN_CHUNK_RMS {
                audible_chunks += 1;
            }
            sample_accumulator.extend_from_slice(&samples);
            for frame in drain_full_frames(&mut sample_accumulator) {
                // Keep audio ordered: while a backlog exists, new frames
                // join the bounded queue instead of jumping ahead of it.
                if transport_failed || !pending_frames.is_empty() {
                    push_bounded_frame(&mut pending_frames, frame);
                    continue;
                }
                trace_call.record_ws_send("audio", json!({ "bytes": frame.len() }));
                if socket.send(Message::Binary(frame.clone().into())).is_ok() {
                    buffer_size = buffer_size.saturating_add(frame.len() as u64);
                } else {
                    push_bounded_frame(&mut pending_frames, frame);
                    transport_failed = true;
                }
            }
        }

        if transport_failed {
            if !reconnect(
                &mut socket,
                &mut cue,
                &mut reconnect_retries,
                &mut trace_call,
            ) {
                return Err("Tencent speech translate reconnect retries exhausted".to_string());
            }
            continue 'session_loop;
        }

        // Replay backlog a few frames per tick so socket reads never starve.
        for _ in 0..TENCENT_PRE_SESSION_AUDIO_DRAIN_PER_TICK {
            let Some(frame) = pending_frames.pop_front() else {
                break;
            };
            trace_call.record_ws_send("audio", json!({ "bytes": frame.len() }));
            if socket.send(Message::Binary(frame.clone().into())).is_ok() {
                buffer_size = buffer_size.saturating_add(frame.len() as u64);
            } else {
                pending_frames.push_front(frame);
                if !reconnect(
                    &mut socket,
                    &mut cue,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err("Tencent speech translate reconnect retries exhausted".to_string());
                }
                continue 'session_loop;
            }
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(evt) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                trace_call.record_ws_recv("serverMessage", evt.clone());
                if let Some(code) = event_error_code(&evt) {
                    let message = event_message(&evt).to_string();
                    let summary =
                        format!("Tencent speech translate server error code={code}: {message}");
                    trace_call.error(summary.clone());
                    diag_log(&app, TENCENT_DIAG_CATEGORY, "error", summary.clone());
                    if is_auth_error(code, &message) {
                        // Retrying with a fresh signature cannot fix bad
                        // credentials; exit instead of reconnecting.
                        cue.commit(&app, store);
                        let _ = socket.close(None);
                        let _ = store.set_stt_connected_if_current(stt_epoch, false, buffer_size);
                        let _ = emit_audio_snapshot(&app, store);
                        return Err(summary);
                    }
                    if !reconnect(
                        &mut socket,
                        &mut cue,
                        &mut reconnect_retries,
                        &mut trace_call,
                    ) {
                        return Err(
                            "Tencent speech translate reconnect retries exhausted".to_string()
                        );
                    }
                    continue 'session_loop;
                }
                reconnect_retries = 0;
                if let Some(result) = parse_result(&evt) {
                    cue.apply_result(&app, store, &result);
                }
                if is_final_frame(&evt) {
                    diag_log(
                        &app,
                        TENCENT_DIAG_CATEGORY,
                        "warning",
                        "Tencent speech translate server finished the stream (final=1); reconnecting with a fresh voice_id"
                            .to_string(),
                    );
                    if !reconnect(
                        &mut socket,
                        &mut cue,
                        &mut reconnect_retries,
                        &mut trace_call,
                    ) {
                        return Err(
                            "Tencent speech translate reconnect retries exhausted".to_string()
                        );
                    }
                    continue 'session_loop;
                }
            }
            Ok(Message::Close(_)) => {
                diag_log(
                    &app,
                    TENCENT_DIAG_CATEGORY,
                    "warning",
                    "Tencent speech translate socket closed by server; reconnecting".to_string(),
                );
                if !reconnect(
                    &mut socket,
                    &mut cue,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err(
                        "Tencent speech translate socket closed and reconnects exhausted"
                            .to_string(),
                    );
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                diag_log(
                    &app,
                    TENCENT_DIAG_CATEGORY,
                    "warning",
                    format!("Tencent speech translate socket read failed: {error}; reconnecting"),
                );
                if !reconnect(
                    &mut socket,
                    &mut cue,
                    &mut reconnect_retries,
                    &mut trace_call,
                ) {
                    return Err(format!(
                        "Tencent speech translate socket read failed after retries: {error}"
                    ));
                }
            }
        }
    }
}

/// Stop sequence: flush the audio backlog and sub-frame remainder, send
/// `{"type":"end"}`, drain tail results for up to one second (still writing
/// cues), commit the open cue, close the socket.
#[allow(clippy::too_many_arguments)]
fn shutdown_session(
    app: &AppHandle,
    store: &AudioStateStore,
    stt_epoch: u64,
    socket: &mut TencentSocket,
    cue: &mut TencentCueState,
    sample_accumulator: &mut Vec<i16>,
    pending_frames: &mut VecDeque<Vec<u8>>,
    buffer_size: u64,
    trace_call: &mut ModelTraceCall,
) {
    while let Some(frame) = pending_frames.pop_front() {
        trace_call.record_ws_send("audio", json!({ "bytes": frame.len() }));
        if socket.send(Message::Binary(frame.into())).is_err() {
            break;
        }
    }
    if !sample_accumulator.is_empty() {
        let frame = pcm16_to_le_bytes(sample_accumulator);
        sample_accumulator.clear();
        trace_call.record_ws_send("audio", json!({ "bytes": frame.len() }));
        let _ = socket.send(Message::Binary(frame.into()));
    }
    let end = json!({ "type": "end" });
    trace_call.record_ws_send("end", end.clone());
    let _ = socket.send(Message::Text(end.to_string().into()));
    drain_tail_results(app, store, socket, cue, trace_call);
    cue.commit(app, store);
    let _ = socket.close(None);
    let _ = store.set_stt_connected_if_current(stt_epoch, false, buffer_size);
    let _ = emit_audio_snapshot(app, store);
}

/// Bounded wait for the server's tail results after `end`: keep applying
/// them to the cue until `final:1`, a close, an error frame, or the
/// one-second fallback deadline.
fn drain_tail_results(
    app: &AppHandle,
    store: &AudioStateStore,
    socket: &mut TencentSocket,
    cue: &mut TencentCueState,
    trace_call: &mut ModelTraceCall,
) {
    let deadline = Instant::now() + Duration::from_millis(TENCENT_END_DRAIN_TIMEOUT_MS);
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(evt) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                trace_call.record_ws_recv("serverMessage", evt.clone());
                if event_error_code(&evt).is_some() {
                    break;
                }
                if let Some(result) = parse_result(&evt) {
                    cue.apply_result(app, store, &result);
                }
                if is_final_frame(&evt) {
                    break;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_params() -> Vec<(String, String)> {
        build_query_params(
            "AKIDexample",
            "en",
            "zh",
            "hunyuan-translation",
            "vid-1234",
            1_700_000_000,
            42,
        )
    }

    fn fixed_credentials() -> TencentCredentials {
        TencentCredentials {
            appid: "1259228442".to_string(),
            secret_id: "AKIDexample".to_string(),
            secret_key: "secret".to_string(),
        }
    }

    #[test]
    fn signing_base_sorts_params_and_omits_scheme_and_signature() {
        let base = build_signing_base("1259228442", &fixed_params());
        assert_eq!(
            base,
            concat!(
                "asr.cloud.tencent.com/asr/speech_translate/1259228442?",
                "expired=1700003600&nonce=42&secretid=AKIDexample&source=en&target=zh",
                "&timestamp=1700000000&trans_model=hunyuan-translation",
                "&voice_format=1&voice_id=vid-1234"
            )
        );
    }

    #[test]
    fn hmac_sha1_base64_matches_known_vector() {
        // RFC-2202-style vector: HMAC-SHA1("key", "The quick brown fox
        // jumps over the lazy dog") = de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9.
        assert_eq!(
            hmac_sha1_base64("key", "The quick brown fox jumps over the lazy dog"),
            "3nybhbi3iqa8ino29wqQcBydtNk="
        );
    }

    #[test]
    fn url_encoding_escapes_base64_specials() {
        assert_eq!(url_encode_component("ab+/="), "ab%2B%2F%3D");
        assert_eq!(
            url_encode_component("3nybhbi3iqa8ino29wqQcBydtNk="),
            "3nybhbi3iqa8ino29wqQcBydtNk%3D"
        );
    }

    #[test]
    fn ws_url_contains_all_params_with_signature_last() {
        let params = fixed_params();
        let url = build_signed_ws_url(&fixed_credentials(), &params);
        assert!(
            url.starts_with("wss://asr.cloud.tencent.com/asr/speech_translate/1259228442?"),
            "{url}"
        );
        for fragment in [
            "secretid=AKIDexample",
            "timestamp=1700000000",
            "expired=1700003600",
            "nonce=42",
            "source=en",
            "target=zh",
            "trans_model=hunyuan-translation",
            "voice_format=1",
            "voice_id=vid-1234",
        ] {
            assert!(url.contains(fragment), "missing {fragment} in {url}");
        }
        let last = url.rsplit('&').next().unwrap();
        assert!(last.starts_with("signature="), "{url}");
        let expected = url_encode_component(&hmac_sha1_base64(
            "secret",
            &build_signing_base("1259228442", &params),
        ));
        assert_eq!(last, format!("signature={expected}"));
    }

    #[test]
    fn combined_credential_parses_three_segments_and_trims() {
        let creds = parse_combined_credential(" 1259228442 | AKID123 | SKxyz ").unwrap();
        assert_eq!(creds.appid, "1259228442");
        assert_eq!(creds.secret_id, "AKID123");
        assert_eq!(creds.secret_key, "SKxyz");
    }

    #[test]
    fn combined_credential_rejects_wrong_segment_counts() {
        for bad in ["only-one", "appid|secretid", "a|b|c|d", "||", "a||c"] {
            // No `unwrap_err`: TencentCredentials deliberately does not
            // derive Debug (it holds the SecretKey).
            let error = parse_combined_credential(bad)
                .err()
                .expect("expected parse failure");
            assert_eq!(error, "腾讯凭据格式应为 appid|SecretId|SecretKey", "input: {bad}");
        }
    }

    #[test]
    fn language_codes_reduce_to_base_subtag() {
        assert_eq!(normalize_language_code("zh-CN", "zh"), "zh");
        assert_eq!(normalize_language_code("en_US", "zh"), "en");
        assert_eq!(normalize_language_code("JA", "zh"), "ja");
        assert_eq!(normalize_language_code("", "zh"), "zh");
        assert_eq!(normalize_language_code("   ", "en"), "en");
    }

    #[test]
    fn trans_model_passes_through_and_defaults_when_empty() {
        assert_eq!(
            resolve_trans_model("hunyuan-translation-lite"),
            "hunyuan-translation-lite"
        );
        assert_eq!(resolve_trans_model("custom-model"), "custom-model");
        assert_eq!(resolve_trans_model(""), "hunyuan-translation");
        assert_eq!(resolve_trans_model("   "), "hunyuan-translation");
    }

    #[test]
    fn result_frames_parse_full_sentence_snapshots() {
        let evt = json!({
            "code": 0,
            "message": "success",
            "voice_id": "v-1",
            "final": 0,
            "result": {
                "source_text": "hello world",
                "target_text": "你好世界",
                "start_time": 0,
                "end_time": 2840,
                "sentence_end": true
            }
        });
        let result = parse_result(&evt).unwrap();
        assert_eq!(result.source_text, "hello world");
        assert_eq!(result.target_text, "你好世界");
        assert!(result.sentence_end, "sentence_end=true commits the cue");
        assert!(event_error_code(&evt).is_none());
        assert!(!is_final_frame(&evt));
    }

    #[test]
    fn sentence_end_accepts_bool_and_integer_encodings() {
        let as_int = json!({ "result": { "source_text": "a", "sentence_end": 1 } });
        assert!(parse_result(&as_int).unwrap().sentence_end);
        let as_zero = json!({ "result": { "source_text": "a", "sentence_end": 0 } });
        assert!(!parse_result(&as_zero).unwrap().sentence_end);
        let missing = json!({ "result": { "source_text": "a" } });
        assert!(!parse_result(&missing).unwrap().sentence_end);
    }

    #[test]
    fn heartbeat_frames_without_result_are_skipped() {
        assert!(parse_result(&json!({ "code": 0, "message": "success", "final": 0 })).is_none());
        assert!(parse_result(&json!({ "code": 0, "result": null })).is_none());
        // Empty texts with no sentence boundary carry nothing to render.
        assert!(
            parse_result(&json!({ "result": { "source_text": "", "target_text": "" } })).is_none()
        );
        // ... but an empty sentence_end frame still closes the open cue.
        assert!(
            parse_result(&json!({ "result": { "source_text": "", "sentence_end": true } }))
                .unwrap()
                .sentence_end
        );
    }

    #[test]
    fn error_codes_detected_only_when_nonzero() {
        assert_eq!(
            event_error_code(&json!({ "code": 4001, "message": "bad signature" })),
            Some(4001)
        );
        assert_eq!(event_error_code(&json!({ "code": 0, "message": "success" })), None);
        assert_eq!(event_error_code(&json!({ "message": "no code" })), None);
    }

    #[test]
    fn auth_errors_by_code_range_or_message_keywords() {
        assert!(is_auth_error(4001, "anything"));
        assert!(is_auth_error(4002, ""));
        assert!(is_auth_error(4003, ""));
        assert!(!is_auth_error(4008, "audio timeout"));
        assert!(is_auth_error(5000, "check request Signature"));
        assert!(is_auth_error(5000, "Authorization failed"));
        assert!(is_auth_error(5000, "鉴权失败"));
        assert!(is_auth_error(5000, "请检查签名参数"));
        assert!(!is_auth_error(5000, "internal server error"));
    }

    #[test]
    fn final_frame_detection_accepts_bool_and_integer() {
        assert!(is_final_frame(&json!({ "final": 1 })));
        assert!(is_final_frame(&json!({ "final": true })));
        assert!(!is_final_frame(&json!({ "final": 0 })));
        assert!(!is_final_frame(&json!({})));
    }

    #[test]
    fn frame_accumulator_drains_200ms_frames_and_keeps_remainder() {
        let mut accumulator: Vec<i16> = vec![0; TENCENT_FRAME_SAMPLES * 2 + 100];
        let frames = drain_full_frames(&mut accumulator);
        assert_eq!(frames.len(), 2);
        assert!(frames
            .iter()
            .all(|frame| frame.len() == TENCENT_FRAME_SAMPLES * 2));
        assert_eq!(accumulator.len(), 100);

        let mut small: Vec<i16> = vec![0; TENCENT_FRAME_SAMPLES - 1];
        assert!(drain_full_frames(&mut small).is_empty());
        assert_eq!(small.len(), TENCENT_FRAME_SAMPLES - 1);
    }

    #[test]
    fn pcm16_frames_serialize_little_endian() {
        assert_eq!(pcm16_to_le_bytes(&[0x0102, -2]), vec![0x02, 0x01, 0xFE, 0xFF]);
    }

    #[test]
    fn nonce_is_a_positive_integer() {
        for _ in 0..32 {
            let nonce = fresh_nonce();
            assert!(nonce >= 1);
            assert!(nonce <= 999_999_999);
        }
    }
}
