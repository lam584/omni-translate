use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use super::AudioRouteHandle;
use crate::audio::stt::SttHandle;

pub(super) struct SessionRegistry {
    sessions: Mutex<HashMap<String, AudioRouteHandle>>,
    stt_handles: Mutex<HashMap<String, SttHandle>>,
    inbound_pipeline_lock: Mutex<()>,
    /// Cancellation token for detached inbound route starts. Every inbound
    /// start/stop command bumps it; a detached fast-watch worker re-reads it
    /// after acquiring the pipeline lock and aborts when it was superseded,
    /// so a stop that won the lock race cannot be undone by a pending start.
    inbound_route_generation: AtomicU64,
}

impl SessionRegistry {
    pub(super) fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            stt_handles: Mutex::new(HashMap::new()),
            inbound_pipeline_lock: Mutex::new(()),
            inbound_route_generation: AtomicU64::new(0),
        }
    }

    pub(super) fn lock_inbound_pipeline(&self) -> MutexGuard<'_, ()> {
        self.inbound_pipeline_lock.lock().expect("inbound pipeline lock poisoned")
    }

    pub(super) fn inbound_route_generation(&self) -> u64 {
        self.inbound_route_generation.load(Ordering::SeqCst)
    }

    pub(super) fn bump_inbound_route_generation(&self) -> u64 {
        self.inbound_route_generation.fetch_add(1, Ordering::SeqCst) + 1
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

    pub(super) fn has(&self, direction: &str) -> bool {
        self.sessions.lock().expect("audio sessions poisoned").contains_key(direction)
    }

    pub(super) fn take(&self, direction: &str) -> Option<AudioRouteHandle> {
        self.sessions.lock().expect("audio sessions poisoned").remove(direction)
    }
}
