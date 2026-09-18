use super::TARGET_CHANNELS;
use std::path::PathBuf;

pub(super) fn apply_gain_db(samples: &mut [f32], gain_db: f32) {
    let linear = 10.0_f32.powf(gain_db / 20.0);
    for sample in samples {
        *sample = (*sample * linear).clamp(-1.0, 1.0);
    }
}

pub(super) fn append_postroll_silence(samples: &mut Vec<f32>, postroll_frames: usize) {
    samples.resize(
        samples.len() + postroll_frames * TARGET_CHANNELS,
        0.0,
    );
}

pub(super) fn insert_silence<T: Clone + Default>(
    samples: &mut Vec<T>,
    channels: usize,
    sample_rate_hz: u32,
    after_seconds: f64,
    silence_seconds: f64,
) -> Result<usize, String> {
    if after_seconds == 0.0 && silence_seconds == 0.0 {
        return Ok(0);
    }
    let after_frames = (after_seconds * sample_rate_hz as f64).round() as usize;
    let total_frames = samples.len() / channels.max(1);
    if after_frames >= total_frames {
        return Err(format!(
            "restart quiet window begins outside media: afterFrames={after_frames} mediaFrames={total_frames}"
        ));
    }
    let silence_frames = (silence_seconds * sample_rate_hz as f64).round() as usize;
    let insertion = after_frames * channels;
    samples.splice(
        insertion..insertion,
        std::iter::repeat_n(T::default(), silence_frames * channels),
    );
    Ok(silence_frames)
}

pub(super) fn resample_to_render_stereo(
    samples: &[f32],
    sample_rate_hz: u32,
    channels: usize,
    render_sample_rate_hz: u32,
) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let channels = channels.max(1);
    let source_frames = samples.len() / channels;
    let target_frames = source_frames.saturating_mul(render_sample_rate_hz.max(1) as usize)
        / sample_rate_hz.max(1) as usize;
    let ratio = sample_rate_hz.max(1) as f64 / render_sample_rate_hz.max(1) as f64;
    let mut output = Vec::with_capacity(target_frames * TARGET_CHANNELS);
    for target_index in 0..target_frames {
        let source_index = ((target_index as f64) * ratio).floor() as usize;
        let source_index = source_index.min(source_frames.saturating_sub(1));
        let frame_start = source_index * channels;
        let left = samples[frame_start].clamp(-1.0, 1.0);
        let right = if channels > 1 {
            samples[frame_start + 1].clamp(-1.0, 1.0)
        } else {
            left
        };
        output.push(left);
        output.push(right);
    }
    output
}

pub(super) fn resample_to_16k_mono(
    samples: &[f32],
    sample_rate_hz: u32,
    channels: usize,
    max_seconds: Option<f64>,
) -> Vec<i16> {
    if samples.is_empty() {
        return Vec::new();
    }
    let channels = channels.max(1);
    let source_frames = samples.len() / channels;
    let target_rate = 16_000usize;
    let mut target_frames =
        source_frames.saturating_mul(target_rate) / sample_rate_hz.max(1) as usize;
    if let Some(seconds) = max_seconds {
        target_frames = target_frames.min((seconds.max(0.1) * target_rate as f64) as usize);
    }
    let ratio = sample_rate_hz.max(1) as f64 / target_rate as f64;
    let mut output = Vec::with_capacity(target_frames);
    for target_index in 0..target_frames {
        let source_index = ((target_index as f64) * ratio).floor() as usize;
        let source_index = source_index.min(source_frames.saturating_sub(1));
        let frame_start = source_index * channels;
        let mut sum = 0.0f32;
        for channel in 0..channels {
            sum += samples[frame_start + channel].clamp(-1.0, 1.0);
        }
        let mono = (sum / channels as f32).clamp(-1.0, 1.0);
        output.push((mono * i16::MAX as f32) as i16);
    }
    output
}

pub(super) fn write_pcm16le(path: &PathBuf, samples: &[i16]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create reference PCM directory '{}': {error}",
                parent.display()
            )
        })?;
    }
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    std::fs::write(path, bytes).map_err(|error| {
        format!(
            "failed to write reference PCM '{}': {error}",
            path.display()
        )
    })
}

