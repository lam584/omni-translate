//! Child custody: no shell, no credential inheritance, no Provider invocation.
use super::super::*;
use super::contract::MediaStarted;
use super::media_collection::{CollectedMedia, collect_media_complete};
use std::process::{Child, Command, Stdio};
use super::owned_collection::OwnedCollection;
pub(super) use super::owned_collection::CollectionState;

const RECEIPT_FILE: &str = "local-aec-source-media-receipt.json";
const STDERR_FILE: &str = "local-aec-source-media-stderr.log";
const SOURCE_PCM_FILE: &str = "local-aec-source-media-48k-mono.f32le";

fn pinned_input(path: &Path, expected_hash: &str, limit: u64, magic: &[u8]) -> Result<fs::File, String> {
    if fs::symlink_metadata(path).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("injector input must not be a symlink".into());
    }
    let mut options = fs::OpenOptions::new(); options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        // Keep loader/decoder reads possible, but deny writes and deletion until
        // the child's real exit. Hashing and spawn refer to this pinned file.
        options.share_mode(1);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > limit { return Err("unbounded injector input".into()); }
    let bytes = read_limited(&mut file, limit)?;
    if bytes.len() as u64 != meta.len() || !bytes.starts_with(magic)
        || format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
        return Err(format!("injector input hash/format mismatch: {}",path.display()));
    }
    Ok(file)
}

/// Cleanup custody and typed source evidence are independent outcomes.
pub(super) struct JoinedSource {
    pub(super) media: Option<CollectedMedia>,
    pub(super) cleanup_error: Option<String>,
}

pub(super) struct InjectorChild {
    child: Child,
    _executable: fs::File,
    _source: fs::File,
    pub(super) start: MediaStarted,
    receipt_path: PathBuf,
    source_pcm_path: PathBuf,
    exited: bool,
    collection: OwnedCollection<CollectedMedia>,
    cleanup_failure: Option<String>,
    source_failure: Option<String>,
}
impl InjectorChild {
    pub(super) fn spawn(request: &ProbeRequest) -> Result<Self, String> {
        let sim = request.speech_simulation.as_ref().ok_or("missing speechSimulation")?;
        let executable = pinned_input(&sim.injector_executable, &sim.injector_executable_sha256, 256*1024*1024, b"MZ")?;
        let source = pinned_input(&sim.source_wav_path, &sim.source_wav_sha256, 64*1024*1024, b"RIFF")?;
        let receipt_path = request.output_directory.join(RECEIPT_FILE);
        let source_pcm_path = request.output_directory.join(SOURCE_PCM_FILE);
        let stdout = fs::OpenOptions::new().create_new(true).write(true).open(&receipt_path).map_err(|e| e.to_string())?;
        let stderr = fs::OpenOptions::new().create_new(true).write(true).open(request.output_directory.join(STDERR_FILE)).map_err(|e| e.to_string())?;
        let mut command = Command::new(&sim.injector_executable);
        command.args(["--media"]).arg(&sim.source_wav_path)
            .args(["--endpoint-id", &request.physical_device_id, "--reference-pcm48k-mono-path"])
            .arg(&source_pcm_path).current_dir(&request.output_directory)
            .stdin(Stdio::null()).stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr)).env_clear();
        // OS-only environment; never inherit Provider credentials/diagnostic
        // authorities. No CREATE_BREAKAWAY_FROM_JOB, so parent's Job owns child.
        for name in ["SystemRoot","windir","SystemDrive","ComSpec","PATH","PATHEXT","TEMP","TMP",
            "USERPROFILE","HOMEDRIVE","HOMEPATH","APPDATA","LOCALAPPDATA","PROGRAMDATA"] {
            if let Some(value) = std::env::var_os(name) { command.env(name, value); }
        }
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let started_at_ms = crate::shared::time::now_unix_millis();
        let child = command.spawn().map_err(|e| e.to_string())?;
        let start = MediaStarted { execution_id: request.execution_id.clone(), physical_device_id: request.physical_device_id.clone(),
            process_id: child.id(), started_at_ms };
        Ok(Self { child, _executable: executable, _source: source, start, receipt_path, source_pcm_path, exited: false, collection: OwnedCollection::new(), cleanup_failure: None, source_failure: None })
    }
    pub(super) fn poll_complete(&mut self, request: &ProbeRequest) -> Result<Option<CollectedMedia>, String> {
        if !self.exited {
            let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? else { return Ok(None); };
            self.exited = true;
            let request = request.clone();
            let start = self.start.clone();
            let receipt_path = self.receipt_path.clone();
            let source_pcm_path = self.source_pcm_path.clone();
            self.collection.start(move || collect_completed_media(&request, &start,
                &receipt_path, &source_pcm_path, status.code()))?;
        }
        self.collection.poll()
    }
    pub(super) fn collection_state(&self) -> CollectionState { self.collection.state() }

    /// Cleanup-only: retain unconsumed typed source evidence after abort/drain.
    /// A typed evidence rejection is returned, not relabeled as collection I/O.
    pub(super) fn stop_and_join_collected(&mut self) -> JoinedSource {
        let stopped = (|| {
            if !self.exited {
                if self.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                    self.child.kill().map_err(|e| e.to_string())?;
                    self.child.wait().map_err(|e| e.to_string())?;
                }
                self.exited = true;
            }
            Ok(())
        })();
        // Pinned handles remain owned until child and collection have stopped.
        // Even a child-stop error must not detach a pending collector.
        finish_collector(&mut self.collection, stopped, &mut self.cleanup_failure, &mut self.source_failure)
    }

    pub(super) fn stop_and_join(&mut self) -> Result<(), String> {
        let joined = self.stop_and_join_collected();
        legacy_collection_result(joined, self.source_failure.clone())
    }
}
impl Drop for InjectorChild {
    fn drop(&mut self) { let _ = self.stop_and_join(); }
}

