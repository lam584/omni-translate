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
