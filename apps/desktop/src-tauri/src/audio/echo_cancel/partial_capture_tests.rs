use super::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Trace { inputs: Vec<Vec<f32>>, resets: u64, fail_reset: bool, invalid_output: bool }
struct TaggedEngine(Arc<Mutex<Trace>>);
impl EchoCancellerEngine for TaggedEngine {
    fn push_render_10ms(&mut self, _: &[f32], _: Instant) -> Result<(), String> { Ok(()) }
    fn process_capture_10ms(&mut self, input: &[f32], _: usize, _: Instant)
        -> Result<EchoCancellationResult, String> {
        let mut trace = self.0.lock().unwrap(); trace.inputs.push(input.to_vec());
        let samples = if trace.invalid_output { vec![0.3; 2] }
            else { input.iter().map(|sample| sample * 0.5 + 0.125).collect() };
        Ok(EchoCancellationResult { samples })
    }
    fn reset(&mut self) -> Result<(), String> {
        let mut trace = self.0.lock().unwrap();
        if trace.fail_reset { return Err("reset failed".into()); }
        trace.resets += 1; Ok(())
    }
    fn stats(&self) -> EchoCancellerEngineStats {
        let trace = self.0.lock().unwrap();
        EchoCancellerEngineStats { backend: "webrtc-aec3", render_10ms_frames: 0,
            capture_10ms_frames: trace.inputs.len() as u64, reset_count: trace.resets,
            rejected_frame_count: 0, stats_read_failure_count: 0, erle_db: None,
            residual_echo_likelihood: None, reported_delay_ms: None, double_talk_frames: None,
            render_underrun_count: 0, capture_underrun_count: 0, processing_call_count: 0,
            processing_time_micros_total: 0, max_processing_time_micros: 0 }
    }
}
fn engine() -> (ProductionEchoCanceller, Arc<Mutex<Trace>>) {
    let trace = Arc::new(Mutex::new(Trace::default()));
    (ProductionEchoCanceller::from_verified_aec3_engine_for_test(Box::new(TaggedEngine(trace.clone()))).unwrap(), trace)
}
#[test]
fn partial_suffix_is_processed_not_passthrough_and_computational_padding_is_not_output() {
    let (mut engine, trace) = engine(); let real = vec![0.5; 192 * 2];
    let output = engine.process_capture_partial_10ms_with_reference(None, &real, 0, Instant::now()).unwrap();
    assert_eq!(output.samples, vec![0.375; real.len()]);
    let trace = trace.lock().unwrap(); assert_eq!(trace.inputs.len(), 1);
    assert_eq!(&trace.inputs[0][..real.len()], real);
    assert_eq!(&trace.inputs[0][real.len()..], &[0.0; 288 * 2]);
    assert_eq!(output.samples.len(), real.len());
}
#[test]
fn all_zero_real_tail_still_calls_native_aec_and_returns_its_real_prefix() {
    let (mut engine, trace) = engine();
    let output = engine.process_capture_partial_10ms_with_reference(None, &[0.0; 96 * 2], 0, Instant::now()).unwrap();
    assert_eq!(output.samples, vec![0.125; 96 * 2]); assert_eq!(trace.lock().unwrap().inputs.len(), 1);
}
#[test]
fn capture_resume_is_rejected_until_a_successful_native_reset() {
    let (mut engine, trace) = engine();
    engine.process_capture_partial_10ms_with_reference(None, &[0.25; 2], 0, Instant::now()).unwrap();
    assert!(engine.partial_capture_boundary_pending());
    assert!(engine.process_capture_10ms_with_reference(None, &[0.0; 960], 0, Instant::now()).is_err());
    trace.lock().unwrap().fail_reset = true; assert!(engine.reset().is_err());
    assert!(engine.partial_capture_boundary_pending());
    trace.lock().unwrap().fail_reset = false; engine.reset().unwrap();
    assert!(!engine.partial_capture_boundary_pending());
    engine.process_capture_10ms_with_reference(None, &[0.0; 960], 0, Instant::now()).unwrap();
    assert_eq!(trace.lock().unwrap().inputs.len(), 2);
}
#[test]
fn malformed_partial_payload_never_reaches_native_aec() {
    for payload in [vec![], vec![0.0], vec![0.0; 960], vec![f32::NAN; 2], vec![f32::INFINITY; 2]] {
        let (mut engine, trace) = engine();
        assert!(engine.process_capture_partial_10ms_with_reference(None, &payload, 0, Instant::now()).is_err());
        assert!(trace.lock().unwrap().inputs.is_empty());
    }
}
#[test]
fn malformed_native_output_cannot_fabricate_a_processed_tail() {
    let (mut engine, trace) = engine(); trace.lock().unwrap().invalid_output = true;
    assert!(engine.process_capture_partial_10ms_with_reference(None, &[0.5; 384], 0, Instant::now()).is_err());
}

