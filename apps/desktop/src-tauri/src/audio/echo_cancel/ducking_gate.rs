//! Post-AEC Sidechain Ducking and Residual Echo Gating.
//!
//! Operates strictly after WebRTC AEC3 linear/nonlinear processing on 10ms
//! 48kHz stereo frames (960 f32 samples).
//!
//! RT-safe: zero heap allocations during audio processing.
//!
//! Transitions are sample-by-sample linearly interpolated to prevent clicks/pops.

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DuckingGateConfig {
    /// Global enable switch. When false, audio passes through at 0 dB (1.0x).
    pub(crate) enabled: bool,
    /// Far-end silence threshold in dBFS. Below this, far-end is inactive and ducking is 0 dB.
    pub(crate) quiet_threshold_db: f32,
    /// Expected acoustic coupling + AEC linear ERLE loss in dB.
    pub(crate) expected_erle_coupling_db: f32,
    /// Soft ducking attenuation in dB applied during double-talk (preserves near-end formants).
    pub(crate) double_talk_ducking_db: f32,
    /// Suppression depth in dB applied to residual echo when near-end is silent.
    pub(crate) echo_only_suppression_db: f32,
    /// Asymmetric envelope attack smoothing coefficient (10ms frame).
    pub(crate) attack_alpha: f32,
    /// Asymmetric envelope release smoothing coefficient (10ms frame).
    pub(crate) release_alpha: f32,
}

impl Default for DuckingGateConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            quiet_threshold_db: -50.0,
            expected_erle_coupling_db: 25.0,
            double_talk_ducking_db: -6.0,
            echo_only_suppression_db: -30.0,
            // 8ms attack at 10ms frame update: exp(-10 / 8) ≈ 0.2865
            attack_alpha: 0.2865,
            // 200ms release at 10ms frame update: exp(-10 / 200) ≈ 0.9512
            release_alpha: 0.9512,
        }
    }
}

pub(crate) struct PostAecDuckingGate {
    config: DuckingGateConfig,
    far_end_envelope_db: f32,
    current_gain: f32,
    current_attenuation_db: f32,
}

impl PostAecDuckingGate {
    pub(crate) fn new(config: DuckingGateConfig) -> Self {
        Self {
            config,
            far_end_envelope_db: -100.0,
            current_gain: 1.0,
            current_attenuation_db: 0.0,
        }
    }

    /// Passthrough instance for tests and unconfigured paths.
    #[cfg(test)]
    pub(crate) fn passthrough() -> Self {
        Self {
            config: DuckingGateConfig {
                enabled: false,
                ..Default::default()
            },
            far_end_envelope_db: -100.0,
            current_gain: 1.0,
            current_attenuation_db: 0.0,
        }
    }

    #[cfg(test)]
    pub(crate) fn far_end_envelope_db(&self) -> f32 {
        self.far_end_envelope_db
    }

    #[cfg(test)]
    pub(crate) fn current_attenuation_db(&self) -> f32 {
        self.current_attenuation_db
    }

    pub(crate) fn reset(&mut self) {
        self.far_end_envelope_db = -100.0;
        self.current_gain = 1.0;
        self.current_attenuation_db = 0.0;
    }

    /// In-place post-AEC ducking and gating on 48kHz stereo slice.
    pub(crate) fn process_frame_in_place(
        &mut self,
        render_reference: Option<&[f32]>,
        aec_output_samples: &mut [f32],
    ) {
        if aec_output_samples.is_empty() {
            return;
        }

        // If disabled or no render reference, target unity gain.
        if !self.config.enabled || render_reference.is_none() {
            self.apply_gain_ramp(1.0, 0.0, aec_output_samples);
            self.far_end_envelope_db = self.decay_envelope(-100.0);
            return;
        }

        let render = render_reference.unwrap();
        let render_db = compute_rms_dbfs(render);

        // Update asymmetric leaky integrator envelope.
        if render_db > self.far_end_envelope_db {
            self.far_end_envelope_db = self.config.attack_alpha * self.far_end_envelope_db
                + (1.0 - self.config.attack_alpha) * render_db;
        } else {
            self.far_end_envelope_db = self.config.release_alpha * self.far_end_envelope_db
                + (1.0 - self.config.release_alpha) * render_db;
        }

        // Quiet far-end: passthrough.
        if self.far_end_envelope_db < self.config.quiet_threshold_db {
            self.apply_gain_ramp(1.0, 0.0, aec_output_samples);
            return;
        }

        // Far-end is active. Inspect post-AEC output energy.
        let post_db = compute_rms_dbfs(aec_output_samples);
        let expected_echo_db = self.far_end_envelope_db - self.config.expected_erle_coupling_db;

        // Decision logic:
        // If post_db <= expected_echo_db: pure echo residual leak -> echo_only_suppression_db.
        // If post_db >= expected_echo_db + 6.0: strong near-end voice -> double_talk_ducking_db.
        // In-between: smooth crossfade to avoid threshold chatter.
        let target_db = if post_db <= expected_echo_db {
            self.config.echo_only_suppression_db
        } else if post_db >= expected_echo_db + 6.0 {
            self.config.double_talk_ducking_db
        } else {
            let t = (post_db - expected_echo_db) / 6.0;
            self.config.echo_only_suppression_db * (1.0 - t) + self.config.double_talk_ducking_db * t
        };

        let target_linear = 10.0_f32.powf(target_db / 20.0);
        self.apply_gain_ramp(target_linear, target_db, aec_output_samples);
    }

    fn decay_envelope(&self, target_db: f32) -> f32 {
        self.config.release_alpha * self.far_end_envelope_db
            + (1.0 - self.config.release_alpha) * target_db
    }

