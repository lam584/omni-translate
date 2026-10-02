//! Native playback admission and congestion diagnostics.
use super::*;

impl OmniEventProcessor {
    pub(super) fn record_stream_enqueue_rejection<R: tauri::Runtime>(
        app: &AppHandle<R>,
        outcome: &OmniPlaybackEnqueueOutcome,
        cue_id: &str,
        created_at_ms: u64,
        detail: &str,
    ) {
        let report = &app.state::<AudioStateStore>().watch_session_report;
        let observed_queue_age_ms = unix_ms().saturating_sub(created_at_ms);
        match outcome {
            OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::RealtimeBudget,
                projected_start_delay_ms,
                ..
            } => report.record_session_issue(
                "output",
                "native-playback-stream-stale-dropped",
                "warning",
                &format!(
                    "{detail} cueId={cue_id} predictedStartMs={projected_start_delay_ms} observedQueueAgeMs={observed_queue_age_ms} reason=stream-start-expired"
                ),
            ),
            OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::QueueFull,
                projected_start_delay_ms,
                ..
            } => report.record_session_issue(
                "output",
                "native-playback-stream-overflow",
                "error",
                &format!(
                    "{detail} cueId={cue_id} predictedStartMs={projected_start_delay_ms} observedQueueAgeMs={observed_queue_age_ms} reason=queue-full"
                ),
            ),
            OmniPlaybackEnqueueOutcome::Stopped => report.record_session_issue(
                "output",
                "native-playback-stream-stopped",
                "warning",
                detail,
            ),
            _ => {}
        }
    }

    pub(super) fn enqueue_playback_command<R: tauri::Runtime>(
        app: &AppHandle<R>,
        playback_queue: &OmniPlaybackQueue,
        command: impl FnOnce(
            Option<crate::bridge::ipc::BridgeTranslationSinkOwner>,
        ) -> OmniPlaybackCommand,
    ) -> OmniPlaybackEnqueueOutcome {
        let _submission_reservation = app.try_state::<AudioStateStore>().map(|audio_state| {
            audio_state
                .translation_playback_quiescence()
                .wait_for_restart_barrier()
        });
        let bridge_owner = app
            .try_state::<crate::bridge::state::BridgeStateStore>()
            .and_then(|state| {
                crate::bridge::ipc::BridgeTranslationSinkOwner::from_snapshot(&state.snapshot())
            });
        playback_queue.enqueue(command(bridge_owner))
    }
}
