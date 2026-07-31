use std::collections::HashMap;
use std::sync::{mpsc::Sender, Mutex};

use crate::audio::omni::{OmniHandle, OmniOutputMode};
use super::{OmniSessionLifecycle, OmniSessionMetadata};

pub(super) struct OmniSessionStore {
    handles: Mutex<HashMap<String, OmniHandle>>,
    senders: Mutex<HashMap<String, Sender<Vec<u8>>>>,
    sessions: Mutex<HashMap<String, OmniSessionMetadata>>,
    generations: Mutex<HashMap<String, u64>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_generation_rejects_late_registration() {
        let store = OmniSessionStore::new();
        let generation = store.begin(
            "inbound",
            "omni",
            false,
            OmniOutputMode::TextAndAudio,
        );
        assert!(store.is_current("inbound", generation));
        assert!(store.mark_stopping("inbound", generation, "cancelled".to_string()));
        assert!(!store.is_current("inbound", generation));
        let replacement = store.begin(
            "inbound",
            "omni-new",
            false,
            OmniOutputMode::TextAndAudio,
        );
        assert!(!store.is_current("inbound", generation));
        assert!(store.is_current("inbound", replacement));
    }
}

impl OmniSessionStore {
    pub(super) fn new() -> Self {
        Self { handles: Mutex::new(HashMap::new()), senders: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()), generations: Mutex::new(HashMap::new()) }
    }

    pub(super) fn store_handle(&self, direction: &str, handle: OmniHandle) -> Option<OmniHandle> {
        self.handles.lock().expect("omni handles poisoned").insert(direction.to_string(), handle)
    }
    pub(super) fn store_sender(&self, direction: &str, sender: Sender<Vec<u8>>) {
        self.senders.lock().expect("omni senders poisoned").insert(direction.to_string(), sender);
    }
    pub(super) fn has_sender(&self, direction: &str) -> bool {
        self.senders.lock().expect("omni senders poisoned").contains_key(direction)
    }
    pub(super) fn take_sender(&self, direction: &str) -> Option<Sender<Vec<u8>>> {
        self.senders.lock().expect("omni senders poisoned").remove(direction)
    }
    pub(super) fn take_handle(&self, direction: &str) -> Option<OmniHandle> {
        let _ = self.take_sender(direction);
        self.sessions.lock().expect("omni sessions poisoned").remove(direction);
        self.handles.lock().expect("omni handles poisoned").remove(direction)
    }
    pub(super) fn begin(
        &self,
        direction: &str,
        model_id: &str,
        subtitle_translate_active: bool,
        output_mode: OmniOutputMode,
    ) -> u64 {
        let generation = {
            let mut values = self.generations.lock().expect("omni generations poisoned");
            *values.entry(direction.to_string()).and_modify(|value| *value = value.saturating_add(1)).or_insert(1)
        };
        self.sessions.lock().expect("omni sessions poisoned").insert(direction.to_string(), OmniSessionMetadata {
            direction: direction.to_string(), session_generation: generation, model_id: model_id.to_string(),
            subtitle_translate_active, output_mode, state: OmniSessionLifecycle::Starting, last_error: None,
        });
        generation
    }
    fn mutate_matching(&self, direction: &str, generation: u64, mutate: impl FnOnce(&mut OmniSessionMetadata)) -> bool {
        let mut sessions = self.sessions.lock().expect("omni sessions poisoned");
        let Some(session) = sessions.get_mut(direction) else { return false; };
        if session.session_generation != generation { return false; }
        mutate(session); true
    }
    pub(super) fn mark_ready(&self, direction: &str, generation: u64) -> bool {
        self.mutate_matching(direction, generation, |session| { session.state = OmniSessionLifecycle::Ready; session.last_error = None; })
    }
    pub(super) fn mark_failed(&self, direction: &str, generation: u64, error: String) -> bool {
        self.mutate_matching(direction, generation, |session| { session.state = OmniSessionLifecycle::Failed; session.last_error = Some(error); })
    }
    pub(super) fn mark_stopping(&self, direction: &str, generation: u64, reason: String) -> bool {
        self.mutate_matching(direction, generation, |session| { session.state = OmniSessionLifecycle::Stopping; session.last_error = Some(reason); })
    }
    pub(super) fn clear(&self, direction: &str, generation: u64) -> bool {
        let should_clear = { let mut sessions = self.sessions.lock().expect("omni sessions poisoned");
            matches!(sessions.get(direction), Some(session) if session.session_generation == generation) && { sessions.remove(direction); true } };
        if should_clear { self.senders.lock().expect("omni senders poisoned").remove(direction);
            self.handles.lock().expect("omni handles poisoned").remove(direction); }
        should_clear
    }
    pub(super) fn matching_ready(
        &self,
        direction: &str,
        model_id: &str,
        subtitle_translate_active: bool,
        output_mode: OmniOutputMode,
    ) -> Option<u64> {
        self.sessions.lock().expect("omni sessions poisoned").get(direction)
            .filter(|session| session.state == OmniSessionLifecycle::Ready && session.model_id == model_id
                && session.subtitle_translate_active == subtitle_translate_active
                && session.output_mode == output_mode)
            .map(|session| session.session_generation)
    }
    pub(super) fn take_matching_sender(
        &self,
        direction: &str,
        model_id: &str,
        subtitle_translate_active: bool,
        output_mode: OmniOutputMode,
    ) -> Option<Sender<Vec<u8>>> {
        self.matching_ready(direction, model_id, subtitle_translate_active, output_mode)?;
        self.take_sender(direction)
    }
    pub(super) fn metadata(&self, direction: &str) -> Option<OmniSessionMetadata> {
        self.sessions.lock().expect("omni sessions poisoned").get(direction).cloned()
    }
    pub(super) fn is_current(&self, direction: &str, generation: u64) -> bool {
        self.sessions.lock().expect("omni sessions poisoned").get(direction)
            .map(|session| session.session_generation == generation && session.state != OmniSessionLifecycle::Stopping)
            .unwrap_or(false)
    }
}
