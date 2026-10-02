use super::super::*;
use crate::audio::speech::{DesktopStreamTap, DesktopStreamActivity};
use super::async_evidence_writer::AsyncEvidenceWriter;

struct PcmEvidence {
    path: PathBuf,
    writer: AsyncEvidenceWriter,
    hash: Sha256,
    samples: u64,
}
impl PcmEvidence {
    fn new(path: PathBuf) -> Result<Self, String> {
        let writer = AsyncEvidenceWriter::new(path.clone())?;
        Ok(Self { path, writer, hash: Sha256::new(), samples: 0 })
    }
    fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.len() % 2 != 0 || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0) {
            return Err("device evidence contains invalid stereo f32 PCM".into());
        }
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.hash.update(&bytes);
        self.writer.write(bytes)?; self.samples += samples.len() as u64; Ok(())
    }
    fn finish(&mut self) -> Result<Value, String> {
        let seal = self.writer.finish()?;
        if seal.written_bytes != self.samples*4 || seal.sha256 != format!("{:x}",self.hash.clone().finalize())
            || !seal.flushed || !seal.synced { return Err("async PCM evidence seal differs from accepted producer bytes".into()); }
        Ok(json!({"path":self.path,"sha256":format!("{:x}",self.hash.clone().finalize()),
            "sampleCount":self.samples,"frameCount":self.samples/2,"bytes":self.samples*4,
            "sampleRateHz":48000,"channelCount":2,"format":"f32le","flushed":true,"synced":true}))
    }
}

pub(super) struct StreamEvidence {
    physical: PcmEvidence,
    reference: PcmEvidence,
    records: AsyncEvidenceWriter,
    records_path: PathBuf,
    records_hash: Sha256,
    record_count: u64,
    record_bytes: u64,
    pub(super) stages: Vec<Value>,
    pub(super) late_voiced_frames: u64,
    pub(super) stream_starts: u32,
    pub(super) completed: bool,
    pub(super) aborted: bool,
    session_id: Option<u64>,
}
impl StreamEvidence {
    pub(super) fn new(output: &Path) -> Result<Self, String> {
        let records_path = output.join("local-aec-stream-events.jsonl");
        let records = AsyncEvidenceWriter::new(records_path.clone())?;
        Ok(Self { physical: PcmEvidence::new(output.join("local-aec-physical-48k-stereo.f32le"))?,
            reference: PcmEvidence::new(output.join("local-aec-linear-reference-48k-stereo.f32le"))?,
            records, records_path, records_hash: Sha256::new(), record_count: 0, record_bytes: 0,
            stages: Vec::new(), late_voiced_frames: 0, stream_starts: 0, completed: false, aborted: false, session_id: None })
    }
    pub(super) fn record(&mut self, mut value: Value) -> Result<(), String> {
        value["sequence"] = json!(self.record_count);
        value["observedAtMs"] = json!(crate::shared::time::now_unix_millis());
        value["scope"] = json!("local-aec-speech-simulation");
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?; bytes.push(b'\n');
        self.records_hash.update(&bytes);
        let byte_count = bytes.len() as u64; self.records.write(bytes)?;
        self.record_bytes += byte_count; self.record_count += 1; Ok(())
    }
    pub(super) fn stream_started(&mut self) { self.stream_starts += 1; }
    pub(super) fn activity(&mut self, activity: DesktopStreamActivity) -> Result<(), String> {
        match activity { DesktopStreamActivity::Completed => self.completed = true,
            DesktopStreamActivity::Aborted => self.aborted = true, _ => {} }
        self.record(json!({"kind":"stream-activity","activity":format!("{activity:?}")}))
    }
    pub(super) fn stage(&mut self, stage: Value) -> Result<(), String> {
        if stage["status"] == "completed" { self.stages.push(stage.clone()); }
        self.record(stage)
    }
    pub(super) fn tap(&mut self, tap: &DesktopStreamTap<'_>, endpoint: &str, media_complete: bool) -> Result<Value, String> {
        if tap.physical_playback_device_id != endpoint || tap.submitted_qpc_100ns.is_none()
            || self.session_id.is_some_and(|id| id != tap.render_session_id)
            || tap.reference_start_frame != self.reference.samples/2 || tap.physical_start_frame != self.physical.samples/2
            || tap.reference_end_frame.checked_sub(tap.reference_start_frame) != Some(tap.reference_samples.len() as u64/2)
            || tap.physical_end_frame.checked_sub(tap.physical_start_frame) != Some(tap.physical_samples.len() as u64/2) {
            return Err("local AEC successful-write evidence endpoint, session, QPC or frame span mismatch".into());
        }
        self.session_id = Some(tap.render_session_id);
        self.physical.write(tap.physical_samples)?; self.reference.write(tap.reference_samples)?;
        let rms = (tap.physical_samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>()
            / tap.physical_samples.len().max(1) as f64).sqrt();
        let voiced = !tap.reference_samples.is_empty() && rms > 0.001;
        if media_complete && voiced { self.late_voiced_frames += tap.physical_samples.len() as u64/2; }
        let value = json!({"kind":"physical-render","renderSessionId":tap.render_session_id,
            "ownerGeneration":tap.renderer_owner_generation,"rendererInstanceId":tap.renderer_instance_id,
            "endpointId":tap.physical_playback_device_id,
            "referenceStartFrame":tap.reference_start_frame,"referenceEndFrame":tap.reference_end_frame,
            "physicalStartFrame":tap.physical_start_frame,"physicalEndFrame":tap.physical_end_frame,
            "stage":tap.stage,"stageOrdinal":tap.stage_ordinal,"delayMs":tap.delay_ms,"nonlinearity":tap.nonlinearity,
            "submittedFrames":tap.submitted_frames,"endpointPaddingFrames":tap.endpoint_padding_frames,
            "physicalPrefixOffsetFrames":tap.physical_prefix_offset_frames,"qpc100ns":tap.submitted_qpc_100ns,
            "sampleRateHz":48000,"channelCount":2,"afterValidatedMediaComplete":media_complete,"voiced":voiced,
            "physicalRms":rms,"deviceObservedAgoMicros":tap.observed_at.elapsed().as_micros(),"physicalPcmSha256":float_hash(tap.physical_samples),
            "linearReferencePcmSha256":float_hash(tap.reference_samples)});
        self.record(value.clone())?; Ok(value)
    }
    pub(super) fn validate(&self, phase_ms: u32, source_frames: usize) -> Result<(), String> {
        if self.stream_starts != 1 || !self.completed || self.aborted || self.stages.len() != 3
            || self.reference.samples/2 != source_frames as u64*2 || self.late_voiced_frames < 48_000 {
            return Err("local AEC stream requires one real continuous render, all phases and >=1s voiced media-end tail".into());
        }
        for (index, stage) in self.stages.iter().enumerate() {
            let expected = if index < 2 { u64::from(phase_ms)*48 }
                else { source_frames as u64*2 - u64::from(phase_ms)*96 };
            if stage["ordinal"] != index+1 || stage["referenceFrames"] != expected
                || stage["delayMs"] != index*80 || stage["physicalFrames"] != expected + (index*80*48) as u64
                || (index == 2 && stage["changedSamples"].as_u64().unwrap_or(0) == 0)
                || (index < 2 && stage["changedSamples"] != 0) {
                return Err("local AEC physical stage receipt contradicts PCM/reference/delay transform".into());
            }
        }
        Ok(())
    }
    pub(super) fn finish(&mut self) -> Result<Value, String> {
        // Seal every evidence file before returning a completed operation.
        let physical = self.physical.finish(); let reference = self.reference.finish();
        let events = self.records.finish().and_then(|seal| {
            if seal.written_bytes != self.record_bytes || seal.sha256 != format!("{:x}",self.records_hash.clone().finalize())
                || !seal.flushed || !seal.synced { return Err("async JSONL evidence seal differs from accepted producer bytes".into()); }
            Ok(())
        });
        events.as_ref().map_err(|e| e.clone())?;
        Ok(json!({"physical":physical?,"linearReference":reference?,"events":{
            "path":self.records_path,"sha256":format!("{:x}",self.records_hash.clone().finalize()),
            "eventCount":self.record_count,"flushed":events.is_ok(),"synced":events.is_ok(),"error":events.err()},
            "stages":self.stages,"streamStartCount":self.stream_starts,"streamDrained":self.completed,
            "aborted":self.aborted,"mediaEndVoicedPhysicalFrames":self.late_voiced_frames,
            "renderSessionId":self.session_id}))
    }
}
fn float_hash(samples: &[f32]) -> String {
    let mut hash = Sha256::new(); for sample in samples { hash.update(sample.to_le_bytes()); }
    format!("{:x}",hash.finalize())
}

