use super::*;
use crate::audio::aec_diagnostic_tap::AecCaptureBoundaryEvidence;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct BoundaryTrace {
    inputs: Vec<Vec<f32>>,
    fail_call: Option<usize>,
    fail_reset: bool,
    resets: usize,
}
struct BoundaryEngine(Arc<Mutex<BoundaryTrace>>);
impl crate::audio::echo_cancel::EchoCancellerEngine for BoundaryEngine {
    fn push_render_10ms(&mut self, _: &[f32], _: Instant) -> Result<(), String> { Ok(()) }
    fn process_capture_10ms(&mut self, input: &[f32], _: usize, _: Instant)
        -> Result<EchoCancellationResult, String> {
        let mut trace = self.0.lock().unwrap();
        trace.inputs.push(input.to_vec());
        if trace.fail_call == Some(trace.inputs.len()) { return Err("boundary native failure".into()); }
        Ok(EchoCancellationResult { samples: input.iter().map(|v| v * 0.5 + 0.125).collect() })
    }
    fn reset(&mut self) -> Result<(), String> {
        let mut trace = self.0.lock().unwrap();
        if trace.fail_reset { return Err("boundary reset failure".into()); }
        trace.resets += 1;
        Ok(())
    }
    fn stats(&self) -> EchoCancellerEngineStats {
        let trace = self.0.lock().unwrap();
        EchoCancellerEngineStats { backend: "webrtc-aec3", render_10ms_frames: 0,
            capture_10ms_frames: trace.inputs.len() as u64, reset_count: trace.resets as u64,
            rejected_frame_count: 0, stats_read_failure_count: 0, erle_db: None,
            residual_echo_likelihood: None, reported_delay_ms: None, double_talk_frames: None,
            render_underrun_count: 0, capture_underrun_count: 0, processing_call_count: 0,
            processing_time_micros_total: 0, max_processing_time_micros: 0 }
    }
}
fn fixture() -> (AudioStateStore, Arc<Mutex<BoundaryTrace>>) {
    let store = AudioStateStore::new();
    let trace = Arc::new(Mutex::new(BoundaryTrace::default()));
    *store.echo_canceller.lock().unwrap() = Some(crate::audio::echo_cancel::create_echo_canceller_for_test(
        Box::new(BoundaryEngine(trace.clone()))).unwrap());
    (store, trace)
}
fn proof(frames: usize) -> AecCaptureBoundaryEvidence {
    AecCaptureBoundaryEvidence { schema_version: 1, capture_owner_id: 5, queue_generation: 17,
        boundary_id: 9, closed_segment_id: 3, next_segment_id: 4, byte_len: frames * 8,
        real_frames: frames, boundary_reason: "device-frame-gap",
        old_segment_start_device_frame_index: 1000, old_segment_start_qpc_100ns: 1_000_000,
        old_segment_end_device_frame_index: 1000 + frames as u64,
        next_packet_device_frame_index: 2000, next_packet_qpc_100ns: 2_000_000,
        next_packet_data_discontinuity: false, next_packet_timestamp_error: false,
        previous_packet_timestamp_error: false }
}
fn metadata(valid: bool) -> AecCaptureFrameMetadata {
    AecCaptureFrameMetadata { packet_device_frame_index: 1000, packet_qpc_100ns: 1_000_000,
        queue_head_device_frame_index: 1000, queue_head_qpc_100ns: 1_000_000,
        observed_qpc_100ns: None, continuity_id: 3, delay_samples: 0,
        timestamp_error: false, data_discontinuity: false, queue_head_clock_valid: valid }
}

#[test]
fn every_short_prefix_p5_and_full_or_two_block_boundaries_preserve_exact_real_samples() {
    // Includes p5=96, every 1..479 suffix, aligned 480, and every 481..959 prefix.
    for frames in 1..960 {
        let (store, trace) = fixture();
        assert!(!store.aec_diagnostic_tap.enabled());
        let input: Vec<f32> = (0..frames * 2).map(|i| (i as f32 + 1.0) / 2048.0).collect();
        let (output, lineage, identity) = store.process_echo_capture_boundary_with_queue_receipt(
            &input, 0, Some(metadata(false)), proof(frames)).unwrap();
        assert!(lineage.is_none());
        assert!(identity.is_none());
        assert_eq!(output.samples, input.iter().map(|v| v * 0.5 + 0.125).collect::<Vec<_>>());
        let calls = trace.lock().unwrap();
        let expected_calls = frames.div_ceil(480);
        assert_eq!(calls.inputs.len(), expected_calls);
        let native: Vec<_> = calls.inputs.iter().flatten().copied().collect();
        assert_eq!(&native[..input.len()], input);
        assert!(native[input.len()..].iter().all(|v| *v == 0.0));
        drop(calls);
        assert!(store.echo_partial_capture_boundary_pending());
        assert!(store.process_echo_capture_with_queue_receipt(&vec![0.25; 1920], 0, None, None).is_err());
        assert!(store.process_echo_capture_boundary_with_queue_receipt(&input, 0, None, proof(frames)).is_err());
        assert_eq!(trace.lock().unwrap().inputs.len(), expected_calls);
        store.reset_echo_canceller_with_diagnostic("capture-segment-boundary", None, 4).unwrap();
        assert!(!store.echo_partial_capture_boundary_pending());
        assert_eq!(store.process_echo_capture_with_queue_receipt(&vec![0.25; 1920], 0, None, None)
            .unwrap().0.samples.len(), 1920);
    }
}

