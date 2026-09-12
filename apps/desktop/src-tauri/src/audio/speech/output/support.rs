use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::VecDeque;

use super::{AudioClient, SpeakerRenderEvent, RENDER_POSITION_POLL_MS};

static NEXT_RENDER_SESSION_ID: AtomicU64 = AtomicU64::new(1);

pub(super) fn next_render_session_id() -> u64 {
    NEXT_RENDER_SESSION_ID.fetch_add(1, Ordering::Relaxed)
}

pub(super) fn f32_samples_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * size_of::<f32>());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

pub(super) fn audio_frames_to_duration(frame_count: usize) -> Duration {
    Duration::from_secs_f64(frame_count as f64 / super::SPEAKER_SAMPLE_RATE_HZ as f64)
}

pub(super) fn playback_volume(output_level: u64) -> f32 {
    output_level.min(100) as f32 / 100.0
}

pub(super) fn publish_render_stream_started<F>(
    stream_started_authority: &mut bool,
    session_id: u64,
    endpoint_id: &str,
    renderer_instance_id: &str,
    owner_generation: u64,
    on_render_event: &mut F,
) -> Result<(), String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
{
    if *stream_started_authority {
        return Ok(());
    }
    on_render_event(SpeakerRenderEvent::Discontinuity {
        reason: crate::audio::state::EchoRenderBoundary::StreamStarted {
            session_id,
            endpoint_id,
            renderer_instance_id,
            owner_generation,
        },
        observed_at: Instant::now(),
    })?;
    *stream_started_authority = true;
    Ok(())
}

struct DeferredRenderFrame {
    render_session_id: u64,
    samples: Vec<f32>,
    sample_rate_hz: u32,
    channel_count: u16,
    player_position: Duration,
    submitted_frames: u64,
    endpoint_padding_frames: u32,
    physical_prefix_offset_frames: u32,
    observed_at: Instant,
}

impl DeferredRenderFrame {
    fn publish<F>(&self, on_render_event: &mut F) -> Result<(), String>
    where
        F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
    {
        on_render_event(SpeakerRenderEvent::Frame {
            render_session_id: self.render_session_id,
            samples: &self.samples,
            sample_rate_hz: self.sample_rate_hz,
            channel_count: self.channel_count,
            player_position: self.player_position,
            submitted_frames: self.submitted_frames,
            endpoint_padding_frames: self.endpoint_padding_frames,
            physical_prefix_offset_frames: self.physical_prefix_offset_frames,
            observed_at: self.observed_at,
        })
    }
}

#[derive(Default)]
pub(super) struct DeferredRenderFrames {
    frames: VecDeque<DeferredRenderFrame>,
}

