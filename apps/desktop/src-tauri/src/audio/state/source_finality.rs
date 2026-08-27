use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct SourceFinalityStore {
    cue_ids: Mutex<HashSet<String>>,
}

impl SourceFinalityStore {
    pub(super) fn set(&self, cue_id: &str, is_final: bool) {
        let mut cue_ids = self.cue_ids.lock().expect("source finality store poisoned");
        if is_final {
            cue_ids.insert(cue_id.to_string());
        } else {
            cue_ids.remove(cue_id);
        }
    }

    pub(super) fn insert(&self, cue_id: &str) {
        self.set(cue_id, true);
    }

    pub(super) fn remove(&self, cue_id: &str) {
        self.set(cue_id, false);
    }

    pub(super) fn clear(&self) {
        self.cue_ids
            .lock()
            .expect("source finality store poisoned")
            .clear();
    }

    pub(super) fn contains(&self, cue_id: &str) -> bool {
        self.cue_ids
            .lock()
            .expect("source finality store poisoned")
            .contains(cue_id)
    }
}
