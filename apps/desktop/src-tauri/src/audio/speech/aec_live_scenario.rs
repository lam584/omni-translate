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
    reserved_cue_id: Option<String>,
    completed: bool,
}

impl AecLiveScenarioAssignments {
    fn assignments_for_cue(&mut self, cue_id: &str) -> Vec<AecLiveScenarioAssignment> {
        if self.completed {
            return Vec::new();
        }
        if self.reserved_cue_id.as_deref() == Some(cue_id) {
            (1..=3)
                .map(|ordinal| AecLiveScenarioAssignment {
                    ordinal,
                    phase: AecLiveScenarioPhase::for_ordinal(ordinal),
                })
                .collect()
        } else if self.reserved_cue_id.is_none() {
            self.reserved_cue_id = Some(cue_id.to_string());
            self.assignments_for_cue(cue_id)
        } else {
            Vec::new()
        }
    }

    fn finish_cue(&mut self, cue_id: &str, completed: bool) {
        if self.reserved_cue_id.as_deref() != Some(cue_id) {
            return;
        }
        self.completed = completed;
        self.reserved_cue_id = None;
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

pub(super) fn active_aec_live_scenario_assignments(
    cue_id: &str,
) -> Result<Vec<AecLiveScenarioAssignment>, String> {
    let scenario_env_value = std::env::var(AEC_LIVE_SCENARIO_ENV).ok();
    if !aec_live_scenario_should_run(
        crate::watch_mode_diagnostic::autostart_enabled(),
        scenario_env_value.as_deref(),
    ) {
        return Ok(Vec::new());
    }
    let assignments = AEC_LIVE_SCENARIO_ASSIGNMENTS
        .get_or_init(|| Mutex::new(AecLiveScenarioAssignments::default()));
    assignments
        .lock()
        .map(|mut assignments| assignments.assignments_for_cue(cue_id))
        .map_err(|_| "AEC live scenario cue assignment lock is poisoned".to_string())
}

pub(super) fn finish_aec_live_scenario_assignments(
    cue_id: &str,
    completed: bool,
) -> Result<(), String> {
    let Some(assignments) = AEC_LIVE_SCENARIO_ASSIGNMENTS.get() else {
        return Ok(());
    };
    assignments
        .lock()
        .map(|mut assignments| assignments.finish_cue(cue_id, completed))
        .map_err(|_| "AEC live scenario cue assignment lock is poisoned".to_string())
}

pub(super) struct AecLiveScenarioRender {
    pub(super) assignment: AecLiveScenarioAssignment,
    pub(super) delay_frames: usize,
    pub(super) changed_samples: usize,
    pub(super) changed_ratio: f64,
    pub(super) physical_samples: Vec<f32>,
    reference_sample_range: std::ops::Range<usize>,
}

impl AecLiveScenarioRender {
    /// Partition one cue, rather than replaying the entire cue for every phase.
    /// All ranges are aligned to committed 10 ms stereo reference blocks,
    /// consecutive and exhaustive. Reject short cues and partial blocks before
    /// physical rendering; never truncate, repeat or pad translated PCM.
    pub(super) fn build_program(
        assignments: &[AecLiveScenarioAssignment],
        reference_samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
    ) -> Result<Vec<Self>, String> {
        if assignments.is_empty() {
            return Ok(Vec::new());
        }
        if assignments.len() != 3 || assignments.iter().enumerate().any(|(index, entry)| {
            entry.ordinal != index as u64 + 1
                || entry.phase != AecLiveScenarioPhase::for_ordinal(index as u64 + 1)
        }) {
            return Err("AEC live scenario requires all three ordered phases".to_string());
        }
        let channels = usize::from(channel_count);
        if sample_rate_hz != super::SPEAKER_SAMPLE_RATE_HZ
            || channel_count != super::SPEAKER_CHANNEL_COUNT
            || reference_samples.len() % channels != 0
        {
            return Err("AEC live scenario requires frame-aligned 48 kHz stereo PCM".to_string());
        }
        // The capture-clock matcher accepts exactly 480 frames / 960 samples.
        // Split whole reference blocks, not individual stereo frames: otherwise
        // every phase can end with a physically committed but inadmissible tail.
        let reference_block_frames = sample_rate_hz as usize
            * super::RENDER_REFERENCE_FRAME_MS as usize / 1_000;
        let total_frames = reference_samples.len() / channels;
        let total_blocks = total_frames / reference_block_frames;
        if total_blocks < assignments.len() {
            return Err(format!(
                "AEC live scenario cue too short for three real phases: frames={total_frames} minimumPhaseFrames={reference_block_frames}"
            ));
        }
        if total_frames % reference_block_frames != 0 {
            return Err(format!(
                "AEC live scenario requires complete 10 ms reference blocks: frames={total_frames} blockFrames={reference_block_frames}"
            ));
        }
        let blocks_per_phase = total_blocks / assignments.len();
        let remainder_blocks = total_blocks % assignments.len();
        let mut start_frame = 0;
        Ok(assignments.iter().enumerate().map(|(index, assignment)| {
            let phase_blocks = blocks_per_phase + usize::from(index < remainder_blocks);
            let end_frame = start_frame + phase_blocks * reference_block_frames;
            let range = start_frame * channels..end_frame * channels;
            let mut render = Self::build(
                *assignment, &reference_samples[range.clone()], sample_rate_hz, channel_count,
            );
            render.reference_sample_range = range;
            start_frame = end_frame;
            render
        }).collect())
    }

    pub(super) fn reference_samples<'a>(&self, samples: &'a [f32]) -> &'a [f32] {
        &samples[self.reference_sample_range.clone()]
    }

