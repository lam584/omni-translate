use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use rodio::{Decoder, Source};
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

#[path = "../../omni-benchmark/src/bailian_contract/mod.rs"]
mod bailian_contract;

const DEFAULT_MODEL: &str = "qwen3.5-livetranslate-flash-realtime";
const DEFAULT_BASE_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const CHUNK_SAMPLES: usize = 320;
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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
    LiveTranslate,
}

#[derive(Debug)]
enum AudioInput {
    Pcm(PathBuf),
    Mp3(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeMode {
    ServerVad,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadinessMode {
    UpdatedOnly,
}

impl RealtimeMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::ServerVad => "server_vad",
        }
    }
}

impl ReadinessMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::UpdatedOnly => "updated_only",
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
    let mut protocol = DashscopeProtocol::LiveTranslate;

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
                if raw != "pcm" {
                    return Err(format!(
                        "invalid --input-audio-format '{raw}'; the enabled LiveTranslate adapter requires pcm"
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
            "--manual" => {
                return Err(
                    "--manual is not supported by the enabled LiveTranslate server_vad adapter"
                        .to_string(),
                )
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let audio_input =
        audio_input.ok_or_else(|| "--pcm <path> or --mp3 <path> is required".to_string())?;
    let input_audio_format = input_audio_format.unwrap_or_else(|| "pcm".to_string());
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
        "dashscope-livetranslate" => Ok(DashscopeProtocol::LiveTranslate),
        other => Err(format!(
            "invalid --protocol '{other}'; only the enabled dashscope-livetranslate profile is authorized"
        )),
    }
}

fn parse_realtime_mode(value: &str) -> Result<RealtimeMode, String> {
    match value {
        "server_vad" => Ok(RealtimeMode::ServerVad),
        other => Err(format!(
            "invalid --mode '{other}'; the enabled LiveTranslate adapter requires server_vad"
        )),
    }
}

fn parse_readiness_mode(value: &str) -> Result<ReadinessMode, String> {
    match value {
        "updated_only" => Ok(ReadinessMode::UpdatedOnly),
        other => Err(format!(
            "invalid --readiness '{other}'; readiness requires a typed, ordered session.updated"
        )),
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

fn print_usage() {
    eprintln!("Usage: omni-realtime-diagnostic (--pcm <16k_mono_pcm> | --mp3 <path>) [--protocol dashscope-livetranslate] [--mode server_vad] [--input-audio-format pcm] [--readiness updated_only] [--model <model>] [--limit-seconds <seconds>]");
}

fn run(config: Config) -> Result<(), String> {
    if config.protocol != DashscopeProtocol::LiveTranslate
        || config.mode != RealtimeMode::ServerVad
        || config.readiness != ReadinessMode::UpdatedOnly
        || config.input_audio_format != "pcm"
    {
        return Err(
            "model_protocol.not_authorized: only the enabled LiveTranslate pcm/server_vad adapter is supported"
                .to_string(),
        );
    }
    let session_cfg = session_update();
    let session_finish = json!({
        "event_id": next_event_id("session_finish"),
        "type": "session.finish"
    });
    let audio_append_template = json!({
        "type": "input_audio_buffer.append",
        "audio": base64_encode_i16(&[0])
    });
    let client_plan = bailian_contract::preflight_livetranslate_client_plan(
        &config.model,
        DEFAULT_BASE_URL,
        session_cfg,
        &audio_append_template,
        session_finish,
    )?;
    let mut lifecycle = bailian_contract::LiveTranslateLifecycle::new(
        client_plan.authority(),
        &config.model,
        client_plan.session_update(),
    )?;
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

    wait_for_handshake_action(
        &mut socket,
        &mut lifecycle,
        bailian_contract::ServerAction::SendSessionUpdate,
    )?;
    socket
        .send(Message::Text(client_plan.session_update().to_string().into()))
        .map_err(|error| format!("failed to send session.update: {error}"))?;
    wait_for_handshake_action(
        &mut socket,
        &mut lifecycle,
        bailian_contract::ServerAction::Ready,
    )?;

    println!("streaming audio...");
    let audio_start = Instant::now();
    for (index, chunk) in chunks.iter().enumerate() {
        let append = json!({
            "type": "input_audio_buffer.append",
            "audio": base64_encode_i16(chunk),
        });
        client_plan.admit_audio_append(&append)?;
        socket
            .send(Message::Text(append.to_string().into()))
            .map_err(|error| format!("audio send failed at chunk {index}: {error}"))?;
        if index % 200 == 0 {
            println!("audio {}/{}", index + 1, chunks.len());
        }
        thread::sleep(Duration::from_millis(18));
    }

    lifecycle.record_finish_sent()?;
    socket
        .send(Message::Text(client_plan.session_finish().to_string().into()))
        .map_err(|error| format!("failed to send session.finish: {error}"))?;

    receive_result(&mut socket, audio_start, &mut lifecycle)?;
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
    let decoder = Decoder::try_from(file)
        .map_err(|error| format!("failed to decode MP3 file '{}': {error}", path.display()))?;
    let sample_rate = decoder.sample_rate().get();
    let channels = decoder.channels().get() as usize;
    let interleaved = decoder.collect::<Vec<f32>>();
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len().max(1) as f32)
        .collect::<Vec<_>>();

    Ok(resample_mono_to_16k_i16(&mono, sample_rate))
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

fn session_update() -> Value {
    json!({
        "event_id": next_event_id("session_update"),
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.0,
                "silence_duration_ms": 400
            },
            "input_audio_transcription": {
                "model": "qwen3-asr-flash-realtime",
                "language": "en"
            },
            "translation": {
                "language": "zh"
            }
        }
    })
}

fn wait_for_handshake_action(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    lifecycle: &mut bailian_contract::LiveTranslateLifecycle,
    expected: bailian_contract::ServerAction,
) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid JSON from server: {error}"))?;
                let action = lifecycle.admit_server_event(&event)?;
                if action == expected {
                    println!("{}", event["type"].as_str().unwrap_or("session.event"));
                    return Ok(());
                }
                return Err(format!(
                    "model_protocol.event_out_of_order: expected {expected:?}, observed {action:?}"
                ));
            }
            Ok(Message::Close(_)) => {
                return Err("server closed before session was ready".to_string())
            }
            Ok(Message::Binary(_)) => {
                return Err("unexpected binary frame during LiveTranslate handshake".to_string())
            }
            Err(error) if is_timeout(&error.to_string()) => continue,
            Err(error) => return Err(format!("read failed while waiting for session: {error}")),
            _ => {}
        }
    }

    Err(format!(
        "timed out waiting for LiveTranslate handshake action {expected:?}"
    ))
}

