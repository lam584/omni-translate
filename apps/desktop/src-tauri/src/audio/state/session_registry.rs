use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use super::AudioRouteHandle;
use crate::audio::stt::SttHandle;

pub(crate) struct RouteInputCompletionRequest {
    pub(crate) ack_tx: std::sync::mpsc::Sender<Result<RouteInputCompletionEvidence, String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RouteInputCompletionEvidence {
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) provider_input_closed_source_sequence: u64,
    pub(crate) provider_sender_released: bool,
    pub(crate) status_consumer_retained: bool,
    pub(crate) padded_tail_bytes: usize,
}

pub(super) struct SessionRegistry {
    sessions: Mutex<HashMap<String, AudioRouteHandle>>,
    route_input_completion_senders:
        Mutex<HashMap<String, std::sync::mpsc::Sender<RouteInputCompletionRequest>>>,
    stt_handles: Mutex<HashMap<String, SttHandle>>,
    inbound_pipeline_lock: Mutex<()>,
    /// Linearizes generation changes with late-worker error commits. Route
    /// start/stop only hold this lock for the generation increment; a worker
    /// performs any blocking Bridge query without it, then takes it again for
    /// the final generation check and all user-visible error side effects.
    inbound_route_authority: Mutex<()>,
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
            route_input_completion_senders: Mutex::new(HashMap::new()),
            stt_handles: Mutex::new(HashMap::new()),
            inbound_pipeline_lock: Mutex::new(()),
            inbound_route_authority: Mutex::new(()),
            inbound_route_generation: AtomicU64::new(0),
        }
    }

    pub(super) fn lock_inbound_pipeline(&self) -> MutexGuard<'_, ()> {
        self.inbound_pipeline_lock.lock().expect("inbound pipeline lock poisoned")
    }

    pub(super) fn inbound_route_generation(&self) -> u64 {
        self.inbound_route_generation.load(Ordering::SeqCst)
    }

    pub(super) fn lock_inbound_route_authority(&self) -> MutexGuard<'_, ()> {
        self.inbound_route_authority
            .lock()
            .expect("inbound route authority poisoned")
    }

    pub(super) fn bump_inbound_route_generation(&self) -> u64 {
        let _authority = self.lock_inbound_route_authority();
        self.inbound_route_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(super) fn store_stt(&self, direction: &str, handle: SttHandle) -> Option<SttHandle> {
        self.stt_handles.lock().expect("stt handles poisoned").insert(direction.to_string(), handle)
    }

    pub(super) fn has_stt(&self, direction: &str) -> bool {
        self.stt_handles.lock().expect("stt handles poisoned").contains_key(direction)
    }

    pub(super) fn take_stt(&self, direction: &str) -> Option<SttHandle> {
        self.stt_handles.lock().expect("stt handles poisoned").remove(direction)
    }

    pub(super) fn insert(&self, direction: &str, handle: AudioRouteHandle) {
        self.sessions.lock().expect("audio sessions poisoned").insert(direction.to_string(), handle);
    }

    pub(super) fn native_capture_start_ack(&self, direction: &str) -> Option<super::NativeCaptureStartAck> {
        let sessions = self.sessions.lock().expect("audio sessions poisoned");
        let handle = sessions.get(direction)?;
        if handle.join_handle.is_finished() { return None; }
        handle.native_capture_start.clone()
    }

    pub(super) fn take(&self, direction: &str) -> Option<AudioRouteHandle> {
        self.sessions.lock().expect("audio sessions poisoned").remove(direction)
    }

    pub(super) fn store_route_input_completion_sender(
        &self,
        direction: &str,
        sender: std::sync::mpsc::Sender<RouteInputCompletionRequest>,
    ) {
        self.route_input_completion_senders
            .lock()
            .expect("route input completion senders poisoned")
            .insert(direction.to_string(), sender);
    }

    pub(super) fn take_route_input_completion_sender(
        &self,
        direction: &str,
    ) -> Option<std::sync::mpsc::Sender<RouteInputCompletionRequest>> {
        self.route_input_completion_senders
            .lock()
            .expect("route input completion senders poisoned")
            .remove(direction)
    }
}


#[cfg(test)]
mod native_start_ack_tests {
    use super::*;
    use crate::audio::state::NativeCaptureStartAck;

    fn parked_handle(ack: Option<NativeCaptureStartAck>) -> AudioRouteHandle {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        AudioRouteHandle {
            stop_tx,
            join_handle: std::thread::spawn(move || { let _ = stop_rx.recv(); }),
            native_capture_start: ack,
        }
    }

    fn join_handle(handle: AudioRouteHandle) {
        let _ = handle.stop_tx.send(());
        handle.join_handle.join().unwrap();
    }

    #[test]
    fn registry_returns_only_active_owner_not_old_same_endpoint_ack() {
        let registry = SessionRegistry::new();
        let old = NativeCaptureStartAck::new();
        registry.insert("inbound", parked_handle(Some(old.clone())));
        assert!(registry.native_capture_start_ack("inbound").unwrap().same_owner(&old));
        let old_handle = registry.take("inbound").unwrap();
        assert!(registry.native_capture_start_ack("inbound").is_none());
        let current = NativeCaptureStartAck::new();
        registry.insert("inbound", parked_handle(Some(current.clone())));
        old.observe_native_start(Ok::<(), &str>(())).unwrap();
        let registered = registry.native_capture_start_ack("inbound").unwrap();
        assert!(registered.same_owner(&current));
        assert!(!registered.same_owner(&old));
        assert!(!registered.is_started());
        join_handle(old_handle);
        join_handle(registry.take("inbound").unwrap());
    }

    #[test]
    fn bridge_or_non_capture_handle_cannot_supply_native_ack() {
        let registry = SessionRegistry::new();
        registry.insert("inbound", parked_handle(None));
        assert!(registry.native_capture_start_ack("inbound").is_none());
        join_handle(registry.take("inbound").unwrap());
    }

    #[test]
    fn exited_native_producer_is_not_an_active_start_authority() {
        let registry = SessionRegistry::new();
        let ack = NativeCaptureStartAck::new();
        ack.observe_native_start(Ok::<(), &str>(())).unwrap();
        let (stop_tx, _stop_rx) = std::sync::mpsc::channel();
        let handle = AudioRouteHandle {
            stop_tx,
            join_handle: std::thread::spawn(|| {}),
            native_capture_start: Some(ack),
        };
        while !handle.join_handle.is_finished() { std::thread::yield_now(); }
        registry.insert("inbound", handle);
        assert!(registry.native_capture_start_ack("inbound").is_none());
        join_handle(registry.take("inbound").unwrap());
    }
}
