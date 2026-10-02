use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct EchoRenderClock {
    pub(super) last_player_position: Option<Duration>,
    pub(super) last_submitted_frames: Option<u64>,
    pub(super) last_endpoint_padding_frames: Option<u32>,
    /// Actual physical PCM prefix inserted ahead of the current reference.
    /// Zero during all normal/non-diagnostic playback.
    pub(super) last_physical_prefix_offset_frames: Option<u32>,
    /// Frames between the render observation and the first sample of the
    /// reference frame most recently passed to AEC3. Unlike endpoint padding,
    /// this excludes the reference frame itself.
    pub(super) last_reference_lead_frames: Option<u32>,
    pub(super) last_observed_at: Option<Instant>,
    pub(super) discontinuity_count: u64,
    /// Hard boundaries are independent of soft underrun timing resets.
    pub(super) hard_reset_generation: u64,
    pub(super) last_discontinuity_reason: Option<&'static str>,
    pub(super) render_authority_endpoint_id: Option<String>,
    pub(super) render_authority_renderer_instance_id: Option<String>,
    pub(super) render_authority_owner_generation: Option<u64>,
    pub(super) render_timeline_epoch: Option<u64>,
    pub(super) active_render_sessions: BTreeMap<u64, (String, String, u64, bool, Option<Duration>, Option<u64>)>,
}
impl EchoRenderClock {
    pub(super) fn publish_discontinuity(&mut self, reason: &'static str) {
        self.discontinuity_count = self.discontinuity_count.saturating_add(1);
        if reason != "wasapi-render-underrun" {
            self.hard_reset_generation = self.hard_reset_generation.saturating_add(1);
        }
        self.last_discontinuity_reason = Some(reason);
    }
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct EchoRenderClockSnapshot {
    pub(crate) player_position: Option<Duration>,
    pub(crate) submitted_frames: Option<u64>,
    pub(crate) endpoint_padding_frames: Option<u32>,
    pub(crate) reference_lead_frames: Option<u32>,
    pub(crate) timeline_epoch: Option<u64>,
    pub(crate) last_observed_at: Option<Instant>,
    pub(crate) discontinuity_count: u64,
    pub(crate) hard_reset_generation: u64,
    pub(crate) last_discontinuity_reason: Option<&'static str>,
}
