use super::*;
use crate::audio::state::{NativeCapturePacket, NativeCaptureWork};

fn route() -> AudioRouteRuntimeSnapshot {
    let mut route = AudioRouteRuntimeSnapshot::idle("audio-route-inbound-watch", "inbound");
    route.stream_bound = true;
    route.capture_state = "buffering".into();
    route.vad_state = "silence".into();
    route.last_energy_db = -90.0;
    route.last_frame_at = Some("last-real-packet".into());
    route.frames_captured = 480;
    route
}
fn packet(frames: u64) -> NativeCapturePacket {
    NativeCapturePacket { frames, device_frame_index: 900, qpc_100ns: 123,
        silent: false, data_discontinuity: false, timestamp_error: false, raw_energy_db: -90.0 }
}
fn started(at: Instant) -> NativeCaptureStartAck {
    let owner = NativeCaptureStartAck::new();
    owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    owner.publish_query(at, NativeCaptureQuery::Empty, NativeCaptureWork {
        packet: Some(packet(480)), aec_completed_frames: 480,
        dispatch_completed_frames: 480, residual_bytes: 0 });
    owner
}
fn empty(owner: &NativeCaptureStartAck, at: Instant) {
    owner.publish_query(at, NativeCaptureQuery::Empty, NativeCaptureWork::default());
}
fn observe(drain: &mut CaptureDrain, at: Instant, route: &AudioRouteRuntimeSnapshot,
    owner: &NativeCaptureStartAck) -> bool {
    drain.observe_owned(|| at, route, true, true, owner, Some(owner)).unwrap()
}
fn snapshot(drain: &CaptureDrain, at: Instant, route: &AudioRouteRuntimeSnapshot,
    owner: &NativeCaptureStartAck, current: Option<&NativeCaptureStartAck>) -> Value {
    let before_receipt = drain.receipt(route);
    let before_health = format!("{:?}", owner.health());
    let result = drain.failure_observation(|| at, FailureContext {
        route, media_complete: true, stream_drained: true, expected: owner, current,
        failure: "native drain deadline exceeded", source_evidence_failure: None,
    });
    assert_eq!(result["schemaVersion"], 1);
    assert_eq!(result["artifactKind"], "local-aec-capture-drain-failure-observation");
    assert_eq!(result["diagnosticOnly"], true);
    assert_eq!(result["accepted"], false);
    assert_eq!(result["capturedBeforeForcedCleanup"], true);
    for key in ["ownerId", "started", "terminal", "fault", "latestQuery", "successfulQueries",
        "lastQueryAgeMs", "queryClockInFuture", "lastQueryGapMs", "emptySinceAgeMs", "emptyPolls",
        "maximumEmptyPollGapMs", "capturedFrames", "aecCompletedFrames", "dispatchCompletedFrames",
        "residualBytes", "workPending", "rawActivityGeneration", "lastRawActivityAgeMs", "latestPacket",
        "emptyEpoch", "progressEpoch", "quiescenceEpoch", "aecResetGeneration"] {
        assert!(result["expectedOwner"].get(key).is_some(), "missing typed owner field: {key}");
    }
    for key in ["lastRejection", "stickyFailure", "lastObservationAgeMs", "latestConsumerGapMs",
        "lastProgressAgeMs", "pcmQuietAgeMs", "nativeIdleQuietAgeMs", "quietStartFrame", "previousFrames",
        "previousSegments", "previousSuccessfulQuery", "observedNativeActivity", "idleEpoch", "activityResets"] {
        assert!(result["drain"].get(key).is_some(), "missing drain provenance: {key}");
    }
    assert!(result.get("completionMode").is_none());
    assert!(result.get("nativeHealth").is_none());
    assert_eq!(before_receipt, drain.receipt(route));
    assert_eq!(before_health, format!("{:?}", owner.health()));
    assert_eq!(drain.receipt(route)["completionMode"], Value::Null);
    assert_eq!(drain.receipt(route)["nativeHealth"], Value::Null);
    result
}

#[test]
fn failure_snapshot_partial_packet_and_pending_query_never_complete_drain() {
    for (query, residual) in [(NativeCaptureQuery::Empty, 8), (NativeCaptureQuery::Pending(480), 0)] {
        let start = Instant::now();
        let owner = started(start);
        owner.publish_query(start + Duration::from_millis(20), query,
            NativeCaptureWork { residual_bytes: residual, ..NativeCaptureWork::default() });
        let mut drain = CaptureDrain::default();
        assert!(!observe(&mut drain, start + Duration::from_millis(20), &route(), &owner));
        let value = snapshot(&drain, start + Duration::from_secs(3), &route(), &owner, Some(&owner));
        assert_eq!(value["drain"]["lastRejection"], "native-not-drained");
        assert_eq!(value["expectedOwner"]["residualBytes"], residual);
        assert_eq!(value["expectedOwner"]["latestQuery"], json!(query));
        assert_eq!(value["expectedOwner"], value["currentOwner"]);
        assert!(!observe(&mut drain, start + Duration::from_secs(3), &route(), &owner));
    }
}

