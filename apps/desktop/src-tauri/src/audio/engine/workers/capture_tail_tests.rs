use super::*;

// Exercise the ACTUAL unchanged production dequeue, not a test reimplementation.
#[allow(dead_code, reason = "standalone tail policy tests import the unchanged production samples module")]
#[path = "../samples.rs"]
mod production_samples;

const NORMAL_FRAMES: usize = 960;

fn context() -> TailQueueContext {
    TailQueueContext { generation: 1, owner_id: 7, continuity_id: 3 }
}
fn pcm(frames: usize, left: f32, right: f32) -> VecDeque<u8> {
    let mut queue = VecDeque::new();
    for _ in 0..frames {
        queue.extend(left.to_le_bytes());
        queue.extend(right.to_le_bytes());
    }
    queue
}
fn mixed_tail() -> VecDeque<u8> {
    let mut queue = pcm(576, 0.25, -0.75);
    queue.extend(pcm(96, 0.0, -0.0));
    queue
}
fn seeded(queue: &VecDeque<u8>) -> (CaptureTailPolicy, TailQueueContext, Instant) {
    let mut policy = CaptureTailPolicy::new(NORMAL_FRAMES).unwrap();
    let context = context();
    let start = Instant::now();
    policy.observe(start, context, queue, TailObservation::RealPacket).unwrap();
    (policy, context, start)
}
fn poll(policy: &mut CaptureTailPolicy, at: Instant, context: TailQueueContext, queue: &VecDeque<u8>) {
    let query_id = policy.last_native_query_id.unwrap_or(0) + 1;
    policy.observe(at, context, queue, TailObservation::Empty { query_id }).unwrap();
}
fn chain(
    policy: &mut CaptureTailPolicy, context: TailQueueContext, queue: &VecDeque<u8>,
    first: Instant, span_ms: u64,
) -> Instant {
    assert_eq!(span_ms % 20, 0);
    for step in 0..=span_ms / 20 {
        poll(policy, first + Duration::from_millis(step * 20), context, queue);
    }
    first + Duration::from_millis(span_ms)
}
fn armed(queue: &VecDeque<u8>) -> (CaptureTailPolicy, TailQueueContext, Instant, TailPermit) {
    let (mut policy, context, start) = seeded(queue);
    let now = chain(&mut policy, context, queue, start + Duration::from_millis(20), 2000);
    let permit = policy.try_issue(now, context, queue).unwrap();
    (policy, context, now, permit)
}
fn bytes(queue: &VecDeque<u8>) -> Vec<u8> { queue.iter().copied().collect() }

#[test]
fn thresholds_match_existing_native_freshness_and_quiet_sources() {
    assert_eq!(NATIVE_QUERY_FRESHNESS, Duration::from_millis(100));
    assert_eq!(TAIL_QUIET_CONFIRMATION, Duration::from_secs(2));
    assert!(include_str!("../../state/native_capture_start/health.rs")
        .contains("const FRESHNESS: Duration = Duration::from_millis(100);"));
    assert!(include_str!("../../../watch_mode_diagnostic/open_input_drain.rs")
        .contains("const QUIET_CONFIRMATION: Duration = Duration::from_secs(2);"));
    assert!(include_str!("../../../watch_mode_diagnostic/local_aec_probe/drain.rs")
        .contains("Duration::from_secs(2)"));
    assert!(include_str!("../mod.rs").contains("const CHUNK_FRAMES: usize = 960;"));
}

#[test]
fn old_672_frame_dequeue_stalls_for_40s_of_real_empty_queries_new_policy_preserves_all_pcm() {
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, start) = seeded(&queue);
    for step in 1..=2000 {
        let chunks = production_samples::drain_sample_chunks(&mut queue, NORMAL_FRAMES * 8);
        assert!(chunks.is_empty());
        assert_eq!(bytes(&queue), expected);
        poll(&mut policy, start + Duration::from_millis(step * 20), context, &queue);
    }
    let now = start + Duration::from_secs(40);
    let permit = policy.try_issue(now, context, &queue).unwrap();
    assert_eq!(permit.evidence().empty_polls, 2000);
    let tail = policy.take_tail(now, context, &mut queue, &permit).unwrap();
    assert_eq!(tail.frames, 672);
    assert_eq!(tail.pcm, expected);
    assert!(queue.is_empty());
    println!("OLD: 2000 actual production dequeue attempts / 40s logical Empty queries: 0 blocks, 672 retained frames. NEW: exactly 672 real frames dequeued, 0 extra bytes; no AEC/dispatch completion declared.");
}

