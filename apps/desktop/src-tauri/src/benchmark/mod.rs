use std::net::TcpStream;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};
use url::Url;

// ──────────────────────────────── Constants ────────────────────────────────

const DEFAULT_WS_BASE_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const CHUNK_SAMPLES: usize = 320; // 20ms @ 16kHz
const CHUNK_SEND_INTERVAL_MS: u64 = 18;
const TOTAL_TIMEOUT_SECS: u64 = 180;
const SESSION_READY_TIMEOUT_SECS: u64 = 30;
pub const BENCHMARK_PROGRESS_EVENT: &str = "benchmark://progress";

// ──────────────────────────────── Config ────────────────────────────────

struct BenchmarkConfig {
    api_key: String,
    mp3_path: PathBuf,
    model: String,
    audio_mode: RealtimeAudioMode,
    interaction_capabilities: Vec<String>,
    provider_kind: String,
    base_url: String,
    auth_header_name: String,
    auth_scheme: String,
    voice: String,
    target_language: String,
    source_language: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeAudioMode {
    Manual,
    ServerVad,
    SemanticVad,
    GeminiAutoActivity,
    GeminiManualActivity,
}

trait BenchmarkAudioModeDriver {
    fn uses_manual_response(&self) -> bool;
    fn turn_detection(&self) -> Value;
}

struct ManualBenchmarkDriver;
struct ServerVadBenchmarkDriver;
struct SemanticVadBenchmarkDriver;

impl BenchmarkAudioModeDriver for ManualBenchmarkDriver {
    fn uses_manual_response(&self) -> bool {
        true
    }

    fn turn_detection(&self) -> Value {
        Value::Null
    }
}

impl BenchmarkAudioModeDriver for ServerVadBenchmarkDriver {
    fn uses_manual_response(&self) -> bool {
        false
    }

    fn turn_detection(&self) -> Value {
        json!({
            "type": "server_vad",
            "threshold": 0.0,
            "silence_duration_ms": 800
        })
    }
}

impl BenchmarkAudioModeDriver for SemanticVadBenchmarkDriver {
    fn uses_manual_response(&self) -> bool {
        false
    }

    fn turn_detection(&self) -> Value {
        json!({
            "type": "semantic_vad",
            "eagerness": "auto"
        })
    }
}

impl RealtimeAudioMode {
    fn from_frontend(value: Option<&str>, model: &str) -> Result<Self, String> {
        match value {
            Some("manual") => Ok(Self::Manual),
            Some("server_vad") => Ok(Self::ServerVad),
            Some("semantic_vad") => Ok(Self::SemanticVad),
            Some("gemini_auto_activity") => Ok(Self::GeminiAutoActivity),
            Some("gemini_manual_activity") => Ok(Self::GeminiManualActivity),
            Some(other) => Err(format!("unsupported realtime audio mode: {other}")),
            None => Ok(default_realtime_audio_mode(model)),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::ServerVad => "server_vad",
            Self::SemanticVad => "semantic_vad",
            Self::GeminiAutoActivity => "gemini_auto_activity",
            Self::GeminiManualActivity => "gemini_manual_activity",
        }
    }