#[test]
fn boundary_native_failure_and_failed_reset_keep_full_and_partial_capture_fenced() {
    for (frames, fail_call) in [(96, 1), (480, 1), (481, 1), (481, 2), (959, 2)] {
        let (store, trace) = fixture();
        trace.lock().unwrap().fail_call = Some(fail_call);
        let input = vec![0.25; frames * 2];
        assert!(store.process_echo_capture_boundary_with_queue_receipt(&input, 0, None, proof(frames)).is_err());
        assert!(store.echo_partial_capture_boundary_pending());
        assert!(store.process_echo_capture_with_queue_receipt(&vec![0.25; 960], 0, None, None).is_err());
        trace.lock().unwrap().fail_reset = true;
        assert!(store.reset_echo_canceller_with_diagnostic("boundary-reset", None, 4).is_err());
        assert!(store.echo_partial_capture_boundary_pending());
        assert!(store.process_echo_capture_boundary_with_queue_receipt(&input, 0, None, proof(frames)).is_err());
        let quiet_tail = crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence {
            schema_version: 1, queue_generation: 17, capture_owner_id: 5, capture_reset_generation: 2,
            byte_len: 768, last_empty_query_id: 123, empty_polls: 101,
            quiet_observation_span_ms: 2000.0, maximum_empty_poll_gap_ms: 20.0,
            last_nonempty_age_at_last_query_ms: 2020.0, all_zero: false,
            zero_samples: 0, nonzero_samples: 192, real_frames: 96,
        };
        assert!(store.process_echo_capture_with_queue_receipt(&vec![0.25; 192], 0, None, Some(quiet_tail)).is_err());
        assert_eq!(trace.lock().unwrap().inputs.len(), fail_call);
        trace.lock().unwrap().fail_reset = false;
        trace.lock().unwrap().fail_call = None;
        store.reset_echo_canceller_with_diagnostic("boundary-reset", None, 4).unwrap();
        assert!(!store.echo_partial_capture_boundary_pending());
        store.process_echo_capture_with_queue_receipt(&vec![0.25; 960], 0, None, None).unwrap();
    }
}

#[test]
fn boundary_reason_requires_raw_next_previous_packet_flags_or_gap() {
    for reason in ["data-discontinuity", "timestamp-error", "device-frame-gap", "untrusted-predecessor"] {
        let (store, trace) = fixture();
        let mut evidence = proof(96);
        evidence.boundary_reason = reason;
        evidence.next_packet_device_frame_index = evidence.old_segment_end_device_frame_index;
        evidence.next_packet_data_discontinuity = reason == "data-discontinuity";
        evidence.next_packet_timestamp_error = reason == "timestamp-error";
        evidence.previous_packet_timestamp_error = reason == "untrusted-predecessor";
        if reason == "device-frame-gap" { evidence.next_packet_device_frame_index += 1; }
        let old_metadata = metadata(reason != "untrusted-predecessor");
        store.process_echo_capture_boundary_with_queue_receipt(&vec![0.25; 192], 0,
            Some(old_metadata), evidence).unwrap();
        assert_eq!(trace.lock().unwrap().inputs.len(), 1);
        assert!(store.echo_partial_capture_boundary_pending());
    }
    for reason in ["data-discontinuity", "timestamp-error", "device-frame-gap", "untrusted-predecessor", "quiet-tail"] {
        let (store, trace) = fixture();
        let mut evidence = proof(96);
        evidence.boundary_reason = reason;
        evidence.next_packet_device_frame_index = evidence.old_segment_end_device_frame_index;
        assert!(store.process_echo_capture_boundary_with_queue_receipt(&vec![0.25; 192], 0,
            Some(metadata(true)), evidence).is_err());
        assert!(trace.lock().unwrap().inputs.is_empty());
        assert!(!store.echo_partial_capture_boundary_pending());
    }
    // The explicit flag is required independently of metadata availability or
    // validity. The tracker supplies it; Node independently binds the raw row.
    for old_metadata in [None, Some(metadata(false)), Some(metadata(true))] {
        let (store, trace) = fixture();
        let mut evidence = proof(96); evidence.boundary_reason = "untrusted-predecessor";
        evidence.previous_packet_timestamp_error = true;
        store.process_echo_capture_boundary_with_queue_receipt(&vec![0.25; 192], 0, old_metadata, evidence).unwrap();
        assert_eq!(trace.lock().unwrap().inputs.len(), 1);
        assert!(store.echo_partial_capture_boundary_pending());
    }
}

