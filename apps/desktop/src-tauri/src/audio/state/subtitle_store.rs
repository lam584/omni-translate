use std::sync::Mutex;

use crate::audio::contracts::SubtitleOverlayRuntimeSnapshot;

pub(super) struct SubtitleStore {
    overlay: Mutex<SubtitleOverlayRuntimeSnapshot>,
}

impl SubtitleStore {
    pub(super) fn new(initial: SubtitleOverlayRuntimeSnapshot) -> Self {
        Self { overlay: Mutex::new(initial) }
    }
    pub(super) fn snapshot(&self, cue_limit: usize) -> SubtitleOverlayRuntimeSnapshot {
        let overlay = self.overlay.lock().expect("subtitle store poisoned");
        SubtitleOverlayRuntimeSnapshot {
            stream_id: overlay.stream_id.clone(),
            generation: overlay.generation,
            seq: overlay.seq,
            baseline_included: overlay.baseline_included,
            queue_depth: overlay.queue_depth,
            dropped_cue_count: overlay.dropped_cue_count,
            first_translation_average_ms: overlay.first_translation_average_ms,
            first_translation_last_ms: overlay.first_translation_last_ms,
            first_translation_sample_count: overlay.first_translation_sample_count,
            report_session_id: overlay.report_session_id.clone(),
            active_cue: overlay.active_cue.clone(),
            recent_cues: overlay
                .recent_cues
                .iter()
                .take(cue_limit)
                .cloned()
                .collect(),
        }
    }
    pub(super) fn update<R>(&self, mutate: impl FnOnce(&mut SubtitleOverlayRuntimeSnapshot) -> R) -> R {
        mutate(&mut self.overlay.lock().expect("subtitle store poisoned"))
    }
}
