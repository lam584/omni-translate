    include!("process_exclusion_lifecycle.rs");

    fn probe_process_exclusion_fingerprint(
        args: &Args,
        capture_device: &Device,
        endpoint_id: String,
        endpoint_name: String,
    ) -> Result<ProbeResult, String> {
        let _probe_mutex = ProcessFingerprintMutexGuard::acquire()?;
        let ProcessExclusionProbeContext {
            pipe_name,
            start_signal_path,
            abort_signal_path,
            external_receipt_id,
            external_ready_receipt_path,
            tone_player_exe,
            diagnostic_child_tone,
            session_id,
        } = prepare_process_exclusion_probe_context(args, &endpoint_id)?;
        let mut bridge = start_bridge(
            &args.bridge_exe,
            &pipe_name,
            &args.runtime_root,
            Some(&diagnostic_child_tone),
        )?;
        let bridge_process_id = bridge.id();
        let mut retained_child_authority: RetainedDiagnosticChildAuthority =
            RetainedDiagnosticChildAuthority::default();

        let mut outcome = (|| {
            let init = request_process_exclusion_init(
                args,
                &pipe_name,
                &session_id,
                &endpoint_id,
            )?;
            if let Some(failure) = process_exclusion_init_failure(&init) {
                return Ok(failure);
            }
            let source_pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-source"))?;
            let collect_source = Arc::new(AtomicBool::new(false));
            let stop_source = Arc::new(AtomicBool::new(false));
            let reader_collect = collect_source.clone();
            let reader_stop = stop_source.clone();
            let source_reader = thread::Builder::new()
                .name("process-exclusion-fingerprint-source".to_string())
                .spawn(move || {
                    collect_bridge_source_pipe(source_pipe, reader_collect, reader_stop)
                })
                .map_err(error_text)?;

            let window_result = (|| {
                let ready = wait_for_process_capture_ready(&pipe_name)?;
                let translation_authority = translation_authority_from_init(&ready)?;
                let excluded_process_id = ready["excludedProcessId"]
                    .as_u64()
                    .and_then(|pid| u32::try_from(pid).ok())
                    .ok_or_else(|| {
                        format!("process exclusion state omitted excludedProcessId: {ready}")
                    })?;
                if excluded_process_id != bridge_process_id {
                    return Err(format!(
                        "process exclusion targeted PID {excluded_process_id}, expected Bridge PID {bridge_process_id}"
                    ));
                }

                let physical_capture = LoopbackCapture::start(capture_device)?;
                let mut discard = CaptureMetrics::default();
                let prime_started = Instant::now();
                while prime_started.elapsed() < Duration::from_millis(200) {
                    physical_capture.collect_available(&mut discard)?;
                    thread::sleep(Duration::from_millis(2));
                }

                let before = control(
                    &pipe_name,
                    json!({
                        "type": "bridge.state.query",
                        "requestId": format!("process-exclusion-before-{}", unix_ms()),
                    }),
                )?;
                let playback_frames_before =
                    before["playbackFramesWritten"].as_u64().unwrap_or(0);
                let mut external_player = start_external_tone_player(
                    &tone_player_exe,
                    &endpoint_id,
                    PROCESS_EXTERNAL_FINGERPRINT_HZ,
                    PROCESS_FINGERPRINT_AMPLITUDE,
                    PROCESS_FINGERPRINT_SECONDS,
                    &external_receipt_id,
                    &external_ready_receipt_path,
                    &start_signal_path,
                    &abort_signal_path,
                )?;
                let external_player_process_id = external_player.id();
                fs::write(&diagnostic_child_tone.trigger_path, b"play").map_err(error_text)?;
                let bridge_child_player_process_id = wait_for_diagnostic_child_pid(
                    &diagnostic_child_tone.pid_path,
                    &diagnostic_child_tone.result_path,
                    Duration::from_secs(2),
                )?;
                let bridge_child_parent_process_id =
                    parent_process_id(bridge_child_player_process_id)?;
                if bridge_child_parent_process_id != bridge_process_id {
                    return Err(format!(
                        "Bridge-child tone player PID {bridge_child_player_process_id} has parent PID {bridge_child_parent_process_id}, expected Bridge PID {bridge_process_id}"
                    ));
                }
                retain_exact_candidate_while_owned_bridge_is_active(
                    &mut retained_child_authority,
                    || owned_bridge_process_is_active(&mut bridge),
                    bridge_child_player_process_id,
                    |candidate_process_id| {
                        VerifiedDiagnosticChildProcess::open(
                            candidate_process_id,
                            bridge_process_id,
                            &tone_player_exe,
                        )
                    },
                )?;

                let total_frames =
                    (SAMPLE_RATE as f32 * PROCESS_FINGERPRINT_SECONDS) as usize;
                let external_ready = wait_for_json_file(
                    &external_ready_receipt_path,
                    Duration::from_secs(5),
                )?;
                validate_tone_ready_receipt(
                    &external_ready,
                    &external_receipt_id,
                    external_player_process_id,
                    &endpoint_id,
                    PROCESS_EXTERNAL_FINGERPRINT_HZ,
                    total_frames,
                )?;
                let bridge_child_ready = wait_for_json_file(
                    &diagnostic_child_tone.ready_receipt_path,
                    Duration::from_secs(5),
                )?;
                validate_tone_ready_receipt(
                    &bridge_child_ready,
                    &diagnostic_child_tone.receipt_id,
                    bridge_child_player_process_id,
                    &endpoint_id,
                    PROCESS_CHILD_FINGERPRINT_HZ,
                    total_frames,
                )?;

                collect_source.store(true, Ordering::Release);
                fs::write(&start_signal_path, b"start").map_err(error_text)?;
                send_translation_tone_at(
                    &pipe_name,
                    &session_id,
                    PROCESS_TRANSLATION_FINGERPRINT_HZ,
                    PROCESS_FINGERPRINT_AMPLITUDE,
                    PROCESS_FINGERPRINT_SECONDS,
                    "process-exclusion-translation",
                    translation_authority.clone(),
                )?;

                let mut physical_metrics = CaptureMetrics::default();
                let started = Instant::now();
                while started.elapsed() < Duration::from_millis(PROCESS_CAPTURE_WINDOW_MS) {
                    physical_capture.collect_available(&mut physical_metrics)?;
                    if let Some(status) = external_player.try_wait()? {
                        if !status.success() {
                            let output = external_player.wait_with_output()?;
                            return Err(format!(
                                "external fingerprint player failed early: status={status} stdout={} stderr={}",
                                String::from_utf8_lossy(&output.stdout),
                                String::from_utf8_lossy(&output.stderr),
                            ));
                        }
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                physical_capture.collect_available(&mut physical_metrics)?;
                let external_output = external_player.wait_with_output()?;
                if !external_output.status.success() {
                    return Err(format!(
                        "external fingerprint player failed: status={} stdout={} stderr={}",
                        external_output.status,
                        String::from_utf8_lossy(&external_output.stdout),
                        String::from_utf8_lossy(&external_output.stderr),
                    ));
                }
                let external_terminal: Value = serde_json::from_slice(&external_output.stdout)
                    .map_err(|error| {
                        format!(
                            "external fingerprint terminal receipt was invalid JSON: {error}; stdout={}",
                            String::from_utf8_lossy(&external_output.stdout)
                        )
                    })?;
                validate_tone_terminal_receipt(
                    &external_terminal,
                    &external_receipt_id,
                    external_player_process_id,
                    &endpoint_id,
                    PROCESS_EXTERNAL_FINGERPRINT_HZ,
                    total_frames,
                )?;
                let bridge_child_result = wait_for_json_file(
                    &diagnostic_child_tone.result_path,
                    Duration::from_secs(5),
                )?;
                if bridge_child_result["passed"] != true
                    || bridge_child_result["processId"].as_u64()
                        != Some(bridge_child_player_process_id as u64)
                    || bridge_child_result["parentProcessId"].as_u64()
                        != Some(bridge_process_id as u64)
                {
                    return Err(format!(
                        "Bridge-child tone player did not complete successfully: {bridge_child_result}"
                    ));
                }
                let bridge_child_terminal = &bridge_child_result["childEvidence"];
                validate_tone_terminal_receipt(
                    bridge_child_terminal,
                    &diagnostic_child_tone.receipt_id,
                    bridge_child_player_process_id,
                    &endpoint_id,
                    PROCESS_CHILD_FINGERPRINT_HZ,
                    total_frames,
                )?;
                let bridge_child_exit_code = bridge_child_result["exitCode"]
                    .as_i64()
                    .ok_or_else(|| {
                        format!(
                            "Bridge-child tone result omitted exitCode: {bridge_child_result}"
                        )
                    })?;

                let after = control(
                    &pipe_name,
                    json!({
                        "type": "bridge.state.query",
                        "requestId": format!("process-exclusion-after-{}", unix_ms()),
                    }),
                )?;
                Ok(ProcessExclusionCaptureWindow {
                    ready,
                    after,
                    physical_metrics,
                    playback_frames_before,
                    external_player_process_id,
                    bridge_child_player_process_id,
                    bridge_child_parent_process_id,
                    bridge_child_exit_code,
                    excluded_process_id,
                })
            })();

            collect_source.store(false, Ordering::Release);
            stop_source.store(true, Ordering::Release);
            let source_result = source_reader
                .join()
                .map_err(|_| "process exclusion source reader panicked".to_string())?;
            let window = match window_result {
                Ok(result) => result,
                Err(detail) => return Ok(ProbeResult::failed_process_exclusion(detail)),
            };
            let source_metrics = match source_result {
                Ok(metrics) => metrics,
                Err(detail) => return Ok(ProbeResult::failed_process_exclusion(detail)),
            };

            evaluate_process_exclusion_fingerprint(
                args,
                &endpoint_id,
                &endpoint_name,
                bridge_process_id,
                window,
                source_metrics,
            )
        })();

        if let Err(detail) = finish_process_exclusion_probe_lifecycle(
            &abort_signal_path,
            &pipe_name,
            &mut bridge,
            &tone_player_exe,
            &diagnostic_child_tone,
            &mut retained_child_authority,
        ) {
            outcome = Ok(ProbeResult::failed_process_exclusion(format!(
                "diagnostic child-tone cleanup did not reach a waited terminal state: {}",
                detail
            )));
        }
        outcome
    }

    include!("process_exclusion_receipts.rs");

    fn evaluate_process_exclusion_fingerprint(
        args: &Args,
        endpoint_id: &String,
        endpoint_name: &String,
        bridge_process_id: u32,
        window: ProcessExclusionCaptureWindow,
        source_metrics: CaptureMetrics,
    ) -> Result<ProbeResult, String> {
        let ProcessExclusionCaptureWindow {
            ready,
            after,
            physical_metrics,
            playback_frames_before,
            external_player_process_id,
            bridge_child_player_process_id,
            bridge_child_parent_process_id,
            bridge_child_exit_code,
            excluded_process_id,
        } = window;
        let playback_frames_after = after["playbackFramesWritten"].as_u64().unwrap_or(0);
        let source_frames_captured_before = ready["sourceFramesCaptured"].as_u64().unwrap_or(0);
        let source_frames_captured_after = after["sourceFramesCaptured"].as_u64().unwrap_or(0);
        let source_frames_captured_delta =
            source_frames_captured_after.saturating_sub(source_frames_captured_before);
        let dropped_frame_count_before = ready["droppedFrameCount"].as_u64().unwrap_or(0);
        let dropped_frame_count_after = after["droppedFrameCount"].as_u64().unwrap_or(0);
        let dropped_frame_count_delta =
            dropped_frame_count_after.saturating_sub(dropped_frame_count_before);
        let physical_samples = first_channel_samples(&physical_metrics.samples);
        let physical_translation_evidence = isolated_component_amplitude(
            &physical_samples,
            PROCESS_TRANSLATION_FINGERPRINT_HZ,
        );
        let physical_translation_component = physical_translation_evidence.isolated;
        let physical_external_component = component_amplitude(
            &physical_samples,
            PROCESS_EXTERNAL_FINGERPRINT_HZ,
        );
        let physical_bridge_child_component = component_amplitude(
            &physical_samples,
            PROCESS_CHILD_FINGERPRINT_HZ,
        );
        let empty_component_evidence = IsolatedComponentAmplitude {
            raw: 0.0,
            local_noise_floor: 0.0,
            isolated: 0.0,
        };
        let source_translation_evidence = sustained_isolated_component_amplitude(
            &source_metrics.pcm_chunks,
            PROCESS_TRANSLATION_FINGERPRINT_HZ,
        )
        .unwrap_or(empty_component_evidence);
        let source_translation_component = source_translation_evidence.isolated;
        let source_external_component = sustained_component_amplitude(
            &source_metrics.pcm_chunks,
            PROCESS_EXTERNAL_FINGERPRINT_HZ,
        )
        .unwrap_or(0.0);
        let source_bridge_child_evidence = sustained_isolated_component_amplitude(
            &source_metrics.pcm_chunks,
            PROCESS_CHILD_FINGERPRINT_HZ,
        )
        .unwrap_or(empty_component_evidence);
        let source_bridge_child_component = source_bridge_child_evidence.isolated;
        let source_fingerprint_observed_chunks = source_metrics
            .pcm_chunks
            .iter()
            .filter(|chunk| chunk.len() >= CHANNELS)
            .count();
        let source_to_physical_translation_ratio = source_translation_component
            / physical_translation_component.max(f32::EPSILON);
        let source_translation_to_external_ratio = source_translation_component
            / source_external_component.max(f32::EPSILON);
        let source_to_physical_bridge_child_ratio = source_bridge_child_component
            / physical_bridge_child_component.max(f32::EPSILON);
        let physical_translation_noise_margin = (physical_translation_evidence.raw
            - physical_translation_evidence.local_noise_floor)
            .max(0.0);
        let physical_translation_snr_ratio = physical_translation_evidence.raw
            / physical_translation_evidence
                .local_noise_floor
                .max(f32::EPSILON);
        let physical_translation_to_external_ratio = physical_translation_component
            / physical_external_component.max(f32::EPSILON);
        let minimum_physical_translation_to_external_ratio =
            args.physical_playback_level.min(100) as f32 / 100.0
                * MIN_CONFIGURED_TRANSLATION_GAIN_FRACTION;

        let physical_recording_path = args
            .runtime_root
            .join("process-exclusion-physical-output.wav");
        let source_recording_path = args
            .runtime_root
            .join("process-exclusion-source-pipe.wav");
        write_wav_pcm16(
            &physical_recording_path,
            &physical_metrics.samples,
            SAMPLE_RATE as u32,
            CHANNELS as u16,
        )?;
        write_wav_pcm16(
            &source_recording_path,
            &source_metrics.samples,
            SAMPLE_RATE as u32,
            CHANNELS as u16,
        )?;

        let mut failures = Vec::new();
        if playback_frames_after <= playback_frames_before {
            failures.push(format!(
                "Bridge translation player did not advance: before={playback_frames_before} after={playback_frames_after}"
            ));
        }
        if physical_metrics.frames() < SAMPLE_RATE {
            failures.push(format!(
                "physical loopback captured only {} frame(s)",
                physical_metrics.frames()
            ));
        }
        if source_metrics.frames() < SAMPLE_RATE {
            failures.push(format!(
                "Bridge source pipe captured only {} frame(s)",
                source_metrics.frames()
            ));
        }
        if source_fingerprint_observed_chunks < REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS {
            failures.push(format!(
                "Bridge source pipe retained only {source_fingerprint_observed_chunks} auditable 20ms fingerprint chunk(s), requires {REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS}"
            ));
        }
        if source_frames_captured_after <= source_frames_captured_before {
            failures.push(format!(
                "Bridge capture telemetry did not advance during the fingerprint window: before={source_frames_captured_before} after={source_frames_captured_after}"
            ));
        }
        if !physical_translation_is_detectable(
            &physical_translation_evidence,
            physical_external_component,
            args.physical_playback_level,
        ) {
            failures.push(format!(
                "translation fingerprint was not physically detectable above the local noise floor at the configured playback level: raw={:.6} noiseFloor={:.6} isolated={physical_translation_component:.6} noiseMargin={physical_translation_noise_margin:.6} minimumNoiseMargin={MIN_PHYSICAL_TRANSLATION_NOISE_MARGIN:.6} snrRatio={physical_translation_snr_ratio:.6} minimumSnrRatio={MIN_PHYSICAL_TRANSLATION_SNR_RATIO:.6} translationToExternalRatio={physical_translation_to_external_ratio:.6} minimumTranslationToExternalRatio={minimum_physical_translation_to_external_ratio:.6}",
                physical_translation_evidence.raw,
                physical_translation_evidence.local_noise_floor,
            ));
        }
        if physical_external_component < MIN_PROCESS_FINGERPRINT_COMPONENT {
            failures.push(format!(
                "external fingerprint was not physically rendered: component={physical_external_component:.6} minimum={MIN_PROCESS_FINGERPRINT_COMPONENT:.6}"
            ));
        }
        if physical_bridge_child_component < MIN_PROCESS_FINGERPRINT_COMPONENT {
            failures.push(format!(
                "Bridge-child fingerprint was not physically rendered: component={physical_bridge_child_component:.6} minimum={MIN_PROCESS_FINGERPRINT_COMPONENT:.6}"
            ));
        }
        if source_external_component < MIN_PROCESS_FINGERPRINT_COMPONENT {
            failures.push(format!(
                "external fingerprint did not survive process loopback: component={source_external_component:.6} minimum={MIN_PROCESS_FINGERPRINT_COMPONENT:.6}"
            ));
        }
        if source_translation_component > MAX_EXCLUDED_TRANSLATION_COMPONENT {
            failures.push(format!(
                "Bridge translation fingerprint leaked into source pipe: component={source_translation_component:.6} maximum={MAX_EXCLUDED_TRANSLATION_COMPONENT:.6}"
            ));
        }
        if source_bridge_child_component > MAX_EXCLUDED_TRANSLATION_COMPONENT {
            failures.push(format!(
                "Bridge-child fingerprint leaked into source pipe: component={source_bridge_child_component:.6} maximum={MAX_EXCLUDED_TRANSLATION_COMPONENT:.6}"
            ));
        }
        if source_to_physical_translation_ratio > MAX_EXCLUDED_TO_PHYSICAL_RATIO {
            failures.push(format!(
                "excluded/physical translation ratio is too high: ratio={source_to_physical_translation_ratio:.6} maximum={MAX_EXCLUDED_TO_PHYSICAL_RATIO:.6}"
            ));
        }
        if source_translation_to_external_ratio > MAX_EXCLUDED_TO_EXTERNAL_RATIO {
            failures.push(format!(
                "excluded/external source ratio is too high: ratio={source_translation_to_external_ratio:.6} maximum={MAX_EXCLUDED_TO_EXTERNAL_RATIO:.6}"
            ));
        }
        if source_to_physical_bridge_child_ratio > MAX_EXCLUDED_TO_PHYSICAL_RATIO {
            failures.push(format!(
                "excluded/physical Bridge-child ratio is too high: ratio={source_to_physical_bridge_child_ratio:.6} maximum={MAX_EXCLUDED_TO_PHYSICAL_RATIO:.6}"
            ));
        }
        if physical_metrics.invalid_samples > 0 {
            failures.push(format!(
                "physical loopback captured {} invalid sample(s)",
                physical_metrics.invalid_samples
            ));
        }
        if after["sourceCaptureMode"] != "process-exclusion"
            || after["captureBackend"] != "wasapi-process-exclusion"
            || after["processLoopbackStatus"] != "ready"
        {
            failures.push(format!(
                "Bridge left the process exclusion backend during the fingerprint window: {after}"
            ));
        }

        let detail = (!failures.is_empty()).then(|| failures.join("; "));
        let evidence = ProcessExclusionFingerprintEvidence {
            bridge_process_id,
            excluded_process_id,
            external_player_process_id,
            bridge_child_player_process_id,
            bridge_child_parent_process_id,
            bridge_child_exit_code,
            source_capture_mode: ready["sourceCaptureMode"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            capture_backend: ready["captureBackend"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            process_loopback_status: after["processLoopbackStatus"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            translation_frequency_hz: PROCESS_TRANSLATION_FINGERPRINT_HZ,
            external_frequency_hz: PROCESS_EXTERNAL_FINGERPRINT_HZ,
            bridge_child_frequency_hz: PROCESS_CHILD_FINGERPRINT_HZ,
            physical_translation_component,
            physical_translation_raw_component: physical_translation_evidence.raw,
            physical_translation_local_noise_floor: physical_translation_evidence.local_noise_floor,
            physical_translation_noise_margin,
            physical_translation_snr_ratio,
            physical_translation_to_external_ratio,
            minimum_physical_translation_to_external_ratio,
            physical_external_component,
            physical_bridge_child_component,
            source_translation_component,
            source_translation_raw_component: source_translation_evidence.raw,
            source_translation_local_noise_floor: source_translation_evidence.local_noise_floor,
            source_external_component,
            source_bridge_child_component,
            source_bridge_child_raw_component: source_bridge_child_evidence.raw,
            source_bridge_child_local_noise_floor: source_bridge_child_evidence.local_noise_floor,
            source_to_physical_translation_ratio,
            source_translation_to_external_ratio,
            source_to_physical_bridge_child_ratio,
            source_captured_frames: source_metrics.frames(),
            source_fingerprint_observed_chunks,
            source_fingerprint_required_chunks: REQUIRED_SUSTAINED_FINGERPRINT_CHUNKS,
            source_frames_captured_before,
            source_frames_captured_after,
            source_frames_captured_delta,
            dropped_frame_count_before,
            dropped_frame_count_after,
            dropped_frame_count_delta,
            source_rms: source_metrics.rms(),
            physical_recording_path: physical_recording_path.display().to_string(),
            source_recording_path: source_recording_path.display().to_string(),
            translation_component_limit: MAX_EXCLUDED_TRANSLATION_COMPONENT,
            source_to_physical_ratio_limit: MAX_EXCLUDED_TO_PHYSICAL_RATIO,
            source_to_external_ratio_limit: MAX_EXCLUDED_TO_EXTERNAL_RATIO,
        };
        Ok(ProbeResult {
            passed: detail.is_none(),
            skipped: false,
            status: if detail.is_none() { "passed" } else { "failed" }.to_string(),
            probe_kind: "process-exclusion-fingerprint".to_string(),
            skip_code: None,
            physical_playback_device_id: args.physical_playback_device_id.clone(),
            resolved_physical_playback_device_id: endpoint_id.clone(),
            resolved_physical_playback_device_name: endpoint_name.clone(),
            recording_path: Some(physical_recording_path.display().to_string()),
            transcription_pcm_path: None,
            playback_frames_written_before: playback_frames_before,
            playback_frames_written_after: playback_frames_after,
            captured_frames: physical_metrics.frames(),
            peak: physical_metrics.peak,
            rms: physical_metrics.rms(),
            tone_frequency_hz: PROCESS_TRANSLATION_FINGERPRINT_HZ,
            tone_component: physical_translation_component,
            silent_packets: physical_metrics.silent_packets,
            invalid_samples: physical_metrics.invalid_samples,
            process_exclusion_fingerprint: Some(evidence),
            detail,
        })
    }

    fn physical_translation_is_detectable(
        evidence: &omni_bridge_service::probe_support::IsolatedComponentAmplitude,
        physical_external_component: f32,
        physical_playback_level: u64,
    ) -> bool {
        if physical_playback_level == 0 {
            return false;
        }
        let noise_margin = (evidence.raw - evidence.local_noise_floor).max(0.0);
        let snr_ratio = evidence.raw / evidence.local_noise_floor.max(f32::EPSILON);
        let translation_to_external_ratio =
            evidence.isolated / physical_external_component.max(f32::EPSILON);
        let configured_gain = physical_playback_level.min(100) as f32 / 100.0;
        noise_margin >= MIN_PHYSICAL_TRANSLATION_NOISE_MARGIN
            && snr_ratio >= MIN_PHYSICAL_TRANSLATION_SNR_RATIO
            && translation_to_external_ratio
                >= configured_gain * MIN_CONFIGURED_TRANSLATION_GAIN_FRACTION
    }

    #[cfg(test)]
    include!("process_exclusion_detectability_tests.rs");

    #[cfg(test)]
    mod tone_receipt_contract_tests {
        use super::*;
        use std::cell::{Cell, RefCell};
        use std::collections::VecDeque;
        use std::rc::Rc;

        const RECEIPT_ID: &str = "fingerprint-receipt-123";
        const ENDPOINT_ID: &str = "physical-endpoint-456";
        const PROCESS_ID: u32 = 7_890;
        const TOTAL_FRAMES: usize = 288_000;

        struct TraceProcess {
            process_id: u32,
            object_token: &'static str,
            termination_trace: Rc<RefCell<Vec<&'static str>>>,
        }

        impl RetainedDiagnosticProcess for TraceProcess {
            fn process_id(&self) -> u32 {
                self.process_id
            }

            fn wait_or_terminate_with_timeout(self, _timeout_ms: u32) -> Result<(), String> {
                self.termination_trace.borrow_mut().push(self.object_token);
                Ok(())
            }
        }

        #[test]
        fn a_spawned_process_id_is_not_a_render_ready_receipt() {
            let spawned_only = json!({
                "processId": PROCESS_ID,
            });

            let error = validate_tone_ready_receipt(
                &spawned_only,
                RECEIPT_ID,
                PROCESS_ID,
                ENDPOINT_ID,
                PROCESS_EXTERNAL_FINGERPRINT_HZ,
                TOTAL_FRAMES,
            )
            .unwrap_err();

            assert!(error.contains("receiptType"), "unexpected error: {error}");
        }

        #[test]
        fn a_partial_render_cannot_be_accepted_as_terminal_evidence() {
            let partial = json!({
                "receiptType": "tone-render.terminal",
                "receiptVersion": 1,
                "receiptId": RECEIPT_ID,
                "passed": true,
                "processId": PROCESS_ID,
                "endpointId": ENDPOINT_ID,
                "frequencyHz": PROCESS_EXTERNAL_FINGERPRINT_HZ,
                "renderedFrames": 187_000,
                "totalFrames": TOTAL_FRAMES,
            });

            let error = validate_tone_terminal_receipt(
                &partial,
                RECEIPT_ID,
                PROCESS_ID,
                ENDPOINT_ID,
                PROCESS_EXTERNAL_FINGERPRINT_HZ,
                TOTAL_FRAMES,
            )
            .unwrap_err();

            assert!(error.contains("renderedFrames"), "unexpected error: {error}");
        }

        #[test]
        fn fully_submitted_frames_are_not_terminal_until_wasapi_drains() {
            let submitted_only = json!({
                "receiptType": "tone-render.terminal",
                "receiptVersion": 1,
                "receiptId": RECEIPT_ID,
                "passed": true,
                "processId": PROCESS_ID,
                "endpointId": ENDPOINT_ID,
                "frequencyHz": PROCESS_EXTERNAL_FINGERPRINT_HZ,
                "renderedFrames": TOTAL_FRAMES,
                "totalFrames": TOTAL_FRAMES,
                "playbackDrained": false,
                "finalPaddingFrames": 960,
            });

            let error = validate_tone_terminal_receipt(
                &submitted_only,
                RECEIPT_ID,
                PROCESS_ID,
                ENDPOINT_ID,
                PROCESS_EXTERNAL_FINGERPRINT_HZ,
                TOTAL_FRAMES,
            )
            .unwrap_err();

            assert!(error.contains("playback queue drained"), "unexpected error: {error}");
        }

        #[test]
        fn cleanup_identity_requires_the_bridge_parent_and_exact_helper_executable() {
            let expected = std::path::Path::new(
                r"C:\omni\omni-tone-render-probe.exe",
            );

            let parent_error = validate_diagnostic_child_identity(
                PROCESS_ID,
                41,
                42,
                expected,
                expected,
            )
            .unwrap_err();
            assert!(parent_error.contains("parent identity mismatch"));

            let executable_error = validate_diagnostic_child_identity(
                PROCESS_ID,
                42,
                42,
                std::path::Path::new(r"C:\omni\unrelated.exe"),
                expected,
            )
            .unwrap_err();
            assert!(executable_error.contains("executable identity mismatch"));
        }

        #[test]
        fn cleanup_identity_accepts_windows_case_and_extended_path_prefix() {
            validate_diagnostic_child_identity(
                PROCESS_ID,
                42,
                42,
                std::path::Path::new(r"\\?\C:\OMNI\OMNI-TONE-RENDER-PROBE.EXE"),
                std::path::Path::new(r"c:\omni\omni-tone-render-probe.exe"),
            )
            .unwrap();
        }

        #[test]
        fn shutdown_receipt_rejects_errors_and_unconverged_terminal_evidence() {
            let bridge_error = json!({
                "type": "bridge.error",
                "code": "bridge.timeout",
            });
            assert!(validate_shutdown_terminal_receipt(&bridge_error).is_err());

            let mut receipt = json!({
                "type": "bridge.state.snapshot",
                "bridgeState": "stopped",
                "lifecycleState": "stopped",
                "processLoopbackShutdownRequestedGeneration": 77,
                "processLoopbackTerminalGeneration": 76,
                "processLoopbackTerminalStatus": "stopped",
                "processLoopbackTerminalTimestampMs": 9_001,
            });
            let generation_error = validate_shutdown_terminal_receipt(&receipt).unwrap_err();
            assert!(generation_error.contains("did not converge"));

            receipt["processLoopbackTerminalGeneration"] = json!(77);
            receipt["processLoopbackTerminalStatus"] = json!("capture-failed");
            let status_error = validate_shutdown_terminal_receipt(&receipt).unwrap_err();
            assert!(status_error.contains("authorized terminal status"));
        }

        #[test]
        fn shutdown_receipt_accepts_generation_bound_stopped_evidence() {
            let receipt = json!({
                "type": "bridge.state.snapshot",
                "bridgeState": "stopped",
                "lifecycleState": "stopped",
                "processLoopbackShutdownRequestedGeneration": 77,
                "processLoopbackTerminalGeneration": 77,
                "processLoopbackTerminalStatus": "not-active",
                "processLoopbackTerminalTimestampMs": 9_001,
            });

            validate_shutdown_terminal_receipt(&receipt).unwrap();
        }

        #[test]
        fn verified_owned_process_is_terminated_and_waited_without_sleep() {
            let command_executable = PathBuf::from(
                std::env::var_os("COMSPEC").expect("Windows COMSPEC must identify cmd.exe"),
            );
            let mut child = Command::new(&command_executable)
                .args(["/d", "/q", "/c", "set /p hold="])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let verified = VerifiedDiagnosticChildProcess::open(
                child.id(),
                std::process::id(),
                &command_executable,
            )
            .unwrap();
            let mut authority = RetainedDiagnosticChildAuthority::default();
            authority.retain_while_bridge_alive(verified).unwrap();
            authority.mark_bridge_terminal();

            authority.finish_with_timeout(0).unwrap();

            assert!(child.wait().unwrap().code().is_some());
        }

        #[test]
        fn terminal_phase_cannot_replace_a_retained_handle_with_a_reused_pid_object() {
            let trace = Rc::new(RefCell::new(Vec::new()));
            let mut authority = RetainedDiagnosticChildAuthority::default();
            authority
                .retain_while_bridge_alive(TraceProcess {
                    process_id: PROCESS_ID,
                    object_token: "H_owned",
                    termination_trace: trace.clone(),
                })
                .unwrap();
            authority.mark_bridge_terminal();

            let error = authority
                .retain_while_bridge_alive(TraceProcess {
                    process_id: PROCESS_ID,
                    object_token: "H_reused",
                    termination_trace: trace.clone(),
                })
                .unwrap_err();
            assert!(error.contains("cannot gain termination authority"));
            authority.finish_with_timeout(0).unwrap();

            assert_eq!(&*trace.borrow(), &["H_owned"]);
        }

        #[test]
        fn terminal_phase_candidate_cannot_gain_authority_when_nothing_was_retained() {
            let trace = Rc::new(RefCell::new(Vec::new()));
            let mut authority = RetainedDiagnosticChildAuthority::default();
            authority.mark_bridge_terminal();

            let cleanup_failure = authority
                .retain_while_bridge_alive(TraceProcess {
                    process_id: PROCESS_ID,
                    object_token: "H_reused",
                    termination_trace: trace.clone(),
                })
                .unwrap_err();
            assert!(cleanup_failure.contains("after Bridge terminal"));
            authority.finish_with_timeout(0).unwrap();

            assert!(trace.borrow().is_empty());
        }

        #[test]
        fn bridge_terminal_before_scan_never_enumerates_or_opens_candidates() {
            let trace = Rc::new(RefCell::new(Vec::new()));
            let enumerate_count = Rc::new(Cell::new(0));
            let open_count = Rc::new(Cell::new(0));
            let mut authority = RetainedDiagnosticChildAuthority::<TraceProcess>::default();

            let error = retain_candidates_while_owned_bridge_is_active(
                &mut authority,
                || Ok(false),
                {
                    let enumerate_count = enumerate_count.clone();
                    move || {
                        enumerate_count.set(enumerate_count.get() + 1);
                        Ok(vec![PROCESS_ID])
                    }
                },
                {
                    let open_count = open_count.clone();
                    let trace = trace.clone();
                    move |process_id| {
                        open_count.set(open_count.get() + 1);
                        Ok(TraceProcess {
                            process_id,
                            object_token: "H_reused",
                            termination_trace: trace.clone(),
                        })
                    }
                },
            )
            .unwrap_err();

            assert!(error.contains("before diagnostic child enumeration"));
            assert_eq!(enumerate_count.get(), 0);
            assert_eq!(open_count.get(), 0);
            authority.mark_bridge_terminal();
            authority.finish_with_timeout(0).unwrap();
            assert!(trace.borrow().is_empty());
        }

        #[test]
        fn bridge_terminal_during_scan_discards_opened_candidate_without_authority() {
            let trace = Rc::new(RefCell::new(Vec::new()));
            let liveness = Rc::new(RefCell::new(VecDeque::from([true, true, false])));
            let enumerate_count = Rc::new(Cell::new(0));
            let open_count = Rc::new(Cell::new(0));
            let mut authority = RetainedDiagnosticChildAuthority::<TraceProcess>::default();

            let error = retain_candidates_while_owned_bridge_is_active(
                &mut authority,
                {
                    let liveness = liveness.clone();
                    move || Ok(liveness.borrow_mut().pop_front().unwrap())
                },
                {
                    let enumerate_count = enumerate_count.clone();
                    move || {
                        enumerate_count.set(enumerate_count.get() + 1);
                        Ok(vec![PROCESS_ID])
                    }
                },
                {
                    let open_count = open_count.clone();
                    let trace = trace.clone();
                    move |process_id| {
                        open_count.set(open_count.get() + 1);
                        Ok(TraceProcess {
                            process_id,
                            object_token: "H_candidate",
                            termination_trace: trace.clone(),
                        })
                    }
                },
            )
            .unwrap_err();

            assert!(error.contains("before retaining diagnostic child"));
            assert_eq!(enumerate_count.get(), 1);
            assert_eq!(open_count.get(), 1);
            authority.mark_bridge_terminal();
            authority.finish_with_timeout(0).unwrap();
            assert!(trace.borrow().is_empty());
        }

        #[test]
        fn exact_pid_terminal_during_open_cannot_reach_retained_authority() {
            let trace = Rc::new(RefCell::new(Vec::new()));
            let liveness = Rc::new(RefCell::new(VecDeque::from([true, true, false])));
            let open_count = Rc::new(Cell::new(0));
            let mut authority = RetainedDiagnosticChildAuthority::<TraceProcess>::default();

            let error = retain_exact_candidate_while_owned_bridge_is_active(
                &mut authority,
                {
                    let liveness = liveness.clone();
                    move || Ok(liveness.borrow_mut().pop_front().unwrap())
                },
                PROCESS_ID,
                {
                    let open_count = open_count.clone();
                    let trace = trace.clone();
                    move |process_id| {
                        open_count.set(open_count.get() + 1);
                        Ok(TraceProcess {
                            process_id,
                            object_token: "H_exact_candidate",
                            termination_trace: trace.clone(),
                        })
                    }
                },
            )
            .unwrap_err();

            assert!(error.contains("before retaining diagnostic child"));
            assert_eq!(open_count.get(), 1);
            authority.mark_bridge_terminal();
            authority.finish_with_timeout(0).unwrap();
            assert!(trace.borrow().is_empty());
        }

        #[test]
        fn bridge_terminal_after_owned_retention_only_finishes_owned_handle() {
            let trace = Rc::new(RefCell::new(Vec::new()));
            let enumerate_count = Rc::new(Cell::new(0));
            let open_count = Rc::new(Cell::new(0));
            let mut authority = RetainedDiagnosticChildAuthority::<TraceProcess>::default();
            authority
                .retain_while_bridge_alive(TraceProcess {
                    process_id: PROCESS_ID,
                    object_token: "H_owned",
                    termination_trace: trace.clone(),
                })
                .unwrap();

            let error = retain_candidates_while_owned_bridge_is_active(
                &mut authority,
                || Ok(false),
                {
                    let enumerate_count = enumerate_count.clone();
                    move || {
                        enumerate_count.set(enumerate_count.get() + 1);
                        Ok(vec![PROCESS_ID])
                    }
                },
                {
                    let open_count = open_count.clone();
                    let trace = trace.clone();
                    move |process_id| {
                        open_count.set(open_count.get() + 1);
                        Ok(TraceProcess {
                            process_id,
                            object_token: "H_reused",
                            termination_trace: trace.clone(),
                        })
                    }
                },
            )
            .unwrap_err();

            assert!(error.contains("before diagnostic child enumeration"));
            assert_eq!(enumerate_count.get(), 0);
            assert_eq!(open_count.get(), 0);
            authority.mark_bridge_terminal();
            authority.finish_with_timeout(0).unwrap();
            assert_eq!(&*trace.borrow(), &["H_owned"]);
        }
    }

    fn wait_for_process_capture_ready(pipe_name: &str) -> Result<Value, String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let state = control(
                pipe_name,
                json!({
                    "type": "bridge.state.query",
                    "requestId": format!("process-exclusion-ready-{}", unix_ms()),
                }),
            )?;
            if state["processLoopbackStatus"] == "failed" {
                return Err(format!(
                    "process loopback capture failed before fingerprint playback: code={} detail={}",
                    state["lastErrorCode"].as_str().unwrap_or("unknown"),
                    state["processLoopbackFailureDetail"]
                        .as_str()
                        .unwrap_or("no detail"),
                ));
            }
            if process_capture_state_is_ready(&state) {
                return Ok(state);
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "process loopback capture did not become ready within 5 seconds: {state}"
                ));
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn process_capture_state_is_ready(state: &Value) -> bool {
        let lifecycle = state["captureLifecycleState"].as_str().unwrap_or_default();
        let lifecycle_ready = lifecycle == "process-loopback-running"
            || (lifecycle == "source-frame-delivered"
                && state["captureFramesReceived"].as_u64().unwrap_or(0) > 0);
        lifecycle_ready
            && state["sourceSubscriberActive"] == true
            && state["processLoopbackStatus"] == "ready"
    }

    fn collect_bridge_source_pipe(
        mut pipe: File,
        collect: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
    ) -> Result<CaptureMetrics, String> {
        let mut metrics = CaptureMetrics::default();
        loop {
            let mut header_size = [0_u8; 4];
            if let Err(error) = pipe.read_exact(&mut header_size) {
                if stop.load(Ordering::Acquire) {
                    return Ok(metrics);
                }
                return Err(format!("Bridge source header size read failed: {error}"));
            }
            let header_size = u32::from_le_bytes(header_size) as usize;
            if header_size == 0 || header_size > 64 * 1024 {
                return Err(format!("Bridge source header size is invalid: {header_size}"));
            }
            let mut header_bytes = vec![0_u8; header_size];
            pipe.read_exact(&mut header_bytes)
                .map_err(|error| format!("Bridge source header read failed: {error}"))?;
            let header_value: Value = serde_json::from_slice(&header_bytes).map_err(error_text)?;
            if header_value["type"].as_str() == Some("bridge.translation.status") {
                let status: TranslationPlaybackStatusEvent =
                    serde_json::from_value(header_value).map_err(error_text)?;
                let ack = TranslationPlaybackStatusAck {
                    event_type: "bridge.translation.status.ack".to_string(),
                    status_id: status.status_id,
                    session_id: status.session_id,
                    bridge_instance_id: status.bridge_instance_id,
                    source_generation: status.source_generation,
                    source_generation_token: status.source_generation_token,
                    playback_owner_generation: status.playback_owner_generation,
                    physical_playback_device_id: status.physical_playback_device_id,
                };
                let ack = serde_json::to_vec(&ack).map_err(error_text)?;
                pipe.write_all(&(ack.len() as u32).to_le_bytes())
                    .map_err(|error| format!("Bridge status ack size write failed: {error}"))?;
                pipe.write_all(&ack)
                    .map_err(|error| format!("Bridge status ack write failed: {error}"))?;
                pipe.flush()
                    .map_err(|error| format!("Bridge status ack flush failed: {error}"))?;
                if stop.load(Ordering::Acquire) {
                    return Ok(metrics);
                }
                continue;
            }
            let header: AudioFrameHeader =
                serde_json::from_value(header_value.clone()).map_err(error_text)?;
            let mut payload = vec![0_u8; header.payload_bytes];
            pipe.read_exact(&mut payload)
                .map_err(|error| format!("Bridge source payload read failed: {error}"))?;
            if header.event_type == "bridge.source.error" {
                return Err(format!(
                    "Bridge source route failed during fingerprint capture: code={} message={}",
                    header_value["errorCode"].as_str().unwrap_or("unknown"),
                    header_value["message"].as_str().unwrap_or("no detail"),
                ));
            }
            if header.event_type == "bridge.source.frame" && collect.load(Ordering::Acquire) {
                if header.sample_rate_hz != SAMPLE_RATE as u32
                    || header.channel_count != CHANNELS as u16
                    || header.sample_format != AudioSampleFormat::PcmS16le
                {
                    return Err(format!(
                        "Bridge source format changed during fingerprint capture: sampleRateHz={} channelCount={}",
                        header.sample_rate_hz, header.channel_count,
                    ));
                }
                metrics.append_pcm16le(&payload);
            }
            if stop.load(Ordering::Acquire) {
                return Ok(metrics);
            }
        }
    }

    include!("process_exclusion_process_lifecycle.rs");