#[test]
fn untrusted_predecessor_with_matching_numbers_but_false_old_timestamp_flag_is_rejected_before_native() {
    for old_metadata in [None, Some(metadata(false)), Some(metadata(true)),
        Some(AecCaptureFrameMetadata { timestamp_error: true, ..metadata(false) })] {
        let (store, trace) = fixture();
        let mut evidence = proof(96);
        evidence.boundary_reason = "untrusted-predecessor";
        evidence.previous_packet_timestamp_error = false;
        // All owner, segment, byte/frame and metadata numbers are unchanged
        // and consistent. Even invalid/timestamp-error metadata cannot replace
        // the required raw previous-packet flag in the boundary evidence.
        assert!(store.process_echo_capture_boundary_with_queue_receipt(
            &vec![0.25; 192], 0, old_metadata, evidence).is_err());
        assert!(trace.lock().unwrap().inputs.is_empty());
        assert_eq!(trace.lock().unwrap().resets, 0);
        assert!(!store.echo_partial_capture_boundary_pending());
        // Rejection leaves the native stream usable without a reset.
        store.process_echo_capture_with_queue_receipt(&vec![0.25; 960], 0, None, None).unwrap();
        assert_eq!(trace.lock().unwrap().inputs.len(), 1);
    }
}

#[test]
fn malformed_payload_identity_and_overflow_never_enter_native() {
    let good = proof(96);
    let mut cases = Vec::new();
    macro_rules! bad { ($field:ident, $value:expr) => {{ let mut v = good; v.$field = $value; cases.push(v); }}; }
    bad!(schema_version, 2); bad!(capture_owner_id, 0); bad!(queue_generation, 0);
    bad!(boundary_id, 0); bad!(closed_segment_id, 0); bad!(next_segment_id, 0);
    bad!(next_segment_id, 5); bad!(byte_len, good.byte_len - 1); bad!(byte_len, usize::MAX);
    bad!(real_frames, 95); bad!(real_frames, usize::MAX);
    bad!(closed_segment_id, u64::MAX); bad!(old_segment_start_device_frame_index, u64::MAX - 95);
    bad!(old_segment_end_device_frame_index, 999); bad!(old_segment_end_device_frame_index, 1095);
    bad!(old_segment_end_device_frame_index, 1097);
    for evidence in cases {
        let (store, trace) = fixture();
        assert!(store.process_echo_capture_boundary_with_queue_receipt(&vec![0.25; 192], 0, None, evidence).is_err());
        assert!(trace.lock().unwrap().inputs.is_empty());
        assert!(!store.echo_partial_capture_boundary_pending());
    }
    for input in [vec![], vec![0.0], vec![0.0; 191], vec![f32::NAN; 192], vec![f32::INFINITY; 192],
        vec![0.0; 1920], vec![0.0; 1922]] {
        let (store, trace) = fixture();
        let mut evidence = proof(input.len() / 2);
        evidence.byte_len = input.len() * 4;
        assert!(store.process_echo_capture_boundary_with_queue_receipt(&input, 0, None, evidence).is_err());
        assert!(trace.lock().unwrap().inputs.is_empty());
    }
    for old in [AecCaptureFrameMetadata { queue_head_device_frame_index: 999, ..metadata(false) },
        AecCaptureFrameMetadata { queue_head_qpc_100ns: 999, ..metadata(false) }] {
        let (store, trace) = fixture();
        assert!(store.process_echo_capture_boundary_with_queue_receipt(&vec![0.25; 192], 0, Some(old), good).is_err());
        assert!(trace.lock().unwrap().inputs.is_empty());
    }
}

