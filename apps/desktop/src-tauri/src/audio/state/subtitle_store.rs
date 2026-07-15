use std::sync::Mutex;

use crate::audio::contracts::SubtitleOverlayRuntimeSnapshot;

pub(super) struct SubtitleStore {
    overlay: Mutex<SubtitleOverlayRuntimeSnapshot>,
}

impl SubtitleStore {
    pub(super) fn new(initial: SubtitleOverlayRuntimeSnapshot) -> Self {
        Self { overlay: Mutex::new(initial) }
    }
    pub(super) fn snapshot(&self) -> SubtitleOverlayRuntimeSnapshot {
        self.overlay.lock().expect("subtitle store poisoned").clone()
    }
    pub(super) fn update<R>(&self, mutate: impl FnOnce(&mut SubtitleOverlayRuntimeSnapshot) -> R) -> R {
        mutate(&mut self.overlay.lock().expect("subtitle store poisoned"))
    }
}
