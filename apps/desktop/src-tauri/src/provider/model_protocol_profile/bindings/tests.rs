use super::*;
use serde_json::json;
use crate::provider::contracts::ProviderDraftInput;

fn provider() -> ProviderDraftInput {
    serde_json::from_value(json!({
        "templateId":"template-custom-bailian", "providerId":"binding-test", "kind":"dashscope",
        "modelRegistryVersion":2, "displayName":"Binding test", "model":"custom-live-deployment", "transport":"websocket",
        "baseUrl":"https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1", "region":"cn-beijing",
        "authRef":{"kind":"header","reference":"offline","headerName":"Authorization","scheme":"Bearer"},
        "streamEnabled":true,"timeoutMs":1000,"systemPromptTemplate":"",
        "modelProtocolBindings":[{"modelId":"custom-live-deployment","operation":"realtime-translation",
            "profileOwnerProviderId":"bailian","manifestVersion":1,
            "profileId":"bailian.livetranslate.3_8.realtime.ws","profileVersion":1}]
    })).unwrap()
}

fn authorize(provider: &ProviderDraftInput) -> Result<AuthorizedModelProtocolProfile, String> {
    crate::audio::events::authorize_bailian_native_translate(provider)
}

fn admit(authority: &AuthorizedModelProtocolProfile) -> Result<AuthorizedModelProtocolEvent, ModelProtocolAuthorizationError> {
    admit_model_protocol_event(authority, ModelProtocolEventAdmissionRequest {
        direction: ModelProtocolEventDirection::Server,
        event_type:"response.text.delta", frame_kind:ModelProtocolFrameKind::Json,
    })
}

#[test]
fn workspace_requirement_rejects_known_and_custom_generic_before_provider_access() {
    for model in ["custom-live-deployment", "qwen3.8-livetranslate-flash-realtime"] {
        let mut p = provider();
        p.model = model.to_string();
        p.model_protocol_bindings[0].model_id = model.to_string();
        assert!(authorize(&p).is_ok());
        p.base_url = "https://dashscope.aliyuncs.com/api/v1".to_string();
        let error = authorize(&p).unwrap_err();
        assert!(error.contains("workspace_required"), "{error}");
        let error = crate::provider::gateway::authorize_bailian_model_operation_before_provider_access(&p, &p.model, "native_translate").unwrap_err();
        assert_eq!(error.code, "model_protocol.endpoint_host_region_mismatch");
        assert!(error.message.contains("workspace_required"), "{}", error.message);
    }
    let mut authority = authorize(&provider()).unwrap();
    authority.endpoint_host = "dashscope.aliyuncs.com".to_string();
    authority.endpoint_host_family_id = "dashscope-cn-beijing-generic".to_string();
    assert!(admit(&authority).is_err());
}

#[test]
fn custom_binding_requires_one_explicit_operation_binding() {
    let mut p = provider();
    let binding = p.model_protocol_bindings[0].clone();
    p.model_protocol_bindings.clear();
    assert!(authorize(&p).unwrap_err().contains("model_not_registered"));
    assert!(crate::provider::gateway::authorize_bailian_model_operation_before_provider_access(&p, &p.model, "native_translate").is_err());
    p.model_protocol_bindings = vec![binding.clone(), binding];
    assert!(authorize(&p).unwrap_err().contains("profile_ambiguous"));
    p.model_protocol_bindings.truncate(1);
    p.model_protocol_bindings[0].operation = "asr".to_string();
    assert!(authorize(&p).is_err());
}

