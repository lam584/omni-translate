use serde_json::Value;
use tauri::AppHandle;

use super::super::{omni, speech};
use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::{ProviderDraftInput, ProviderModelCapabilityRegistryEntryInput};

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
    Registry,
    Template,
    Provider,
    ModelName,
    None,
}

impl RealtimeProfileSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Registry => "registry",
            Self::Template => "template",
            Self::Provider => "provider",
            Self::ModelName => "model-name",
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
    pub(crate) input_format: String,
    pub(crate) output_format: Option<String>,
    pub(crate) sample_rate: u32,
    pub(crate) server_segmentation: bool,
    pub(crate) native_translation: bool,
    pub(crate) native_audio_output: bool,
    pub(crate) secondary_translation_policy: String,
    pub(crate) speech_dispatch_policy: String,
    pub(crate) preconnect_policy: String,
    pub(crate) preconnect_allowed: bool,
    pub(crate) timeout_budget_ms: u64,
    pub(crate) source: RealtimeProfileSource,
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
    pub(super) subtitle_translate_active: bool,
    pub(super) output_mode: omni::OmniOutputMode,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedRoutePlan {
    pub(super) direction: String,
    pub(super) requested_voice_model: String,
    pub(super) target_language: String,
    pub(super) voice: String,
    pub(super) instructions: String,
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
        let realtime_profile = resolve_realtime_profile(&provider, &provider.model);
        let realtime_audio_mode = realtime_profile.realtime_audio_mode.clone();
        let effective_audio_mode = if resolve_legacy_vad_bypass_for_route(direction, config) {
            "manual".to_string()
        } else {
            realtime_audio_mode.clone()
        };
        let kind = if realtime_profile.source != RealtimeProfileSource::None {
            realtime_profile.route_kind
        } else if is_openai_realtime_provider(&provider) {
            // Explicit realtime/live/transcribe models keep their protocol
            // semantics even when hosted behind a tencent-flavored template.
            ResolvedRouteKind::OpenAiRealtime
        } else if is_tencent_speech_translate_provider(&provider) {
            ResolvedRouteKind::TencentSpeechTranslate
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
        let configuration_error = (secondary_requested && secondary_subtitle_provider.is_none()).then(|| {
            super::super::omni::session_errors::with_error_markers(
                &format!("Configured subtitle translation model '{subtitle_model_id}' cannot be resolved to an enabled provider"),
                super::super::omni::session_errors::SessionErrorCode::ModelReferenceInvalid,
            )
        });
        let subtitle_translate_active = secondary_subtitle_provider.is_some();
        let subtitle_fallback_policy = if subtitle_translate_active {
            SubtitleFallbackPolicy::Secondary
        } else {
            SubtitleFallbackPolicy::Native
        };
        let speech_output_enabled = speech::speech_output_enabled(config);
        let translation_audio_source = speech::resolve_translation_audio_source(config, true);
        let speech_dispatch_policy = if subtitle_translate_active
            && speech_output_enabled
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
        let legacy_vad_bypass = resolve_legacy_vad_bypass_for_route(direction, config);
        let reuse_model = provider.model.clone();
        let omni_speech_config = omni::OmniSpeechConfig::from_config(config);
        let omni_output_mode = omni::OmniOutputMode::from_speech_config(&omni_speech_config);
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
        let voice = resolve_realtime_voice(&provider.model, configured_voice);
        Self {
            direction: direction.to_string(),
            requested_voice_model: requested_voice_model.clone(),
            target_language,
            voice,
            instructions: config
                .pointer("/subtitles/instructions")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty() && !is_legacy_default_instructions(text))
                .map(str::to_string)
                .unwrap_or(default_instructions),
            omni_speech_config,
            provider,
            secondary_subtitle_provider,
            configuration_error,
            subtitle_translation_model_id: subtitle_model_id.to_string(),
            realtime_audio_mode: effective_audio_mode,
            legacy_vad_bypass,
            vad_policy,
            subtitle_fallback_policy,
            speech_dispatch_policy,
            speech_output_enabled,
            translation_audio_source,
            session_reuse_key: SessionReuseKey {
                direction: direction.to_string(),
                model: reuse_model,
                subtitle_translate_active,
                output_mode: omni_output_mode,
            },
            kind,
        }
    }
}

