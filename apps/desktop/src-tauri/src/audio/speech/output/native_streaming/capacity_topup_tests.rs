// Included INSIDE native_streaming's existing cfg(test) tests module.
// These are deterministic fake-endpoint traces, not acoustic/hardware evidence.
mod capacity_topup_tests {
    use super::*;

    // Independent golden interpolation, including the single retained end frame.
    // Deliberately do not call StreamPcmQueue or speaker_pcm_48k_stereo here.
    fn golden_reference(source: &[i16]) -> Vec<f32> {
        let mut result = Vec::new();
        if let Some(first) = source.first() {
            let mut previous = *first as f32 / i16::MAX as f32;
            result.extend([previous; 2]);
            for sample in &source[1..] {
                let next = *sample as f32 / i16::MAX as f32;
                let midpoint = previous + (next - previous) * 0.5;
                result.extend([midpoint, midpoint, next, next]);
                previous = next;
            }
            result.extend([previous; 2]);
        }
        result
    }

    #[derive(Default)]
    struct Trace {
        reference: Vec<f32>,
        physical: Vec<f32>,
        render_reference: Vec<f32>,
        session: Option<u64>,
        identity: Option<(u64, String, String)>,
        completed: Vec<(u64, u32, u64, u64, u64)>,
        activities_completed: usize,
        end_queued: usize,
        taps: usize,
    }

    impl Trace {
        fn record(&mut self, event: DesktopStreamingEvent<'_>) -> Result<(), String> {
            match event {
                DesktopStreamingEvent::Tap(tap) => {
                    assert_eq!(tap.reference_start_frame, (self.reference.len() / 2) as u64);
                    assert_eq!(tap.physical_start_frame, (self.physical.len() / 2) as u64);
                    assert_eq!(tap.reference_end_frame - tap.reference_start_frame,
                        (tap.reference_samples.len() / 2) as u64);
                    assert_eq!(tap.physical_end_frame - tap.physical_start_frame,
                        (tap.physical_samples.len() / 2) as u64);
                    assert_eq!(tap.submitted_frames, tap.physical_end_frame);
                    assert!(tap.physical_samples.len() / 2 <= BLOCK_FRAMES);
                    if let Some(session) = self.session { assert_eq!(tap.render_session_id, session); }
                    self.session = Some(tap.render_session_id);
                    let identity = (tap.renderer_owner_generation,
                        tap.renderer_instance_id.to_string(), tap.physical_playback_device_id.to_string());
                    if let Some(expected) = &self.identity { assert_eq!(&identity, expected); }
                    self.identity = Some(identity);
                    self.reference.extend_from_slice(tap.reference_samples);
                    self.physical.extend_from_slice(tap.physical_samples);
                    self.taps += 1;
                }
                DesktopStreamingEvent::Render(SpeakerRenderEvent::Frame {
                    render_session_id, samples, sample_rate_hz, channel_count, ..
                }) => {
                    if let Some(session) = self.session { assert_eq!(render_session_id, session); }
                    self.session = Some(render_session_id);
                    assert_eq!(sample_rate_hz, 48_000);
                    assert_eq!(channel_count, 2);
                    self.render_reference.extend_from_slice(samples);
                }
                DesktopStreamingEvent::Render(SpeakerRenderEvent::AecLiveScenarioStage {
                    status: "completed", ordinal, delay_ms, reference_frames,
                    physical_frames, changed_samples, ..
                }) => self.completed.push((ordinal, delay_ms, reference_frames, physical_frames, changed_samples)),
                DesktopStreamingEvent::Activity(DesktopStreamActivity::Completed) => self.activities_completed += 1,
                DesktopStreamingEvent::Activity(DesktopStreamActivity::EndQueued) => self.end_queued += 1,
                _ => {}
            }
            Ok(())
        }
    }

