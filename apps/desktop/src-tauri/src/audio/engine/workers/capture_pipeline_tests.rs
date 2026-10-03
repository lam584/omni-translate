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

fn packet_witness<'a>(buffer_info: &'a wasapi::BufferInfo, frames: usize, before_frames: usize)
    -> capture_diagnostics::NativeCapturePacketWitness<'a> {
    capture_diagnostics::NativeCapturePacketWitness {
        buffer_info, captured_frames: frames, queued_bytes_before_read: before_frames * 8,
        queued_bytes_after_read: (before_frames + frames) * 8, block_align: 8,
        observed_qpc_100ns: Some(9_000_000), direction: "inbound",
        requested_endpoint_id: "requested-endpoint", endpoint_id: None,
        capture_owner_id: None, capture_aec_reset_generation: None, queue_append: None,
    }
}

#[test]
fn native_capture_packet_witness_includes_96_480_576_frame_reads_without_processing() {
    let pipeline = pipeline();
    let before = pipeline.capture_metadata().unwrap();
    let mut records = Vec::new();
    for (frames, prefix) in [(96, 0), (480, 96), (576, 192)] {
        assert!(frames + prefix < CHUNK_FRAMES);
        let info = wasapi::BufferInfo::new(0, 6_672_000 + frames as u64, 4_207_119_107_588);
        capture_diagnostics::record_native_capture_packet_witness(packet_witness(&info, frames, prefix),
            |record| records.push(record));
        let row = records.last().unwrap();
        assert_eq!(row["rawFrameCount"], json!(frames));
        assert_eq!(row["rawByteCount"], json!(frames * 8));
        assert_eq!(row["queuedBytesBeforeRead"], json!(prefix * 8));
        assert_eq!(row["queuedBytesAfterRead"], json!((prefix + frames) * 8));
        assert_eq!(row["rawPacketDeviceFrameIndex"], json!(info.index));
    }
    assert_eq!(records.len(), 3);
    assert_eq!(pipeline.processor.frames_captured, 0);
    assert_eq!(pipeline.capture_metadata().unwrap(), before);
}

#[test]
fn native_capture_packet_witness_ignores_zero_frame_idle_with_retained_prefix() {
    let pipeline = pipeline();
    let retained = pipeline.capture_metadata().unwrap();
    // Even flagged/default idle BufferInfo cannot impersonate a returned PCM packet.
    let idle = wasapi::BufferInfo::new(7, 0, 0);
    let mut records = Vec::new();
    capture_diagnostics::record_native_capture_packet_witness(packet_witness(&idle, 0, 576),
        |record| records.push(record));
    assert!(records.is_empty());
    assert_eq!(pipeline.capture_metadata().unwrap(), retained);
}

#[test]
fn native_capture_packet_witness_preserves_flags_owner_and_native_reset_domain() {
    let info = wasapi::BufferInfo::new(7, 0, u64::MAX);
    let mut packet = packet_witness(&info, 96, 672);
    packet.endpoint_id = Some("actual-endpoint");
    packet.capture_owner_id = Some(41);
    packet.capture_aec_reset_generation = Some(3);
    let mut records = Vec::new();
    capture_diagnostics::record_native_capture_packet_witness(packet, |record| records.push(record));
    let row = &records[0];
    assert_eq!(row["kind"], "native-capture-packet");
    assert_eq!(row["schemaVersion"], 1);
    assert_eq!(row["dataDiscontinuity"], true);
    assert_eq!(row["silent"], true);
    assert_eq!(row["timestampError"], true);
    assert_eq!(row["rawPacketDeviceFrameIndex"], 0);
    assert_eq!(row["rawPacketQpc100ns"], json!(u64::MAX));
    assert_eq!(row["captureOwnerId"], 41);
    assert_eq!(row["captureAecResetGeneration"], 3);
    assert_eq!(row["endpointId"], "actual-endpoint");
    assert_eq!(row["requestedEndpointId"], "requested-endpoint");
    assert_eq!(row["direction"], "inbound");
    assert_eq!(row["resetGenerationDomain"], "aec-diagnostic-tap");
    assert!(row.get("resetGeneration").is_none(), "only the tap injects its own reset generation");
    assert_eq!(row["diagnosticOnly"], true);
    for field in ["qualityAcceptance", "aecQualityAcceptance", "releaseEligible", "formalCaptureClockAcceptance"] {
        assert_eq!(row[field], false);
    }
    assert!(row.get("queueHeadClockValid").is_none());
    assert!(row.get("queueHeadDeviceFrameIndex").is_none());
    assert!(row.get("queueHeadQpc100ns").is_none());
}

