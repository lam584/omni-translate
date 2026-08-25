//! OpenAI Realtime 协议基准测试实现
//!
//! 支持四种方言：Conversation、Translation、Transcription、FlatCompat (GLM)
//! 参考: apps/desktop/src-tauri/src/benchmark/runners.rs::run_single_openai_benchmark

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

use crate::audio::{base64_encode_i16, CHUNK_SEND_INTERVAL_MS};
use crate::config::Config;
use crate::protocol::BenchmarkProtocol;
use crate::reporting::{
    elapsed_ms, is_timeout, set_read_timeout, wait_session_ready, AsrDelta, OutputDelta, RunResult,
};

// ──────────────────────────────── Constants ────────────────────────────────

const TOTAL_TIMEOUT_SECS: u64 = 180;
const IDLE_TIMEOUT_SECS: u64 = 20;

/// OpenAI 标准协议输入采样率 24kHz
const OPENAI_INPUT_RATE: u32 = 24_000;
/// FlatCompat (GLM) 协议输入采样率 16kHz
const FLAT_INPUT_RATE: u32 = 16_000;
/// 基准测试 instructions
const BENCHMARK_INSTRUCTIONS: &str =
    "Transcribe the input audio and translate it to Chinese. Keep the response concise.";

// ──────────────────────────────── OpenAI Dialect ────────────────────────────

/// OpenAI Realtime 协议方言
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenAiDialect {
    Conversation,
    Translation,
    Transcription,
    FlatCompat,
}

impl OpenAiDialect {
    fn from_protocol(p: BenchmarkProtocol) -> Option<Self> {
        match p {
            BenchmarkProtocol::OpenAiConversation => Some(Self::Conversation),
            BenchmarkProtocol::OpenAiTranslation => Some(Self::Translation),
            BenchmarkProtocol::OpenAiTranscription => Some(Self::Transcription),
            BenchmarkProtocol::OpenAiFlat => Some(Self::FlatCompat),
            _ => None,
        }
    }

    fn input_rate(self) -> u32 {
        match self {
            Self::FlatCompat => FLAT_INPUT_RATE,
            _ => OPENAI_INPUT_RATE,
        }
    }

    /// chunk 大小 = input_rate / 50 (20ms)
    fn chunk_samples(self) -> usize {
        (self.input_rate() / 50) as usize
    }
}

// ──────────────────────────────── Public Entry ──────────────────────────────

pub fn run_openai_benchmark(
    run_idx: usize,
    config: &Config,
    samples: &[i16],
    audio_duration: f64,
) -> Result<RunResult, String> {
    let dialect = OpenAiDialect::from_protocol(config.protocol)
        .ok_or_else(|| format!("protocol {:?} is not an OpenAI family protocol", config.protocol))?;
    let manual_response = config.manual || config.protocol.uses_manual_commit();

    // ── Phase 1: 构建 URL 并连接 ──
    let connect_start = Instant::now();
    let ws_url = build_ws_url(dialect, &config.base_url, &config.model)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("OpenAI request build failed: {e}"))?;
    apply_auth(request.headers_mut(), config)?;

    let (mut socket, _) = connect(request).map_err(|e| format!("OpenAI connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);

    set_read_timeout(&mut socket);

    // ── Phase 2: Session 配置 ──
    let session_start = Instant::now();
    let session_cfg = build_session_update(dialect, config);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|e| format!("OpenAI session.update send: {e}"))?;
    wait_session_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);

    // ── Phase 3: 重采样并发送音频 ──
    let input_rate = dialect.input_rate();
    let resampled = resample_i16(samples, 16_000, input_rate);
    let chunk_size = dialect.chunk_samples();
    let chunks: Vec<&[i16]> = resampled.chunks(chunk_size).collect();
    let audio_start = Instant::now();

    for (idx, chunk) in chunks.iter().enumerate() {
        let encoded = base64_encode_i16(chunk);
        let msg = build_audio_append(dialect, &encoded);
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("OpenAI audio append send: {e}"))?;
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

    // Manual commit: commit + response.create
    if manual_response {
        for msg in build_manual_commit_messages(dialect) {
            socket
                .send(Message::Text(msg.to_string().into()))
                .map_err(|e| format!("OpenAI manual response send: {e}"))?;
        }
    }

    // ── Phase 4: 接收事件 ──
    let result = receive_events(&mut socket, &audio_start, manual_response)?;

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

