// Test-only diagnostic. Include INSIDE echo_backend.rs::tests:
// include!("echo_backend_delay_mapping_tests.rs");
// Estimator types are pub(super) to engine, so compile its exact source in a
// test-only child module rather than changing production visibility or copying
// its arithmetic. Its existing nested tests are also compiled; filter this test
// when running the bounded diagnostic. No real QPC or wall-clock reads determine
// the assertions below. This is current-behavior characterization, not acceptance.
mod assembled_reference_delay_diagnostic {
    use super::*;

    mod timing {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/audio/engine/aec_timing.rs"));
    }
    use timing::{AecDelayEstimator, CaptureClockObservation};

    #[derive(Default)]
    struct Calls {
        reverse: Vec<Vec<f32>>,
        delays: Vec<usize>,
        resets: u64,
    }
    struct RecordingEngine(Arc<Mutex<Calls>>);
    impl crate::audio::echo_cancel::EchoCancellerEngine for RecordingEngine {
        fn push_render_10ms(&mut self, frame: &[f32], _: Instant) -> Result<(), String> {
            self.0.lock().unwrap().reverse.push(frame.to_vec());
            Ok(())
        }
        fn process_capture_10ms(&mut self, frame: &[f32], delay: usize, _: Instant)
            -> Result<EchoCancellationResult, String> {
            self.0.lock().unwrap().delays.push(delay);
            Ok(EchoCancellationResult { samples: frame.to_vec() })
        }
        fn reset(&mut self) -> Result<(), String> {
            self.0.lock().unwrap().resets += 1;
            Ok(())
        }
        fn stats(&self) -> EchoCancellerEngineStats {
            <ResetCountingEngine as crate::audio::echo_cancel::EchoCancellerEngine>::stats(
                &ResetCountingEngine { reset_count: self.0.lock().unwrap().resets })
        }
    }
    fn ramp(start: usize, frames: usize) -> Vec<f32> {
        (start..start + frames).flat_map(|n| [n as f32 / 32_768.0; 2]).collect()
    }
    fn commit(store: &AudioStateStore, epoch: u64, start: usize, frames: usize,
        submitted: u64, padding: u32, qpc: u64, instant: Instant) {
        store.push_echo_reference_at(epoch, &ramp(start, frames), 48_000, 2,
            Duration::from_nanos((submitted - u64::from(padding)) * 1_000_000_000 / 48_000),
            submitted, Some(qpc), padding, 0, instant).unwrap();
    }
    fn observation(store: &AudioStateStore, device_frame: u64, packet_qpc: u64,
        now_qpc: u64, render_age_ms: f64) -> CaptureClockObservation {
        let clock = store.echo_render_clock_snapshot();
        CaptureClockObservation {
            device_frame_index: device_frame,
            packet_qpc_100ns: packet_qpc,
            observed_qpc_100ns: Some(now_qpc),
            capture_padding_frames: Some(0),
            capture_buffer_frames: 1056,
            render_clock_age_ms: Some(render_age_ms),
            render_endpoint_padding_frames: clock.endpoint_padding_frames,
            render_reference_lead_frames: clock.reference_lead_frames,
            render_submitted_frames: clock.submitted_frames,
            render_timeline_epoch: clock.timeline_epoch,
            render_discontinuity_count: clock.discontinuity_count,
            render_hard_reset_generation: clock.hard_reset_generation,
            render_discontinuity_reason: clock.last_discontinuity_reason,
            data_discontinuity: false,
            timestamp_error: false,
        }
    }
    fn capture(store: &AudioStateStore, frames: usize, device_frame: u64,
        packet_qpc: u64, now_qpc: u64, delay: usize) {
        store.process_echo_capture_with_metadata(&vec![0.0; frames * 2], delay,
            Some(AecCaptureFrameMetadata {
                packet_device_frame_index: device_frame,
                packet_qpc_100ns: packet_qpc,
                queue_head_device_frame_index: device_frame,
                queue_head_qpc_100ns: packet_qpc,
                observed_qpc_100ns: Some(now_qpc),
                continuity_id: store.echo_render_clock_snapshot().discontinuity_count,
                delay_samples: delay,
                timestamp_error: false,
                data_discontinuity: false,
                queue_head_clock_valid: true,
            })).unwrap();
    }

