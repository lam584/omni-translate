use super::time_utils::now_unix_millis_marker;
use crate::audio::events::resolve_composite_template_provider;

#[derive(Clone)]
struct RouteMixConfig {
    keep_original_audio: bool,
    translated_audio_enabled: bool,
    translated_audio_gain_db: f32,
    translated_audio_auto_gain_enabled: bool,
    original_audio_gain_db: f32,
    ducking_enabled: bool,
    ducking_depth_percent: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SpeechSynthesisProtocol { RealtimeAudio, TaskTts }

#[derive(Clone)]
struct SpeechConfig {
    provider: ProviderDraftInput,
    enabled: bool,
    target_language: String,
    voice: String,
    output_target: String,
    local_playback_enabled: bool,
    virtual_mic_output_enabled: bool,
    bridge_playback_enabled: bool,
    bridge_capture_mode: Option<crate::bridge::contracts::SourceCaptureMode>,
    speaker_device_id: Option<String>,
    speaker_output_level: u64,
    priority: String,
    inbound_delay_ms: u64,
    outbound_delay_ms: u64,
    outbound_ptt_enabled: bool,
    outbound_ptt_state: String,
    inbound_mix: RouteMixConfig,
    outbound_mix: RouteMixConfig,
    secondary_segment_tts_enabled: bool,
}

impl SpeechConfig {
    fn synthesis_protocol(&self) -> SpeechSynthesisProtocol {
        if crate::audio::bailian_tasks::is_tts_model(&self.provider.model) {
            SpeechSynthesisProtocol::TaskTts
        } else {
            SpeechSynthesisProtocol::RealtimeAudio
        }
    }

