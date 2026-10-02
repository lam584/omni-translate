use super::super::*;
use crate::audio::state::{NativeCaptureStartAck, NativeCaptureQuery};

/// Completion requires live capture progress over a full two-second window.
/// Neither elapsed wall time on a frozen snapshot nor a deadline is success.
#[derive(Default)]
pub(super) struct CaptureDrain {
    quiet_since: Option<Instant>,
    quiet_start_frames: u64,
    previous_frames: u64,
    previous_segments: u64,
    last_progress: Option<Instant>,
    last_observation: Option<Instant>,
    idle_since: Option<Instant>,
    idle_epoch: Option<u64>,
    idle_start_query: u64,
    idle_start_polls: u64,
    previous_query: u64,
    native_activity: Option<(u64, u64, u64, u64)>,
    pcm_start_query: u64,
    pcm_max_producer_gap: Duration,
    pcm_max_consumer_gap: Duration,
    maximum_consumer_gap: Duration,
    completion_mode: Option<CompletionMode>,
    native_receipt: Option<NativeHealthReceipt>,
    capture_owner_id: Option<u64>,
    failure: Option<String>,
    pub(super) resets: u64,
}
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum CompletionMode { PcmFrames, NativeEmptyPolls }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHealthReceipt {
    successful_query_start: u64,
    successful_query_end: u64,
    empty_poll_count: u64,
    maximum_producer_poll_gap_ms: u64,
    maximum_consumer_observation_gap_ms: u64,
    captured_frames: u64,
    aec_completed_frames: u64,
    dispatch_completed_frames: u64,
    residual_bytes: usize,
    work_pending: bool,
    terminal: bool,
    fault: Option<String>,
    latest_packet: Option<crate::audio::state::NativeCapturePacket>,
    latest_query: NativeCaptureQuery,
    raw_activity_generation: u64,
    last_raw_activity_age_ms: Option<u64>,
    empty_epoch: u64,
    progress_epoch: u64,
    quiescence_epoch: u64,
    aec_reset_generation: u64,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureDrainReceipt<'a> {
    schema_version: u32,
    completion_mode: Option<CompletionMode>,
    capture_owner_id: Option<u64>,
    owner_continuity: bool,
    native_start_acknowledged: bool,
    continuous_quiet_ms: u64,
    minimum_quiet_capture_frames: Option<u64>,
    quiet_start_frame: u64,
    quiet_end_frame: u64,
    quiet_energy_ceiling_db: f32,
    activity_resets: u64,
    capture_remained_open: bool,
    capture_state_at_drain: &'a str,
    deadline_is_failure_only: bool,
    native_health: &'a Option<NativeHealthReceipt>,
}
fn ceil_millis(duration: Duration) -> u64 { duration.as_nanos().div_ceil(1_000_000) as u64 }
impl CaptureDrain {
    fn reset_idle(&mut self) {
        if self.idle_since.take().is_some() { self.resets += 1; }
        self.idle_epoch = None;
        self.maximum_consumer_gap = Duration::ZERO;
    }
    /// Production entry point. The expected activation is retained from Start;
    /// registry membership is checked on EVERY observation, including drain.
    pub(super) fn observe_owned(&mut self, clock: impl FnOnce() -> Instant, route: &AudioRouteRuntimeSnapshot,
        media_complete: bool, stream_drained: bool, expected: &NativeCaptureStartAck,
        current: Option<&NativeCaptureStartAck>) -> Result<bool, String> {
        if let Some(ref error) = self.failure { return Err(error.clone()); }
        let result = self.observe_owned_inner(clock, route, media_complete, stream_drained, expected, current);
        if let Err(ref error) = result { self.failure = Some(error.clone()); }
        result
    }
    fn observe_owned_inner(&mut self, clock: impl FnOnce() -> Instant, route: &AudioRouteRuntimeSnapshot,
        media_complete: bool, stream_drained: bool, expected: &NativeCaptureStartAck,
        current: Option<&NativeCaptureStartAck>) -> Result<bool, String> {
        // StopRequested/Paused controls cannot be bypassed by the in-flight
        // fast path while the native producer hasn't reached terminal yet.
        if route.last_error.is_some() || route.last_error_code.is_some() || !route.stream_bound
            || !matches!(route.capture_state.as_str(), "capturing" | "buffering") {
            return Err("local AEC capture closed, paused, stopping or failed before drain".into());
        }
        let current = current.ok_or("local AEC native capture owner is no longer current")?;
        if !expected.same_owner(current) {
            return Err("local AEC native capture owner changed during drain".into());
        }
        let health = current.health();
        // Sample the consumer clock AFTER the coherent snapshot. A concurrent
        // real publication must not look future-dated and restart quiet.
        let now = clock();
        if health.terminal || health.fault.is_some() {
            return Err(format!("local AEC native capture terminal/fault during drain: {:?}", health.fault));
        }
        let segment_changed = route.segment_count != self.previous_segments
            || route.frames_captured < self.previous_frames;
        if segment_changed { self.reset_idle(); }
        let consumer_gap = self.last_observation.map(|old| now.saturating_duration_since(old));
        let activity = (health.raw_activity_generation, health.progress_epoch,
            health.quiescence_epoch, health.aec_reset_generation);
        if self.native_activity.is_some_and(|old| old != activity) {
            if self.quiet_since.take().is_some() { self.resets += 1; }
            self.reset_idle();
        }
        self.native_activity = Some(activity);
        let fresh = health.started && health.last_query_at.is_some_and(|at|
            at <= now && now.saturating_duration_since(at) <= Duration::from_millis(100));
        if !fresh {
            if self.quiet_since.take().is_some() { self.resets += 1; }
            self.reset_idle();
        }
        if health.work_pending {
            // No completion while real GetBuffer/AEC/dispatch is in flight,
            // even if the previous successful Empty is less than 100ms old.
            if self.idle_epoch != Some(health.empty_epoch) { self.reset_idle(); }
            if consumer_gap.is_some_and(|gap| gap > Duration::from_millis(100)) {
                self.reset_idle();
                if self.quiet_since.take().is_some() { self.resets += 1; }
            }
            if self.quiet_since.is_some() {
                self.pcm_max_consumer_gap = self.pcm_max_consumer_gap.max(consumer_gap.unwrap_or_default());
            }
            if self.idle_since.is_some() {
                self.maximum_consumer_gap = self.maximum_consumer_gap.max(consumer_gap.unwrap_or_default());
            }
            self.last_observation = Some(now);
            return Ok(false);
        }
        let previous_quiet_since = self.quiet_since;
        let pcm_done = self.observe(now, route, media_complete, stream_drained)? && fresh;
        // Both modes need a real completed native query and no unprocessed
        // packet/partial queue. Persistent quiescence_epoch also invalidates
        // a Pending/partial history hidden between consumer observations.
        let drained_native = fresh && health.successful_queries > 0
            && health.query == NativeCaptureQuery::Empty && health.residual_bytes == 0
            && health.captured_frames > 0 && health.captured_frames == health.aec_completed_frames
            && health.captured_frames == health.dispatch_completed_frames
            && health.dispatch_completed_frames == route.frames_captured;
        if !drained_native {
            if self.quiet_since.take().is_some() { self.resets += 1; }
            self.reset_idle(); self.previous_query = health.successful_queries;
            return Ok(false);
        }
        if self.quiet_since != previous_quiet_since || self.pcm_start_query == 0 {
            self.pcm_start_query = health.successful_queries;
            self.pcm_max_producer_gap = Duration::ZERO;
            self.pcm_max_consumer_gap = Duration::ZERO;
        } else if self.quiet_since.is_some() {
            self.pcm_max_producer_gap = self.pcm_max_producer_gap.max(health.last_query_gap.unwrap_or_default());
            self.pcm_max_consumer_gap = self.pcm_max_consumer_gap.max(consumer_gap.unwrap_or_default());
        }
        if pcm_done {
            self.completion_mode = Some(CompletionMode::PcmFrames);
        } else {
            let continuous = self.idle_epoch == Some(health.empty_epoch)
                && !consumer_gap.is_some_and(|gap| gap > Duration::from_millis(100));
            if !continuous { self.reset_idle(); }
            let quiet = fresh && !segment_changed && media_complete && stream_drained
                && health.query == NativeCaptureQuery::Empty && health.empty_since.is_some()
                && health.captured_frames > 0 && health.aec_completed_frames == health.captured_frames
                && health.dispatch_completed_frames == health.captured_frames
                && route.frames_captured == health.dispatch_completed_frames
                && health.residual_bytes == 0 && route.vad_state == "silence"
                && route.active_segment_id.is_none() && route.last_frame_at.is_some()
                && route.last_energy_db.is_finite() && route.last_energy_db <= -60.0;
            if !quiet { self.reset_idle(); self.previous_query = health.successful_queries; return Ok(false); }
            // Re-reading one frozen snapshot is not a new successful poll.
            let new_query = health.successful_queries > self.previous_query;
            self.previous_query = health.successful_queries;
            if !new_query { return Ok(false); }
            let since = *self.idle_since.get_or_insert_with(|| {
                self.idle_epoch = Some(health.empty_epoch);
                self.idle_start_query = health.successful_queries;
                self.idle_start_polls = health.empty_polls;
                self.quiet_start_frames = route.frames_captured;
                now
            });
            if continuous { self.maximum_consumer_gap = self.maximum_consumer_gap.max(consumer_gap.unwrap_or_default()); }
            if now.saturating_duration_since(since) < Duration::from_secs(2)
                || health.empty_since.is_none_or(|at| now.saturating_duration_since(at) < Duration::from_secs(2)) {
                return Ok(false);
            }
            self.completion_mode = Some(CompletionMode::NativeEmptyPolls);
        }
        self.capture_owner_id = Some(health.owner_id);
        self.native_receipt = Some(NativeHealthReceipt {
            successful_query_start: if pcm_done { self.pcm_start_query } else { self.idle_start_query },
            successful_query_end: health.successful_queries,
            empty_poll_count: if pcm_done { 0 } else { health.empty_polls - self.idle_start_polls + 1 },
            maximum_producer_poll_gap_ms: ceil_millis(if pcm_done { self.pcm_max_producer_gap } else { health.maximum_empty_poll_gap }),
            maximum_consumer_observation_gap_ms: ceil_millis(if pcm_done { self.pcm_max_consumer_gap } else { self.maximum_consumer_gap }),
            captured_frames: health.captured_frames, aec_completed_frames: health.aec_completed_frames,
            dispatch_completed_frames: health.dispatch_completed_frames, residual_bytes: health.residual_bytes,
            work_pending: health.work_pending, terminal: health.terminal, fault: health.fault, latest_packet: health.latest_packet,
            latest_query: health.query, raw_activity_generation: health.raw_activity_generation,
            last_raw_activity_age_ms: health.last_raw_activity_at.map(|at| now.saturating_duration_since(at).as_millis() as u64),
            empty_epoch: health.empty_epoch, progress_epoch: health.progress_epoch,
            quiescence_epoch: health.quiescence_epoch, aec_reset_generation: health.aec_reset_generation,
        });
        Ok(true)
    }
    pub(super) fn observe(&mut self, now: Instant, route: &AudioRouteRuntimeSnapshot,
        media_complete: bool, stream_drained: bool) -> Result<bool, String> {
        if route.last_error.is_some() || route.last_error_code.is_some() || !route.stream_bound
            || !matches!(route.capture_state.as_str(), "capturing" | "buffering") {
            return Err("local AEC capture closed or failed before output/capture drain".into());
        }
        // Check the OLD timestamps before an advancing snapshot can refresh
        // last_progress. A blind polling gap or stalled capture must never be
        // counted toward the same continuous two-second quiet window.
        let freshness_limit = Duration::from_millis(100);
        let interrupted = self.last_observation.is_some_and(|t| now.saturating_duration_since(t) > freshness_limit)
            || self.last_progress.is_some_and(|t| now.saturating_duration_since(t) > freshness_limit);
        if interrupted && self.quiet_since.take().is_some() { self.resets += 1; }
        self.last_observation = Some(now);
        let progressed = route.frames_captured > self.previous_frames;
        let gap = route.frames_captured.saturating_sub(self.previous_frames) > 4_800;
        let activity = route.segment_count != self.previous_segments || route.frames_captured < self.previous_frames;
        self.previous_frames = route.frames_captured;
        self.previous_segments = route.segment_count;
        if progressed { self.last_progress = Some(now); }
        let fresh = self.last_progress.is_some_and(|t| now.saturating_duration_since(t) <= freshness_limit);
        let quiet = media_complete && stream_drained && fresh && !gap && !activity
            && route.vad_state == "silence" && route.active_segment_id.is_none()
            && route.last_energy_db.is_finite() && route.last_energy_db <= -60.0
            && route.last_frame_at.is_some();
        if !quiet {
            if self.quiet_since.take().is_some() { self.resets += 1; }
            return Ok(false);
        }
        let since = *self.quiet_since.get_or_insert_with(|| { self.quiet_start_frames = route.frames_captured; now });
        let done = now.saturating_duration_since(since) >= Duration::from_secs(2)
            && route.frames_captured.saturating_sub(self.quiet_start_frames) >= 96_000;
        if done { self.completion_mode = Some(CompletionMode::PcmFrames); }
        Ok(done)
    }
    pub(super) fn receipt(&self, route: &AudioRouteRuntimeSnapshot) -> Value {
        json!(CaptureDrainReceipt {
            schema_version: 2, completion_mode: self.completion_mode,
            capture_owner_id: self.capture_owner_id, owner_continuity: self.capture_owner_id.is_some(),
            native_start_acknowledged: self.native_receipt.is_some(), continuous_quiet_ms: 2000,
            minimum_quiet_capture_frames: match self.completion_mode {
                Some(CompletionMode::PcmFrames) => Some(96_000), _ => None },
            quiet_start_frame: self.quiet_start_frames, quiet_end_frame: route.frames_captured,
            quiet_energy_ceiling_db: -60.0, activity_resets: self.resets,
            capture_remained_open: route.stream_bound, capture_state_at_drain: &route.capture_state, deadline_is_failure_only: true,
            native_health: &self.native_receipt,
        })
    }
}

#[cfg(test)]
#[path = "drain_tests.rs"]
mod idle_tests;