// Resolve exactly once without modifying or discarding a typed result. Child
// and collector cleanup errors remain separate from source evidence rejection.
fn finish_collector(collection: &mut OwnedCollection<CollectedMedia>, stopped: Result<(), String>,
    retained_cleanup: &mut Option<String>, retained_source: &mut Option<String>) -> JoinedSource {
    let (media, collector_error) = match collection.finish() {
        Ok(media) => (media, None), Err(error) => (None, Some(error)),
    };
    let cleanup_error = match (stopped, collector_error) {
        (Err(child), Some(collection)) => Some(format!("{child}; source collector cleanup: {collection}")),
        (Err(child), None) => Some(child), (Ok(()), error) => error,
    };
    if let Some(error) = cleanup_error { retained_cleanup.get_or_insert(error); }
    if let Some(error) = media.as_ref().and_then(|media| media.evidence_failure.as_ref()) {
        retained_source.get_or_insert_with(|| error.clone());
    }
    JoinedSource { media, cleanup_error: retained_cleanup.clone() }
}
fn legacy_collection_result(joined: JoinedSource, retained_source: Option<String>) -> Result<(), String> {
    let evidence = joined.media.and_then(|media| media.evidence_failure).or(retained_source);
    let cleanup = joined.cleanup_error.map_or(Ok(()), Err);
    super::media_collection::finish_collection(cleanup, evidence)
}

