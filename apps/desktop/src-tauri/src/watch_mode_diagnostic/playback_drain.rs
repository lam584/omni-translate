use super::*;

pub(super) async fn wait_for_local_playback_quiescence(
    app: &AppHandle,
    configured_cap: Duration,
) -> Result<LocalPlaybackDrainEvidence, String> {
    let state = app.state::<AudioStateStore>();
    let speaker_playback_active = state.inbound_speaker_playback_active();
    let initial = state.translation_playback_quiescence().snapshot();
    let (initial_pending_audio_frames, output_sample_rate_hz) =
        local_playback_drain_authority(speaker_playback_active, initial);
    let budget = local_playback_drain_budget(
        initial_pending_audio_frames,
        output_sample_rate_hz,
        configured_cap,
    );
    let used_fallback_cap = initial_pending_audio_frames.is_none()
        || output_sample_rate_hz.is_none()
        || output_sample_rate_hz == Some(0);
    let started = Instant::now();
    let mut confirmation = PlaybackDrainConfirmation::new(LOCAL_PLAYBACK_IDLE_CONFIRMATION);
    loop {
        let state = app.state::<AudioStateStore>();
        let quiescent = process_exclusion_restart_is_quiescent(
            state.inbound_speaker_playback_active(),
            state.translation_playback_quiescence().snapshot(),
        );
        if confirmation.observe(Instant::now(), quiescent) {
            return Ok(LocalPlaybackDrainEvidence {
                budget,
                initial_pending_audio_frames,
                output_sample_rate_hz,
                used_fallback_cap,
            });
        }
        if started.elapsed() >= budget {
            return Err(format!(
                "translated playback did not remain quiescent for {}ms within the {}ms dynamic drain budget (pendingFrames={:?}, outputRateHz={:?}, fallbackCap={})",
                LOCAL_PLAYBACK_IDLE_CONFIRMATION.as_millis(),
                budget.as_millis(),
                initial_pending_audio_frames,
                output_sample_rate_hz,
                used_fallback_cap,
            ));
        }
        tokio::time::sleep(INPUT_COMPLETE_POLL).await;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct LocalPlaybackDrainEvidence {
    pub(super) budget: Duration,
    pub(super) initial_pending_audio_frames: Option<u64>,
    pub(super) output_sample_rate_hz: Option<u32>,
    pub(super) used_fallback_cap: bool,
}

pub(super) fn local_playback_drain_authority(
    _speaker_playback_active: bool,
    snapshot: TranslationPlaybackQuiescenceSnapshot,
) -> (Option<u64>, Option<u32>) {
    let unknown_bridge_owner = snapshot.pending_bridge_acks > 0
        || snapshot.active_bridge_cues > 0
        || snapshot.restart_barrier;
    if unknown_bridge_owner {
        return (None, None);
    }
    (snapshot.pending_audio_frames, snapshot.output_sample_rate_hz)
}

pub(super) fn local_playback_drain_budget(
    pending_audio_frames: Option<u64>,
    output_sample_rate_hz: Option<u32>,
    configured_cap: Duration,
) -> Duration {
    let bounded_cap = configured_cap
        .max(LOCAL_PLAYBACK_DRAIN_MIN_CAP)
        .min(LOCAL_PLAYBACK_DRAIN_MAX_CAP);
    let (Some(frames), Some(sample_rate_hz)) =
        (pending_audio_frames, output_sample_rate_hz.filter(|rate| *rate > 0))
    else {
        return bounded_cap;
    };
    let audio_millis = u128::from(frames)
        .saturating_mul(1_000)
        .saturating_add(u128::from(sample_rate_hz) - 1)
        / u128::from(sample_rate_hz);
    let audio_duration = Duration::from_millis(audio_millis.min(u128::from(u64::MAX)) as u64);
    audio_duration
        .saturating_add(LOCAL_PLAYBACK_DRAIN_MARGIN)
        .saturating_add(LOCAL_PLAYBACK_IDLE_CONFIRMATION)
        .min(bounded_cap)
}
