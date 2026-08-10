use super::*;

impl AudioStateStore {
    pub(crate) fn begin_omni_session(
        &self,
        direction: &str,
        model_id: &str,
        realtime_audio_mode: &str,
        subtitle_translate_active: bool,
        output_mode: OmniOutputMode,
        glossary_signature: u64,
    ) -> u64 {
        self.omni_sessions.begin(
            direction,
            model_id,
            realtime_audio_mode,
            subtitle_translate_active,
            output_mode,
            glossary_signature,
        )
    }

    pub(crate) fn mark_omni_session_ready(&self, direction: &str, generation: u64) -> bool {
        self.omni_sessions.mark_ready(direction, generation)
    }

    pub(crate) fn mark_omni_session_failed(
        &self,
        direction: &str,
        generation: u64,
        error: impl Into<String>,
    ) -> bool {
        self.omni_sessions
            .mark_failed(direction, generation, error.into())
    }

    pub(crate) fn mark_omni_session_stopping(
        &self,
        direction: &str,
        generation: u64,
        reason: impl Into<String>,
    ) -> bool {
        self.omni_sessions
            .mark_stopping(direction, generation, reason.into())
    }

    pub(crate) fn clear_omni_session(
        &self,
        direction: &str,
        generation: u64,
        reason: impl Into<String>,
    ) -> bool {
        let _ = reason.into();
        self.omni_sessions.clear(direction, generation)
    }

    pub(crate) fn matching_ready_omni_session(
        &self,
        direction: &str,
        model_id: &str,
        realtime_audio_mode: &str,
        subtitle_translate_active: bool,
        output_mode: OmniOutputMode,
        glossary_signature: u64,
    ) -> Option<u64> {
        self.omni_sessions.matching_ready(
            direction,
            model_id,
            realtime_audio_mode,
            subtitle_translate_active,
            output_mode,
            glossary_signature,
        )
    }

    pub(crate) fn take_matching_omni_sender(
        &self,
        direction: &str,
        model_id: &str,
        realtime_audio_mode: &str,
        subtitle_translate_active: bool,
        output_mode: OmniOutputMode,
        glossary_signature: u64,
    ) -> Option<Sender<Vec<u8>>> {
        self.omni_sessions.take_matching_sender(
            direction,
            model_id,
            realtime_audio_mode,
            subtitle_translate_active,
            output_mode,
            glossary_signature,
        )
    }

    pub(crate) fn omni_session_metadata(&self, direction: &str) -> Option<OmniSessionMetadata> {
        self.omni_sessions.metadata(direction)
    }

    pub(crate) fn is_current_omni_session(&self, direction: &str, generation: u64) -> bool {
        self.omni_sessions.is_current(direction, generation)
    }
}
