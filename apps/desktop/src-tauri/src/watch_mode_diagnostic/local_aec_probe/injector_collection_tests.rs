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
    assert!(finish_collector(&mut task).unwrap_err().contains("clock failure while pump aborted"));
    assert!(task.poll().unwrap().is_none());
}
