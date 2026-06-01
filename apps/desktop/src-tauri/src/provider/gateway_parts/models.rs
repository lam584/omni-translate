use serde_json::Value;

use super::super::contracts::{ProviderDraftInput, ProviderModelRuntime, ProviderRuntimeError};
use super::transport::join_url;

pub(super) fn resolve_models_endpoint(
    provider: &ProviderDraftInput,
) -> Result<String, ProviderRuntimeError> {
    match provider.kind.as_str() {
        "dashscope" => join_url(
            &normalize_dashscope_compatible_base_url(&provider.base_url),
            "models",
        ),
        "openai-compatible" => join_url(
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

pub(super) fn derive_model_capabilities(model_id: &str) -> Vec<String> {
    let normalized = model_id.to_ascii_lowercase();
    let mut capabilities = vec!["text-generation".to_string()];

    if normalized.contains("realtime") || normalized.contains("live") {
        capabilities.push("speech-to-speech".to_string());
    }

    if normalized.contains("tts")
        || normalized.contains("speech")
        || normalized.contains("audio")
        || normalized.contains("cosyvoice")
        || normalized.contains("sambert")
    {
        capabilities.push("text-to-speech".to_string());
    }

    if normalized.contains("asr")
        || normalized.contains("sensevoice")
        || normalized.contains("paraformer")
        || normalized.contains("gummy")
        || normalized.contains("omni")
        || normalized.contains("livetranslate")
    {
        capabilities.push("speech-to-text".to_string());
    }

    if normalized.contains("omni") || normalized.contains("livetranslate") {
        capabilities.push("speech-to-speech".to_string());
    }

    capabilities
}