#[test]
fn failure_snapshot_counter_mismatch_retains_each_actual_completion_counter() {
    for (aec, dispatch) in [(0, 480), (480, 0), (0, 0)] {
        let start = Instant::now();
        let owner = NativeCaptureStartAck::new();
        owner.observe_native_start(Ok::<_, ()>(())).unwrap();
        owner.publish_query(start, NativeCaptureQuery::Empty, NativeCaptureWork {
            packet: Some(packet(480)), aec_completed_frames: aec,
            dispatch_completed_frames: dispatch, residual_bytes: 0 });
        let mut drain = CaptureDrain::default();
        assert!(!observe(&mut drain, start, &route(), &owner));
        let value = snapshot(&drain, start, &route(), &owner, Some(&owner));
        assert_eq!(value["expectedOwner"]["capturedFrames"], 480);
        assert_eq!(value["expectedOwner"]["aecCompletedFrames"], aec);
        assert_eq!(value["expectedOwner"]["dispatchCompletedFrames"], dispatch);
        assert_eq!(value["expectedOwner"]["latestPacket"]["qpc100ns"], 123);
    }
}

#[test]
fn failure_snapshot_frozen_query_reports_age_without_inventing_progress() {
    let start = Instant::now(); let owner = started(start); let mut drain = CaptureDrain::default();
    assert!(!observe(&mut drain, start, &route(), &owner));
    let value = snapshot(&drain, start + Duration::from_secs(3), &route(), &owner, Some(&owner));
    assert_eq!(value["expectedOwner"]["lastQueryAgeMs"], 3000);
    assert_eq!(value["expectedOwner"]["successfulQueries"], 1);
    assert_eq!(value["drain"]["lastObservationAgeMs"], 3000);
    assert_eq!(value["drain"]["previousSuccessfulQuery"], 1);
    assert!(!observe(&mut drain, start + Duration::from_secs(3), &route(), &owner));
}

#[test]
fn failure_snapshot_stalled_native_work_retains_fresh_old_empty_without_acceptance() {
    let start = Instant::now(); let owner = started(start); let producer = owner.producer_guard();
    let mut drain = CaptureDrain::default();
    for i in 0..=99 {
        let at = start + Duration::from_millis(i * 20); empty(&owner, at);
        assert!(!observe(&mut drain, at, &route(), &owner));
    }
    let query_at = start + Duration::from_millis(2000); empty(&owner, query_at);
    producer.begin_work(8);
    assert!(!observe(&mut drain, query_at + Duration::from_millis(10), &route(), &owner));
    for offset in [10, 3000] {
        let value = snapshot(&drain, query_at + Duration::from_millis(offset), &route(), &owner, Some(&owner));
        assert_eq!(value["drain"]["lastRejection"], "native-work-pending");
        assert_eq!(value["expectedOwner"]["workPending"], true);
        assert_eq!(value["expectedOwner"]["lastQueryAgeMs"], offset);
        assert_eq!(value["expectedOwner"]["latestQuery"]["kind"], "empty");
        assert_eq!(value["expectedOwner"]["terminal"], false);
    }
    assert!(!observe(&mut drain, query_at + Duration::from_secs(3), &route(), &owner));
}

#[test]
fn failure_snapshot_never_refreshes_unavailable_or_future_query_clock() {
    let start = Instant::now();
    for future in [false, true] {
        let owner = started(start); let mut drain = CaptureDrain::default();
        owner.publish_query(start + Duration::from_millis(20),
            if future { NativeCaptureQuery::Empty } else { NativeCaptureQuery::Unavailable },
            NativeCaptureWork::default());
        let now = if future { start } else { start + Duration::from_millis(3000) };
        let value = snapshot(&drain, now, &route(), &owner, Some(&owner));
        assert_eq!(value["expectedOwner"]["queryClockInFuture"], future);
        assert_eq!(value["expectedOwner"]["lastQueryAgeMs"], if future { json!(0) } else { Value::Null });
        assert!(!observe(&mut drain, now, &route(), &owner));
    }
}

