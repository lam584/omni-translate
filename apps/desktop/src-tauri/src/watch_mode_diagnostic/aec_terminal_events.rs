//! Additional v4 owner evidence is separate from the unchanged legacy terminal path.
use tauri::{AppHandle, Manager};
use serde_json::json;
use crate::audio::state::{AudioStateStore, StrictWatchTerminalLifecycleSnapshot};
use super::terminal_authority::{InputCompleteMarker, StrictPaidTerminalConfig, TerminalAuthorityRecorder};
use super::unix_ms_now;

pub(super) fn append_aec_terminal_events(app: &AppHandle, config: &StrictPaidTerminalConfig,
    recorder: &mut TerminalAuthorityRecorder, lifecycle: &StrictWatchTerminalLifecycleSnapshot) -> Result<(), String> {
        let snapshot = app.state::<AudioStateStore>().strict_watch_open_input_snapshot()?;
        for (stage, evidence) in [("captureClosed", snapshot.capture_closed.as_ref()), ("lastOutput", snapshot.last_output.as_ref()), ("lastPhysicalCompleted", snapshot.last_physical_completed.as_ref())] {
            let Some(evidence) = evidence else { return Err(format!("aec-terminal-evidence-missing: {stage}")); };
            recorder.push(stage, evidence.observed_at_unix_ms, json!({
                "authority": evidence.owner_id, "runMarker": config.identity.run_marker,
                "cellId": config.identity.cell_id, "leaseId": config.identity.lease_id,
                "sourceSequence": evidence.source_sequence, "activityGeneration": evidence.activity_generation,
                "ownerId": evidence.owner_id,
            }));
        }
        let append = &lifecycle.last_provider_append;
        recorder.push("lastAppend", append.observed_at_unix_ms, json!({
            "authority": "desktop-provider-socket-send-owner", "runMarker": config.identity.run_marker,
            "cellId": config.identity.cell_id, "leaseId": config.identity.lease_id,
            "sourceSequence": append.source_sequence, "activityGeneration": snapshot.activity_generation,
            "appendIndex": append.append_index, "samples": append.samples, "acceptedSamplesTotal": append.accepted_samples_total,
        }));
        recorder.push("finishOutputChecked", unix_ms_now(), json!({
            "authority": "desktop-strict-terminal-ledger", "runMarker": config.identity.run_marker,
            "cellId": config.identity.cell_id, "leaseId": config.identity.lease_id,
            "sourceSequence": snapshot.source_sequence, "activityGeneration": snapshot.activity_generation,
            "sealedActivityGeneration": snapshot.output_quiescent.as_ref().map(|event| event.activity_generation),
            "phase": snapshot.phase, "inputOpen": snapshot.input_open, "providerInputOpen": snapshot.provider_input_open,
            "lastOutput": snapshot.last_output, "lastPhysicalCompleted": snapshot.last_physical_completed,
            "pendingSpeech": snapshot.pending_speech, "pendingResponses": snapshot.pending_responses,
            "pendingInputSegments": snapshot.pending_input_segments,
            "pendingRendererAcks": snapshot.pending_renderer_acks,
            "providerWritesAfterFinish": lifecycle.session_finished_received.provider_writes_after_finish,
        }));
    Ok(())
}

// Both policies keep the original marker disposition and legacy event payloads.
pub(super) fn append_input_completion_events(
    config: &StrictPaidTerminalConfig,
    recorder: &mut TerminalAuthorityRecorder,
    marker: &InputCompleteMarker,
) -> Result<(), String> {
    let Some(media_playback_completed_at_unix_ms) =
        marker.media_playback_completed_at_unix_ms
    else {
        return Err("input-complete marker is missing mediaPlaybackCompletedAtUnixMs".to_string());
    };
    recorder.push(
        if marker.disposition == "completed" {
            "mediaPlaybackCompleted"
        } else {
            "mediaPlaybackFailed"
        },
        media_playback_completed_at_unix_ms,
        json!({
            "authority": if config.completion_policy.is_some() { "runner-immutable-media-complete-marker" } else { "runner-input-complete-marker" },
            "disposition": marker.disposition,
            "failureReason": marker.failure_reason,
            "authoritativeTransformedReferenceFrames": marker.authoritative_transformed_reference_frames,
            "boundedCaptureGraceFrames": marker.bounded_capture_grace_frames,
            "maxExternalAudioSamples": marker.max_external_audio_samples,
        }),
    );
    recorder.push(
        "inputCompleteSignaled",
        marker.signaled_at_unix_ms,
        json!({
            "authority": if config.completion_policy.is_some() { "desktop-open-input-quiescent-marker-owner" } else { "runner-immutable-input-complete-marker" },
            "markerCompletedAtUnixMs": marker.completed_at_unix_ms,
        }),
    );
    Ok(())
}