#[test]
fn entire_576_voiced_plus_96_zero_tail_not_latest_silent_packet_is_evidence() {
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    let evidence = *permit.evidence();
    assert_eq!(evidence.context, context);
    assert_eq!(evidence.byte_len, 672 * 8);
    assert!(evidence.last_nonempty_at < evidence.empty_since);
    assert_eq!(evidence.last_empty_query_at.duration_since(evidence.empty_since), Duration::from_secs(2));
    assert_eq!(evidence.last_empty_query_id, 101);
    assert_eq!(evidence.maximum_empty_poll_gap, Duration::from_millis(20));
    assert_eq!(evidence.pcm, TailPcmEvidence {
        frames: 672, samples: 1344, finite: true, all_zero: false,
        zero_samples: 192, nonzero_samples: 1152, nonfinite_samples: 0, peak: Some(0.75),
    });
    assert_eq!(bytes(&queue), expected, "issuing evidence cannot mutate input");
    let tail = policy.take_tail(now, context, &mut queue, &permit).unwrap();
    assert_eq!(tail.pcm, expected);
    assert_eq!(tail.evidence, evidence);
    assert_eq!(tail.frames, 672);
    println!("FULL-TAIL: 576 voiced + 96 zero = 672 frames; finite=true, allZero=false, nonzeroSamples=1152, zeroSamples=192, peak=0.75.");
}

#[test]
fn all_zero_real_pcm_is_never_automatically_processed_or_dequeued() {
    let mut queue = pcm(672, 0.0, -0.0);
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    assert!(permit.evidence().pcm.all_zero);
    assert_eq!(permit.evidence().pcm.peak, Some(0.0));
    assert_eq!(permit.evidence().pcm.nonzero_samples, 0);
    assert_eq!(bytes(&queue), expected);
    // There is intentionally no 'processed' bit/counter or silence shortcut API.
    let tail = policy.take_tail(now, context, &mut queue, &permit).unwrap();
    assert_eq!(tail.pcm, expected, "signed-zero PCM must remain byte-identical real input");
    assert_eq!(tail.frames, 672, "length, NOT completed native AEC frames");
}

#[test]
fn real_288_frame_resume_fills_normal_960_in_original_order_and_revokes_tail() {
    let mut queue = mixed_tail();
    let (mut policy, mut context, now, permit) = armed(&queue);
    queue.extend(pcm(288, 0.5, -0.125));
    context.generation += 1;
    let expected = bytes(&queue);
    policy.observe(now + Duration::from_millis(1), context, &queue, TailObservation::RealPacket).unwrap();
    assert_eq!(policy.take_tail(now + Duration::from_millis(1), context, &mut queue, &permit)
        .unwrap_err(), TailPolicyError::PermitInvalidated);
    assert_eq!(bytes(&queue), expected);
    let chunks = production_samples::drain_sample_chunks(&mut queue, NORMAL_FRAMES * 8);
    assert_eq!(chunks, vec![expected]);
    assert!(queue.is_empty());
    println!("RESUME: real 672 + real 288 -> production normal 960-frame dequeue, byte-for-byte ordered; old tail permit rejected.");
}

#[test]
fn query_coverage_not_elapsed_wall_clock_grants_permission_at_exact_2s() {
    let queue = mixed_tail();
    let (mut policy, context, start) = seeded(&queue);
    let last = chain(&mut policy, context, &queue, start + Duration::from_millis(20), 1980);
    assert_eq!(policy.try_issue(last + Duration::from_millis(20), context, &queue).unwrap_err(),
        TailPolicyError::QuietWindowIncomplete);
    poll(&mut policy, last + Duration::from_millis(20), context, &queue);
    assert!(policy.try_issue(last + Duration::from_millis(20), context, &queue).is_ok());
}

#[test]
fn one_empty_frozen_snapshot_and_wait_timeouts_do_not_prove_quiet() {
    let queue = mixed_tail();
    let (mut policy, context, start) = seeded(&queue);
    poll(&mut policy, start + Duration::from_millis(20), context, &queue);
    assert_eq!(policy.try_issue(start + Duration::from_secs(40), context, &queue).unwrap_err(),
        TailPolicyError::StaleQuery);
    assert_eq!(policy.try_issue(start + Duration::from_secs(40), context, &queue).unwrap_err(),
        TailPolicyError::NoContinuousEmptyQueries);
}

