use std::sync::{Arc, Mutex};
#[path = "native_capture_start/health.rs"]
mod health;
pub(crate) use health::{NativeCaptureHealthSnapshot, NativeCapturePacket, NativeCaptureQuery, NativeCaptureWork};
use health::NativeCaptureHealth;

/// The Start acknowledgement and coherent health belong to this activation,
/// never to an endpoint name or an optimistic route snapshot.
#[derive(Clone)]
pub(crate) struct NativeCaptureStartAck(Arc<Mutex<NativeCaptureHealth>>);

impl NativeCaptureStartAck {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Mutex::new(NativeCaptureHealth::new())))
    }
    fn with_health<T>(&self, f: impl FnOnce(&mut NativeCaptureHealth) -> T) -> T {
        let mut health = self.0.lock().unwrap_or_else(|poisoned| {
            let mut health = poisoned.into_inner();
            health.finish(Some("native capture health lock poisoned".into()));
            health
        });
        f(&mut health)
    }
    pub(crate) fn observe_native_start<T, E>(&self, result: Result<T, E>) -> Result<T, E> {
        self.with_health(|health| {
            if result.is_ok() { health.start(); }
            else { health.finish(Some("native IAudioClient Start failed".into())); }
        });
        result
    }
    /// Historical Start is deliberately not a claim of producer liveness.
    #[cfg(test)]
    pub(crate) fn is_started(&self) -> bool {
        self.with_health(|health| health.snapshot.started)
    }
    pub(crate) fn same_owner(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub(crate) fn health(&self) -> health::NativeCaptureHealthSnapshot {
        self.with_health(|health| health.snapshot.clone())
    }
    pub(crate) fn producer_guard(&self) -> NativeCaptureProducerGuard {
        NativeCaptureProducerGuard { owner: self.clone(), finished: false, thread_bound: std::marker::PhantomData }
    }
    /// Only the real producer calls this, AFTER synchronous AEC and dispatch
    /// returned and GetNextPacketSize actually succeeded. No waits publish.
    #[cfg(test)]
    pub(crate) fn publish_query(&self, at: std::time::Instant,
        query: NativeCaptureQuery, work: NativeCaptureWork) {
        self.with_health(|health| health.publish(at, query, work));
    }
}

pub(crate) struct NativeCaptureProducerGuard {
    owner: NativeCaptureStartAck,
    finished: bool,
    // The real Start/query/stop producer cannot be moved to another thread.
    thread_bound: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl NativeCaptureProducerGuard {
    /// Coherent identity of this real Start/reset owner. Read-only: never derive
    /// identity from endpoint names, tail permits, or a mutable route snapshot.
    pub(crate) fn diagnostic_owner_identity(&self) -> (u64, u64) {
        self.owner.with_health(|health| (health.snapshot.owner_id, health.snapshot.aec_reset_generation))
    }

    /// Actual GetBuffer metadata is published before AEC, without query freshness.
    pub(crate) fn record_buffer_packet(&self, captured_frames: usize,
        buffer_info: &wasapi::BufferInfo, residual_bytes: usize,
        raw_energy: impl FnOnce() -> f32) -> NativeCaptureWork {
        let mut work = NativeCaptureWork::default();
        if captured_frames > 0 {
            work.packet = Some(NativeCapturePacket {
                frames: captured_frames as u64, device_frame_index: buffer_info.index,
                qpc_100ns: buffer_info.timestamp, silent: buffer_info.flags.silent,
                data_discontinuity: buffer_info.flags.data_discontinuity,
                timestamp_error: buffer_info.flags.timestamp_error, raw_energy_db: raw_energy(),
            });
            self.record_packet(work.packet.as_ref().expect("real packet"), residual_bytes);
        }
        work
    }
    /// Every successful Start path stops once, with sticky fault/terminal already visible.
    /// The sole capture/reset owner seals diagnostics after stop and before final completion.
    pub(crate) fn finish_capture(&mut self, capture_result: Result<(), String>,
        stop: impl FnOnce() -> Result<(), String>, seal_diagnostics: impl FnOnce()) -> Result<(), String> {
        if let Err(ref error) = capture_result { self.fault(error); }
        self.stopping();
        let stop_result = stop();
        seal_diagnostics();
        // Keep native Stop/owner cleanup details even when processing already
        // failed. Sticky health still retains its first fault; the returned error
        // must carry every failure for sealed diagnostics and the route owner.
        let result = match (capture_result, stop_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(capture), Ok(())) => Err(capture),
            (Ok(()), Err(stop)) => Err(stop),
            (Err(capture), Err(stop)) => Err(format!("{capture}; native capture cleanup: {stop}")),
        };
        self.finish(&result);
        result
    }

    pub(crate) fn begin_work(&self, residual_bytes: usize) {
        self.owner.with_health(|health| health.begin_work(residual_bytes));
    }
    pub(crate) fn record_packet(&self, packet: &NativeCapturePacket, residual_bytes: usize) {
        self.owner.with_health(|health| health.record_packet(packet, residual_bytes, std::time::Instant::now()));
    }
    pub(crate) fn record_raw_activity(&self, energy_db: f32) {
        self.owner.with_health(|health| health.record_raw_activity(energy_db, std::time::Instant::now()));
    }
    /// Called only after the real production AEC reset returned successfully.
    pub(crate) fn record_aec_reset(&self) {
        self.owner.with_health(|health| health.record_aec_reset());
    }
    pub(crate) fn complete_aec(&self, frames: u64) {
        self.owner.with_health(|health| health.complete_aec(frames));
    }
    pub(crate) fn complete_dispatch(&self, frames: u64) {
        self.owner.with_health(|health| health.complete_dispatch(frames));
    }
    pub(crate) fn publish_query(&self, at: std::time::Instant,
        query: NativeCaptureQuery, work: NativeCaptureWork) {
        self.owner.with_health(|health| health.publish(at, query, work));
    }
    pub(crate) fn fault(&self, error: &str) {
        self.owner.with_health(|health| health.finish(Some(error.into())));
    }
    pub(crate) fn stopping(&self) {
        self.owner.with_health(|health| health.finish(None));
    }
    pub(crate) fn finish(&mut self, result: &Result<(), String>) {
        self.owner.with_health(|health| health.finish(result.as_ref().err().cloned()));
        self.finished = true;
    }
}
impl Drop for NativeCaptureProducerGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.owner.with_health(|health| health.finish(Some(
                "native capture producer dropped before completion".into())));
        }
    }
}