#[test]
fn failure_snapshot_missing_or_replaced_owner_keeps_expected_and_current_separate() {
    let start = Instant::now(); let owner = started(start); let replacement = started(start);
    for current in [None, Some(&replacement)] {
        let mut drain = CaptureDrain::default();
        let error = drain.observe_owned(|| start, &route(), true, true, &owner, current).unwrap_err();
        let value = snapshot(&drain, start, &route(), &owner, current);
        assert_eq!(value["ownerContinuity"], false);
        assert_eq!(value["expectedOwner"]["ownerId"], owner.health().owner_id);
        assert_eq!(value["drain"]["stickyFailure"], error);
        assert_eq!(value["drain"]["lastRejection"], if current.is_none() { "owner-missing" } else { "owner-replaced" });
        if current.is_none() { assert_eq!(value["currentOwner"], Value::Null); }
        else {
            assert_eq!(value["currentOwner"]["ownerId"], replacement.health().owner_id);
            assert_ne!(value["currentOwner"]["ownerId"], value["expectedOwner"]["ownerId"]);
        }
        // Restoring membership cannot erase an earlier fatal rejection.
        assert!(drain.observe_owned(|| start, &route(), true, true, &owner, Some(&owner)).is_err());
    }
}

#[test]
fn failure_snapshot_stopped_and_faulted_owner_preserves_terminal_provenance() {
    for fault in [None, Some("GetNextPacketSize failed")] {
        let start = Instant::now(); let owner = started(start); let mut producer = owner.producer_guard();
        producer.stopping(); producer.finish(&fault.map_or(Ok(()), |message| Err(message.into())));
        let mut drain = CaptureDrain::default();
        assert!(drain.observe_owned(|| start, &route(), true, true, &owner, Some(&owner)).is_err());
        let value = snapshot(&drain, start, &route(), &owner, Some(&owner));
        assert_eq!(value["drain"]["lastRejection"], "native-terminal-or-fault");
        assert_eq!(value["expectedOwner"]["terminal"], true);
        assert_eq!(value["expectedOwner"]["fault"], json!(fault));
        assert_eq!(value["ownerContinuity"], true);
        assert!(drain.observe_owned(|| start, &route(), true, true, &owner, Some(&owner)).is_err());
    }
}

#[test]
fn failure_snapshot_producer_and_consumer_gaps_retain_window_reset_provenance() {
    for consumer_gap in [false, true] {
        let start = Instant::now(); let owner = started(start); let mut drain = CaptureDrain::default();
        for i in 0..=95 {
            let at = start + Duration::from_millis(i * 20); empty(&owner, at);
            assert!(!observe(&mut drain, at, &route(), &owner));
        }
        if consumer_gap {
            for i in 96..=110 { empty(&owner, start + Duration::from_millis(i * 20)); }
        } else { empty(&owner, start + Duration::from_millis(2200)); }
        let at = start + Duration::from_millis(2200);
        assert!(!observe(&mut drain, at, &route(), &owner));
        let value = snapshot(&drain, at, &route(), &owner, Some(&owner));
        assert_eq!(value["drain"]["latestConsumerGapMs"], 300);
        assert!(value["drain"]["activityResets"].as_u64().unwrap() > 0);
        assert_eq!(value["expectedOwner"]["lastQueryGapMs"], if consumer_gap { 20 } else { 300 });
        assert!(value["drain"]["nativeIdleQuietAgeMs"].is_null()
            || value["drain"]["nativeIdleQuietAgeMs"] == 0);
    }
}

#[test]
fn failure_snapshot_aec_reset_retains_generation_and_invalidated_quiet_window() {
    let start = Instant::now(); let owner = started(start); let producer = owner.producer_guard();
    let mut drain = CaptureDrain::default();
    for i in 0..=95 {
        let at = start + Duration::from_millis(i * 20); empty(&owner, at);
        assert!(!observe(&mut drain, at, &route(), &owner));
    }
    let before_reset = owner.health();
    producer.record_aec_reset();
    let at = start + Duration::from_millis(1920); empty(&owner, at);
    assert!(!observe(&mut drain, at, &route(), &owner));
    let value = snapshot(&drain, at, &route(), &owner, Some(&owner));
    assert_eq!(value["expectedOwner"]["aecResetGeneration"], 1);
    assert_eq!(value["expectedOwner"]["quiescenceEpoch"], before_reset.quiescence_epoch);
    assert!(value["expectedOwner"]["emptyEpoch"].as_u64().unwrap() > before_reset.empty_epoch);
    assert!(value["drain"]["activityResets"].as_u64().unwrap() > 0);
    assert_eq!(value["expectedOwner"], value["currentOwner"]);
}