fn build_ws_url(dialect: OpenAiDialect, base_url: &str, model: &str) -> Result<String, String> {
    // 解析 base_url，确保路径正确
    let mut url = base_url.trim().to_string();

    // 确保路径包含 /v1/realtime
    if !url.contains("/realtime") {
        let trimmed = url.trim_end_matches('/');
        if !trimmed.ends_with("/v1") {
            url = format!("{}/v1/realtime", trimmed);
        } else {
            url = format!("{}/realtime", trimmed);
        }
    }

    match dialect {
        OpenAiDialect::Conversation | OpenAiDialect::FlatCompat => {
            Ok(format!("{}?model={}", url, model))
        }
        OpenAiDialect::Translation => {
            // /v1/realtime/translations?model=<model>
            let url = url.replace("/realtime", "/realtime/translations");
            Ok(format!("{}?model={}", url, model))
        }
        OpenAiDialect::Transcription => {
            // /v1/realtime?intent=transcription
            Ok(format!("{}?intent=transcription", url))
        }
    }
}

// ──────────────────────────────── 鉴权 ──────────────────────────────────────

fn apply_auth(
    headers: &mut tungstenite::http::HeaderMap,
    config: &Config,
) -> Result<(), String> {
    let name = tungstenite::http::header::HeaderName::from_bytes(config.auth_header_name.as_bytes())
        .map_err(|e| format!("auth header name parse: {e}"))?;

    let value = if config.auth_scheme.eq_ignore_ascii_case("bearer") {
        format!("Bearer {}", config.api_key)
    } else if config.auth_scheme.is_empty() {
        config.api_key.clone()
    } else {
        format!("{} {}", config.auth_scheme, config.api_key)
    };

    let header_value = tungstenite::http::HeaderValue::from_str(&value)
        .map_err(|e| format!("auth header value parse: {e}"))?;
    headers.insert(name, header_value);
    Ok(())
}

// ──────────────────────────────── Session 配置 ──────────────────────────────

fn build_session_update(dialect: OpenAiDialect, config: &Config) -> Value {
    match dialect {
        OpenAiDialect::Conversation => build_conversation_session(config),
        OpenAiDialect::Translation => build_translation_session(config),
        OpenAiDialect::Transcription => build_transcription_session(config),
        OpenAiDialect::FlatCompat => build_flat_session(config),
    }
}

fn build_conversation_session(config: &Config) -> Value {
    let instructions = format!(
        "{}\nTranslate or transcribe the incoming audio for watch-mode subtitles. Target language: {}.",
        BENCHMARK_INSTRUCTIONS, config.target_language
    );
    let turn_detection = if config.manual {
        Value::Null
    } else {
        json!({
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
            "create_response": true,
            "interrupt_response": false
        })
    };
    json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": instructions,
            "output_modalities": ["text"],
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": OPENAI_INPUT_RATE },
                    "transcription": { "model": "gpt-4o-mini-transcribe" },
                    "turn_detection": turn_detection
                }
            }
        }
    })
}

fn build_translation_session(config: &Config) -> Value {
    let lang = normalize_language(&config.target_language);
    json!({
        "type": "session.update",
        "session": {
            "audio": {
                "input": { "format": "pcm16" },
                "output": {
                    "format": "pcm16",
                    "language": lang
                }
            }
        }
    })
}

fn build_transcription_session(config: &Config) -> Value {
    let turn_detection = if config.manual {
        Value::Null
    } else {
        json!({
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500
        })
    };
    let mut transcription = json!({ "model": config.model });
    if config.manual {
        transcription["delay"] = Value::String("low".to_string());
    }
    json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": OPENAI_INPUT_RATE },
                    "transcription": transcription,
                    "turn_detection": turn_detection
                }
            }
        }
    })
}

