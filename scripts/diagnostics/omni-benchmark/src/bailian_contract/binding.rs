use super::*;
use serde::Deserialize;

/// Explicit opt-in for an unknown deployment ID; never rewrites catalog identities.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProtocolBinding {
    pub profile_id: String,
    pub profile_version: u64,
    pub region: String,
}

pub(crate) fn authorize_livetranslate(model: &str, base_url: &str, binding: Option<&ProtocolBinding>) -> Result<LiveTranslateAuthority, String> {
    if binding.is_none() { return authorize_enabled_livetranslate(model, base_url); }
    let registry: Value = serde_json::from_str(REGISTRY).map_err(|e| e.to_string())?;
    authorize_from_registry_binding(&registry, model, base_url, binding)
}

pub(super) fn select_profile<'a>(registry: &'a Value, model: &str, base_url: &str, binding: &ProtocolBinding) -> Result<&'a Value, String> {
    let invalid = || "model_protocol.not_authorized: invalid explicit profile binding".to_string();
    if model.is_empty() || model.trim() != model { return Err(invalid()); }
    let catalog: Value = serde_json::from_str(include_str!("../../../../../contracts/provider-manifests.compiled.v1.json")).map_err(|e| e.to_string())?;
    let manifests = catalog["manifests"].as_array().ok_or_else(invalid)?;
    for manifest in manifests {
        let models = manifest["models"].as_array().ok_or_else(invalid)?;
        if models.iter().any(|entry| entry["id"].as_str() == Some(model)) { return Err(invalid()); }
    }
    let profiles = registry["profiles"].as_array().ok_or_else(invalid)?;
    if profiles.iter().any(|p| p["exactModelIds"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(model)))) { return Err(invalid()); }
    let profile = profiles.iter().find(|p| p["profileId"].as_str() == Some(&binding.profile_id)).ok_or_else(invalid)?;
    if !matches!(binding.profile_id.as_str(), PROFILE_ID | PROFILE_ID_V2)
        || profile["profileVersion"].as_u64() != Some(binding.profile_version)
        || !profile["regions"].as_array().is_some_and(|regions| regions.iter().any(|r| r.as_str() == Some(&binding.region))) { return Err(invalid()); }
    let request = base_url.into_client_request().map_err(|e| e.to_string())?;
    let host = request.uri().host().ok_or_else(invalid)?;
    let policy = registry["endpointHostPolicies"].as_array().and_then(|policies| policies.iter().find(|p| p["region"].as_str() == Some(&binding.region))).ok_or_else(invalid)?;
    // Apply the existing endpoint authorizer to this region alone, not a union of regions.
    let mut regional = registry.clone();
    regional["endpointHostPolicies"] = serde_json::json!([policy]);
    authorize_endpoint(&regional, base_url, profile)
        .map_err(|e| format!("{e}: region {} host {host}", binding.region))?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    const URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
    fn binding(profile_id: &str) -> ProtocolBinding {
        ProtocolBinding { profile_id: profile_id.into(), profile_version: 1, region: "cn-beijing".into() }
    }
    #[test]
    fn workspace_requirement_applies_to_known_and_custom_without_changing_v1_allowlist() {
        for (region, generic) in [("cn-beijing", "dashscope.aliyuncs.com"), ("ap-southeast-1", "dashscope-intl.aliyuncs.com")] {
            let generic_url = format!("wss://{generic}/api-ws/v1/realtime");
            let workspace_url = format!("wss://workspace-test.{region}.maas.aliyuncs.com/api-ws/v1/realtime");
            let b = ProtocolBinding { region: region.into(), ..binding(PROFILE_ID_V2) };
            for (model, selected) in [("qwen3.8-livetranslate-flash-realtime", None), ("custom-deployment", Some(&b))] {
                let error = authorize_livetranslate(model, &generic_url, selected).unwrap_err();
                assert!(error.contains("workspace_required"), "{error}");
                assert!(authorize_livetranslate(model, &workspace_url, selected).is_ok());
            }
            assert!(authorize_livetranslate("qwen3.5-livetranslate-flash-realtime", &generic_url, None).is_ok());
            assert!(authorize_livetranslate("qwen3.5-livetranslate-flash-realtime", &workspace_url, None).is_err());
        }
        for host in ["cn-beijing.maas.aliyuncs.com", "a.b.cn-beijing.maas.aliyuncs.com", "workspace-test.cn-beijing.maas.aliyuncs.com.evil.invalid", "-bad.cn-beijing.maas.aliyuncs.com"] {
            assert!(authorize_livetranslate("qwen3.8-livetranslate-flash-realtime", &format!("wss://{host}/api-ws/v1/realtime"), None).is_err());
        }
    }
    #[test]
    fn unknown_binding_is_explicit_versioned_and_generation_specific() {
        assert!(authorize_livetranslate("custom-deployment", URL, None).is_err());
        for (id, incremental) in [(PROFILE_ID, false), (PROFILE_ID_V2, true)] {
            let b = binding(id);
            let url = if incremental { "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime" } else { URL };
            let authority = authorize_livetranslate("custom-deployment", url, Some(&b)).unwrap();
            assert_eq!(authority.incremental_text, incremental);
            assert_eq!(authority.allowed_server_events.contains("response.text.delta"), incremental);
            assert_eq!(authority.allowed_server_events.contains("response.text.text"), !incremental);
            assert!(!authority.allowed_client_events.contains("response.create"));
        }
    }
    #[test]
    fn every_compiled_catalog_id_is_forbidden_even_when_not_in_protocol_registry() {
        let catalog: Value = serde_json::from_str(include_str!("../../../../../contracts/provider-manifests.compiled.v1.json")).unwrap();
        for manifest in catalog["manifests"].as_array().unwrap() {
            for model in manifest["models"].as_array().unwrap() {
                let id = model["id"].as_str().unwrap();
                assert!(authorize_livetranslate(id, "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime", Some(&binding(PROFILE_ID_V2))).is_err(), "{id}");
            }
        }
    }
    #[test]
    fn invalid_binding_fields_and_cross_region_endpoints_fail_closed() {
        for b in [
            ProtocolBinding { profile_version: 2, ..binding(PROFILE_ID_V2) },
            ProtocolBinding { region: "unknown".into(), ..binding(PROFILE_ID_V2) },
            ProtocolBinding { region: "ap-southeast-1".into(), ..binding(PROFILE_ID_V2) },
            binding("bailian.omni.realtime.ws"),
        ] { assert!(authorize_livetranslate("custom", "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime", Some(&b)).is_err()); }
        for url in ["ws://dashscope.aliyuncs.com/api-ws/v1/realtime", "wss://evil.example/api-ws/v1/realtime", "wss://dashscope.aliyuncs.com/api-ws/v1/inference", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=other", "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime", "wss://x.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime"] {
            assert!(authorize_livetranslate("custom", url, Some(&binding(PROFILE_ID_V2))).is_err(), "{url}");
        }
        let intl = ProtocolBinding { region: "ap-southeast-1".into(), ..binding(PROFILE_ID_V2) };
        for host in ["workspace-test.ap-southeast-1.maas.aliyuncs.com"] {
            assert!(authorize_livetranslate("custom", &format!("wss://{host}/api-ws/v1/realtime"), Some(&intl)).is_ok());
        }
        assert!(authorize_livetranslate("custom", "wss://work.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime", Some(&binding(PROFILE_ID))).is_err());
    }
    #[test]
    fn binding_json_is_strict() {
        for json in [r#"{}"#, r#"{"profileId":"x","profileVersion":"1","region":"cn-beijing"}"#, r#"{"profileId":"x","profileVersion":1,"region":"cn-beijing","operation":"dialogue"}"#] {
            assert!(serde_json::from_str::<ProtocolBinding>(json).is_err());
        }
    }
    #[test]
    fn binding_schema_matches_supported_authority_values() {
        let schema: Value = serde_json::from_str(include_str!("../../protocol-binding.schema.json")).unwrap();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["profileId", "profileVersion", "region"]));
        assert_eq!(schema["properties"]["profileId"]["enum"], serde_json::json!([PROFILE_ID, PROFILE_ID_V2]));
        assert_eq!(schema["properties"]["profileVersion"]["const"], PROFILE_VERSION);
        for region in schema["properties"]["region"]["enum"].as_array().unwrap() {
            let region = region.as_str().unwrap();
            let host = if region == "cn-beijing" { "dashscope.aliyuncs.com" } else { "dashscope-intl.aliyuncs.com" };
            for id in [PROFILE_ID, PROFILE_ID_V2] {
                let host = if id == PROFILE_ID_V2 { format!("workspace-test.{region}.maas.aliyuncs.com") } else { host.to_string() };
                let b = ProtocolBinding { region: region.into(), ..binding(id) };
                assert!(authorize_livetranslate("custom", &format!("wss://{host}/api-ws/v1/realtime"), Some(&b)).is_ok());
            }
        }
    }
    #[test]
    fn binding_cannot_bypass_profile_operation_adapter_or_wire_authority() {
        let registry: Value = serde_json::from_str(REGISTRY).unwrap();
        let index = registry["profiles"].as_array().unwrap().iter().position(|p| p["profileId"] == PROFILE_ID_V2).unwrap();
        for (pointer, value) in [
            ("/adapter/status", serde_json::json!("disabled")),
            ("/adapter/adapterId", serde_json::json!(ADAPTER_ID)),
            ("/operations", serde_json::json!(["dialogue"])),
            ("/dialectId", serde_json::json!(LIVETRANSLATE_DIALECT)),
        ] {
            let mut altered = registry.clone();
            *altered["profiles"][index].pointer_mut(pointer).unwrap() = value;
            assert!(authorize_from_registry_binding(&altered, "custom", "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime", Some(&binding(PROFILE_ID_V2))).is_err(), "{pointer}");
        }
        assert_eq!(registry, serde_json::from_str::<Value>(REGISTRY).unwrap());
    }

}