    fn build(
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
            reference_sample_range: 0..reference_samples.len(),
        }
    }

    pub(super) fn reference_frames(
        &self,
        reference_samples: &[f32],
        channel_count: u16,
    ) -> u64 {
        (self.reference_samples(reference_samples).len() / channel_count as usize) as u64
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
    fn failed_first_cue_releases_all_three_stages_to_the_next_cue() {
        let mut assignments = AecLiveScenarioAssignments::default();

        let first = assignments.assignments_for_cue("cue-a");
        let retry = assignments.assignments_for_cue("cue-a");
        let blocked = assignments.assignments_for_cue("cue-b");
        assignments.finish_cue("cue-b", false);
        let still_blocked = assignments.assignments_for_cue("cue-b");
        assignments.finish_cue("cue-a", false);
        let second = assignments.assignments_for_cue("cue-b");

        assert_eq!(
            first.iter().map(|entry| entry.ordinal).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(first[0].phase, AecLiveScenarioPhase::DoubleTalk);
        assert_eq!(first[1].phase, AecLiveScenarioPhase::DynamicDelay);
        assert_eq!(first[2].phase, AecLiveScenarioPhase::Nonlinear);
        assert_eq!(retry, first);
        assert!(blocked.is_empty());
        assert!(still_blocked.is_empty());
        assert_eq!(second, first);
    }

    #[test]
    fn completed_program_is_not_assigned_to_later_cues() {
        let mut assignments = AecLiveScenarioAssignments::default();

        assert_eq!(assignments.assignments_for_cue("cue-a").len(), 3);
        assignments.finish_cue("cue-a", true);

        assert!(assignments.assignments_for_cue("cue-a").is_empty());
        assert!(assignments.assignments_for_cue("cue-b").is_empty());
    }

    #[test]
    fn long_cue_program_conserves_source_frames_and_does_not_repeat_later_cues() {
        let mut assignments = AecLiveScenarioAssignments::default();
        let mut reference_total = 0_u64;
        let mut physical_total = 0_u64;
        for (index, duration_ms) in [58_720_usize, 45_680, 6_640].into_iter().enumerate() {
            let cue_id = format!("long-cue-{index}");
            let frames = duration_ms * SPEAKER_SAMPLE_RATE_HZ as usize / 1_000;
            let samples = (0..frames).flat_map(|frame| {
                let sample = (frame % 997 + 1) as f32 / 2_000.0;
                [sample, -sample]
            }).collect::<Vec<_>>();
            let program = AecLiveScenarioRender::build_program(
                &assignments.assignments_for_cue(&cue_id), &samples,
                SPEAKER_SAMPLE_RATE_HZ, SPEAKER_CHANNEL_COUNT,
            ).unwrap();
            if index == 0 {
                assert_eq!(program.len(), 3);
                let mut end = 0;
                for (phase, render) in program.iter().enumerate() {
                    assert_eq!(render.reference_sample_range.start, end);
                    end = render.reference_sample_range.end;
                    assert_eq!(render.assignment.ordinal, phase as u64 + 1);
                    let reference = render.reference_samples(&samples);
                    let physical = &render.physical_samples[render.delay_frames * 2..];
                    assert_eq!(reference.len(), physical.len());
                    for (&source, &played) in reference.iter().zip(physical) {
                        assert_eq!(played, render.assignment.phase.physical_sample(source));
                    }
                    reference_total += render.reference_frames(&samples, SPEAKER_CHANNEL_COUNT);
                    physical_total += render.physical_frames(SPEAKER_CHANNEL_COUNT);
                }
                assert_eq!(end, samples.len());
                assert_eq!(reference_total, 2_818_560);
                assert_eq!(physical_total, 2_818_560 + 3_840 + 7_680);
                assignments.finish_cue(&cue_id, true);
            } else {
                assert!(program.is_empty(), "completed phases must not replay subsequent cues");
                reference_total += frames as u64;
                physical_total += frames as u64;
            }
        }
        assert_eq!(reference_total, 5_329_920); // 111.04 seconds, not 228.48.
        assert_eq!(physical_total, reference_total + 11_520); // Only real delay prefixes added.
    }

    #[test]
    fn partition_keeps_remainder_blocks_once_and_in_order() {
        let assignments = AecLiveScenarioAssignments::default().assignments_for_cue("cue");
        for total_frames in [1_440, 1_920, 2_400, 2_880] {
            let samples = (0..total_frames * 2).map(|sample| sample as f32).collect::<Vec<_>>();
            let program = AecLiveScenarioRender::build_program(
                &assignments, &samples, SPEAKER_SAMPLE_RATE_HZ, SPEAKER_CHANNEL_COUNT,
            ).unwrap();
            let reconstructed = program.iter().flat_map(|render| {
                render.reference_samples(&samples).iter().copied()
            }).collect::<Vec<_>>();
            assert_eq!(reconstructed, samples);
            for render in &program {
                assert_eq!(render.reference_sample_range.start % 960, 0);
                assert_eq!(render.reference_sample_range.end % 960, 0);
                assert!(render.reference_frames(&samples, 2) >= 480);
            }
        }
    }

    #[test]
    fn partial_reference_block_fails_before_render_program_without_completing_phases() {
        let mut state = AecLiveScenarioAssignments::default();
        let assignments = state.assignments_for_cue("partial");
        for frames in [1_441, 1_442, 1_919, 2_284_801] {
            let error = AecLiveScenarioRender::build_program(
                &assignments, &vec![0.2; frames * 2],
                SPEAKER_SAMPLE_RATE_HZ, SPEAKER_CHANNEL_COUNT,
            ).err().expect("partial reference block must fail before rendering");
            assert!(error.contains("complete 10 ms reference blocks"));
        }
        state.finish_cue("partial", false);
        assert!(!state.completed);
        assert_eq!(state.assignments_for_cue("next"), assignments);
    }

    #[test]
    fn short_cue_fails_closed_without_completing_or_skipping_any_phase() {
        let mut state = AecLiveScenarioAssignments::default();
        let assignments = state.assignments_for_cue("short");
        for frames in [0, 1, 479, 480, 1_439] {
            let error = AecLiveScenarioRender::build_program(
                &assignments, &vec![0.2; frames * 2],
                SPEAKER_SAMPLE_RATE_HZ, SPEAKER_CHANNEL_COUNT,
            ).err().expect("short cue must fail before rendering");
            assert!(error.contains("too short"));
        }
        state.finish_cue("short", false);
        assert!(!state.completed);
        assert_eq!(state.assignments_for_cue("next"), assignments);
    }

    #[test]
    fn program_rejects_incomplete_phases_and_invalid_pcm() {
        let assignments = AecLiveScenarioAssignments::default().assignments_for_cue("cue");
        let samples = vec![0.2; 2_880];
        let mut reordered = assignments.clone();
        reordered.swap(0, 1);
        for invalid in [&assignments[..2], &reordered[..]] {
            assert!(AecLiveScenarioRender::build_program(invalid, &samples, 48_000, 2).is_err());
        }
        for (rate, channels, length) in [
            (0, 2, 2_880), (48_000, 0, 2_880), (48_000, 2, 2_879),
            (24_000, 2, 2_880), (48_000, 1, 2_880),
        ] {
            assert!(AecLiveScenarioRender::build_program(
                &assignments, &samples[..length], rate, channels,
            ).is_err());
        }
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