#[test]
fn native_capture_packet_witness_keeps_unavailable_identity_and_observation_null() {
    let info = wasapi::BufferInfo::new(0, 6_672_000, 4_207_119_107_588);
    let mut packet = packet_witness(&info, 96, 672);
    packet.observed_qpc_100ns = None;
    let mut records = Vec::new();
    capture_diagnostics::record_native_capture_packet_witness(packet, |record| records.push(record));
    let row = &records[0];
    for field in ["endpointId", "captureOwnerId", "captureAecResetGeneration", "observedQpc100ns", "qpc100ns"] {
        assert!(row.get(field).unwrap().is_null(), "unknown field must remain null: {field}");
    }
    assert_eq!(row["rawPacketQpc100ns"], json!(info.timestamp));
}

#[test]
fn native_capture_packet_witness_snapshot_survives_clock_consumption_and_later_idle() {
    let mut pipeline = pipeline();
    let info = wasapi::BufferInfo::new(1, 6_672_000, 4_207_119_107_588);
    let mut records = Vec::new();
    capture_diagnostics::record_native_capture_packet_witness(packet_witness(&info, 96, 672),
        |record| records.push(record));
    let snapshot = records[0].clone();
    pipeline.consume_capture_clock(672, 672 * 8);
    let idle = wasapi::BufferInfo::new(0, 0, 0);
    capture_diagnostics::record_native_capture_packet_witness(packet_witness(&idle, 0, 768),
        |record| records.push(record));
    assert_eq!(records.len(), 1);
    assert_eq!(records[0], snapshot);
    assert_eq!(records[0]["rawPacketQpc100ns"], json!(4_207_119_107_588u64));
    assert_eq!(records[0]["observedQpc100ns"], json!(9_000_000));
}

#[test]
fn native_capture_packet_witness_does_not_invent_bytes_on_queue_underflow() {
    let info = wasapi::BufferInfo::new(0, 6_672_000, 4_207_119_107_588);
    let mut packet = packet_witness(&info, 96, 672);
    packet.queued_bytes_after_read = packet.queued_bytes_before_read - 8;
    let mut records = Vec::new();
    capture_diagnostics::record_native_capture_packet_witness(packet, |record| records.push(record));
    assert_eq!(records[0]["rawFrameCount"], 96);
    assert!(records[0]["rawByteCount"].is_null());
}

