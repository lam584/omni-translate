use super::*;
use crate::provider::contracts::ProviderModelProtocolBindingInput;

/// Only the authorizer can issue this provenance. It retains the actual model
/// identity; custom deployments never impersonate a built-in manifest model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ExplicitBindingProvenance {
    binding: ProviderModelProtocolBindingInput,
    transport: String,
    region: String,
    endpoint_host: String,
}

pub(crate) fn authorize_model_protocol_invocation_with_binding(
    request: ModelProtocolAuthorizationRequest<'_>,
    binding: Option<&ProviderModelProtocolBindingInput>,
) -> Result<AuthorizedModelProtocolProfile, ModelProtocolAuthorizationError> {
    super::authorize_model_protocol_invocation_inner(request, binding)
}

pub(crate) fn binding_operation_matches(binding: &str, operation: &str) -> bool {
    binding == operation || matches!((binding, operation),
        ("realtime-translation", "native_translate") | ("realtime-conversation", "dialogue")
        | ("realtime-transcription", "asr") | ("voice-clone", "voice_clone"))
}

fn valid_binding(registry: &ModelProtocolRegistry, binding: &ProviderModelProtocolBindingInput) -> bool {
    binding.profile_owner_provider_id == "bailian"
        && registry.registry_version == format!("bailian-model-protocol-registry/v{}", binding.manifest_version)
        && binding.auth_profile_id.is_none()
        && !binding.model_id.trim().is_empty()
        && binding.model_id.trim() == binding.model_id
}

pub(super) fn select_profile<'a>(
    registry: &'a ModelProtocolRegistry,
    request: &ModelProtocolAuthorizationRequest<'_>,
    binding: Option<&ProviderModelProtocolBindingInput>,
) -> Result<(&'a ModelProtocolProfile, Option<ExplicitBindingProvenance>), ModelProtocolAuthorizationError> {
    let candidates = profiles_for_model(registry, request.exact_model_id);
    if let Some(binding) = binding {
        if !valid_binding(registry, binding)
            || binding.model_id != request.exact_model_id || !binding_operation_matches(&binding.operation, request.operation)
        {
            return Err(ModelProtocolAuthorizationError::AuthorizationIdentityMismatch);
        }
    }
    let (profile, provenance) = if candidates.is_empty() {
        if crate::provider::provider_manifest::is_builtin_bailian_model(request.exact_model_id)
            .map_err(|_| ModelProtocolAuthorizationError::RegistryInvalid)? {
            return Err(ModelProtocolAuthorizationError::ProfileIdMismatch);
        }
        let binding = binding.ok_or(ModelProtocolAuthorizationError::ModelNotRegistered)?;
        let profile = registry.profiles.iter().find(|profile| profile.profile_id == binding.profile_id)
            .ok_or(ModelProtocolAuthorizationError::ProfileIdMismatch)?;
        (profile, Some(ExplicitBindingProvenance { binding: binding.clone(),
            transport: request.transport.to_string(), region: request.region.to_string(),
            endpoint_host: request.endpoint_host.trim().to_ascii_lowercase(),
        }))
    } else {
        let profile = if let Some(id) = request.declared_profile_id {
            candidates.iter().copied().find(|profile| profile.profile_id == id)
                .ok_or(ModelProtocolAuthorizationError::ProfileIdMismatch)?
        } else if candidates.len() == 1 { candidates[0] }
        else { return Err(ModelProtocolAuthorizationError::ProfileAmbiguous); };
        // An identical declaration is harmless; a built-in identity cannot be rebound.
        if binding.is_some_and(|binding| binding.profile_id != profile.profile_id) {
            return Err(ModelProtocolAuthorizationError::ProfileIdMismatch);
        }
        (profile, None)
    };
    if binding.is_some_and(|binding| binding.profile_version != profile.profile_version) {
        return Err(ModelProtocolAuthorizationError::ProfileVersionMismatch);
    }
    if request.declared_profile_id.is_some_and(|id| id != profile.profile_id) {
        return Err(ModelProtocolAuthorizationError::ProfileIdMismatch);
    }
    Ok((profile, provenance))
}

pub(super) fn identity_matches(
    registry: &ModelProtocolRegistry,
    profile: &ModelProtocolProfile,
    authority: &AuthorizedModelProtocolProfile,
) -> bool {
    match &authority.binding_provenance {
        None => profile.exact_model_ids.contains(&authority.exact_model_id),
        Some(provenance) => {
            let binding = &provenance.binding;
            valid_binding(registry, binding)
                && provenance.transport == authority.transport
                && provenance.region == authority.region
                && provenance.endpoint_host == authority.endpoint_host
                && profiles_for_model(registry, &authority.exact_model_id).is_empty()
                && !crate::provider::provider_manifest::is_builtin_bailian_model(&authority.exact_model_id).unwrap_or(true)
                && binding.model_id == authority.exact_model_id
                && binding_operation_matches(&binding.operation, &authority.operation)
                && binding.profile_id == profile.profile_id
                && binding.profile_version == profile.profile_version
        }
    }
}

#[cfg(test)]
mod tests;