fn resolve_realtime_voice(model: &str, configured_voice: &str) -> String {
    let model = model.trim().to_ascii_lowercase();
    let configured_voice = configured_voice.trim();
    if model.starts_with("qwen-audio-3.0-realtime")
        && (configured_voice.is_empty() || configured_voice.eq_ignore_ascii_case("Ethan"))
    {
        // Ethan is an Omni/OpenAI-style preset and Qwen-Audio rejects it.
        // Use Qwen-Audio's documented system default so the first session does
        // not fail and reconnect without a usable voice.
        "longanqian".to_string()
    } else {
        configured_voice.to_string()
    }
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
fn is_legacy_default_instructions(text: &str) -> bool {
    matches!(
        text,
        "你是一个实时翻译助手，请将听到的外语内容翻译成中文输出。"
            | "You are a realtime subtitle translator. Translate incoming audio into concise subtitles."
    )
}

fn subtitle_translate_mode_and_model(config: &Value) -> (&str, &str) {
    let mode = config
        .pointer("/devices/subtitleTranslationMode")
        .and_then(Value::as_str)
        .unwrap_or("secondary");
    let model_id = config
        .pointer("/devices/subtitleTranslationModelId")
        .and_then(Value::as_str)
        .unwrap_or("");
    (mode, model_id)
}

pub(super) fn infer_legacy_omni_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("realtime") && (lower.contains("omni") || lower.contains("livetranslate"))
}

fn is_named_dashscope_realtime_model(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    lower.starts_with("qwen")
        && lower.contains("realtime")
        && (lower.contains("omni")
            || lower.contains("livetranslate")
            || lower.contains("audio")
            || lower.contains("asr"))
}

