use reqwest::blocking::Response;
use serde_json::Value;

use super::super::contracts::{
    ProviderDraftInput, ProviderModelCatalogRuntime, ProviderModelRuntime, ProviderRuntimeError,
};
use super::{auth, time, transport};

/// Owns model-catalog endpoint resolution, HTTP transport, and response
/// normalization.  Keeping this state-free service separate prevents the
/// application-facing gateway from accumulating protocol details.
#[derive(Default)]
pub(crate) struct ModelCatalogService;

impl ModelCatalogService {
    pub(crate) fn fetch(&self, provider: ProviderDraftInput) -> ProviderModelCatalogRuntime {
        let endpoint = match resolve_models_endpoint(&provider) {
            Ok(endpoint) => endpoint,
            Err(error) => return failed_catalog(provider.provider_id, String::new(), error),
        };

        let result = (|| -> Result<Vec<ProviderModelRuntime>, ProviderRuntimeError> {
            let client = transport::build_client(provider.timeout_ms)?;
            let response = client
                .get(endpoint.clone())
                .headers(auth::build_reqwest_headers(&provider)?)
                .send()
                .map_err(transport::normalize_transport_error)?;
            parse_response(&provider, response)
        })();

        match result {
            Ok(models) => ProviderModelCatalogRuntime {
                provider_id: provider.provider_id,
                endpoint,
                fetched_at: time::now_unix_seconds_marker(),
                models,
                error: None,
            },
            Err(error) => failed_catalog(provider.provider_id, endpoint, error),
        }
    }
}

fn parse_response(
    provider: &ProviderDraftInput,
    response: Response,
) -> Result<Vec<ProviderModelRuntime>, ProviderRuntimeError> {
    if !response.status().is_success() {
        return Err(match provider.kind.as_str() {
            "dashscope" => transport::parse_dashscope_error(response),
            _ => transport::parse_openai_error(response),
        });
    }
    let value: Value = response.json().map_err(transport::normalize_transport_error)?;
    parse_model_catalog_response(&value)
}

fn failed_catalog(
    provider_id: String,
    endpoint: String,
    error: ProviderRuntimeError,
) -> ProviderModelCatalogRuntime {
    ProviderModelCatalogRuntime {
        provider_id,
        endpoint,
        fetched_at: time::now_unix_seconds_marker(),
        models: Vec::new(),
        error: Some(error),
    }
}

pub(crate) fn resolve_models_endpoint(
    provider: &ProviderDraftInput,
) -> Result<String, ProviderRuntimeError> {
    match provider.kind.as_str() {
        "dashscope" => transport::join_url(
            &normalize_dashscope_compatible_base_url(&provider.base_url),
            "models",
        ),
        kind if is_openai_compatible_kind(kind) => transport::join_url(
            &normalize_openai_compatible_base_url(&provider.base_url),
            "models",
        ),
        _ => Err(ProviderRuntimeError::new(
            "request.invalid",
            "当前 Provider 不支持拉取模型目录。",
        )),
    }
}

pub(super) fn normalize_openai_compatible_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');

    if trimmed.ends_with("/models") {
        return trimmed
            .trim_end_matches("/models")
            .trim_end_matches('/')
            .to_string();
    }

    trimmed.to_string()
}

pub(super) fn normalize_dashscope_compatible_base_url(base_url: &str) -> String {
    if base_url.contains("/compatible-mode/v1") {
        return base_url.trim_end_matches('/').to_string();
    }

    if base_url.contains("/api/v1") {
        return base_url
            .replace("/api/v1", "/compatible-mode/v1")
            .trim_end_matches('/')
            .to_string();
    }

    format!("{}/compatible-mode/v1", base_url.trim_end_matches('/'))
}

