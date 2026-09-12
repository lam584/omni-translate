use super::*;

use crate::release_evidence_diagnostic::provider_selection::select_provider_by_id;

fn default_config() -> Value {
    serde_json::from_str(include_str!("../../../defaults/app-config.default.json"))
        .expect("checked-in default configuration must parse")
}

fn exact_livetranslate_seed_mut(config: &mut Value) -> &mut serde_json::Map<String, Value> {
    config["providers"]
        .as_array_mut()
        .expect("default providers must be an array")
        .iter_mut()
        .find(|provider| provider["providerId"] == PROVIDER_ID)
        .expect("default configuration must contain the strict provider")
        ["localModelCapabilityRegistry"]
        .as_array_mut()
        .expect("strict provider registry must be an array")
        .iter_mut()
        .find(|entry| entry["modelId"] == PREFLIGHT_MODEL)
        .expect("default registry must contain the exact LiveTranslate seed")
        .as_object_mut()
        .expect("LiveTranslate seed must be an object")
}

fn persisted_config_with_legacy_official_seed() -> Value {
    let mut config = default_config();
    let seed = exact_livetranslate_seed_mut(&mut config);
    for field in ["registryVersion", "profileId", "profileVersion"] {
        seed.remove(field);
    }
    assert_eq!(seed.get("source"), Some(&json!("official")));
    assert_eq!(
        seed.get("realtimeProtocol"),
        Some(&json!("dashscope-livetranslate"))
    );
    assert!(seed
        .get("capabilities")
        .and_then(Value::as_array)
        .is_some_and(|capabilities| !capabilities.is_empty()));
    config
}

fn strict_authorization() -> ProviderPreflightAuthorization {
    let identity = PreflightAuthorityProfile::StrictReleaseMatrix
        .model_protocol_profile_identity()
        .expect("checked-in registry must authorize the strict model")
        .expect("strict authorization must have an explicit protocol profile");
    ProviderPreflightAuthorization {
        authority: json!({}),
        model: PREFLIGHT_MODEL.to_string(),
        protocol: PREFLIGHT_PROTOCOL.to_string(),
        authorization_root: PathBuf::new(),
        grant: json!({}),
        authorization_digest: "a".repeat(64),
        expires_at: Utc::now() + chrono::Duration::minutes(5),
        profile: PreflightAuthorityProfile::StrictReleaseMatrix,
        model_protocol_profile_identity: Some(identity),
    }
}

fn parsed_strict_provider(config: &Value) -> ProviderDraftInput {
    select_provider_by_id(config, PROVIDER_ID)
        .expect("fixture must pass the production persisted-provider parser")
        .1
}

#[test]
fn signed_strict_authority_resolves_legacy_official_seed_to_the_exact_profile() {
    let mut provider = parsed_strict_provider(&persisted_config_with_legacy_official_seed());
    let authorization = strict_authorization();
    let expected_identity = authorization
        .model_protocol_profile_identity
        .clone()
        .expect("strict fixture must retain the signed identity");

    let configured_model = authorization
        .apply_to_provider(&mut provider)
        .expect("signed strict authority must resolve before any Provider connection");

    assert_eq!(configured_model, PREFLIGHT_MODEL);
    assert_eq!(provider.model, PREFLIGHT_MODEL);
    assert_eq!(provider.transport, expected_identity.transport);
    assert_eq!(expected_identity.operation, STRICT_MODEL_PROTOCOL_OPERATION);
    let resolved = resolve_realtime_profile(&provider, &provider.model);
    assert_eq!(
        resolved.protocol_dialect.map(|value| value.as_str()),
        Some(PREFLIGHT_PROTOCOL)
    );
    let actual_identity = ModelProtocolProfileIdentityRuntime::from(
        resolved
            .model_protocol_authority
            .as_ref()
            .expect("strict provider must retain registry-derived connection authority"),
    );
    assert_eq!(actual_identity, expected_identity);

    let mut missing_protocol_config = persisted_config_with_legacy_official_seed();
    exact_livetranslate_seed_mut(&mut missing_protocol_config).remove("realtimeProtocol");
    let mut provider = parsed_strict_provider(&missing_protocol_config);
    authorization
        .apply_to_provider(&mut provider)
        .expect("signed strict authority must fill a missing official legacy protocol");
    let entry = provider
        .local_model_capability_registry
        .iter()
        .find(|entry| entry.model_id == PREFLIGHT_MODEL)
        .expect("the exact official seed must remain present");
    assert_eq!(entry.realtime_protocol.as_deref(), Some(PREFLIGHT_PROTOCOL));
}