#[test]
fn empty_without_a_real_packet_witness_cannot_authorize_an_arbitrary_queue() {
    let queue = mixed_tail();
    let mut policy = CaptureTailPolicy::new(NORMAL_FRAMES).unwrap();
    let now = chain(&mut policy, context(), &queue, Instant::now(), 2000);
    assert_eq!(policy.try_issue(now, context(), &queue).unwrap_err(), TailPolicyError::NoRealPacket);
}

#[test]
fn exact_100ms_poll_gaps_allowed_but_100ms_plus_1ns_restarts_2s_chain() {
    let queue = mixed_tail();
    let (mut policy, context, start) = seeded(&queue);
    for step in 1..=21 {
        poll(&mut policy, start + Duration::from_millis(step * 100), context, &queue);
    }
    let last = start + Duration::from_millis(2100);
    let permit = policy.try_issue(last, context, &queue).unwrap();
    assert_eq!(permit.evidence().maximum_empty_poll_gap, Duration::from_millis(100));
    let resumed = last + Duration::from_millis(100) + Duration::from_nanos(1);
    poll(&mut policy, resumed, context, &queue);
    assert_eq!(policy.try_issue(resumed, context, &queue).unwrap_err(), TailPolicyError::QuietWindowIncomplete);
    assert_eq!(policy.empty_polls, 1);
    assert_eq!(policy.maximum_empty_poll_gap, Duration::ZERO);
    let last = chain(&mut policy, context, &queue, resumed + Duration::from_millis(20), 1980);
    assert!(policy.try_issue(last, context, &queue).is_ok());
}

#[test]
fn a_late_consumer_cannot_issue_from_stale_queries() {
    let queue = mixed_tail();
    let (mut policy, context, now, _) = armed(&queue);
    assert_eq!(policy.try_issue(now + Duration::from_millis(100) + Duration::from_nanos(1), context, &queue)
        .unwrap_err(), TailPolicyError::StaleQuery);
    assert!(policy.pending.is_none());
}

#[test]
fn permit_consumption_accepts_exact_freshness_boundary_only() {
    for extra in [Duration::ZERO, Duration::from_nanos(1)] {
        let mut queue = mixed_tail();
        let expected = bytes(&queue);
        let (mut policy, context, now, permit) = armed(&queue);
        let result = policy.take_tail(now + NATIVE_QUERY_FRESHNESS + extra, context, &mut queue, &permit);
        if extra.is_zero() { assert_eq!(result.unwrap().pcm, expected); }
        else {
            assert_eq!(result.unwrap_err(), TailPolicyError::StaleQuery);
            assert_eq!(bytes(&queue), expected);
        }
    }
}

#[test]
fn every_new_query_even_another_empty_invalidates_old_permission() {
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    poll(&mut policy, now + Duration::from_millis(20), context, &queue);
    assert_eq!(policy.take_tail(now + Duration::from_millis(20), context, &mut queue, &permit)
        .unwrap_err(), TailPolicyError::PermitInvalidated);
    assert_eq!(bytes(&queue), expected);
}

#[test]
fn pending_unavailable_and_error_cancel_before_and_after_permit_and_require_new_quiet() {
    for event in [TailObservation::Pending { query_id: 102 }, TailObservation::Unavailable, TailObservation::Error] {
        let mut queue = mixed_tail();
        let expected = bytes(&queue);
        let (mut policy, context, now, permit) = armed(&queue);
        let interrupt = now + Duration::from_millis(1);
        policy.observe(interrupt, context, &queue, event).unwrap();
        assert_eq!(policy.take_tail(interrupt, context, &mut queue, &permit).unwrap_err(),
            TailPolicyError::PermitInvalidated);
        assert_eq!(bytes(&queue), expected);
        let first = interrupt + Duration::from_millis(20);
        let last = chain(&mut policy, context, &queue, first, 1980);
        assert_eq!(policy.try_issue(last, context, &queue).unwrap_err(), TailPolicyError::QuietWindowIncomplete);
        poll(&mut policy, last + Duration::from_millis(20), context, &queue);
        assert!(policy.try_issue(last + Duration::from_millis(20), context, &queue).is_ok());
    }
}