#[test]
fn failure_snapshot_source_error_and_route_state_survive_without_completion_authority() {
    let start = Instant::now(); let owner = started(start); let mut drain = CaptureDrain::default();
    let mut route = route();
    route.last_error = Some("capture failed before cleanup".into());
    route.last_error_code = Some("CAPTURE_FAILED".into());
    route.active_segment_id = Some("unclosed-segment".into());
    assert!(drain.observe_owned(|| start, &route, false, false, &owner, Some(&owner)).is_err());
    let value = drain.failure_observation(|| start, FailureContext {
        route: &route, media_complete: false, stream_drained: false, expected: &owner, current: Some(&owner),
        failure: "native drain deadline exceeded", source_evidence_failure: Some("source IAudioClock drift"),
    });
    assert_eq!(value["drain"]["lastRejection"], "route-closed-or-failed");
    assert_eq!(value["failure"], "native drain deadline exceeded");
    assert_eq!(value["sourceEvidenceFailure"], "source IAudioClock drift");
    assert_eq!(value["mediaComplete"], false); assert_eq!(value["streamDrained"], false);
    assert_eq!(value["route"]["lastError"], "capture failed before cleanup");
    assert_eq!(value["route"]["lastErrorCode"], "CAPTURE_FAILED");
    assert_eq!(value["route"]["activeSegmentId"], "unclosed-segment");
    assert_eq!(value["route"]["streamBound"], true);
    assert_eq!(value["expectedOwner"]["terminal"], false);
    assert_eq!(value["accepted"], false);
    assert_eq!(drain.receipt(&route)["completionMode"], Value::Null);
}


#[test]
fn failure_snapshot_unstarted_owner_preserves_absent_clocks_and_queries() {
    let at = Instant::now(); let owner = NativeCaptureStartAck::new(); let mut drain = CaptureDrain::default();
    assert!(!observe(&mut drain, at, &route(), &owner));
    let value = snapshot(&drain, at, &route(), &owner, Some(&owner));
    assert_eq!(value["expectedOwner"]["started"], false);
    assert_eq!(value["expectedOwner"]["successfulQueries"], 0);
    assert_eq!(value["expectedOwner"]["lastQueryAgeMs"], Value::Null);
    assert_eq!(value["expectedOwner"]["emptySinceAgeMs"], Value::Null);
    assert_eq!(value["expectedOwner"]["lastQueryGapMs"], Value::Null);
    assert_eq!(value["expectedOwner"]["lastRawActivityAgeMs"], Value::Null);
    assert_eq!(value["expectedOwner"]["latestPacket"], Value::Null);
}

#[test]
fn failure_snapshot_physical_media_completion_does_not_replace_renderer_drain() {
    let start = Instant::now(); let owner = started(start); let mut drain = CaptureDrain::default();
    for i in 0..=110 {
        let at = start + Duration::from_millis(i * 20); empty(&owner, at);
        assert!(!drain.observe_owned(|| at, &route(), true, false, &owner, Some(&owner)).unwrap());
    }
    let at = start + Duration::from_millis(2200);
    let value = drain.failure_observation(|| at, FailureContext {
        route: &route(), media_complete: true, stream_drained: false, expected: &owner, current: Some(&owner),
        failure: "renderer drain did not complete", source_evidence_failure: None,
    });
    assert_eq!(value["mediaComplete"], true); assert_eq!(value["streamDrained"], false);
    assert_eq!(value["drain"]["lastRejection"], "idle-not-quiet");
    assert_eq!(value["accepted"], false);
    assert_eq!(drain.receipt(&route())["completionMode"], Value::Null);
}

#[test]
fn failure_snapshot_after_successful_drain_does_not_erase_or_reauthorize_receipt() {
    let start=Instant::now();let owner=started(start);let r=route();let mut d=CaptureDrain::default();
    for i in 0..=100 { let at=start+Duration::from_millis(i*20);empty(&owner,at);
        assert_eq!(observe(&mut d,at,&r,&owner),i==100); }
    let before=d.receipt(&r);let health=format!("{:?}",owner.health());
    let v=d.failure_observation(||start+Duration::from_secs(2),FailureContext {
        route:&r,media_complete:true,stream_drained:true,expected:&owner,current:Some(&owner),
        failure:"retained source evidence rejected",source_evidence_failure:Some("source clock >1ms"),
    });
    assert_eq!(v["accepted"],false);assert_eq!(v["sourceValidationState"],"rejected");
    assert_eq!(v["sourceEvidenceFailure"],"source clock >1ms");
    assert_eq!(v["drain"]["lastRejection"],Value::Null);
    assert_eq!(before,d.receipt(&r));assert_eq!(health,format!("{:?}",owner.health()));
    assert_eq!(d.receipt(&r)["completionMode"],"native-empty-polls");
}
