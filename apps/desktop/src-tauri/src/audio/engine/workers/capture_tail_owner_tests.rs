use super::*;

fn pcm(frames: usize, value: f32) -> VecDeque<u8> {
    (0..frames * 2).flat_map(|_| value.to_le_bytes()).collect()
}
fn native() -> NativeCaptureStartAck {
    let native = NativeCaptureStartAck::new();
    native.observe_native_start(Ok::<_, String>(())).unwrap();
    native
}
fn arm(owner: &mut CaptureTailOwner, native: &NativeCaptureStartAck, queue: &VecDeque<u8>) -> Instant {
    let end = Instant::now();
    let first = end - Duration::from_millis(2020);
    owner.observe_packet(first, native, queue).unwrap();
    for i in 0..=100 {
        owner.observe_query(first + Duration::from_millis(20 + i * 20), native, queue, Some(0)).unwrap();
    }
    end
}

#[test]
fn actual_672_frame_tail_is_dequeued_once_without_claiming_aec_or_dispatch() {
    let native = native();
    let mut owner = CaptureTailOwner::new(CHUNK_FRAMES).unwrap();
    let mut queue = pcm(576, 0.125);
    queue.extend(pcm(96, 0.0));
    let original: Vec<u8> = queue.iter().copied().collect();
    owner.mutated().unwrap();
    let at = arm(&mut owner, &native, &queue);
    let before = native.health();
    let tail = owner.take_ready(at, &native, &mut queue).unwrap().unwrap();
    assert_eq!(tail.frames, 672);
    assert_eq!(tail.pcm, original);
    let receipt = tail_receipt(&tail.evidence);
    assert_eq!(receipt.real_frames, 672);
    assert!(!receipt.all_zero);
    assert_eq!(receipt.zero_samples, 192);
    assert_eq!(receipt.nonzero_samples, 1152);
    assert_eq!(receipt.byte_len, 5376);
    assert!(receipt.quiet_observation_span_ms >= 2000.0);
    assert!(receipt.maximum_empty_poll_gap_ms <= 100.0);
    assert_eq!(receipt.capture_owner_id, before.owner_id);
    assert_eq!(native.health().aec_completed_frames, before.aec_completed_frames);
    assert_eq!(native.health().dispatch_completed_frames, before.dispatch_completed_frames);
    assert!(queue.is_empty());
    assert!(owner.take_ready(Instant::now(), &native, &mut queue).unwrap().is_none());
}

#[test]
fn failed_unavailable_pending_and_reset_queries_cannot_release_a_tail() {
    for change in 0..4 {
        let native = native();
        let guard = native.producer_guard();
        let mut owner = CaptureTailOwner::new(CHUNK_FRAMES).unwrap();
        let mut queue = pcm(96, 0.0);
        owner.mutated().unwrap();
        arm(&mut owner, &native, &queue);
        let at = Instant::now();
        match change {
            0 => owner.query_failed(&native, &queue),
            1 => owner.observe_query(at, &native, &queue, None).unwrap(),
            2 => owner.observe_query(at, &native, &queue, Some(48)).unwrap(),
            _ => { guard.record_aec_reset(); owner.observe_query(at, &native, &queue, Some(0)).unwrap(); }
        }
        let bytes: Vec<_> = queue.iter().copied().collect();
        assert!(owner.take_ready(Instant::now(), &native, &mut queue).unwrap().is_none());
        assert_eq!(queue.iter().copied().collect::<Vec<_>>(), bytes);
    }
}

#[test]
fn full_chunk_dequeue_preserves_a_real_packet_witness_for_its_suffix() {
    let native = native();
    let mut owner = CaptureTailOwner::new(CHUNK_FRAMES).unwrap();
    let mut queue = pcm(CHUNK_FRAMES + 288, 0.25);
    owner.mutated().unwrap();
    let chunks = drain_sample_chunks(&mut queue, CHUNK_FRAMES * 8);
    assert_eq!(chunks.len(), 1);
    owner.mutated().unwrap();
    let at = arm(&mut owner, &native, &queue);
    let tail = owner.take_ready(at, &native, &mut queue).unwrap().unwrap();
    assert_eq!(tail.frames, 288);
    assert_eq!(tail.evidence.context.generation, 2);
    assert_eq!(tail.pcm.len(), 288 * 8);
}

#[test]
fn idle_query_cannot_manufacture_a_packet_witness_after_mutation_or_owner_switch() {
    for switch_owner in [false, true] {
        let native = native();
        let mut owner = CaptureTailOwner::new(CHUNK_FRAMES).unwrap();
        let mut queue = pcm(96, 0.25);
        owner.mutated().unwrap();
        arm(&mut owner, &native, &queue);
        if !switch_owner { queue.extend(pcm(48, 0.0)); owner.mutated().unwrap(); }
        let replacement = self::native();
        let current = if switch_owner { &replacement } else { &native };
        owner.observe_query(Instant::now(), current, &queue, Some(0)).unwrap();
        assert!(owner.take_ready(Instant::now(), current, &mut queue).unwrap().is_none());
        assert!(!queue.is_empty());
    }
}

