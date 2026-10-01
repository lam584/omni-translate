use serde_json::Value;
use tauri::AppHandle;
use super::super::{glossary::{GlossaryCatalog, GlossaryContext}, omni, speech};
use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::{ProviderDraftInput, ProviderModelCapabilityRegistryEntryInput};
use crate::provider::adapter_registry::{realtime_route, RealtimeAdapterRoute};
use crate::provider::model_protocol_profile::{
    lookup_model_protocol_profiles_for_inspection,
    AuthorizedModelProtocolProfile,
    ModelProtocolAuthorizationRequest, ModelProtocolRequestedAudio,
};
use crate::provider::provider_manifest::authorize_realtime_provider_for_model;

#[path = "route_config/session_contract.rs"]
mod session_contract;
#[path = "route_config/model_protocol_authority.rs"]
mod model_protocol_authority;
#[path = "route_config/subtitle_policy.rs"]
mod subtitle_policy;
#[path = "route_config/watch_audio_policy.rs"]
mod watch_audio_policy;
#[path = "route_config/provider_resolution.rs"]
mod provider_resolution;
#[cfg(test)]
#[path = "route_config/bailian_protocol_old_red.rs"]
mod bailian_protocol_old_red;

use self::watch_audio_policy::resolve_route_audio_mode;
pub(super) use self::provider_resolution::resolve_model_provider_from_config;
pub(crate) use self::provider_resolution::{
    resolve_composite_template_provider, resolve_model_provider_from_config_value,
};
use self::subtitle_policy::{is_legacy_default_instructions, subtitle_translate_mode_and_model};
use self::model_protocol_authority::{
    bailian_protocol_from_authority, parse_realtime_protocol, registry_protocol,
    resolve_bailian_model_protocol_authority, primary_bailian_operation,
};
pub(crate) use self::model_protocol_authority::{
    authorize_bailian_model_operation, authorize_bailian_native_translate, authorize_bailian_realtime,
};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolvedRouteKind {
    GeminiLive,
    Omni,
    TencentSpeechTranslate,
    OpenAiRealtime,
    DashscopeStt,
    LocalVad,
}

impl ResolvedRouteKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::GeminiLive => "gemini-live",
            Self::Omni => "omni",
            Self::TencentSpeechTranslate => "tencent-speech-translate",
            Self::OpenAiRealtime => "openai-realtime",
            Self::DashscopeStt => "dashscope-asr",
            Self::LocalVad => "local-vad",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RealtimeProtocol {
    DashscopeOmni,
    DashscopeQwenAudio,
    DashscopeLivetranslate,
    DashscopeAsr,
    OpenAiConversation,
    OpenAiTranslation,
    OpenAiTranscription,
    OpenAiFlat,
    GeminiLive,
}

