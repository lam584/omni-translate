use std::collections::VecDeque;
use std::time::Instant;

const TARGET_SAMPLE_RATE_HZ: u32 = 48_000;
const TARGET_CHANNEL_COUNT: usize = 2;
/// Upper bound for the per-block least-squares gain estimate. WASAPI loopback
/// normally carries our render stream close to unity, while speaker/mixer
/// gain can move it in either direction. Bounding the estimate prevents an
/// unrelated source block from producing an unstable subtraction gain.
const MAX_ECHO_PATH_GAIN: f32 = 2.0;
/// RMS above which the playback-aligned reference block counts as active TTS
/// output rather than silence between segments.
const REFERENCE_ACTIVE_RMS: f32 = 0.01;
/// A block is safe to drop only when adaptive subtraction leaves no audible
/// non-reference signal. This is deliberately absolute: in Watch mode the
/// source video is often 10-20 dB quieter than translated playback, so a
/// captured/reference energy ratio cannot distinguish source audio from echo.
const PURE_ECHO_RESIDUAL_RMS: f32 = 0.003;
const PURE_ECHO_CORRELATION: f32 = 0.8;
/// Acoustic speaker bleed can leave delayed reflections after the direct-path
/// projection. If the residual is still predictable from a recent render
/// reference, it remains echo rather than valid double talk.
const ECHO_TAIL_CORRELATION: f32 = 0.35;
const ECHO_TAIL_MAX_LAG_MS: usize = 50;
const ECHO_TAIL_LAG_STEP_MS: usize = 1;
/// WASAPI render startup and loopback delivery latency varies by endpoint and
/// can change when a Bluetooth/USB device wakes up. Search a bounded window
/// instead of assuming every device matches the nominal 100 ms route delay.
const ADAPTIVE_DELAY_MAX_MS: usize = 300;
const ADAPTIVE_DELAY_COARSE_STEP_MS: usize = 5;
const ADAPTIVE_DELAY_FINE_RADIUS_MS: usize = 6;
const ADAPTIVE_DELAY_FINE_STEP_MS: usize = 1;
/// Correlation scoring samples one channel every four frames. The selected
/// alignment is still subtracted at full resolution.
const ALIGNMENT_SCORE_FRAME_STRIDE: usize = 4;
/// Below this correlation, projection is more likely to carve unrelated
/// program audio than to remove translated playback.
const MIN_ECHO_ALIGNMENT_CORRELATION: f32 = 0.2;
/// Residual gain applied while TTS is audibly playing and no double talk is
/// detected: half-duplex energy suppression layered on top of the linear
/// subtraction, because a fixed 0.8 attenuation alone cannot match the real
/// acoustic path gain.
const PLAYBACK_GATE_GAIN: f32 = 0.1;

pub(crate) struct EchoCancellationResult {
    pub(crate) samples: Vec<f32>,
    /// True when the aligned playback reference is active and the captured
    /// block is dominated by that playback. The capture worker must not send
    /// such a block to ASR: the Omni pump intentionally forwards a short
    /// silence tail, so merely reducing the samples would still feed the
    /// translated speaker output back to the model.
    pub(crate) suppress_asr: bool,
}

#[derive(Debug, Clone, Copy)]
struct EchoAlignment {
    delay_samples: usize,
    block_start: usize,
    correlation: f32,
}

/// Time-aligned reference of what the speaker is actually playing.
///
/// Callers may push a whole TTS segment before its blocking playback starts;
/// the buffer keeps its own playback clock (`play_cursor`) that advances with
/// wall time, so `subtract_from` always reads the reference block that was
/// audible when the captured chunk was recorded instead of assuming the
/// buffer tail is "now".
pub(crate) struct EchoReferenceBuffer {
    buffer: VecDeque<f32>,
    capacity: usize,
    /// Interleaved samples of `buffer` the playback clock has consumed.
    play_cursor: f64,
    last_advance: Option<Instant>,
}

