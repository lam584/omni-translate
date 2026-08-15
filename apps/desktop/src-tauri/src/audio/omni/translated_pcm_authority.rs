use std::collections::{HashMap, HashSet};
use std::fs::{create_dir, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::provider::contracts::ProviderDraftInput;

const AUTHORITY_DIR_ENV: &str = "OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR";
const MAX_SAMPLES_ENV: &str = "OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES";
const CELL_ID_ENV: &str = "OMNI_WATCH_MODE_CELL_ID";
const LEASE_ID_ENV: &str = "OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID";
const RUN_MARKER_ENV: &str = "OMNI_WATCH_MODE_RUN_MARKER";
const AUTOSTART_ENV: &str = "OMNI_WATCH_MODE_AUTOSTART";
const MAX_PROVIDER_INPUT_SAMPLES: u64 = 180 * 16_000;
const MAX_TRANSLATED_PCM_SAMPLES: usize = 240 * 48_000;
const AUTHORITY_KIND: &str = "watch-mode-translated-cue-pcm-authority";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AcceptedTranslatedCue {
    sequence: u64,
    cue_id: String,
    request_ids: Vec<String>,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_count: usize,
    frame_count: u64,
    bytes: usize,
    sha256: String,
    relative_path: String,
    accepted_frames: u64,
    chunk_count: u32,
    chunks: Vec<AcceptedTranslatedChunk>,
    created_at_ms: u64,
    completed_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedTranslatedChunk {
    chunk_index: u32,
    request_id: String,
    sample_offset: usize,
    sample_count: usize,
    accepted_at_ms: u64,
}

#[derive(Debug)]
struct PendingTranslatedStream {
    cue_id: String,
    request_ids: Vec<String>,
    sample_rate_hz: u32,
    channel_count: u16,
    samples: Vec<i16>,
    accepted_frames: u64,
    chunks: Vec<AcceptedTranslatedChunk>,
    next_chunk_index: u32,
    created_at_ms: u64,
}

#[derive(Debug)]
struct EnabledTranslatedPcmAuthority {
    pcm_directory: PathBuf,
    journal: File,
    summary: File,
    cell_id: String,
    lease_id: String,
    run_marker: String,
    session_generation: u64,
    model: String,
    protocol: String,
    max_provider_input_samples: u64,
    sequence: u64,
    accepted_cues: Vec<AcceptedTranslatedCue>,
    accepted_cue_ids: HashSet<String>,
    active_streams: HashMap<String, PendingTranslatedStream>,
    aborted_stream_count: u64,
    finalized: bool,
    terminal_reason: Option<String>,
}

#[derive(Debug)]
pub(super) struct TranslatedPcmAuthority {
    enabled: Option<EnabledTranslatedPcmAuthority>,
}

impl TranslatedPcmAuthority {
    pub(super) fn from_env(
        provider: &ProviderDraftInput,
        direction: &str,
        session_generation: u64,
    ) -> Result<Self, String> {
        let resolved = crate::audio::events::resolve_realtime_profile(provider, &provider.model);
        let protocol = resolved
            .protocol_dialect
            .map(|value| value.as_str())
            .unwrap_or_default();
        Self::from_environment(
            direction,
            session_generation,
            &provider.model,
            protocol,
            |name| std::env::var(name).ok(),
        )
    }

    pub(super) fn disabled() -> Self {
        Self { enabled: None }
    }

    fn from_environment(
        direction: &str,
        session_generation: u64,
        model: &str,
        protocol: &str,
        read_env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let authority_directory = read_env(AUTHORITY_DIR_ENV);
        let max_samples = read_env(MAX_SAMPLES_ENV);
        if authority_directory.is_none() && max_samples.is_none() {
            return Ok(Self::disabled());
        }
        let required = |name: &str, value: Option<String>| -> Result<String, String> {
            value
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .ok_or_else(|| format!("strict translated PCM authority requires {name}"))
        };
        let directory = PathBuf::from(required(AUTHORITY_DIR_ENV, authority_directory)?);
        let max_provider_input_samples = required(MAX_SAMPLES_ENV, max_samples)?
            .parse::<u64>()
            .map_err(|error| format!("{MAX_SAMPLES_ENV} must be an integer: {error}"))?;
        if max_provider_input_samples == 0
            || max_provider_input_samples > MAX_PROVIDER_INPUT_SAMPLES
        {
            return Err(format!(
                "{MAX_SAMPLES_ENV} must be within 1..={MAX_PROVIDER_INPUT_SAMPLES}"
            ));
        }
        let cell_id = required(CELL_ID_ENV, read_env(CELL_ID_ENV))?;
        let lease_id = required(LEASE_ID_ENV, read_env(LEASE_ID_ENV))?;
        let run_marker = required(RUN_MARKER_ENV, read_env(RUN_MARKER_ENV))?;
        let autostart = required(AUTOSTART_ENV, read_env(AUTOSTART_ENV))?;
        if !matches!(autostart.as_str(), "1" | "true" | "TRUE" | "yes" | "YES") {
            return Err(format!(
                "strict translated PCM authority requires {AUTOSTART_ENV}=1"
            ));
        }
        if direction != "inbound" {
            return Err(
                "strict translated PCM authority permits only the inbound Watch route"
                    .to_string(),
            );
        }
        if model.trim().is_empty() || protocol.trim().is_empty() {
            return Err(
                "strict translated PCM authority requires resolved model and protocol"
                    .to_string(),
            );
        }
        let parent = directory.parent().ok_or_else(|| {
            "strict translated PCM authority directory must have a parent".to_string()
        })?;
        if !parent.is_dir() {
            return Err(
                "strict translated PCM authority parent directory does not exist".to_string(),
            );
        }
        create_dir(&directory).map_err(|error| {
            format!(
                "strict translated PCM authority directory must be new and exclusive: {error}"
            )
        })?;
        let pcm_directory = directory.join("cue-pcm");
        let initialize = || -> Result<(File, File), String> {
            create_dir(&pcm_directory).map_err(|error| {
                format!("strict translated PCM cue directory create failed: {error}")
            })?;
            let journal =
                create_new_file(&directory.join("translated-cue-pcm-authority.jsonl"))?;
            let summary = create_new_file(&directory.join("translated-cue-pcm-summary.json"))?;
            Ok((journal, summary))
        };
        let (journal, summary) = match initialize() {
            Ok(files) => files,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&directory);
                return Err(error);
            }
        };
        let mut authority = Self {
            enabled: Some(EnabledTranslatedPcmAuthority {
                pcm_directory,
                journal,
                summary,
                cell_id,
                lease_id,
                run_marker,
                session_generation,
                model: model.trim().to_string(),
                protocol: protocol.trim().to_string(),
                max_provider_input_samples,
                sequence: 0,
                accepted_cues: Vec::new(),
                accepted_cue_ids: HashSet::new(),
                active_streams: HashMap::new(),
                aborted_stream_count: 0,
                finalized: false,
                terminal_reason: None,
            }),
        };
        authority.write_event("initialized", None)?;
        authority.write_summary()?;
        Ok(authority)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn accept_complete_cue(
        &mut self,
        cue_id: &str,
        request_id: &str,
        samples: &[i16],
        sample_rate_hz: u32,
        channel_count: u16,
        accepted_frames: u64,
        created_at_ms: u64,
    ) -> Result<(), String> {
        let Some(enabled) = self.enabled.as_mut() else {
            return Ok(());
        };
        validate_accepted_pcm(
            cue_id,
            samples,
            sample_rate_hz,
            channel_count,
            accepted_frames,
        )?;
        if enabled.active_streams.contains_key(cue_id)
            || enabled.accepted_cue_ids.contains(cue_id)
        {
            return Err(format!(
                "translated PCM authority rejected duplicate cueId={cue_id}"
            ));
        }
        let record = persist_accepted_cue(
            enabled,
            cue_id,
            vec![request_id.to_string()],
            samples,
            sample_rate_hz,
            channel_count,
            accepted_frames,
            1,
            vec![AcceptedTranslatedChunk {
                chunk_index: 0,
                request_id: request_id.to_string(),
                sample_offset: 0,
                sample_count: samples.len(),
                accepted_at_ms: now_unix_ms(),
            }],
            created_at_ms,
        )?;
        self.write_event("bridge_write_accepted", Some(&record))?;
        self.write_summary()
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn accept_stream_write(
        &mut self,
        cue_id: &str,
        request_id: &str,
        samples: &[i16],
        sample_rate_hz: u32,
        channel_count: u16,
        accepted_frames: u64,
        chunk_index: u32,
        stream_state: omni_bridge_protocol::TranslationStreamState,
        created_at_ms: u64,
    ) -> Result<(), String> {
        let Some(enabled) = self.enabled.as_mut() else {
            return Ok(());
        };
        use omni_bridge_protocol::TranslationStreamState;
        match stream_state {
            TranslationStreamState::Start => {
                if chunk_index != 0
                    || enabled.active_streams.contains_key(cue_id)
                    || enabled.accepted_cue_ids.contains(cue_id)
                {
                    return Err(format!(
                        "translated PCM authority rejected invalid stream start cueId={cue_id} chunkIndex={chunk_index}"
                    ));
                }
                validate_accepted_pcm(
                    cue_id,
                    samples,
                    sample_rate_hz,
                    channel_count,
                    accepted_frames,
                )?;
                enabled.active_streams.insert(
                    cue_id.to_string(),
                    PendingTranslatedStream {
                        cue_id: cue_id.to_string(),
                        request_ids: vec![request_id.to_string()],
                        sample_rate_hz,
                        channel_count,
                        samples: samples.to_vec(),
                        accepted_frames,
                        chunks: vec![AcceptedTranslatedChunk {
                            chunk_index,
                            request_id: request_id.to_string(),
                            sample_offset: 0,
                            sample_count: samples.len(),
                            accepted_at_ms: now_unix_ms(),
                        }],
                        next_chunk_index: 1,
                        created_at_ms,
                    },
                );
                self.write_summary()
            }
            TranslationStreamState::Chunk => {
                validate_accepted_pcm(
                    cue_id,
                    samples,
                    sample_rate_hz,
                    channel_count,
                    accepted_frames,
                )?;
                let pending = enabled.active_streams.get_mut(cue_id).ok_or_else(|| {
                    format!("translated PCM authority stream chunk has no start cueId={cue_id}")
                })?;
                validate_stream_identity(pending, sample_rate_hz, channel_count, chunk_index)?;
                let next_len = pending.samples.len().saturating_add(samples.len());
                if next_len > MAX_TRANSLATED_PCM_SAMPLES {
                    return Err(format!(
                        "translated PCM authority stream exceeds {MAX_TRANSLATED_PCM_SAMPLES} samples"
                    ));
                }
                pending.samples.extend_from_slice(samples);
                pending.chunks.push(AcceptedTranslatedChunk {
                    chunk_index,
                    request_id: request_id.to_string(),
                    sample_offset: next_len - samples.len(),
                    sample_count: samples.len(),
                    accepted_at_ms: now_unix_ms(),
                });
                pending.request_ids.push(request_id.to_string());
                pending.accepted_frames = pending
                    .accepted_frames
                    .checked_add(accepted_frames)
                    .ok_or_else(|| "translated PCM accepted frame count overflow".to_string())?;
                pending.next_chunk_index = pending.next_chunk_index.saturating_add(1);
                self.write_summary()
            }
            TranslationStreamState::End => {
                if !samples.is_empty() || accepted_frames != 0 {
                    return Err(
                        "translated PCM authority stream end must contain no PCM".to_string(),
                    );
                }
                let pending = enabled.active_streams.get(cue_id).ok_or_else(|| {
                    format!("translated PCM authority stream end has no start cueId={cue_id}")
                })?;
                validate_stream_identity(pending, sample_rate_hz, channel_count, chunk_index)?;
                let pending = enabled
                    .active_streams
                    .remove(cue_id)
                    .expect("stream presence was checked immediately before removal");
                let mut request_ids = pending.request_ids;
                request_ids.push(request_id.to_string());
                let record = persist_accepted_cue(
                    enabled,
                    &pending.cue_id,
                    request_ids,
                    &pending.samples,
                    pending.sample_rate_hz,
                    pending.channel_count,
                    pending.accepted_frames,
                    pending.next_chunk_index,
                    pending.chunks,
                    pending.created_at_ms,
                )?;
                self.write_event("bridge_write_accepted", Some(&record))?;
                self.write_summary()
            }
            TranslationStreamState::Abort => self.abort_stream(cue_id, "bridge-stream-abort"),
        }
    }

    pub(super) fn abort_stream(&mut self, cue_id: &str, reason: &str) -> Result<(), String> {
        let Some(enabled) = self.enabled.as_mut() else {
            return Ok(());
        };
        if enabled.active_streams.remove(cue_id).is_some() {
            enabled.aborted_stream_count = enabled.aborted_stream_count.saturating_add(1);
            let detail = json!({ "cueId": cue_id, "reason": reason });
            self.write_raw_event("stream_aborted", Some(detail))?;
            self.write_summary()?;
        }
        Ok(())
    }

    pub(super) fn finalize(&mut self, reason: &str) -> Result<(), String> {
        let Some(enabled) = self.enabled.as_mut() else {
            return Ok(());
        };
        if enabled.finalized {
            return Ok(());
        }
        // A route can stop while the provider has an unfinished streaming
        // response. Such PCM was never sealed as a complete accepted cue and
        // must not remain ambiguous in the final artifact.
        let unfinished = enabled.active_streams.len() as u64;
        enabled.active_streams.clear();
        enabled.aborted_stream_count = enabled
            .aborted_stream_count
            .saturating_add(unfinished);
        enabled.finalized = true;
        enabled.terminal_reason = Some(reason.to_string());
        self.write_raw_event("finalized", None)?;
        self.write_summary()
    }

    fn write_event(
        &mut self,
        event: &str,
        cue: Option<&AcceptedTranslatedCue>,
    ) -> Result<(), String> {
        let detail = cue
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| format!("translated PCM cue serialize failed: {error}"))?;
        self.write_raw_event(event, detail)
    }

    fn write_raw_event(
        &mut self,
        event: &str,
        detail: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let Some(enabled) = self.enabled.as_mut() else {
            return Ok(());
        };
        enabled.sequence = enabled.sequence.saturating_add(1);
        let record = json!({
            "schemaVersion": 1,
            "artifactKind": AUTHORITY_KIND,
            "event": event,
            "sequence": enabled.sequence,
            "occurredAtMs": now_unix_ms(),
            "cellId": enabled.cell_id,
            "leaseId": enabled.lease_id,
            "runMarker": enabled.run_marker,
            "sessionGeneration": enabled.session_generation,
            "direction": "inbound",
            "model": enabled.model,
            "protocol": enabled.protocol,
            "detail": detail,
        });
        serde_json::to_writer(&mut enabled.journal, &record)
            .map_err(|error| format!("translated PCM authority serialize failed: {error}"))?;
        enabled
            .journal
            .write_all(b"\n")
            .and_then(|_| enabled.journal.flush())
            .map_err(|error| format!("translated PCM authority journal write failed: {error}"))
    }

    fn write_summary(&mut self) -> Result<(), String> {
        let Some(enabled) = self.enabled.as_mut() else {
            return Ok(());
        };
        let total_samples = enabled
            .accepted_cues
            .iter()
            .map(|cue| cue.sample_count as u64)
            .sum::<u64>();
        let total_bytes = enabled
            .accepted_cues
            .iter()
            .map(|cue| cue.bytes as u64)
            .sum::<u64>();
        let summary = json!({
            "schemaVersion": 1,
            "artifactKind": AUTHORITY_KIND,
            "cellId": enabled.cell_id,
            "leaseId": enabled.lease_id,
            "runMarker": enabled.run_marker,
            "sessionGeneration": enabled.session_generation,
            "direction": "inbound",
            "model": enabled.model,
            "protocol": enabled.protocol,
            "maxProviderInputSamples": enabled.max_provider_input_samples,
            "pcmFormat": "s16le",
            "cueCount": enabled.accepted_cues.len(),
            "totalSamples": total_samples,
            "totalBytes": total_bytes,
            "abortedStreamCount": enabled.aborted_stream_count,
            "activeStreamCount": enabled.active_streams.len(),
            "acceptedCues": enabled.accepted_cues,
            "finalized": enabled.finalized,
            "terminalReason": enabled.terminal_reason,
        });
        enabled
            .summary
            .seek(SeekFrom::Start(0))
            .and_then(|_| enabled.summary.set_len(0))
            .map_err(|error| format!("translated PCM authority summary reset failed: {error}"))?;
        serde_json::to_writer(&mut enabled.summary, &summary)
            .map_err(|error| format!("translated PCM authority summary serialize failed: {error}"))?;
        enabled
            .summary
            .write_all(b"\n")
            .and_then(|_| enabled.summary.flush())
            .map_err(|error| format!("translated PCM authority summary write failed: {error}"))
    }
}

impl Drop for TranslatedPcmAuthority {
    fn drop(&mut self) {
        let _ = self.finalize("authority-drop");
    }
}

fn create_new_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("translated PCM authority file must be new: {error}"))
}

