use reqwest::blocking::Response;
use serde_json::Value;

use crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection;

use super::super::contracts::{
    ProviderDraftInput, ProviderModelCatalogRuntime, ProviderModelRuntime, ProviderRuntimeError,
};
use super::{auth, time, transport};

/// Owns model-catalog endpoint resolution, HTTP transport, and response
/// normalization.  Keeping this state-free service separate prevents the
/// application-facing gateway from accumulating protocol details.
#[derive(Clone, Default)]
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
    parse_model_catalog_response(provider, &value)
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
    provider: &ProviderDraftInput,
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
                capabilities: derive_catalog_model_capabilities(provider, id, entry),
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

fn derive_catalog_model_capabilities(
    provider: &ProviderDraftInput,
    model_id: &str,
    entry: &Value,
) -> Vec<String> {
    if provider.kind == "dashscope" {
        return derive_bailian_profile_capabilities(model_id);
    }
    if let Ok(Some(capabilities)) =
        crate::provider::provider_manifest::manifest_model_capabilities(provider, model_id)
    {
        return capabilities;
    }
    entry
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn derive_bailian_profile_capabilities(model_id: &str) -> Vec<String> {
    let Ok(profiles) = lookup_model_protocol_profiles_for_inspection(model_id) else {
        return Vec::new();
    };
    let mut capabilities = Vec::new();

    for operation in profiles
        .iter()
        .flat_map(|profile| profile.operations.iter())
    {
        match operation.as_str() {
            "asr" => push_capability(&mut capabilities, "speech-to-text"),
            "tts" => push_capability(&mut capabilities, "text-to-speech"),
            "native_translate" | "dialogue" => {
                push_capability(&mut capabilities, "speech-to-speech");
            }
            _ => {}
        }
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_model_catalog_response;
    use crate::provider::contracts::ProviderDraftInput;

    fn provider(kind: &str) -> ProviderDraftInput {
        serde_json::from_value(json!({
            "templateId": "template-test-catalog",
            "providerId": "provider-test-catalog",
            "kind": kind,
            "displayName": "Catalog fixture",
            "model": "fixture-model",
            "baseUrl": "https://example.test/v1",
            "transport": "http",
            "authRef": {
                "kind": "none",
                "reference": "none",
                "headerName": "Authorization",
                "scheme": "none"
            },
            "streamEnabled": false,
            "timeoutMs": 1000,
            "systemPromptTemplate": ""
        }))
        .expect("catalog provider fixture")
    }

    fn dashscope_capabilities(model_id: &str) -> Vec<String> {
        let catalog = parse_model_catalog_response(
            &provider("dashscope"),
            &json!({ "data": [{ "id": model_id }] }),
        )
        .expect("catalog fixture should parse");
        catalog[0].capabilities.clone()
    }

    #[test]
    fn dashscope_asr_profile_does_not_inherit_tts_or_s2s_from_its_name() {
        assert_eq!(
            dashscope_capabilities("qwen3-asr-flash-realtime"),
            vec!["speech-to-text"]
        );
        assert_eq!(
            dashscope_capabilities("qwen-audio-3.0-asr-flash-streaming"),
            vec!["speech-to-text"]
        );
    }

    #[test]
    fn dashscope_tts_profile_does_not_inherit_stt_or_s2s_from_realtime() {
        assert_eq!(
            dashscope_capabilities("qwen3-tts-flash-realtime"),
            vec!["text-to-speech"]
        );
    }

    #[test]
    fn unknown_dashscope_audio_realtime_model_has_no_guessed_capabilities() {
        assert!(dashscope_capabilities("unknown-audio-realtime-model").is_empty());
    }

    #[test]
    fn dashscope_native_translate_and_dialogue_profiles_map_only_to_s2s() {
        assert_eq!(
            dashscope_capabilities("qwen3.5-livetranslate-flash-realtime"),
            vec!["speech-to-speech"]
        );
        assert_eq!(
            dashscope_capabilities("qwen-audio-3.0-realtime-plus"),
            vec!["speech-to-speech"]
        );
    }

    #[test]
    fn non_dashscope_catalog_uses_declared_capabilities_not_model_names() {
        let provider = provider("openai-compatible");
        let catalog = parse_model_catalog_response(
            &provider,
            &json!({ "data": [{
                "id": "arbitrary-model-id",
                "capabilities": ["speech-to-text"]
            }] }),
        )
        .expect("catalog fixture should parse");
        assert_eq!(catalog[0].capabilities, vec!["speech-to-text"]);

        let untyped = parse_model_catalog_response(
            &provider,
            &json!({ "data": [{ "id": "openai/gpt-audio" }] }),
        )
        .expect("untyped catalog fixture should parse");
        assert!(untyped[0].capabilities.is_empty());
    }
}