#[cfg(test)]
mod asynchronous_seal_tests {
    use super::*;
    #[test]
    fn pcm_seal_joins_ordered_writes_and_preserves_native_bytes() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("physical.f32le");
        let mut pcm=PcmEvidence::new(path.clone()).unwrap();
        let first=vec![0.125_f32,-0.25];
        let second=[0.5_f32,-0.75,0.0,0.25];
        pcm.write(&first).unwrap();pcm.write(&second).unwrap();
        let seal=pcm.finish().unwrap();let repeated=pcm.finish().unwrap();
        let expected:Vec<u8>=first.iter().chain(second.iter()).flat_map(|s|s.to_le_bytes()).collect();
        assert_eq!(fs::read(path).unwrap(),expected);assert_eq!(seal,repeated);
        assert_eq!(seal["sampleCount"],6);assert_eq!(seal["frameCount"],3);
        assert_eq!(seal["sha256"],format!("{:x}",Sha256::digest(&expected)));
        assert_eq!(seal["flushed"],true);assert_eq!(seal["synced"],true);
    }
    #[test]
    fn asynchronous_jsonl_seal_is_bound_to_producer_sequence_and_hash() {
        let root=tempfile::tempdir().unwrap();let mut evidence=StreamEvidence::new(root.path()).unwrap();
        evidence.record(json!({"kind":"one"})).unwrap();evidence.record(json!({"kind":"two"})).unwrap();
        let seal=evidence.finish().unwrap();let bytes=fs::read(root.path().join("local-aec-stream-events.jsonl")).unwrap();
        let rows:Vec<Value>=std::str::from_utf8(&bytes).unwrap().lines().map(|s|serde_json::from_str(s).unwrap()).collect();
        assert_eq!(rows[0]["sequence"],0);assert_eq!(rows[1]["sequence"],1);
        assert_eq!(rows[0]["kind"],"one");assert_eq!(rows[1]["kind"],"two");
        assert_eq!(seal["events"]["eventCount"],2);
        assert_eq!(seal["events"]["sha256"],format!("{:x}",Sha256::digest(&bytes)));
        assert_eq!(seal["events"]["flushed"],true);assert_eq!(seal["events"]["synced"],true);
        // A perfectly sealed file does not invent completed playback/stages.
        assert!(evidence.validate(40_000,120_000).is_err());assert_eq!(seal["streamDrained"],false);
    }
}
