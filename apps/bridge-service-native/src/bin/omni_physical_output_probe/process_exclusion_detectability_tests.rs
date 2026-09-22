mod detectability_tests {
    use super::*;

    #[test]
    fn low_gain_spdif_translation_is_detectable_relative_to_the_external_tone() {
        let evidence = omni_bridge_service::probe_support::IsolatedComponentAmplitude {
            raw: 0.006623,
            local_noise_floor: 0.000020,
            isolated: 0.006603,
        };
        assert!(physical_translation_is_detectable(&evidence, 0.013282, 50));
    }

    #[test]
    fn silence_cannot_pass_relative_physical_detectability() {
        let evidence = omni_bridge_service::probe_support::IsolatedComponentAmplitude {
            raw: 0.0,
            local_noise_floor: 0.0,
            isolated: 0.0,
        };
        assert!(!physical_translation_is_detectable(&evidence, 0.013282, 50));
    }

    #[test]
    fn local_spectral_noise_without_margin_is_not_translation_evidence() {
        let evidence = omni_bridge_service::probe_support::IsolatedComponentAmplitude {
            raw: 0.000900,
            local_noise_floor: 0.000800,
            isolated: 0.000100,
        };
        assert!(!physical_translation_is_detectable(&evidence, 0.013282, 50));
    }

    #[test]
    fn diagnostic_fingerprint_amplitude_keeps_three_tones_below_clipping() {
        assert!(PROCESS_FINGERPRINT_AMPLITUDE >= 0.36);
        // Two full-level external/child tones plus the 50%-level Bridge tone.
        assert!(PROCESS_FINGERPRINT_AMPLITUDE * 2.5 < 1.0);
    }

    #[test]
    fn delivered_source_frame_is_already_process_capture_readiness() {
        let state = json!({
            "captureLifecycleState": "source-frame-delivered",
            "captureFramesReceived": 960,
            "sourceSubscriberActive": true,
            "processLoopbackStatus": "ready",
        });
        assert!(process_capture_state_is_ready(&state));
    }

    #[test]
    fn delivered_lifecycle_without_frames_is_not_process_capture_readiness() {
        let state = json!({
            "captureLifecycleState": "source-frame-delivered",
            "captureFramesReceived": 0,
            "sourceSubscriberActive": true,
            "processLoopbackStatus": "ready",
        });
        assert!(!process_capture_state_is_ready(&state));
    }
}

// Pure PCM fixtures: no endpoints, processes, or Provider calls.
mod physical_window_tests {
    use super::*;

    const WINDOW: usize = 960;

    fn tone(frequency: f32, windows: usize, discontinuous: bool) -> Vec<f32> {
        (0..windows * WINDOW).map(|i| {
            // One-second blocks have integer tone cycles. Alternating their sign
            // gives exact coherent cancellation while preserving local energy.
            let sign = if discontinuous && (i / SAMPLE_RATE) % 2 == 1 { -1.0 } else { 1.0 };
            sign * 0.36 * (std::f64::consts::TAU * frequency as f64
                * i as f64 / SAMPLE_RATE as f64).sin() as f32
        }).collect()
    }

    #[test]
    fn physical_phase_discontinuity_retains_sustained_presence() {
        for frequency in [997.0, 1733.0, 2449.0] {
            let samples = tone(frequency, 300, true);
            assert!(component_amplitude(&samples, frequency) < 0.01);
            let evidence = physical_fingerprint_evidence(&samples, frequency);
            assert!(evidence.isolated > 0.35, "frequency={frequency}: {evidence:?}");
        }
    }

    #[test]
    fn physical_absent_and_wrong_tone_are_not_presence() {
        for samples in [vec![0.0; 300 * WINDOW], tone(1733.0, 300, false)] {
            assert!(physical_fingerprint_evidence(&samples, 2449.0).isolated < 0.01);
        }
    }

    #[test]
    fn physical_brief_tone_or_spike_is_not_sustained_presence() {
        for windows in [1, 49] {
            let mut samples = tone(2449.0, windows, false);
            samples.resize(300 * WINDOW, 0.0);
            assert!(physical_fingerprint_evidence(&samples, 2449.0).isolated < 0.01,
                "{windows} windows must not establish one second of presence");
        }
        let mut spike = vec![0.0; 300 * WINDOW];
        spike[WINDOW / 2] = 1.0;
        assert!(physical_fingerprint_evidence(&spike, 2449.0).isolated < 0.01);
    }