pub(super) fn authorize_endpoint(registry: &Value, base_url: &str, profile: &Value) -> Result<(), String> {
    let dialect_id = profile["dialectId"].as_str().unwrap_or_default();
    let workspace_required = profile.pointer("/endpointRequirements/workspaceScoped").and_then(Value::as_bool) == Some(true);
    let request = base_url
        .into_client_request()
        .map_err(|error| format!("invalid DashScope WebSocket base URL: {error}"))?;
    let uri = request.uri();
    if uri.scheme_str() != Some("wss") {
        return Err("model_protocol.endpoint_not_authorized: endpoint must use wss".to_string());
    }
    let host = uri
        .host()
        .ok_or_else(|| "model_protocol.endpoint_not_authorized: endpoint has no host".to_string())?;
    let path = uri.path();
    let dialect_path = registry
        .get("dialects")
        .and_then(Value::as_array)
        .and_then(|dialects| {
            dialects.iter().find(|dialect| {
                dialect.get("dialectId").and_then(Value::as_str) == Some(dialect_id)
            })
        })
        .and_then(|dialect| dialect.get("endpointPath"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("registry dialect '{dialect_id}' has no endpointPath"))?;
    if path != dialect_path || uri.query().is_some() {
        return Err(format!(
            "model_protocol.endpoint_not_authorized: expected endpoint path '{dialect_path}' without a query"
        ));
    }
    let mut matched_workspace = false;
    let generic_host_authorized = registry
        .get("endpointHostPolicies")
        .and_then(Value::as_array)
        .is_some_and(|policies| {
            policies.iter().any(|policy| {
                policy
                    .get("allowedHostFamilies")
                    .and_then(Value::as_array)
                    .is_some_and(|families| {
                        families.iter().any(|family| {
                            family.get("hostPattern").and_then(Value::as_str).is_some_and(|pattern| {
                                if family.get("workspaceScoped").and_then(Value::as_bool) == Some(true) {
                                    if dialect_id != DIALECT_V2 { return false; }
                                    let matched = pattern.strip_prefix("*.").and_then(|suffix| host.strip_suffix(&format!(".{suffix}")))
                                        .is_some_and(|label| !label.is_empty() && !label.contains('.')
                                            && !label.starts_with('-') && !label.ends_with('-')
                                            && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
                                    matched_workspace = matched;
                                    matched
                                } else { pattern == host }
                            })
                        })
                    })
            })
        });
    if !generic_host_authorized {
        return Err(format!(
            "model_protocol.endpoint_not_authorized: host '{host}' is not an authorized registry host"
        ));
    }
    if workspace_required && !matched_workspace {
        return Err("model_protocol.endpoint_not_authorized: workspace_required: this model requires a Workspace endpoint.".to_string());
    }
    Ok(())
}
