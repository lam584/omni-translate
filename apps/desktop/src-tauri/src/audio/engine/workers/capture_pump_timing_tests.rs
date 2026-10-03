use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

thread_local! {
    pub(super) static CLOCK_READS: Cell<u64> = const { Cell::new(0) };
    pub(super) static QPC_READS: Cell<u64> = const { Cell::new(0) };
    pub(super) static TEST_QPC: Cell<Option<u64>> = const { Cell::new(Some(100)) };
}
fn collector() -> CapturePumpTiming { CapturePumpTiming::new(17, 171, "endpoint-vm171".into()) }
fn enabled() -> Handle { new_handle(17, 171, "endpoint-vm171".into()) }
fn packet(discontinuity: bool, timestamp_error: bool) -> Observation {
    Observation::Packet { device_frame_index: 480, qpc_100ns: 123456,
        frames: 96, data_discontinuity: discontinuity, timestamp_error, silent: false }
}
fn record(c: &mut CapturePumpTiming, part: Part, start: u64, end: u64, obs: Observation) {
    c.record(part, start, end, Some(10), Some(20), Outcome::Completed, obs, false);
}
fn sequences(c: &CapturePumpTiming) -> Vec<u64> {
    let mut ids: Vec<_> = c.retained.iter().map(|s| s.sequence).collect();
    ids.sort_unstable(); ids
}

#[test]
fn disabled_executes_once_preserves_result_and_reads_no_clocks() {
    CLOCK_READS.with(|c| c.set(0)); QPC_READS.with(|c| c.set(0));
    let mut calls = 0;
    let result: Result<Box<u32>, &str> = measure(&None, Part::Aec, || {
        calls += 1; Err("same error")
    });
    assert_eq!(result.unwrap_err(), "same error");
    let value = Box::new(171_u32);
    let address = &*value as *const u32;
    let value = measure_observed(&None, Part::QueryPacket, || {
        calls += 1; (Ok::<_, &str>(value), Observation::Query { packet_size: Some(96) })
    }).unwrap();
    assert_eq!(&*value as *const u32, address);
    assert_eq!(calls, 2);
    assert!(receipt(&None).is_none());
    assert_eq!(CLOCK_READS.with(Cell::get), 0);
    assert_eq!(QPC_READS.with(Cell::get), 0);
    let panic = catch_unwind(|| { let _: Result<(), ()> = measure(&None, Part::Dispatch,
        || panic!("disabled panic")); });
    assert!(panic.is_err());
    assert_eq!(CLOCK_READS.with(Cell::get), 0);
    assert_eq!(QPC_READS.with(Cell::get), 0);
}

#[test]
fn discontinuity_retains_inclusive_one_second_context_before_and_after() {
    let mut c = collector();
    record(&mut c, Part::Aec, 800_000, 900_000, Observation::None); // outside
    record(&mut c, Part::Dispatch, 900_000, 1_000_000, Observation::None); // touches
    record(&mut c, Part::QueryPacket, 1_200_000, 1_300_000,
        Observation::Query { packet_size: Some(480) });
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, packet(true, false));
    assert!(c.receipt()["pendingPostWindow"].as_bool().unwrap());
    record(&mut c, Part::EventWait, 2_990_000, 3_000_000,
        Observation::Wait { status: WaitStatus::Signaled, timeout_ms: 20 });
    record(&mut c, Part::Aec, 3_000_000, 3_010_000, Observation::None); // touches
    record(&mut c, Part::Dispatch, 3_010_000, 3_020_000, Observation::None); // outside
    assert_eq!(sequences(&c), vec![1, 2, 3, 4, 5]);
    assert_eq!(c.windows.len(), 1);
    assert_eq!(c.windows[0].start_elapsed_micros, 1_000_000);
    assert_eq!(c.windows[0].end_elapsed_micros, 3_000_000);
    assert!(!c.receipt()["diagnosticIncomplete"].as_bool().unwrap());
    assert_eq!(c.totals[Part::Aec as usize].count, 2); // includes the outside span
}

