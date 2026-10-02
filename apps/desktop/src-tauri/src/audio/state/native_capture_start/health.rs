use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use serde::Serialize;
static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);
const FRESHNESS: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "frames", rename_all = "kebab-case")]
pub(crate) enum NativeCaptureQuery { Empty, Pending(u32), Unavailable }
impl NativeCaptureQuery {
    // Patched wasapi shared GetNextPacketSize returns Some(0) on successful
    // native zero. None skips the API in exclusive mode: NOT an Empty query.
    pub(crate) fn from_packet_size(size: Option<u32>) -> Self {
        match size { Some(0) => Self::Empty, Some(n) => Self::Pending(n), None => Self::Unavailable }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCapturePacket {
    pub(crate) frames: u64,
    pub(crate) device_frame_index: u64,
    pub(crate) qpc_100ns: u64,
    pub(crate) silent: bool,
    pub(crate) data_discontinuity: bool,
    pub(crate) timestamp_error: bool,
    pub(crate) raw_energy_db: f32,
}
#[derive(Default)]
pub(crate) struct NativeCaptureWork {
    pub(crate) packet: Option<NativeCapturePacket>,
    pub(crate) aec_completed_frames: u64,
    pub(crate) dispatch_completed_frames: u64,
    pub(crate) residual_bytes: usize,
}
/// Private owner-local state; packet clocks never change for Empty polls.
#[derive(Clone, Debug)]
pub(crate) struct NativeCaptureHealthSnapshot {
    pub(crate) owner_id: u64,
    pub(crate) started: bool,
    pub(crate) terminal: bool,
    pub(crate) fault: Option<String>,
    pub(crate) query: NativeCaptureQuery,
    pub(crate) successful_queries: u64,
    pub(crate) last_query_at: Option<Instant>,
    pub(crate) empty_since: Option<Instant>,
    pub(crate) empty_epoch: u64,
    pub(crate) empty_polls: u64,
    pub(crate) maximum_empty_poll_gap: Duration,
    pub(crate) captured_frames: u64,
    pub(crate) aec_completed_frames: u64,
    pub(crate) dispatch_completed_frames: u64,
    pub(crate) residual_bytes: usize,
    pub(crate) work_pending: bool,
    pub(crate) progress_epoch: u64,
    pub(crate) quiescence_epoch: u64,
    pub(crate) aec_reset_generation: u64,
    pub(crate) last_query_gap: Option<Duration>,
    pub(crate) raw_activity_generation: u64,
    pub(crate) last_raw_activity_at: Option<Instant>,
    pub(crate) latest_packet: Option<NativeCapturePacket>,
}
pub(super) struct NativeCaptureHealth {
    pub(super) snapshot: NativeCaptureHealthSnapshot,
    packet_recorded: bool,
}
impl NativeCaptureHealth {
    pub(super) fn new() -> Self {
        Self { packet_recorded: false, snapshot: NativeCaptureHealthSnapshot {
            owner_id: NEXT_OWNER.fetch_add(1, Ordering::Relaxed), started: false,
            terminal: false, fault: None, query: NativeCaptureQuery::Unavailable,
            successful_queries: 0, last_query_at: None, empty_since: None,
            empty_epoch: 0, empty_polls: 0, maximum_empty_poll_gap: Duration::ZERO,
            captured_frames: 0, aec_completed_frames: 0, dispatch_completed_frames: 0,
            residual_bytes: 0, work_pending: false, progress_epoch: 0, quiescence_epoch: 0, aec_reset_generation: 0, last_query_gap: None, raw_activity_generation: 0, last_raw_activity_at: None, latest_packet: None,
        } }
    }
    pub(super) fn start(&mut self) {
        if !self.snapshot.terminal { self.snapshot.started = true; }
    }
    pub(super) fn finish(&mut self, fault: Option<String>) {
        self.snapshot.terminal = true;
        self.snapshot.work_pending = false;
        self.snapshot.empty_since = None;
        if self.snapshot.fault.is_none() { self.snapshot.fault = fault; }
    }
    // In-flight work does NOT advance a query clock or the Empty sequence. It
    // prevents completion using a still-fresh old Empty while GetBuffer/AEC/
    // dispatch is blocked. Brief empty queries do not restart a healthy chain.
    pub(super) fn begin_work(&mut self, residual_bytes: usize) {
        if self.snapshot.started && !self.snapshot.terminal {
            self.snapshot.work_pending = true;
            self.snapshot.residual_bytes = residual_bytes;
            self.packet_recorded = false;
        }
    }
    pub(super) fn record_packet(&mut self, packet: &NativeCapturePacket, residual_bytes: usize, at: Instant) {
        let s = &mut self.snapshot;
        if !s.started || s.terminal { return; }
        s.work_pending = true;
        s.captured_frames += packet.frames;
        s.residual_bytes = residual_bytes;
        if !packet.raw_energy_db.is_finite() || packet.raw_energy_db > -60.0
            || packet.data_discontinuity || packet.timestamp_error {
            s.raw_activity_generation += 1;
            s.last_raw_activity_at = Some(at);
        }
        s.latest_packet = Some(packet.clone());
        s.empty_since = None;
        s.empty_epoch += 1;
        self.packet_recorded = true;
    }
    pub(super) fn record_raw_activity(&mut self, energy_db: f32, at: Instant) {
        let s = &mut self.snapshot;
        if s.started && !s.terminal && (!energy_db.is_finite() || energy_db > -60.0) {
            s.raw_activity_generation += 1;
            s.last_raw_activity_at = Some(at);
            s.empty_since = None;
            s.empty_epoch += 1;
        }
    }
    pub(super) fn record_aec_reset(&mut self) {
        let s = &mut self.snapshot;
        if s.started && !s.terminal {
            s.aec_reset_generation += 1;
            s.empty_since = None;
            s.empty_epoch += 1;
        }
    }
    pub(super) fn complete_aec(&mut self, frames: u64) {
        if !self.snapshot.terminal { self.snapshot.aec_completed_frames += frames; }
    }
    pub(super) fn complete_dispatch(&mut self, frames: u64) {
        if !self.snapshot.terminal { self.snapshot.dispatch_completed_frames += frames; }
    }
    pub(super) fn publish(&mut self, at: Instant, query: NativeCaptureQuery, work: NativeCaptureWork) {
        if !self.snapshot.started || self.snapshot.terminal { return; }
        if let Some(ref packet) = work.packet {
            if !self.packet_recorded { self.record_packet(packet, work.residual_bytes, at); }
        }
        let had_packet = self.packet_recorded;
        self.packet_recorded = false;
        let s = &mut self.snapshot;
        let gap = s.last_query_at.map(|old| at.saturating_duration_since(old));
        if gap.is_some_and(|g| g > FRESHNESS) { s.progress_epoch += 1; }
        s.work_pending = false;
        s.aec_completed_frames += work.aec_completed_frames;
        s.dispatch_completed_frames += work.dispatch_completed_frames;
        s.residual_bytes = work.residual_bytes;
        s.last_query_gap = gap;
        if query != NativeCaptureQuery::Empty || s.residual_bytes != 0 { s.quiescence_epoch += 1; }
        let clean = !had_packet && query == NativeCaptureQuery::Empty && s.residual_bytes == 0
            && s.captured_frames > 0 && s.aec_completed_frames == s.captured_frames
            && s.dispatch_completed_frames == s.captured_frames;
        if !clean || gap.is_some_and(|g| g > FRESHNESS) || s.empty_since.is_none() {
            s.empty_epoch += 1;
            s.empty_since = clean.then_some(at);
            s.empty_polls = 0;
            s.maximum_empty_poll_gap = Duration::ZERO;
        } else if let Some(gap) = gap {
            s.maximum_empty_poll_gap = s.maximum_empty_poll_gap.max(gap);
        }
        if clean { s.empty_polls += 1; }
        s.query = query;
        if query != NativeCaptureQuery::Unavailable {
            s.successful_queries += 1;
            s.last_query_at = Some(at);
        } else {
            s.last_query_at = None;
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