#[test]
fn custom_binding_authorizes_actual_identity_gateway_and_route_but_rejects_forgery() {
    let p = provider();
    let authority = authorize(&p).unwrap();
    assert_eq!(authority.exact_model_id, p.model);
    assert!(authority.binding_provenance.is_some());
    admit(&authority).unwrap();
    let route = crate::audio::events::resolve_realtime_profile(&p, &p.model);
    assert!(route.model_protocol_error.is_none(), "{:?}", route.model_protocol_error);
    assert_eq!(route.protocol_dialect, Some(crate::audio::events::RealtimeProtocol::DashscopeLivetranslate));
    assert!(crate::provider::gateway::authorize_bailian_model_operation_before_provider_access(&p, &p.model, "native_translate").unwrap().is_some());
    let mut forged = authority.clone();
    forged.exact_model_id = "different-custom-deployment".to_string();
    assert!(admit(&forged).is_err());
    forged = authority.clone();
    forged.wire_dialect = "bailian-livetranslate-session-ws-v1".to_string();
    assert!(admit(&forged).is_err());
    forged = authority.clone();
    forged.profile_version += 1;
    assert!(admit(&forged).is_err());
    forged = authority.clone();
    forged.endpoint_host = "other.cn-beijing.maas.aliyuncs.com".to_string();
    assert!(admit(&forged).is_err());
    forged = authority;
    forged.binding_provenance = None;
    assert!(admit(&forged).is_err());
}

#[test]
fn custom_binding_rejects_disabled_profile_endpoint_owner_version_and_media() {
    let original = provider();
    let disabled = registry().unwrap().profiles.iter().find(|profile| profile.adapter.status != "enabled").unwrap();
    let mut p = original.clone();
    p.model_protocol_bindings[0].profile_id = disabled.profile_id.clone();
    assert!(authorize(&p).is_err());
    p = original.clone(); p.base_url = "https://evil.invalid/api/v1".to_string();
    assert!(authorize(&p).unwrap_err().contains("endpoint_host_region_mismatch"));
    p = original.clone(); p.base_url = "https://workspace-test.cn-beijing.maas.aliyuncs.com/wrong/path".to_string();
    assert!(authorize(&p).unwrap_err().contains("endpoint_family_mismatch"));
    p = original.clone(); p.base_url = "http://dashscope.aliyuncs.com/api/v1".to_string();
    assert!(authorize(&p).is_err());
    p = original.clone(); p.model_protocol_bindings[0].profile_owner_provider_id = "other".to_string();
    assert!(authorize(&p).is_err());
    p = original.clone(); p.model_protocol_bindings[0].profile_version = 999;
    assert!(authorize(&p).unwrap_err().contains("profile_version_mismatch"));
    p = original.clone(); p.model_protocol_bindings[0].manifest_version = 999;
    assert!(authorize(&p).is_err());
    let request = ModelProtocolAuthorizationRequest {
        exact_model_id:&original.model, operation:"native_translate", transport:"websocket", region:"cn-beijing",
        endpoint_host:"workspace-test.cn-beijing.maas.aliyuncs.com",
        audio_input:Some(ModelProtocolRequestedAudio {codec:"pcm16",sample_rate_hz:44_100,channels:1}), audio_output:None,
        declared_registry_version:None,declared_profile_id:None,declared_profile_version:None,
        declared_wire_dialect:None,declared_endpoint_family:None,declared_terminal_lifecycle:None,
    };
    assert_eq!(authorize_model_protocol_invocation_with_binding(request, original.model_protocol_bindings.first()).unwrap_err(), ModelProtocolAuthorizationError::AudioInputSampleRateNotSupported);
}