fn collect_completed_media(request: &ProbeRequest, start: &MediaStarted, receipt_path: &Path,
    source_pcm_path: &Path, exit_code: Option<i32>) -> Result<CollectedMedia, String> {
    let bytes = read_bounded(receipt_path, MAX_REQUEST_BYTES)?;
    let marker = json!({"executionId":request.execution_id,"sourceMediaReceiptSha256":format!("{:x}",Sha256::digest(&bytes))});
    let now = crate::shared::time::now_unix_millis();
    let mut collected = collect_media_complete(request, start, &bytes, now, exit_code)?;
    let result = &mut collected.bound;
    let sim = request.speech_simulation.as_ref().ok_or("missing speechSimulation")?;
    if result["receipt"]["mediaPath"] != sim.source_wav_path.to_string_lossy().as_ref()
        || result["receipt"]["sourcePcm48kMonoPath"] != source_pcm_path.to_string_lossy().as_ref() {
        return Err("source injector receipt PCM/media path mismatch".into());
    }
    let source_pcm = read_bounded(source_pcm_path, 48_000*4*300)?;
    let source_frames = source_pcm.len() as u64 / 4;
    if source_pcm.len() % 4 != 0
        || source_pcm.chunks_exact(4).any(|bytes| { let sample=f32::from_le_bytes(bytes.try_into().unwrap()); !sample.is_finite() || sample.abs()>1.0 })
        || result["receipt"]["renderedFrames"].as_u64().zip(result["receipt"]["postrollSilenceFrames"].as_u64())
            .is_none_or(|(media,postroll)| media.checked_add(postroll)!=Some(source_frames)) {
        return Err("source injector physical PCM does not cover the full receipt span".into());
    }
    let clock_path = request.output_directory.join("aec-source-playback-clock.jsonl");
    if result["receipt"]["sourceClockMetadataPath"] != clock_path.to_string_lossy().as_ref() {
        return Err("source actual clock sidecar path mismatch".into());
    }
    let clock_bytes = read_clock_journal(&clock_path, collected.evidence_failure.is_some())?;
    let clock_validation = validate_source_clock(&clock_bytes, &result["receipt"], source_frames);
    result["sourceClockIndependentValidationPassed"] = json!(clock_validation.is_ok());
    let mut clock_rejection = None;
    let clock_end = match clock_validation {
        Ok(end) => end,
        Err(error) => {
            result["sourceClockIndependentValidationError"] = json!(error);
            clock_rejection = Some(error);
            Value::Null
        }
    };
    let raw_path = request.output_directory.join("aec-source-playback-clock-raw-diagnostic.jsonl");
    if result["receipt"]["sourceClockRawTracePath"] != raw_path.to_string_lossy().as_ref() {
        return Err("source raw clock sidecar path mismatch".into());
    }
    let raw_bytes = read_bounded(&raw_path, 32*1024*1024)?;
    let raw_end = validate_raw_clock_collection(&raw_bytes, &result["receipt"], source_frames)?;
    result["sourceClockRawMetadataPath"] = json!(raw_path);
    result["sourceClockRawSha256"] = json!(format!("{:x}",Sha256::digest(&raw_bytes)));
    result["sourceClockRawBytes"] = json!(raw_bytes.len());
    result["sourceClockPhysicalEnd"] = raw_end;
    result["sourceClockMetadataPath"] = json!(clock_path);
    result["sourceClockSha256"] = json!(format!("{:x}",Sha256::digest(&clock_bytes)));
    result["sourceClockEnd"] = clock_end;
    result["sourcePcmSha256"] = json!(format!("{:x}",Sha256::digest(&source_pcm)));
    result["sourcePcmBytes"] = json!(source_pcm.len());
    result["sourcePcmFormat"] = json!("f32le");
    result["sourcePcmSampleRateHz"] = json!(48_000);
    result["sourcePcmChannelCount"] = json!(1);
    result["sourcePcmFrames"] = json!(source_frames);
    result["sourceWavSha256"] = json!(sim.source_wav_sha256);
    result["injectorExecutableSha256"] = json!(sim.injector_executable_sha256);
    result["exitCode"] = json!(exit_code);
    result["sourceEvidenceValidationPassed"] = json!(collected.evidence_failure.is_none());
    result["sourceEvidenceValidationError"] = json!(collected.evidence_failure);
    result["passed"] = json!(collected.evidence_failure.is_none());
    result["endpointId"] = result["receipt"]["endpointId"].clone();
    result["processId"] = result["receipt"]["processId"].clone();
    result["spawnedByNative"] = json!(true);
    result["providerCalls"] = json!(0);
    if let Some(error) = clock_rejection { collected.reject_evidence(error); }
    exclusive_json(&request.output_directory.join(super::contract::COMPLETE_FILE), &marker)?;
    Ok(collected)
}

// Only a rejected-evidence collection can seal an empty accepted journal. It
// still fails the independent strict validator and never authorizes success.
fn read_clock_journal(path: &Path, allow_empty: bool) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e|e.to_string())?;
    let meta = file.metadata().map_err(|e|e.to_string())?;
    if !meta.is_file() || meta.len()>8*1024*1024 || (!allow_empty && meta.len()==0) {
        return Err("source accepted clock journal size/type invalid".into());
    }
    let bytes = read_limited(file,8*1024*1024)?;
    if bytes.len() as u64 != meta.len() { return Err("source clock journal changed during read".into()); }
    Ok(bytes)
}

