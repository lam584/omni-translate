use serde::Deserialize;
use serde_json::json;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use crate::audio::state::{AudioStateStore, StrictWatchOpenInputSnapshot, StrictWatchOpenInputPhase};
use super::terminal_authority::{ExpectedInputCompleteIdentity, InputCompleteMarker, StrictPaidTerminalConfig, TerminalAuthorityRecorder};

pub(super) const AEC_COMPLETION_POLICY: &str = "aec-output-quiescent-v2";
const QUIET_CONFIRMATION: Duration = Duration::from_secs(2);
const EXPECTED_SOURCE_SEGMENTS: usize = 6;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MediaCompleteMarker {
    pub(super) artifact_kind: String,
    pub(super) schema_version: u64,
    pub(super) media_sha256: String,
    pub(super) playback_process_id: u32,
    pub(super) playback_endpoint_id: String,
    pub(super) run_marker: String,
    pub(super) cell_id: String,
    pub(super) lease_id: String,
    pub(super) media_playback_started_at_unix_ms: u64,
    pub(super) media_playback_completed_at_unix_ms: u64,
    pub(super) authoritative_transformed_reference_frames: u64,
    pub(super) max_external_audio_samples: u64,
    #[serde(default)]
    pub(super) bounded_capture_grace_frames: Option<u64>,
    pub(super) expected_source_segments: Vec<String>,
}

pub(super) fn parse_media_complete_marker(bytes: &[u8], expected: &ExpectedInputCompleteIdentity) -> Result<MediaCompleteMarker, String> {
    let marker: MediaCompleteMarker = serde_json::from_slice(bytes).map_err(|error| format!("watch.aec-media-complete-invalid: {error}"))?;
    if marker.artifact_kind != "watch-mode-media-complete" || marker.schema_version != 2 {
        return Err("watch.aec-media-complete-schema-invalid".to_string());
    }
    if marker.run_marker != expected.run_marker || marker.cell_id != expected.cell_id || marker.lease_id != expected.lease_id {
        return Err("watch.aec-media-complete-identity-mismatch".to_string());
    }
    if marker.media_playback_started_at_unix_ms == 0 || marker.media_playback_completed_at_unix_ms < marker.media_playback_started_at_unix_ms {
        return Err("watch.aec-media-complete-timestamps-invalid".to_string());
    }
    if marker.authoritative_transformed_reference_frames != 2_013_045 || marker.max_external_audio_samples != 2_880_000
        || marker.bounded_capture_grace_frames.is_some_and(|grace| marker.authoritative_transformed_reference_frames.checked_add(grace) != Some(marker.max_external_audio_samples)) {
        return Err("watch.aec-media-complete-reference-budget-invalid".to_string());
    }
    if marker.media_sha256.len() != 64 || !marker.media_sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || marker.playback_process_id == 0 || marker.playback_endpoint_id.trim().is_empty() {
        return Err("watch.aec-media-playback-identity-invalid".to_string());
    }
    if marker.media_sha256 != super::source_coverage::MEDIA_SHA256 || marker.expected_source_segments != super::source_coverage::reference_segments(super::source_coverage::SOURCE_REFERENCE) {
        return Err("watch.aec-media-source-reference-mismatch".to_string());
    }
    if marker.expected_source_segments.len() != EXPECTED_SOURCE_SEGMENTS || marker.expected_source_segments.iter().any(|text| normalized_source(text).is_empty()) {
        return Err("watch.aec-media-complete-requires-six-source-segments".to_string());
    }
    Ok(marker)
}