    #[test]
    fn capacity_1056_uses_real_96_frame_spare_after_unchanged_two_step_startup() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        device.borrow_mut().capacity = 1056;
        stream.push_pcm(&vec![10_000; 19_200], 24_000).unwrap();
        let mut trace = Trace::default();
        stream.poll(&mut |event| trace.record(event)).unwrap();
        assert_eq!(device.borrow().padding, 960);
        assert_eq!(device.borrow().writes.len(), 2);
        let queued = stream.queue.buffered_frames();
        stream.poll(&mut |event| trace.record(event)).unwrap();
        // Old behavior refuses its planned 480-frame write here: first red assertion.
        assert_eq!(device.borrow().padding, 1056);
        assert_eq!(device.borrow().writes.last().unwrap().len(), 96 * 2);
        assert_eq!(stream.queue.buffered_frames(), queued - 96);
        assert_eq!(trace.reference, vec![10_000_f32 / i16::MAX as f32; 1056 * 2]);
        assert_eq!(trace.physical, trace.reference);
        assert_eq!(trace.render_reference, trace.reference);
        let before = stream.submitted_frames;
        stream.poll(&mut |event| trace.record(event)).unwrap();
        assert_eq!(stream.submitted_frames, before); // Truly full: no synthetic write.
        assert_eq!(device.borrow().starts, 1);
    }

    #[test]
    fn real_reserve_survives_a_960_frame_wake_then_one_steady_step_only() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        device.borrow_mut().capacity = 1056;
        stream.push_pcm(&vec![7_000; 19_200], 24_000).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        device.borrow_mut().wakes.push_back((Ok(DesktopRenderWake::Signaled), 960));
        assert_eq!(stream.wait_for_device(Duration::from_millis(2)), Ok(DesktopRenderWake::Signaled));
        assert_eq!(device.borrow().padding, 96); // Previously 960 -> 0.
        let before = stream.submitted_frames;
        stream.poll(&mut |event| match event {
            DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason: crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"), ..
            }) => Err("a real reserve must prevent this underrun".into()),
            _ => Ok(()),
        }).unwrap();
        assert_eq!(stream.submitted_frames, before + 480);
        assert_eq!(device.borrow().padding, 576); // NOT an expanded full-fill poll.
        assert_eq!(device.borrow().starts, 1);
        assert_eq!(device.borrow().resets, 0);
    }

    #[test]
    fn varied_actual_capacities_clamp_writes_without_expanding_startup_or_steady_poll() {
        for capacity in [1_u32, 96, 479, 480, 481, 800, 959, 960, 1000, 1056, 1441] {
            let owner = DesktopPlaybackOwnership::default();
            let (mut stream, device) = fake_stream(&owner);
            device.borrow_mut().capacity = capacity;
            stream.push_pcm(&vec![9_000; 19_200], 24_000).unwrap();
            stream.poll(&mut |_| Ok(())).unwrap();
            let prime = if capacity >= 960 { 960 } else { capacity.min(480) };
            assert_eq!(device.borrow().padding, prime, "startup capacity={capacity}");
            assert_eq!(device.borrow().starts, 1, "capacity={capacity}");
            let before = stream.submitted_frames;
            let writes = device.borrow().writes.len();
            let topup = (capacity - prime).min(480);
            stream.poll(&mut |_| Ok(())).unwrap();
            assert_eq!(stream.submitted_frames, before + u64::from(topup), "capacity={capacity}");
            assert_eq!(device.borrow().writes.len(), writes + usize::from(topup > 0));
            assert_eq!(device.borrow().padding, prime + topup);
            assert!(device.borrow().writes.iter().all(|pcm| !pcm.is_empty()
                && pcm.len() / 2 <= capacity.min(480) as usize));
        }
    }

    #[test]
    fn startup_still_requires_800ms_pcm_or_1000ms_wait_not_device_spare() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        device.borrow_mut().capacity = 1056;
        stream.push_pcm(&vec![100; 19_199], 24_000).unwrap();
        stream.first_audio_at = Some(Instant::now());
        stream.poll(&mut |_| Ok(())).unwrap();
        assert_eq!(device.borrow().starts, 0);
        assert!(device.borrow().writes.is_empty());
        stream.push_pcm(&[200], 24_000).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        assert_eq!(device.borrow().padding, 960);
        assert_eq!(STARTUP_FRAMES, 38_400);
        assert_eq!(STARTUP_MAX_WAIT, Duration::from_millis(1000));

        let other_owner = DesktopPlaybackOwnership::default();
        let (mut short, short_device) = fake_stream(&other_owner);
        short_device.borrow_mut().capacity = 96;
        short.push_pcm(&[300; 50], 24_000).unwrap(); // 99 ready frames, retained tail excluded.
        short.first_audio_at = Some(Instant::now());
        short.poll(&mut |_| Ok(())).unwrap();
        assert_eq!(short_device.borrow().starts, 0);
        short.first_audio_at = Some(Instant::now() - STARTUP_MAX_WAIT);
        short.poll(&mut |_| Ok(())).unwrap();
        assert_eq!(short_device.borrow().padding, 96);
        assert_eq!(short.queue.buffered_frames(), 3);
        assert!(!short.queue.ended);
    }

    #[test]
    fn small_live_deltas_coalesce_before_using_a_partial_device_slot() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        device.borrow_mut().capacity = 1056;
        stream.push_pcm(&vec![100; 19_200], 24_000).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        // Isolate the source-readiness rule in an already active client. The
        // golden end-to-end test below checks admission/submission accounting.
        stream.queue.reference.clear();
        stream.push_pcm(&[200; 100], 24_000).unwrap();
        let before = stream.submitted_frames;
        stream.poll(&mut |_| Ok(())).unwrap();
        assert_eq!(stream.submitted_frames, before);
        assert_eq!(stream.queue.buffered_frames(), 200);
        stream.push_pcm(&[300; 139], 24_000).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        assert_eq!(stream.submitted_frames, before);
        assert_eq!(stream.queue.buffered_frames(), 478);
        stream.push_pcm(&[400], 24_000).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        assert_eq!(stream.submitted_frames, before + 96);
        assert_eq!(stream.queue.buffered_frames(), 384);
    }

    #[test]
    fn zero_padding_with_queued_live_pcm_still_faults_before_consuming_source() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        device.borrow_mut().capacity = 1056;
        stream.push_pcm(&vec![100; 19_200], 24_000).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        stream.poll(&mut |_| Ok(())).unwrap();
        device.borrow_mut().padding = 0;
        let queued = stream.queue.buffered_frames();
        let submitted = stream.submitted_frames;
        let writes = device.borrow().writes.len();
        let error = stream.poll(&mut |event| match event {
            DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason: crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"), ..
            }) => Err("zero-padding remains a failure".into()),
            _ => Ok(()),
        }).unwrap_err();
        assert_eq!(error, "zero-padding remains a failure");
        assert_eq!(stream.queue.buffered_frames(), queued);
        assert_eq!(stream.submitted_frames, submitted);
        assert_eq!(device.borrow().writes.len(), writes);
    }

    #[test]
    fn chunked_source_topups_and_end_tail_match_exact_pcm_taps_and_single_session() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        device.borrow_mut().capacity = 1056;
        let source: Vec<i16> = (0..19_237).map(|i| ((i * 73 % 24_001) as i16) - 12_000).collect();
        for delta in source.chunks(137) { stream.push_pcm(delta, 24_000).unwrap(); }
        let mut trace = Trace::default();
        stream.poll(&mut |event| trace.record(event)).unwrap();
        stream.poll(&mut |event| trace.record(event)).unwrap();
        assert_eq!(device.borrow().padding, 1056);
        let before_end = stream.queue.buffered_frames();
        stream.end(&mut |event| trace.record(event)).unwrap();
        assert_eq!(stream.queue.buffered_frames(), before_end + 1);
        assert!(stream.end(&mut |event| trace.record(event)).is_err());
        assert_eq!(stream.queue.buffered_frames(), before_end + 1);
        assert!(stream.queue.previous.is_none());
        let mut receipt = None;
        for _ in 0..1000 {
            let padding = device.borrow().padding;
            device.borrow_mut().padding = padding.saturating_sub(173);
            if let Some(done) = stream.poll(&mut |event| trace.record(event)).unwrap() {
                receipt = Some(done);
                break;
            }
        }
        let receipt = receipt.expect("bounded fake endpoint must drain");
        let golden = golden_reference(&source);
        assert_eq!(trace.reference, golden);
        assert_eq!(trace.physical, golden);
        assert_eq!(trace.render_reference, golden);
        assert_eq!(device.borrow().writes.concat(), golden);
        assert_eq!(receipt.rendered_frames, source.len() as u64 * 2);
        assert_eq!(trace.activities_completed, 1);
        assert_eq!(trace.end_queued, 1);
        assert_eq!(trace.taps, device.borrow().writes.len());
        assert_eq!(device.borrow().starts, 1);
        assert_eq!(device.borrow().stops, 1);
        assert_eq!(device.borrow().resets, 0);
        assert_eq!(device.borrow().padding, 0);
        assert!(stream.poll(&mut |event| trace.record(event)).is_err());
    }

    #[test]
    fn nonmultiple_phase_budgets_are_exact_with_80_160ms_prefixes_and_nonlinearity() {
        for (capacity, phase_frames) in [(1056_u32, 961_u64), (257, 1057)] {
            let owner = DesktopPlaybackOwnership::default();
            let (mut stream, device) = fake_stream(&owner);
            device.borrow_mut().capacity = capacity;
            stream.scenario = aec_live_scenario::ordered_speech_simulation_assignments();
            stream.scenario_phase_frames = phase_frames;
            let mut trace = Trace::default();
            stream.start_stage(&mut |event| trace.record(event)).unwrap();
            let source: Vec<i16> = (0..1800).map(|i| ((i * 83 % 20_001) as i16) - 10_000).collect();
            for delta in source.chunks(79) { stream.push_pcm(delta, 24_000).unwrap(); }
            stream.end(&mut |event| trace.record(event)).unwrap();
            let mut receipt = None;
            for _ in 0..300 {
                // Ended source permits zero padding without masking live faults.
                device.borrow_mut().padding = 0;
                if let Some(done) = stream.poll(&mut |event| trace.record(event)).unwrap() {
                    receipt = Some(done);
                    break;
                }
                if stream.stage.index < 2 {
                    assert!(stream.stage.reference_frames <= phase_frames,
                        "phase budget overshoot: capacity={capacity}");
                }
            }
            assert_eq!(receipt.expect("three phases must drain").rendered_frames, 3600);
            let golden = golden_reference(&source);
            let split = phase_frames as usize * 2;
            let mut physical = golden[..split].to_vec();
            physical.extend(vec![0.0; 3840 * 2]);
            physical.extend_from_slice(&golden[split..split * 2]);
            physical.extend(vec![0.0; 7680 * 2]);
            // Golden endpoint shaping, independent of phase.physical_sample().
            physical.extend(golden[split * 2..].iter().map(|sample| {
                let driven = sample.clamp(-1.0, 1.0) * 2.4;
                ((driven / (1.0 + driven.abs())) * 1.35).clamp(-0.92, 0.92)
            }));
            assert_eq!(trace.reference, golden);
            assert_eq!(trace.render_reference, golden);
            assert_eq!(trace.physical, physical);
            assert_eq!(device.borrow().writes.concat(), physical);
            assert_eq!(trace.completed.len(), 3);
            assert_eq!(trace.completed[0], (1, 0, phase_frames, phase_frames, 0));
            assert_eq!(trace.completed[1], (2, 80, phase_frames, phase_frames + 3840, 0));
            let nonlinear_frames = 3600 - 2 * phase_frames;
            assert_eq!(trace.completed[2].0, 3);
            assert_eq!(trace.completed[2].1, 160);
            assert_eq!(trace.completed[2].2, nonlinear_frames);
            assert_eq!(trace.completed[2].3, nonlinear_frames + 7680);
            let changed = golden[split * 2..].iter().zip(&physical[(split * 2 + 11_520 * 2)..])
                .filter(|(reference, played)| reference.to_bits() != played.to_bits()).count();
            assert_eq!(trace.completed[2].4, changed as u64);
            assert!(changed > 0);
            assert_eq!(trace.activities_completed, 1);
            assert_eq!(device.borrow().starts, 1);
            assert_eq!(device.borrow().stops, 1);
            assert_eq!(device.borrow().resets, 0);
        }
    }

    #[test]
    fn active_stage_transition_keeps_two_step_prime_then_tops_up_prefix_spare() {
        for previous in 0..2 {
            let (mut stream, device, _owner) = stream_at_active_stage_boundary(previous);
            let before = stream.submitted_frames;
            stream.poll(&mut |_| Ok(())).unwrap();
            assert_eq!(stream.submitted_frames, before + 960);
            assert_eq!(device.borrow().padding, 960);
            assert_eq!(stream.stage.prefix_remaining, 3840 * (previous + 1) - 960);
            stream.poll(&mut |_| Ok(())).unwrap();
            assert_eq!(stream.submitted_frames, before + 1056);
            assert_eq!(device.borrow().padding, 1056);
            assert_eq!(stream.stage.prefix_remaining, 3840 * (previous + 1) - 1056);
            assert_eq!(stream.stage.reference_frames, 0);
            assert!(device.borrow().writes.last().unwrap().iter().all(|sample| *sample == 0.0));
            assert_eq!(device.borrow().starts, 1);
            assert_eq!(device.borrow().resets, 0);
        }
    }
}