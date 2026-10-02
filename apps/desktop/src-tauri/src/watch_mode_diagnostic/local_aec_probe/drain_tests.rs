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
fn captured(owner: &NativeCaptureStartAck, at: Instant, frames: u64, raw_energy_db: f32) {
    owner.publish_query(at, NativeCaptureQuery::Empty, NativeCaptureWork {
        packet: Some(NativeCapturePacket { frames, device_frame_index:900,qpc_100ns:123,
            silent:false,data_discontinuity:false,timestamp_error:false,raw_energy_db }),
        aec_completed_frames:frames,dispatch_completed_frames:frames,residual_bytes:0 });
}
fn started(start: Instant) -> NativeCaptureStartAck {
    let owner = NativeCaptureStartAck::new();
    owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    captured(&owner,start - Duration::from_millis(20),480,-90.0);
    owner
}
fn empty(owner: &NativeCaptureStartAck, at: Instant) {
    owner.publish_query(at,NativeCaptureQuery::Empty,NativeCaptureWork::default());
}
fn observe(drain: &mut CaptureDrain, now: Instant, route: &AudioRouteRuntimeSnapshot,
    owner: &NativeCaptureStartAck) -> bool {
    drain.observe_owned(|| now, route, true, true, owner, Some(owner)).unwrap()
}
#[test]
fn native_idle_drain_completes_without_fabricating_96000_pcm_frames() {
    let start = Instant::now(); let route = route(); let owner = started(start);
    let mut drain = CaptureDrain::default();
    for i in 0..=100 {
        let at = start + Duration::from_millis(i * 20);
        empty(&owner,at);
        assert_eq!(observe(&mut drain,at,&route,&owner),i==100);
    }
    assert_eq!(route.frames_captured,480);
    let receipt=drain.receipt(&route);
    assert_eq!(receipt["schemaVersion"],2);
    assert_eq!(receipt["completionMode"],"native-empty-polls");
    assert_eq!(receipt["minimumQuietCaptureFrames"],Value::Null);
    assert_eq!(receipt["nativeHealth"]["emptyPollCount"],101);
    assert_eq!(receipt["nativeHealth"]["capturedFrames"],480);
    assert_eq!(receipt["nativeHealth"]["maximumProducerPollGapMs"],20);
    assert_eq!(receipt["nativeHealth"]["latestPacket"]["qpc100ns"],123);
    assert_eq!(receipt["nativeHealth"]["lastRawActivityAgeMs"],Value::Null);
    assert_eq!(receipt["captureStateAtDrain"],"buffering");
}
#[test]
fn native_idle_drain_requires_actual_capture_aec_and_dispatch_completion() {
    let start=Instant::now();
    for (read,aec,dispatch) in [(0,0,0),(480,0,480),(480,480,0)] {
        let owner=NativeCaptureStartAck::new(); owner.observe_native_start(Ok::<_, ()>(())).unwrap();
        if read>0 { owner.publish_query(start-Duration::from_millis(20),NativeCaptureQuery::Empty,NativeCaptureWork {
            packet:Some(NativeCapturePacket { frames:read,device_frame_index:0,qpc_100ns:123,
                silent:false,data_discontinuity:false,timestamp_error:false,raw_energy_db:-90.0 }),
            aec_completed_frames:aec,dispatch_completed_frames:dispatch,residual_bytes:0 }); }
        let mut drain=CaptureDrain::default();
        for i in 0..=110 { let at=start+Duration::from_millis(i*20); empty(&owner,at);
            assert!(!observe(&mut drain,at,&route(),&owner)); }
    }
}
#[test]
fn native_idle_drain_rejects_same_endpoint_replacement_and_removed_owner() {
    let start=Instant::now(); let owner=started(start); let replacement=started(start);
    let mut drain=CaptureDrain::default();
    assert!(drain.observe_owned(|| start,&route(),true,true,&owner,Some(&replacement)).is_err());
    assert!(drain.observe_owned(|| start,&route(),true,true,&owner,None).is_err());
}
#[test]
fn native_idle_drain_wait_timeouts_and_frozen_success_snapshot_are_not_progress() {
    let start=Instant::now(); let owner=started(start); let mut drain=CaptureDrain::default();
    empty(&owner,start);
    // Event waits or repeated reads cannot publish a successful native query.
    for i in 0..=110 { assert!(!observe(&mut drain,start+Duration::from_millis(i*20),&route(),&owner)); }
    // An exclusive-mode None didn't make any native query either.
    for i in 111..=220 { let at=start+Duration::from_millis(i*20);
        owner.publish_query(at,NativeCaptureQuery::Unavailable,NativeCaptureWork::default());
        assert!(!observe(&mut drain,at,&route(),&owner)); }
}
#[test]
fn native_idle_drain_does_not_wash_producer_or_consumer_gap_with_one_query() {
    for consumer_blind in [false,true] {
        let start=Instant::now(); let owner=started(start); let mut drain=CaptureDrain::default();
        for i in 0..=95 { let at=start+Duration::from_millis(i*20);empty(&owner,at);
            assert!(!observe(&mut drain,at,&route(),&owner)); }
        if consumer_blind {
            // Producer remains genuinely healthy while the consumer is blind.
            for i in 96..=110 { empty(&owner,start+Duration::from_millis(i*20)); }
        }
        let resumed=start+Duration::from_millis(2220);
        empty(&owner,resumed);
        assert!(!observe(&mut drain,resumed,&route(),&owner));
        for i in 1..=100 { let at=resumed+Duration::from_millis(i*20);empty(&owner,at);
            assert_eq!(observe(&mut drain,at,&route(),&owner),i==100); }
    }
}
#[test]
fn native_idle_drain_pending_partial_raw_and_segments_restart_the_window() {
    for disturbance in 0..5 {
        let start=Instant::now();let owner=started(start);let mut drain=CaptureDrain::default();let mut route=route();
        for i in 0..=95 { let at=start+Duration::from_millis(i*20);empty(&owner,at);
            assert!(!observe(&mut drain,at,&route,&owner)); }
        let dirty=start+Duration::from_millis(1920);
        match disturbance {
            0=>owner.publish_query(dirty,NativeCaptureQuery::Pending(480),NativeCaptureWork::default()),
            1=>owner.publish_query(dirty,NativeCaptureQuery::Empty,NativeCaptureWork { residual_bytes:8,..Default::default() }),
            2=>{ captured(&owner,dirty,480,-12.0);route.frames_captured+=480; },
            3=>{ empty(&owner,dirty);route.segment_count+=1; },
            _=>{ empty(&owner,dirty);route.active_segment_id=Some("new-segment".into()); },
        }
        // Hidden Pending/raw/residual between observations still changes epoch.
        if disturbance>=3 { assert!(!observe(&mut drain,dirty,&route,&owner)); }
        route.active_segment_id=None;
        let resumed=dirty+Duration::from_millis(20);empty(&owner,resumed);
        assert!(!observe(&mut drain,resumed,&route,&owner));
        for i in 1..=100 { let at=resumed+Duration::from_millis(i*20);empty(&owner,at);
            assert_eq!(observe(&mut drain,at,&route,&owner),i==100,"disturbance {disturbance}"); }
    }
}
#[test]
fn native_idle_drain_terminal_and_query_errors_are_sticky() {
    for fault in [None,Some("GetNextPacketSize failed".into())] {
        let start=Instant::now();let owner=started(start);let mut guard=owner.producer_guard();
        guard.stopping();let result=fault.map_or(Ok(()),Err);guard.finish(&result);
        empty(&owner,start);
        assert!(CaptureDrain::default().observe_owned(|| start,&route(),true,true,&owner,Some(&owner)).is_err());
    }
}
#[test]
fn native_idle_drain_media_complete_cannot_replace_renderer_drain() {
    let start=Instant::now();let owner=started(start);let mut drain=CaptureDrain::default();
    for i in 0..=110 { let at=start+Duration::from_millis(i*20);empty(&owner,at);
        assert!(!drain.observe_owned(|| at,&route(),true,false,&owner,Some(&owner)).unwrap()); }
}
#[test]
fn native_idle_drain_freshness_boundary_is_100ms_not_an_event_wait_budget() {
    for step in [100,101] {
        let start=Instant::now();let owner=started(start);let mut drain=CaptureDrain::default();
        for i in 0..=20 {let at=start+Duration::from_millis(i*step);empty(&owner,at);
            assert_eq!(observe(&mut drain,at,&route(),&owner),step==100 && i==20); }
    }
}
#[test]
fn native_idle_drain_actual_pcm_branch_still_requires_96000_new_frames() {
    let start=Instant::now();let owner=started(start);let mut drain=CaptureDrain::default();let mut route=route();
    for i in 0..=100 { let at=start+Duration::from_millis(i*20);
        captured(&owner,at,960,-90.0);route.frames_captured+=960;
        assert_eq!(observe(&mut drain,at,&route,&owner),i==100); }
    let receipt=drain.receipt(&route);
    assert_eq!(receipt["completionMode"],"pcm-frames");
    assert_eq!(receipt["minimumQuietCaptureFrames"],96000);
    assert_eq!(receipt["quietEndFrame"].as_u64().unwrap()-receipt["quietStartFrame"].as_u64().unwrap(),96000);
}

