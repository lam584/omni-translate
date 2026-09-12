use super::*;

pub(crate) fn resolve_model_provider_from_config(
    app: &AppHandle,
    config: &Value,
    composite_model_id: &str,
    purpose: &str,
) -> Option<ProviderDraftInput> {
    let linked_count = config
        .get("linkedProviders")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let _ = append_diagnostics_log(
        app,
        "audio",
        "debug",
        format!(
            "resolve_model_provider_from_config: purpose={purpose} composite_model_id={composite_model_id} linkedProviders={linked_count}"
        ),
        None,
        None,
        None,
    );

    let resolved = resolve_model_provider_from_config_value(config, composite_model_id);
    match &resolved {
        Some(provider) => {
            let _ = append_diagnostics_log(
                app,
                "audio",
                "info",
                format!(
                    "resolve_model_provider_from_config: purpose={purpose} provider_id={} kind={} model={} base_url={} template_id={}",
                    provider.provider_id,
                    provider.kind,
                    provider.model,
                    provider.base_url,
                    provider.template_id
                ),
                None,
                None,
                None,
            );
        }
        None => {
            let target_template = composite_model_id
                .split_once("::")
                .map(|(template_id, _)| template_id)
                .unwrap_or("(main-provider)");
            let _ = append_diagnostics_log(
                app,
                "audio",
                "warning",
                format!(
                    "resolve_model_provider_from_config: purpose={purpose} no provider matched target_template={target_template} composite_model_id={composite_model_id} linkedProviders={linked_count}"
                ),
                None,
                None,
                None,
            );
        }
    }
    resolved
}

/// Resolves a `templateId::modelId` composite against the provider array,
/// overriding the matched provider's model. Shared by the route-config and
/// speech-config resolvers so the composite lookup lives in one place.
pub(crate) fn resolve_composite_template_provider(
    providers: &[Value],
    template_id: &str,
    model_id: &str,
) -> Option<ProviderDraftInput> {
    for provider_value in providers {
        let parsed: Option<ProviderDraftInput> =
            serde_json::from_value(provider_value.clone()).ok();
        if let Some(mut provider) = parsed {
            if provider.template_id == template_id {
                provider.model = model_id.to_string();
                return Some(provider);
            }
        }
    }
    None
}

pub(crate) fn resolve_model_provider_from_config_value(
    config: &Value,
    composite_model_id: &str,
) -> Option<ProviderDraftInput> {
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some((template_id, model_id)) = composite_model_id.split_once("::") {
        return resolve_composite_template_provider(&providers, template_id, model_id);
    }

    // Bare model name: search all providers equally.
    for provider_value in &providers {
        let parsed: Option<ProviderDraftInput> =
            serde_json::from_value(provider_value.clone()).ok();
        if let Some(provider) = parsed {
            if provider.model == composite_model_id {
                return Some(provider);
            }
            if provider
                .scene_model_assignments
                .iter()
                .any(|a| a.model_ids.iter().any(|m| m == composite_model_id))
            {
                let mut p = provider;
                p.model = composite_model_id.to_string();
                return Some(p);
            }
            if is_omni_route_model(&provider, composite_model_id)
                && is_dashscope_provider(&provider)
            {
                let mut p = provider;
                p.model = composite_model_id.to_string();
                return Some(p);
            }
        }
    }

    None
}
