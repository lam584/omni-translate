use super::*;
use contract::{MediaStarted, read_speech_pcm, validate_media_complete};

fn request(root: &Path) -> ProbeRequest {
    ProbeRequest { schema_version: 2, execution_id: root.file_name().unwrap().to_string_lossy().into(),
        output_directory: root.into(), render_pcm_path: root.join("new-api.pcm"), render_pcm_sha256: "0".repeat(64),
        physical_device_id: "{0.0.0.00000000}.{12345678-1234-1234-1234-123456789abc}".into(),
        speech_simulation: Some(SpeechSimulationRequest { chunk_frames: 2400, chunk_interval_ms: 100,
            stage_duration_ms: 20_000, deadline_ms: 180_000, injector_executable: root.join("injector.exe"),
            injector_executable_sha256: "0".repeat(64), source_wav_path: root.join("english.wav"),
            source_wav_sha256: "0".repeat(64), tail_start_frame: Some(1_200_000) }) }
}
fn root() -> tempfile::TempDir { tempfile::Builder::new().prefix("local-aec-").tempdir().unwrap() }

#[test]
fn schema2_rejects_short_label_only_phases_and_changed_stream_cadence() {
    let temp = root(); let mut r = request(temp.path());
    validate_schema(&r).unwrap();
    r.speech_simulation.as_mut().unwrap().deadline_ms = 180_001;
    assert!(validate_schema(&r).is_err());
    r.speech_simulation.as_mut().unwrap().deadline_ms = 180_000;
    r.speech_simulation.as_mut().unwrap().stage_duration_ms = 800;
    assert!(validate_schema(&r).is_err());
    r.speech_simulation.as_mut().unwrap().stage_duration_ms = 20_000;
    r.speech_simulation.as_mut().unwrap().chunk_interval_ms = 20;
    assert!(validate_schema(&r).is_err());
    r.schema_version = 1;
    assert!(validate_schema(&r).is_err());
    r.speech_simulation = None; validate_schema(&r).unwrap();
    r.schema_version = 2; assert!(validate_schema(&r).is_err());
}

#[test]
fn real_speech_reader_consumes_all_pinned_pcm_and_rejects_silent_or_short_stages() {
    let temp = root(); let mut r = request(temp.path());
    let samples = vec![10_000_i16; 1_440_000];
    let bytes: Vec<_> = samples.iter().flat_map(|v| v.to_le_bytes()).collect();
    fs::write(&r.render_pcm_path,&bytes).unwrap(); r.render_pcm_sha256 = format!("{:x}",Sha256::digest(&bytes));
    assert_eq!(read_speech_pcm(&r).unwrap(),samples);
    r.render_pcm_sha256 = "0".repeat(64); assert!(read_speech_pcm(&r).is_err());
    let silence = vec![0_u8; bytes.len()]; fs::write(&r.render_pcm_path,&silence).unwrap();
    r.render_pcm_sha256 = format!("{:x}",Sha256::digest(silence)); assert!(read_speech_pcm(&r).is_err());
    let short = vec![100_u8; 4800]; fs::write(&r.render_pcm_path,&short).unwrap();
    r.render_pcm_sha256 = format!("{:x}",Sha256::digest(short)); assert!(read_speech_pcm(&r).is_err());
}

