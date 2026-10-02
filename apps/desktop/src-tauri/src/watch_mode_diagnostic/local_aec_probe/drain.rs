use super::super::*;

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
    pub(super) resets: u64,
}
impl CaptureDrain {
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
        Ok(now.saturating_duration_since(since) >= Duration::from_secs(2)
            && route.frames_captured.saturating_sub(self.quiet_start_frames) >= 96_000)
    }
    pub(super) fn receipt(&self, route: &AudioRouteRuntimeSnapshot) -> Value {
        json!({"continuousQuietMs":2000,"minimumQuietCaptureFrames":96000,
            "quietStartFrame":self.quiet_start_frames,"quietEndFrame":route.frames_captured,
            "quietEnergyCeilingDb":-60.0,"activityResets":self.resets,
            "captureRemainedOpen":route.stream_bound,"deadlineIsFailureOnly":true})
    }
}
