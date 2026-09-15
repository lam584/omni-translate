use super::*;

pub(super) fn parse_realtime_protocol(value: &str) -> Option<RealtimeProtocol> {
    match value.trim() {
        "dashscope-omni" => Some(RealtimeProtocol::DashscopeOmni),
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
    match authority.wire_dialect.as_str() {
        "bailian-livetranslate-session-ws-v1" => {
            Some(RealtimeProtocol::DashscopeLivetranslate)
        }
        _ => None,
    }
}

pub(super) fn resolve_bailian_model_protocol_authority(
    provider: &ProviderDraftInput,
    model: &str,
    operation: &str,
) -> Result<AuthorizedModelProtocolProfile, String> {
    let entry = selected_registry_entry(provider, model);
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
        authorize_model_protocol_invocation(ModelProtocolAuthorizationRequest {
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
        })
        .map_err(|error| {
            format!(
                "{}: Bailian model '{}' is not authorized for operation={} transport={} region={} endpointHost={}",
                error.code(), model, operation, provider.transport, region, endpoint_host
            )
        })
    };
    // Resolve the exact manifest identity first. Only an enabled typed adapter
    // may then supply its audited production media contract; model-name or UI
    // capability metadata never selects these values.
    let inspected_authority = authorize(None, None)?;
    let authority = if inspected_authority.adapter_id == "desktop-livetranslate-session-v1" {
        authorize(
            Some(ModelProtocolRequestedAudio {
                codec: "pcm16",
                sample_rate_hz: 16_000,
                channels: 1,
            }),
            Some(ModelProtocolRequestedAudio {
                codec: "pcm16",
                sample_rate_hz: 24_000,
                channels: 1,
            }),
        )?
    } else {
        inspected_authority
    };
    if bailian_protocol_from_authority(&authority).is_none() {
        return Err(format!(
            "model_protocol.adapter_unavailable: authorized wire dialect '{}' has no Desktop route adapter",
            authority.wire_dialect
        ));
    }
    Ok(authority)
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