impl RealtimeProtocol {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::DashscopeOmni => "dashscope-omni",
            Self::DashscopeQwenAudio => "dashscope-qwen-audio",
            Self::DashscopeLivetranslate => "dashscope-livetranslate",
            Self::DashscopeAsr => "dashscope-asr",
            Self::OpenAiConversation => "openai-conversation",
            Self::OpenAiTranslation => "openai-translation",
            Self::OpenAiTranscription => "openai-transcription",
            Self::OpenAiFlat => "openai-flat",
            Self::GeminiLive => "gemini-live",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RealtimeProfileSource {
    Manifest,
    Registry,
    Template,
    Provider,
    None,
}

impl RealtimeProfileSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Manifest => "manifest",
            Self::Registry => "registry",
            Self::Template => "template",
            Self::Provider => "provider",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedRealtimeProfile {
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) route_kind: ResolvedRouteKind,
    pub(crate) protocol_dialect: Option<RealtimeProtocol>,
    pub(crate) realtime_audio_mode: String,
    pub(crate) interaction_capabilities: Vec<String>,
    pub(crate) input_format: String,
    pub(crate) output_format: Option<String>,
    pub(crate) sample_rate: u32,
    pub(crate) server_segmentation: bool,
    pub(crate) native_translation: bool,
    pub(crate) invocation_operation: String,
    pub(crate) translation_execution: String,
    pub(crate) native_audio_output: bool,
    pub(crate) secondary_translation_policy: String,
    pub(crate) speech_dispatch_policy: String,
    pub(crate) preconnect_policy: String,
    pub(crate) preconnect_allowed: bool,
    pub(crate) timeout_budget_ms: u64,
    pub(crate) source: RealtimeProfileSource,
    pub(crate) model_protocol_authority: Option<AuthorizedModelProtocolProfile>,
    pub(crate) model_protocol_error: Option<String>,
    pub(crate) diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResolvedVadPolicy {
    ManualCommit,
    ServerVad,
    GeminiAutoActivity,
    GeminiManualActivity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SubtitleFallbackPolicy {
    Native,
    Secondary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SpeechDispatchPolicy {
    Disabled,
    SubtitleTtsWhenIdle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SessionReuseKey {
    pub(super) direction: String,
    pub(super) model: String,
    pub(super) source_language: String,
    pub(super) target_language: String,
    pub(super) realtime_audio_mode: String,
    pub(super) subtitle_translate_active: bool,
    pub(super) output_mode: omni::OmniOutputMode,
    pub(super) contract_signature: u64,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedRoutePlan {
    pub(super) direction: String,
    pub(super) requested_voice_model: String,
    pub(super) target_language: String,
    pub(super) voice: String,
    pub(super) instructions: String,
    pub(super) glossary: GlossaryContext,
    pub(super) omni_speech_config: omni::OmniSpeechConfig,
    pub(super) provider: ProviderDraftInput,
    pub(super) secondary_subtitle_provider: Option<ProviderDraftInput>,
    pub(super) configuration_error: Option<String>,
    pub(super) subtitle_translation_model_id: String,
    pub(super) realtime_audio_mode: String,
    pub(super) legacy_vad_bypass: bool,
    pub(super) vad_policy: ResolvedVadPolicy,
    pub(super) subtitle_fallback_policy: SubtitleFallbackPolicy,
    pub(super) speech_dispatch_policy: SpeechDispatchPolicy,
    pub(super) speech_output_enabled: bool,
    pub(super) translation_audio_source: speech::TranslationAudioSource,
    pub(super) model_protocol_authority: Option<AuthorizedModelProtocolProfile>,
    pub(super) session_reuse_key: SessionReuseKey,
    pub(super) kind: ResolvedRouteKind,
}

impl ResolvedRoutePlan {
    pub(super) fn from_resolved_provider(
        direction: &str,
        config: &Value,
        requested_voice_model: String,
        provider: ProviderDraftInput,
    ) -> Self {
        let target_language = resolve_route_target_language(direction, config);
        let source_language = subtitle_source_language_or_english(config);
        let realtime_profile = resolve_realtime_profile(&provider, &provider.model);
        let legacy_vad_bypass = resolve_legacy_vad_bypass_for_route(direction, config);
        let (effective_audio_mode, audio_mode_error) = resolve_route_audio_mode(
            direction,
            config,
            &provider,
            &realtime_profile,
            legacy_vad_bypass,
        );
        let kind = if realtime_profile.source != RealtimeProfileSource::None {
            realtime_profile.route_kind
        } else if is_dashscope_provider(&provider) {
            ResolvedRouteKind::DashscopeStt
        } else {
            ResolvedRouteKind::LocalVad
        };
        let (subtitle_mode, subtitle_model_id) = subtitle_translate_mode_and_model(config);
        let secondary_requested = subtitle_mode == "secondary" && !subtitle_model_id.trim().is_empty();
        let secondary_subtitle_provider = secondary_requested
            .then(|| resolve_model_provider_from_config_value(config, subtitle_model_id))
            .flatten();
        // Secondary subtitles are optional. Retain unavailable saved references,
        // but use the native translation route for this session.
        let mut configuration_error = None;
        if configuration_error.is_none() {
            configuration_error = realtime_profile.model_protocol_error.as_ref().map(|error| {
                let context = serde_json::json!({
                    "modelRole": "primary-audio",
                    "modelId": realtime_profile.model_id,
                    "providerId": realtime_profile.provider_id,
                    "modelReference": requested_voice_model,
                    "direction": direction,
                });
                super::super::omni::session_errors::with_error_markers(
                    &format!("{error} | modelContext: {context}"),
                    super::super::omni::session_errors::SessionErrorCode::ModelReferenceInvalid,
                )
            });
        }
        if configuration_error.is_none() {
            configuration_error = audio_mode_error.map(|error| {
                super::super::omni::session_errors::with_error_markers(
                    &error,
                    super::super::omni::session_errors::SessionErrorCode::ModelReferenceInvalid,
                )
            });
        }
        // Task ASR only produces transcription. Its separately selected text
        // translator must be admitted before any audio/network route starts.
        if configuration_error.is_none() && realtime_profile.model_protocol_authority.as_ref()
            .is_some_and(|a| a.adapter_id == "desktop-qwen-audio-task-asr-v1") {
            configuration_error = crate::audio::translate::resolve_primary_text_provider(config).err();
        }
        let subtitle_translate_active = secondary_subtitle_provider.is_some();
        let subtitle_fallback_policy = if subtitle_translate_active {
            SubtitleFallbackPolicy::Secondary
        } else {
            SubtitleFallbackPolicy::Native
        };
        let speech_output_enabled = speech::speech_output_enabled(config);
        let translation_audio_source = speech::resolve_translation_audio_source(config, true);
        let speech_dispatch_policy = if speech_output_enabled
            && translation_audio_source == speech::TranslationAudioSource::SubtitleTts
        {
            SpeechDispatchPolicy::SubtitleTtsWhenIdle
        } else {
            SpeechDispatchPolicy::Disabled
        };
        let vad_policy = match effective_audio_mode.as_str() {
            "manual" => ResolvedVadPolicy::ManualCommit,
            "gemini_auto_activity" => ResolvedVadPolicy::GeminiAutoActivity,
            "gemini_manual_activity" => ResolvedVadPolicy::GeminiManualActivity,
            _ => ResolvedVadPolicy::ServerVad,
        };
        let reuse_model = provider.model.clone();
        let model_protocol_authority = realtime_profile.model_protocol_authority.clone();
        let omni_speech_config = omni::OmniSpeechConfig::from_config(config);
        let requested_output_mode = if translation_audio_source
            == speech::TranslationAudioSource::SubtitleTts
        {
            omni::OmniOutputMode::TextOnly
        } else {
            omni::OmniOutputMode::from_speech_config(&omni_speech_config)
        };
        let mut omni_output_mode = requested_output_mode;
        let mut session_source_language = source_language.clone();
        let mut session_target_language = target_language.clone();
        if is_livetranslate_route_model(&provider, &provider.model) {
            let language_contract = realtime_profile
                .model_protocol_authority
                .as_ref()
                .ok_or_else(|| {
                    "model_protocol.authorization_missing: LiveTranslate requires an exact authorized profile"
                        .to_string()
                })
                .and_then(|authority| {
                    crate::audio::bailian_protocol::validate_audio_mode(authority, &effective_audio_mode)?;
                    session_contract::resolve_livetranslate_contract(
                        authority,
                        &source_language,
                        &target_language,
                        requested_output_mode,
                    )
                });
            match language_contract {
                Ok((source, target, output_mode)) => {
                    session_source_language = source;
                    session_target_language = target;
                    omni_output_mode = output_mode;
                }
                Err(error) if configuration_error.is_none() => {
                    configuration_error = Some(super::super::omni::session_errors::with_error_markers(
                        &error,
                        super::super::omni::session_errors::SessionErrorCode::ModelReferenceInvalid,
                    ));
                }
                Err(_) => {}
            }
        }
        let default_instructions = if kind == ResolvedRouteKind::Omni {
            if direction == "outbound" {
                // The microphone route translates the local speaker's voice for
                // the peer, so the target language is the resolved outbound one
                // instead of the subtitle target hardcoded as Chinese.
                format!(
                    "你是一个只输出译文的实时翻译引擎。把听到的所有语音内容直接翻译成 {target_language}。只输出译文，禁止任何解释、确认、寒暄或对音频本身的描述（如“我没听到有人说话”）。若确实没有可翻译的语言内容，保持静默，不输出任何文字。"
                )
            } else {
                "你是一个只输出译文的实时翻译引擎。把听到的所有内容（人声对话、旁白、歌词、视频与音乐中的人声等）直接翻译成中文。只输出译文，禁止任何解释、确认、寒暄或对音频本身的描述（如“我没听到有人说话”“只听到音乐”）。若确实没有可翻译的语言内容，保持静默，不输出任何文字。".to_string()
            }
        } else {
            "You are a translation engine that outputs translations only. Translate everything you hear (speech, narration, lyrics, vocals in music or video) into concise subtitles. Output only the translation itself; never add confirmations, explanations, or meta commentary about the audio (e.g. 'I only hear music'). If there is truly no translatable speech, output nothing.".to_string()
        };
        let configured_voice = config
            .pointer("/speech/voice")
            .and_then(Value::as_str)
            .unwrap_or("Ethan");
        let voice = resolve_realtime_voice(
            realtime_profile.model_protocol_authority.as_ref(),
            configured_voice,
        );
        let glossary = GlossaryCatalog::from_config(config)
            .for_languages("auto", &target_language);
        let base_instructions = config
            .pointer("/subtitles/instructions")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty() && !is_legacy_default_instructions(text))
            .map(str::to_string)
            .unwrap_or(default_instructions);
        // Realtime models occasionally normalize a large spoken amount to a
        // smaller magnitude. This is a translation requirement, not a Watch
        // fixture hint: preserve every number, unit, date and monetary amount
        // exactly in the target language for every Omni route.
        let numeric_fidelity_instruction = "Preserve every numerical value, date, unit, currency amount, percentage, and magnitude exactly. Never round, shorten, or change a number's scale. For Chinese output, retain the monetary scale explicitly: one billion dollars = 十亿美元, one hundred million dollars = 一亿美元, and five hundred million dollars = 五亿美元.";
        let instructions = glossary.with_instructions(&format!(
            "{base_instructions}\n{numeric_fidelity_instruction}"
        ));
        let translation_owner = match subtitle_fallback_policy {
            SubtitleFallbackPolicy::Native => "native",
            SubtitleFallbackPolicy::Secondary => "secondary",
        };
        let contract_signature = session_contract::realtime_session_contract_signature(
            &provider,
            &realtime_profile,
            &session_source_language,
            &session_target_language,
            &effective_audio_mode,
            omni_output_mode,
            translation_owner,
            &voice,
            &instructions,
            glossary.signature(),
        );
        Self {
            direction: direction.to_string(),
            requested_voice_model: requested_voice_model.clone(),
            target_language,
            voice,
            instructions,
            glossary,
            omni_speech_config,
            provider,
            secondary_subtitle_provider,
            configuration_error,
            subtitle_translation_model_id: subtitle_model_id.to_string(),
            realtime_audio_mode: effective_audio_mode.clone(),
            legacy_vad_bypass,
            vad_policy,
            subtitle_fallback_policy,
            speech_dispatch_policy,
            speech_output_enabled,
            translation_audio_source,
            model_protocol_authority,
            session_reuse_key: SessionReuseKey {
                direction: direction.to_string(),
                model: reuse_model,
                source_language: session_source_language,
                target_language: session_target_language,
                realtime_audio_mode: effective_audio_mode.clone(),
                subtitle_translate_active,
                output_mode: omni_output_mode,
                contract_signature,
            },
            kind,
        }
    }
}

fn resolve_realtime_voice(
    authority: Option<&AuthorizedModelProtocolProfile>,
    configured_voice: &str,
) -> String {
    let configured_voice = configured_voice.trim();
    if configured_voice.is_empty() || ["auto", "default", "Ethan"].iter().any(|value| configured_voice.eq_ignore_ascii_case(value)) {
        // Ethan is the legacy app-wide default, not a valid selectable voice
        // for these exact Bailian adapters. Only that inherited default is
        // upgraded; a different explicit voice still undergoes typed admission.
        if let Some(authority) = authority.filter(|a| crate::audio::bailian_dialogue::is_supported_authority(a)) {
            return if authority.adapter_id == "desktop-omni-session-v2" { "Tina" }
                else if authority.exact_model_id == "qwen-audio-3.1-realtime-plus" { "longanqian_v3.1" }
                else { "longanqian" }.to_string();
        }
    }
    configured_voice.to_string()
}

/// Effective translation target for a route direction. Inbound keeps the
/// subtitle target (peer speech -> user language). Outbound reverses the
/// pair: the microphone is translated into the peer's language, taken from
/// the explicit `outboundTargetLanguage`, otherwise derived from the subtitle
/// source language, and finally falling back to English when that is `auto`.
pub(super) fn resolve_route_target_language(direction: &str, config: &Value) -> String {
    if direction == "outbound" {
        if let Some(configured) = config
            .pointer("/subtitles/outboundTargetLanguage")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|lang| !lang.is_empty())
        {
            return configured.to_string();
        }
        return subtitle_source_language_or_english(config);
    }
    config
        .pointer("/subtitles/targetLanguage")
        .and_then(Value::as_str)
        .unwrap_or("zh-CN")
        .to_string()
}

/// Subtitle source language for outbound translation: the configured source,
/// trimmed and rejected when empty or `auto`, otherwise English. Shared with
/// the subtitle translate worker's outbound-target derivation.
pub(crate) fn subtitle_source_language_or_english(config: &Value) -> String {
    config
        .pointer("/subtitles/sourceLanguage")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|lang| !lang.is_empty() && !lang.eq_ignore_ascii_case("auto"))
        .unwrap_or("en")
        .to_string()
}

/// Instructions persisted by older versions were weak enough that models
/// replied conversationally; treat them as "unset" so the new defaults apply.


fn is_official_registry_seed(entry: &ProviderModelCapabilityRegistryEntryInput) -> bool {
    entry.id.starts_with("seed-") && entry.source.as_deref() == Some("official")
}

fn selected_registry_entry<'a>(
    provider: &'a ProviderDraftInput,
    model: &str,
) -> Option<&'a ProviderModelCapabilityRegistryEntryInput> {
    let matches_model = |entry: &&ProviderModelCapabilityRegistryEntryInput| {
        entry.model_id.trim().eq_ignore_ascii_case(model.trim())
    };
    provider
        .local_model_capability_registry
        .iter()
        .filter(matches_model)
        .find(|entry| !is_official_registry_seed(entry))
        .or_else(|| {
            provider
                .local_model_capability_registry
                .iter()
                .find(|entry| entry.model_id.trim().eq_ignore_ascii_case(model.trim()))
        })
}

