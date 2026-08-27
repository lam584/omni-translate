#![cfg(windows)]

use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard, OnceLock},
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tempfile::TempDir;
use cpal::traits::{DeviceTrait, HostTrait};

use omni_bridge_protocol::{
    TranslationPlaybackStatusAck, BRIDGE_PROTOCOL_VERSION,
};

static PROCESS_LOOPBACK_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn process_loopback_test_guard() -> MutexGuard<'static, ()> {
    PROCESS_LOOPBACK_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn sidecar_path() -> &'static str {
    env!("CARGO_BIN_EXE_omni-bridge-service")
}

fn physical_output_probe_path() -> &'static str {
    env!("CARGO_BIN_EXE_omni-physical-output-probe")
}

fn default_physical_output_endpoint_id() -> Option<String> {
    let device = cpal::default_host().default_output_device()?;
    let name = device.description().ok()?.name().to_string();
    if name.contains("Omni Translate Virtual Speaker") {
        return None;
    }
    device.id().ok().map(|id| id.1)
}

fn tone_render_probe_path() -> &'static str {
    env!("CARGO_BIN_EXE_omni-tone-render-probe")
}

fn spawn_sidecar(pipe_name: &str, runtime_root: &Path) -> Child {
    Command::new(sidecar_path())
        .args([
            "--pipe-name",
            pipe_name,
            "--runtime-root",
            runtime_root.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn spawn_sidecar_with_process_fault(
    pipe_name: &str,
    runtime_root: &Path,
    windows_build_number: u32,
    activation_hresult: Option<&str>,
) -> Child {
    let mut command = Command::new(sidecar_path());
    command
        .args([
            "--pipe-name",
            pipe_name,
            "--runtime-root",
            runtime_root.to_str().unwrap(),
        ])
        .env("OMNI_BRIDGE_TEST_ALLOW_FAULT_INJECTION", "1")
        .env(
            "OMNI_BRIDGE_TEST_WINDOWS_BUILD_NUMBER",
            windows_build_number.to_string(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(hresult) = activation_hresult {
        command.env(
            "OMNI_BRIDGE_TEST_PROCESS_LOOPBACK_ACTIVATION_HRESULT",
            hresult,
        );
    }
    command.spawn().unwrap()
}

fn wait_until_ready(child: &mut Child) {
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(
        line.contains("\"type\":\"bridge-service.ready\""),
        "unexpected sidecar ready output: {line}"
    );
}

fn open_pipe(pipe_path: &str) -> File {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match OpenOptions::new().read(true).write(true).open(pipe_path) {
            Ok(pipe) => return pipe,
            Err(error) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
                let _ = error;
            }
            Err(error) => panic!("failed to open {pipe_path}: {error}"),
        }
    }
}

fn send_control(pipe_name: &str, command: Value) -> Value {
    let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}"));
    writeln!(pipe, "{command}").unwrap();
    let mut reader = BufReader::new(pipe);
    let mut response = String::new();
    reader.read_line(&mut response).unwrap();
    serde_json::from_str(&response).unwrap()
}

fn shutdown(pipe_name: &str) {
    let response = send_control(
        pipe_name,
        json!({
            "type": "bridge.shutdown",
            "requestId": "shutdown-1",
            "sessionId": "session-1",
            "reason": "manual-stop"
        }),
    );
    assert_eq!(response["bridgeState"], "stopped");
}

/// Binds the sidecar to a desktop session over the control pipe without any
/// physical playback so the audio-pipe tests run on machines with no devices.
fn init_session(pipe_name: &str, session_id: &str) {
    let response = send_control(
        pipe_name,
        json!({
            "type": "bridge.init",
            "requestId": "init-1",
            "sessionId": session_id,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "expectedDriverVersion": "0.0.0-test",
            "expectedBridgeVersion": "0.0.0-test",
            "monitorPlaybackEnabled": false,
            "translationPlaybackEnabled": false
        }),
    );
    assert_eq!(response["type"], "bridge.init.ack");
    assert_eq!(response["protocolVersion"], BRIDGE_PROTOCOL_VERSION);
}

fn wait_for_process_source_running(pipe_name: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = send_control(
            pipe_name,
            json!({
                "type": "bridge.state.query",
                "requestId": "process-source-running"
            }),
        );
        let lifecycle_ready = state["captureLifecycleState"] == "process-loopback-running"
            || (state["captureLifecycleState"] == "source-frame-delivered"
                && state["captureFramesReceived"].as_u64().unwrap_or(0) > 0);
        if lifecycle_ready && state["sourceSubscriberActive"] == true
        {
            return state;
        }
        if state["processLoopbackStatus"] == "failed" || Instant::now() >= deadline {
            panic!("process source route did not become ready: {state}");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn read_source_envelope(pipe: &mut File) -> Value {
    let mut header_size = [0u8; 4];
    pipe.read_exact(&mut header_size).unwrap();
    let mut header = vec![0u8; u32::from_le_bytes(header_size) as usize];
    pipe.read_exact(&mut header).unwrap();
    let header: Value = serde_json::from_slice(&header).unwrap();
    let mut payload = vec![0u8; header["payloadBytes"].as_u64().unwrap_or(0) as usize];
    pipe.read_exact(&mut payload).unwrap();
    header
}

fn acknowledge_translation_status(pipe: &mut File, status: &Value) {
    let ack = TranslationPlaybackStatusAck {
        event_type: "bridge.translation.status.ack".to_string(),
        status_id: status["statusId"]
            .as_str()
            .expect("translation statusId")
            .to_string(),
        session_id: status["sessionId"]
            .as_str()
            .expect("translation sessionId")
            .to_string(),
    };
    let header = serde_json::to_vec(&ack).unwrap();
    pipe.write_all(&(header.len() as u32).to_le_bytes())
        .unwrap();
    pipe.write_all(&header).unwrap();
    pipe.flush().unwrap();
}

#[test]
fn translation_terminal_replays_after_disconnect_until_desktop_acknowledges_status_id() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-status-replay-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    init_session(&pipe_name, "session-1");

    let header = translation_header("session-1", "bridge.translation.frame", 2, 4);
    let ack = exchange_audio_frame(&pipe_name, &header, &[1, 0, 2, 0]).unwrap();
    assert_eq!(ack["type"], "bridge.translation.ack");

    let source_path = format!(r"\\.\pipe\{pipe_name}-source");
    let mut first_source = open_pipe(&source_path);
    let first_delivery = read_source_envelope(&mut first_source);
    assert_eq!(first_delivery["type"], "bridge.translation.status");
    assert_eq!(first_delivery["playbackStatus"], "stale-dropped");
    assert_eq!(first_delivery["cueId"], "cue-1");
    assert!(!first_delivery["statusId"].as_str().unwrap().is_empty());

    // Simulate the exact failure window: Bridge completed WriteFile, then the
    // Desktop reader disappeared before its ACK reached the server.
    drop(first_source);

    let mut second_source = open_pipe(&source_path);
    let replay = read_source_envelope(&mut second_source);
    assert_eq!(replay, first_delivery, "retry must preserve the stable statusId");
    acknowledge_translation_status(&mut second_source, &replay);

    let next = read_source_envelope(&mut second_source);
    assert_eq!(
        next["type"], "bridge.source.heartbeat",
        "a matching ACK must remove the terminal before normal source delivery resumes"
    );
    drop(second_source);

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
}

fn wait_for_log_text(path: &Path, expected: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let content = fs::read_to_string(path).unwrap_or_default();
        if content.contains(expected) {
            return content;
        }
        if Instant::now() >= deadline {
            panic!("timed out waiting for {expected:?} in {}: {content}", path.display());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn proactive_process_loopback_probe_never_starts_source_capture_or_driver_probe() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-process-probe-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);

    let response = send_control(
        &pipe_name,
        json!({
            "type": "bridge.process-loopback.probe",
            "requestId": "process-loopback-probe-1",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION
        }),
    );
    assert_eq!(response["type"], "bridge.process-loopback.probe.ack");
    assert_eq!(response["protocolVersion"], BRIDGE_PROTOCOL_VERSION);
    assert!(matches!(
        response["processLoopbackStatus"].as_str(),
        Some("ready") | Some("unsupported") | Some("failed")
    ));
    assert!(response["probeProcessId"].as_u64().unwrap_or(0) > 0);
    assert_eq!(response["sourceCaptureMode"], "none");
    assert_eq!(response["captureBackend"], "none");

    let state = send_control(
        &pipe_name,
        json!({
            "type": "bridge.state.query",
            "requestId": "process-loopback-probe-state-1"
        }),
    );
    assert_eq!(state["sourceCaptureMode"], "none");
    assert_eq!(state["captureBackend"], "none");
    assert_eq!(state["sourceSubscriberActive"], false);
    assert_eq!(state["bridgeProcessId"], sidecar.id());
    assert!(state["bridgeInstanceId"].as_str().is_some_and(|value| !value.is_empty()));
    assert!(state["sourceGeneration"].as_u64().unwrap_or_default() > 0);
    assert!(state["sourceGenerationToken"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert_eq!(state["capturePacketCount"], 0);
    assert_eq!(state["driverHealth"], "not-installed");

    shutdown(&pipe_name);
    let _ = sidecar.wait();
}

#[test]
fn injected_activation_hresult_reaches_control_and_source_error_envelopes() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-process-activation-fault-{}", std::process::id());
    let mut sidecar = spawn_sidecar_with_process_fault(
        &pipe_name,
        runtime_root.path(),
        20_348,
        Some("0x88890004"),
    );
    wait_until_ready(&mut sidecar);

    let response = send_control(
        &pipe_name,
        json!({
            "type": "bridge.init",
            "requestId": "injected-activation-failure",
            "sessionId": "injected-activation-session",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "sourceCaptureMode": "process-exclusion",
            "physicalPlaybackDeviceId": "omni-no-physical-endpoint-needed",
            "monitorPlaybackEnabled": false,
            "translationPlaybackEnabled": false
        }),
    );
    assert_eq!(response["type"], "bridge.error", "{response}");
    assert_eq!(response["code"], "bridge.process-loopback-activation-failed");
    assert_eq!(response["sourceCaptureMode"], "process-exclusion");
    assert_eq!(response["captureBackend"], "wasapi-process-exclusion");
    assert_eq!(response["processLoopbackStatus"], "failed");
    assert_eq!(response["windowsBuildNumber"], 20_348);
    assert!(response["processLoopbackFailureDetail"]
        .as_str()
        .unwrap()
        .contains("HRESULT=0x88890004"));

    let mut source_pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-source"));
    let source_error = read_source_envelope(&mut source_pipe);
    assert_eq!(source_error["type"], "bridge.source.error");
    assert_eq!(
        source_error["errorCode"],
        "bridge.process-loopback-activation-failed"
    );
    assert!(source_error["message"]
        .as_str()
        .unwrap()
        .contains("HRESULT=0x88890004"));

    let state = send_control(
        &pipe_name,
        json!({"type": "bridge.state.query", "requestId": "fault-state"}),
    );
    assert_eq!(state["bridgeState"], "degraded");
    assert_eq!(state["lifecycleState"], "error");
    assert_eq!(state["sourceSubscriberActive"], false);
    assert_eq!(state["capturePacketCount"], 0);
    assert_eq!(state["playbackFramesWritten"], 0);

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
}

#[test]
fn injected_unsupported_build_never_attempts_process_activation() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-process-unsupported-{}", std::process::id());
    let mut sidecar = spawn_sidecar_with_process_fault(
        &pipe_name,
        runtime_root.path(),
        20_347,
        Some("0xDEADBEEF"),
    );
    wait_until_ready(&mut sidecar);

    let response = send_control(
        &pipe_name,
        json!({
            "type": "bridge.init",
            "requestId": "unsupported-build",
            "sessionId": "unsupported-build-session",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "sourceCaptureMode": "process-exclusion",
            "monitorPlaybackEnabled": false,
            "translationPlaybackEnabled": false
        }),
    );
    assert_eq!(response["type"], "bridge.error", "{response}");
    assert_eq!(response["code"], "bridge.process-loopback-unsupported");
    assert_eq!(response["processLoopbackStatus"], "unsupported");
    assert_eq!(response["processLoopbackSupported"], false);
    assert_eq!(response["windowsBuildNumber"], 20_347);
    assert!(!response["message"].as_str().unwrap().contains("DEADBEEF"));

    let mut source_pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-source"));
    let source_error = read_source_envelope(&mut source_pipe);
    assert_eq!(source_error["type"], "bridge.source.error");
    assert_eq!(
        source_error["errorCode"],
        "bridge.process-loopback-unsupported"
    );

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
}

#[test]
fn process_exclusion_init_is_driver_independent_and_never_falls_back() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-process-exclusion-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    let physical_endpoint = default_physical_output_endpoint_id()
        .expect("process-exclusion integration requires an explicit physical output endpoint");

    let response = send_control(
        &pipe_name,
        json!({
            "type": "bridge.init",
            "requestId": "process-exclusion-init-1",
            "sessionId": "session-1",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "sourceCaptureMode": "process-exclusion",
            "physicalPlaybackDeviceId": physical_endpoint,
            "monitorPlaybackEnabled": false,
            "translationPlaybackEnabled": false
        }),
    );
    assert_eq!(response["sourceCaptureMode"], "process-exclusion");
    assert_eq!(response["captureBackend"], "wasapi-process-exclusion");
    assert_eq!(response["driverHealth"], "not-installed");
    assert_eq!(response["processLoopbackMinimumWindowsBuild"], 20_348);
    match response["type"].as_str().unwrap() {
        "bridge.init.ack" => {
            assert_eq!(response["bridgeState"], "running");
            assert_eq!(response["processLoopbackStatus"], "ready");
            assert_eq!(response["processLoopbackSupported"], true);
            let source_pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-source"));
            let deadline = Instant::now() + Duration::from_secs(2);
            let state = loop {
                let state = send_control(
                    &pipe_name,
                    json!({
                        "type": "bridge.state.query",
                        "requestId": "process-exclusion-state-1"
                    }),
                );
                let lifecycle_ready = state["captureLifecycleState"] == "process-loopback-running"
                    || (state["captureLifecycleState"] == "source-frame-delivered"
                        && state["captureFramesReceived"].as_u64().unwrap_or(0) > 0);
                if lifecycle_ready
                    || state["processLoopbackStatus"] == "failed"
                    || Instant::now() >= deadline
                {
                    break state;
                }
                thread::sleep(Duration::from_millis(25));
            };
            assert_eq!(state["translationPlaybackEnabled"], true);
            assert_eq!(state["sourceMonitorPlaybackEnabled"], false);
            if state["processLoopbackStatus"] == "failed" {
                assert_eq!(
                    state["lastErrorCode"],
                    "bridge.process-loopback-capture-failed"
                );
                assert_eq!(state["bridgeState"], "degraded");
            } else {
                assert!(
                    state["captureLifecycleState"] == "process-loopback-running"
                        || (state["captureLifecycleState"] == "source-frame-delivered"
                            && state["captureFramesReceived"].as_u64().unwrap_or(0) > 0),
                    "process-loopback source worker did not activate: {state}"
                );
            }
            drop(source_pipe);
        }
        "bridge.error" => {
            assert!(matches!(
                response["code"].as_str(),
                Some("bridge.process-loopback-unsupported")
                    | Some("bridge.process-loopback-activation-failed")
            ));
            assert_ne!(response["captureBackend"], "driver-virtual-speaker");
        }
        response_type => panic!("unexpected process-exclusion init response: {response_type}"),
    }

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn process_exclusion_intentional_mute_acknowledges_with_a_terminal_cue_reason() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-process-muted-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    let physical_endpoint = default_physical_output_endpoint_id()
        .expect("process-exclusion integration requires an explicit physical output endpoint");

    let response = send_control(
        &pipe_name,
        json!({
            "type": "bridge.init",
            "requestId": "process-muted-init",
            "sessionId": "session-1",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "sourceCaptureMode": "process-exclusion",
            "physicalPlaybackDeviceId": physical_endpoint,
            "monitorPlaybackEnabled": false,
            "translationPlaybackEnabled": false,
            "mixControl": {
                "keepOriginalAudio": true,
                "translatedAudioEnabled": false,
                "translatedAudioGainDb": 0.0,
                "translatedAudioAutoGainEnabled": true,
                "originalAudioGainDb": 0.0,
                "duckingEnabled": false,
                "duckingDepthPercent": 0,
                "monitorMode": "original-only"
            }
        }),
    );
    if response["type"] == "bridge.error" {
        assert!(matches!(
            response["code"].as_str(),
            Some("bridge.process-loopback-unsupported")
                | Some("bridge.process-loopback-activation-failed")
        ));
        shutdown(&pipe_name);
        assert!(sidecar.wait().unwrap().success());
        return;
    }
    assert_eq!(response["type"], "bridge.init.ack");
    assert_eq!(response["processLoopbackStatus"], "ready");

    let mut stale_header = translation_header("session-1", "bridge.translation.frame", 2, 4);
    stale_header["bridgeInstanceId"] = response["bridgeInstanceId"].clone();
    stale_header["playbackOwnerGeneration"] = json!(
        response["playbackOwnerGeneration"].as_u64().unwrap().saturating_sub(1)
    );
    let stale_ack = exchange_audio_frame(&pipe_name, &stale_header, &[1, 0, 2, 0]).unwrap();
    assert_eq!(stale_ack["type"], "bridge.translation.nack");
    assert_eq!(stale_ack["errorCode"], "bridge.translation-generation-ended");

    let mut header = translation_header("session-1", "bridge.translation.frame", 2, 4);
    header["bridgeInstanceId"] = response["bridgeInstanceId"].clone();
    header["playbackOwnerGeneration"] = response["playbackOwnerGeneration"].clone();
    let ack = exchange_audio_frame(&pipe_name, &header, &[1, 0, 2, 0]).unwrap();
    assert_eq!(ack["type"], "bridge.translation.ack");
    let log = wait_for_log_text(
        &runtime_root.path().join("bridge-service.log"),
        "event=translation_playback_status status=stale-dropped cueId=cue-1 reason=translated-audio-muted",
    );
    assert!(!log.contains("status=completed cueId=cue-1"));

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
}

#[test]
fn process_exclusion_fingerprint_excludes_bridge_and_preserves_external_process_audio() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_root = TempDir::new().unwrap();
    let output = Command::new(physical_output_probe_path())
        .args([
            "--bridge-exe",
            sidecar_path(),
            "--tone-player-exe",
            tone_render_probe_path(),
            "--runtime-root",
            runtime_root.path().to_str().unwrap(),
            "--physical-playback-device-id",
            "default",
            "--physical-playback-level",
            "50",
            "--process-exclusion-fingerprint",
        ])
        .output()
        .expect("process exclusion fingerprint probe must launch");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let result: Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|error| {
        panic!(
            "process exclusion fingerprint probe returned invalid JSON: {error}; status={}; stdout={stdout}; stderr={stderr}",
            output.status,
        )
    });

    if result["skipped"] == true {
        assert!(output.status.success(), "a supported skip must exit zero: {result}");
        assert_eq!(result["probeKind"], "process-exclusion-fingerprint");
        assert!(matches!(
            result["skipCode"].as_str(),
            Some("probe.no-physical-render-endpoint")
                | Some("bridge.process-loopback-unsupported")
        ));
        eprintln!("process exclusion fingerprint skipped with explicit evidence: {result}");
        return;
    }

    assert!(
        output.status.success(),
        "process exclusion fingerprint failed: status={} result={result} stderr={stderr}",
        output.status,
    );
    assert_eq!(result["passed"], true, "fingerprint result: {result}");
    assert_eq!(result["status"], "passed");
    assert_eq!(result["probeKind"], "process-exclusion-fingerprint");
    let evidence = &result["processExclusionFingerprint"];
    assert_eq!(evidence["sourceCaptureMode"], "process-exclusion");
    assert_eq!(evidence["captureBackend"], "wasapi-process-exclusion");
    assert_eq!(evidence["processLoopbackStatus"], "ready");
    assert_eq!(evidence["bridgeProcessId"], evidence["excludedProcessId"]);
    assert_ne!(
        evidence["externalPlayerProcessId"], evidence["bridgeProcessId"],
        "the preservation tone must originate outside the excluded Bridge process"
    );
    assert_ne!(
        evidence["bridgeChildPlayerProcessId"], evidence["bridgeProcessId"],
        "the Bridge-child tone must run in a distinct process"
    );
    assert_eq!(
        evidence["bridgeChildParentProcessId"], evidence["bridgeProcessId"],
        "the excluded child fingerprint must be emitted by a real Bridge process descendant"
    );
    assert_eq!(
        evidence["bridgeChildExitCode"], 0,
        "the Bridge-child tone process must complete successfully"
    );
    assert!(
        evidence["physicalTranslationNoiseMargin"].as_f64().unwrap() >= 0.001,
        "Bridge fingerprint must clear the local physical noise floor: {evidence}"
    );
    assert!(
        evidence["physicalTranslationSnrRatio"].as_f64().unwrap() >= 2.0,
        "Bridge fingerprint must have a measurable physical SNR: {evidence}"
    );
    assert!(
        evidence["physicalTranslationToExternalRatio"].as_f64().unwrap()
            >= evidence["minimumPhysicalTranslationToExternalRatio"]
                .as_f64()
                .unwrap(),
        "Bridge fingerprint must be detectable relative to the external reference and configured 50% playback level: {evidence}"
    );
    assert!(
        evidence["physicalExternalComponent"].as_f64().unwrap() >= 0.01,
        "external fingerprint must be proven on the physical endpoint: {evidence}"
    );
    assert!(
        evidence["physicalBridgeChildComponent"].as_f64().unwrap() >= 0.01,
        "Bridge-child fingerprint must be proven on the physical endpoint: {evidence}"
    );
    assert!(
        evidence["sourceExternalComponent"].as_f64().unwrap() >= 0.01,
        "external fingerprint must survive the Bridge source pipe: {evidence}"
    );
    assert!(
        evidence["sourceTranslationComponent"].as_f64().unwrap()
            <= evidence["translationComponentLimit"].as_f64().unwrap(),
        "Bridge fingerprint leaked into the source pipe: {evidence}"
    );
    assert!(
        evidence["sourceBridgeChildComponent"].as_f64().unwrap()
            <= evidence["translationComponentLimit"].as_f64().unwrap(),
        "Bridge-child fingerprint leaked into the source pipe: {evidence}"
    );
    assert!(
        evidence["sourceToPhysicalTranslationRatio"].as_f64().unwrap()
            <= evidence["sourceToPhysicalRatioLimit"].as_f64().unwrap(),
        "excluded/physical ratio exceeded its strict threshold: {evidence}"
    );
    assert!(
        evidence["sourceTranslationToExternalRatio"].as_f64().unwrap()
            <= evidence["sourceToExternalRatioLimit"].as_f64().unwrap(),
        "excluded/external ratio exceeded its strict threshold: {evidence}"
    );
    assert!(
        evidence["sourceToPhysicalBridgeChildRatio"].as_f64().unwrap()
            <= evidence["sourceToPhysicalRatioLimit"].as_f64().unwrap(),
        "excluded/physical Bridge-child ratio exceeded its strict threshold: {evidence}"
    );
    assert!(
        runtime_root.path().join("process-exclusion-physical-output.wav").is_file(),
        "physical-loopback evidence WAV must be retained"
    );
    assert!(
        runtime_root.path().join("process-exclusion-source-pipe.wav").is_file(),
        "source-pipe evidence WAV must be retained"
    );
}

