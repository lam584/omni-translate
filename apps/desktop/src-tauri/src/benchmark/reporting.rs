use rodio::{Decoder, Source};

#[derive(Default)]
struct RawResult {
    first_asr_ms: Option<f64>,
    asr_deltas: Vec<AsrDelta>,
    asr_final: String,
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,
    first_output_ms: Option<f64>,
    first_committed_ms: Option<f64>,
    output_deltas: Vec<OutputDelta>,
    translation_final: String,
    response_count: u32,
    response_created_ms: Option<f64>,
    response_done_ms: Option<f64>,
    response_done_audio_chunks_sent: Option<usize>,
    response_done_audio_sent_secs: Option<f64>,
}

fn empty_run_result(run_index: usize, model: String, audio_duration_secs: f64) -> RunResult {
    RunResult {
        run_index,
        model,
        connect_ms: 0.0,
        session_ready_ms: 0.0,
        audio_send_ms: 0.0,
        audio_chunks_sent: 0,
        audio_duration_secs,
        first_asr_ms: None,
        asr_deltas: Vec::new(),
        asr_final: String::new(),
        first_output_ms: None,
        first_committed_ms: None,
        output_deltas: Vec::new(),
        translation_final: String::new(),
        response_created_ms: None,
        response_done_ms: None,
        response_done_audio_chunks_sent: None,
        response_done_audio_sent_secs: None,
        response_count: 0,
        speech_started_ms: None,
        speech_stopped_ms: None,
        time_to_first_token_ms: None,
        time_to_first_committed_ms: None,
        total_output_duration_ms: None,
        output_delta_count: 0,
    }
}

fn compute_total_output_duration(run: &RunResult) -> Option<f64> {
    total_output_duration_from(
        run.response_done_ms,
        run.first_output_ms,
        run.response_created_ms,
    )
}

fn total_output_duration_from(
    response_done_ms: Option<f64>,
    first_output_ms: Option<f64>,
    response_created_ms: Option<f64>,
) -> Option<f64> {
    match (response_done_ms, first_output_ms, response_created_ms) {
        (Some(done), Some(ftt), _) => Some(done - ftt),
        (Some(done), None, Some(created)) => Some(done - created),
        _ => None,
    }
}

fn sync_output_progress(progress: &mut BenchmarkProgressState, raw: &RawResult) {
    progress.run.first_output_ms = raw.first_output_ms;
    progress.run.first_committed_ms = raw.first_committed_ms;
    progress.run.output_deltas = raw.output_deltas.clone();
    progress.run.translation_final = raw.translation_final.clone();
    progress.run.output_delta_count = raw.output_deltas.len();
    progress.run.time_to_first_token_ms = raw.first_output_ms;
    progress.run.time_to_first_committed_ms = raw.first_committed_ms;
    progress.run.total_output_duration_ms = compute_total_output_duration(&progress.run);
}

fn extract_direct_text(event: &Value) -> Option<String> {
    [
        "delta",
        "text",
        "transcript",
        "output_text",
        "audio_transcript",
    ]
    .iter()
    .find_map(|key| event.get(*key).and_then(Value::as_str))
    .map(str::to_string)
    .filter(|text| !text.is_empty())
}

fn extract_audio_transcript_text(event: &Value) -> Option<String> {
    extract_direct_text(event).or_else(|| extract_response_text(event))
}

fn should_replace_final_text(current: &str, candidate: &str) -> bool {
    !candidate.is_empty() && candidate.chars().count() >= current.chars().count()
}

fn is_binary_audio_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "response.audio.delta"
            | "response.output_audio.delta"
            | "response.audio.done"
            | "response.output_audio.done"
    )
}

fn is_model_text_output_event(event_type: &str) -> bool {
    event_type.starts_with("response.") && !is_binary_audio_event(event_type)
}

fn extract_response_text(event: &Value) -> Option<String> {
    if let Some(text) = extract_direct_text(event) {
        return Some(text);
    }

    let mut parts = Vec::new();
    collect_response_text(event.get("response").unwrap_or(event), &mut parts);
    let text = parts.join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn collect_response_text(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_response_text(item, parts);
            }
        }
        Value::Object(map) => {
            for key in ["text", "transcript", "output_text"] {
                if let Some(text) = map.get(key).and_then(Value::as_str) {
                    if !text.is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
            for key in ["output", "content", "item"] {
                if let Some(child) = map.get(key) {
                    collect_response_text(child, parts);
                }
            }
        }
        _ => {}
    }
}

// ──────────────────────────────── Session Setup ─────────────────────────────

