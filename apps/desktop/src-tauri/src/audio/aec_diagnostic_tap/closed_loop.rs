//! Sidecar for physical render and exact provider-input provenance. Uses the
//! same bounded admission/sealing machinery as the diagnostic PCM tap, but does
//! not change its diagnostic-only schema or claim acoustic quality itself.
use super::*;
const PHYSICAL: &str = "aec-physical-output-48k-stereo.f32le";
const PROVIDER: &str = "aec-provider-input.s16le";
const RECORDS: &str = "aec-closed-loop-metadata.jsonl";
const SEAL: &str = "aec-closed-loop-terminal.json";
// Diagnostic witnesses may retain an unavailable native observation or an
// impossible append, but can never claim formal capture/quality authority.
// Byte/clock acceptance is the strict consumer's job, not writer normalization.
fn validate_native_packet_witness(meta: &Value) -> io::Result<()> {
    let unsigned = |key: &str| meta.get(key).is_some_and(|v| v.as_u64().is_some());
    let nullable_unsigned = |key: &str| meta.get(key).is_some_and(|v| v.is_null() || v.as_u64().is_some());
    let string = |key: &str| meta.get(key).is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()));
    let flags = ["dataDiscontinuity","silent","timestampError"];
    let no_authority = ["qualityAcceptance","aecQualityAcceptance","releaseEligible","formalCaptureClockAcceptance"];
    let valid = meta["schemaVersion"] == 1 && meta["diagnosticOnly"] == true
        && no_authority.iter().all(|key| meta[*key] == false)
        && ["rawFrameCount","blockAlignBytes"].iter().all(|key| meta[*key].as_u64().is_some_and(|n| n > 0))
        && ["rawPacketDeviceFrameIndex","rawPacketQpc100ns","queuedBytesBeforeRead","queuedBytesAfterRead","resetGeneration"].iter().all(|key| unsigned(key))
        && ["rawByteCount","qpc100ns","observedQpc100ns","captureOwnerId","captureAecResetGeneration"].iter().all(|key| nullable_unsigned(key))
        && flags.iter().all(|key| meta[*key].is_boolean())
        && ["direction","requestedEndpointId"].iter().all(|key| string(key))
        && meta.get("endpointId").is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| !s.is_empty()))
        && meta["qpc100ns"] == meta["observedQpc100ns"]
        && meta["resetGenerationDomain"] == "aec-diagnostic-tap";
    if !valid {
        return Err(io::Error::new(io::ErrorKind::InvalidData,"invalid diagnostic native capture packet witness"));
    }
    Ok(())
}