#[test]
fn new_real_packet_restarts_quiet_and_binds_new_nonempty_time() {
    let mut queue = mixed_tail();
    let (mut policy, mut context, now, _) = armed(&queue);
    queue.extend(pcm(1, 0.0, 0.0)); // Even a real silent packet resets the wait.
    context.generation += 1;
    let packet_time = now + Duration::from_millis(1);
    policy.observe(packet_time, context, &queue, TailObservation::RealPacket).unwrap();
    assert_eq!(policy.try_issue(packet_time, context, &queue).unwrap_err(), TailPolicyError::NoContinuousEmptyQueries);
    let last = chain(&mut policy, context, &queue, packet_time + Duration::from_millis(20), 2000);
    let permit = policy.try_issue(last, context, &queue).unwrap();
    assert_eq!(permit.evidence().last_nonempty_at, packet_time);
    assert_eq!(permit.evidence().pcm.frames, 673);
}

#[test]
fn owner_continuity_and_generation_changes_reject_old_permission_without_touching_pcm() {
    for which in 0..3 {
        let mut queue = mixed_tail();
        let expected = bytes(&queue);
        let (mut policy, mut context, now, permit) = armed(&queue);
        match which { 0 => context.owner_id += 1, 1 => context.continuity_id += 1, _ => context.generation += 1 }
        assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::QueueChanged);
        assert_eq!(bytes(&queue), expected);
    }
}

#[test]
fn observed_owner_or_continuity_switch_requires_new_real_packet_and_full_quiet() {
    for which in 0..2 {
        let queue = mixed_tail();
        let (mut policy, mut context, now, _) = armed(&queue);
        if which == 0 { context.owner_id += 1; } else { context.continuity_id += 1; }
        let next = now + Duration::from_millis(20);
        poll(&mut policy, next, context, &queue);
        let last = chain(&mut policy, context, &queue, next + Duration::from_millis(20), 2000);
        assert_eq!(policy.try_issue(last, context, &queue).unwrap_err(), TailPolicyError::NoRealPacket);
        let packet_time = last + Duration::from_millis(1);
        policy.observe(packet_time, context, &queue, TailObservation::RealPacket).unwrap();
        let last = chain(&mut policy, context, &queue, packet_time + Duration::from_millis(20), 2000);
        assert_eq!(policy.try_issue(last, context, &queue).unwrap().evidence().last_nonempty_at, packet_time);
    }
}