pub(super) fn parse_model_catalog_response(
    value: &Value,
) -> Result<Vec<ProviderModelRuntime>, ProviderRuntimeError> {
    let entries = value
        .pointer("/data")
        .and_then(Value::as_array)
        .or_else(|| value.pointer("/models").and_then(Value::as_array))
        .ok_or_else(|| {
            ProviderRuntimeError::new("response.unparseable", "模型目录响应中缺少 data 数组。")
        })?;

    let models = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }

            Some(ProviderModelRuntime {
                id: id.to_string(),
                display_name: entry
                    .get("display_name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(id)
                    .to_string(),
                owned_by: entry
                    .get("owned_by")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                created_at: entry.get("created").and_then(Value::as_u64),
                capabilities: derive_model_capabilities(id),
            })
        })
        .collect::<Vec<_>>();

    if models.is_empty() {
        return Err(ProviderRuntimeError::new(
            "response.unparseable",
            "模型目录响应中没有可用模型条目。",
        ));
    }

    Ok(models)
}

pub(crate) fn derive_model_capabilities(model_id: &str) -> Vec<String> {
    let normalized = model_id.to_ascii_lowercase();
    let mut capabilities: Vec<String> = Vec::new();

    if is_stt_model_name(&normalized) {
        push_capability(&mut capabilities, "speech-to-text");
    }

    if is_tts_model_name(&normalized) {
        push_capability(&mut capabilities, "text-to-speech");
    }

    if is_s2s_model_name(&normalized) {
        push_capability(&mut capabilities, "speech-to-speech");
    }

    if is_text_generation_model_name(&normalized) && capabilities.is_empty() {
        push_capability(&mut capabilities, "text-generation");
    }

    capabilities
}

fn is_openai_compatible_kind(kind: &str) -> bool {
    matches!(
        kind,
        "openai-compatible" | "openrouter" | "ollama" | "lmstudio" | "nvidia"
    )
}

fn push_capability(capabilities: &mut Vec<String>, capability: &str) {
    if !capabilities.iter().any(|item| item == capability) {
        capabilities.push(capability.to_string());
    }
}

fn is_stt_model_name(normalized: &str) -> bool {
    normalized.contains("asr")
        || normalized.contains("transcribe")
        || normalized.contains("whisper")
        || normalized.contains("parakeet")
        || normalized.contains("chirp")
        || normalized.contains("voxtral")
        || normalized.contains("sensevoice")
        || normalized.contains("paraformer")
        || normalized.contains("gummy")
        || normalized.contains("omni")
        || normalized.contains("livetranslate")
        || normalized.contains("realtime")
        || (normalized.contains("gemini") && (normalized.contains("live") || normalized.contains("native-audio")))
}

fn is_tts_model_name(normalized: &str) -> bool {
    normalized.contains("tts")
        || normalized.contains("speech")
        || normalized.contains("audio")
        || normalized.contains("cosyvoice")
        || normalized.contains("sambert")
        || normalized.contains("magpie")
        || normalized.contains("omni")
        || normalized.contains("gpt-realtime")
        || (normalized.contains("gemini") && (normalized.contains("live") || normalized.contains("native-audio")))
}

fn is_s2s_model_name(normalized: &str) -> bool {
    normalized.contains("omni")
        || normalized.contains("livetranslate")
        || normalized.contains("gpt-realtime")
        || normalized.contains("gpt-4o-realtime")
        || normalized.contains("gpt-audio")
        || (normalized.contains("gemini") && (normalized.contains("live") || normalized.contains("native-audio")))
}

fn is_text_generation_model_name(normalized: &str) -> bool {
    normalized.contains("chat")
        || normalized.contains("completion")
        || normalized.contains("qwen")
        || normalized.contains("gpt")
        || normalized.contains("deepseek")
        || normalized.contains("claude")
        || normalized.contains("gemini")
        || normalized.contains("glm")
        || normalized.contains("llama")
        || normalized.contains("mistral")
        || normalized.contains("yi")
        || normalized.contains("nemotron")
        || normalized.contains("local")
        || normalized.contains("ollama")
        || normalized.contains("lmstudio")
}