fn build_auth_header_value(config: &BenchmarkConfig) -> String {
    if config.auth_scheme.eq_ignore_ascii_case("bearer") {
        format!("Bearer {}", config.api_key)
    } else {
        config.api_key.clone()
    }
}

fn apply_benchmark_auth(
    headers: &mut tungstenite::http::HeaderMap,
    config: &BenchmarkConfig,
) -> Result<(), String> {
    let name =
        tungstenite::http::header::HeaderName::from_bytes(config.auth_header_name.as_bytes())
            .map_err(|e| format!("auth header name parse: {e}"))?;
    let value = tungstenite::http::HeaderValue::from_str(&build_auth_header_value(config))
        .map_err(|e| format!("auth header value parse: {e}"))?;
    headers.insert(name, value);
    Ok(())
}

fn build_default_benchmark_url(base_url: &str, model: &str) -> Result<Url, String> {
    crate::provider::gateway_parts::transport::to_websocket_url(base_url, model)
        .map_err(|error| error.message)
}

// Benchmark and the production watch-mode workers must speak the identical
// protocol, so URL and session construction delegate to the audio adapters.
#[cfg(test)]
fn build_openai_benchmark_url(base_url: &str, model: &str) -> Result<Url, String> {
    crate::audio::openai_realtime::build_openai_realtime_url(base_url, model)
}

fn build_gemini_benchmark_url(base_url: &str) -> Result<Url, String> {
    crate::audio::gemini_live::build_gemini_live_url(base_url)
}

fn build_session_update(config: &BenchmarkConfig) -> Value {
    let protocol = config
        .protocol_dialect
        .unwrap_or(crate::audio::events::RealtimeProtocol::DashscopeOmni);
    crate::audio::omni::build_dashscope_session_update(
        protocol,
        &config.voice,
        BENCHMARK_INSTRUCTIONS,
        to_production_audio_mode(config.audio_mode),
        &config.target_language,
    )
    .expect("DashScope benchmark must use an Omni or LiveTranslate protocol")
}

const BENCHMARK_INSTRUCTIONS: &str =
    "Transcribe the input audio and translate it to Chinese. Keep the response concise.";

fn to_production_audio_mode(mode: RealtimeAudioMode) -> crate::audio::omni::RealtimeAudioMode {
    match mode {
        RealtimeAudioMode::Manual => crate::audio::omni::RealtimeAudioMode::Manual,
        RealtimeAudioMode::SemanticVad => crate::audio::omni::RealtimeAudioMode::SemanticVad,
        _ => crate::audio::omni::RealtimeAudioMode::ServerVad,
    }
}

fn build_openai_session_update(config: &BenchmarkConfig) -> Value {
    let dialect = config
        .protocol_dialect
        .map(crate::audio::openai_realtime::dialect_from_protocol)
        .transpose()
        .expect("benchmark protocol must resolve")
        .unwrap_or(crate::audio::openai_realtime::OpenAiRealtimeDialect::Conversation);
    crate::audio::openai_realtime::build_session_update(
        dialect,
        &config.model,
        BENCHMARK_INSTRUCTIONS,
        to_production_audio_mode(config.audio_mode),
        &config.target_language,
        false,
    )
}

fn build_gemini_setup(config: &BenchmarkConfig) -> Value {
    let mode = if config.audio_mode == RealtimeAudioMode::GeminiManualActivity {
        crate::audio::gemini_live::GeminiActivityMode::Manual
    } else {
        crate::audio::gemini_live::GeminiActivityMode::Auto
    };
    crate::audio::gemini_live::build_setup(
        &config.model,
        BENCHMARK_INSTRUCTIONS,
        mode,
        &config.target_language,
        None,
    )
}

fn wait_ready_event(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    json_error_prefix: &str,
    closed_error: &str,
    read_error_prefix: &str,
    timeout_error: &str,
    mut classify: impl FnMut(&Value) -> Option<Result<(), String>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(SESSION_READY_TIMEOUT_SECS);
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("{json_error_prefix}: {e}"))?;
                if let Some(outcome) = classify(&event) {
                    return outcome;
                }
            }
            Ok(Message::Close(_)) => {
                return Err(closed_error.to_string());
            }
            Err(e) if is_timeout(&e.to_string()) => continue,
            Err(e) => return Err(format!("{read_error_prefix}: {e}")),
            _ => {}
        }
    }
    Err(timeout_error.to_string())
}

