use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

// ──────────────────────────────── Constants ────────────────────────────────

const DEFAULT_WS_BASE_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const DEFAULT_MODEL: &str = "qwen3.5-livetranslate-flash-realtime";
const CHUNK_SAMPLES: usize = 320; // 20ms @ 16kHz
const CHUNK_SEND_INTERVAL_MS: u64 = 18;
const TOTAL_TIMEOUT_SECS: u64 = 180;
const IDLE_TIMEOUT_SECS: u64 = 20;
const SESSION_READY_TIMEOUT_SECS: u64 = 30;

// ──────────────────────────────── CLI Config ────────────────────────────────

struct Config {
    api_key: String,
    audio_path: PathBuf,
    model: String,
    base_url: String,
    runs: usize,
    voice: String,
    target_language: String,
    source_language: String,
    json_output: bool,
    limit_seconds: Option<f32>,
    manual: bool,
    protocol: DashscopeProtocol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DashscopeProtocol {
    Omni,
    LiveTranslate,
}

// ──────────────────────────────── Timing Records ────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct OutputDelta {
    /// Milliseconds since audio streaming started
    elapsed_ms: f64,
    /// Event type name
    event_type: String,
    /// Current building sentence (stash for livetranslate, delta for omni)
    stash: String,
    /// Completed sentence(s)
    committed_text: String,
    /// Raw text/delta field from the event
    raw_text: String,
}

#[derive(Debug, Clone, Serialize)]
struct AsrDelta {
    elapsed_ms: f64,
    stash: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
struct RunResult {
    run_index: usize,
    model: String,

    // Phase timings (all in ms)
    connect_ms: f64,
    session_ready_ms: f64,
    audio_send_ms: f64,
    audio_chunks_sent: usize,
    audio_duration_secs: f64,

    // ASR (input transcription)
    first_asr_ms: Option<f64>,
    asr_deltas: Vec<AsrDelta>,
    asr_final: String,

    // Translation output
    first_output_ms: Option<f64>,
    first_committed_ms: Option<f64>,
    output_deltas: Vec<OutputDelta>,
    translation_final: String,

    // Response lifecycle
    response_created_ms: Option<f64>,
    response_done_ms: Option<f64>,
    response_count: u32,

    // Speech detection
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,

    // Derived metrics
    time_to_first_token_ms: Option<f64>,
    time_to_first_committed_ms: Option<f64>,
    total_output_duration_ms: Option<f64>,
    output_delta_count: usize,
}

#[derive(Debug, Serialize)]
struct BenchmarkReport {
    model: String,
    audio_file: String,
    audio_duration_secs: f64,
    runs: Vec<RunResult>,
    summary: Summary,
}

#[derive(Debug, Serialize)]
struct Summary {
    run_count: usize,
    successful_runs: usize,
    avg_connect_ms: f64,
    avg_session_ready_ms: f64,
    avg_time_to_first_token_ms: Option<f64>,
    avg_time_to_first_committed_ms: Option<f64>,
    avg_output_delta_interval_ms: Option<f64>,
    avg_output_deltas_per_run: f64,
    avg_total_output_duration_ms: Option<f64>,
    p50_delta_interval_ms: Option<f64>,
    p90_delta_interval_ms: Option<f64>,
    p99_delta_interval_ms: Option<f64>,
    min_delta_interval_ms: Option<f64>,
    max_delta_interval_ms: Option<f64>,
}

// ──────────────────────────────── main ──────────────────────────────────────

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let config = match parse_args() {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("{msg}");
            print_usage();
            std::process::exit(2);
        }
    };

    if let Err(err) = run_benchmark(config) {
        eprintln!("Benchmark failed: {err}");
        std::process::exit(1);
    }
}