#[test]
fn explicit_registry_or_legacy_protocol_mismatch_fails_before_connect() {
    let cases = [
        ("registryVersion", json!("bailian-model-protocol-registry/v999")),
        ("profileId", json!("bailian.livetranslate.realtime.ws.tampered")),
        ("profileVersion", json!(999)),
        ("realtimeProtocol", json!("dashscope-omni")),
    ];

    for (field, replacement) in cases {
        let mut config = default_config();
        exact_livetranslate_seed_mut(&mut config).insert(field.to_string(), replacement);
        let mut provider = parsed_strict_provider(&config);
        let result = strict_authorization().apply_to_provider(&mut provider);
        assert!(
            result.is_err(),
            "persisted {field} mismatch must not be overwritten before Provider connection"
        );
        let error = result.expect_err("mismatch result was checked above");
        assert!(
            error.contains("signed protocol") || error.contains("signed registry-derived"),
            "unexpected {field} mismatch error: {error}"
        );
    }
}

#[test]
fn custom_exact_model_shadow_cannot_gain_signed_connection_authority() {
    let mut config = default_config();
    let provider = config["providers"]
        .as_array_mut()
        .expect("default providers must be an array")
        .iter_mut()
        .find(|provider| provider["providerId"] == PROVIDER_ID)
        .expect("default configuration must contain the strict provider");
    let registry = provider["localModelCapabilityRegistry"]
        .as_array_mut()
        .expect("strict provider registry must be an array");
    registry.retain(|entry| entry["modelId"] != PREFLIGHT_MODEL);
    registry.insert(
            0,
            json!({
                "id": "custom-shadow-livetranslate",
                "modelId": PREFLIGHT_MODEL,
                "registryVersion": "bailian-model-protocol-registry/v1",
                "profileId": "bailian.livetranslate.realtime.ws.tampered",
                "profileVersion": 1,
                "capabilities": ["speech-to-text", "speech-to-speech"],
                "realtimeProtocol": "dashscope-omni",
                "realtimeAudioMode": "server_vad",
                "interactionCapabilities": ["streaming"],
                "apiModes": ["websocket"],
                "source": "custom"
            }),
        );

    let mut provider = parsed_strict_provider(&config);
    strict_authorization()
        .apply_to_provider(&mut provider)
        .expect_err("a lone custom exact-model declaration must fail before Provider connection");
}

#[test]
fn duplicate_exact_model_declarations_fail_before_connect() {
    let mut config = default_config();
    let provider = config["providers"]
        .as_array_mut()
        .expect("default providers must be an array")
        .iter_mut()
        .find(|provider| provider["providerId"] == PROVIDER_ID)
        .expect("default configuration must contain the strict provider");
    provider["localModelCapabilityRegistry"]
        .as_array_mut()
        .expect("strict provider registry must be an array")
        .insert(
            0,
            json!({
                "id": "custom-shadow-livetranslate",
                "modelId": PREFLIGHT_MODEL,
                "registryVersion": "bailian-model-protocol-registry/v1",
                "profileId": "bailian.livetranslate.realtime.ws",
                "profileVersion": 1,
                "capabilities": ["speech-to-text", "speech-to-speech"],
                "realtimeProtocol": PREFLIGHT_PROTOCOL,
                "source": "custom"
            }),
        );

    let mut provider = parsed_strict_provider(&config);
    let error = strict_authorization()
        .apply_to_provider(&mut provider)
        .expect_err("duplicate exact-model declarations must fail before Provider connection");
    assert!(error.contains("exactly one signed registry-derived"));
}