    /// Sample-by-sample linear interpolation for stereo frames (channel pairs).
    fn apply_gain_ramp(
        &mut self,
        target_gain: f32,
        target_db: f32,
        samples: &mut [f32],
    ) {
        let start_gain = self.current_gain;
        let pair_count = samples.len() / 2;

        if pair_count == 0 {
            // Fallback for odd / 1-sample buffers
            for sample in samples.iter_mut() {
                *sample *= target_gain;
            }
            self.current_gain = target_gain;
            self.current_attenuation_db = target_db;
            return;
        }

        let delta = (target_gain - start_gain) / pair_count as f32;
        let mut gain = start_gain;

        for pair in samples.chunks_exact_mut(2) {
            gain += delta;
            pair[0] *= gain;
            pair[1] *= gain;
        }

        // Remainder if odd length
        let remainder_start = pair_count * 2;
        for sample in &mut samples[remainder_start..] {
            *sample *= target_gain;
        }

        self.current_gain = target_gain;
        self.current_attenuation_db = target_db;
    }
}

fn compute_rms_dbfs(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -100.0;
    }
    let mut sum_sq = 0.0_f32;
    for &sample in samples {
        sum_sq += sample * sample;
    }
    let mean_sq = sum_sq / samples.len() as f32;
    if mean_sq <= 1e-10 {
        -100.0
    } else {
        (mean_sq.sqrt().max(1e-5)).log10() * 20.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_preserves_samples_bit_exact() {
        let mut gate = PostAecDuckingGate::passthrough();
        let render = vec![0.5; 960];
        let mut capture = vec![0.375; 960];
        gate.process_frame_in_place(Some(&render), &mut capture);
        assert_eq!(capture, vec![0.375; 960]);
        assert_eq!(gate.current_gain, 1.0);
    }

    #[test]
    fn quiet_render_does_not_attenuate() {
        let mut gate = PostAecDuckingGate::new(DuckingGateConfig::default());
        // -60 dBFS render is below quiet_threshold_db (-50 dBFS)
        let render = vec![0.001; 960];
        let mut capture = vec![0.5; 960];
        gate.process_frame_in_place(Some(&render), &mut capture);
        assert_eq!(capture, vec![0.5; 960]);
        assert_eq!(gate.current_attenuation_db, 0.0);
    }

    #[test]
    fn none_render_does_not_attenuate() {
        let mut gate = PostAecDuckingGate::new(DuckingGateConfig::default());
        let mut capture = vec![0.5; 960];
        gate.process_frame_in_place(None, &mut capture);
        assert_eq!(capture, vec![0.5; 960]);
        assert_eq!(gate.current_gain, 1.0);
    }

    #[test]
    fn echo_only_residual_triggers_deep_suppression() {
        let mut gate = PostAecDuckingGate::new(DuckingGateConfig::default());
        // Loud render: ~ -6 dBFS
        let render = vec![0.5; 960];
        // Weak residual echo after AEC: ~ -60 dBFS
        let mut capture = vec![0.001; 960];

        // Process a few frames for attack envelope to rise
        for _ in 0..5 {
            capture = vec![0.001; 960];
            gate.process_frame_in_place(Some(&render), &mut capture);
        }

        assert_eq!(gate.current_attenuation_db, -30.0);
        let expected_gain = 10.0_f32.powf(-30.0 / 20.0);
        assert!((gate.current_gain - expected_gain).abs() < 1e-4);
        assert!((capture[959] - 0.001 * expected_gain).abs() < 1e-5);
    }

    #[test]
    fn double_talk_triggers_moderate_ducking_without_zeroing() {
        let mut gate = PostAecDuckingGate::new(DuckingGateConfig::default());
        let render = vec![0.5; 960]; // Loud render
        let mut capture = vec![0.3; 960]; // Strong near-end voice

        for _ in 0..5 {
            capture = vec![0.3; 960];
            gate.process_frame_in_place(Some(&render), &mut capture);
        }

        assert_eq!(gate.current_attenuation_db, -6.0);
        let expected_gain = 10.0_f32.powf(-6.0 / 20.0);
        assert!((gate.current_gain - expected_gain).abs() < 1e-4);
        // Voice is gently ducked, not zeroed
        assert!(capture[959] > 0.14 && capture[959] < 0.16);
    }

    #[test]
    fn linear_interpolation_is_smooth_and_click_free() {
        let mut gate = PostAecDuckingGate::new(DuckingGateConfig::default());
        let render = vec![0.5; 960];
        let mut capture = vec![1.0; 960];

        gate.process_frame_in_place(Some(&render), &mut capture);

        // First sample pair should have gain close to 1.0 (start)
        assert!(capture[0] > 0.9);
        // Middle should be strictly intermediate
        assert!(capture[480] < capture[0] && capture[480] > capture[959]);
        // Last sample pair should have reached target gain
        let expected_last = gate.current_gain;
        assert!((capture[958] - expected_last).abs() < 0.01);
        assert_eq!(capture[958], capture[959], "stereo pairs must have identical gain");
    }

    #[test]
    fn reset_clears_state() {
        let mut gate = PostAecDuckingGate::new(DuckingGateConfig::default());
        let render = vec![0.5; 960];
        let mut capture = vec![0.001; 960];
        gate.process_frame_in_place(Some(&render), &mut capture);
        assert!(gate.current_attenuation_db < 0.0);

        gate.reset();
        assert_eq!(gate.current_gain, 1.0);
        assert_eq!(gate.current_attenuation_db, 0.0);
        assert_eq!(gate.far_end_envelope_db, -100.0);
    }
}