#[test]
fn duplicate_or_backward_native_query_id_never_counts_even_with_new_timestamp() {
    for query_id in [100, 101] {
        let mut queue = mixed_tail();
        let expected = bytes(&queue);
        let (mut policy, context, now, permit) = armed(&queue);
        let later = now + Duration::from_millis(20);
        assert_eq!(policy.observe(later, context, &queue, TailObservation::Empty { query_id }),
            Err(TailPolicyError::NonmonotonicQuery));
        assert_eq!(policy.take_tail(later, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
        assert_eq!(bytes(&queue), expected);
        let last = chain(&mut policy, context, &queue, later + Duration::from_millis(20), 1980);
        assert_eq!(policy.try_issue(last, context, &queue).unwrap_err(), TailPolicyError::QuietWindowIncomplete);
    }
}

#[test]
fn duplicate_or_backward_observation_time_cancels_and_retains_high_water_clock() {
    for offset in [Duration::ZERO, Duration::from_millis(1)] {
        let mut queue = mixed_tail();
        let (mut policy, context, now, permit) = armed(&queue);
        assert_eq!(policy.observe(now - offset, context, &queue, TailObservation::Empty { query_id: 102 }),
            Err(TailPolicyError::NonmonotonicTime));
        assert_eq!(policy.last_observation_at, Some(now));
        assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
        poll(&mut policy, now + Duration::from_millis(20), context, &queue);
        assert_eq!(policy.try_issue(now + Duration::from_millis(20), context, &queue).unwrap_err(), TailPolicyError::QuietWindowIncomplete);
    }
}

#[test]
fn backwards_issue_and_consume_time_fail_closed_without_dequeue() {
    let queue = mixed_tail();
    let (mut policy, context, now, _) = armed(&queue);
    assert_eq!(policy.try_issue(now - Duration::from_nanos(1), context, &queue).unwrap_err(), TailPolicyError::NonmonotonicTime);
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    assert_eq!(policy.take_tail(now - Duration::from_nanos(1), context, &mut queue, &permit).unwrap_err(), TailPolicyError::NonmonotonicTime);
    assert_eq!(bytes(&queue), expected);
}

#[test]
fn permit_is_one_attempt_no_repeat_issue_replay_or_cross_policy_use() {
    let mut queue = mixed_tail();
    let (mut policy, context, now, permit) = armed(&queue);
    assert_eq!(policy.try_issue(now, context, &queue).unwrap_err(), TailPolicyError::AlreadyIssuedForQuery);
    let tail = policy.take_tail(now, context, &mut queue, &permit).unwrap();
    assert_eq!(tail.frames, 672);
    // Reinsert the identical bytes deliberately to try replaying a consumed permit.
    queue.extend(tail.pcm.clone());
    assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
    assert_eq!(bytes(&queue), tail.pcm);
    let (mut other, _, other_now, _) = armed(&queue);
    assert_eq!(other.take_tail(other_now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
    assert_eq!(bytes(&queue), tail.pcm);
}

#[test]
fn wrong_byte_length_after_permission_never_drains_any_data_or_reuses_permit() {
    for grow in [false, true] {
        let mut queue = mixed_tail();
        let (mut policy, context, now, permit) = armed(&queue);
        if grow { queue.push_back(0); } else { queue.pop_back(); }
        let expected = bytes(&queue);
        assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::QueueChanged);
        assert_eq!(bytes(&queue), expected);
        assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
    }
}

#[test]
fn same_length_byte_change_or_nonfinite_substitution_even_without_generation_bump_rejected() {
    for replacement in [0.5f32.to_le_bytes(), f32::NAN.to_le_bytes(), f32::INFINITY.to_le_bytes()] {
        let mut queue = mixed_tail();
        let (mut policy, context, now, permit) = armed(&queue);
        for (slot, byte) in replacement.into_iter().enumerate() { queue[slot] = byte; }
        let expected = bytes(&queue);
        assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::ByteContentChanged);
        assert_eq!(bytes(&queue), expected);
    }
}

#[test]
fn all_nonfinite_values_are_full_tail_evidence_but_not_permission() {
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let queue = pcm(672, 0.0, value);
        let expected = bytes(&queue);
        let stats = CaptureTailPolicy::inspect_pcm(&queue).unwrap();
        assert!(!stats.finite);
        assert!(!stats.all_zero);
        assert_eq!(stats.nonfinite_samples, 672);
        assert_eq!(stats.nonzero_samples, 672);
        assert_eq!(stats.zero_samples, 672);
        assert_eq!(stats.peak, Some(0.0));
        let (mut policy, context, start) = seeded(&queue);
        let now = chain(&mut policy, context, &queue, start + Duration::from_millis(20), 2000);
        assert_eq!(policy.try_issue(now, context, &queue).unwrap_err(), TailPolicyError::NonFinitePcm(stats));
        assert!(policy.pending.is_none());
        assert_eq!(bytes(&queue), expected);
    }
    let stats = CaptureTailPolicy::inspect_pcm(&pcm(1, f32::NAN, f32::INFINITY)).unwrap();
    assert_eq!(stats.peak, None);
    println!("NONFINITE: NaN/+Inf/-Inf retained unchanged; finite=false evidence, no dequeue permission.");
}

#[test]
fn empty_unaligned_and_full_normal_blocks_not_authorized_as_partial_tails() {
    for len in [0, 1, 4, 7, 8 * 672 + 1, 8 * 960, 8 * 961] {
        let queue: VecDeque<_> = vec![0u8; len].into();
        let expected = bytes(&queue);
        let (mut policy, context, start) = seeded(&queue);
        let now = chain(&mut policy, context, &queue, start + Duration::from_millis(20), 2000);
        let error = policy.try_issue(now, context, &queue).unwrap_err();
        if len == 0 { assert_eq!(error, TailPolicyError::EmptyQueue); }
        else if len % 8 != 0 { assert_eq!(error, TailPolicyError::NotFrameAligned); }
        else { assert_eq!(error, TailPolicyError::NotPartialTail); }
        assert_eq!(bytes(&queue), expected);
    }
    for frames in [0, 1, usize::MAX] {
        assert!(matches!(CaptureTailPolicy::new(frames), Err(TailPolicyError::InvalidNormalChunkSize)));
    }
}

#[test]
fn every_valid_partial_size_preserves_bytes_and_actual_frame_count() {
    for frames in 1..NORMAL_FRAMES {
        let mut queue = pcm(frames, f32::from_bits(1), -1.0); // Tiny nonzero is not silence.
        let expected = bytes(&queue);
        let (mut policy, context, now, permit) = armed(&queue);
        assert!(!permit.evidence().pcm.all_zero);
        let tail = policy.take_tail(now, context, &mut queue, &permit).unwrap();
        assert_eq!(tail.frames, frames);
        assert_eq!(tail.pcm.len(), frames * 8);
        assert_eq!(tail.pcm, expected);
        assert!(queue.is_empty());
    }
    println!("CONSERVATION: all 959 valid partial lengths (1..959 frames), exact byte identity and actual frame counts.");
}

#[test]
fn deque_wrapping_does_not_hide_samples_or_reorder_tail() {
    let mut queue = VecDeque::with_capacity(672 * 8);
    queue.extend(vec![0u8; 672 * 8]);
    queue.drain(..576 * 8);
    queue.extend(pcm(576, 0.25, -0.75));
    assert!(!queue.as_slices().1.is_empty(), "exercise wrapped storage");
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    assert_eq!(permit.evidence().pcm.nonzero_samples, 1152);
    assert_eq!(permit.evidence().pcm.zero_samples, 192);
    assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap().pcm, expected);
}

