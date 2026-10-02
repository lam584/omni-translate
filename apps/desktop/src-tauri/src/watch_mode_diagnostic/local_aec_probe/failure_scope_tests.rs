use super::*;
use crate::audio::state::NativeCaptureStartAck;
use std::{cell::RefCell,rc::Rc,sync::mpsc};
struct FakeResource(Rc<RefCell<Vec<&'static str>>>);
impl Drop for FakeResource { fn drop(&mut self) { self.0.borrow_mut().push("resource-stop/drop"); } }
#[test]
fn readiness_and_initializer_errors_or_panics_preserve_resources_until_observation() {
    for fault in ["readiness-watchdog","open-error","open-panic"] {
        let events=Rc::new(RefCell::new(Vec::new()));
        let mut resource=None;
        let result=guarded("post-activation setup", || {
            resource=Some(FakeResource(events.clone()));
            if fault=="open-panic" { panic!("injected native open panic"); }
            Err::<(),String>(fault.into())
        });
        assert!(result.is_err());assert!(resource.is_some());assert!(events.borrow().is_empty());
        events.borrow_mut().push("failure-observation");
        drop(resource);
        assert_eq!(*events.borrow(),vec!["failure-observation","resource-stop/drop"]);
    }
    // Bind the tested retained-resource topology to the actual orchestrator.
    let source=include_str!("speech_simulation.rs");
    let retained=source.find("let mut injector_owner = None;").unwrap();
    let guard=source.find("let operation = guarded(\"speech stream\"").unwrap();
    let observe=source.find("let before_cleanup = failure_scope::observe").unwrap();
    assert!(retained<guard && guard<observe);
    let fallback=&source[observe..];
    assert!(fallback.find("failure_scope::observe").unwrap()<fallback.find("cleanup_independently").unwrap());
    assert!(fallback.find("failure_scope::observe").unwrap()<fallback.find("cleanup_independently").unwrap());
}
fn pending_snapshot() -> Value {
    let owner=NativeCaptureStartAck::new();owner.observe_native_start(Ok::<_,()>(())).unwrap();
    let route=AudioRouteRuntimeSnapshot::idle("inbound","inbound");
    drain::CaptureDrain::default().failure_observation(Instant::now,drain::FailureContext {
        route:&route,media_complete:false,stream_drained:false,expected:&owner,current:Some(&owner),
        failure:"watchdog",source_evidence_failure:None,
    })
}
#[test]
fn blocked_collection_resolves_source_rejection_after_snapshot_without_rewriting_it() {
    let (tx,rx)=mpsc::channel();
    let mut task=super::super::owned_collection::OwnedCollection::new();
    let bound=json!({"sha256":"exact-raw-hash","receipt":{"sourceClockValidationPassed":false}});
    let expected=bound.clone();
    task.start(move || {rx.recv().unwrap();Ok(media_collection::CollectedMedia {
        bound,evidence_failure:Some("source render clock origin drift exceeds frozen 1ms bound".into()),
    })}).unwrap();
    assert!(task.poll().unwrap().is_none());
    let before=pending_snapshot();
    assert_eq!(before["sourceValidationState"],"not-yet-consumed");
    assert_eq!(before["sourceEvidenceFailure"],Value::Null);
    let mut report=json!({"captureDrainFailureObservation":before.clone(),"status":"failed"});
    // Model abort then release/join, never join unfinished collector in the pump.
    tx.send(()).unwrap();
    let (cleanup,error)=retain_late_collection(&mut report,Ok(injector::JoinedSource {media:task.finish().unwrap(),cleanup_error:None}));
    cleanup.unwrap();let error=error.unwrap();
    assert!(error.contains("1ms"));
    assert_eq!(report["captureDrainFailureObservation"],before);
    assert_eq!(report["lateSourceCollection"]["bound"],expected);
    assert_eq!(report["lateSourceCollection"]["diagnosticOnly"],true);
    assert_eq!(report["lateSourceCollection"]["accepted"],false);
    assert_eq!(report["sourceEvidenceValidationPassed"],false);
    assert_eq!(report["sourceEvidenceValidationError"],error);
    assert!(task.finish().unwrap().is_none());
}
#[test]
fn late_collection_io_failure_remains_error_with_separate_provenance() {
    let before=pending_snapshot();let mut report=json!({"captureDrainFailureObservation":before.clone()});
    let (result,source)=retain_late_collection(&mut report,Err("collector IO failure".into()));
    assert!(source.is_none());
    assert_eq!(result.unwrap_err(),"collector IO failure");
    assert_eq!(report["captureDrainFailureObservation"],before);
    assert_eq!(report["lateSourceCollection"]["status"],"collector-or-child-error");
    assert_eq!(report["lateSourceCollection"]["accepted"],false);
    assert_eq!(report["lateSourceCollection"]["evidenceFailure"],Value::Null);
}
#[test]
fn absent_or_late_accepted_collection_cannot_fabricate_native_completion() {
    let mut report=json!({});let (c,s)=retain_late_collection(&mut report,Ok(injector::JoinedSource {media:None,cleanup_error:None}));c.unwrap();assert!(s.is_none());
    assert!(report.get("lateSourceCollection").is_none());
    let media=media_collection::CollectedMedia {bound:json!({"passed":true}),evidence_failure:None};
    let (c,s)=retain_late_collection(&mut report,Ok(injector::JoinedSource {media:Some(media),cleanup_error:None}));c.unwrap();assert!(s.is_none());
    assert_eq!(report["lateSourceCollection"]["accepted"],false);
    assert!(report.get("captureDrain").is_none());assert!(report.get("status").is_none());
}

#[test]
fn running_watchdog_errors_and_panics_observe_before_cleanup_mutates_native_state() {
    for fault in ["watchdog","native-error","native-panic"] {
        let owner=NativeCaptureStartAck::new();owner.observe_native_start(Ok::<_,()>(())).unwrap();
        let mut producer=owner.producer_guard();let route=AudioRouteRuntimeSnapshot::idle("inbound","inbound");
        let outcome=guarded("running loop",|| {
            if fault=="native-panic" {panic!("native error injection");} Err::<(),String>(fault.into())
        });
        let d=drain::CaptureDrain::default();
        let captured=d.failure_observation(Instant::now,drain::FailureContext {
            route:&route,media_complete:false,stream_drained:false,expected:&owner,current:Some(&owner),
            failure:outcome.as_ref().unwrap_err(),source_evidence_failure:None,
        });
        assert_eq!(captured["expectedOwner"]["terminal"],false);
        producer.finish_capture(Err("forced failure cleanup".into()),||Ok(()),||{}).unwrap_err();
        assert!(owner.health().terminal);assert_eq!(captured["expectedOwner"]["terminal"],false);
        assert_eq!(captured["accepted"],false);
    }
    let source=include_str!("speech_simulation.rs");let start=source.find("let before_cleanup = failure_scope::observe").unwrap();
    let inner=&source[start..];assert!(inner.find("stream.abort").unwrap()<inner.find("stop_and_join_collected").unwrap());
}

#[test]
fn cleanup_panics_never_resample_snapshot_or_suppress_source_join() {
    let owner=NativeCaptureStartAck::new();owner.observe_native_start(Ok::<_,()>(())).unwrap();
    let mut producer=owner.producer_guard();let route=AudioRouteRuntimeSnapshot::idle("inbound","inbound");
    let before=drain::CaptureDrain::default().failure_observation(Instant::now,drain::FailureContext {
        route:&route,media_complete:true,stream_drained:true,expected:&owner,current:Some(&owner),
        failure:"cleanup-only failure",source_evidence_failure:None,
    });
    let mut report=json!({"captureDrainFailureObservation":before.clone()});
    let called=RefCell::new(false);let bound=json!({"exact-bound":"original"});
    let (abort,joined)=cleanup_independently(|| {
        producer.finish_capture(Ok(()),||Ok(()),||{}).unwrap();
        panic!("abort cleanup panic");
    },|| {
        *called.borrow_mut()=true;
        Ok(injector::JoinedSource {media:Some(media_collection::CollectedMedia {
            bound:bound.clone(),evidence_failure:Some("source clock reject".into())}),cleanup_error:Some("child wait failed".into())})
    });
    assert!(abort.unwrap_err().contains("panicked"));assert!(*called.borrow());
    assert!(owner.health().terminal);assert_eq!(before["expectedOwner"]["terminal"],false);
    let (cleanup,source)=retain_late_collection(&mut report,joined);
    assert_eq!(cleanup.unwrap_err(),"child wait failed");assert_eq!(source.unwrap(),"source clock reject");
    assert_eq!(report["lateSourceCollection"]["bound"],bound);
    assert_eq!(report["lateSourceCollection"]["cleanupError"],"child wait failed");
    assert_eq!(report["captureDrainFailureObservation"],before);
    let (a,s)=cleanup_independently(||Ok(()),||panic!("source cleanup panic"));
    assert!(a.is_ok());assert!(s.err().unwrap().contains("panicked"));
}
#[test]
fn all_runtime_and_cleanup_errors_remain_failures() {
    assert!(combine_errors(Ok(()),Ok(()),Ok(())).is_ok());
    let error=combine_errors(Err("pump".into()),Err("abort".into()),Err("source cleanup".into())).unwrap_err();
    assert_eq!(error,"pump; abort; source cleanup");
}