// Independent adapter review. Keep the original tests intact; all added fault
// injection is local to this module and never selects an alternate production
// backend. The linked tests below use the actual verified WebRTC implementation.
mod adapter_review {
    use super::*;

    #[derive(Clone, Copy, Default)]
    enum Fault {
        #[default]
        None,
        ShortOutput,
        LongOutput,
        NonfiniteRealOutput,
        NonfinitePaddingOutput,
        CaptureError,
        RenderError,
    }
    #[derive(Default)]
    struct Audit {
        capture_inputs: Vec<Vec<f32>>,
        render_inputs: Vec<Vec<f32>>,
        delays: Vec<usize>,
        times: Vec<Instant>,
        successful_capture_calls: u64,
        successful_resets: u64,
        fail_reset: bool,
        fault: Fault,
    }
    struct AuditedEngine(Arc<Mutex<Audit>>);
    impl EchoCancellerEngine for AuditedEngine {
        fn push_render_10ms(&mut self, input: &[f32], _: Instant) -> Result<(), String> {
            let mut audit = self.0.lock().unwrap();
            audit.render_inputs.push(input.to_vec());
            if matches!(audit.fault, Fault::RenderError) { return Err("review render failed".into()); }
            Ok(())
        }
        fn process_capture_10ms(&mut self, input: &[f32], delay: usize, at: Instant)
            -> Result<EchoCancellationResult, String> {
            assert_eq!(input.len(), AEC_FRAME_SAMPLES, "native boundary is always 10ms stereo");
            let mut audit = self.0.lock().unwrap();
            audit.capture_inputs.push(input.to_vec());
            audit.delays.push(delay);
            audit.times.push(at);
            if matches!(audit.fault, Fault::CaptureError) { return Err("review capture failed".into()); }
            audit.successful_capture_calls += 1;
            let mut samples: Vec<_> = input.iter().map(|sample| sample * 0.5 + 0.125).collect();
            match audit.fault {
                Fault::ShortOutput => { samples.pop(); }
                Fault::LongOutput => samples.push(0.0),
                Fault::NonfiniteRealOutput => samples[0] = f32::NAN,
                // Fault lies ONLY in the synthetic suffix; validation must
                // happen before trimming, not merely on the real prefix.
                Fault::NonfinitePaddingOutput => samples[AEC_FRAME_SAMPLES - 1] = f32::INFINITY,
                _ => {}
            }
            Ok(EchoCancellationResult { samples })
        }
        fn reset(&mut self) -> Result<(), String> {
            let mut audit = self.0.lock().unwrap();
            if audit.fail_reset { return Err("review reset failed".into()); }
            audit.successful_resets += 1;
            Ok(())
        }
        fn stats(&self) -> EchoCancellerEngineStats {
            let audit = self.0.lock().unwrap();
            EchoCancellerEngineStats {
                backend: "webrtc-aec3", render_10ms_frames: audit.render_inputs.len() as u64,
                capture_10ms_frames: audit.successful_capture_calls,
                reset_count: audit.successful_resets, rejected_frame_count: 0,
                stats_read_failure_count: 0, erle_db: None, residual_echo_likelihood: None,
                reported_delay_ms: None, double_talk_frames: None,
                render_underrun_count: 0, capture_underrun_count: 0,
                processing_call_count: (audit.capture_inputs.len() + audit.render_inputs.len()) as u64,
                processing_time_micros_total: 0, max_processing_time_micros: 0,
            }
        }
    }
    fn audited() -> (ProductionEchoCanceller, Arc<Mutex<Audit>>) {
        let audit = Arc::new(Mutex::new(Audit::default()));
        let adapter = ProductionEchoCanceller::from_verified_aec3_engine_for_test(
            Box::new(AuditedEngine(audit.clone()))).unwrap();
        (adapter, audit)
    }

