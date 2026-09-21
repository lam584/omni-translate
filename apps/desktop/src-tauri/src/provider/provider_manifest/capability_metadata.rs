use super::*;
use serde_json::{json, Value};
use crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile;

/// Advisory projection of the compiled module. Authorization never consumes
/// these values; the shared instance-override resolver overlays them afterwards.
pub(crate) fn manifest_model_capability_metadata(
    provider: &ProviderDraftInput,
    model_id: &str,
    bailian_authority: Option<&AuthorizedModelProtocolProfile>,
) -> Result<Option<Value>, String> {
    let bundle = bundle()?;
    let manifest = if provider.kind == "dashscope" {
        bundle.manifests.iter().find(|manifest| manifest.provider.id == "bailian")
    } else { provider_manifest(bundle, provider)? };
    let Some(manifest) = manifest else { return Ok(None); };
    let model = manifest.models.iter().find(|model| model.id == model_id);
    let profiles: Vec<_> = if let Some(model) = model {
        model.protocol_bindings.iter().filter_map(|binding| manifest.protocol_profiles.iter()
            .find(|profile| profile.id == binding.protocol_profile_id && profile.version == binding.protocol_profile_version)).collect()
    } else if let Some(authority) = bailian_authority.filter(|authority| authority.exact_model_id == model_id) {
        manifest.protocol_profiles.iter().filter(|profile| profile.id == authority.profile_id && profile.version == authority.profile_version).collect()
    } else { return Ok(None); };
    Ok(Some(project_metadata(manifest, model, &profiles)))
}

fn project_metadata(manifest: &ProviderManifest, model: Option<&Model>, profiles: &[&ProtocolProfile]) -> Value {
    let lifecycles: Vec<_> = profiles.iter().filter_map(|profile| manifest.lifecycle_profiles.iter()
        .find(|lifecycle| lifecycle.id == profile.lifecycle_profile_id)).collect();
    let has_mode = |mode: &str| lifecycles.iter().any(|lifecycle| lifecycle.vad_modes.iter().any(|value| value == mode));
    // Same exact lifecycle-event derivation as the module's TS projection.
    let server_vad = has_mode("server-vad") || lifecycles.iter().any(|lifecycle|
        lifecycle.server_events.iter().any(|event| event == "input_audio_buffer.speech_started"));
    let manual = has_mode("manual") || lifecycles.iter().any(|lifecycle|
        lifecycle.client_events.iter().any(|event| event == "input_audio_buffer.commit"));
    let semantic = has_mode("semantic-vad");
    let activity = has_mode("client-activity");
    let streaming = profiles.iter().any(|profile| manifest.transports.iter()
        .any(|transport| transport.id == profile.transport_id && transport.kind == "websocket"));
    let mode = if activity { "gemini_auto_activity" } else if server_vad { "server_vad" }
        else if semantic { "semantic_vad" } else { "manual" };
    let interactions: Vec<_> = [("auto_vad", server_vad || semantic || activity),
        ("manual_commit", manual), ("client_activity", activity), ("streaming", streaming), ("push_to_talk", manual)]
        .into_iter().filter_map(|(name, present)| present.then_some(name)).collect();
    let mut metadata = json!({"realtimeAudioMode":mode,"interactionCapabilities":interactions});
    if let Some(overrides) = model.and_then(|model| model.capability_metadata.as_ref()).and_then(Value::as_object) {
        for field in ["capabilities", "interactionCapabilities", "realtimeAudioMode", "apiModes", "releasedAt"] {
            if let Some(value) = overrides.get(field) { metadata[field] = value.clone(); }
        }
    }
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_advisory_metadata_preserves_non_bailian_seed_fields() {
        let mut checked = 0;
        for manifest in &bundle().unwrap().manifests {
            if manifest.provider.id == "bailian" { continue; }
            for model in &manifest.models {
                if let Some(metadata) = &model.capability_metadata {
                    let projected = project_metadata(manifest, Some(model), &[]);
                    for (field, value) in metadata.as_object().unwrap() {
                        assert_eq!(&projected[field], value, "{} {} {field}", manifest.provider.id, model.id);
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked > 0, "compiled non-Bailian module metadata must be present");
    }

    #[test]
    fn compiled_livetranslate_advisory_uses_events_and_transport_not_model_names() {
        let manifest = bundle().unwrap().manifests.iter().find(|manifest| manifest.provider.id == "bailian").unwrap();
        for (profile_id, manual) in [("bailian.livetranslate.realtime.ws", true), ("bailian.livetranslate.3_8.realtime.ws", false)] {
            let profile = manifest.protocol_profiles.iter().find(|profile| profile.id == profile_id).unwrap();
            let projected = project_metadata(manifest, None, &[profile]);
            assert_eq!(projected["realtimeAudioMode"], "server_vad");
            assert_eq!(projected["interactionCapabilities"], if manual { json!(["auto_vad","manual_commit","streaming","push_to_talk"]) } else { json!(["auto_vad","streaming"]) });
        }
    }
}
