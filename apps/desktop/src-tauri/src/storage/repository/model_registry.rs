use serde_json::{json, Value};

const SEEDS: &str = include_str!("../../../../src/schema/model-registry-v1-seed.json");

/// Shared with the renderer: compare against a frozen pre-upgrade snapshot,
/// not today's manifest. Legacy rows and unknown fields remain untouched.
pub(super) fn migrate_provider(provider: &mut Value) {
    if provider.get("modelRegistryVersion").and_then(Value::as_u64) == Some(2) { return; }
    let seeds: Vec<Value> = serde_json::from_str(SEEDS).expect("frozen registry seed");
    let mut overrides = provider.get("modelCapabilityOverrides").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(rows) = provider.get("localModelCapabilityRegistry").and_then(Value::as_array) {
        for row in rows {
            let seed = seeds.iter().find(|seed| row["source"] != "manual" && seed.get("modelId") == row.get("modelId") && seed.get("id") == row.get("id"));
            let Some(seed) = seed else {
                let mut delta = json!({"modelId": row["modelId"], "source": if row["source"] == "manual" { "user" } else { "legacy" }});
                for field in ["capabilities", "interactionCapabilities", "apiModes", "realtimeAudioMode", "notes", "hidden", "displayName"] {
                    if let Some(value) = row.get(field) { delta[field] = value.clone(); }
                }
                overrides.push(delta);
                continue;
            };
            let mut delta = json!({ "modelId": row["modelId"], "source": "legacy" });
            for field in ["capabilities", "interactionCapabilities", "apiModes", "realtimeAudioMode", "notes", "hidden", "displayName"] {
                let fallback = json!("server_vad");
                let baseline = seed.get(field).or_else(|| if field == "realtimeAudioMode" { Some(&fallback) } else { None });
                if let Some(value) = row.get(field) {
                    if Some(value) != baseline { delta[field] = value.clone(); }
                }
            }
            if delta.as_object().is_some_and(|object| object.len() > 2) { overrides.push(delta); }
        }
    }
    if let Some(object) = provider.as_object_mut() {
        object.insert("modelRegistryVersion".into(), json!(2));
        object.insert("modelCapabilityOverrides".into(), json!(overrides));
    }
}

pub(super) fn migrate_config(config: &mut Value) {
    if let Some(providers) = config.get_mut("providers").and_then(Value::as_array_mut) {
        for provider in providers { migrate_provider(provider); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_migration_vectors() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!("../../../../src/schema/model-registry-migration-vectors.json")).unwrap();
        for vector in vectors {
            let mut provider = vector["input"].clone();
            migrate_provider(&mut provider);
            assert_eq!(provider["modelCapabilityOverrides"], vector["overrides"], "{}", vector["name"]);
            assert_eq!(provider["localModelCapabilityRegistry"], vector["input"]["localModelCapabilityRegistry"]);
            if let Some(model_id) = vector.get("resolveModelId").and_then(Value::as_str) {
                let registry: crate::provider::contracts::ProviderModelRegistryInput = serde_json::from_value(provider.clone()).unwrap();
                let (resolved, diagnostics) = registry.resolve(model_id, None);
                assert_eq!(resolved.unwrap()["capabilities"], vector["resolvedCapabilities"]);
                assert_eq!(diagnostics, vec!["duplicate-model-id"]);
            }
            let once = provider.clone();
            migrate_provider(&mut provider);
            assert_eq!(provider, once);
        }
    }
}
pub(super) fn initialize_defaults(config: &mut Value) {
    if let Some(providers) = config.get_mut("providers").and_then(Value::as_array_mut) {
        for provider in providers {
            provider["modelRegistryVersion"] = json!(2);
            provider["modelCapabilityOverrides"] = json!([]);
            provider["localModelCapabilityRegistry"] = json!([]);
        }
    }
}