fn print_usage() {
    eprintln!(
        r#"Usage: omni-benchmark --audio <path> [options]

Required:
  --audio <path>             Path to audio file (.mp3, .wav, .pcm, .s16le, .raw)
  --mp3 <path>               Deprecated alias for --audio

Options:
  --model <model>            Model name (default: {DEFAULT_MODEL})
  --protocol <dialect>       dashscope-omni or dashscope-livetranslate (default)
  --base-url <url>           WebSocket base URL (default: {DEFAULT_WS_BASE_URL})
  --runs <N>                 Number of runs (default: 1)
  --voice <voice>            Voice name (default: Ethan)
  --target-language <lang>   Target language (default: zh)
  --source-language <lang>   Source language (default: en)
  --limit-seconds <secs>     Limit audio to first N seconds
  --manual                   Use manual VAD (no server_vad)
  --json                     Output results as JSON
  --api-key <key>            API key (or set DASHSCOPE_API_KEY env var)
  --help, -h                 Show this help
"#
    );
}

fn parse_args() -> Result<Config, String> {
    let api_key = std::env::var("DASHSCOPE_API_KEY").unwrap_or_default();

    let mut audio_path: Option<PathBuf> = None;
    let mut model = DEFAULT_MODEL.to_string();
    let mut base_url = DEFAULT_WS_BASE_URL.to_string();
    let mut runs = 1usize;
    let mut voice = "Ethan".to_string();
    let mut target_language = "zh".to_string();
    let mut source_language = "en".to_string();
    let mut json_output = false;
    let mut limit_seconds: Option<f32> = None;
    let mut manual = false;
    let mut protocol = DashscopeProtocol::LiveTranslate;
    let mut cli_api_key: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--audio" => audio_path = Some(PathBuf::from(next_val(&mut args, "--audio")?)),
            "--mp3" => audio_path = Some(PathBuf::from(next_val(&mut args, "--mp3")?)),
            "--model" => model = next_val(&mut args, "--model")?,
            "--protocol" => protocol = parse_protocol(&next_val(&mut args, "--protocol")?)?,
            "--base-url" => base_url = next_val(&mut args, "--base-url")?,
            "--runs" => {
                runs = next_val(&mut args, "--runs")?
                    .parse()
                    .map_err(|e| format!("invalid --runs: {e}"))?
            }
            "--voice" => voice = next_val(&mut args, "--voice")?,
            "--target-language" => target_language = next_val(&mut args, "--target-language")?,
            "--source-language" => source_language = next_val(&mut args, "--source-language")?,
            "--limit-seconds" => {
                let v = next_val(&mut args, "--limit-seconds")?
                    .parse::<f32>()
                    .map_err(|e| format!("invalid --limit-seconds: {e}"))?;
                if v <= 0.0 {
                    return Err("--limit-seconds must be > 0".into());
                }
                limit_seconds = Some(v);
            }
            "--manual" => manual = true,
            "--json" => json_output = true,
            "--api-key" => cli_api_key = Some(next_val(&mut args, "--api-key")?),
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let final_key = cli_api_key.unwrap_or(api_key);
    if final_key.trim().is_empty() {
        return Err("DASHSCOPE_API_KEY env var or --api-key is required".into());
    }

    let audio_path = audio_path.ok_or_else(|| "--audio <path> is required".to_string())?;
    if !audio_path.exists() {
        return Err(format!("audio file not found: {}", audio_path.display()));
    }

    Ok(Config {
        api_key: final_key,
        audio_path,
        model,
        base_url,
        runs,
        voice,
        target_language,
        source_language,
        json_output,
        limit_seconds,
        manual,
        protocol,
    })
}

fn parse_protocol(value: &str) -> Result<DashscopeProtocol, String> {
    match value {
        "dashscope-omni" => Ok(DashscopeProtocol::Omni),
        "dashscope-livetranslate" => Ok(DashscopeProtocol::LiveTranslate),
        other => Err(format!(
            "invalid --protocol '{other}'; expected dashscope-omni or dashscope-livetranslate"
        )),
    }
}

