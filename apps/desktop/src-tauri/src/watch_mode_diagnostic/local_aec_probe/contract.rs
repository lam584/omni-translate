use super::super::*;

pub(super) const PCM_RATE: u32 = 24_000;
pub(super) const MAX_SPEECH_PCM_BYTES: u64 = 24_000 * 2 * 180;
pub(super) const READY_FILE: &str = "local-aec-ready.json";
pub(super) const START_FILE: &str = "media-started.marker";
pub(super) const COMPLETE_FILE: &str = "media-complete.marker";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechSimulationRequest {
    pub(super) chunk_frames: usize,
    pub(super) chunk_interval_ms: u64,
    pub(super) stage_duration_ms: u32,
    pub(super) deadline_ms: u64,
    pub(super) injector_executable: PathBuf,
    pub(super) injector_executable_sha256: String,
    pub(super) source_wav_path: PathBuf,
    pub(super) source_wav_sha256: String,
    #[serde(default)]
    pub(super) tail_start_frame: Option<usize>,
}

pub(super) fn validate_schema(request: &ProbeRequest) -> Result<(), String> {
    match (request.schema_version, request.speech_simulation.as_ref()) {
        (1, None) => Ok(()),
        (2, Some(sim)) => {
            if sim.chunk_frames != 2400 || sim.chunk_interval_ms != 100
                || !(20_000..=60_000).contains(&sim.stage_duration_ms) || sim.stage_duration_ms % 10 != 0
                || !(30_000..=180_000).contains(&sim.deadline_ms)
                || !sim.injector_executable.is_absolute() || !sim.source_wav_path.is_absolute()
                || [&sim.injector_executable_sha256, &sim.source_wav_sha256].iter().any(|hash|
                    hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())) {
                return Err("invalid schema2 PCM cadence, phase duration, deadline or receipt path".into());
            }
            Ok(())
        }
        _ => Err("schema1 forbids speechSimulation; schema2 requires speechSimulation".into()),
    }
}

pub(super) fn read_speech_pcm(request: &ProbeRequest) -> Result<Vec<i16>, String> {
    let sim = request.speech_simulation.as_ref().ok_or("missing speechSimulation")?;
    let bytes = read_bounded(&request.render_pcm_path, MAX_SPEECH_PCM_BYTES)?;
    if bytes.len() % (sim.chunk_frames * 2) != 0
        || format!("{:x}", Sha256::digest(&bytes)) != request.render_pcm_sha256 {
        return Err("schema2 speech PCM must be hash-pinned s16le/24k/mono aligned to 100ms deltas".into());
    }
    let samples: Vec<i16> = bytes.chunks_exact(2).map(|v| i16::from_le_bytes([v[0], v[1]])).collect();
    let phase_frames = sim.stage_duration_ms as usize * 24;
    if samples.len() < phase_frames * 3 || sim.deadline_ms < samples.len() as u64 / 24 + 10_000 {
        return Err("schema2 requires at least three physical phases and a non-completion watchdog".into());
    }
    for range in [0..phase_frames, phase_frames..phase_frames * 2, phase_frames * 2..samples.len()] {
        if !samples[range].iter().any(|s| s.unsigned_abs() > 32) {
            return Err("schema2 speech PCM contains a silent phase; labels are not speech evidence".into());
        }
    }
    if sim.tail_start_frame.is_some_and(|offset| offset % sim.chunk_frames != 0
        || offset < phase_frames * 2 || offset >= samples.len()
        || samples.len().saturating_sub(offset) < PCM_RATE as usize) {
        return Err("tailStartFrame must be 100ms-aligned after the first two phases, with >=1s remaining original PCM".into());
    }
    Ok(samples)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MediaStarted {
    pub(super) execution_id: String,
    pub(super) physical_device_id: String,
    pub(super) process_id: u32,
    pub(super) started_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaComplete { execution_id: String, source_media_receipt_sha256: String }

pub(super) fn validate_media_complete(request: &ProbeRequest, start: &MediaStarted, marker_bytes: &[u8], receipt_bytes: &[u8], now_ms: u64) -> Result<Value, String> {
    let marker: MediaComplete = serde_json::from_slice(marker_bytes).map_err(|e| e.to_string())?;
    if marker.execution_id != request.execution_id || marker.source_media_receipt_sha256 != format!("{:x}", Sha256::digest(receipt_bytes)) {
        return Err("media-complete marker identity or receipt hash mismatch".into());
    }
    let receipt: Value = serde_json::from_slice(receipt_bytes).map_err(|e| e.to_string())?;
    if receipt["passed"] != true || receipt["endpointId"] != request.physical_device_id
        || receipt["processId"].as_u64() != Some(u64::from(start.process_id))
        || receipt["renderedFrames"].as_u64().unwrap_or(0) == 0
        || receipt["renderSampleRateHz"] != 48_000
        || receipt["zeroPaddingUnderrunCount"].as_u64() != Some(0)
        || !receipt["detail"].is_null()
        || receipt["sourcePlaybackStartQpc100ns"].as_u64().unwrap_or(0) == 0
        || receipt["startedAtMs"].as_u64().is_none_or(|t| t < start.started_at_ms.saturating_sub(1_000))
        || receipt["finishedAtMs"].as_u64().is_none_or(|t| t < start.started_at_ms || t > now_ms)
        || receipt["startedAtMs"].as_u64() > receipt["finishedAtMs"].as_u64() {
        return Err("source media receipt is not a healthy same-endpoint real injector completion".into());
    }
    Ok(json!({"sha256":marker.source_media_receipt_sha256,"receipt":receipt,"validatedAtMs":now_ms}))
}
