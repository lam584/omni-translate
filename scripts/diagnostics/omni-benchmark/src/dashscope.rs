use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

use crate::audio::{base64_encode_i16, CHUNK_SAMPLES, CHUNK_SEND_INTERVAL_MS};
use crate::config::Config;
use crate::protocol::BenchmarkProtocol;
use crate::reporting::{
    elapsed_ms, is_timeout, set_read_timeout, wait_session_ready, AsrDelta, OutputDelta, RunResult,
};

// ──────────────────────────────── Constants ────────────────────────────────

const TOTAL_TIMEOUT_SECS: u64 = 180;
const IDLE_TIMEOUT_SECS: u64 = 20;

// ──────────────────────────────── DashScope Benchmark ───────────────────────

pub fn run_dashscope_benchmark(
    run_idx: usize,
    config: &Config,
    samples: &[i16],
    audio_duration: f64,
) -> Result<RunResult, String> {
    let total_start = Instant::now();
    let manual_response = config.manual || config.protocol == BenchmarkProtocol::DashscopeOmni;

    // ── Phase 1: Connect ──
    let connect_start = Instant::now();
    let ws_url = format!("{}?model={}", config.base_url, config.model);
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("request build failed: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|e| format!("auth header parse: {e}"))?,
    );

    let (mut socket, _) = connect(request).map_err(|e| format!("connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);

    set_read_timeout(&mut socket);

    // ── Phase 2: Session setup ──
    let session_start = Instant::now();
    let session_cfg = build_session_update(config);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|e| format!("session.update send: {e}"))?;
    wait_session_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);

    // ── Phase 3: Stream audio ──
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();

    for (i, chunk) in chunks.iter().enumerate() {
        let msg = build_audio_append(chunk);
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("audio send at chunk {i}: {e}"))?;
        if i % 200 == 0 && !config.json_output {
            eprint!("\r  audio: {}/{} chunks", i + 1, chunks.len());
        }
        std::thread::sleep(Duration::from_millis(CHUNK_SEND_INTERVAL_MS));
    }

    if !config.json_output {
        eprintln!(
            "\r  audio: {}/{} chunks sent          ",
            chunks.len(),
            chunks.len()
        );
    }

    let audio_send_ms = elapsed_ms(&audio_start);

    // Manual mode: commit + response.create
    if manual_response {
        let commit_msg = build_input_audio_commit();
        socket
            .send(Message::Text(commit_msg.to_string().into()))
            .map_err(|e| format!("commit send: {e}"))?;
        let create_msg = build_response_create();
        socket
            .send(Message::Text(create_msg.to_string().into()))
            .map_err(|e| format!("response.create send: {e}"))?;
    }

    // ── Phase 4: Receive results ──
    let result = receive_events(&mut socket, &audio_start, manual_response)?;

    let _ = socket.close(None);

    let _ = total_start; // keep for potential future use

    let output_delta_count = result.output_deltas.len();
    let total_output_duration_ms = match (
        result.response_done_ms,
        result.first_output_ms,
        result.response_created_ms,
    ) {
        (Some(done), Some(ftt), _) => Some(done - ftt),
        (Some(done), None, Some(created)) => Some(done - created),
        _ => None,
    };

    Ok(RunResult {
        run_index: run_idx,
        model: config.model.clone(),
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        audio_chunks_sent: chunks.len(),
        audio_duration_secs: audio_duration,
        first_asr_ms: result.first_asr_ms,
        asr_deltas: result.asr_deltas,
        asr_final: result.asr_final,
        first_output_ms: result.first_output_ms,
        first_committed_ms: result.first_committed_ms,
        output_deltas: result.output_deltas,
        translation_final: result.translation_final,
        response_created_ms: result.response_created_ms,
        response_done_ms: result.response_done_ms,
        response_count: result.response_count,
        speech_started_ms: result.speech_started_ms,
        speech_stopped_ms: result.speech_stopped_ms,
        time_to_first_token_ms: result.first_output_ms,
        time_to_first_committed_ms: result.first_committed_ms,
        total_output_duration_ms,
        output_delta_count,
    })
}