#[test]
fn overlapping_and_touching_windows_merge_without_duplicate_spans_or_totals() {
    let mut c = collector();
    record(&mut c, Part::Aec, 1_100_000, 1_200_000, Observation::None);
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, packet(true, false));
    record(&mut c, Part::EventWait, 2_100_000, 2_200_000,
        Observation::Wait { status: WaitStatus::TimedOut, timeout_ms: 20 });
    record(&mut c, Part::ReadPacket, 2_499_000, 2_500_000, packet(false, true));
    // [3.5,5.5] touches the merged [1,3.5].
    record(&mut c, Part::ReadPacket, 4_499_000, 4_500_000, packet(true, false));
    record(&mut c, Part::QueryPacket, 5_599_000, 5_600_000, Observation::None);
    assert_eq!(c.windows.len(), 1);
    assert_eq!(c.windows[0].end_elapsed_micros, 5_500_000);
    assert_eq!(sequences(&c), vec![0, 1, 2, 3, 4]);
    assert_eq!(c.finished, 6);
    assert_eq!(c.trigger_count, 3);
    assert_eq!(c.totals[Part::ReadPacket as usize].count, 3);
    assert_eq!(c.observations.data_discontinuities, 2);
    assert_eq!(c.observations.timestamp_errors, 1);
    assert!(!c.receipt()["diagnosticIncomplete"].as_bool().unwrap());
}

#[test]
fn disjoint_windows_and_long_nested_spans_do_not_lose_earlier_sequence() {
    let mut c = collector();
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, packet(true, false));
    record(&mut c, Part::Dispatch, 19_400_000, 19_500_000, Observation::None);
    // Later completion but earlier start intersects the OLD window.
    record(&mut c, Part::FullChunkProcess, 1_000_000, 20_000_000, Observation::None);
    assert_eq!(sequences(&c), vec![0, 2]);
    record(&mut c, Part::ReadPacket, 20_099_000, 20_100_000, packet(true, false));
    record(&mut c, Part::QueryPacket, 21_199_000, 21_200_000, Observation::None);
    assert_eq!(c.windows.len(), 2);
    assert_eq!(sequences(&c), vec![0, 1, 2, 3]);
    assert_eq!(c.receipt()["retainedSpans"][1]["sequence"], 1);
}

#[test]
fn actual_wait_status_and_query_none_zero_nonempty_are_not_inferred() {
    let mut c = collector();
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, packet(true, false));
    for (i, status) in [WaitStatus::Signaled, WaitStatus::TimedOut, WaitStatus::Failed]
        .into_iter().enumerate() {
        // Equal durations must NOT determine status.
        record(&mut c, Part::EventWait, 2_001_000 + i as u64 * 10,
            2_001_005 + i as u64 * 10, Observation::Wait { status, timeout_ms: 20 });
    }
    for (i, size) in [None, Some(0), Some(480)].into_iter().enumerate() {
        record(&mut c, Part::QueryPacket, 2_002_000 + i as u64 * 10,
            2_002_005 + i as u64 * 10, Observation::Query { packet_size: size });
    }
    let result = c.receipt();
    let waits: Vec<_> = c.retained.iter().filter_map(|s| match s.observation {
        Observation::Wait { status, timeout_ms } => Some((status, timeout_ms)), _ => None
    }).collect();
    assert_eq!(waits, vec![(WaitStatus::Signaled,20), (WaitStatus::TimedOut,20),
        (WaitStatus::Failed,20)]);
    assert_eq!(result["observationTotals"]["signaled"], 1);
    assert_eq!(result["observationTotals"]["timedOut"], 1);
    assert_eq!(result["observationTotals"]["failed"], 1);
    assert_eq!(result["observationTotals"]["querySizeUnavailable"], 1);
    assert_eq!(result["observationTotals"]["queryEmpty"], 1);
    assert_eq!(result["observationTotals"]["queryNonempty"], 1);
    assert_eq!(result["retainedSpans"][1]["observation"]["status"], "signaled");
    assert_eq!(result["retainedSpans"][4]["observation"]["packetSize"], Value::Null);
}

#[test]
fn none_observation_and_silent_clean_packet_do_not_invent_window_or_wait() {
    let mut c = collector();
    record(&mut c, Part::EventWait, 100, 200, Observation::None);
    record(&mut c, Part::ReadPacket, 200, 300, Observation::Packet {
        device_frame_index: 480, qpc_100ns: 123456, frames: 96,
        data_discontinuity: false, timestamp_error: false, silent: true
    });
    assert!(c.windows.is_empty()); assert_eq!(c.observations.waits, 0);
    assert_eq!(c.observations.packets, 1);
}