#[test]
fn native_idle_drain_capture_fault_and_raw_activity_cannot_hide_behind_cleaned_pcm() {
    let start=Instant::now();let owner=started(start);let mut drain=CaptureDrain::default();let mut route=route();
    for i in 0..=110 { let at=start+Duration::from_millis(i*20);
        captured(&owner,at,960,-12.0);route.frames_captured+=960;
        assert!(!observe(&mut drain,at,&route,&owner)); }
    route.last_error=Some("earlier capture failure".into());
    assert!(drain.observe_owned(|| start+Duration::from_secs(3),&route,true,true,&owner,Some(&owner)).is_err());
}

#[test]
fn native_idle_drain_old_fresh_empty_cannot_complete_while_real_work_is_blocked() {
    for stall_long in [false,true] {
        let start=Instant::now();let owner=started(start);let producer=owner.producer_guard();let mut drain=CaptureDrain::default();
        for i in 0..=99 {let at=start+Duration::from_millis(i*20);empty(&owner,at);
            assert!(!observe(&mut drain,at,&route(),&owner)); }
        empty(&owner,start+Duration::from_millis(2000)); // not yet seen by consumer
        producer.begin_work(0); // real native GetBuffer now in flight
        assert!(owner.health().work_pending);
        assert!(!observe(&mut drain,start+Duration::from_millis(2010),&route(),&owner));
        let resumed=start+Duration::from_millis(if stall_long {2220}else{2020});
        producer.publish_query(resumed,NativeCaptureQuery::Empty,NativeCaptureWork::default());
        assert_eq!(observe(&mut drain,resumed,&route(),&owner),!stall_long);
    }
}
#[test]
fn native_idle_drain_raw_packet_and_each_completion_are_visible_before_query_publication() {
    let start=Instant::now();let owner=started(start);let producer=owner.producer_guard();let mut drain=CaptureDrain::default();
    for i in 0..=99 {let at=start+Duration::from_millis(i*20);empty(&owner,at);
        assert!(!observe(&mut drain,at,&route(),&owner)); }
    empty(&owner,start+Duration::from_millis(2000));
    let prior=owner.health();
    producer.begin_work(0);
    producer.record_packet(&NativeCapturePacket {frames:480,device_frame_index:1380,qpc_100ns:999,
        silent:false,data_discontinuity:false,timestamp_error:false,raw_energy_db:-12.0},480*8);
    let read=owner.health();
    assert_eq!(read.captured_frames,960);
    assert_eq!(read.aec_completed_frames,480);
    assert_eq!(read.dispatch_completed_frames,480);
    assert_eq!(read.latest_packet.unwrap().qpc_100ns,999);
    assert_eq!(read.successful_queries,prior.successful_queries);
    assert_eq!(read.last_query_at,prior.last_query_at);
    assert!(!observe(&mut drain,start+Duration::from_millis(2010),&route(),&owner));
    producer.complete_aec(480);
    assert_eq!(owner.health().aec_completed_frames,960);
    assert_eq!(owner.health().dispatch_completed_frames,480);
    assert!(!observe(&mut drain,start+Duration::from_millis(2020),&route(),&owner));
    producer.complete_dispatch(480);
    assert!(owner.health().work_pending);
    assert_eq!(owner.health().dispatch_completed_frames,960);
    // Even completed AEC/dispatch doesn't count as a successful native query.
    assert_eq!(owner.health().successful_queries,prior.successful_queries);
    producer.publish_query(start+Duration::from_millis(2040),NativeCaptureQuery::Empty,NativeCaptureWork::default());
    assert!(!owner.health().work_pending);
    let mut updated=route();updated.frames_captured=960;
    assert!(!observe(&mut drain,start+Duration::from_millis(2040),&updated,&owner));
}

