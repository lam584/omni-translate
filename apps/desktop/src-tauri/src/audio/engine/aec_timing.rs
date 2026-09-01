use std::sync::OnceLock;

use windows_sys::Win32::System::Performance::{
    QueryPerformanceCounter, QueryPerformanceFrequency,
};

const MAX_DELAY_MS: f64 = 1_000.0;
const SMOOTHING_ALPHA: f64 = 0.2;
const MAX_UPDATE_STEP_MS: f64 = 25.0;
const CLOCK_DISCONTINUITY_TOLERANCE_MS: f64 = 50.0;

#[derive(Debug, Clone, Copy)]
pub(super) struct CaptureClockObservation {
    pub(super) device_frame_index: u64,
    pub(super) packet_qpc_100ns: u64,
    pub(super) observed_qpc_100ns: Option<u64>,
    pub(super) capture_padding_frames: Option<u32>,
    pub(super) capture_buffer_frames: u32,
    /// Age of the most recent observation from the WASAPI render client that
    /// owns physical playback.
    pub(super) render_clock_age_ms: Option<f64>,
    /// Raw frames queued in that same WASAPI render client. Kept for
    /// diagnostics; it includes the current reference frame and therefore is
    /// not itself a render-delay hint.
    pub(super) render_endpoint_padding_frames: Option<u32>,
    /// Frames from `ProcessReverseStream` submission until the first sample of
    /// that same 10 ms reference reaches the endpoint. This excludes the
    /// reference frame itself and is the `(t_render - t_analyze)` term from
    /// WebRTC's stream-delay contract.
    pub(super) render_reference_lead_frames: Option<u32>,
    /// Cumulative frames submitted to that same WASAPI render client. The
    /// estimator uses this position to detect render-session regression.
    pub(super) render_submitted_frames: Option<u64>,
    pub(super) render_discontinuity_count: u64,
    pub(super) data_discontinuity: bool,
    pub(super) timestamp_error: bool,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct AecDelayEstimate {
    pub(super) delay_samples: usize,
    pub(super) delay_ms: f64,
    pub(super) capture_padding_frames: Option<u32>,
    pub(super) capture_padding_invalid: bool,
    pub(super) packet_age_ms: Option<f64>,
    pub(super) render_clock_age_ms: Option<f64>,
    pub(super) render_endpoint_padding_frames: Option<u32>,
    pub(super) render_reference_lead_frames: Option<u32>,
    pub(super) effective_render_reference_lead_frames: Option<u32>,
    pub(super) render_submitted_frames: Option<u64>,
    /// Invalid timing authority always drops the delay smoother, but only a
    /// real stream boundary may destroy AEC3's learned filter.
    pub(super) delay_reset_required: bool,
    pub(super) aec_reset_required: bool,
    pub(super) aec_reset_reason: Option<&'static str>,
    pub(super) published_render_discontinuity: bool,
    pub(super) source: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureClockDiscontinuity {
    Regression,
    Drift,
}

/// External stream-delay estimator for AEC3.
///
/// WASAPI capture supplies a device-frame position and a QPC timestamp for the
/// first captured frame. Their age directly provides `(t_process - t_capture)`;
/// capture padding is diagnostic only because adding it would count buffered
/// time already present in that QPC age a second time. The physical render
/// client contributes its cumulative submit position and same-client
/// `GetCurrentPadding`. Only the frames ahead of the current reference are used
/// for `(t_render - t_analyze)`; observation age decays that real lead.
/// AEC3 retains its internal content-based estimator for the acoustic path.
pub(super) struct AecDelayEstimator {
    sample_rate_hz: u32,
    channel_count: usize,
    smoothed_delay_ms: Option<f64>,
    last_device_frame_index: Option<u64>,
    last_packet_qpc_100ns: Option<u64>,
    last_render_submitted_frames: Option<u64>,
    last_render_discontinuity_count: Option<u64>,
    reset_count: u64,
    timestamp_error_count: u64,
}

impl AecDelayEstimator {
    pub(super) fn new(sample_rate_hz: u32, channel_count: usize) -> Self {
        Self {
            sample_rate_hz,
            channel_count,
            smoothed_delay_ms: None,
            last_device_frame_index: None,
            last_packet_qpc_100ns: None,
            last_render_submitted_frames: None,
            last_render_discontinuity_count: None,
            reset_count: 0,
            timestamp_error_count: 0,
        }
    }

    pub(super) fn observe_capture(
        &mut self,
        observation: CaptureClockObservation,
    ) -> AecDelayEstimate {
        // AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR makes both the device position
        // and QPC timestamp non-authoritative for this packet. Do not compare
        // them with the last good clock or install them as the next baseline.
        let clock_discontinuity = (!observation.timestamp_error)
            .then(|| self.clock_discontinuity(observation))
            .flatten();
        let published_render_discontinuity = self
            .last_render_discontinuity_count
            .is_some_and(|previous| previous != observation.render_discontinuity_count);
        let render_clock_discontinuity =
            published_render_discontinuity || self.render_position_discontinuity(observation);
        let capture_padding_invalid = observation
            .capture_padding_frames
            .is_some_and(|padding| padding > observation.capture_buffer_frames);
        let delay_reset_required = observation.data_discontinuity
            || observation.timestamp_error
            || capture_padding_invalid
            || clock_discontinuity.is_some()
            || render_clock_discontinuity;
        let aec_reset_reason = if observation.data_discontinuity {
            Some("wasapi-capture-data-discontinuity")
        } else if render_clock_discontinuity {
            Some("wasapi-render-session-discontinuity")
        } else if clock_discontinuity == Some(CaptureClockDiscontinuity::Regression) {
            Some("wasapi-capture-clock-regression")
        } else {
            None
        };
        let aec_reset_required = aec_reset_reason.is_some();
        if observation.timestamp_error {
            self.timestamp_error_count = self.timestamp_error_count.saturating_add(1);
        }
        if delay_reset_required {
            self.smoothed_delay_ms = None;
            self.reset_count = self.reset_count.saturating_add(1);
        }

        if !observation.timestamp_error {
            self.last_device_frame_index = Some(observation.device_frame_index);
            self.last_packet_qpc_100ns = Some(observation.packet_qpc_100ns);
        }
        if let Some(submitted) = observation.render_submitted_frames {
            self.last_render_submitted_frames = Some(submitted);
        }
        self.last_render_discontinuity_count = Some(observation.render_discontinuity_count);

        let packet_age_ms = if observation.timestamp_error {
            None
        } else {
            observation.observed_qpc_100ns.map(|observed| {
                observed
                    .saturating_sub(observation.packet_qpc_100ns) as f64
                    / 10_000.0
            })
        };
        let render_clock_age_ms = observation
            .render_clock_age_ms
            .map(|age| age.clamp(0.0, MAX_DELAY_MS));
        let effective_render_reference_lead_frames = observation
            .render_reference_lead_frames
            .map(|frames| {
                let elapsed_frames = render_clock_age_ms
                    .map(|age| age * self.sample_rate_hz as f64 / 1_000.0)
                    .unwrap_or(0.0)
                    .round() as u32;
                frames.saturating_sub(elapsed_frames)
            });
        let render_lead_ms = effective_render_reference_lead_frames
            .map(|frames| frames as f64 * 1_000.0 / self.sample_rate_hz as f64)
            .unwrap_or(0.0);
        let candidate_ms = packet_age_ms
            .map(|age| (age + render_lead_ms).clamp(0.0, MAX_DELAY_MS));
        if let Some(candidate_ms) = candidate_ms {
            self.smoothed_delay_ms = Some(match self.smoothed_delay_ms {
                Some(previous) => {
                    let bounded_delta = (candidate_ms - previous)
                        .clamp(-MAX_UPDATE_STEP_MS, MAX_UPDATE_STEP_MS);
                    (previous + bounded_delta * SMOOTHING_ALPHA).clamp(0.0, MAX_DELAY_MS)
                }
                None => candidate_ms,
            });
        }
        let delay_ms = self.smoothed_delay_ms.unwrap_or(0.0);
        let delay_frames = (delay_ms * self.sample_rate_hz as f64 / 1_000.0).round() as usize;
        AecDelayEstimate {
            delay_samples: delay_frames.saturating_mul(self.channel_count),
            delay_ms,
            capture_padding_frames: observation.capture_padding_frames,
            capture_padding_invalid,
            packet_age_ms,
            render_clock_age_ms,
            render_endpoint_padding_frames: observation.render_endpoint_padding_frames,
            render_reference_lead_frames: observation.render_reference_lead_frames,
            effective_render_reference_lead_frames,
            render_submitted_frames: observation.render_submitted_frames,
            delay_reset_required,
            aec_reset_required,
            aec_reset_reason,
            published_render_discontinuity,
            source: "wasapi-capture-qpc+capture-padding-validated+render-submit-position+same-client-reference-lead",
        }
    }

    pub(super) fn reset_count(&self) -> u64 {
        self.reset_count
    }

    pub(super) fn timestamp_error_count(&self) -> u64 {
        self.timestamp_error_count
    }

    fn clock_discontinuity(
        &self,
        observation: CaptureClockObservation,
    ) -> Option<CaptureClockDiscontinuity> {
        let (Some(previous_index), Some(previous_qpc)) =
            (self.last_device_frame_index, self.last_packet_qpc_100ns)
        else {
            return None;
        };
        if observation.device_frame_index < previous_index
            || observation.packet_qpc_100ns < previous_qpc
        {
            return Some(CaptureClockDiscontinuity::Regression);
        }
        let frame_delta = observation.device_frame_index - previous_index;
        let expected_delta_ms = frame_delta as f64 * 1_000.0 / self.sample_rate_hz as f64;
        let actual_delta_ms =
            (observation.packet_qpc_100ns - previous_qpc) as f64 / 10_000.0;
        ((actual_delta_ms - expected_delta_ms).abs() > CLOCK_DISCONTINUITY_TOLERANCE_MS)
            .then_some(CaptureClockDiscontinuity::Drift)
    }

    fn render_position_discontinuity(&self, observation: CaptureClockObservation) -> bool {
        let Some(current) = observation.render_submitted_frames else {
            return false;
        };
        self.last_render_submitted_frames
            .is_some_and(|previous| current < previous)
            || observation
                .render_endpoint_padding_frames
                .is_some_and(|padding| padding as u64 > current)
    }
}

pub(super) fn qpc_now_100ns() -> Option<u64> {
    static FREQUENCY: OnceLock<Option<i64>> = OnceLock::new();
    let frequency = *FREQUENCY.get_or_init(|| {
        let mut frequency = 0_i64;
        (unsafe { QueryPerformanceFrequency(&mut frequency) } != 0 && frequency > 0)
            .then_some(frequency)
    });
    let frequency = frequency?;
    let mut counter = 0_i64;
    if unsafe { QueryPerformanceCounter(&mut counter) } == 0 || counter < 0 {
        return None;
    }
    let ticks = counter as u128;
    let hundred_ns = ticks.saturating_mul(10_000_000) / frequency as u128;
    u64::try_from(hundred_ns).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(
        index: u64,
        packet_qpc_100ns: u64,
        observed_qpc_100ns: u64,
        padding: u32,
    ) -> CaptureClockObservation {
        CaptureClockObservation {
            device_frame_index: index,
            packet_qpc_100ns,
            observed_qpc_100ns: Some(observed_qpc_100ns),
            capture_padding_frames: Some(padding),
            capture_buffer_frames: 1_920,
            render_clock_age_ms: None,
            render_endpoint_padding_frames: None,
            render_reference_lead_frames: None,
            render_submitted_frames: None,
            render_discontinuity_count: 0,
            data_discontinuity: false,
            timestamp_error: false,
        }
    }

    #[test]
    fn capture_qpc_age_does_not_count_capture_padding_twice() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        // The 30 ms QPC age already spans every frame queued behind this
        // packet. The 20 ms padding is useful diagnostics, not another delay
        // term.
        let estimate = estimator.observe_capture(observation(
            0,
            1_000_000,
            1_300_000,
            960,
        ));

        assert_eq!(estimate.delay_ms, 30.0);
        assert_eq!(estimate.delay_samples, 2_880);
        assert_eq!(estimate.packet_age_ms, Some(30.0));
        assert_eq!(estimate.capture_padding_frames, Some(960));
        assert_eq!(
            estimate.source,
            "wasapi-capture-qpc+capture-padding-validated+render-submit-position+same-client-reference-lead"
        );
        assert!(!estimate.delay_reset_required);
        assert!(!estimate.aec_reset_required);
    }

    #[test]
    fn uses_only_frames_ahead_of_the_current_render_reference() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let mut observed = observation(0, 1_000_000, 1_300_000, 960);
        observed.render_clock_age_ms = Some(5.0);
        // Endpoint padding includes the current 10 ms frame (480 frames), so
        // only the 480 frames preceding it are a render-delay term. Five ms
        // have elapsed since the observation, leaving a 5 ms lead.
        observed.render_endpoint_padding_frames = Some(960);
        observed.render_reference_lead_frames = Some(480);
        observed.render_submitted_frames = Some(4_800);
        let estimate = estimator.observe_capture(observed);

        assert_eq!(estimate.delay_ms, 35.0);
        assert_eq!(estimate.render_clock_age_ms, Some(5.0));
        assert_eq!(estimate.render_endpoint_padding_frames, Some(960));
        assert_eq!(estimate.render_reference_lead_frames, Some(480));
        assert_eq!(
            estimate.effective_render_reference_lead_frames,
            Some(240)
        );
        assert_eq!(estimate.render_submitted_frames, Some(4_800));
    }

