use super::*;

pub(super) fn parse_realtime_protocol(value: &str) -> Option<RealtimeProtocol> {
    match value.trim() {
        "dashscope-omni" => Some(RealtimeProtocol::DashscopeOmni),
        "dashscope-qwen-audio" => Some(RealtimeProtocol::DashscopeQwenAudio),
        "dashscope-livetranslate" => Some(RealtimeProtocol::DashscopeLivetranslate),
        "dashscope-asr" => Some(RealtimeProtocol::DashscopeAsr),
        "openai-conversation" => Some(RealtimeProtocol::OpenAiConversation),
        "openai-translation" => Some(RealtimeProtocol::OpenAiTranslation),
        "openai-transcription" => Some(RealtimeProtocol::OpenAiTranscription),
        "openai-flat" => Some(RealtimeProtocol::OpenAiFlat),
        "gemini-live" => Some(RealtimeProtocol::GeminiLive),
        _ => None,
    }
}

pub(super) fn registry_protocol(
    _provider: &ProviderDraftInput,
    entry: &ProviderModelCapabilityRegistryEntryInput,
) -> Option<RealtimeProtocol> {
    entry
        .realtime_protocol
        .as_deref()
        .and_then(parse_realtime_protocol)
}

pub(super) fn bailian_protocol_from_authority(
    authority: &AuthorizedModelProtocolProfile,
) -> Option<RealtimeProtocol> {
    match (authority.adapter_id.as_str(), authority.wire_dialect.as_str(), authority.wire_dialect_version) {
        ("desktop-livetranslate-session-v1", "bailian-livetranslate-session-ws-v1", 1)
        | ("desktop-livetranslate-session-v2", "bailian-livetranslate-session-ws-v2", 2) => {
            Some(RealtimeProtocol::DashscopeLivetranslate)
        }
        ("desktop-omni-session-v2", "bailian-omni-realtime-ws-v2", 2) => Some(RealtimeProtocol::DashscopeOmni),
        ("desktop-qwen-audio-session-v1", "bailian-qwen-audio-chat-realtime-ws-v1", 1) => Some(RealtimeProtocol::DashscopeQwenAudio),
        ("desktop-qwen-audio-task-asr-v1", "bailian-qwen-audio-asr-task-ws-v1", 1) => Some(RealtimeProtocol::DashscopeAsr),
        _ => None,
    }
}

/// Exact dialect descriptors choose the operation before admission, never by model prefix.
pub(super) fn primary_bailian_operation(provider: &ProviderDraftInput, model: &str) -> Result<&'static str, String> {
    let profiles = crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(model)
        .map_err(|error| error.to_string())?;
    if profiles.len() > 1 { return Err("model_protocol.profile_ambiguous: explicit primary operation is required".to_string()); }
    if let Some(profile) = profiles.first() {
        return Ok(match profile.wire_dialect.as_str() {
            "bailian-omni-realtime-ws-v2" | "bailian-qwen-audio-chat-realtime-ws-v1" => "dialogue",
            "bailian-qwen-audio-asr-task-ws-v1" => "asr",
            _ => "native_translate",
        });
    }
    let bindings: Vec<_> = provider.model_protocol_bindings.iter().filter(|b| b.model_id == model
        && matches!(b.operation.as_str(), "realtime-translation" | "realtime-conversation" | "asr" | "realtime-transcription")).collect();
    if bindings.len() > 1 { return Err("model_protocol.profile_ambiguous: explicit primary operation is required".to_string()); }
    Ok(match bindings.first().map(|b| b.operation.as_str()) {
        Some("realtime-conversation") => "dialogue", Some("asr" | "realtime-transcription") => "asr", _ => "native_translate",
    })
}