#[test]
fn concurrent_process_exclusion_fingerprint_probes_are_serialized_without_cross_contamination() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_a = TempDir::new().unwrap();
    let runtime_b = TempDir::new().unwrap();
    let spawn_probe = |runtime_root: &Path| {
        Command::new(physical_output_probe_path())
            .args([
                "--bridge-exe",
                sidecar_path(),
                "--tone-player-exe",
                tone_render_probe_path(),
                "--runtime-root",
                runtime_root.to_str().unwrap(),
                "--physical-playback-device-id",
                "default",
                "--physical-playback-level",
                "50",
                "--process-exclusion-fingerprint",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("concurrent process exclusion fingerprint probe must launch")
    };

    let first = spawn_probe(runtime_a.path());
    let second = spawn_probe(runtime_b.path());
    let first_output = first.wait_with_output().unwrap();
    let second_output = second.wait_with_output().unwrap();

    for (label, output) in [("first", first_output), ("second", second_output)] {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let result: Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|error| {
            panic!(
                "{label} concurrent fingerprint returned invalid JSON: {error}; status={}; stdout={stdout}; stderr={stderr}",
                output.status,
            )
        });
        if result["skipped"] == true {
            assert!(output.status.success(), "{label} skip must exit zero: {result}");
            continue;
        }
        if result["passed"] == false
            && result["detail"]
                .as_str()
                .is_some_and(|detail| detail.starts_with("external fingerprint did not survive process loopback:"))
        {
            eprintln!(
                "{label} concurrent fingerprint was inconclusive because the external baseline was below the authority threshold: {result}"
            );
            continue;
        }
        assert!(
            output.status.success(),
            "{label} concurrent fingerprint failed: {result}; stderr={stderr}"
        );
        let evidence = &result["processExclusionFingerprint"];
        assert!(
            evidence["sourceTranslationComponent"].as_f64().unwrap()
                <= evidence["translationComponentLimit"].as_f64().unwrap(),
            "{label} probe saw another Bridge translation fingerprint: {evidence}"
        );
        assert!(
            evidence["sourceBridgeChildComponent"].as_f64().unwrap()
                <= evidence["translationComponentLimit"].as_f64().unwrap(),
            "{label} probe saw another Bridge-child fingerprint: {evidence}"
        );
    }
}