    #[test]
    fn actual_zero_eighty_and_one_sixty_ms_prefixes_change_the_aec_delay_hint() {
        for (prefix_frames, expected_delay_ms) in
            [(0, 0.0), (3_840, 80.0), (7_680, 160.0)]
        {
            let mut estimator = AecDelayEstimator::new(48_000, 2);
            let mut observed = observation(0, 1_000_000, 1_000_000, 0);
            observed.render_clock_age_ms = Some(0.0);
            observed.render_endpoint_padding_frames = Some(480);
            // AudioStateStore derives this lead from the same physical prefix
            // that was inserted into the WASAPI render buffer.
            observed.render_reference_lead_frames = Some(prefix_frames);
            observed.render_submitted_frames = Some(480);

            let estimate = estimator.observe_capture(observed);

            assert_eq!(estimate.delay_ms, expected_delay_ms);
            assert_eq!(estimate.delay_samples, prefix_frames as usize * 2);
            assert_eq!(
                estimate.effective_render_reference_lead_frames,
                Some(prefix_frames)
            );
        }
    }

    #[test]
    fn render_submit_regression_requests_reset_without_inventing_padding() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let mut first = observation(0, 1_000_000, 1_100_000, 0);
        first.render_submitted_frames = Some(4_800);
        first.render_endpoint_padding_frames = Some(480);
        first.render_reference_lead_frames = Some(0);
        let _ = estimator.observe_capture(first);