    #[test]
    fn real_672_frame_tail_uses_two_exact_native_calls_and_returns_only_real_1344_samples() {
        let (mut adapter, audit) = audited();
        let mut real = vec![0.5; 576 * 2];
        real.extend(vec![0.0; 96 * 2]);
        let before = real.clone();
        let start = Instant::now();
        let full = adapter.process_capture_10ms_with_reference(
            None, &real[..AEC_FRAME_SAMPLES], 3 * AEC_FRAME_SAMPLES, start).unwrap();
        let suffix = adapter.process_capture_partial_10ms_with_reference(
            None, &real[AEC_FRAME_SAMPLES..], 2 * AEC_FRAME_SAMPLES,
            start + Duration::from_millis(10)).unwrap();
        let output: Vec<_> = full.samples.into_iter().chain(suffix.samples).collect();
        assert_eq!(output.len(), real.len());
        assert_eq!(output, real.iter().map(|sample| sample * 0.5 + 0.125).collect::<Vec<_>>());
        assert_eq!(real, before, "caller input cannot acquire synthetic padding");
        let stats = adapter.stats();
        assert_eq!(stats.capture_10ms_frames, 2, "native blocks, NOT 960 real frames");
        assert_eq!(stats.processing_call_count, 2);
        let audit = audit.lock().unwrap();
        assert_eq!(audit.capture_inputs.len(), 2);
        assert_eq!(audit.capture_inputs[0], real[..AEC_FRAME_SAMPLES]);
        assert_eq!(&audit.capture_inputs[1][..192 * 2], &real[AEC_FRAME_SAMPLES..]);
        assert_eq!(&audit.capture_inputs[1][192 * 2..], &[0.0; 288 * 2]);
        assert_eq!(audit.delays, vec![3 * AEC_FRAME_SAMPLES, 2 * AEC_FRAME_SAMPLES]);
        assert_eq!(audit.times, vec![start, start + Duration::from_millis(10)]);
        println!("ADAPTER AUDIT: 672 real frames -> 480 + 192 real, 2 native 10ms calls, 288 math padding frames internal, 1344 output samples only.");
    }

    #[test]
    fn every_short_stereo_suffix_preserves_real_output_length_with_exactly_one_native_call() {
        for frames in 1..480 {
            let (mut adapter, audit) = audited();
            let real: Vec<_> = (0..frames * 2).map(|index| if index % 2 == 0 { 0.5 } else { -0.25 }).collect();
            let output = adapter.process_capture_partial_10ms_with_reference(None, &real, 0, Instant::now()).unwrap();
            assert_eq!(output.samples.len(), frames * 2);
            assert_eq!(output.samples, real.iter().map(|sample| sample * 0.5 + 0.125).collect::<Vec<_>>());
            let audit = audit.lock().unwrap();
            assert_eq!(audit.capture_inputs.len(), 1);
            assert_eq!(&audit.capture_inputs[0][..real.len()], real);
            assert!(audit.capture_inputs[0][real.len()..].iter().all(|sample| *sample == 0.0));
        }
    }

    #[test]
    fn paired_reference_is_one_real_10ms_reference_not_appended_to_capture_output() {
        let (mut adapter, audit) = audited();
        let reference = vec![-0.25; AEC_FRAME_SAMPLES];
        let output = adapter.process_capture_partial_10ms_with_reference(
            Some(&reference), &[0.5; 192 * 2], 77, Instant::now()).unwrap();
        assert_eq!(output.samples, vec![0.375; 192 * 2]);
        assert_eq!(adapter.stats().capture_10ms_frames, 1);
        assert_eq!(adapter.stats().processing_call_count, 2, "one render + one capture");
        let audit = audit.lock().unwrap();
        assert_eq!(audit.render_inputs, vec![reference]);
        assert_eq!(audit.capture_inputs.len(), 1);
        assert_eq!(audit.delays, vec![77]);
    }

    #[test]
    fn invalid_reference_or_render_failure_never_calls_capture_or_returns_fake_pcm() {
        for malformed in [true, false] {
            let (mut adapter, audit) = audited();
            let reference = if malformed { vec![0.0; 2] } else { vec![0.0; AEC_FRAME_SAMPLES] };
            if !malformed { audit.lock().unwrap().fault = Fault::RenderError; }
            assert!(adapter.process_capture_partial_10ms_with_reference(
                Some(&reference), &[0.5; 192 * 2], 0, Instant::now()).is_err());
            assert!(audit.lock().unwrap().capture_inputs.is_empty());
            assert_eq!(adapter.stats().capture_10ms_frames, 0);
        }
    }