#[test]
fn injector_completion_requires_actual_receipt_hash_identity_clock_and_endpoint() {
    let temp=root(); let r=request(temp.path());
    let start=MediaStarted { execution_id:r.execution_id.clone(),physical_device_id:r.physical_device_id.clone(),process_id:1234,started_at_ms:1000 };
    let good=json!({"passed":true,"endpointId":r.physical_device_id,"processId":1234,"renderedFrames":48_000,
        "renderSampleRateHz":48000,"zeroPaddingUnderrunCount":0,"detail":null,
        "sourcePlaybackStartQpc100ns":123456789,"startedAtMs":1100,"finishedAtMs":3000});
    let check=|receipt:Value,execution:&str| {
        let bytes=serde_json::to_vec(&receipt).unwrap();
        let marker=serde_json::to_vec(&json!({"executionId":execution,"sourceMediaReceiptSha256":format!("{:x}",Sha256::digest(&bytes))})).unwrap();
        validate_media_complete(&r,&start,&marker,&bytes,4000)
    };
    check(good.clone(),&r.execution_id).unwrap();
    assert!(check(good.clone(),"vm131-forged").is_err());
    for (field,value) in [("passed",json!(false)),("endpointId",json!("other")),("processId",json!(999)),
        ("zeroPaddingUnderrunCount",json!(1)),("sourcePlaybackStartQpc100ns",Value::Null),("finishedAtMs",json!(5000))] {
        let mut bad=good.clone(); bad[field]=value; assert!(check(bad,&r.execution_id).is_err(),"{field}");
    }
    let bytes=serde_json::to_vec(&good).unwrap();
    let marker=serde_json::to_vec(&json!({"executionId":r.execution_id,"sourceMediaReceiptSha256":"0".repeat(64)})).unwrap();
    assert!(validate_media_complete(&r,&start,&marker,&bytes,4000).is_err());
}

fn quiet_route() -> AudioRouteRuntimeSnapshot {
    let mut route=AudioRouteRuntimeSnapshot::idle("audio-route-inbound-watch","inbound");
    route.stream_bound=true; route.capture_state="buffering".into(); route.last_energy_db=-90.0;
    route.last_frame_at=Some("real-capture-clock".into()); route
}
#[test]
fn quiet_drain_cannot_use_media_end_deadline_or_frozen_capture_as_completion() {
    let mut drain=drain::CaptureDrain::default(); let start=Instant::now(); let mut route=quiet_route();
    route.frames_captured=960;
    assert!(!drain.observe(start,&route,true,false).unwrap());
    assert!(!drain.observe(start,&route,true,true).unwrap());
    assert!(!drain.observe(start+Duration::from_secs(3),&route,true,true).unwrap());
    for i in 1..=110 { route.frames_captured+=960;
        let done=drain.observe(start+Duration::from_secs(3)+Duration::from_millis(i*20),&route,true,true).unwrap();
        if i<101 { assert!(!done); } else { assert!(done); }
    }
    route.stream_bound=false; assert!(drain.observe(start+Duration::from_secs(6),&route,true,true).is_err());
}
#[test]
fn quiet_drain_resets_on_capture_activity_and_missing_observation_window() {
    let mut drain=drain::CaptureDrain::default(); let start=Instant::now(); let mut route=quiet_route();
    for i in 0..100 { route.frames_captured+=960; assert!(!drain.observe(start+Duration::from_millis(i*20),&route,true,true).unwrap()); }
    route.segment_count+=1; route.frames_captured+=960;
    assert!(!drain.observe(start+Duration::from_secs(2),&route,true,true).unwrap());
    route.last_energy_db=-20.0; route.frames_captured+=960;
    assert!(!drain.observe(start+Duration::from_millis(2020),&route,true,true).unwrap());
    route.last_energy_db=-90.0; route.frames_captured+=96_000;
    assert!(!drain.observe(start+Duration::from_secs(4),&route,true,true).unwrap());
    assert!(drain.resets>=1);
}

#[test]
fn sealed_pcm_evidence_without_real_stage_events_is_not_a_pass() {
    let temp=root(); let mut evidence=evidence::StreamEvidence::new(temp.path()).unwrap();
    assert!(evidence.validate(20_000,1_440_000).is_err());
    let sealed=evidence.finish().unwrap();
    assert_eq!(sealed["physical"]["bytes"],0); assert_eq!(sealed["streamDrained"],false);
    assert!(evidence::StreamEvidence::new(temp.path()).is_err());
}
