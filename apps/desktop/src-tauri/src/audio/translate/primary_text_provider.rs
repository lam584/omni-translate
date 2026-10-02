use serde_json::Value;
use crate::provider::contracts::ProviderDraftInput;

fn primary_text_model_error(reference: &str, model: Option<&str>, provider: Option<&str>, detail: &str) -> String {
    let context = serde_json::json!({
        "modelRole": "primary-text", "modelReference": reference,
        "modelId": model, "providerId": provider,
    });
    super::super::omni::session_errors::with_error_markers(
        &format!("{detail} | modelContext: {context}"),
        super::super::omni::session_errors::SessionErrorCode::ModelReferenceInvalid,
    )
}

// This is only an endpoint projection for a runtime copy whose exact text
// model has already been admitted. It cannot grant a voice/text operation or
// repair custom/insecure URLs. Keep the shared persisted audio endpoint intact.
fn dashscope_shared_websocket_text_base_url(base_url: &str) -> Option<String> {
    let mut endpoint = url::Url::parse(base_url).ok()?;
    if !matches!(endpoint.scheme(), "https" | "wss") || !endpoint.username().is_empty()
        || endpoint.password().is_some() || endpoint.port().is_some()
        || endpoint.query().is_some() || endpoint.fragment().is_some() {
        return None;
    }
    let host = endpoint.host_str()?;
    let official_host = matches!(host, "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com")
        || [".cn-beijing.maas.aliyuncs.com", ".ap-southeast-1.maas.aliyuncs.com"].iter().any(|suffix| {
            host.strip_suffix(suffix).is_some_and(|label| {
                !label.is_empty() && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        });
    if !official_host || ![
        "", "/api/v1", "/compatible-mode/v1", "/api-ws/v1/realtime", "/api-ws/v1/inference",
    ].contains(&endpoint.path().trim_end_matches('/')) {
        return None;
    }
    endpoint.set_scheme("https").ok()?;
    endpoint.set_path("/compatible-mode/v1");
    Some(endpoint.to_string())
}

/// Resolve only the independent primary reference. Admission checks happen
/// before both startup and every hot reload; the gateway rechecks the actual
/// operation at its provider-access boundary. Audio/native-translate authority
/// is never a substitute for a text-translation binding.
pub(crate) fn resolve_primary_text_provider(config: &Value) -> Result<ProviderDraftInput, String> {
    let reference = config.pointer("/devices/primaryTextTranslationModelId")
        .and_then(Value::as_str).unwrap_or("");
    let (value, model_id) = crate::storage::repository::resolve_exact_model_value(config, reference)
        .ok_or_else(|| primary_text_model_error(reference, None, None,
            "primary text translation requires one enabled, exact model reference"))?;
    let mut provider: ProviderDraftInput = serde_json::from_value(value.clone())
        .map_err(|error| primary_text_model_error(reference, Some(&model_id), None, &error.to_string()))?;
    provider.model = model_id;
    let error = |detail: &str| primary_text_model_error(reference, Some(&provider.model), Some(&provider.provider_id), detail);
    match crate::provider::provider_manifest::authorize_provider_operation_for_model(
        &provider, &provider.model, "text-translation",
    ).map_err(|detail| error(&detail))? {
        Some(authority) => {
            if authority.adapter_id != "openai-compatible-http" {
                return Err(error("text-translation requires an executable HTTP text adapter"));
            }
            Ok(authority.provider_for_connection(&provider))
        }
        // Legacy DashScope HTTP is admitted by the same exact text-generation
        // declaration used by its gateway adapter, not the voice authorizer.
        None if provider.kind == "dashscope" => {
            let voice_profiles = crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(&provider.model)
                .map_err(|detail| error(&detail.to_string()))?;
            let text = provider.local_model_capability_registry.iter().any(|entry| {
                entry.model_id == provider.model && entry.capabilities.iter().any(|cap| cap == "text-generation")
            });
            if !text || !voice_profiles.is_empty() || !matches!(provider.transport.as_str(), "http" | "streaming-http" | "websocket") {
                return Err(error("model is not admitted for DashScope HTTP text-translation"));
            }
            // A text-only worker executes HTTP even if its shared provider uses
            // WebSocket for a separate audio model. Never invoke a voice route.
            if provider.transport == "websocket" {
                if let Some(base_url) = dashscope_shared_websocket_text_base_url(&provider.base_url) {
                    provider.base_url = base_url;
                }
            }
            provider.transport = if provider.stream_enabled { "streaming-http" } else { "http" }.to_string();
            Ok(provider)
        }
        None => Err(error("model has no executable text-translation binding")),
    }
}
