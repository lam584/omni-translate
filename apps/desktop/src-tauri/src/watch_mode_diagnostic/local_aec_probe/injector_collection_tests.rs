use super::*;

fn fixture() -> (tempfile::TempDir, ProbeRequest, MediaStarted, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let pcm = root.path().join(SOURCE_PCM_FILE);
    let receipt_path = root.path().join(RECEIPT_FILE);
    let clock = root.path().join("aec-source-playback-clock.jsonl");
    let raw = root.path().join("aec-source-playback-clock-raw-diagnostic.jsonl");
    let request: ProbeRequest = serde_json::from_value(json!({"schemaVersion":2,
        "executionId":"local-aec-12345678-1234-1234-1234-123456789abc","outputDirectory":root.path(),
        "renderPcmPath":root.path().join("render"),"renderPcmSha256":"hash","physicalDeviceId":"endpoint",
        "speechSimulation":{"chunkFrames":2400,"chunkIntervalMs":100,"stageDurationMs":40000,"deadlineMs":180000,
            "injectorExecutable":root.path().join("injector.exe"),"injectorExecutableSha256":"a".repeat(64),
            "sourceWavPath":root.path().join("source.wav"),"sourceWavSha256":"b".repeat(64)}})).unwrap();
    let start = MediaStarted { execution_id:request.execution_id.clone(), physical_device_id:"endpoint".into(),
        process_id:1234, started_at_ms:1000 };
    let receipt = json!({"passed":true,"endpointId":"endpoint","processId":1234,"renderedFrames":48000,
        "postrollSilenceFrames":0,"renderSampleRateHz":48000,"zeroPaddingUnderrunCount":0,"detail":null,
        "sourcePlaybackStartQpc100ns":1000000000,"sourceClockFrequency":48000,"startedAtMs":1100,"finishedAtMs":3000,
        "mediaPlaybackComplete":true,"naturalRenderDrained":true,"diagnosticOnly":false,
        "sourceClockValidationPassed":true,"sourceClockValidationError":null,
        "mediaPath":request.speech_simulation.as_ref().unwrap().source_wav_path,
        "sourcePcm48kMonoPath":pcm,"sourceClockMetadataPath":clock,"sourceClockRawTracePath":raw});
    fs::write(&receipt_path,serde_json::to_vec(&receipt).unwrap()).unwrap();
    fs::write(&pcm,0.25_f32.to_le_bytes().repeat(48000)).unwrap();
    let accepted = |sequence:u64, position:u64, padding:u64| json!({"schemaVersion":1,
        "artifactKind":"aec-source-playback-clock","sequence":sequence,"processId":1234,"endpointId":"endpoint",
        "sampleRateHz":48000,"clockFrequency":48000,"clockPosition":position,
        "qpc100ns":1000000000+position*10000000/48000,"playbackStartQpc100ns":1000000000,
        "submittedFrames":48000,"paddingFrames":padding});
    fs::write(&clock,format!("{}\n{}\n",accepted(0,480,47520),accepted(1,48000,0))).unwrap();
    let observed = |sequence:u64, position:u64, padding:u64| json!({"schemaVersion":1,
        "artifactKind":"aec-source-playback-clock-raw-diagnostic","scope":"diagnostic-only-not-c03",
        "aecQualityAcceptance":false,"releaseEligible":false,"sequence":sequence,"processId":1234,"endpointId":"endpoint",
        "sampleRateHz":48000,"clockFrequency":48000,"clockPosition":position,"qpc100ns":1000000000+position,
        "submittedFrames":48000,"paddingFrames":padding,"rawClockHresult":0,"rawClockAccuracyAvailable":true,
        "nativeApiError":null,"paddingError":null,"observationError":null});
    fs::write(raw,format!("{}\n{}\n",observed(0,480,47520),observed(1,48000,0))).unwrap();
    (root, request, start, receipt_path, pcm)
}