#[test]
fn native_capture_packet_ledger_receipt_keeps_real_byte_ranges_and_reset_domains_separate() {
    let mut ledger=CaptureQueueLedger::new(41,0);
    let first=ledger.observe_append(41,0,768,Some(768));
    let second=ledger.observe_append(41,768,4608,Some(3840));
    let info=wasapi::BufferInfo::new(0,6672096,4207119107588);
    let mut packet=packet_witness(&info,480,96);
    packet.endpoint_id=Some("initialized-effective-endpoint");
    packet.capture_owner_id=Some(41); packet.capture_aec_reset_generation=Some(3);
    packet.queue_append=Some(&second);
    let mut records=Vec::new();
    capture_diagnostics::record_native_capture_packet_witness(packet,|row| records.push(row));
    let row=&records[0];
    assert_eq!(first.packet_id,Some(1)); assert_eq!(row["packetId"],2);
    assert_eq!(row["appendStartByte"],768); assert_eq!(row["appendEndByte"],4608);
    assert_eq!(row["queueGenerationBefore"],1); assert_eq!(row["queueGenerationAfter"],2);
    assert_eq!(row["queueOwnerId"],41); assert_eq!(row["captureAecResetGeneration"],3);
    assert_eq!(row["nativeResetGenerationDomain"],"native-capture-owner");
    assert_eq!(row["resetGenerationDomain"],"aec-diagnostic-tap");
    assert_eq!(row["queueGenerationDomain"],"capture-queue-ledger");
    assert!(row["ledgerError"].is_null()); assert!(row.get("resetGeneration").is_none());
}
#[test]
fn native_capture_packet_failed_ledger_keeps_raw_packet_without_fabricated_append_range() {
    let mut ledger=CaptureQueueLedger::new(41,0);
    ledger.observe_append(41,0,768,Some(768));
    let failed=ledger.observe_append(42,768,4608,Some(3840));
    let info=wasapi::BufferInfo::new(0,6672096,4207119107588);
    let mut packet=packet_witness(&info,480,96); packet.queue_append=Some(&failed);
    packet.capture_owner_id=Some(42);
    let mut records=Vec::new();
    capture_diagnostics::record_native_capture_packet_witness(packet,|row| records.push(row));
    let row=&records[0];
    assert_eq!(row["rawByteCount"],3840); assert_eq!(row["rawPacketDeviceFrameIndex"],6672096);
    assert_eq!(row["ledgerError"],"capture-owner-mismatch");
    assert_eq!(row["captureOwnerId"],42); assert_eq!(row["queueOwnerId"],41);
    for field in ["packetId","appendStartByte","appendEndByte"] { assert!(row[field].is_null()); }
    assert_eq!(row["ledgerLastKnownTailByte"],768);
}
#[test]
fn initialized_queue_binding_reads_actual_guard_not_requested_route_or_tail_identity() {
    let mut pipeline=pipeline();
    let ack=crate::audio::state::NativeCaptureStartAck::new();
    let guard=ack.producer_guard();
    let other=crate::audio::state::NativeCaptureStartAck::new();
    pipeline.bind_capture_queue("initialized-effective-endpoint",&guard,0,true);
    let before=ack.health();
    let row=pipeline.queue_record("native-capture-queue-reset","inbound",&guard).unwrap();
    assert_eq!(row["endpointId"],"initialized-effective-endpoint");
    assert_eq!(row["captureOwnerId"],json!(before.owner_id));
    assert_eq!(row["queueOwnerId"],json!(before.owner_id));
    assert_ne!(row["captureOwnerId"],json!(other.health().owner_id));
    assert_eq!(row["captureAecResetGeneration"],0);
    assert_eq!(row["queueGeneration"],0);
    assert_eq!(ack.health().aec_reset_generation,before.aec_reset_generation);
    for field in ["qualityAcceptance","aecQualityAcceptance","releaseEligible","formalCaptureClockAcceptance"] {
        assert_eq!(row[field],false);
    }
}
#[test]
fn queue_clock_diagnostic_snapshot_does_not_change_existing_invalid_prefix_decision() {
    let mut pipeline=pipeline();
    pipeline.queue_clock.observe_packet(672*8,768*8,true,false,true);
    for _ in 0..100 {
        assert_eq!(pipeline.queue_clock.diagnostic_state(),(672*8,true));
        assert!(!pipeline.capture_metadata().unwrap().queue_head_clock_valid);
    }
    pipeline.consume_capture_clock(672,672*8);
    assert_eq!(pipeline.queue_clock.diagnostic_state(),(0,true));
    assert!(pipeline.capture_metadata().unwrap().queue_head_clock_valid);
}
