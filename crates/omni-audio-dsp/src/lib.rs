//! Small, dependency-free DSP helpers shared by desktop and bridge playback.

const ACTIVE_FRAME_MS: usize = 20;
const ACTIVE_FLOOR_DBFS: f32 = -50.0;
const TARGET_RMS_DBFS: f32 = -18.0;
const MIN_AUTO_GAIN_DB: f32 = -6.0;
const MAX_AUTO_GAIN_DB: f32 = 12.0;
const PEAK_CEILING_DBFS: f32 = -1.0;
const MUTE_GAIN_DB: f32 = -60.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpeechEnhancementMetrics {
    pub active_rms_dbfs: Option<f32>,
    pub input_peak_dbfs: Option<f32>,
    pub auto_gain_db: f32,
    pub requested_gain_db: f32,
    pub applied_gain_db: f32,
    pub peak_limited: bool,
    pub muted: bool,
}

impl SpeechEnhancementMetrics {
    fn silent(manual_gain_db: f32, muted: bool) -> Self {
        Self {
            active_rms_dbfs: None,
            input_peak_dbfs: None,
            auto_gain_db: 0.0,
            requested_gain_db: manual_gain_db,
            applied_gain_db: if muted { f32::NEG_INFINITY } else { manual_gain_db },
            peak_limited: false,
            muted,
        }
    }
}

/// Applies per-utterance active-RMS leveling, manual gain and peak protection.
///
/// Samples are interleaved PCM16. The caller must pass the source sample rate
/// and channel count so 20 ms analysis windows remain stable across providers.
pub fn enhance_speech_i16(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    manual_gain_db: f32,
    auto_gain_enabled: bool,
) -> (Vec<i16>, SpeechEnhancementMetrics) {
    let manual_gain_db = if manual_gain_db.is_finite() {
        manual_gain_db
    } else {
        MUTE_GAIN_DB
    };
    if samples.is_empty() || sample_rate_hz == 0 || channel_count == 0 {
        return (
            vec![0; samples.len()],
            SpeechEnhancementMetrics::silent(manual_gain_db, false),
        );
    }
    if manual_gain_db <= MUTE_GAIN_DB {
        return (
            vec![0; samples.len()],
            SpeechEnhancementMetrics::silent(manual_gain_db, true),
        );
    }

    let peak = samples
        .iter()
        .map(|sample| (*sample as f32 / i16::MAX as f32).abs())
        .fold(0.0_f32, f32::max);
    if peak == 0.0 {
        return (
            vec![0; samples.len()],
            SpeechEnhancementMetrics::silent(manual_gain_db, false),
        );
    }

    let active_rms = active_frame_rms(samples, sample_rate_hz, channel_count);
    let auto_gain_db = if auto_gain_enabled {
        active_rms
            .map(|rms| (TARGET_RMS_DBFS - linear_to_db(rms)).clamp(MIN_AUTO_GAIN_DB, MAX_AUTO_GAIN_DB))
            .unwrap_or(0.0)
    } else {
        0.0
    };
    let requested_gain_db = manual_gain_db + auto_gain_db;
    let peak_safe_gain_db = PEAK_CEILING_DBFS - linear_to_db(peak);
    let applied_gain_db = if requested_gain_db > 0.0 {
        requested_gain_db.min(peak_safe_gain_db)
    } else {
        requested_gain_db
    };
    let peak_limited = applied_gain_db + f32::EPSILON < requested_gain_db;
    let linear_gain = db_to_linear(applied_gain_db);
    let output = samples
        .iter()
        .map(|sample| {
            ((*sample as f32) * linear_gain)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16
        })
        .collect();

    (
        output,
        SpeechEnhancementMetrics {
            active_rms_dbfs: active_rms.map(linear_to_db),
            input_peak_dbfs: Some(linear_to_db(peak)),
            auto_gain_db,
            requested_gain_db,
            applied_gain_db,
            peak_limited,
            muted: false,
        },
    )
}

