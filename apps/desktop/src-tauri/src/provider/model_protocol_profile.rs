use std::fmt;
use std::sync::OnceLock;

use serde::Deserialize;

const REGISTRY_JSON: &str = include_str!(
    "../../../../../contracts/model-protocol-profiles.v1.json"
);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProtocolRegistry {
    registry_version: String,
    checked_at: String,
    endpoint_host_policies: Vec<ModelProtocolEndpointHostPolicy>,
    dialects: Vec<ModelProtocolDialect>,
    profiles: Vec<ModelProtocolProfile>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProtocolEndpointHostPolicy {
    region: String,
    allowed_host_families: Vec<ModelProtocolEndpointHostRule>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProtocolEndpointHostRule {
    host_family_id: String,
    host_pattern: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProtocolDialect {
    dialect_id: String,
    dialect_version: u32,
    transport: String,
    endpoint_family: String,
    endpoint_path: String,
    model_placement: String,
    input_framing: String,
    output_framing: String,
    turn_control: String,
    preview_semantics: String,
    text_event_semantics: Vec<ModelProtocolTextEventSemantic>,
    commit_semantics: String,
    response_trigger: String,
    terminal_lifecycle: String,
    reuse_policy: String,
    region_policy: String,
    audio_input: ModelProtocolAudioDirection,
    audio_output: ModelProtocolAudioDirection,
    client_event_types: Vec<String>,
    server_event_types: Vec<String>,
    client_json_base64_event_types: Vec<String>,
    client_binary_event_types: Vec<String>,
    server_json_base64_event_types: Vec<String>,
    server_binary_event_types: Vec<String>,
    wire_fixture: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProtocolTextEventSemantic {
    pub(crate) event_type: String,
    pub(crate) update_mode: String,
    pub(crate) identity_keys: Vec<String>,
    pub(crate) preview_fields: Vec<String>,
    pub(crate) final_event_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProtocolAudioDirection {
    pub(crate) required: bool,
    pub(crate) codecs: Vec<String>,
    pub(crate) sample_rates_hz: Vec<u32>,
    pub(crate) channels: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProtocolProfile {
    profile_id: String,
    profile_version: u32,
    product: String,
    exact_model_ids: Vec<String>,
    operations: Vec<String>,
    dialect_id: String,
    regions: Vec<String>,
    model_audio: Option<ModelProtocolProfileAudio>,
    adapter: ModelProtocolAdapter,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ModelProtocolProfileAudio {
    input: ModelProtocolProfileAudioDirection,
    output: ModelProtocolProfileAudioDirection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProtocolProfileAudioDirection {
    pub(crate) required: bool,
    pub(crate) codecs: Vec<String>,
    pub(crate) sample_rate_constraint: ModelProtocolSampleRateConstraint,
    pub(crate) channels: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProtocolSampleRateConstraint {
    pub(crate) kind: String,
    pub(crate) values_hz: Option<Vec<u32>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ModelProtocolRequestedAudio<'a> {
    pub(crate) codec: &'a str,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channels: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedModelProtocolAudioSpec {
    pub(crate) codec: String,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channels: u8,
}

impl From<ModelProtocolRequestedAudio<'_>> for AuthorizedModelProtocolAudioSpec {
    fn from(requested: ModelProtocolRequestedAudio<'_>) -> Self {
        Self {
            codec: requested.codec.to_string(),
            sample_rate_hz: requested.sample_rate_hz,
            channels: requested.channels,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProtocolAdapter {
    status: String,
    adapter_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelProtocolAuthorizationError {
    RegistryInvalid,
    RegistryVersionMismatch,
    ModelNotRegistered,
    ProfileAmbiguous,
    ProfileIdMismatch,
    ProfileVersionMismatch,
    OperationNotSupported,
    DialectNotRegistered,
    TransportMismatch,
    EndpointFamilyMismatch,
    WireDialectMismatch,
    TerminalLifecycleMismatch,
    RegionNotSupported,
    EndpointHostRequired,
    EndpointHostRegionMismatch,
    AudioInputCodecNotSupported,
    AudioInputSampleRateNotSupported,
    AudioInputChannelsNotSupported,
    AudioOutputCodecNotSupported,
    AudioOutputSampleRateNotSupported,
    AudioOutputChannelsNotSupported,
    AdapterUnavailable,
    AuthorizationIdentityMismatch,
    EventNotAllowed,
    FrameKindMismatch,
}

impl ModelProtocolAuthorizationError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::RegistryInvalid => "model_protocol.registry_invalid",
            Self::RegistryVersionMismatch => "model_protocol.registry_version_mismatch",
            Self::ModelNotRegistered => "model_protocol.model_not_registered",
            Self::ProfileAmbiguous => "model_protocol.profile_ambiguous",
            Self::ProfileIdMismatch => "model_protocol.profile_id_mismatch",
            Self::ProfileVersionMismatch => "model_protocol.profile_version_mismatch",
            Self::OperationNotSupported => "model_protocol.operation_not_supported",
            Self::DialectNotRegistered => "model_protocol.dialect_not_registered",
            Self::TransportMismatch => "model_protocol.transport_mismatch",
            Self::EndpointFamilyMismatch => "model_protocol.endpoint_family_mismatch",
            Self::WireDialectMismatch => "model_protocol.wire_dialect_mismatch",
            Self::TerminalLifecycleMismatch => "model_protocol.terminal_lifecycle_mismatch",
            Self::RegionNotSupported => "model_protocol.region_not_supported",
            Self::EndpointHostRequired => "model_protocol.endpoint_host_required",
            Self::EndpointHostRegionMismatch => {
                "model_protocol.endpoint_host_region_mismatch"
            }
            Self::AudioInputCodecNotSupported => {
                "model_protocol.audio_input_codec_not_supported"
            }
            Self::AudioInputSampleRateNotSupported => {
                "model_protocol.audio_input_sample_rate_not_supported"
            }
            Self::AudioInputChannelsNotSupported => {
                "model_protocol.audio_input_channels_not_supported"
            }
            Self::AudioOutputCodecNotSupported => {
                "model_protocol.audio_output_codec_not_supported"
            }
            Self::AudioOutputSampleRateNotSupported => {
                "model_protocol.audio_output_sample_rate_not_supported"
            }
            Self::AudioOutputChannelsNotSupported => {
                "model_protocol.audio_output_channels_not_supported"
            }
            Self::AdapterUnavailable => "model_protocol.adapter_unavailable",
            Self::AuthorizationIdentityMismatch => {
                "model_protocol.authorization_identity_mismatch"
            }
            Self::EventNotAllowed => "model_protocol.event_not_allowed",
            Self::FrameKindMismatch => "model_protocol.frame_kind_mismatch",
        }
    }
}

impl fmt::Display for ModelProtocolAuthorizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ModelProtocolAuthorizationError {}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ModelProtocolAuthorizationRequest<'a> {
    pub(crate) exact_model_id: &'a str,
    pub(crate) operation: &'a str,
    pub(crate) transport: &'a str,
    pub(crate) region: &'a str,
    pub(crate) endpoint_host: &'a str,
    pub(crate) audio_input: Option<ModelProtocolRequestedAudio<'a>>,
    pub(crate) audio_output: Option<ModelProtocolRequestedAudio<'a>>,
    pub(crate) declared_registry_version: Option<&'a str>,
    pub(crate) declared_profile_id: Option<&'a str>,
    pub(crate) declared_profile_version: Option<u32>,
    pub(crate) declared_wire_dialect: Option<&'a str>,
    pub(crate) declared_endpoint_family: Option<&'a str>,
    pub(crate) declared_terminal_lifecycle: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedModelProtocolProfile {
    pub(crate) registry_version: String,
    pub(crate) registry_checked_at: String,
    pub(crate) provider_family: &'static str,
    pub(crate) exact_model_id: String,
    pub(crate) profile_id: String,
    pub(crate) profile_version: u32,
    pub(crate) product: String,
    pub(crate) operation: String,
    pub(crate) transport: String,
    pub(crate) region: String,
    pub(crate) endpoint_host: String,
    pub(crate) endpoint_host_family_id: String,
    pub(crate) endpoint_family: String,
    pub(crate) endpoint_path: String,
    pub(crate) model_placement: String,
    pub(crate) wire_dialect: String,
    pub(crate) wire_dialect_version: u32,
    pub(crate) input_framing: String,
    pub(crate) output_framing: String,
    pub(crate) turn_control: String,
    pub(crate) preview_semantics: String,
    pub(crate) text_event_semantics: Vec<ModelProtocolTextEventSemantic>,
    pub(crate) commit_semantics: String,
    pub(crate) response_trigger: String,
    pub(crate) terminal_lifecycle: String,
    pub(crate) reuse_policy: String,
    pub(crate) region_policy: String,
    pub(crate) audio_input: ModelProtocolAudioDirection,
    pub(crate) audio_output: ModelProtocolAudioDirection,
    pub(crate) audio_input_constraint: ModelProtocolProfileAudioDirection,
    pub(crate) audio_output_constraint: ModelProtocolProfileAudioDirection,
    pub(crate) requested_audio_input: Option<AuthorizedModelProtocolAudioSpec>,
    pub(crate) requested_audio_output: Option<AuthorizedModelProtocolAudioSpec>,
    pub(crate) client_event_types: Vec<String>,
    pub(crate) server_event_types: Vec<String>,
    pub(crate) client_json_base64_event_types: Vec<String>,
    pub(crate) client_binary_event_types: Vec<String>,
    pub(crate) server_json_base64_event_types: Vec<String>,
    pub(crate) server_binary_event_types: Vec<String>,
    pub(crate) adapter_id: String,
    pub(crate) wire_fixture: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ModelProtocolProfileInspection {
    pub(crate) registry_version: String,
    pub(crate) registry_checked_at: String,
    pub(crate) exact_model_id: String,
    pub(crate) profile_id: String,
    pub(crate) profile_version: u32,
    pub(crate) product: String,
    pub(crate) operations: Vec<String>,
    pub(crate) adapter_status: String,
    pub(crate) adapter_id: Option<String>,
    pub(crate) transport: String,
    pub(crate) endpoint_family: String,
    pub(crate) endpoint_path: String,
    pub(crate) model_placement: String,
    pub(crate) wire_dialect: String,
    pub(crate) wire_dialect_version: u32,
    pub(crate) input_framing: String,
    pub(crate) output_framing: String,
    pub(crate) terminal_lifecycle: String,
    pub(crate) text_event_semantics: Vec<ModelProtocolTextEventSemantic>,
    pub(crate) client_event_types: Vec<String>,
    pub(crate) server_event_types: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelProtocolEventDirection {
    Client,
    Server,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelProtocolFrameKind {
    Json,
    JsonBase64,
    Binary,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ModelProtocolEventAdmissionRequest<'a> {
    pub(crate) direction: ModelProtocolEventDirection,
    pub(crate) event_type: &'a str,
    pub(crate) frame_kind: ModelProtocolFrameKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedModelProtocolEvent {
    pub(crate) profile_id: String,
    pub(crate) profile_version: u32,
    pub(crate) wire_dialect: String,
    pub(crate) direction: ModelProtocolEventDirection,
    pub(crate) event_type: String,
    pub(crate) frame_kind: ModelProtocolFrameKind,
}

fn registry() -> Result<&'static ModelProtocolRegistry, ModelProtocolAuthorizationError> {
    static REGISTRY: OnceLock<Result<ModelProtocolRegistry, String>> = OnceLock::new();
    match REGISTRY.get_or_init(|| {
        serde_json::from_str(REGISTRY_JSON).map_err(|error| error.to_string())
    }) {
        Ok(registry) => Ok(registry),
        Err(_) => Err(ModelProtocolAuthorizationError::RegistryInvalid),
    }
}

fn profiles_for_model<'a>(
    registry: &'a ModelProtocolRegistry,
    exact_model_id: &str,
) -> Vec<&'a ModelProtocolProfile> {
    if exact_model_id.is_empty() || exact_model_id.trim() != exact_model_id {
        return Vec::new();
    }
    registry
        .profiles
        .iter()
        .filter(|profile| {
            profile
                .exact_model_ids
                .iter()
                .any(|model_id| model_id == exact_model_id)
        })
        .collect()
}

fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    let Some(suffix) = pattern.strip_prefix('*') else {
        return host == pattern;
    };
    if !suffix.starts_with('.') || !host.ends_with(suffix) {
        return false;
    }
    let prefix = &host[..host.len().saturating_sub(suffix.len())];
    if prefix.is_empty() || prefix.len() > 63 || prefix.contains('.') {
        return false;
    }
    let bytes = prefix.as_bytes();
    bytes
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn resolve_endpoint_host_family<'a>(
    registry: &'a ModelProtocolRegistry,
    region: &str,
    endpoint_host: &str,
) -> Result<(String, &'a str), ModelProtocolAuthorizationError> {
    let endpoint_host = endpoint_host.trim().to_ascii_lowercase();
    if endpoint_host.is_empty() {
        return Err(ModelProtocolAuthorizationError::EndpointHostRequired);
    }
    if !endpoint_host
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-'))
    {
        return Err(ModelProtocolAuthorizationError::EndpointHostRegionMismatch);
    }
    let rule = registry
        .endpoint_host_policies
        .iter()
        .find(|policy| policy.region == region)
        .and_then(|policy| {
            policy.allowed_host_families.iter().find(|rule| {
                host_matches_pattern(&endpoint_host, &rule.host_pattern)
            })
        })
        .ok_or(ModelProtocolAuthorizationError::EndpointHostRegionMismatch)?;
    Ok((endpoint_host, &rule.host_family_id))
}

fn materialize_audio_constraint(
    profile_constraint: Option<&ModelProtocolProfileAudioDirection>,
    dialect_direction: &ModelProtocolAudioDirection,
) -> ModelProtocolProfileAudioDirection {
    profile_constraint.cloned().unwrap_or_else(|| {
        let sample_rate_constraint = if !dialect_direction.required
            && dialect_direction.sample_rates_hz.is_empty()
        {
            ModelProtocolSampleRateConstraint {
                kind: "not-applicable".to_string(),
                values_hz: None,
            }
        } else {
            ModelProtocolSampleRateConstraint {
                kind: "allow-list".to_string(),
                values_hz: Some(dialect_direction.sample_rates_hz.clone()),
            }
        };
        ModelProtocolProfileAudioDirection {
            required: dialect_direction.required,
            codecs: dialect_direction.codecs.clone(),
            sample_rate_constraint,
            channels: dialect_direction.channels.clone(),
        }
    })
}

fn validate_requested_audio(
    requested: Option<ModelProtocolRequestedAudio<'_>>,
    constraint: &ModelProtocolProfileAudioDirection,
    codec_error: ModelProtocolAuthorizationError,
    sample_rate_error: ModelProtocolAuthorizationError,
    channels_error: ModelProtocolAuthorizationError,
) -> Result<(), ModelProtocolAuthorizationError> {
    let Some(requested) = requested else {
        return Ok(());
    };
    if !constraint.codecs.iter().any(|codec| codec == requested.codec) {
        return Err(codec_error);
    }
    let valid_sample_rate = match constraint.sample_rate_constraint.kind.as_str() {
        "allow-list" => constraint
            .sample_rate_constraint
            .values_hz
            .as_ref()
            .is_some_and(|rates| rates.contains(&requested.sample_rate_hz)),
        "any-positive-integer" => requested.sample_rate_hz > 0,
        "not-applicable" => false,
        _ => false,
    };
    if !valid_sample_rate {
        return Err(sample_rate_error);
    }
    if !constraint.channels.contains(&requested.channels) {
        return Err(channels_error);
    }
    Ok(())
}

/// Exact, read-only manifest inspection for diagnostics and migration tests.
///
/// This function never grants connection authority. In particular, a
/// `manifest-only` result must still fail `authorize_model_protocol_invocation`
/// with `model_protocol.adapter_unavailable`.
pub(crate) fn lookup_model_protocol_profiles_for_inspection(
    exact_model_id: &str,
) -> Result<Vec<ModelProtocolProfileInspection>, ModelProtocolAuthorizationError> {
    let registry = registry()?;
    let mut inspections = Vec::new();
    for profile in profiles_for_model(registry, exact_model_id) {
        let dialect = registry
            .dialects
            .iter()
            .find(|dialect| dialect.dialect_id == profile.dialect_id)
            .ok_or(ModelProtocolAuthorizationError::DialectNotRegistered)?;
        inspections.push(ModelProtocolProfileInspection {
            registry_version: registry.registry_version.clone(),
            registry_checked_at: registry.checked_at.clone(),
            exact_model_id: exact_model_id.to_string(),
            profile_id: profile.profile_id.clone(),
            profile_version: profile.profile_version,
            product: profile.product.clone(),
            operations: profile.operations.clone(),
            adapter_status: profile.adapter.status.clone(),
            adapter_id: profile.adapter.adapter_id.clone(),
            transport: dialect.transport.clone(),
            endpoint_family: dialect.endpoint_family.clone(),
            endpoint_path: dialect.endpoint_path.clone(),
            model_placement: dialect.model_placement.clone(),
            wire_dialect: dialect.dialect_id.clone(),
            wire_dialect_version: dialect.dialect_version,
            input_framing: dialect.input_framing.clone(),
            output_framing: dialect.output_framing.clone(),
            terminal_lifecycle: dialect.terminal_lifecycle.clone(),
            text_event_semantics: dialect.text_event_semantics.clone(),
            client_event_types: dialect.client_event_types.clone(),
            server_event_types: dialect.server_event_types.clone(),
        });
    }
    Ok(inspections)
}

pub(crate) fn authorize_model_protocol_invocation(
    request: ModelProtocolAuthorizationRequest<'_>,
) -> Result<AuthorizedModelProtocolProfile, ModelProtocolAuthorizationError> {
    let registry = registry()?;
    if request
        .declared_registry_version
        .is_some_and(|version| version != registry.registry_version)
    {
        return Err(ModelProtocolAuthorizationError::RegistryVersionMismatch);
    }

    let candidates = profiles_for_model(registry, request.exact_model_id);
    if candidates.is_empty() {
        return Err(ModelProtocolAuthorizationError::ModelNotRegistered);
    }
    let profile = if let Some(declared_profile_id) = request.declared_profile_id {
        candidates
            .into_iter()
            .find(|profile| profile.profile_id == declared_profile_id)
            .ok_or(ModelProtocolAuthorizationError::ProfileIdMismatch)?
    } else if candidates.len() == 1 {
        candidates[0]
    } else {
        return Err(ModelProtocolAuthorizationError::ProfileAmbiguous);
    };

    if request
        .declared_profile_version
        .is_some_and(|version| version != profile.profile_version)
    {
        return Err(ModelProtocolAuthorizationError::ProfileVersionMismatch);
    }
    if !profile
        .operations
        .iter()
        .any(|operation| operation == request.operation)
    {
        return Err(ModelProtocolAuthorizationError::OperationNotSupported);
    }
    let dialect = registry
        .dialects
        .iter()
        .find(|dialect| dialect.dialect_id == profile.dialect_id)
        .ok_or(ModelProtocolAuthorizationError::DialectNotRegistered)?;
    if dialect.transport != request.transport {
        return Err(ModelProtocolAuthorizationError::TransportMismatch);
    }
    if request
        .declared_endpoint_family
        .is_some_and(|family| family != dialect.endpoint_family)
    {
        return Err(ModelProtocolAuthorizationError::EndpointFamilyMismatch);
    }
    if request
        .declared_wire_dialect
        .is_some_and(|wire_dialect| wire_dialect != dialect.dialect_id)
    {
        return Err(ModelProtocolAuthorizationError::WireDialectMismatch);
    }
    if request
        .declared_terminal_lifecycle
        .is_some_and(|lifecycle| lifecycle != dialect.terminal_lifecycle)
    {
        return Err(ModelProtocolAuthorizationError::TerminalLifecycleMismatch);
    }
    if !profile.regions.iter().any(|region| region == request.region) {
        return Err(ModelProtocolAuthorizationError::RegionNotSupported);
    }
    let (endpoint_host, endpoint_host_family_id) = resolve_endpoint_host_family(
        registry,
        request.region,
        request.endpoint_host,
    )?;
    let audio_input_constraint = materialize_audio_constraint(
        profile.model_audio.as_ref().map(|audio| &audio.input),
        &dialect.audio_input,
    );
    let audio_output_constraint = materialize_audio_constraint(
        profile.model_audio.as_ref().map(|audio| &audio.output),
        &dialect.audio_output,
    );
    validate_requested_audio(
        request.audio_input,
        &audio_input_constraint,
        ModelProtocolAuthorizationError::AudioInputCodecNotSupported,
        ModelProtocolAuthorizationError::AudioInputSampleRateNotSupported,
        ModelProtocolAuthorizationError::AudioInputChannelsNotSupported,
    )?;
    validate_requested_audio(
        request.audio_output,
        &audio_output_constraint,
        ModelProtocolAuthorizationError::AudioOutputCodecNotSupported,
        ModelProtocolAuthorizationError::AudioOutputSampleRateNotSupported,
        ModelProtocolAuthorizationError::AudioOutputChannelsNotSupported,
    )?;
    if profile.adapter.status != "enabled" {
        return Err(ModelProtocolAuthorizationError::AdapterUnavailable);
    }
    let adapter_id = profile
        .adapter
        .adapter_id
        .as_deref()
        .filter(|adapter_id| !adapter_id.is_empty())
        .ok_or(ModelProtocolAuthorizationError::AdapterUnavailable)?;

    Ok(AuthorizedModelProtocolProfile {
        registry_version: registry.registry_version.clone(),
        registry_checked_at: registry.checked_at.clone(),
        provider_family: "bailian",
        exact_model_id: request.exact_model_id.to_string(),
        profile_id: profile.profile_id.clone(),
        profile_version: profile.profile_version,
        product: profile.product.clone(),
        operation: request.operation.to_string(),
        transport: dialect.transport.clone(),
        region: request.region.to_string(),
        endpoint_host,
        endpoint_host_family_id: endpoint_host_family_id.to_string(),
        endpoint_family: dialect.endpoint_family.clone(),
        endpoint_path: dialect.endpoint_path.clone(),
        model_placement: dialect.model_placement.clone(),
        wire_dialect: dialect.dialect_id.clone(),
        wire_dialect_version: dialect.dialect_version,
        input_framing: dialect.input_framing.clone(),
        output_framing: dialect.output_framing.clone(),
        turn_control: dialect.turn_control.clone(),
        preview_semantics: dialect.preview_semantics.clone(),
        text_event_semantics: dialect.text_event_semantics.clone(),
        commit_semantics: dialect.commit_semantics.clone(),
        response_trigger: dialect.response_trigger.clone(),
        terminal_lifecycle: dialect.terminal_lifecycle.clone(),
        reuse_policy: dialect.reuse_policy.clone(),
        region_policy: dialect.region_policy.clone(),
        audio_input: dialect.audio_input.clone(),
        audio_output: dialect.audio_output.clone(),
        audio_input_constraint,
        audio_output_constraint,
        requested_audio_input: request.audio_input.map(Into::into),
        requested_audio_output: request.audio_output.map(Into::into),
        client_event_types: dialect.client_event_types.clone(),
        server_event_types: dialect.server_event_types.clone(),
        client_json_base64_event_types: dialect.client_json_base64_event_types.clone(),
        client_binary_event_types: dialect.client_binary_event_types.clone(),
        server_json_base64_event_types: dialect.server_json_base64_event_types.clone(),
        server_binary_event_types: dialect.server_binary_event_types.clone(),
        adapter_id: adapter_id.to_string(),
        wire_fixture: dialect.wire_fixture.clone(),
    })
}

fn expected_frame_kind(
    dialect: &ModelProtocolDialect,
    direction: ModelProtocolEventDirection,
    event_type: &str,
) -> ModelProtocolFrameKind {
    let (binary_events, base64_events) = match direction {
        ModelProtocolEventDirection::Client => (
            &dialect.client_binary_event_types,
            &dialect.client_json_base64_event_types,
        ),
        ModelProtocolEventDirection::Server => (
            &dialect.server_binary_event_types,
            &dialect.server_json_base64_event_types,
        ),
    };
    if binary_events.iter().any(|candidate| candidate == event_type) {
        ModelProtocolFrameKind::Binary
    } else if base64_events
        .iter()
        .any(|candidate| candidate == event_type)
    {
        ModelProtocolFrameKind::JsonBase64
    } else {
        ModelProtocolFrameKind::Json
    }
}

pub(crate) fn admit_model_protocol_event(
    authorization: &AuthorizedModelProtocolProfile,
    request: ModelProtocolEventAdmissionRequest<'_>,
) -> Result<AuthorizedModelProtocolEvent, ModelProtocolAuthorizationError> {
    let registry = registry()?;
    let profile = registry.profiles.iter().find(|profile| {
        profile.profile_id == authorization.profile_id
            && profile.profile_version == authorization.profile_version
            && profile
                .exact_model_ids
                .iter()
                .any(|model_id| model_id == &authorization.exact_model_id)
    });
    let dialect = registry
        .dialects
        .iter()
        .find(|dialect| dialect.dialect_id == authorization.wire_dialect);
    let Some((profile, dialect)) = profile.zip(dialect) else {
        return Err(ModelProtocolAuthorizationError::AuthorizationIdentityMismatch);
    };
    let endpoint_authority = resolve_endpoint_host_family(
        registry,
        &authorization.region,
        &authorization.endpoint_host,
    )
    .map_err(|_| ModelProtocolAuthorizationError::AuthorizationIdentityMismatch)?;
    let expected_audio_input_constraint = materialize_audio_constraint(
        profile.model_audio.as_ref().map(|audio| &audio.input),
        &dialect.audio_input,
    );
    let expected_audio_output_constraint = materialize_audio_constraint(
        profile.model_audio.as_ref().map(|audio| &audio.output),
        &dialect.audio_output,
    );
    let expected_adapter_audio = match authorization.adapter_id.as_str() {
        "desktop-livetranslate-session-v1" => Some((
            AuthorizedModelProtocolAudioSpec {
                codec: "pcm16".to_string(),
                sample_rate_hz: 16_000,
                channels: 1,
            },
            AuthorizedModelProtocolAudioSpec {
                codec: "pcm16".to_string(),
                sample_rate_hz: 24_000,
                channels: 1,
            },
        )),
        _ => None,
    };
    if registry.registry_version != authorization.registry_version
        || registry.checked_at != authorization.registry_checked_at
        || authorization.provider_family != "bailian"
        || profile.product != authorization.product
        || !profile
            .operations
            .iter()
            .any(|operation| operation == &authorization.operation)
        || !profile
            .regions
            .iter()
            .any(|region| region == &authorization.region)
        || profile.dialect_id != dialect.dialect_id
        || dialect.dialect_version != authorization.wire_dialect_version
        || dialect.transport != authorization.transport
        || dialect.endpoint_family != authorization.endpoint_family
        || dialect.endpoint_path != authorization.endpoint_path
        || dialect.model_placement != authorization.model_placement
        || dialect.input_framing != authorization.input_framing
        || dialect.output_framing != authorization.output_framing
        || dialect.turn_control != authorization.turn_control
        || dialect.preview_semantics != authorization.preview_semantics
        || dialect.text_event_semantics != authorization.text_event_semantics
        || dialect.commit_semantics != authorization.commit_semantics
        || dialect.response_trigger != authorization.response_trigger
        || dialect.terminal_lifecycle != authorization.terminal_lifecycle
        || dialect.reuse_policy != authorization.reuse_policy
        || dialect.region_policy != authorization.region_policy
        || dialect.audio_input != authorization.audio_input
        || dialect.audio_output != authorization.audio_output
        || dialect.client_event_types != authorization.client_event_types
        || dialect.server_event_types != authorization.server_event_types
        || dialect.client_json_base64_event_types
            != authorization.client_json_base64_event_types
        || dialect.client_binary_event_types != authorization.client_binary_event_types
        || dialect.server_json_base64_event_types
            != authorization.server_json_base64_event_types
        || dialect.server_binary_event_types != authorization.server_binary_event_types
        || dialect.wire_fixture != authorization.wire_fixture
        || endpoint_authority.0 != authorization.endpoint_host
        || endpoint_authority.1 != authorization.endpoint_host_family_id
        || expected_audio_input_constraint != authorization.audio_input_constraint
        || expected_audio_output_constraint != authorization.audio_output_constraint
        || expected_adapter_audio.as_ref().is_none_or(|(input, output)| {
            authorization.requested_audio_input.as_ref() != Some(input)
                || authorization.requested_audio_output.as_ref() != Some(output)
        })
        || profile.adapter.status != "enabled"
        || profile.adapter.adapter_id.as_deref() != Some(authorization.adapter_id.as_str())
    {
        return Err(ModelProtocolAuthorizationError::AuthorizationIdentityMismatch);
    }

    let allowlist = match request.direction {
        ModelProtocolEventDirection::Client => &dialect.client_event_types,
        ModelProtocolEventDirection::Server => &dialect.server_event_types,
    };
    if !allowlist
        .iter()
        .any(|event_type| event_type == request.event_type)
    {
        return Err(ModelProtocolAuthorizationError::EventNotAllowed);
    }
    if expected_frame_kind(dialect, request.direction, request.event_type) != request.frame_kind {
        return Err(ModelProtocolAuthorizationError::FrameKindMismatch);
    }

    Ok(AuthorizedModelProtocolEvent {
        profile_id: authorization.profile_id.clone(),
        profile_version: authorization.profile_version,
        wire_dialect: authorization.wire_dialect.clone(),
        direction: request.direction,
        event_type: request.event_type.to_string(),
        frame_kind: request.frame_kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AuthorizationVectors {
        vectors: Vec<AuthorizationVector>,
    }

    #[derive(Debug, Deserialize)]
    struct AuthorizationVector {
        id: String,
        request: AuthorizationVectorRequest,
        expect: AuthorizationVectorExpectation,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AuthorizationVectorRequest {
        exact_model_id: String,
        operation: String,
        transport: String,
        region: String,
        endpoint_host: Option<String>,
        audio_input: Option<AuthorizationVectorAudio>,
        audio_output: Option<AuthorizationVectorAudio>,
        declared_registry_version: Option<String>,
        declared_profile_id: Option<String>,
        declared_profile_version: Option<u32>,
        declared_wire_dialect: Option<String>,
        declared_endpoint_family: Option<String>,
        declared_terminal_lifecycle: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AuthorizationVectorAudio {
        codec: String,
        sample_rate_hz: u32,
        channels: u8,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AuthorizationVectorExpectation {
        ok: bool,
        error_code: Option<String>,
        profile_id: Option<String>,
        profile_version: Option<u32>,
        wire_dialect: Option<String>,
        endpoint_family: Option<String>,
        endpoint_host_family_id: Option<String>,
        terminal_lifecycle: Option<String>,
    }

    impl AuthorizationVectorRequest {
        fn as_request(&self) -> ModelProtocolAuthorizationRequest<'_> {
            ModelProtocolAuthorizationRequest {
                exact_model_id: &self.exact_model_id,
                operation: &self.operation,
                transport: &self.transport,
                region: &self.region,
                endpoint_host: self.endpoint_host.as_deref().unwrap_or_default(),
                audio_input: self.audio_input.as_ref().map(|audio| {
                    ModelProtocolRequestedAudio {
                        codec: &audio.codec,
                        sample_rate_hz: audio.sample_rate_hz,
                        channels: audio.channels,
                    }
                }),
                audio_output: self.audio_output.as_ref().map(|audio| {
                    ModelProtocolRequestedAudio {
                        codec: &audio.codec,
                        sample_rate_hz: audio.sample_rate_hz,
                        channels: audio.channels,
                    }
                }),
                declared_registry_version: self.declared_registry_version.as_deref(),
                declared_profile_id: self.declared_profile_id.as_deref(),
                declared_profile_version: self.declared_profile_version,
                declared_wire_dialect: self.declared_wire_dialect.as_deref(),
                declared_endpoint_family: self.declared_endpoint_family.as_deref(),
                declared_terminal_lifecycle: self.declared_terminal_lifecycle.as_deref(),
            }
        }
    }

    fn livetranslate_authority() -> AuthorizedModelProtocolProfile {
        authorize_model_protocol_invocation(ModelProtocolAuthorizationRequest {
            exact_model_id: "qwen3.5-livetranslate-flash-realtime",
            operation: "native_translate",
            transport: "websocket",
            region: "cn-beijing",
            endpoint_host: "dashscope.aliyuncs.com",
            audio_input: Some(ModelProtocolRequestedAudio {
                codec: "pcm16",
                sample_rate_hz: 16_000,
                channels: 1,
            }),
            audio_output: Some(ModelProtocolRequestedAudio {
                codec: "pcm16",
                sample_rate_hz: 24_000,
                channels: 1,
            }),
            declared_registry_version: None,
            declared_profile_id: None,
            declared_profile_version: None,
            declared_wire_dialect: None,
            declared_endpoint_family: None,
            declared_terminal_lifecycle: None,
        })
        .expect("LiveTranslate v1 profile should be authorized")
    }

    #[test]
    fn shared_authorization_vectors_match_typescript_and_node() {
        let vectors: AuthorizationVectors = serde_json::from_str(include_str!(
            "../../../../../contracts/model-protocol-authorization-v1.vectors.json"
        ))
        .expect("authorization vectors should deserialize");
        for vector in vectors.vectors {
            let result = authorize_model_protocol_invocation(vector.request.as_request());
            assert_eq!(result.is_ok(), vector.expect.ok, "{}", vector.id);
            match result {
                Ok(authorization) => {
                    assert_eq!(Some(&authorization.profile_id), vector.expect.profile_id.as_ref(), "{}", vector.id);
                    assert_eq!(Some(authorization.profile_version), vector.expect.profile_version, "{}", vector.id);
                    assert_eq!(Some(&authorization.wire_dialect), vector.expect.wire_dialect.as_ref(), "{}", vector.id);
                    assert_eq!(Some(&authorization.endpoint_family), vector.expect.endpoint_family.as_ref(), "{}", vector.id);
                    assert_eq!(Some(&authorization.endpoint_host_family_id), vector.expect.endpoint_host_family_id.as_ref(), "{}", vector.id);
                    assert_eq!(Some(&authorization.terminal_lifecycle), vector.expect.terminal_lifecycle.as_ref(), "{}", vector.id);
                }
                Err(error) => assert_eq!(Some(error.code()), vector.expect.error_code.as_deref(), "{}", vector.id),
            }
        }
    }

    #[test]
    fn complete_authority_binds_endpoint_framing_and_terminal() {
        let authorization = livetranslate_authority();
        assert_eq!(authorization.profile_id, "bailian.livetranslate.realtime.ws");
        assert_eq!(authorization.endpoint_path, "/api-ws/v1/realtime");
        assert_eq!(authorization.input_framing, "json-base64");
        assert_eq!(authorization.output_framing, "json-base64");
        assert!(authorization
            .server_event_types
            .iter()
            .any(|event_type| event_type == "response.created"));
        assert_eq!(
            authorization
                .text_event_semantics
                .iter()
                .find(|semantic| semantic.event_type == "response.text.text")
                .map(|semantic| semantic.update_mode.as_str()),
            Some("replaceable-snapshot")
        );
        assert_eq!(
            authorization.terminal_lifecycle,
            "session.finish->session.finished"
        );
    }

    #[test]
    fn exact_manifest_inspection_does_not_grant_task_asr_connection_authority() {
        let inspections = lookup_model_protocol_profiles_for_inspection("fun-asr-realtime")
            .expect("registry should be inspectable");
        assert_eq!(inspections.len(), 1);
        assert_eq!(inspections[0].adapter_status, "manifest-only");
        assert_eq!(inspections[0].endpoint_path, "/api-ws/v1/inference");
        assert_eq!(inspections[0].input_framing, "binary");
        assert_eq!(
            inspections[0].terminal_lifecycle,
            "finish-task->task-finished"
        );
        assert_eq!(
            authorize_model_protocol_invocation(ModelProtocolAuthorizationRequest {
                exact_model_id: "fun-asr-realtime",
                operation: "asr",
                transport: "websocket",
                region: "cn-beijing",
                endpoint_host: "dashscope.aliyuncs.com",
                audio_input: None,
                audio_output: None,
                declared_registry_version: None,
                declared_profile_id: None,
                declared_profile_version: None,
                declared_wire_dialect: None,
                declared_endpoint_family: None,
                declared_terminal_lifecycle: None,
            }),
            Err(ModelProtocolAuthorizationError::AdapterUnavailable)
        );
        assert!(lookup_model_protocol_profiles_for_inspection("fun-asr-realtime-next")
            .expect("registry should be inspectable")
            .is_empty());
    }

    #[test]
    fn event_admission_rejects_omni_delta_before_livetranslate_mutation() {
        let authorization = livetranslate_authority();
        assert!(admit_model_protocol_event(
            &authorization,
            ModelProtocolEventAdmissionRequest {
                direction: ModelProtocolEventDirection::Server,
                event_type: "response.created",
                frame_kind: ModelProtocolFrameKind::Json,
            },
        )
        .is_ok());
        assert_eq!(
            admit_model_protocol_event(
                &authorization,
                ModelProtocolEventAdmissionRequest {
                    direction: ModelProtocolEventDirection::Server,
                    event_type: "response.text.delta",
                    frame_kind: ModelProtocolFrameKind::Json,
                },
            ),
            Err(ModelProtocolAuthorizationError::EventNotAllowed)
        );
        assert!(admit_model_protocol_event(
            &authorization,
            ModelProtocolEventAdmissionRequest {
                direction: ModelProtocolEventDirection::Server,
                event_type: "response.text.text",
                frame_kind: ModelProtocolFrameKind::Json,
            },
        )
        .is_ok());
    }

    #[test]
    fn event_admission_enforces_profile_framing() {
        let authorization = livetranslate_authority();
        assert!(admit_model_protocol_event(
            &authorization,
            ModelProtocolEventAdmissionRequest {
                direction: ModelProtocolEventDirection::Client,
                event_type: "input_audio_buffer.append",
                frame_kind: ModelProtocolFrameKind::JsonBase64,
            },
        )
        .is_ok());
        assert_eq!(
            admit_model_protocol_event(
                &authorization,
                ModelProtocolEventAdmissionRequest {
                    direction: ModelProtocolEventDirection::Server,
                    event_type: "response.audio.delta",
                    frame_kind: ModelProtocolFrameKind::Json,
                },
            ),
            Err(ModelProtocolAuthorizationError::FrameKindMismatch)
        );
        assert!(admit_model_protocol_event(
            &authorization,
            ModelProtocolEventAdmissionRequest {
                direction: ModelProtocolEventDirection::Server,
                event_type: "response.audio.delta",
                frame_kind: ModelProtocolFrameKind::JsonBase64,
            },
        )
        .is_ok());
    }

    #[test]
    fn event_admission_revalidates_every_authorized_protocol_field() {
        let authority = livetranslate_authority();
        let request = ModelProtocolEventAdmissionRequest {
            direction: ModelProtocolEventDirection::Server,
            event_type: "session.created",
            frame_kind: ModelProtocolFrameKind::Json,
        };
        let assert_rejected = |tampered: &AuthorizedModelProtocolProfile, field: &str| {
            assert_eq!(
                admit_model_protocol_event(tampered, request),
                Err(ModelProtocolAuthorizationError::AuthorizationIdentityMismatch),
                "tampering {field} must invalidate the complete authority"
            );
        };

        macro_rules! tamper {
            ($field:ident, $value:expr) => {{
                let mut tampered = authority.clone();
                tampered.$field = $value;
                assert_rejected(&tampered, stringify!($field));
            }};
        }

        tamper!(registry_checked_at, "2099-01-01".to_string());
        tamper!(registry_version, "forged-registry".to_string());
        tamper!(provider_family, "forged-provider");
        tamper!(exact_model_id, "forged-model".to_string());
        tamper!(profile_id, "forged-profile".to_string());
        tamper!(profile_version, 999);
        tamper!(product, "forged-product".to_string());
        tamper!(operation, "dialogue".to_string());
        tamper!(transport, "sse".to_string());
        tamper!(region, "ap-southeast-1".to_string());
        tamper!(endpoint_host, "dashscope-intl.aliyuncs.com".to_string());
        tamper!(endpoint_host_family_id, "forged-host-family".to_string());
        tamper!(endpoint_family, "dashscope-task-v1".to_string());
        tamper!(endpoint_path, "/api-ws/v1/inference".to_string());
        tamper!(model_placement, "payload".to_string());
        tamper!(wire_dialect, "forged-dialect".to_string());
        tamper!(wire_dialect_version, 999);
        tamper!(input_framing, "binary".to_string());
        tamper!(output_framing, "binary".to_string());
        tamper!(turn_control, "forged-turn-control".to_string());
        tamper!(preview_semantics, "append-delta".to_string());
        tamper!(text_event_semantics, Vec::new());
        tamper!(commit_semantics, "response.done".to_string());
        tamper!(response_trigger, "response.create".to_string());
        tamper!(terminal_lifecycle, "owner-close".to_string());
        tamper!(reuse_policy, "multi-turn-session".to_string());
        tamper!(region_policy, "none".to_string());
        tamper!(audio_input, ModelProtocolAudioDirection {
            required: false,
            codecs: vec!["pcm16".to_string()],
            sample_rates_hz: vec![16_000],
            channels: vec![1],
        });
        tamper!(audio_output, ModelProtocolAudioDirection {
            required: true,
            codecs: vec!["pcm16".to_string()],
            sample_rates_hz: vec![24_000],
            channels: vec![1],
        });
        let mut forged_input_constraint = authority.audio_input_constraint.clone();
        forged_input_constraint.codecs = vec!["opus".to_string()];
        tamper!(audio_input_constraint, forged_input_constraint);
        let mut forged_output_constraint = authority.audio_output_constraint.clone();
        forged_output_constraint.channels = vec![2];
        tamper!(audio_output_constraint, forged_output_constraint);
        tamper!(requested_audio_input, None);
        tamper!(requested_audio_output, None);
        tamper!(client_event_types, vec!["session.update".to_string()]);
        tamper!(server_event_types, vec!["session.created".to_string()]);
        tamper!(client_json_base64_event_types, Vec::new());
        tamper!(client_binary_event_types, vec!["binary.audio".to_string()]);
        tamper!(server_json_base64_event_types, Vec::new());
        tamper!(server_binary_event_types, vec!["binary.audio".to_string()]);
        tamper!(adapter_id, "forged-adapter".to_string());
        tamper!(wire_fixture, "forged-fixture.json".to_string());
    }
}
