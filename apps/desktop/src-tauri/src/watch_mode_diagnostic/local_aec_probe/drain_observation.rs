//! Failure-only bounded scalar observation. Never an input to drain acceptance.
use super::*;
use crate::audio::state::NativeCaptureHealthSnapshot;

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum DrainRejection {
    RouteClosedOrFailed, OwnerMissing, OwnerReplaced, NativeTerminalOrFault,
    NativeWorkPending, NativeNotDrained, IdleNotQuiet, NoNewNativeQuery,
    QuietWindowIncomplete,
}
pub(in super::super) struct FailureContext<'a> {
    pub(in super::super) route: &'a AudioRouteRuntimeSnapshot,
    pub(in super::super) media_complete: bool,
    pub(in super::super) stream_drained: bool,
    pub(in super::super) expected: &'a NativeCaptureStartAck,
    pub(in super::super) current: Option<&'a NativeCaptureStartAck>,
    pub(in super::super) failure: &'a str,
    pub(in super::super) source_evidence_failure: Option<&'a str>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnerObservation {
    owner_id: u64, started: bool, terminal: bool, fault: Option<String>,
    latest_query: NativeCaptureQuery, successful_queries: u64,
    last_query_age_ms: Option<u64>, query_clock_in_future: bool,
    last_query_gap_ms: Option<u64>, empty_since_age_ms: Option<u64>,
    empty_polls: u64, maximum_empty_poll_gap_ms: u64,
    captured_frames: u64, aec_completed_frames: u64, dispatch_completed_frames: u64,
    residual_bytes: usize, work_pending: bool,
    raw_activity_generation: u64, last_raw_activity_age_ms: Option<u64>,
    latest_packet: Option<crate::audio::state::NativeCapturePacket>,
    empty_epoch: u64, progress_epoch: u64, quiescence_epoch: u64, aec_reset_generation: u64,
}
fn age(now: Instant, then: Option<Instant>) -> Option<u64> {
    then.map(|then| now.saturating_duration_since(then).as_millis() as u64)
}
impl OwnerObservation {
    fn from_health(h: NativeCaptureHealthSnapshot, now: Instant) -> Self {
        Self {
            owner_id: h.owner_id, started: h.started, terminal: h.terminal, fault: h.fault,
            latest_query: h.query, successful_queries: h.successful_queries,
            last_query_age_ms: age(now,h.last_query_at), query_clock_in_future: h.last_query_at.is_some_and(|t| t > now),
            last_query_gap_ms: h.last_query_gap.map(ceil_millis), empty_since_age_ms: age(now,h.empty_since),
            empty_polls: h.empty_polls, maximum_empty_poll_gap_ms: ceil_millis(h.maximum_empty_poll_gap),
            captured_frames: h.captured_frames, aec_completed_frames: h.aec_completed_frames,
            dispatch_completed_frames: h.dispatch_completed_frames, residual_bytes: h.residual_bytes,
            work_pending: h.work_pending, raw_activity_generation: h.raw_activity_generation,
            last_raw_activity_age_ms: age(now,h.last_raw_activity_at), latest_packet: h.latest_packet,
            empty_epoch: h.empty_epoch, progress_epoch: h.progress_epoch,
            quiescence_epoch: h.quiescence_epoch, aec_reset_generation: h.aec_reset_generation,
        }
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteObservation<'a> {
    frames_captured: u64, segment_count: u64, stream_bound: bool,
    capture_state: &'a str, vad_state: &'a str, last_energy_db: f32,
    active_segment_id: &'a Option<String>, last_frame_at: &'a Option<String>,
    last_error: &'a Option<String>, last_error_code: &'a Option<String>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DrainObservation<'a> {
    last_rejection: Option<DrainRejection>, sticky_failure: &'a Option<String>,
    last_observation_age_ms: Option<u64>, latest_consumer_gap_ms: Option<u64>,
    last_progress_age_ms: Option<u64>, pcm_quiet_age_ms: Option<u64>,
    native_idle_quiet_age_ms: Option<u64>, quiet_start_frame: u64,
    previous_frames: u64, previous_segments: u64, previous_successful_query: u64,
    observed_native_activity: Option<(u64,u64,u64,u64)>, idle_epoch: Option<u64>,
    activity_resets: u64,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FailureObservation<'a> {
    schema_version: u32, artifact_kind: &'static str, diagnostic_only: bool, accepted: bool,
    captured_before_forced_cleanup: bool, observed_at_ms: u64,
    failure: &'a str, source_evidence_failure: Option<&'a str>, source_validation_state: &'static str,
    expected_owner: OwnerObservation, current_owner: Option<OwnerObservation>,
    owner_continuity: bool, media_complete: bool, stream_drained: bool,
    route: RouteObservation<'a>, drain: DrainObservation<'a>,
}
impl CaptureDrain {
    /// Called once after the running loop has returned, BEFORE abort/Stop/join.
    /// It cannot set completion_mode, native_receipt, clocks, counters or quiet.
    pub(in super::super) fn failure_observation(&self, clock: impl FnOnce() -> Instant,
        c: FailureContext<'_>) -> Value {
        let expected = c.expected.health();
        let current = c.current.map(|owner| if c.expected.same_owner(owner) {
            expected.clone()
        } else { owner.health() });
        let now = clock();
        let r = c.route;
        json!(FailureObservation {
            schema_version: 1, artifact_kind: "local-aec-capture-drain-failure-observation",
            diagnostic_only: true, accepted: false, captured_before_forced_cleanup: true,
            observed_at_ms: crate::shared::time::now_unix_millis(),
            failure: c.failure, source_evidence_failure: c.source_evidence_failure,
            source_validation_state: if c.source_evidence_failure.is_some() { "rejected" }
                else if c.media_complete { "accepted" } else { "not-yet-consumed" },
            owner_continuity: c.current.is_some_and(|owner| c.expected.same_owner(owner)),
            expected_owner: OwnerObservation::from_health(expected,now),
            current_owner: current.map(|h| OwnerObservation::from_health(h,now)),
            media_complete: c.media_complete, stream_drained: c.stream_drained,
            route: RouteObservation {
                frames_captured:r.frames_captured, segment_count:r.segment_count, stream_bound:r.stream_bound,
                capture_state:&r.capture_state, vad_state:&r.vad_state, last_energy_db:r.last_energy_db,
                active_segment_id:&r.active_segment_id, last_frame_at:&r.last_frame_at,
                last_error:&r.last_error, last_error_code:&r.last_error_code,
            },
            drain: DrainObservation {
                last_rejection:self.last_rejection, sticky_failure:&self.failure,
                last_observation_age_ms:age(now,self.last_observation),
                latest_consumer_gap_ms:self.latest_consumer_gap.map(ceil_millis),
                last_progress_age_ms:age(now,self.last_progress), pcm_quiet_age_ms:age(now,self.quiet_since),
                native_idle_quiet_age_ms:age(now,self.idle_since), quiet_start_frame:self.quiet_start_frames,
                previous_frames:self.previous_frames, previous_segments:self.previous_segments,
                previous_successful_query:self.previous_query, observed_native_activity:self.native_activity,
                idle_epoch:self.idle_epoch, activity_resets:self.resets,
            },
        })
    }
}