    fn is_gemini(self) -> bool {
        matches!(self, Self::GeminiAutoActivity | Self::GeminiManualActivity)
    }
}

fn default_realtime_audio_mode(model: &str) -> RealtimeAudioMode {
    let normalized = model.to_ascii_lowercase();
    if normalized.contains("livetranslate") {
        RealtimeAudioMode::ServerVad
    } else {
        RealtimeAudioMode::Manual
    }
}

fn benchmark_audio_mode_driver(mode: RealtimeAudioMode) -> Box<dyn BenchmarkAudioModeDriver> {
    match mode {
        RealtimeAudioMode::Manual => Box::new(ManualBenchmarkDriver),
        RealtimeAudioMode::ServerVad => Box::new(ServerVadBenchmarkDriver),
        RealtimeAudioMode::SemanticVad => Box::new(SemanticVadBenchmarkDriver),
        RealtimeAudioMode::GeminiAutoActivity | RealtimeAudioMode::GeminiManualActivity => {
            Box::new(ServerVadBenchmarkDriver)
        }
    }
}

// ──────────────────────────────── Timing Records ────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputDelta {
    elapsed_ms: f64,
    event_type: String,
    stash: String,
    committed_text: String,
    raw_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AsrDelta {
    elapsed_ms: f64,
    stash: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    run_index: usize,
    model: String,
    connect_ms: f64,
    session_ready_ms: f64,
    audio_send_ms: f64,
    audio_chunks_sent: usize,
    audio_duration_secs: f64,
    first_asr_ms: Option<f64>,
    asr_deltas: Vec<AsrDelta>,
    asr_final: String,
    first_output_ms: Option<f64>,
    first_committed_ms: Option<f64>,
    output_deltas: Vec<OutputDelta>,
    translation_final: String,
    response_created_ms: Option<f64>,
    response_done_ms: Option<f64>,
    response_done_audio_chunks_sent: Option<usize>,
    response_done_audio_sent_secs: Option<f64>,
    response_count: u32,
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,
    time_to_first_token_ms: Option<f64>,
    time_to_first_committed_ms: Option<f64>,
    total_output_duration_ms: Option<f64>,
    output_delta_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    model: String,
    realtime_audio_mode: String,
    interaction_capabilities: Vec<String>,
    audio_file: String,
    audio_duration_secs: f64,
    runs: Vec<RunResult>,
    summary: Summary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkProgressEvent {
    run_id: String,
    status: String,
    phase: String,
    message: String,
    report: BenchmarkReport,
    error: Option<String>,
    audio_chunks_sent: usize,
    total_audio_chunks: usize,
}

struct BenchmarkProgressState {
    app: AppHandle,
    run_id: String,
    model: String,
    audio_file: String,
    realtime_audio_mode: RealtimeAudioMode,
    interaction_capabilities: Vec<String>,
    audio_duration_secs: f64,
    total_audio_chunks: usize,
    run: RunResult,
    last_audio_progress_emit: Instant,
}

impl BenchmarkProgressState {
    fn new(
        app: AppHandle,
        run_id: String,
        model: String,
        audio_file: String,
        realtime_audio_mode: RealtimeAudioMode,
        interaction_capabilities: Vec<String>,
        audio_duration_secs: f64,
        total_audio_chunks: usize,
    ) -> Self {
        Self {
            app,
            run_id,
            model: model.clone(),
            audio_file,
            realtime_audio_mode,
            interaction_capabilities,
            audio_duration_secs,
            total_audio_chunks,
            run: empty_run_result(0, model, audio_duration_secs),
            last_audio_progress_emit: Instant::now() - Duration::from_secs(1),
        }
    }

    fn report(&self) -> BenchmarkReport {
        let run = self.run.clone();
        BenchmarkReport {
            model: self.model.clone(),
            realtime_audio_mode: self.realtime_audio_mode.as_str().to_string(),
            interaction_capabilities: self.interaction_capabilities.clone(),
            audio_file: self.audio_file.clone(),
            audio_duration_secs: self.audio_duration_secs,
            summary: compute_summary(&[run.clone()], self.audio_duration_secs),
            runs: vec![run],
        }
    }

    fn emit(&self, status: &str, phase: &str, message: impl Into<String>, error: Option<String>) {
        let payload = BenchmarkProgressEvent {
            run_id: self.run_id.clone(),
            status: status.to_string(),
            phase: phase.to_string(),
            message: message.into(),
            report: self.report(),
            error,
            audio_chunks_sent: self.run.audio_chunks_sent,
            total_audio_chunks: self.total_audio_chunks,
        };
        let _ = self.app.emit(BENCHMARK_PROGRESS_EVENT, payload);
    }

    fn emit_audio_progress(&mut self, force: bool) {
        if force || self.last_audio_progress_emit.elapsed() >= Duration::from_millis(250) {
            self.last_audio_progress_emit = Instant::now();
            self.emit(
                "running",
                "audio-streaming",
                format!(
                    "已发送 {}/{} 个音频分片",
                    self.run.audio_chunks_sent, self.total_audio_chunks
                ),
                None,
            );
        }
    }
}

// ──────────────────────────────── Tauri Command ────────────────────────────────

#[tauri::command]
pub async fn run_model_benchmark(
    app: AppHandle,
    model: String,
    api_key: String,
    mp3_path: String,
    run_id: String,
    realtime_audio_mode: Option<String>,
    interaction_capabilities: Option<Vec<String>>,
    provider_kind: Option<String>,
    base_url: Option<String>,
    auth_header_name: Option<String>,
    auth_scheme: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let audio_mode = RealtimeAudioMode::from_frontend(realtime_audio_mode.as_deref(), &model)?;
        let config = BenchmarkConfig {
            api_key,
            mp3_path: PathBuf::from(&mp3_path),
            model: model.clone(),
            audio_mode,
            interaction_capabilities: interaction_capabilities.unwrap_or_default(),
            provider_kind: provider_kind.unwrap_or_else(|| "dashscope".to_string()),
            base_url: base_url
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_WS_BASE_URL.to_string()),
            auth_header_name: auth_header_name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Authorization".to_string()),
            auth_scheme: auth_scheme
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "bearer".to_string()),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            source_language: "en".to_string(),
        };

        if !config.mp3_path.exists() {
            return Err(format!("MP3 file not found: {}", config.mp3_path.display()));
        }

        let samples = read_mp3_samples(&config.mp3_path)?;
        let audio_duration = samples.len() as f64 / 16_000.0;
        let total_audio_chunks = samples.chunks(CHUNK_SAMPLES).count();

        let mut progress = BenchmarkProgressState::new(
            app.clone(),
            run_id.clone(),
            model.clone(),
            mp3_path.clone(),
            config.audio_mode,
            config.interaction_capabilities.clone(),
            audio_duration,
            total_audio_chunks,
        );
        progress.emit(
            "running",
            "mp3-decoded",
            format!("MP3 已解码，音频时长 {:.1}s", audio_duration),
            None,
        );

        let result = match run_single_benchmark(0, &config, &samples, audio_duration, &mut progress)
        {
            Ok(result) => result,
            Err(error) => {
                progress.emit("error", "failed", error.clone(), Some(error.clone()));
                return Err(error);
            }
        };

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

        let run_result = RunResult {
            run_index: 0,
            model: model.clone(),
            connect_ms: result.connect_ms,
            session_ready_ms: result.session_ready_ms,
            audio_send_ms: result.audio_send_ms,
            audio_chunks_sent: result.audio_chunks_sent,
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
            response_done_audio_chunks_sent: result.response_done_audio_chunks_sent,
            response_done_audio_sent_secs: result.response_done_audio_sent_secs,
            response_count: result.response_count,
            speech_started_ms: result.speech_started_ms,
            speech_stopped_ms: result.speech_stopped_ms,
            time_to_first_token_ms: result.first_output_ms,
            time_to_first_committed_ms: result.first_committed_ms,
            total_output_duration_ms,
            output_delta_count,
        };

        let summary = compute_summary(&[run_result.clone()], audio_duration);
        let report = BenchmarkReport {
            model,
            realtime_audio_mode: config.audio_mode.as_str().to_string(),
            interaction_capabilities: config.interaction_capabilities.clone(),
            audio_file: mp3_path,
            audio_duration_secs: audio_duration,
            runs: vec![run_result],
            summary,
        };

        progress.run = report.runs[0].clone();
        progress.emit("completed", "completed", "基准测试完成", None);