    #[test]
    fn a_second_partial_and_normal_capture_cannot_advance_native_until_reset_succeeds() {
        let (mut adapter, audit) = audited();
        adapter.process_capture_partial_10ms_with_reference(None, &[0.0; 96 * 2], 0, Instant::now()).unwrap();
        let render = vec![0.0; AEC_FRAME_SAMPLES];
        for _ in 0..2 {
            assert!(adapter.process_capture_partial_10ms_with_reference(Some(&render), &[0.5; 2], 0, Instant::now()).is_err());
            assert!(adapter.process_capture_10ms_with_reference(Some(&render), &[0.0; AEC_FRAME_SAMPLES], 0, Instant::now()).is_err());
        }
        assert_eq!(adapter.stats().capture_10ms_frames, 1);
        assert!(audit.lock().unwrap().render_inputs.is_empty());
        audit.lock().unwrap().fail_reset = true;
        assert!(adapter.reset().is_err());
        assert!(adapter.partial_capture_boundary_pending());
        assert!(adapter.process_capture_partial_10ms_with_reference(None, &[0.5; 2], 0, Instant::now()).is_err());
        assert_eq!(adapter.stats().capture_10ms_frames, 1);
        assert_eq!(adapter.stats().reset_count, 0);
        audit.lock().unwrap().fail_reset = false;
        adapter.reset().unwrap();
        adapter.process_capture_10ms_with_reference(None, &[0.0; AEC_FRAME_SAMPLES], 0, Instant::now()).unwrap();
        assert_eq!(adapter.stats().capture_10ms_frames, 2);
        assert_eq!(adapter.stats().reset_count, 1);
    }

    #[test]
    fn wrong_length_and_nonfinite_native_outputs_fail_even_when_only_padding_is_corrupt() {
        for fault in [Fault::ShortOutput, Fault::LongOutput, Fault::NonfiniteRealOutput, Fault::NonfinitePaddingOutput] {
            let (mut adapter, audit) = audited();
            audit.lock().unwrap().fault = fault;
            assert!(adapter.process_capture_partial_10ms_with_reference(None, &[0.5; 192 * 2], 0, Instant::now()).is_err());
            assert_eq!(audit.lock().unwrap().capture_inputs.len(), 1);
            assert_eq!(adapter.stats().capture_10ms_frames, 1, "native ran; no valid real output returned");
        }
    }

    // Regression tests intentionally require the fail-closed boundary. A native
    // call has already advanced/possibly advanced its padded computational frame;
    // invalid output must not reopen capture without a successful native reset.
    fn failed_partial_must_block_resume(fault: Fault) {
        let (mut adapter, audit) = audited();
        audit.lock().unwrap().fault = fault;
        assert!(adapter.process_capture_partial_10ms_with_reference(None, &[0.5; 192 * 2], 0, Instant::now()).is_err());
        assert_eq!(audit.lock().unwrap().capture_inputs.len(), 1);
        audit.lock().unwrap().fault = Fault::None;
        assert!(adapter.process_capture_10ms_with_reference(None, &[0.0; AEC_FRAME_SAMPLES], 0, Instant::now()).is_err(),
            "native partial failure MUST fence resume: computational padding may already have advanced AEC");
        assert_eq!(audit.lock().unwrap().capture_inputs.len(), 1, "no second native call before reset");
        assert!(adapter.partial_capture_boundary_pending());
        audit.lock().unwrap().fail_reset = true;
        assert!(adapter.reset().is_err());
        assert!(adapter.partial_capture_boundary_pending());
        audit.lock().unwrap().fail_reset = false;
        adapter.reset().unwrap();
        adapter.process_capture_10ms_with_reference(None, &[0.0; AEC_FRAME_SAMPLES], 0, Instant::now()).unwrap();
        assert_eq!(audit.lock().unwrap().capture_inputs.len(), 2);
    }
    #[test]
    fn invalid_length_after_partial_native_call_requires_reset_before_resume() {
        failed_partial_must_block_resume(Fault::ShortOutput);
        failed_partial_must_block_resume(Fault::LongOutput);
    }
    #[test]
    fn nonfinite_partial_native_output_requires_reset_before_resume() {
        failed_partial_must_block_resume(Fault::NonfiniteRealOutput);
        failed_partial_must_block_resume(Fault::NonfinitePaddingOutput);
    }
    #[test]
    fn native_partial_call_error_requires_reset_before_resume() {
        failed_partial_must_block_resume(Fault::CaptureError);
    }
}

