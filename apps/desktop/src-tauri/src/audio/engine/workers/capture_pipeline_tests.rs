use super::*;
use serde_json::json;

fn pipeline() -> CapturePipeline {
    let spec = RouteSpec::from_config(&json!({"devices": {
        "inboundRoute": {"routeId":"inbound-route", "input":{"deviceId":"speaker-1"}}
    }}), "inbound").unwrap();
    let mut pipeline = CapturePipeline::new(spec);
    pipeline.delay_samples = 2880;
    pipeline.metadata = Some(AecCaptureFrameMetadata {
        packet_device_frame_index: 1920, packet_qpc_100ns: 1_400_000,
        queue_head_device_frame_index: 1440, queue_head_qpc_100ns: 1_300_000,
        observed_qpc_100ns: Some(1_500_000), continuity_id: 7, delay_samples: 2880,
        timestamp_error: false, data_discontinuity: false, queue_head_clock_valid: true,
    });
    pipeline.queue_clock.observe_packet(0, 960 * 8, false, false, true);
    pipeline
}

#[test]
fn real_tail_advances_only_its_672_frames_and_keeps_packet_identity() {
    let mut pipeline = pipeline();
    let head = pipeline.capture_metadata().unwrap();
    pipeline.consume_capture_clock(672, 672 * 8);
    let after = pipeline.capture_metadata().unwrap();
    assert_eq!(after.queue_head_device_frame_index, head.queue_head_device_frame_index + 672);
    assert_eq!(after.queue_head_qpc_100ns, head.queue_head_qpc_100ns + 140_000);
    assert_eq!(after.packet_device_frame_index, head.packet_device_frame_index);
    assert_eq!(after.packet_qpc_100ns, head.packet_qpc_100ns);
    assert_eq!(after.observed_qpc_100ns, head.observed_qpc_100ns);
    assert_eq!(after.delay_samples, 1536);
    assert!(after.queue_head_clock_valid);
}

#[test]
fn invalid_prefix_recovers_without_idle_poll_reanchoring_or_carrying_the_mask() {
    let mut pipeline = pipeline();
    pipeline.queue_clock.observe_packet(576 * 8, (576 + 1920) * 8, true, false, true);
    assert!(!pipeline.capture_metadata().unwrap().queue_head_clock_valid);
    pipeline.consume_capture_clock(960, 960 * 8);
    assert!(pipeline.capture_metadata().unwrap().queue_head_clock_valid);
    let head = pipeline.capture_metadata().unwrap();
    // No read/query/wait supplies a replacement clock: only consumption moves it.
    for _ in 0..2000 { assert_eq!(pipeline.capture_metadata().unwrap(), head); }
}

#[test]
fn clock_overflow_or_bad_anchor_cannot_be_rehabilitated_by_consuming_a_tail() {
    let mut pipeline = pipeline();
    pipeline.metadata.as_mut().unwrap().queue_head_qpc_100ns = u64::MAX;
    pipeline.consume_capture_clock(192, 192 * 8);
    assert!(!pipeline.capture_metadata().unwrap().queue_head_clock_valid);
    pipeline.metadata.as_mut().unwrap().queue_head_clock_valid = true;
    pipeline.queue_clock.observe_packet(0, 192 * 8, false, true, false);
    assert!(!pipeline.capture_metadata().unwrap().queue_head_clock_valid);
    pipeline.consume_capture_clock(192, 192 * 8);
    assert!(!pipeline.capture_metadata().unwrap().queue_head_clock_valid);
}

#[test]
fn actual_route_frame_count_and_cached_voiced_pcm_exclude_computational_padding() {
    let mut pipeline = pipeline();
    for frames in [960, 672, 96, 192, 480] {
        let chunk = f32_stereo_to_bytes(&vec![0.25; frames * 2]);
        pipeline.processor.ingest_chunk(&chunk, 0);
    }
    assert_eq!(pipeline.processor.frames_captured, 2400);
    let active = pipeline.processor.active_segment.as_ref().unwrap();
    assert_eq!(active.audio_bytes.len(), 2400 * 8);
}