// ──────────────────────────────── Message Builders ──────────────────────────

fn build_session_update(config: &Config) -> Value {
    let is_livetranslate = config.protocol == BenchmarkProtocol::DashscopeLiveTranslate;
    let manual_response = config.manual || config.protocol == BenchmarkProtocol::DashscopeOmni;

    let turn_detection = if manual_response {
        Value::Null
    } else {
        json!({
            "type": "server_vad",
            "threshold": 0.0,
            "silence_duration_ms": 800
        })
    };

    let input_audio_format = if is_livetranslate { "pcm" } else { "pcm16" };

    let mut session = json!({
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "voice": config.voice,
            "instructions": "Transcribe the input audio and translate it to Chinese. Keep the response concise.",
            "input_audio_format": input_audio_format,
            "sample_rate": 16000,
            "output_audio_format": "pcm",
            "turn_detection": turn_detection,
        }
    });

    if is_livetranslate {
        session["session"]["input_audio_transcription"] = json!({
            "model": "qwen3-asr-flash-realtime",
            "language": config.source_language
        });
        session["session"]["translation"] = json!({
            "language": normalize_language(&config.target_language)
        });
    }

    session
}

fn build_audio_append(chunk: &[i16]) -> Value {
    json!({
        "type": "input_audio_buffer.append",
        "audio": base64_encode_i16(chunk),
    })
}

fn build_input_audio_commit() -> Value {
    json!({"type": "input_audio_buffer.commit"})
}

fn build_response_create() -> Value {
    json!({"type": "response.create"})
}

// ──────────────────────────────── Event Receiver ────────────────────────────

struct RawResult {
    first_asr_ms: Option<f64>,
    asr_deltas: Vec<AsrDelta>,
    asr_final: String,
    first_output_ms: Option<f64>,
    first_committed_ms: Option<f64>,
    output_deltas: Vec<OutputDelta>,
    translation_final: String,
    response_created_ms: Option<f64>,
    response_done_ms: Option<f64>,
    response_count: u32,
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,
}

