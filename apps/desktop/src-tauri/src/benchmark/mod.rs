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

include!("runners.rs");
include!("event_parsing.rs");
include!("reporting.rs");
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
        // Locked to the production adapter: 24 kHz input + input transcription.
        assert_eq!(
            openai
                .pointer("/session/audio/input/format/rate")
                .and_then(Value::as_u64),
            Some(24_000)
        );
        assert!(openai
            .pointer("/session/audio/input/transcription/model")
            .is_some());

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