pub(crate) fn resolve_realtime_profile(
    provider: &ProviderDraftInput,
    model: &str,
) -> ResolvedRealtimeProfile {
    resolve_realtime_profile_for_operation(provider, model, None)
}

pub(crate) fn resolve_realtime_profile_for_operation(provider: &ProviderDraftInput, model: &str, operation: Option<&str>) -> ResolvedRealtimeProfile {
    let manifest_realtime = if is_dashscope_provider(provider) { Ok(None) } else { authorize_realtime_provider_for_model(provider, model) };
    let (manifest_protocol, manifest_route_kind, manifest_authority, manifest_error) = match manifest_realtime {
        Ok(Some(authority)) => {
            let route = realtime_route(&authority.adapter_id, &authority.operation);
            let protocol = match route {
                Some(RealtimeAdapterRoute::OpenAiConversation) => Some(RealtimeProtocol::OpenAiConversation),
                Some(RealtimeAdapterRoute::OpenAiTranslation) => Some(RealtimeProtocol::OpenAiTranslation),
                Some(RealtimeAdapterRoute::OpenAiTranscription) => Some(RealtimeProtocol::OpenAiTranscription),
                Some(RealtimeAdapterRoute::GeminiLive) => Some(RealtimeProtocol::GeminiLive),
                Some(RealtimeAdapterRoute::TencentSpeechTranslation) | None => None,
            };
            if route == Some(RealtimeAdapterRoute::TencentSpeechTranslation) {
                (None, Some(ResolvedRouteKind::TencentSpeechTranslate), Some(authority), None)
            } else {
                match protocol {
                Some(protocol) => (Some(protocol), None, Some(authority), None),
                None => (None, None, None, Some(format!(
                    "provider_manifest.route_unsupported: adapter '{}'/{} has no realtime route",
                    authority.adapter_id, authority.operation
                ))),
                }
            }
        }
        Ok(None) => (None, None, None, None),
        Err(error) => (None, None, None, Some(error)),
    };
    let exact_bailian_manifest_model = lookup_model_protocol_profiles_for_inspection(model)
        .is_ok_and(|profiles| !profiles.is_empty());
    let bailian_provider_family_mismatch =
        exact_bailian_manifest_model && !is_dashscope_provider(provider);
    let registry_matches = provider
        .local_model_capability_registry
        .iter()
        .filter(|entry| entry.model_id.trim().eq_ignore_ascii_case(model.trim()))
        .collect::<Vec<_>>();
    let registry_entry = if provider.model_registry_version == Some(2) { None } else { selected_registry_entry(provider, model) };
    let mut diagnostics = if provider.model_registry_version != Some(2) && registry_matches.len() > 1 {
        vec![format!(
            "duplicate realtime registry entries for '{model}'; selected entry '{}' is effective",
            registry_entry
                .map(|entry| entry.id.as_str())
                .unwrap_or("(none)")
        )]
    } else {
        Vec::new()
    };
    let requested_operation = operation.map(str::to_string).map(Ok)
        .unwrap_or_else(|| primary_bailian_operation(provider, model).map(str::to_string));
    let bailian_authorization = is_dashscope_provider(provider).then(|| {
        let operation = requested_operation.as_ref().map_err(Clone::clone)?;
        resolve_bailian_model_protocol_authority(provider, model, operation)
    });
    let (model_protocol_authority, bailian_protocol_error) = match bailian_authorization {
        Some(Ok(authority)) => (Some(authority), None),
        Some(Err(error)) => (None, Some(error)),
        None if bailian_provider_family_mismatch => (
            None,
            Some(
                "model_protocol.provider_family_mismatch: exact Bailian model requires provider kind 'dashscope'"
                    .to_string(),
            ),
        ),
        None => (None, None),
    };
    let model_protocol_error = manifest_error.or(bailian_protocol_error);
    let resolved_registry_protocol = registry_entry.and_then(|e| registry_protocol(provider, e));
    let (protocol_dialect, source) = if model_protocol_error.is_some() {
        (None, RealtimeProfileSource::None)
    } else if let Some(protocol) = manifest_protocol {
        (Some(protocol), RealtimeProfileSource::Manifest)
    } else if manifest_route_kind.is_some() {
        (None, RealtimeProfileSource::Manifest)
    } else if bailian_provider_family_mismatch {
        (None, RealtimeProfileSource::None)
    } else if is_dashscope_provider(provider) {
        match model_protocol_authority
            .as_ref()
            .and_then(bailian_protocol_from_authority)
        {
            Some(protocol) => (Some(protocol), RealtimeProfileSource::Manifest),
            None => (None, RealtimeProfileSource::None),
        }
    } else if let Some(protocol) = resolved_registry_protocol {
        (Some(protocol), RealtimeProfileSource::Registry)
    } else if let Some(protocol) = provider
        .template_realtime_protocol
        .as_deref()
        .and_then(parse_realtime_protocol)
    {
        (Some(protocol), RealtimeProfileSource::Template)
    } else if let Some(protocol) = provider
        .realtime_protocol
        .as_deref()
        .and_then(parse_realtime_protocol)
    {
        (Some(protocol), RealtimeProfileSource::Provider)
    } else {
        (None, RealtimeProfileSource::None)
    };
    let manifest_audio_mode = manifest_authority.as_ref().map(|authority| {
        if authority.adapter_id == "gemini-live" {
            "gemini_auto_activity"
        } else if authority.vad_modes.iter().any(|mode| mode == "server-vad") {
            "server_vad"
        } else if authority.vad_modes.iter().any(|mode| mode == "semantic-vad") {
            "semantic_vad"
        } else {
            "manual"
        }
    });
    let realtime_audio_mode = manifest_audio_mode
        .map(str::to_string)
        .or_else(|| registry_entry
            .and_then(|entry| entry.realtime_audio_mode.as_deref())
            .filter(|mode| !mode.trim().is_empty())
            .map(str::to_string))
        .unwrap_or_else(|| match protocol_dialect {
            Some(RealtimeProtocol::DashscopeOmni) => "manual".to_string(),
            Some(RealtimeProtocol::GeminiLive) => "gemini_auto_activity".to_string(),
            _ => "server_vad".to_string(),
        });
    let inherited_interaction = registry_entry.map(|entry| entry.interaction_capabilities.clone())
        .unwrap_or_else(|| match realtime_audio_mode.as_str() {
            "server_vad" | "semantic_vad" => vec!["auto_vad".to_string()],
            "manual" => vec!["manual_commit".to_string()],
            _ => Vec::new(),
        });
    let mut inherited = serde_json::json!({"realtimeAudioMode":realtime_audio_mode,"interactionCapabilities":inherited_interaction});
    if provider.model_registry_version == Some(2) {
        match crate::provider::provider_manifest::manifest_model_capability_metadata(provider, model, model_protocol_authority.as_ref()) {
            Ok(Some(metadata)) => inherited = metadata,
            Ok(None) => {},
            Err(error) => diagnostics.push(error),
        }
    }
    let effective = if provider.model_registry_version == Some(2) {
        let registry = crate::provider::contracts::ProviderModelRegistryInput {
            model_registry_version: provider.model_registry_version,
            model_capability_overrides: provider.model_capability_overrides.clone(),
        };
        let (resolved, issues) = registry.resolve(model, Some(&inherited));
        diagnostics.extend(issues.into_iter().map(str::to_string));
        resolved.unwrap_or(inherited)
    } else { inherited };
    let realtime_audio_mode = effective.get("realtimeAudioMode").and_then(Value::as_str)
        .unwrap_or(&realtime_audio_mode).to_string();
    let interaction_capabilities = effective.get("interactionCapabilities").and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let route_kind = manifest_route_kind.unwrap_or_else(|| match protocol_dialect {
        Some(RealtimeProtocol::DashscopeOmni | RealtimeProtocol::DashscopeQwenAudio | RealtimeProtocol::DashscopeLivetranslate) => {
            ResolvedRouteKind::Omni
        }
        Some(RealtimeProtocol::DashscopeAsr) => ResolvedRouteKind::DashscopeStt,
        Some(RealtimeProtocol::GeminiLive) => ResolvedRouteKind::GeminiLive,
        Some(
            RealtimeProtocol::OpenAiConversation
            | RealtimeProtocol::OpenAiTranslation
            | RealtimeProtocol::OpenAiTranscription
            | RealtimeProtocol::OpenAiFlat,
        ) => ResolvedRouteKind::OpenAiRealtime,
        None => ResolvedRouteKind::LocalVad,
    });
    let translation_execution = match protocol_dialect {
        Some(RealtimeProtocol::DashscopeOmni | RealtimeProtocol::DashscopeQwenAudio) => "prompted-realtime",
        Some(RealtimeProtocol::DashscopeLivetranslate | RealtimeProtocol::OpenAiTranslation) => "dedicated-realtime",
        _ if route_kind == ResolvedRouteKind::TencentSpeechTranslate => "dedicated-realtime",
        _ => "text-worker",
    };
    let native_translation = route_kind == ResolvedRouteKind::TencentSpeechTranslate || matches!(
        protocol_dialect,
        Some(
            RealtimeProtocol::DashscopeOmni
                | RealtimeProtocol::DashscopeQwenAudio
                | RealtimeProtocol::DashscopeLivetranslate
                | RealtimeProtocol::OpenAiTranslation
        )
    );
    let native_audio_output = if let Some(authority) = manifest_authority.as_ref() {
        authority.capabilities.iter().any(|capability| {
            capability == "speech-to-speech" || capability == "text-to-speech"
        })
    } else if is_dashscope_provider(provider) {
        model_protocol_authority
            .as_ref()
            .is_some_and(|authority| !authority.audio_output.codecs.is_empty())
    } else {
        registry_entry
            .map(|entry| {
                entry.capabilities.iter().any(|capability| {
                    capability == "speech-to-speech" || capability == "text-to-speech"
                })
            })
            .unwrap_or(matches!(
                protocol_dialect,
                Some(
                    RealtimeProtocol::DashscopeOmni
                        | RealtimeProtocol::OpenAiConversation
                        | RealtimeProtocol::GeminiLive
                )
            ))
    };
    let server_segmentation = route_kind != ResolvedRouteKind::LocalVad;
    let preconnect_allowed = route_kind == ResolvedRouteKind::Omni;
    let secondary_translation_policy = if translation_execution != "text-worker" { "native" } else { "secondary" };
    let speech_dispatch_policy = if native_audio_output {
        "native-audio"
    } else if native_translation {
        "disabled"
    } else {
        "subtitle-tts"
    };
    let preconnect_policy = if preconnect_allowed { "allowed" } else { "disabled" };
    let dashscope_realtime = matches!(
        protocol_dialect,
        Some(
            RealtimeProtocol::DashscopeOmni
                | RealtimeProtocol::DashscopeQwenAudio
                | RealtimeProtocol::DashscopeLivetranslate
                | RealtimeProtocol::DashscopeAsr
        )
    );
    let input_format = if matches!(
        protocol_dialect,
        Some(RealtimeProtocol::DashscopeLivetranslate | RealtimeProtocol::DashscopeAsr | RealtimeProtocol::DashscopeOmni | RealtimeProtocol::DashscopeQwenAudio)
    ) {
        "pcm"
    } else {
        "pcm16"
    };
    ResolvedRealtimeProfile {
        provider_id: provider.provider_id.clone(),
        model_id: model.to_string(),
        route_kind,
        protocol_dialect,
        realtime_audio_mode,
        interaction_capabilities,
        input_format: input_format.to_string(),
        output_format: native_audio_output
            .then(|| if dashscope_realtime { "pcm" } else { "pcm16" }.to_string()),
        sample_rate: if dashscope_realtime
            || matches!(
                protocol_dialect,
                Some(RealtimeProtocol::OpenAiFlat | RealtimeProtocol::GeminiLive)
            )
        {
            16_000
        } else {
            24_000
        },
        server_segmentation,
        native_translation,
        invocation_operation: model_protocol_authority.as_ref().map(|a| a.operation.clone()).unwrap_or_else(|| requested_operation.unwrap_or_else(|_| "native_translate".to_string())),
        translation_execution: translation_execution.to_string(),
        native_audio_output,
        secondary_translation_policy: secondary_translation_policy.to_string(),
        speech_dispatch_policy: speech_dispatch_policy.to_string(),
        preconnect_policy: preconnect_policy.to_string(),
        preconnect_allowed,
        timeout_budget_ms: if route_kind == ResolvedRouteKind::Omni {
            95_000
        } else {
            30_000
        },
        source,
        model_protocol_authority,
        model_protocol_error,
        diagnostics,
    }
}