#[test]
fn process_exclusion_restart_retargets_the_new_bridge_without_old_source_frames() {
    let _process_loopback_guard = process_loopback_test_guard();
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-process-restart-{}", std::process::id());
    let physical_endpoint = default_physical_output_endpoint_id()
        .expect("process-exclusion restart requires an explicit physical output endpoint");

    let mut first = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut first);
    let first_init = send_control(
        &pipe_name,
        json!({
            "type": "bridge.init",
            "requestId": "process-restart-init-a",
            "sessionId": "process-restart-session-a",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "sourceCaptureMode": "process-exclusion",
            "physicalPlaybackDeviceId": physical_endpoint,
            "monitorPlaybackEnabled": false,
            "translationPlaybackEnabled": false
        }),
    );
    if first_init["type"] == "bridge.error"
        && first_init["code"] == "bridge.process-loopback-unsupported"
    {
        eprintln!("process exclusion restart skipped with explicit evidence: {first_init}");
        shutdown(&pipe_name);
        assert!(first.wait().unwrap().success());
        return;
    }
    assert_eq!(first_init["type"], "bridge.init.ack", "{first_init}");
    assert_eq!(first_init["physicalPlaybackStatus"], "ready");
    assert_eq!(first_init["resolvedPhysicalPlaybackDeviceId"], physical_endpoint);
    let first_playback_owner_generation = first_init["playbackOwnerGeneration"]
        .as_u64()
        .expect("first init must publish playback owner generation");
    let first_pid = first.id();
    let mut first_source = open_pipe(&format!(r"\\.\pipe\{pipe_name}-source"));
    let first_state = wait_for_process_source_running(&pipe_name);
    assert_eq!(first_state["excludedProcessId"], first_pid);
    let first_envelope = read_source_envelope(&mut first_source);
    assert_eq!(first_envelope["sessionId"], "process-restart-session-a");
    assert_eq!(first_envelope["bridgeProcessId"], first_pid);
    assert_eq!(
        first_envelope["bridgeInstanceId"],
        first_state["bridgeInstanceId"]
    );
    assert_eq!(
        first_envelope["sourceGeneration"],
        first_state["sourceGeneration"]
    );
    assert_eq!(
        first_envelope["sourceGenerationToken"],
        first_state["sourceGenerationToken"]
    );
    assert_eq!(first_envelope["sampleFormat"], "pcm-s16le");
    assert_eq!(first_envelope["frameId"], "driver-source-1");
    drop(first_source);
    shutdown(&pipe_name);
    assert!(first.wait().unwrap().success());

    let mut second = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut second);
    let second_pid = second.id();
    assert_ne!(second_pid, first_pid);
    let second_init = send_control(
        &pipe_name,
        json!({
            "type": "bridge.init",
            "requestId": "process-restart-init-b",
            "sessionId": "process-restart-session-b",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "sourceCaptureMode": "process-exclusion",
            "physicalPlaybackDeviceId": physical_endpoint,
            "monitorPlaybackEnabled": false,
            "translationPlaybackEnabled": false
        }),
    );
    assert_eq!(second_init["type"], "bridge.init.ack", "{second_init}");
    assert_eq!(second_init["physicalPlaybackStatus"], "ready");
    assert_eq!(second_init["resolvedPhysicalPlaybackDeviceId"], physical_endpoint);
    assert!(
        second_init["playbackOwnerGeneration"].as_u64().unwrap()
            > first_playback_owner_generation,
        "restart must publish a newer playback owner generation"
    );
    let mut second_source = open_pipe(&format!(r"\\.\pipe\{pipe_name}-source"));
    let second_state = wait_for_process_source_running(&pipe_name);
    assert_eq!(second_state["excludedProcessId"], second_pid);
    assert_ne!(second_state["excludedProcessId"], first_pid);
    let second_envelope = read_source_envelope(&mut second_source);
    assert_eq!(second_envelope["sessionId"], "process-restart-session-b");
    assert_eq!(second_envelope["bridgeProcessId"], second_pid);
    assert_eq!(
        second_envelope["bridgeInstanceId"],
        second_state["bridgeInstanceId"]
    );
    assert_eq!(
        second_envelope["sourceGeneration"],
        second_state["sourceGeneration"]
    );
    assert_eq!(
        second_envelope["sourceGenerationToken"],
        second_state["sourceGenerationToken"]
    );
    assert_ne!(second_envelope["sessionId"], first_envelope["sessionId"]);
    assert_ne!(
        second_envelope["bridgeInstanceId"],
        first_envelope["bridgeInstanceId"]
    );
    assert_ne!(
        second_envelope["sourceGeneration"],
        first_envelope["sourceGeneration"]
    );
    assert_ne!(
        second_envelope["sourceGenerationToken"],
        first_envelope["sourceGenerationToken"]
    );
    assert_eq!(second_envelope["sampleFormat"], "pcm-s16le");
    assert_eq!(
        second_envelope["frameId"], "driver-source-1",
        "a restarted source subscriber must begin from a fresh generation"
    );
    drop(second_source);
    shutdown(&pipe_name);
    assert!(second.wait().unwrap().success());
}