fn next_val(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

// ──────────────────────────────── Benchmark Runner ──────────────────────────

fn run_benchmark(config: Config) -> Result<(), String> {
    let mut samples = read_audio_samples(&config.audio_path)?;
    if let Some(limit) = config.limit_seconds {
        let max = (limit * 16_000.0).ceil() as usize;
        if samples.len() > max {
            samples.truncate(max);
        }
    }

    let audio_duration = samples.len() as f64 / 16_000.0;

    if !config.json_output {
        println!("╔══════════════════════════════════════════════════════════╗");
        println!("║          Omni Realtime Translation Benchmark            ║");
        println!("╠══════════════════════════════════════════════════════════╣");
        println!("║  model:     {:<44} ║", config.model);
        println!(
            "║  audio:     {:<44} ║",
            truncate_path(&config.audio_path, 44)
        );
        println!("║  duration:  {:<44} ║", format!("{audio_duration:.1}s"));
        println!("║  runs:      {:<44} ║", config.runs);
        println!("║  voice:     {:<44} ║", config.voice);
        println!("║  target:    {:<44} ║", config.target_language);
        println!(
            "║  mode:      {:<44} ║",
            if config.manual {
                "manual"
            } else {
                "server_vad"
            }
        );
        println!("╚══════════════════════════════════════════════════════════╝");
        println!();
    }

    let mut results: Vec<RunResult> = Vec::new();

    for run_idx in 0..config.runs {
        if !config.json_output {
            println!("── Run {}/{} ──", run_idx + 1, config.runs);
        }

        let result = run_single_benchmark(run_idx, &config, &samples, audio_duration)?;

        if !config.json_output {
            print_run_summary(&result);
        }

        results.push(result);

        // Brief pause between runs
        if run_idx + 1 < config.runs {
            thread::sleep(Duration::from_secs(1));
        }
    }

    let summary = compute_summary(&results, audio_duration);
    let report = BenchmarkReport {
        model: config.model.clone(),
        audio_file: config.audio_path.display().to_string(),
        audio_duration_secs: audio_duration,
        runs: results,
        summary,
    };

    if config.json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|e| format!("JSON serialize failed: {e}"))?
        );
    } else {
        println!();
        print_summary(&report.summary, &report.model);
    }

    Ok(())
}

// ──────────────────────────────── Single Run ────────────────────────────────

fn run_single_benchmark(
    run_idx: usize,
    config: &Config,
    samples: &[i16],
    audio_duration: f64,
) -> Result<RunResult, String> {
    let total_start = Instant::now();
    let manual_response = config.manual || config.protocol == DashscopeProtocol::Omni;

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
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": base64_encode_i16(chunk),
        });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("audio send at chunk {i}: {e}"))?;
        if i % 200 == 0 && !config.json_output {
            eprint!("\r  audio: {}/{} chunks", i + 1, chunks.len());
        }
        thread::sleep(Duration::from_millis(CHUNK_SEND_INTERVAL_MS));
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
        socket
            .send(Message::Text(
                json!({"type": "input_audio_buffer.commit"})
                    .to_string()
                    .into(),
            ))
            .map_err(|e| format!("commit send: {e}"))?;
        socket
            .send(Message::Text(
                json!({"type": "response.create"}).to_string().into(),
            ))
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

// ──────────────────────────────── Session Setup ─────────────────────────────

fn build_session_update(config: &Config) -> Value {
    let is_livetranslate = config.protocol == DashscopeProtocol::LiveTranslate;
    let manual_response = config.manual || config.protocol == DashscopeProtocol::Omni;

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

fn wait_session_ready(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(SESSION_READY_TIMEOUT_SECS);
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("JSON error during session setup: {e}"))?;
                match event["type"].as_str().unwrap_or("?") {
                    "session.created" | "session.updated" => return Ok(()),
                    "error" => return Err(format!("server error: {}", event["error"])),
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => {
                return Err("server closed before session was ready".into());
            }
            Err(e) if is_timeout(&e.to_string()) => continue,
            Err(e) => return Err(format!("read error during session setup: {e}")),
            _ => {}
        }
    }
    Err("timed out waiting for session.updated".into())
}

