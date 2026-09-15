use serde_json::json;

use super::*;

const CHECKED_AT: &str = "2026-08-30";
const SOURCE_URLS: &[&str] = &[
    "https://help.aliyun.com/zh/model-studio/qwen-real-time-speech-recognition",
    "https://help.aliyun.com/zh/model-studio/qwen-omni",
    "https://help.aliyun.com/zh/model-studio/live-translate",
];

fn provider_fixture(
    model: &str,
    template_protocol: Option<&str>,
    registry_protocol: Option<&str>,
    manifest_profile: Option<(&str, u32)>,
) -> ProviderDraftInput {
    let (profile_id, profile_version) = manifest_profile
        .map(|(profile_id, profile_version)| (Some(profile_id), Some(profile_version)))
        .unwrap_or((None, None));
    serde_json::from_value(json!({
        "templateId": "template-dashscope-realtime",
        "providerId": "provider-dashscope-old-red",
        "kind": "dashscope",
        "templateRealtimeProtocol": template_protocol,
        "realtimeProtocol": null,
        "displayName": "DashScope old-red fixture",
        "model": model,
        "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
        "transport": "websocket",
        "authRef": {
            "kind": "header",
            "reference": "redacted-fixture-only",
            "headerName": "Authorization",
            "scheme": "Bearer"
        },
        "region": "cn-beijing",
        "streamEnabled": true,
        "timeoutMs": 1000,
        "systemPromptTemplate": "",
        "fixtureMetadata": {
            "sourceUrls": SOURCE_URLS,
            "checkedAt": CHECKED_AT,
            "profileId": "model-protocol-manifest",
            "profileVersion": 1,
            "redaction": "No credential or customer payload; auth reference is synthetic.",
            "expectedOrdering": "manifest authorization precedes every transport attempt"
        },
        "localModelCapabilityRegistry": [{
            "id": format!("audit-{model}"),
            "modelId": model,
            "capabilities": ["speech-to-text"],
            "registryVersion": manifest_profile
                .map(|_| "bailian-model-protocol-registry/v1"),
            "profileId": profile_id,
            "profileVersion": profile_version,
            "realtimeProtocol": registry_protocol,
            "realtimeAudioMode": null,
            "interactionCapabilities": [],
            "apiModes": ["realtime"],
            "releasedAt": null,
            "source": "local-audit-fixture",
            "notes": format!(
                "checkedAt={CHECKED_AT}; profileId/model-protocol-manifest; profileVersion=1; redacted; expected ordering is authorize-before-connect; sources={}",
                SOURCE_URLS.join(",")
            )
        }]
    }))
    .expect("old-red provider fixture must deserialize")
}

#[test]
fn exact_registry_without_profile_never_falls_back_to_template() {
    let model = "qwen3-asr-flash-realtime";
    let provider = provider_fixture(model, Some("dashscope-omni"), None, None);

    let resolved = resolve_realtime_profile(&provider, model);

    assert_eq!(
        resolved.protocol_dialect,
        None,
        "A01: an exact registry entry without a protocol profile must fail closed instead of inheriting the DashScope Omni template"
    );
    assert_eq!(resolved.source, RealtimeProfileSource::None);
    assert_eq!(resolved.route_kind, ResolvedRouteKind::LocalVad);
    assert!(
        !resolved.preconnect_allowed,
        "A01: missing explicit profile must authorize zero connection attempts"
    );
}

#[test]
fn exact_manifest_model_does_not_require_a_duplicate_local_registry_row() {
    let mut provider = provider_fixture(
        "qwen3.5-livetranslate-flash-realtime",
        Some("dashscope-omni"),
        None,
        None,
    );
    provider.local_model_capability_registry.clear();

    let resolved = resolve_realtime_profile(&provider, &provider.model);

    assert_eq!(
        resolved.protocol_dialect,
        Some(RealtimeProtocol::DashscopeLivetranslate)
    );
    assert_eq!(resolved.source, RealtimeProfileSource::Manifest);
    assert!(resolved.preconnect_allowed);
    assert!(resolved.model_protocol_error.is_none());
    let authority = resolved
        .model_protocol_authority
        .expect("enabled LiveTranslate route must retain complete connection authority");
    let input = authority
        .requested_audio_input
        .expect("route must bind the actual capture media before socket creation");
    assert_eq!((input.codec.as_str(), input.sample_rate_hz, input.channels), ("pcm16", 16_000, 1));
    let output = authority
        .requested_audio_output
        .expect("route must bind the actual provider playback media before socket creation");
    assert_eq!((output.codec.as_str(), output.sample_rate_hz, output.channels), ("pcm16", 24_000, 1));
}

