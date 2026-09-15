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
    const PROCESS_SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

    struct DiagnosticBridgeChildTone {
        executable: PathBuf,
        trigger_path: PathBuf,
        pid_path: PathBuf,
        ready_receipt_path: PathBuf,
        result_path: PathBuf,
        start_signal_path: PathBuf,
        abort_signal_path: PathBuf,
        receipt_id: String,
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

    struct OwnedToneProcess(Option<Child>);

    impl OwnedToneProcess {
        fn new(child: Child) -> Self {
            Self(Some(child))
        }

        fn id(&self) -> u32 {
            self.0.as_ref().expect("tone process must exist").id()
        }

        fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, String> {
            self.0
                .as_mut()
                .expect("tone process must exist")
                .try_wait()
                .map_err(error_text)
        }

        fn wait_with_output(&mut self) -> Result<std::process::Output, String> {
            self.0
                .take()
                .expect("tone process must exist")
                .wait_with_output()
                .map_err(error_text)
        }
    }

    impl Drop for OwnedToneProcess {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
        }
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

    struct VerifiedDiagnosticChildProcess {
        process_id: u32,
        parent_process_id: u32,
        handle: WinHandle,
    }

    impl VerifiedDiagnosticChildProcess {
        fn open(
            process_id: u32,
            expected_parent_process_id: u32,
            expected_executable: &PathBuf,
        ) -> Result<Self, String> {
            let parent_process_id = parent_process_id(process_id)?;
            let handle = WinHandle::new(
                unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION
                            | PROCESS_TERMINATE
                            | PROCESS_SYNCHRONIZE_ACCESS,
                        0,
                        process_id,
                    )
                },
                "OpenProcess(diagnostic child tone)",
            )?;
            let actual_executable = process_executable_path(handle.raw())?;
            validate_diagnostic_child_identity(
                process_id,
                parent_process_id,
                expected_parent_process_id,
                &actual_executable,
                expected_executable,
            )?;
            Ok(Self {
                process_id,
                parent_process_id,
                handle,
            })
        }

        fn wait_or_terminate_with_timeout(self, timeout_ms: u32) -> Result<(), String> {
            match unsafe { WaitForSingleObject(self.handle.raw(), timeout_ms) } {
                0 => Ok(()),
                0x102 => {
                    if unsafe { TerminateProcess(self.handle.raw(), 0xE001_0001) } == 0 {
                        if unsafe { WaitForSingleObject(self.handle.raw(), 0) } == 0 {
                            return Ok(());
                        }
                        return Err(format!(
                            "TerminateProcess(diagnostic child tone PID {}, parent PID {}) failed: {}",
                            self.process_id,
                            self.parent_process_id,
                            std::io::Error::last_os_error()
                        ));
                    }
                    match unsafe { WaitForSingleObject(self.handle.raw(), 5_000) } {
                        0 => Ok(()),
                        result => Err(format!(
                            "diagnostic child tone PID {}, parent PID {} did not terminate after TerminateProcess: waitResult=0x{result:08x}",
                            self.process_id,
                            self.parent_process_id
                        )),
                    }
                }
                result => Err(format!(
                    "WaitForSingleObject(diagnostic child tone PID {}, parent PID {}) failed: waitResult=0x{result:08x} error={}",
                    self.process_id,
                    self.parent_process_id,
                    std::io::Error::last_os_error()
                )),
            }
        }
    }

    trait RetainedDiagnosticProcess: Sized {
        fn process_id(&self) -> u32;
        fn wait_or_terminate_with_timeout(self, timeout_ms: u32) -> Result<(), String>;
    }

    impl RetainedDiagnosticProcess for VerifiedDiagnosticChildProcess {
        fn process_id(&self) -> u32 {
            self.process_id
        }

        fn wait_or_terminate_with_timeout(self, timeout_ms: u32) -> Result<(), String> {
            VerifiedDiagnosticChildProcess::wait_or_terminate_with_timeout(self, timeout_ms)
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum BridgeAuthorityPhase {
        Alive,
        Terminal,
    }

    struct RetainedDiagnosticChildAuthority<P = VerifiedDiagnosticChildProcess> {
        phase: BridgeAuthorityPhase,
        children: Vec<P>,
    }

    impl<P> Default for RetainedDiagnosticChildAuthority<P> {
        fn default() -> Self {
            Self {
                phase: BridgeAuthorityPhase::Alive,
                children: Vec::new(),
            }
        }
    }

    impl<P: RetainedDiagnosticProcess> RetainedDiagnosticChildAuthority<P> {
        fn retain_while_bridge_alive(&mut self, child: P) -> Result<(), String> {
            if self.phase != BridgeAuthorityPhase::Alive {
                return Err(format!(
                    "diagnostic child PID {} cannot gain termination authority after Bridge terminal",
                    child.process_id()
                ));
            }
            if self
                .children
                .iter()
                .any(|retained| retained.process_id() == child.process_id())
            {
                return Ok(());
            }
            self.children.push(child);
            Ok(())
        }

        fn mark_bridge_terminal(&mut self) {
            self.phase = BridgeAuthorityPhase::Terminal;
        }

        fn finish(self) -> Result<(), String> {
            self.finish_with_timeout(5_000)
        }

        fn finish_with_timeout(self, timeout_ms: u32) -> Result<(), String> {
            let mut failures = Vec::new();
            if self.phase != BridgeAuthorityPhase::Terminal {
                failures.push(
                    "diagnostic child cleanup began before Bridge terminal was confirmed"
                        .to_string(),
                );
            }
            for child in self.children {
                if let Err(detail) = child.wait_or_terminate_with_timeout(timeout_ms) {
                    failures.push(detail);
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join(" | "))
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

    struct ProcessExclusionProbeContext {
        pipe_name: String,
        start_signal_path: PathBuf,
        abort_signal_path: PathBuf,
        external_receipt_id: String,
        external_ready_receipt_path: PathBuf,
        tone_player_exe: PathBuf,
        diagnostic_child_tone: DiagnosticBridgeChildTone,
        session_id: String,
    }

    fn prepare_process_exclusion_probe_context(
        args: &Args,
        endpoint_id: &str,
    ) -> Result<ProcessExclusionProbeContext, String> {
        let pipe_name = format!("omni-process-exclusion-fingerprint-{}", std::process::id());
        let diagnostic_nonce = format!("{}-{}", std::process::id(), unix_ms());
        let start_signal_path = args
            .runtime_root
            .join(format!("process-exclusion-tone-{diagnostic_nonce}.start"));
        let abort_signal_path = args
            .runtime_root
            .join(format!("process-exclusion-tone-{diagnostic_nonce}.abort"));
        let external_receipt_id = format!("process-exclusion-external-{diagnostic_nonce}");
        let external_ready_receipt_path = args
            .runtime_root
            .join(format!("process-exclusion-external-{diagnostic_nonce}.ready.json"));
        let tone_player_exe = resolve_tone_player_exe(args)?;
        let diagnostic_child_tone = DiagnosticBridgeChildTone {
            executable: tone_player_exe.clone(),
            trigger_path: args
                .runtime_root
                .join(format!("process-exclusion-child-{diagnostic_nonce}.trigger")),
            pid_path: args
                .runtime_root
                .join(format!("process-exclusion-child-{diagnostic_nonce}.pid")),
            ready_receipt_path: args
                .runtime_root
                .join(format!("process-exclusion-child-{diagnostic_nonce}.ready.json")),
            result_path: args
                .runtime_root
                .join(format!("process-exclusion-child-{diagnostic_nonce}.json")),
            start_signal_path: start_signal_path.clone(),
            abort_signal_path: abort_signal_path.clone(),
            receipt_id: format!("process-exclusion-child-{diagnostic_nonce}"),
            endpoint_id: endpoint_id.to_string(),
        };
        Ok(ProcessExclusionProbeContext {
            pipe_name,
            start_signal_path,
            abort_signal_path,
            external_receipt_id,
            external_ready_receipt_path,
            tone_player_exe,
            diagnostic_child_tone,
            session_id: format!("process-exclusion-fingerprint-session-{}", unix_ms()),
        })
    }

    fn request_process_exclusion_init(
        args: &Args,
        pipe_name: &str,
        session_id: &str,
        endpoint_id: &str,
    ) -> Result<Value, String> {
        control(
            pipe_name,
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
        )
    }

    fn process_exclusion_init_failure(init: &Value) -> Option<ProbeResult> {
        if init["type"] == "bridge.error" {
            let code = init["code"]
                .as_str()
                .unwrap_or("bridge.process-loopback-activation-failed");
            let detail =
                format!("process exclusion fingerprint init failed: code={code} response={init}");
            return Some(if code == "bridge.process-loopback-unsupported" {
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
            return Some(ProbeResult::failed_process_exclusion(format!(
                "process exclusion fingerprint init did not return a ready process backend: {init}"
            )));
        }
        None
    }

    fn finish_process_exclusion_probe_lifecycle(
        abort_signal_path: &PathBuf,
        pipe_name: &str,
        bridge: &mut Child,
        tone_player_exe: &PathBuf,
        diagnostic_child_tone: &DiagnosticBridgeChildTone,
        retained_child_authority: &mut RetainedDiagnosticChildAuthority,
    ) -> Result<(), String> {
        let mut cleanup_failures = Vec::new();
        if let Err(error) = fs::write(abort_signal_path, b"abort") {
            cleanup_failures.push(format!("failed to publish tone abort signal: {error}"));
        }
        if let Err(detail) = retain_diagnostic_child_authority_before_bridge_shutdown(
            retained_child_authority,
            bridge,
            tone_player_exe,
            &diagnostic_child_tone.pid_path,
            &diagnostic_child_tone.result_path,
            Duration::from_secs(5),
        ) {
            cleanup_failures.push(detail);
        }
        if let Err(detail) = shutdown_bridge_with_terminal_receipt(pipe_name) {
            cleanup_failures.push(detail);
        }
        match stop_child_confirmed(bridge) {
            Ok(()) => retained_child_authority.mark_bridge_terminal(),
            Err(detail) => cleanup_failures.push(detail),
        }
        let retained = std::mem::take(retained_child_authority);
        if let Err(detail) = retained.finish() {
            cleanup_failures.push(detail);
        }
        if cleanup_failures.is_empty() {
            Ok(())
        } else {
            Err(cleanup_failures.join(" | "))
        }
    }