// ──────────────────────────────── Audio I/O ─────────────────────────────────

fn read_audio_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => read_mp3_samples(path),
        "wav" | "wave" => read_wav_samples(path),
        "pcm" | "s16le" | "raw" => read_pcm16_mono_samples(path),
        other => Err(format!(
            "unsupported audio extension '{}'; expected .mp3, .wav, .pcm, .s16le, or .raw",
            if other.is_empty() { "(none)" } else { other }
        )),
    }
}

fn read_pcm16_mono_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read PCM '{}': {e}", path.display()))?;
    if bytes.len() % 2 != 0 {
        return Err(format!(
            "PCM file '{}' has odd byte length {}; expected signed 16-bit little-endian mono",
            path.display(),
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect())
}

fn read_wav_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read WAV '{}': {e}", path.display()))?;
    let wav = parse_wav(&bytes).map_err(|e| format!("WAV decode '{}': {e}", path.display()))?;
    Ok(resample_to_16k(&wav.samples, wav.sample_rate))
}

struct WavAudio {
    samples: Vec<f32>,
    sample_rate: u32,
}

fn parse_wav(bytes: &[u8]) -> Result<WavAudio, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }

    let mut offset = 12usize;
    let mut format_tag = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut data_range = None;

    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        offset += 8;
        if offset + chunk_size > bytes.len() {
            return Err("truncated chunk".to_string());
        }
        match chunk_id {
            b"fmt " => {
                if chunk_size < 16 {
                    return Err("fmt chunk too short".to_string());
                }
                format_tag = Some(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]));
                channels = Some(u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]));
                sample_rate = Some(u32::from_le_bytes([
                    bytes[offset + 4],
                    bytes[offset + 5],
                    bytes[offset + 6],
                    bytes[offset + 7],
                ]));
                bits_per_sample =
                    Some(u16::from_le_bytes([bytes[offset + 14], bytes[offset + 15]]));
            }
            b"data" => data_range = Some((offset, offset + chunk_size)),
            _ => {}
        }
        offset += chunk_size + (chunk_size % 2);
    }

    let format_tag = format_tag.ok_or_else(|| "missing fmt chunk".to_string())?;
    let channels = channels
        .filter(|value| *value > 0)
        .ok_or_else(|| "invalid channel count".to_string())? as usize;
    let sample_rate = sample_rate
        .filter(|value| *value > 0)
        .ok_or_else(|| "invalid sample rate".to_string())?;
    let bits_per_sample = bits_per_sample.ok_or_else(|| "missing bits per sample".to_string())?;
    let (start, end) = data_range.ok_or_else(|| "missing data chunk".to_string())?;
    let data = &bytes[start..end];

    let mono = match (format_tag, bits_per_sample) {
        (1, 16) => data
            .chunks_exact(channels * 2)
            .map(|frame| {
                frame
                    .chunks_exact(2)
                    .take(channels)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
                    .sum::<f32>()
                    / channels as f32
            })
            .collect(),
        (3, 32) => data
            .chunks_exact(channels * 4)
            .map(|frame| {
                frame
                    .chunks_exact(4)
                    .take(channels)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .sum::<f32>()
                    / channels as f32
            })
            .collect(),
        _ => {
            return Err(format!(
                "unsupported WAV format tag {} with {} bits per sample",
                format_tag, bits_per_sample
            ))
        }
    };

    Ok(WavAudio {
        samples: mono,
        sample_rate,
    })
}

