use serde::{Deserialize, Serialize};

fn default_provider_temperature() -> f64 {
    0.2
}

fn default_provider_max_output_tokens() -> u64 {
    256
}

fn default_provider_response_modalities() -> Vec<String> {
    vec!["text".to_string()]
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthRefInput {
    pub kind: String,
    pub reference: String,
    pub header_name: String,
    pub scheme: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCustomHeaderInput {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSceneModelAssignmentInput {
    #[allow(dead_code)]
    pub scenario: String,
    pub model_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ProviderModelCapabilityRegistryEntryInput {
    pub id: String,
    pub model_id: String,
    pub capabilities: Vec<String>,
    pub realtime_audio_mode: Option<String>,
    #[serde(default)]
    pub interaction_capabilities: Vec<String>,
    #[serde(default)]
    pub api_modes: Vec<String>,
    pub released_at: Option<String>,
    pub source: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ProviderModelCatalogCacheItemInput {
    pub id: String,
    pub display_name: String,
    pub owned_by: Option<String>,
    pub created_at: Option<u64>,
    pub capabilities: Vec<String>,
    pub provider_template_id: String,
    pub provider_template_name: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ProviderModelCatalogCacheInput {
    #[serde(default)]
    pub models: Vec<ProviderModelCatalogCacheItemInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraftInput {
    pub template_id: String,
    pub provider_id: String,
    pub kind: String,
    pub display_name: String,
    pub model: String,
    pub base_url: String,
    pub transport: String,
    pub auth_ref: ProviderAuthRefInput,
    pub region: Option<String>,
    pub stream_enabled: bool,
    pub timeout_ms: u64,
    pub system_prompt_template: String,
    #[serde(default = "default_provider_temperature")]
    pub temperature: f64,
    #[serde(default = "default_provider_max_output_tokens")]
    pub max_output_tokens: u64,
    #[serde(default = "default_provider_response_modalities")]
    pub response_modalities: Vec<String>,
    #[serde(default)]
    pub custom_headers: Vec<ProviderCustomHeaderInput>,
    #[serde(default)]
    pub scene_model_assignments: Vec<ProviderSceneModelAssignmentInput>,
    #[allow(dead_code)]
    #[serde(default)]
    pub local_model_capability_registry: Vec<ProviderModelCapabilityRegistryEntryInput>,
    #[allow(dead_code)]
    #[serde(default)]
    pub model_catalog_cache: ProviderModelCatalogCacheInput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeError {
    pub code: String,
    pub message: String,
    pub retriable: bool,
    pub http_status: Option<u16>,
    pub provider_code: Option<String>,
    pub suggestion: Option<String>,
}

impl ProviderRuntimeError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retriable: false,
            http_status: None,
            provider_code: None,
            suggestion: None,
        }
    }

    pub fn with_http_status(mut self, http_status: u16) -> Self {
        self.http_status = Some(http_status);
        self
    }

    pub fn with_provider_code(mut self, provider_code: impl Into<String>) -> Self {
        self.provider_code = Some(provider_code.into());
        self
    }

    pub fn with_suggestion(mut self, suggestion: impl Into<String>) -> Self {
        self.suggestion = Some(suggestion.into());
        self
    }

    pub fn retriable(mut self, retriable: bool) -> Self {
        self.retriable = retriable;
        self
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRoutingDecision {
    pub subtitle_priority: String,
    pub speech_disposition: String,
    pub rationale: String,
}

impl ProviderRoutingDecision {
    pub fn for_verdict(verdict: &str, latency_ms: u64, fallback_applied: bool) -> Self {
        match verdict {
            "available" => Self {
                subtitle_priority: "balanced".to_string(),
                speech_disposition: "ready".to_string(),
                rationale: if fallback_applied {
                    "已做传输回退，但当前延迟和结构稳定性仍满足实时要求。".to_string()
                } else {
                    format!("当前延迟 {} ms，允许字幕与译音并行。", latency_ms)
                },
            },
            "realtime-risk" => Self {
                subtitle_priority: "subtitle-first".to_string(),
                speech_disposition: "deferred".to_string(),
                rationale: format!(
                    "当前延迟 {} ms 超过预算，优先保证字幕不断流，译音进入 deferred。",
                    latency_ms
                ),
            },
            _ => Self {
                subtitle_priority: "subtitle-first".to_string(),
                speech_disposition: "queued".to_string(),
                rationale: "当前 Provider 不可用或响应结构不稳定，禁止进入实时主链路。".to_string(),
            },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeCheckRuntime {
    pub id: String,
    pub key: String,
    pub label: String,
    pub status: String,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeProfileRuntime {
    pub id: String,
    pub template_id: String,
    pub provider_id: String,
    pub verdict: String,
    pub checked_at: String,
    pub measured_latency_ms: u64,
    pub latency_budget_ms: u64,
    pub stream_supported: bool,
    pub error_shape_stable: bool,
    pub response_shape_stable: bool,
    pub transport_requested: String,
    pub transport_effective: String,
    pub fallback_applied: bool,
    pub checks: Vec<ProviderProbeCheckRuntime>,
    pub guidance: Vec<String>,
    pub routing_decision: ProviderRoutingDecision,
    pub error: Option<ProviderRuntimeError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStreamEventRecord {
    pub event_type: String,
    pub summary: String,
    pub segment_id: Option<String>,
    pub text_delta: Option<String>,
    pub text: Option<String>,
    pub audio_chunk_ref: Option<String>,
}

impl ProviderStreamEventRecord {
    pub fn new(event_type: &str, summary: &str) -> Self {
        Self {
            event_type: event_type.to_string(),
            summary: summary.to_string(),
            segment_id: None,
            text_delta: None,
            text: None,
            audio_chunk_ref: None,
        }
    }

    pub fn with_text(event_type: &str, summary: &str, segment_id: &str, text: String) -> Self {
        Self {
            event_type: event_type.to_string(),
            summary: summary.to_string(),
            segment_id: Some(segment_id.to_string()),
            text_delta: None,
            text: Some(text),
            audio_chunk_ref: None,
        }
    }

    pub fn with_delta(
        event_type: &str,
        summary: String,
        segment_id: &str,
        text_delta: String,
    ) -> Self {
        Self {
            event_type: event_type.to_string(),
            summary,
            segment_id: Some(segment_id.to_string()),
            text_delta: Some(text_delta),
            text: None,
            audio_chunk_ref: None,
        }
    }

    pub fn with_audio(
        event_type: &str,
        summary: &str,
        segment_id: Option<&str>,
        audio_chunk_ref: String,
    ) -> Self {
        Self {
            event_type: event_type.to_string(),
            summary: summary.to_string(),
            segment_id: segment_id.map(|s| s.to_string()),
            text_delta: None,
            text: None,
            audio_chunk_ref: Some(audio_chunk_ref),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSmokeResult {
    pub request_id: String,
    pub provider_id: String,
    pub status: String,
    pub transport_requested: String,
    pub transport_effective: String,
    pub fallback_applied: bool,
    pub stream_observed: bool,
    pub duration_ms: u64,
    pub first_event_latency_ms: Option<u64>,
    pub transcript: String,
    pub source_language: String,
    pub target_language: String,
    pub event_log: Vec<ProviderStreamEventRecord>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub audio_seconds: Option<f64>,
    pub routing_decision: ProviderRoutingDecision,
    pub error: Option<ProviderRuntimeError>,
}

impl ProviderSmokeResult {
    #[allow(clippy::too_many_arguments)]
    pub fn new_success(
        request_id: String,
        provider_id: String,
        transport_effective: String,
        source_language: String,
        target_language: String,
        event_log: Vec<ProviderStreamEventRecord>,
        first_event_latency_ms: Option<u64>,
        transcript: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> Self {
        Self {
            request_id,
            provider_id,
            status: "completed".to_string(),
            transport_requested: transport_effective.clone(),
            transport_effective,
            fallback_applied: false,
            stream_observed: false,
            duration_ms: 0,
            first_event_latency_ms,
            transcript,
            source_language,
            target_language,
            event_log,
            input_tokens,
            output_tokens,
            audio_seconds: None,
            routing_decision: ProviderRoutingDecision::for_verdict("available", 0, false),
            error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelRuntime {
    pub id: String,
    pub display_name: String,
    pub owned_by: Option<String>,
    pub created_at: Option<u64>,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCatalogRuntime {
    pub provider_id: String,
    pub endpoint: String,
    pub fetched_at: String,
    pub models: Vec<ProviderModelRuntime>,
    pub error: Option<ProviderRuntimeError>,
}

#[derive(Clone, Debug)]
pub struct TtsAudioChunk {
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub pcm_i16: Vec<i16>,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct TtsSynthesisResult {
    pub request_id: String,
    pub provider_id: String,
    pub model: String,
    pub voice_preset_id: String,
    pub duration_ms: u64,
    pub audio_seconds: f64,
    pub audio: TtsAudioChunk,
    pub event_log: Vec<ProviderStreamEventRecord>,
}
