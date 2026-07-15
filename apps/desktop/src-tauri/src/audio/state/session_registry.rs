use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use super::AudioRouteHandle;
use crate::audio::stt::SttHandle;

pub(super) struct SessionRegistry {
    sessions: Mutex<HashMap<String, AudioRouteHandle>>,
    stt_handles: Mutex<HashMap<String, SttHandle>>,
    inbound_pipeline_lock: Mutex<()>,
}

impl SessionRegistry {
    pub(super) fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            stt_handles: Mutex::new(HashMap::new()),
            inbound_pipeline_lock: Mutex::new(()),
        }
    }

    pub(super) fn lock_inbound_pipeline(&self) -> MutexGuard<'_, ()> {
        self.inbound_pipeline_lock.lock().expect("inbound pipeline lock poisoned")
    }

    pub(super) fn store_stt(&self, direction: &str, handle: SttHandle) -> Option<SttHandle> {
        self.stt_handles.lock().expect("stt handles poisoned").insert(direction.to_string(), handle)
    }

    pub(super) fn take_stt(&self, direction: &str) -> Option<SttHandle> {
        self.stt_handles.lock().expect("stt handles poisoned").remove(direction)
    }

    pub(super) fn insert(&self, direction: &str, handle: AudioRouteHandle) {
        self.sessions.lock().expect("audio sessions poisoned").insert(direction.to_string(), handle);
    }

    pub(super) fn take(&self, direction: &str) -> Option<AudioRouteHandle> {
        self.sessions.lock().expect("audio sessions poisoned").remove(direction)
    }
}
