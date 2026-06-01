use std::io::Read;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

const DEFAULT_MODEL: &str = "qwen3.5-omni-plus-realtime-2026-03-15";
const DEFAULT_BASE_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const CHUNK_SAMPLES: usize = 320;

#[derive(Debug)]
struct Config {
    api_key: String,
    pcm_path: PathBuf,
    model: String,
    manual: bool,
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let config = match parse_args() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{message}");
            print_usage();
            std::process::exit(2);
        }
    };

    if let Err(error) = run(config) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn parse_args() -> Result<Config, String> {
    let api_key = std::env::var("DASHSCOPE_API_KEY")
        .map_err(|_| "DASHSCOPE_API_KEY is required".to_string())?;
    if api_key.trim().is_empty() {
        return Err("DASHSCOPE_API_KEY is empty".to_string());
    }

    let mut pcm_path: Option<PathBuf> = None;
    let mut model = DEFAULT_MODEL.to_string();
    let mut manual = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--pcm" => pcm_path = Some(PathBuf::from(next_value(&mut args, "--pcm")?)),
            "--model" => model = next_value(&mut args, "--model")?,
            "--manual" => manual = true,
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let pcm_path = pcm_path.ok_or_else(|| "--pcm <path> is required".to_string())?;
    Ok(Config {
        api_key,
        pcm_path,
        model,
        manual,
    })
}

fn next_value(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

fn print_usage() {
    eprintln!("Usage: omni-realtime-diagnostic --pcm <16k_mono_pcm> [--manual] [--model <model>]");
}

fn run(config: Config) -> Result<(), String> {
    let samples = read_pcm_samples(&config.pcm_path)?;
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    println!("Omni Realtime Diagnostic");
    println!("model={}", config.model);
    println!("mode={}", if config.manual { "manual" } else { "semantic_vad" });
    println!(
        "pcm_samples={} duration={:.1}s chunks={}",
        samples.len(),
        samples.len() as f64 / 16_000.0,
        chunks.len()
    );

    let ws_url = format!("{}?model={}", DEFAULT_BASE_URL, config.model);
    let mut request = ws_url
        .into_client_request()
        .map_err(|error| format!("failed to create request: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|error| format!("failed to parse auth header: {error}"))?,
    );

    println!("connecting...");
    let (mut socket, _) = connect(request).map_err(|error| format!("connect failed: {error}"))?;
    set_read_timeout(&mut socket);

    let session_cfg = session_update(config.manual);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("failed to send session.update: {error}"))?;
    wait_for_session_ready(&mut socket)?;

    println!("streaming audio...");
    let audio_start = Instant::now();
    for (index, chunk) in chunks.iter().enumerate() {
        let append = json!({
            "type": "input_audio_buffer.append",
            "audio": base64_encode_i16(chunk),
        });
        socket
            .send(Message::Text(append.to_string().into()))
            .map_err(|error| format!("audio send failed at chunk {index}: {error}"))?;
        if index % 200 == 0 {
            println!("audio {}/{}", index + 1, chunks.len());
        }
        thread::sleep(Duration::from_millis(18));
    }

    if config.manual {
        socket
            .send(Message::Text(json!({ "type": "input_audio_buffer.commit" }).to_string().into()))
            .map_err(|error| format!("failed to send commit: {error}"))?;
        socket
            .send(Message::Text(json!({ "type": "response.create" }).to_string().into()))
            .map_err(|error| format!("failed to send response.create: {error}"))?;
    }

    receive_result(&mut socket, audio_start, config.manual)?;
    let _ = socket.close(None);
    Ok(())
}

fn read_pcm_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    let mut raw = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| format!("failed to open PCM file '{}': {error}", path.display()))?
        .read_to_end(&mut raw)
        .map_err(|error| format!("failed to read PCM file '{}': {error}", path.display()))?;

    if raw.len() % 2 != 0 {
        return Err("PCM file length must be an even number of bytes".to_string());
    }

    Ok(raw
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
        .collect())
}

fn session_update(manual: bool) -> Value {
    let turn_detection = if manual {
        Value::Null
    } else {
        json!({
            "type": "semantic_vad",
            "threshold": 0.5,
            "silence_duration_ms": 800,
        })
    };

    json!({
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "voice": "Ethan",
            "instructions": "Transcribe the audio and translate it to English.",
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "output_audio_format": "pcm",
            "turn_detection": turn_detection,
        }
    })
}

fn wait_for_session_ready(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid JSON from server: {error}"))?;
                match event["type"].as_str().unwrap_or("?") {
                    "session.created" => println!("session.created"),
                    "session.updated" => {
                        println!("session.updated");
                        return Ok(());
                    }
                    "error" => return Err(format!("server error: {}", event["error"])),
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return Err("server closed before session was ready".to_string()),
            Err(error) if is_timeout(&error.to_string()) => continue,
            Err(error) => return Err(format!("read failed while waiting for session: {error}")),
            _ => {}
        }
    }

    Err("timed out waiting for session.updated".to_string())
}

fn receive_result(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    start: Instant,
    manual: bool,
) -> Result<(), String> {
    let total_timeout = Duration::from_secs(120);
    let idle_timeout = Duration::from_secs(15);
    let mut last_event = Instant::now();
    let mut source = String::new();
    let mut translation = String::new();
    let mut response_count = 0_u32;

    loop {
        if start.elapsed() > total_timeout || last_event.elapsed() > idle_timeout {
            break;
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                last_event = Instant::now();
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid JSON from server: {error}"))?;
                match event["type"].as_str().unwrap_or("?") {
                    "input_audio_buffer.speech_started" => println!("speech_started"),
                    "input_audio_buffer.speech_stopped" => println!("speech_stopped"),
                    "conversation.item.input_audio_transcription.completed" => {
                        source = event["transcript"].as_str().unwrap_or("").to_string();
                        println!("source={source}");
                    }
                    "response.audio_transcript.delta" => {
                        if let Some(delta) = event["delta"].as_str() {
                            translation.push_str(delta);
                        }
                    }
                    "response.audio_transcript.done" => {
                        if let Some(transcript) = event["transcript"].as_str() {
                            if !transcript.is_empty() {
                                translation = transcript.to_string();
                            }
                        }
                        println!("translation={translation}");
                    }
                    "response.done" => {
                        response_count += 1;
                        println!("response.done count={response_count}");
                        if manual {
                            break;
                        }
                    }
                    "error" => return Err(format!("server error: {}", event["error"])),
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => break,
            Err(error) if is_timeout(&error.to_string()) => continue,
            Err(error) => return Err(format!("read failed: {error}")),
            _ => {}
        }
    }

    println!("Result");
    println!("responses={response_count}");
    println!("source='{source}'");
    println!("translation='{translation}'");

    if response_count == 0 && source.is_empty() && translation.is_empty() {
        return Err("no transcription or translation received".to_string());
    }

    Ok(())
}

fn set_read_timeout(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) {
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        }
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => {
            let _ = stream.get_mut().set_read_timeout(Some(Duration::from_secs(10)));
        }
        _ => {}
    }
}

fn is_timeout(message: &str) -> bool {
    message.contains("timed out") || message.contains("TimedOut") || message.contains("10060")
}

fn base64_encode_i16(samples: &[i16]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