#[derive(Debug)]
struct Event { physical: Option<Vec<f32>>, provider: Option<Vec<i16>>, metadata: Value }
#[derive(Debug, Default)]
pub(super) struct ClosedLoopTap { live: Option<Live> }
#[derive(Debug)]
struct Live { sender: mpsc::SyncSender<Event>, shared: Arc<Shared>, writer: Mutex<Option<JoinHandle<()>>> }
impl ClosedLoopTap {
    pub(super) fn start(directory: &Path) -> Result<Self,String> {
        let physical = EvidenceFile::new(PHYSICAL,exclusive(directory.join(PHYSICAL)).map_err(|e|e.to_string())?);
        let provider = EvidenceFile::new(PROVIDER,exclusive(directory.join(PROVIDER)).map_err(|e|e.to_string())?);
        let records = EvidenceFile::new(RECORDS,exclusive(directory.join(RECORDS)).map_err(|e|e.to_string())?);
        let terminal = exclusive(directory.join(format!("{SEAL}.partial"))).map_err(|e|e.to_string())?;
        if directory.join(SEAL).exists() { return Err("closed-loop terminal already exists".into()); }
        let (sender,receiver)=mpsc::sync_channel::<Event>(TAP_CHANNEL_CAPACITY);
        let shared=Arc::new(Shared::default()); let worker=shared.clone(); let directory=directory.to_owned();
        // Identity is frozen at tap startup, not read from a mutable environment
        // while closing or copied from the analysis manifest after the run.
        let startup_qpc_100ns=crate::audio::engine::aec_timing::qpc_now_100ns();
        let freeze_sha256=std::env::var("OMNI_WATCH_MODE_AEC_SIGNED_FREEZE_SHA256").ok();
        let identity=json!({"runMarker":std::env::var("OMNI_WATCH_MODE_MEDIA_AUTHORITY_RUN_MARKER").ok(),
            "cellId":std::env::var("OMNI_WATCH_MODE_MEDIA_AUTHORITY_CELL_ID").ok(),
            "leaseId":std::env::var("OMNI_WATCH_MODE_MEDIA_AUTHORITY_LEASE_ID").ok()});
        let writer=thread::Builder::new().name("aec-closed-loop-writer".into()).spawn(move || {
            let mut physical=physical; let mut provider=provider; let mut records=records;
            let mut errors=Vec::new(); let mut physical_samples=0u64; let mut provider_samples=0u64;
            let mut physical_events=0u64; let mut provider_events=0u64; let mut lifecycle_events=0u64;
            loop {
                let event=match receiver.recv_timeout(WRITER_POLL) {
                    Ok(event)=>event,
                    Err(mpsc::RecvTimeoutError::Timeout) if worker.quiescent()=>match receiver.try_recv() {
                        Ok(event)=>event, Err(mpsc::TryRecvError::Empty)=>break,
                        Err(mpsc::TryRecvError::Disconnected)=>break,
                    },
                    Err(mpsc::RecvTimeoutError::Timeout)=>continue,
                    Err(mpsc::RecvTimeoutError::Disconnected)=>{worker.fail("closed-loop channel disconnected".into());break;}
                };
                let mut meta=event.metadata;
                let result=(|| -> io::Result<()> {
                    if meta["kind"] == "native-capture-packet" { validate_native_packet_witness(&meta)?; }
                    meta["schemaVersion"]=json!(1);
                    meta["sequence"]=json!(worker.written_events.load(Ordering::Acquire));
                    if let Some(samples)=event.physical {
                        if samples.is_empty() || samples.len()%2!=0 || samples.iter().any(|v|!v.is_finite() || v.abs()>1.0) {
                            return Err(io::Error::new(io::ErrorKind::InvalidData,"invalid physical f32 PCM"));
                        }
                        meta["kind"]=json!("physical-output"); meta["sampleOffset"]=json!(physical_samples);
                        meta["sampleCount"]=json!(samples.len()); meta["sampleRateHz"]=json!(48000); meta["channelCount"]=json!(2);
                        write_f32(&mut physical.writer,&samples)?; physical_samples+=samples.len() as u64; physical_events+=1;
                    } else if let Some(samples)=event.provider {
                        if samples.is_empty() { return Err(io::Error::new(io::ErrorKind::InvalidData,"empty provider input")); }
                        meta["kind"]=json!("provider-input"); meta["sampleOffset"]=json!(provider_samples);
                        meta["sampleCount"]=json!(samples.len()); meta["channelCount"]=json!(1);
                        let bytes:Vec<_>=samples.iter().flat_map(|v|v.to_le_bytes()).collect();
                        meta["sha256"]=json!(format!("{:x}",Sha256::digest(&bytes)));
                        provider.writer.write_all(&bytes)?; provider_samples+=samples.len() as u64; provider_events+=1;
                    } else {
                        if !matches!(meta["kind"].as_str(),Some("render-lifecycle"|"stage-lifecycle"|"provider-lifecycle"|"native-capture-packet")) {
                            return Err(io::Error::new(io::ErrorKind::InvalidData,"unknown closed-loop lifecycle event"));
                        }
                        lifecycle_events+=1;
                    }
                    serde_json::to_writer(&mut records.writer,&meta)?; records.writer.write_all(b"\n")?; Ok(())
                })();
                if let Err(e)=result { worker.fail(e.to_string());errors.push(e.to_string()); }
                else {worker.written_events.fetch_add(1,Ordering::Release);}
            }
            if let Some(error)=worker.failure.get() {errors.push(error.clone());}
            if worker.dropped_events.load(Ordering::Acquire)>0 {errors.push("closed-loop events dropped".into());}
            if worker.sequence.load(Ordering::Acquire)!=worker.written_events.load(Ordering::Acquire) {
                errors.push("closed-loop event accounting mismatch".into());
            }
            let files=json!({"physical":physical.finish(&mut errors),"provider":provider.finish(&mut errors),"metadata":records.finish(&mut errors)});
            let mut value=json!({"schemaVersion":1,"kind":"aec-closed-loop-terminal","identity":identity,
                "complete":errors.is_empty(),"errors":errors,"files":files,"countsFinal":true,
                "startupQpc100ns":startup_qpc_100ns,"thresholdFreezeSha256":freeze_sha256,
                "physicalSamples":physical_samples,"providerSamples":provider_samples,
                "physicalEvents":physical_events,"providerEvents":provider_events,"lifecycleEvents":lifecycle_events,
                "attemptedEvents":worker.sequence.load(Ordering::Acquire),
                "acceptedEvents":worker.accepted_events.load(Ordering::Acquire),
                "writtenEvents":worker.written_events.load(Ordering::Acquire),
                "droppedEvents":worker.dropped_events.load(Ordering::Acquire)});
            let result=(|| -> io::Result<()> { let mut terminal=terminal; serde_json::to_writer(&mut terminal,&value)?;
                terminal.write_all(b"\n")?;terminal.flush()?;terminal.sync_all()?;drop(terminal);
                if directory.join(SEAL).exists(){return Err(io::Error::new(io::ErrorKind::AlreadyExists,"closed-loop terminal already exists"));}
                std::fs::rename(directory.join(format!("{SEAL}.partial")),directory.join(SEAL)) })();
            if let Err(e)=result {value["complete"]=json!(false);value["errors"].as_array_mut().unwrap().push(json!(e.to_string()));}
            let _=worker.outcome.set(value);
        }).map_err(|e|e.to_string())?;
        Ok(Self{live:Some(Live{sender,shared,writer:Mutex::new(Some(writer))})})
    }
    pub(super) fn record(&self,physical:Option<&[f32]>,provider:Option<&[i16]>,metadata:Value) {
        let Some(live)=&self.live else{return;}; let Some(_admission)=live.shared.admit() else{return;};
        live.shared.sequence.fetch_add(1,Ordering::Relaxed);
        match live.sender.try_send(Event{physical:physical.map(<[f32]>::to_vec),provider:provider.map(<[i16]>::to_vec),metadata}) {
            Ok(())=>{live.shared.accepted_events.fetch_add(1,Ordering::Relaxed);},
            Err(e)=>{live.shared.dropped_events.fetch_add(1,Ordering::Relaxed);live.shared.fail(e.to_string());}
        }
    }
    pub(super) fn close(&self) {if let Some(live)=&self.live{live.shared.close();}}
    pub(super) fn abort(&self,reason:&str) {if let Some(live)=&self.live{if let Some(_admission)=live.shared.admit(){live.shared.fail(reason.into());}}}
    pub(super) fn finish(&self,timeout:Duration)->Result<Value,String> {
        let Some(live)=&self.live else{return Ok(json!({"complete":false,"status":"disabled"}));};
        self.close();let started=Instant::now();loop {
            if let Some(value)=live.shared.outcome.get(){return if value["complete"]==true{Ok(value.clone())}else{Err(value.to_string())};}
            if started.elapsed()>=timeout{return Err("closed-loop finish timed out".into());}thread::sleep(Duration::from_millis(1));
        }
    }
}
impl Drop for ClosedLoopTap {
    fn drop(&mut self) {if let Some(live)=&self.live {
        if live.shared.admission.load(Ordering::Acquire)&CLOSED==0{live.shared.fail("closed-loop dropped without finish".into());}
        if let Ok(mut writer)=live.writer.try_lock(){if writer.as_ref().is_some_and(JoinHandle::is_finished){if let Some(writer)=writer.take(){let _=writer.join();}}}
    }}
}

#[cfg(test)]
#[path = "closed_loop_packet_tests.rs"]
mod packet_witness_tests;