    #[test]
    fn assembled_reference_latest_write_lead_counterexample() {
        const T0: u64 = 10_000_000;
        const T1: u64 = T0 + 100_000; // Exactly 480 rendered frames / 10 ms.
        let instant = Instant::now(); // Only an anchor; elapsed() is never used.
        let store = AudioStateStore::new();
        let calls = Arc::new(Mutex::new(Calls::default()));
        *store.echo_canceller.lock().unwrap() = Some(
            crate::audio::echo_cancel::create_echo_canceller_for_test(
                Box::new(RecordingEngine(calls.clone()))).unwrap());
        publish_session_start(&store, 1, "endpoint-A", 7);
        publish_stream_start(&store, 1, "endpoint-A", 7);
        let mut current = AecDelayEstimator::new(48_000, 2);
        let mut corrected = AecDelayEstimator::new(48_000, 2);

        // Two real primed writes, device stopped until T0: submitted=960,
        // padding=960, played=0. Capture already has 20 ms of valid backlog.
        commit(&store, 1, 0, 480, 480, 480, T0, instant);
        commit(&store, 1, 480, 480, 960, 960, T0, instant);
        let initial = observation(&store, 48_000, T0 - 200_000, T0, 0.0);
        assert_eq!(initial.render_reference_lead_frames, Some(480));
        let first = current.observe_capture(initial);
        let baseline = corrected.observe_capture(initial);
        assert_eq!(first.delay_samples, 2880); // 20 ms backlog + 10 ms lead.
        assert_eq!(baseline.delay_samples, first.delay_samples);
        assert!(!first.delay_reset_required && !first.aec_reset_required);
        capture(&store, 960, 48_000, T0 - 200_000, T0, first.delay_samples);
        assert_eq!(calls.lock().unwrap().reverse, vec![ramp(0, 480), ramp(480, 480)]);
        assert_eq!(calls.lock().unwrap().delays, vec![2880, 1920]);

        // Fill 96 free frames at T0. After 10 ms the endpoint has played480,
        // so padding=576. One real 480 write at T1 restores padding to1056.
        commit(&store, 1, 960, 96, 1056, 1056, T0, instant);
        commit(&store, 1, 1056, 480, 1536, 1056, T1,
            instant + Duration::from_millis(10));
        let next = observation(&store, 48_960, T0, T1, 0.0);
        assert_eq!(next.render_reference_lead_frames, Some(576));
        assert_eq!(next.render_timeline_epoch, Some(1));
        assert_eq!(next.render_hard_reset_generation, 0);
        assert_eq!(next.render_discontinuity_count, 0);
        let actual = current.observe_capture(next);
        // Counterfactual oracle ONLY: same clock/capture/bounds/history, with
        // lead measured to the actual matched [960,1440) start, not write1056.
        let expected = corrected.observe_capture(CaptureClockObservation {
            render_reference_lead_frames: Some(960 - 480),
            ..next
        });
        assert_eq!(actual.packet_age_ms, Some(10.0));
        assert_eq!(actual.effective_render_reference_lead_frames, Some(576));
        assert_eq!(expected.effective_render_reference_lead_frames, Some(480));
        assert!(!actual.delay_reset_required && !actual.aec_reset_required);
        assert!(!actual.capture_padding_invalid && !actual.queue_head_qpc_clamped);
        assert_eq!(actual.device_frame_delta, Some(960));
        assert_eq!(actual.packet_qpc_delta_100ns, Some(200_000));
        // Production smoothing alpha=.2: 30 ->28.4 versus 30 ->28.0 ms.
        assert_eq!(actual.delay_samples, 2726);
        assert_eq!(expected.delay_samples, 2688);
        capture(&store, 480, 48_960, T0, T1, actual.delay_samples);
        assert_eq!(calls.lock().unwrap().reverse[2], ramp(960, 480));
        assert_eq!(calls.lock().unwrap().delays[2], 2726,
            "first capture chunk receives unchanged latest-write delay");
        let unchanged = store.echo_render_clock_snapshot();
        assert_eq!(unchanged.reference_lead_frames, Some(576));
        assert_eq!(unchanged.timeline_epoch, Some(1));
        assert_eq!(unchanged.discontinuity_count, 0);
        assert_eq!(calls.lock().unwrap().resets, 0);

        // Same authority, new epoch: old96-frame tail [1440,1536) must not
        // concatenate into the new session. No hard reset is invented.
        publish_session_start(&store, 2, "endpoint-A", 7);
        publish_stream_start(&store, 2, "endpoint-A", 7);
        commit(&store, 2, 10_000, 480, 480, 480, T1 + 100_000,
            instant + Duration::from_millis(20));
        capture(&store, 480, 49_440, T1, T1 + 100_000, 0);
        assert_eq!(calls.lock().unwrap().reverse[3], ramp(10_000, 480));
        assert_eq!(store.echo_render_clock_snapshot().timeline_epoch, Some(2));
        assert_eq!(store.echo_render_clock_snapshot().hard_reset_generation, 0);

        // Changed owner publishes a hard boundary; only capture owns reset.
        publish_session_start(&store, 3, "endpoint-A", 8);
        publish_stream_start(&store, 3, "endpoint-A", 8);
        let changed = store.echo_render_clock_snapshot();
        assert_eq!(changed.timeline_epoch, Some(3));
        assert_eq!(changed.hard_reset_generation, 1);
        assert_eq!(changed.discontinuity_count, 1);
        assert_eq!(calls.lock().unwrap().resets, 0);
        let boundary = current.observe_capture(observation(
            &store, 49_440, T1, T1 + 100_000, 0.0));
        assert!(boundary.aec_reset_required);
        assert_eq!(boundary.aec_reset_reason, Some("wasapi-render-session-discontinuity"));
        store.reset_echo_canceller().unwrap();
        assert_eq!(calls.lock().unwrap().resets, 1);
        commit(&store, 3, 20_000, 480, 480, 480, T1 + 200_000,
            instant + Duration::from_millis(30));
        capture(&store, 480, 49_920, T1 + 100_000, T1 + 200_000, 0);
        assert_eq!(calls.lock().unwrap().reverse[4], ramp(20_000, 480));
    }

