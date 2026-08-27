use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::audio::omni::{self, OmniOutputMode};
use crate::provider::contracts::ProviderDraftInput;

use super::{RealtimeProtocol, ResolvedRealtimeProfile};

pub(super) fn resolve_livetranslate_contract(
    model: &str,
    source_language: &str,
    target_language: &str,
    requested_output_mode: OmniOutputMode,
) -> Result<(String, String, OmniOutputMode), String> {
    let source = omni::resolve_livetranslate_language(model, source_language, "en")?;
    let target = omni::resolve_livetranslate_language(model, target_language, "zh")?;
    let output_mode =
        omni::resolve_livetranslate_output_mode(model, &target, requested_output_mode)?;
    Ok((source, target, output_mode))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn realtime_session_contract_signature(
    provider: &ProviderDraftInput,
    profile: &ResolvedRealtimeProfile,
    source_language: &str,
    target_language: &str,
    realtime_audio_mode: &str,
    output_mode: OmniOutputMode,
    translation_owner: &str,
    voice: &str,
    instructions: &str,
    glossary_signature: u64,
) -> u64 {
    let mut hasher = DefaultHasher::new();
    provider.template_id.hash(&mut hasher);
    provider.provider_id.hash(&mut hasher);
    provider.kind.hash(&mut hasher);
    provider.template_realtime_protocol.hash(&mut hasher);
    provider.realtime_protocol.hash(&mut hasher);
    provider.model.hash(&mut hasher);
    provider.base_url.hash(&mut hasher);
    provider.transport.hash(&mut hasher);
    provider.auth_ref.kind.hash(&mut hasher);
    provider.auth_ref.reference.hash(&mut hasher);
    provider.auth_ref.header_name.hash(&mut hasher);
    provider.auth_ref.scheme.hash(&mut hasher);
    provider.region.hash(&mut hasher);
    provider.timeout_ms.hash(&mut hasher);
    provider.response_modalities.hash(&mut hasher);
    for header in &provider.custom_headers {
        header.name.hash(&mut hasher);
        header.value.hash(&mut hasher);
        header.enabled.hash(&mut hasher);
    }
    profile
        .protocol_dialect
        .map(RealtimeProtocol::as_str)
        .hash(&mut hasher);
    source_language.hash(&mut hasher);
    target_language.hash(&mut hasher);
    realtime_audio_mode.hash(&mut hasher);
    output_mode.as_str().hash(&mut hasher);
    translation_owner.hash(&mut hasher);
    voice.hash(&mut hasher);
    instructions.hash(&mut hasher);
    glossary_signature.hash(&mut hasher);
    hasher.finish()
}