fn parse_realtime_protocol(value: &str) -> Option<RealtimeProtocol> {
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

fn registry_protocol(
    _provider: &ProviderDraftInput,
    entry: &ProviderModelCapabilityRegistryEntryInput,
) -> Option<RealtimeProtocol> {
    entry
        .realtime_protocol
        .as_deref()
        .and_then(parse_realtime_protocol)
}

fn infer_realtime_protocol(
    provider: &ProviderDraftInput,
    model: &str,
) -> Option<RealtimeProtocol> {
    let lower = model.trim().to_ascii_lowercase();
    if lower.contains("gemini")
        && (lower.contains("live") || lower.contains("realtime") || lower.contains("native-audio"))
    {
        return Some(RealtimeProtocol::GeminiLive);
    }
    if is_dashscope_provider(provider) {
        if lower.contains("livetranslate") {
            return Some(RealtimeProtocol::DashscopeLivetranslate);
        }
        if lower.contains("omni") && lower.contains("realtime") {
            return Some(RealtimeProtocol::DashscopeOmni);
        }
        if lower.contains("asr") && lower.contains("realtime") {
            return Some(RealtimeProtocol::DashscopeAsr);
        }
        if lower.contains("qwen-audio") && lower.contains("realtime") {
            return Some(RealtimeProtocol::DashscopeOmni);
        }
    }
    if provider.kind == "openai-compatible" {
        if lower.contains("translate") {
            return Some(RealtimeProtocol::OpenAiTranslation);
        }
        if lower.contains("transcribe") || lower.contains("whisper") {
            return Some(RealtimeProtocol::OpenAiTranscription);
        }
        if lower.contains("realtime") || lower.contains("live") {
            return Some(RealtimeProtocol::OpenAiConversation);
        }
    }
    None
}

pub(crate) fn resolve_realtime_profile(
    provider: &ProviderDraftInput,
    model: &str,
) -> ResolvedRealtimeProfile {
    let registry_matches = provider
        .local_model_capability_registry
        .iter()
        .filter(|entry| entry.model_id.trim().eq_ignore_ascii_case(model.trim()))
        .collect::<Vec<_>>();
    let registry_entry = registry_matches.first().copied();
    let diagnostics = if registry_matches.len() > 1 {
        vec![format!(
            "duplicate realtime registry entries for '{model}'; first entry '{}' is effective",
            registry_matches[0].id
        )]
    } else {
        Vec::new()
    };
    let resolved_registry_protocol = registry_entry.and_then(|e| registry_protocol(provider, e));
    let (protocol_dialect, source) = if let Some(protocol) = resolved_registry_protocol {
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
    } else if let Some(protocol) = infer_realtime_protocol(provider, model) {
        (Some(protocol), RealtimeProfileSource::ModelName)
    } else {
        (None, RealtimeProfileSource::None)
    };
    let realtime_audio_mode = registry_entry
        .and_then(|entry| entry.realtime_audio_mode.as_deref())
        .filter(|mode| !mode.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| match protocol_dialect {
            Some(RealtimeProtocol::DashscopeOmni) => "manual".to_string(),
            Some(RealtimeProtocol::GeminiLive) => "gemini_auto_activity".to_string(),
            _ if source == RealtimeProfileSource::ModelName => {
                default_realtime_audio_mode_name(model).to_string()
            }
            _ => "server_vad".to_string(),
        });
    let route_kind = match protocol_dialect {
        Some(RealtimeProtocol::DashscopeOmni | RealtimeProtocol::DashscopeLivetranslate) => {
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
    };
    let native_translation = matches!(
        protocol_dialect,
        Some(
            RealtimeProtocol::DashscopeOmni
                | RealtimeProtocol::DashscopeLivetranslate
                | RealtimeProtocol::OpenAiTranslation
        )
    );
    let native_audio_output = registry_entry
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
        ));
    let server_segmentation = route_kind != ResolvedRouteKind::LocalVad;
    let preconnect_allowed = route_kind == ResolvedRouteKind::Omni;
    let secondary_translation_policy = if native_translation { "native" } else { "secondary" };
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
                | RealtimeProtocol::DashscopeLivetranslate
                | RealtimeProtocol::DashscopeAsr
        )
    );
    let input_format = if matches!(
        protocol_dialect,
        Some(RealtimeProtocol::DashscopeLivetranslate | RealtimeProtocol::DashscopeAsr)
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

fn default_realtime_audio_mode_name(model: &str) -> &'static str {
    let lower = model.to_ascii_lowercase();
    if model_name_is_livetranslate(&lower) {
        "server_vad"
    } else if lower.contains("omni") && lower.contains("realtime") {
        "manual"
    } else if lower.contains("gemini") && (lower.contains("live") || lower.contains("realtime")) {
        "gemini_auto_activity"
    } else if lower.contains("whisper") && lower.contains("realtime") {
        // gpt-realtime-whisper streams continuously; OpenAI recommends
        // turn_detection: null with manual commits for it.
        "manual"
    } else {
        "server_vad"
    }
}

#[cfg(test)]
pub(super) fn resolve_realtime_audio_mode_value(provider: &ProviderDraftInput, model: &str) -> String {
    resolve_realtime_profile(provider, model).realtime_audio_mode
}

pub(crate) fn model_name_is_livetranslate(model: &str) -> bool {
    model.to_ascii_lowercase().contains("livetranslate")
}

#[cfg(test)]
pub(super) fn resolve_realtime_audio_mode_for_route(
    direction: &str,
    config: &Value,
    provider: &ProviderDraftInput,
) -> Result<omni::RealtimeAudioMode, String> {
    let configured_mode = resolve_realtime_audio_mode_value(provider, &provider.model);
    let legacy_bypass = resolve_legacy_vad_bypass_for_route(direction, config);
    let mode = if legacy_bypass {
        Some("manual")
    } else {
        Some(configured_mode.as_str())
    };
    omni::RealtimeAudioMode::from_config_value(mode, &provider.model)
}

/// Tencent realtime speech translation rides on the openai-compatible kind
/// (no dedicated ProviderKind). Match only signals specific to the
/// speech_translate product — the WS host, the exact template, or a
/// hunyuan-translation model — so other Tencent-hosted endpoints (e.g. an
/// OpenAI-compatible LLM proxy on tencent infrastructure) are not hijacked.
fn is_tencent_speech_translate_provider(provider: &ProviderDraftInput) -> bool {
    provider.kind == "openai-compatible"
        && (provider
            .base_url
            .to_ascii_lowercase()
            .contains("asr.cloud.tencent.com")
            || provider.template_id == "template-tencent-speech"
            || provider
                .model
                .to_ascii_lowercase()
                .starts_with("hunyuan-translation"))
}