        serde_json::to_string(&report).map_err(|e| format!("JSON serialize failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

// ──────────────────────────────── Single Run ────────────────────────────────

struct IntermediateResult {
    connect_ms: f64,
    session_ready_ms: f64,
    audio_send_ms: f64,
    audio_chunks_sent: usize,
    first_asr_ms: Option<f64>,
    asr_deltas: Vec<AsrDelta>,
    asr_final: String,
    first_output_ms: Option<f64>,
    first_committed_ms: Option<f64>,
    output_deltas: Vec<OutputDelta>,
    translation_final: String,
    response_created_ms: Option<f64>,
    response_done_ms: Option<f64>,
    response_done_audio_chunks_sent: Option<usize>,
    response_done_audio_sent_secs: Option<f64>,
    response_count: u32,
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,
}

fn run_single_benchmark(
    _run_idx: usize,
    config: &BenchmarkConfig,
    samples: &[i16],
    audio_duration: f64,
    progress: &mut BenchmarkProgressState,
) -> Result<IntermediateResult, String> {
    reject_non_turn_based_benchmark(config)?;

    if config.audio_mode.is_gemini() {
        return run_single_gemini_benchmark(config, samples, audio_duration, progress);
    }
    if config.provider_kind == "openai-compatible" {
        return run_single_openai_benchmark(config, samples, audio_duration, progress);
    }

    // ── Phase 1: Connect ──
    let audio_mode_driver = benchmark_audio_mode_driver(config.audio_mode);
    let manual_response = audio_mode_driver.uses_manual_response();
    let connect_start = Instant::now();
    let ws_url = build_default_benchmark_url(&config.base_url, &config.model)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("request build failed: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        build_auth_header_value(config)
            .parse()
            .map_err(|e| format!("auth header parse: {e}"))?,
    );

    let (mut socket, _) = connect(request).map_err(|e| format!("connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);
    progress.run.connect_ms = connect_ms;
    progress.emit("running", "connected", "WebSocket 已连接", None);

    set_read_timeout(&mut socket, Duration::from_secs(10));

    // ── Phase 2: Session setup ──
    let session_start = Instant::now();
    let session_cfg = build_session_update(config);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|e| format!("session.update send: {e}"))?;
    wait_session_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);
    progress.run.session_ready_ms = session_ready_ms;
    progress.emit("running", "session-ready", "Session 已就绪", None);

    // ── Phase 3+4: Interleaved audio streaming + event receiving ──
    // After each 20ms audio chunk send, briefly poll for server events with
    // a 1ms read timeout. This gives pseudo-concurrency without lock contention —
    // events are captured within 1ms of arrival during the 18ms inter-chunk gaps.
    set_read_timeout(&mut socket, Duration::from_millis(1));
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();

    let mut raw = RawResult {
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
    };
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收模型输出",
        None,
    );

    let idle_timeout = Duration::from_secs(10);
    let mut last_event = Instant::now();
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);

    for (i, chunk) in chunks.iter().enumerate() {
        // 1. Drain pending events first (non-blocking)
        drain_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;

        // 2. Send the next audio chunk
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": base64_encode_i16(chunk),
        });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("audio send at chunk {i}: {e}"))?;
        progress.run.audio_chunks_sent = i + 1;
        progress.run.audio_send_ms = elapsed_ms(&audio_start);
        progress.run.audio_duration_secs = audio_duration;
        progress.emit_audio_progress(i + 1 == chunks.len());

        // 3. Wait until it's time for the next chunk (poll events during wait)
        let deadline = audio_start + Duration::from_millis((i + 1) as u64 * CHUNK_SEND_INTERVAL_MS);
        while Instant::now() < deadline {
            if audio_start.elapsed() > total_timeout {
                break;
            }
            drain_available(
                &mut socket,
                &audio_start,
                &mut raw,
                &mut last_event,
                progress,
            )?;
            let remain = deadline.saturating_duration_since(Instant::now());
            if remain > Duration::from_millis(1) {
                thread::sleep(remain.min(Duration::from_millis(5)));
            }
        }

        if audio_start.elapsed() > total_timeout {
            break;
        }
    }

    let audio_send_ms = elapsed_ms(&audio_start);
    progress.run.audio_send_ms = audio_send_ms;
    progress.run.audio_chunks_sent = chunks.len();
    if manual_response {
        socket
            .send(Message::Text(
                json!({ "type": "input_audio_buffer.commit" })
                    .to_string()
                    .into(),
            ))
            .map_err(|e| format!("audio commit send: {e}"))?;
        socket
            .send(Message::Text(
                json!({ "type": "response.create", "response": { "modalities": ["text", "audio"] } })
                    .to_string()
                    .into(),
            ))
            .map_err(|e| format!("response.create send: {e}"))?;
        progress.emit(
            "running",
            "response-requested",
            "音频发送完成，已请求模型生成完整响应",
            None,
        );
    }
    progress.emit(
        "running",
        "audio-sent",
        "音频发送完成，等待剩余模型事件",
        None,
    );

    // ── Phase 5: Drain remaining server events ──
    // Switch back to longer timeout, wait for idle or response.done
    set_read_timeout(&mut socket, Duration::from_secs(5));
    let done_quiet_period = Duration::from_millis(700);
    while last_event.elapsed() < idle_timeout && audio_start.elapsed() < total_timeout {
        drain_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;
        if raw.response_done_ms.is_some() && last_event.elapsed() >= done_quiet_period {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = socket.close(None);

    Ok(IntermediateResult {
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        audio_chunks_sent: chunks.len(),
        first_asr_ms: raw.first_asr_ms,
        asr_deltas: raw.asr_deltas,
        asr_final: raw.asr_final,
        first_output_ms: raw.first_output_ms,
        first_committed_ms: raw.first_committed_ms,
        output_deltas: raw.output_deltas,
        translation_final: raw.translation_final,
        response_created_ms: raw.response_created_ms,
        response_done_ms: raw.response_done_ms,
        response_done_audio_chunks_sent: raw.response_done_audio_chunks_sent,
        response_done_audio_sent_secs: raw.response_done_audio_sent_secs,
        response_count: raw.response_count,
        speech_started_ms: raw.speech_started_ms,
        speech_stopped_ms: raw.speech_stopped_ms,
    })
}

fn run_single_openai_benchmark(
    config: &BenchmarkConfig,
    samples: &[i16],
    _audio_duration: f64,
    progress: &mut BenchmarkProgressState,
) -> Result<IntermediateResult, String> {
    let audio_mode_driver = benchmark_audio_mode_driver(config.audio_mode);
    let manual_response = audio_mode_driver.uses_manual_response();
    let connect_start = Instant::now();
    let ws_url = build_openai_benchmark_url(&config.base_url, &config.model)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("OpenAI request build failed: {e}"))?;
    apply_benchmark_auth(request.headers_mut(), config)?;
    request.headers_mut().insert(
        "OpenAI-Beta",
        "realtime=v1"
            .parse()
            .map_err(|e| format!("OpenAI-Beta header parse: {e}"))?,
    );

    let (mut socket, _) = connect(request).map_err(|e| format!("OpenAI connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);
    progress.run.connect_ms = connect_ms;
    progress.emit(
        "running",
        "connected",
        "OpenAI Realtime WebSocket 已连接",
        None,
    );
    set_read_timeout(&mut socket, Duration::from_secs(10));

    let session_start = Instant::now();
    let session_cfg = build_openai_session_update(config);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|e| format!("OpenAI session.update send: {e}"))?;
    wait_session_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);
    progress.run.session_ready_ms = session_ready_ms;
    progress.emit(
        "running",
        "session-ready",
        "OpenAI Realtime session 已就绪",
        None,
    );

    let mut raw = RawResult::default();
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();
    let mut last_event = Instant::now();
    let idle_timeout = Duration::from_secs(20);
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);
    set_read_timeout(&mut socket, Duration::from_millis(1));
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收 OpenAI 输出",
        None,
    );

    for (idx, chunk) in chunks.iter().enumerate() {
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": base64_encode_i16(chunk)
        });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("OpenAI audio append send: {e}"))?;
        progress.run.audio_chunks_sent = idx + 1;
        progress.emit_audio_progress(false);
        let deadline = Instant::now() + Duration::from_millis(CHUNK_SEND_INTERVAL_MS);
        while Instant::now() < deadline {
            drain_available(
                &mut socket,
                &audio_start,
                &mut raw,
                &mut last_event,
                progress,
            )?;
            let remain = deadline.saturating_duration_since(Instant::now());
            if remain > Duration::from_millis(1) {
                thread::sleep(remain.min(Duration::from_millis(5)));
            }
        }
    }

    let audio_send_ms = elapsed_ms(&audio_start);
    progress.run.audio_send_ms = audio_send_ms;
    progress.run.audio_chunks_sent = chunks.len();
    if manual_response {
        for msg in [
            json!({ "type": "input_audio_buffer.commit" }),
            json!({ "type": "response.create", "response": { "modalities": ["text"] } }),
        ] {
            socket
                .send(Message::Text(msg.to_string().into()))
                .map_err(|e| format!("OpenAI manual response send: {e}"))?;
        }
        progress.emit(
            "running",
            "response-requested",
            "音频发送完成，已请求 OpenAI 生成完整响应",
            None,
        );
    }
    progress.emit(
        "running",
        "audio-sent",
        "音频发送完成，等待 OpenAI 剩余事件",
        None,
    );

    set_read_timeout(&mut socket, Duration::from_secs(5));
    while last_event.elapsed() < idle_timeout && audio_start.elapsed() < total_timeout {
        drain_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;
        if raw.response_done_ms.is_some() && last_event.elapsed() >= Duration::from_millis(700) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = socket.close(None);

    Ok(intermediate_from_raw(
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        chunks.len(),
        raw,
    ))
}

