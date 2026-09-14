use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EchoRenderBoundary<'a> {
    SessionStarted {
        session_id: u64,
        endpoint_id: &'a str,
        renderer_instance_id: &'a str,
        owner_generation: u64,
    },
    StreamStarted {
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
    #[cfg(test)]
    pub(crate) fn log_reason(self) -> &'static str {
        match self {
            Self::SessionStarted { .. } => "wasapi-render-session-start",
            Self::StreamStarted { .. } => "wasapi-render-stream-started",
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
    pub(crate) fn aec_diagnostic_tap_enabled(&self) -> bool {
        self.aec_diagnostic_tap.enabled()
    }

    /// The coordinator must first stop/join capture and render producers. Fence
    /// the last native operation before closing tap admission; neither this
    /// fence nor writer I/O may turn the caller's timeout into an unbounded wait.
    pub(crate) fn finish_aec_diagnostic_tap(
        &self,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let started = Instant::now();
        while self.aec_diagnostic_tap.enabled() {
            match self.echo_canceller.try_lock() {
                Ok(_guard) => {
                    self.aec_diagnostic_tap.close_admission();
                    break;
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    self.aec_diagnostic_tap.abort("echo canceller poisoned during tap finish");
                    break;
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    let remaining = timeout.saturating_sub(started.elapsed());
                    if remaining.is_zero() {
                        self.aec_diagnostic_tap.abort("native AEC operation did not quiesce before finish timeout");
                        break;
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(1)));
                }
            }
        }
        self.aec_diagnostic_tap.finish(timeout.saturating_sub(started.elapsed()))
    }

    pub(crate) fn push_echo_reference_at(
        &self,
        render_session_id: u64,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        player_position: Duration,
        submitted_frames: u64,
        endpoint_padding_frames: u32,
        physical_prefix_offset_frames: u32,
        render_time: Instant,
    ) -> Result<(), String> {
        {
            let mut clock = self
                .echo_render_clock
                .lock()
                .expect("echo render clock poisoned");
            let Some((_, _, owner_generation, true, last_player_position, last_submitted_frames)) =
                clock.active_render_sessions.get(&render_session_id)
            else {
                clock.discontinuity_count = clock.discontinuity_count.saturating_add(1);
                clock.last_discontinuity_reason = Some("wasapi-render-frame-session-mismatch");
                return Err(format!(
                    "render frame does not belong to started session {render_session_id}"
                ));
            };
            let position_regressed = last_player_position
                .is_some_and(|previous| player_position < previous)
                || last_submitted_frames.is_some_and(|previous| submitted_frames < previous);
            let reference_frames = samples.len() / usize::from(channel_count.max(1));
            let played = submitted_frames.saturating_sub(u64::from(endpoint_padding_frames));
            let reference_start = submitted_frames.saturating_sub(reference_frames as u64);
            // submitted_frames is the physical timeline. Prefix-aware render
            // pacing publishes a reference only after its corresponding
            // physical prefix, so reference_start already includes that prefix.
            // Adding it again would double-count the diagnostic delay.
            let reference_lead_frames = reference_start
                .saturating_sub(played)
                .min(MAX_ECHO_RENDER_REFERENCE_LEAD_FRAMES) as u32;
            let mut canceller_guard = self.echo_canceller
                .lock()
                .expect("echo canceller poisoned");
            if let Some(canceller) = canceller_guard.as_mut() {
                canceller.push_render_at(samples, sample_rate_hz, channel_count, render_time)
                    .inspect_err(|error| self.aec_diagnostic_tap.abort(error))?;
                // Native processing, generation/sequence assignment and enqueue
                // share this guard with capture/reset. No timestamp work when off.
                if self.aec_diagnostic_tap.enabled() {
                    self.aec_diagnostic_tap.record_render(
                        samples,
                        sample_rate_hz,
                        channel_count,
                        crate::audio::engine::aec_timing::qpc_now_100ns(),
                        clock.discontinuity_count,
                        render_session_id,
                        *owner_generation,
                        physical_prefix_offset_frames,
                        reference_start,
                        submitted_frames,
                        played,
                        submitted_frames,
                        endpoint_padding_frames,
                    );
                }
            }
            drop(canceller_guard);
            let (_, _, _, _, last_player_position, last_submitted_frames) = clock
                .active_render_sessions
                .get_mut(&render_session_id)
                .expect("validated render session disappeared while clock lock was held");
            *last_player_position = Some(player_position);
            *last_submitted_frames = Some(submitted_frames);
            if position_regressed {
                clock.discontinuity_count = clock.discontinuity_count.saturating_add(1);
                clock.last_discontinuity_reason = Some("wasapi-render-position-regressed");
            }
            clock.last_reference_lead_frames = Some(reference_lead_frames);
            clock.last_player_position = Some(player_position);
            clock.last_submitted_frames = Some(submitted_frames);
            clock.last_endpoint_padding_frames = Some(endpoint_padding_frames);
            clock.last_physical_prefix_offset_frames = Some(physical_prefix_offset_frames);
            clock.render_timeline_epoch = Some(render_session_id);
            clock.last_observed_at = Some(render_time);
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
        let reason = match reason {
            EchoRenderBoundary::SessionStarted {
                session_id,
                endpoint_id,
                renderer_instance_id,
                owner_generation,
            } => {
                let duplicate_session = clock.active_render_sessions.contains_key(&session_id);
                clock.active_render_sessions.insert(
                    session_id,
                    (
                        endpoint_id.to_string(),
                        renderer_instance_id.to_string(),
                        owner_generation,
                        false,
                        None,
                        None,
                    ),
                );
                duplicate_session.then_some("wasapi-render-session-id-reused")
            }
            EchoRenderBoundary::StreamStarted {
                session_id,
                endpoint_id,
                renderer_instance_id,
                owner_generation,
            } => {
                let matching_pending = clock.active_render_sessions.get_mut(&session_id).is_some_and(
                    |(expected_endpoint, expected_renderer, expected_generation, started, _, _)| {
                        let matches = expected_endpoint == endpoint_id
                            && expected_renderer == renderer_instance_id
                            && *expected_generation == owner_generation
                            && !*started;
                        if matches {
                            *started = true;
                        }
                        matches
                    },
                );
                if !matching_pending {
                    Some("wasapi-render-stream-start-mismatch")
                } else {
                    let has_prior_authority = clock.render_authority_endpoint_id.is_some();
                    let same_authority = clock.render_authority_endpoint_id.as_deref()
                        == Some(endpoint_id)
                        && clock.render_authority_renderer_instance_id.as_deref()
                            == Some(renderer_instance_id)
                        && clock.render_authority_owner_generation == Some(owner_generation);
                    clock.render_authority_endpoint_id = Some(endpoint_id.to_string());
                    clock.render_authority_renderer_instance_id =
                        Some(renderer_instance_id.to_string());
                    clock.render_authority_owner_generation = Some(owner_generation);
                    clock.render_timeline_epoch = Some(session_id);
                    (has_prior_authority && !same_authority)
                        .then_some("wasapi-render-authority-changed")
                }
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
                    |(expected_endpoint, expected_renderer, expected_generation, expected_started, _, _)| {
                        expected_endpoint == endpoint_id
                            && expected_renderer == renderer_instance_id
                            && *expected_generation == owner_generation
                            && *expected_started == stream_started
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
            clear_render_timing(&mut clock, observed_at);
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
            timeline_epoch: clock.render_timeline_epoch,
            last_observed_at: clock.last_observed_at,
            discontinuity_count: clock.discontinuity_count,
            last_discontinuity_reason: clock.last_discontinuity_reason,
        }
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

    #[cfg(test)]
    pub(crate) fn process_echo_capture(
        &self,
        captured: &[f32],
        delay_samples: usize,
    ) -> Result<EchoCancellationResult, String> {
        self.process_echo_capture_with_metadata(captured, delay_samples, None)
    }

    pub(crate) fn process_echo_capture_with_metadata(
        &self,
        captured: &[f32],
        delay_samples: usize,
        metadata: Option<AecCaptureFrameMetadata>,
    ) -> Result<EchoCancellationResult, String> {
        let mut canceller_guard = self.echo_canceller
            .lock()
            .expect("echo canceller poisoned");
        let result = canceller_guard.as_mut()
            .ok_or_else(|| {
                "WebRTC AEC3 production engine is not active; capture cannot be processed"
                    .to_string()
            })
            .and_then(|canceller| canceller.process_capture(captured, delay_samples))
            .inspect_err(|error| self.aec_diagnostic_tap.abort(error))?;
        if let Some(metadata) = metadata {
            self.aec_diagnostic_tap
                .record_capture(captured, &result.samples, metadata);
        } else if self.aec_diagnostic_tap.enabled() {
            self.aec_diagnostic_tap.abort("AEC capture processed without packet metadata");
        }
        // Keep native processing and tap admission in one total order, also
        // shared by reset/render and the bounded finalization fence.
        drop(canceller_guard);
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn reset_echo_canceller(&self) -> Result<(), String> {
        self.reset_echo_canceller_with_diagnostic("unspecified", None, 0)
    }

    pub(crate) fn reset_echo_canceller_with_diagnostic(
        &self,
        reason: &str,
        observed_qpc_100ns: Option<u64>,
        continuity_id: u64,
    ) -> Result<(), String> {
        let mut guard = self
            .echo_canceller
            .lock()
            .expect("echo canceller poisoned");
        let canceller = guard.as_mut().ok_or_else(|| {
            "WebRTC AEC3 production engine is not active; reset is unavailable"
                .to_string()
        })?;
        canceller.reset().inspect_err(|error| self.aec_diagnostic_tap.abort(error))?;
        self.aec_diagnostic_tap
            .record_reset(reason, observed_qpc_100ns, continuity_id);
        Ok(())
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

    struct TraceEngine(Arc<Mutex<Vec<&'static str>>>);

    impl crate::audio::echo_cancel::EchoCancellerEngine for TraceEngine {
        fn push_render_10ms(&mut self, _: &[f32], _: Instant) -> Result<(), String> {
            self.0.lock().unwrap().push("render-reference");
            std::thread::yield_now();
            Ok(())
        }
        fn process_capture_10ms(&mut self, frame: &[f32], _: usize, _: Instant) -> Result<EchoCancellationResult, String> {
            self.0.lock().unwrap().push("capture");
            std::thread::yield_now();
            Ok(EchoCancellationResult { samples: frame.to_vec() })
        }
        fn reset(&mut self) -> Result<(), String> {
            self.0.lock().unwrap().push("reset");
            std::thread::yield_now();
            Ok(())
        }
        fn stats(&self) -> EchoCancellerEngineStats {
            <ResetCountingEngine as crate::audio::echo_cancel::EchoCancellerEngine>::stats(&ResetCountingEngine { reset_count: 0 })
        }
    }

    #[test]
    fn native_reset_render_capture_and_tap_share_one_total_order() {
        let directory = std::env::temp_dir().join(format!("aec-order-{}", uuid::Uuid::new_v4()));
        let trace = Arc::new(Mutex::new(Vec::new()));
        let mut store = AudioStateStore::new();
        store.aec_diagnostic_tap = AecDiagnosticTap::start(&directory).unwrap();
        *store.echo_canceller.lock().unwrap() = Some(crate::audio::echo_cancel::create_echo_canceller_for_test(Box::new(TraceEngine(trace.clone()))).unwrap());
        publish_session_start(&store, 1, "endpoint", 1);
        publish_stream_start(&store, 1, "endpoint", 1);
        let store = Arc::new(store);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for lane in 0..3 {
            let store = store.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                for index in 0..4 {
                    barrier.wait();
                    match lane {
                        0 => store.reset_echo_canceller_with_diagnostic("test-reset", Some(10), 0).unwrap(),
                        1 => publish_reference_frame(&store, 1, (index + 1) * 480, (index + 1) * 480).unwrap(),
                        _ => { store.process_echo_capture_with_metadata(&[0.0; 960], 0, Some(AecCaptureFrameMetadata {
                            packet_device_frame_index: index * 480, packet_qpc_100ns: index * 100_000,
                            queue_head_device_frame_index: index * 480, queue_head_qpc_100ns: index * 100_000,
                            observed_qpc_100ns: Some(index * 100_000 + 1), continuity_id: 0, delay_samples: 0,
                            timestamp_error: false, data_discontinuity: false, queue_head_clock_valid: true,
                        })).unwrap(); }
                    }
                }
            }));
        }
        for worker in workers { worker.join().unwrap(); }
        let terminal = store.finish_aec_diagnostic_tap(Duration::from_secs(2)).unwrap();
        assert_eq!(terminal["writtenEvents"], 12);
        let rows: Vec<serde_json::Value> = std::fs::read_to_string(directory.join("aec-frame-metadata.jsonl")).unwrap()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let trace = trace.lock().unwrap();
        assert_eq!(trace.len(), rows.len());
        let mut generation = 0;
        for (index, (native, row)) in trace.iter().zip(&rows).enumerate() {
            if *native == "reset" { generation += 1; }
            assert_eq!(row["kind"], *native);
            assert_eq!(row["sequence"], index);
            assert_eq!(row["resetGeneration"], generation);
            if *native == "render-reference" {
                assert_eq!(row["schemaVersion"], 3);
                assert_eq!(row["renderSessionId"], 1);
                assert_eq!(row["ownerGeneration"], 1);
                assert_eq!(row["physicalPrefixOffsetFrames"], 0);
                assert_eq!(row["referenceEndFrame"], row["submittedFrames"]);
                assert_eq!(row["referenceEndFrame"].as_u64().unwrap()
                    - row["referenceStartFrame"].as_u64().unwrap(), 480);
                assert_eq!(row["playedFrames"].as_u64().unwrap(),
                    row["submittedFrames"].as_u64().unwrap()
                        - row["endpointPaddingFrames"].as_u64().unwrap());
            }
        }
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn finish_budget_includes_native_mutex_and_timeout_cannot_later_turn_successful() {
        let directory = std::env::temp_dir().join(format!("aec-fence-{}", uuid::Uuid::new_v4()));
        let mut store = AudioStateStore::new();
        store.aec_diagnostic_tap = AecDiagnosticTap::start(&directory).unwrap();
        let store = Arc::new(store);
        let guard = store.echo_canceller.lock().unwrap();
        let other = store.clone();
        let started = Instant::now();
        let result = std::thread::spawn(move || other.finish_aec_diagnostic_tap(Duration::from_millis(20))).join().unwrap();
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2), "finish blocked on native mutex");
        drop(guard);
        let error = store.finish_aec_diagnostic_tap(Duration::from_secs(2)).unwrap_err();
        assert!(error.contains("native AEC operation did not quiesce"));
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_error_fails_tap_instead_of_committing_a_silent_hole() {
        let directory = std::env::temp_dir().join(format!("aec-native-error-{}", uuid::Uuid::new_v4()));
        let mut store = AudioStateStore::new();
        store.aec_diagnostic_tap = AecDiagnosticTap::start(&directory).unwrap();
        *store.echo_canceller.lock().unwrap() = Some(crate::audio::echo_cancel::create_echo_canceller_for_test(Box::new(RejectingRenderEngine)).unwrap());
        publish_session_start(&store, 1, "endpoint", 1);
        publish_stream_start(&store, 1, "endpoint", 1);
        assert!(publish_reference_frame(&store, 1, 480, 480).is_err());
        let error = store.finish_aec_diagnostic_tap(Duration::from_secs(2)).unwrap_err();
        assert!(error.contains("deterministic render admission failure"));
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_packet_metadata_fails_aec_trace_without_changing_native_output() {
        let directory = std::env::temp_dir().join(format!("aec-metadata-{}", uuid::Uuid::new_v4()));
        let mut store = AudioStateStore::new();
        store.aec_diagnostic_tap = AecDiagnosticTap::start(&directory).unwrap();
        *store.echo_canceller.lock().unwrap() = Some(crate::audio::echo_cancel::create_echo_canceller_for_test(Box::new(ResetCountingEngine { reset_count: 0 })).unwrap());
        let output = store.process_echo_capture(&[0.25; 960], 0).unwrap();
        assert_eq!(output.samples, vec![0.25; 960]);
        assert!(store.finish_aec_diagnostic_tap(Duration::from_secs(2)).unwrap_err().contains("without packet metadata"));
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    struct ResetCountingEngine {
        reset_count: u64,
    }

    struct RejectingRenderEngine;

    impl crate::audio::echo_cancel::EchoCancellerEngine for RejectingRenderEngine {
        fn push_render_10ms(
            &mut self,
            _frame: &[f32],
            _render_time: Instant,
        ) -> Result<(), String> {
            Err("deterministic render admission failure".to_string())
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
            Ok(())
        }

        fn stats(&self) -> EchoCancellerEngineStats {
            EchoCancellerEngineStats {
                backend: "webrtc-aec3",
                render_10ms_frames: 0,
                capture_10ms_frames: 0,
                reset_count: 0,
                rejected_frame_count: 1,
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

    #[test]
    fn rejected_reference_admission_does_not_publish_partial_clock_state() {
        let store = AudioStateStore::new();
        publish_session_start(&store, 61, "endpoint-a", 7);
        publish_stream_start(&store, 61, "endpoint-a", 7);
        let canceller = crate::audio::echo_cancel::create_echo_canceller_for_test(Box::new(
            RejectingRenderEngine,
        ))
        .expect("install rejecting AEC3 backend");
        *store
            .echo_canceller
            .lock()
            .expect("echo canceller poisoned") = Some(canceller);
        let before = store.echo_render_clock_snapshot();

        let error = publish_reference_frame(&store, 61, 480, 480)
            .expect_err("render admission must fail");

        assert!(error.contains("deterministic render admission failure"));
        let after = store.echo_render_clock_snapshot();
        assert_eq!(after.player_position, before.player_position);
        assert_eq!(after.submitted_frames, before.submitted_frames);
        assert_eq!(after.endpoint_padding_frames, before.endpoint_padding_frames);
        assert_eq!(after.reference_lead_frames, before.reference_lead_frames);
        assert_eq!(after.timeline_epoch, before.timeline_epoch);
        assert_eq!(after.discontinuity_count, before.discontinuity_count);
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

    fn publish_stream_start(
        store: &AudioStateStore,
        session_id: u64,
        endpoint_id: &str,
        owner_generation: u64,
    ) {
        store
            .mark_echo_render_discontinuity(
                EchoRenderBoundary::StreamStarted {
                    session_id,
                    endpoint_id,
                    renderer_instance_id: "desktop-process-42",
                    owner_generation,
                },
                Instant::now(),
            )
            .expect("publish render stream start");
    }

    #[test]
    fn pending_failure_then_recovery_does_not_change_established_authority() {
        let store = AudioStateStore::new();
        publish_session_start(&store, 1, "endpoint-a", 7);
        publish_stream_start(&store, 1, "endpoint-a", 7);
        publish_session_end(&store, 1, "endpoint-a", 7, true, true);

        publish_session_start(&store, 2, "temporary-endpoint", 8);
        assert_eq!(store.echo_render_clock_snapshot().timeline_epoch, Some(1));
        publish_session_end(&store, 2, "temporary-endpoint", 8, false, false);
        publish_session_start(&store, 3, "endpoint-a", 7);
        assert_eq!(store.echo_render_clock_snapshot().timeline_epoch, Some(1));
        publish_stream_start(&store, 3, "endpoint-a", 7);
        assert_eq!(store.echo_render_clock_snapshot().timeline_epoch, Some(3));
        publish_session_end(&store, 3, "endpoint-a", 7, true, true);

        assert_eq!(store.echo_render_clock_snapshot().discontinuity_count, 0);
    }

    #[test]
    fn started_authority_change_remains_a_device_level_discontinuity() {
        let store = AudioStateStore::new();
        publish_session_start(&store, 1, "endpoint-a", 7);
        publish_stream_start(&store, 1, "endpoint-a", 7);
        publish_session_end(&store, 1, "endpoint-a", 7, true, true);

        publish_session_start(&store, 2, "endpoint-b", 8);
        assert_eq!(store.echo_render_clock_snapshot().discontinuity_count, 0);
        publish_stream_start(&store, 2, "endpoint-b", 8);

        let clock = store.echo_render_clock_snapshot();
        assert_eq!(clock.discontinuity_count, 1);
        assert_eq!(
            clock.last_discontinuity_reason,
            Some("wasapi-render-authority-changed")
        );
    }

    fn publish_reference_frame(
        store: &AudioStateStore,
        session_id: u64,
        player_position_frames: u64,
        submitted_frames: u64,
    ) -> Result<(), String> {
        store.push_echo_reference_at(
            session_id,
            &vec![0.0; 480 * 2],
            crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ,
            crate::audio::echo_cancel::TARGET_CHANNEL_COUNT as u16,
            Duration::from_secs_f64(player_position_frames as f64 / 48_000.0),
            submitted_frames,
            480,
            0,
            Instant::now(),
        )
    }

    #[test]
    fn interleaved_frames_are_bound_to_their_session_and_detect_own_regression() {
        let store = AudioStateStore::new();
        publish_session_start(&store, 51, "endpoint-a", 7);
        publish_session_start(&store, 52, "endpoint-a", 7);
        publish_stream_start(&store, 51, "endpoint-a", 7);
        publish_stream_start(&store, 52, "endpoint-a", 7);

        publish_reference_frame(&store, 51, 480, 480).expect("A first frame");
        publish_reference_frame(&store, 52, 480, 480).expect("B first frame");
        assert_eq!(store.echo_render_clock_snapshot().discontinuity_count, 0);

        publish_reference_frame(&store, 51, 240, 240).expect("A regressed frame");
        let clock = store.echo_render_clock_snapshot();
        assert_eq!(clock.timeline_epoch, Some(51));
        assert_eq!(clock.submitted_frames, Some(240));
        assert_eq!(clock.endpoint_padding_frames, Some(480));
        assert_eq!(clock.discontinuity_count, 1);
        assert_eq!(
            clock.last_discontinuity_reason,
            Some("wasapi-render-position-regressed")
        );
    }

    #[test]
    fn normally_drained_per_cue_sessions_preserve_aec_authority() {
        let store = AudioStateStore::new();

        publish_session_start(&store, 1, "endpoint-a", 7);
        publish_stream_start(&store, 1, "endpoint-a", 7);
        publish_session_end(&store, 1, "endpoint-a", 7, true, true);
        publish_session_start(&store, 2, "endpoint-a", 7);
        publish_stream_start(&store, 2, "endpoint-a", 7);
        publish_session_end(&store, 2, "endpoint-a", 7, true, true);

        assert_eq!(store.echo_render_clock_snapshot().discontinuity_count, 0);
    }

    #[test]
    fn endpoint_or_owner_change_remains_a_device_level_discontinuity() {
        for (next_endpoint, next_generation) in [("endpoint-b", 7), ("endpoint-a", 8)] {
            let store = AudioStateStore::new();
            publish_session_start(&store, 1, "endpoint-a", 7);
            publish_stream_start(&store, 1, "endpoint-a", 7);
            publish_session_end(&store, 1, "endpoint-a", 7, true, true);

            publish_session_start(&store, 2, next_endpoint, next_generation);
            publish_stream_start(&store, 2, next_endpoint, next_generation);

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
        publish_stream_start(&post_stream, 1, "endpoint-a", 7);
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
        publish_stream_start(&store, 11, "endpoint-a", 7);
        publish_stream_start(&store, 12, "endpoint-a", 7);
        publish_session_end(&store, 11, "endpoint-a", 7, true, true);
        publish_session_start(&store, 13, "endpoint-a", 7);
        publish_stream_start(&store, 13, "endpoint-a", 7);
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
        publish_session_start(&store, 31, "endpoint-a", 7);
        publish_stream_start(&store, 31, "endpoint-a", 7);
        // 960 submitted, 840 padded => 120 already played. The current
        // reference starts at frame 480, so only 360 frames precede it; the
        // reference's own 480 frames must not enter the AEC delay hint.
        store
            .push_echo_reference_at(
                31,
                &vec![0.0; 480 * 2],
                crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ,
                crate::audio::echo_cancel::TARGET_CHANNEL_COUNT as u16,
                Duration::from_secs_f64(120.0 / 48_000.0),
                960,
                840,
                0,
                observed_at,
            )
            .expect("record render reference");

        let clock = store.echo_render_clock_snapshot();
        assert_eq!(clock.endpoint_padding_frames, Some(840));
        assert_eq!(clock.reference_lead_frames, Some(360));
    }

    #[test]
    fn physical_prefix_is_already_accounted_for_by_the_physical_submit_position() {
        let store = AudioStateStore::new();
        let observed_at = Instant::now();
        publish_session_start(&store, 41, "endpoint-a", 7);
        publish_stream_start(&store, 41, "endpoint-a", 7);
        // The first 480-frame reference follows a 3,840-frame physical prefix.
        // With all 4,320 submitted frames still padded, its physical start is
        // 3,840 frames ahead. The prefix must not be added a second time.
        store
            .push_echo_reference_at(
                41,
                &vec![0.0; 480 * 2],
                crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ,
                crate::audio::echo_cancel::TARGET_CHANNEL_COUNT as u16,
                Duration::ZERO,
                4_320,
                4_320,
                3_840,
                observed_at,
            )
            .expect("record delayed render reference");

        let clock = store.echo_render_clock_snapshot();
        assert_eq!(clock.reference_lead_frames, Some(3_840));
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
