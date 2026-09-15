use std::collections::VecDeque;

const CHANNELS: usize = 2;
const FRAME_FRAMES: usize = 480;
const FRAME_SAMPLES: usize = FRAME_FRAMES * CHANNELS;
const MIN_RATE_RATIO: f64 = 0.995;
const MAX_RATE_RATIO: f64 = 1.005;
const MIN_RATE_OBSERVATION_FRAMES: u64 = 4_800;
const MAX_BUFFERED_FRAMES: usize = 48_000 * 5;

/// Converts physically committed render-reference samples into capture-clock
/// paced 10 ms frames. Whole render blocks are never dropped or duplicated:
/// consumption advances by a persistent fractional source position.
#[derive(Default)]
pub(crate) struct CaptureClockReferenceMatcher {
    epoch: Option<u64>,
    samples: VecDeque<f32>,
    source_position_frames: f64,
    render_rate_hz: Option<f64>,
    capture_rate_hz: Option<f64>,
    last_render: Option<(u64, u64)>,
    last_capture: Option<(u64, u64, u64)>,
}

impl CaptureClockReferenceMatcher {
    pub(crate) fn clear_for_epoch(&mut self, epoch: u64) {
        self.epoch = Some(epoch);
        self.samples.clear();
        self.source_position_frames = 0.0;
        self.last_render = None;
        self.last_capture = None;
        self.render_rate_hz = None;
        self.capture_rate_hz = None;
    }

    pub(crate) fn discard_buffered(&mut self) {
        self.samples.clear();
        self.source_position_frames = 0.0;
        self.last_render = None;
        self.last_capture = None;
        self.render_rate_hz = None;
        self.capture_rate_hz = None;
    }
    pub(crate) fn enqueue_committed(
        &mut self,
        epoch: u64,
        reference_end_frame: u64,
        qpc_100ns: Option<u64>,
        samples: &[f32],
    ) -> Result<(), String> {
        if samples.len() != FRAME_SAMPLES {
            return Err(
                "capture-clock reference matcher requires one committed 10 ms stereo frame".into(),
            );
        }
        if self.epoch != Some(epoch) {
            self.clear_for_epoch(epoch);
        }
        if let Some(qpc) = qpc_100ns {
            observe_rate(
                &mut self.last_render,
                reference_end_frame,
                qpc,
                &mut self.render_rate_hz,
            );
        }
        if self.samples.len() / CHANNELS + FRAME_FRAMES > MAX_BUFFERED_FRAMES {
            return Err("capture-clock reference matcher buffer is full".into());
        }
        self.samples.extend(samples.iter().copied());
        Ok(())
    }

    pub(crate) fn observe_capture_clock(
        &mut self,
        epoch: u64,
        continuity_id: u64,
        device_frame: u64,
        qpc_100ns: u64,
        valid: bool,
    ) {
        if self.epoch != Some(epoch) {
            self.clear_for_epoch(epoch);
        }
        if !valid {
            return;
        }
        match self.last_capture {
            Some((previous_continuity, _, _)) if previous_continuity == continuity_id => {
                let mut anchor = self.last_capture.map(|(_, frame, qpc)| (frame, qpc));
                observe_rate(
                    &mut anchor,
                    device_frame,
                    qpc_100ns,
                    &mut self.capture_rate_hz,
                );
                self.last_capture = anchor.map(|(frame, qpc)| (continuity_id, frame, qpc));
            }
            _ => self.last_capture = Some((continuity_id, device_frame, qpc_100ns)),
        }
    }

    pub(crate) fn take_10ms(&mut self, epoch: u64) -> Option<Vec<f32>> {
        if self.epoch != Some(epoch) {
            return None;
        }
        let ratio = match (self.render_rate_hz, self.capture_rate_hz) {
            (Some(render), Some(capture)) if capture > 0.0 => {
                (render / capture).clamp(MIN_RATE_RATIO, MAX_RATE_RATIO)
            }
            _ => 1.0,
        };
        let required_last = self.source_position_frames + ratio * (FRAME_FRAMES - 1) as f64;
        let available_frames = self.samples.len() / CHANNELS;
        if required_last.floor() as usize + 1 >= available_frames {
            return None;
        }
        let mut output = Vec::with_capacity(FRAME_SAMPLES);
        for output_frame in 0..FRAME_FRAMES {
            let position = self.source_position_frames + ratio * output_frame as f64;
            let left = position.floor() as usize;
            let fraction = position - left as f64;
            for channel in 0..CHANNELS {
                let a = self.samples[left * CHANNELS + channel];
                let b = self.samples[(left + 1) * CHANNELS + channel];
                output.push(a + (b - a) * fraction as f32);
            }
        }
        self.source_position_frames += ratio * FRAME_FRAMES as f64;
        let consumed = self.source_position_frames.floor() as usize;
        for _ in 0..consumed * CHANNELS {
            let _ = self.samples.pop_front();
        }
        self.source_position_frames -= consumed as f64;
        Some(output)
    }