#[test]
fn real_owner_keeps_live_packet_pcm_when_actual_observation_clock_is_tied() {
    let native = native();
    let guard = native.producer_guard();
    let mut owner = CaptureTailOwner::new(CHUNK_FRAMES).unwrap();
    let mut queue = pcm(576, 0.25);
    let at = Instant::now();
    let packet = |frame, frames| crate::audio::state::NativeCapturePacket {
        frames, device_frame_index: frame, qpc_100ns: 100, silent: false,
        data_discontinuity: false, timestamp_error: false, raw_energy_db: -20.0,
    };
    guard.record_packet(&packet(0, 576), queue.len());
    owner.mutated().unwrap();
    owner.observe_packet(at - Duration::from_millis(20), &native, &queue).unwrap();
    owner.observe_query(at, &native, &queue, Some(0)).unwrap();
    queue.extend(pcm(96, -0.125));
    guard.record_packet(&packet(576, 96), queue.len());
    owner.mutated().unwrap();
    owner.observe_packet(at, &native, &queue).unwrap();
    let expected: Vec<_> = queue.iter().copied().collect();
    for _ in 0..10 { owner.observe_query(at, &native, &queue, Some(0)).unwrap(); }
    assert!(owner.take_ready(at + Duration::from_secs(40), &native, &mut queue).unwrap().is_none());
    assert_eq!(queue.iter().copied().collect::<Vec<_>>(), expected);
    let health = native.health();
    assert!(health.started && !health.terminal && health.fault.is_none());
    assert_eq!(health.captured_frames, 672);
    assert_eq!(health.aec_completed_frames, 0);
    assert_eq!(health.dispatch_completed_frames, 0);
    let receipt = serde_json::to_value(owner.clock_receipt(health.owner_id)).unwrap();
    assert_eq!(receipt["clockUnchangedPacketCount"], 1);
    assert_eq!(receipt["clockUnchangedQueryCount"], 10);
    assert_eq!(receipt["observationCount"], 13);
    assert_eq!(receipt["captureOwnerId"], health.owner_id);
    assert_eq!(receipt["nonadvancingTimeNeverCreditsQuiet"], true);
    assert_eq!(receipt["qualityAcceptance"], false);
}

#[test]
fn owner_still_rejects_backward_time_and_retains_all_input_bytes() {
    let native = native();
    let mut owner = CaptureTailOwner::new(CHUNK_FRAMES).unwrap();
    let mut queue = pcm(96, 0.125);
    owner.mutated().unwrap();
    let at = Instant::now();
    owner.observe_packet(at, &native, &queue).unwrap();
    owner.observe_query(at, &native, &queue, Some(0)).unwrap();
    let expected: Vec<_> = queue.iter().copied().collect();
    assert!(owner.observe_packet(at - Duration::from_nanos(1), &native, &queue).unwrap_err().contains("NonmonotonicTime"));
    assert!(owner.observe_query(at - Duration::from_nanos(1), &native, &queue, Some(0)).unwrap_err().contains("NonmonotonicTime"));
    assert!(owner.take_ready(at, &native, &mut queue).unwrap().is_none());
    assert_eq!(queue.iter().copied().collect::<Vec<_>>(), expected);
}

#[test]
fn owner_rearms_only_from_real_forward_queries_after_stall_and_dequeues_exact_tail_once() {
    let native = native();
    let mut owner = CaptureTailOwner::new(CHUNK_FRAMES).unwrap();
    let mut queue = pcm(672, 0.125);
    let expected: Vec<_> = queue.iter().copied().collect();
    owner.mutated().unwrap();
    let end = Instant::now();
    let stalled = end - Duration::from_millis(2020);
    owner.observe_packet(stalled, &native, &queue).unwrap();
    for _ in 0..10 { owner.observe_query(stalled, &native, &queue, Some(0)).unwrap(); }
    for step in 0..=99 {
        owner.observe_query(stalled + Duration::from_millis(20 + step * 20), &native, &queue, Some(0)).unwrap();
    }
    assert!(owner.take_ready(stalled + Duration::from_millis(2000), &native, &mut queue).unwrap().is_none());
    owner.observe_query(end, &native, &queue, Some(0)).unwrap();
    let tail = owner.take_ready(end, &native, &mut queue).unwrap().unwrap();
    assert_eq!(tail.pcm, expected);
    assert_eq!(tail.frames, 672);
    assert_eq!(tail.evidence.last_nonempty_at, stalled);
    assert_eq!(tail.evidence.last_empty_query_at.duration_since(tail.evidence.empty_since), Duration::from_secs(2));
    assert!(queue.is_empty());
    assert!(owner.take_ready(Instant::now(), &native, &mut queue).unwrap().is_none());
    assert_eq!(native.health().aec_completed_frames, 0);
    assert_eq!(native.health().dispatch_completed_frames, 0);
}