#[cfg(all(feature = "webrtc-aec3", target_os = "windows", target_env = "msvc", target_arch = "x86_64"))]
mod linked_adapter_review {
    use super::*;
    use crate::audio::state::AudioStateStore;
    use crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence;

    // Synthetic admission fixture ONLY for backend/native algorithm tests.
    // This does not assert actual device Empty queries or prove queue-owner
    // admission; that state machine is verified separately by capture_tail.
    fn fixture_tail_receipt(input: &[f32]) -> AecCaptureTailEvidence {
        let zero_samples = input.iter().filter(|sample| **sample == 0.0).count();
        AecCaptureTailEvidence {
            schema_version: 1, queue_generation: 1, capture_owner_id: 7,
            capture_reset_generation: 0, byte_len: input.len() * 4,
            last_empty_query_id: 101, empty_polls: 101,
            quiet_observation_span_ms: 2000.0, maximum_empty_poll_gap_ms: 20.0,
            last_nonempty_age_at_last_query_ms: 2020.0,
            all_zero: zero_samples == input.len(), zero_samples,
            nonzero_samples: input.len() - zero_samples, real_frames: input.len() / 2,
        }
    }

    // Native-only synthetic PCM; never opens WASAPI, a device or a Provider.
    fn real_pcm(frames: usize) -> Vec<f32> {
        (0..frames * 2).map(|sample| {
            if sample / 2 >= 576 { 0.0 }
            else if sample % 2 == 0 { 0.25 } else { -0.125 }
        }).collect()
    }

    #[test]
    fn linked_672_tail_matches_direct_native_prefix_and_exact_call_count_without_padding_output() {
        let store = AudioStateStore::new();
        store.activate_production_echo_canceller().expect("verified linked native AEC");
        let before = store.echo_canceller_stats().unwrap();
        let real = real_pcm(672);
        let untouched = real.clone();
        let (result, provenance) = store.process_echo_capture_tail_with_provenance(&real, 0, None, fixture_tail_receipt(&real)).unwrap();
        assert!(provenance.is_none(), "tap disabled; this is not fabricated packet provenance");
        let after = store.echo_canceller_stats().unwrap();
        assert_eq!(after.backend, "webrtc-aec3");
        assert_eq!(after.capture_10ms_frames - before.capture_10ms_frames, 2);
        assert_eq!(after.processing_call_count - before.processing_call_count, 2);
        assert_eq!(after.render_10ms_frames, before.render_10ms_frames);
        assert_eq!(after.reset_count, before.reset_count);
        assert_eq!(after.rejected_frame_count, before.rejected_frame_count);
        assert_eq!(after.stats_read_failure_count, 0, "native count must not be stale cached telemetry");
        assert_eq!(result.samples.len(), 672 * 2);
        assert!(result.samples.iter().all(|sample| sample.is_finite()));
        assert_eq!(real, untouched);
        assert!(store.echo_partial_capture_boundary_pending());

        // An independent directly linked AEC processes the exact same two
        // 10ms computational frames. Only real prefix output may be returned.
        let mut direct = omni_webrtc_aec3::Aec3::new().unwrap();
        let mut expected = Vec::new();
        for chunk in real.chunks(AEC_FRAME_SAMPLES) {
            let mut calculation = vec![0.0; AEC_FRAME_SAMPLES];
            calculation[..chunk.len()].copy_from_slice(chunk);
            direct.process_capture_10ms(&mut calculation, 0).unwrap();
            expected.extend_from_slice(&calculation[..chunk.len()]);
        }
        assert_eq!(direct.stats().unwrap().capture_10ms_frames, 2);
        assert_eq!(result.samples, expected, "linked native real output prefix, no raw passthrough or extra padding");
        println!("LINKED: realFrames=672 nativeCalls=2 internalMathPaddingFrames=288 outputSamples=1344 resetRequired=true");
    }