// Identity/full physical endpoint validation is separate from clock alignment
// quality. A failed origin check remains failed; these raw rows only prove what
// the same native client observed while completing the unchanged source.
fn validate_raw_clock_collection(bytes: &[u8], receipt: &Value, source_frames: u64) -> Result<Value, String> {
    let text=std::str::from_utf8(bytes).map_err(|e|e.to_string())?;
    if !text.ends_with('\n') { return Err("source raw clock journal is truncated".into()); }
    let mut count=0_u64;let mut last=Value::Null;
    for line in text.lines() {
        let row:Value=serde_json::from_str(line).map_err(|e|e.to_string())?;
        if row["schemaVersion"]!=1 || row["artifactKind"]!="aec-source-playback-clock-raw-diagnostic"
            || row["scope"]!="diagnostic-only-not-c03" || row["aecQualityAcceptance"]!=false || row["releaseEligible"]!=false
            || row["sequence"]!=count || row["endpointId"]!=receipt["endpointId"] || row["processId"]!=receipt["processId"]
            || row["sampleRateHz"]!=48000 || row["submittedFrames"].as_u64().is_none_or(|n|n>source_frames) {
            return Err("source raw clock collection identity/order/ownership mismatch".into());
        }
        if row["rawClockHresult"].as_i64().is_none_or(|status|status<0)
            || !row["nativeApiError"].is_null() || !row["paddingError"].is_null()
            || !row["observationError"].is_null() {
            return Err("source raw collection contains a fatal native observation".into());
        }
        count+=1;last=row;
    }
    let frequency=last["clockFrequency"].as_u64().filter(|n|*n>0).ok_or("source raw terminal frequency missing")?;
    let position=last["clockPosition"].as_u64().ok_or("source raw terminal position missing")?;
    if count<2 || last["rawClockHresult"]!=0 || last["rawClockAccuracyAvailable"]!=true
        || last["qpc100ns"].as_u64().is_none_or(|qpc|qpc==0)
        || !last["nativeApiError"].is_null() || !last["observationError"].is_null()
        || last["paddingFrames"]!=0 || last["submittedFrames"].as_u64()!=Some(source_frames)
        || (position as u128)*48_000 < (source_frames as u128)*(frequency as u128) {
        return Err("source raw clock has not reliably crossed full PCM with zero padding".into());
    }
    Ok(json!({"recordCount":count,"terminal":last,"sourceFrames":source_frames,
        "physicalPlaybackObserved":true,"alignmentQualityAcceptance":false}))
}