#[test]
fn dashscope_template_cannot_authorize_an_openai_compatible_audio_route() {
    let mut provider = provider_fixture(
        "qwen3.5-livetranslate-flash-realtime",
        None,
        Some("dashscope-livetranslate"),
        Some(("bailian.livetranslate.realtime.ws", 1)),
    );
    provider.kind = "openai-compatible".to_string();

    let resolved = resolve_realtime_profile(&provider, &provider.model);
    assert_eq!(resolved.protocol_dialect, None);
    assert!(!resolved.preconnect_allowed);
    assert!(resolved.model_protocol_authority.is_none());
    assert!(
        authorize_bailian_native_translate(&provider)
            .expect_err("provider kind mismatch must fail before connector construction")
            .contains("model_protocol.provider_family_mismatch")
    );
}

#[test]
fn resolver_parity_is_manifest_authoritative_rust_vector() {
    struct Case {
        name: &'static str,
        provider: ProviderDraftInput,
        expected_protocol: Option<RealtimeProtocol>,
        expected_source: RealtimeProfileSource,
        expected_preconnect: bool,
    }

    let cases = [
        Case {
            name: "known-livetranslate",
            provider: provider_fixture(
                "qwen3.5-livetranslate-flash-realtime",
                Some("dashscope-omni"),
                Some("dashscope-livetranslate"),
                Some(("bailian.livetranslate.realtime.ws", 1)),
            ),
            expected_protocol: Some(RealtimeProtocol::DashscopeLivetranslate),
            expected_source: RealtimeProfileSource::Manifest,
            expected_preconnect: true,
        },
        Case {
            name: "known-omni",
            provider: provider_fixture(
                "qwen3-omni-flash-realtime",
                None,
                Some("dashscope-omni"),
                Some(("bailian.omni.realtime.ws", 1)),
            ),
            expected_protocol: None,
            expected_source: RealtimeProfileSource::None,
            expected_preconnect: false,
        },
        Case {
            name: "unknown",
            provider: provider_fixture("future-unknown-voice-model-2099", None, None, None),
            expected_protocol: None,
            expected_source: RealtimeProfileSource::None,
            expected_preconnect: false,
        },
        Case {
            name: "exact-entry-without-profile",
            provider: provider_fixture(
                "qwen3-asr-flash-realtime",
                Some("dashscope-omni"),
                None,
                None,
            ),
            expected_protocol: None,
            expected_source: RealtimeProfileSource::None,
            expected_preconnect: false,
        },
    ];

    for case in cases {
        let resolved = resolve_realtime_profile(&case.provider, &case.provider.model);
        assert_eq!(
            resolved.protocol_dialect, case.expected_protocol,
            "A03 protocol mismatch for Rust parity vector '{}'",
            case.name
        );
        assert_eq!(
            resolved.source, case.expected_source,
            "A03 authority source mismatch for Rust parity vector '{}'",
            case.name
        );
        assert_eq!(
            resolved.preconnect_allowed, case.expected_preconnect,
            "A03 connect authority mismatch for Rust parity vector '{}'",
            case.name
        );
    }
}

#[test]
fn task_asr_never_uses_realtime_endpoint() {
    let url = crate::provider::gateway_parts::transport::to_websocket_url(
        "https://dashscope.aliyuncs.com/api/v1",
        "qwen-audio-3.0-asr-flash-streaming",
    )
    .expect("B01 URL construction remains local and deterministic");

    assert_eq!(
        url.path(),
        "/api-ws/v1/inference",
        "B01: task/inference ASR must never be routed to the realtime session endpoint"
    );
}

#[test]
fn route_authority_binds_the_actual_endpoint_host_to_the_declared_region() {
    let mut provider = provider_fixture(
        "qwen3.5-livetranslate-flash-realtime",
        None,
        Some("dashscope-livetranslate"),
        Some(("bailian.livetranslate.realtime.ws", 1)),
    );

    provider.base_url = "https://dashscope-intl.aliyuncs.com/api/v1".to_string();
    let cross_region = resolve_realtime_profile(&provider, &provider.model);
    assert_eq!(cross_region.protocol_dialect, None);
    assert!(!cross_region.preconnect_allowed);
    assert!(
        cross_region
            .model_protocol_error
            .as_deref()
            .is_some_and(|error| error.contains("model_protocol.endpoint_host_region_mismatch"))
    );

    provider.base_url =
        "https://llm-sanitized.cn-beijing.maas.aliyuncs.com/api/v1".to_string();
    let workspace = resolve_realtime_profile(&provider, &provider.model);
    assert_eq!(
        workspace.protocol_dialect,
        Some(RealtimeProtocol::DashscopeLivetranslate)
    );
    assert!(workspace.preconnect_allowed);

    provider.base_url =
        "https://attacker.llm-sanitized.cn-beijing.maas.aliyuncs.com/api/v1".to_string();
    let nested_workspace = resolve_realtime_profile(&provider, &provider.model);
    assert_eq!(nested_workspace.protocol_dialect, None);
    assert!(!nested_workspace.preconnect_allowed);
}