fn run_single_gemini_benchmark(
    config: &BenchmarkConfig,
    samples: &[i16],
    _audio_duration: f64,
    progress: &mut BenchmarkProgressState,
) -> Result<IntermediateResult, String> {
    let connect_start = Instant::now();
    let ws_url = build_gemini_benchmark_url(&config.base_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Gemini request build failed: {e}"))?;
    apply_benchmark_auth(request.headers_mut(), config)?;

    let (mut socket, _) = connect(request).map_err(|e| format!("Gemini connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);
    progress.run.connect_ms = connect_ms;
    progress.emit("running", "connected", "Gemini Live WebSocket 已连接", None);
    set_read_timeout(&mut socket, Duration::from_secs(10));

    let session_start = Instant::now();
    let setup = build_gemini_setup(config);
    socket
        .send(Message::Text(setup.to_string().into()))
        .map_err(|e| format!("Gemini setup send: {e}"))?;
    wait_gemini_setup_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);
    progress.run.session_ready_ms = session_ready_ms;
    progress.emit("running", "session-ready", "Gemini Live setup 已完成", None);

    let mut raw = RawResult::default();
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();
    let mut last_event = Instant::now();
    let idle_timeout = Duration::from_secs(20);
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);
    let manual_activity = config.audio_mode == RealtimeAudioMode::GeminiManualActivity;
    set_read_timeout(&mut socket, Duration::from_millis(1));
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收 Gemini Live 输出",
        None,
    );

    if manual_activity {
        socket
            .send(Message::Text(
                json!({ "realtimeInput": { "activityStart": {} } })
                    .to_string()
                    .into(),
            ))
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
            .map_err(|e| format!("Gemini audio send: {e}"))?;
        progress.run.audio_chunks_sent = idx + 1;
        progress.emit_audio_progress(false);
        let deadline = Instant::now() + Duration::from_millis(CHUNK_SEND_INTERVAL_MS);
        while Instant::now() < deadline {
            drain_gemini_available(
                &mut socket,
                &audio_start,
                &mut raw,
                &mut last_event,
                progress,
            )?;
            let remain = deadline.saturating_duration_since(Instant::now());
            if remain > Duration::from_millis(1) {
                thread::sleep(remain.min(Duration::from_millis(5)));
            }
        }
    }

    let audio_send_ms = elapsed_ms(&audio_start);
    progress.run.audio_send_ms = audio_send_ms;
    progress.run.audio_chunks_sent = chunks.len();
    let end_msg = if manual_activity {
        json!({ "realtimeInput": { "activityEnd": {} } })
    } else {
        json!({ "realtimeInput": { "audioStreamEnd": true } })
    };
    socket
        .send(Message::Text(end_msg.to_string().into()))
        .map_err(|e| format!("Gemini audio end send: {e}"))?;
    progress.emit(
        "running",
        "audio-sent",
        "音频发送完成，等待 Gemini Live 剩余事件",
        None,
    );

    set_read_timeout(&mut socket, Duration::from_secs(5));
    while last_event.elapsed() < idle_timeout && audio_start.elapsed() < total_timeout {
        drain_gemini_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;
        if raw.response_done_ms.is_some() && last_event.elapsed() >= Duration::from_millis(700) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = socket.close(None);

    Ok(intermediate_from_raw(
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        chunks.len(),
        raw,
    ))
}

// ──────────────────────────────── Event Drain ───────────────────────────────

fn drain_available(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    r: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
) -> Result<(), String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                *last_event = Instant::now();
                let event: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let etype = event["type"].as_str().unwrap_or("?");
                let ms = elapsed_ms(audio_start);

                match etype {
                    "input_audio_buffer.speech_started" => {
                        r.speech_started_ms = Some(ms);
                        progress.run.speech_started_ms = Some(ms);
                        progress.emit("running", "vad", "检测到语音开始", None);
                    }
                    "input_audio_buffer.speech_stopped" => {
                        r.speech_stopped_ms = Some(ms);
                        progress.run.speech_stopped_ms = Some(ms);
                        progress.emit("running", "vad", "检测到语音结束", None);
                    }
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
                        progress.run.first_asr_ms = r.first_asr_ms;
                        progress.run.asr_deltas = r.asr_deltas.clone();
                        progress.run.asr_final = r.asr_final.clone();
                        progress.emit("running", "asr", "收到 ASR 流式文本", None);
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        let transcript = event["transcript"].as_str().unwrap_or("").to_string();
                        if !transcript.is_empty() {
                            r.asr_final = transcript;
                        }
                        progress.run.asr_final = r.asr_final.clone();
                        progress.emit("running", "asr-completed", "ASR 识别完成", None);
                    }
                    "response.created" => {
                        if r.response_created_ms.is_none() {
                            r.response_created_ms = Some(ms);
                        }
                        progress.run.response_created_ms = r.response_created_ms;
                        progress.emit("running", "response-created", "模型开始响应", None);
                    }
                    "response.done" => {
                        r.response_done_ms = Some(ms);
                        r.response_count += 1;
                        if r.response_done_audio_chunks_sent.is_none() {
                            let chunks_sent = progress.run.audio_chunks_sent;
                            r.response_done_audio_chunks_sent = Some(chunks_sent);
                            r.response_done_audio_sent_secs =
                                Some(chunks_sent as f64 * CHUNK_SAMPLES as f64 / 16_000.0);
                        }
                        if r.translation_final.is_empty() && r.output_deltas.is_empty() {
                            if let Some(text) = extract_response_text(&event) {
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
                        progress.run.response_done_ms = r.response_done_ms;
                        progress.run.response_done_audio_chunks_sent =
                            r.response_done_audio_chunks_sent;
                        progress.run.response_done_audio_sent_secs =
                            r.response_done_audio_sent_secs;
                        progress.run.response_count = r.response_count;
                        sync_output_progress(progress, r);
                        progress.run.total_output_duration_ms =
                            compute_total_output_duration(&progress.run);
                        progress.emit("running", "response-done", "模型响应完成", None);
                    }
                    "response.audio_transcript.delta" => {
                        let delta = extract_direct_text(&event).unwrap_or_default();
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
                        sync_output_progress(progress, r);
                        progress.emit("running", "asr", "收到音频转写 delta", None);
                    }
                    "response.text.delta"
                    | "response.output_text.delta"
                    | "response.transcript.delta" => {
                        let delta = extract_direct_text(&event).unwrap_or_default();
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
                        sync_output_progress(progress, r);
                        progress.emit("running", "output-delta", "收到模型输出 delta", None);
                    }
                    "response.audio_transcript.done" => {
                        let text = extract_audio_transcript_text(&event).unwrap_or_default();
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
                        sync_output_progress(progress, r);
                        progress.emit("running", "output-committed", "模型音频转写完成", None);
                    }
                    "response.text.done"
                    | "response.output_text.done"
                    | "response.transcript.done" => {
                        let text = extract_response_text(&event).unwrap_or_default();
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
                        sync_output_progress(progress, r);
                        progress.emit("running", "output-committed", "模型输出已提交", None);
                    }
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
                        if !current_text.is_empty() {
                            r.translation_final = current_text.clone();
                            if r.first_committed_ms.is_none() {
                                r.first_committed_ms = Some(ms);
                            }
                        }
                        r.output_deltas.push(OutputDelta {
                            elapsed_ms: ms,
                            event_type: etype.to_string(),
                            stash,
                            committed_text: text_val.clone(),
                            raw_text: current_text,
                        });
                        sync_output_progress(progress, r);
                        progress.emit("running", "output-text", "收到模型输出文本", None);
                    }
                    "error" => {
                        return Err(format!("server error: {}", event["error"]));
                    }
                    _ => {
                        if is_model_text_output_event(etype) {
                            if let Some(text) = extract_response_text(&event) {
                                if r.first_output_ms.is_none() {
                                    r.first_output_ms = Some(ms);
                                }
                                if etype.ends_with(".done") || etype.ends_with(".completed") {
                                    if r.first_committed_ms.is_none() {
                                        r.first_committed_ms = Some(ms);
                                    }
                                    r.translation_final = text.clone();
                                }
                                r.output_deltas.push(OutputDelta {
                                    elapsed_ms: ms,
                                    event_type: etype.to_string(),
                                    stash: if etype.ends_with(".delta") {
                                        text.clone()
                                    } else {
                                        String::new()
                                    },
                                    committed_text: if etype.ends_with(".delta") {
                                        String::new()
                                    } else {
                                        text.clone()
                                    },
                                    raw_text: text,
                                });
                                sync_output_progress(progress, r);
                                progress.emit("running", "output-event", "收到模型输出事件", None);
                            }
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Err(e) if is_timeout(&e.to_string()) => return Ok(()), // No more events right now
            Err(e) => return Err(format!("read error: {e}")),
            _ => continue,
        }
    }
}

fn reject_non_turn_based_benchmark(config: &BenchmarkConfig) -> Result<(), String> {
    let provider_kind = config.provider_kind.to_ascii_lowercase();
    if matches!(
        provider_kind.as_str(),
        "openrouter" | "ollama" | "lmstudio" | "nvidia"
    ) {
        return Err(format!(
            "provider kind '{}' is not a turn-based realtime voice session backend for this benchmark",
            config.provider_kind
        ));
    }

    let capabilities: Vec<String> = config
        .interaction_capabilities
        .iter()
        .map(|item| item.to_ascii_lowercase())
        .collect();
    let has = |capability: &str| capabilities.iter().any(|item| item == capability);
    let has_turn_session = has("auto_vad") || has("manual_commit") || has("client_activity");

    if has("text_only_backend") {
        return Err("text_only_backend models require an external ASR/TTS chain; realtime voice benchmark is unsupported".to_string());
    }
    if has("pipeline_asr_mt_tts") {
        return Err("pipeline_asr_mt_tts backends should be benchmarked as ASR -> MT -> TTS pipelines, not turn-based realtime sessions".to_string());
    }
    if has("chunked_http_audio") && !has_turn_session {
        return Err("chunked_http_audio models expose request/stream audio endpoints, not turn-level realtime VAD/manual sessions".to_string());
    }
    if (has("server_commit_tts") || has("commit_tts")) && !has_turn_session {
        return Err("TTS commit modes synthesize text buffers and do not accept microphone audio benchmark input".to_string());
    }

    Ok(())
}

// ──────────────────────────────── Event Receiver ────────────────────────────

fn drain_gemini_available(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    r: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
) -> Result<(), String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                *last_event = Instant::now();
                let event: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let ms = elapsed_ms(audio_start);

                if event.get("setupComplete").is_some() {
                    continue;
                }
                if event.get("error").is_some() {
                    return Err(format!("Gemini server error: {}", event["error"]));
                }

                if let Some(input_text) = event
                    .pointer("/serverContent/inputTranscription/text")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
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
                    progress.run.first_asr_ms = r.first_asr_ms;
                    progress.run.asr_deltas = r.asr_deltas.clone();
                    progress.run.asr_final = r.asr_final.clone();
                    progress.emit("running", "asr", "收到 Gemini 输入转写文本", None);
                }

                if let Some(output_text) = event
                    .pointer("/serverContent/outputTranscription/text")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    push_gemini_output_delta(
                        r,
                        progress,
                        ms,
                        "serverContent.outputTranscription",
                        output_text,
                    );
                }

                let model_text = collect_gemini_model_text(
                    event
                        .pointer("/serverContent/modelTurn")
                        .unwrap_or(&Value::Null),
                );
                if !model_text.is_empty() {
                    push_gemini_output_delta(
                        r,
                        progress,
                        ms,
                        "serverContent.modelTurn",
                        &model_text,
                    );
                }

                let turn_complete = event
                    .pointer("/serverContent/turnComplete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if turn_complete {
                    r.response_done_ms = Some(ms);
                    r.response_count += 1;
                    if r.response_done_audio_chunks_sent.is_none() {
                        let chunks_sent = progress.run.audio_chunks_sent;
                        r.response_done_audio_chunks_sent = Some(chunks_sent);
                        r.response_done_audio_sent_secs =
                            Some(chunks_sent as f64 * CHUNK_SAMPLES as f64 / 16_000.0);
                    }
                    if r.first_committed_ms.is_none() && !r.translation_final.is_empty() {
                        r.first_committed_ms = Some(ms);
                    }
                    progress.run.response_done_ms = r.response_done_ms;
                    progress.run.response_done_audio_chunks_sent =
                        r.response_done_audio_chunks_sent;
                    progress.run.response_done_audio_sent_secs = r.response_done_audio_sent_secs;
                    progress.run.response_count = r.response_count;
                    sync_output_progress(progress, r);
                    progress.emit("running", "response-done", "Gemini Live 响应完成", None);
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Err(e) if is_timeout(&e.to_string()) => return Ok(()),
            Err(e) => return Err(format!("Gemini read error: {e}")),
            _ => continue,
        }
    }
}