    #[test]
    fn linked_tail_lengths_and_all_zero_pcm_really_process_native_blocks_without_inflated_lengths() {
        for frames in [1, 96, 192, 479, 480, 481, 576, 672, 959] {
            for silent in [false, true] {
                let store = AudioStateStore::new();
                store.activate_production_echo_canceller().unwrap();
                let before = store.echo_canceller_stats().unwrap();
                let input = if silent { vec![0.0; frames * 2] } else { real_pcm(frames) };
                let (output, _) = store.process_echo_capture_tail_with_provenance(&input, 0, None, fixture_tail_receipt(&input)).unwrap();
                let after = store.echo_canceller_stats().unwrap();
                let expected_native_calls = ((frames + 479) / 480) as u64;
                assert_eq!(after.capture_10ms_frames - before.capture_10ms_frames, expected_native_calls);
                assert_eq!(after.processing_call_count - before.processing_call_count, expected_native_calls);
                assert_eq!(after.stats_read_failure_count, 0);
                assert_eq!(output.samples.len() / TARGET_CHANNEL_COUNT, frames, "never count mathematical padding as real PCM");
                assert!(output.samples.iter().all(|sample| sample.is_finite()));
                assert_eq!(store.echo_partial_capture_boundary_pending(), frames % 480 != 0);
            }
        }
    }

    #[test]
    fn linked_resume_rejection_does_not_call_native_and_successful_reset_reopens_real_capture() {
        let store = AudioStateStore::new();
        store.activate_production_echo_canceller().unwrap();
        let tail = store.process_echo_capture_tail_with_provenance(&real_pcm(672), 0, None, fixture_tail_receipt(&real_pcm(672))).unwrap().0;
        assert_eq!(tail.samples.len(), 1344);
        let before = store.echo_canceller_stats().unwrap();
        assert!(store.process_echo_capture_tail_with_provenance(&[0.0; 2], 0, None, fixture_tail_receipt(&[0.0; 2])).is_err());
        assert!(store.process_echo_capture_with_provenance(&[0.0; 960 * 2], 0, None).is_err());
        let rejected = store.echo_canceller_stats().unwrap();
        assert_eq!(rejected.capture_10ms_frames, before.capture_10ms_frames);
        assert_eq!(rejected.processing_call_count, before.processing_call_count);
        assert_eq!(rejected.reset_count, before.reset_count);
        assert!(store.echo_partial_capture_boundary_pending());
        store.reset_echo_canceller_with_diagnostic("linked-partial-tail-review", None, 0).unwrap();
        let reset = store.echo_canceller_stats().unwrap();
        assert_eq!(reset.reset_count, before.reset_count + 1);
        assert_eq!(reset.capture_10ms_frames, before.capture_10ms_frames);
        assert!(!store.echo_partial_capture_boundary_pending());
        let (normal, _) = store.process_echo_capture_with_provenance(&[0.0; 960 * 2], 0, None).unwrap();
        assert_eq!(normal.samples.len(), 960 * 2);
        let resumed = store.echo_canceller_stats().unwrap();
        assert_eq!(resumed.capture_10ms_frames - reset.capture_10ms_frames, 2);
        assert_eq!(resumed.processing_call_count - reset.processing_call_count, 2);
        assert_eq!(resumed.stats_read_failure_count, 0);
    }
}

#[cfg(all(feature = "webrtc-aec3", target_os = "windows", target_env = "msvc", target_arch = "x86_64"))]
#[test]
fn linked_partial_bad_input_is_rejected_before_any_native_capture_count_or_reset() {
    use crate::audio::state::AudioStateStore;
    use crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence;
    // Malformed-input paths must reject before interpreting this placeholder
    // admission fixture or invoking native AEC. It is not device-query evidence.
    for input in [vec![], vec![0.0], vec![0.0; 960 * 2], vec![f32::NAN; 2], vec![f32::INFINITY; 2], vec![f32::NEG_INFINITY; 2]] {
        let store = AudioStateStore::new();
        store.activate_production_echo_canceller().unwrap();
        let before = store.echo_canceller_stats().unwrap();
        let evidence = AecCaptureTailEvidence {
            schema_version: 1, queue_generation: 1, capture_owner_id: 7,
            capture_reset_generation: 0, byte_len: input.len() * 4,
            last_empty_query_id: 101, empty_polls: 101,
            quiet_observation_span_ms: 2000.0, maximum_empty_poll_gap_ms: 20.0,
            last_nonempty_age_at_last_query_ms: 2020.0,
            all_zero: false, zero_samples: 0, nonzero_samples: 0, real_frames: input.len() / 2,
        };
        assert!(store.process_echo_capture_tail_with_provenance(&input, 0, None, evidence).is_err());
        let after = store.echo_canceller_stats().unwrap();
        assert_eq!(after.capture_10ms_frames, before.capture_10ms_frames);
        assert_eq!(after.processing_call_count, before.processing_call_count);
        assert_eq!(after.reset_count, before.reset_count);
        assert!(!store.echo_partial_capture_boundary_pending());
    }
}

