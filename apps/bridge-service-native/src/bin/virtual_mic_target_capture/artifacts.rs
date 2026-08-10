use chrono::{SecondsFormat, Utc};
use omni_bridge_service::BRIDGE_PROTOCOL_VERSION;
use omni_bridge_protocol::{
    TranslationPlaybackStatusEvent, TranslationPlaybackStatusKind,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(super) const SAMPLE_RATE_HZ: u32 = 48_000;
pub(super) const CHANNEL_COUNT: u16 = 1;
pub(super) const BITS_PER_SAMPLE: u16 = 16;
pub(super) const BLOCK_ALIGN_BYTES: usize = 2;
pub(super) const FINGERPRINT_FREQUENCY_HZ: f32 = 997.0;
const MAX_CAPTURE_SAMPLE_DELTA: i32 = 1;
const FINGERPRINT_ANCHOR_COUNT: usize = 64;
const FINGERPRINT_FRAMES: usize = 24_000;
const CUE_LEAD_FRAMES: usize = 4_800;
const CUE_TAIL_FRAMES: usize = 4_800;
pub(super) const COLLECTOR_ID: &str = "omni-virtual-mic-target-capture";
pub(super) const COLLECTOR_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug)]
pub(super) struct Fingerprint {
    pub id: String,
    pub frequency_hz: f32,
    pub pcm: Vec<i16>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CueLifecycleEvidence {
    pub cue_id: String,
    pub queued_count: u64,
    pub started_count: u64,
    pub completed_count: u64,
    pub stale_dropped_count: u64,
    pub route_failed_count: u64,
    pub terminal_event_count: u64,
    pub terminal_status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CueStatusTimelineEventEvidence {
    #[serde(flatten)]
    pub event: TranslationPlaybackStatusEvent,
    pub collector_received_at_monotonic_ns: u64,
}

impl CueLifecycleEvidence {
    pub(super) fn from_timeline(
        cue_id: &str,
        session_id: &str,
        timeline: &[CueStatusTimelineEventEvidence],
    ) -> Result<Self, String> {
        let mut result = Self {
            cue_id: cue_id.to_string(),
            ..Self::default()
        };
        let mut seen_status_ids = HashMap::new();
        let mut unique_statuses = Vec::new();
        let mut previous_received_at = None;
        for observed in timeline {
            let event = &observed.event;
            if event.event_type != "bridge.translation.status"
                || event.status_id.trim().is_empty()
                || event.cue_id != cue_id
                || event.session_id != session_id
            {
                return Err(format!(
                    "virtual microphone status timeline is not bound to cue/session: {observed:?}"
                ));
            }
            if previous_received_at.is_some_and(|previous| {
                observed.collector_received_at_monotonic_ns <= previous
            }) {
                return Err(format!(
                    "collector status receipt timestamps are not strictly monotonic: {timeline:?}"
                ));
            }
            previous_received_at = Some(observed.collector_received_at_monotonic_ns);
            let raw_event = serde_json::to_string(event).map_err(|error| error.to_string())?;
            if let Some(previous) = seen_status_ids.get(&event.status_id) {
                if previous != &raw_event {
                    return Err(format!(
                        "Bridge reused statusId {} for different raw status events",
                        event.status_id
                    ));
                }
                continue;
            }
            seen_status_ids.insert(event.status_id.clone(), raw_event);
            unique_statuses.push(event.playback_status);
            match event.playback_status {
                TranslationPlaybackStatusKind::Queued => result.queued_count += 1,
                TranslationPlaybackStatusKind::Started => result.started_count += 1,
                TranslationPlaybackStatusKind::Completed => {
                    result.completed_count += 1;
                    result.terminal_event_count += 1;
                    result.terminal_status = "completed".to_string();
                }
                TranslationPlaybackStatusKind::StaleDropped => {
                    result.stale_dropped_count += 1;
                    result.terminal_event_count += 1;
                    result.terminal_status = "stale-dropped".to_string();
                }
                TranslationPlaybackStatusKind::RouteFailed => {
                    result.route_failed_count += 1;
                    result.terminal_event_count += 1;
                    result.terminal_status = "route-failed".to_string();
                }
            }
        }
        let ordered_statuses = unique_statuses
            .iter()
            .map(|status| status.as_str())
            .collect::<Vec<_>>();
        if ordered_statuses != ["queued", "started", "completed"] {
            return Err(format!(
                "virtual microphone raw status order was not queued/started/completed: {ordered_statuses:?}"
            ));
        }
        result.require_exactly_once_success()?;
        Ok(result)
    }

    pub(super) fn require_exactly_once_success(&self) -> Result<(), String> {
        if self.queued_count != 1
            || self.started_count != 1
            || self.completed_count != 1
            || self.stale_dropped_count != 0
            || self.route_failed_count != 0
            || self.terminal_event_count != 1
            || self.terminal_status != "completed"
        {
            return Err(format!(
                "virtual microphone cue lifecycle was not exactly-once queued/started/completed: {self:?}"
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawBridgeCounterEvidence {
    pub virtual_mic_frames_written: u64,
    pub playback_frames_written: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecomputedCounterDeltaEvidence {
    pub virtual_mic_frames_written: u64,
    pub playback_frames_written: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CollectorAuthorityEvidence {
    pub collector_id: String,
    pub collector_version: String,
    pub parent_collector_process_id: u32,
    pub capture_child_process_id: u32,
    pub bridge_protocol_version: String,
    pub bridge_process_id: u64,
    pub bridge_instance_id: String,
    pub bridge_session_id: String,
    pub capture_endpoint_id: String,
    pub capture_endpoint_name: String,
    pub raw_counters_before: RawBridgeCounterEvidence,
    pub raw_counters_after: RawBridgeCounterEvidence,
    pub recomputed_counter_delta: RecomputedCounterDeltaEvidence,
    pub cue_id: String,
    pub cue_status_timeline: Vec<CueStatusTimelineEventEvidence>,
    pub cue_lifecycle: CueLifecycleEvidence,
}

impl CollectorAuthorityEvidence {
    fn validate(&self) -> Result<(), String> {
        if self.collector_id != COLLECTOR_ID || self.collector_version != COLLECTOR_VERSION {
            return Err(format!(
                "virtual microphone evidence collector identity is invalid: {}/{}",
                self.collector_id, self.collector_version
            ));
        }
        if self.parent_collector_process_id == 0
            || self.capture_child_process_id == 0
            || self.bridge_process_id == 0
            || u64::from(self.parent_collector_process_id) == self.bridge_process_id
            || u64::from(self.capture_child_process_id) == self.bridge_process_id
            || self.parent_collector_process_id == self.capture_child_process_id
        {
            return Err("collector, capture child, and Bridge require distinct non-zero PIDs".to_string());
        }
        if self.bridge_protocol_version != BRIDGE_PROTOCOL_VERSION
            || self.bridge_instance_id.trim().is_empty()
            || self.bridge_session_id.trim().is_empty()
        {
            return Err("Bridge protocol/instance/session binding is incomplete".to_string());
        }
        if self.capture_endpoint_id.trim().is_empty()
            || self.capture_endpoint_name.trim().is_empty()
        {
            return Err("capture endpoint ID/name binding is incomplete".to_string());
        }
        let virtual_delta = self
            .raw_counters_after
            .virtual_mic_frames_written
            .checked_sub(self.raw_counters_before.virtual_mic_frames_written)
            .ok_or_else(|| "raw virtual-mic counter regressed".to_string())?;
        let physical_delta = self
            .raw_counters_after
            .playback_frames_written
            .checked_sub(self.raw_counters_before.playback_frames_written)
            .ok_or_else(|| "raw physical-playback counter regressed".to_string())?;
        if virtual_delta == 0
            || virtual_delta != self.recomputed_counter_delta.virtual_mic_frames_written
            || physical_delta != self.recomputed_counter_delta.playback_frames_written
            || physical_delta != 0
        {
            return Err(format!(
                "stored counter deltas do not match raw before/after counters: virtual={virtual_delta} physical={physical_delta}"
            ));
        }
        let lifecycle = CueLifecycleEvidence::from_timeline(
            &self.cue_id,
            &self.bridge_session_id,
            &self.cue_status_timeline,
        )?;
        if serde_json::to_value(&lifecycle).map_err(|error| error.to_string())?
            != serde_json::to_value(&self.cue_lifecycle).map_err(|error| error.to_string())?
        {
            return Err("stored cue lifecycle does not match raw status timeline".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TargetCaptureApplication {
    pub classification: String,
    pub name: String,
    pub process_id: u32,
    pub capture_api: String,
    pub opened_endpoint: bool,
    pub endpoint_id: String,
    pub endpoint_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaptureFormatEvidence {
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub bits_per_sample: u16,
    pub encoding: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FingerprintEvidence {
    pub id: String,
    pub detected: bool,
    pub frequency_hz: f32,
    pub start_frame: usize,
    pub frame_count: usize,
    pub expected_pcm_hex: String,
    pub expected_pcm_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaptureProbeEvidence {
    pub schema_version: u32,
    pub artifact_kind: String,
    pub captured_at: String,
    #[serde(flatten)]
    pub authority: CollectorAuthorityEvidence,
    pub target_capture_application: TargetCaptureApplication,
    pub format: CaptureFormatEvidence,
    pub capture_wav: String,
    pub capture_wav_sha256: String,
    pub captured_frames: usize,
    pub fingerprint: FingerprintEvidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeSnapshotEvidence {
    pub schema_version: u32,
    pub artifact_kind: String,
    pub captured_at: String,
    #[serde(flatten)]
    pub authority: CollectorAuthorityEvidence,
    pub virtual_mic_output_supported: bool,
    pub virtual_mic_output_status: String,
    pub virtual_mic_format: String,
    pub capture_wav: String,
    pub capture_wav_sha256: String,
    pub captured_frames: usize,
    pub fingerprint: FingerprintEvidence,
    pub virtual_mic_frames_written: u64,
    pub virtual_mic_frames_written_before: u64,
    pub virtual_mic_frames_written_after: u64,
    pub virtual_mic_frames_written_for_cue: u64,
    pub physical_playback_frames_written_before: u64,
    pub physical_playback_frames_written_after: u64,
    pub physical_playback_frames_written_for_cue: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EvidenceWriteResult {
    pub output_directory: String,
    pub capture_wav: String,
    pub capture_probe: String,
    pub runtime_snapshot: String,
    pub captured_frames: usize,
    pub capture_wav_sha256: String,
}

pub(super) fn captured_at_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn generate_fingerprint(id: String, mut seed: u64) -> Fingerprint {
    if seed == 0 {
        seed = 0x9e37_79b9_7f4a_7c15;
    }
    let phase_step = std::f32::consts::TAU * FINGERPRINT_FREQUENCY_HZ
        / SAMPLE_RATE_HZ as f32;
    let pcm = (0..FINGERPRINT_FRAMES)
        .map(|frame| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let watermark = 0.88 + (seed as u16 as f32 / u16::MAX as f32) * 0.12;
            let sample = (phase_step * frame as f32).sin() * 0.24 * watermark;
            (sample * i16::MAX as f32).round() as i16
        })
        .collect();
    Fingerprint {
        id,
        frequency_hz: FINGERPRINT_FREQUENCY_HZ,
        pcm,
    }
}

pub(super) fn build_cue_pcm(fingerprint: &Fingerprint) -> Vec<i16> {
    let mut cue = Vec::with_capacity(CUE_LEAD_FRAMES + fingerprint.pcm.len() + CUE_TAIL_FRAMES);
    cue.resize(CUE_LEAD_FRAMES, 0);
    cue.extend_from_slice(&fingerprint.pcm);
    cue.resize(cue.len() + CUE_TAIL_FRAMES, 0);
    cue
}

pub(super) fn pcm16_bytes(samples: &[i16]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}

pub(super) fn find_unique_fingerprint(
    captured_pcm: &[u8],
    fingerprint_pcm: &[u8],
) -> Result<usize, String> {
    if !captured_pcm.len().is_multiple_of(BLOCK_ALIGN_BYTES)
        || fingerprint_pcm.is_empty()
        || !fingerprint_pcm.len().is_multiple_of(BLOCK_ALIGN_BYTES)
    {
        return Err("captured or expected fingerprint PCM has invalid frame alignment".to_string());
    }

    let captured = captured_pcm
        .chunks_exact(BLOCK_ALIGN_BYTES)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    let fingerprint = fingerprint_pcm
        .chunks_exact(BLOCK_ALIGN_BYTES)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    if captured.len() < fingerprint.len() {
        return Err(
            "captured endpoint PCM does not contain the full Bridge fingerprint within one-LSB tolerance"
                .to_string(),
        );
    }

    // Windows shared-mode WASAPI can round an otherwise lossless PCM16 sample
    // by one least-significant bit during the endpoint's PCM16 -> float ->
    // PCM16 conversion. Locate candidates with sparse anchors, then require
    // every one of the 24,000 watermark samples to remain within that single
    // LSB. This keeps the full randomized fingerprint and uniqueness checks;
    // it does not turn the proof into a broad spectral or timing heuristic.
    let anchor_stride = (fingerprint.len() / FINGERPRINT_ANCHOR_COUNT).max(1);
    let mut anchors = (0..fingerprint.len())
        .step_by(anchor_stride)
        .collect::<Vec<_>>();
    if anchors.last().copied() != Some(fingerprint.len() - 1) {
        anchors.push(fingerprint.len() - 1);
    }
    let within_one_lsb = |actual: i16, expected: i16| {
        (i32::from(actual) - i32::from(expected)).abs() <= MAX_CAPTURE_SAMPLE_DELTA
    };
    let mut first = None;
    for start in 0..=captured.len() - fingerprint.len() {
        if !anchors
            .iter()
            .all(|index| within_one_lsb(captured[start + index], fingerprint[*index]))
        {
            continue;
        }
        if !(0..fingerprint.len())
            .all(|index| within_one_lsb(captured[start + index], fingerprint[index]))
        {
            continue;
        }
        if first.replace(start).is_some() {
            return Err("captured endpoint PCM contains the fingerprint more than once".to_string());
        }
    }
    let Some(first) = first else {
        return Err(
            "captured endpoint PCM does not contain the full Bridge fingerprint within one-LSB tolerance"
                .to_string(),
        );
    };
    Ok(first)
}

pub(super) fn require_fingerprint_spectrum(
    captured_pcm: &[u8],
    start_frame: usize,
    frame_count: usize,
    frequency_hz: f32,
) -> Result<(), String> {
    let target = pcm_tone_component(captured_pcm, start_frame, frame_count, frequency_hz)?;
    let side = pcm_tone_component(captured_pcm, start_frame, frame_count, frequency_hz - 211.0)?
        .max(pcm_tone_component(
            captured_pcm,
            start_frame,
            frame_count,
            frequency_hz + 211.0,
        )?);
    if target < 0.02 || target < side.max(0.001) * 4.0 {
        return Err(format!(
            "captured fingerprint spectrum is not isolated: target={target:.6} side={side:.6}"
        ));
    }
    Ok(())
}

fn pcm_tone_component(
    pcm: &[u8],
    start_frame: usize,
    frame_count: usize,
    frequency_hz: f32,
) -> Result<f32, String> {
    let end_frame = start_frame
        .checked_add(frame_count)
        .ok_or_else(|| "fingerprint frame range overflowed".to_string())?;
    if frame_count == 0 || end_frame.saturating_mul(BLOCK_ALIGN_BYTES) > pcm.len() {
        return Err("fingerprint spectrum range exceeds captured PCM".to_string());
    }
    let mut sine = 0.0_f64;
    let mut cosine = 0.0_f64;
    for index in 0..frame_count {
        let offset = (start_frame + index) * BLOCK_ALIGN_BYTES;
        let sample = i16::from_le_bytes(pcm[offset..offset + 2].try_into().unwrap()) as f64
            / 32_768.0;
        let phase = std::f64::consts::TAU * frequency_hz as f64 * index as f64
            / SAMPLE_RATE_HZ as f64;
        sine += sample * phase.sin();
        cosine += sample * phase.cos();
    }
    Ok((2.0 * sine.hypot(cosine) / frame_count as f64) as f32)
}

pub(super) fn build_wav(pcm: &[u8]) -> Result<Vec<u8>, String> {
    if pcm.is_empty() || !pcm.len().is_multiple_of(BLOCK_ALIGN_BYTES) {
        return Err("virtual microphone capture contains no complete PCM16 frames".to_string());
    }
    let data_len = u32::try_from(pcm.len())
        .map_err(|_| "virtual microphone capture is too large for RIFF/WAVE".to_string())?;
    let byte_rate = SAMPLE_RATE_HZ * u32::from(CHANNEL_COUNT) * u32::from(BITS_PER_SAMPLE / 8);
    let block_align = CHANNEL_COUNT * (BITS_PER_SAMPLE / 8);
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&CHANNEL_COUNT.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    Ok(wav)
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn pcm_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn decode_pcm_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err("expected fingerprint PCM hex is empty or misaligned".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|offset| {
            u8::from_str_radix(&value[offset..offset + 2], 16)
                .map_err(|_| "expected fingerprint PCM hex is not lowercase hexadecimal".to_string())
        })
        .collect()
}

fn validate_evidence_pair(
    probe: &CaptureProbeEvidence,
    snapshot: &RuntimeSnapshotEvidence,
    wav: &[u8],
) -> Result<(), String> {
    probe.authority.validate()?;
    snapshot.authority.validate()?;
    if serde_json::to_value(&probe.authority).map_err(|error| error.to_string())?
        != serde_json::to_value(&snapshot.authority).map_err(|error| error.to_string())?
    {
        return Err("capture probe and runtime snapshot authority fields diverged".to_string());
    }
    if probe.schema_version != 1
        || snapshot.schema_version != 1
        || probe.artifact_kind != "virtual-mic-real-capture-probe"
        || snapshot.artifact_kind != "virtual-mic-runtime-snapshot"
        || probe.captured_at != snapshot.captured_at
    {
        return Err("capture probe/runtime snapshot schema identity diverged".to_string());
    }
    let authority = &probe.authority;
    let target = &probe.target_capture_application;
    if target.classification != "real-target"
        || !target.opened_endpoint
        || target.process_id != authority.capture_child_process_id
        || target.endpoint_id != authority.capture_endpoint_id
        || target.endpoint_name != authority.capture_endpoint_name
    {
        return Err("target capture application is not bound to the authority record".to_string());
    }
    if probe.format.sample_rate_hz != SAMPLE_RATE_HZ
        || probe.format.channel_count != CHANNEL_COUNT
        || probe.format.bits_per_sample != BITS_PER_SAMPLE
        || probe.format.encoding != "pcm16"
        || snapshot.virtual_mic_format != "48000Hz/mono/pcm16"
        || !snapshot.virtual_mic_output_supported
        || snapshot.virtual_mic_output_status != "ready"
    {
        return Err("virtual microphone evidence format/capability is not canonical".to_string());
    }
    if probe.capture_wav != "virtual-mic-capture.wav"
        || probe.capture_wav_sha256 != sha256_hex(wav)
        || probe.captured_frames == 0
        || !probe.fingerprint.detected
        || probe.fingerprint.id.trim().is_empty()
        || probe.fingerprint.frequency_hz != FINGERPRINT_FREQUENCY_HZ
        || probe.fingerprint.frame_count != FINGERPRINT_FRAMES
        || probe.fingerprint.expected_pcm_sha256.len() != 64
        || probe
            .fingerprint
            .start_frame
            .checked_add(probe.fingerprint.frame_count)
            .is_none_or(|end| end > probe.captured_frames)
    {
        return Err("WAV/fingerprint evidence is incomplete or inconsistent".to_string());
    }
    let expected_pcm = decode_pcm_hex(&probe.fingerprint.expected_pcm_hex)?;
    if expected_pcm.len() != FINGERPRINT_FRAMES * BLOCK_ALIGN_BYTES
        || pcm_hex(&expected_pcm) != probe.fingerprint.expected_pcm_hex
        || sha256_hex(&expected_pcm) != probe.fingerprint.expected_pcm_sha256
    {
        return Err(
            "expected fingerprint PCM bytes/hash do not bind the pre-injection watermark"
                .to_string(),
        );
    }
    let captured_pcm = wav
        .get(44..)
        .ok_or_else(|| "capture WAV does not contain canonical PCM data".to_string())?;
    if probe.captured_frames != captured_pcm.len() / BLOCK_ALIGN_BYTES {
        return Err("capture WAV frame count diverged from the evidence record".to_string());
    }
    let recomputed_start = find_unique_fingerprint(captured_pcm, &expected_pcm)?;
    if recomputed_start != probe.fingerprint.start_frame {
        return Err(
            "declared fingerprint start frame diverged from the recomputed unique window"
                .to_string(),
        );
    }
    require_fingerprint_spectrum(
        captured_pcm,
        recomputed_start,
        probe.fingerprint.frame_count,
        probe.fingerprint.frequency_hz,
    )?;
    if snapshot.capture_wav != probe.capture_wav
        || snapshot.capture_wav_sha256 != probe.capture_wav_sha256
        || snapshot.captured_frames != probe.captured_frames
        || serde_json::to_value(&snapshot.fingerprint).map_err(|error| error.to_string())?
            != serde_json::to_value(&probe.fingerprint).map_err(|error| error.to_string())?
    {
        return Err("runtime snapshot WAV/fingerprint fields diverged from capture probe".to_string());
    }
    let before = &authority.raw_counters_before;
    let after = &authority.raw_counters_after;
    let delta = &authority.recomputed_counter_delta;
    if snapshot.virtual_mic_frames_written != after.virtual_mic_frames_written
        || snapshot.virtual_mic_frames_written_before != before.virtual_mic_frames_written
        || snapshot.virtual_mic_frames_written_after != after.virtual_mic_frames_written
        || snapshot.virtual_mic_frames_written_for_cue != delta.virtual_mic_frames_written
        || snapshot.physical_playback_frames_written_before != before.playback_frames_written
        || snapshot.physical_playback_frames_written_after != after.playback_frames_written
        || snapshot.physical_playback_frames_written_for_cue != delta.playback_frames_written
    {
        return Err("runtime snapshot counters diverged from raw collector counters".to_string());
    }
    Ok(())
}

pub(super) fn write_evidence(
    output_directory: &Path,
    captured_pcm: &[u8],
    probe: &mut CaptureProbeEvidence,
    snapshot: &mut RuntimeSnapshotEvidence,
) -> Result<EvidenceWriteResult, String> {
    let wav = build_wav(captured_pcm)?;
    probe.capture_wav_sha256 = sha256_hex(&wav);
    probe.captured_frames = captured_pcm.len() / BLOCK_ALIGN_BYTES;
    snapshot.capture_wav_sha256 = probe.capture_wav_sha256.clone();
    snapshot.captured_frames = probe.captured_frames;
    validate_evidence_pair(probe, snapshot, &wav)?;
    let paths = evidence_paths(output_directory);
    for path in [&paths.0, &paths.1, &paths.2] {
        if path.exists() {
            return Err(format!(
                "refusing to overwrite existing virtual microphone evidence: {}",
                path.display()
            ));
        }
    }
    fs::create_dir_all(output_directory).map_err(|error| error.to_string())?;
    write_new(&paths.0, &wav)?;
    let probe_json = serde_json::to_vec_pretty(probe).map_err(|error| error.to_string())?;
    if let Err(error) = write_new(&paths.1, &probe_json) {
        let _ = fs::remove_file(&paths.0);
        return Err(error);
    }
    let snapshot_json = serde_json::to_vec_pretty(snapshot).map_err(|error| error.to_string())?;
    if let Err(error) = write_new(&paths.2, &snapshot_json) {
        let _ = fs::remove_file(&paths.0);
        let _ = fs::remove_file(&paths.1);
        return Err(error);
    }
    Ok(EvidenceWriteResult {
        output_directory: output_directory.display().to_string(),
        capture_wav: paths.0.display().to_string(),
        capture_probe: paths.1.display().to_string(),
        runtime_snapshot: paths.2.display().to_string(),
        captured_frames: probe.captured_frames,
        capture_wav_sha256: probe.capture_wav_sha256.clone(),
    })
}

fn evidence_paths(output_directory: &Path) -> (PathBuf, PathBuf, PathBuf) {
    (
        output_directory.join("virtual-mic-capture.wav"),
        output_directory.join("virtual-mic-capture-probe.json"),
        output_directory.join("runtime-snapshot.json"),
    )
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("failed to create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed_status(
        sequence: u64,
        id: &str,
        kind: TranslationPlaybackStatusKind,
    ) -> CueStatusTimelineEventEvidence {
        CueStatusTimelineEventEvidence {
            event: TranslationPlaybackStatusEvent {
                event_type: "bridge.translation.status".to_string(),
                status_id: id.to_string(),
                request_id: format!("request-{id}"),
                session_id: "session".to_string(),
                cue_id: "cue".to_string(),
                playback_status: kind,
                reason: "mock-raw-status".to_string(),
                error_code: None,
                timestamp_ms: 1_000 + sequence,
            },
            collector_received_at_monotonic_ns: sequence * 1_000,
        }
    }

    fn complete_timeline() -> Vec<CueStatusTimelineEventEvidence> {
        vec![
            observed_status(1, "queued-status", TranslationPlaybackStatusKind::Queued),
            observed_status(2, "started-status", TranslationPlaybackStatusKind::Started),
            observed_status(3, "completed-status", TranslationPlaybackStatusKind::Completed),
        ]
    }

    fn valid_authority(virtual_frames: u64) -> CollectorAuthorityEvidence {
        let timeline = complete_timeline();
        let lifecycle = CueLifecycleEvidence::from_timeline("cue", "session", &timeline).unwrap();
        CollectorAuthorityEvidence {
            collector_id: COLLECTOR_ID.to_string(),
            collector_version: COLLECTOR_VERSION.to_string(),
            parent_collector_process_id: 10,
            capture_child_process_id: 20,
            bridge_protocol_version: BRIDGE_PROTOCOL_VERSION.to_string(),
            bridge_process_id: 30,
            bridge_instance_id: "bridge-instance".to_string(),
            bridge_session_id: "session".to_string(),
            capture_endpoint_id: "endpoint-id".to_string(),
            capture_endpoint_name: "Omni Translate Virtual Microphone".to_string(),
            raw_counters_before: RawBridgeCounterEvidence {
                virtual_mic_frames_written: 100,
                playback_frames_written: 9,
            },
            raw_counters_after: RawBridgeCounterEvidence {
                virtual_mic_frames_written: 100 + virtual_frames,
                playback_frames_written: 9,
            },
            recomputed_counter_delta: RecomputedCounterDeltaEvidence {
                virtual_mic_frames_written: virtual_frames,
                playback_frames_written: 0,
            },
            cue_id: "cue".to_string(),
            cue_status_timeline: timeline,
            cue_lifecycle: lifecycle,
        }
    }

    fn valid_pair(
        pcm: &[u8],
        fingerprint: &Fingerprint,
    ) -> (CaptureProbeEvidence, RuntimeSnapshotEvidence) {
        let authority = valid_authority(fingerprint.pcm.len() as u64);
        let mut probe = CaptureProbeEvidence {
            schema_version: 1,
            artifact_kind: "virtual-mic-real-capture-probe".to_string(),
            captured_at: "2026-08-10T00:00:00.000Z".to_string(),
            authority: authority.clone(),
            target_capture_application: TargetCaptureApplication {
                classification: "real-target".to_string(),
                name: "Omni Translate Virtual Microphone Target Capture".to_string(),
                process_id: authority.capture_child_process_id,
                capture_api: "WASAPI".to_string(),
                opened_endpoint: true,
                endpoint_id: authority.capture_endpoint_id.clone(),
                endpoint_name: authority.capture_endpoint_name.clone(),
            },
            format: CaptureFormatEvidence {
                sample_rate_hz: SAMPLE_RATE_HZ,
                channel_count: CHANNEL_COUNT,
                bits_per_sample: BITS_PER_SAMPLE,
                encoding: "pcm16".to_string(),
            },
            capture_wav: "virtual-mic-capture.wav".to_string(),
            capture_wav_sha256: sha256_hex(&build_wav(pcm).unwrap()),
            captured_frames: pcm.len() / BLOCK_ALIGN_BYTES,
            fingerprint: FingerprintEvidence {
                id: fingerprint.id.clone(),
                detected: true,
                frequency_hz: fingerprint.frequency_hz,
                start_frame: 0,
                frame_count: fingerprint.pcm.len(),
                expected_pcm_hex: pcm_hex(pcm),
                expected_pcm_sha256: sha256_hex(pcm),
            },
        };
        let snapshot = RuntimeSnapshotEvidence {
            schema_version: 1,
            artifact_kind: "virtual-mic-runtime-snapshot".to_string(),
            captured_at: probe.captured_at.clone(),
            authority,
            virtual_mic_output_supported: true,
            virtual_mic_output_status: "ready".to_string(),
            virtual_mic_format: "48000Hz/mono/pcm16".to_string(),
            capture_wav: probe.capture_wav.clone(),
            capture_wav_sha256: probe.capture_wav_sha256.clone(),
            captured_frames: probe.captured_frames,
            fingerprint: probe.fingerprint.clone(),
            virtual_mic_frames_written: 100 + fingerprint.pcm.len() as u64,
            virtual_mic_frames_written_before: 100,
            virtual_mic_frames_written_after: 100 + fingerprint.pcm.len() as u64,
            virtual_mic_frames_written_for_cue: fingerprint.pcm.len() as u64,
            physical_playback_frames_written_before: 9,
            physical_playback_frames_written_after: 9,
            physical_playback_frames_written_for_cue: 0,
        };
        probe.capture_wav_sha256 = sha256_hex(&build_wav(pcm).unwrap());
        (probe, snapshot)
    }

    #[test]
    fn generated_wav_contains_one_unique_fingerprint_window() {
        let fingerprint = generate_fingerprint("fingerprint-1".to_string(), 42);
        let mut captured = vec![0_u8; 2_000];
        let expected = pcm16_bytes(&fingerprint.pcm);
        captured.extend_from_slice(&expected);
        captured.extend_from_slice(&vec![0_u8; 2_000]);
        assert_eq!(find_unique_fingerprint(&captured, &expected).unwrap(), 1_000);
        require_fingerprint_spectrum(
            &captured,
            1_000,
            fingerprint.pcm.len(),
            fingerprint.frequency_hz,
        )
        .unwrap();
        let wav = build_wav(&captured).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48_000);
        assert_eq!(&wav[44..], captured);
        assert_eq!(sha256_hex(&wav).len(), 64);
    }

    #[test]
    fn fingerprint_match_tolerates_one_lsb_wasapi_quantization() {
        let fingerprint = generate_fingerprint("one-lsb".to_string(), 43);
        let quantized = fingerprint
            .pcm
            .iter()
            .enumerate()
            .map(|(index, sample)| {
                if index % 4 == 0 {
                    sample.saturating_add(1)
                } else if index % 4 == 1 {
                    sample.saturating_sub(1)
                } else {
                    *sample
                }
            })
            .collect::<Vec<_>>();
        let mut captured = vec![0_u8; 2_000];
        captured.extend_from_slice(&pcm16_bytes(&quantized));
        captured.extend_from_slice(&vec![0_u8; 2_000]);
        assert_eq!(
            find_unique_fingerprint(&captured, &pcm16_bytes(&fingerprint.pcm)).unwrap(),
            1_000
        );
    }

    #[test]
    fn fingerprint_match_rejects_two_lsb_sample_changes() {
        let fingerprint = generate_fingerprint("two-lsb".to_string(), 44);
        let changed = fingerprint
            .pcm
            .iter()
            .map(|sample| sample.saturating_add(2))
            .collect::<Vec<_>>();
        let error = find_unique_fingerprint(
            &pcm16_bytes(&changed),
            &pcm16_bytes(&fingerprint.pcm),
        )
        .unwrap_err();
        assert!(error.contains("does not contain"));
    }

    #[test]
    fn fingerprint_match_rejects_duplicate_full_watermarks() {
        let fingerprint = generate_fingerprint("duplicate".to_string(), 45);
        let expected = pcm16_bytes(&fingerprint.pcm);
        let mut captured = expected.clone();
        captured.extend_from_slice(&vec![0_u8; 2_000]);
        captured.extend_from_slice(&expected);
        let error = find_unique_fingerprint(&captured, &expected).unwrap_err();
        assert!(error.contains("more than once"));
    }

    #[test]
    fn fingerprint_match_rejects_truncated_or_silent_capture() {
        let fingerprint = generate_fingerprint("missing".to_string(), 46);
        let expected = pcm16_bytes(&fingerprint.pcm);
        let truncated = &expected[..expected.len() - BLOCK_ALIGN_BYTES];
        assert!(find_unique_fingerprint(truncated, &expected)
            .unwrap_err()
            .contains("does not contain"));
        let silence = vec![0_u8; expected.len() + 2_000];
        assert!(find_unique_fingerprint(&silence, &expected)
            .unwrap_err()
            .contains("does not contain"));
    }

    #[test]
    fn evidence_pair_recomputes_expected_pcm_hash_and_one_lsb_unique_window() {
        let fingerprint = generate_fingerprint("authority-window".to_string(), 47);
        let expected = pcm16_bytes(&fingerprint.pcm);
        let quantized = fingerprint
            .pcm
            .iter()
            .enumerate()
            .map(|(index, sample)| match index % 3 {
                0 => sample.saturating_add(1),
                1 => sample.saturating_sub(1),
                _ => *sample,
            })
            .collect::<Vec<_>>();
        let mut captured = vec![0_u8; 2_000];
        captured.extend_from_slice(&pcm16_bytes(&quantized));
        captured.extend_from_slice(&vec![0_u8; 2_000]);
        let wav = build_wav(&captured).unwrap();
        let (mut probe, mut snapshot) = valid_pair(&expected, &fingerprint);
        probe.fingerprint.start_frame = 1_000;
        snapshot.fingerprint = probe.fingerprint.clone();
        probe.capture_wav_sha256 = sha256_hex(&wav);
        probe.captured_frames = captured.len() / BLOCK_ALIGN_BYTES;
        snapshot.capture_wav_sha256 = probe.capture_wav_sha256.clone();
        snapshot.captured_frames = probe.captured_frames;
        validate_evidence_pair(&probe, &snapshot, &wav).unwrap();

        let mut forged_hash = probe.clone();
        forged_hash.fingerprint.expected_pcm_sha256 = "0".repeat(64);
        assert!(validate_evidence_pair(&forged_hash, &snapshot, &wav)
            .unwrap_err()
            .contains("pre-injection watermark"));

        let mut forged_pcm = probe.clone();
        let replacement = if &forged_pcm.fingerprint.expected_pcm_hex[2..4] == "ff" {
            "00"
        } else {
            "ff"
        };
        forged_pcm
            .fingerprint
            .expected_pcm_hex
            .replace_range(2..4, replacement);
        assert!(validate_evidence_pair(&forged_pcm, &snapshot, &wav).is_err());
    }

    #[test]
    fn lifecycle_deduplicates_stable_replay_but_rejects_new_duplicate_terminal() {
        let mut timeline = complete_timeline();
        let mut replay = timeline.last().unwrap().clone();
        replay.collector_received_at_monotonic_ns = 4_000;
        timeline.push(replay);
        CueLifecycleEvidence::from_timeline("cue", "session", &timeline).unwrap();
        timeline.push(observed_status(
            5,
            "second-completed-status",
            TranslationPlaybackStatusKind::Completed,
        ));
        assert!(CueLifecycleEvidence::from_timeline("cue", "session", &timeline).is_err());
    }

    #[test]
    fn route_failure_is_never_accepted_as_capture_evidence() {
        let timeline = vec![
            observed_status(1, "queued-status", TranslationPlaybackStatusKind::Queued),
            observed_status(2, "failed-status", TranslationPlaybackStatusKind::RouteFailed),
        ];
        assert!(CueLifecycleEvidence::from_timeline("cue", "session", &timeline).is_err());
    }

    #[test]
    fn fingerprint_seed_changes_the_exact_pcm_hash() {
        let first = generate_fingerprint("first".to_string(), 1);
        let second = generate_fingerprint("second".to_string(), 2);
        assert_ne!(sha256_hex(&pcm16_bytes(&first.pcm)), sha256_hex(&pcm16_bytes(&second.pcm)));
    }

    #[test]
    fn fingerprint_pcm_is_stable_through_the_bridge_unity_float_roundtrip() {
        let fingerprint = generate_fingerprint("roundtrip".to_string(), 99);
        let round_tripped = fingerprint
            .pcm
            .iter()
            .map(|sample| {
                let stereo_left = *sample as f32 / i16::MAX as f32;
                let stereo_right = stereo_left;
                let mono = (stereo_left + stereo_right) * 0.5;
                (mono * i16::MAX as f32).round() as i16
            })
            .collect::<Vec<_>>();
        assert_eq!(round_tripped, fingerprint.pcm);
    }

    #[test]
    fn mock_evidence_writer_emits_the_three_manual_schema_files_without_overwrite() {
        let output = tempfile::tempdir().unwrap();
        let fingerprint = generate_fingerprint("mock-fingerprint".to_string(), 7);
        let pcm = pcm16_bytes(&fingerprint.pcm);
        let (mut probe, mut snapshot) = valid_pair(&pcm, &fingerprint);
        let written = write_evidence(output.path(), &pcm, &mut probe, &mut snapshot).unwrap();
        assert!(Path::new(&written.capture_wav).is_file());
        assert!(Path::new(&written.capture_probe).is_file());
        assert!(Path::new(&written.runtime_snapshot).is_file());
        let probe_json: serde_json::Value =
            serde_json::from_slice(&fs::read(&written.capture_probe).unwrap()).unwrap();
        assert_eq!(probe_json["artifactKind"], "virtual-mic-real-capture-probe");
        assert_eq!(probe_json["targetCaptureApplication"]["classification"], "real-target");
        assert_eq!(probe_json["capturedFrames"], fingerprint.pcm.len());
        assert_eq!(probe_json["collectorId"], COLLECTOR_ID);
        assert_eq!(probe_json["collectorVersion"], COLLECTOR_VERSION);
        assert_eq!(probe_json["parentCollectorProcessId"], 10);
        assert_eq!(probe_json["captureChildProcessId"], 20);
        assert_eq!(probe_json["bridgeProcessId"], 30);
        assert_eq!(probe_json["bridgeProtocolVersion"], BRIDGE_PROTOCOL_VERSION);
        let timeline = probe_json["cueStatusTimeline"].as_array().unwrap();
        assert_eq!(timeline.len(), 3);
        for (index, expected_status) in ["queued", "started", "completed"].iter().enumerate() {
            assert_eq!(timeline[index]["sessionId"], "session");
            assert_eq!(timeline[index]["cueId"], "cue");
            assert_eq!(timeline[index]["playbackStatus"], *expected_status);
            assert!(!timeline[index]["statusId"].as_str().unwrap().is_empty());
            if index > 0 {
                assert!(timeline[index]["collectorReceivedAtMonotonicNs"].as_u64().unwrap()
                    > timeline[index - 1]["collectorReceivedAtMonotonicNs"].as_u64().unwrap());
            }
        }
        let snapshot_json: serde_json::Value =
            serde_json::from_slice(&fs::read(&written.runtime_snapshot).unwrap()).unwrap();
        for field in [
            "collectorId",
            "collectorVersion",
            "parentCollectorProcessId",
            "captureChildProcessId",
            "bridgeProcessId",
            "bridgeInstanceId",
            "bridgeSessionId",
            "captureEndpointId",
            "captureEndpointName",
            "rawCountersBefore",
            "rawCountersAfter",
            "recomputedCounterDelta",
            "cueStatusTimeline",
            "cueLifecycle",
            "captureWav",
            "captureWavSha256",
            "capturedFrames",
            "fingerprint",
        ] {
            assert_eq!(probe_json[field], snapshot_json[field], "field {field}");
        }
        assert!(write_evidence(output.path(), &pcm, &mut probe, &mut snapshot).is_err());
    }

    #[test]
    fn authoritative_pair_rejects_missing_pid_endpoint_delta_and_status() {
        let fingerprint = generate_fingerprint("negative-evidence".to_string(), 8);
        let pcm = pcm16_bytes(&fingerprint.pcm);
        let wav = build_wav(&pcm).unwrap();

        let (mut missing_pid, snapshot) = valid_pair(&pcm, &fingerprint);
        missing_pid.authority.capture_child_process_id = 0;
        assert!(validate_evidence_pair(&missing_pid, &snapshot, &wav).is_err());

        let (mut missing_endpoint, snapshot) = valid_pair(&pcm, &fingerprint);
        missing_endpoint.authority.capture_endpoint_id.clear();
        assert!(validate_evidence_pair(&missing_endpoint, &snapshot, &wav).is_err());

        let (mut wrong_delta, snapshot) = valid_pair(&pcm, &fingerprint);
        wrong_delta
            .authority
            .recomputed_counter_delta
            .virtual_mic_frames_written += 1;
        assert!(validate_evidence_pair(&wrong_delta, &snapshot, &wav).is_err());

        let (mut missing_status, snapshot) = valid_pair(&pcm, &fingerprint);
        missing_status.authority.cue_status_timeline.remove(1);
        assert!(validate_evidence_pair(&missing_status, &snapshot, &wav).is_err());
    }

    #[test]
    fn authoritative_pair_rejects_nonmonotonic_or_cross_document_timeline() {
        let fingerprint = generate_fingerprint("timeline-evidence".to_string(), 9);
        let pcm = pcm16_bytes(&fingerprint.pcm);
        let wav = build_wav(&pcm).unwrap();
        let (mut nonmonotonic, snapshot) = valid_pair(&pcm, &fingerprint);
        nonmonotonic.authority.cue_status_timeline[1]
            .collector_received_at_monotonic_ns = 500;
        assert!(validate_evidence_pair(&nonmonotonic, &snapshot, &wav).is_err());

        let (probe, mut divergent_snapshot) = valid_pair(&pcm, &fingerprint);
        divergent_snapshot.authority.capture_endpoint_id = "different-endpoint".to_string();
        assert!(validate_evidence_pair(&probe, &divergent_snapshot, &wav).is_err());
    }
}
