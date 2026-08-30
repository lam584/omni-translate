// Process-loopback source frames can be dropped before they reach the
// diagnostic subscriber. Preserve each 20 ms payload boundary: concatenating
// the surviving chunks removes clock gaps and can cancel an otherwise strong
// coherent tone in one whole-recording Fourier projection.

const REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS: usize = 50;

fn payload_window_component_amplitude(samples: &[f32], frequency_hz: f32) -> f32 {
    if samples.len() < 2 {
        return 0.0;
    }
    let omega = TAU * frequency_hz / SAMPLE_RATE as f32;
    let denominator = (samples.len() - 1) as f32;
    let mut real = 0.0_f64;
    let mut imaginary = 0.0_f64;
    let mut weight_sum = 0.0_f64;
    for (index, sample) in samples.iter().enumerate() {
        let weight = 0.5 - 0.5 * (TAU * index as f32 / denominator).cos();
        let angle = omega as f64 * index as f64;
        real += *sample as f64 * weight as f64 * angle.cos();
        imaginary -= *sample as f64 * weight as f64 * angle.sin();
        weight_sum += weight as f64;
    }
    (2.0 * (real * real + imaginary * imaginary).sqrt() / weight_sum.max(f64::EPSILON))
        as f32
}

fn payload_window_isolated_component_amplitude(
    samples: &[f32],
    frequency_hz: f32,
) -> IsolatedComponentAmplitude {
    // A 20 ms Hann window has a much wider main lobe than the whole-recording
    // probe. Keep the noise samples at least 175 Hz away while remaining well
    // clear of every other diagnostic fingerprint (the closest pair is 716 Hz).
    const LOCAL_OFFSETS_HZ: [f32; 8] = [
        -400.0, -325.0, -250.0, -175.0, 175.0, 250.0, 325.0, 400.0,
    ];
    let raw = payload_window_component_amplitude(samples, frequency_hz);
    let mut nearby = LOCAL_OFFSETS_HZ.map(|offset| {
        payload_window_component_amplitude(samples, (frequency_hz + offset).max(20.0))
    });
    nearby.sort_by(f32::total_cmp);
    let middle = nearby.len() / 2;
    let local_noise_floor = (nearby[middle - 1] + nearby[middle]) * 0.5;
    IsolatedComponentAmplitude {
        raw,
        local_noise_floor,
        isolated: (raw - local_noise_floor).max(0.0),
    }
}

fn sustained_component_amplitude(chunks: &[Vec<f32>], frequency_hz: f32) -> Option<f32> {
    let mut components = chunks
        .iter()
        .filter(|chunk| chunk.len() >= CHANNELS)
        .map(|chunk| {
            payload_window_component_amplitude(&first_channel_samples(chunk), frequency_hz)
        })
        .collect::<Vec<_>>();
    if components.len() < REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS {
        return None;
    }
    components.sort_by(|left, right| right.total_cmp(left));
    Some(components[REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS - 1])
}

fn sustained_isolated_component_amplitude(
    chunks: &[Vec<f32>],
    frequency_hz: f32,
) -> Option<IsolatedComponentAmplitude> {
    let mut components = chunks
        .iter()
        .filter(|chunk| chunk.len() >= CHANNELS)
        .map(|chunk| {
            payload_window_isolated_component_amplitude(
                &first_channel_samples(chunk),
                frequency_hz,
            )
        })
        .collect::<Vec<_>>();
    if components.len() < REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS {
        return None;
    }
    components.sort_by(|left, right| right.isolated.total_cmp(&left.isolated));
    Some(components[REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS - 1])
}

#[cfg(test)]
mod process_exclusion_detectability_tests {
    use super::*;

    fn every_other_tone_chunk(frequency_hz: f32) -> Vec<Vec<f32>> {
        let frames_per_chunk = 960;
        let chunk_count = (PROCESS_FINGERPRINT_SECONDS * SAMPLE_RATE as f32) as usize
            / frames_per_chunk;
        (0..chunk_count)
            .filter(|chunk_index| chunk_index % 2 == 0)
            .map(|chunk_index| {
                (0..frames_per_chunk)
                    .flat_map(|frame| {
                        let absolute_frame = chunk_index * frames_per_chunk + frame;
                        let sample = PROCESS_FINGERPRINT_AMPLITUDE
                            * (TAU * frequency_hz * absolute_frame as f32 / SAMPLE_RATE as f32)
                                .sin();
                        [sample, sample]
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn dropped_chunk_phase_gaps_cannot_erase_a_sustained_fingerprint() {
        for frequency_hz in [
            PROCESS_TRANSLATION_FINGERPRINT_HZ,
            PROCESS_EXTERNAL_FINGERPRINT_HZ,
            PROCESS_CHILD_FINGERPRINT_HZ,
        ] {
            let chunks = every_other_tone_chunk(frequency_hz);
            let concatenated = chunks.iter().flatten().copied().collect::<Vec<_>>();
            let old_whole_recording_component =
                component_amplitude(&first_channel_samples(&concatenated), frequency_hz);
            assert!(
                old_whole_recording_component < MIN_PROCESS_FINGERPRINT_COMPONENT,
                "fixture must deterministically falsify the old whole-recording oracle: frequency={frequency_hz} component={old_whole_recording_component}"
            );
            let sustained = sustained_component_amplitude(&chunks, frequency_hz)
                .expect("six seconds with alternate drops retains 150 auditable chunks");
            assert!(
                sustained > 0.3,
                "payload-window authority lost a sustained tone: frequency={frequency_hz} component={sustained}"
            );
        }
    }

    #[test]
    fn payload_window_authority_still_rejects_excluded_tone_leakage() {
        let external_chunks = every_other_tone_chunk(PROCESS_EXTERNAL_FINGERPRINT_HZ);
        for excluded_frequency_hz in [
            PROCESS_TRANSLATION_FINGERPRINT_HZ,
            PROCESS_CHILD_FINGERPRINT_HZ,
        ] {
            let evidence = sustained_isolated_component_amplitude(
                &external_chunks,
                excluded_frequency_hz,
            )
            .expect("external fixture retains enough chunks");
            assert!(
                evidence.isolated <= MAX_EXCLUDED_TRANSLATION_COMPONENT,
                "external tone was misclassified as excluded leakage: frequency={excluded_frequency_hz} evidence={evidence:?}"
            );
        }

        let leaked_translation =
            every_other_tone_chunk(PROCESS_TRANSLATION_FINGERPRINT_HZ);
        let evidence = sustained_isolated_component_amplitude(
            &leaked_translation,
            PROCESS_TRANSLATION_FINGERPRINT_HZ,
        )
        .expect("leak fixture retains enough chunks");
        assert!(
            evidence.isolated > MAX_EXCLUDED_TRANSLATION_COMPONENT,
            "a real excluded translation leak escaped the payload-window oracle: {evidence:?}"
        );
    }
}