// Faults are injected AFTER a real linked WebRTC capture call succeeds. These
// prove native adaptation/counters advanced, unlike a pre-call rejecting mock.
#[cfg(all(feature = "webrtc-aec3", target_os = "windows", target_env = "msvc", target_arch = "x86_64"))]
mod linked_post_native_failure_review {
    use super::*;

    #[derive(Clone, Copy, Default)]
    enum AfterNative {
        #[default]
        Clean,
        BadLength,
        NaNReal,
        NaNPadding,
        ErrAfterSuccess,
    }
    #[derive(Default)]
    struct Control { fault: AfterNative, fail_reset: bool }
    struct NativeThenFault {
        native: Arc<Mutex<WebRtcAec3Engine>>,
        control: Arc<Mutex<Control>>,
    }
    impl EchoCancellerEngine for NativeThenFault {
        fn push_render_10ms(&mut self, input: &[f32], at: Instant) -> Result<(), String> {
            self.native.lock().unwrap().push_render_10ms(input, at)
        }
        fn process_capture_10ms(&mut self, input: &[f32], delay: usize, at: Instant)
            -> Result<EchoCancellationResult, String> {
            // This is actual linked native AEC, NOT a synthetic success count.
            let mut output = self.native.lock().unwrap().process_capture_10ms(input, delay, at)?;
            match self.control.lock().unwrap().fault {
                AfterNative::Clean => {}
                AfterNative::BadLength => { output.samples.pop(); }
                AfterNative::NaNReal => output.samples[0] = f32::NAN,
                AfterNative::NaNPadding => output.samples[AEC_FRAME_SAMPLES - 1] = f32::NAN,
                AfterNative::ErrAfterSuccess => {
                    return Err("injected failure AFTER successful linked native capture".into());
                }
            }
            Ok(output)
        }
        fn reset(&mut self) -> Result<(), String> {
            if self.control.lock().unwrap().fail_reset {
                return Err("injected unsuccessful reset; native state retained".into());
            }
            self.native.lock().unwrap().reset()
        }
        fn stats(&self) -> EchoCancellerEngineStats { self.native.lock().unwrap().stats() }
    }