fn translation_header(session_id: &str, event_type: &str, frame_count: u64, payload_bytes: u64) -> Value {
    json!({
        "type": event_type,
        "requestId": "translation-1",
        "sessionId": session_id,
        "frameId": "frame-1",
        "streamId": "stream-1",
        "sampleRateHz": 24000,
        "sampleFormat": "pcm-s16le",
        "channelCount": 1,
        "frameCount": frame_count,
        "timestampMs": 1,
        "payloadBytes": payload_bytes,
        "cueId": "cue-1",
        "translationSink": "physical-playback",
        "routeDirection": "inbound"
    })
}

fn write_framed_header(pipe: &mut File, header_bytes: &[u8]) {
    pipe.write_all(&(header_bytes.len() as u32).to_le_bytes()).unwrap();
    pipe.write_all(header_bytes).unwrap();
}

/// Sends one framed audio frame and reads the framed response; returns `None`
/// when the sidecar dropped the connection without answering.
fn exchange_audio_frame(pipe_name: &str, header: &Value, payload: &[u8]) -> Option<Value> {
    let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-audio"));
    write_framed_header(&mut pipe, &serde_json::to_vec(header).unwrap());
    pipe.write_all(payload).unwrap();

    let mut length = [0u8; 4];
    if pipe.read_exact(&mut length).is_err() {
        return None;
    }
    let mut body = vec![0u8; u32::from_le_bytes(length) as usize];
    pipe.read_exact(&mut body).ok()?;
    Some(serde_json::from_slice(&body).unwrap())
}