        let mut regressed = observation(480, 1_100_000, 1_200_000, 0);
        regressed.render_submitted_frames = Some(480);
        regressed.render_endpoint_padding_frames = Some(240);
        regressed.render_reference_lead_frames = Some(0);
        let estimate = estimator.observe_capture(regressed);

        assert!(estimate.delay_reset_required);
        assert!(estimate.aec_reset_required);
        assert_eq!(
            estimate.aec_reset_reason,
            Some("wasapi-render-session-discontinuity")
        );
        assert_eq!(estimate.render_submitted_frames, Some(480));
        assert_eq!(estimator.reset_count(), 1);
    }

    #[test]
    fn impossible_capture_padding_is_a_clock_consistency_failure() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let mut invalid = observation(0, 1_000_000, 1_100_000, 1_921);
        invalid.capture_buffer_frames = 1_920;

        let estimate = estimator.observe_capture(invalid);

        assert!(estimate.capture_padding_invalid);
        assert!(estimate.delay_reset_required);
        assert!(!estimate.aec_reset_required);
        // Padding remains visible for diagnostics but is not added to the
        // official WebRTC delay formula.
        assert_eq!(estimate.capture_padding_frames, Some(1_921));
        assert_eq!(estimate.delay_ms, 10.0);
    }

    #[test]
    fn explicit_render_session_discontinuity_resets_delay_smoothing() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let mut first = observation(0, 1_000_000, 1_100_000, 0);
        first.render_discontinuity_count = 4;
        let initial = estimator.observe_capture(first);
        assert!(!initial.delay_reset_required);
        assert!(!initial.aec_reset_required);

        let mut restarted = observation(480, 1_100_000, 1_400_000, 0);
        restarted.render_discontinuity_count = 5;
        let estimate = estimator.observe_capture(restarted);

        assert!(estimate.delay_reset_required);
        assert!(estimate.aec_reset_required);
        assert!(estimate.published_render_discontinuity);
        assert_eq!(
            estimate.aec_reset_reason,
            Some("wasapi-render-session-discontinuity")
        );
        assert_eq!(estimate.delay_ms, 30.0);

        let mut next_observation = observation(960, 1_200_000, 1_500_000, 0);
        next_observation.render_discontinuity_count = 5;
        let next = estimator.observe_capture(next_observation);
        assert!(!next.aec_reset_required);
        assert!(!next.published_render_discontinuity);
    }

    #[test]
    fn delayed_observation_is_bounded_without_resetting_timing_or_aec() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let first = estimator.observe_capture(observation(0, 1_000_000, 1_100_000, 0));
        let second = estimator.observe_capture(observation(
            480,
            1_100_000,
            9_100_000,
            0,
        ));

        assert_eq!(first.delay_ms, 10.0);
        // The packet clock itself advanced by the expected 10 ms; only the
        // worker observed this packet late. Bound the hint without treating a
        // desktop scheduling delay as a device discontinuity.
        assert_eq!(second.delay_ms, 15.0);
        assert!(!second.delay_reset_required);
        assert!(!second.aec_reset_required);
        assert_eq!(second.aec_reset_reason, None);
    }

    #[test]
    fn discontinuity_resets_smoothing_and_requests_aec_reset() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let _ = estimator.observe_capture(observation(48_000, 10_000_000, 10_200_000, 0));
        let mut regressed = observation(0, 1_000_000, 1_100_000, 0);
        regressed.data_discontinuity = true;
        let estimate = estimator.observe_capture(regressed);

        assert!(estimate.delay_reset_required);
        assert!(estimate.aec_reset_required);
        assert_eq!(
            estimate.aec_reset_reason,
            Some("wasapi-capture-data-discontinuity")
        );
        assert_eq!(estimate.delay_ms, 10.0);
        assert_eq!(estimator.reset_count(), 1);
    }

    #[test]
    fn timestamp_error_never_reuses_invalid_qpc_as_a_new_measurement() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let _ = estimator.observe_capture(observation(0, 1_000_000, 1_100_000, 0));
        let mut invalid = observation(480, 0, 100_000_000, 9_600);
        invalid.timestamp_error = true;
        let estimate = estimator.observe_capture(invalid);

        assert!(estimate.delay_reset_required);
        assert!(!estimate.aec_reset_required);
        assert_eq!(estimate.packet_age_ms, None);
        assert_eq!(estimate.delay_ms, 0.0);
        assert_eq!(estimator.timestamp_error_count(), 1);
    }

    #[test]
    fn monotonic_capture_clock_regression_resets_aec_filter() {
        let mut estimator = AecDelayEstimator::new(48_000, 2);
        let _ = estimator.observe_capture(observation(48_000, 10_000_000, 10_200_000, 0));
        let estimate = estimator.observe_capture(observation(47_520, 9_900_000, 10_300_000, 0));

        assert!(estimate.delay_reset_required);
        assert!(estimate.aec_reset_required);
        assert_eq!(
            estimate.aec_reset_reason,
            Some("wasapi-capture-clock-regression")
        );
    }

    #[test]
    fn qpc_clock_is_available_on_supported_windows_runtime() {
        assert!(qpc_now_100ns().is_some());
    }
}