impl EchoReferenceBuffer {
    pub(crate) fn new(capacity_frames: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(capacity_frames * TARGET_CHANNEL_COUNT),
            capacity: capacity_frames * TARGET_CHANNEL_COUNT,
            play_cursor: 0.0,
            last_advance: None,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Current reference depth in interleaved samples, surfaced by the
    /// periodic echo-cancel diagnostics summary.
    pub(crate) fn depth_samples(&self) -> usize {
        self.buffer.len()
    }

    pub(crate) fn push_samples(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
    ) {
        self.push_samples_at(samples, sample_rate_hz, channel_count, Instant::now());
    }

    pub(crate) fn push_samples_at(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        now: Instant,
    ) {
        self.advance_play_cursor(now);
        // A new segment starts playing when it is pushed; if the clock ran
        // into the silence past the previous segment, snap it back to the end
        // of the buffered audio so the appended samples align with "now".
        self.play_cursor = self.play_cursor.min(self.buffer.len() as f64);
        if samples.is_empty() || sample_rate_hz == 0 || channel_count == 0 {
            return;
        }

        let channel_count = channel_count as usize;
        let input_frames = samples.len() / channel_count;
        if input_frames == 0 {
            return;
        }

        let output_frames = ((input_frames as u64 * TARGET_SAMPLE_RATE_HZ as u64)
            / sample_rate_hz as u64)
            .max(1) as usize;
        let ratio = sample_rate_hz as f32 / TARGET_SAMPLE_RATE_HZ as f32;

        for output_frame in 0..output_frames {
            let source_pos = output_frame as f32 * ratio;
            let left_index = source_pos.floor() as usize;
            let right_index = (left_index + 1).min(input_frames - 1);
            let frac = source_pos - left_index as f32;

            let (left, right) = if channel_count == 1 {
                let sample = lerp(samples[left_index], samples[right_index], frac);
                (sample, sample)
            } else {
                let left_a = samples[left_index * channel_count];
                let left_b = samples[right_index * channel_count];
                let right_a = samples[left_index * channel_count + 1];
                let right_b = samples[right_index * channel_count + 1];
                (lerp(left_a, left_b, frac), lerp(right_a, right_b, frac))
            };

            self.push_sample(left);
            self.push_sample(right);
        }
    }

    pub(crate) fn subtract_from(
        &mut self,
        captured: &[f32],
        delay_samples: usize,
    ) -> EchoCancellationResult {
        self.subtract_from_at(captured, delay_samples, Instant::now())
    }

    pub(crate) fn subtract_from_at(
        &mut self,
        captured: &[f32],
        delay_samples: usize,
        now: Instant,
    ) -> EchoCancellationResult {
        self.advance_play_cursor(now);
        if captured.is_empty() || self.buffer.is_empty() {
            return EchoCancellationResult {
                samples: captured.to_vec(),
                suppress_asr: false,
            };
        }

        // Align the playback position to a frame boundary so stereo channels
        // stay paired, then find the reference block that best matches this
        // capture. `delay_samples` remains the preferred/nominal route delay,
        // but real endpoint latency is allowed to move within a bounded window.
        let cursor = (self.play_cursor as usize / TARGET_CHANNEL_COUNT) * TARGET_CHANNEL_COUNT;
        let Some(alignment) = self.best_echo_alignment(captured, cursor, delay_samples) else {
            return EchoCancellationResult {
                samples: captured.to_vec(),
                suppress_asr: false,
            };
        };
        let block_start = alignment.block_start as i64;

        let mut reference_energy = 0.0_f32;
        let mut captured_energy = 0.0_f32;
        let mut cross_energy = 0.0_f32;
        let reference: Vec<f32> = captured
            .iter()
            .enumerate()
            .map(|(index, sample)| {
                let position = block_start + index as i64;
                let reference = if position >= 0 && (position as usize) < self.buffer.len() {
                    self.buffer[position as usize]
                } else {
                    0.0
                };
                reference_energy += reference * reference;
                captured_energy += sample * sample;
                cross_energy += sample * reference;
                reference
            })
            .collect();

        // Estimate the actual render-to-capture gain for this block rather
        // than subtracting a fixed 0.8. In system-loopback Watch mode the
        // captured stream is `video + our translated playback`; least-squares
        // projection removes the latter while retaining the unrelated video.
        let echo_path_gain = if reference_energy > f32::EPSILON
            && alignment.correlation >= MIN_ECHO_ALIGNMENT_CORRELATION
        {
            (cross_energy / reference_energy).clamp(0.0, MAX_ECHO_PATH_GAIN)
        } else {
            0.0
        };
        let mut cleaned: Vec<f32> = captured
            .iter()
            .zip(reference.iter())
            .map(|(sample, reference)| {
                (sample - reference * echo_path_gain).clamp(-1.0, 1.0)
            })
            .collect();

        // Never use captured/reference loudness as a half-duplex gate: a quiet
        // movie under louder translated speech is valid double talk. Drop a
        // block only when it is strongly correlated with our render reference
        // AND adaptive subtraction leaves an inaudible residual.
        let block_len = captured.len() as f32;
        let reference_rms = (reference_energy / block_len).sqrt();
        let captured_rms = (captured_energy / block_len).sqrt();
        let residual_rms = (cleaned.iter().map(|sample| sample * sample).sum::<f32>()
            / block_len)
            .sqrt();
        let correlation_denominator = (reference_energy * captured_energy).sqrt();
        let correlation = if correlation_denominator > f32::EPSILON {
            (cross_energy.abs() / correlation_denominator).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let residual_energy = residual_rms * residual_rms * block_len;
        let mut max_tail_correlation = 0.0_f32;
        if residual_energy > f32::EPSILON {
            let samples_per_ms = TARGET_SAMPLE_RATE_HZ as usize
                * TARGET_CHANNEL_COUNT
                / 1_000;
            for lag_ms in
                (ECHO_TAIL_LAG_STEP_MS..=ECHO_TAIL_MAX_LAG_MS)
                    .step_by(ECHO_TAIL_LAG_STEP_MS)
            {
                let lag_samples = lag_ms * samples_per_ms;
                let mut delayed_energy = 0.0_f32;
                let mut residual_cross = 0.0_f32;
                for (index, residual) in cleaned.iter().enumerate() {
                    let position = block_start + index as i64 - lag_samples as i64;
                    let delayed_reference = if position >= 0
                        && (position as usize) < self.buffer.len()
                    {
                        self.buffer[position as usize]
                    } else {
                        0.0
                    };
                    delayed_energy += delayed_reference * delayed_reference;
                    residual_cross += residual * delayed_reference;
                }
                let denominator = (residual_energy * delayed_energy).sqrt();
                if denominator > f32::EPSILON {
                    max_tail_correlation = max_tail_correlation
                        .max((residual_cross.abs() / denominator).clamp(0.0, 1.0));
                }
            }
        }
        let suppress_asr = reference_rms > REFERENCE_ACTIVE_RMS
            && captured_rms > f32::EPSILON
            && correlation >= PURE_ECHO_CORRELATION
            && (residual_rms < PURE_ECHO_RESIDUAL_RMS
                || max_tail_correlation >= ECHO_TAIL_CORRELATION);
        if suppress_asr {
            for sample in cleaned.iter_mut() {
                *sample *= PLAYBACK_GATE_GAIN;
            }
        }
        EchoCancellationResult {
            samples: cleaned,
            suppress_asr,
        }
    }

    fn best_echo_alignment(
        &self,
        captured: &[f32],
        cursor: usize,
        preferred_delay_samples: usize,
    ) -> Option<EchoAlignment> {
        let samples_per_ms =
            TARGET_SAMPLE_RATE_HZ as usize * TARGET_CHANNEL_COUNT / 1_000;
        let coarse_step =
            (ADAPTIVE_DELAY_COARSE_STEP_MS * samples_per_ms).max(TARGET_CHANNEL_COUNT);
        let max_delay = (ADAPTIVE_DELAY_MAX_MS * samples_per_ms)
            .max(preferred_delay_samples.saturating_add(coarse_step));
        let mut best = None;

        for delay in (0..=max_delay).step_by(coarse_step) {
            self.consider_echo_alignment(captured, cursor, delay, preferred_delay_samples, &mut best);
        }
        self.consider_echo_alignment(
            captured,
            cursor,
            preferred_delay_samples,
            preferred_delay_samples,
            &mut best,
        );

        let coarse = best?;
        let fine_radius = ADAPTIVE_DELAY_FINE_RADIUS_MS * samples_per_ms;
        let fine_step =
            (ADAPTIVE_DELAY_FINE_STEP_MS * samples_per_ms).max(TARGET_CHANNEL_COUNT);
        let fine_start = coarse.delay_samples.saturating_sub(fine_radius);
        let fine_end = coarse
            .delay_samples
            .saturating_add(fine_radius)
            .min(max_delay);
        for delay in (fine_start..=fine_end).step_by(fine_step) {
            self.consider_echo_alignment(captured, cursor, delay, preferred_delay_samples, &mut best);
        }
        best
    }

    fn consider_echo_alignment(
        &self,
        captured: &[f32],
        cursor: usize,
        delay_samples: usize,
        preferred_delay_samples: usize,
        best: &mut Option<EchoAlignment>,
    ) {
        let delay_samples =
            (delay_samples / TARGET_CHANNEL_COUNT) * TARGET_CHANNEL_COUNT;
        let Some(block_end) = cursor.checked_sub(delay_samples) else {
            return;
        };
        let Some(block_start) = block_end.checked_sub(captured.len()) else {
            return;
        };
        if block_end > self.buffer.len() {
            return;
        }

        let stride = TARGET_CHANNEL_COUNT * ALIGNMENT_SCORE_FRAME_STRIDE;
        let mut reference_energy = 0.0_f32;
        let mut captured_energy = 0.0_f32;
        let mut cross_energy = 0.0_f32;
        let mut sample_count = 0usize;
        for index in (0..captured.len()).step_by(stride) {
            let reference = self.buffer[block_start + index];
            let sample = captured[index];
            reference_energy += reference * reference;
            captured_energy += sample * sample;
            cross_energy += sample * reference;
            sample_count += 1;
        }
        if sample_count == 0 || captured_energy <= f32::EPSILON {
            return;
        }
        let reference_rms = (reference_energy / sample_count as f32).sqrt();
        if reference_rms <= REFERENCE_ACTIVE_RMS {
            return;
        }
        let denominator = (reference_energy * captured_energy).sqrt();
        if denominator <= f32::EPSILON {
            return;
        }
        let correlation = (cross_energy.abs() / denominator).clamp(0.0, 1.0);
        let candidate = EchoAlignment {
            delay_samples,
            block_start,
            correlation,
        };
        let replace = best.is_none_or(|current| {
            correlation > current.correlation + f32::EPSILON
                || ((correlation - current.correlation).abs() <= f32::EPSILON
                    && delay_samples.abs_diff(preferred_delay_samples)
                        < current.delay_samples.abs_diff(preferred_delay_samples))
        });
        if replace {
            *best = Some(candidate);
        }
    }

    /// Moves the playback clock forward by the wall time elapsed since the
    /// previous call. The cursor may run past the buffered audio into the
    /// silence after playback finished (bounded so it cannot grow without
    /// limit); `push_samples_at` snaps it back when new audio starts.
    fn advance_play_cursor(&mut self, now: Instant) {
        if let Some(previous) = self.last_advance {
            let elapsed = now.saturating_duration_since(previous).as_secs_f64();
            let advanced =
                elapsed * TARGET_SAMPLE_RATE_HZ as f64 * TARGET_CHANNEL_COUNT as f64;
            self.play_cursor = (self.play_cursor + advanced)
                .min((self.buffer.len() + self.capacity) as f64);
        }
        self.last_advance = Some(now);
    }

    fn push_sample(&mut self, sample: f32) {
        // `capacity` is a retention target, not permission to discard audio
        // that has not played yet. Native responses are queued as one complete
        // PCM block and can exceed 30 seconds; dropping the front here made a
        // 42-second response use the wrong 30-second reference from its first
        // sample onward. Reclaim only samples already consumed by the playback
        // clock and allow a long in-flight segment to grow temporarily.
        while self.buffer.len() >= self.capacity && self.play_cursor >= 1.0 {
            self.buffer.pop_front();
            self.play_cursor = (self.play_cursor - 1.0).max(0.0);
        }
        self.buffer.push_back(sample.clamp(-1.0, 1.0));
    }
}

fn lerp(left: f32, right: f32, frac: f32) -> f32 {
    left + (right - left) * frac
}

/// Root-mean-square level of a sample block. Shared by the echo-cancel and
/// acoustic-loop test suites.
#[cfg(test)]
pub(crate) fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Mirrors `ECHO_CANCEL_DELAY_SAMPLES` in the capture engine.
    const TEST_DELAY_SAMPLES: usize = 9_600;
    /// One 960-frame stereo capture chunk in interleaved samples.
    const TEST_CHUNK_SAMPLES: usize = 1_920;
    const TEST_ECHO_PATH_GAIN: f32 = 0.8;

    fn sine_mono(frames: usize, amplitude: f32) -> Vec<f32> {
        (0..frames)
            .map(|index| (index as f32 * 0.13).sin() * amplitude)
            .collect()
    }

    /// Builds the capture chunk the microphone hears `seconds_played` seconds
    /// into playback: the reference block that ended `TEST_DELAY_SAMPLES`
    /// behind the playback position, scaled by the acoustic echo path gain.
    fn echoed_block(reference_mono: &[f32], seconds_played: u64, gain: f32) -> Vec<f32> {
        echoed_block_with_delay(reference_mono, seconds_played, TEST_DELAY_SAMPLES, gain)
    }

    fn echoed_block_with_delay(
        reference_mono: &[f32],
        seconds_played: u64,
        delay_samples: usize,
        gain: f32,
    ) -> Vec<f32> {
        let cursor =
            seconds_played as usize * TARGET_SAMPLE_RATE_HZ as usize * TARGET_CHANNEL_COUNT;
        let block_start = cursor - delay_samples - TEST_CHUNK_SAMPLES;
        (0..TEST_CHUNK_SAMPLES)
            .map(|index| reference_mono[(block_start + index) / 2] * gain)
            .collect()
    }

    fn broadband_mono(frames: usize, amplitude: f32) -> Vec<f32> {
        let mut state = 0x1234_5678_u32;
        let mut smoothed = 0.0_f32;
        (0..frames)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let white = (state as f32 / u32::MAX as f32).mul_add(2.0, -1.0);
                smoothed = smoothed.mul_add(0.82, white * 0.18);
                smoothed * amplitude
            })
            .collect()
    }

    /// Seeds a 30-second-capacity reference buffer with `seconds` of a tone at
    /// `amplitude`, pushed at a freshly captured playback start instant.
    fn seeded_reference_buffer(
        seconds: usize,
        amplitude: f32,
    ) -> (EchoReferenceBuffer, Vec<f32>, Instant) {
        let mut buffer = EchoReferenceBuffer::new(48_000 * 30);
        let reference = sine_mono(seconds * 48_000, amplitude);
        let playback_started = Instant::now();
        buffer.push_samples_at(&reference, 48_000, 1, playback_started);
        (buffer, reference, playback_started)
    }

    /// A cosine capture block unrelated to the reference tone, scaled by `gain`;
    /// used to prove pass-through/double-talk behavior with no aligned echo.
    fn cosine_capture_block(gain: f32) -> Vec<f32> {
        (0..TEST_CHUNK_SAMPLES)
            .map(|index| (index as f32 * 0.031).cos() * gain)
            .collect()
    }

    #[test]
    fn converts_mono_to_stereo_reference() {
        let mut buffer = EchoReferenceBuffer::new(4);
        buffer.push_samples(&[0.5, -0.5], 48_000, 1);

        assert_eq!(buffer.buffer.len(), 4);
        assert_eq!(buffer.buffer[0], 0.5);
        assert_eq!(buffer.buffer[1], 0.5);
        assert_eq!(buffer.buffer[2], -0.5);
        assert_eq!(buffer.buffer[3], -0.5);
    }

    #[test]
    fn resamples_24k_to_48k() {
        let mut buffer = EchoReferenceBuffer::new(8);
        buffer.push_samples(&[0.25, 0.75], 24_000, 1);

        assert_eq!(buffer.buffer.len(), 8);
        assert!(buffer.buffer[2] > 0.25);
    }

    #[test]
    fn keeps_unplayed_samples_when_a_segment_exceeds_soft_capacity() {
        let mut buffer = EchoReferenceBuffer::new(1);
        buffer.push_samples(&[0.1, 0.2, 0.3], 48_000, 1);

        assert_eq!(buffer.buffer.len(), 6);
        assert_eq!(buffer.buffer[0], 0.1);
        assert_eq!(buffer.buffer[5], 0.3);
    }

    #[test]
    fn reclaims_consumed_samples_before_appending_a_new_segment() {
        let mut buffer = EchoReferenceBuffer::new(1);
        let started = Instant::now();
        buffer.push_samples_at(&[0.1, 0.2, 0.3], 48_000, 1, started);
        buffer.push_samples_at(
            &[0.7],
            48_000,
            1,
            started + Duration::from_secs(1),
        );

        assert_eq!(buffer.buffer.len(), 2);
        assert_eq!(buffer.buffer[0], 0.7);
        assert_eq!(buffer.buffer[1], 0.7);
    }

    #[test]
    fn empty_buffer_returns_capture() {
        let mut buffer = EchoReferenceBuffer::new(4);
        let captured = vec![0.2, -0.2];

        let cancellation = buffer.subtract_from(&captured, 0);
        assert_eq!(cancellation.samples, captured);
        assert!(!cancellation.suppress_asr);
        assert!(buffer.is_empty());
    }

    #[test]
    fn cancels_echo_aligned_to_actual_playback_progress() {
        let (mut buffer, reference, playback_started) = seeded_reference_buffer(3, 0.5);

        // Two seconds into playback the capture loop receives the echo of the
        // block played `TEST_DELAY_SAMPLES` earlier, at the exact path gain
        // the canceller compensates for.
        let captured = echoed_block(&reference, 2, TEST_ECHO_PATH_GAIN);
        let cancellation = buffer.subtract_from_at(
            &captured,
            TEST_DELAY_SAMPLES,
            playback_started + Duration::from_secs(2),
        );

        assert!(
            rms(&cancellation.samples) < rms(&captured) * 0.05,
            "residual echo too high: cleaned_rms={} captured_rms={}",
            rms(&cancellation.samples),
            rms(&captured)
        );
        assert!(cancellation.suppress_asr);
    }

    #[test]
    fn adapts_to_endpoint_latency_instead_of_leaking_translated_playback() {
        let playback_started = Instant::now();
        let reference = broadband_mono(3 * 48_000, 0.5);

        for actual_delay_ms in [35_usize, 220] {
            let mut buffer = EchoReferenceBuffer::new(48_000 * 30);
            buffer.push_samples_at(&reference, 48_000, 1, playback_started);
            let actual_delay_samples =
                actual_delay_ms * TARGET_SAMPLE_RATE_HZ as usize * TARGET_CHANNEL_COUNT / 1_000;
            let captured = echoed_block_with_delay(
                &reference,
                2,
                actual_delay_samples,
                TEST_ECHO_PATH_GAIN,
            );

            let cancellation = buffer.subtract_from_at(
                &captured,
                TEST_DELAY_SAMPLES,
                playback_started + Duration::from_secs(2),
            );

            assert!(
                rms(&cancellation.samples) < rms(&captured) * 0.05,
                "latency {actual_delay_ms}ms leaked translated playback: cleaned_rms={} captured_rms={}",
                rms(&cancellation.samples),
                rms(&captured)
            );
            assert!(
                cancellation.suppress_asr,
                "latency {actual_delay_ms}ms must be suppressed before realtime ASR"
            );
        }
    }

    #[test]
    fn long_segment_keeps_early_reference_aligned_past_soft_capacity() {
        // Model audio arrives as one complete segment before blocking playback
        // begins. A one-second soft capacity must not evict the first two
        // seconds of this three-second segment before they have played.
        let mut buffer = EchoReferenceBuffer::new(48_000);
        let reference = sine_mono(3 * 48_000, 0.5);
        let playback_started = Instant::now();
        buffer.push_samples_at(&reference, 48_000, 1, playback_started);

        let captured = echoed_block(&reference, 1, TEST_ECHO_PATH_GAIN);
        let cancellation = buffer.subtract_from_at(
            &captured,
            TEST_DELAY_SAMPLES,
            playback_started + Duration::from_secs(1),
        );

        assert!(
            rms(&cancellation.samples) < rms(&captured) * 0.05,
            "early reference was evicted or shifted: cleaned_rms={} captured_rms={}",
            rms(&cancellation.samples),
            rms(&captured)
        );
        assert!(cancellation.suppress_asr);
    }

    #[test]
    fn suppresses_residual_echo_while_tts_is_playing() {
        let (mut buffer, reference, playback_started) = seeded_reference_buffer(3, 0.5);

        // The acoustic path gain differs from ATTENUATION, so plain linear
        // subtraction leaves an audible residual; the playback gate must
        // suppress it while the reference block is active.
        let captured = echoed_block(&reference, 2, 0.5);
        let cancellation = buffer.subtract_from_at(
            &captured,
            TEST_DELAY_SAMPLES,
            playback_started + Duration::from_secs(2),
        );

        assert!(
            rms(&cancellation.samples) < rms(&captured) * 0.1,
            "gated residual too high: cleaned_rms={} captured_rms={}",
            rms(&cancellation.samples),
            rms(&captured)
        );
        assert!(
            cancellation.suppress_asr,
            "playback-dominated capture must be dropped before the Omni silence grace"
        );
    }

    #[test]
    fn keeps_double_talk_audible_during_playback() {
        let (mut buffer, _reference, playback_started) = seeded_reference_buffer(3, 0.2);

        // The listener talks loudly over quiet TTS playback; the gate must
        // back off so their speech still reaches STT.
        let captured = cosine_capture_block(0.9);
        let cancellation = buffer.subtract_from_at(
            &captured,
            TEST_DELAY_SAMPLES,
            playback_started + Duration::from_secs(2),
        );

        assert!(
            rms(&cancellation.samples) > rms(&captured) * 0.5,
            "double talk was gated away: cleaned_rms={} captured_rms={}",
            rms(&cancellation.samples),
            rms(&captured)
        );
        assert!(!cancellation.suppress_asr);
    }

    #[test]
    fn keeps_quiet_program_audio_under_louder_translated_playback() {
        let (mut buffer, reference, playback_started) = seeded_reference_buffer(3, 0.18);
        let translated_playback = echoed_block(&reference, 2, TEST_ECHO_PATH_GAIN);
        let program_audio = cosine_capture_block(0.025);
        let captured: Vec<f32> = translated_playback
            .iter()
            .zip(program_audio.iter())
            .map(|(translated, program)| translated + program)
            .collect();

        let cancellation = buffer.subtract_from_at(
            &captured,
            TEST_DELAY_SAMPLES,
            playback_started + Duration::from_secs(2),
        );

        assert!(
            rms(&cancellation.samples) > rms(&program_audio) * 0.7,
            "quiet source was gated: cleaned_rms={} source_rms={}",
            rms(&cancellation.samples),
            rms(&program_audio)
        );
        assert!(
            rms(&cancellation.samples) < rms(&program_audio) * 1.3,
            "translated playback was not removed: cleaned_rms={} source_rms={}",
            rms(&cancellation.samples),
            rms(&program_audio)
        );
        assert!(!cancellation.suppress_asr);
    }

    #[test]
    fn passes_capture_through_after_playback_finished() {
        let (mut buffer, _reference, playback_started) = seeded_reference_buffer(1, 0.5);

        // Long after the one-second reference finished playing, capture must
        // pass through untouched even though old samples remain buffered.
        let captured = cosine_capture_block(0.4);
        let cancellation = buffer.subtract_from_at(
            &captured,
            TEST_DELAY_SAMPLES,
            playback_started + Duration::from_secs(5),
        );

        assert_eq!(cancellation.samples, captured);
        assert!(!cancellation.suppress_asr);
    }

    #[test]
    fn ignores_degenerate_push_inputs() {
        let mut buffer = EchoReferenceBuffer::new(4);
        buffer.push_samples(&[], 48_000, 1);
        buffer.push_samples(&[0.5], 0, 1);
        buffer.push_samples(&[0.5], 48_000, 0);
        // Fewer samples than one full frame of the claimed channel count.
        buffer.push_samples(&[0.5], 48_000, 2);

        assert!(buffer.is_empty());
        assert_eq!(buffer.depth_samples(), 0);
    }

    #[test]
    fn capture_before_playback_reaches_the_delay_passes_through() {
        let (mut buffer, _reference, playback_started) = seeded_reference_buffer(1, 0.5);

        // The echo path is TEST_DELAY_SAMPLES long, so a capture taken right
        // at playback start cannot contain any speaker output yet; the
        // canceller must not carve the aligned-to-nothing reference out of it.
        let captured = cosine_capture_block(0.4);
        let cancellation = buffer.subtract_from_at(&captured, TEST_DELAY_SAMPLES, playback_started);

        assert_eq!(cancellation.samples, captured);
        assert!(!cancellation.suppress_asr);
    }

    #[test]
    fn new_segment_after_a_silence_gap_realigns_the_play_cursor() {
        let mut buffer = EchoReferenceBuffer::new(48_000 * 30);
        let playback_started = Instant::now();
        // First 1-second segment, then 4 seconds of silence: the playback
        // clock runs far past the buffered audio.
        buffer.push_samples_at(&sine_mono(48_000, 0.5), 48_000, 1, playback_started);

        // A new segment starts after the gap; the cursor must snap back to
        // the end of the buffered audio so this segment aligns with "now".
        let second_segment = sine_mono(48_000, 0.3);
        let second_started = playback_started + Duration::from_secs(5);
        buffer.push_samples_at(&second_segment, 48_000, 1, second_started);

        // One second into the second segment the microphone hears its echo:
        // the reference block that ended TEST_DELAY_SAMPLES behind the cursor,
        // located near the end of the second segment.
        let first_segment_samples = 48_000 * TARGET_CHANNEL_COUNT;
        let cursor = first_segment_samples + 48_000 * TARGET_CHANNEL_COUNT;
        let block_start = cursor - TEST_DELAY_SAMPLES - TEST_CHUNK_SAMPLES;
        let captured: Vec<f32> = (0..TEST_CHUNK_SAMPLES)
            .map(|index| {
                second_segment[(block_start + index - first_segment_samples) / 2]
                    * TEST_ECHO_PATH_GAIN
            })
            .collect();
        let cancellation = buffer.subtract_from_at(
            &captured,
            TEST_DELAY_SAMPLES,
            second_started + Duration::from_secs(1),
        );

        assert!(
            rms(&cancellation.samples) < rms(&captured) * 0.05,
            "cursor misaligned after silence gap: cleaned_rms={} captured_rms={}",
            rms(&cancellation.samples),
            rms(&captured)
        );
        assert!(cancellation.suppress_asr);
    }
}
