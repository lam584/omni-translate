use super::*;
use super::capture_tail::{CaptureTailPolicy, RealCaptureTail, TailObservation, TailPolicyError,
    TailQueueContext, TailPermitEvidence, TailObservationProgress};
use crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence;

/// Single capture-thread owner. Generations advance for real append/dequeue,
/// never for an event wake or an idle read which did not return PCM.
pub(super) struct CaptureTailOwner {
    policy: CaptureTailPolicy,
    generation: u64,
    query_sequence: u64,
    observation_count: u64,
    clock_unchanged_packet_count: u64,
    clock_unchanged_query_count: u64,
}

impl CaptureTailOwner {
    pub(super) fn new(normal_frames: usize) -> Result<Self, String> {
        Ok(Self { policy: CaptureTailPolicy::new(normal_frames).map_err(|e| format!("{e:?}"))?,
            generation: 0, query_sequence: 0, observation_count: 0,
            clock_unchanged_packet_count: 0, clock_unchanged_query_count: 0 })
    }
    pub(super) fn mutated(&mut self) -> Result<(), String> {
        self.generation = self.generation.checked_add(1).ok_or("capture queue generation exhausted")?;
        self.policy.invalidate();
        Ok(())
    }
    fn context(&self, native: &NativeCaptureStartAck) -> TailQueueContext {
        let health = native.health();
        TailQueueContext { generation: self.generation, owner_id: health.owner_id,
            continuity_id: health.aec_reset_generation }
    }
    pub(super) fn observe_packet(&mut self, at: Instant, native: &NativeCaptureStartAck,
        queue: &VecDeque<u8>) -> Result<(), String> {
        let progress = self.policy.observe(at, self.context(native), queue, TailObservation::RealPacket);
        self.finish_observation(progress, true)
    }
    pub(super) fn observe_query(&mut self, at: Instant, native: &NativeCaptureStartAck,
        queue: &VecDeque<u8>, packet_size: Option<u32>) -> Result<(), String> {
        self.query_sequence = self.query_sequence.checked_add(1).ok_or("native query sequence exhausted")?;
        let observation = match packet_size {
            Some(0) => TailObservation::Empty { query_id: self.query_sequence },
            Some(_) => TailObservation::Pending { query_id: self.query_sequence },
            None => TailObservation::Unavailable,
        };
        let progress = self.policy.observe(at, self.context(native), queue, observation);
        self.finish_observation(progress, false)
    }
    pub(super) fn query_failed(&mut self, native: &NativeCaptureStartAck, queue: &VecDeque<u8>) {
        let progress = self.policy.observe(Instant::now(), self.context(native), queue, TailObservation::Error);
        let _ = self.finish_observation(progress, false);
    }
    fn finish_observation(&mut self, progress: Result<TailObservationProgress, TailPolicyError>,
        packet: bool) -> Result<(), String> {
        self.observation_count = self.observation_count.checked_add(1)
            .ok_or("capture tail observation count exhausted")?;
        match progress {
            Ok(TailObservationProgress::Progressed) => Ok(()),
            Ok(TailObservationProgress::ClockUnchanged) => {
                // Continue real capture/AEC/dispatch, but the policy has already
                // revoked every quiet window/permit. No sleep, retry or new clock.
                let count = if packet { &mut self.clock_unchanged_packet_count }
                    else { &mut self.clock_unchanged_query_count };
                *count = count.checked_add(1).ok_or("capture tail unchanged-clock count exhausted")?;
                Ok(())
            }
            Err(error) => {
                let kind = if packet { "packet" } else { "query" };
                Err(format!("capture tail {kind} witness rejected: {error:?}"))
            }
        }
    }
    pub(super) fn clock_receipt(&self, capture_owner_id: u64) -> TailObservationClockReceipt {
        TailObservationClockReceipt { schema_version: 1, clock_domain: "std-instant-native-observation",
            capture_owner_id, observation_count: self.observation_count,
            clock_unchanged_packet_count: self.clock_unchanged_packet_count,
            clock_unchanged_query_count: self.clock_unchanged_query_count,
            nonadvancing_time_never_credits_quiet: true, diagnostic_only: true, quality_acceptance: false }
    }
    pub(super) fn take_ready(&mut self, at: Instant, native: &NativeCaptureStartAck,
        queue: &mut VecDeque<u8>) -> Result<Option<RealCaptureTail>, String> {
        if queue.is_empty() { return Ok(None); }
        let context = self.context(native);
        let permit = match self.policy.try_issue(at, context, queue) {
            Ok(permit) => permit,
            Err(TailPolicyError::QuietWindowIncomplete | TailPolicyError::NoRealPacket
                | TailPolicyError::NoContinuousEmptyQueries | TailPolicyError::StaleQuery
                | TailPolicyError::QueueChanged) => return Ok(None),
            Err(error) => return Err(format!("capture tail permission rejected: {error:?}")),
        };
        let tail = self.policy.take_tail(Instant::now(), context, queue, &permit)
            .map_err(|e| format!("capture tail dequeue rejected: {e:?}"))?;
        self.mutated()?;
        Ok(Some(tail))
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TailObservationClockReceipt {
    schema_version: u32,
    clock_domain: &'static str,
    capture_owner_id: u64,
    observation_count: u64,
    clock_unchanged_packet_count: u64,
    clock_unchanged_query_count: u64,
    nonadvancing_time_never_credits_quiet: bool,
    diagnostic_only: bool,
    quality_acceptance: bool,
}

pub(super) fn tail_receipt(e: &TailPermitEvidence) -> AecCaptureTailEvidence {
    AecCaptureTailEvidence { schema_version: 1, queue_generation: e.context.generation,
        capture_owner_id: e.context.owner_id, capture_reset_generation: e.context.continuity_id,
        byte_len: e.byte_len, last_empty_query_id: e.last_empty_query_id, empty_polls: e.empty_polls,
        quiet_observation_span_ms: e.last_empty_query_at.duration_since(e.empty_since).as_secs_f64() * 1000.0,
        maximum_empty_poll_gap_ms: e.maximum_empty_poll_gap.as_secs_f64() * 1000.0,
        last_nonempty_age_at_last_query_ms: e.last_empty_query_at.duration_since(e.last_nonempty_at).as_secs_f64() * 1000.0,
        all_zero: e.pcm.all_zero, zero_samples: e.pcm.zero_samples, nonzero_samples: e.pcm.nonzero_samples,
        real_frames: e.pcm.frames }
}

#[cfg(test)]
#[path = "capture_tail_owner_tests.rs"]
mod tests;