#[test]
fn duplicate_sidecar_is_rejected_until_the_running_instance_shuts_down() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-singleton-{}", std::process::id());
    let mut first = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut first);
    assert_eq!(
        fs::read_to_string(runtime_root.path().join("bridge-service.pid"))
            .unwrap()
            .trim(),
        first.id().to_string()
    );

    let duplicate = spawn_sidecar(&pipe_name, runtime_root.path())
        .wait_with_output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("bridge.singleton-already-running"));

    shutdown(&pipe_name);
    assert!(first.wait().unwrap().success());
    assert!(!runtime_root.path().join("bridge-service.pid").exists());

    let mut third = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut third);
    shutdown(&pipe_name);
    assert!(third.wait().unwrap().success());
}

#[test]
fn audio_pipe_returns_a_framed_session_mismatch_nack() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-nack-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);

    let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-audio"));
    let header = json!({
        "type": "bridge.translation.frame",
        "requestId": "translation-1",
        "sessionId": "wrong-session",
        "frameId": "frame-1",
        "streamId": "stream-1",
        "sampleRateHz": 24000,
        "sampleFormat": "pcm-s16le",
        "channelCount": 1,
        "frameCount": 2,
        "timestampMs": 1,
        "payloadBytes": 4,
        "translationSink": "physical-playback",
        "routeDirection": "inbound"
    });
    let encoded = serde_json::to_vec(&header).unwrap();
    pipe.write_all(&(encoded.len() as u32).to_le_bytes())
        .unwrap();
    pipe.write_all(&encoded).unwrap();
    pipe.write_all(&[1, 0, 2, 0]).unwrap();

    let mut length = [0u8; 4];
    pipe.read_exact(&mut length).unwrap();
    let mut body = vec![0u8; u32::from_le_bytes(length) as usize];
    pipe.read_exact(&mut body).unwrap();
    let nack: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(nack["type"], "bridge.translation.nack");
    assert_eq!(nack["errorCode"], "bridge.session-mismatch");
    drop(pipe);

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn audio_pipe_acknowledges_a_valid_translation_frame() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-ack-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    init_session(&pipe_name, "session-1");

    let header = translation_header("session-1", "bridge.translation.frame", 2, 4);
    let ack = exchange_audio_frame(&pipe_name, &header, &[1, 0, 2, 0])
        .expect("a valid translation frame must be acknowledged");
    assert_eq!(ack["type"], "bridge.translation.ack");
    assert_eq!(ack["requestId"], "translation-1");
    assert_eq!(ack["frameId"], "frame-1");
    assert_eq!(ack["acceptedFrames"], 2);
    assert!(ack.get("errorCode").is_none_or(Value::is_null));

    let log = wait_for_log_text(
        &runtime_root.path().join("bridge-service.log"),
        "event=translation_playback_status status=stale-dropped cueId=cue-1 reason=translation-playback-disabled",
    );
    assert!(!log.contains("status=completed cueId=cue-1"));

    // The accepted payload is persisted for diagnostics, byte for byte.
    assert_eq!(
        fs::read(runtime_root.path().join("last-translation-frame.pcm")).unwrap(),
        vec![1, 0, 2, 0]
    );

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn audio_pipe_rejects_virtual_mic_output_without_entering_physical_playback() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-virtual-mic-nack-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    init_session(&pipe_name, "session-1");

    let mut header = translation_header("session-1", "bridge.translation.frame", 2, 4);
    header["translationSink"] = json!("virtual-mic");
    header["routeDirection"] = json!("outbound");
    header["chunkIndex"] = json!(0);
    header["chunkCount"] = json!(1);
    let nack = exchange_audio_frame(&pipe_name, &header, &[1, 0, 2, 0])
        .expect("an unavailable virtual-mic sink must be nacked, not played physically");
    assert_eq!(nack["type"], "bridge.translation.nack");
    assert_eq!(
        nack["errorCode"],
        "bridge.virtual-mic-output-unavailable"
    );
    assert_eq!(nack["acceptedFrames"], 0);

    let state = send_control(
        &pipe_name,
        json!({
            "type": "bridge.state.query",
            "requestId": "virtual-mic-state-1"
        }),
    );
    assert_eq!(state["playbackFramesWritten"], 0);
    assert_eq!(
        state["lastErrorCode"],
        "bridge.virtual-mic-output-unavailable"
    );

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn audio_pipe_rejects_wrong_direction_and_bad_payload_metadata_with_typed_nacks() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-typed-nack-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    init_session(&pipe_name, "session-1");

    // Source frames belong on the source pipe, never on the audio pipe.
    let wrong_direction = translation_header("session-1", "bridge.source.frame", 2, 4);
    let nack = exchange_audio_frame(&pipe_name, &wrong_direction, &[1, 0, 2, 0])
        .expect("a wrong-direction frame must be nacked, not dropped");
    assert_eq!(nack["type"], "bridge.translation.nack");
    assert_eq!(nack["errorCode"], "bridge.invalid-audio-direction");
    assert_eq!(nack["acceptedFrames"], 0);

    // frameCount=3 mono claims 6 bytes of pcm16le but the header pins 4.
    let bad_metadata = translation_header("session-1", "bridge.translation.frame", 3, 4);
    let nack = exchange_audio_frame(&pipe_name, &bad_metadata, &[1, 0, 2, 0])
        .expect("mismatched payload metadata must be nacked, not dropped");
    assert_eq!(nack["errorCode"], "bridge.invalid-pcm-payload");

    // A rejected frame must not corrupt the session: a valid frame right
    // after the nacks is still accepted.
    let valid = translation_header("session-1", "bridge.translation.frame", 2, 4);
    let ack = exchange_audio_frame(&pipe_name, &valid, &[1, 0, 2, 0]).unwrap();
    assert_eq!(ack["type"], "bridge.translation.ack");

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn malformed_and_truncated_audio_frames_do_not_kill_the_sidecar() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-malformed-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    init_session(&pipe_name, "session-1");

    // v4 never infers a PCM representation from the other dimensions. A
    // frame without the explicit sample format is malformed at the envelope.
    let mut missing_sample_format =
        translation_header("session-1", "bridge.translation.frame", 2, 4);
    missing_sample_format
        .as_object_mut()
        .unwrap()
        .remove("sampleFormat");
    assert!(
        exchange_audio_frame(&pipe_name, &missing_sample_format, &[1, 0, 2, 0]).is_none(),
        "a header without sampleFormat must be rejected before PCM decoding"
    );

    // Garbage bytes where the JSON header should be: the sidecar drops the
    // connection without a response instead of crashing.
    {
        let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-audio"));
        write_framed_header(&mut pipe, b"this is not json");
        pipe.write_all(&[1, 0, 2, 0]).unwrap();
        let mut length = [0u8; 4];
        assert!(
            pipe.read_exact(&mut length).is_err(),
            "malformed header must close the connection without a framed response"
        );
    }

    // A header that promises more payload bytes than the client ever sends:
    // dropping the connection mid-frame must not wedge the audio pipe server.
    {
        let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-audio"));
        let truncated = translation_header("session-1", "bridge.translation.frame", 1_000_000, 4_000_000);
        write_framed_header(&mut pipe, &serde_json::to_vec(&truncated).unwrap());
        pipe.write_all(&[1, 0]).unwrap();
    }

    // The sidecar survived both: the next valid frame is still acknowledged.
    let valid = translation_header("session-1", "bridge.translation.frame", 2, 4);
    let ack = exchange_audio_frame(&pipe_name, &valid, &[1, 0, 2, 0])
        .expect("sidecar must keep serving after malformed and truncated frames");
    assert_eq!(ack["type"], "bridge.translation.ack");

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn control_pipe_answers_invalid_json_with_a_typed_bridge_error() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-badjson-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);

    let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}"));
    writeln!(pipe, "{{not json").unwrap();
    let mut reader = BufReader::new(pipe);
    let mut response = String::new();
    reader.read_line(&mut response).unwrap();
    let error: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(error["type"], "bridge.error");
    assert_eq!(error["retriable"], false);
    assert!(error["message"].as_str().unwrap().contains("invalid JSON command"));
    drop(reader);

    // The control server keeps serving well-formed commands afterwards.
    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}