    fn actual_native_failure_must_fence_resume(fault: AfterNative) {
        let native = Arc::new(Mutex::new(WebRtcAec3Engine::new().expect("actual linked native AEC")));
        let control = Arc::new(Mutex::new(Control { fault, fail_reset: false }));
        let mut adapter = ProductionEchoCanceller::from_verified_aec3_engine_for_test(
            Box::new(NativeThenFault { native: native.clone(), control: control.clone() })).unwrap();
        let before = adapter.stats();
        let error = adapter.process_capture_partial_10ms_with_reference(
            None, &[0.25; 192 * 2], 0, Instant::now());
        assert!(error.is_err(), "bad native output/Err must never return fabricated PCM");
        let advanced = adapter.stats();
        assert_eq!(advanced.capture_10ms_frames, before.capture_10ms_frames + 1,
            "real linked native capture MUST have succeeded before fault injection");
        assert_eq!(advanced.processing_call_count, before.processing_call_count + 1);
        assert_eq!(advanced.stats_read_failure_count, 0, "count must be native, not stale cached stats");
        assert_eq!(advanced.reset_count, before.reset_count);
        // Verify directly against the linked FFI handle as a second witness.
        assert_eq!(native.lock().unwrap().inner.stats().unwrap().capture_10ms_frames,
            before.capture_10ms_frames + 1);
        control.lock().unwrap().fault = AfterNative::Clean;
        println!("POST-NATIVE FAILURE: capture count actually advanced by 1; invalid partial result must remain fenced until successful native reset.");
        assert!(adapter.process_capture_10ms_with_reference(
            None, &[0.0; AEC_FRAME_SAMPLES], 0, Instant::now()).is_err(),
            "adapter cannot resume after bad partial result: real native padding already advanced its state");
        assert_eq!(adapter.stats().capture_10ms_frames, advanced.capture_10ms_frames);
        assert_eq!(adapter.stats().processing_call_count, advanced.processing_call_count);
        assert!(adapter.partial_capture_boundary_pending());
        control.lock().unwrap().fail_reset = true;
        assert!(adapter.reset().is_err());
        assert_eq!(adapter.stats().reset_count, before.reset_count);
        assert!(adapter.partial_capture_boundary_pending(), "failed reset cannot reopen native capture");
        assert!(adapter.process_capture_partial_10ms_with_reference(
            None, &[0.25; 2], 0, Instant::now()).is_err());
        assert_eq!(adapter.stats().capture_10ms_frames, advanced.capture_10ms_frames);
        control.lock().unwrap().fail_reset = false;
        adapter.reset().unwrap();
        let reset = adapter.stats();
        assert_eq!(reset.reset_count, before.reset_count + 1);
        assert_eq!(reset.capture_10ms_frames, advanced.capture_10ms_frames);
        assert!(!adapter.partial_capture_boundary_pending());
        let resumed = adapter.process_capture_10ms_with_reference(
            None, &[0.0; AEC_FRAME_SAMPLES], 0, Instant::now()).unwrap();
        assert_eq!(resumed.samples.len(), AEC_FRAME_SAMPLES);
        assert!(resumed.samples.iter().all(|sample| sample.is_finite()));
        assert_eq!(adapter.stats().capture_10ms_frames, advanced.capture_10ms_frames + 1);
    }

    #[test]
    fn linked_bad_length_after_successful_native_partial_call_requires_reset_before_resume() {
        actual_native_failure_must_fence_resume(AfterNative::BadLength);
    }
    #[test]
    fn linked_nan_after_successful_native_partial_call_requires_reset_before_resume() {
        actual_native_failure_must_fence_resume(AfterNative::NaNReal);
        actual_native_failure_must_fence_resume(AfterNative::NaNPadding);
    }
    #[test]
    fn linked_err_after_successful_native_partial_call_requires_reset_before_resume() {
        actual_native_failure_must_fence_resume(AfterNative::ErrAfterSuccess);
    }
}

#[test]
fn closed_segment_adapter_fences_aligned_input_before_native_and_invalid_output() {
    for frames in [96, 480, 481, 959] {
        let (mut adapter, trace) = engine();
        trace.lock().unwrap().invalid_output = true;
        assert!(adapter.process_capture_boundary_with_reference(&vec![0.5; frames * 2], 0,
            Instant::now(), |_| None).is_err());
        assert!(adapter.partial_capture_boundary_pending());
        assert_eq!(trace.lock().unwrap().inputs.len(), 1);
        assert!(adapter.process_capture_10ms_with_reference(None, &[0.0; 960], 0, Instant::now()).is_err());
        assert!(adapter.process_capture_partial_10ms_with_reference(None, &[0.0; 192], 0, Instant::now()).is_err());
        assert!(adapter.process_capture(&[0.0; 960], 0).is_err());
        trace.lock().unwrap().fail_reset = true;
        assert!(adapter.reset().is_err());
        assert!(adapter.partial_capture_boundary_pending());
        assert_eq!(trace.lock().unwrap().inputs.len(), 1);
        trace.lock().unwrap().fail_reset = false;
        trace.lock().unwrap().invalid_output = false;
        adapter.reset().unwrap();
        assert!(!adapter.partial_capture_boundary_pending());
        adapter.process_capture_10ms_with_reference(None, &[0.0; 960], 0, Instant::now()).unwrap();
    }
}

#[test]
fn malformed_closed_segment_adapter_input_does_not_match_reference_or_admit_native() {
    for input in [vec![], vec![0.0], vec![f32::NAN; 2], vec![f32::INFINITY; 2], vec![0.0; 1920]] {
        let (mut adapter, trace) = engine();
        assert!(adapter.process_capture_boundary_with_reference(&input, 0, Instant::now(),
            |_| panic!("malformed boundary must not consume reference")).is_err());
        assert!(trace.lock().unwrap().inputs.is_empty());
        assert!(!adapter.partial_capture_boundary_pending());
    }
}