fn validate_accepted_pcm(
    cue_id: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    accepted_frames: u64,
) -> Result<(), String> {
    if cue_id.trim().is_empty() || samples.is_empty() {
        return Err("translated PCM authority requires cueId and non-empty PCM".to_string());
    }
    if sample_rate_hz == 0 || channel_count != 1 {
        return Err(
            "translated PCM authority requires mono PCM with a non-zero sample rate".to_string(),
        );
    }
    if samples.len() > MAX_TRANSLATED_PCM_SAMPLES
        || accepted_frames != samples.len() as u64
    {
        return Err(format!(
            "translated PCM authority accepted frame mismatch: samples={} acceptedFrames={accepted_frames}",
            samples.len()
        ));
    }
    Ok(())
}

fn validate_stream_identity(
    pending: &PendingTranslatedStream,
    sample_rate_hz: u32,
    channel_count: u16,
    chunk_index: u32,
) -> Result<(), String> {
    if pending.sample_rate_hz != sample_rate_hz
        || pending.channel_count != channel_count
        || pending.next_chunk_index != chunk_index
    {
        return Err(format!(
            "translated PCM authority stream sequence mismatch: cueId={} expectedChunk={} actualChunk={chunk_index}",
            pending.cue_id, pending.next_chunk_index
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn persist_accepted_cue(
    enabled: &mut EnabledTranslatedPcmAuthority,
    cue_id: &str,
    request_ids: Vec<String>,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    accepted_frames: u64,
    chunk_count: u32,
    chunks: Vec<AcceptedTranslatedChunk>,
    created_at_ms: u64,
) -> Result<AcceptedTranslatedCue, String> {
    if enabled.accepted_cue_ids.contains(cue_id) {
        return Err(format!(
            "translated PCM authority rejected duplicate completed cueId={cue_id}"
        ));
    }
    let bytes = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect::<Vec<_>>();
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let cue_sequence = enabled.accepted_cues.len() + 1;
    let file_name = format!("cue-{cue_sequence:04}-{}.pcm", &sha256[..16]);
    let path = enabled.pcm_directory.join(&file_name);
    let mut file = create_new_file(&path)?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("translated PCM authority cue write failed: {error}"))?;
    let record = AcceptedTranslatedCue {
        sequence: cue_sequence as u64,
        cue_id: cue_id.to_string(),
        request_ids,
        sample_rate_hz,
        channel_count,
        sample_count: samples.len(),
        frame_count: samples.len() as u64 / channel_count as u64,
        bytes: bytes.len(),
        sha256,
        relative_path: format!("cue-pcm/{file_name}"),
        accepted_frames,
        chunk_count,
        chunks,
        created_at_ms,
        completed_at_ms: now_unix_ms(),
    };
    enabled.accepted_cue_ids.insert(cue_id.to_string());
    enabled.accepted_cues.push(record.clone());
    Ok(record)
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use omni_bridge_protocol::TranslationStreamState;
    use tempfile::tempdir;

    fn strict_environment(directory: &Path) -> HashMap<String, String> {
        HashMap::from([
            (
                AUTHORITY_DIR_ENV.to_string(),
                directory.to_string_lossy().to_string(),
            ),
            (MAX_SAMPLES_ENV.to_string(), "2880000".to_string()),
            (CELL_ID_ENV.to_string(), "cell-1".to_string()),
            (LEASE_ID_ENV.to_string(), "lease-1".to_string()),
            (RUN_MARKER_ENV.to_string(), "run-1".to_string()),
            (AUTOSTART_ENV.to_string(), "1".to_string()),
        ])
    }

    fn create_authority(root: &Path) -> TranslatedPcmAuthority {
        let target = root.join("authority");
        let env = strict_environment(&target);
        TranslatedPcmAuthority::from_environment(
            "inbound",
            7,
            "qwen3.5-omni-flash-realtime",
            "dashscope-omni",
            |name| env.get(name).cloned(),
        )
        .expect("authority")
    }

    #[test]
    fn strict_budget_requires_translated_pcm_authority_before_connect() {
        let env = HashMap::from([(
            MAX_SAMPLES_ENV.to_string(),
            "2880000".to_string(),
        )]);
        let error = TranslatedPcmAuthority::from_environment(
            "inbound",
            1,
            "model",
            "protocol",
            |name| env.get(name).cloned(),
        )
        .expect_err("missing authority path must fail");
        assert!(error.contains(AUTHORITY_DIR_ENV));
    }

    #[test]
    fn accepted_complete_cue_is_bound_to_exact_pcm_and_metadata() {
        let root = tempdir().expect("tempdir");
        let mut authority = create_authority(root.path());
        let samples = vec![100_i16, -200, 300, -400];
        authority
            .accept_complete_cue("cue-1", "request-1", &samples, 24_000, 1, 4, 11)
            .expect("accepted cue");
        authority.finalize("test-completed").expect("finalize");

        let directory = root.path().join("authority");
        let summary: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("translated-cue-pcm-summary.json"))
                .expect("summary"),
        )
        .expect("summary JSON");
        assert_eq!(summary["cueCount"], 1);
        assert_eq!(summary["acceptedCues"][0]["cueId"], "cue-1");
        assert_eq!(summary["acceptedCues"][0]["acceptedFrames"], 4);
        assert_eq!(summary["acceptedCues"][0]["chunks"][0]["chunkIndex"], 0);
        assert_eq!(summary["acceptedCues"][0]["chunks"][0]["sampleOffset"], 0);
        assert_eq!(summary["acceptedCues"][0]["chunks"][0]["sampleCount"], 4);
        assert_eq!(summary["activeStreamCount"], 0);
        assert_eq!(summary["finalized"], true);
        let relative = summary["acceptedCues"][0]["relativePath"]
            .as_str()
            .expect("relative path");
        let bytes = std::fs::read(directory.join(relative)).expect("PCM");
        assert_eq!(bytes, [100_i16, -200, 300, -400].iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>());
        assert_eq!(summary["acceptedCues"][0]["sha256"], format!("{:x}", Sha256::digest(&bytes)));
    }

    #[test]
    fn accepted_stream_is_aggregated_only_after_ordered_end() {
        let root = tempdir().expect("tempdir");
        let mut authority = create_authority(root.path());
        authority
            .accept_stream_write(
                "cue-stream",
                "request-start",
                &[1, 2],
                24_000,
                1,
                2,
                0,
                TranslationStreamState::Start,
                12,
            )
            .expect("start");
        authority
            .accept_stream_write(
                "cue-stream",
                "request-chunk",
                &[3, 4, 5],
                24_000,
                1,
                3,
                1,
                TranslationStreamState::Chunk,
                12,
            )
            .expect("chunk");
        let error = authority
            .accept_stream_write(
                "cue-stream",
                "request-bad-end",
                &[],
                24_000,
                1,
                0,
                3,
                TranslationStreamState::End,
                12,
            )
            .expect_err("out-of-order end");
        assert!(error.contains("sequence mismatch"));
        authority
            .accept_stream_write(
                "cue-stream",
                "request-end",
                &[],
                24_000,
                1,
                0,
                2,
                TranslationStreamState::End,
                12,
            )
            .expect("end");
        authority.finalize("test-completed").expect("finalize");
        let summary: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                root.path()
                    .join("authority/translated-cue-pcm-summary.json"),
            )
            .expect("summary"),
        )
        .expect("summary JSON");
        assert_eq!(summary["acceptedCues"][0]["sampleCount"], 5);
        assert_eq!(summary["acceptedCues"][0]["chunkCount"], 2);
        assert_eq!(summary["acceptedCues"][0]["chunks"].as_array().unwrap().len(), 2);
        assert_eq!(summary["acceptedCues"][0]["chunks"][1]["chunkIndex"], 1);
        assert_eq!(summary["acceptedCues"][0]["chunks"][1]["sampleOffset"], 2);
        assert_eq!(summary["acceptedCues"][0]["chunks"][1]["sampleCount"], 3);
        assert_eq!(summary["acceptedCues"][0]["requestIds"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn duplicate_cue_and_partial_ack_are_rejected() {
        let root = tempdir().expect("tempdir");
        let mut authority = create_authority(root.path());
        authority
            .accept_complete_cue("cue", "request", &[1, 2], 24_000, 1, 2, 1)
            .expect("first cue");
        assert!(authority
            .accept_complete_cue("cue", "request-2", &[1, 2], 24_000, 1, 2, 1)
            .expect_err("duplicate")
            .contains("duplicate"));
        assert!(authority
            .accept_complete_cue("cue-2", "request-3", &[1, 2], 24_000, 1, 1, 1)
            .expect_err("partial ack")
            .contains("mismatch"));
    }
}
