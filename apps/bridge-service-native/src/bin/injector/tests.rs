    use super::*;

    #[test]
    fn decodes_pcm16_wav_instead_of_treating_it_as_mp3() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("sample.wav");
        let pcm = [-32_768i16, -16_384, 0, 16_384, 32_767];
        let data_len = (pcm.len() * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for sample in pcm {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(&path, wav).expect("write WAV");

        let decoded = decode_media(&path).expect("decode WAV");
        assert_eq!(decoded.source_sample_rate_hz, 24_000);
        assert_eq!(decoded.source_channels, 1);
        assert_eq!(decoded.samples.len(), pcm.len());
        assert!((decoded.samples[0] + 1.0).abs() < 0.0001);
        assert!(decoded.samples[2].abs() < 0.0001);
        assert!((decoded.samples[4] - 0.9999695).abs() < 0.0001);
    }

    #[test]
    fn explicit_endpoint_id_never_falls_back_to_virtual_speaker_name() {
        assert!(render_device_matches_request(
            Some("{physical-endpoint}"),
            "{physical-endpoint}",
            "Speakers (High Definition Audio Device)",
            "Omni Translate Virtual Speaker",
        ));
        assert!(render_device_matches_request(
            Some("{0.0.0.00000000}.{0FA47289-698C-4F9B-BBB2-6775530CE776}"),
            "{0.0.0.00000000}.{0fa47289-698c-4f9b-bbb2-6775530ce776}",
            "Speakers (Omni Translate Virtual Speaker)",
            "Omni Translate Virtual Speaker",
        ));
        assert!(!render_device_matches_request(
            Some("{physical-endpoint}"),
            "{virtual-endpoint}",
            "Omni Translate Virtual Speaker",
            "Omni Translate Virtual Speaker",
        ));
        assert!(render_device_matches_request(
            None,
            "{virtual-endpoint}",
            "Omni Translate Virtual Speaker",
            "Omni Translate Virtual Speaker",
        ));
    }

    #[test]
    fn render_resampling_preserves_duration_across_endpoint_clocks() {
        let source = vec![0.25_f32; 24_000];
        let rendered_16k = resample_to_render_stereo(&source, 24_000, 1, 16_000);
        let rendered_48k = resample_to_render_stereo(&source, 24_000, 1, 48_000);
        assert_eq!(rendered_16k.len(), 16_000 * TARGET_CHANNELS);
        assert_eq!(rendered_48k.len(), 48_000 * TARGET_CHANNELS);
    }

    #[test]
    fn source_gain_is_applied_only_to_render_samples() {
        let mut rendered = vec![1.0_f32, -0.5];
        apply_gain_db(&mut rendered, -9.0);
        let linear = 10.0_f32.powf(-9.0 / 20.0);
        assert!((rendered[0] - linear).abs() < 0.000_001);
        assert!((rendered[1] + 0.5 * linear).abs() < 0.000_001);
    }

    #[test]
    fn postroll_silence_extends_render_without_changing_media_samples() {
        let mut rendered = vec![0.5_f32, -0.5, 0.25, -0.25];
        let media = rendered.clone();
        append_postroll_silence(&mut rendered, 3);
        assert_eq!(&rendered[..media.len()], media.as_slice());
        assert_eq!(rendered.len(), media.len() + 3 * TARGET_CHANNELS);
        assert!(rendered[media.len()..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn restart_quiet_window_preserves_both_media_sides_and_exact_duration() {
        let mut rendered = vec![1_i16, 2, 3, 4, 5, 6, 7, 8];
        let inserted = insert_silence(&mut rendered, 2, 2, 1.0, 1.5).unwrap();
        assert_eq!(inserted, 3);
        assert_eq!(&rendered[..4], &[1, 2, 3, 4]);
        assert_eq!(&rendered[4..10], &[0; 6]);
        assert_eq!(&rendered[10..], &[5, 6, 7, 8]);
    }

    #[test]
    fn restart_quiet_window_rejects_a_marker_after_media_end() {
        let mut rendered = vec![1_i16; 8];
        assert!(insert_silence(&mut rendered, 2, 2, 2.0, 1.0)
            .unwrap_err()
            .contains("outside media"));
    }

    #[test]
    fn injector_event_buffer_is_fixed_to_the_audited_250ms_tolerance() {
        assert_eq!(INJECTOR_EVENT_BUFFER_DURATION_HNS, 250 * 10_000);
        assert_eq!(injector_event_buffer_frames(48_000), 12_000);
        assert_eq!(injector_event_buffer_frames(44_100), 11_025);
    }

    #[test]
    fn actual_event_buffer_must_cover_the_requested_scheduler_tolerance() {
        validate_injector_event_buffer_frames(12_000, 48_000).unwrap();
        validate_injector_event_buffer_frames(12_001, 48_000).unwrap();
        let error = validate_injector_event_buffer_frames(11_999, 48_000).unwrap_err();
        assert!(error.contains("bufferFrames=11999"));
        assert!(error.contains("requiredBufferFrames=12000"));
        assert!(validate_injector_event_buffer_frames(12_000, 0).is_err());
    }

    #[test]
    fn failed_result_preserves_known_render_telemetry() {
        let mut authority = RenderPacingAuthority::default();
        authority
            .record_prefill(12_000, 12_000, 12_000, 6_183_136)
            .unwrap();
        authority.record_started();
        let detail = authority
            .observe_refill_wake(0, 6_183_136, Duration::from_millis(251))
            .unwrap_err();
        let failure = InjectorError::with_render(detail, 12_000, 12_000, &authority);
        let json = serde_json::to_value(InjectorResult::failed(failure)).unwrap();
        assert_eq!(json["bufferFrames"], 12_000);
        assert_eq!(json["prefillFrames"], 12_000);
        assert_eq!(json["renderWakeCount"], 1);
        assert_eq!(json["maxRenderWakeIntervalMs"], 251);
        assert_eq!(json["zeroPaddingUnderrunCount"], 1);
        assert!(json["detail"]
            .as_str()
            .unwrap()
            .contains("render underrun"));
    }

    #[test]
    fn pacing_authority_requires_prefill_before_start() {
        let mut authority = RenderPacingAuthority::default();
        authority.record_prefill(480, 480, 480, 960).unwrap();
        authority.record_started();
        assert_eq!(authority.prefill_frames, 480);
        assert_eq!(authority.zero_padding_underrun_count, 0);
    }

    #[test]
    fn injector_buffer_tolerates_observed_30ms_and_114ms_scheduler_delays() {
        let sample_rate_hz = 48_000_usize;
        let buffer_frames = injector_event_buffer_frames(sample_rate_hz as u32);
        for delay_ms in [30_usize, 114] {
            let consumed_frames = sample_rate_hz * delay_ms / 1_000;
            let padding_frames = buffer_frames.saturating_sub(consumed_frames);
            assert!(padding_frames > 0, "delay {delay_ms} ms exhausted buffer");

            let mut authority = RenderPacingAuthority::default();
            authority
                .record_prefill(
                    buffer_frames,
                    buffer_frames,
                    buffer_frames,
                    buffer_frames + 1,
                )
                .unwrap();
            authority.record_started();
            authority
                .observe_refill_wake(
                    padding_frames,
                    buffer_frames + 1,
                    Duration::from_millis(delay_ms as u64),
                )
                .unwrap();
            assert_eq!(authority.zero_padding_underrun_count, 0);
        }
    }

    #[test]
    fn injector_buffer_still_fails_closed_after_scheduler_delay_exceeds_capacity() {
        let sample_rate_hz = 48_000_usize;
        let buffer_frames = injector_event_buffer_frames(sample_rate_hz as u32);
        let delay_ms = 251_usize;
        let consumed_frames = sample_rate_hz * delay_ms / 1_000;
        let padding_frames = buffer_frames.saturating_sub(consumed_frames);
        assert_eq!(padding_frames, 0);

        let mut authority = RenderPacingAuthority::default();
        authority
            .record_prefill(
                buffer_frames,
                buffer_frames,
                buffer_frames,
                buffer_frames + 1,
            )
            .unwrap();
        authority.record_started();
        let error = authority
            .observe_refill_wake(
                padding_frames,
                buffer_frames + 1,
                Duration::from_millis(delay_ms as u64),
            )
            .unwrap_err();
        assert!(error.contains("render underrun"));
        assert_eq!(authority.zero_padding_underrun_count, 1);
    }

    #[test]
    fn prefill_requires_the_entire_actual_buffer_for_long_media() {
        let mut authority = RenderPacingAuthority::default();
        let error = authority
            .record_prefill(480, 480, 12_000, 6_183_136)
            .unwrap_err();
        assert!(error.contains("expectedPrefillFrames=12000"));
        assert!(error.contains("writtenFrames=480"));
        assert_eq!(authority.prefill_frames, 0);
    }

    #[test]
    fn prefill_accepts_all_short_media_when_it_is_smaller_than_the_buffer() {
        let mut authority = RenderPacingAuthority::default();
        authority
            .record_prefill(6_000, 6_000, 12_000, 6_000)
            .unwrap();
        assert_eq!(authority.prefill_frames, 6_000);
        assert_eq!(authority.submitted_frames, 6_000);
    }

    #[test]
    fn pacing_authority_fails_closed_when_padding_reaches_zero_before_submission_finishes() {
        let mut authority = RenderPacingAuthority::default();
        authority.record_prefill(480, 480, 480, 960).unwrap();
        authority.record_started();
        let error = authority
            .observe_refill_wake(0, 960, Duration::from_millis(12))
            .unwrap_err();
        assert!(error.contains("render underrun"));
        assert_eq!(authority.zero_padding_underrun_count, 1);
    }

    #[test]
    fn pacing_authority_accepts_event_driven_progress_with_nonzero_padding() {
        let mut authority = RenderPacingAuthority::default();
        authority.record_prefill(480, 480, 480, 960).unwrap();
        authority.record_started();
        authority
            .observe_refill_wake(240, 960, Duration::from_millis(5))
            .unwrap();
        authority.record_write(240);
        assert_eq!(authority.wake_count, 1);
        assert_eq!(authority.max_wake_interval_ms, 5);
        assert_eq!(authority.submitted_frames, 720);
    }

    #[test]
    fn progressing_render_survives_repeated_bounded_scheduler_delay() {
        let started = Instant::now();
        let first_progress = started + Duration::from_secs(14);
        assert!(!render_has_stalled(started, first_progress));

        let second_progress = first_progress + Duration::from_secs(14);
        assert!(!render_has_stalled(first_progress, second_progress));

        let third_progress = second_progress + Duration::from_secs(14);
        assert!(!render_has_stalled(second_progress, third_progress));
    }

    #[test]
    fn canonical_failure_scale_keeps_progress_authority_past_the_old_deadline() {
        let total_frames = 6_183_136;
        let started = Instant::now();
        let old_deadline = started + Duration::from_millis(148_000);
        let recent_progress = old_deadline - Duration::from_millis(2);

        assert!(!render_has_stalled(recent_progress, old_deadline));
        assert!(!render_absolute_timeout_expired(
            started,
            old_deadline,
            render_absolute_timeout(total_frames, 48_000),
        ));
    }

    #[test]
    fn render_without_progress_reaches_a_strict_stall_deadline() {
        let started = Instant::now();
        assert!(!render_has_stalled(
            started,
            started + RENDER_STALL_TIMEOUT
        ));
        assert!(render_has_stalled(
            started,
            started + RENDER_STALL_TIMEOUT + Duration::from_millis(1)
        ));
    }

    #[test]
    fn pathological_fragmentary_progress_still_has_an_absolute_safety_limit() {
        let started = Instant::now();
        let timeout = render_absolute_timeout(48_000, 48_000);
        assert_eq!(timeout, Duration::from_secs(121));
        assert!(!render_absolute_timeout_expired(
            started,
            started + timeout,
            timeout,
        ));
        assert!(render_absolute_timeout_expired(
            started,
            started + timeout + Duration::from_millis(1),
            timeout,
        ));
    }

    #[test]
    fn drain_progress_cannot_extend_the_shared_absolute_safety_limit() {
        let started = Instant::now();
        let timeout = render_absolute_timeout(48_000, 48_000);
        let last_padding_progress = started + timeout - Duration::from_secs(1);
        let observed = started + timeout + Duration::from_millis(1);

        assert!(!render_has_stalled(last_padding_progress, observed));
        assert!(render_absolute_timeout_expired(
            started,
            observed,
            timeout,
        ));
    }
