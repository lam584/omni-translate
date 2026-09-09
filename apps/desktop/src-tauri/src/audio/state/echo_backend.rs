use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EchoRenderBoundary<'a> {
    SessionStarted {
        session_id: u64,
        endpoint_id: &'a str,
        renderer_instance_id: &'a str,
        owner_generation: u64,
    },
    SessionEnded {
        session_id: u64,
        endpoint_id: &'a str,
        renderer_instance_id: &'a str,
        owner_generation: u64,
        normally_drained: bool,
        stream_started: bool,
    },
    DeviceFault(&'static str),
}

impl EchoRenderBoundary<'_> {
    pub(crate) fn log_reason(self) -> &'static str {
        match self {
            Self::SessionStarted { .. } => "wasapi-render-session-start",
            Self::SessionEnded {
                normally_drained: true,
                ..
            } => "wasapi-render-session-drained",
            Self::SessionEnded {
                stream_started: false,
                ..
            } => "wasapi-render-aborted-before-stream-start",
            Self::SessionEnded { .. } => "wasapi-render-failed-after-stream-start",
            Self::DeviceFault(reason) => reason,
        }
    }
}

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
        reason: EchoRenderBoundary<'_>,
        observed_at: Instant,
    ) -> Result<(), String> {
        let mut clock = self
            .echo_render_clock
            .lock()
            .expect("echo render clock poisoned");
        clear_render_timing(&mut clock, observed_at);
        let reason = match reason {
            EchoRenderBoundary::SessionStarted {
                session_id,
                endpoint_id,
                renderer_instance_id,
                owner_generation,
            } => {
                let has_prior_authority = clock.render_authority_endpoint_id.is_some();
                let same_authority = clock.render_authority_endpoint_id.as_deref()
                    == Some(endpoint_id)
                    && clock.render_authority_renderer_instance_id.as_deref()
                        == Some(renderer_instance_id)
                    && clock.render_authority_owner_generation == Some(owner_generation);
                let duplicate_session = clock.active_render_sessions.contains_key(&session_id);
                clock.render_authority_endpoint_id = Some(endpoint_id.to_string());
                clock.render_authority_renderer_instance_id =
                    Some(renderer_instance_id.to_string());
                clock.render_authority_owner_generation = Some(owner_generation);
                clock.active_render_sessions.insert(
                    session_id,
                    (
                        endpoint_id.to_string(),
                        renderer_instance_id.to_string(),
                        owner_generation,
                    ),
                );
                let reason = duplicate_session
                    .then_some("wasapi-render-session-id-reused")
                    .or_else(|| {
                        (has_prior_authority && !same_authority)
                            .then_some("wasapi-render-authority-changed")
                    });
                reason
            }
            EchoRenderBoundary::SessionEnded {
                session_id,
                endpoint_id,
                renderer_instance_id,
                owner_generation,
                normally_drained,
                stream_started,
            } => {
                let expected = clock.active_render_sessions.remove(&session_id);
                let matching_end = expected.as_ref().is_some_and(
                    |(expected_endpoint, expected_renderer, expected_generation)| {
                        expected_endpoint == endpoint_id
                            && expected_renderer == renderer_instance_id
                            && *expected_generation == owner_generation
                    },
                );
                if !matching_end {
                    Some("wasapi-render-session-end-mismatch")
                } else if stream_started && !normally_drained {
                    Some("wasapi-render-failed-after-stream-start")
                } else {
                    None
                }
            }
            EchoRenderBoundary::DeviceFault(reason) => Some(reason),
        };
        if let Some(reason) = reason {
            clock.discontinuity_count = clock.discontinuity_count.saturating_add(1);
            clock.last_discontinuity_reason = Some(reason);
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
            .mark_echo_render_discontinuity(
                EchoRenderBoundary::DeviceFault("wasapi-render-underrun"),
                Instant::now(),
            )
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

    fn publish_session_start(
        store: &AudioStateStore,
        session_id: u64,
        endpoint_id: &str,
        owner_generation: u64,
    ) {
        store
            .mark_echo_render_discontinuity(
                EchoRenderBoundary::SessionStarted {
                    session_id,
                    endpoint_id,
                    renderer_instance_id: "desktop-process-42",
                    owner_generation,
                },
                Instant::now(),
            )
            .expect("publish render session start");
    }

    fn publish_session_end(
        store: &AudioStateStore,
        session_id: u64,
        endpoint_id: &str,
        owner_generation: u64,
        normally_drained: bool,
        stream_started: bool,
    ) {
        store
            .mark_echo_render_discontinuity(
                EchoRenderBoundary::SessionEnded {
                    session_id,
                    endpoint_id,
                    renderer_instance_id: "desktop-process-42",
                    owner_generation,
                    normally_drained,
                    stream_started,
                },
                Instant::now(),
            )
            .expect("publish render session end");
    }

    #[test]
    fn normally_drained_per_cue_sessions_preserve_aec_authority() {
        let store = AudioStateStore::new();

        publish_session_start(&store, 1, "endpoint-a", 7);
        publish_session_end(&store, 1, "endpoint-a", 7, true, true);
        publish_session_start(&store, 2, "endpoint-a", 7);
        publish_session_end(&store, 2, "endpoint-a", 7, true, true);

        assert_eq!(store.echo_render_clock_snapshot().discontinuity_count, 0);
    }

    #[test]
    fn endpoint_or_owner_change_remains_a_device_level_discontinuity() {
        for (next_endpoint, next_generation) in [("endpoint-b", 7), ("endpoint-a", 8)] {
            let store = AudioStateStore::new();
            publish_session_start(&store, 1, "endpoint-a", 7);
            publish_session_end(&store, 1, "endpoint-a", 7, true, true);

            publish_session_start(&store, 2, next_endpoint, next_generation);

            let clock = store.echo_render_clock_snapshot();
            assert_eq!(clock.discontinuity_count, 1);
            assert_eq!(
                clock.last_discontinuity_reason,
                Some("wasapi-render-authority-changed")
            );
        }
    }

    #[test]
    fn only_a_failure_after_stream_start_breaks_the_render_authority() {
        let pre_stream = AudioStateStore::new();
        publish_session_start(&pre_stream, 1, "endpoint-a", 7);
        publish_session_end(&pre_stream, 1, "endpoint-a", 7, false, false);
        assert_eq!(
            pre_stream.echo_render_clock_snapshot().discontinuity_count,
            0
        );

        let post_stream = AudioStateStore::new();
        publish_session_start(&post_stream, 1, "endpoint-a", 7);
        publish_session_end(&post_stream, 1, "endpoint-a", 7, false, true);
        let clock = post_stream.echo_render_clock_snapshot();
        assert_eq!(clock.discontinuity_count, 1);
        assert_eq!(
            clock.last_discontinuity_reason,
            Some("wasapi-render-failed-after-stream-start")
        );
    }

    #[test]
    fn interleaved_sessions_match_their_own_end_without_overwriting_each_other() {
        let store = AudioStateStore::new();

        publish_session_start(&store, 11, "endpoint-a", 7);
        publish_session_start(&store, 12, "endpoint-a", 7);
        publish_session_end(&store, 11, "endpoint-a", 7, true, true);
        publish_session_start(&store, 13, "endpoint-a", 7);
        publish_session_end(&store, 12, "endpoint-a", 7, false, true);
        publish_session_end(&store, 13, "endpoint-a", 7, true, true);

        let clock = store.echo_render_clock.lock().expect("echo render clock");
        assert_eq!(clock.discontinuity_count, 1);
        assert_eq!(
            clock.last_discontinuity_reason,
            Some("wasapi-render-failed-after-stream-start")
        );
        assert!(clock.active_render_sessions.is_empty());
    }

    #[test]
    fn an_end_must_match_the_exact_active_session_and_authority() {
        let store = AudioStateStore::new();
        publish_session_start(&store, 21, "endpoint-a", 7);

        publish_session_end(&store, 22, "endpoint-a", 7, true, true);

        let clock = store.echo_render_clock.lock().expect("echo render clock");
        assert_eq!(clock.discontinuity_count, 1);
        assert_eq!(
            clock.last_discontinuity_reason,
            Some("wasapi-render-session-end-mismatch")
        );
        assert!(clock.active_render_sessions.contains_key(&21));
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

fn clear_render_timing(clock: &mut EchoRenderClock, observed_at: Instant) {
    clock.last_player_position = None;
    clock.last_submitted_frames = None;
    clock.last_endpoint_padding_frames = None;
    clock.last_physical_prefix_offset_frames = None;
    clock.last_reference_lead_frames = None;
    clock.last_observed_at = Some(observed_at);
}
