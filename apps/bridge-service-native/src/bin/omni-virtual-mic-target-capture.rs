#[cfg(not(windows))]
fn main() {
    if omni_bridge_service::emit_build_commit_if_requested() {
        return;
    }
    eprintln!("omni-virtual-mic-target-capture is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
#[path = "virtual_mic_target_capture/artifacts.rs"]
mod artifacts;

#[cfg(windows)]
#[path = "virtual_mic_target_capture/ipc.rs"]
mod ipc;

#[cfg(windows)]
#[path = "virtual_mic_target_capture/capture_child.rs"]
mod capture_child;

#[cfg(all(windows, test))]
#[path = "virtual_mic_target_capture/app_tests.rs"]
mod app_tests;

#[cfg(windows)]
fn main() {
    if omni_bridge_service::emit_build_commit_if_requested() {
        return;
    }
    match app::run_from_env() {
        Ok(result) => println!("{}", serde_json::to_string(&result).unwrap()),
        Err(detail) => {
            println!(
                "{}",
                serde_json::to_string(&app::FailureResult {
                    passed: false,
                    detail,
                })
                .unwrap()
            );
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod app {
    use super::capture_child::{
        parse_capture_child_args, run_capture_child_mode, CaptureChildReady, CaptureChildResult,
        TARGET_APPLICATION_NAME,
    };
    use super::artifacts::{
        build_cue_pcm, captured_at_now, find_unique_fingerprint, generate_fingerprint,
        pcm16_bytes, pcm_hex, require_fingerprint_spectrum, sha256_hex, write_evidence,
        CaptureFormatEvidence, CaptureProbeEvidence, CollectorAuthorityEvidence,
        CueLifecycleEvidence, EvidenceWriteResult, FingerprintEvidence,
        RawBridgeCounterEvidence, RecomputedCounterDeltaEvidence, RuntimeSnapshotEvidence,
        TargetCaptureApplication, BITS_PER_SAMPLE, BLOCK_ALIGN_BYTES, CHANNEL_COUNT, COLLECTOR_ID,
        COLLECTOR_VERSION, SAMPLE_RATE_HZ,
    };
    use super::ipc::{
        collect_cue_statuses, control, send_virtual_mic_cue, shutdown_bridge, unix_ms,
    };
    use omni_bridge_service::BRIDGE_PROTOCOL_VERSION;
    use serde::Serialize;
    use serde_json::{json, Value};
    use std::fs::{self, OpenOptions};
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};
    use uuid::Uuid;

    const CAPTURE_DURATION_MS: u64 = 3_200;
    const READY_TIMEOUT: Duration = Duration::from_secs(5);
    const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(8);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct FailureResult {
        pub passed: bool,
        pub detail: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ProbeResult {
        pub passed: bool,
        pub artifact_kind: String,
        pub cue_id: String,
        pub capture_endpoint_id: String,
        pub capture_endpoint_name: String,
        pub virtual_mic_frames_written_for_cue: u64,
        pub physical_playback_frames_written_for_cue: u64,
        #[serde(flatten)]
        pub evidence: EvidenceWriteResult,
    }

    #[derive(Clone, Debug)]
    pub(super) struct ProbeArgs {
        pub(super) output_directory: PathBuf,
        pub(super) bridge_exe: PathBuf,
        runtime_root: PathBuf,
    }

    struct BridgeGuard {
        child: Option<Child>,
        pipe_name: String,
    }

    impl BridgeGuard {
        fn process_id(&self) -> Result<u32, String> {
            self.child
                .as_ref()
                .map(Child::id)
                .ok_or_else(|| "Bridge process is no longer running".to_string())
        }

        fn stop(&mut self) {
            shutdown_bridge(&self.pipe_name);
            let Some(child) = self.child.as_mut() else {
                return;
            };
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(3) {
                if child.try_wait().ok().flatten().is_some() {
                    self.child = None;
                    return;
                }
                thread::sleep(Duration::from_millis(25));
            }
            let _ = child.kill();
            let _ = child.wait();
            self.child = None;
        }
    }

    impl Drop for BridgeGuard {
        fn drop(&mut self) {
            self.stop();
        }
    }

    pub(super) fn run_from_env() -> Result<ProbeResult, String> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if args.iter().any(|arg| arg == "--capture-child") {
            let child_args = parse_capture_child_args(&args)?;
            run_capture_child_mode(&child_args)?;
            std::process::exit(0);
        }
        run_probe(parse_probe_args(&args)?)
    }

    fn run_probe(args: ProbeArgs) -> Result<ProbeResult, String> {
        if !args.bridge_exe.is_file() {
            return Err(format!(
                "installed Bridge executable was not found: {}",
                args.bridge_exe.display()
            ));
        }
        ensure_evidence_targets_absent(&args.output_directory)?;
        fs::create_dir_all(&args.runtime_root).map_err(error_text)?;

        let run_id = Uuid::new_v4().to_string();
        let pipe_name = format!("omni-virtual-mic-target-capture-{}", &run_id[..12]);
        let mut bridge = start_bridge(&args.bridge_exe, &pipe_name, &args.runtime_root)?;
        let initial = wait_for_bridge(&mut bridge, &pipe_name)?;
        require_protocol_v6(&initial)?;

        let session_id = format!("virtual-mic-target-session-{run_id}");
        let cue_id = format!("virtual-mic-target-cue-{run_id}");
        let init = control(
            &pipe_name,
            json!({
                "type": "bridge.init",
                "requestId": format!("virtual-mic-target-init-{}", unix_ms()),
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "sessionId": session_id,
                "installChannel": "development",
                "targetDeviceId": "virtual-mic-default",
                "virtualRenderDeviceId": "virtual-speaker-default",
                "physicalPlaybackDeviceId": "",
                "physicalPlaybackLevel": 0,
                "sourceCaptureMode": "none",
                "virtualMicOutputRequested": true,
                "monitorPlaybackEnabled": false,
                "translationPlaybackEnabled": false,
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
        let endpoint_name = require_ready_virtual_mic(&init)?;
        let before = query_bridge_state(&pipe_name, "before")?;
        require_ready_virtual_mic(&before)?;

        let child_paths = CaptureChildPaths::new(&args.runtime_root, &run_id);
        let mut capture_child = start_capture_child(&endpoint_name, &child_paths)?;
        let ready = wait_for_capture_ready(&mut capture_child, &child_paths.ready_path)?;
        require_capture_ready(&ready, capture_child.id(), &endpoint_name)?;

        let fingerprint = generate_fingerprint(
            format!("virtual-mic-fingerprint-{run_id}"),
            unix_ms() ^ u64::from(std::process::id()),
        );
        let cue_pcm = build_cue_pcm(&fingerprint);
        let ack = send_virtual_mic_cue(&pipe_name, &session_id, &cue_id, &cue_pcm)?;
        let statuses = collect_cue_statuses(&pipe_name, &cue_id, Duration::from_secs(5))?;
        let lifecycle = CueLifecycleEvidence::from_timeline(&cue_id, &session_id, &statuses)?;

        let child_result = wait_for_capture_result(
            &mut capture_child,
            &child_paths.result_path,
            CHILD_EXIT_TIMEOUT,
        )?;
        require_capture_result(&child_result, &ready)?;
        let captured_pcm = fs::read(&child_paths.pcm_path).map_err(error_text)?;
        if child_result.captured_frames != captured_pcm.len() / BLOCK_ALIGN_BYTES {
            return Err(format!(
                "capture child frame count mismatch: result={} bytes={}",
                child_result.captured_frames,
                captured_pcm.len()
            ));
        }
        let expected_fingerprint_pcm = pcm16_bytes(&fingerprint.pcm);
        let fingerprint_start_frame =
            find_unique_fingerprint(&captured_pcm, &expected_fingerprint_pcm)?;
        require_fingerprint_spectrum(
            &captured_pcm,
            fingerprint_start_frame,
            fingerprint.pcm.len(),
            fingerprint.frequency_hz,
        )?;

        let after = query_bridge_state(&pipe_name, "after")?;
        let endpoint_after = require_ready_virtual_mic(&after)?;
        if endpoint_after != endpoint_name {
            return Err(format!(
                "Bridge capture endpoint changed during probe: before={endpoint_name} after={endpoint_after}"
            ));
        }
        let counters = CounterEvidence::from_snapshots(&before, &after)?;
        counters.require_virtual_mic_only(cue_pcm.len() as u64)?;
        if ack.playback_frames_written != counters.physical_before {
            return Err(format!(
                "audio ACK reported unexpected physical playback frames: ack={} before={}",
                ack.playback_frames_written, counters.physical_before
            ));
        }
        let bridge_identity = BridgeIdentity::from_snapshots(
            &before,
            &after,
            bridge.process_id()?,
        )?;
        let authority = CollectorAuthorityEvidence {
            collector_id: COLLECTOR_ID.to_string(),
            collector_version: COLLECTOR_VERSION.to_string(),
            parent_collector_process_id: std::process::id(),
            capture_child_process_id: ready.process_id,
            bridge_protocol_version: BRIDGE_PROTOCOL_VERSION.to_string(),
            bridge_process_id: bridge_identity.process_id,
            bridge_instance_id: bridge_identity.instance_id,
            bridge_session_id: session_id.clone(),
            capture_endpoint_id: ready.endpoint_id.clone(),
            capture_endpoint_name: ready.endpoint_name.clone(),
            raw_counters_before: counters.raw_before(),
            raw_counters_after: counters.raw_after(),
            recomputed_counter_delta: counters.recomputed_delta(),
            cue_id: cue_id.clone(),
            cue_status_timeline: statuses,
            cue_lifecycle: lifecycle,
        };
        let fingerprint_evidence = FingerprintEvidence {
            id: fingerprint.id.clone(),
            detected: true,
            frequency_hz: fingerprint.frequency_hz,
            start_frame: fingerprint_start_frame,
            frame_count: fingerprint.pcm.len(),
            expected_pcm_hex: pcm_hex(&expected_fingerprint_pcm),
            expected_pcm_sha256: sha256_hex(&expected_fingerprint_pcm),
        };

        let captured_at = captured_at_now();
        let mut capture_probe = CaptureProbeEvidence {
            schema_version: 1,
            artifact_kind: "virtual-mic-real-capture-probe".to_string(),
            captured_at: captured_at.clone(),
            authority: authority.clone(),
            target_capture_application: TargetCaptureApplication {
                classification: "real-target".to_string(),
                name: ready.application_name.clone(),
                process_id: ready.process_id,
                capture_api: ready.capture_api.clone(),
                opened_endpoint: true,
                endpoint_id: ready.endpoint_id.clone(),
                endpoint_name: ready.endpoint_name.clone(),
            },
            format: CaptureFormatEvidence {
                sample_rate_hz: SAMPLE_RATE_HZ,
                channel_count: CHANNEL_COUNT,
                bits_per_sample: BITS_PER_SAMPLE,
                encoding: "pcm16".to_string(),
            },
            capture_wav: "virtual-mic-capture.wav".to_string(),
            capture_wav_sha256: String::new(),
            captured_frames: 0,
            fingerprint: fingerprint_evidence.clone(),
        };
        let mut runtime_snapshot = RuntimeSnapshotEvidence {
            schema_version: 1,
            artifact_kind: "virtual-mic-runtime-snapshot".to_string(),
            captured_at,
            authority,
            virtual_mic_output_supported: true,
            virtual_mic_output_status: "ready".to_string(),
            virtual_mic_format: "48000Hz/mono/pcm16".to_string(),
            capture_wav: "virtual-mic-capture.wav".to_string(),
            capture_wav_sha256: String::new(),
            captured_frames: 0,
            fingerprint: fingerprint_evidence,
            virtual_mic_frames_written: counters.virtual_after,
            virtual_mic_frames_written_before: counters.virtual_before,
            virtual_mic_frames_written_after: counters.virtual_after,
            virtual_mic_frames_written_for_cue: counters.virtual_delta,
            physical_playback_frames_written_before: counters.physical_before,
            physical_playback_frames_written_after: counters.physical_after,
            physical_playback_frames_written_for_cue: counters.physical_delta,
        };
        let evidence = write_evidence(
            &args.output_directory,
            &captured_pcm,
            &mut capture_probe,
            &mut runtime_snapshot,
        )?;
        bridge.stop();
        cleanup_child_files(&child_paths);
        Ok(ProbeResult {
            passed: true,
            artifact_kind: "virtual-mic-real-capture-evidence".to_string(),
            cue_id,
            capture_endpoint_id: ready.endpoint_id,
            capture_endpoint_name: endpoint_name,
            virtual_mic_frames_written_for_cue: counters.virtual_delta,
            physical_playback_frames_written_for_cue: counters.physical_delta,
            evidence,
        })
    }

    #[derive(Clone, Debug)]
    struct BridgeIdentity {
        process_id: u64,
        instance_id: String,
    }

    impl BridgeIdentity {
        fn from_snapshots(
            before: &Value,
            after: &Value,
            spawned_process_id: u32,
        ) -> Result<Self, String> {
            let before_process_id = required_counter(before, "bridgeProcessId")?;
            let after_process_id = required_counter(after, "bridgeProcessId")?;
            let before_instance_id = required_string(before, "bridgeInstanceId")?;
            let after_instance_id = required_string(after, "bridgeInstanceId")?;
            if before_process_id == 0
                || before_process_id != after_process_id
                || before_process_id != u64::from(spawned_process_id)
                || before_instance_id != after_instance_id
            {
                return Err(format!(
                    "Bridge process/instance changed during collector run: before={before_process_id}/{before_instance_id} after={after_process_id}/{after_instance_id} spawned={spawned_process_id}"
                ));
            }
            Ok(Self {
                process_id: before_process_id,
                instance_id: before_instance_id,
            })
        }
    }

    #[derive(Clone, Debug)]
    pub(super) struct CounterEvidence {
        virtual_before: u64,
        virtual_after: u64,
        virtual_delta: u64,
        physical_before: u64,
        physical_after: u64,
        physical_delta: u64,
    }

    impl CounterEvidence {
        pub(super) fn from_snapshots(before: &Value, after: &Value) -> Result<Self, String> {
            let virtual_before = required_counter(before, "virtualMicFramesWritten")?;
            let virtual_after = required_counter(after, "virtualMicFramesWritten")?;
            let physical_before = required_counter(before, "playbackFramesWritten")?;
            let physical_after = required_counter(after, "playbackFramesWritten")?;
            Ok(Self {
                virtual_before,
                virtual_after,
                virtual_delta: virtual_after.checked_sub(virtual_before).ok_or_else(|| {
                    "Bridge virtualMicFramesWritten regressed during the cue".to_string()
                })?,
                physical_before,
                physical_after,
                physical_delta: physical_after.checked_sub(physical_before).ok_or_else(|| {
                    "Bridge playbackFramesWritten regressed during the cue".to_string()
                })?,
            })
        }

        pub(super) fn require_virtual_mic_only(&self, expected_frames: u64) -> Result<(), String> {
            if self.virtual_delta == 0 || self.virtual_delta != expected_frames {
                return Err(format!(
                    "Bridge virtualMicFramesWritten delta mismatch: expected={expected_frames} actual={}",
                    self.virtual_delta
                ));
            }
            if self.physical_delta != 0 {
                return Err(format!(
                    "virtual microphone cue leaked into physical playback accounting: delta={}",
                    self.physical_delta
                ));
            }
            Ok(())
        }

        fn raw_before(&self) -> RawBridgeCounterEvidence {
            RawBridgeCounterEvidence {
                virtual_mic_frames_written: self.virtual_before,
                playback_frames_written: self.physical_before,
            }
        }

        fn raw_after(&self) -> RawBridgeCounterEvidence {
            RawBridgeCounterEvidence {
                virtual_mic_frames_written: self.virtual_after,
                playback_frames_written: self.physical_after,
            }
        }

        fn recomputed_delta(&self) -> RecomputedCounterDeltaEvidence {
            RecomputedCounterDeltaEvidence {
                virtual_mic_frames_written: self.virtual_delta,
                playback_frames_written: self.physical_delta,
            }
        }
    }

    struct CaptureChildPaths {
        ready_path: PathBuf,
        result_path: PathBuf,
        pcm_path: PathBuf,
    }

    impl CaptureChildPaths {
        fn new(runtime_root: &Path, run_id: &str) -> Self {
            Self {
                ready_path: runtime_root.join(format!("virtual-mic-target-{run_id}.ready.json")),
                result_path: runtime_root.join(format!("virtual-mic-target-{run_id}.result.json")),
                pcm_path: runtime_root.join(format!("virtual-mic-target-{run_id}.pcm")),
            }
        }
    }

    pub(super) fn parse_probe_args(args: &[String]) -> Result<ProbeArgs, String> {
        let mut output_directory = None;
        let mut bridge_exe = None;
        let mut runtime_root = None;
        let mut index = 0;
        while index < args.len() {
            let key = args[index].as_str();
            index += 1;
            match key {
                "--output-directory" => {
                    output_directory = Some(PathBuf::from(next_arg(args, &mut index, key)?))
                }
                "--bridge-exe" => {
                    bridge_exe = Some(PathBuf::from(next_arg(args, &mut index, key)?))
                }
                "--runtime-root" => {
                    runtime_root = Some(PathBuf::from(next_arg(args, &mut index, key)?))
                }
                _ => return Err(format!("unknown argument: {key}")),
            }
        }
        let output_directory = output_directory
            .ok_or_else(|| "--output-directory is required".to_string())?;
        let bridge_exe = bridge_exe.unwrap_or_else(default_bridge_exe);
        let runtime_root = runtime_root.unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "omni-virtual-mic-target-capture-{}-{}",
                std::process::id(),
                unix_ms()
            ))
        });
        Ok(ProbeArgs {
            output_directory,
            bridge_exe,
            runtime_root,
        })
    }

    fn next_arg<'a>(args: &'a [String], index: &mut usize, key: &str) -> Result<&'a str, String> {
        let value = args
            .get(*index)
            .ok_or_else(|| format!("{key} requires a value"))?;
        *index += 1;
        Ok(value)
    }

    fn default_bridge_exe() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("target/release"))
            .join("omni-bridge-service.exe")
    }

    fn ensure_evidence_targets_absent(output_directory: &Path) -> Result<(), String> {
        for name in [
            "virtual-mic-capture.wav",
            "virtual-mic-capture-probe.json",
            "runtime-snapshot.json",
        ] {
            let path = output_directory.join(name);
            if path.exists() {
                return Err(format!(
                    "refusing to overwrite existing virtual microphone evidence: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    fn start_bridge(exe: &Path, pipe_name: &str, runtime_root: &Path) -> Result<BridgeGuard, String> {
        let child = Command::new(exe)
            .arg("--pipe-name")
            .arg(pipe_name)
            .arg("--runtime-root")
            .arg(runtime_root)
            .arg("--bridge-version")
            .arg("0.1.0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(error_text)?;
        Ok(BridgeGuard {
            child: Some(child),
            pipe_name: pipe_name.to_string(),
        })
    }

    fn wait_for_bridge(bridge: &mut BridgeGuard, pipe_name: &str) -> Result<Value, String> {
        let started = Instant::now();
        loop {
            if let Some(status) = bridge
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
            {
                return Err(format!("Bridge exited before readiness: {status}"));
            }
            match query_bridge_state(pipe_name, "startup") {
                Ok(snapshot) => return Ok(snapshot),
                Err(_) if started.elapsed() < READY_TIMEOUT => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn query_bridge_state(pipe_name: &str, label: &str) -> Result<Value, String> {
        control(
            pipe_name,
            json!({
                "type": "bridge.state.query",
                "requestId": format!("virtual-mic-target-{label}-{}", unix_ms()),
            }),
        )
    }

    fn require_protocol_v6(snapshot: &Value) -> Result<(), String> {
        if snapshot["protocolVersion"].as_str() != Some(BRIDGE_PROTOCOL_VERSION) {
            return Err(format!(
                "Bridge protocol mismatch: expected={} snapshot={snapshot}",
                BRIDGE_PROTOCOL_VERSION
            ));
        }
        Ok(())
    }

    pub(super) fn require_ready_virtual_mic(snapshot: &Value) -> Result<String, String> {
        require_protocol_v6(snapshot)?;
        let endpoint_name = snapshot["captureEndpointName"].as_str().unwrap_or_default();
        if snapshot["virtualMicOutputSupported"].as_bool() != Some(true)
            || snapshot["virtualMicOutputStatus"].as_str() != Some("ready")
            || snapshot["virtualMicFormat"].as_str() != Some("48000Hz/mono/pcm16")
            || endpoint_name.trim().is_empty()
        {
            return Err(format!(
                "Bridge virtual microphone capability is not supported+ready with canonical format: {snapshot}"
            ));
        }
        Ok(endpoint_name.to_string())
    }

    fn start_capture_child(
        endpoint_name: &str,
        paths: &CaptureChildPaths,
    ) -> Result<Child, String> {
        let current_exe = std::env::current_exe().map_err(error_text)?;
        Command::new(current_exe)
            .arg("--capture-child")
            .arg("--endpoint-name")
            .arg(endpoint_name)
            .arg("--ready-path")
            .arg(&paths.ready_path)
            .arg("--result-path")
            .arg(&paths.result_path)
            .arg("--pcm-path")
            .arg(&paths.pcm_path)
            .arg("--capture-duration-ms")
            .arg(CAPTURE_DURATION_MS.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(error_text)
    }

    fn wait_for_capture_ready(child: &mut Child, path: &Path) -> Result<CaptureChildReady, String> {
        let started = Instant::now();
        loop {
            if path.is_file() {
                return read_json(path);
            }
            if let Some(status) = child.try_wait().map_err(error_text)? {
                return Err(format!(
                    "target capture application exited before opening the endpoint: {status}"
                ));
            }
            if started.elapsed() >= READY_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                return Err("target capture application did not open the endpoint within 5 seconds".to_string());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_capture_result(
        child: &mut Child,
        path: &Path,
        timeout: Duration,
    ) -> Result<CaptureChildResult, String> {
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait().map_err(error_text)? {
                let result = read_json::<CaptureChildResult>(path).map_err(|error| {
                    format!("target capture exited {status} without a valid result: {error}")
                })?;
                if !status.success() || !result.passed {
                    return Err(format!(
                        "target capture failed: {}",
                        result.detail.as_deref().unwrap_or("no detail")
                    ));
                }
                return Ok(result);
            }
            if started.elapsed() >= timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "target capture application did not finish within {}ms",
                    timeout.as_millis()
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn require_capture_ready(
        ready: &CaptureChildReady,
        child_pid: u32,
        expected_name: &str,
    ) -> Result<(), String> {
        if ready.schema_version != 1
            || ready.artifact_kind != "virtual-mic-target-capture-ready"
            || ready.process_id != child_pid
            || ready.application_name != TARGET_APPLICATION_NAME
            || ready.capture_api != "WASAPI"
            || ready.endpoint_id.trim().is_empty()
            || ready.endpoint_name != expected_name
            || ready.sample_rate_hz != SAMPLE_RATE_HZ
            || ready.channel_count != CHANNEL_COUNT
            || ready.bits_per_sample != BITS_PER_SAMPLE
        {
            return Err(format!("target capture readiness was invalid: {ready:?}"));
        }
        Ok(())
    }

    fn require_capture_result(
        result: &CaptureChildResult,
        ready: &CaptureChildReady,
    ) -> Result<(), String> {
        if !result.passed
            || result.process_id != ready.process_id
            || result.endpoint_id != ready.endpoint_id
            || result.endpoint_name != ready.endpoint_name
            || result.captured_frames == 0
        {
            return Err(format!("target capture result did not match readiness: {result:?}"));
        }
        Ok(())
    }

    fn required_counter(snapshot: &Value, field: &str) -> Result<u64, String> {
        snapshot[field]
            .as_u64()
            .ok_or_else(|| format!("Bridge state snapshot is missing numeric {field}: {snapshot}"))
    }

    fn required_string(snapshot: &Value, field: &str) -> Result<String, String> {
        snapshot[field]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("Bridge state snapshot is missing string {field}: {snapshot}"))
    }

    fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
        let mut bytes = Vec::new();
        OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(error_text)?
            .read_to_end(&mut bytes)
            .map_err(error_text)?;
        serde_json::from_slice(&bytes).map_err(error_text)
    }

    fn cleanup_child_files(paths: &CaptureChildPaths) {
        for path in [&paths.ready_path, &paths.result_path, &paths.pcm_path] {
            let _ = fs::remove_file(path);
        }
    }

    fn error_text(error: impl std::fmt::Display) -> String {
        error.to_string()
    }

}