#[test]
fn boundary_tap_records_schema_two_real_pcm_only_and_preserves_invalid_raw_clock() {
    for frames in [96, 480, 481, 959] {
        let directory = std::env::temp_dir().join(format!("aec-boundary-{}", uuid::Uuid::new_v4()));
        let (mut store, trace) = fixture();
        store.aec_diagnostic_tap = AecDiagnosticTap::start_diagnostic_only_for_test(&directory).unwrap();
        assert!(!store.aec_provider_lineage_required());
        let old_metadata = AecCaptureFrameMetadata {
            packet_device_frame_index: 1100, packet_qpc_100ns: 0,
            timestamp_error: true, data_discontinuity: true, ..metadata(false)
        };
        let mut evidence = proof(frames);
        // The actual tracker supplies this reason, not the invalid clock bit.
        evidence.boundary_reason = "untrusted-predecessor";
        evidence.previous_packet_timestamp_error = true;
        let input = vec![0.5; frames * 2];
        let (output, lineage, identity) = store.process_echo_capture_boundary_with_queue_receipt(
            &input, 0, Some(old_metadata), evidence).unwrap();
        assert!(lineage.is_none());
        assert!(identity.is_some());
        assert!(!store.aec_provider_lineage_required());
        assert!(store.echo_partial_capture_boundary_pending());
        let terminal = store.finish_aec_diagnostic_tap(Duration::from_secs(2)).unwrap();
        assert_eq!(terminal["sampleCounts"]["pre"], frames * 2);
        assert_eq!(terminal["sampleCounts"]["post"], frames * 2);
        for name in ["aec-pre-capture-48k-stereo.f32le", "aec-post-output-48k-stereo.f32le"] {
            assert_eq!(std::fs::metadata(directory.join(name)).unwrap().len(), (frames * 8) as u64);
        }
        let pre_bytes = std::fs::read(directory.join("aec-pre-capture-48k-stereo.f32le")).unwrap();
        let pre: Vec<_> = pre_bytes.chunks_exact(4).map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap())).collect();
        assert_eq!(pre, input);
        let post_bytes = std::fs::read(directory.join("aec-post-output-48k-stereo.f32le")).unwrap();
        let post: Vec<_> = post_bytes.chunks_exact(4).map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap())).collect();
        assert_eq!(post, output.samples);
        let rows = std::fs::read_to_string(directory.join("aec-frame-metadata.jsonl")).unwrap();
        let row: serde_json::Value = serde_json::from_str(rows.trim()).unwrap();
        let processing = &row["aecProcessing"];
        assert_eq!(processing["schemaVersion"], 2);
        assert_eq!(processing["boundaryAdmission"]["schemaVersion"], 1);
        assert_eq!(processing["boundaryAdmission"]["previousPacketTimestampError"], true);
        assert_eq!(processing["inputFrames"], frames);
        assert_eq!(processing["native10msFrames"], trace.lock().unwrap().inputs.len());
        assert_eq!(processing["mathPaddingFrames"], frames.div_ceil(480) * 480 - frames);
        assert_eq!(processing["allInputProcessed"], true);
        assert_eq!(processing["resetBeforeResumeRequired"], true);
        assert!(processing["tailAdmission"].is_null());
        assert_eq!(processing["boundaryAdmission"], serde_json::to_value(evidence).unwrap());
        // A boundary receipt must not upgrade old invalid capture clock metadata.
        assert_eq!(row["rawPacketDeviceFrameIndex"], old_metadata.packet_device_frame_index);
        assert!(row["packetDeviceFrameIndex"].is_null());
        assert_eq!(row["rawPacketQpc100ns"], old_metadata.packet_qpc_100ns);
        assert!(row["packetQpc100ns"].is_null());
        assert!(row["queueHeadDeviceFrameIndex"].is_null());
        assert!(row["queueHeadQpc100ns"].is_null());
        assert_eq!(row["queueHeadClockValid"], false);
        assert_eq!(row["timestampError"], true);
        assert_eq!(row["dataDiscontinuity"], true);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn normal_and_quiet_tail_processing_keep_schema_one_without_boundary_admission_key() {
    for tail in [false, true] {
        let directory = std::env::temp_dir().join(format!("aec-v1-boundary-none-{}", uuid::Uuid::new_v4()));
        let (mut store, _) = fixture();
        store.aec_diagnostic_tap = AecDiagnosticTap::start_diagnostic_only_for_test(&directory).unwrap();
        let receipt = tail.then_some(crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence {
            schema_version: 1, queue_generation: 17, capture_owner_id: 5, capture_reset_generation: 2,
            byte_len: 3840, last_empty_query_id: 123, empty_polls: 101,
            quiet_observation_span_ms: 2000.0, maximum_empty_poll_gap_ms: 20.0,
            last_nonempty_age_at_last_query_ms: 2020.0, all_zero: false,
            zero_samples: 0, nonzero_samples: 960, real_frames: 480,
        });
        store.process_echo_capture_with_queue_receipt(&vec![0.25; 960], 0, Some(metadata(true)), receipt).unwrap();
        assert!(!store.echo_partial_capture_boundary_pending());
        store.finish_aec_diagnostic_tap(Duration::from_secs(2)).unwrap();
        let rows = std::fs::read_to_string(directory.join("aec-frame-metadata.jsonl")).unwrap();
        let row: serde_json::Value = serde_json::from_str(rows.trim()).unwrap();
        assert_eq!(row["aecProcessing"]["schemaVersion"], 1);
        assert!(row["aecProcessing"].get("boundaryAdmission").is_none());
        assert_eq!(row["aecProcessing"]["tailAdmission"].is_object(), tail);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