    #[test]
    fn physical_deterministic_broadband_noise_is_not_presence() {
        let mut seed = 0x12345678_u32;
        let samples = (0..300 * WINDOW).map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32 * 0.36
        }).collect::<Vec<_>>();
        assert!(physical_fingerprint_evidence(&samples, 2449.0).isolated < 0.01);
    }

    #[test]
    fn physical_requires_fifty_complete_windows() {
        assert!(physical_fingerprint_evidence(&tone(2449.0, 49, false), 2449.0).isolated < 0.01);
        assert!(physical_fingerprint_evidence(&tone(2449.0, 50, false), 2449.0).isolated > 0.35);
        let mut short = tone(2449.0, 50, false);
        short.pop();
        assert!(physical_fingerprint_evidence(&short, 2449.0).isolated < 0.01);
    }
}

mod physical_gain_and_replay_tests {
    use super::*;

    fn mixed_window(translation: f32, external: f32) -> Vec<f32> {
        (0..PHYSICAL_FINGERPRINT_WINDOW_FRAMES).map(|i| {
            let t = std::f64::consts::TAU * i as f64 / SAMPLE_RATE as f64;
            translation * (t * 997.0).sin() as f32
                + external * (t * 1733.0).sin() as f32
        }).collect()
    }

    fn gain_passes(samples: &[f32]) -> bool {
        let (translation, external) = physical_translation_window_evidence(samples, 50);
        external >= MIN_PROCESS_FINGERPRINT_COMPONENT
            && physical_translation_is_detectable(&translation, external, 50)
    }

    #[test]
    fn physical_gain_requires_coincident_reference_and_sustained_gain() {
        assert!(gain_passes(&mixed_window(0.18, 0.36).repeat(50)));
        assert!(!gain_passes(&mixed_window(0.08, 0.36).repeat(300)));
        let separated = [mixed_window(0.18, 0.0).repeat(150),
            mixed_window(0.0, 0.36).repeat(150)].concat();
        assert!(!gain_passes(&separated), "noncoincident tones cannot establish gain");
        let mut brief = mixed_window(0.18, 0.36).repeat(49);
        brief.extend(mixed_window(0.08, 0.36).repeat(251));
        assert!(!gain_passes(&brief), "49 passing windows cannot hide sustained attenuation");
        // A short quiet external reference must not mask the remaining low gain.
        let mut quiet_reference = mixed_window(0.02, 0.02).repeat(49);
        quiet_reference.extend(mixed_window(0.02, 0.36).repeat(251));
        assert!(!gain_passes(&quiet_reference));
        // Shared endpoint attenuation is fine when the same-window gain is real.
        assert!(gain_passes(&mixed_window(0.006623, 0.013282).repeat(50)));
    }

    #[test]
    fn physical_window_change_cannot_relax_source_leakage() {
        for frequency in [PROCESS_TRANSLATION_FINGERPRINT_HZ, PROCESS_CHILD_FINGERPRINT_HZ] {
            let chunks = (0..50).map(|_| {
                (0..960).flat_map(|i| {
                    let t = std::f64::consts::TAU * i as f64 / SAMPLE_RATE as f64;
                    let value = (0.36 * (t * 1733.0).sin()
                        + 0.004 * (t * frequency as f64).sin()) as f32;
                    [value, value]
                }).collect::<Vec<_>>()
            }).collect::<Vec<_>>();
            let leak = sustained_isolated_component_amplitude(&chunks, frequency).unwrap();
            assert!(leak.isolated > MAX_EXCLUDED_TRANSLATION_COMPONENT);
        }
        // An absolute-small leak must still fail the ratio if the old coherent
        // denominator was small, even when local physical amplitude is strong.
        assert!(conservative_physical_leakage_ratio(0.001, 0.01, 0.36)
            > MAX_EXCLUDED_TO_PHYSICAL_RATIO);
        for source in [0.0, 0.0001, 0.001, 0.004] {
            for coherent in [0.0, 0.001, 0.01, 0.36] {
                for sustained in [0.0, 0.001, 0.01, 0.36] {
                    assert!(conservative_physical_leakage_ratio(source, coherent, sustained)
                        >= source / coherent.max(f32::EPSILON));
                }
            }
        }
    }