#[test]
fn missing_zero_retreating_qpc_remain_raw_and_incomplete() {
    let mut c = collector();
    for (i, (a,b)) in [(None,Some(1)), (Some(1),None), (Some(0),Some(1)),
        (Some(5),Some(4))].into_iter().enumerate() {
        c.record(Part::ReadPacket, 2_000_000 + i as u64 * 10,
            2_000_005 + i as u64 * 10, a, b, Outcome::Completed,
            packet(true, false), false);
    }
    record(&mut c, Part::QueryPacket, 3_100_000, 3_100_001, Observation::None);
    assert_eq!(c.totals[Part::ReadPacket as usize].invalid_qpc, 4);
    assert!(c.retained[..4].iter().all(|s| !s.qpc_valid));
    assert_eq!(c.retained[0].start_qpc_100ns, None);
    assert_eq!(c.retained[3].end_qpc_100ns, Some(4));
    assert!(c.receipt()["incompleteReasons"]["invalidQpc"].as_bool().unwrap());
    assert!(c.receipt()["diagnosticIncomplete"].as_bool().unwrap());
}

#[test]
fn pre_ring_capacity_eviction_is_bounded_and_never_claims_complete() {
    let mut c = CapturePumpTiming::with_limits(1, 2, "e".into(), 2, 8, 8);
    for i in 0..3 { record(&mut c, Part::Aec, 1_100_000+i*10,
        1_100_005+i*10, Observation::None); }
    assert_eq!(c.pre.len(), 2); assert_eq!(c.pre_capacity_evictions, 1);
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, packet(true, false));
    record(&mut c, Part::QueryPacket, 3_099_000, 3_100_000, Observation::None);
    assert!(c.pre.len() <= 2);
    assert!(c.receipt()["incompleteReasons"]["preRingOverflow"].as_bool().unwrap());
    assert!(c.receipt()["diagnosticIncomplete"].as_bool().unwrap());
    assert!(!sequences(&c).contains(&0));
}

#[test]
fn production_limits_are_bounded_and_overflow_is_visible() {
    let mut c = collector();
    for i in 0..PRE_LIMIT+2 {
        record(&mut c, Part::QueryPacket, 2_000_000+i as u64,
            2_000_000+i as u64, Observation::None);
    }
    assert_eq!(c.pre.len(), PRE_LIMIT);
    assert_eq!(c.pre_capacity_evictions, 2);
    record(&mut c, Part::ReadPacket, 2_500_000, 2_500_000, packet(true, false));
    for i in 0..RETAINED_LIMIT+2 {
        record(&mut c, Part::EventWait, 2_600_000+i as u64,
            2_600_000+i as u64, Observation::None);
    }
    assert_eq!(c.retained.len(), RETAINED_LIMIT);
    assert!(c.retained_dropped > 0);
    assert!(c.incomplete.retained_overflow);
    assert_eq!(c.finished, (PRE_LIMIT+2+1+RETAINED_LIMIT+2) as u64);
    assert_eq!(c.totals[Part::EventWait as usize].count, (RETAINED_LIMIT+2) as u64);
}

#[test]
fn retained_and_window_bounds_fail_closed_but_global_totals_continue() {
    let mut c = CapturePumpTiming::with_limits(1, 2, "e".into(), 8, 1, 1);
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, packet(true, false));
    record(&mut c, Part::Aec, 2_100_000, 2_200_000, Observation::None);
    assert_eq!(c.retained.len(), 1); assert_eq!(c.retained_dropped, 1);
    record(&mut c, Part::ReadPacket, 5_999_000, 6_000_000, packet(true, false));
    assert_eq!(c.windows.len(), 1); assert_eq!(c.windows_dropped, 1);
    assert_eq!(c.finished, 3); assert_eq!(c.trigger_count, 2);
    let result = c.receipt();
    assert_eq!(result["incompleteReasons"]["retainedOverflow"], true);
    assert_eq!(result["incompleteReasons"]["windowOverflow"], true);
    assert_eq!(result["diagnosticIncomplete"], true);
}

