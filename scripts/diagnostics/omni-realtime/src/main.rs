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
    audio_input: AudioInput,
    model: String,
    mode: RealtimeMode,
    input_audio_format: String,
    readiness: ReadinessMode,
    limit_seconds: Option<f32>,
    protocol: DashscopeProtocol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DashscopeProtocol {
    Omni,
    LiveTranslate,
}

#[derive(Debug)]
enum AudioInput {
    Pcm(PathBuf),
    Mp3(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeMode {
    Manual,
    ServerVad,
    SemanticVad,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadinessMode {
    UpdatedOnly,
    CreatedOrUpdated,
}

impl RealtimeMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::ServerVad => "server_vad",
            Self::SemanticVad => "semantic_vad",
        }
    }
}

impl ReadinessMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::UpdatedOnly => "updated_only",
            Self::CreatedOrUpdated => "created_or_updated",
        }
    }
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

    let mut audio_input: Option<AudioInput> = None;
    let mut model = DEFAULT_MODEL.to_string();
    let mut mode = RealtimeMode::ServerVad;
    let mut input_audio_format: Option<String> = None;
    let mut readiness = ReadinessMode::UpdatedOnly;
    let mut limit_seconds = None;
    let mut protocol = DashscopeProtocol::Omni;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--pcm" => {
                audio_input = Some(AudioInput::Pcm(PathBuf::from(next_value(
                    &mut args, "--pcm",
                )?)))
            }
            "--mp3" => {
                audio_input = Some(AudioInput::Mp3(PathBuf::from(next_value(
                    &mut args, "--mp3",
                )?)))
            }
            "--model" => model = next_value(&mut args, "--model")?,
            "--protocol" => protocol = parse_protocol(&next_value(&mut args, "--protocol")?)?,
            "--mode" => {
                let raw = next_value(&mut args, "--mode")?;
                mode = parse_realtime_mode(&raw)?;
            }
            "--input-audio-format" => {
                let raw = next_value(&mut args, "--input-audio-format")?;
                if raw != "pcm" && raw != "pcm16" {
                    return Err(format!(
                        "invalid --input-audio-format '{raw}'; expected pcm or pcm16"
                    ));
                }
                input_audio_format = Some(raw);
            }
            "--readiness" => {
                let raw = next_value(&mut args, "--readiness")?;
                readiness = parse_readiness_mode(&raw)?;
            }
            "--limit-seconds" => {
                let raw = next_value(&mut args, "--limit-seconds")?;
                let value = raw
                    .parse::<f32>()
                    .map_err(|error| format!("invalid --limit-seconds '{raw}': {error}"))?;
                if value <= 0.0 {
                    return Err("--limit-seconds must be greater than 0".to_string());
                }
                limit_seconds = Some(value);
            }
            "--manual" => mode = RealtimeMode::Manual,
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let audio_input =
        audio_input.ok_or_else(|| "--pcm <path> or --mp3 <path> is required".to_string())?;
    let input_audio_format = input_audio_format.unwrap_or_else(|| {
        if protocol == DashscopeProtocol::LiveTranslate {
            "pcm"
        } else {
            "pcm16"
        }
        .to_string()
    });
    Ok(Config {
        api_key,
        audio_input,
        model,
        mode,
        input_audio_format,
        readiness,
        limit_seconds,
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

fn parse_realtime_mode(value: &str) -> Result<RealtimeMode, String> {
    match value {
        "manual" => Ok(RealtimeMode::Manual),
        "server_vad" => Ok(RealtimeMode::ServerVad),
        "semantic_vad" => Ok(RealtimeMode::SemanticVad),
        other => Err(format!(
            "invalid --mode '{other}'; expected manual, server_vad, or semantic_vad"
        )),
    }
}

fn parse_readiness_mode(value: &str) -> Result<ReadinessMode, String> {
    match value {
        "updated_only" => Ok(ReadinessMode::UpdatedOnly),
        "created_or_updated" => Ok(ReadinessMode::CreatedOrUpdated),
        other => Err(format!(
            "invalid --readiness '{other}'; expected updated_only or created_or_updated"
        )),
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

fn print_usage() {
    eprintln!("Usage: omni-realtime-diagnostic (--pcm <16k_mono_pcm> | --mp3 <path>) [--protocol dashscope-omni|dashscope-livetranslate] [--manual | --mode manual|server_vad|semantic_vad] [--input-audio-format pcm|pcm16] [--readiness updated_only|created_or_updated] [--model <model>] [--limit-seconds <seconds>]");
}

fn run(config: Config) -> Result<(), String> {
    let mut samples = read_audio_samples(&config.audio_input)?;
    if let Some(limit_seconds) = config.limit_seconds {
        let max_samples = (limit_seconds * 16_000.0).ceil() as usize;
        if samples.len() > max_samples {
            samples.truncate(max_samples);
        }
    }
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    println!("Omni Realtime Diagnostic");
    println!("model={}", config.model);
    println!("mode={}", config.mode.as_str());
    println!("input_audio_format={}", config.input_audio_format);
    println!("readiness={}", config.readiness.as_str());
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

    let session_cfg = session_update(config.protocol, config.mode, &config.input_audio_format);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("failed to send session.update: {error}"))?;
    wait_for_session_ready(&mut socket, config.readiness)?;

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

    if config.mode == RealtimeMode::Manual {
        socket
            .send(Message::Text(
                json!({ "type": "input_audio_buffer.commit" })
                    .to_string()
                    .into(),
            ))
            .map_err(|error| format!("failed to send commit: {error}"))?;
        socket
            .send(Message::Text(
                json!({ "type": "response.create" }).to_string().into(),
            ))
            .map_err(|error| format!("failed to send response.create: {error}"))?;
    }

    receive_result(
        &mut socket,
        audio_start,
        config.mode == RealtimeMode::Manual,
    )?;
    let _ = socket.close(None);
    Ok(())
}

fn read_audio_samples(input: &AudioInput) -> Result<Vec<i16>, String> {
    match input {
        AudioInput::Pcm(path) => read_pcm_samples(path),
        AudioInput::Mp3(path) => read_mp3_samples(path),
    }
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

fn read_mp3_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("failed to open MP3 file '{}': {error}", path.display()))?;
    let mut decoder = minimp3::Decoder::new(file);
    let mut mono = Vec::new();
    let mut sample_rate: Option<u32> = None;

    loop {
        let frame = match decoder.next_frame() {
            Ok(frame) => frame,
            Err(minimp3::Error::Eof) => break,
            Err(error) => {
                return Err(format!(
                    "failed to decode MP3 file '{}': {error}",
                    path.display()
                ));
            }
        };
        sample_rate.get_or_insert(frame.sample_rate.max(1) as u32);
        let channels = frame.channels.max(1);
        for interleaved in frame.data.chunks(channels) {
            let sum: f32 = interleaved
                .iter()
                .map(|&sample| sample as f32 / i16::MAX as f32)
                .sum();
            mono.push(sum / interleaved.len().max(1) as f32);
        }
    }

    Ok(resample_mono_to_16k_i16(
        &mono,
        sample_rate.unwrap_or(16_000),
    ))
}

fn resample_mono_to_16k_i16(samples: &[f32], source_rate: u32) -> Vec<i16> {
    const TARGET_RATE: u32 = 16_000;
    if samples.is_empty() {
        return Vec::new();
    }

    let target_len =
        ((samples.len() as u64 * TARGET_RATE as u64) / source_rate.max(1) as u64).max(1) as usize;
    let ratio = source_rate as f64 / TARGET_RATE as f64;
    let last_index = samples.len() - 1;
    let mut resampled = Vec::with_capacity(target_len);
    for index in 0..target_len {
        let source_pos = index as f64 * ratio;
        let left_index = source_pos.floor() as usize;
        let right_index = (left_index + 1).min(last_index);
        let fraction = (source_pos - left_index as f64) as f32;
        let sample = samples[left_index] * (1.0 - fraction) + samples[right_index] * fraction;
        resampled.push((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }
    resampled
}

fn session_update(protocol: DashscopeProtocol, mode: RealtimeMode, input_audio_format: &str) -> Value {
    let turn_detection = match mode {
        RealtimeMode::Manual => Value::Null,
        RealtimeMode::ServerVad => json!({
            "type": "server_vad",
            "threshold": 0.0,
            "silence_duration_ms": 800,
        }),
        RealtimeMode::SemanticVad => json!({
            "type": "semantic_vad",
            "eagerness": "auto",
        }),
    };

    let mut session = json!({
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "voice": "Ethan",
            "instructions": "Transcribe the input audio and translate it to Chinese. Keep the response concise.",
            "input_audio_format": input_audio_format,
            "sample_rate": 16000,
            "output_audio_format": "pcm",
            "turn_detection": turn_detection,
        }
    });

    if protocol == DashscopeProtocol::LiveTranslate {
        session["session"]["input_audio_transcription"] = json!({
            "model": "qwen3-asr-flash-realtime",
            "language": "en"
        });
        session["session"]["translation"] = json!({
            "language": "zh"
        });
    }

    session
}

fn wait_for_session_ready(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    readiness: ReadinessMode,
) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid JSON from server: {error}"))?;
                match event["type"].as_str().unwrap_or("?") {
                    "session.created" => {
                        println!("session.created");
                        if readiness == ReadinessMode::CreatedOrUpdated {
                            return Ok(());
                        }
                    }
                    "session.updated" => {
                        println!("session.updated");
                        return Ok(());
                    }
                    "error" => return Err(format!("server error: {}", event["error"])),
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => {
                return Err("server closed before session was ready".to_string())
            }
            Err(error) if is_timeout(&error.to_string()) => continue,
            Err(error) => return Err(format!("read failed while waiting for session: {error}")),
            _ => {}
        }
    }

    Err(format!(
        "timed out waiting for readiness event mode={}",
        readiness.as_str()
    ))
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
                    "conversation.item.input_audio_transcription.text" => {
                        let text = event["text"]
                            .as_str()
                            .or_else(|| event["delta"].as_str())
                            .unwrap_or("");
                        source = text.to_string();
                        println!("source.text={source}");
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        source = event["transcript"].as_str().unwrap_or("").to_string();
                        println!("source={source}");
                    }
                    "response.text.delta" => {
                        if let Some(delta) = event["delta"].as_str() {
                            translation.push_str(delta);
                        }
                    }
                    "response.text.done" => {
                        if let Some(text) = event["text"].as_str() {
                            if !text.is_empty() {
                                translation = text.to_string();
                            }
                        }
                        println!("translation={translation}");
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
    let timeout = Some(Duration::from_secs(10));
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(timeout);
    } else if let tungstenite::stream::MaybeTlsStream::Rustls(stream) = socket.get_mut() {
        let _ = stream.get_mut().set_read_timeout(timeout);
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
