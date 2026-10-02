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

pub(super) struct SourcePlaybackClock {
    writer: Option<std::io::BufWriter<std::fs::File>>, pub(super) metadata_path: Option<PathBuf>,
    pub(super) origin: Option<u64>, pub(super) frequency: Option<u64>, previous_position: u64,
    endpoint_id: String, rate: u32, sequence: u64,
}
impl SourcePlaybackClock {
    pub(super) fn new(pcm_path: Option<&std::path::Path>, endpoint_id: &str, rate: u32) -> Result<Self, String> {
        let metadata_path = pcm_path.map(|p| p.with_file_name("aec-source-playback-clock.jsonl"));
        let writer = metadata_path.as_ref().map(|p| std::fs::OpenOptions::new().write(true).create_new(true).open(p)
            .map(std::io::BufWriter::new)).transpose().map_err(|error| format!("create source clock evidence: {error}"))?;
        Ok(Self { writer, metadata_path, origin: None, frequency: None, previous_position: 0,
            endpoint_id: endpoint_id.to_string(), rate, sequence: 0 })
    }
    pub(super) fn observe(&mut self, render: &MediaRender, submitted: usize) -> Result<(), String> {
        if self.writer.is_none() { return Ok(()); }
        let clock = render.audio_clock.as_ref().ok_or("source evidence clock not enabled")?;
        let frequency = clock.get_frequency().map_err(error_text)?;
        let (position, qpc) = clock.get_position().map_err(error_text)?;
        if frequency == 0 || qpc == 0 || position < self.previous_position || self.frequency.is_some_and(|f| f != frequency) {
            return Err("source render clock invalid/non-monotonic/frequency changed".to_string());
        }
        if position == 0 { return Ok(()); }
        let origin = source_clock_origin(position, frequency, qpc)?;
        if self.origin.is_some_and(|old| old.abs_diff(origin) > 10_000) {
            return Err("source render clock origin drift exceeds frozen 1ms bound".to_string());
        }
        self.origin.get_or_insert(origin); self.frequency = Some(frequency); self.previous_position = position;
        let value = serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock", "sequence":self.sequence,
            "processId":std::process::id(), "endpointId":self.endpoint_id,"sampleRateHz":self.rate,
            "clockPosition":position,"clockFrequency":frequency,"qpc100ns":qpc,
            "playbackStartQpc100ns":self.origin,"submittedFrames":submitted,"paddingFrames":render.current_padding_frames()?});
        serde_json::to_writer(self.writer.as_mut().unwrap(), &value).map_err(|error| error.to_string())?;
        self.writer.as_mut().unwrap().write_all(b"\n").map_err(|error| error.to_string())?; self.sequence += 1;
        Ok(())
    }
    pub(super) fn finish(&mut self) -> Result<(), String> {
        if let Some(writer) = self.writer.as_mut() {
            if self.origin.is_none() || self.sequence < 2 { return Err("source actual playback clock evidence incomplete".to_string()); }
            writer.flush().map_err(|error| error.to_string())?;
            writer.get_ref().sync_all().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}
