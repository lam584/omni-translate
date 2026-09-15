use serde_json::Value;

use crate::provider::contracts::ProviderDraftInput;

use super::{RealtimeProtocol, ResolvedRealtimeProfile};

/// Qwen Audio's automatic VAD is designed for duplex conversation: a new
/// `speech_started` cancels the response currently being generated. Continuous
/// video narration routinely starts the next phrase within a few dozen
/// milliseconds, so server-VAD responses are cancelled before their first
/// translation token and the following response can absorb the prior turn.
/// The existing manual gate serializes commit -> ASR final -> response.create
/// -> response.done while continuing to buffer incoming media, which preserves
/// every source turn without allowing later narration to barge in.
fn should_serialize_qwen_audio_watch_turns(
    direction: &str,
    config: &Value,
    profile: &ResolvedRealtimeProfile,
) -> bool {
    direction == "inbound"
        && super::super::configured_route_mode(config) == "watch"
        && profile.protocol_dialect == Some(RealtimeProtocol::DashscopeOmni)
        && profile.model_protocol_authority.as_ref().is_some_and(|authority| {
            authority.profile_id == "bailian.qwen-audio-chat.realtime.ws"
                && authority.profile_version == 1
                && authority.wire_dialect == "bailian-qwen-audio-chat-realtime-ws-v1"
        })
}

pub(super) fn resolve_route_audio_mode(
    direction: &str,
    config: &Value,
    provider: &ProviderDraftInput,
    profile: &ResolvedRealtimeProfile,
    legacy_vad_bypass: bool,
) -> (String, Option<String>) {
    if legacy_vad_bypass
        || should_serialize_qwen_audio_watch_turns(direction, config, profile)
    {
        return ("manual".to_string(), None);
    }
    if direction == "outbound"
        && profile.protocol_dialect == Some(RealtimeProtocol::DashscopeOmni)
    {
        return ("manual".to_string(), None);
    }
    let continuous_watch = direction == "inbound"
        && super::super::configured_route_mode(config) == "watch"
        && profile.protocol_dialect == Some(RealtimeProtocol::DashscopeOmni);
    if !continuous_watch || profile.realtime_audio_mode != "manual" {
        return (profile.realtime_audio_mode.clone(), None);
    }
    let supports_auto_vad = profile.model_protocol_authority.as_ref().is_some_and(|authority| {
        authority.profile_id == "bailian.omni.realtime.ws"
            && authority.profile_version == 1
            && authority.wire_dialect == "bailian-omni-realtime-ws-v1"
    });
    if supports_auto_vad {
        return ("semantic_vad".to_string(), None);
    }
    (
        "manual".to_string(),
        Some(format!(
            "Realtime model '{}' is manual-only and cannot start continuous Watch capture; choose a server_vad/semantic_vad capable model",
            provider.model
        )),
    )
}
