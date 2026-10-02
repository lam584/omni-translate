use super::*;

fn metadata(index: u64) -> AecCaptureFrameMetadata {
    AecCaptureFrameMetadata {
        packet_device_frame_index: index * 480, packet_qpc_100ns: 1_000_000 + index * 100_000,
        queue_head_device_frame_index: index * 480, queue_head_qpc_100ns: 1_000_000 + index * 100_000,
        observed_qpc_100ns: Some(1_000_001 + index * 100_000), continuity_id: 7,
        delay_samples: 0, timestamp_error: false, data_discontinuity: false, queue_head_clock_valid: true,
    }
}

fn capture(lineage: &mut PostTapProvenance, index: u64, value: f32, reset: u64) -> (AecPostPacket, Vec<u8>) {
    let post = vec![value; 960];
    let packet = lineage.capture(index * 3, &post, metadata(index), reset);
    let raw = post.iter().flat_map(|v| v.to_le_bytes()).collect();
    (packet, raw)
}

#[test]
fn continuous_silence_and_six_second_prefix_have_exact_producer_offsets() {
    let mut lineage = PostTapProvenance::default();
    let (tx, rx) = std::sync::mpsc::channel();
    for index in 0..600 {
        let (packet, raw) = capture(&mut lineage, index, 0.0, 0);
        lineage.dispatch(packet, &raw).unwrap();
        tx.send(raw).unwrap();
    }
    drop(tx);
    // All silence bytes are identical and the entire prefix exceeds the old 4s index.
    let mut pre_session = VecDeque::new();
    while let Ok(raw) = rx.try_recv() {
        lineage.receive(&raw).unwrap();
        pre_session.push_back(raw);
    }
    for index in 0..600 {
        let raw = pre_session.pop_front().unwrap();
        let packet = lineage.packet(&raw).unwrap();
        assert_eq!(packet.source_packet_sequence, index * 3);
        assert_eq!(packet.post_sample_offset, index * 960);
        assert_eq!(packet.metadata.queue_head_qpc_100ns, 1_000_000 + index * 100_000);
        let wire = crate::audio::pcm_resample::resample_capture_to_mono_i16(&raw, 16_000);
        packet.validate_wire(&raw, &wire, 16_000).unwrap();
        assert_eq!(wire, vec![0; 160]);
        lineage.complete(&raw, &packet).unwrap();
    }
    lineage.drained().unwrap();
}

#[test]
fn repeated_nonzero_pcm_keeps_requeue_and_reconnect_lineage() {
    let mut lineage = PostTapProvenance::default();
    let mut queue = VecDeque::new();
    for index in 0..8 {
        let (packet, raw) = capture(&mut lineage, index, 0.25, index / 4);
        lineage.dispatch(packet, &raw).unwrap();
        lineage.receive(&raw).unwrap();
        queue.push_back(raw);
    }
    let raw = queue.pop_front().unwrap();
    let before = lineage.packet(&raw).unwrap();
    // Failed socket send does not commit. The exact Vec moves to the queue front.
    queue.push_front(raw);
    for index in 0..8 {
        let raw = queue.pop_front().unwrap();
        let packet = lineage.packet(&raw).unwrap();
        if index == 0 { assert_eq!(packet, before); }
        assert_eq!(packet.reset_generation, index / 4);
        assert_eq!(packet.post_sample_offset, index * 960);
        lineage.complete(&raw, &packet).unwrap();
    }
    lineage.drained().unwrap();
}

#[test]
fn producer_dropped_packet_fails_even_when_all_pcm_is_silent() {
    let mut lineage = PostTapProvenance::default();
    let _lost = capture(&mut lineage, 0, 0.0, 0);
    let (second, raw) = capture(&mut lineage, 1, 0.0, 0);
    assert!(lineage.dispatch(second, &raw).unwrap_err().contains("capture-gap"));
}

#[test]
fn queued_packet_drop_and_reorder_fail_even_when_all_pcm_is_silent() {
    let mut lineage = PostTapProvenance::default();
    let (first, raw1) = capture(&mut lineage, 0, 0.0, 0);
    let (second, raw2) = capture(&mut lineage, 1, 0.0, 0);
    lineage.dispatch(first, &raw1).unwrap();
    lineage.dispatch(second, &raw2).unwrap();
    lineage.receive(&raw1).unwrap();
    lineage.receive(&raw2).unwrap();
    drop(raw1);
    assert!(lineage.packet(&raw2).unwrap_err().contains("send-gap"));
    assert!(lineage.drained().unwrap_err().contains("unconsumed"));
}

