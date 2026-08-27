use std::time::SystemTime;

use tauri::{AppHandle, Runtime};

use super::{diag_log, elapsed_ms_since, AudioStateStore, OmniEventDiagnostics};

pub(super) fn resolve_audio_origin(
    provider_offset_ms: Option<u64>,
    provider_event_ms: u64,
    vad_event_count: u64,
    first_audible_chunk_ms: Option<u64>,
) -> (u64, &'static str) {
    if let Some(offset_ms) = provider_offset_ms {
        return (offset_ms, "provider-offset");
    }
    if vad_event_count == 1 {
        return first_audible_chunk_ms
            .map(|elapsed| (elapsed, "local-rms"))
            .unwrap_or((provider_event_ms, "provider-event"));
    }
    (provider_event_ms, "provider-event")
}

pub(super) fn record_provider_audio_origin(
    store: &AudioStateStore,
    cue_id: &str,
    direction: &str,
    provider_offset_ms: Option<u64>,
    provider_event_ms: u64,
    vad_event_count: u64,
    first_audible_chunk_ms: Option<u64>,
) {
    let (started_at_ms, origin) = resolve_audio_origin(
        provider_offset_ms,
        provider_event_ms,
        vad_event_count,
        first_audible_chunk_ms,
    );
    store.watch_session_report.record_audio_origin(
        cue_id, direction, started_at_ms, origin,
    );
}

pub(super) fn manual_origin_ms(
    turn_started_at: Option<&SystemTime>,
    session_started_at: &SystemTime,
) -> Option<u64> {
    turn_started_at?
        .duration_since(*session_started_at)
        .ok()
        .map(|elapsed| elapsed.as_millis() as u64)
}

pub(super) fn stage_committed_manual_origin(
    store: &AudioStateStore,
    started_at_ms: Option<u64>,
    committed: bool,
) {
    if committed {
        if let Some(started_at_ms) = started_at_ms {
            store.watch_session_report.stage_manual_audio_origin(started_at_ms);
        }
    }
}

pub(super) fn record_committed_manual_source_segment<R: Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    started_at_ms: Option<u64>,
    started_during_playback: Option<bool>,
    session_started_at: &SystemTime,
    event_diagnostics: &mut OmniEventDiagnostics,
) {
    let Some(started_during_playback) = started_during_playback else {
        return;
    };
    stage_committed_manual_origin(store, started_at_ms, true);
    event_diagnostics.begin_manual_source_segment(
        elapsed_ms_since(session_started_at),
        started_during_playback,
    );
    let _ = diag_log(
        app,
        "omni",
        "debug",
        format!(
            "event=manual_source_segment action=begin sourceStartedDuringPlayback={started_during_playback} sourceContinuityId={} sourceContinuityActive={}",
            event_diagnostics.source_continuity_id,
            event_diagnostics.source_continuity_active,
        ),
    );
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::{manual_origin_ms, resolve_audio_origin};

    #[test]
    fn provider_offset_precedes_local_rms_and_event_fallback() {
        assert_eq!(resolve_audio_origin(Some(120), 100, 1, Some(90)), (120, "provider-offset"));
        assert_eq!(resolve_audio_origin(None, 100, 1, Some(90)), (90, "local-rms"));
        assert_eq!(resolve_audio_origin(None, 100, 2, Some(90)), (100, "provider-event"));
    }

    #[test]
    fn manual_origin_preserves_the_first_successful_append_clock() {
        let session = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
        let turn = session + Duration::from_millis(275);
        assert_eq!(manual_origin_ms(Some(&turn), &session), Some(275));
    }
}