#[test]
fn off_thread_collector_preserves_exact_identity_pcm_and_clock_seals() {
    let (root, request, start, receipt, pcm) = fixture();
    let expected_pcm_hash = format!("{:x}",Sha256::digest(fs::read(&pcm).unwrap()));
    let marker = root.path().join(super::super::contract::COMPLETE_FILE);
    let mut task = OwnedCollection::new();
    task.start(move || collect_completed_media(&request,&start,&receipt,&pcm,Some(0))).unwrap();
    let deadline = Instant::now()+Duration::from_secs(3);
    let collected = loop {
        if let Some(value) = task.poll().unwrap() { break value; }
        assert!(Instant::now()<deadline);
        std::thread::sleep(Duration::from_millis(1));
    };
    assert!(collected.evidence_failure.is_none());
    assert_eq!(collected.bound["sourcePcmSha256"],expected_pcm_hash);
    assert_eq!(collected.bound["sourcePcmFrames"],48000);
    assert_eq!(collected.bound["sourceClockIndependentValidationPassed"],true);
    assert_eq!(collected.bound["sourceClockPhysicalEnd"]["alignmentQualityAcceptance"],false);
    assert!(marker.is_file());
    assert!(task.poll().unwrap().is_none());
    assert!(task.finish().unwrap().is_none());
}

#[test]
fn failed_source_custody_never_writes_media_complete_marker() {
    for fault in ["identity", "truncated-pcm", "invalid-pcm", "pcm-path", "raw-clock", "missing-receipt"] {
        let (root,request,start,receipt_path,pcm) = fixture();
        match fault {
            "identity" | "pcm-path" => {
                let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
                if fault=="identity" { receipt["processId"]=json!(99); }
                else { receipt["sourcePcm48kMonoPath"]=json!("unowned-pcm"); }
                fs::write(&receipt_path,serde_json::to_vec(&receipt).unwrap()).unwrap();
            }
            "truncated-pcm" => { fs::write(&pcm,[0_u8;3]).unwrap(); }
            "invalid-pcm" => { fs::write(&pcm,f32::NAN.to_le_bytes().repeat(48000)).unwrap(); }
            "raw-clock" => { fs::write(root.path().join("aec-source-playback-clock-raw-diagnostic.jsonl"),b"{}\n").unwrap(); }
            "missing-receipt" => { fs::remove_file(&receipt_path).unwrap(); }
            _ => unreachable!(),
        }
        assert!(collect_completed_media(&request,&start,&receipt_path,&pcm,Some(0)).is_err(),"{fault}");
        assert!(!root.path().join(super::super::contract::COMPLETE_FILE).exists(),"{fault}");
    }
}

#[test]
fn rejected_alignment_can_finish_collection_but_never_becomes_success() {
    let (root,request,start,receipt_path,pcm) = fixture();
    let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    receipt["passed"]=json!(false); receipt["sourceClockValidationPassed"]=json!(false);
    receipt["sourceClockValidationError"]=json!("native clock origin rejected");
    receipt["detail"]=receipt["sourceClockValidationError"].clone();
    fs::write(&receipt_path,serde_json::to_vec(&receipt).unwrap()).unwrap();
    fs::write(root.path().join("aec-source-playback-clock.jsonl"),b"").unwrap();
    let collected = collect_completed_media(&request,&start,&receipt_path,&pcm,Some(1)).unwrap();
    assert_eq!(collected.bound["passed"],false);
    assert_eq!(collected.bound["sourceClockIndependentValidationPassed"],false);
    assert_eq!(collected.evidence_failure.as_deref(),Some("native clock origin rejected"));
    assert!(super::super::media_collection::finish_collection(Ok(()),collected.evidence_failure).is_err());
    assert!(root.path().join(super::super::contract::COMPLETE_FILE).is_file());
}