fn push_gemini_output_delta(
    r: &mut RawResult,
    progress: &mut BenchmarkProgressState,
    ms: f64,
    event_type: &str,
    text: &str,
) {
    if r.first_output_ms.is_none() {
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
    sync_output_progress(progress, r);
    progress.emit("running", "output-delta", "收到 Gemini Live 输出文本", None);
}

fn collect_gemini_model_text(value: &Value) -> String {
    fn walk(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    out.push_str(text);
                }
                for child in map.values() {
                    walk(child, out);
                }
            }
            Value::Array(items) => {
                for child in items {
                    walk(child, out);
                }
            }
            _ => {}
        }
    }

    let mut out = String::new();
    walk(value, &mut out);
    out
}

#[derive(Default)]
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
    response_done_audio_chunks_sent: Option<usize>,
    response_done_audio_sent_secs: Option<f64>,
    response_count: u32,
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,
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

fn intermediate_from_raw(
    connect_ms: f64,
    session_ready_ms: f64,
    audio_send_ms: f64,
    audio_chunks_sent: usize,
    raw: RawResult,
) -> IntermediateResult {
    IntermediateResult {
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        audio_chunks_sent,
        first_asr_ms: raw.first_asr_ms,
        asr_deltas: raw.asr_deltas,
        asr_final: raw.asr_final,
        first_output_ms: raw.first_output_ms,
        first_committed_ms: raw.first_committed_ms,
        output_deltas: raw.output_deltas,
        translation_final: raw.translation_final,
        response_created_ms: raw.response_created_ms,
        response_done_ms: raw.response_done_ms,
        response_done_audio_chunks_sent: raw.response_done_audio_chunks_sent,
        response_done_audio_sent_secs: raw.response_done_audio_sent_secs,
        response_count: raw.response_count,
        speech_started_ms: raw.speech_started_ms,
        speech_stopped_ms: raw.speech_stopped_ms,
    }
}