pub(super) fn is_omni_route_model(provider: &ProviderDraftInput, model: &str) -> bool {
    resolve_realtime_profile(provider, model).route_kind == ResolvedRouteKind::Omni
}

pub(crate) fn is_livetranslate_route_model(provider: &ProviderDraftInput, model: &str) -> bool {
    resolve_realtime_profile(provider, model).protocol_dialect
        == Some(RealtimeProtocol::DashscopeLivetranslate)
}

#[cfg(test)]
pub(super) fn is_openai_realtime_provider(provider: &ProviderDraftInput) -> bool {
    resolve_realtime_profile(provider, &provider.model).route_kind
        == ResolvedRouteKind::OpenAiRealtime
}

fn resolve_legacy_vad_bypass_for_route(direction: &str, config: &Value) -> bool {
    let configured = config
        .pointer("/vad/bypass")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if direction == "inbound" && super::configured_route_mode(config) == "watch" {
        return false;
    }
    configured
}

#[cfg(test)]
pub(super) fn resolve_realtime_audio_mode_value(provider: &ProviderDraftInput, model: &str) -> String {
    resolve_realtime_profile(provider, model).realtime_audio_mode
}

#[cfg(test)]
pub(super) fn resolve_realtime_audio_mode_for_route(
    direction: &str,
    config: &Value,
    provider: &ProviderDraftInput,
) -> Result<omni::RealtimeAudioMode, String> {
    let profile = resolve_realtime_profile(provider, &provider.model);
    let legacy_bypass = resolve_legacy_vad_bypass_for_route(direction, config);
    let (mode, error) = resolve_route_audio_mode(
        direction,
        config,
        provider,
        &profile,
        legacy_bypass,
    );
    if let Some(error) = error {
        return Err(error);
    }
    omni::RealtimeAudioMode::from_config_value(Some(&mode), &provider.model)
}

