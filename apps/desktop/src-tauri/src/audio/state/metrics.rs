use std::sync::Mutex;

use super::translation_latency::FirstTranslationLatencyTracker;
use crate::audio::contracts::SubtitleOverlayRuntimeSnapshot;

pub(super) struct AudioMetricsStore {
    first_translation_latency: Mutex<FirstTranslationLatencyTracker>,
}

impl AudioMetricsStore {
    pub(super) fn new() -> Self {
        Self { first_translation_latency: Mutex::new(FirstTranslationLatencyTracker::default()) }
    }
    pub(super) fn note_source(&self, cue_id: &str, source_text: &str) {
        self.first_translation_latency.lock().expect("first translation latency poisoned")
            .record_source(cue_id, source_text);
    }
    pub(super) fn note_translation(&self, overlay: &mut SubtitleOverlayRuntimeSnapshot, cue_id: &str, text: &str) {
        let Some(metrics) = self.first_translation_latency.lock().expect("first translation latency poisoned")
            .record_translation(cue_id, text) else { return; };
        overlay.first_translation_average_ms = Some(metrics.average_ms);
        overlay.first_translation_last_ms = Some(metrics.last_ms);
        overlay.first_translation_sample_count = metrics.sample_count;
    }
    pub(super) fn reset(&self, overlay: &mut SubtitleOverlayRuntimeSnapshot) {
        self.first_translation_latency.lock().expect("first translation latency poisoned").reset();
        overlay.first_translation_average_ms = None;
        overlay.first_translation_last_ms = None;
        overlay.first_translation_sample_count = 0;
    }
}
