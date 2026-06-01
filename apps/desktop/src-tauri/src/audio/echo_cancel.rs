use std::collections::VecDeque;

const TARGET_SAMPLE_RATE_HZ: u32 = 48_000;
const TARGET_CHANNEL_COUNT: usize = 2;
const ATTENUATION: f32 = 0.8;

pub(crate) struct EchoReferenceBuffer {
    buffer: VecDeque<f32>,
    capacity: usize,
}

impl EchoReferenceBuffer {
    pub(crate) fn new(capacity_frames: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(capacity_frames * TARGET_CHANNEL_COUNT),
            capacity: capacity_frames * TARGET_CHANNEL_COUNT,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    pub(crate) fn push_samples(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
    ) {
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

    pub(crate) fn subtract_from(&self, captured: &[f32], delay_samples: usize) -> Vec<f32> {
        if captured.is_empty() || self.buffer.is_empty() {
            return captured.to_vec();
        }

        let len = self.buffer.len();
        if len <= delay_samples {
            return captured.to_vec();
        }

        let available = len - delay_samples;
        let start = available.saturating_sub(captured.len());
        captured
            .iter()
            .enumerate()
            .map(|(index, sample)| {
                let reference = if index < available {
                    self.buffer.get(start + index).copied().unwrap_or(0.0)
                } else {
                    0.0
                };
                (sample - reference * ATTENUATION).clamp(-1.0, 1.0)
            })
            .collect()
    }

    fn push_sample(&mut self, sample: f32) {
        while self.buffer.len() >= self.capacity {
            self.buffer.pop_front();
        }
        self.buffer.push_back(sample.clamp(-1.0, 1.0));
    }
}

fn lerp(left: f32, right: f32, frac: f32) -> f32 {
    left + (right - left) * frac
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn subtracts_delayed_reference() {
        let mut buffer = EchoReferenceBuffer::new(4);
        buffer.push_samples(&[0.5, 0.5], 48_000, 2);

        let cleaned = buffer.subtract_from(&[0.5, 0.5], 0);
        assert!((cleaned[0] - 0.1).abs() < 0.00001);
        assert!((cleaned[1] - 0.1).abs() < 0.00001);
    }

    #[test]
    fn empty_buffer_returns_capture() {
        let buffer = EchoReferenceBuffer::new(4);
        let captured = vec![0.2, -0.2];

        assert_eq!(buffer.subtract_from(&captured, 0), captured);
        assert!(buffer.is_empty());
    }
}
