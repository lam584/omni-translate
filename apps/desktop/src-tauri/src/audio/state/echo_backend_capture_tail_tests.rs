use super::*;
use crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence;
use crate::audio::echo_cancel::EchoCancellerEngine;
use std::sync::{Arc, Mutex};

struct TaggedCapture(Arc<Mutex<Vec<Vec<f32>>>>);
impl EchoCancellerEngine for TaggedCapture {
    fn push_render_10ms(&mut self, _: &[f32], _: Instant) -> Result<(), String> { Ok(()) }
    fn process_capture_10ms(&mut self, frame: &[f32], _: usize, _: Instant) -> Result<EchoCancellationResult, String> {
        self.0.lock().unwrap().push(frame.to_vec());
        Ok(EchoCancellationResult { samples: frame.iter().map(|value| value * 0.5 + 0.01).collect() })
    }
    fn reset(&mut self) -> Result<(), String> { Ok(()) }
    fn stats(&self) -> EchoCancellerEngineStats {
        EchoCancellerEngineStats { backend: "webrtc-aec3", render_10ms_frames: 0,
            capture_10ms_frames: self.0.lock().unwrap().len() as u64, reset_count: 0,
            rejected_frame_count: 0, stats_read_failure_count: 0, erle_db: None,
            residual_echo_likelihood: None, reported_delay_ms: None, double_talk_frames: None,
            render_underrun_count: 0, capture_underrun_count: 0, processing_call_count: 0,
            processing_time_micros_total: 0, max_processing_time_micros: 0 }
    }
}
fn tail_receipt(frames: usize) -> AecCaptureTailEvidence {
    AecCaptureTailEvidence { schema_version: 1, queue_generation: 17, capture_owner_id: 5,
        capture_reset_generation: 2, byte_len: frames * 8, last_empty_query_id: 123,
        empty_polls: 101, quiet_observation_span_ms: 2000.0, maximum_empty_poll_gap_ms: 20.0,
        last_nonempty_age_at_last_query_ms: 2020.0, all_zero: true,
        zero_samples: frames * 2, nonzero_samples: 0, real_frames: frames }
}
fn store() -> (AudioStateStore, Arc<Mutex<Vec<Vec<f32>>>>) {
    let store = AudioStateStore::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    *store.echo_canceller.lock().unwrap() = Some(crate::audio::echo_cancel::create_echo_canceller_for_test(
        Box::new(TaggedCapture(calls.clone()))).unwrap());
    (store, calls)
}

#[test]
fn all_672_real_frames_are_native_processed_and_only_math_padding_is_trimmed() {
    let (store, calls) = store();
    let mut captured = vec![0.4; 576 * 2]; captured.extend(vec![0.0; 96 * 2]);
    let mut receipt = tail_receipt(672);
    receipt.all_zero = false; receipt.zero_samples = 192; receipt.nonzero_samples = 1152;
    let (output, _) = store.process_echo_capture_tail_with_provenance(&captured, 0, None, receipt).unwrap();
    assert_eq!(output.samples.len(), 1344);
    assert_eq!(output.samples[..1152], vec![0.4_f32 * 0.5 + 0.01; 1152]);
    assert_eq!(output.samples[1152..], vec![0.01; 192]);
    let recorded = calls.lock().unwrap();
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0], captured[..960]);
    assert_eq!(recorded[1][..384], captured[960..]);
    assert_eq!(recorded[1][384..], vec![0.0; 576]);
    drop(recorded);
    assert!(store.echo_partial_capture_boundary_pending());
    assert!(store.process_echo_capture_with_provenance(&vec![0.0; 1920], 0, None).is_err());
    assert_eq!(calls.lock().unwrap().len(), 2);
    store.reset_echo_canceller_with_diagnostic("capture-resume-after-partial-tail", None, 0).unwrap();
    assert!(!store.echo_partial_capture_boundary_pending());
    assert_eq!(store.process_echo_capture_with_provenance(&vec![0.0; 1920], 0, None).unwrap().0.samples.len(), 1920);
    assert_eq!(calls.lock().unwrap().len(), 4);
}

#[test]
fn real_zero_tail_is_not_silently_discarded_or_mislabeled_as_native_padding() {
    let (store, calls) = store();
    let (output, _) = store.process_echo_capture_tail_with_provenance(&vec![0.0; 192], 0, None, tail_receipt(96)).unwrap();
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert_eq!(output.samples, vec![0.01; 192]);
    assert!(store.echo_partial_capture_boundary_pending());
}

#[test]
fn a_480_frame_real_tail_needs_one_native_call_and_no_resume_reset() {
    let (store, calls) = store();
    let (output, _) = store.process_echo_capture_tail_with_provenance(&vec![0.0; 960], 0, None, tail_receipt(480)).unwrap();
    assert_eq!(output.samples.len(), 960);
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert!(!store.echo_partial_capture_boundary_pending());
}

#[test]
fn normal_entry_rejects_partial_input_instead_of_raw_suffix_passthrough() {
    let (store, calls) = store();
    assert!(store.process_echo_capture_with_provenance(&vec![0.25; 1344], 0, None).is_err());
    assert!(calls.lock().unwrap().is_empty());
}
