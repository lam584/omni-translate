//! Gemini Live 协议基准测试实现
//!
//! 参考: apps/desktop/src-tauri/src/benchmark/runners.rs::run_single_gemini_benchmark
//! 参考: apps/desktop/src-tauri/src/benchmark/event_parsing.rs (Gemini 事件解析)

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

use omni_benchmark_core::collect_gemini_model_text;

use crate::audio::{base64_encode_i16, CHUNK_SAMPLES, CHUNK_SEND_INTERVAL_MS};
use crate::config::Config;
use crate::reporting::{
    elapsed_ms, is_timeout, set_read_timeout, AsrDelta, OutputDelta, RunResult,
};

// ──────────────────────────────── Constants ────────────────────────────────

const TOTAL_TIMEOUT_SECS: u64 = 180;
const IDLE_TIMEOUT_SECS: u64 = 20;
const SESSION_READY_TIMEOUT_SECS: u64 = 30;

/// Gemini Live 服务路径
const GEMINI_LIVE_SERVICE: &str =
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/// 基准测试 instructions
const BENCHMARK_INSTRUCTIONS: &str =
    "Transcribe the input audio and translate it to Chinese. Keep the response concise.";

// ──────────────────────────────── Public Entry ──────────────────────────────

pub fn run_gemini_benchmark(
    run_idx: usize,
    config: &Config,
    samples: &[i16],
    audio_duration: f64,
) -> Result<RunResult, String> {
    // Gemini 使用 16kHz PCM，与输入采样率一致
    let manual_activity = config.manual;

    // ── Phase 1: 构建 URL 并连接 ──
    let connect_start = Instant::now();
    let ws_url = build_gemini_url(&config.base_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Gemini request build failed: {e}"))?;
    apply_auth(request.headers_mut(), config)?;

    let (mut socket, _) = connect(request).map_err(|e| format!("Gemini connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);

    set_read_timeout(&mut socket);

    // ── Phase 2: Setup ──
    let session_start = Instant::now();
    let setup = build_setup(config);
    socket
        .send(Message::Text(setup.to_string().into()))
        .map_err(|e| format!("Gemini setup send: {e}"))?;
    wait_setup_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);

    // ── Phase 3: 发送音频 ──
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();

    // Manual activity 模式: 先发送 activityStart
    if manual_activity {
        let msg = json!({ "realtimeInput": { "activityStart": {} } });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("Gemini activityStart send: {e}"))?;
    }

    for (idx, chunk) in chunks.iter().enumerate() {
        let msg = json!({
            "realtimeInput": {
                "audio": {
                    "mimeType": "audio/pcm;rate=16000",
                    "data": base64_encode_i16(chunk)
                }
            }
        });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("Gemini audio send at chunk {idx}: {e}"))?;
        if idx % 200 == 0 && !config.json_output {
            eprint!("\r  audio: {}/{} chunks", idx + 1, chunks.len());
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

    // 发送结束信号
    let end_msg = if manual_activity {
        json!({ "realtimeInput": { "activityEnd": {} } })
    } else {
        json!({ "realtimeInput": { "audioStreamEnd": true } })
    };
    socket
        .send(Message::Text(end_msg.to_string().into()))
        .map_err(|e| format!("Gemini audio end send: {e}"))?;

    // ── Phase 4: 接收事件 ──
    let result = receive_events(&mut socket, &audio_start)?;

    let _ = socket.close(None);

    let output_delta_count = result.output_deltas.len();
    let total_output_duration_ms = match (result.response_done_ms, result.first_output_ms, result.response_created_ms) {
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

// ──────────────────────────────── URL 构建 ──────────────────────────────────

fn build_gemini_url(base_url: &str) -> Result<String, String> {
    let url = base_url.trim();
    // 如果 base_url 已经包含完整路径，直接使用
    if url.contains("BidiGenerateContent") {
        return Ok(url.to_string());
    }
    // 否则拼接 Gemini Live 服务路径
    let trimmed = url.trim_end_matches('/');
    Ok(format!("{}/ws/{}", trimmed, GEMINI_LIVE_SERVICE))
}

// ──────────────────────────────── 鉴权 ──────────────────────────────────────

fn apply_auth(
    headers: &mut tungstenite::http::HeaderMap,
    config: &Config,
) -> Result<(), String> {
    let name = tungstenite::http::header::HeaderName::from_bytes(config.auth_header_name.as_bytes())
        .map_err(|e| format!("auth header name parse: {e}"))?;

    // Gemini 使用 x-goog-api-key，直接传 key 值
    let value = if config.auth_scheme.is_empty() {
        config.api_key.clone()
    } else if config.auth_scheme.eq_ignore_ascii_case("bearer") {
        format!("Bearer {}", config.api_key)
    } else {
        format!("{} {}", config.auth_scheme, config.api_key)
    };

    let header_value = tungstenite::http::HeaderValue::from_str(&value)
        .map_err(|e| format!("auth header value parse: {e}"))?;
    headers.insert(name, header_value);
    Ok(())
}

// ──────────────────────────────── Setup 消息 ────────────────────────────────

fn build_setup(config: &Config) -> Value {
    let model_name = if config.model.starts_with("models/") {
        config.model.clone()
    } else {
        format!("models/{}", config.model)
    };

    let disabled_activity_detection = config.manual;

    json!({
        "setup": {
            "model": model_name,
            "generationConfig": {
                "responseModalities": ["TEXT"]
            },
            "systemInstruction": {
                "parts": [{
                    "text": format!(
                        "{}\nTranslate incoming audio into concise subtitles. Target language: {}.",
                        BENCHMARK_INSTRUCTIONS, config.target_language
                    )
                }]
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "realtimeInputConfig": {
                "automaticActivityDetection": {
                    "disabled": disabled_activity_detection
                }
            },
            "contextWindowCompression": { "slidingWindow": {} },
            "sessionResumption": {}
        }
    })
}

// ──────────────────────────────── Setup Ready ───────────────────────────────

fn wait_setup_ready(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(SESSION_READY_TIMEOUT_SECS);
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("Gemini JSON error during setup: {e}"))?;
                // Gemini 使用 setupComplete 而非 session.created
                if event.get("setupComplete").is_some() {
                    return Ok(());
                }
                if let Some(error) = event.get("error") {
                    return Err(format!("Gemini server error: {error}"));
                }
            }
            Ok(Message::Close(_)) => {
                return Err("Gemini server closed before setup completed".into());
            }
            Err(e) if is_timeout(&e.to_string()) => continue,
            Err(e) => return Err(format!("Gemini read error during setup: {e}")),
            _ => {}
        }
    }
    Err("timed out waiting for Gemini setupComplete".into())
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
                let ms = elapsed_ms(audio_start);

                handle_gemini_event(&mut r, ms, &event)?;
            }
            Ok(Message::Close(_)) => break,
            Err(e) if is_timeout(&e.to_string()) => continue,
            Err(e) => return Err(format!("Gemini read error: {e}")),
            _ => {}
        }
    }

    Ok(r)
}