fn wait_session_ready(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<(), String> {
    wait_ready_event(
        socket,
        "JSON error during session setup",
        "server closed before session was ready",
        "read error during session setup",
        "timed out waiting for session.updated",
        |event| match event["type"].as_str().unwrap_or("?") {
            "session.created" | "session.updated" => Some(Ok(())),
            "error" => Some(Err(format!("server error: {}", event["error"]))),
            _ => None,
        },
    )
}

fn wait_gemini_setup_ready(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
) -> Result<(), String> {
    wait_ready_event(
        socket,
        "Gemini JSON error during setup",
        "Gemini server closed before setup completed",
        "Gemini read error during setup",
        "timed out waiting for Gemini setupComplete",
        |event| {
            if event.get("setupComplete").is_some() {
                return Some(Ok(()));
            }
            event
                .get("error")
                .map(|error| Err(format!("Gemini server error: {error}")))
        },
    )
}

// ──────────────────────────────── Audio I/O ─────────────────────────────────

#[derive(Debug)]
struct AudioDecodeResult {
    samples: Vec<i16>,
    original_sample_rate: u32,
    channels: u16,
    file_size_bytes: u64,
}

fn read_audio_samples_with_info(path: &PathBuf) -> Result<AudioDecodeResult, String> {
    let file_size_bytes = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);
    let format = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (samples, original_sample_rate, channels) = match format.as_str() {
        "mp3" => read_mp3_samples(path)?,
        "wav" | "wave" => read_wav_samples(path)?,
        "pcm" | "s16le" | "raw" => (read_pcm16_samples(path)?, 16_000, 1),
        _ => {
            return Err(format!(
                "unsupported audio extension '{}'; expected .mp3, .wav, .pcm, .s16le, or .raw",
                if format.is_empty() { "(none)" } else { &format }
            ))
        }
    };
    if samples.is_empty() {
        return Err(format!("decoded audio '{}' is empty", path.display()));
    }
    Ok(AudioDecodeResult {
        samples,
        original_sample_rate,
        channels,
        file_size_bytes,
    })
}

fn read_mp3_samples(path: &PathBuf) -> Result<(Vec<i16>, u32, u16), String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("open MP3 '{}': {e}", path.display()))?;
    let decoder = Decoder::try_from(file)
        .map_err(|e| format!("MP3 decode '{}': {e}", path.display()))?;
    let original_sample_rate = decoder.sample_rate().get();
    let channels = decoder.channels().get();
    let interleaved = decoder.collect::<Vec<f32>>();
    let mono = interleaved
        .chunks(channels as usize)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len().max(1) as f32)
        .collect::<Vec<_>>();
    let samples = resample_to_16k(&mono, original_sample_rate);
    Ok((samples, original_sample_rate, channels))
}

fn read_wav_samples(path: &PathBuf) -> Result<(Vec<i16>, u32, u16), String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("open WAV '{}': {e}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1);
    let interleaved = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .map(|sample| sample.map(|value| value.clamp(-1.0, 1.0)))
            .collect::<Result<Vec<_>, _>>(),
        (hound::SampleFormat::Int, bits @ 1..=8) => {
            let scale = ((1_i32 << (bits - 1)) - 1).max(1) as f32;
            reader
                .samples::<i8>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()
        }
        (hound::SampleFormat::Int, bits @ 9..=16) => {
            let scale = ((1_i32 << (bits - 1)) - 1) as f32;
            reader
                .samples::<i16>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()
        }
        (hound::SampleFormat::Int, bits @ 17..=32) => {
            let scale = ((1_i64 << (bits - 1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()
        }
        _ => return Err(format!(
            "unsupported WAV encoding in '{}': {:?}, {} bits",
            path.display(), spec.sample_format, spec.bits_per_sample
        )),
    }
    .map_err(|e| format!("decode WAV '{}': {e}", path.display()))?;

    let mono = interleaved
        .chunks(channels as usize)
        .map(|frame| frame.iter().sum::<f32>() / frame.len().max(1) as f32)
        .collect::<Vec<_>>();
    Ok((
        resample_to_16k(&mono, spec.sample_rate),
        spec.sample_rate,
        channels,
    ))
}

fn read_pcm16_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("read PCM '{}': {e}", path.display()))?;
    if bytes.len() % 2 != 0 {
        return Err(format!(
            "PCM file '{}' has odd byte length {}; expected signed 16-bit little-endian mono",
            path.display(), bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
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

// ──────────────────────────────── Helpers ────────────────────────────────────

fn elapsed_ms(start: &Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn set_read_timeout(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>, timeout: Duration) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(timeout));
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream.get_mut().set_read_timeout(Some(timeout));
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
