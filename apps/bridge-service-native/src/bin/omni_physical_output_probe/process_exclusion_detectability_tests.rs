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
}