#[test]
fn native_idle_drain_rejects_stop_requested_and_paused_before_producer_terminal() {
    for state in ["stopping","paused","muted","stop-requested"] {
        let start=Instant::now();let owner=started(start);let producer=owner.producer_guard();let mut drain=CaptureDrain::default();
        for i in 0..=99 {let at=start+Duration::from_millis(i*20);empty(&owner,at);
            assert!(!observe(&mut drain,at,&route(),&owner)); }
        let mut control=route();control.capture_state=state.into();
        producer.begin_work(0);
        assert!(!owner.health().terminal);
        assert!(drain.observe_owned(|| start+Duration::from_millis(2000),&control,true,true,&owner,Some(&owner)).is_err());
        producer.publish_query(start+Duration::from_millis(2020),NativeCaptureQuery::Empty,NativeCaptureWork::default());
        assert!(drain.observe_owned(|| start+Duration::from_millis(2020),&route(),true,true,&owner,Some(&owner)).is_err());
    }
}

fn partial(owner: &NativeCaptureStartAck, at: Instant) {
    owner.publish_query(at,NativeCaptureQuery::Empty,NativeCaptureWork {
        packet:Some(NativeCapturePacket {frames:1,device_frame_index:999,qpc_100ns:999,
            silent:false,data_discontinuity:false,timestamp_error:false,raw_energy_db:-90.0}),
        residual_bytes:8,..Default::default() });
}
fn finish_partial(owner: &NativeCaptureStartAck, at: Instant) {
    owner.publish_query(at,NativeCaptureQuery::Empty,NativeCaptureWork {
        packet:Some(NativeCapturePacket {frames:959,device_frame_index:1000,qpc_100ns:1000,
            silent:false,data_discontinuity:false,timestamp_error:false,raw_energy_db:-90.0}),
        aec_completed_frames:960,dispatch_completed_frames:960,residual_bytes:0 });
}
#[test]
fn review_f1_pcm_cannot_complete_with_native_pending_or_partial_residual() {
    for pending in [true,false] {
        let start=Instant::now();let owner=started(start);let mut drain=CaptureDrain::default();let mut route=route();
        for i in 0..=100 { let at=start+Duration::from_millis(i*20);captured(&owner,at,960,-90.0);route.frames_captured+=960;
            if i==100 {
                if pending { owner.publish_query(at,NativeCaptureQuery::Pending(480),NativeCaptureWork::default()); }
                else {partial(&owner,at);}
            }
            assert!(!observe(&mut drain,at,&route,&owner),"native pending={pending} at {i}");
        }
    }
}
#[test]
fn review_f1_pending_partial_history_restarts_pcm_two_second_and_96000_frame_window() {
    for pending in [true,false] {
        let start=Instant::now();let owner=started(start);let mut drain=CaptureDrain::default();let mut route=route();
        for i in 0..=95 {let at=start+Duration::from_millis(i*20);captured(&owner,at,960,-90.0);route.frames_captured+=960;
            assert!(!observe(&mut drain,at,&route,&owner));}
        let dirty=start+Duration::from_millis(1920);
        if pending {owner.publish_query(dirty,NativeCaptureQuery::Pending(480),NativeCaptureWork::default());}
        else {partial(&owner,dirty);}
        assert!(!observe(&mut drain,dirty,&route,&owner));
        let resumed=start+Duration::from_millis(1940);
        for i in 0..=100 {let at=resumed+Duration::from_millis(i*20);
            if !pending && i==0 {finish_partial(&owner,at);}else{captured(&owner,at,960,-90.0);}
            route.frames_captured+=960;
            assert_eq!(observe(&mut drain,at,&route,&owner),i==100,"history pending={pending} at {i}");}
    }
}
#[test]
fn review_f2_flag_clean_actual_aec_reset_restarts_pcm_quiet_provenance() {
    let start=Instant::now();let owner=started(start);let producer=owner.producer_guard();let mut drain=CaptureDrain::default();let mut route=route();
    for i in 0..=95 {let at=start+Duration::from_millis(i*20);captured(&owner,at,960,-90.0);route.frames_captured+=960;
        assert!(!observe(&mut drain,at,&route,&owner));}
    // Successful real reset is a boundary even if the next packet has clean flags.
    producer.record_aec_reset();
    let resumed=start+Duration::from_millis(1920);
    for i in 0..=100 {let at=resumed+Duration::from_millis(i*20);captured(&owner,at,960,-90.0);route.frames_captured+=960;
        assert_eq!(observe(&mut drain,at,&route,&owner),i==100,"post-reset {i}");}
}
