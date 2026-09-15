use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmQuality {
    pub passed: bool,
    pub error: Option<String>,
    pub sample_rate_hz: u32,
    pub sample_count: usize,
    pub duration_seconds: f64,
    pub rms: f64,
    pub peak: f64,
    pub crest_factor: f64,
    pub clipping_ratio: f64,
    pub clipped_samples: usize,
    pub zero_crossing_rate: f64,
    pub discontinuity_rate: f64,
    pub discontinuities: usize,
    pub non_silent_ratio: f64,
    pub noise_risk: bool,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmSimilarity {
    pub passed: bool,
    pub error: Option<String>,
    pub sample_rate_hz: u32,
    pub frame_milliseconds: f64,
    pub reference_frames: usize,
    pub recorded_frames: usize,
    pub compared_frames: usize,
    pub best_offset_frames: usize,
    pub best_offset_seconds: f64,
    pub envelope_correlation: f64,
    pub level_ratio: f64,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPcmSimilarity {
    pub sample_rate_hz: u32,
    pub reference_samples: usize,
    pub recorded_samples: usize,
    pub compared_samples: usize,
    pub best_offset_samples: i64,
    pub best_offset_seconds: f64,
    pub polarity: i8,
    pub waveform_correlation: f64,
    pub derivative_correlation: f64,
    pub energy_ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalWaveformCandidate {
    pub index: usize,
    pub anchor_reference_start_sample: usize,
    pub reference_offset_sample: usize,
    pub reference_start_sample: usize,
    pub recorded_start_sample: usize,
    pub samples: usize,
    pub anchor_lag_samples: usize,
    pub local_lag_samples: usize,
    pub local_lag_delta_samples: i64,
    pub waveform_correlation: f64,
    pub derivative_correlation: f64,
    pub energy_ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalWrongReferenceMetric {
    pub label: String,
    pub score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalWaveformMetrics {
    pub sample_rate_hz: u32,
    pub global_lag_samples: usize,
    pub maximum_lag_samples: usize,
    pub global_polarity: i8,
    pub candidates: Vec<CanonicalWaveformCandidate>,
    pub wrong_references: Vec<CanonicalWrongReferenceMetric>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedLoopbackSegment {
    pub reference_offset_seconds: f64,
    pub recording_offset_seconds: f64,
    pub timing_error_seconds: f64,
    pub waveform_correlation: f64,
    pub derivative_correlation: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedLoopbackMetrics {
    pub reference_samples: usize,
    pub score: f64,
    pub waveform_median: f64,
    pub waveform_minimum: f64,
    pub derivative_median: f64,
    pub derivative_minimum: f64,
    pub polarity: i8,
    pub global_lag_samples: i64,
    pub timing_error_seconds: f64,
    pub matched_start_sample: i64,
    pub matched_end_sample: i64,
    pub segment_matches: Vec<TranslatedLoopbackSegment>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrequencyComponent {
    pub frequency_hz: f64,
    pub amplitude: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmFingerprintMetrics {
    pub sample_rate_hz: u32,
    pub sample_count: usize,
    pub duration_seconds: f64,
    pub rms: f64,
    pub peak: f64,
    pub components: Vec<FrequencyComponent>,
}

fn rounded(value: f64, places: i32) -> f64 {
    let factor = 10_f64.powi(places);
    (value * factor).round() / factor
}

pub fn analyze_pcm(samples: &[i16], sample_rate_hz: u32) -> PcmQuality {
    if samples.is_empty() {
        return PcmQuality {
            passed: false,
            error: Some("PCM file contains no samples".to_string()),
            sample_rate_hz,
            sample_count: 0,
            duration_seconds: 0.0,
            rms: 0.0,
            peak: 0.0,
            crest_factor: 0.0,
            clipping_ratio: 0.0,
            clipped_samples: 0,
            zero_crossing_rate: 0.0,
            discontinuity_rate: 0.0,
            discontinuities: 0,
            non_silent_ratio: 0.0,
            noise_risk: false,
            detail: None,
        };
    }

    let mut sum_squares = 0.0;
    let mut peak = 0.0_f64;
    let mut clipped = 0;
    let mut zero_crossings = 0;
    let mut discontinuities = 0;
    let mut non_silent = 0;
    let mut previous = 0.0;
    for (index, sample) in samples.iter().copied().enumerate() {
        let value = f64::from(sample) / 32768.0;
        let absolute = value.abs();
        sum_squares += value * value;
        peak = peak.max(absolute);
        if i32::from(sample).abs() >= 32_700 {
            clipped += 1;
        }
        if index > 0 && ((value >= 0.0 && previous < 0.0) || (value < 0.0 && previous >= 0.0)) {
            zero_crossings += 1;
        }
        if index > 0 && (value - previous).abs() >= 0.35 {
            discontinuities += 1;
        }
        if absolute >= 0.003 {
            non_silent += 1;
        }
        previous = value;
    }

    let count = samples.len();
    let rms = (sum_squares / count as f64).sqrt();
    let clipping_ratio = clipped as f64 / count as f64;
    let transition_count = count.saturating_sub(1).max(1) as f64;
    let zero_crossing_rate = zero_crossings as f64 / transition_count;
    let discontinuity_rate = discontinuities as f64 / transition_count;
    let non_silent_ratio = non_silent as f64 / count as f64;
    let crest_factor = if rms > 0.0 { peak / rms } else { 0.0 };
    let hard_failure = clipping_ratio > 0.01 || peak >= 0.9999 || discontinuity_rate > 0.005;
    let noise_risk = zero_crossing_rate > 0.28 && rms > 0.015;
    let detail = if clipping_ratio > 0.01 || peak >= 0.9999 {
        Some(format!(
            "physical output recording is clipped: clippingRatio={} peak={}",
            rounded(clipping_ratio, 6),
            rounded(peak, 6)
        ))
    } else if discontinuity_rate > 0.005 {
        Some(format!(
            "physical output recording has discontinuities: discontinuityRate={}",
            rounded(discontinuity_rate, 6)
        ))
    } else if noise_risk {
        Some("physical output recording has high zero-crossing noise risk".to_string())
    } else {
        None
    };

    PcmQuality {
        passed: !hard_failure,
        error: None,
        sample_rate_hz,
        sample_count: count,
        duration_seconds: rounded(count as f64 / f64::from(sample_rate_hz.max(1)), 3),
        rms: rounded(rms, 6),
        peak: rounded(peak, 6),
        crest_factor: rounded(crest_factor, 3),
        clipping_ratio: rounded(clipping_ratio, 6),
        clipped_samples: clipped,
        zero_crossing_rate: rounded(zero_crossing_rate, 6),
        discontinuity_rate: rounded(discontinuity_rate, 6),
        discontinuities,
        non_silent_ratio: rounded(non_silent_ratio, 6),
        noise_risk,
        detail,
    }
}

pub fn analyze_pcm_fingerprint(samples: &[i16], sample_rate_hz: u32, frequencies: &[f64]) -> PcmFingerprintMetrics {
    let quality = analyze_pcm(samples, sample_rate_hz);
    let components = frequencies.iter().map(|frequency| {
        let omega = 2.0 * std::f64::consts::PI * frequency / sample_rate_hz as f64;
        let coefficient = 2.0 * omega.cos();
        let (mut previous, mut before_previous) = (0.0, 0.0);
        for sample in samples {
            let current = f64::from(*sample) / 32768.0 + coefficient * previous - before_previous;
            before_previous = previous;
            previous = current;
        }
        let power = previous * previous + before_previous * before_previous - coefficient * previous * before_previous;
        FrequencyComponent {
            frequency_hz: *frequency,
            amplitude: rounded(if samples.is_empty() { 0.0 } else { 2.0 * power.max(0.0).sqrt() / samples.len() as f64 }, 9),
        }
    }).collect();
    PcmFingerprintMetrics {
        sample_rate_hz, sample_count: samples.len(), duration_seconds: quality.duration_seconds,
        rms: quality.rms, peak: quality.peak, components,
    }
}

pub fn rms_envelope(samples: &[i16], frame_samples: usize) -> Vec<f64> {
    if frame_samples == 0 {
        return Vec::new();
    }
    samples
        .chunks_exact(frame_samples)
        .map(|frame| {
            let sum = frame.iter().map(|sample| {
                let value = f64::from(*sample) / 32768.0;
                value * value
            }).sum::<f64>();
            (sum / frame_samples as f64).sqrt()
        })
        .collect()
}

pub fn pearson_correlation(left: &[f64], right: &[f64]) -> f64 {
    let count = left.len().min(right.len());
    if count < 12 {
        return 0.0;
    }
    let left = &left[..count];
    let right = &right[..count];
    let left_mean = left.iter().sum::<f64>() / count as f64;
    let right_mean = right.iter().sum::<f64>() / count as f64;
    let (numerator, left_denominator, right_denominator) = left.iter().zip(right).fold(
        (0.0, 0.0, 0.0),
        |(numerator, left_denominator, right_denominator), (left, right)| {
            let left_delta = left - left_mean;
            let right_delta = right - right_mean;
            (
                numerator + left_delta * right_delta,
                left_denominator + left_delta * left_delta,
                right_denominator + right_delta * right_delta,
            )
        },
    );
    let denominator = (left_denominator * right_denominator).sqrt();
    if denominator <= 0.0 { 0.0 } else { numerator / denominator }
}

fn signed_correlation_at(reference: &[i16], recorded: &[i16], offset: usize, stride: usize, derivative: bool) -> f64 {
    let count = reference.len().min(recorded.len().saturating_sub(offset));
    let begin = if derivative { stride.max(1) } else { 0 };
    let mut left_sum = 0.0;
    let mut right_sum = 0.0;
    let mut observed = 0_usize;
    for index in (begin..count).step_by(stride.max(1)) {
        let left = if derivative {
            f64::from(reference[index]) - f64::from(reference[index - 1])
        } else { f64::from(reference[index]) };
        let right_index = offset + index;
        let right = if derivative {
            f64::from(recorded[right_index]) - f64::from(recorded[right_index - 1])
        } else { f64::from(recorded[right_index]) };
        left_sum += left;
        right_sum += right;
        observed += 1;
    }
    if observed < 32 { return 0.0; }
    let left_mean = left_sum / observed as f64;
    let right_mean = right_sum / observed as f64;
    let (mut numerator, mut left_energy, mut right_energy) = (0.0, 0.0, 0.0);
    for index in (begin..count).step_by(stride.max(1)) {
        let left = (if derivative {
            f64::from(reference[index]) - f64::from(reference[index - 1])
        } else { f64::from(reference[index]) }) - left_mean;
        let right_index = offset + index;
        let right = (if derivative {
            f64::from(recorded[right_index]) - f64::from(recorded[right_index - 1])
        } else { f64::from(recorded[right_index]) }) - right_mean;
        numerator += left * right;
        left_energy += left * left;
        right_energy += right * right;
    }
    let denominator = (left_energy * right_energy).sqrt();
    if denominator <= 0.0 { 0.0 } else { numerator / denominator }
}

fn signed_score(reference: &[i16], recorded: &[i16], offset: usize, stride: usize) -> (f64, f64, i8, f64) {
    let waveform = signed_correlation_at(reference, recorded, offset, stride, false);
    let derivative = signed_correlation_at(reference, recorded, offset, stride, true);
    let polarity = if waveform + derivative < 0.0 { -1 } else { 1 };
    let adjusted_waveform = waveform * f64::from(polarity);
    let adjusted_derivative = derivative * f64::from(polarity);
    let score = adjusted_waveform.max(0.0) * 0.65 + adjusted_derivative.max(0.0) * 0.35;
    (adjusted_waveform, adjusted_derivative, polarity, score)
}

fn correlation_window(reference: &[i16], recorded: &[i16], reference_start: usize, recorded_start: usize, count: usize, stride: usize, derivative: bool) -> f64 {
    signed_correlation_at(
        &reference[reference_start..reference_start + count],
        &recorded[recorded_start..recorded_start + count],
        0,
        stride,
        derivative,
    )
}

fn canonical_segment_plan(reference_length: usize, sample_rate_hz: u32) -> Result<Vec<(usize, usize, usize)>, String> {
    if reference_length < sample_rate_hz as usize * 3 {
        return Err("source reference needs at least three seconds for independent waveform segments".to_string());
    }
    let candidate_count = 9_usize;
    let samples = (sample_rate_hz as usize).min(reference_length / (candidate_count + 2));
    let available = reference_length - samples;
    let starts = (0..candidate_count).map(|index| {
        let fraction = 0.04 + 0.92 * index as f64 / (candidate_count - 1) as f64;
        (available as f64 * fraction).floor() as usize
    }).collect::<Vec<_>>();
    if starts.windows(2).any(|pair| pair[1] < pair[0] + samples) {
        return Err("source segment plan overlaps".to_string());
    }
    Ok(starts.into_iter().enumerate().map(|(index, start)| (index, start, samples)).collect())
}

fn canonical_lag_score(reference: &[i16], recorded: &[i16], segments: &[(usize, usize, usize)], lag: usize, stride: usize) -> (f64, f64, i8, f64) {
    let (waveform, derivative) = segments.iter().fold((0.0, 0.0), |(waveform, derivative), (_, start, count)| (
        waveform + correlation_window(reference, recorded, *start, *start + lag, *count, stride, false),
        derivative + correlation_window(reference, recorded, *start, *start + lag, *count, stride, true),
    ));
    let waveform = waveform / segments.len() as f64;
    let derivative = derivative / segments.len() as f64;
    let polarity = if waveform < 0.0 { -1 } else { 1 };
    let waveform = waveform * f64::from(polarity);
    let derivative = derivative * f64::from(polarity);
    (waveform, derivative, polarity, waveform.max(0.0) * 0.65 + derivative.max(0.0) * 0.35)
}

fn canonical_global(reference: &[i16], recorded: &[i16], segments: &[(usize, usize, usize)], sample_rate_hz: u32) -> Result<(usize, usize, i8), String> {
    let (_, last_start, last_samples) = segments.last().copied().unwrap();
    let fit = recorded.len().checked_sub(last_start + last_samples)
        .ok_or_else(|| "physical source window is shorter than the required canonical segments".to_string())?;
    let maximum_lag = fit.min(sample_rate_hz as usize * 15);
    let mut best = (0_usize, 1_i8, -1.0_f64);
    for lag in (0..=maximum_lag).step_by(80) {
        let (_, _, polarity, score) = canonical_lag_score(reference, recorded, segments, lag, 32);
        if score > best.2 { best = (lag, polarity, score); }
    }
    for lag in best.0.saturating_sub(80)..=maximum_lag.min(best.0 + 80) {
        let (_, _, polarity, score) = canonical_lag_score(reference, recorded, segments, lag, 8);
        if score > best.2 { best = (lag, polarity, score); }
    }
    Ok((best.0, maximum_lag, best.1))
}

fn evaluate_canonical_candidate(
    reference: &[i16], recorded: &[i16], anchor: usize, fragment_samples: usize,
    reference_offset: usize, lag: usize, stride: usize, polarity: i8,
    best: &mut Option<(usize, usize, f64, f64, f64)>,
) {
    let reference_start = anchor + reference_offset;
    let recorded_start = reference_start + lag;
    if reference_start + fragment_samples > reference.len() || recorded_start + fragment_samples > recorded.len() { return; }
    let waveform = correlation_window(reference, recorded, reference_start, recorded_start, fragment_samples, stride, false) * f64::from(polarity);
    let derivative = correlation_window(reference, recorded, reference_start, recorded_start, fragment_samples, stride, true) * f64::from(polarity);
    let score = waveform.max(0.0) * 0.65 + derivative.max(0.0) * 0.35;
    if best.as_ref().is_none_or(|entry| score > entry.4) { *best = Some((reference_offset, lag, waveform, derivative, score)); }
}

fn canonical_candidates(reference: &[i16], recorded: &[i16], segments: &[(usize, usize, usize)], anchor_lag: usize, polarity: i8, sample_rate_hz: u32) -> Result<Vec<CanonicalWaveformCandidate>, String> {
    let fragment_samples = (sample_rate_hz as usize) / 5;
    let offset_step = (sample_rate_hz as usize) / 20;
    let lag_radius = (sample_rate_hz as usize) / 5;
    segments.iter().map(|(index, anchor, segment_samples)| {
        let minimum_lag = anchor_lag.saturating_sub(lag_radius);
        let maximum_lag = (anchor_lag + lag_radius).min(recorded.len().saturating_sub(anchor + fragment_samples));
        let mut best: Option<(usize, usize, f64, f64, f64)> = None;
        for reference_offset in (0..=segment_samples - fragment_samples).step_by(offset_step) {
            for lag in (minimum_lag..=maximum_lag).step_by(80) { evaluate_canonical_candidate(reference, recorded, *anchor, fragment_samples, reference_offset, lag, 8, polarity, &mut best); }
        }
        let coarse = best.ok_or_else(|| "physical waveform candidate has no complete clock-bounded fragment".to_string())?;
        for lag in (coarse.1.saturating_sub(80).max(minimum_lag)..=maximum_lag.min(coarse.1 + 80)).step_by(4) { evaluate_canonical_candidate(reference, recorded, *anchor, fragment_samples, coarse.0, lag, 4, polarity, &mut best); }
        let refined = best.unwrap();
        for lag in refined.1.saturating_sub(4).max(minimum_lag)..=maximum_lag.min(refined.1 + 4) { evaluate_canonical_candidate(reference, recorded, *anchor, fragment_samples, refined.0, lag, 2, polarity, &mut best); }
        let (reference_offset, lag, waveform, derivative, _) = best.unwrap();
        let reference_start = anchor + reference_offset;
        let recorded_start = reference_start + lag;
        let reference_energy = reference[reference_start..reference_start + fragment_samples].iter().map(|value| f64::from(*value).powi(2)).sum::<f64>();
        let recorded_energy = recorded[recorded_start..recorded_start + fragment_samples].iter().map(|value| f64::from(*value).powi(2)).sum::<f64>();
        Ok(CanonicalWaveformCandidate {
            index: *index, anchor_reference_start_sample: *anchor, reference_offset_sample: reference_offset,
            reference_start_sample: reference_start, recorded_start_sample: recorded_start, samples: fragment_samples,
            anchor_lag_samples: anchor_lag, local_lag_samples: lag, local_lag_delta_samples: lag as i64 - anchor_lag as i64,
            waveform_correlation: rounded(waveform, 6), derivative_correlation: rounded(derivative, 6),
            energy_ratio: rounded(if reference_energy > 0.0 { (recorded_energy / reference_energy).sqrt() } else { 0.0 }, 6),
        })
    }).collect()
}

fn wrong_reference_score(reference: &[i16], recorded: &[i16], sample_rate_hz: u32) -> Result<f64, String> {
    let comparison_length = reference.len().min(recorded.len().saturating_sub(sample_rate_hz as usize));
    let segments = canonical_segment_plan(comparison_length, sample_rate_hz)?;
    let (lag, _, polarity) = canonical_global(reference, recorded, &segments, sample_rate_hz)?;
    let mut candidates = canonical_candidates(reference, recorded, &segments, lag, polarity, sample_rate_hz)?;
    candidates.sort_by(|left, right| {
        let left = left.waveform_correlation * 0.65 + left.derivative_correlation * 0.35;
        let right = right.waveform_correlation * 0.65 + right.derivative_correlation * 0.35;
        right.total_cmp(&left)
    });
    let mut waveform = candidates[..3].iter().map(|entry| entry.waveform_correlation).collect::<Vec<_>>();
    let mut derivative = candidates[..3].iter().map(|entry| entry.derivative_correlation).collect::<Vec<_>>();
    waveform.sort_by(f64::total_cmp);
    derivative.sort_by(f64::total_cmp);
    Ok(waveform[1].max(0.0) * 0.65 + derivative[1].max(0.0) * 0.35)
}

pub fn analyze_canonical_waveform(reference: &[i16], recorded: &[i16], wrong_references: &[(String, Vec<i16>)], sample_rate_hz: u32) -> Result<CanonicalWaveformMetrics, String> {
    let comparison_length = reference.len().min(recorded.len().saturating_sub(sample_rate_hz as usize));
    let segments = canonical_segment_plan(comparison_length, sample_rate_hz)?;
    let (lag, maximum_lag, polarity) = canonical_global(reference, recorded, &segments, sample_rate_hz)?;
    let candidates = canonical_candidates(reference, recorded, &segments, lag, polarity, sample_rate_hz)?;
    let mut controls = wrong_references.to_vec();
    if controls.is_empty() {
        controls = [733.0, 1211.0].into_iter().map(|frequency| {
            let samples = (0..reference.len()).map(|index| {
                let envelope = 0.7 + 0.3 * (2.0 * std::f64::consts::PI * 3.0 * index as f64 / sample_rate_hz as f64).sin();
                ((2.0 * std::f64::consts::PI * frequency * index as f64 / sample_rate_hz as f64).sin() * 8_000.0 * envelope).round() as i16
            }).collect();
            (format!("deterministic-{}hz-control", frequency as u32), samples)
        }).collect();
    }
    let wrong_references = controls.into_iter().map(|(label, samples)| Ok(CanonicalWrongReferenceMetric {
        label, score: rounded(wrong_reference_score(&samples, recorded, sample_rate_hz)?, 6),
    })).collect::<Result<Vec<_>, String>>()?;
    Ok(CanonicalWaveformMetrics { sample_rate_hz, global_lag_samples: lag, maximum_lag_samples: maximum_lag, global_polarity: polarity, candidates, wrong_references })
}

pub fn render_bridge_reference_to_loopback(interleaved: &[i16], channels: usize, source_rate_hz: u32) -> Result<Vec<f64>, String> {
    if channels == 0 || interleaved.len() % channels != 0 || source_rate_hz == 0 {
        return Err("translated PCM channel count, sample count, or sample rate is invalid".to_string());
    }
    let mono = interleaved.chunks_exact(channels).map(|frame| {
        frame.iter().map(|sample| f64::from(*sample) / 32768.0).sum::<f64>() / channels as f64
    }).collect::<Vec<_>>();
    if mono.is_empty() { return Err("translated PCM contains no frames".to_string()); }
    let bridge_rate = 48_000_u32;
    let bridge_length = (mono.len() as u64 * u64::from(bridge_rate) / u64::from(source_rate_hz)).max(1) as usize;
    let bridge = (0..bridge_length).map(|index| {
        let source = (index as u64 * u64::from(source_rate_hz) / u64::from(bridge_rate)) as usize;
        mono[source.min(mono.len() - 1)]
    }).collect::<Vec<_>>();
    let output_length = (bridge.len() as u64 * 16_000 / u64::from(bridge_rate)).max(1) as usize;
    Ok((0..output_length).map(|index| {
        let position = index as f64 * bridge_rate as f64 / 16_000.0;
        let left = (position.floor() as usize).min(bridge.len() - 1);
        let right = (left + 1).min(bridge.len() - 1);
        bridge[left] + (bridge[right] - bridge[left]) * (position - left as f64)
    }).collect())
}

fn translated_pearson(reference: &[f64], recording: &[i16], recording_start: i64, reference_start: usize, length: usize, stride: usize, derivative: bool) -> f64 {
    let begin = if derivative { stride.max(1) } else { 0 };
    let (mut sum_left, mut sum_right, mut sum_left_squared, mut sum_right_squared, mut sum_products) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut count = 0_usize;
    for offset in (begin..length).step_by(stride.max(1)) {
        let reference_index = reference_start + offset;
        let recording_index = recording_start + offset as i64;
        if reference_index >= reference.len() || recording_index < 0 || recording_index as usize >= recording.len() { break; }
        let left = if derivative { reference[reference_index] - reference[reference_index - 1] } else { reference[reference_index] };
        let right = if derivative {
            (f64::from(recording[recording_index as usize]) - f64::from(recording[recording_index as usize - 1])) / 32768.0
        } else { f64::from(recording[recording_index as usize]) / 32768.0 };
        sum_left += left;
        sum_right += right;
        sum_left_squared += left * left;
        sum_right_squared += right * right;
        sum_products += left * right;
        count += 1;
    }
    if count < 80 { return 0.0; }
    let count = count as f64;
    let numerator = sum_products - sum_left * sum_right / count;
    let left_energy = sum_left_squared - sum_left * sum_left / count;
    let right_energy = sum_right_squared - sum_right * sum_right / count;
    let denominator = (left_energy * right_energy).sqrt();
    if denominator <= 1e-10 { 0.0 } else { numerator / denominator }
}

fn translated_median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 1 { values[middle] } else { (values[middle - 1] + values[middle]) / 2.0 }
}

pub fn analyze_translated_loopback(reference_interleaved: &[i16], channels: usize, source_rate_hz: u32, recording: &[i16], expected_start: i64) -> Result<TranslatedLoopbackMetrics, String> {
    analyze_translated_loopback_in_radius(
        reference_interleaved,
        channels,
        source_rate_hz,
        recording,
        expected_start,
        24_000,
    )
}

pub fn analyze_translated_loopback_in_radius(
    reference_interleaved: &[i16],
    channels: usize,
    source_rate_hz: u32,
    recording: &[i16],
    expected_start: i64,
    search_radius_samples: i64,
) -> Result<TranslatedLoopbackMetrics, String> {
    if search_radius_samples < 0 {
        return Err("translated loopback search radius cannot be negative".to_string());
    }
    let reference = render_bridge_reference_to_loopback(reference_interleaved, channels, source_rate_hz)?;
    let segment_length = reference.len().min(11_200);
    if segment_length < 6_400 { return Err("translated cue is shorter than 400 ms".to_string()); }
    let maximum = reference.len().saturating_sub(segment_length);
    let mut starts = [0.08, 0.5, 0.9].into_iter().map(|fraction| (maximum as f64 * fraction).round() as usize).collect::<Vec<_>>();
    starts.sort_unstable();
    starts.dedup();
    let evaluate = |lag: i64| -> Option<(i64, i8, f64, f64, f64, f64, f64, Vec<(usize, i64, f64, f64)>)> {
        let stride = (segment_length / 12_000).max(1);
        let mut raw = Vec::new();
        for start in &starts {
            let recording_start = expected_start + lag + *start as i64;
            if recording_start < 0 || recording_start + segment_length as i64 > recording.len() as i64 { return None; }
            raw.push((*start, recording_start,
                translated_pearson(&reference, recording, recording_start, *start, segment_length, stride, false),
                translated_pearson(&reference, recording, recording_start, *start, segment_length, stride, true)));
        }
        let polarity = if translated_median(raw.iter().map(|entry| entry.2).collect()) + translated_median(raw.iter().map(|entry| entry.3).collect()) < 0.0 { -1 } else { 1 };
        for entry in &mut raw { entry.2 *= f64::from(polarity); entry.3 *= f64::from(polarity); }
        let waveform_median = translated_median(raw.iter().map(|entry| entry.2).collect());
        let derivative_median = translated_median(raw.iter().map(|entry| entry.3).collect());
        let waveform_minimum = raw.iter().map(|entry| entry.2).fold(f64::INFINITY, f64::min);
        let derivative_minimum = raw.iter().map(|entry| entry.3).fold(f64::INFINITY, f64::min);
        Some((lag, polarity, waveform_median, derivative_median, waveform_minimum, derivative_minimum, waveform_median.min(derivative_median), raw))
    };
    let radius = search_radius_samples;
    let prefilter_length = segment_length.min(3_200);
    let prefilter_start = starts[0];
    let mut candidates: Vec<(i64, f64)> = Vec::new();
    for lag in -radius..=radius {
        let recording_start = expected_start + lag + prefilter_start as i64;
        if recording_start < 0 || recording_start + prefilter_length as i64 > recording.len() as i64 { continue; }
        let score = translated_pearson(&reference, recording, recording_start, prefilter_start, prefilter_length, 8, false).abs()
            + translated_pearson(&reference, recording, recording_start, prefilter_start, prefilter_length, 8, true).abs();
        if candidates.len() < 12 || score > candidates[0].1 {
            candidates.push((lag, score));
            candidates.sort_by(|left, right| left.1.total_cmp(&right.1));
            if candidates.len() > 12 { candidates.remove(0); }
        }
    }
    let mut best = candidates.into_iter().filter_map(|entry| evaluate(entry.0)).max_by(|left, right| left.6.total_cmp(&right.6))
        .ok_or_else(|| "no complete physical search window".to_string())?;
    let refine_start = (best.0 - 2).max(-radius);
    let refine_end = (best.0 + 2).min(radius);
    for lag in refine_start..=refine_end {
        if let Some(candidate) = evaluate(lag) { if candidate.6 > best.6 { best = candidate; } }
    }
    let timing = best.0 as f64 / 16_000.0;
    let segment_matches = best.7.iter().map(|entry| TranslatedLoopbackSegment {
        reference_offset_seconds: rounded(entry.0 as f64 / 16_000.0, 6),
        recording_offset_seconds: rounded(entry.1 as f64 / 16_000.0, 6),
        timing_error_seconds: rounded(timing, 6), waveform_correlation: rounded(entry.2, 6), derivative_correlation: rounded(entry.3, 6),
    }).collect();
    Ok(TranslatedLoopbackMetrics {
        reference_samples: reference.len(), score: rounded(best.6, 6), waveform_median: rounded(best.2, 6),
        waveform_minimum: rounded(best.4, 6), derivative_median: rounded(best.3, 6), derivative_minimum: rounded(best.5, 6),
        polarity: best.1, global_lag_samples: best.0, timing_error_seconds: rounded(timing, 6),
        matched_start_sample: expected_start + best.0, matched_end_sample: expected_start + best.0 + reference.len() as i64,
        segment_matches,
    })
}

pub fn compare_signed_pcm(reference: &[i16], recorded: &[i16], sample_rate_hz: u32) -> SignedPcmSimilarity {
    if reference.is_empty() || recorded.is_empty() {
        return SignedPcmSimilarity {
            sample_rate_hz, reference_samples: reference.len(), recorded_samples: recorded.len(),
            compared_samples: 0, best_offset_samples: 0, best_offset_seconds: 0.0,
            polarity: 1, waveform_correlation: 0.0, derivative_correlation: 0.0, energy_ratio: 0.0,
        };
    }
    let maximum_offset = recorded.len().saturating_sub(32).min(sample_rate_hz as usize * 15);
    let coarse_step = 80_usize;
    let coarse_stride = (reference.len().min(recorded.len()) / 12_000).max(8);
    let mut best = (0_usize, 0.0, 0.0, 1_i8, -1.0_f64);
    for offset in (0..=maximum_offset).step_by(coarse_step) {
        let (waveform, derivative, polarity, score) = signed_score(reference, recorded, offset, coarse_stride);
        if score > best.4 { best = (offset, waveform, derivative, polarity, score); }
    }
    let refine_start = best.0.saturating_sub(coarse_step);
    let refine_end = maximum_offset.min(best.0 + coarse_step);
    let fine_stride = (reference.len().min(recorded.len()) / 24_000).max(1);
    for offset in refine_start..=refine_end {
        let (waveform, derivative, polarity, score) = signed_score(reference, recorded, offset, fine_stride);
        if score > best.4 { best = (offset, waveform, derivative, polarity, score); }
    }
    let compared = reference.len().min(recorded.len().saturating_sub(best.0));
    let reference_energy = reference[..compared].iter().map(|value| f64::from(*value).powi(2)).sum::<f64>();
    let recorded_energy = recorded[best.0..best.0 + compared].iter().map(|value| f64::from(*value).powi(2)).sum::<f64>();
    let energy_ratio = if reference_energy > 0.0 { (recorded_energy / reference_energy).sqrt() } else { 0.0 };
    SignedPcmSimilarity {
        sample_rate_hz,
        reference_samples: reference.len(),
        recorded_samples: recorded.len(),
        compared_samples: compared,
        best_offset_samples: best.0 as i64,
        best_offset_seconds: rounded(best.0 as f64 / f64::from(sample_rate_hz.max(1)), 6),
        polarity: best.3,
        waveform_correlation: rounded(best.1, 6),
        derivative_correlation: rounded(best.2, 6),
        energy_ratio: rounded(energy_ratio, 6),
    }
}

pub fn compare_pcm(reference: &[i16], recorded: &[i16], sample_rate_hz: u32) -> PcmSimilarity {
    let frame_samples = ((f64::from(sample_rate_hz) * 0.02).floor() as usize).max(80);
    let reference = rms_envelope(reference, frame_samples);
    let recorded = rms_envelope(recorded, frame_samples);
    if reference.len() < 40 || recorded.len() < 40 {
        return PcmSimilarity {
            passed: false,
            error: Some("not enough PCM frames for similarity analysis".to_string()),
            sample_rate_hz,
            frame_milliseconds: rounded(frame_samples as f64 * 1000.0 / f64::from(sample_rate_hz.max(1)), 3),
            reference_frames: reference.len(),
            recorded_frames: recorded.len(),
            compared_frames: 0,
            best_offset_frames: 0,
            best_offset_seconds: 0.0,
            envelope_correlation: -1.0,
            level_ratio: 0.0,
            detail: None,
        };
    }

    let max_offset = recorded.len().saturating_sub(20)
        .min((u64::from(sample_rate_hz) * 8 / frame_samples as u64) as usize);
    let mut best_correlation = -1.0_f64;
    let mut best_offset = 0;
    let mut best_count = 0;
    for offset in 0..=max_offset {
        let count = reference.len().min(recorded.len() - offset);
        if count < 40 {
            continue;
        }
        let correlation = pearson_correlation(&reference[..count], &recorded[offset..offset + count]);
        if correlation > best_correlation {
            best_correlation = correlation;
            best_offset = offset;
            best_count = count;
        }
    }
    let reference_mean = reference.iter().sum::<f64>() / reference.len() as f64;
    let recorded_mean = recorded.iter().sum::<f64>() / recorded.len() as f64;
    let level_ratio = if reference_mean > 0.0 { recorded_mean / reference_mean } else { 0.0 };
    let passed = best_correlation >= 0.35 && (0.05..=8.0).contains(&level_ratio);
    let detail = (!passed).then(|| format!(
        "physical output original passthrough does not resemble source media reference: correlation={} levelRatio={}",
        rounded(best_correlation, 4),
        rounded(level_ratio, 4)
    ));
    PcmSimilarity {
        passed,
        error: None,
        sample_rate_hz,
        frame_milliseconds: rounded(frame_samples as f64 * 1000.0 / f64::from(sample_rate_hz.max(1)), 3),
        reference_frames: reference.len(),
        recorded_frames: recorded.len(),
        compared_frames: best_count,
        best_offset_frames: best_offset,
        best_offset_seconds: rounded(best_offset as f64 * frame_samples as f64 / f64::from(sample_rate_hz.max(1)), 3),
        envelope_correlation: rounded(best_correlation, 4),
        level_ratio: rounded(level_ratio, 4),
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_detects_silence_and_clipping_without_rejecting_silence() {
        let silence = analyze_pcm(&vec![0; 16_000], 16_000);
        assert!(silence.passed);
        assert_eq!(silence.non_silent_ratio, 0.0);
        let clipped = analyze_pcm(&vec![i16::MAX; 16_000], 16_000);
        assert!(!clipped.passed);
        assert_eq!(clipped.clipping_ratio, 1.0);
    }

    #[test]
    fn similarity_finds_a_delayed_matching_envelope() {
        let reference: Vec<i16> = (0..32_000)
            .map(|index| (((index / 320) % 8) as i16 - 4) * 2_000)
            .collect();
        let mut recorded = vec![0; 3_200];
        recorded.extend_from_slice(&reference);
        let result = compare_pcm(&reference, &recorded, 16_000);
        assert!(result.passed, "{result:?}");
        assert_eq!(result.best_offset_frames, 10);
        assert!(result.envelope_correlation > 0.99);
    }

    #[test]
    fn correlation_requires_enough_varying_frames() {
        assert_eq!(pearson_correlation(&[1.0; 11], &[1.0; 11]), 0.0);
        assert_eq!(pearson_correlation(&[1.0; 12], &[1.0; 12]), 0.0);
    }

    #[test]
    fn signed_similarity_finds_delay_and_polarity() {
        let reference: Vec<i16> = (0..16_000).map(|index| (((index * 7919) % 20_003) as i16) - 10_000).collect();
        let mut recorded = vec![0; 1_600];
        recorded.extend(reference.iter().map(|value| -*value));
        let result = compare_signed_pcm(&reference, &recorded, 16_000);
        assert_eq!(result.best_offset_samples, 1_600);
        assert_eq!(result.polarity, -1);
        assert!(result.waveform_correlation > 0.99);
        assert!(result.derivative_correlation > 0.99);
    }

    #[test]
    fn translated_loopback_finds_a_sub_millisecond_delay() {
        let reference: Vec<i16> = (0..14_400).map(|index| (((index * 7919) % 20_003) as i16) - 10_000).collect();
        let mut recording = vec![0_i16; 40_000];
        recording[8_005..8_005 + reference.len()].copy_from_slice(&reference);
        let result = analyze_translated_loopback(&reference, 1, 16_000, &recording, 8_000).unwrap();
        assert_eq!(result.global_lag_samples, 5);
        assert!(result.waveform_median > 0.99);
        assert!(result.derivative_median > 0.99);

        let fixed_window = analyze_translated_loopback_in_radius(
            &reference,
            1,
            16_000,
            &recording,
            8_000,
            0,
        )
        .unwrap();
        assert_eq!(fixed_window.global_lag_samples, 0);
        assert!(fixed_window.score < result.score);
        let adjacent_window = analyze_translated_loopback_in_radius(
            &reference,
            1,
            16_000,
            &recording,
            8_004,
            0,
        )
        .unwrap();
        assert_eq!(adjacent_window.global_lag_samples, 0);
        assert_eq!(adjacent_window.matched_start_sample, 8_004);
        assert!(adjacent_window.score < result.score);
        assert!(analyze_translated_loopback_in_radius(
            &reference,
            1,
            16_000,
            &recording,
            8_000,
            -1,
        )
        .unwrap_err()
        .contains("cannot be negative"));
    }

    #[test]
    fn fingerprint_and_quality_cover_empty_discontinuous_and_noisy_inputs() {
        let empty = analyze_pcm(&[], 16_000);
        assert!(!empty.passed);
        assert!(empty.error.as_deref().unwrap().contains("no samples"));

        let discontinuous = (0..16_000)
            .map(|index| if index % 2 == 0 { 20_000 } else { -20_000 })
            .collect::<Vec<_>>();
        let quality = analyze_pcm(&discontinuous, 16_000);
        assert!(!quality.passed);
        assert!(quality.noise_risk);
        assert!(quality.detail.as_deref().unwrap().contains("discontinuities"));

        let fingerprint = analyze_pcm_fingerprint(&discontinuous, 16_000, &[1_000.0, 3_000.0]);
        assert_eq!(fingerprint.components.len(), 2);
        assert!(fingerprint.components.iter().all(|component| component.amplitude >= 0.0));
        assert_eq!(rms_envelope(&discontinuous, 0), Vec::<f64>::new());
    }

    #[test]
    fn canonical_waveform_finds_distributed_segments_and_rejects_short_inputs() {
        let sample_rate = 800;
        let mut state = 0x1234_5678_u32;
        let reference = (0..12_000)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 16) as i16) / 2
            })
            .collect::<Vec<_>>();
        let mut recorded = vec![0_i16; 200];
        recorded.extend_from_slice(&reference);
        recorded.extend_from_slice(&vec![0_i16; sample_rate as usize]);

        let result = analyze_canonical_waveform(&reference, &recorded, &[], sample_rate).unwrap();
        assert!(result.global_lag_samples <= 400);
        assert!(matches!(result.global_polarity, -1 | 1));
        assert_eq!(result.candidates.len(), 9);
        assert_eq!(result.wrong_references.len(), 2);
        assert!(result.candidates.iter().all(|candidate| candidate.waveform_correlation.is_finite()));

        let error = analyze_canonical_waveform(&reference[..1_000], &recorded, &[], sample_rate)
            .unwrap_err();
        assert!(error.contains("at least three seconds"));
    }

    #[test]
    fn translated_render_rejects_invalid_shapes_and_resamples_stereo() {
        assert!(render_bridge_reference_to_loopback(&[1, 2], 0, 16_000).is_err());
        assert!(render_bridge_reference_to_loopback(&[1, 2, 3], 2, 16_000).is_err());
        assert!(render_bridge_reference_to_loopback(&[], 1, 16_000).is_err());
        let rendered = render_bridge_reference_to_loopback(&[1_000, 3_000, -1_000, 1_000], 2, 8_000).unwrap();
        assert_eq!(rendered.len(), 4);
        assert!((rendered[0] - 2_000.0 / 32_768.0).abs() < 1e-9);

        let too_short = analyze_translated_loopback(&vec![1; 1_000], 1, 16_000, &vec![0; 20_000], 0)
            .unwrap_err();
        assert!(too_short.contains("shorter than 400 ms"));
        let empty_signed = compare_signed_pcm(&[], &[], 16_000);
        assert_eq!(empty_signed.compared_samples, 0);
        let short_similarity = compare_pcm(&[0; 100], &[0; 100], 16_000);
        assert!(short_similarity.error.as_deref().unwrap().contains("not enough PCM frames"));
    }
}
