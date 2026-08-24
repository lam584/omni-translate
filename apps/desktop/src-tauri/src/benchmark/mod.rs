use std::net::TcpStream;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use omni_benchmark_core::{
    base64_encode_i16, collect_gemini_model_text, resample_to_16k, SessionRead,
};
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
pub(crate) const BENCHMARK_PROGRESS_EVENT: &str = "benchmark://progress";

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
    protocol_dialect: Option<crate::audio::events::RealtimeProtocol>,
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
}

struct ManualBenchmarkDriver;
struct ServerVadBenchmarkDriver;
struct SemanticVadBenchmarkDriver;

impl BenchmarkAudioModeDriver for ManualBenchmarkDriver {
    fn uses_manual_response(&self) -> bool {
        true
    }

}

impl BenchmarkAudioModeDriver for ServerVadBenchmarkDriver {
    fn uses_manual_response(&self) -> bool {
        false
    }

}

impl BenchmarkAudioModeDriver for SemanticVadBenchmarkDriver {
    fn uses_manual_response(&self) -> bool {
        false
    }

}

impl RealtimeAudioMode {
    fn from_frontend(value: Option<&str>, _model: &str) -> Result<Self, String> {
        match value {
            Some("manual") => Ok(Self::Manual),
            Some("server_vad") => Ok(Self::ServerVad),
            Some("semantic_vad") => Ok(Self::SemanticVad),
            Some("gemini_auto_activity") => Ok(Self::GeminiAutoActivity),
            Some("gemini_manual_activity") => Ok(Self::GeminiManualActivity),
            Some(other) => Err(format!("unsupported realtime audio mode: {other}")),
            None => Ok(Self::ServerVad),
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
struct AudioFileInfo {
    /// Original file name (e.g. "sample.mp3")
    file_name: String,
    /// File format derived from extension (e.g. "mp3", "wav", "pcm")
    format: String,
    /// File size in bytes
    file_size_bytes: u64,
    /// Original sample rate before resampling (Hz)
    original_sample_rate: u32,
    /// Number of channels in the source file
    channels: u16,
    /// Decoded mono sample count at 16kHz
    decoded_samples: usize,
    /// Duration in seconds after decoding
    duration_secs: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    model: String,
    realtime_audio_mode: String,
    interaction_capabilities: Vec<String>,
    audio_file: String,
    audio_duration_secs: f64,
    audio_info: Option<AudioFileInfo>,
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
    audio_info: Option<AudioFileInfo>,
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
            audio_info: None,
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
            audio_info: self.audio_info.clone(),
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
    fn benchmark_decodes_wav_by_its_actual_format() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("benchmark.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 24_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("WAV should be created");
        for index in 0..2_400 {
            let sample = if index % 2 == 0 { 8_000_i16 } else { -8_000_i16 };
            writer.write_sample(sample).expect("left sample should write");
            writer.write_sample(sample).expect("right sample should write");
        }
        writer.finalize().expect("WAV should finalize");

        let decoded = read_audio_samples_with_info(&path).expect("WAV should decode");
        assert_eq!(decoded.original_sample_rate, 24_000);
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.samples.len(), 1_600);
    }

    #[test]
    fn benchmark_decodes_watch_mode_regression_fixture_at_full_duration() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/testing/fixtures/watch-mode-en-original.wav");

        let decoded = read_audio_samples_with_info(&path).expect("fixture WAV should decode");
        assert_eq!(decoded.original_sample_rate, 24_000);
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.samples.len(), 2_013_045);
        assert!((decoded.samples.len() as f64 / 16_000.0 - 125.815_312_5).abs() < 0.000_001);
    }

    #[test]
    fn benchmark_rejects_unknown_audio_extensions() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("benchmark.bin");
        std::fs::write(&path, [0_u8; 4]).expect("fixture should write");

        let error = read_audio_samples_with_info(&path).expect_err("format should be rejected");
        assert!(error.contains("unsupported audio extension 'bin'"));
    }

    #[test]
    fn partial_report_serializes_with_empty_run_defaults() {
        let run = empty_run_result(0, "qwen-test-realtime".to_string(), 12.5);
        let report = BenchmarkReport {
            model: "qwen-test-realtime".to_string(),
            realtime_audio_mode: "manual".to_string(),
            interaction_capabilities: vec!["manual_commit".to_string()],
            audio_file: "sample.mp3".to_string(),
            audio_duration_secs: 12.5,
            audio_info: Some(AudioFileInfo {
                file_name: "sample.mp3".to_string(),
                format: "mp3".to_string(),
                file_size_bytes: 204800,
                original_sample_rate: 44100,
                channels: 2,
                decoded_samples: 200000,
                duration_secs: 12.5,
            }),
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
        assert_eq!(json["audioInfo"]["fileName"], "sample.mp3");
        assert_eq!(json["audioInfo"]["format"], "mp3");
        assert_eq!(json["audioInfo"]["fileSizeBytes"], 204800);
        assert_eq!(json["audioInfo"]["originalSampleRate"], 44100);
        assert_eq!(json["audioInfo"]["channels"], 2);
        assert_eq!(json["audioInfo"]["decodedSamples"], 200000);
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

        // Custom DashScope gateways use the same fixed protocol path as production.
        let custom = build_default_benchmark_url(
            "wss://custom.example.com/ws/v1",
            "my-model",
        )
        .expect("custom URL should build");
        assert_eq!(
            custom.as_str(),
            "wss://custom.example.com/api-ws/v1/realtime?model=my-model"
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
            protocol_dialect: Some(crate::audio::events::RealtimeProtocol::OpenAiConversation),
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
        config.protocol_dialect = Some(crate::audio::events::RealtimeProtocol::GeminiLive);
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
    fn missing_frontend_mode_has_a_name_independent_server_vad_default() {
        assert_eq!(
            RealtimeAudioMode::from_frontend(None, "deployment-without-hints").unwrap(),
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
            protocol_dialect: Some(crate::audio::events::RealtimeProtocol::DashscopeOmni),
        };
        assert!(build_session_update(&config)["session"]["turn_detection"].is_null());

        config.model = "qwen3.5-livetranslate-flash-realtime".to_string();
        config.audio_mode = RealtimeAudioMode::ServerVad;
        config.protocol_dialect = Some(crate::audio::events::RealtimeProtocol::DashscopeLivetranslate);
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