#[test]
fn counter_and_time_overflow_and_invalid_instant_are_explicit() {
    let mut c = collector();
    c.finished = u64::MAX;
    c.totals[Part::Aec as usize].total_micros = u64::MAX;
    record(&mut c, Part::Aec, 100, 200, Observation::None);
    assert_eq!(c.finished, u64::MAX);
    assert_eq!(c.totals[Part::Aec as usize].total_micros, u64::MAX);
    c.record(Part::Dispatch, 300, 299, Some(1), Some(2), Outcome::Completed,
        Observation::None, false);
    record(&mut c, Part::ReadPacket, u64::MAX-1, u64::MAX, packet(true, false));
    assert!(c.incomplete.counter_overflow); assert!(c.incomplete.invalid_instant);
    assert_eq!(c.windows.last().unwrap().end_elapsed_micros, u64::MAX);
    assert!(c.receipt()["diagnosticIncomplete"].as_bool().unwrap());
}

#[test]
fn unavailable_pre_context_pending_post_context_and_active_spans_are_explicit() {
    let mut c = collector();
    record(&mut c, Part::ReadPacket, 1, 2, packet(true, false));
    assert!(c.incomplete.pre_window_unavailable);
    assert_eq!(c.receipt()["pendingPostWindow"], true);
    let handle = enabled();
    let guard = Guard::new(handle.as_ref().unwrap(), Part::Aec).unwrap();
    assert_eq!(receipt(&handle).unwrap()["unfinishedSpans"], true);
    assert_eq!(receipt(&handle).unwrap()["diagnosticIncomplete"], true);
    drop(guard);
    assert_eq!(receipt(&handle).unwrap()["unfinishedSpans"], false);
    assert_eq!(receipt(&handle).unwrap()["incompleteReasons"]["unwound"], true);
}

#[test]
fn success_error_and_panic_are_measured_without_changing_results() {
    let handle = enabled();
    let success = measure(&handle, Part::Aec, || Ok::<_, &str>(171)).unwrap();
    assert_eq!(success, 171);
    let error = measure_observed(&handle, Part::EventWait, ||
        (Err::<(), _>("native failure"), Observation::Wait {
            status: WaitStatus::Failed, timeout_ms: 20 })).unwrap_err();
    assert_eq!(error, "native failure");
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _: Result<(), ()> = measure(&handle, Part::Dispatch, || panic!("same panic"));
    }));
    let payload = panic.unwrap_err();
    assert_eq!(*payload.downcast::<&str>().unwrap(), "same panic");
    let c = handle.as_ref().unwrap().collector.borrow();
    assert_eq!(c.active, 0); assert_eq!(c.finished, 3);
    assert_eq!(c.totals[Part::Aec as usize].count, 1);
    assert_eq!(c.totals[Part::EventWait as usize].rejected, 1);
    assert_eq!(c.totals[Part::Dispatch as usize].unwound, 1);
    assert_eq!(c.observations.failed, 1);
    assert_eq!(c.pre.back().unwrap().span.outcome, Outcome::Unwound);
}

#[test]
fn enabled_measure_keeps_nullable_qpc_no_clock_replacement() {
    let handle = enabled();
    TEST_QPC.with(|q| q.set(None));
    let result = measure(&handle, Part::PreparePacket, || Ok::<_, ()>("unchanged"));
    TEST_QPC.with(|q| q.set(Some(100)));
    assert_eq!(result.unwrap(), "unchanged");
    let c = handle.as_ref().unwrap().collector.borrow();
    let span = &c.pre.back().unwrap().span;
    assert_eq!(span.start_qpc_100ns, None); assert_eq!(span.end_qpc_100ns, None);
    assert!(!span.qpc_valid); assert!(c.incomplete.invalid_qpc);
    assert!(span.end_elapsed_micros >= span.start_elapsed_micros);
}

#[test]
fn nested_measurement_releases_refcell_before_operation() {
    let handle = enabled();
    let result: Result<u32, ()> = measure(&handle, Part::FullChunkProcess, || {
        assert_eq!(receipt(&handle).unwrap()["activeSpanCount"], 1);
        measure(&handle, Part::Aec, || Ok(17))
    });
    assert_eq!(result.unwrap(), 17);
    let c = handle.as_ref().unwrap().collector.borrow();
    assert_eq!(c.finished, 2); assert_eq!(c.active, 0);
    assert_eq!(c.pre[0].span.part, Part::Aec);
    assert_eq!(c.pre[1].span.part, Part::FullChunkProcess);
}

