//! Lossless, missing-key-only migration of the classic ASR translator.
use serde_json::Value;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::provider_manifest::authorize_provider_operation_for_model;

const LEGACY_ASR_MODELS: &[&str] = &[
    "whisper-1", "gpt-realtime-whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe",
    "qwen3-asr-flash-realtime", "qwen3-asr-flash", "qwen3-asr-flash-filetrans",
    "fun-asr-realtime", "fun-asr", "paraformer-realtime-v2", "paraformer-v2",
];

// Reject ambiguous bare references instead of using provider array order. A
// configured provider instance is enabled unless explicitly disabled by import.
pub(crate) fn resolve_exact_model_value<'a>(config: &'a Value, reference: &str) -> Option<(&'a Value, String)> {
    let (template_id, model_id) = match reference.split_once("::") {
        Some((template, model)) => (Some(template), model),
        None => (None, reference),
    };
    if model_id.is_empty() || model_id.trim() != model_id { return None; }
    let providers = config.get("providers")?.as_array()?;
    let mut matches = providers.iter().filter(|provider| {
        if provider.get("enabled").and_then(Value::as_bool) == Some(false) { return false; }
        if let Some(template) = template_id {
            return provider.get("templateId").and_then(Value::as_str) == Some(template);
        }
        provider.get("model").and_then(Value::as_str) == Some(model_id)
            || ["localModelCapabilityRegistry", "modelProtocolBindings"].iter().any(|key| {
                provider.get(*key).and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| {
                    item.get("modelId").and_then(Value::as_str) == Some(model_id)
                }))
            })
            || ["candidateModelGroups", "sceneModelAssignments"].iter().any(|key| {
                provider.get(*key).and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| {
                    item.get("modelIds").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(model_id)))
                }))
            })
    });
    let provider = matches.next()?;
    if matches.next().is_some() { return None; }
    Some((provider, model_id.to_string()))
}

fn legacy_asr_pipeline(provider: &Value, model_id: &str) -> bool {
    if !LEGACY_ASR_MODELS.contains(&model_id) { return false; }
    let openai = ["whisper-1", "gpt-realtime-whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"].contains(&model_id);
    provider.get("kind").and_then(Value::as_str) == Some(if openai { "openai-compatible" } else { "dashscope" })
}

fn operation_allowed(provider: &Value, model_id: &str, operation: &str) -> bool {
    serde_json::from_value::<ProviderDraftInput>(provider.clone()).ok().is_some_and(|provider| {
        authorize_provider_operation_for_model(&provider, model_id, operation)
            .is_ok_and(|authority| authority.is_some())
    })
}

pub(super) fn migrate_config(config: &mut Value) {
    let Some(devices) = config.get("devices").and_then(Value::as_object) else { return; };
    if devices.contains_key("primaryTextTranslationModelId") { return; }
    let legacy = devices.get("subtitleTranslationModelId").and_then(Value::as_str).unwrap_or("");
    let eligible = resolve_exact_model_value(config, legacy).is_some_and(|(provider, model)| {
        let text_capability = provider.get("localModelCapabilityRegistry").and_then(Value::as_array)
            .is_some_and(|entries| entries.iter().any(|entry| {
                entry.get("modelId").and_then(Value::as_str) == Some(model.as_str())
                    && entry.get("capabilities").and_then(Value::as_array)
                        .is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some("text-generation")))
            }));
        if !text_capability && !operation_allowed(provider, &model, "text-translation") { return false; }
        ["inboundVoiceModelId", "outboundVoiceModelId"].iter().any(|key| {
            let reference = devices.get(*key).and_then(Value::as_str).unwrap_or("");
            resolve_exact_model_value(config, reference).is_some_and(|(asr, model)| {
                legacy_asr_pipeline(asr, &model) || operation_allowed(asr, &model, "asr")
            })
        })
    });
    let value = if eligible { legacy.to_string() } else { String::new() };
    config["devices"]["primaryTextTranslationModelId"] = Value::String(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn legacy_config() -> Value {
        json!({
            "devices": {
                "inboundVoiceModelId": "legacy::qwen3-asr-flash-realtime",
                "outboundVoiceModelId": "legacy::qwen3.5-omni-flash-realtime",
                "subtitleTranslationMode": "secondary",
                "subtitleTranslationModelId": "legacy::translator"
            },
            "providers": [{
                "templateId": "legacy", "model": "qwen3-asr-flash-realtime", "kind": "dashscope",
                "localModelCapabilityRegistry": [{ "modelId": "translator", "capabilities": ["text-generation"] }],
                "authRef": {"reference": "unchanged-secret-reference"}
            }],
            "credentials": {"untouched": "value"}
        })
    }

    #[test]
    fn migration_copies_only_exact_legacy_asr_and_preserves_every_other_value() {
        let mut config = legacy_config();
        let before = config.clone();
        migrate_config(&mut config);
        assert_eq!(config["devices"]["primaryTextTranslationModelId"], "legacy::translator");
        let once = config.clone();
        migrate_config(&mut config);
        assert_eq!(config, once);
        config["devices"].as_object_mut().unwrap().remove("primaryTextTranslationModelId");
        assert_eq!(config, before);
    }

    #[test]
    fn explicit_empty_and_existing_primary_model_are_never_overwritten() {
        for primary in ["", "different::model"] {
            let mut config = legacy_config();
            config["devices"]["primaryTextTranslationModelId"] = json!(primary);
            let before = config.clone();
            migrate_config(&mut config);
            assert_eq!(config, before);
        }
    }

    #[test]
    fn migration_rejects_disabled_missing_nontext_and_name_only_models() {
        for case in 0..6 {
            let mut config = legacy_config();
            match case {
                0 => config["providers"][0]["enabled"] = json!(false),
                1 => config["devices"]["subtitleTranslationModelId"] = json!("missing::translator"),
                2 => config["providers"][0]["localModelCapabilityRegistry"][0]["capabilities"] = json!(["speech-to-text"]),
                3 => config["devices"]["inboundVoiceModelId"] = json!("legacy::qwen3-asr-spoof"),
                4 => config["devices"]["inboundVoiceModelId"] = json!("legacy::qwen3.5-omni-flash-realtime"),
                _ => config["providers"] = json!([]),
            }
            migrate_config(&mut config);
            assert_eq!(config["devices"]["primaryTextTranslationModelId"], "", "case {case}");
            assert_eq!(config["devices"]["subtitleTranslationModelId"], if case == 1 { "missing::translator" } else { "legacy::translator" });
        }
    }

    #[test]
    fn bare_model_reference_must_resolve_uniquely() {
        let mut config = legacy_config();
        config["devices"]["subtitleTranslationModelId"] = json!("translator");
        let duplicate = config["providers"][0].clone();
        config["providers"].as_array_mut().unwrap().push(duplicate);
        migrate_config(&mut config);
        assert_eq!(config["devices"]["primaryTextTranslationModelId"], "");
    }
}
