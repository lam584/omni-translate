use super::*;
use super::translation_lifecycle::{apply_source_update, cue_revision};

impl AudioStateStore {
    pub(crate) fn update_or_push_stt_cue(
        &self,
        cue_id: &str,
        source_text: &str,
        committed: bool,
    ) {
        self.source_final_cues.set(cue_id, committed);
        let route_direction = route_direction_from_cue_id(cue_id).to_string();
        let sequence = self.next_subtitle_sequence();
        let cue_contract = self.subtitles.update(|overlay| {
            let exists = overlay.recent_cues.iter().any(|cue| cue.cue_id == cue_id);
            if exists {
                for cue in overlay.recent_cues.iter_mut() {
                    if cue.cue_id == cue_id {
                        if cue.committed && !committed {
                            let new_len = source_text.len();
                            let old_len = cue.source_text.len();
                            if !source_text.is_empty() && new_len < old_len {
                                break;
                            }
                        }
                        apply_source_update(cue, source_text, committed, sequence);
                        if committed {
                            finalize_cue_display_segments(cue);
                        }
                        break;
                    }
                }
                if let Some(active) = overlay.active_cue.as_mut() {
                    if active.cue_id == cue_id
                        && (!active.committed
                            || committed
                            || source_text.is_empty()
                            || source_text.len() >= active.source_text.len())
                    {
                        apply_source_update(active, source_text, committed, sequence);
                        if committed {
                            finalize_cue_display_segments(active);
                        }
                    }
                }
            } else {
                let cue = new_subtitle_cue(
                    cue_id,
                    &route_direction,
                    source_text,
                    committed,
                    sequence,
                );
                overlay.active_cue = Some(cue.clone());
                overlay.recent_cues.insert(0, cue);
                trim_recent_subtitle_cues(overlay);
            }
            source_contract(overlay, cue_id, sequence)
        });
        self.note_first_translation_source(cue_id, source_text);
        if let Some((revision, cue_sequence, translation_state)) = cue_contract {
            self.watch_session_report.record_source_runtime(
                cue_id,
                &route_direction,
                source_text,
                committed,
                revision,
                cue_sequence,
                translation_state,
            );
        }
    }

    pub(crate) fn commit_stt_cue(&self, cue_id: &str, source_text: &str, direction: &str) {
        self.source_final_cues.insert(cue_id);
        let sequence = self.next_subtitle_sequence();
        let cue_contract = self.subtitles.update(|overlay| {
            let exists = overlay.recent_cues.iter().any(|cue| cue.cue_id == cue_id);
            if exists {
                for cue in overlay.recent_cues.iter_mut() {
                    if cue.cue_id == cue_id {
                        apply_source_update(cue, source_text, true, sequence);
                        finalize_cue_display_segments(cue);
                        cue.ended_at = ms_marker(unix_ms());
                        break;
                    }
                }
                if let Some(active) = overlay.active_cue.as_mut() {
                    if active.cue_id == cue_id {
                        apply_source_update(active, source_text, true, sequence);
                        finalize_cue_display_segments(active);
                        active.ended_at = ms_marker(unix_ms());
                    }
                }
            } else {
                let cue = new_subtitle_cue(cue_id, direction, source_text, true, sequence);
                overlay.active_cue = Some(cue.clone());
                overlay.recent_cues.insert(0, cue);
                trim_recent_subtitle_cues(overlay);
            }
            source_contract(overlay, cue_id, sequence)
        });
        self.note_first_translation_source(cue_id, source_text);
        if let Some((revision, cue_sequence, translation_state)) = cue_contract {
            self.watch_session_report.record_source_runtime(
                cue_id,
                direction,
                source_text,
                true,
                revision,
                cue_sequence,
                translation_state,
            );
        }
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.inbound.segment_count += 1;
    }
}

fn source_contract(
    overlay: &SubtitleOverlayRuntimeSnapshot,
    cue_id: &str,
    fallback_sequence: u64,
) -> Option<(u64, u64, Option<SubtitleTranslationStateRuntime>)> {
    overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == cue_id)
        .map(|cue| {
            (
                cue_revision(cue),
                cue.sequence.unwrap_or(fallback_sequence),
                cue.translation_state,
            )
        })
}