#[test]
fn drop_borrow_conflict_cannot_double_panic_or_claim_complete() {
    let handle = enabled();
    let guard = Guard::new(handle.as_ref().unwrap(), Part::Aec).unwrap();
    let borrow = handle.as_ref().unwrap().collector.borrow();
    drop(guard);
    assert!(handle.as_ref().unwrap().recording_borrow_conflict.get());
    drop(borrow);
    assert_eq!(receipt(&handle).unwrap()["diagnosticIncomplete"], true);
    assert_eq!(receipt(&handle).unwrap()["recordingBorrowConflict"], true);
    assert_eq!(receipt(&handle).unwrap()["unfinishedSpans"], true);
}

#[test]
fn receipt_binds_identity_no_authority_and_all_part_names_and_maxima() {
    let mut c = collector();
    for (i, part) in PARTS.into_iter().enumerate() {
        let start = 2_000_000 + i as u64 * 100;
        record(&mut c, part, start, start+10, Observation::None);
        record(&mut c, part, start+10, start+30, Observation::None);
        c.record(part, start+30, start+40, Some(10), Some(20), Outcome::Rejected,
            Observation::None, false);
    }
    let result = c.receipt();
    assert_eq!(result["captureOwnerId"], 17); assert_eq!(result["threadId"], 171);
    assert_eq!(result["endpointId"], "endpoint-vm171");
    assert_eq!(result["diagnosticOnly"], true);
    for key in ["qualityAcceptance", "formalCaptureClockAcceptance", "releaseEligible"] {
        assert_eq!(result[key], false);
    }
    let names = ["readPacket", "workAccounting", "packetAdmission", "boundaryProcess",
        "preparePacket", "dequeue", "fullChunkProcess", "aec", "dispatch",
        "queryPacket", "tailProcess", "eventWait"];
    for (i,name) in names.into_iter().enumerate() {
        assert_eq!(result["parts"][i]["part"], name);
        assert_eq!(result["parts"][i]["totals"]["count"], 3);
        assert_eq!(result["parts"][i]["totals"]["rejected"], 1);
        assert_eq!(result["parts"][i]["totals"]["totalMicros"], 40);
        assert_eq!(result["parts"][i]["totals"]["maximumMicros"], 20);
        assert_eq!(result["parts"][i]["totals"]["maximumSpan"]["durationMicros"], 20);
    }
}


#[test]
fn clean_nonempty_device_gap_triggers_context_and_saves_both_frame_positions() {
    let mut c = collector();
    record(&mut c, Part::Aec, 1_200_000, 1_300_000, Observation::None);
    record(&mut c, Part::ReadPacket, 1_499_000, 1_500_000, Observation::Packet {
        device_frame_index: 100, qpc_100ns: 123, frames: 480,
        data_discontinuity: false, timestamp_error: false, silent: false,
    });
    assert_eq!(c.previous_packet_end, Some(580));
    record(&mut c, Part::ReadPacket, 1_600_000, 1_600_001, Observation::Packet {
        device_frame_index: 0, qpc_100ns: 0, frames: 0,
        data_discontinuity: true, timestamp_error: true, silent: true,
    });
    assert_eq!(c.previous_packet_end, Some(580));
    assert_eq!(c.trigger_count, 0);
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, Observation::Packet {
        device_frame_index: 676, qpc_100ns: 456, frames: 480,
        data_discontinuity: false, timestamp_error: false, silent: false,
    });
    record(&mut c, Part::ReadPacket, 2_100_000, 2_100_001, Observation::Packet {
        device_frame_index: 1156, qpc_100ns: 789, frames: 480,
        data_discontinuity: false, timestamp_error: false, silent: true,
    });
    record(&mut c, Part::Dispatch, 2_500_000, 2_600_000, Observation::None);
    record(&mut c, Part::QueryPacket, 3_099_000, 3_100_000, Observation::None);
    assert_eq!(c.trigger_count, 1); assert_eq!(c.observations.frame_gaps, 1);
    assert_eq!(c.observations.empty_packets, 1);
    assert_eq!(c.observations.data_discontinuities, 0);
    assert_eq!(c.observations.timestamp_errors, 0);
    assert_eq!(sequences(&c), vec![0, 1, 2, 3, 4, 5]);
    let result = c.receipt();
    assert_eq!(result["frameGapTriggerCount"], 1);
    assert_eq!(result["retainedSpans"][3]["frameGap"]["previousEndDeviceFrameIndex"], 580);
    assert_eq!(result["retainedSpans"][3]["frameGap"]["currentDeviceFrameIndex"], 676);
    assert_eq!(result["retainedSpans"][3]["frameGap"]["forwardGapFrames"], 96);
    assert_eq!(result["diagnosticIncomplete"], false);
}