impl DeferredRenderFrames {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn defer(
        &mut self,
        render_session_id: u64,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        player_position: Duration,
        submitted_frames: u64,
        endpoint_padding_frames: u32,
        physical_prefix_offset_frames: u32,
        observed_at: Instant,
    ) {
        self.frames.push_back(DeferredRenderFrame {
            render_session_id,
            samples: samples.to_vec(),
            sample_rate_hz,
            channel_count,
            player_position,
            submitted_frames,
            endpoint_padding_frames,
            physical_prefix_offset_frames,
            observed_at,
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn publish_or_defer<F>(
        &mut self,
        stream_started_authority: bool,
        render_session_id: u64,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        player_position: Duration,
        submitted_frames: u64,
        endpoint_padding_frames: u32,
        physical_prefix_offset_frames: u32,
        observed_at: Instant,
        on_render_event: &mut F,
    ) -> Result<(), String>
    where
        F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
    {
        if !stream_started_authority {
            self.defer(
                render_session_id,
                samples,
                sample_rate_hz,
                channel_count,
                player_position,
                submitted_frames,
                endpoint_padding_frames,
                physical_prefix_offset_frames,
                observed_at,
            );
            return Ok(());
        }
        DeferredRenderFrame {
            render_session_id,
            samples: samples.to_vec(),
            sample_rate_hz,
            channel_count,
            player_position,
            submitted_frames,
            endpoint_padding_frames,
            physical_prefix_offset_frames,
            observed_at,
        }
        .publish(on_render_event)
    }

    fn flush<F>(&mut self, on_render_event: &mut F) -> Result<(), String>
    where
        F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
    {
        while let Some(frame) = self.frames.pop_front() {
            if let Err(error) = frame.publish(on_render_event) {
                self.frames.push_front(frame);
                return Err(error);
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

pub(super) fn publish_render_stream_started_and_flush<F>(
    stream_started_authority: &mut bool,
    session_id: u64,
    endpoint_id: &str,
    renderer_instance_id: &str,
    owner_generation: u64,
    deferred_frames: &mut DeferredRenderFrames,
    on_render_event: &mut F,
) -> Result<(), String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
{
    publish_render_stream_started(
        stream_started_authority,
        session_id,
        endpoint_id,
        renderer_instance_id,
        owner_generation,
        on_render_event,
    )?;
    deferred_frames.flush(on_render_event)
}

pub(super) fn ensure_render_ownership(
    audio_client: &AudioClient,
    playback_permit: &super::super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
) -> Result<(), String> {
    match playback_permit.ensure_active() {
        Ok(()) => Ok(()),
        Err(error) => cancel_wasapi_render(audio_client, playback_permit, started, error),
    }
}

pub(super) fn wait_for_render_poll(
    audio_client: &AudioClient,
    playback_permit: &super::super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
) -> Result<(), String> {
    match playback_permit.wait_for_endpoint_poll(Duration::from_millis(RENDER_POSITION_POLL_MS)) {
        Ok(()) => Ok(()),
        Err(error) => cancel_wasapi_render(audio_client, playback_permit, started, error),
    }
}

pub(super) fn submit_render_action<T>(
    audio_client: &AudioClient,
    playback_permit: &super::super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
    submit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match playback_permit.submit(submit) {
        Ok(value) => Ok(value),
        Err(error)
            if super::super::playback_ownership::desktop_playback_was_cancelled(&error) =>
        {
            cancel_wasapi_render(audio_client, playback_permit, started, error)?;
            unreachable!("cancel_wasapi_render always returns an error")
        }
        Err(error) => Err(error),
    }
}

fn cancel_wasapi_render(
    audio_client: &AudioClient,
    playback_permit: &super::super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
    cancellation: String,
) -> Result<(), String> {
    let stop_error = started
        .then(|| audio_client.stop_stream().err().map(|error| error.to_string()))
        .flatten();
    let reset_error = audio_client.reset_stream().err().map(|error| error.to_string());
    let cleanup_error = match (stop_error, reset_error) {
        (None, None) => None,
        (Some(stop), None) => Some(format!("IAudioClient::Stop failed: {stop}")),
        (None, Some(reset)) => Some(format!("IAudioClient::Reset failed: {reset}")),
        (Some(stop), Some(reset)) => Some(format!(
            "IAudioClient::Stop failed: {stop}; IAudioClient::Reset failed: {reset}"
        )),
    };
    if let Some(cleanup_error) = cleanup_error {
        playback_permit.record_cancellation_failure(cleanup_error.clone());
        return Err(format!("{cancellation}; {cleanup_error}"));
    }
    Err(cancellation)
}

#[derive(Default)]
pub(super) struct RenderUnderrunTracker {
    pub(super) reported_in_session: bool,
}

impl RenderUnderrunTracker {
    pub(super) fn observe(
        &mut self,
        started: bool,
        submitted_frames: usize,
        padding_frames: u32,
    ) -> bool {
        if !self.reported_in_session && started && submitted_frames > 0 && padding_frames == 0 {
            self.reported_in_session = true;
            return true;
        }
        false
    }
}