fn read_mp3_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("open MP3 '{}': {e}", path.display()))?;
    let mut decoder = minimp3::Decoder::new(file);
    let mut mono = Vec::new();
    let mut sample_rate: Option<u32> = None;

    loop {
        match decoder.next_frame() {
            Ok(frame) => {
                sample_rate.get_or_insert(frame.sample_rate.max(1) as u32);
                let channels = frame.channels.max(1);
                mono.extend(frame.data.chunks(channels).map(|ch| {
                    ch.iter()
                        .copied()
                        .map(|s| s as f32 / i16::MAX as f32)
                        .sum::<f32>()
                        / ch.len().max(1) as f32
                }));
            }
            Err(minimp3::Error::Eof) => break,
            Err(e) => return Err(format!("MP3 decode '{}': {e}", path.display())),
        }
    }

    Ok(resample_to_16k(&mono, sample_rate.unwrap_or(16_000)))
}

fn resample_to_16k(samples: &[f32], source_rate: u32) -> Vec<i16> {
    const TARGET: u32 = 16_000;
    if samples.is_empty() {
        return Vec::new();
    }
    let target_len = ((samples.len() as u64 * TARGET as u64) / source_rate.max(1) as u64).max(1);
    let ratio = source_rate as f64 / TARGET as f64;
    (0..target_len as usize)
        .map(|i| {
            let pos = i as f64 * ratio;
            let lo = pos.floor() as usize;
            let hi = (lo + 1).min(samples.len() - 1);
            let frac = (pos - lo as f64) as f32;
            let s = samples[lo] * (1.0 - frac) + samples[hi] * frac;
            (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
        })
        .collect()
}

fn should_replace_final_text(current: &str, candidate: &str) -> bool {
    !candidate.is_empty() && candidate.chars().count() >= current.chars().count()
}

// ──────────────────────────────── Statistics ────────────────────────────────

fn compute_summary(results: &[RunResult], _audio_duration: f64) -> Summary {
    let successful: Vec<&RunResult> = results
        .iter()
        .filter(|r| r.response_count > 0 || !r.translation_final.is_empty())
        .collect();
    let n = successful.len();

    if n == 0 {
        return Summary {
            run_count: results.len(),
            successful_runs: 0,
            avg_connect_ms: 0.0,
            avg_session_ready_ms: 0.0,
            avg_time_to_first_token_ms: None,
            avg_time_to_first_committed_ms: None,
            avg_output_delta_interval_ms: None,
            avg_output_deltas_per_run: 0.0,
            avg_total_output_duration_ms: None,
            p50_delta_interval_ms: None,
            p90_delta_interval_ms: None,
            p99_delta_interval_ms: None,
            min_delta_interval_ms: None,
            max_delta_interval_ms: None,
        };
    }

    let avg_connect = successful.iter().map(|r| r.connect_ms).sum::<f64>() / n as f64;
    let avg_session = successful.iter().map(|r| r.session_ready_ms).sum::<f64>() / n as f64;

    // TTFT relative to response.created (preferred) or absolute
    let ttf_values: Vec<f64> = successful
        .iter()
        .filter_map(|r| match (r.first_output_ms, r.response_created_ms) {
            (Some(ftt), Some(rc)) if ftt >= rc => Some(ftt - rc),
            (Some(ftt), Some(_)) => Some(ftt),
            (Some(ftt), None) => Some(ftt),
            _ => None,
        })
        .collect();
    let avg_ttf = if ttf_values.is_empty() {
        None
    } else {
        Some(ttf_values.iter().sum::<f64>() / ttf_values.len() as f64)
    };

    // TTFC relative to response.created (preferred) or absolute
    let ttfc_values: Vec<f64> = successful
        .iter()
        .filter_map(|r| match (r.first_committed_ms, r.response_created_ms) {
            (Some(ftc), Some(rc)) if ftc >= rc => Some(ftc - rc),
            (Some(ftc), Some(_)) => Some(ftc),
            (Some(ftc), None) => Some(ftc),
            _ => None,
        })
        .collect();
    let avg_ttfc = if ttfc_values.is_empty() {
        None
    } else {
        Some(ttfc_values.iter().sum::<f64>() / ttfc_values.len() as f64)
    };

    let dur_values: Vec<f64> = successful
        .iter()
        .filter_map(|r| r.total_output_duration_ms)
        .collect();
    let avg_dur = if dur_values.is_empty() {
        None
    } else {
        Some(dur_values.iter().sum::<f64>() / dur_values.len() as f64)
    };

    // Collect all delta intervals across all runs
    let mut all_intervals: Vec<f64> = Vec::new();
    for r in &successful {
        for i in 1..r.output_deltas.len() {
            let gap = r.output_deltas[i].elapsed_ms - r.output_deltas[i - 1].elapsed_ms;
            if gap >= 0.0 {
                all_intervals.push(gap);
            }
        }
    }

    let avg_interval = if all_intervals.is_empty() {
        None
    } else {
        Some(all_intervals.iter().sum::<f64>() / all_intervals.len() as f64)
    };

    all_intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let percentile = |p: f64| -> Option<f64> {
        if all_intervals.is_empty() {
            return None;
        }
        let idx = ((all_intervals.len() as f64 - 1.0) * p / 100.0).round() as usize;
        Some(all_intervals[idx.min(all_intervals.len() - 1)])
    };

    let avg_deltas = successful
        .iter()
        .map(|r| r.output_delta_count as f64)
        .sum::<f64>()
        / n as f64;

    Summary {
        run_count: results.len(),
        successful_runs: n,
        avg_connect_ms: avg_connect,
        avg_session_ready_ms: avg_session,
        avg_time_to_first_token_ms: avg_ttf,
        avg_time_to_first_committed_ms: avg_ttfc,
        avg_output_delta_interval_ms: avg_interval,
        avg_output_deltas_per_run: avg_deltas,
        avg_total_output_duration_ms: avg_dur,
        p50_delta_interval_ms: percentile(50.0),
        p90_delta_interval_ms: percentile(90.0),
        p99_delta_interval_ms: percentile(99.0),
        min_delta_interval_ms: all_intervals.first().copied(),
        max_delta_interval_ms: all_intervals.last().copied(),
    }
}

// ──────────────────────────────── Display ───────────────────────────────────

fn print_run_summary(r: &RunResult) {
    println!("  connect:       {:.0} ms", r.connect_ms);
    println!("  session ready: {:.0} ms", r.session_ready_ms);
    println!(
        "  audio send:    {:.0} ms ({} chunks, {:.1}s audio)",
        r.audio_send_ms, r.audio_chunks_sent, r.audio_duration_secs
    );

    if let Some(ms) = r.speech_started_ms {
        println!("  speech start:  {:.0} ms", ms);
    }
    if let Some(ms) = r.first_asr_ms {
        println!("  first ASR:     {:.0} ms", ms);
    }
    if !r.asr_final.is_empty() {
        println!(
            "  ASR final:     \"{}\" ({} chars)",
            truncate_str(&r.asr_final, 60),
            r.asr_final.chars().count()
        );
    }

    if let Some(ms) = r.response_created_ms {
        println!("  resp.created:  {:.0} ms", ms);
    }
    if let Some(ms) = r.first_output_ms {
        let rel = r.response_created_ms.map_or(String::new(), |rc| {
            format!(" (+{:.0}ms after resp.created)", ms - rc)
        });
        println!("  first token:   {:.0} ms{rel}", ms);
    }
    if let Some(ms) = r.first_committed_ms {
        let rel = r.response_created_ms.map_or(String::new(), |rc| {
            format!(" (+{:.0}ms after resp.created)", ms - rc)
        });
        println!("  first commit:  {:.0} ms{rel}", ms);
    }
    if let Some(ms) = r.response_done_ms {
        let rel = r
            .response_created_ms
            .map_or(String::new(), |rc| format!(" (+{:.0}ms)", ms - rc));
        println!("  resp.done:     {:.0} ms{rel}", ms);
    }

    println!("  output deltas: {}", r.output_delta_count);

    // Delta intervals
    if r.output_deltas.len() > 1 {
        let intervals: Vec<f64> = (1..r.output_deltas.len())
            .map(|i| r.output_deltas[i].elapsed_ms - r.output_deltas[i - 1].elapsed_ms)
            .filter(|g| *g >= 0.0)
            .collect();
        if !intervals.is_empty() {
            let avg = intervals.iter().sum::<f64>() / intervals.len() as f64;
            let min = intervals.iter().cloned().fold(f64::MAX, f64::min);
            let max = intervals.iter().cloned().fold(0.0f64, f64::max);
            let mut sorted = intervals.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let p50 = sorted[sorted.len() / 2];
            println!(
                "  delta interval: avg={:.0}ms p50={:.0}ms min={:.0}ms max={:.0}ms",
                avg, p50, min, max
            );
        }
    }

    if let Some(ms) = r.total_output_duration_ms {
        println!("  output duration: {:.0} ms", ms);
    }

    println!(
        "  translation:   \"{}\" ({} chars)",
        truncate_str(&r.translation_final, 60),
        r.translation_final.chars().count()
    );
    println!("  response.done: {} times", r.response_count);
    println!();
}

fn print_summary(s: &Summary, model: &str) {
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║  Benchmark Summary: {:<36} ║", truncate_str(model, 36));
    println!("╠══════════════════════════════════════════════════════════╣");
    println!(
        "║  runs: {}/{} successful                            ",
        s.successful_runs, s.run_count
    );
    println!("║");
    println!("║  Connection:");
    println!("║    avg connect:       {:>8.0} ms", s.avg_connect_ms);
    println!("║    avg session ready: {:>8.0} ms", s.avg_session_ready_ms);
    println!("║");
    println!("║  Output Latency:");
    if let Some(v) = s.avg_time_to_first_token_ms {
        println!("║    avg TTFT (after resp.created): {:>8.0} ms", v);
    } else {
        println!("║    avg TTFT (after resp.created):    N/A");
    }
    if let Some(v) = s.avg_time_to_first_committed_ms {
        println!("║    avg TTFC (after resp.created): {:>8.0} ms", v);
    } else {
        println!("║    avg TTFC (after resp.created):    N/A");
    }
    println!("║");
    println!("║  Streaming Speed:");
    if let Some(v) = s.avg_output_delta_interval_ms {
        println!("║    avg delta interval: {:>8.0} ms", v);
    } else {
        println!("║    avg delta interval:      N/A");
    }
    if let Some(v) = s.p50_delta_interval_ms {
        println!("║    p50 delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.p90_delta_interval_ms {
        println!("║    p90 delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.p99_delta_interval_ms {
        println!("║    p99 delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.min_delta_interval_ms {
        println!("║    min delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.max_delta_interval_ms {
        println!("║    max delta interval: {:>8.0} ms", v);
    }
    println!(
        "║    avg deltas per run: {:>8.1}",
        s.avg_output_deltas_per_run
    );
    println!("║");
    if let Some(v) = s.avg_total_output_duration_ms {
        println!("║    avg total output duration: {:>8.0} ms", v);
    }
    println!("╚══════════════════════════════════════════════════════════╝");
}

// ──────────────────────────────── Helpers ────────────────────────────────────

fn elapsed_ms(start: &Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn set_read_timeout(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) {
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        }
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => {
            let _ = stream
                .get_mut()
                .set_read_timeout(Some(Duration::from_secs(10)));
        }
        _ => {}
    }
}

fn is_timeout(msg: &str) -> bool {
    msg.contains("timed out") || msg.contains("TimedOut") || msg.contains("10060")
}

fn base64_encode_i16(samples: &[i16]) -> String {
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
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

fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut result: String = s.chars().take(max - 1).collect();
        result.push('…');
        result
    }
}

fn truncate_path(path: &PathBuf, max: usize) -> String {
    let s = path.display().to_string();
    truncate_str(&s, max)
}
