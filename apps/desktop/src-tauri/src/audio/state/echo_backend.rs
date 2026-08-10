use super::*;

const MAX_ECHO_RENDER_REFERENCE_LEAD_FRAMES: u64 =
    crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ as u64;

impl AudioStateStore {
    pub(crate) fn push_echo_reference_at(
        &self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        player_position: Duration,
        render_time: Instant,
    ) -> Result<(), String> {
        {
            let mut clock = self
                .echo_render_clock
                .lock()
                .expect("echo render clock poisoned");
            if clock
                .last_player_position
                .is_some_and(|previous| player_position < previous)
            {
                clock.discontinuity_count = clock.discontinuity_count.saturating_add(1);
                clock.last_discontinuity_reason = Some("wasapi-render-position-regressed");
            }
            let reference_frames = samples.len() / usize::from(channel_count.max(1));
            let physical_prefix_offset_frames =
                clock.last_physical_prefix_offset_frames.unwrap_or(0);
            clock.last_reference_lead_frames = clock
                .last_submitted_frames
                .zip(clock.last_endpoint_padding_frames)
                .map(|(submitted, padding)| {
                    let played = submitted.saturating_sub(u64::from(padding));
                    let reference_start = submitted.saturating_sub(reference_frames as u64);
                    reference_start
                        .saturating_sub(played)
                        .saturating_add(u64::from(physical_prefix_offset_frames))
                        .min(MAX_ECHO_RENDER_REFERENCE_LEAD_FRAMES) as u32
                });
            clock.last_player_position = Some(player_position);
            clock.last_observed_at = Some(render_time);
        }
        if let Some(canceller) = self
            .echo_canceller
            .lock()
            .expect("echo canceller poisoned")
            .as_mut()
        {
            canceller.push_render_at(samples, sample_rate_hz, channel_count, render_time)?;
        }
        Ok(())
    }
    
    pub(crate) fn mark_echo_render_discontinuity(
        &self,
        reason: &'static str,
        observed_at: Instant,
    ) -> Result<(), String> {
        {
            let mut clock = self
                .echo_render_clock
                .lock()
                .expect("echo render clock poisoned");
            clock.last_player_position = None;
            clock.last_submitted_frames = None;
            clock.last_endpoint_padding_frames = None;
            clock.last_physical_prefix_offset_frames = None;
            clock.last_reference_lead_frames = None;
            clock.last_observed_at = Some(observed_at);
            clock.discontinuity_count = clock.discontinuity_count.saturating_add(1);
            clock.last_discontinuity_reason = Some(reason);
        }
        if let Some(canceller) = self
            .echo_canceller
            .lock()
            .expect("echo canceller poisoned")
            .as_mut()
        {
            canceller.reset()?;
        }
        Ok(())
    }
    
    pub(crate) fn echo_render_clock_snapshot(&self) -> EchoRenderClockSnapshot {
        let clock = self
            .echo_render_clock
            .lock()
            .expect("echo render clock poisoned");
        EchoRenderClockSnapshot {
            player_position: clock.last_player_position,
            submitted_frames: clock.last_submitted_frames,
            endpoint_padding_frames: clock.last_endpoint_padding_frames,
            reference_lead_frames: clock.last_reference_lead_frames,
            last_observed_at: clock.last_observed_at,
            discontinuity_count: clock.discontinuity_count,
            last_discontinuity_reason: clock.last_discontinuity_reason,
        }
    }

    pub(crate) fn observe_echo_render_endpoint(
        &self,
        submitted_frames: u64,
        endpoint_padding_frames: u32,
        physical_prefix_offset_frames: u32,
        observed_at: Instant,
    ) {
        let mut clock = self
            .echo_render_clock
            .lock()
            .expect("echo render clock poisoned");
        let played_frames = submitted_frames.saturating_sub(endpoint_padding_frames as u64);
        clock.last_player_position = Some(Duration::from_secs_f64(
            played_frames as f64 / crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ as f64,
        ));
        clock.last_submitted_frames = Some(submitted_frames);
        clock.last_endpoint_padding_frames = Some(endpoint_padding_frames);
        clock.last_physical_prefix_offset_frames = Some(physical_prefix_offset_frames);
        clock.last_observed_at = Some(observed_at);
    }
    
