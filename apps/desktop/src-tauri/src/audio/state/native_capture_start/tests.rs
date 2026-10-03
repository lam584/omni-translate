use super::*;
use super::super::NativeCaptureStartAck;

#[test]
fn native_capture_health_only_successful_shared_zero_is_empty() {
    assert_eq!(NativeCaptureQuery::from_packet_size(Some(0)), NativeCaptureQuery::Empty);
    assert_eq!(NativeCaptureQuery::from_packet_size(None), NativeCaptureQuery::Unavailable);
    assert_eq!(NativeCaptureQuery::from_packet_size(Some(480)), NativeCaptureQuery::Pending(480));
}
#[test]
fn native_capture_health_start_is_not_capture_or_liveness() {
    let owner = NativeCaptureStartAck::new();
    owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    owner.publish_query(Instant::now(), NativeCaptureQuery::Empty, NativeCaptureWork::default());
    let s = owner.health();
    assert!(s.started);
    assert_eq!(s.captured_frames, 0);
    assert!(s.empty_since.is_none());
    assert!(s.latest_packet.is_none());
}
#[test]
fn native_capture_health_terminal_fault_and_drop_cannot_be_revived() {
    for fail in [false, true] {
        let owner = NativeCaptureStartAck::new();
        owner.observe_native_start(Ok::<_, ()>(())).unwrap();
        let mut producer = owner.producer_guard();
        let result = if fail { Err("query failure".into()) } else { Ok(()) };
        producer.finish(&result);
        owner.observe_native_start(Ok::<_, ()>(())).unwrap();
        owner.publish_query(Instant::now(), NativeCaptureQuery::Empty, NativeCaptureWork::default());
        assert!(owner.health().terminal);
        assert_eq!(owner.health().successful_queries, 0);
        assert_eq!(owner.health().fault.is_some(), fail);
    }
    let owner = NativeCaptureStartAck::new();
    owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    drop(owner.producer_guard());
    assert!(owner.health().terminal);
    assert!(owner.health().fault.is_some());
}
#[test]
fn native_capture_health_empty_never_changes_packet_clocks_or_work_counters() {
    let owner = NativeCaptureStartAck::new();
    owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    let start = Instant::now();
    owner.publish_query(start, NativeCaptureQuery::Empty, NativeCaptureWork {
        packet: Some(NativeCapturePacket { frames:480,device_frame_index:900,qpc_100ns:123,
            silent:false,data_discontinuity:false,timestamp_error:false,raw_energy_db:-12.0 }),
        aec_completed_frames:480,dispatch_completed_frames:480,residual_bytes:0 });
    for i in 1..=100 {
        owner.publish_query(start + Duration::from_millis(i * 20), NativeCaptureQuery::Empty, NativeCaptureWork::default());
    }
    let s=owner.health();
    assert_eq!((s.captured_frames,s.aec_completed_frames,s.dispatch_completed_frames),(480,480,480));
    assert_eq!(s.latest_packet.as_ref().unwrap().qpc_100ns,123);
    assert_eq!(s.raw_activity_generation,1);
}

#[test]
fn native_capture_health_mutex_poison_is_sticky_and_new_empty_cannot_revive_it() {
    let owner=NativeCaptureStartAck::new();owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    let producer=owner.clone();
    assert!(std::thread::spawn(move || {
        let _held=producer.0.lock().unwrap();panic!("offline synthetic lock poison");
    }).join().is_err());
    assert!(owner.health().terminal);
    assert_eq!(owner.health().fault.as_deref(),Some("native capture health lock poisoned"));
    owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    owner.publish_query(Instant::now(),NativeCaptureQuery::Empty,NativeCaptureWork::default());
    assert!(owner.health().terminal);
    assert_eq!(owner.health().successful_queries,0);
}

#[test]
fn native_capture_health_pre_aec_chunk_activity_cannot_be_hidden_by_packet_average() {
    let owner=NativeCaptureStartAck::new();owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    let producer=owner.producer_guard();producer.begin_work(0);
    producer.record_raw_activity(-12.0);
    let s=owner.health();assert_eq!(s.raw_activity_generation,1);
    assert!(s.last_raw_activity_at.is_some());assert!(s.empty_since.is_none());
    assert!(s.work_pending);assert_eq!(s.successful_queries,0);
    producer.record_raw_activity(-90.0);
    assert_eq!(owner.health().raw_activity_generation,1);
}

#[test]
fn native_capture_guard_diagnostic_identity_is_actual_owner_and_read_only_reset_domain() {
    let ack=NativeCaptureStartAck::new();
    let other=NativeCaptureStartAck::new();
    let guard=ack.producer_guard();
    let before=ack.health();
    assert_eq!(guard.diagnostic_owner_identity(),(before.owner_id,before.aec_reset_generation));
    assert_ne!(guard.diagnostic_owner_identity().0,other.health().owner_id);
    for _ in 0..100 { assert_eq!(guard.diagnostic_owner_identity(),(before.owner_id,0)); }
    let after=ack.health();
    assert_eq!((after.successful_queries,after.progress_epoch,after.aec_reset_generation),
        (before.successful_queries,before.progress_epoch,before.aec_reset_generation));
    ack.observe_native_start(Ok::<_, ()>(())).unwrap();
    guard.record_aec_reset();
    assert_eq!(guard.diagnostic_owner_identity(),(before.owner_id,1));
    assert_eq!(ack.health().aec_reset_generation,1);
    guard.stopping();
    guard.record_aec_reset();
    assert_eq!(guard.diagnostic_owner_identity(),(before.owner_id,1));
}
