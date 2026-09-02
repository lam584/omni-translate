use super::*;

pub(super) async fn wait_for_local_playback_quiescence(
    app: &AppHandle,
    configured_watchdog: Duration,
) -> Result<LocalPlaybackDrainEvidence, String> {
    let state = app.state::<AudioStateStore>();
    let speaker_playback_active = state.inbound_speaker_playback_active();
    let initial = state.translation_playback_quiescence().snapshot();
    let (initial_pending_audio_frames, output_sample_rate_hz) =
        local_playback_drain_authority(speaker_playback_active, initial);
    let estimated_pending_audio_duration = local_playback_drain_estimate(
        initial_pending_audio_frames,
        output_sample_rate_hz,
    );
    let started = Instant::now();
    let mut confirmation = PlaybackDrainConfirmation::new(LOCAL_PLAYBACK_IDLE_CONFIRMATION);
    loop {
        let state = app.state::<AudioStateStore>();
        let speaker_playback_active = state.inbound_speaker_playback_active();
        let snapshot = state.translation_playback_quiescence().snapshot();
        let now = Instant::now();
        let waited = now.saturating_duration_since(started);
        if waited >= configured_watchdog {
            return Err(format!(
                "translated playback did not remain quiescent for {}ms within the {}ms playback-drain watchdog (initialPendingFrames={:?}, outputRateHz={:?}, estimatedPendingAudioMs={:?}, finalPendingNativeAudio={}, finalQueuedCommands={}, finalActiveCommands={}, finalPendingFrames={:?}, finalPendingSubmissions={}, finalPendingBridgeAcks={}, finalActiveBridgeCues={}, finalRestartBarrier={}, finalSpeakerPlaybackActive={})",
                LOCAL_PLAYBACK_IDLE_CONFIRMATION.as_millis(),
                configured_watchdog.as_millis(),
                initial_pending_audio_frames,
                output_sample_rate_hz,
                estimated_pending_audio_duration.map(|duration| duration.as_millis()),
                snapshot.pending_native_audio,
                snapshot.queued_commands,
                snapshot.active_commands,
                snapshot.pending_audio_frames,
                snapshot.pending_playback_submissions,
                snapshot.pending_bridge_acks,
                snapshot.active_bridge_cues,
                snapshot.restart_barrier,
                speaker_playback_active,
            ));
        }
        let quiescent = process_exclusion_restart_is_quiescent(speaker_playback_active, snapshot);
        if confirmation.observe(now, quiescent) {
            return Ok(LocalPlaybackDrainEvidence {
                watchdog: configured_watchdog,
                waited,
                initial_pending_audio_frames,
                output_sample_rate_hz,
                estimated_pending_audio_duration,
                final_snapshot: snapshot,
            });
        }
        tokio::time::sleep(INPUT_COMPLETE_POLL).await;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct LocalPlaybackDrainEvidence {
    pub(super) watchdog: Duration,
    pub(super) waited: Duration,
    pub(super) initial_pending_audio_frames: Option<u64>,
    pub(super) output_sample_rate_hz: Option<u32>,
    pub(super) estimated_pending_audio_duration: Option<Duration>,
    pub(super) final_snapshot: TranslationPlaybackQuiescenceSnapshot,
}

pub(super) fn local_playback_drain_authority(
    _speaker_playback_active: bool,
    snapshot: TranslationPlaybackQuiescenceSnapshot,
) -> (Option<u64>, Option<u32>) {
    let unknown_bridge_owner = snapshot.pending_bridge_acks > 0
        || snapshot.active_bridge_cues > 0
        || snapshot.restart_barrier;
    if unknown_bridge_owner
        && (snapshot.pending_audio_frames.is_none()
            || snapshot.output_sample_rate_hz.is_none())
    {
        return (None, None);
    }
    (snapshot.pending_audio_frames, snapshot.output_sample_rate_hz)
}

pub(super) fn local_playback_drain_estimate(
    pending_audio_frames: Option<u64>,
    output_sample_rate_hz: Option<u32>,
) -> Option<Duration> {
    let (Some(frames), Some(sample_rate_hz)) =
        (pending_audio_frames, output_sample_rate_hz.filter(|rate| *rate > 0))
    else {
        return None;
    };
    let audio_millis = u128::from(frames)
        .saturating_mul(1_000)
        .saturating_add(u128::from(sample_rate_hz) - 1)
        / u128::from(sample_rate_hz);
    Some(Duration::from_millis(
        audio_millis.min(u128::from(u64::MAX)) as u64,
    ))
}
