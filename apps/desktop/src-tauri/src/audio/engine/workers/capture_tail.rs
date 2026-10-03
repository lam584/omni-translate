//! Owner-local permission to dequeue a real, short f32-le stereo capture tail.
//!
//! This module neither runs AEC nor declares any frames processed. An all-zero
//! tail is still real input and MUST traverse native AEC and normal dispatch.
//! Integrators must observe EVERY real packet/native query (including failures),
//! bump queue generation on EVERY queue mutation, and serialize observation,
//! permit issuance and consumption with the capture queue's owner. A wait/event
//! wake or a cached health snapshot is not a native Empty query.
//!
//! The fixed thresholds mirror existing policy, not a new drain criterion:
//! state/native_capture_start/health.rs FRESHNESS = 100ms;
//! watch_mode_diagnostic/open_input_drain.rs QUIET_CONFIRMATION = 2s.
//! Local-aec-probe drain.rs also requires 2s. None of those policies is changed.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub(crate) const NATIVE_QUERY_FRESHNESS: Duration = Duration::from_millis(100);
pub(crate) const TAIL_QUIET_CONFIRMATION: Duration = Duration::from_secs(2);
pub(crate) const F32_STEREO_FRAME_BYTES: usize = 8;
static NEXT_PERMIT_ID: AtomicU64 = AtomicU64::new(1);

/// Identities must never be reused after a mutation/reset during this lifetime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TailQueueContext {
    pub(crate) generation: u64,
    pub(crate) owner_id: u64,
    pub(crate) continuity_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct QueueBinding {
    context: TailQueueContext,
    byte_len: usize,
}

/// Only Empty means a new successful native query returning zero available frames.
/// query_id must be the owner-local native-query sequence, not a consumer count.
/// Duplicate/backwards IDs reject; skipped IDs restart continuity from scratch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TailObservation {
    RealPacket,
    Empty { query_id: u64 },
    Pending { query_id: u64 },
    Unavailable,
    Error,
}

/// Content evidence over EVERY sample in the entire queued tail. No energy
/// threshold/latestPacket/silent flag is used. Signed zero counts as real zero;
/// nonzero includes nonfinite samples, while peak covers finite samples only.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TailPcmEvidence {
    pub(crate) frames: usize,
    pub(crate) samples: usize,
    pub(crate) finite: bool,
    pub(crate) all_zero: bool,
    pub(crate) zero_samples: usize,
    pub(crate) nonzero_samples: usize,
    pub(crate) nonfinite_samples: usize,
    pub(crate) peak: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TailPermitEvidence {
    pub(crate) context: TailQueueContext,
    pub(crate) byte_len: usize,
    pub(crate) last_nonempty_at: Instant,
    pub(crate) empty_since: Instant,
    pub(crate) last_empty_query_at: Instant,
    pub(crate) last_empty_query_id: u64,
    pub(crate) empty_polls: u64,
    pub(crate) maximum_empty_poll_gap: Duration,
    pub(crate) pcm: TailPcmEvidence,
}

/// Opaque and not Clone: issued for one query, accepted at most once. A global
/// non-wrapping ID prevents a permit from another policy instance being accepted.
#[derive(Debug)]
pub(crate) struct TailPermit {
    id: u64,
    evidence: TailPermitEvidence,
    // Exact bytes also reject same-length mutation even if a caller fails to
    // bump generation. This is never used as synthetic capture input.
    exact_bytes: Vec<u8>,
}
impl TailPermit {
    pub(crate) fn evidence(&self) -> &TailPermitEvidence { &self.evidence }
}

#[derive(Debug)]
pub(crate) struct RealCaptureTail {
    pub(crate) pcm: Vec<u8>,
    pub(crate) frames: usize,
    pub(crate) evidence: TailPermitEvidence,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum TailPolicyError {
    InvalidNormalChunkSize,
    EmptyQueue,
    NotPartialTail,
    NotFrameAligned,
    NonFinitePcm(TailPcmEvidence),
    NoRealPacket,
    NoContinuousEmptyQueries,
    QuietWindowIncomplete,
    NonmonotonicTime,
    NonmonotonicQuery,
    StaleQuery,
    QueueChanged,
    ByteContentChanged,
    AlreadyIssuedForQuery,
    PermitInvalidated,
    PermitIdsExhausted,
}

/// No state here authorizes bypassing AEC, capture shutdown, or terminal drain.
pub(crate) struct CaptureTailPolicy {
    normal_chunk_frames: usize,
    binding: Option<QueueBinding>,
    last_observation_at: Option<Instant>,
    last_native_query_id: Option<u64>,
    last_nonempty_at: Option<Instant>,
    last_empty_query_at: Option<Instant>,
    empty_since: Option<Instant>,
    empty_polls: u64,
    maximum_empty_poll_gap: Duration,
    pending: Option<u64>,
    issued_for_query: Option<Instant>,
}

impl CaptureTailPolicy {
    /// Pass the production normal chunk size (currently CHUNK_FRAMES = 960).
    pub(crate) fn new(normal_chunk_frames: usize) -> Result<Self, TailPolicyError> {
        if normal_chunk_frames < 2
            || normal_chunk_frames.checked_mul(F32_STEREO_FRAME_BYTES).is_none()
        { return Err(TailPolicyError::InvalidNormalChunkSize); }
        Ok(Self {
            normal_chunk_frames, binding: None, last_observation_at: None,
            last_native_query_id: None,
            last_nonempty_at: None, last_empty_query_at: None, empty_since: None,
            empty_polls: 0, maximum_empty_poll_gap: Duration::ZERO,
            pending: None, issued_for_query: None,
        })
    }