    #[cfg(test)]
    fn buffered_frames(&self) -> usize {
        self.samples.len() / CHANNELS
    }

    #[cfg(test)]
    fn rate_ratio(&self) -> Option<f64> {
        Some((self.render_rate_hz? / self.capture_rate_hz?).clamp(MIN_RATE_RATIO, MAX_RATE_RATIO))
    }
}

fn observe_rate(
    anchor: &mut Option<(u64, u64)>,
    frame: u64,
    qpc_100ns: u64,
    rate_hz: &mut Option<f64>,
) {
    let Some((anchor_frame, anchor_qpc)) = *anchor else {
        *anchor = Some((frame, qpc_100ns));
        return;
    };
    let Some(frames) = frame.checked_sub(anchor_frame) else {
        *anchor = Some((frame, qpc_100ns));
        return;
    };
    let Some(ticks) = qpc_100ns.checked_sub(anchor_qpc) else {
        *anchor = Some((frame, qpc_100ns));
        return;
    };
    if frames < MIN_RATE_OBSERVATION_FRAMES {
        return;
    }
    if ticks == 0 {
        *anchor = Some((frame, qpc_100ns));
        return;
    }
    let observed_rate = frames as f64 * 10_000_000.0 / ticks as f64;
    if (47_000.0..=49_000.0).contains(&observed_rate) {
        *rate_hz = Some(observed_rate);
    }
    // A complete window is bounded even when implausible, so one bad interval
    // cannot remain the permanent basis for later observations.
    *anchor = Some((frame, qpc_100ns));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(start: u64) -> Vec<f32> {
        (0..FRAME_FRAMES)
            .flat_map(|i| {
                let value = (start + i as u64) as f32;
                [value, -value]
            })
            .collect()
    }

    #[test]
    fn zero_drift_is_identity_and_never_reads_future_reference() {
        let mut matcher = CaptureClockReferenceMatcher::default();
        matcher
            .enqueue_committed(7, 480, Some(100_000), &frame(0))
            .unwrap();
        assert!(matcher.take_10ms(7).is_none());
        matcher
            .enqueue_committed(7, 960, Some(200_000), &frame(480))
            .unwrap();
        matcher.observe_capture_clock(7, 3, 480, 100_000, true);
        matcher.observe_capture_clock(7, 3, 960, 200_000, true);
        let output = matcher.take_10ms(7).unwrap();
        assert_eq!(output, frame(0));
        assert_eq!(matcher.buffered_frames(), 480);
    }

    #[test]
    fn measured_drift_uses_fractional_monotonic_positions_without_block_drop_or_duplicate() {
        let mut matcher = CaptureClockReferenceMatcher::default();
        let render_qpc = |index: u64| {
            Some(100_000 + ((index + 1) as f64 * 480.0 / 47_941.46 * 10_000_000.0) as u64)
        };
        for index in 0..12_u64 {
            matcher
                .enqueue_committed(1, (index + 1) * 480, render_qpc(index), &frame(index * 480))
                .unwrap();
        }
        for index in 0..=100_u64 {
            let qpc = 100_000 + (index as f64 * 480.0 / 48_003.76 * 10_000_000.0) as u64;
            matcher.observe_capture_clock(1, 9, index * 480, qpc, true);
        }
        let expected_ratio = 47_941.46 / 48_003.76;
        assert!((matcher.rate_ratio().unwrap() - expected_ratio).abs() < 0.000_01);
        let mut prior = -1.0_f32;
        for index in 12..12_612_u64 {
            matcher
                .enqueue_committed(1, (index + 1) * 480, render_qpc(index), &frame(index * 480))
                .unwrap();
            let output = matcher.take_10ms(1).unwrap();
            for value in output.chunks_exact(2).map(|pair| pair[0]) {
                assert!(
                    value > prior,
                    "source position must remain strictly monotonic"
                );
                prior = value;
            }
        }
        assert!(
            prior < 12_600.0 * 480.0,
            "slower render clock must not consume a future reference"
        );
        assert!(matcher.buffered_frames() < 30 * FRAME_FRAMES);
    }

    #[test]
    fn reverse_drift_remains_monotonic_without_repeating_a_block() {
        let mut matcher = CaptureClockReferenceMatcher::default();
        let render_qpc = |index: u64| {
            Some(100_000 + ((index + 1) as f64 * 480.0 / 48_060.0 * 10_000_000.0) as u64)
        };
        for index in 0..12_u64 {
            matcher
                .enqueue_committed(3, (index + 1) * 480, render_qpc(index), &frame(index * 480))
                .unwrap();
        }
        matcher.observe_capture_clock(3, 4, 0, 100_000, true);
        matcher.observe_capture_clock(3, 4, 48_000, 10_100_000, true);
        let expected_ratio = 48_060.0 / 48_000.0;
        assert!((matcher.rate_ratio().unwrap() - expected_ratio).abs() < 0.000_01);
        let mut prior = -1.0_f32;
        for index in 12..512_u64 {
            matcher
                .enqueue_committed(3, (index + 1) * 480, render_qpc(index), &frame(index * 480))
                .unwrap();
            for value in matcher
                .take_10ms(3)
                .unwrap()
                .chunks_exact(2)
                .map(|pair| pair[0])
            {
                assert!(value > prior);
                prior = value;
            }
        }
        assert!(prior > 500.0 * 480.0);
    }

    #[test]
    fn short_scheduler_jitter_cannot_replace_the_long_rate_observation() {
        let mut matcher = CaptureClockReferenceMatcher::default();
        matcher
            .enqueue_committed(5, 480, Some(100_000), &frame(0))
            .unwrap();
        matcher
            .enqueue_committed(5, 960, Some(205_000), &frame(480))
            .unwrap();
        matcher.observe_capture_clock(5, 2, 0, 100_000, true);
        matcher.observe_capture_clock(5, 2, 480, 195_000, true);
        assert_eq!(matcher.take_10ms(5).unwrap(), frame(0));
    }

    #[test]
    fn consumer_scheduling_delay_cannot_change_the_producer_clock_ratio() {
        fn observed_ratio(delay: std::time::Duration) -> f64 {
            let mut matcher = CaptureClockReferenceMatcher::default();
            matcher
                .enqueue_committed(8, 480, Some(100_000), &frame(0))
                .unwrap();
            std::thread::sleep(delay);
            matcher
                .enqueue_committed(8, 5_280, Some(1_101_220), &frame(480))
                .unwrap();
            matcher.observe_capture_clock(8, 1, 0, 100_000, true);
            std::thread::sleep(delay);
            matcher.observe_capture_clock(8, 1, 4_800, 1_100_000, true);
            matcher.rate_ratio().unwrap()
        }

        let immediate = observed_ratio(std::time::Duration::ZERO);
        let delayed = observed_ratio(std::time::Duration::from_millis(5));
        assert_eq!(delayed, immediate);
    }

    #[test]
    fn epoch_reset_requires_fresh_complete_rate_observations() {
        let mut matcher = CaptureClockReferenceMatcher::default();
        matcher
            .enqueue_committed(10, 480, Some(100_000), &frame(0))
            .unwrap();
        matcher
            .enqueue_committed(10, 5_280, Some(1_101_220), &frame(480))
            .unwrap();
        matcher.observe_capture_clock(10, 2, 0, 100_000, true);
        matcher.observe_capture_clock(10, 2, 4_800, 1_100_000, true);
        assert!(matcher.rate_ratio().is_some());

        matcher.clear_for_epoch(11);
        assert_eq!(matcher.rate_ratio(), None);
        matcher
            .enqueue_committed(11, 480, Some(2_000_000), &frame(10_000))
            .unwrap();
        matcher
            .enqueue_committed(11, 960, Some(2_100_122), &frame(10_480))
            .unwrap();
        matcher.observe_capture_clock(11, 3, 0, 2_000_000, true);
        matcher.observe_capture_clock(11, 3, 480, 2_100_000, true);
        assert_eq!(matcher.rate_ratio(), None);

        matcher
            .enqueue_committed(11, 5_280, Some(3_001_220), &frame(10_960))
            .unwrap();
        matcher.observe_capture_clock(11, 3, 4_800, 3_000_000, true);
        assert!(matcher.rate_ratio().is_some());
    }

    #[test]
    fn discontinuity_discards_old_epoch_and_never_interpolates_across_it() {
        let mut matcher = CaptureClockReferenceMatcher::default();
        matcher
            .enqueue_committed(1, 480, Some(100_000), &frame(0))
            .unwrap();
        matcher
            .enqueue_committed(2, 480, Some(200_000), &frame(10_000))
            .unwrap();
        assert!(matcher.take_10ms(1).is_none());
        assert!(matcher.take_10ms(2).is_none());
        matcher
            .enqueue_committed(2, 960, Some(300_000), &frame(10_480))
            .unwrap();
        let output = matcher.take_10ms(2).unwrap();
        assert_eq!(output[0], 10_000.0);
    }

    #[test]
    fn invalid_capture_clock_does_not_install_a_rate() {
        let mut matcher = CaptureClockReferenceMatcher::default();
        matcher
            .enqueue_committed(4, 480, Some(100_000), &frame(0))
            .unwrap();
        matcher
            .enqueue_committed(4, 960, Some(200_130), &frame(480))
            .unwrap();
        matcher.observe_capture_clock(4, 1, 0, 100_000, true);
        matcher.observe_capture_clock(4, 1, 480, 100_001, false);
        let output = matcher.take_10ms(4).unwrap();
        assert_eq!(output, frame(0));
    }
}
