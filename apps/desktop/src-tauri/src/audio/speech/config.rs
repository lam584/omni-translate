use super::time_utils::now_unix_millis_marker;
use crate::audio::events::resolve_composite_template_provider;

#[derive(Clone)]
#[allow(dead_code, reason = "route mix fields are parsed now for forward-compatible mixer policy")]
struct RouteMixConfig {
    keep_original_audio: bool,
    translated_audio_enabled: bool,
    translated_audio_gain_db: f32,
    translated_audio_auto_gain_enabled: bool,
    original_audio_gain_db: f32,
    ducking_enabled: bool,
    ducking_depth_percent: u64,
}

#[derive(Clone)]
struct SpeechConfig {
    provider: ProviderDraftInput,
    enabled: bool,
    target_language: String,
    #[allow(dead_code, reason = "voice preset id is preserved for provider contract compatibility")]
    voice_preset_id: String,
    voice: String,
    output_target: String,
    local_playback_enabled: bool,
    virtual_mic_output_enabled: bool,
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
            .filter(|model| !is_livetranslate_model_id(model))
            .next();
        let mut provider = match selected_tts_model {
            Some(model) => resolve_model_provider_from_config_value(config, model).ok_or_else(|| {
                format!("Configured TTS model '{model}' cannot be resolved to an enabled provider")
            })?,
            None => provider,
        };
        let secondary_segment_tts_enabled = secondary_translation_active
            && secondary_audio_enabled
            && resolve_translation_audio_source(config, true)
                == TranslationAudioSource::SubtitleTts;
        if secondary_segment_tts_enabled
            && provider.kind == "dashscope"
            && is_livetranslate_model_id(&provider.model)
        {
            provider.model = "qwen3.5-omni-plus-realtime".to_string();
        }
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
            voice_preset_id: config
                .pointer("/speech/voicePresetId")
                .and_then(Value::as_str)
                .unwrap_or("voice-cn-neutral")
                .to_string(),
            voice: config
                .pointer("/speech/voice")
                .and_then(Value::as_str)
                .unwrap_or("Ethan")
                .to_string(),
            output_target: config
                .pointer("/speech/outputTarget")
                .and_then(Value::as_str)
                .unwrap_or("speaker")
                .to_string(),
            local_playback_enabled: desktop_direct_playback_enabled_for_config(config),
            virtual_mic_output_enabled: config
                .pointer("/speech/virtualMicOutputEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
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
        .find(|provider| provider.kind == "dashscope")
        .map(|mut provider| {
            provider.model = requested_model.to_string();
            provider
        })
}

fn is_livetranslate_model_id(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    lower.contains("livetranslate")
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
