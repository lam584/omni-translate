// Process-tree exclusion fingerprint orchestration and evidence helpers.

    const PROCESS_TRANSLATION_FINGERPRINT_HZ: f32 = 997.0;
    const PROCESS_EXTERNAL_FINGERPRINT_HZ: f32 = 1_733.0;
    const PROCESS_CHILD_FINGERPRINT_HZ: f32 = 2_449.0;
    // Keep the authority threshold strict while surviving endpoints that apply
    // a fixed shared-mode attenuation. 0.36 remains below clipping even
    // with all three diagnostic tones present; the production translation
    // playback level is still independently verified at 50%.
    const PROCESS_FINGERPRINT_AMPLITUDE: f32 = 0.36;
    // Child-process creation and WASAPI shared-mode startup can consume more
    // than a second on a loaded Windows worker. Keep every diagnostic emitter
    // alive long enough that the post-readiness measurement still contains at
    // least one complete second of source authority; the evaluator continues
    // to require the original 48k captured-frame floor.
    const PROCESS_FINGERPRINT_SECONDS: f32 = 6.0;
    const PROCESS_CAPTURE_WINDOW_MS: u64 = 6_800;
    const MIN_PROCESS_FINGERPRINT_COMPONENT: f32 = 0.01;
    const MAX_EXCLUDED_TRANSLATION_COMPONENT: f32 = 0.003;
    const MAX_EXCLUDED_TO_PHYSICAL_RATIO: f32 = 0.05;
    const MAX_EXCLUDED_TO_EXTERNAL_RATIO: f32 = 0.05;
    const MIN_PHYSICAL_TRANSLATION_NOISE_MARGIN: f32 = 0.001;
    const MIN_PHYSICAL_TRANSLATION_SNR_RATIO: f32 = 2.0;
    const MIN_CONFIGURED_TRANSLATION_GAIN_FRACTION: f32 = 0.5;
    const PROCESS_FINGERPRINT_MUTEX_NAME: &str =
        r"Local\OmniTranslate.ProcessExclusionFingerprintProbe.v1";
    const PROCESS_FINGERPRINT_MUTEX_TIMEOUT_MS: u32 = 120_000;

    struct DiagnosticBridgeChildTone {
        executable: PathBuf,
        trigger_path: PathBuf,
        pid_path: PathBuf,
        result_path: PathBuf,
        endpoint_id: String,
    }

    struct ProcessExclusionCaptureWindow {
        ready: Value,
        after: Value,
        physical_metrics: CaptureMetrics,
        playback_frames_before: u64,
        external_player_process_id: u32,
        bridge_child_player_process_id: u32,
        bridge_child_parent_process_id: u32,
        bridge_child_exit_code: i64,
        excluded_process_id: u32,
    }

    struct WinHandle(HANDLE);

    impl WinHandle {
        fn new(handle: HANDLE, operation: &str) -> Result<Self, String> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "{operation} failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self(handle))
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for WinHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct ProcessFingerprintMutexGuard(WinHandle);

    impl ProcessFingerprintMutexGuard {
        fn acquire() -> Result<Self, String> {
            let name = PROCESS_FINGERPRINT_MUTEX_NAME
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let handle = WinHandle::new(
                unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) },
                "CreateMutexW(process exclusion fingerprint)",
            )?;
            let wait_result =
                unsafe { WaitForSingleObject(handle.raw(), PROCESS_FINGERPRINT_MUTEX_TIMEOUT_MS) };
            match wait_result {
                0 | 0x80 => Ok(Self(handle)),
                0x102 => Err(format!(
                    "timed out after {PROCESS_FINGERPRINT_MUTEX_TIMEOUT_MS}ms waiting for another process exclusion fingerprint probe to finish"
                )),
                result => Err(format!(
                    "WaitForSingleObject(process exclusion fingerprint) failed: result=0x{result:08x} error={}",
                    std::io::Error::last_os_error()
                )),
            }
        }
    }

    impl Drop for ProcessFingerprintMutexGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = ReleaseMutex(self.0.raw());
            }
        }
    }

    fn probe_process_exclusion_fingerprint(
        args: &Args,
        capture_device: &Device,
        endpoint_id: String,
        endpoint_name: String,
    ) -> Result<ProbeResult, String> {
        let _probe_mutex = ProcessFingerprintMutexGuard::acquire()?;
        let pipe_name = format!("omni-process-exclusion-fingerprint-{}", std::process::id());
        let diagnostic_nonce = format!("{}-{}", std::process::id(), unix_ms());
        let tone_player_exe = resolve_tone_player_exe(args)?;
        let diagnostic_child_tone = DiagnosticBridgeChildTone {
            executable: tone_player_exe.clone(),
            trigger_path: args
                .runtime_root
                .join(format!("process-exclusion-child-{diagnostic_nonce}.trigger")),
            pid_path: args
                .runtime_root
                .join(format!("process-exclusion-child-{diagnostic_nonce}.pid")),
            result_path: args
                .runtime_root
                .join(format!("process-exclusion-child-{diagnostic_nonce}.json")),
            endpoint_id: endpoint_id.clone(),
        };
        let mut bridge = start_bridge(
            &args.bridge_exe,
            &pipe_name,
            &args.runtime_root,
            Some(&diagnostic_child_tone),
        )?;
        let bridge_process_id = bridge.id();
        let session_id = format!("process-exclusion-fingerprint-session-{}", unix_ms());

        let outcome = (|| {
            let init = control(
                &pipe_name,
                json!({
                    "type": "bridge.init",
                    "requestId": format!("process-exclusion-fingerprint-init-{}", unix_ms()),
                    "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                    "sessionId": session_id,
                    "installChannel": "development",
                    "targetDeviceId": "virtual-mic-default",
                    "virtualRenderDeviceId": "virtual-speaker-default",
                    "physicalPlaybackDeviceId": endpoint_id,
                    "physicalPlaybackLevel": args.physical_playback_level.min(100),
                    "sourceCaptureMode": "process-exclusion",
                    "monitorPlaybackEnabled": false,
                    "translationPlaybackEnabled": true,
                    "expectedDriverVersion": "0.10.0-dev",
                    "expectedBridgeVersion": "0.1.0",
                    "mixControl": {
                        "keepOriginalAudio": false,
                        "translatedAudioEnabled": true,
                        "translatedAudioGainDb": 0,
                        "translatedAudioAutoGainEnabled": false,
                        "originalAudioGainDb": 0,
                        "duckingEnabled": false,
                        "duckingDepthPercent": 0,
                        "monitorMode": "translated-only"
                    }
                }),
            )?;
            if init["type"] == "bridge.error" {
                let code = init["code"].as_str().unwrap_or("bridge.process-loopback-activation-failed");
                let detail = format!(
                    "process exclusion fingerprint init failed: code={code} response={init}"
                );
                return Ok(if code == "bridge.process-loopback-unsupported" {
                    ProbeResult::skipped_process_exclusion(code, detail)
                } else {
                    ProbeResult::failed_process_exclusion(detail)
                });
            }
            if init["bridgeState"] != "running"
                || init["sourceCaptureMode"] != "process-exclusion"
                || init["captureBackend"] != "wasapi-process-exclusion"
                || init["processLoopbackStatus"] != "ready"
            {
                return Ok(ProbeResult::failed_process_exclusion(format!(
                    "process exclusion fingerprint init did not return a ready process backend: {init}"
                )));
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
                collect_source.store(true, Ordering::Release);
                send_translation_tone_at(
                    &pipe_name,
                    &session_id,
                    PROCESS_TRANSLATION_FINGERPRINT_HZ,
                    PROCESS_FINGERPRINT_AMPLITUDE,
                    PROCESS_FINGERPRINT_SECONDS,
                    "process-exclusion-translation",
                    translation_authority.clone(),
                )?;
                let mut external_player = start_external_tone_player(
                    &tone_player_exe,
                    &endpoint_id,
                    PROCESS_EXTERNAL_FINGERPRINT_HZ,
                    PROCESS_FINGERPRINT_AMPLITUDE,
                    PROCESS_FINGERPRINT_SECONDS,
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

                // Publishing the child PID proves that Bridge spawned the
                // descendant, not that its independent WASAPI stream has
                // started rendering yet.  Give that stream one shared-mode
                // scheduling quantum before opening the measurement window;
                // otherwise a valid child can complete just after the short
                // fingerprint window and look falsely absent from physical
                // evidence.  The subsequent frequency threshold is unchanged.
                thread::sleep(Duration::from_millis(250));

                let mut physical_metrics = CaptureMetrics::default();
                let started = Instant::now();
                while started.elapsed() < Duration::from_millis(PROCESS_CAPTURE_WINDOW_MS) {
                    physical_capture.collect_available(&mut physical_metrics)?;
                    if let Some(status) = external_player.try_wait().map_err(error_text)? {
                        if !status.success() {
                            let output = external_player.wait_with_output().map_err(error_text)?;
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
                let external_output = external_player.wait_with_output().map_err(error_text)?;
                if !external_output.status.success() {
                    return Err(format!(
                        "external fingerprint player failed: status={} stdout={} stderr={}",
                        external_output.status,
                        String::from_utf8_lossy(&external_output.stdout),
                        String::from_utf8_lossy(&external_output.stderr),
                    ));
                }
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

        shutdown_bridge(&pipe_name);
        stop_child(&mut bridge);
        outcome
    }

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

    fn resolve_tone_player_exe(args: &Args) -> Result<PathBuf, String> {
        if let Some(path) = &args.tone_player_exe {
            return Ok(path.clone());
        }
        let current_exe = std::env::current_exe().map_err(error_text)?;
        let file_name = if cfg!(windows) {
            "omni-tone-render-probe.exe"
        } else {
            "omni-tone-render-probe"
        };
        Ok(current_exe
            .parent()
            .ok_or_else(|| format!("probe executable has no parent: {}", current_exe.display()))?
            .join(file_name))
    }

    fn start_external_tone_player(
        exe: &PathBuf,
        endpoint_id: &str,
        frequency_hz: f32,
        amplitude: f32,
        seconds: f32,
    ) -> Result<Child, String> {
        if !exe.is_file() {
            return Err(format!(
                "external tone player executable was not found: {}",
                exe.display()
            ));
        }
        Command::new(exe)
            .arg("--endpoint-id")
            .arg(endpoint_id)
            .arg("--frequency-hz")
            .arg(frequency_hz.to_string())
            .arg("--amplitude")
            .arg(amplitude.to_string())
            .arg("--seconds")
            .arg(seconds.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(error_text)
    }

    fn parent_process_id(process_id: u32) -> Result<u32, String> {
        let snapshot = WinHandle::new(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) },
            "CreateToolhelp32Snapshot",
        )?;
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32FirstW(snapshot.raw(), &mut entry) } == 0 {
            return Err(format!(
                "Process32FirstW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        loop {
            if entry.th32ProcessID == process_id {
                return Ok(entry.th32ParentProcessID);
            }
            if unsafe { Process32NextW(snapshot.raw(), &mut entry) } == 0 {
                break;
            }
        }
        Err(format!(
            "Bridge-child tone player PID {process_id} was not present in the process snapshot"
        ))
    }

    fn wait_for_diagnostic_child_pid(
        path: &PathBuf,
        result_path: &PathBuf,
        timeout: Duration,
    ) -> Result<u32, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(raw) = fs::read_to_string(path) {
                return raw.trim().parse::<u32>().map_err(|error| {
                    format!(
                        "Bridge-child PID file '{}' is invalid: {error}",
                        path.display()
                    )
                });
            }
            if let Ok(bytes) = fs::read(result_path) {
                let failure: Value = serde_json::from_slice(&bytes).map_err(error_text)?;
                return Err(format!(
                    "Bridge failed before publishing its diagnostic child PID: {failure}"
                ));
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Bridge did not publish its diagnostic child PID within {} ms: {}",
                    timeout.as_millis(),
                    path.display()
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn wait_for_json_file(path: &PathBuf, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(bytes) = fs::read(path) {
                return serde_json::from_slice(&bytes).map_err(|error| {
                    format!(
                        "diagnostic JSON file '{}' is invalid: {error}",
                        path.display()
                    )
                });
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Bridge did not publish diagnostic child result within {} ms: {}",
                    timeout.as_millis(),
                    path.display()
                ));
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
