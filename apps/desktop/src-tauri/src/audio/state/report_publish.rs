use super::translation_lifecycle::{
    apply_display_update, apply_translation_update, cue_revision, TranslationMutation,
};
use super::*;

struct PublishContext {
    direction: String,
    source_text: String,
    display_segments: Vec<SubtitleDisplaySegmentRuntime>,
    revision: u64,
    sequence: u64,
    translation_state: SubtitleTranslationStateRuntime,
}

impl AudioStateStore {
    pub(crate) fn update_subtitle_cue_translation(
        &self,
        cue_id: &str,
        translated_text: String,
        committed: bool,
    ) {
        let state = if committed {
            SubtitleTranslationStateRuntime::Final
        } else {
            SubtitleTranslationStateRuntime::Streaming
        };
        let _ = self.apply_subtitle_cue_translation(cue_id, None, translated_text, state);
    }

    pub(crate) fn update_subtitle_cue_translation_for_revision(
        &self,
        cue_id: &str,
        expected_revision: u64,
        translated_text: String,
        state: SubtitleTranslationStateRuntime,
    ) -> bool {
        self.apply_subtitle_cue_translation(
            cue_id,
            Some(expected_revision),
            translated_text,
            state,
        )
    }

    pub(crate) fn mark_subtitle_translation_error(
        &self,
        cue_id: &str,
        expected_revision: u64,
        message: String,
    ) -> bool {
        self.update_subtitle_cue_translation_for_revision(
            cue_id,
            expected_revision,
            message,
            SubtitleTranslationStateRuntime::Error,
        )
    }

    fn apply_subtitle_cue_translation(
        &self,
        cue_id: &str,
        expected_revision: Option<u64>,
        translated_text: String,
        state: SubtitleTranslationStateRuntime,
    ) -> bool {
        let sequence = self.next_subtitle_sequence();
        let mutation = TranslationMutation {
            expected_revision,
            sequence,
            translated_text: &translated_text,
            state,
        };
        let context = self.subtitles.update(|overlay| {
            let mut accepted = false;
            for cue in overlay.recent_cues.iter_mut() {
                if cue.cue_id == cue_id {
                    accepted = apply_translation_update(cue, &mutation);
                    break;
                }
            }
            if !accepted {
                return None;
            }
            if let Some(active) = overlay.active_cue.as_mut() {
                if active.cue_id == cue_id {
                    let _ = apply_translation_update(active, &mutation);
                }
            }
            overlay
                .recent_cues
                .iter_mut()
                .find(|cue| cue.cue_id == cue_id)
                .map(|cue| {
                    if matches!(
                        state,
                        SubtitleTranslationStateRuntime::Final
                            | SubtitleTranslationStateRuntime::Error
                    ) {
                        cue.ended_at = ms_marker(unix_ms());
                    }
                    PublishContext {
                        direction: cue.route_direction.clone(),
                        source_text: cue.source_text.clone(),
                        display_segments: cue.display_segments.clone(),
                        revision: cue_revision(cue),
                        sequence: cue.sequence.unwrap_or(sequence),
                        translation_state: state,
                    }
                })
        });
        let Some(context) = context else {
            return false;
        };
        if matches!(
            state,
            SubtitleTranslationStateRuntime::Streaming
                | SubtitleTranslationStateRuntime::Final
        ) {
            self.subtitles.update(|overlay| {
                self.note_first_translation_result(overlay, cue_id, &translated_text)
            });
        }
        self.record_publish_context(cue_id, &translated_text, context);
        true
    }

    fn record_publish_context(
        &self,
        cue_id: &str,
        translated_text: &str,
        context: PublishContext,
    ) {
        self.watch_session_report.record_publish_runtime(
            cue_id,
            &context.direction,
            &context.source_text,
            translated_text,
            &context.display_segments,
            matches!(
                context.translation_state,
                SubtitleTranslationStateRuntime::Final
            ),
            context.revision,
            context.sequence,
            Some(context.translation_state),
        );
    }

