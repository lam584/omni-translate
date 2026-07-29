use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Cues whose secondary subtitle translation is gated behind a manual
/// response decision. Entries only ever describe uncommitted cues; callers
/// release them together with the cues they gate and periodically drain
/// expired entries so stranded gates cannot leak for the app lifetime.
pub(super) struct DeferredTranslationStore {
    entries: Mutex<HashMap<String, Instant>>,
}

impl DeferredTranslationStore {
    pub(super) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Instant>> {
        self.entries
            .lock()
            .expect("deferred subtitle cues poisoned")
    }

    pub(super) fn defer(&self, cue_id: &str) {
        self.lock().insert(cue_id.to_string(), Instant::now());
    }

    pub(super) fn remove(&self, cue_id: &str) {
        self.lock().remove(cue_id);
    }

    pub(super) fn allowed(&self, cue_id: &str) -> bool {
        !self.lock().contains_key(cue_id)
    }

    pub(super) fn clear(&self) {
        self.lock().clear();
    }

    /// Removes and returns every entry whose last defer touch is at least
    /// `max_age` old. `Duration::ZERO` flushes all entries.
    pub(super) fn take_expired(&self, max_age: Duration) -> Vec<String> {
        let now = Instant::now();
        let mut entries = self.lock();
        let expired: Vec<String> = entries
            .iter()
            .filter(|(_, deferred_at)| now.saturating_duration_since(**deferred_at) >= max_age)
            .map(|(cue_id, _)| cue_id.clone())
            .collect();
        for cue_id in &expired {
            entries.remove(cue_id);
        }
        expired
    }
}