    pub(crate) fn activate_production_echo_canceller(
        &self,
    ) -> Result<EchoCancellerEngineStats, String> {
        let canceller = create_production_echo_canceller()?;
        let stats = canceller.stats();
        *self
            .echo_canceller
            .lock()
            .expect("echo canceller poisoned") = Some(canceller);
        Ok(stats)
    }
    
    pub(crate) fn process_echo_capture(
        &self,
        captured: &[f32],
        delay_samples: usize,
    ) -> Result<EchoCancellationResult, String> {
        self.echo_canceller
            .lock()
            .expect("echo canceller poisoned")
            .as_mut()
            .ok_or_else(|| {
                "WebRTC AEC3 production engine is not active; capture cannot be processed"
                    .to_string()
            })
            .and_then(|canceller| canceller.process_capture(captured, delay_samples))
    }
    
    pub(crate) fn reset_echo_canceller(&self) -> Result<(), String> {
        let mut guard = self
            .echo_canceller
            .lock()
            .expect("echo canceller poisoned");
        let canceller = guard.as_mut().ok_or_else(|| {
            "WebRTC AEC3 production engine is not active; reset is unavailable"
                .to_string()
        })?;
        canceller.reset()
    }

    pub(crate) fn record_aec3_capture_chunk(&self, playback_active: bool) {
        self.inner
            .lock()
            .expect("audio state poisoned")
            .echo_capture_diagnostics
            .record_aec3_capture(playback_active);
    }
    
    /// Engine identity and native AEC3 counters for the periodic summary.
    pub(crate) fn echo_canceller_stats(&self) -> Option<EchoCancellerEngineStats> {
        self.echo_canceller
            .lock()
            .expect("echo canceller poisoned")
            .as_ref()
            .map(ProductionEchoCanceller::stats)
    }
    }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_lead_excludes_the_current_ten_ms_frame_from_endpoint_padding() {
        let store = AudioStateStore::new();
        let observed_at = Instant::now();
        // 960 submitted, 840 padded => 120 already played. The current
        // reference starts at frame 480, so only 360 frames precede it; the
        // reference's own 480 frames must not enter the AEC delay hint.
        store.observe_echo_render_endpoint(960, 840, 0, observed_at);
        store
            .push_echo_reference_at(
                &vec![0.0; 480 * 2],
                crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ,
                crate::audio::echo_cancel::TARGET_CHANNEL_COUNT as u16,
                Duration::from_secs_f64(120.0 / 48_000.0),
                observed_at,
            )
            .expect("record render reference");

        let clock = store.echo_render_clock_snapshot();
        assert_eq!(clock.endpoint_padding_frames, Some(840));
        assert_eq!(clock.reference_lead_frames, Some(360));
    }

    #[test]
    fn actual_physical_prefix_is_added_to_the_reference_lead_and_bounded() {
        for (physical_prefix_offset_frames, expected_lead_frames) in [
            (0, 0),
            (3_840, 3_840),
            (7_680, 7_680),
            (u32::MAX, 48_000),
        ] {
            let store = AudioStateStore::new();
            let observed_at = Instant::now();
            store.observe_echo_render_endpoint(
                480,
                480,
                physical_prefix_offset_frames,
                observed_at,
            );
            store
                .push_echo_reference_at(
                    &vec![0.0; 480 * 2],
                    crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ,
                    crate::audio::echo_cancel::TARGET_CHANNEL_COUNT as u16,
                    Duration::ZERO,
                    observed_at,
                )
                .expect("record delayed render reference");

            let clock = store.echo_render_clock_snapshot();
            assert_eq!(
                clock.reference_lead_frames,
                Some(expected_lead_frames)
            );
        }
    }
}