    fn from_value(config: &Value) -> Result<Self, String> {
        let provider = config
            .get("providers")
            .and_then(Value::as_array)
            .and_then(|arr| arr.iter().find(|value| {
                value.get("templateId").and_then(Value::as_str) == Some("default")
                    || value.get("providerId").and_then(Value::as_str) == Some("default-provider")
            }))
            .and_then(|v| serde_json::from_value::<ProviderDraftInput>(v.clone()).ok())
           .unwrap_or_else(|| {
                serde_json::from_value(json!({
                    "templateId": "default",
                    "providerId": "default-provider",
                    "kind": "dashscope",
                    "displayName": "Default Provider",
                    "model": "",
                    "baseUrl": "",
                    "transport": "websocket",
                    "authRef": {
                        "kind": "credential-ref",
                        "reference": "none",
                        "headerName": "Authorization",
                        "scheme": "none"
                    },
                    "streamEnabled": true,
                    "timeoutMs": 5000,
                    "systemPromptTemplate": ""
                })).expect("default provider should parse")
           });
        let secondary_translation_active = config
            .pointer("/devices/subtitleTranslationMode")
            .and_then(Value::as_str)
            == Some("secondary")
            && config
                .pointer("/devices/subtitleTranslationModelId")
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
        let secondary_audio_enabled = config
            .pointer("/devices/outputSpeechEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tts_model_candidates = [
            config
                .pointer("/devices/inboundSecondaryAudioModelId")
                .and_then(Value::as_str)
                .filter(|model| {
                    secondary_translation_active
                        && secondary_audio_enabled
                        && !model.trim().is_empty()
                }),
            config
                .pointer("/speech/textToSpeechModelId")
                .and_then(Value::as_str)
                .filter(|model| !model.trim().is_empty()),
            config
                .pointer("/devices/textToSpeechModelId")
                .and_then(Value::as_str)
                .filter(|model| !model.trim().is_empty()),
            config
                .pointer("/devices/outboundVoiceModelId")
                .and_then(Value::as_str)
                .filter(|model| !model.trim().is_empty()),
        ];
        let selected_tts_model = tts_model_candidates
            .into_iter()
            .flatten()
            .filter(|model| !is_livetranslate_model_reference(config, model))
            .next();
        let mut provider = match selected_tts_model {
            Some(model) => resolve_model_provider_from_config_value(config, model).ok_or_else(|| {
                let context = json!({ "modelRole": "speech-output", "modelReference": model });
                format!("Configured TTS model '{model}' cannot be resolved to an enabled provider | modelContext: {context}")
            })?,
            None => provider,
        };
        let synthesis_protocol = prepare_speech_provider(&mut provider)?;
        if (selected_tts_model.is_some() || synthesis_protocol == SpeechSynthesisProtocol::TaskTts) && provider.kind == "dashscope" {
            crate::audio::events::authorize_bailian_model_operation(
                &provider,
                &provider.model,
                "tts",
            )
            .map_err(|error| {
                speech_model_context(&provider, &format!(
                    "Configured DashScope TTS model '{}' is not authorized for TTS: {error}", provider.model
                ))
            })?;
        }
        let secondary_segment_tts_enabled = secondary_translation_active
            && secondary_audio_enabled
            && resolve_translation_audio_source(config, true)
                == TranslationAudioSource::SubtitleTts;
        if secondary_segment_tts_enabled
            && provider.kind == "dashscope"
            && crate::audio::events::resolve_realtime_profile(&provider, &provider.model)
                .protocol_dialect
                == Some(crate::audio::events::RealtimeProtocol::DashscopeLivetranslate)
        {
            provider.model = provider
                .local_model_capability_registry
                .iter()
                .find(|entry| {
                    entry.realtime_protocol.as_deref() == Some("dashscope-omni")
                        && entry.capabilities.iter().any(|capability| {
                            capability == "text-to-speech" || capability == "speech-to-speech"
                        })
                })
                .map(|entry| entry.model_id.clone())
                .ok_or_else(|| {
                    "Configured LiveTranslate provider has no explicit dashscope-omni TTS model"
                        .to_string()
                })?;
        }
        let bridge_playback_enabled = bridge_translation_playback_enabled_for_config(config);
        let bridge_capture_mode = bridge_owned_capture_mode_for_config(config);
        let voice = match synthesis_protocol {
            SpeechSynthesisProtocol::TaskTts => crate::audio::bailian_tasks::resolve_tts_voice(
                config.pointer("/speech/voice").and_then(Value::as_str).unwrap_or("auto"),
            ),
            SpeechSynthesisProtocol::RealtimeAudio => config.pointer("/speech/voice").and_then(Value::as_str).unwrap_or("Ethan").to_string(),
        };
        Ok(Self {
            provider,
            enabled: config
                .pointer("/speech/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || secondary_segment_tts_enabled,
            target_language: config
                .pointer("/speech/targetLanguage")
                .and_then(Value::as_str)
                .unwrap_or("zh-CN")
                .to_string(),
            voice,
            output_target: if bridge_playback_enabled {
                "bridge-playback".to_string()
            } else {
                config
                    .pointer("/speech/outputTarget")
                    .and_then(Value::as_str)
                    .unwrap_or("speaker")
                    .to_string()
            },
            local_playback_enabled: desktop_direct_playback_enabled_for_config(config),
            virtual_mic_output_enabled: config
                .pointer("/speech/virtualMicOutputEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            bridge_playback_enabled,
            bridge_capture_mode,
            speaker_device_id: config
                .pointer("/devices/outputDeviceId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
            speaker_output_level: config
                .pointer("/devices/outputLevel")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(100),
            priority: config
                .pointer("/subtitles/priority")
                .and_then(Value::as_str)
                .unwrap_or("subtitle-first")
                .to_string(),
            inbound_delay_ms: config
                .pointer("/devices/inboundRoute/latencyControl/translationBufferMs")
                .and_then(Value::as_u64)
                .unwrap_or(120)
                + config
                    .pointer("/devices/inboundRoute/latencyControl/playbackBufferMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(40),
            outbound_delay_ms: config
                .pointer("/devices/outboundRoute/latencyControl/translationBufferMs")
                .and_then(Value::as_u64)
                .unwrap_or(90)
                + config
                    .pointer("/devices/outboundRoute/latencyControl/playbackBufferMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(50),
            outbound_ptt_enabled: config
                .pointer("/devices/outboundRoute/pushToTalk/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            outbound_ptt_state: config
                .pointer("/devices/outboundRoute/pushToTalk/state")
                .and_then(Value::as_str)
                .unwrap_or("idle")
                .to_string(),
            inbound_mix: parse_mix(config, "/devices/inboundRoute/mixControl"),
            outbound_mix: parse_mix(config, "/devices/outboundRoute/mixControl"),
            secondary_segment_tts_enabled,
        })
    }

    fn dispatch_delay_ms(&self, direction: &str) -> u64 {
        if self.priority != "subtitle-first" {
            return 0;
        }

        if direction == "outbound" {
            self.outbound_delay_ms
        } else {
            self.inbound_delay_ms
        }
    }
}

pub(crate) fn speech_output_enabled(config: &Value) -> bool {
    config
        .pointer("/speech/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || config
            .pointer("/devices/outputSpeechEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn resolve_model_provider_from_config_value(
    config: &Value,
    composite_model_id: &str,
) -> Option<ProviderDraftInput> {
    let requested_model = composite_model_id.trim();
    if requested_model.is_empty() {
        return None;
    }
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some((template_id, model_id)) = requested_model.split_once("::") {
        return resolve_composite_template_provider(&providers, template_id, model_id);
    }

    providers
        .iter()
        .filter_map(|provider_value| {
            serde_json::from_value::<ProviderDraftInput>(provider_value.clone()).ok()
        })
        .filter(|provider| provider.model == requested_model
            || provider.scene_model_assignments.iter().any(|assignment| assignment.model_ids.iter().any(|model| model == requested_model))
            || provider.local_model_capability_registry.iter().any(|entry| entry.model_id == requested_model)
            || provider.model_catalog_cache.models.iter().any(|model| model.id == requested_model))
        .try_fold(None, |matched, mut provider| {
            if matched.is_some() { return Err(()); }
            provider.model = requested_model.to_string();
            Ok(Some(provider))
        })
        .ok().flatten()
}

fn speech_model_context(provider: &ProviderDraftInput, error: &str) -> String {
    if error.contains(" | modelContext: ") { return error.to_string(); }
    let context = json!({ "modelRole": "speech-output", "modelId": provider.model,
        "providerId": provider.provider_id, "modelReference": format!("{}::{}", provider.template_id, provider.model) });
    format!("{error} | modelContext: {context}")
}

fn prepare_speech_provider(provider: &mut ProviderDraftInput) -> Result<SpeechSynthesisProtocol, String> {
    if !crate::audio::bailian_tasks::is_tts_model(&provider.model) {
        return Ok(SpeechSynthesisProtocol::RealtimeAudio);
    }
    if provider.kind != "dashscope" {
        return Err(speech_model_context(provider, "model_protocol.provider_family_mismatch: Task TTS requires a Bailian provider"));
    }
    let profiles = crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(&provider.model)
        .map_err(|error| speech_model_context(provider, error.code()))?;
    if profiles.len() != 1 || profiles[0].adapter_status != "enabled"
        || profiles[0].adapter_id.as_deref() != Some(crate::audio::bailian_tasks::TTS_ADAPTER_ID)
        || profiles[0].wire_dialect != crate::audio::bailian_tasks::TTS_DIALECT_ID
        || profiles[0].wire_dialect_version != 1 || profiles[0].endpoint_path != "/api-ws/v1/inference"
        || !profiles[0].operations.iter().any(|operation| operation == "tts")
    {
        return Err(speech_model_context(provider, "model_protocol.adapter_unavailable: selected Task TTS has no enabled typed adapter"));
    }
    // A platform can share credentials/host with its primary realtime model.
    // Endpoint path and transport come from the exact selected TTS profile.
    let mut endpoint = crate::provider::gateway_parts::transport::to_websocket_url(&provider.base_url, &provider.model)
        .map_err(|error| speech_model_context(provider, &format!("{}: {}", error.code, error.message)))?;
    if endpoint.scheme() != "wss" || !endpoint.username().is_empty() || endpoint.password().is_some() {
        return Err(speech_model_context(provider, "model_protocol.endpoint_family_mismatch: Task TTS requires a secure credential-free endpoint URL"));
    }
    endpoint.set_fragment(None);
    provider.base_url = endpoint.to_string();
    provider.transport = "websocket".to_string();
    Ok(SpeechSynthesisProtocol::TaskTts)
}
fn is_livetranslate_model_reference(config: &Value, model_id: &str) -> bool {
    let is_live = |model: &str| crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(model)
        .ok().is_some_and(|profiles| profiles.len() == 1
            && matches!(profiles[0].wire_dialect.as_str(), "bailian-livetranslate-session-ws-v1" | "bailian-livetranslate-session-ws-v2"));
    match resolve_model_provider_from_config_value(config, model_id) {
        Some(provider) => provider.kind == "dashscope" && is_live(&provider.model),
        // Filtering a documented bare LT identity is classification, not an
        // invocation or a grant to the first provider on a platform.
        None => !model_id.contains("::") && is_live(model_id)
            && config.get("providers").and_then(Value::as_array).is_some_and(|providers|
                providers.iter().any(|provider| provider.get("kind").and_then(Value::as_str) == Some("dashscope"))),
    }
}
fn parse_mix(config: &Value, prefix: &str) -> RouteMixConfig {
    RouteMixConfig {
        keep_original_audio: config
            .pointer(&format!("{prefix}/keepOriginalAudio"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        translated_audio_enabled: config
            .pointer(&format!("{prefix}/translatedAudioEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        translated_audio_gain_db: config
            .pointer(&format!("{prefix}/translatedAudioGainDb"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32,
        translated_audio_auto_gain_enabled: config
            .pointer(&format!("{prefix}/translatedAudioAutoGainEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(prefix.contains("inboundRoute")),
        original_audio_gain_db: config
            .pointer(&format!("{prefix}/originalAudioGainDb"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32,
        ducking_enabled: config
            .pointer(&format!("{prefix}/duckingEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ducking_depth_percent: config
            .pointer(&format!("{prefix}/duckingDepthPercent"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;

    fn livetranslate_tts_config(model: &str) -> Value {
        json!({
            "providers": [
                {"templateId":"live","providerId":"live-provider","kind":"dashscope","displayName":"Live","model":"qwen3.5-livetranslate-flash-realtime","baseUrl":"https://dashscope.aliyuncs.com/api/v1","transport":"websocket","authRef":{"kind":"credential-ref","reference":"none","headerName":"Authorization","scheme":"none"},"streamEnabled":true,"timeoutMs":5000,"systemPromptTemplate":""},
                {"templateId":"tts","providerId":"tts-provider","kind":"openai-compatible","displayName":"TTS","model":"tts-1","baseUrl":"","transport":"http-json","authRef":{"kind":"credential-ref","reference":"none","headerName":"Authorization","scheme":"none"},"streamEnabled":true,"timeoutMs":5000,"systemPromptTemplate":""}
            ],
            "devices": {
                "subtitleTranslationMode":"secondary",
                "subtitleTranslationModelId":"translator::text-model",
                "outputSpeechEnabled":true,
                "inboundSecondaryAudioModelId":model
            },
            "speech":{"translationAudioSource":"subtitle-tts","textToSpeechModelId":"tts::tts-1"}
        })
    }

    #[test]
    fn livetranslate_candidates_allow_secondary_speech_to_use_real_tts() {
        // Exercise the production parser and embedded manifest, not a dialect stub.
        for model in [
            "qwen3.5-livetranslate-flash-realtime",
            "qwen3.5-livetranslate-flash-realtime-2026-05-19",
            "qwen3-livetranslate-flash-realtime",
            "qwen3-livetranslate-flash-realtime-2025-09-22",
        ] {
            for reference in [model.to_string(), format!("live::{model}")] {
                let config = livetranslate_tts_config(&reference);
                let speech = SpeechConfig::from_value(&config)
                    .unwrap_or_else(|error| panic!("{reference}: {error}"));
                assert_eq!(speech.provider.provider_id, "tts-provider");
                assert_eq!(speech.provider.model, "tts-1");
                assert!(speech.secondary_segment_tts_enabled);
                assert!(speech.enabled);
            }
        }
    }

    #[test]
    fn livetranslate_lookalikes_and_missing_providers_fail_closed() {
        for reference in [
            "live::qwen3.5-livetranslate-flash-realtime-next",
            "live::QWEN3.5-LIVETRANSLATE-FLASH-REALTIME",
            "live:: qwen3.5-livetranslate-flash-realtime",
            "deleted::qwen3.5-livetranslate-flash-realtime",
        ] {
            let error = SpeechConfig::from_value(&livetranslate_tts_config(reference))
                .err().expect("unresolved or unknown selections must not fall through to TTS");
            assert!(error.contains("cannot be resolved") || error.contains("not authorized for TTS"), "{reference}: {error}");
        }
    }

    #[test]
    fn livetranslate_filter_preserves_other_provider_and_tts_authorization() {
        let mut config = livetranslate_tts_config("tts::qwen3.5-livetranslate-flash-realtime");
        let speech = SpeechConfig::from_value(&config).expect("other providers are not classified by Bailian model names");
        assert_eq!(speech.provider.model, "qwen3.5-livetranslate-flash-realtime");
        assert_eq!(speech.provider.provider_id, "tts-provider");

        config["devices"]["inboundSecondaryAudioModelId"] = json!("tts::tts-1");
        let speech = SpeechConfig::from_value(&config).expect("ordinary TTS remains selected");
        assert_eq!(speech.provider.model, "tts-1");
        assert!(speech.secondary_segment_tts_enabled);

        for model in ["qwen3.5-omni-plus-realtime", "qwen3-tts-flash-realtime"] {
            config["devices"]["inboundSecondaryAudioModelId"] = json!("live::qwen3.5-livetranslate-flash-realtime");
            config["speech"]["textToSpeechModelId"] = json!(format!("live::{model}"));
            let error = SpeechConfig::from_value(&config).err().expect("fallback must still pass TTS authorization");
            assert!(error.contains(model), "authorization must inspect the fallback: {error}");
            assert!(error.contains("not authorized for TTS"));
        }
    }

    #[test]
    fn legacy_mix_defaults_smart_gain_only_for_inbound_watch_audio() {
        let config = json!({});
        let inbound = parse_mix(&config, "/devices/inboundRoute/mixControl");
        let outbound = parse_mix(&config, "/devices/outboundRoute/mixControl");

        assert!(inbound.translated_audio_auto_gain_enabled);
        assert!(!outbound.translated_audio_auto_gain_enabled);
    }

    #[test]
    fn explicit_missing_tts_provider_fails_closed() {
        let config = json!({
            "providers": [],
            "speech": { "textToSpeechModelId": "deleted-template::tts-model" }
        });
        let error = match SpeechConfig::from_value(&config) {
            Ok(_) => panic!("stale explicit TTS selection must fail"),
            Err(error) => error,
        };
        assert!(error.contains("cannot be resolved"));
        assert!(error.contains("deleted-template::tts-model"));
    }

    #[test]
    fn unconfigured_tts_uses_only_marked_default_provider() {
        let config = json!({
            "providers": [
                {"templateId":"first","providerId":"first","kind":"openai-compatible","displayName":"First","model":"wrong","baseUrl":"","transport":"http-json","authRef":{"kind":"credential-ref","reference":"none","headerName":"Authorization","scheme":"none"},"streamEnabled":true,"timeoutMs":5000,"systemPromptTemplate":""},
                {"templateId":"default","providerId":"default-provider","kind":"dashscope","displayName":"Default","model":"tts-default","baseUrl":"","transport":"websocket","authRef":{"kind":"credential-ref","reference":"none","headerName":"Authorization","scheme":"none"},"streamEnabled":true,"timeoutMs":5000,"systemPromptTemplate":""}
            ]
        });
        let speech = SpeechConfig::from_value(&config).expect("marked default should resolve");
        assert_eq!(speech.provider.provider_id, "default-provider");
    }
}
