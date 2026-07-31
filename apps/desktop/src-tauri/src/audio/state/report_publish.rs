use super::*;

impl AudioStateStore {
    pub(crate) fn update_subtitle_cue_translation(
        &self,
        cue_id: &str,
        translated_text: String,
        committed: bool,
    ) {
        let translated_for_metrics = translated_text.clone();
        let publish_context = self.subtitles.update(|overlay| {
        for cue in overlay.recent_cues.iter_mut() {
            if cue.cue_id == cue_id {
                cue.translated_text = translated_text.clone();
                if committed {
                    cue.translation_committed = true;
                    finalize_cue_display_segments(cue);
                    cue.ended_at = ms_marker(unix_ms());
                }
                break;
            }
        }
        if let Some(active) = overlay.active_cue.as_mut() {
            if active.cue_id == cue_id {
                active.translated_text = translated_text;
                if committed {
                    active.translation_committed = true;
                    finalize_cue_display_segments(active);
                    active.ended_at = ms_marker(unix_ms());
                }
            }
        }
            self.note_first_translation_result(overlay, cue_id, &translated_for_metrics);
            overlay
                .recent_cues
                .iter()
                .find(|cue| cue.cue_id == cue_id)
                .map(|cue| {
                    (
                        cue.route_direction.clone(),
                        cue.source_text.clone(),
                        cue.display_segments.clone(),
                    )
                })
        });
        if let Some((direction, source_text, display_segments)) = publish_context {
            self.watch_session_report.record_publish(
                cue_id,
                &direction,
                &source_text,
                &translated_for_metrics,
                &display_segments,
                committed,
            );
        }
    }

    pub(crate) fn update_subtitle_cue_display_segments(
        &self,
        cue_id: &str,
        display_source_text: String,
        display_segments: Vec<SubtitleDisplaySegmentRuntime>,
        translated_text: String,
        committed: bool,
    ) {
        let translated_for_metrics = translated_text.clone();
        let segments_for_report = display_segments.clone();
        let publish_context = self.subtitles.update(|overlay| {
        for cue in overlay.recent_cues.iter_mut() {
            if cue.cue_id == cue_id {
                cue.display_source_text = display_source_text.clone();
                cue.display_segments = display_segments.clone();
                cue.translated_text = translated_text.clone();
                cue.committed = committed || cue.committed;
                if committed {
                    cue.translation_committed = !cue.translated_text.trim().is_empty();
                    finalize_cue_display_segments(cue);
                    cue.ended_at = ms_marker(unix_ms());
                }
                break;
            }
        }
        if let Some(active) = overlay.active_cue.as_mut() {
            if active.cue_id == cue_id {
                active.display_source_text = display_source_text;
                active.display_segments = display_segments;
                active.translated_text = translated_text;
                active.committed = committed || active.committed;
                if committed {
                    active.translation_committed = !active.translated_text.trim().is_empty();
                    finalize_cue_display_segments(active);
                    active.ended_at = ms_marker(unix_ms());
                }
            }
        }
            self.note_first_translation_result(overlay, cue_id, &translated_for_metrics);
            overlay
                .recent_cues
                .iter()
                .find(|cue| cue.cue_id == cue_id)
                .map(|cue| (cue.route_direction.clone(), cue.source_text.clone()))
        });
        if let Some((direction, source_text)) = publish_context {
            self.watch_session_report.record_publish(
                cue_id,
                &direction,
                &source_text,
                &translated_for_metrics,
                &segments_for_report,
                committed,
            );
        }
    }

    pub(crate) fn commit_subtitle_cue(&self, cue_id: &str) {
        let publish_context = self.subtitles.update(|overlay| {
        for cue in overlay.recent_cues.iter_mut() {
            if cue.cue_id == cue_id {
                cue.committed = true;
                cue.translation_committed = !cue.translated_text.trim().is_empty();
                finalize_cue_display_segments(cue);
                cue.ended_at = ms_marker(unix_ms());
                break;
            }
        }
        if let Some(active) = overlay.active_cue.as_mut() {
            if active.cue_id == cue_id {
                active.committed = true;
                active.translation_committed = !active.translated_text.trim().is_empty();
                finalize_cue_display_segments(active);
                active.ended_at = ms_marker(unix_ms());
            }
        }
            overlay
                .recent_cues
                .iter()
                .find(|cue| cue.cue_id == cue_id)
                .map(|cue| {
                    (
                        cue.route_direction.clone(),
                        cue.source_text.clone(),
                        cue.translated_text.clone(),
                        cue.display_segments.clone(),
                    )
                })
        });
        if let Some((direction, source_text, translated_text, display_segments)) = publish_context {
            if !translated_text.is_empty() {
                self.watch_session_report.record_publish(
                    cue_id,
                    &direction,
                    &source_text,
                    &translated_text,
                    &display_segments,
                    true,
                );
            }
        }
    }

}