fn is_dashscope_provider(provider: &ProviderDraftInput) -> bool {
    provider.kind == "dashscope"
}

#[cfg(test)]
pub(super) fn should_start_secondary_speech_dispatch(
    config: &Value,
    st_active: bool,
    speech_dispatch_state: &str,
) -> bool {
    st_active
        && speech::speech_output_enabled(config)
        && speech_dispatch_state == "idle"
        && speech::resolve_translation_audio_source(config, true)
            == speech::TranslationAudioSource::SubtitleTts
}

#[cfg(test)]
mod primary_audio_authorization_context_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn task_asr_missing_primary_text_is_rejected_at_route_plan_boundary() {
        let config = json!({
            "providers": [{"templateId":"task", "providerId":"task-provider", "kind":"dashscope",
                "displayName":"Task", "model":"qwen-audio-3.1-asr-flash-streaming",
                "baseUrl":"https://dashscope.aliyuncs.com/api/v1", "region":"cn-beijing",
                "transport":"websocket", "streamEnabled":true, "timeoutMs":1000,
                "authRef":{"kind":"header","reference":"fixture", "headerName":"Authorization", "scheme":"Bearer"},
                "systemPromptTemplate":"", "modelRegistryVersion":2}],
            "devices":{"primaryTextTranslationModelId":"", "subtitleTranslationMode":"native", "subtitleTranslationModelId":"stale::unused"}
        });
        let reference="task::qwen-audio-3.1-asr-flash-streaming";
        let provider=resolve_model_provider_from_config_value(&config,reference).unwrap();
        let plan=ResolvedRoutePlan::from_resolved_provider("inbound", &config, reference.to_string(), provider);
        assert!(plan.model_protocol_authority.is_some());
        let error=plan.configuration_error.unwrap();
        assert!(error.contains("primary-text")); assert!(error.contains("session.model-reference-invalid"));
        assert!(plan.secondary_subtitle_provider.is_none());
    }

    #[test]
    fn primary_audio_authorization_failure_keeps_actual_model_and_native_subtitle_role() {
        for model in ["qwen3.8-omni-flash-realtime-unknown", "qwen3.5-omni-plus-realtime"] {
            let config = json!({
                "providers": [{
                    "templateId": "template-dashscope-workspace",
                    "providerId": "provider-context-fixture",
                    "kind": "dashscope",
                    "displayName": "Route context fixture",
                    "model": "qwen3.8-livetranslate-flash-realtime",
                    "baseUrl": "wss://llm-context.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
                    "transport": "websocket",
                    "authRef": {"kind": "header", "reference": "redacted", "headerName": "Authorization", "scheme": "Bearer"},
                    "region": "cn-beijing", "streamEnabled": true, "timeoutMs": 1000,
                    "systemPromptTemplate": "", "modelRegistryVersion": 2
                }],
                "devices": {"subtitleTranslationMode": "native", "subtitleTranslationModelId": ""}
            });
            let reference = format!("template-dashscope-workspace::{model}");
            let provider = resolve_model_provider_from_config_value(&config, &reference).unwrap();
            let raw_error = resolve_realtime_profile(&provider, model).model_protocol_error.unwrap();
            for direction in ["inbound", "outbound"] {
                let plan = ResolvedRoutePlan::from_resolved_provider(direction, &config, reference.clone(), provider.clone());
                assert!(plan.secondary_subtitle_provider.is_none());
                assert_eq!(plan.subtitle_fallback_policy, SubtitleFallbackPolicy::Native);
                let error = plan.configuration_error.expect("primary authorization must remain fail-closed");
                assert!(error.starts_with(&raw_error));
                assert!(error.contains("code: session.model-reference-invalid"));
                let context = error.split(" | modelContext: ").nth(1).unwrap().split(" | code:").next().unwrap();
                let context: Value = serde_json::from_str(context).unwrap();
                assert_eq!(context["modelRole"], "primary-audio");
                assert_eq!(context["modelId"], model);
                assert_eq!(context["providerId"], "provider-context-fixture");
                assert_eq!(context["modelReference"], reference);
                assert_eq!(context["direction"], direction);
                assert!(context.get("alternate").is_none());
            }
        }
    }
}
