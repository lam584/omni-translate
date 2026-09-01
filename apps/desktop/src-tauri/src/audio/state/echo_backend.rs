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
    
    /// Publishes a monotonic render-discontinuity identity and its reason.
    /// The capture worker is the sole owner of resetting AEC3 before it
    /// processes the next capture frame.
    pub(crate) fn mark_echo_render_discontinuity(
        &self,
        reason: &'static str,
        observed_at: Instant,
    ) -> Result<(), String> {
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

    struct ResetCountingEngine {
        reset_count: u64,
    }

    impl crate::audio::echo_cancel::EchoCancellerEngine for ResetCountingEngine {
        fn push_render_10ms(
            &mut self,
            _frame: &[f32],
            _render_time: Instant,
        ) -> Result<(), String> {
            Ok(())
        }

        fn process_capture_10ms(
            &mut self,
            frame: &[f32],
            _delay_samples: usize,
            _capture_time: Instant,
        ) -> Result<EchoCancellationResult, String> {
            Ok(EchoCancellationResult {
                samples: frame.to_vec(),
            })
        }

        fn reset(&mut self) -> Result<(), String> {
            self.reset_count = self.reset_count.saturating_add(1);
            Ok(())
        }

        fn stats(&self) -> EchoCancellerEngineStats {
            EchoCancellerEngineStats {
                backend: "webrtc-aec3",
                render_10ms_frames: 0,
                capture_10ms_frames: 0,
                reset_count: self.reset_count,
                rejected_frame_count: 0,
                stats_read_failure_count: 0,
                erle_db: None,
                residual_echo_likelihood: None,
                reported_delay_ms: None,
                double_talk_frames: None,
                render_underrun_count: 0,
                capture_underrun_count: 0,
                processing_call_count: 0,
                processing_time_micros_total: 0,
                max_processing_time_micros: 0,
            }
        }
    }

    #[test]
    fn render_discontinuity_is_reset_once_by_the_capture_owner() {
        let store = AudioStateStore::new();
        let canceller = crate::audio::echo_cancel::create_echo_canceller_for_test(Box::new(
            ResetCountingEngine { reset_count: 0 },
        ))
        .expect("install reset-counting AEC3 backend");
        *store
            .echo_canceller
            .lock()
            .expect("echo canceller poisoned") = Some(canceller);

        store
            .mark_echo_render_discontinuity("wasapi-render-underrun", Instant::now())
            .expect("publish render discontinuity");

        let published = store.echo_render_clock_snapshot();
        assert_eq!(published.discontinuity_count, 1);
        assert_eq!(
            published.last_discontinuity_reason,
            Some("wasapi-render-underrun")
        );
        assert_eq!(
            store
                .echo_canceller_stats()
                .expect("reset-counting AEC3 backend")
                .reset_count,
            0,
            "the render producer must publish identity and reason without resetting AEC3"
        );

        store
            .reset_echo_canceller()
            .expect("capture owner resets before processing capture");
        assert_eq!(
            store
                .echo_canceller_stats()
                .expect("reset-counting AEC3 backend")
                .reset_count,
            1
        );
    }

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