fn active_frame_rms(samples: &[i16], sample_rate_hz: u32, channel_count: u16) -> Option<f32> {
    let samples_per_frame = ((sample_rate_hz as usize * ACTIVE_FRAME_MS / 1_000)
        .max(1))
        .saturating_mul(channel_count as usize);
    let active_floor = db_to_linear(ACTIVE_FLOOR_DBFS);
    let mut active_energy = 0.0_f64;
    let mut active_samples = 0_usize;

    for frame in samples.chunks(samples_per_frame) {
        let energy = frame
            .iter()
            .map(|sample| {
                let value = *sample as f64 / i16::MAX as f64;
                value * value
            })
            .sum::<f64>();
        let rms = (energy / frame.len().max(1) as f64).sqrt() as f32;
        if rms >= active_floor {
            active_energy += energy;
            active_samples += frame.len();
        }
    }

    (active_samples > 0).then(|| (active_energy / active_samples as f64).sqrt() as f32)
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

fn linear_to_db(value: f32) -> f32 {
    20.0 * value.max(f32::MIN_POSITIVE).log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant_tone(level_dbfs: f32, duration_ms: u32) -> Vec<i16> {
        let value = (db_to_linear(level_dbfs) * i16::MAX as f32).round() as i16;
        vec![value; 24_000 * duration_ms as usize / 1_000]
    }

    fn peak_dbfs(samples: &[i16]) -> f32 {
        linear_to_db(
            samples
                .iter()
                .map(|sample| (*sample as f32 / i16::MAX as f32).abs())
                .fold(0.0_f32, f32::max),
        )
    }

    #[test]
    fn boosts_quiet_active_speech_toward_target() {
        let input = constant_tone(-30.0, 100);
        let (output, metrics) = enhance_speech_i16(&input, 24_000, 1, 0.0, true);
        assert!((metrics.auto_gain_db - 12.0).abs() < 0.1);
        assert!((peak_dbfs(&output) - TARGET_RMS_DBFS).abs() < 0.2);
    }

    #[test]
    fn attenuates_overly_loud_speech() {
        let input = constant_tone(-10.0, 100);
        let (_, metrics) = enhance_speech_i16(&input, 24_000, 1, 0.0, true);
        assert!((metrics.auto_gain_db - MIN_AUTO_GAIN_DB).abs() < 0.1);
    }

    #[test]
    fn caps_auto_gain_and_ignores_silent_frames() {
        let mut input = vec![0; 2_400];
        input.extend(constant_tone(-40.0, 100));
        let (_, metrics) = enhance_speech_i16(&input, 24_000, 1, 0.0, true);
        assert!((metrics.active_rms_dbfs.unwrap() + 40.0).abs() < 0.2);
        assert!((metrics.auto_gain_db - MAX_AUTO_GAIN_DB).abs() < 0.1);
    }

    #[test]
    fn manual_two_hundred_percent_is_peak_safe() {
        let input = constant_tone(-3.0, 100);
        let (output, metrics) = enhance_speech_i16(&input, 24_000, 1, 6.0206, false);
        assert!(metrics.peak_limited);
        assert!(peak_dbfs(&output) <= PEAK_CEILING_DBFS + 0.01);
    }

    #[test]
    fn disabled_auto_gain_preserves_unity_samples() {
        let input = constant_tone(-20.0, 100);
        let (output, metrics) = enhance_speech_i16(&input, 24_000, 1, 0.0, false);
        assert_eq!(output, input);
        assert_eq!(metrics.auto_gain_db, 0.0);
        assert!(!metrics.peak_limited);
    }

    #[test]
    fn mute_and_silence_are_safe() {
        let input = constant_tone(-20.0, 100);
        let (muted, metrics) = enhance_speech_i16(&input, 24_000, 1, -60.0, true);
        assert!(muted.iter().all(|sample| *sample == 0));
        assert!(metrics.muted);

        let (silence, metrics) = enhance_speech_i16(&vec![0; 480], 24_000, 1, 0.0, true);
        assert!(silence.iter().all(|sample| *sample == 0));
        assert_eq!(metrics.active_rms_dbfs, None);
    }

    #[test]
    fn invalid_metadata_returns_silence() {
        let (output, _) = enhance_speech_i16(&[1, 2, 3], 0, 1, 0.0, true);
        assert_eq!(output, vec![0, 0, 0]);
    }
}