fn compute_total_output_duration(run: &RunResult) -> Option<f64> {
    match (
        run.response_done_ms,
        run.first_output_ms,
        run.response_created_ms,
    ) {
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
    let mut url =
        Url::parse(base_url.trim()).map_err(|e| format!("invalid base URL: {e}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        "wss" | "ws" => url.scheme(),
        other => return Err(format!("unsupported URL scheme: {other}")),
    }
    .to_string();
    url.set_scheme(&scheme)
        .map_err(|_| format!("unsupported URL scheme: {scheme}"))?;
    // DashScope uses a fixed WebSocket endpoint path, distinct from the REST API path.
    if url
        .host_str()
        .is_some_and(|h| h.contains("dashscope.aliyuncs.com"))
    {
        url.set_path("/api-ws/v1/realtime");
    }
    url.query_pairs_mut().clear().append_pair("model", model);
    Ok(url)
}

fn build_openai_benchmark_url(base_url: &str, model: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(base_url.trim()).map_err(|e| format!("invalid OpenAI base URL: {e}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        "wss" | "ws" => url.scheme(),
        other => return Err(format!("unsupported OpenAI realtime URL scheme: {other}")),
    }
    .to_string();
    url.set_scheme(&scheme)
        .map_err(|_| format!("unsupported OpenAI realtime URL scheme: {scheme}"))?;
    let path = url.path().trim_end_matches('/').to_string();
    let realtime_path = if path.is_empty() || path == "/" {
        "/v1/realtime".to_string()
    } else if path.ends_with("/realtime") {
        path
    } else {
        format!("{path}/realtime")
    };
    url.set_path(&realtime_path);
    url.query_pairs_mut().clear().append_pair("model", model);
    Ok(url)
}

fn build_gemini_benchmark_url(base_url: &str) -> Result<Url, String> {
    const SERVICE: &str =
        "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
    let mut url =
        Url::parse(base_url.trim()).map_err(|e| format!("invalid Gemini base URL: {e}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        "wss" | "ws" => url.scheme(),
        other => return Err(format!("unsupported Gemini Live URL scheme: {other}")),
    }
    .to_string();
    url.set_scheme(&scheme)
        .map_err(|_| format!("unsupported Gemini Live URL scheme: {scheme}"))?;
    url.set_path(&format!("/ws/{SERVICE}"));
    Ok(url)
}

fn build_session_update(config: &BenchmarkConfig) -> Value {
    let is_livetranslate = config.model.to_ascii_lowercase().contains("livetranslate");
    let audio_mode_driver = benchmark_audio_mode_driver(config.audio_mode);
    let turn_detection = audio_mode_driver.turn_detection();

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

fn build_openai_session_update(config: &BenchmarkConfig) -> Value {
    let audio_mode_driver = benchmark_audio_mode_driver(config.audio_mode);
    json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "model": config.model,
            "instructions": "Transcribe the input audio and translate it to Chinese. Keep the response concise.",
            "output_modalities": ["text"],
            "audio": {
                "input": {
                    "format": {
                        "type": "audio/pcm",
                        "rate": 16000
                    },
                    "turn_detection": audio_mode_driver.turn_detection()
                }
            }
        }
    })
}

fn build_gemini_setup(config: &BenchmarkConfig) -> Value {
    let model = if config.model.starts_with("models/") {
        config.model.clone()
    } else {
        format!("models/{}", config.model)
    };
    let disabled = config.audio_mode == RealtimeAudioMode::GeminiManualActivity;
    json!({
        "setup": {
            "model": model,
            "generationConfig": {
                "responseModalities": ["TEXT"]
            },
            "systemInstruction": {
                "parts": [{
                    "text": format!(
                        "Transcribe the input audio and translate it to Chinese. Keep the response concise. Target language: {}.",
                        config.target_language
                    )
                }]
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "realtimeInputConfig": {
                "automaticActivityDetection": {
                    "disabled": disabled
                }
            }
        }
    })
}

fn wait_session_ready(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<(), String> {
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

fn wait_gemini_setup_ready(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(SESSION_READY_TIMEOUT_SECS);
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("Gemini JSON error during setup: {e}"))?;
                if event.get("setupComplete").is_some() {
                    return Ok(());
                }
                if event.get("error").is_some() {
                    return Err(format!("Gemini server error: {}", event["error"]));
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

// ──────────────────────────────── Audio I/O ─────────────────────────────────

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

fn normalize_language(lang: &str) -> &str {
    match lang {
        l if l.starts_with("zh") => "zh",
        l if l.starts_with("en") => "en",
        l if l.starts_with("ja") => "ja",
        l if l.starts_with("ko") => "ko",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_report_serializes_with_empty_run_defaults() {
        let run = empty_run_result(0, "qwen-test-realtime".to_string(), 12.5);
        let report = BenchmarkReport {
            model: "qwen-test-realtime".to_string(),
            realtime_audio_mode: "manual".to_string(),
            interaction_capabilities: vec!["manual_commit".to_string()],
            audio_file: "sample.mp3".to_string(),
            audio_duration_secs: 12.5,
            summary: compute_summary(&[run.clone()], 12.5),
            runs: vec![run],
        };

        let json = serde_json::to_value(&report).expect("report should serialize");
        assert_eq!(json["model"], "qwen-test-realtime");
        assert_eq!(json["realtimeAudioMode"], "manual");
        assert_eq!(json["runs"][0]["audioChunksSent"], 0);
        assert!(json["runs"][0]["responseDoneAudioChunksSent"].is_null());
        assert!(json["runs"][0]["responseDoneAudioSentSecs"].is_null());
        assert_eq!(json["summary"]["successfulRuns"], 0);
    }

    #[test]
    fn benchmark_builds_provider_specific_realtime_urls() {
        let openai = build_openai_benchmark_url("https://api.openai.com/v1", "gpt-realtime")
            .expect("OpenAI URL should build");
        assert_eq!(
            openai.as_str(),
            "wss://api.openai.com/v1/realtime?model=gpt-realtime"
        );

        let proxy =
            build_openai_benchmark_url("https://proxy.example.com/openai/v1", "gpt-realtime")
                .expect("proxy URL should preserve path");
        assert_eq!(
            proxy.as_str(),
            "wss://proxy.example.com/openai/v1/realtime?model=gpt-realtime"
        );

        let gemini =
            build_gemini_benchmark_url("https://generativelanguage.googleapis.com/v1beta/openai")
                .expect("Gemini URL should build");
        assert_eq!(
            gemini.as_str(),
            "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        );

        // DashScope: REST base_url should be rewritten to the fixed WebSocket path.
        let dashscope = build_default_benchmark_url(
            "https://dashscope.aliyuncs.com/api/v1",
            "qwen3.5-omni-plus-realtime",
        )
        .expect("DashScope URL should build");
        assert_eq!(
            dashscope.as_str(),
            "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime"
        );

        // Non-DashScope host should keep original path.
        let custom = build_default_benchmark_url(
            "wss://custom.example.com/ws/v1",
            "my-model",
        )
        .expect("custom URL should build");
        assert_eq!(
            custom.as_str(),
            "wss://custom.example.com/ws/v1?model=my-model"
        );
    }

    #[test]
    fn benchmark_modes_include_openai_and_gemini_protocol_shapes() {
        let mut config = BenchmarkConfig {
            api_key: "key".to_string(),
            mp3_path: PathBuf::from("sample.mp3"),
            model: "gpt-realtime".to_string(),
            audio_mode: RealtimeAudioMode::SemanticVad,
            interaction_capabilities: vec!["auto_vad".to_string(), "manual_commit".to_string()],
            provider_kind: "openai-compatible".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            auth_header_name: "Authorization".to_string(),
            auth_scheme: "bearer".to_string(),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            source_language: "en".to_string(),
        };
        let openai = build_openai_session_update(&config);
        assert_eq!(
            openai
                .pointer("/session/audio/input/turn_detection/type")
                .and_then(Value::as_str),
            Some("semantic_vad")
        );

        config.model = "gemini-2.5-flash-live".to_string();
        config.audio_mode = RealtimeAudioMode::GeminiManualActivity;
        let gemini = build_gemini_setup(&config);
        assert_eq!(
            gemini
                .pointer("/setup/realtimeInputConfig/automaticActivityDetection/disabled")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            RealtimeAudioMode::GeminiAutoActivity.as_str(),
            "gemini_auto_activity"
        );
    }

    #[test]
    fn output_progress_updates_summary_source_fields() {
        let mut run = empty_run_result(0, "qwen-test-realtime".to_string(), 3.0);
        run.response_created_ms = Some(100.0);
        run.first_output_ms = Some(130.0);
        run.response_done_ms = Some(260.0);
        run.response_count = 1;
        run.output_deltas = vec![
            OutputDelta {
                elapsed_ms: 130.0,
                event_type: "response.text.delta".to_string(),
                stash: "你".to_string(),
                committed_text: String::new(),
                raw_text: "你".to_string(),
            },
            OutputDelta {
                elapsed_ms: 160.0,
                event_type: "response.text.delta".to_string(),
                stash: "好".to_string(),
                committed_text: String::new(),
                raw_text: "好".to_string(),
            },
        ];
        run.output_delta_count = run.output_deltas.len();
        run.total_output_duration_ms = compute_total_output_duration(&run);

        let summary = compute_summary(&[run], 3.0);
        assert_eq!(summary.successful_runs, 1);
        assert_eq!(summary.avg_output_deltas_per_run, 2.0);
        assert_eq!(summary.avg_total_output_duration_ms, Some(130.0));
    }

    #[test]
    fn extracts_output_text_delta_events() {
        let event = json!({
            "type": "response.output_text.delta",
            "delta": "hello"
        });

        assert_eq!(extract_direct_text(&event), Some("hello".to_string()));
    }

    #[test]
    fn extracts_audio_transcript_done_text() {
        let event = json!({
            "type": "response.audio_transcript.done",
            "transcript": "五亿美元的生物燃料。"
        });

        assert_eq!(
            extract_audio_transcript_text(&event),
            Some("五亿美元的生物燃料。".to_string())
        );
    }

    #[test]
    fn shorter_done_text_does_not_replace_longer_live_output() {
        assert!(!should_replace_final_text("都始于这1美元。", "这一切"));
        assert!(should_replace_final_text(
            "这是一",
            "这是一台价值十亿美元的火箭。"
        ));
    }

    #[test]
    fn extracts_nested_response_done_text() {
        let event = json!({
            "type": "response.done",
            "response": {
                "output": [{
                    "content": [
                        {"type": "output_text", "text": "hello"},
                        {"type": "audio", "transcript": " world"}
                    ]
                }]
            }
        });

        assert_eq!(
            extract_response_text(&event),
            Some("hello world".to_string())
        );
    }

    #[test]
    fn recognizes_binary_audio_events() {
        assert!(is_binary_audio_event("response.audio.delta"));
        assert!(is_binary_audio_event("response.output_audio.delta"));
        assert!(!is_binary_audio_event("response.audio_transcript.delta"));
        assert!(!is_binary_audio_event("response.output_text.delta"));
    }

    #[test]
    fn classifies_audio_transcript_as_model_text_output() {
        assert!(is_model_text_output_event(
            "response.audio_transcript.delta"
        ));
        assert!(is_model_text_output_event("response.audio_transcript.done"));
        assert!(is_model_text_output_event("response.output_text.delta"));
        assert!(!is_model_text_output_event("response.audio.delta"));
        assert!(!is_model_text_output_event(
            "conversation.item.input_audio_transcription.text"
        ));
    }

    #[test]
    fn uses_manual_response_for_non_livetranslate_models() {
        assert_eq!(
            default_realtime_audio_mode("qwen3.5-omni-plus-realtime"),
            RealtimeAudioMode::Manual
        );
        assert_eq!(
            default_realtime_audio_mode("qwen3.5-livetranslate-flash-realtime"),
            RealtimeAudioMode::ServerVad
        );
    }

    #[test]
    fn session_turn_detection_matches_model_family() {
        let mut config = BenchmarkConfig {
            api_key: "test".to_string(),
            mp3_path: PathBuf::from("sample.mp3"),
            model: "qwen3.5-omni-plus-realtime".to_string(),
            audio_mode: RealtimeAudioMode::Manual,
            interaction_capabilities: vec!["auto_vad".to_string(), "manual_commit".to_string()],
            provider_kind: "dashscope".to_string(),
            base_url: DEFAULT_WS_BASE_URL.to_string(),
            auth_header_name: "Authorization".to_string(),
            auth_scheme: "bearer".to_string(),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            source_language: "en".to_string(),
        };
        assert!(build_session_update(&config)["session"]["turn_detection"].is_null());

        config.model = "qwen3.5-livetranslate-flash-realtime".to_string();
        config.audio_mode = RealtimeAudioMode::ServerVad;
        assert_eq!(
            build_session_update(&config)["session"]["turn_detection"]["type"],
            "server_vad"
        );

        config.audio_mode = RealtimeAudioMode::SemanticVad;
        assert_eq!(
            build_session_update(&config)["session"]["turn_detection"]["type"],
            "semantic_vad"
        );
    }
}