fn handle_gemini_event(r: &mut RawResult, ms: f64, event: &Value) -> Result<(), String> {
    // 忽略 setupComplete
    if event.get("setupComplete").is_some() {
        return Ok(());
    }
    // 处理错误
    if let Some(error) = event.get("error") {
        return Err(format!("Gemini server error: {error}"));
    }

    // ── 输入转写 (ASR) ──
    if let Some(input_text) = event
        .pointer("/serverContent/inputTranscription/text")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        if r.first_asr_ms.is_none() {
            r.first_asr_ms = Some(ms);
        }
        r.asr_final.push_str(input_text);
        r.asr_deltas.push(AsrDelta {
            elapsed_ms: ms,
            stash: r.asr_final.clone(),
            text: input_text.to_string(),
        });
    }

    // ── 输出转写 (翻译) ──
    if let Some(output_text) = event
        .pointer("/serverContent/outputTranscription/text")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        push_output_delta(r, ms, "serverContent.outputTranscription", output_text);
    }

    // ── modelTurn 中的文本内容 ──
    let model_text = collect_gemini_model_text(
        event
            .pointer("/serverContent/modelTurn")
            .unwrap_or(&Value::Null),
    );
    if !model_text.is_empty() {
        push_output_delta(r, ms, "serverContent.modelTurn", &model_text);
    }

    // ── turnComplete ──
    let turn_complete = event
        .pointer("/serverContent/turnComplete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if turn_complete {
        r.response_done_ms = Some(ms);
        r.response_count += 1;
        if r.first_committed_ms.is_none() && !r.translation_final.is_empty() {
            r.first_committed_ms = Some(ms);
        }
    }

    Ok(())
}

fn push_output_delta(
    r: &mut RawResult,
    ms: f64,
    event_type: &str,
    text: &str,
) {
    if r.first_output_ms.is_none() && !text.is_empty() {
        r.first_output_ms = Some(ms);
    }
    r.translation_final.push_str(text);
    r.output_deltas.push(OutputDelta {
        elapsed_ms: ms,
        event_type: event_type.to_string(),
        stash: text.to_string(),
        committed_text: String::new(),
        raw_text: text.to_string(),
    });
}