    fn cancel_wait(&mut self) {
        self.pending = None;
        self.empty_since = None;
        self.last_empty_query_at = None;
        self.empty_polls = 0;
        self.maximum_empty_poll_gap = Duration::ZERO;
    }

    /// For owner-local operations whose outcome is not yet known (e.g. an
    /// in-flight query/work transition). Does not manufacture a native query.
    pub(crate) fn invalidate(&mut self) { self.cancel_wait(); }

    /// Call once per REAL observation, with its actual monotonic acquisition
    /// time. Never replay a snapshot using a later consumer clock. A duplicate
    /// timestamp, backwards clock, failure or gap cancels the current chain.
    pub(crate) fn observe(
        &mut self, at: Instant, context: TailQueueContext, queue: &VecDeque<u8>,
        observation: TailObservation,
    ) -> Result<(), TailPolicyError> {
        self.pending = None; // Even a newer Empty invalidates an older permit.
        let binding = QueueBinding { context, byte_len: queue.len() };
        if self.binding.is_none_or(|previous| previous.context.owner_id != context.owner_id) {
            self.last_native_query_id = None;
        }
        if self.binding != Some(binding) {
            self.cancel_wait();
            // Require a real packet witness for this queue/owner/continuity.
            self.last_nonempty_at = None;
            self.binding = Some(binding);
        }
        if self.last_observation_at.is_some_and(|previous| at <= previous) {
            self.cancel_wait();
            // Retain the high-water clock; a replay cannot move it backwards.
            return Err(TailPolicyError::NonmonotonicTime);
        }
        self.last_observation_at = Some(at);
        // IDs come from actual native queries, not consumer polls. Keep the
        // owner-local high-water ID across failures/gaps/continuity resets.
        if let TailObservation::Empty { query_id } | TailObservation::Pending { query_id } = observation {
            if let Some(previous) = self.last_native_query_id {
                if query_id <= previous {
                    self.cancel_wait();
                    return Err(TailPolicyError::NonmonotonicQuery);
                }
                if query_id - previous != 1 {
                    // Missing observations may have been Pending/failed: no
                    // proof that the intervening native queries were Empty.
                    self.cancel_wait();
                }
            }
            self.last_native_query_id = Some(query_id);
        }
        match observation {
            TailObservation::RealPacket => {
                self.cancel_wait();
                self.last_nonempty_at = Some(at);
            }
            TailObservation::Pending { .. } => {
                self.cancel_wait();
                // A Pending query is not proof that its PCM has been received.
                // Keep the real packet witness, but advance the nonempty clock.
                if self.last_nonempty_at.is_some() { self.last_nonempty_at = Some(at); }
            }
            TailObservation::Unavailable | TailObservation::Error => self.cancel_wait(),
            TailObservation::Empty { .. } => {
                let gap = self.last_empty_query_at.map(|previous| at.duration_since(previous));
                if gap.is_some_and(|gap| gap > NATIVE_QUERY_FRESHNESS) {
                    self.cancel_wait();
                }
                // This real query can START a new chain, never bridge the gap.
                self.empty_since.get_or_insert(at);
                self.last_empty_query_at = Some(at);
                self.empty_polls = self.empty_polls.saturating_add(1);
                if let Some(gap) = gap.filter(|gap| *gap <= NATIVE_QUERY_FRESHNESS) {
                    self.maximum_empty_poll_gap = self.maximum_empty_poll_gap.max(gap);
                }
            }
        }
        Ok(())
    }

    /// Obtain evidence from actual queue bytes, independently of any permit.
    /// Malformed/nonfinite PCM never grants permission to dequeue.
    pub(crate) fn inspect_pcm(queue: &VecDeque<u8>) -> Result<TailPcmEvidence, TailPolicyError> {
        if queue.is_empty() { return Err(TailPolicyError::EmptyQueue); }
        if queue.len() % F32_STEREO_FRAME_BYTES != 0 {
            return Err(TailPolicyError::NotFrameAligned);
        }
        let mut evidence = TailPcmEvidence {
            frames: queue.len() / F32_STEREO_FRAME_BYTES, samples: queue.len() / 4,
            finite: true, all_zero: true, zero_samples: 0, nonzero_samples: 0,
            nonfinite_samples: 0, peak: None,
        };
        let mut bytes = queue.iter().copied();
        while let Some(a) = bytes.next() {
            let value = f32::from_le_bytes([
                a, bytes.next().expect("aligned PCM"), bytes.next().expect("aligned PCM"),
                bytes.next().expect("aligned PCM"),
            ]);
            if value == 0.0 { evidence.zero_samples += 1; }
            else { evidence.nonzero_samples += 1; evidence.all_zero = false; }
            if value.is_finite() {
                evidence.peak = Some(evidence.peak.unwrap_or(0.0).max(value.abs()));
            } else {
                evidence.finite = false;
                evidence.nonfinite_samples += 1;
            }
        }
        Ok(evidence)
    }