    // Opt-in only: paths name existing iteration directories, never committed WAVs.
    // OMNI_PHYSICAL_REPLAY_ITERATIONS=<.../0011>;<.../0012>
    #[test]
    #[ignore = "requires existing local process-exclusion WAV/JSON artifacts"]
    fn physical_saved_wav_replay() {
        let roots = std::env::var("OMNI_PHYSICAL_REPLAY_ITERATIONS")
            .expect("set OMNI_PHYSICAL_REPLAY_ITERATIONS to iteration directories separated by ;");
        for root in roots.split(';') {
            let root = std::path::Path::new(root);
            let bytes = std::fs::read(root.join("runtime/process-exclusion-physical-output.wav")).unwrap();
            assert_eq!(&bytes[0..4], b"RIFF");
            assert_eq!(&bytes[8..12], b"WAVE");
            let mut format = None;
            let mut data = None;
            let mut offset = 12;
            while offset + 8 <= bytes.len() {
                let len = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
                let payload = &bytes[offset + 8..offset + 8 + len];
                match &bytes[offset..offset + 4] {
                    b"fmt " => format = Some((
                        u16::from_le_bytes(payload[0..2].try_into().unwrap()),
                        u16::from_le_bytes(payload[2..4].try_into().unwrap()),
                        u32::from_le_bytes(payload[4..8].try_into().unwrap()),
                        u16::from_le_bytes(payload[14..16].try_into().unwrap()))),
                    b"data" => data = Some(payload),
                    _ => (),
                }
                offset += 8 + len + len % 2;
            }
            assert_eq!(format, Some((1, 2, 48000, 16)));
            let samples = data.unwrap().chunks_exact(4).map(|frame| {
                i16::from_le_bytes(frame[0..2].try_into().unwrap()) as f32 / 32768.0
            }).collect::<Vec<_>>();
            let child = physical_fingerprint_evidence(&samples, PROCESS_CHILD_FINGERPRINT_HZ);
            let external = physical_fingerprint_evidence(&samples, PROCESS_EXTERNAL_FINGERPRINT_HZ);
            let (translation, reference) = physical_translation_window_evidence(&samples, 50);
            let coherent_child = component_amplitude(&samples, PROCESS_CHILD_FINGERPRINT_HZ);
            let coherent_translation = isolated_component_amplitude(&samples, PROCESS_TRANSLATION_FINGERPRINT_HZ).isolated;
            let json: serde_json::Value = serde_json::from_slice(
                &std::fs::read(root.join("process-exclusion.stdout.log")).unwrap()).unwrap();
            let source = &json["processExclusionFingerprint"];
            let child_ratio = conservative_physical_leakage_ratio(
                source["sourceBridgeChildComponent"].as_f64().unwrap() as f32,
                coherent_child, child.isolated);
            let translation_ratio = conservative_physical_leakage_ratio(
                source["sourceTranslationComponent"].as_f64().unwrap() as f32,
                coherent_translation, translation.isolated);
            println!("{} coherentChild={coherent_child:.9} sustainedChild={:.9} external={:.9} translation={:.9} coincidentExternal={reference:.9} gain={:.9} childLeakRatio={child_ratio:.9} translationLeakRatio={translation_ratio:.9}",
                root.display(), child.isolated, external.isolated, translation.isolated, translation.isolated / reference);
            assert!(child.isolated >= MIN_PROCESS_FINGERPRINT_COMPONENT);
            assert!(external.isolated >= MIN_PROCESS_FINGERPRINT_COMPONENT);
            assert!(reference >= MIN_PROCESS_FINGERPRINT_COMPONENT);
            assert!(physical_translation_is_detectable(&translation, reference, 50));
            assert!(child_ratio <= MAX_EXCLUDED_TO_PHYSICAL_RATIO);
            assert!(translation_ratio <= MAX_EXCLUDED_TO_PHYSICAL_RATIO);
        }
    }
}
