use std::io::Write;
use std::path::PathBuf;
use super::{MediaRender, error_text};

// The stream origin is reconstructed from the position of a sample actually
// playing on this client. Clock positions are not sample frames: divide by
// GetFrequency before comparing to QPC's 100ns units. No wall-clock enqueue timestamp.
pub(super) fn source_clock_origin(position: u64, frequency: u64, qpc: u64) -> Result<u64, String> {
    if frequency == 0 || qpc == 0 { return Err("source render clock units invalid".into()); }
    let offset = (position as u128) * 10_000_000 / frequency as u128;
    if offset > u64::MAX as u128 { return Err("source render clock offset overflow".into()); }
    qpc.checked_sub(offset as u64).ok_or_else(|| "source render origin invalid".into())
}

// Keep persistence injectable without touching the native execution entry point.
trait EvidenceWriter: Write + Send + Sync {
    fn sync_all(&self) -> std::io::Result<()>;
}
impl EvidenceWriter for std::io::BufWriter<std::fs::File> {
    fn sync_all(&self) -> std::io::Result<()> { self.get_ref().sync_all() }
}

struct ClockObservation {
    position: u64, frequency: u64, qpc: u64, submitted: usize,
    padding: Result<usize, String>,
}

pub(super) struct SourcePlaybackClock {
    writer: Option<Box<dyn EvidenceWriter>>, pub(super) metadata_path: Option<PathBuf>,
    failure_writer: Option<Box<dyn EvidenceWriter>>, failure: Option<String>, persistence_failed: bool,
    pub(super) origin: Option<u64>, pub(super) frequency: Option<u64>, previous_position: u64,
    endpoint_id: String, rate: u32, sequence: u64,
}
impl SourcePlaybackClock {
    pub(super) fn new(pcm_path: Option<&std::path::Path>, endpoint_id: &str, rate: u32) -> Result<Self, String> {
        let metadata_path = pcm_path.map(|p| p.with_file_name("aec-source-playback-clock.jsonl"));
        let failure_path = pcm_path.map(|p| p.with_file_name("aec-source-playback-clock-failures.jsonl"));
        let open = |path: &PathBuf| -> Result<Box<dyn EvidenceWriter>, String> {
            std::fs::OpenOptions::new().write(true).create_new(true).open(path)
                .map(|file| Box::new(std::io::BufWriter::new(file)) as Box<dyn EvidenceWriter>)
                .map_err(|error| format!("create source clock evidence {}: {error}", path.display()))
        };
        let writer = metadata_path.as_ref().map(&open).transpose()?;
        let failure_writer = failure_path.as_ref().map(&open).transpose()?;
        Ok(Self { writer, metadata_path, failure_writer, failure: None, persistence_failed: false,
            origin: None, frequency: None, previous_position: 0,
            endpoint_id: endpoint_id.to_string(), rate, sequence: 0 })
    }
    pub(super) fn observe(&mut self, render: &MediaRender, submitted: usize) -> Result<(), String> {
        if self.writer.is_none() { return Ok(()); }
        if let Some(error) = &self.failure { return Err(error.clone()); }
        let raw = (|| {
            let clock = render.audio_clock.as_ref().ok_or("source evidence clock not enabled")?;
            let frequency = clock.get_frequency().map_err(error_text)?;
            let (position, qpc) = clock.get_position().map_err(error_text)?;
            Ok::<_, String>((position, frequency, qpc))
        })();
        match raw {
            Ok((position, frequency, qpc)) => self.observe_sample(ClockObservation {
                position, frequency, qpc, submitted, padding: render.current_padding_frames(),
            }),
            Err(error) => self.reject(None, error),
        }
    }
    pub(super) fn observe_raw_clock(&mut self, raw: Result<(u64, u64, u64), String>,
        submitted: usize, padding: Result<usize, String>) -> Result<(), String> {
        if let Some(error) = &self.failure { return Err(error.clone()); }
        match raw {
            Ok((position, frequency, qpc)) => self.observe_sample(ClockObservation { position, frequency, qpc, submitted, padding }),
            Err(error) => self.reject(None, error),
        }
    }
    pub(super) fn validation_failure(&self) -> Option<&str> { self.failure.as_deref() }
    pub(super) fn persistence_failed(&self) -> bool { self.persistence_failed }
    fn observe_sample(&mut self, sample: ClockObservation) -> Result<(), String> {
        if let Some(error) = &self.failure { return Err(error.clone()); }
        let ClockObservation { position, frequency, qpc, .. } = sample;
        // These gates (including the startup position-zero skip) are unchanged.
        let validation = if frequency == 0 || qpc == 0 || position < self.previous_position
            || self.frequency.is_some_and(|f| f != frequency) {
            Err("source render clock invalid/non-monotonic/frequency changed".to_string())
        } else if position == 0 {
            return Ok(());
        } else {
            source_clock_origin(position, frequency, qpc).and_then(|origin| {
                if self.origin.is_some_and(|old| old.abs_diff(origin) > 10_000) {
                    Err("source render clock origin drift exceeds frozen 1ms bound".to_string())
                } else { Ok(origin) }
            })
        };
        let origin = match validation {
            Ok(origin) => origin,
            Err(error) => return self.reject(Some(&sample), error),
        };
        let padding = match &sample.padding {
            Ok(padding) => *padding,
            Err(error) => return self.reject(Some(&sample), error.clone()),
        };
        let value = serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock", "sequence":self.sequence,
            "processId":std::process::id(), "endpointId":self.endpoint_id,"sampleRateHz":self.rate,
            "clockPosition":position,"clockFrequency":frequency,"qpc100ns":qpc,
            "playbackStartQpc100ns":self.origin.unwrap_or(origin),"submittedFrames":sample.submitted,"paddingFrames":padding});
        if let Err(error) = Self::write_row(&mut self.writer, &value) {
            self.persistence_failed = true;
            return self.reject(Some(&sample), format!("write source clock evidence: {error}"));
        }
        // Only a validated, successfully written row can change accepted state.
        self.origin.get_or_insert(origin); self.frequency = Some(frequency); self.previous_position = position;
        self.sequence += 1;
        Ok(())
    }
    fn write_row(writer: &mut Option<Box<dyn EvidenceWriter>>, value: &serde_json::Value) -> Result<(), String> {
        let writer = writer.as_mut().ok_or("source clock evidence writer missing")?;
        serde_json::to_writer(&mut **writer, value).map_err(|error| error.to_string())?;
        writer.write_all(b"\n").map_err(|error| error.to_string())
    }
    fn reject(&mut self, sample: Option<&ClockObservation>, error: String) -> Result<(), String> {
        // Latch before persistence: write/flush/sync errors must never make finish green.
        self.failure = Some(error.clone());
        let mut errors = vec![error.clone()];
        if let Some(sample) = sample {
            let computed_origin = source_clock_origin(sample.position, sample.frequency, sample.qpc);
            let value = serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock-failure",
                "sequence":self.sequence,"processId":std::process::id(),"endpointId":self.endpoint_id,"sampleRateHz":self.rate,
                "clockPosition":sample.position,"clockFrequency":sample.frequency,"qpc100ns":sample.qpc,
                "submittedFrames":sample.submitted,"paddingFrames":sample.padding.as_ref().ok(),
                "paddingError":sample.padding.as_ref().err(),
                "computedPlaybackStartQpc100ns":computed_origin.as_ref().ok(),
                "originCalculationError":computed_origin.as_ref().err(),
                "acceptedAnchor":{"playbackStartQpc100ns":self.origin,"clockFrequency":self.frequency,
                    "clockPosition":self.previous_position,"successfulObservations":self.sequence},
                "validationError":error});
            if let Err(error) = Self::write_row(&mut self.failure_writer, &value) {
                self.persistence_failed = true;
                errors.push(format!("write source clock failure evidence: {error}"));
            }
        }
        // Flush both streams even when one fails, before returning the original gate failure.
        if let Err(error) = self.flush_evidence() { errors.push(error); }
        let error = errors.join("; ");
        self.failure = Some(error.clone());
        Err(error)
    }
    fn flush_evidence(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (name, writer) in [("accepted", &mut self.writer), ("failure", &mut self.failure_writer)] {
            if let Some(writer) = writer.as_mut() {
                if let Err(error) = writer.flush() { errors.push(format!("flush {name} source clock evidence: {error}")); }
                if let Err(error) = writer.sync_all() { errors.push(format!("sync {name} source clock evidence: {error}")); }
            }
        }
        if errors.is_empty() { Ok(()) } else { self.persistence_failed = true; Err(errors.join("; ")) }
    }
    pub(super) fn finish(&mut self) -> Result<(), String> {
        // Incomplete/failed runs still persist every row that reached a writer.
        if let Err(error) = self.flush_evidence() {
            let error = self.failure.as_ref().map(|failure| format!("{failure}; {error}")).unwrap_or(error);
            self.failure = Some(error.clone());
            return Err(error);
        }
        if let Some(error) = &self.failure { return Err(error.clone()); }
        if self.writer.is_some() && (self.origin.is_none() || self.sequence < 2) {
            return Err("source actual playback clock evidence incomplete".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "source_clock/tests.rs"]
mod tests;