fn receive_result(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    start: Instant,
    lifecycle: &mut bailian_contract::LiveTranslateLifecycle,
) -> Result<(), String> {
    let total_timeout = Duration::from_secs(120);
    let idle_timeout = Duration::from_secs(15);
    let mut last_event = Instant::now();
    let mut source = String::new();
    let mut translation = String::new();
    let mut response_count = 0_u32;

    loop {
        if start.elapsed() > total_timeout || last_event.elapsed() > idle_timeout {
            return Err("timed out before LiveTranslate session.finished".to_string());
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                last_event = Instant::now();
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid JSON from server: {error}"))?;
                let action = lifecycle.admit_server_event(&event)?;
                if action == bailian_contract::ServerAction::Finished {
                    println!("session.finished");
                    break;
                }
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
                    "response.text.text" | "response.audio_transcript.text" => {
                        let text = event["text"].as_str().unwrap_or("");
                        let stash = event["stash"].as_str().unwrap_or("");
                        translation = format!("{text}{stash}");
                        println!("translation.preview={translation}");
                    }
                    "response.text.done" => {
                        if let Some(text) = event["text"].as_str() {
                            if !text.is_empty() {
                                translation = text.to_string();
                            }
                        }
                        println!("translation={translation}");
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
                    }
                    "error" => return Err(format!("server error: {}", event["error"])),
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => {
                return lifecycle.record_transport_closed()
            }
            Ok(Message::Binary(_)) => {
                return Err("unexpected binary frame before LiveTranslate session.finished".to_string())
            }
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

fn next_event_id(kind: &str) -> String {
    let sequence = EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "event_omni_realtime_{}_{}_{}",
        std::process::id(),
        kind,
        sequence
    )
}

fn base64_encode_i16(samples: &[i16]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod old_red_tests {
    use super::*;

    #[test]
    fn unsupported_dialects_and_readiness_shortcuts_are_rejected() {
        assert!(parse_protocol("dashscope-omni").is_err());
        assert!(parse_readiness_mode("created_or_updated").is_err());
        assert!(parse_realtime_mode("manual").is_err());
        assert!(parse_realtime_mode("semantic_vad").is_err());
    }

    #[test]
    fn livetranslate_session_update_is_the_official_server_vad_shape() {
        let event = session_update();
        assert_eq!(event.pointer("/session/modalities"), Some(&json!(["text"])));
        assert_eq!(
            event.pointer("/session/turn_detection"),
            Some(&json!({
                "type": "server_vad",
                "threshold": 0.0,
                "silence_duration_ms": 400,
            }))
        );
        assert!(event.pointer("/session/instructions").is_none());
        assert!(event.pointer("/session/voice").is_none());
        assert!(event.pointer("/session/output_audio_format").is_none());
    }

    #[test]
    fn production_builder_echo_is_required_before_audio_readiness() {
        let update = session_update();
        let client_plan = bailian_contract::preflight_livetranslate_client_plan(
            DEFAULT_MODEL,
            DEFAULT_BASE_URL,
            update,
            &json!({"type":"input_audio_buffer.append","audio":"AAA="}),
            json!({"event_id":"evt-finish","type":"session.finish"}),
        )
        .unwrap();
        let mut lifecycle = bailian_contract::LiveTranslateLifecycle::new(
            client_plan.authority(),
            DEFAULT_MODEL,
            client_plan.session_update(),
        )
        .unwrap();
        assert_eq!(
            lifecycle
                .admit_server_event(&json!({
                    "type":"session.created",
                    "event_id":"evt-created",
                    "session":{
                        "id":"session-builder",
                        "object":"realtime.session",
                        "model":DEFAULT_MODEL
                    }
                }))
                .unwrap(),
            bailian_contract::ServerAction::SendSessionUpdate
        );
        let mut echoed = client_plan.session_update()["session"].clone();
        echoed["id"] = json!("session-builder");
        echoed["object"] = json!("realtime.session");
        echoed["model"] = json!(DEFAULT_MODEL);
        assert_eq!(
            lifecycle
                .admit_server_event(&json!({
                    "type":"session.updated",
                    "event_id":"evt-updated",
                    "session":echoed
                }))
                .unwrap(),
            bailian_contract::ServerAction::Ready
        );
    }
}
