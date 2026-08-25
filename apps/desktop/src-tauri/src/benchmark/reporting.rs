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
    omni_benchmark_core::wait_session_ready(|| match socket.read() {
        Ok(Message::Text(text)) => SessionRead::Text(text.to_string()),
        Ok(Message::Close(_)) => SessionRead::Closed,
        Err(error) => SessionRead::Error(error.to_string()),
        _ => SessionRead::Other,
    })
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
    let mut decoder = minimp3::Decoder::new(file);
    let mut mono = Vec::new();
    let mut sample_rate: Option<u32> = None;
    let mut channels: u16 = 1;

    loop {
        match decoder.next_frame() {
            Ok(frame) => {
                sample_rate.get_or_insert(frame.sample_rate.max(1) as u32);
                let ch = frame.channels.max(1);
                if ch > 1 {
                    channels = ch as u16;
                }
                mono.extend(frame.data.chunks(ch).map(|ch_slice| {
                    ch_slice
                        .iter()
                        .copied()
                        .map(|s| s as f32 / i16::MAX as f32)
                        .sum::<f32>()
                        / ch_slice.len().max(1) as f32
                }));
            }
            Err(minimp3::Error::Eof) => break,
            Err(e) => return Err(format!("MP3 decode '{}': {e}", path.display())),
        }
    }

    let original_sample_rate = sample_rate.unwrap_or(16_000);
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

// ──────────────────────────────── Statistics ────────────────────────────────

fn compute_summary(results: &[RunResult], _audio_duration: f64) -> Summary {
    let inputs = results
        .iter()
        .map(|run| omni_benchmark_core::SummaryRun {
            response_count: run.response_count,
            has_translation: !run.translation_final.is_empty(),
            connect_ms: run.connect_ms,
            session_ready_ms: run.session_ready_ms,
            first_output_ms: run.first_output_ms,
            first_committed_ms: run.first_committed_ms,
            response_created_ms: run.response_created_ms,
            total_output_duration_ms: run.total_output_duration_ms,
            output_delta_count: run.output_delta_count,
            output_delta_elapsed_ms: run
                .output_deltas
                .iter()
                .map(|delta| delta.elapsed_ms)
                .collect(),
        })
        .collect::<Vec<_>>();
    let summary = omni_benchmark_core::compute_summary(&inputs);
    Summary {
        run_count: summary.run_count,
        successful_runs: summary.successful_runs,
        avg_connect_ms: summary.avg_connect_ms,
        avg_session_ready_ms: summary.avg_session_ready_ms,
        avg_time_to_first_token_ms: summary.avg_time_to_first_token_ms,
        avg_time_to_first_committed_ms: summary.avg_time_to_first_committed_ms,
        avg_output_delta_interval_ms: summary.avg_output_delta_interval_ms,
        avg_output_deltas_per_run: summary.avg_output_deltas_per_run,
        avg_total_output_duration_ms: summary.avg_total_output_duration_ms,
        p50_delta_interval_ms: summary.p50_delta_interval_ms,
        p90_delta_interval_ms: summary.p90_delta_interval_ms,
        p99_delta_interval_ms: summary.p99_delta_interval_ms,
        min_delta_interval_ms: summary.min_delta_interval_ms,
        max_delta_interval_ms: summary.max_delta_interval_ms,
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
