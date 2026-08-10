use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const AEC_LIVE_SCENARIO_ENV: &str = "OMNI_WATCH_MODE_AEC_LIVE_SCENARIO";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AecLiveScenarioPhase {
    DoubleTalk,
    DynamicDelay,
    Nonlinear,
}

impl AecLiveScenarioPhase {
    fn for_ordinal(ordinal: u64) -> Self {
        match ordinal.saturating_sub(1) % 3 {
            0 => Self::DoubleTalk,
            1 => Self::DynamicDelay,
            _ => Self::Nonlinear,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::DoubleTalk => "double-talk",
            Self::DynamicDelay => "dynamic-delay",
            Self::Nonlinear => "nonlinear",
        }
    }

    pub(super) fn delay_ms(self) -> u32 {
        match self {
            Self::DoubleTalk => 0,
            Self::DynamicDelay => 80,
            Self::Nonlinear => 160,
        }
    }

    pub(super) fn nonlinearity(self) -> &'static str {
        match self {
            Self::DoubleTalk | Self::DynamicDelay => "none",
            Self::Nonlinear => "soft-clip",
        }
    }

    fn physical_sample(self, sample: f32) -> f32 {
        if self != Self::Nonlinear {
            return sample;
        }
        // Model deterministic endpoint distortion only on the physical PCM;
        // the AEC render reference remains the post-volume linear signal.
        let driven = sample.clamp(-1.0, 1.0) * 2.4;
        let soft_clipped = driven / (1.0 + driven.abs());
        (soft_clipped * 1.35).clamp(-0.92, 0.92)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AecLiveScenarioAssignment {
    pub(super) ordinal: u64,
    pub(super) phase: AecLiveScenarioPhase,
}

#[derive(Default)]
struct AecLiveScenarioAssignments {
    next_ordinal: u64,
    by_cue_id: HashMap<String, AecLiveScenarioAssignment>,
}

impl AecLiveScenarioAssignments {
    fn assignment_for_cue(&mut self, cue_id: &str) -> AecLiveScenarioAssignment {
        if let Some(assignment) = self.by_cue_id.get(cue_id) {
            return *assignment;
        }
        self.next_ordinal = self.next_ordinal.saturating_add(1).max(1);
        let assignment = AecLiveScenarioAssignment {
            ordinal: self.next_ordinal,
            phase: AecLiveScenarioPhase::for_ordinal(self.next_ordinal),
        };
        self.by_cue_id.insert(cue_id.to_string(), assignment);
        assignment
    }
}

static AEC_LIVE_SCENARIO_ASSIGNMENTS: OnceLock<Mutex<AecLiveScenarioAssignments>> =
    OnceLock::new();

fn env_flag_value_enabled(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(|value| matches!(value, "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn aec_live_scenario_should_run(
    watch_diagnostic_autostart: bool,
    scenario_env_value: Option<&str>,
) -> bool {
    watch_diagnostic_autostart && env_flag_value_enabled(scenario_env_value)
}

pub(super) fn active_aec_live_scenario_assignment(
    cue_id: &str,
) -> Result<Option<AecLiveScenarioAssignment>, String> {
    let scenario_env_value = std::env::var(AEC_LIVE_SCENARIO_ENV).ok();
    if !aec_live_scenario_should_run(
        crate::watch_mode_diagnostic::autostart_enabled(),
        scenario_env_value.as_deref(),
    ) {
        return Ok(None);
    }
    let assignments = AEC_LIVE_SCENARIO_ASSIGNMENTS
        .get_or_init(|| Mutex::new(AecLiveScenarioAssignments::default()));
    assignments
        .lock()
        .map(|mut assignments| Some(assignments.assignment_for_cue(cue_id)))
        .map_err(|_| "AEC live scenario cue assignment lock is poisoned".to_string())
}

pub(super) struct AecLiveScenarioRender {
    pub(super) assignment: AecLiveScenarioAssignment,
    pub(super) delay_frames: usize,
    pub(super) changed_samples: usize,
    pub(super) changed_ratio: f64,
    pub(super) physical_samples: Vec<f32>,
}

impl AecLiveScenarioRender {
    pub(super) fn build(
        assignment: AecLiveScenarioAssignment,
        reference_samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
    ) -> Self {
        let delay_frames = sample_rate_hz as usize * assignment.phase.delay_ms() as usize / 1_000;
        let delay_samples = delay_frames.saturating_mul(channel_count as usize);
        let mut physical_samples = Vec::with_capacity(
            delay_samples.saturating_add(reference_samples.len()),
        );
        physical_samples.resize(delay_samples, 0.0);
        physical_samples.extend(
            reference_samples
                .iter()
                .copied()
                .map(|sample| assignment.phase.physical_sample(sample)),
        );
        // Count only aligned signal samples. The delay-prefix silence proves
        // dynamic delay separately and must not masquerade as nonlinearity.
        let changed_samples = physical_samples[delay_samples..]
            .iter()
            .zip(reference_samples)
            .filter(|(physical, reference)| physical.to_bits() != reference.to_bits())
            .count();
        let changed_ratio = if reference_samples.is_empty() {
            0.0
        } else {
            changed_samples as f64 / reference_samples.len() as f64
        };
        Self {
            assignment,
            delay_frames,
            changed_samples,
            changed_ratio,
            physical_samples,
        }
    }

    pub(super) fn reference_frames(
        &self,
        reference_samples: &[f32],
        channel_count: u16,
    ) -> u64 {
        (reference_samples.len() / channel_count as usize) as u64
    }

    pub(super) fn physical_frames(&self, channel_count: u16) -> u64 {
        (self.physical_samples.len() / channel_count as usize) as u64
    }

    pub(super) fn physical_prefix_offset_frames(&self) -> u32 {
        self.delay_frames.min(u32::MAX as usize) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::speech::{
        RenderSubmitTracker, SPEAKER_CHANNEL_COUNT, SPEAKER_SAMPLE_RATE_HZ,
    };

    #[test]
    fn live_scenario_requires_both_diagnostic_autostart_and_explicit_opt_in() {
        assert!(!aec_live_scenario_should_run(false, Some("1")));
        assert!(!aec_live_scenario_should_run(true, None));
        assert!(!aec_live_scenario_should_run(true, Some("0")));
        assert!(aec_live_scenario_should_run(true, Some("1")));
        assert!(aec_live_scenario_should_run(true, Some("true")));
    }

    #[test]
    fn consecutive_cues_cycle_three_stages_and_retry_keeps_the_assignment() {
        let mut assignments = AecLiveScenarioAssignments::default();

        let first = assignments.assignment_for_cue("cue-a");
        let second = assignments.assignment_for_cue("cue-b");
        let third = assignments.assignment_for_cue("cue-c");
        let retry = assignments.assignment_for_cue("cue-b");

        assert_eq!(first.ordinal, 1);
        assert_eq!(first.phase, AecLiveScenarioPhase::DoubleTalk);
        assert_eq!(second.ordinal, 2);
        assert_eq!(second.phase, AecLiveScenarioPhase::DynamicDelay);
        assert_eq!(third.ordinal, 3);
        assert_eq!(third.phase, AecLiveScenarioPhase::Nonlinear);
        assert_eq!(retry, second);
    }

    #[test]
    fn double_talk_baseline_is_zero_delay_and_linear() {
        let reference = vec![0.1_f32, -0.2, 0.3, -0.4];
        let render = AecLiveScenarioRender::build(
            AecLiveScenarioAssignment {
                ordinal: 1,
                phase: AecLiveScenarioPhase::DoubleTalk,
            },
            &reference,
            SPEAKER_SAMPLE_RATE_HZ,
            SPEAKER_CHANNEL_COUNT,
        );

        assert_eq!(render.assignment.phase.delay_ms(), 0);
        assert_eq!(render.physical_prefix_offset_frames(), 0);
        assert_eq!(render.assignment.phase.nonlinearity(), "none");
        assert_eq!(render.changed_samples, 0);
        assert_eq!(render.changed_ratio, 0.0);
        assert_eq!(render.physical_samples, reference);
    }

    #[test]
    fn dynamic_delay_prefixes_physical_silence_and_keeps_reference_ahead() {
        let reference = vec![0.25_f32, -0.25, 0.5, -0.5];
        let assignment = AecLiveScenarioAssignment {
            ordinal: 2,
            phase: AecLiveScenarioPhase::DynamicDelay,
        };
        let render = AecLiveScenarioRender::build(
            assignment,
            &reference,
            SPEAKER_SAMPLE_RATE_HZ,
            SPEAKER_CHANNEL_COUNT,
        );
        let delay_frames = render.delay_frames;
        let delay_samples = delay_frames * SPEAKER_CHANNEL_COUNT as usize;

        assert_eq!(delay_frames, 3_840);
        assert_eq!(render.physical_prefix_offset_frames(), 3_840);
        assert_eq!(
            render.physical_frames(SPEAKER_CHANNEL_COUNT),
            render.reference_frames(&reference, SPEAKER_CHANNEL_COUNT) + delay_frames as u64
        );
        assert!(render.physical_samples[..delay_samples]
            .iter()
            .all(|sample| *sample == 0.0));
        assert_eq!(&render.physical_samples[delay_samples..], reference);
        assert_eq!(render.changed_samples, 0);
        assert_eq!(render.changed_ratio, 0.0);

        let mut tracker = RenderSubmitTracker::new_with_reference(delay_frames + 2, 2, 2);
        let first_reference = tracker
            .record_write(2, 2)
            .expect("first physical write")
            .expect("reference advances with the original PCM");
        assert_eq!(first_reference.start_frame, 0);
        assert_eq!(first_reference.end_frame, 2);
        while !tracker.is_complete() {
            let written = tracker.next_write_frames(2);
            assert!(tracker
                .record_write(written, written as u32)
                .expect("delayed physical tail")
                .is_none());
        }
    }

    #[test]
    fn nonlinear_stage_changes_only_physical_pcm() {
        let reference = vec![0.05_f32, -0.2, 0.55, -0.9];
        let unchanged_reference = reference.clone();
        let render = AecLiveScenarioRender::build(
            AecLiveScenarioAssignment {
                ordinal: 3,
                phase: AecLiveScenarioPhase::Nonlinear,
            },
            &reference,
            SPEAKER_SAMPLE_RATE_HZ,
            SPEAKER_CHANNEL_COUNT,
        );
        let delay_samples = render.delay_frames * SPEAKER_CHANNEL_COUNT as usize;
        let shaped = &render.physical_samples[delay_samples..];

        assert_eq!(reference, unchanged_reference);
        assert_eq!(render.physical_prefix_offset_frames(), 7_680);
        assert_ne!(shaped, reference);
        assert_eq!(render.changed_samples, reference.len());
        assert_eq!(render.changed_ratio, 1.0);
        assert!(shaped.iter().all(|sample| sample.abs() <= 0.92));
        assert_eq!(render.assignment.phase.nonlinearity(), "soft-clip");
    }
}
