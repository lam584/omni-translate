use std::time::{Duration, Instant};

use wasapi::{
    calculate_period_100ns, AudioClient, DeviceEnumerator, Direction as WasapiDirection,
    SampleType, StreamMode, WaveFormat,
};

use super::{
    play_to_speaker_with_permit, resolve_wasapi_render_device, speaker_render_stage_error,
    SpeakerPlaybackReceipt, SpeakerRenderEvent, WasapiComApartment, RENDER_BUFFER_MS,
    SPEAKER_CHANNEL_COUNT, SPEAKER_SAMPLE_RATE_HZ,
};

pub(crate) struct SpeakerEndpointRecoveryPermit {
    playback_permit: super::super::playback_ownership::DesktopPlaybackPermit,
}

impl SpeakerEndpointRecoveryPermit {
    pub(crate) fn generation(&self) -> u64 {
        self.playback_permit.generation()
    }
}

pub(crate) fn wait_for_exact_speaker_endpoint_ready<F>(
    device_id: Option<&str>,
    playback_ownership: &super::super::playback_ownership::DesktopPlaybackOwnership,
    cue_id: &str,
    timeout: Duration,
    poll_interval: Duration,
    mut observe: F,
) -> Result<SpeakerEndpointRecoveryPermit, String>
where
    F: FnMut(u32, &str),
{
    let playback_permit = playback_ownership.acquire(cue_id, "native-omni-endpoint-recovery")?;
    let deadline = Instant::now() + timeout;
    let mut poll_index = 0_u32;
    loop {
        poll_index = poll_index.saturating_add(1);
        playback_permit.ensure_active()?;
        let readiness = probe_exact_speaker_endpoint(device_id);
        match readiness {
            Ok(resolved_id) => {
                observe(poll_index, &format!("ready endpoint_id={resolved_id}"));
                playback_permit.ensure_active()?;
                return Ok(SpeakerEndpointRecoveryPermit { playback_permit });
            }
            Err(error) => observe(poll_index, &error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "speaker endpoint readiness deadline exceeded after {poll_index} polls"
            ));
        }
        playback_permit.wait_for_endpoint_poll(poll_interval.min(remaining))?;
    }
}

fn probe_exact_speaker_endpoint(device_id: Option<&str>) -> Result<String, String> {
    let _com_apartment = WasapiComApartment::enter()
        .map_err(|error| speaker_render_stage_error("com-initialize", error))?;
    let enumerator = DeviceEnumerator::new()
        .map_err(|error| speaker_render_stage_error("device-enumerator", error))?;
    let device = resolve_wasapi_render_device(&enumerator, device_id)
        .map_err(|error| speaker_render_stage_error("endpoint-resolve", error))?;
    let resolved_id = device
        .get_id()
        .map_err(|error| speaker_render_stage_error("endpoint-id", error))?;
    if let Some(requested_id) = exact_requested_endpoint_id(device_id) {
        if resolved_id != requested_id {
            return Err(format!(
                "speaker-render-stage=endpoint-identity error=resolved endpoint mismatch requested={requested_id} resolved={resolved_id}"
            ));
        }
    }
    let state = device
        .get_state()
        .map_err(|error| speaker_render_stage_error("endpoint-state", error))?;
    if format!("{state:?}") != "Active" {
        return Err(format!(
            "speaker-render-stage=endpoint-state error=endpoint is not active state={state:?} id={resolved_id}"
        ));
    }
    probe_speaker_audio_client(device.get_iaudioclient().map_err(|error| {
        speaker_render_stage_error("readiness-audio-client", error)
    })?)?;
    Ok(resolved_id)
}

fn exact_requested_endpoint_id(device_id: Option<&str>) -> Option<&str> {
    device_id.filter(|id| {
        !matches!(
            id.trim(),
            "" | "default" | "speaker-default" | "system-output-default"
        )
    })
}

fn probe_speaker_audio_client(mut audio_client: AudioClient) -> Result<(), String> {
    let desired_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        SPEAKER_SAMPLE_RATE_HZ as usize,
        SPEAKER_CHANNEL_COUNT as usize,
        None,
    );
    let buffer_duration_hns = calculate_period_100ns(
        SPEAKER_SAMPLE_RATE_HZ as i64 * RENDER_BUFFER_MS / 1_000,
        SPEAKER_SAMPLE_RATE_HZ as i64,
    );
    audio_client
        .initialize_client(
            &desired_format,
            &WasapiDirection::Render,
            &StreamMode::PollingShared {
                autoconvert: true,
                buffer_duration_hns,
            },
        )
        .map_err(|error| {
            speaker_render_stage_error("readiness-audio-client-initialize", error)
        })?;
    audio_client
        .get_audiorenderclient()
        .map_err(|error| speaker_render_stage_error("readiness-render-client", error))?;
    let buffer_frames = audio_client
        .get_buffer_size()
        .map_err(|error| speaker_render_stage_error("readiness-buffer-size", error))?;
    if buffer_frames == 0 {
        return Err(
            "speaker-render-stage=readiness-buffer-size error=zero-frame buffer".to_string(),
        );
    }
    Ok(())
}

pub(crate) fn play_to_speaker<F>(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    device_id: Option<&str>,
    output_level: u64,
    playback_ownership: &super::super::playback_ownership::DesktopPlaybackOwnership,
    cue_id: &str,
    playback_source: &'static str,
    mut on_render_event: F,
) -> Result<SpeakerPlaybackReceipt, String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
{
    if samples.is_empty() {
        return Ok(SpeakerPlaybackReceipt {
            rendered_frames: 0,
            output_sample_rate_hz: SPEAKER_SAMPLE_RATE_HZ,
            output_channel_count: SPEAKER_CHANNEL_COUNT,
            physical_playback_device_id: device_id.unwrap_or_default().to_string(),
            renderer_instance_id: format!("desktop-process-{}", std::process::id()),
            renderer_owner_generation: 0,
        });
    }
    let playback_permit = playback_ownership.acquire(cue_id, playback_source)?;
    play_to_speaker_with_permit(
        samples,
        sample_rate_hz,
        channel_count,
        device_id,
        output_level,
        &playback_permit,
        cue_id,
        &mut on_render_event,
    )
}

pub(crate) fn retry_play_to_speaker_after_endpoint_ready<F>(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    device_id: Option<&str>,
    output_level: u64,
    recovery_permit: SpeakerEndpointRecoveryPermit,
    cue_id: &str,
    mut on_render_event: F,
) -> Result<SpeakerPlaybackReceipt, String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
{
    recovery_permit.playback_permit.ensure_active()?;
    play_to_speaker_with_permit(
        samples,
        sample_rate_hz,
        channel_count,
        device_id,
        output_level,
        &recovery_permit.playback_permit,
        cue_id,
        &mut on_render_event,
    )
}

#[cfg(test)]
mod tests {
    use super::exact_requested_endpoint_id;

    #[test]
    fn exact_endpoint_identity_excludes_only_supported_default_aliases() {
        assert_eq!(exact_requested_endpoint_id(Some("{endpoint-id}")), Some("{endpoint-id}"));
        assert_eq!(exact_requested_endpoint_id(Some("default")), None);
        assert_eq!(exact_requested_endpoint_id(Some("speaker-default")), None);
        assert_eq!(exact_requested_endpoint_id(Some("system-output-default")), None);
        assert_eq!(exact_requested_endpoint_id(None), None);
    }
}