    pub(crate) fn update_subtitle_cue_display_segments(
        &self,
        cue_id: &str,
        display_source_text: String,
        display_segments: Vec<SubtitleDisplaySegmentRuntime>,
        translated_text: String,
        committed: bool,
    ) {
        let revision = self
            .subtitles
            .snapshot()
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == cue_id)
            .map(cue_revision);
        let Some(revision) = revision else {
            return;
        };
        let state = if committed {
            SubtitleTranslationStateRuntime::Final
        } else if translated_text.trim().is_empty() {
            SubtitleTranslationStateRuntime::Pending
        } else {
            SubtitleTranslationStateRuntime::Streaming
        };
        let _ = self.update_subtitle_cue_display_segments_for_revision(
            cue_id,
            revision,
            display_source_text,
            display_segments,
            translated_text,
            state,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn update_subtitle_cue_display_segments_for_revision(
        &self,
        cue_id: &str,
        expected_revision: u64,
        display_source_text: String,
        display_segments: Vec<SubtitleDisplaySegmentRuntime>,
        translated_text: String,
        state: SubtitleTranslationStateRuntime,
    ) -> bool {
        let sequence = self.next_subtitle_sequence();
        let context = self.subtitles.update(|overlay| {
            let mut accepted = false;
            for cue in overlay.recent_cues.iter_mut() {
                if cue.cue_id == cue_id {
                    accepted = apply_display_update(
                        cue,
                        Some(expected_revision),
                        sequence,
                        &display_source_text,
                        &display_segments,
                        &translated_text,
                        state,
                    );
                    break;
                }
            }
            if !accepted {
                return None;
            }
            if let Some(active) = overlay.active_cue.as_mut() {
                if active.cue_id == cue_id {
                    let _ = apply_display_update(
                        active,
                        Some(expected_revision),
                        sequence,
                        &display_source_text,
                        &display_segments,
                        &translated_text,
                        state,
                    );
                }
            }
            overlay
                .recent_cues
                .iter()
                .find(|cue| cue.cue_id == cue_id)
                .map(|cue| PublishContext {
                    direction: cue.route_direction.clone(),
                    source_text: cue.source_text.clone(),
                    display_segments: cue.display_segments.clone(),
                    revision: cue_revision(cue),
                    sequence: cue.sequence.unwrap_or(sequence),
                    translation_state: state,
                })
        });
        let Some(context) = context else {
            return false;
        };
        if !translated_text.trim().is_empty()
            && state != SubtitleTranslationStateRuntime::Error
        {
            self.subtitles.update(|overlay| {
                self.note_first_translation_result(overlay, cue_id, &translated_text)
            });
        }
        self.record_publish_context(cue_id, &translated_text, context);
        true
    }

    pub(crate) fn commit_subtitle_cue(&self, cue_id: &str) {
        let sequence = self.next_subtitle_sequence();
        let publish = self.subtitles.update(|overlay| {
            for cue in overlay.recent_cues.iter_mut() {
                if cue.cue_id == cue_id {
                    commit_cue(cue, sequence);
                    break;
                }
            }
            if let Some(active) = overlay.active_cue.as_mut() {
                if active.cue_id == cue_id {
                    commit_cue(active, sequence);
                }
            }
            overlay
                .recent_cues
                .iter()
                .find(|cue| cue.cue_id == cue_id)
                .map(|cue| {
                    (
                        cue.translated_text.clone(),
                        PublishContext {
                            direction: cue.route_direction.clone(),
                            source_text: cue.source_text.clone(),
                            display_segments: cue.display_segments.clone(),
                            revision: cue_revision(cue),
                            sequence: cue.sequence.unwrap_or(sequence),
                            translation_state: cue
                                .translation_state
                                .unwrap_or(SubtitleTranslationStateRuntime::Pending),
                        },
                    )
                })
        });
        if let Some((translated_text, context)) = publish {
            if !translated_text.is_empty() {
                self.record_publish_context(cue_id, &translated_text, context);
            }
        }
    }
}

fn commit_cue(cue: &mut SubtitleCueRuntime, sequence: u64) {
    cue.committed = true;
    if !cue.translated_text.trim().is_empty()
        && cue.translation_state != Some(SubtitleTranslationStateRuntime::Error)
    {
        cue.translation_committed = true;
        cue.translation_state = Some(SubtitleTranslationStateRuntime::Final);
    }
    cue.sequence = Some(sequence);
    finalize_cue_display_segments(cue);
    cue.ended_at = ms_marker(unix_ms());
}