#[test]
fn abort_cleanup_retains_unconsumed_typed_alignment_failure() {
    let (_root,request,start,receipt_path,pcm) = fixture();
    let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    receipt["passed"]=json!(false); receipt["sourceClockValidationPassed"]=json!(false);
    receipt["sourceClockValidationError"]=json!("clock failure while pump aborted");
    receipt["detail"]=receipt["sourceClockValidationError"].clone();
    fs::write(&receipt_path,serde_json::to_vec(&receipt).unwrap()).unwrap();
    let mut task = OwnedCollection::new();
    task.start(move || collect_completed_media(&request,&start,&receipt_path,&pcm,Some(1))).unwrap();
    // Never poll/consume: this is the deadline/abort cleanup-only path.
    let mut failure = None; let mut source_failure = None;
    let joined = finish_collector(&mut task, Ok(()), &mut failure, &mut source_failure);
    assert!(legacy_collection_result(joined, source_failure.clone())
        .unwrap_err().contains("clock failure while pump aborted"));
    assert!(failure.is_none());
    assert!(source_failure.unwrap().contains("clock failure while pump aborted"));
    assert!(task.poll().unwrap().is_none());
}

#[test]
fn watchdog_snapshot_does_not_wait_for_late_rejected_source_collection() {
    use std::sync::mpsc;
    use crate::audio::state::NativeCaptureStartAck;
    use super::super::drain::{CaptureDrain, FailureContext};

    let (_root, request, start, receipt_path, pcm) = fixture();
    let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    receipt["passed"] = json!(false); receipt["sourceClockValidationPassed"] = json!(false);
    receipt["sourceClockValidationError"] = json!("clock rejected after watchdog snapshot");
    receipt["detail"] = receipt["sourceClockValidationError"].clone();
    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let pcm_hash = format!("{:x}", Sha256::digest(fs::read(&pcm).unwrap()));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let mut task = OwnedCollection::new();
    task.start(move || {
        started_tx.send(()).unwrap(); release_rx.recv().unwrap();
        collect_completed_media(&request, &start, &receipt_path, &pcm, Some(1))
    }).unwrap();
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let state_before_cleanup = task.state();
    assert_eq!(state_before_cleanup, CollectionState::Pending);
    assert!(task.poll().unwrap().is_none());

    // Snapshot before abort while the collector is deliberately unresolved.
    let owner = NativeCaptureStartAck::new();
    owner.observe_native_start(Ok::<_, ()>(())).unwrap();
    let mut producer = owner.producer_guard();
    let mut route = AudioRouteRuntimeSnapshot::idle("audio-route-inbound-watch", "inbound");
    route.stream_bound = true; route.capture_state = "buffering".into();
    let drain = CaptureDrain::default();
    let native = drain.failure_observation(Instant::now, FailureContext {
        route: &route, media_complete: false, stream_drained: false,
        expected: &owner, current: Some(&owner), failure: "watchdog deadline exceeded",
        source_evidence_failure: None,
    });
    let sealed_native = serde_json::to_vec(&native).unwrap();
    assert_eq!(native["mediaComplete"], false);
    assert_eq!(native["sourceEvidenceFailure"], Value::Null);
    assert_eq!(native["sourceValidationState"], "not-yet-consumed");
    assert_eq!(native["expectedOwner"]["terminal"], false);

    // Fake the subsequent native abort, then let the source collector resolve.
    producer.stopping(); producer.finish(&Ok(()));
    release_tx.send(()).unwrap();
    let mut sticky = None; let mut source_failure = None;
    let joined = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
    assert!(joined.cleanup_error.is_none());
    let late = joined.media.unwrap();
    assert_eq!(late.bound["receipt"], receipt);
    assert_eq!(late.bound["exitCode"], 1);
    assert_eq!(late.bound["passed"], false);
    assert_eq!(late.bound["mediaPlaybackComplete"], true);
    assert_eq!(late.bound["sourcePcmSha256"], pcm_hash);
    assert_eq!(late.evidence_failure.as_deref(), Some("clock rejected after watchdog snapshot"));
    assert_eq!(task.state(), CollectionState::Consumed);
    assert_eq!(serde_json::to_vec(&native).unwrap(), sealed_native);
    assert_eq!(native["expectedOwner"]["terminal"], false);
    assert!(owner.health().terminal);
    assert_eq!(state_before_cleanup, CollectionState::Pending);
    let expected_bound = late.bound.clone();
    let mut report = json!({"captureDrainFailureObservation":native,
        "sourceCollectionStateBeforeCleanup":state_before_cleanup});
    let (cleanup, retained) = super::super::failure_scope::retain_late_collection(&mut report,
        Ok(JoinedSource { media: Some(late), cleanup_error: None }));
    assert!(cleanup.is_ok());
    assert_eq!(retained.as_deref(), Some("clock rejected after watchdog snapshot"));
    assert_eq!(report["lateSourceCollection"]["bound"], expected_bound);
    assert_eq!(report["lateSourceCollection"]["status"], "resolved-during-cleanup");
    assert_eq!(report["lateSourceCollection"]["diagnosticOnly"], true);
    assert_eq!(report["lateSourceCollection"]["accepted"], false);
    assert_eq!(report["sourceEvidenceValidationPassed"], false);
    assert_eq!(report["sourceEvidenceValidationError"], "clock rejected after watchdog snapshot");
    assert_eq!(report["sourceCollectionStateBeforeCleanup"], "pending");
    assert_eq!(serde_json::to_vec(&report["captureDrainFailureObservation"]).unwrap(), sealed_native);
    assert_eq!(report["captureDrainFailureObservation"]["sourceValidationState"], "not-yet-consumed");
    // Drop/legacy cleanup must not turn an already-returned typed rejection green.
    let joined = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
    assert!(joined.media.is_none()); assert!(joined.cleanup_error.is_none());
    let repeated = legacy_collection_result(joined, source_failure.clone());
    assert!(repeated.unwrap_err().contains("clock rejected after watchdog snapshot"));
}

