//! Shared capture-format conversion for realtime speech providers.
//!
//! The capture engine always delivers 48 kHz / stereo / f32-le chunks
//! (`engine::SAMPLE_RATE_HZ` / `engine::CHANNEL_COUNT`). Every provider
//! worker must convert to its wire format itself; this module hosts the
//! conversions shared by non-DashScope providers (OpenAI realtime needs
//! 24 kHz mono pcm16, Gemini Live needs 16 kHz mono pcm16).

use base64::Engine;

/// Downmix 48 kHz stereo f32-le capture bytes to mono i16 at `target_rate`.
/// Only integer decimation targets of 48 kHz are supported (16 kHz, 24 kHz).
pub(crate) fn resample_capture_to_mono_i16(input: &[u8], target_rate: u32) -> Vec<i16> {
    debug_assert!(48_000 % target_rate.max(1) == 0, "target must divide 48kHz");
    let ratio = (48_000 / target_rate.max(1)).max(1) as usize;
    let frame_count = input.len() / 8;
    if frame_count == 0 {
        return Vec::new();
    }

    let mut mono = Vec::with_capacity(frame_count);
    for frame in input.chunks_exact(8) {
        let left = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
        let right = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
        mono.push((left + right) * 0.5);
    }

    let out_len = mono.len() / ratio;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let window = &mono[i * ratio..(i + 1) * ratio];
        let averaged = window.iter().sum::<f32>() / ratio as f32;
        out.push((averaged.clamp(-1.0, 1.0) * 32767.0) as i16);
    }
    out
}

/// Linear-interpolation resample of mono i16 PCM between arbitrary rates
/// (e.g. the benchmark's 16 kHz decode buffer -> OpenAI's 24 kHz input).
pub(crate) fn resample_mono_i16(input: &[i16], from_rate: u32, to_rate: u32) -> Vec<i16> {
    if input.is_empty() || from_rate == 0 || to_rate == 0 {
        return Vec::new();
    }
    if from_rate == to_rate {
        return input.to_vec();
    }
    let out_len = ((input.len() as u64) * to_rate as u64 / from_rate as u64) as usize;
    let step = from_rate as f64 / to_rate as f64;
    let last = input.len() - 1;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * step;
        let idx = (pos as usize).min(last);
        let frac = pos - idx as f64;
        let a = input[idx] as f64;
        let b = input[(idx + 1).min(last)] as f64;
        out.push((a + (b - a) * frac).round() as i16);
    }
    out
}

pub(crate) fn base64_encode_pcm16(samples: &[i16]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

pub(crate) fn base64_decode_to_i16(encoded: &str) -> Result<Vec<i16>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("base64 decode error: {e}"))?;
    if bytes.len() % 2 != 0 {
        return Err("odd byte count for i16 PCM".to_string());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}

/// RMS of an i16 chunk on a 0..1 scale, matching the Omni silence gate metric.
pub(crate) fn pcm16_chunk_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares = samples.iter().fold(0.0_f64, |sum, sample| {
        let value = *sample as f64 / 32768.0;
        sum + value * value
    });
    (sum_squares / samples.len() as f64).sqrt() as f32
}

/// RMS silence gate with a trailing grace window, mirroring the Omni pump so
/// server-side VAD still sees end-of-speech silence before we stop sending.
pub(crate) struct SilenceGate {
    min_rms: f32,
    grace_chunks: u32,
    grace_remaining: u32,
}

impl SilenceGate {
    pub(crate) fn new(min_rms: f32, grace_chunks: u32) -> Self {
        Self {
            min_rms,
            grace_chunks,
            grace_remaining: 0,
        }
    }

    pub(crate) fn should_send(&mut self, rms: f32) -> bool {
        if rms >= self.min_rms {
            self.grace_remaining = self.grace_chunks;
            return true;
        }
        if self.grace_remaining > 0 {
            self.grace_remaining -= 1;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture_bytes(frames: &[(f32, f32)]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(frames.len() * 8);
        for (left, right) in frames {
            bytes.extend_from_slice(&left.to_le_bytes());
            bytes.extend_from_slice(&right.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn resamples_to_24k_with_2_to_1_decimation() {
        let frames: Vec<(f32, f32)> = (0..8).map(|_| (0.5, 0.5)).collect();
        let out = resample_capture_to_mono_i16(&capture_bytes(&frames), 24_000);
        assert_eq!(out.len(), 4);
        assert!(out.iter().all(|s| (*s - 16383).abs() <= 1), "{out:?}");
    }

    #[test]
    fn resamples_to_16k_with_3_to_1_decimation() {
        let frames: Vec<(f32, f32)> = (0..9).map(|_| (1.0, 0.0)).collect();
        let out = resample_capture_to_mono_i16(&capture_bytes(&frames), 16_000);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|s| (*s - 16383).abs() <= 1), "{out:?}");
    }

    #[test]
    fn clamps_out_of_range_float_samples() {
        let frames = vec![(2.0, 2.0), (2.0, 2.0), (-2.0, -2.0), (-2.0, -2.0)];
        let out = resample_capture_to_mono_i16(&capture_bytes(&frames), 24_000);
        assert_eq!(out, vec![32767, -32767]);
    }

    #[test]
    fn empty_and_partial_frames_produce_empty_output() {
        assert!(resample_capture_to_mono_i16(&[], 24_000).is_empty());
        assert!(resample_capture_to_mono_i16(&[0u8; 7], 24_000).is_empty());
    }

    #[test]
    fn rms_distinguishes_silence_from_signal() {
        assert_eq!(pcm16_chunk_rms(&[0, 0, 0]), 0.0);
        assert!(pcm16_chunk_rms(&[0, 512, -512]) > 0.002);
    }

    #[test]
    fn linear_resample_upsamples_16k_to_24k() {
        let input: Vec<i16> = vec![0, 100, 200, 300];
        let out = resample_mono_i16(&input, 16_000, 24_000);
        assert_eq!(out.len(), 6);
        assert_eq!(out[0], 0);
        // Position 1 maps to source offset 2/3 between samples 0 and 100.
        assert!((out[1] - 67).abs() <= 1, "{out:?}");
        assert_eq!(*out.last().unwrap(), 300);
    }

    #[test]
    fn linear_resample_identity_and_empty_cases() {
        let input: Vec<i16> = vec![1, 2, 3];
        assert_eq!(resample_mono_i16(&input, 16_000, 16_000), input);
        assert!(resample_mono_i16(&[], 16_000, 24_000).is_empty());
        assert!(resample_mono_i16(&input, 0, 24_000).is_empty());
    }

    #[test]
    fn silence_gate_allows_grace_window_after_audible_audio() {
        let mut gate = SilenceGate::new(0.002, 3);
        assert!(!gate.should_send(0.0));
        assert!(gate.should_send(0.5));
        for _ in 0..3 {
            assert!(gate.should_send(0.0));
        }
        assert!(!gate.should_send(0.0));
    }
}
