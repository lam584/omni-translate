use std::collections::VecDeque;
use std::time::Instant;

const TARGET_SAMPLE_RATE_HZ: u32 = 48_000;
const TARGET_CHANNEL_COUNT: usize = 2;
const ATTENUATION: f32 = 0.8;
/// RMS above which the playback-aligned reference block counts as active TTS
/// output rather than silence between segments.
const REFERENCE_ACTIVE_RMS: f32 = 0.01;
/// Captured blocks louder than this multiple of the reference RMS count as
/// double talk; suppression then backs off to plain linear subtraction so the
/// listener's own speech is not gated away.
const DOUBLE_TALK_RMS_RATIO: f32 = 2.0;
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
        // stay paired, then map the captured chunk onto the reference block
        // that ended `delay_samples` behind the playback cursor: the capture
        // path hears the speaker output that many samples late.
        let cursor = (self.play_cursor as usize / TARGET_CHANNEL_COUNT) * TARGET_CHANNEL_COUNT;
        let block_end = cursor as i64 - delay_samples as i64;
        let block_start = block_end - captured.len() as i64;

        let mut reference_energy = 0.0_f32;
        let mut captured_energy = 0.0_f32;
        let mut cleaned: Vec<f32> = captured
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
                (sample - reference * ATTENUATION).clamp(-1.0, 1.0)
            })
            .collect();

        // Half-duplex energy suppression: while the aligned reference block is
        // audibly playing and the capture is not clearly louder (double talk),
        // duck the residual so imperfect linear subtraction cannot leak TTS
        // audio back into STT.
        let block_len = captured.len() as f32;
        let reference_rms = (reference_energy / block_len).sqrt();
        let captured_rms = (captured_energy / block_len).sqrt();
        let suppress_asr = reference_rms > REFERENCE_ACTIVE_RMS
            && captured_rms < reference_rms * DOUBLE_TALK_RMS_RATIO;
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
        while self.buffer.len() >= self.capacity {
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

    fn sine_mono(frames: usize, amplitude: f32) -> Vec<f32> {
        (0..frames)
            .map(|index| (index as f32 * 0.13).sin() * amplitude)
            .collect()
    }

    /// Builds the capture chunk the microphone hears `seconds_played` seconds
    /// into playback: the reference block that ended `TEST_DELAY_SAMPLES`
    /// behind the playback position, scaled by the acoustic echo path gain.
    fn echoed_block(reference_mono: &[f32], seconds_played: u64, gain: f32) -> Vec<f32> {
        let cursor =
            seconds_played as usize * TARGET_SAMPLE_RATE_HZ as usize * TARGET_CHANNEL_COUNT;
        let block_start = cursor - TEST_DELAY_SAMPLES - TEST_CHUNK_SAMPLES;
        (0..TEST_CHUNK_SAMPLES)
            .map(|index| reference_mono[(block_start + index) / 2] * gain)
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
    fn drops_old_samples_over_capacity() {
        let mut buffer = EchoReferenceBuffer::new(1);
        buffer.push_samples(&[0.1, 0.2, 0.3], 48_000, 1);

        assert_eq!(buffer.buffer.len(), 2);
        assert_eq!(buffer.buffer[0], 0.3);
        assert_eq!(buffer.buffer[1], 0.3);
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
        let captured = echoed_block(&reference, 2, ATTENUATION);
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
            .map(|index| second_segment[(block_start + index - first_segment_samples) / 2] * ATTENUATION)
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
