use std::collections::HashMap;
use std::time::Instant;

#[derive(Default)]
struct CueFirstTranslationTiming {
    first_source_at: Option<Instant>,
    recorded: bool,
}

#[derive(Clone, Copy)]
pub(super) struct FirstTranslationLatencyMetrics {
    pub(super) average_ms: u64,
    pub(super) last_ms: u64,
    pub(super) sample_count: u64,
}

#[derive(Default)]
pub(super) struct FirstTranslationLatencyTracker {
    cues: HashMap<String, CueFirstTranslationTiming>,
    total_ms: u128,
    sample_count: u64,
    last_ms: Option<u64>,
}

impl FirstTranslationLatencyTracker {
    pub(super) fn record_source(&mut self, cue_id: &str, source_text: &str) {
        if source_text.trim().is_empty() {
            return;
        }

        let cue = self.cues.entry(cue_id.to_string()).or_default();
        if cue.first_source_at.is_none() {
            cue.first_source_at = Some(Instant::now());
        }
    }

    pub(super) fn record_translation(
        &mut self,
        cue_id: &str,
        translated_text: &str,
    ) -> Option<FirstTranslationLatencyMetrics> {
        if translated_text.trim().is_empty() {
            return None;
        }

        let cue = self.cues.entry(cue_id.to_string()).or_default();
        if cue.recorded {
            return None;
        }
        let first_source_at = cue.first_source_at?;

        cue.recorded = true;
        let elapsed_ms = first_source_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self.total_ms = self.total_ms.saturating_add(elapsed_ms as u128);
        self.sample_count = self.sample_count.saturating_add(1);
        self.last_ms = Some(elapsed_ms);

        Some(self.metrics())
    }

    fn metrics(&self) -> FirstTranslationLatencyMetrics {
        let average_ms = if self.sample_count == 0 {
            0
        } else {
            (self.total_ms / self.sample_count as u128).min(u64::MAX as u128) as u64
        };

        FirstTranslationLatencyMetrics {
            average_ms,
            last_ms: self.last_ms.unwrap_or(0),
            sample_count: self.sample_count,
        }
    }

    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }
}
