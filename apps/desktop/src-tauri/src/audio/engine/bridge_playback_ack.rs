use std::io::Write;

use tauri::{AppHandle, Manager};

#[cfg(test)]
use super::bridge_source_io::bridge_translation_status_disposition;
use super::bridge_source_io::{
    bridge_translation_status_disposition_for_authority, record_bridge_translation_status,
    write_bridge_translation_status_ack, BridgeTranslationStatusDisposition,
};
use super::diag_log_detail;
use crate::audio::state::AudioStateStore;
use crate::bridge::state::BridgeStateStore;

#[cfg(test)]
fn acknowledged_status_mutates_terminal_state(
    disposition: BridgeTranslationStatusDisposition,
    active_session_id: Option<&str>,
    event_session_id: &str,
) -> bool {
    disposition == BridgeTranslationStatusDisposition::Apply
        && active_session_id == Some(event_session_id)
}

fn apply_acknowledged_status_to_terminal_state_for_owner(
    store: &AudioStateStore,
    disposition: BridgeTranslationStatusDisposition,
    authority: &crate::audio::state::TranslationPlaybackAuthority,
    cue_id: &str,
    status: &str,
    status_id: &str,
) -> Result<(), String> {
    if disposition != BridgeTranslationStatusDisposition::Apply {
        return Ok(());
    }
    let quiescence = store.translation_playback_quiescence();
    if !quiescence.bridge_playback_cue_matches_owner(cue_id, authority) {
        return Err("Bridge translation status did not match the cue playback authority".to_string());
    }
    if status == "completed" {
        store.record_strict_watch_renderer_ack(
            cue_id,
            "bridge-translation-status-ack",
            status_id,
        )?;
    }
    if !quiescence.observe_bridge_playback_status_for_owner(cue_id, status, authority)
    {
        return Err("Bridge translation status did not match the cue playback authority".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn apply_acknowledged_status_to_terminal_state(
    store: &AudioStateStore,
    disposition: BridgeTranslationStatusDisposition,
    active_session_id: Option<&str>,
    event_session_id: &str,
    cue_id: &str,
    status: &str,
    status_id: &str,
) -> Result<(), String> {
    if acknowledged_status_mutates_terminal_state(
        disposition,
        active_session_id,
        event_session_id,
    ) {
        if status == "completed" {
            store.record_strict_watch_renderer_ack(
                cue_id,
                "bridge-translation-status-ack",
                status_id,
            )?;
        }
        store
            .translation_playback_quiescence()
            .observe_bridge_playback_status(cue_id, status);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn handle_bridge_translation_status(
    app: &AppHandle,
    store: &AudioStateStore,
    source_pipe: &mut impl Write,
    status_id: &str,
    session_id: &str,
    bridge_instance_id: &str,
    source_generation: u64,
    source_generation_token: &str,
    playback_owner_generation: u64,
    physical_playback_device_id: &str,
    cue_id: &str,
    status: &str,
    reason: &str,
    error_code: Option<&str>,
    timestamp_ms: u64,
) -> bool {
    let quiescence = store.translation_playback_quiescence();
    let _ack_barrier = quiescence.begin_bridge_ack();
    let authority = crate::audio::state::TranslationPlaybackAuthority {
        session_id: session_id.to_string(),
        bridge_instance_id: bridge_instance_id.to_string(),
        source_generation,
        source_generation_token: source_generation_token.to_string(),
        playback_owner_generation,
        physical_playback_device_id: physical_playback_device_id.to_string(),
    };
    let bridge_snapshot = app.state::<BridgeStateStore>().snapshot();
    let active_session_id = bridge_snapshot.session_id.clone();
    let authority_matches = crate::bridge::ipc::BridgeTranslationSinkOwner::from_snapshot(
        &bridge_snapshot,
    )
    .is_some_and(|owner| owner.matches_playback_authority(&authority))
        && quiescence.bridge_playback_cue_matches_owner(cue_id, &authority);
    let disposition = bridge_translation_status_disposition_for_authority(
        store,
        status_id,
        authority_matches,
    );
    if disposition == BridgeTranslationStatusDisposition::Apply {
        record_bridge_translation_status(
            app,
            store,
            status_id,
            cue_id,
            status,
            reason,
            error_code,
            timestamp_ms,
        );
    } else {
        diag_log_detail(
            app,
            "bridge",
            "info",
            "event=translation_playback_status_idempotent_skip",
            format!(
                "statusId={status_id} cueId={cue_id} reason={} eventSessionId={session_id} activeSessionId={}",
                disposition.as_str(),
                active_session_id.as_deref().unwrap_or("-")
            ),
        );
    }
    if let Err(error) = write_bridge_translation_status_ack(source_pipe, status_id, &authority) {
        diag_log_detail(
            app,
            "audio",
            "warning",
            "Bridge translation status acknowledgement failed. Reconnecting.",
            error,
        );
        return false;
    }
    if let Err(error) = apply_acknowledged_status_to_terminal_state_for_owner(
        store,
        disposition,
        &authority,
        cue_id,
        status,
        status_id,
    ) {
        diag_log_detail(
            app,
            "audio",
            "error",
            "Strict Watch final renderer ACK authority failed.",
            error,
        );
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_replay_after_failed_ack_cannot_advance_a_new_session() {
        let store = AudioStateStore::new();
        let status_id = "bridge-status-ack-failed-before-session-switch";
        let quiescence = store.translation_playback_quiescence();
        quiescence.expect_bridge_playback_cue("old-cue");
        let first = bridge_translation_status_disposition(
            &store,
            Some("old-session"),
            status_id,
            "old-session",
        );
        assert_eq!(first, BridgeTranslationStatusDisposition::Apply);

        // The first delivery was accepted into the receipt ledger, but its
        // source-pipe ACK failed. Bridge then switches ownership before replay.
        let replay = bridge_translation_status_disposition(
            &store,
            Some("new-session"),
            status_id,
            "old-session",
        );
        assert_eq!(replay, BridgeTranslationStatusDisposition::DuplicateReplay);
        apply_acknowledged_status_to_terminal_state(
            &store,
            replay,
            Some("new-session"),
            "old-session",
            "old-cue",
            "completed",
            status_id,
        )
        .expect("duplicate replay remains an idempotent no-op");
        assert_eq!(quiescence.snapshot().active_bridge_cues, 1);
    }

    #[test]
    fn bridge_replay_with_mutated_payload_cannot_advance_terminal_state() {
        let store = AudioStateStore::new();
        let status_id = "bridge-status-mutated-replay";
        let quiescence = store.translation_playback_quiescence();
        quiescence.expect_bridge_playback_cue("cue-original");
        assert_eq!(
            bridge_translation_status_disposition(
                &store,
                Some("session-1"),
                status_id,
                "session-1",
            ),
            BridgeTranslationStatusDisposition::Apply,
        );

        // DuplicateReplay proves only that this statusId was seen before. It
        // does not prove that the replay retained the original cue/session/
        // status payload. Model a mutated replay that turns the original
        // non-terminal envelope into `completed` for the active cue.
        let replay = bridge_translation_status_disposition(
            &store,
            Some("session-1"),
            status_id,
            "session-1",
        );
        assert_eq!(replay, BridgeTranslationStatusDisposition::DuplicateReplay);
        apply_acknowledged_status_to_terminal_state(
            &store,
            replay,
            Some("session-1"),
            "session-1",
            "cue-original",
            "completed",
            status_id,
        )
        .expect("mutated duplicate replay remains an idempotent no-op");
        assert_eq!(quiescence.snapshot().active_bridge_cues, 1);
    }

    #[test]
    fn submitted_renderer_completed_status_records_ack_then_clears_quiescence() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .expect("strict lifecycle begins");
        store
            .record_strict_watch_renderer_cue_submitted("submitted-cue", "response-submitted")
            .expect("renderer cue submission records");
        let quiescence = store.translation_playback_quiescence();
        quiescence.expect_bridge_playback_cue("submitted-cue");

        apply_acknowledged_status_to_terminal_state(
            &store,
            BridgeTranslationStatusDisposition::Apply,
            Some("session-1"),
            "session-1",
            "submitted-cue",
            "completed",
            "submitted-status",
        )
        .expect("submitted cue completion is accepted");

        assert_eq!(quiescence.snapshot().active_bridge_cues, 0);
    }

    #[test]
    fn never_submitted_renderer_completed_status_cannot_clear_quiescence() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .expect("strict lifecycle begins");
        store
            .record_strict_watch_provider_append(480)
            .expect("provider append records");
        store
            .record_strict_watch_provider_input_closed()
            .expect("capture producer completion records");
        store
            .record_strict_watch_session_finish_sent()
            .expect("session.finish records");
        store
            .record_strict_watch_response_audio_done("response-1")
            .expect("response audio terminal records");
        store
            .record_strict_watch_response_done("response-1")
            .expect("response terminal records");
        store
            .record_strict_watch_session_finished_received()
            .expect("session.finished records");
        let quiescence = store.translation_playback_quiescence();
        quiescence.expect_bridge_playback_cue("never-submitted-cue");

        let result = apply_acknowledged_status_to_terminal_state(
            &store,
            BridgeTranslationStatusDisposition::Apply,
            Some("session-1"),
            "session-1",
            "never-submitted-cue",
            "completed",
            "never-submitted-status",
        );

        assert!(result.is_err(), "an unknown renderer cue must fail closed");
        assert_eq!(quiescence.snapshot().active_bridge_cues, 1);
        assert!(
            store.strict_watch_terminal_lifecycle_snapshot().is_err(),
            "an unknown cue must not become final renderer ACK authority"
        );
    }
}
