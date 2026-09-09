use std::time::Duration;
use std::sync::atomic::{AtomicU64, Ordering};

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
