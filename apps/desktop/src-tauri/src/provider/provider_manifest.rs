use std::sync::OnceLock;

use serde::Deserialize;
use url::Url;

use super::contracts::ProviderDraftInput;
mod capability_metadata;
pub(crate) use capability_metadata::manifest_model_capability_metadata;

const BUNDLE_JSON: &str = include_str!(
    "../../../../../contracts/provider-manifests.compiled.v1.json"
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderManifestBundle {
    schema_version: String,
    manifests: Vec<ProviderManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderManifest {
    manifest_version: u32,
    provider: ProviderIdentity,
    auth_profiles: Vec<AuthProfile>,
    transports: Vec<Transport>,
    audio_profiles: Vec<AudioProfile>,
    lifecycle_profiles: Vec<LifecycleProfile>,
    api_families: Vec<ApiFamily>,
    protocol_profiles: Vec<ProtocolProfile>,
    models: Vec<Model>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderIdentity {
    id: String,
    template_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthProfile {
    id: String,
    #[serde(rename = "type")]
    auth_type: String,
    parameters: Vec<AuthParameter>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthParameter {
    location: String,
    name: String,
    source: String,
    scheme: Option<String>,
    required: bool,
}

#[derive(Debug, Deserialize)]
struct Transport {
    id: String,
    kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiFamily {
    id: String,
    base_url_template: String,
    endpoint_template: Option<String>,
    endpoint_status: String,
    model_addressing: String,
    transport_id: String,
    auth_profile_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolProfile {
    id: String,
    version: u32,
    api_family_id: String,
    transport_id: String,
    auth_profile_ids: Vec<String>,
    default_auth_profile_id: String,
    audio_profile_id: Option<String>,
    lifecycle_profile_id: String,
    operations: Vec<String>,
    capabilities: Vec<String>,
    custom_provider_policy: Option<String>,
    custom_endpoint_policy: Option<String>,
    adapter: Adapter,
}

#[derive(Debug, Deserialize)]
struct AudioProfile {
    id: String,
    input: AudioDirection,
    output: AudioDirection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioDirection {
    formats: Vec<String>,
    sample_rates_hz: Vec<u32>,
    channels: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct Adapter {
    id: String,
    status: String,
    verification: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleProfile {
    id: String,
    vad_modes: Vec<String>,
    #[serde(default)]
    client_events: Vec<String>,
    #[serde(default)]
    server_events: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    id: String,
    capabilities: Vec<String>,
    #[serde(default)]
    capability_metadata: Option<serde_json::Value>,
    protocol_bindings: Vec<ModelBinding>,
}

pub(crate) fn is_builtin_bailian_model(model_id: &str) -> Result<bool, String> {
    Ok(bundle()?.manifests.iter().filter(|manifest| manifest.provider.id == "bailian")
        .any(|manifest| manifest.models.iter().any(|model| model.id == model_id)))
}

pub(crate) fn manifest_model_capabilities(
    provider: &ProviderDraftInput,
    model_id: &str,
) -> Result<Option<Vec<String>>, String> {
    let bundle = bundle()?;
    let Some(manifest) = provider_manifest(bundle, provider)? else {
        return Ok(None);
    };
    Ok(manifest
        .models
        .iter()
        .find(|model| model.id == model_id)
        .map(|model| model.capabilities.clone()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelBinding {
    operation: String,
    protocol_profile_id: String,
    protocol_profile_version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedProviderProtocol {
    pub(crate) manifest_version: u32,
    pub(crate) provider_owner_id: String,
    pub(crate) model_id: String,
    pub(crate) deployment_id: Option<String>,
    pub(crate) operation: String,
    pub(crate) profile_id: String,
    pub(crate) profile_version: u32,
    pub(crate) adapter_id: String,
    pub(crate) adapter_verification: String,
    pub(crate) api_family_id: String,
    pub(crate) endpoint_template: String,
    pub(crate) transport_kind: String,
    pub(crate) auth_profile_id: String,
    pub(crate) canonical_auth_header_name: Option<String>,
    pub(crate) canonical_auth_scheme: Option<String>,
    pub(crate) lifecycle_profile_id: String,
    pub(crate) vad_modes: Vec<String>,
    pub(crate) capabilities: Vec<String>,
    pub(crate) audio_input_format: Option<String>,
    pub(crate) audio_input_sample_rate_hz: Option<u32>,
    pub(crate) audio_input_channels: Option<u8>,
    pub(crate) audio_output_format: Option<String>,
    pub(crate) audio_output_sample_rate_hz: Option<u32>,
    pub(crate) audio_output_channels: Option<u8>,
}

impl AuthorizedProviderProtocol {
    pub(crate) fn wire_model_id(&self) -> &str {
        self.deployment_id.as_deref().unwrap_or(&self.model_id)
    }

    pub(crate) fn provider_for_connection(
        &self,
        provider: &ProviderDraftInput,
    ) -> ProviderDraftInput {
        let mut projected = provider.clone();
        projected.model = self.model_id.clone();
        if let Some(header_name) = &self.canonical_auth_header_name {
            projected.auth_ref.header_name = header_name.clone();
        }
        if self.transport_kind == "sse"
            && self.adapter_id == "openai-compatible-http"
            && provider.transport == "websocket"
            && provider.stream_enabled
        {
            projected.transport = "streaming-http".to_string();
        }
        if let Some(scheme) = &self.canonical_auth_scheme {
            projected.auth_ref.scheme = scheme.clone();
        }
        projected
    }
}

fn bundle() -> Result<&'static ProviderManifestBundle, String> {
    static BUNDLE: OnceLock<Result<ProviderManifestBundle, String>> = OnceLock::new();
    match BUNDLE.get_or_init(|| {
        let parsed: ProviderManifestBundle =
            serde_json::from_str(BUNDLE_JSON).map_err(|error| error.to_string())?;
        if parsed.schema_version != "provider-manifest-bundle/v1" {
            return Err("unsupported provider manifest bundle version".to_string());
        }
        Ok(parsed)
    }) {
        Ok(bundle) => Ok(bundle),
        Err(error) => Err(format!("provider_manifest.registry_invalid: {error}")),
    }
}

fn provider_manifest<'a>(
    bundle: &'a ProviderManifestBundle,
    provider: &ProviderDraftInput,
) -> Result<Option<&'a ProviderManifest>, String> {
    // Workspace is an explicit built-in Bailian template alias, not a model-name
    // heuristic or a way for arbitrary/custom templates to claim another owner.
    let workspace_alias = provider.template_id == "template-dashscope-workspace";
    let owner_template_id = if workspace_alias {
        "template-dashscope-realtime"
    } else {
        provider.template_id.as_str()
    };
    let manifest = bundle
        .manifests
        .iter()
        .find(|manifest| manifest.provider.template_id == owner_template_id
            && (!workspace_alias || manifest.provider.id == "bailian"));
    if workspace_alias {
        if let Some(runtime_owner) = bundle.manifests.iter()
            .find(|candidate| candidate.provider.id == provider.provider_id) {
            if runtime_owner.provider.id != "bailian" {
                return Err(format!(
                    "provider_manifest.provider_owner_mismatch: Workspace template cannot claim runtime owner '{}'",
                    provider.provider_id
                ));
            }
        }
    }
    let declared_owner = provider
        .manifest_provider_id
        .as_deref()
        .filter(|owner| !owner.trim().is_empty());
    match (manifest, declared_owner) {
        (Some(manifest), Some(owner)) if owner != manifest.provider.id => Err(format!(
            "provider_manifest.provider_owner_mismatch: template '{}' belongs to '{}', not '{}'",
            provider.template_id, manifest.provider.id, owner
        )),
        (Some(manifest), _) => Ok(Some(manifest)),
        (None, Some(owner)) => Err(format!(
            "provider_manifest.template_not_registered: template '{}' cannot claim manifest owner '{}'",
            provider.template_id, owner
        )),
        (None, None) => Ok(None),
    }
}

fn replace_template_fields(template: &str) -> String {
    let mut output = String::with_capacity(template.len());
    let mut inside_placeholder = false;
    for character in template.chars() {
        match character {
            '{' if !inside_placeholder => {
                inside_placeholder = true;
                output.push_str("placeholder");
            }
            '}' if inside_placeholder => inside_placeholder = false,
            _ if !inside_placeholder => output.push(character),
            _ => {}
        }
    }
    output
}

fn valid_dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && label.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && label.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
}

fn endpoint_host_matches(base_url: &str, template: &str, endpoint_template: &str) -> bool {
    let Ok(actual) = Url::parse(base_url.trim()) else {
        return false;
    };
    let materialized = replace_template_fields(template);
    let Ok(expected) = Url::parse(&materialized) else {
        return false;
    };
    let Some(actual_host) = actual.host_str() else {
        return false;
    };
    let Some(expected_host) = expected.host_str() else {
        return false;
    };
    let secure_scheme_matches = matches!(actual.scheme(), "https" | "wss")
        && matches!(expected.scheme(), "https" | "wss");
    let normalized_path = |url: &Url| url.path().trim_end_matches('/').to_string();
    let actual_path = normalized_path(&actual);
    let expected_path = normalized_path(&expected);
    let endpoint_path = endpoint_template.split('?').next().unwrap_or(endpoint_template).trim_end_matches('/');
    let path_matches = actual_path == expected_path
        || (!actual_path.is_empty()
            && actual_path != "/"
            && endpoint_path.starts_with(&format!("{actual_path}/")));
    if !secure_scheme_matches
        || !actual.username().is_empty()
        || actual.password().is_some()
        || actual.fragment().is_some()
        || actual.port_or_known_default() != expected.port_or_known_default()
        || !path_matches
    {
        return false;
    }
    let template_host = template
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(rest))
        .unwrap_or("");
    let actual_labels = actual_host.split('.').collect::<Vec<_>>();
    let expected_labels = expected_host.split('.').collect::<Vec<_>>();
    let template_labels = template_host.split('.').collect::<Vec<_>>();
    if actual_labels.len() != expected_labels.len()
        || template_labels.len() != expected_labels.len()
    {
        return false;
    }
    actual_labels
        .iter()
        .zip(expected_labels.iter())
        .zip(template_labels.iter())
        .all(|((actual, expected), source)| {
            if source.starts_with('{') && source.ends_with('}') {
                valid_dns_label(actual)
            } else {
                actual.eq_ignore_ascii_case(expected)
            }
        })
}

fn valid_custom_endpoint(base_url: &str, transport: &str) -> bool {
    let Ok(endpoint) = Url::parse(base_url.trim()) else {
        return false;
    };
    let secure_scheme = endpoint.scheme() == "https"
        || (transport == "websocket" && endpoint.scheme() == "wss");
    secure_scheme
        && endpoint.host_str().is_some()
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.fragment().is_none()
}

fn transport_matches(provider_transport: &str, manifest_transport: &str) -> bool {
    matches!(
        (provider_transport, manifest_transport),
        ("http", "http")
            | ("streaming-http", "sse")
            | ("websocket", "websocket")
            | ("webrtc", "webrtc")
    )
}

fn selected_auth_profile<'a>(
    manifest: &'a ProviderManifest,
    profile: &ProtocolProfile,
    family: &ApiFamily,
    declared_auth_profile_id: Option<&str>,
) -> Result<&'a AuthProfile, String> {
    let selected_id = declared_auth_profile_id
        .unwrap_or(&profile.default_auth_profile_id);
    if !profile.auth_profile_ids.iter().any(|id| id == selected_id)
        || !family.auth_profile_ids.iter().any(|id| id == selected_id)
    {
        return Err(format!(
            "provider_manifest.auth_profile_not_allowed: '{}' is not allowed by profile '{}'",
            selected_id, profile.id
        ));
    }
    manifest
        .auth_profiles
        .iter()
        .find(|auth| auth.id == selected_id)
        .ok_or_else(|| {
            format!(
                "provider_manifest.registry_invalid: auth profile '{}' is missing",
                selected_id
            )
        })
}

fn validate_auth_shape(provider: &ProviderDraftInput, auth: &AuthProfile) -> Result<(), String> {
    let credential_header = auth.parameters.iter().find(|parameter| {
        parameter.location == "header"
            && parameter.source == "credential"
            && parameter.required
    });
    let Some(parameter) = credential_header else {
        // Query signing and multi-part derived credentials are validated by
        // their typed provider adapter after this manifest admission.
        return Ok(());
    };
    if !provider
        .auth_ref
        .header_name
        .trim()
        .eq_ignore_ascii_case(&parameter.name)
    {
        return Err(format!(
            "provider_manifest.auth_header_mismatch: profile '{}' requires header '{}'",
            auth.id, parameter.name
        ));
    }
    let expected_scheme = match parameter.scheme.as_deref() {
        Some(scheme) if scheme.eq_ignore_ascii_case("bearer") => "bearer",
        Some(scheme) if scheme.eq_ignore_ascii_case("token") => "api-key",
        _ if auth.auth_type == "bearer" => "bearer",
        _ => "api-key",
    };
    if provider.auth_ref.scheme != expected_scheme {
        return Err(format!(
            "provider_manifest.auth_scheme_mismatch: profile '{}' requires scheme '{}'",
            auth.id, expected_scheme
        ));
    }
    Ok(())
}

fn canonical_auth_shape(auth: &AuthProfile) -> (Option<String>, Option<String>) {
    let credential_header = auth.parameters.iter().find(|parameter| {
        parameter.location == "header"
            && parameter.source == "credential"
            && parameter.required
    });
    let Some(parameter) = credential_header else {
        return (None, None);
    };
    let scheme = match parameter.scheme.as_deref() {
        Some(value) if value.eq_ignore_ascii_case("bearer") => "bearer",
        Some(value) if value.eq_ignore_ascii_case("token") => "api-key",
        _ if auth.auth_type == "bearer" => "bearer",
        _ => "api-key",
    };
    (Some(parameter.name.clone()), Some(scheme.to_string()))
}

pub(crate) fn authorize_provider_operation(
    provider: &ProviderDraftInput,
    operation: &str,
) -> Result<Option<AuthorizedProviderProtocol>, String> {
    authorize_provider_operation_for_model(provider, &provider.model, operation)
}

pub(crate) fn authorize_provider_operation_for_model(
    provider: &ProviderDraftInput,
    model_id: &str,
    operation: &str,
) -> Result<Option<AuthorizedProviderProtocol>, String> {
    if model_id.trim().is_empty() {
        return Err("provider_manifest.model_id_required: invocation model must not be empty".to_string());
    }
    let bundle = bundle()?;
    let registered_manifest = provider_manifest(bundle, provider)?;
    let custom_provider = provider.template_id.starts_with("template-custom-");
    let declared_bindings = provider
        .model_protocol_bindings
        .iter()
        .filter(|declaration| declaration.model_id == model_id && declaration.operation == operation)
        .collect::<Vec<_>>();

    let (manifest, profile, declared_auth_profile_id, explicit_declaration) =
        if let Some(manifest) = registered_manifest {
            let model = manifest
                .models
                .iter()
                .find(|model| model.id == model_id)
                .ok_or_else(|| {
                    format!(
                        "provider_manifest.model_not_found: exact model '{}' is not registered by '{}'",
                        model_id, manifest.provider.id
                    )
                })?;
            let binding = model
                .protocol_bindings
                .iter()
                .find(|binding| binding.operation == operation)
                .ok_or_else(|| {
                    format!(
                        "provider_manifest.model_operation_not_bound: model '{}' has no '{}' binding",
                        model.id, operation
                    )
                })?;
            let profile = manifest
                .protocol_profiles
                .iter()
                .find(|profile| {
                    profile.id == binding.protocol_profile_id
                        && profile.version == binding.protocol_profile_version
                })
                .ok_or_else(|| {
                    format!(
                        "provider_manifest.registry_invalid: profile '{}@{}' is missing",
                        binding.protocol_profile_id, binding.protocol_profile_version
                    )
                })?;
            if !provider.model_protocol_bindings.is_empty() && declared_bindings.len() != 1 {
                return Err(format!(
                    "provider_manifest.profile_declaration_missing: exact binding for '{}'/{} is required",
                    model.id, operation
                ));
            }
            let declared_auth = if let Some(declared) = declared_bindings.first() {
                if declared.profile_owner_provider_id != manifest.provider.id
                    || declared.manifest_version != manifest.manifest_version
                    || declared.profile_id != profile.id
                    || declared.profile_version != profile.version
                {
                    return Err(format!(
                        "provider_manifest.profile_declaration_mismatch: declared manifest {} '{}@{}' does not match manifest {} '{}@{}'",
                        declared.manifest_version,
                        declared.profile_id,
                        declared.profile_version,
                        manifest.manifest_version,
                        profile.id,
                        profile.version
                    ));
                }
                declared.auth_profile_id.as_deref()
            } else {
                None
            };
            (manifest, profile, declared_auth, !declared_bindings.is_empty())
        } else if custom_provider {
            if provider.manifest_provider_id.is_some() {
                return Err("provider_manifest.custom_owner_forbidden: a custom provider cannot claim a built-in template owner".to_string());
            }
            if declared_bindings.len() != 1 {
                return Err(format!(
                    "provider_manifest.profile_declaration_required: custom provider '{}' must select exactly one versioned binding for '{}'/{}",
                    provider.provider_id, model_id, operation
                ));
            }
            let declared = declared_bindings[0];
            let manifest = bundle
                .manifests
                .iter()
                .find(|candidate| candidate.provider.id == declared.profile_owner_provider_id)
                .ok_or_else(|| {
                    format!(
                        "provider_manifest.profile_owner_not_found: '{}' is not registered",
                        declared.profile_owner_provider_id
                    )
                })?;
            if manifest.manifest_version != declared.manifest_version {
                return Err(format!(
                    "provider_manifest.manifest_version_mismatch: '{}' is manifest version {}, not {}",
                    manifest.provider.id, manifest.manifest_version, declared.manifest_version
                ));
            }
            let profile = manifest
                .protocol_profiles
                .iter()
                .find(|candidate| {
                    candidate.id == declared.profile_id
                        && candidate.version == declared.profile_version
                })
                .ok_or_else(|| {
                    format!(
                        "provider_manifest.profile_not_found: '{}@{}' is not registered",
                        declared.profile_id, declared.profile_version
                    )
                })?;
            if profile.custom_provider_policy.as_deref() != Some("explicit-profile")
                || profile.custom_endpoint_policy.as_deref()
                    != Some("absolute-secure-url-no-userinfo")
            {
                return Err(format!(
                    "provider_manifest.custom_profile_forbidden: '{}@{}' is not approved for custom providers",
                    profile.id, profile.version
                ));
            }
            (manifest, profile, declared.auth_profile_id.as_deref(), true)
        } else {
            if !provider.model_protocol_bindings.is_empty() {
                return Err(format!(
                    "provider_manifest.template_not_registered: template '{}' cannot attach protocol bindings",
                    provider.template_id
                ));
            }
            return Ok(None);
        };

    if !profile.operations.iter().any(|candidate| candidate == operation) {
        return Err(format!(
            "provider_manifest.profile_operation_mismatch: profile '{}' does not declare operation '{}'",
            profile.id, operation
        ));
    }

    if profile.adapter.status != "enabled" {
        return Err(format!(
            "provider_manifest.adapter_unavailable: profile '{}@{}' is not enabled",
            profile.id, profile.version
        ));
    }
    let family = manifest
        .api_families
        .iter()
        .find(|family| family.id == profile.api_family_id)
        .ok_or_else(|| {
            format!(
                "provider_manifest.registry_invalid: API family '{}' is missing",
                profile.api_family_id
            )
        })?;
    if family.endpoint_status != "verified" || family.endpoint_template.is_none() {
        return Err(format!(
            "provider_manifest.endpoint_unavailable: API family '{}' is not verified",
            family.id
        ));
    }
    if family.transport_id != profile.transport_id {
        return Err(format!(
            "provider_manifest.registry_invalid: profile '{}' transport differs from API family",
            profile.id
        ));
    }
    let transport = manifest
        .transports
        .iter()
        .find(|transport| transport.id == profile.transport_id)
        .ok_or_else(|| {
            format!(
                "provider_manifest.registry_invalid: transport '{}' is missing",
                profile.transport_id
            )
        })?;
    // The text gateway already resolves an OpenAI-compatible WebSocket preference to
    // streaming HTTP. Admit that exact custom SSE profile only when streaming is
    // enabled; realtime WebSocket admission still requires its own transport.
    let custom_text_streaming_fallback = custom_provider
        && matches!(operation, "text" | "text-translation")
        && profile.adapter.id == "openai-compatible-http"
        && transport.kind == "sse"
        && provider.transport == "websocket"
        && provider.stream_enabled;
    if !transport_matches(&provider.transport, &transport.kind) && !custom_text_streaming_fallback {
        return Err(format!(
            "provider_manifest.transport_mismatch: profile '{}' requires '{}', got '{}'",
            profile.id, transport.kind, provider.transport
        ));
    }
    let endpoint_matches = if custom_provider {
        valid_custom_endpoint(&provider.base_url, &transport.kind)
    } else {
        endpoint_host_matches(
            &provider.base_url,
            &family.base_url_template,
            family.endpoint_template.as_deref().expect("verified endpoint checked above"),
        )
    };
    if !endpoint_matches {
        return Err(format!(
            "provider_manifest.endpoint_host_mismatch: '{}' is not authorized for family '{}'",
            provider.base_url, family.id
        ));
    }
    let deployment_id = match family.model_addressing.as_str() {
        "deployment-id" | "path-deployment" => Some(
            provider
                .deployment_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "provider_manifest.deployment_id_required: model '{}' requires an explicit deployment id",
                        model_id
                    )
                })?
                .to_string(),
        ),
        _ => None,
    };
    let auth = selected_auth_profile(
        manifest,
        profile,
        family,
        declared_auth_profile_id,
    )?;
    if !explicit_declaration {
        validate_auth_shape(provider, auth)?;
    }
    let (canonical_auth_header_name, canonical_auth_scheme) = canonical_auth_shape(auth);
    let lifecycle = manifest
        .lifecycle_profiles
        .iter()
        .find(|lifecycle| lifecycle.id == profile.lifecycle_profile_id)
        .ok_or_else(|| format!(
            "provider_manifest.registry_invalid: lifecycle profile '{}' is missing",
            profile.lifecycle_profile_id
        ))?;
    let audio = profile.audio_profile_id.as_deref().map(|audio_id| {
        manifest
            .audio_profiles
            .iter()
            .find(|audio| audio.id == audio_id)
            .ok_or_else(|| {
                format!(
                    "provider_manifest.registry_invalid: audio profile '{}' is missing",
                    audio_id
                )
            })
    }).transpose()?;

    Ok(Some(AuthorizedProviderProtocol {
        manifest_version: manifest.manifest_version,
        provider_owner_id: manifest.provider.id.clone(),
        model_id: model_id.to_string(),
        deployment_id,
        operation: operation.to_string(),
        profile_id: profile.id.clone(),
        profile_version: profile.version,
        adapter_id: profile.adapter.id.clone(),
        adapter_verification: profile.adapter.verification.clone(),
        api_family_id: family.id.clone(),
        endpoint_template: family
            .endpoint_template
            .clone()
            .expect("verified endpoint checked above"),
        transport_kind: transport.kind.clone(),
        auth_profile_id: auth.id.clone(),
        canonical_auth_header_name,
        canonical_auth_scheme,
        lifecycle_profile_id: profile.lifecycle_profile_id.clone(),
        vad_modes: lifecycle.vad_modes.clone(),
        capabilities: profile.capabilities.clone(),
        audio_input_format: audio.and_then(|audio| audio.input.formats.first().cloned()),
        audio_input_sample_rate_hz: audio.and_then(|audio| audio.input.sample_rates_hz.first().copied()),
        audio_input_channels: audio.and_then(|audio| audio.input.channels.first().copied()),
        audio_output_format: audio.and_then(|audio| audio.output.formats.first().cloned()),
        audio_output_sample_rate_hz: audio.and_then(|audio| audio.output.sample_rates_hz.first().copied()),
        audio_output_channels: audio.and_then(|audio| audio.output.channels.first().copied()),
    }))
}

pub(crate) fn authorize_realtime_provider(
    provider: &ProviderDraftInput,
) -> Result<Option<AuthorizedProviderProtocol>, String> {
    authorize_realtime_provider_for_model(provider, &provider.model)
}

pub(crate) fn authorize_realtime_provider_for_model(
    provider: &ProviderDraftInput,
    model_id: &str,
) -> Result<Option<AuthorizedProviderProtocol>, String> {
    if model_id.trim().is_empty() {
        return Err("provider_manifest.model_id_required: invocation model must not be empty".to_string());
    }
    let bundle = bundle()?;
    let manifest = provider_manifest(bundle, provider)?;
    let custom_provider = provider.template_id.starts_with("template-custom-");
    let realtime_operations = if let Some(manifest) = manifest {
        let model = manifest
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| {
                format!(
                    "provider_manifest.model_not_found: exact model '{}' is not registered by '{}'",
                    model_id, manifest.provider.id
                )
            })?;
        model.protocol_bindings.iter().map(|binding| binding.operation.as_str()).collect::<Vec<_>>()
    } else if custom_provider {
        provider.model_protocol_bindings.iter()
            .filter(|binding| binding.model_id == model_id)
            .map(|binding| binding.operation.as_str())
            .collect::<Vec<_>>()
    } else {
        return Ok(None);
    };
    let realtime_operations = realtime_operations
        .into_iter()
        .filter(|operation| operation.starts_with("realtime-"))
        .collect::<Vec<_>>();
    match realtime_operations.as_slice() {
        [] if custom_provider => Err(format!(
            "provider_manifest.profile_declaration_required: custom provider '{}' must select one exact realtime profile",
            provider.provider_id
        )),
        [] => Ok(None),
        [operation] => authorize_provider_operation_for_model(provider, model_id, operation),
        _ => Err(format!(
            "provider_manifest.profile_ambiguous: model '{}' has multiple realtime operations",
            model_id
        )),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn provider(template_id: &str, model: &str, base_url: &str, transport: &str) -> ProviderDraftInput {
        serde_json::from_value(json!({
            "templateId": template_id,
            "providerId": "provider-instance",
            "kind": "openai-compatible",
            "displayName": "Fixture",
            "model": model,
            "baseUrl": base_url,
            "transport": transport,
            "authRef": {
                "kind": "env-ref",
                "reference": "FIXTURE_API_KEY",
                "headerName": "Authorization",
                "scheme": "bearer"
            },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": ""
        }))
        .expect("provider fixture")
    }

    #[test]
    fn exact_openai_realtime_profile_authorizes_before_socket() {
        let provider = provider(
            "template-openai-compatible-realtime",
            "gpt-realtime-2.1",
            "https://api.openai.com/v1",
            "websocket",
        );
        let authority = authorize_realtime_provider(&provider)
            .expect("authorization result")
            .expect("realtime authority");
        assert_eq!(authority.profile_id, "openai.realtime.conversation.websocket.ga");
        assert_eq!(authority.adapter_id, "openai-realtime-websocket");
        assert_eq!(authority.adapter_verification, "fixture-only");
        assert_eq!(authority.wire_model_id(), "gpt-realtime-2.1");
    }

    #[test]
    fn disabled_openai_translation_fails_closed() {
        let provider = provider(
            "template-openai-compatible-realtime",
            "gpt-realtime-translate",
            "https://api.openai.com/v1",
            "websocket",
        );
        let error = authorize_realtime_provider(&provider).unwrap_err();
        assert!(error.starts_with("provider_manifest.adapter_unavailable"));
    }

    #[test]
    fn azure_catalog_model_and_deployment_are_distinct() {
        let mut provider = provider(
            "template-azure-openai",
            "gpt-live-transcribe",
            "https://fixture-resource.openai.azure.com/openai/v1",
            "websocket",
        );
        provider.auth_ref.header_name = "api-key".to_string();
        provider.auth_ref.scheme = "api-key".to_string();
        let error = authorize_realtime_provider(&provider).unwrap_err();
        assert!(error.starts_with("provider_manifest.deployment_id_required"));

        provider.deployment_id = Some("watch-stt-prod".to_string());
        let authority = authorize_realtime_provider(&provider)
            .expect("authorization result")
            .expect("realtime authority");
        assert_eq!(authority.model_id, "gpt-live-transcribe");
        assert_eq!(authority.wire_model_id(), "watch-stt-prod");
    }

    #[test]
    fn tencent_classic_translation_uses_its_exact_manifest_profile() {
        let mut provider = provider(
            "template-tencent-speech",
            "hunyuan-translation-lite",
            "https://asr.cloud.tencent.com",
            "websocket",
        );
        provider.auth_ref.scheme = "api-key".to_string();

        let authority = authorize_realtime_provider(&provider)
            .expect("authorization result")
            .expect("realtime authority");

        assert_eq!(authority.provider_owner_id, "tencent-cloud");
        assert_eq!(authority.operation, "realtime-translation");
        assert_eq!(authority.profile_id, "tencent-cloud.speech-translate.ws-v1");
        assert_eq!(authority.adapter_id, "tencent-speech-translate-adapter");
        assert_eq!(authority.auth_profile_id, "speech-translate-hmac-sha1-query");
    }

    #[test]
    fn official_profile_rejects_proxy_host_and_owner_substitution() {
        let proxy = provider(
            "template-openai-compatible-realtime",
            "gpt-realtime-2.1",
            "https://proxy.example.com/v1",
            "websocket",
        );
        assert!(authorize_realtime_provider(&proxy)
            .unwrap_err()
            .starts_with("provider_manifest.endpoint_host_mismatch"));

        for unsafe_url in [
            "http://api.openai.com/v1",
            "ws://api.openai.com/v1",
            "https://user@api.openai.com/v1",
            "https://api.openai.com:8443/v1",
            "https://api.openai.com/other",
            "https://api.openai.com/v1#credential-leak",
        ] {
            let unsafe_provider = provider(
                "template-openai-compatible-realtime",
                "gpt-realtime-2.1",
                unsafe_url,
                "websocket",
            );
            assert!(authorize_realtime_provider(&unsafe_provider)
                .unwrap_err()
                .starts_with("provider_manifest.endpoint_host_mismatch"), "accepted {unsafe_url}");
        }

        let mut wrong_owner = provider(
            "template-openai-compatible-realtime",
            "gpt-realtime-2.1",
            "https://api.openai.com/v1",
            "websocket",
        );
        wrong_owner.manifest_provider_id = Some("azure-openai".to_string());
        assert!(authorize_realtime_provider(&wrong_owner)
            .unwrap_err()
            .starts_with("provider_manifest.provider_owner_mismatch"));
    }


    fn workspace_provider() -> ProviderDraftInput {
        let mut provider = provider(
            "template-dashscope-workspace",
            "qwen3.8-livetranslate-flash-realtime",
            "wss://fixture.cn-beijing.maas.aliyuncs.com",
            "websocket",
        );
        provider.provider_id = "provider-dashscope".to_string();
        provider.kind = "dashscope".to_string();
        provider.region = Some("cn-beijing".to_string());
        provider.manifest_provider_id = Some("bailian".to_string());
        provider.model_registry_version = Some(2);
        provider.model_protocol_bindings = vec![serde_json::from_value(json!({
            "modelId": provider.model,
            "operation": "realtime-translation",
            "profileOwnerProviderId": "bailian",
            "manifestVersion": 1,
            "profileId": "bailian.livetranslate.3_8.realtime.ws",
            "profileVersion": 1
        })).expect("Workspace binding fixture")];
        provider
    }

    #[test]
    fn workspace_alias_authorizes_exact_bailian_manifest_binding() {
        let provider = workspace_provider();
        let authority = authorize_realtime_provider(&provider)
            .expect("Workspace authorization")
            .expect("Bailian authority");
        assert_eq!(authority.provider_owner_id, "bailian");
        assert_eq!(authority.model_id, provider.model);
        assert_eq!(authority.profile_id, "bailian.livetranslate.3_8.realtime.ws");
        assert_eq!(authority.operation, "realtime-translation");
        assert_eq!(provider.template_id, "template-dashscope-workspace");
    }

    #[test]
    fn workspace_alias_rejects_foreign_owner_and_profile() {
        let mut declared_owner = workspace_provider();
        declared_owner.manifest_provider_id = Some("openai".to_string());
        assert!(authorize_realtime_provider(&declared_owner).unwrap_err()
            .starts_with("provider_manifest.provider_owner_mismatch"));
        let mut runtime_owner = workspace_provider();
        runtime_owner.provider_id = "openai".to_string();
        assert!(authorize_realtime_provider(&runtime_owner).unwrap_err()
            .starts_with("provider_manifest.provider_owner_mismatch"));
        let mut profile_owner = workspace_provider();
        profile_owner.model_protocol_bindings[0].profile_owner_provider_id = "openai".to_string();
        assert!(authorize_realtime_provider(&profile_owner).unwrap_err()
            .starts_with("provider_manifest.profile_declaration_mismatch"));
        let mut stale_profile = workspace_provider();
        stale_profile.model_protocol_bindings[0].profile_version = 999;
        assert!(authorize_realtime_provider(&stale_profile).unwrap_err()
            .starts_with("provider_manifest.profile_declaration_mismatch"));
        let mut arbitrary_template = workspace_provider();
        arbitrary_template.template_id = "template-dashscope-workspace-spoof".to_string();
        assert!(authorize_realtime_provider(&arbitrary_template).unwrap_err()
            .starts_with("provider_manifest.template_not_registered"));
    }

    #[test]
    fn workspace_alias_rejects_unauthorized_endpoints() {
        for endpoint in [
            "wss://evil.example.test",
            "wss://fixture.cn-beijing.maas.aliyuncs.com.evil.example.test",
            "wss://fixture.ap-southeast-1.maas.aliyuncs.com",
            "wss://user@fixture.cn-beijing.maas.aliyuncs.com",
            "http://fixture.cn-beijing.maas.aliyuncs.com",
        ] {
            let mut provider = workspace_provider();
            provider.base_url = endpoint.to_string();
            assert!(authorize_realtime_provider(&provider).unwrap_err()
                .starts_with("provider_manifest.endpoint_host_mismatch"), "accepted {endpoint}");
        }
    }

    fn custom_realtime_provider() -> ProviderDraftInput {
        serde_json::from_value(json!({
            "templateId": "template-custom-private-gateway-1",
            "providerId": "provider-custom-private-gateway",
            "kind": "openai-compatible",
            "displayName": "Private Gateway",
            "model": "private-realtime-model",
            "baseUrl": "https://gateway.example.test/v1",
            "transport": "websocket",
            "authRef": {
                "kind": "env-ref",
                "reference": "PRIVATE_GATEWAY_API_KEY",
                "headerName": "Authorization",
                "scheme": "bearer"
            },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": "",
            "modelProtocolBindings": [{
                "modelId": "private-realtime-model",
                "operation": "realtime-conversation",
                "profileOwnerProviderId": "openai",
                "manifestVersion": 3,
                "profileId": "openai.realtime.conversation.websocket.ga",
                "profileVersion": 1,
                "authProfileId": "openai.auth.bearer-header"
            }]
        }))
        .expect("custom provider fixture")
    }

    #[test]
    fn custom_provider_requires_one_exact_approved_profile_before_socket() {
        let provider = custom_realtime_provider();
        let authority = authorize_realtime_provider(&provider)
            .expect("custom authorization")
            .expect("custom realtime authority");
        assert_eq!(authority.provider_owner_id, "openai");
        assert_eq!(authority.model_id, "private-realtime-model");

        let mut missing = provider.clone();
        missing.model_protocol_bindings.clear();
        assert!(authorize_realtime_provider(&missing)
            .unwrap_err()
            .starts_with("provider_manifest.profile_declaration_required"));

        let mut stale = provider.clone();
        stale.model_protocol_bindings[0].manifest_version = 2;
        assert!(authorize_realtime_provider(&stale)
            .unwrap_err()
            .starts_with("provider_manifest.manifest_version_mismatch"));
    }

    fn custom_text_binding(model: &str, operation: &str) -> super::super::contracts::ProviderModelProtocolBindingInput {
        serde_json::from_value(json!({
            "modelId": model,
            "operation": operation,
            "profileOwnerProviderId": "openai",
            "manifestVersion": 3,
            "profileId": "openai.chat-completions.sse.ga",
            "profileVersion": 1,
            "authProfileId": "openai.auth.bearer-header"
        }))
        .expect("text binding fixture")
    }

    #[test]
    fn custom_bindings_select_the_actual_model_and_operation() {
        let mut provider = custom_realtime_provider();
        provider.model_protocol_bindings.push(custom_text_binding("private-text-model", "text-translation"));
        provider.model_protocol_bindings.push(custom_text_binding("private-realtime-model", "text"));

        let realtime = authorize_provider_operation(&provider, "realtime-conversation")
            .expect("realtime authorization")
            .expect("realtime authority");
        assert_eq!(realtime.model_id, "private-realtime-model");
        assert_eq!(realtime.profile_id, "openai.realtime.conversation.websocket.ga");
        assert!(authorize_realtime_provider(&provider).unwrap().is_some());
        let same_model_text = authorize_provider_operation(&provider, "text")
            .expect("same-model text authorization")
            .expect("same-model text authority");
        assert_eq!(same_model_text.model_id, "private-realtime-model");
        assert_eq!(same_model_text.operation, "text");
        let projected = same_model_text.provider_for_connection(&provider);
        assert_eq!(projected.transport, "streaming-http");
        assert_eq!(crate::provider::gateway_parts::transport::resolve_transport(&provider).0, "streaming-http");
        assert_eq!(crate::provider::gateway_parts::transport::resolve_transport(&projected).0, "streaming-http");
        assert_eq!(projected.base_url, provider.base_url);
        assert_eq!(projected.auth_ref, provider.auth_ref);

        provider.model = "private-text-model".to_string();
        let text = authorize_provider_operation(&provider, "text-translation")
            .expect("text authorization")
            .expect("text authority");
        assert_eq!(text.model_id, "private-text-model");
        assert_eq!(text.profile_id, "openai.chat-completions.sse.ga");
        assert_eq!(text.provider_for_connection(&provider).transport, "streaming-http");
        let mut non_streaming = provider.clone();
        non_streaming.stream_enabled = false;
        assert!(authorize_provider_operation(&non_streaming, "text-translation")
            .unwrap_err()
            .starts_with("provider_manifest.transport_mismatch"));
        let mut insecure_text = provider.clone();
        insecure_text.base_url = "http://gateway.example.test/v1".to_string();
        assert!(authorize_provider_operation(&insecure_text, "text-translation")
            .unwrap_err()
            .starts_with("provider_manifest.endpoint_host_mismatch"));
        let mut wrong_auth = provider.clone();
        wrong_auth.model_protocol_bindings[1].auth_profile_id = Some("foreign-auth".to_string());
        assert!(authorize_provider_operation(&wrong_auth, "text-translation")
            .unwrap_err()
            .starts_with("provider_manifest.auth_profile_not_allowed"));
        assert!(authorize_provider_operation(&provider, "realtime-conversation")
            .unwrap_err()
            .starts_with("provider_manifest.profile_declaration_required"));
    }

    #[test]
    fn second_candidate_authorizes_without_changing_provider_default_model() {
        let mut provider = custom_realtime_provider();
        provider.model_protocol_bindings.push(custom_text_binding("second-candidate", "text-translation"));

        let authority = authorize_provider_operation_for_model(
            &provider,
            "second-candidate",
            "text-translation",
        )
        .expect("candidate authorization")
        .expect("candidate authority");
        assert_eq!(provider.model, "private-realtime-model");
        assert_eq!(authority.model_id, "second-candidate");
        let connection = authority.provider_for_connection(&provider);
        assert_eq!(connection.model, "second-candidate");
        assert_eq!(connection.transport, "streaming-http");
        assert!(authorize_realtime_provider_for_model(&provider, "second-candidate")
            .unwrap_err()
            .starts_with("provider_manifest.profile_declaration_required"));
        assert!(authorize_provider_operation_for_model(&provider, "", "text-translation")
            .is_err());
    }

    #[test]
    fn realtime_route_uses_second_candidate_instead_of_provider_default() {
        let mut provider = custom_realtime_provider();
        let mut second = provider.model_protocol_bindings[0].clone();
        second.model_id = "second-realtime-candidate".to_string();
        provider.model_protocol_bindings.push(second);

        let resolved = crate::audio::events::resolve_realtime_profile(
            &provider,
            "second-realtime-candidate",
        );
        assert_eq!(provider.model, "private-realtime-model");
        assert_eq!(resolved.model_id, "second-realtime-candidate");
        assert_eq!(resolved.model_protocol_error, None);
        assert_eq!(
            resolved.protocol_dialect,
            Some(crate::audio::events::RealtimeProtocol::OpenAiConversation),
        );
    }

    #[test]
    fn custom_binding_rejects_duplicate_wrong_source_and_incompatible_operation() {
        let mut provider = custom_realtime_provider();
        provider.model_protocol_bindings.push(provider.model_protocol_bindings[0].clone());
        assert!(authorize_provider_operation(&provider, "realtime-conversation")
            .unwrap_err()
            .starts_with("provider_manifest.profile_declaration_required"));

        let mut wrong_source = custom_realtime_provider();
        wrong_source.model_protocol_bindings[0].profile_owner_provider_id = "azure-openai".to_string();
        assert!(authorize_provider_operation(&wrong_source, "realtime-conversation")
            .unwrap_err()
            .starts_with("provider_manifest.manifest_version_mismatch"));

        let mut incompatible = custom_realtime_provider();
        incompatible.model_protocol_bindings[0].operation = "text-translation".to_string();
        assert!(authorize_provider_operation(&incompatible, "text-translation")
            .unwrap_err()
            .starts_with("provider_manifest.profile_operation_mismatch"));

        let mut empty = custom_realtime_provider();
        empty.model_protocol_bindings.clear();
        assert!(authorize_provider_operation(&empty, "text-translation")
            .unwrap_err()
            .starts_with("provider_manifest.profile_declaration_required"));
    }

    #[test]
    fn custom_profile_rejects_insecure_endpoint_and_builtin_owner_spoof() {
        let mut insecure = custom_realtime_provider();
        insecure.base_url = "http://gateway.example.test/v1".to_string();
        assert!(authorize_realtime_provider(&insecure)
            .unwrap_err()
            .starts_with("provider_manifest.endpoint_host_mismatch"));

        let mut spoof = custom_realtime_provider();
        spoof.manifest_provider_id = Some("openai".to_string());
        assert!(authorize_realtime_provider(&spoof)
            .unwrap_err()
            .starts_with("provider_manifest.template_not_registered"));
    }
}