fn normalized_source(text: &str) -> String {
    text.chars().filter(|ch| ch.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Deterministic policy reducer. The monotonic generation observes even an
/// entire output/playback burst occurring between two polling snapshots.
#[derive(Debug)]
pub(super) struct OpenInputDrain {
    deadline: Instant,
    generation: Option<u64>,
    quiet_since: Option<Instant>,
    quiet_start_append: Option<crate::audio::state::StrictWatchProviderAppendEvidence>,
}

impl OpenInputDrain {
    pub(super) fn new(started: Instant, watchdog: Duration) -> Self {
        Self { deadline: started + watchdog, generation: None, quiet_since: None, quiet_start_append: None }
    }

    pub(super) fn observe(&mut self, now: Instant, snapshot: &StrictWatchOpenInputSnapshot, playback_quiet: bool, source_covered: usize) -> Result<bool, String> {
        if now >= self.deadline { return Err("watch.aec-output-quiescence-timeout".to_string()); }
        if snapshot.phase != StrictWatchOpenInputPhase::Open || !snapshot.input_open || !snapshot.provider_input_open {
            return Err("watch.aec-input-closed-before-output-quiescence".to_string());
        }
        let generation_changed = self.generation != Some(snapshot.activity_generation);
        self.generation = Some(snapshot.activity_generation);
        let quiet = snapshot.session_updated && snapshot.media_complete.is_some()
            && snapshot.pending_speech == 0 && snapshot.pending_responses == 0
            && snapshot.pending_input_segments == 0
            && snapshot.pending_renderer_acks == 0 && snapshot.last_output.is_some()
            && snapshot.last_physical_completed.is_some() && playback_quiet
            && source_covered == EXPECTED_SOURCE_SEGMENTS;
        if !quiet { self.quiet_since = None; self.quiet_start_append = None; return Ok(false); }
        if generation_changed || self.quiet_since.is_none() { self.quiet_since = Some(now); self.quiet_start_append = snapshot.last_provider_append.clone(); }
        let last_activity_at = [&snapshot.last_input_speech, &snapshot.last_output, &snapshot.last_physical_started, &snapshot.last_physical_frame, &snapshot.last_physical_completed]
            .into_iter().filter_map(|event| event.as_ref().map(|event| event.observed_at_unix_ms)).max().unwrap_or(0);
        if self.quiet_start_append.as_ref().is_some_and(|append| append.observed_at_unix_ms < last_activity_at) {
            self.quiet_start_append = None;
        }
        if self.quiet_start_append.is_none() {
            self.quiet_start_append = snapshot.last_provider_append.as_ref().filter(|append| append.observed_at_unix_ms >= last_activity_at).cloned();
        }
        let since = self.quiet_since.get_or_insert(now);
        let send_window_covered = self.quiet_start_append.as_ref().zip(snapshot.last_provider_append.as_ref()).is_some_and(|(first, last)| {
            last.source_sequence > first.source_sequence && last.append_index > first.append_index
                && last.accepted_samples_total.saturating_sub(first.accepted_samples_total) >= 32_000
                && last.observed_at_unix_ms.saturating_sub(first.observed_at_unix_ms) >= 2_000
        });
        Ok(now.saturating_duration_since(*since) >= QUIET_CONFIRMATION && send_window_covered)
    }
}

pub(super) fn reject_runner_failure(config: &StrictPaidTerminalConfig) -> Result<(), String> {
    match std::fs::read(&config.input_complete_path) {
        Ok(bytes) => {
            let input = super::parse_input_complete_marker(&bytes, &config.identity)?;
            if input.disposition == "failed-incomplete" {
                Err(format!("runner-input-failed: {}", input.failure_reason.unwrap_or_default()))
            } else { Err("watch.aec-premature-input-complete-marker".to_string()) }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("watch.aec-input-marker-read-failed: {error}")),
    }
}

pub(super) async fn await_open_input_quiescence(app: &AppHandle, config: &StrictPaidTerminalConfig, recorder: &mut TerminalAuthorityRecorder) -> Result<InputCompleteMarker, String> {
    let started = Instant::now();
    let drain_started_at_unix_ms = super::unix_ms_now();
    let path = config.media_complete_path.as_deref().ok_or_else(|| "watch.aec-media-complete-path-missing".to_string())?;
    let (marker, original_bytes) = loop {
        reject_runner_failure(config)?;
        if started.elapsed() >= config.input_completion_watchdog { return Err("watch.aec-media-complete-timeout".to_string()); }
        match std::fs::read(path) {
            Ok(bytes) => { let marker = parse_media_complete_marker(&bytes, &config.identity)?; break (marker, bytes); }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("watch.aec-media-complete-read-failed: {error}")),
        }
        tokio::time::sleep(super::INPUT_COMPLETE_POLL).await;
    };
    if marker.media_playback_completed_at_unix_ms > super::unix_ms_now()
        || marker.media_playback_started_at_unix_ms < config.producer.started_at_unix_ms {
        return Err("watch.aec-media-complete-outside-producer-window".to_string());
    }
    let state = app.state::<AudioStateStore>();
    state.record_strict_watch_media_complete()?;
    let snapshot = state.strict_watch_open_input_snapshot()?;
    recorder.push("mediaComplete", marker.media_playback_completed_at_unix_ms, json!({
        "authority": "runner-immutable-media-complete-marker", "runMarker": marker.run_marker,
        "cellId": marker.cell_id, "leaseId": marker.lease_id, "schemaVersion": marker.schema_version,
        "mediaSha256": marker.media_sha256, "playbackProcessId": marker.playback_process_id, "playbackEndpointId": marker.playback_endpoint_id,
        "sourceSequence": snapshot.media_complete.as_ref().map(|event| event.source_sequence),
        "activityGeneration": snapshot.activity_generation,
        "mediaPlaybackStartedAtUnixMs": marker.media_playback_started_at_unix_ms,
        "mediaPlaybackCompletedAtUnixMs": marker.media_playback_completed_at_unix_ms,
        "authoritativeTransformedReferenceFrames": marker.authoritative_transformed_reference_frames,
        "maxExternalAudioSamples": marker.max_external_audio_samples,
        "expectedSourceSegments": marker.expected_source_segments,
        "inputOpen": true, "providerInputOpen": true,
    }));
    let mut drain = OpenInputDrain::new(started, config.input_completion_watchdog);
    loop {
        reject_runner_failure(config)?;
        if std::fs::read(path).map_err(|error| format!("watch.aec-media-marker-reread-failed: {error}"))? != original_bytes {
            return Err("watch.aec-media-marker-mutated".to_string());
        }
        let snapshot = state.strict_watch_open_input_snapshot()?;
        if snapshot.identity.run_marker != config.identity.run_marker || snapshot.identity.cell_id != config.identity.cell_id || snapshot.identity.lease_id != config.identity.lease_id {
            return Err("watch.aec-open-input-identity-mismatch".to_string());
        }
        let audio = state.snapshot();
        if !audio.stt_connected { return Err("watch.aec-provider-not-running".to_string()); }
        let playback = state.translation_playback_quiescence().snapshot();
        let playing = state.inbound_speaker_playback_context(Duration::ZERO).0;
        // Do not run a source LCS on each streaming delta while the provider or
        // renderer still owns work; that cannot advance completion and could
        // amplify a long active response into diagnostic CPU contention.
        let covered = if snapshot.pending_speech == 0 && snapshot.pending_responses == 0
            && snapshot.pending_renderer_acks == 0 && playback.is_quiescent() && !playing {
            let (source, translated) = state.watch_session_report.snapshot()
                .map(|report| super::source_coverage::accepted_report_text(&report)).unwrap_or_default();
            super::source_coverage::covered_segments(&marker.expected_source_segments, &source, &translated)
        } else { 0 };
        if drain.observe(Instant::now(), &snapshot, playback.is_quiescent() && !playing, covered)? {
            // Seal only the exact observed generation; a concurrent fresh output
            // makes approval fail rather than converting a stale snapshot to success.
            state.approve_strict_watch_output_quiescence(snapshot.activity_generation)?;
            let approved = state.strict_watch_open_input_snapshot()?;
            let evidence = approved.output_quiescent.as_ref().ok_or_else(|| "watch.aec-quiescent-evidence-missing".to_string())?;
            recorder.push("outputQuiescent", evidence.observed_at_unix_ms, json!({
                "authority": "desktop-open-input-drain-owner", "runMarker": config.identity.run_marker,
                "cellId": config.identity.cell_id, "leaseId": config.identity.lease_id,
                "sourceSequence": evidence.source_sequence, "activityGeneration": evidence.activity_generation,
                "inputCompletionWatchdogMs": config.input_completion_watchdog.as_millis(),
                "openInputDrainStartedAtUnixMs": drain_started_at_unix_ms,
                "stableForMs": QUIET_CONFIRMATION.as_millis(), "inputOpen": approved.input_open,
                "providerInputOpen": approved.provider_input_open, "sourceSegmentsCovered": covered,
                "expectedSourceSegments": EXPECTED_SOURCE_SEGMENTS, "pendingSpeech": snapshot.pending_speech,
                "pendingResponses": snapshot.pending_responses, "pendingRendererAcks": snapshot.pending_renderer_acks,
                "pendingInputSegments": snapshot.pending_input_segments,
                "pendingNativeAudio": playback.pending_native_audio, "queuedCommands": playback.queued_commands,
                "activeCommands": playback.active_commands, "pendingBridgeAcks": playback.pending_bridge_acks,
                "activeBridgeCues": playback.active_bridge_cues, "pendingAudioFrames": playback.pending_audio_frames,
                "pendingPlaybackSubmissions": playback.pending_playback_submissions, "restartBarrier": playback.restart_barrier,
                "lastInputSpeech": snapshot.last_input_speech, "lastOutput": snapshot.last_output,
                "lastPhysicalStarted": snapshot.last_physical_started, "lastPhysicalFrame": snapshot.last_physical_frame,
                "lastPhysicalCompleted": snapshot.last_physical_completed,
                "sendWindowStart": drain.quiet_start_append, "sendWindowEnd": snapshot.last_provider_append,
                "sendWindowSampleRateHz": 16000,
                "sendWindowSamples": snapshot.last_provider_append.as_ref().zip(drain.quiet_start_append.as_ref()).map(|(last, first)| last.accepted_samples_total.saturating_sub(first.accepted_samples_total)),
            }));
            let now = super::unix_ms_now();
            let input = InputCompleteMarker {
                artifact_kind: "watch-mode-input-complete".to_string(), schema_version: 1,
                run_marker: config.identity.run_marker.clone(), cell_id: config.identity.cell_id.clone(), lease_id: config.identity.lease_id.clone(),
                completed_at_unix_ms: now, signaled_at_unix_ms: now,
                disposition: "completed".to_string(), failure_reason: None,
                authoritative_transformed_reference_frames: Some(marker.authoritative_transformed_reference_frames),
                bounded_capture_grace_frames: marker.bounded_capture_grace_frames,
                media_playback_completed_at_unix_ms: Some(marker.media_playback_completed_at_unix_ms),
                max_external_audio_samples: Some(marker.max_external_audio_samples),
            };
            super::terminal_capture::write_json_immutable(&config.input_complete_path, "Runtime input-complete marker", &input)
                .map_err(|error| format!("watch.aec-input-complete-write-failed: {error}"))?;
            return Ok(input);
        }
        tokio::time::sleep(super::INPUT_COMPLETE_POLL).await;
    }
}