fn build_flat_session(config: &Config) -> Value {
    let instructions = format!(
        "{}\nTranslate or transcribe the incoming audio for watch-mode subtitles. Target language: {}.",
        BENCHMARK_INSTRUCTIONS, config.target_language
    );
    let turn_detection = if config.manual {
        Value::Null
    } else {
        json!({ "type": "server_vad" })
    };
    json!({
        "type": "session.update",
        "session": {
            "model": config.model,
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

// ──────────────────────────────── 消息构建 ──────────────────────────────────

fn build_audio_append(dialect: OpenAiDialect, audio_b64: &str) -> Value {
    // Translation 端使用 session. 前缀
    let event_type = match dialect {
        OpenAiDialect::Translation => "session.input_audio_buffer.append",
        _ => "input_audio_buffer.append",
    };
    json!({ "type": event_type, "audio": audio_b64 })
}

fn build_manual_commit_messages(dialect: OpenAiDialect) -> Vec<Value> {
    let mut messages = vec![json!({ "type": "input_audio_buffer.commit" })];
    match dialect {
        OpenAiDialect::Conversation => messages.push(json!({
            "type": "response.create",
            "response": { "output_modalities": ["text"] }
        })),
        OpenAiDialect::FlatCompat => messages.push(json!({
            "type": "response.create",
            "response": { "modalities": ["text"] }
        })),
        _ => {}
    }
    messages
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

                handle_openai_event(&mut r, ms, etype, &event)?;

                // Manual 模式下收到 response.done 即可退出
                if manual && etype == "response.done" {
                    break;
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

fn handle_openai_event(
    r: &mut RawResult,
    ms: f64,
    etype: &str,
    event: &Value,
) -> Result<(), String> {
    match etype {
        // ── 语音检测 ──
        "input_audio_buffer.speech_started" => {
            r.speech_started_ms = Some(ms);
        }
        "input_audio_buffer.speech_stopped" => {
            r.speech_stopped_ms = Some(ms);
        }

        // ── ASR 转写 ──
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

        // ── 响应生命周期 ──
        "response.created" => {
            if r.response_created_ms.is_none() {
                r.response_created_ms = Some(ms);
            }
        }
        "response.done" => {
            r.response_done_ms = Some(ms);
            r.response_count += 1;
            // 如果还没有输出 delta，尝试从 response.done 中提取文本
            if r.translation_final.is_empty() && r.output_deltas.is_empty() {
                if let Some(text) = extract_response_text(event) {
                    r.translation_final = text.clone();
                    if r.first_committed_ms.is_none() {
                        r.first_committed_ms = Some(ms);
                    }
                    if r.first_output_ms.is_none() {
                        r.first_output_ms = Some(ms);
                    }
                    r.output_deltas.push(OutputDelta {
                        elapsed_ms: ms,
                        event_type: etype.to_string(),
                        stash: String::new(),
                        committed_text: text.clone(),
                        raw_text: text,
                    });
                }
            }
        }

        // ── 音频转写增量 ──
        "response.audio_transcript.delta" => {
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

        // ── 文本输出增量 ──
        "response.text.delta" | "response.output_text.delta" | "response.transcript.delta" => {
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

        // ── 完成事件 ──
        "response.audio_transcript.done" => {
            let text = event["transcript"].as_str().unwrap_or("").to_string();
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
        "response.text.done" | "response.output_text.done" | "response.transcript.done" => {
            let text = extract_response_text(event).unwrap_or_default();
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

        // ── Livetranslate 风格: stash/text 模式 ──
        "response.audio_transcript.text" => {
            let stash = event["stash"].as_str().unwrap_or("").to_string();
            let text_val = event["text"].as_str().unwrap_or("").to_string();
            let current_text = if !stash.is_empty() {
                stash.clone()
            } else {
                text_val.clone()
            };
            if r.first_output_ms.is_none() && (!stash.is_empty() || !text_val.is_empty()) {
                r.first_output_ms = Some(ms);
            }
            if !text_val.is_empty()
                && r.output_deltas.last().map_or(true, |prev| prev.committed_text != text_val)
            {
                if r.first_committed_ms.is_none() {
                    r.first_committed_ms = Some(ms);
                }
                if should_replace_final_text(&r.translation_final, &text_val) {
                    r.translation_final = text_val.clone();
                }
            }
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

    Ok(())
}

// ──────────────────────────────── Helpers ────────────────────────────────────

fn extract_response_text(event: &Value) -> Option<String> {
    // 尝试多种字段路径
    event["text"]
        .as_str()
        .or_else(|| event["transcript"].as_str())
        .or_else(|| event["output_text"].as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

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

/// 简单线性插值重采样 i16 样本
fn resample_i16(samples: &[i16], source_rate: u32, target_rate: u32) -> Vec<i16> {
    if samples.is_empty() || source_rate == target_rate {
        return samples.to_vec();
    }
    let target_len = ((samples.len() as u64 * target_rate as u64) / source_rate.max(1) as u64).max(1);
    let ratio = source_rate as f64 / target_rate as f64;
    (0..target_len as usize)
        .map(|i| {
            let pos = i as f64 * ratio;
            let lo = pos.floor() as usize;
            let hi = (lo + 1).min(samples.len() - 1);
            let frac = pos - lo as f64;
            let s = samples[lo] as f64 * (1.0 - frac) + samples[hi] as f64 * frac;
            s.clamp(i16::MIN as f64, i16::MAX as f64) as i16
        })
        .collect()
}