    fn check_query_time(&self, now: Instant) -> Result<Instant, TailPolicyError> {
        let last = self.last_empty_query_at.ok_or(TailPolicyError::NoContinuousEmptyQueries)?;
        if now < last { return Err(TailPolicyError::NonmonotonicTime); }
        if now.duration_since(last) > NATIVE_QUERY_FRESHNESS {
            return Err(TailPolicyError::StaleQuery);
        }
        Ok(last)
    }

    pub(crate) fn try_issue(
        &mut self, now: Instant, context: TailQueueContext, queue: &VecDeque<u8>,
    ) -> Result<TailPermit, TailPolicyError> {
        if self.binding != Some(QueueBinding { context, byte_len: queue.len() }) {
            self.cancel_wait();
            self.last_nonempty_at = None;
            return Err(TailPolicyError::QueueChanged);
        }
        let last_query = match self.check_query_time(now) {
            Ok(at) => at,
            Err(error) => { self.cancel_wait(); return Err(error); }
        };
        let last_nonempty_at = self.last_nonempty_at.ok_or(TailPolicyError::NoRealPacket)?;
        let empty_since = self.empty_since.ok_or(TailPolicyError::NoContinuousEmptyQueries)?;
        // Query-to-query evidence, NOT wall-clock time since a frozen snapshot.
        if self.empty_polls < 2 || last_query.duration_since(empty_since) < TAIL_QUIET_CONFIRMATION {
            return Err(TailPolicyError::QuietWindowIncomplete);
        }
        if self.issued_for_query == Some(last_query) {
            return Err(TailPolicyError::AlreadyIssuedForQuery);
        }
        let pcm = Self::inspect_pcm(queue)?;
        if pcm.frames >= self.normal_chunk_frames { return Err(TailPolicyError::NotPartialTail); }
        if !pcm.finite { return Err(TailPolicyError::NonFinitePcm(pcm)); }
        let id = NEXT_PERMIT_ID.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
            |next| next.checked_add(1)).map_err(|_| TailPolicyError::PermitIdsExhausted)?;
        let evidence = TailPermitEvidence {
            context, byte_len: queue.len(), last_nonempty_at, empty_since,
            last_empty_query_at: last_query,
            last_empty_query_id: self.last_native_query_id.expect("real Empty query"),
            empty_polls: self.empty_polls,
            maximum_empty_poll_gap: self.maximum_empty_poll_gap, pcm,
        };
        self.pending = Some(id);
        self.issued_for_query = Some(last_query);
        Ok(TailPermit { id, evidence, exact_bytes: queue.iter().copied().collect() })
    }

    /// The only queue-mutating operation: atomically validate and take EXACTLY
    /// the existing real tail. A failed attempt leaves every queue byte intact
    /// and burns the pending permission. No extra input or padding is produced.
    /// The returned frame count is input length, NOT AEC/dispatch completion.
    pub(crate) fn take_tail(
        &mut self, now: Instant, context: TailQueueContext, queue: &mut VecDeque<u8>,
        permit: &TailPermit,
    ) -> Result<RealCaptureTail, TailPolicyError> {
        let pending = self.pending.take();
        let validation = (|| {
            if pending != Some(permit.id) { return Err(TailPolicyError::PermitInvalidated); }
            let last_query = self.check_query_time(now)?;
            let evidence = permit.evidence;
            let binding = QueueBinding { context, byte_len: queue.len() };
            if self.binding != Some(binding) || context != evidence.context
                || queue.len() != evidence.byte_len
            { return Err(TailPolicyError::QueueChanged); }
            if self.last_nonempty_at != Some(evidence.last_nonempty_at)
                || self.empty_since != Some(evidence.empty_since)
                || last_query != evidence.last_empty_query_at
                || self.last_native_query_id != Some(evidence.last_empty_query_id)
                || self.empty_polls != evidence.empty_polls
            { return Err(TailPolicyError::PermitInvalidated); }
            if !queue.iter().copied().eq(permit.exact_bytes.iter().copied()) {
                return Err(TailPolicyError::ByteContentChanged);
            }
            Ok(evidence)
        })();
        self.cancel_wait();
        let evidence = validation?;
        let pcm = queue.drain(..).collect();
        Ok(RealCaptureTail { pcm, frames: evidence.pcm.frames, evidence })
    }
}

#[cfg(test)]
#[path = "capture_tail_tests.rs"]
mod tests;
