#![allow(dead_code)]
use serde_json::Value;

/// Unified translation route abstraction backed by the model capability registry.
///
/// - `Native`:  Omni model directly outputs translation subtitles/audio.
///             Does not launch `subtitle_translate` worker; no segment-TTS evidence required.
/// - `Secondary`: Launches `subtitle_translate` worker for smart segmentation +
///               text translation; plays `pending=false` segments via TTS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationRoute {
    Native,
    Secondary,
}

impl TranslationRoute {
    /// Resolve the translation route from the unified config.
    ///
    /// Route is determined by `devices.subtitleTranslationMode`:
    /// - `"secondary"` → `Secondary`
    /// - everything else → `Native`
    pub fn from_config(config: &Value) -> Self {
        match config
            .pointer("/devices/subtitleTranslationMode")
            .and_then(Value::as_str)
        {
            Some("secondary") => Self::Secondary,
            _ => Self::Native,
        }
    }

    /// Whether the subtitle translate worker (smart segmentation + text LLM)
    /// should be started for this route.
    pub fn requires_subtitle_translate(&self) -> bool {
        matches!(self, Self::Secondary)
    }

    /// Whether segment-level TTS (secondary subtitle-tts) is expected for this route.
    /// On `Native`, Omni's own audio output provides the translated speech.
    pub fn requires_segment_tts(&self) -> bool {
        matches!(self, Self::Secondary)
    }

    /// The translation audio source strategy for this route.
    /// `Native` → Omni-native audio stream; `Secondary` → subtitle TTS.
    pub fn translation_audio_source(&self) -> crate::audio::speech::TranslationAudioSource {
        match self {
            Self::Native => crate::audio::speech::TranslationAudioSource::OmniNative,
            Self::Secondary => crate::audio::speech::TranslationAudioSource::SubtitleTts,
        }
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_route_from_default_config() {
        let route = TranslationRoute::from_config(&json!({}));
        assert_eq!(route, TranslationRoute::Native);
        assert!(!route.requires_subtitle_translate());
        assert!(!route.requires_segment_tts());
    }

    #[test]
    fn secondary_route_from_config() {
        let config = json!({
            "devices": {
                "subtitleTranslationMode": "secondary",
                "subtitleTranslationModelId": "some-model",
                "outputSpeechEnabled": true
            }
        });
        let route = TranslationRoute::from_config(&config);
        assert_eq!(route, TranslationRoute::Secondary);
        assert!(route.requires_subtitle_translate());
        assert!(route.requires_segment_tts());
    }

    #[test]
    fn native_route_when_mode_is_native() {
        let config = json!({
            "devices": {
                "subtitleTranslationMode": "native"
            }
        });
        let route = TranslationRoute::from_config(&config);
        assert_eq!(route, TranslationRoute::Native);
        assert!(!route.requires_subtitle_translate());
    }
}