    // Exact integer conversion inspected in echo_cancel/production.rs, not a
    // copy of estimator smoothing. Bind the mirror to that source expression;
    // this records the would-be native argument, not an executed AEC3 call.
    fn native_delay_ms_for_diagnostic(delay_samples: usize) -> i32 {
        let adapter = include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/src/audio/echo_cancel/production.rs")).replace("\r\n", "\n");
        assert!(adapter.contains(
            "let delay_ms = delay_samples\n            .saturating_div(TARGET_CHANNEL_COUNT)\n            .saturating_mul(1_000)\n            .saturating_div(TARGET_SAMPLE_RATE_HZ as usize)\n            .min(1_000) as i32;"),
            "native adapter conversion changed: re-audit the diagnostic mirror");
        use crate::audio::echo_cancel::{TARGET_CHANNEL_COUNT, TARGET_SAMPLE_RATE_HZ};
        delay_samples.saturating_div(TARGET_CHANNEL_COUNT)
            .saturating_mul(1_000)
            .saturating_div(TARGET_SAMPLE_RATE_HZ as usize)
            .min(1_000) as i32
    }

    #[test]
    fn repeated_480_frame_reference_carry_crosses_native_ms_boundary_diagnostic_only() {
        const T0: u64 = 10_000_000;
        let instant = Instant::now();
        let store = AudioStateStore::new();
        let calls = Arc::new(Mutex::new(Calls::default()));
        *store.echo_canceller.lock().unwrap() = Some(
            crate::audio::echo_cancel::create_echo_canceller_for_test(
                Box::new(RecordingEngine(calls.clone()))).unwrap());
        publish_session_start(&store, 1, "endpoint-A", 7);
        publish_stream_start(&store, 1, "endpoint-A", 7);
        let mut current = AecDelayEstimator::new(48_000, 2);
        let mut corrected = AecDelayEstimator::new(48_000, 2);
        commit(&store, 1, 0, 480, 480, 480, T0, instant);
        commit(&store, 1, 480, 480, 960, 960, T0, instant);
        let baseline = observation(&store, 48_000, T0 - 200_000, T0, 0.0);
        let first = current.observe_capture(baseline);
        assert_eq!(corrected.observe_capture(baseline).delay_samples, first.delay_samples);
        assert_eq!(first.delay_samples, 2880);
        capture(&store, 960, 48_000, T0 - 200_000, T0, first.delay_samples);
        commit(&store, 1, 960, 96, 1056, 1056, T0, instant);
        let mut first_native_difference = None;
        let mut native_pairs = Vec::new();
        for step in 1..=32_usize {
            let now_qpc = T0 + step as u64 * 100_000;
            let capture_qpc = now_qpc - 100_000;
            let played = step as u64 * 480;
            let submitted = 1056 + played;
            let matched_start = 960 + (step - 1) * 480;
            // Every period consumes exactly480 then writes exactly480. Thus
            // post-write device padding=1056, incoming-write start=played+576,
            // and matcher head=played+480, all in the same physical domain.
            commit(&store, 1, 1056 + (step - 1) * 480, 480,
                submitted, 1056, now_qpc,
                instant + Duration::from_millis(step as u64 * 10));
            let observed = observation(&store, 48_960 + (step - 1) as u64 * 480,
                capture_qpc, now_qpc, 0.0);
            assert_eq!(observed.render_reference_lead_frames, Some(576));
            let actual = current.observe_capture(observed);
            let reference = corrected.observe_capture(CaptureClockObservation {
                render_reference_lead_frames: Some((matched_start as u64 - played) as u32),
                ..observed
            });
            assert_eq!(reference.effective_render_reference_lead_frames, Some(480));
            assert_eq!(actual.packet_age_ms, Some(10.0));
            assert!(!actual.delay_reset_required && !actual.aec_reset_required);
            assert!(!reference.delay_reset_required && !reference.aec_reset_required);
            assert!(!actual.capture_padding_invalid && !actual.queue_head_qpc_clamped);
            assert_eq!(actual.device_frame_delta, Some(if step == 1 { 960 } else { 480 }));
            assert_eq!(actual.packet_qpc_delta_100ns,
                Some(if step == 1 { 200_000 } else { 100_000 }));
            capture(&store, 480, 48_960 + (step - 1) as u64 * 480,
                capture_qpc, now_qpc, actual.delay_samples);
            let trace = calls.lock().unwrap();
            assert_eq!(trace.reverse[step + 1], ramp(matched_start, 480),
                "exact PCM identity rules out drift interpolation/tail loss");
            assert_eq!(trace.delays[step + 1], actual.delay_samples);
            let consumed = trace.reverse.iter().map(|pcm| pcm.len() / 2).sum::<usize>();
            assert_eq!(submitted as usize - consumed, 96,
                "every consumed reference block leaves exactly96 committed frames");
            assert_eq!(trace.resets, 0);
            drop(trace);
            assert!(store.echo_reference_matcher.lock().unwrap().take_10ms(1).is_none(),
                "the real96-frame FIFO remainder cannot invent a future480-frame block");
            let snapshot = store.echo_render_clock_snapshot();
            assert_eq!(snapshot.timeline_epoch, Some(1));
            assert_eq!(snapshot.hard_reset_generation, 0);
            assert_eq!(snapshot.discontinuity_count, 0);
            let authority = store.echo_render_clock.lock().unwrap();
            assert_eq!(authority.render_authority_owner_generation, Some(7));
            assert_eq!(authority.render_authority_endpoint_id.as_deref(), Some("endpoint-A"));
            assert_eq!(authority.render_authority_renderer_instance_id.as_deref(),
                Some("desktop-process-42"));
            drop(authority);
            let pair = (native_delay_ms_for_diagnostic(actual.delay_samples),
                native_delay_ms_for_diagnostic(reference.delay_samples));
            if pair.0 != pair.1 && first_native_difference.is_none() {
                first_native_difference = Some(step);
            }
            native_pairs.push(pair);
            if step == 1 {
                assert_eq!((actual.delay_samples, reference.delay_samples), (2726, 2688));
            }
            if step == 2 {
                assert_eq!((actual.delay_samples, reference.delay_samples), (2604, 2534));
            }
            if step == 32 {
                assert_eq!((actual.delay_samples, reference.delay_samples), (2112, 1920));
            }
        }
        assert_eq!(native_pairs[0], (28, 28));
        assert_eq!(native_pairs[1], (27, 26));
        assert_eq!(first_native_difference, Some(2));
        assert_eq!(native_pairs[31], (22, 20));
        // No native AEC execution or acoustic assertion: this is only the
        // differing integer argument that the inspected adapter would pass.
    }
}