/// Independently seal the injector's ACTUAL IAudioClock journal. Wall/process
/// timestamps never establish source acoustic origin or justify zero extension.
fn validate_source_clock(bytes: &[u8], receipt: &Value, source_frames: u64) -> Result<Value, String> {
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut previous_position=0_u64; let mut previous_qpc=0_u64; let mut count=0_u64;
    let mut last=Value::Null;
    for line in text.lines() {
        let clock: Value=serde_json::from_str(line).map_err(|e| e.to_string())?;
        let position=clock["clockPosition"].as_u64().ok_or("source clock position missing")?;
        let frequency=clock["clockFrequency"].as_u64().filter(|f|*f>0).ok_or("source clock frequency missing")?;
        let qpc=clock["qpc100ns"].as_u64().filter(|q|*q>0).ok_or("source clock QPC missing")?;
        let origin=receipt["sourcePlaybackStartQpc100ns"].as_u64().ok_or("source clock origin missing")?;
        let offset=(position as u128)*10_000_000/frequency as u128;
        let measured_origin=qpc.checked_sub(u64::try_from(offset).map_err(|_|"source clock overflow")?).ok_or("source clock invalid origin")?;
        if clock["schemaVersion"]!=1 || clock["artifactKind"]!="aec-source-playback-clock" || clock["sequence"]!=count
            || clock["processId"]!=receipt["processId"] || clock["endpointId"]!=receipt["endpointId"]
            || clock["sampleRateHz"]!=48000 || Some(frequency)!=receipt["sourceClockFrequency"].as_u64()
            || clock["playbackStartQpc100ns"].as_u64()!=Some(origin) || position<previous_position || qpc<previous_qpc
            || measured_origin.abs_diff(origin)>10_000 {
            return Err("source IAudioClock journal identity, order or existing 1ms drift bound failed".into());
        }
        previous_position=position; previous_qpc=qpc; count+=1; last=clock;
    }
    let frequency=receipt["sourceClockFrequency"].as_u64().filter(|f|*f>0).ok_or("source frequency missing")?;
    if count<2 || last["paddingFrames"]!=0 || last["submittedFrames"].as_u64()!=Some(source_frames)
        || (previous_position as u128)*48_000 < (source_frames as u128)*(frequency as u128) {
        return Err("source actual clock has not crossed full PCM endpoint with zero padding".into());
    }
    Ok(json!({"recordCount":count,"terminal":last,"sourceFrames":source_frames,
        "clockCrossedFullPcmEndpoint":true,"paddingFrames":0}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn injector_pin_rejects_mismatched_hash_before_spawn_and_keeps_valid_handle() {
        let root = tempfile::tempdir().unwrap(); let file = root.path().join("native.exe");
        fs::write(&file,b"MZbounded").unwrap();
        assert!(pinned_input(&file,&"0".repeat(64),32,b"MZ").is_err());
        assert!(pinned_input(&file,&format!("{:x}",Sha256::digest(b"MZbounded")),2,b"MZ").is_err());
        let pinned = pinned_input(&file,&format!("{:x}",Sha256::digest(b"MZbounded")),32,b"MZ").unwrap();
        #[cfg(windows)] assert!(fs::OpenOptions::new().write(true).open(&file).is_err());
        drop(pinned);
        assert!(fs::OpenOptions::new().write(true).open(&file).is_ok());
    }
    #[test]
    fn actual_source_clock_must_cross_full_media_endpoint_and_zero_padding() {
        let origin=1_000_000_000_u64;
        let receipt=json!({"processId":1234,"endpointId":"real-endpoint","sourceClockFrequency":48000,
            "sourcePlaybackStartQpc100ns":origin});
        let record=|sequence:u64,position:u64,padding:u64| json!({"schemaVersion":1,
            "artifactKind":"aec-source-playback-clock","sequence":sequence,"processId":1234,
            "endpointId":"real-endpoint","sampleRateHz":48000,"clockFrequency":48000,
            "clockPosition":position,"qpc100ns":origin+position*10_000_000/48000,
            "playbackStartQpc100ns":origin,"submittedFrames":48000,"paddingFrames":padding});
        let bytes=|end:Value| format!("{}\n{}\n",record(0,480,47520),end).into_bytes();
        let good=record(1,48000,0);
        assert!(validate_source_clock(&bytes(good.clone()),&receipt,48000).is_ok());
        assert!(validate_source_clock(&bytes(record(1,47999,0)),&receipt,48000).is_err());
        assert!(validate_source_clock(&bytes(record(1,48000,1)),&receipt,48000).is_err());
        let mut bad=good.clone();bad["qpc100ns"]=json!(origin+10_010_001);
        assert!(validate_source_clock(&bytes(bad),&receipt,48000).is_err());
        let mut bad=good;bad["endpointId"]=json!("different");
        assert!(validate_source_clock(&bytes(bad),&receipt,48000).is_err());
    }

    #[test]
    fn rejected_source_clock_journal_may_be_sealed_empty_but_never_accepted() {
        let dir=tempfile::tempdir().unwrap();let file=dir.path().join("clock.jsonl");fs::write(&file,b"").unwrap();
        assert!(read_clock_journal(&file,false).is_err());assert_eq!(read_clock_journal(&file,true).unwrap(),Vec::<u8>::new());
        assert!(validate_source_clock(b"",&json!({}),48000).is_err());
    }
    #[test]
    fn raw_source_end_supports_collection_only_and_rejects_false_endpoint_or_padding() {
        let receipt=json!({"endpointId":"endpoint","processId":1234});
        let record=|sequence:u64,position:u64,padding:u64|json!({"schemaVersion":1,
            "artifactKind":"aec-source-playback-clock-raw-diagnostic","scope":"diagnostic-only-not-c03",
            "aecQualityAcceptance":false,"releaseEligible":false,"sequence":sequence,"endpointId":"endpoint",
            "processId":1234,"sampleRateHz":48000,"submittedFrames":48000,"paddingFrames":padding,
            "clockFrequency":384000,"clockPosition":position,"rawClockHresult":0,"rawClockAccuracyAvailable":true,
            "nativeApiError":null,"paddingError":null,"observationError":null,"qpc100ns":100000000+position,"strictValidationFailure":"source clock origin failed"});
        let bytes=|last:Value|format!("{}\n{}\n",record(0,3840,47520),last).into_bytes();
        let good=record(1,384000,0);let end=validate_raw_clock_collection(&bytes(good.clone()),&receipt,48000).unwrap();
        assert_eq!(end["physicalPlaybackObserved"],true);assert_eq!(end["alignmentQualityAcceptance"],false);
        for (field,value) in [("clockPosition",json!(383999)),("paddingFrames",json!(1)),("endpointId",json!("other")),
            ("rawClockHresult",json!(1)),("rawClockAccuracyAvailable",json!(false)),("sequence",json!(5)),("qpc100ns",Value::Null),("qpc100ns",json!(0))] {
            let mut bad=good.clone();bad[field]=value;assert!(validate_raw_clock_collection(&bytes(bad),&receipt,48000).is_err(),"{field}");
        }
        for (field,value) in [("rawClockHresult",json!(-1)),("nativeApiError",json!("API failed")),
            ("paddingError",json!("padding failed")),("observationError",json!("QPC failed"))] {
            let mut first=record(0,3840,47520);first[field]=value;
            let contradictory=format!("{}\n{}\n",first,good).into_bytes();
            assert!(validate_raw_clock_collection(&contradictory,&receipt,48000).is_err(),"earlier {field}");
        }
    }

}

#[cfg(test)]
#[path = "injector_collection_tests.rs"] mod collection_tests;
