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