fn receive_events(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    audio_start: &Instant,
    manual: bool,
) -> Result<RawResult, String> {
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);
    let idle_timeout = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let mut last_event = Instant::now();

    let mut r = RawResult {
        first_asr_ms: None,
        asr_deltas: Vec::new(),
        asr_final: String::new(),
        first_output_ms: None,
        first_committed_ms: None,
        output_deltas: Vec::new(),
        translation_final: String::new(),
        response_created_ms: None,
        response_done_ms: None,
        response_count: 0,
        speech_started_ms: None,
        speech_stopped_ms: None,
    };

    loop {
        if audio_start.elapsed() > total_timeout || last_event.elapsed() > idle_timeout {
            break;
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                last_event = Instant::now();
                let event: Value =
                    serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {e}"))?;
                let etype = event["type"].as_str().unwrap_or("?");
                let ms = elapsed_ms(audio_start);

                match etype {
                    // ── Speech detection ──
                    "input_audio_buffer.speech_started" => {
                        r.speech_started_ms = Some(ms);
                    }
                    "input_audio_buffer.speech_stopped" => {
                        r.speech_stopped_ms = Some(ms);
                    }

                    // ── ASR input transcription ──
                    "conversation.item.input_audio_transcription.text" => {
                        let stash = event["stash"].as_str().unwrap_or("").to_string();
                        let text_val = event["text"].as_str().unwrap_or("").to_string();
                        if r.first_asr_ms.is_none() {
                            r.first_asr_ms = Some(ms);
                        }
                        r.asr_deltas.push(AsrDelta {
                            elapsed_ms: ms,
                            stash: stash.clone(),
                            text: text_val.clone(),
                        });
                        if !stash.is_empty() {
                            r.asr_final = stash;
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        let transcript = event["transcript"].as_str().unwrap_or("").to_string();
                        if !transcript.is_empty() {
                            r.asr_final = transcript;
                        }
                    }

                    // ── Response lifecycle ──
                    "response.created" => {
                        if r.response_created_ms.is_none() {
                            r.response_created_ms = Some(ms);
                        }
                    }
                    "response.done" => {
                        // Record the latest response.done
                        r.response_done_ms = Some(ms);
                        r.response_count += 1;
                        if manual {
                            break;
                        }
                    }

                    // ── Omni model: delta/done pattern ──
                    "response.text.delta" | "response.audio_transcript.delta" => {
                        let delta = event["delta"].as_str().unwrap_or("").to_string();
                        if r.first_output_ms.is_none() && !delta.is_empty() {
                            r.first_output_ms = Some(ms);
                        }
                        r.output_deltas.push(OutputDelta {
                            elapsed_ms: ms,
                            event_type: etype.to_string(),
                            stash: delta.clone(),
                            committed_text: String::new(),
                            raw_text: delta,
                        });
                    }
                    "response.text.done" | "response.audio_transcript.done" => {
                        let text = event["text"]
                            .as_str()
                            .or_else(|| event["transcript"].as_str())
                            .unwrap_or("")
                            .to_string();
                        if !text.is_empty() {
                            if should_replace_final_text(&r.translation_final, &text) {
                                r.translation_final = text.clone();
                            }
                            if r.first_output_ms.is_none() {
                                r.first_output_ms = Some(ms);
                            }
                            if r.first_committed_ms.is_none() {
                                r.first_committed_ms = Some(ms);
                            }
                        }
                        r.output_deltas.push(OutputDelta {
                            elapsed_ms: ms,
                            event_type: etype.to_string(),
                            stash: String::new(),
                            committed_text: text.clone(),
                            raw_text: text,
                        });
                    }

                    // ── Livetranslate model: stash/text pattern ──
                    "response.audio_transcript.text" => {
                        let stash = event["stash"].as_str().unwrap_or("").to_string();
                        let text_val = event["text"].as_str().unwrap_or("").to_string();
                        let current_text = if !stash.is_empty() {
                            stash.clone()
                        } else {
                            text_val.clone()
                        };

                        if r.first_output_ms.is_none()
                            && (!stash.is_empty() || !text_val.is_empty())
                        {
                            r.first_output_ms = Some(ms);
                        }

                        // Detect committed text transition (text field changed)
                        if !text_val.is_empty()
                            && r.output_deltas
                                .last()
                                .map_or(true, |prev: &OutputDelta| prev.committed_text != text_val)
                        {
                            if r.first_committed_ms.is_none() {
                                r.first_committed_ms = Some(ms);
                            }
                            if should_replace_final_text(&r.translation_final, &text_val) {
                                r.translation_final = text_val.clone();
                            }
                        }

                        // Update final with stash if it's the last one
                        if should_replace_final_text(&r.translation_final, &current_text) {
                            r.translation_final = current_text.clone();
                        }

                        r.output_deltas.push(OutputDelta {
                            elapsed_ms: ms,
                            event_type: etype.to_string(),
                            stash,
                            committed_text: text_val,
                            raw_text: current_text,
                        });
                    }

                    "error" => {
                        return Err(format!("server error: {}", event["error"]));
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => break,
            Err(e) if is_timeout(&e.to_string()) => continue,
            Err(e) => return Err(format!("read error: {e}")),
            _ => {}
        }
    }

    Ok(r)
}

// ──────────────────────────────── Helpers ────────────────────────────────────

fn should_replace_final_text(current: &str, candidate: &str) -> bool {
    !candidate.is_empty() && candidate.chars().count() >= current.chars().count()
}

fn normalize_language(lang: &str) -> &str {
    match lang {
        l if l.starts_with("zh") => "zh",
        l if l.starts_with("en") => "en",
        l if l.starts_with("ja") => "ja",
        l if l.starts_with("ko") => "ko",
        other => other,
    }
}
