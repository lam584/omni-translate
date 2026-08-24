use crate::audio::state::AudioStateStore;

use super::super::OmniPlaybackQueue;

pub(super) struct LivetranslateShutdownFailure<'a> {
    pub(super) store: &'a AudioStateStore,
    pub(super) direction: &'a str,
    pub(super) current_cue_id: Option<&'a str>,
    pub(super) pending_source_text: &'a str,
    pub(super) native_cue_ids: &'a [String],
    pub(super) native_translation_reuse_active: bool,
    pub(super) playback_tx: &'a OmniPlaybackQueue,
    pub(super) pending_audio_stream_cue_id: Option<&'a str>,
    pub(super) pending_audio_stream_chunk_index: u32,
    pub(super) pending_audio_stream_created_at_ms: Option<u64>,
}

pub(super) fn terminalize_livetranslate_shutdown_failure(
    context: LivetranslateShutdownFailure<'_>,
) {
    let LivetranslateShutdownFailure {
        store,
        direction,
        current_cue_id,
        pending_source_text,
        native_cue_ids,
        native_translation_reuse_active,
        playback_tx,
        pending_audio_stream_cue_id,
        pending_audio_stream_chunk_index,
        pending_audio_stream_created_at_ms,
    } = context;
    let current_cue_id = current_cue_id
        .map(str::to_string)
        .or_else(|| {
            (!pending_source_text.trim().is_empty()).then(|| {
                super::super::next_omni_cue_id(direction)
            })
        });
    let mut cue_ids = native_cue_ids.to_vec();
    if let Some(cue_id) = current_cue_id.as_ref() {
        if !cue_ids.iter().any(|known| known == cue_id) {
            cue_ids.push(cue_id.clone());
        }
    }
    let snapshot = store.snapshot();
    for cue_id in cue_ids {
        let source_text = if current_cue_id.as_deref() == Some(cue_id.as_str())
            && !pending_source_text.trim().is_empty()
        {
            pending_source_text.to_string()
        } else {
            snapshot
                .subtitle_overlay
                .recent_cues
                .iter()
                .find(|cue| cue.cue_id == cue_id)
                .map(|cue| cue.source_text.clone())
                .unwrap_or_default()
        };
        if !source_text.trim().is_empty() {
            store.update_or_push_stt_cue(&cue_id, &source_text, true);
        }
        if native_translation_reuse_active {
            let translation_is_final = snapshot
                .subtitle_overlay
                .recent_cues
                .iter()
                .find(|cue| cue.cue_id == cue_id)
                .is_some_and(|cue| cue.translation_committed);
            if !translation_is_final {
                store.update_subtitle_cue_translation(
                    &cue_id,
                    super::super::protocol::NATIVE_FAILED_TRANSLATION_FAILURE.to_string(),
                    true,
                );
            }
        }
    }
    if let Some(cue_id) = pending_audio_stream_cue_id {
        playback_tx.abort_stream(
            cue_id,
            pending_audio_stream_chunk_index,
            pending_audio_stream_created_at_ms.unwrap_or_else(super::super::unix_ms),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_failure_preserves_source_and_terminalizes_native_translation() {
        let store = AudioStateStore::new();
        store.update_or_push_stt_cue("omni-cue-inbound-tail", "stable source", false);
        let playback_tx = OmniPlaybackQueue::new(4);
        terminalize_livetranslate_shutdown_failure(LivetranslateShutdownFailure {
            store: &store,
            direction: "inbound",
            current_cue_id: Some("omni-cue-inbound-tail"),
            pending_source_text: "stable source final",
            native_cue_ids: &["omni-cue-inbound-tail".to_string()],
            native_translation_reuse_active: true,
            playback_tx: &playback_tx,
            pending_audio_stream_cue_id: None,
            pending_audio_stream_chunk_index: 0,
            pending_audio_stream_created_at_ms: None,
        });

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-inbound-tail")
            .expect("terminal cue");
        assert_eq!(cue.source_text, "stable source final");
        assert!(cue.committed);
        assert_eq!(
            cue.translated_text,
            super::super::super::protocol::NATIVE_FAILED_TRANSLATION_FAILURE
        );
        assert!(cue.translation_committed);
    }

    #[test]
    fn secondary_owner_keeps_source_without_writing_native_failure() {
        let store = AudioStateStore::new();
        let playback_tx = OmniPlaybackQueue::new(4);
        terminalize_livetranslate_shutdown_failure(LivetranslateShutdownFailure {
            store: &store,
            direction: "inbound",
            current_cue_id: Some("omni-cue-inbound-secondary"),
            pending_source_text: "secondary source",
            native_cue_ids: &[],
            native_translation_reuse_active: false,
            playback_tx: &playback_tx,
            pending_audio_stream_cue_id: None,
            pending_audio_stream_chunk_index: 0,
            pending_audio_stream_created_at_ms: None,
        });

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == "omni-cue-inbound-secondary")
            .expect("source cue");
        assert!(cue.committed);
        assert!(cue.translated_text.is_empty());
        assert!(!cue.translation_committed);
    }
}