#[test]
fn typed_late_collection_returns_exact_evidence_once_and_legacy_adapter_rejects() {
    let bound = json!({"passed":false,"exitCode":1,"receipt":{"rawClockHresult":1},
        "sourceEvidenceValidationPassed":false,"sourceEvidenceValidationError":"typed source reject"});
    let expected = bound.clone();
    let mut task = OwnedCollection::new();
    task.start(move || Ok(CollectedMedia { bound, evidence_failure: Some("typed source reject".into()) })).unwrap();
    let mut sticky = None; let mut source_failure = None;
    let joined = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
    let collected = joined.media.as_ref().unwrap();
    assert_eq!(collected.bound, expected);
    assert_eq!(collected.evidence_failure.as_deref(), Some("typed source reject"));
    assert!(joined.cleanup_error.is_none());
    assert_eq!(task.state(), CollectionState::Consumed);
    assert!(task.poll().unwrap().is_none());
    assert!(legacy_collection_result(joined, source_failure.clone()).unwrap_err().contains("typed source reject"));
    for _ in 0..2 {
        let joined = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
        assert!(joined.media.is_none()); assert!(joined.cleanup_error.is_none());
        assert!(legacy_collection_result(joined, source_failure.clone()).unwrap_err().contains("typed source reject"));
    }
}