#[test]
fn custom_binding_cannot_rebind_known_models_and_legacy_projection_is_not_authority() {
    for model in ["qwen3.8-flash", "qwen-plus", "qwen-mt-plus"] {
        let mut p = provider();
        p.model = model.to_string();
        p.model_protocol_bindings[0].model_id = model.to_string();
        assert!(authorize(&p).is_err(), "built-in catalog model {model} cannot be rebound");
        let mut forged = authorize(&provider()).unwrap();
        forged.exact_model_id = model.to_string();
        forged.binding_provenance.as_mut().unwrap().binding.model_id = model.to_string();
        assert!(admit(&forged).is_err(), "event revalidation must check the compiled catalog too");
    }
    for (model, profile) in [("qwen3.5-livetranslate-flash-realtime","bailian.livetranslate.realtime.ws"),
        ("qwen3.8-livetranslate-flash-realtime","bailian.livetranslate.3_8.realtime.ws")] {
        let mut p = provider(); p.model = model.to_string();
        p.model_protocol_bindings[0].model_id = model.to_string();
        p.model_protocol_bindings[0].profile_id = if model.contains("3.5") {"bailian.livetranslate.3_8.realtime.ws"} else {"bailian.livetranslate.realtime.ws"}.to_string();
        assert!(authorize(&p).unwrap_err().contains("profile_id_mismatch"));
        p.model_protocol_bindings.clear();
        p.local_model_capability_registry = serde_json::from_value(json!([{
            "id":"stale", "modelId":model, "capabilities":["speech-to-speech"],
            "registryVersion":"old-projection", "profileId":"stale", "profileVersion":99,
            "interactionCapabilities":[],"apiModes":[],"source":"local","notes":""
        }])).unwrap();
        let authority = authorize(&p).unwrap();
        assert_eq!(authority.profile_id, profile);
        assert!(authority.binding_provenance.is_none());
    }
}

#[test]
fn registry_v2_runtime_overrides_use_shared_resolver_and_preserve_explicit_empty() {
    let mut p = provider();
    p.model_capability_overrides = vec![json!({"modelId":p.model,"source":"legacy","realtimeAudioMode":"manual","interactionCapabilities":["manual_commit"]}),
        json!({"modelId":p.model,"source":"user","realtimeAudioMode":"server_vad","interactionCapabilities":[]})];
    let profile = crate::audio::events::resolve_realtime_profile(&p, &p.model);
    assert_eq!(profile.realtime_audio_mode, "server_vad");
    assert!(profile.interaction_capabilities.is_empty());
    assert!(profile.diagnostics.iter().any(|issue| issue == "duplicate-model-id"));
    assert!(profile.model_protocol_authority.is_some());
    p.model_capability_overrides = vec![json!({"modelId":p.model,"source":"user","realtimeAudioMode":"manual"})];
    let profile = crate::audio::events::resolve_realtime_profile(&p, &p.model);
    assert_eq!(profile.realtime_audio_mode, "manual");
    assert!(crate::audio::bailian_protocol::validate_audio_mode(profile.model_protocol_authority.as_ref().unwrap(), &profile.realtime_audio_mode).is_err());
}

#[test]
fn legacy_route_declaration_errors_and_gateway_unknown_errors_keep_distinct_precedence() {
    for (model, version, route_error, gateway_error) in [
        ("custom-live-deployment", None, Some("profile_declaration_missing"), Some("model_not_registered")),
        ("qwen3.5-livetranslate-flash-realtime", None, Some("profile_declaration_missing"), Some("profile_declaration_missing")),
        ("custom-live-deployment", Some(2), Some("model_not_registered"), Some("model_not_registered")),
        ("qwen3.5-livetranslate-flash-realtime", Some(2), None, None),
    ] {
        let mut p = provider();
        p.model = model.to_string();
        p.model_registry_version = version;
        p.model_protocol_bindings.clear();
        p.local_model_capability_registry = serde_json::from_value(json!([{
            "id":"legacy-row", "modelId":model, "capabilities":["speech-to-speech"],
            "realtimeProtocol":"dashscope-livetranslate", "realtimeAudioMode":"server_vad",
            "interactionCapabilities":[],"apiModes":[],"source":"local","notes":""
        }])).unwrap();
        let route = crate::audio::events::resolve_realtime_profile(&p, model);
        match route_error {
            Some(code) => assert!(route.model_protocol_error.as_deref().is_some_and(|error| error.contains(code)), "{model} {version:?}: {:?}", route.model_protocol_error),
            None => assert!(route.model_protocol_error.is_none()),
        }
        let gateway = crate::provider::gateway::authorize_bailian_model_operation_before_provider_access(&p, model, "native_translate");
        match gateway_error {
            Some(code) => assert_eq!(gateway.unwrap_err().code, format!("model_protocol.{code}")),
            None => assert!(gateway.unwrap().is_some()),
        }
    }
}