fn is_dashscope_provider(provider: &ProviderDraftInput) -> bool {
    provider.kind == "dashscope"
        || provider.template_id.to_lowercase().contains("dashscope")
        || provider.model.to_lowercase().contains("dashscope")
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

pub(super) fn resolve_model_provider_from_config(
    app: &AppHandle,
    config: &Value,
    composite_model_id: &str,
    purpose: &str,
) -> Option<ProviderDraftInput> {
    let linked_count = config
        .get("linkedProviders")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let _ = append_diagnostics_log(
        app,
        "audio",
        "debug",
        format!(
            "resolve_model_provider_from_config: purpose={purpose} composite_model_id={composite_model_id} linkedProviders={linked_count}"
        ),
        None,
        None,
        None,
    );

    let resolved = resolve_model_provider_from_config_value(config, composite_model_id);
    match &resolved {
        Some(provider) => {
            let _ = append_diagnostics_log(
                app,
                "audio",
                "info",
                format!(
                    "resolve_model_provider_from_config: purpose={purpose} provider_id={} kind={} model={} base_url={} template_id={}",
                    provider.provider_id,
                    provider.kind,
                    provider.model,
                    provider.base_url,
                    provider.template_id
                ),
                None,
                None,
                None,
            );
        }
        None => {
            let target_template = composite_model_id
                .split_once("::")
                .map(|(template_id, _)| template_id)
                .unwrap_or("(main-provider)");
            let _ = append_diagnostics_log(
                app,
                "audio",
                "warning",
                format!(
                    "resolve_model_provider_from_config: purpose={purpose} no provider matched target_template={target_template} composite_model_id={composite_model_id} linkedProviders={linked_count}"
                ),
                None,
                None,
                None,
            );
        }
    }
    resolved
}

/// Resolves a `templateId::modelId` composite against the provider array,
/// overriding the matched provider's model. Shared by the route-config and
/// speech-config resolvers so the composite lookup lives in one place.
pub(crate) fn resolve_composite_template_provider(
    providers: &[Value],
    template_id: &str,
    model_id: &str,
) -> Option<ProviderDraftInput> {
    for provider_value in providers {
        let parsed: Option<ProviderDraftInput> =
            serde_json::from_value(provider_value.clone()).ok();
        if let Some(mut provider) = parsed {
            if provider.template_id == template_id {
                provider.model = model_id.to_string();
                return Some(provider);
            }
        }
    }
    None
}

pub(crate) fn resolve_model_provider_from_config_value(
    config: &Value,
    composite_model_id: &str,
) -> Option<ProviderDraftInput> {
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some((template_id, model_id)) = composite_model_id.split_once("::") {
        return resolve_composite_template_provider(&providers, template_id, model_id);
    }

    // Qwen realtime speech model names belong to the DashScope websocket
    // family. Resolve that provider class before exact model equality so an
    // earlier OpenAI-compatible text provider with a stale/copied model value
    // cannot hijack the Watch route merely because of array order.
    if is_named_dashscope_realtime_model(composite_model_id) {
        for provider_value in &providers {
            let parsed: Option<ProviderDraftInput> =
                serde_json::from_value(provider_value.clone()).ok();
            if let Some(mut provider) = parsed {
                if is_dashscope_provider(&provider) {
                    provider.model = composite_model_id.to_string();
                    return Some(provider);
                }
            }
        }
    }

    // Bare model name: search all providers equally.
    for provider_value in &providers {
        let parsed: Option<ProviderDraftInput> =
            serde_json::from_value(provider_value.clone()).ok();
        if let Some(provider) = parsed {
            if provider.model == composite_model_id {
                return Some(provider);
            }
            if provider
                .scene_model_assignments
                .iter()
                .any(|a| a.model_ids.iter().any(|m| m == composite_model_id))
            {
                let mut p = provider;
                p.model = composite_model_id.to_string();
                return Some(p);
            }
            if is_omni_route_model(&provider, composite_model_id) && is_dashscope_provider(&provider) {
                let mut p = provider;
                p.model = composite_model_id.to_string();
                return Some(p);
            }
        }
    }

    None
}