pub(super) fn resolve_bailian_model_protocol_authority(
    provider: &ProviderDraftInput,
    model: &str,
    operation: &str,
) -> Result<AuthorizedModelProtocolProfile, String> {
    let bindings = provider.model_protocol_bindings.iter()
        .filter(|binding| binding.model_id == model && crate::provider::model_protocol_profile::binding_operation_matches(&binding.operation, operation))
        .collect::<Vec<_>>();
    if bindings.len() > 1 {
        return Err("model_protocol.profile_ambiguous: multiple explicit bindings for model and operation".to_string());
    }
    let binding = bindings.first().copied();
    if binding.is_some() && provider.model_registry_version != Some(2)
        && lookup_model_protocol_profiles_for_inspection(model).map_err(|error| error.to_string())?.is_empty() {
        return Err("model_protocol.profile_declaration_missing: custom bindings require modelRegistryVersion 2".to_string());
    }
    let entry = if provider.model_registry_version == Some(2) || binding.is_some() { None }
        else { selected_registry_entry(provider, model) };
    let registry_version = match entry {
        Some(entry) => Some(
            entry
                .model_protocol_registry_version
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "model_protocol.profile_declaration_missing: registryVersion is missing for Bailian model '{model}'"
                    )
                })?,
        ),
        None => None,
    };
    let profile_id = match entry {
        Some(entry) => Some(
            entry
                .model_protocol_profile_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "model_protocol.profile_declaration_missing: profileId is missing for Bailian model '{model}'"
                    )
                })?,
        ),
        None => None,
    };
    let profile_version = match entry {
        Some(entry) => Some(entry.model_protocol_profile_version.ok_or_else(|| {
            format!(
                "model_protocol.profile_declaration_missing: profileVersion is missing for Bailian model '{model}'"
            )
        })?),
        None => None,
    };
    // A selected v1 row is an explicit declaration: preserve its missing-field
    // error before model lookup. Gateway preflight independently rejects unknown
    // voice identities before transport. V2 advisory projections never enter here.
    if binding.is_none() && lookup_model_protocol_profiles_for_inspection(model)
        .map_err(|error| error.to_string())?.is_empty() {
        return Err("model_protocol.model_not_registered: model has no built-in authority or explicit binding".to_string());
    }
    let region = provider.region.as_deref().unwrap_or("");
    let endpoint_host = url::Url::parse(provider.base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .ok_or_else(|| {
            format!(
                "model_protocol.endpoint_host_required: Bailian model '{model}' requires a valid endpoint host"
            )
        })?;
    let authorize = |audio_input, audio_output| {
        crate::provider::model_protocol_profile::authorize_model_protocol_invocation_with_binding(ModelProtocolAuthorizationRequest {
            exact_model_id: model,
            operation,
            transport: &provider.transport,
            region,
            endpoint_host: &endpoint_host,
            audio_input,
            audio_output,
            declared_registry_version: registry_version,
            declared_profile_id: profile_id,
            declared_profile_version: profile_version,
            declared_wire_dialect: None,
            declared_endpoint_family: None,
            declared_terminal_lifecycle: None,
        }, binding)
        .map_err(|error| {
            format!(
                "{}: Bailian model '{}' is not authorized for operation={} transport={} region={} endpointHost={}",
                error, model, operation, provider.transport, region, endpoint_host
            )
        })
    };
    // Resolve the exact manifest identity first. Only an enabled typed adapter
    // may then supply its audited production media contract; model-name or UI
    // capability metadata never selects these values.
    let inspected_authority = authorize(None, None)?;
    let realtime_codec = if crate::audio::bailian_dialogue::is_supported_authority(&inspected_authority) { "pcm" } else { "pcm16" };
    let authority = if crate::audio::bailian_protocol::is_supported_authority(&inspected_authority)
        || crate::audio::bailian_dialogue::is_supported_authority(&inspected_authority) {
        authorize(
            Some(ModelProtocolRequestedAudio {
                codec: realtime_codec,
                sample_rate_hz: 16_000,
                channels: 1,
            }),
            Some(ModelProtocolRequestedAudio {
                codec: realtime_codec,
                sample_rate_hz: 24_000,
                channels: 1,
            }),
        )?
    } else if inspected_authority.adapter_id == "desktop-qwen-audio-task-asr-v1" {
        authorize(Some(ModelProtocolRequestedAudio { codec: "pcm", sample_rate_hz: 16_000, channels: 1 }), None)?
    } else if inspected_authority.adapter_id == "desktop-qwen-audio-task-tts-v1" {
        authorize(None, Some(ModelProtocolRequestedAudio { codec: "pcm", sample_rate_hz: 24_000, channels: 1 }))?
    } else { inspected_authority };
    if binding.is_some() {
        let endpoint = url::Url::parse(provider.base_url.trim()).map_err(|_| "model_protocol.endpoint_host_required".to_string())?;
        let path = endpoint.path().trim_end_matches('/');
        if !matches!(endpoint.scheme(), "https" | "wss") || !endpoint.username().is_empty() || endpoint.password().is_some()
            || !["", "/api/v1", "/compatible-mode/v1", "/api-ws/v1/realtime", "/api-ws/v1/inference"].contains(&path) {
            return Err("model_protocol.endpoint_family_mismatch: explicit binding requires an official secure endpoint path".to_string());
        }
    }
    if bailian_protocol_from_authority(&authority).is_none()
        && !(authority.adapter_id == "desktop-qwen-audio-task-tts-v1" && authority.wire_dialect == "bailian-speech-synthesizer-duplex-task-ws-v1") {
        return Err(format!(
            "model_protocol.adapter_unavailable: authorized wire dialect '{}' has no Desktop route adapter",
            authority.wire_dialect
        ));
    }
    Ok(authority)
}

pub(crate) fn authorize_bailian_realtime(provider: &ProviderDraftInput) -> Result<AuthorizedModelProtocolProfile, String> {
    let operation = primary_bailian_operation(provider, &provider.model)?;
    authorize_bailian_model_operation(provider, &provider.model, operation)
}

pub(crate) fn authorize_bailian_native_translate(
    provider: &ProviderDraftInput,
) -> Result<AuthorizedModelProtocolProfile, String> {
    authorize_bailian_model_operation(provider, &provider.model, "native_translate")
}

pub(crate) fn authorize_bailian_model_operation(
    provider: &ProviderDraftInput,
    model: &str,
    operation: &str,
) -> Result<AuthorizedModelProtocolProfile, String> {
    if !is_dashscope_provider(provider) {
        return Err(
            "model_protocol.provider_family_mismatch: provider is not Bailian/DashScope"
                .to_string(),
        );
    }
    resolve_bailian_model_protocol_authority(provider, model, operation)
}
