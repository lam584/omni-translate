use super::*;

impl AudioStateStore {
    /// Removes only the provider-owned cue proven to be an ignored short-VAD
    /// fragment. Unlike ordinary cancellation cleanup, this may remove a
    /// source-final cue because response ownership and duration were already
    /// established before this API is called.
    pub(crate) fn discard_ignored_short_vad_fragment_cue(&self, cue_id: &str) {
        self.deferred_subtitle_translation_cues.remove(cue_id);
        self.source_final_cues.remove(cue_id);
        self.subtitles.update(|overlay| {
            overlay.recent_cues.retain(|cue| cue.cue_id != cue_id);
            if overlay.active_cue.as_ref().is_some_and(|cue| cue.cue_id == cue_id) {
                overlay.active_cue = None;
            }
            trim_recent_subtitle_cues(overlay);
        });
        self.watch_session_report
            .discard_ignored_short_vad_fragment_cue(cue_id);
        self.history.discard_cue(cue_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_short_vad_cleanup_removes_exact_committed_cue_only() {
        let store = AudioStateStore::new();
        store.watch_session_report.begin_or_reuse("test", "model");
        store.update_or_push_stt_cue("keep", "keep source", true);
        store.update_or_push_stt_cue("short", "我。", true);

        store.discard_ignored_short_vad_fragment_cue("short");

        let snapshot = store.snapshot();
        assert!(!snapshot.subtitle_overlay.recent_cues.iter().any(|cue| cue.cue_id == "short"));
        assert!(snapshot.subtitle_overlay.recent_cues.iter().any(|cue| cue.cue_id == "keep"));
        let report = store.watch_session_report.snapshot().expect("report");
        assert_eq!(report.cues.len(), 1);
        assert_eq!(report.cues[0].cue_id, "keep");
    }
}
