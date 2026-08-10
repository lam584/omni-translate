use std::time::{Duration, Instant};

/// Render-reference event emitted by the same WASAPI client that owns physical
/// playback. Each frame carries the exact submit position and same-client
/// endpoint padding observed immediately after the device accepted it.
pub(crate) enum SpeakerRenderEvent<'a> {
    Discontinuity {
        reason: &'static str,
        observed_at: Instant,
    },
    Frame {
        samples: &'a [f32],
        sample_rate_hz: u32,
        channel_count: u16,
        player_position: Duration,
        submitted_frames: u64,
        endpoint_padding_frames: u32,
        /// Physical silence inserted before this cue's first audible sample.
        /// It comes from the device-bound PCM, not diagnostics.
        physical_prefix_offset_frames: u32,
        observed_at: Instant,
    },
    AecLiveScenarioStage {
        status: &'static str,
        stage: &'static str,
        ordinal: u64,
        delay_ms: u32,
        nonlinearity: &'static str,
        reference_frames: u64,
        physical_frames: u64,
        changed_samples: u64,
        changed_ratio: f64,
        started_at_ms: u64,
        completed_at_ms: u64,
    },
}