#[test]
fn explicit_inflight_invalidation_is_not_native_progress() {
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    policy.invalidate();
    assert_eq!(policy.take_tail(now, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
    assert_eq!(bytes(&queue), expected);
    assert_eq!(policy.try_issue(now, context, &queue).unwrap_err(), TailPolicyError::NoContinuousEmptyQueries);
}

#[test]
fn skipped_query_sequence_cannot_bridge_unknown_native_outcomes() {
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    let next = now + Duration::from_millis(20);
    // Sequence 102 was not observed. Its outcome cannot be assumed Empty.
    policy.observe(next, context, &queue, TailObservation::Empty { query_id: 103 }).unwrap();
    assert_eq!(policy.empty_polls, 1);
    assert_eq!(policy.empty_since, Some(next));
    assert_eq!(policy.try_issue(next, context, &queue).unwrap_err(), TailPolicyError::QuietWindowIncomplete);
    assert_eq!(policy.take_tail(next, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
    assert_eq!(bytes(&queue), expected);
}

#[test]
fn latest_empty_can_issue_new_permission_but_old_permission_stays_invalid() {
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, now, old) = armed(&queue);
    let next = now + Duration::from_millis(20);
    poll(&mut policy, next, context, &queue);
    let new = policy.try_issue(next, context, &queue).unwrap();
    assert_ne!(old.id, new.id);
    assert_eq!(new.evidence().last_empty_query_id, old.evidence().last_empty_query_id + 1);
    assert_eq!(policy.take_tail(next, context, &mut queue, &new).unwrap().pcm, expected);
    assert_eq!(policy.take_tail(next, context, &mut queue, &old).unwrap_err(), TailPolicyError::PermitInvalidated);
}

#[test]
fn generation_or_length_mutation_before_issue_cancels_the_old_wait() {
    for mutate_length in [false, true] {
        let mut queue = mixed_tail();
        let (mut policy, mut context, now, _) = armed(&queue);
        if mutate_length { queue.extend(pcm(1, 0.0, 0.0)); }
        else { context.generation += 1; }
        let expected = bytes(&queue);
        assert_eq!(policy.try_issue(now, context, &queue).unwrap_err(), TailPolicyError::QueueChanged);
        assert!(policy.pending.is_none());
        assert!(policy.empty_since.is_none());
        assert_eq!(bytes(&queue), expected);
    }
}

#[test]
fn real_packet_event_even_without_length_change_revokes_old_permit() {
    let mut queue = mixed_tail();
    let expected = bytes(&queue);
    let (mut policy, context, now, permit) = armed(&queue);
    let packet_time = now + Duration::from_millis(1);
    policy.observe(packet_time, context, &queue, TailObservation::RealPacket).unwrap();
    assert_eq!(policy.take_tail(packet_time, context, &mut queue, &permit).unwrap_err(), TailPolicyError::PermitInvalidated);
    assert_eq!(bytes(&queue), expected);
    assert_eq!(policy.last_nonempty_at, Some(packet_time));
    assert!(policy.empty_since.is_none());
}
