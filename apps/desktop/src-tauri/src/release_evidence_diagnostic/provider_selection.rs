use serde_json::Value;

use crate::provider::contracts::ProviderDraftInput;

pub(super) fn select_provider(
    config: &Value,
    requested_provider_id: Option<&str>,
) -> Result<(Value, ProviderDraftInput), String> {
    if let Some(provider_id) = requested_provider_id {
        return select_provider_by_id(config, provider_id);
    }
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "persisted configuration has no providers array".to_string())?;
    let active_template = config
        .get("activeProviderTemplateId")
        .and_then(Value::as_str);
    let selected = active_template
        .and_then(|template| {
            providers.iter().find(|provider| {
                provider.get("templateId").and_then(Value::as_str) == Some(template)
            })
        })
        .or_else(|| providers.first())
        .ok_or_else(|| "persisted configuration contains no provider".to_string())?;
    parse_provider(selected.clone())
}

pub(super) fn select_provider_by_id(
    config: &Value,
    provider_id: &str,
) -> Result<(Value, ProviderDraftInput), String> {
    let matches = config
        .get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers.iter().filter(|provider| {
                provider.get("providerId").and_then(Value::as_str) == Some(provider_id)
            }).collect::<Vec<_>>()
        })
        .ok_or_else(|| "persisted configuration has no providers array".to_string())?;
    if matches.len() != 1 {
        return Err(format!(
            "persisted provider '{provider_id}' must exist exactly once; found {} entries",
            matches.len()
        ));
    }
    let selected = matches[0];
    parse_provider(selected.clone())
}

fn parse_provider(value: Value) -> Result<(Value, ProviderDraftInput), String> {
    let provider: ProviderDraftInput = serde_json::from_value(value.clone())
        .map_err(|error| format!("persisted provider contract is invalid: {error}"))?;
    if provider.auth_ref.kind != "credential-ref"
        || !provider.auth_ref.reference.starts_with("credential://")
    {
        return Err("release provider must use a credential:// credential-ref".to_string());
    }
    Ok((value, provider))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_duplicate_exact_provider_ids_before_probe() {
        let provider = json!({
            "templateId": "template-dashscope-realtime",
            "providerId": "provider-dashscope",
            "kind": "dashscope",
            "displayName": "DashScope",
            "model": "qwen3.5-omni-flash-realtime",
            "baseUrl": "https://dashscope.aliyuncs.com",
            "transport": "websocket",
            "authRef": {
                "kind": "credential-ref",
                "reference": "credential://provider/dashscope/default",
                "headerName": "Authorization",
                "scheme": "bearer"
            },
            "region": null,
            "streamEnabled": true,
            "timeoutMs": 1000,
            "systemPromptTemplate": ""
        });
        let config = json!({ "providers": [provider.clone(), provider] });
        assert!(select_provider_by_id(&config, "provider-dashscope")
            .unwrap_err()
            .contains("exactly once"));
    }
}