#[test]
fn wrong_pcm_at_dispatch_and_receive_fails_closed() {
    let mut lineage = PostTapProvenance::default();
    let (packet, mut raw) = capture(&mut lineage, 0, 0.0, 0);
    raw[0] = 1;
    assert!(lineage.dispatch(packet, &raw).unwrap_err().contains("pcm-mismatch"));
    let mut lineage = PostTapProvenance::default();
    let (packet, raw) = capture(&mut lineage, 0, 0.0, 0);
    lineage.dispatch(packet, &raw).unwrap();
    let mut wrong = raw.clone();
    wrong[4] = 1;
    assert!(lineage.receive(&wrong).unwrap_err().contains("pcm-mismatch"));
}

#[test]
fn invalid_and_wrong_continuous_clock_fail_closed() {
    for invalid in 0..3 {
        let mut lineage = PostTapProvenance::default();
        let (mut packet, raw) = capture(&mut lineage, 0, 0.0, 0);
        match invalid { 0 => packet.metadata.queue_head_clock_valid = false,
            1 => packet.metadata.timestamp_error = true, _ => packet.metadata.data_discontinuity = true }
        assert!(lineage.dispatch(packet, &raw).unwrap_err().contains("invalid-clock"));
    }
    let mut lineage = PostTapProvenance::default();
    let (first, raw1) = capture(&mut lineage, 0, 0.0, 0);
    lineage.dispatch(first, &raw1).unwrap();
    let (mut second, raw2) = capture(&mut lineage, 1, 0.0, 0);
    second.metadata.queue_head_qpc_100ns += 100;
    assert!(lineage.dispatch(second, &raw2).unwrap_err().contains("clock-gap"));
}

#[test]
fn tampered_packet_clock_and_reset_are_not_accepted_as_original_token() {
    let mut lineage = PostTapProvenance::default();
    let (packet, raw) = capture(&mut lineage, 0, 0.1, 2);
    lineage.dispatch(packet, &raw).unwrap();
    lineage.receive(&raw).unwrap();
    let bound = lineage.packet(&raw).unwrap();
    let mut wrong_clock = bound.clone();
    wrong_clock.metadata.queue_head_qpc_100ns += 100;
    assert!(lineage.complete(&raw, &wrong_clock).unwrap_err().contains("wrong-packet-token"));
    let mut wrong_reset = bound.clone();
    wrong_reset.reset_generation += 1;
    assert!(lineage.complete(&raw, &wrong_reset).unwrap_err().contains("wrong-packet-token"));
    lineage.complete(&raw, &bound).unwrap();
}

#[test]
fn wrong_wire_and_pcm_mutation_after_receive_fail_closed() {
    let mut lineage = PostTapProvenance::default();
    let (packet, mut raw) = capture(&mut lineage, 0, 0.0, 0);
    lineage.dispatch(packet, &raw).unwrap();
    lineage.receive(&raw).unwrap();
    let bound = lineage.packet(&raw).unwrap();
    let mut wire = vec![0i16; 160];
    wire[10] = 1;
    assert!(bound.validate_wire(&raw, &wire, 16_000).unwrap_err().contains("wire-mismatch"));
    raw[0] = 1;
    assert!(lineage.packet(&raw).unwrap_err().contains("pcm-mismatch"));
}

#[test]
fn clone_is_not_a_received_packet_and_duplicate_completion_is_rejected() {
    let mut lineage = PostTapProvenance::default();
    let (packet, raw) = capture(&mut lineage, 0, 0.0, 0);
    lineage.dispatch(packet, &raw).unwrap();
    lineage.receive(&raw).unwrap();
    assert!(lineage.packet(&raw.clone()).unwrap_err().contains("unbound"));
    let bound = lineage.packet(&raw).unwrap();
    lineage.complete(&raw, &bound).unwrap();
    assert!(lineage.complete(&raw, &bound).unwrap_err().contains("unbound"));
}