#[test]
fn backward_frame_position_is_gap_not_reanchored_and_packet_end_overflow_is_incomplete() {
    let mut c = collector();
    record(&mut c, Part::ReadPacket, 1_500_000, 1_500_001, Observation::Packet {
        device_frame_index: 100, qpc_100ns: 123, frames: 480,
        data_discontinuity: false, timestamp_error: false, silent: false,
    });
    record(&mut c, Part::ReadPacket, 1_999_000, 2_000_000, Observation::Packet {
        device_frame_index: 99, qpc_100ns: 124, frames: 480,
        data_discontinuity: true, timestamp_error: false, silent: false,
    });
    assert_eq!(c.trigger_count, 1); // flag AND gap are one trigger window
    let gap = c.observations.last_frame_gap.unwrap();
    assert_eq!(gap.previous_end_device_frame_index, 580);
    assert_eq!(gap.current_device_frame_index, 99);
    assert_eq!(gap.forward_gap_frames, None);
    record(&mut c, Part::ReadPacket, 2_100_000, 2_100_001, Observation::Packet {
        device_frame_index: u64::MAX-1, qpc_100ns: 125, frames: 96,
        data_discontinuity: false, timestamp_error: false, silent: false,
    });
    assert!(c.incomplete.packet_frame_overflow);
    assert_eq!(c.previous_packet_end, None);
    assert_eq!(c.observations.frame_gaps, 2);
    // No invented previous end after the arithmetic failure.
    record(&mut c, Part::ReadPacket, 2_200_000, 2_200_001, packet(false, false));
    assert_eq!(c.observations.frame_gaps, 2);
    assert_eq!(c.receipt()["incompleteReasons"]["packetFrameOverflow"], true);
    assert_eq!(c.receipt()["diagnosticIncomplete"], true);
}

#[test]
fn begin_conflict_shared_or_mutable_borrow_does_not_block_or_change_operation() {
    for mutable in [false, true] {
        let handle = enabled();
        let trace = handle.as_ref().unwrap();
        let shared = if mutable { None } else { Some(trace.collector.borrow()) };
        let exclusive = if mutable { Some(trace.collector.borrow_mut()) } else { None };
        let mut calls = 0;
        let result: Result<u32, &str> = measure(&handle, Part::Aec, || {
            calls += 1; Ok(171)
        });
        assert_eq!(result.unwrap(), 171);
        let result = measure_observed(&handle, Part::EventWait, || {
            calls += 1;
            (Err::<(), _>("same native error"), Observation::Wait {
                status: WaitStatus::Failed, timeout_ms: 20 })
        });
        assert_eq!(result.unwrap_err(), "same native error");
        assert_eq!(calls, 2);
        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _: Result<(), ()> = measure(&handle, Part::Dispatch,
                || panic!("original operation panic"));
        }));
        assert_eq!(*panic.unwrap_err().downcast::<&str>().unwrap(), "original operation panic");
        assert!(trace.recording_borrow_conflict.get());
        drop(shared); drop(exclusive);
        let result = receipt(&handle).unwrap();
        assert_eq!(result["recordingBorrowConflict"], true);
        assert_eq!(result["diagnosticIncomplete"], true);
        assert_eq!(result["activeSpanCount"], 0);
        assert_eq!(result["finishedSpanCount"], 0);
        // Once released, later measurement still works; the fault remains sticky.
        measure(&handle, Part::Aec, || Ok::<(), ()>(())).unwrap();
        assert_eq!(receipt(&handle).unwrap()["finishedSpanCount"], 1);
        assert_eq!(receipt(&handle).unwrap()["diagnosticIncomplete"], true);
    }
}

#[test]
fn receipt_under_mutable_borrow_returns_none_marks_conflict_without_panicking() {
    let handle = enabled();
    let borrow = handle.as_ref().unwrap().collector.borrow_mut();
    assert!(receipt(&handle).is_none());
    drop(borrow);
    assert_eq!(receipt(&handle).unwrap()["recordingBorrowConflict"], true);
    assert_eq!(receipt(&handle).unwrap()["diagnosticIncomplete"], true);
}
