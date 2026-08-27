use crate::provider::contracts::ProviderDraftInput;

use crate::audio::glossary::GlossaryContext;

use super::{OmniOutputMode, OmniSpeechConfig, RealtimeAudioMode};

/// Immutable inputs transferred from session startup into the Omni worker.
pub(crate) struct OmniSessionConfig {
    pub(super) direction: String,
    pub(super) session_generation: u64,
    pub(super) provider: ProviderDraftInput,
    pub(super) voice: String,
    pub(super) instructions: String,
    pub(super) glossary: GlossaryContext,
    pub(super) audio_mode: RealtimeAudioMode,
    pub(super) output_mode: OmniOutputMode,
    pub(super) source_language: String,
    pub(super) target_language: String,
    pub(super) subtitle_translate_active: bool,
    pub(super) speech_config: OmniSpeechConfig,
}