#[test]
fn healthy_typed_late_collection_is_one_shot_but_does_not_invent_a_source_result() {
    let bound = json!({"passed":true,"exitCode":0,"receipt":{"native":"unchanged"}});
    let expected = bound.clone();
    let mut task = OwnedCollection::new();
    let mut sticky = None; let mut source_failure = None;
    let before = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
    assert!(before.media.is_none()); assert!(before.cleanup_error.is_none());
    assert_eq!(task.state(), CollectionState::NotStarted);
    task.start(move || Ok(CollectedMedia { bound, evidence_failure: None })).unwrap();
    let joined = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
    assert_eq!(joined.media.as_ref().unwrap().bound, expected);
    assert!(legacy_collection_result(joined, source_failure.clone()).is_ok());
    let repeated = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
    assert!(repeated.media.is_none()); assert!(repeated.cleanup_error.is_none());
    assert!(sticky.is_none()); assert!(source_failure.is_none());
    assert_eq!(task.state(), CollectionState::Consumed);
}

#[test]
fn typed_cleanup_collection_io_and_panic_errors_stay_failed_and_sticky() {
    for panic in [false, true] {
        let mut task: OwnedCollection<CollectedMedia> = OwnedCollection::new();
        task.start(move || {
            if panic { panic!("collector failed after abort"); }
            Err("cleanup collection I/O failed".into())
        }).unwrap();
        let mut sticky = None; let mut source_failure = None;
        let joined = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
        assert!(joined.media.is_none());
        let error = joined.cleanup_error.unwrap();
        assert!(error.contains(if panic { "worker panicked" } else { "collection I/O failed" }));
        assert_eq!(task.state(), CollectionState::Failed);
        assert_eq!(task.poll().err().unwrap(), error);
        let repeated = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
        assert_eq!(repeated.cleanup_error.as_deref(), Some(error.as_str()));
        assert_eq!(legacy_collection_result(repeated, source_failure.clone()).unwrap_err(), error);
        assert!(source_failure.is_none());
    }
}

#[test]
fn child_cleanup_failure_retains_exact_typed_rejection_and_independent_cleanup_error() {
    use std::sync::mpsc;
    for typed_rejection in [false, true] {
        let bound = json!({"passed":false,"exitCode":1,"receipt":{"rawClockHresult":1},
            "sourceEvidenceValidationError":"late clock reject"});
        let expected_bound = bound.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (resolved_tx, resolved_rx) = mpsc::channel();
        let mut task = OwnedCollection::new();
        task.start(move || {
            started_tx.send(()).unwrap(); release_rx.recv().unwrap();
            if typed_rejection {
                Ok(CollectedMedia { bound, evidence_failure: Some("late clock reject".into()) })
            } else { Err("collector disk read failed".into()) }
        }).unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let cleanup = std::thread::spawn(move || {
            let mut sticky = None; let mut source_failure = None;
            let joined = finish_collector(&mut task, Err("child wait failed".into()), &mut sticky, &mut source_failure);
            resolved_tx.send(joined).unwrap_or_else(|_| panic!("cleanup receiver dropped"));
            (task, sticky, source_failure)
        });
        assert!(resolved_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        let joined = resolved_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(joined.cleanup_error.as_ref().unwrap().contains("child wait failed"));
        if typed_rejection {
            let media = joined.media.as_ref().unwrap();
            assert_eq!(media.bound, expected_bound);
            assert_eq!(media.evidence_failure.as_deref(), Some("late clock reject"));
            assert_eq!(joined.cleanup_error.as_deref(), Some("child wait failed"));
            assert!(!joined.cleanup_error.as_ref().unwrap().contains("late clock reject"));
        } else {
            assert!(joined.media.is_none());
            assert!(joined.cleanup_error.as_ref().unwrap().contains("collector disk read failed"));
        }
        let (mut task, mut sticky, mut source_failure) = cleanup.join().unwrap();
        let error = legacy_collection_result(joined, source_failure.clone()).unwrap_err();
        assert!(error.contains("child wait failed"));
        assert!(error.contains(if typed_rejection { "late clock reject" } else { "collector disk read failed" }));
        let repeated = finish_collector(&mut task, Ok(()), &mut sticky, &mut source_failure);
        assert!(repeated.media.is_none());
        assert_eq!(legacy_collection_result(repeated, source_failure.clone()).unwrap_err(), error);
    }
}
