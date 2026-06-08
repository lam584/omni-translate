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
        kind if is_openai_compatible_kind(kind) => join_url(
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
