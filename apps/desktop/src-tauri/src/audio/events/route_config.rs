#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolvedRouteKind {
    GeminiLive,
    Omni,
    OpenAiRealtime,
    DashscopeStt,
    LocalVad,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolvedVadPolicy {
    ManualCommit,
    ServerVad,
    GeminiAutoActivity,
    GeminiManualActivity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubtitleFallbackPolicy {
    Native,
    Secondary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpeechDispatchPolicy {
    Disabled,
    SubtitleTtsWhenIdle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionReuseKey {
    direction: String,
    model: String,
    subtitle_translate_active: bool,
}

#[derive(Debug, Clone)]
struct ResolvedRoutePlan {
    direction: String,
    requested_voice_model: String,
    target_language: String,
    voice: String,
    instructions: String,
    omni_speech_config: omni::OmniSpeechConfig,
    provider: ProviderDraftInput,
    secondary_subtitle_provider: Option<ProviderDraftInput>,
    subtitle_translation_model_id: String,
    realtime_audio_mode: String,
    legacy_vad_bypass: bool,
    vad_policy: ResolvedVadPolicy,
    subtitle_fallback_policy: SubtitleFallbackPolicy,
    speech_dispatch_policy: SpeechDispatchPolicy,
    speech_output_enabled: bool,
    translation_audio_source: speech::TranslationAudioSource,
    session_reuse_key: SessionReuseKey,
    kind: ResolvedRouteKind,
}

impl ResolvedRoutePlan {
    fn from_resolved_provider(
        direction: &str,
        config: &Value,
        requested_voice_model: String,
        provider: ProviderDraftInput,
    ) -> Self {
        let realtime_audio_mode = resolve_realtime_audio_mode_value(&provider, &provider.model);
        let effective_audio_mode = if resolve_legacy_vad_bypass_for_route(direction, config) {
            "manual".to_string()
        } else {
            realtime_audio_mode.clone()
        };
        let kind = if gemini_live::is_gemini_activity_mode(&realtime_audio_mode) {
            ResolvedRouteKind::GeminiLive
        } else if is_omni_model(&provider.model) {
            ResolvedRouteKind::Omni
        } else if is_openai_realtime_provider(&provider) {
            ResolvedRouteKind::OpenAiRealtime
        } else if is_dashscope_provider(&provider) {
            ResolvedRouteKind::DashscopeStt
        } else {
            ResolvedRouteKind::LocalVad
        };
        let (subtitle_mode, subtitle_model_id) = subtitle_translate_mode_and_model(config);
        let secondary_subtitle_provider = (subtitle_mode == "secondary" && !subtitle_model_id.trim().is_empty())
            .then(|| resolve_model_provider_from_config_value(config, subtitle_model_id))
            .flatten();
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
        let default_instructions = if kind == ResolvedRouteKind::Omni {
            "你是一个实时翻译助手，请将听到的外语内容翻译成中文输出。"
        } else {
            "You are a realtime subtitle translator. Translate incoming audio into concise subtitles."
        };
        Self {
            direction: direction.to_string(),
            requested_voice_model: requested_voice_model.clone(),
            target_language: config
                .pointer("/subtitles/targetLanguage")
                .and_then(Value::as_str)
                .unwrap_or("zh")
                .to_string(),
            voice: config
                .pointer("/speech/voice")
                .and_then(Value::as_str)
                .unwrap_or("Ethan")
                .to_string(),
            instructions: config
                .pointer("/subtitles/instructions")
                .and_then(Value::as_str)
                .unwrap_or(default_instructions)
                .to_string(),
            omni_speech_config: omni::OmniSpeechConfig::from_config(config),
            provider,
            secondary_subtitle_provider,
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
            },
            kind,
        }
    }
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

fn is_omni_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("realtime") && (lower.contains("omni") || lower.contains("livetranslate"))
}

fn is_openai_realtime_provider(provider: &ProviderDraftInput) -> bool {
    provider.kind == "openai-compatible" && {
        let lower = provider.model.to_ascii_lowercase();
        lower.contains("realtime") || lower.contains("live")
    }
}

fn resolve_legacy_vad_bypass_for_route(direction: &str, config: &Value) -> bool {
    let configured = config
        .pointer("/vad/bypass")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let route_mode = config
        .pointer("/devices/routeMode")
        .and_then(Value::as_str)
        .unwrap_or("");
    if direction == "inbound" && route_mode == "watch" {
        return false;
    }
    configured
}

fn default_realtime_audio_mode_name(model: &str) -> &'static str {
    let lower = model.to_ascii_lowercase();
    if lower.contains("livetranslate") {
        "server_vad"
    } else if lower.contains("omni") && lower.contains("realtime") {
        "manual"
    } else if lower.contains("gemini") && (lower.contains("live") || lower.contains("realtime")) {
        "gemini_auto_activity"
    } else {
        "server_vad"
    }
}

fn resolve_realtime_audio_mode_value(provider: &ProviderDraftInput, model: &str) -> String {
    let normalized_model = model.trim().to_ascii_lowercase();
    provider
        .local_model_capability_registry
        .iter()
        .find(|entry| {
            entry
                .model_id
                .trim()
                .eq_ignore_ascii_case(&normalized_model)
        })
        .and_then(|entry| entry.realtime_audio_mode.as_deref())
        .filter(|mode| !mode.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_realtime_audio_mode_name(model).to_string())
}

#[cfg(test)]
fn resolve_realtime_audio_mode_for_route(
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

fn is_dashscope_provider(provider: &ProviderDraftInput) -> bool {
    provider.kind == "dashscope"
        || provider.template_id.to_lowercase().contains("dashscope")
        || provider.model.to_lowercase().contains("dashscope")
}

#[cfg(test)]
fn should_start_secondary_speech_dispatch(
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

fn resolve_model_provider_from_config(
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
        for provider_value in &providers {
            let parsed: Option<ProviderDraftInput> =
                serde_json::from_value(provider_value.clone()).ok();
            if let Some(mut provider) = parsed {
                if provider.template_id == template_id {
                    provider.model = model_id.to_string();
                    return Some(provider);
                }
            }
        }
        return None;
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
            if is_omni_model(composite_model_id) && is_dashscope_provider(&provider) {
                let mut p = provider;
                p.model = composite_model_id.to_string();
                return Some(p);
            }
        }
    }

    None
}
