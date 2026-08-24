#![cfg(windows)]

use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tempfile::TempDir;

use omni_bridge_protocol::{
    BRIDGE_PROTOCOL_VERSION, MAX_AUDIO_FRAME_HEADER_BYTES, MAX_AUDIO_FRAME_PAYLOAD_BYTES,
    MAX_CONTROL_MESSAGE_BYTES,
};

fn sidecar_path() -> &'static str {
    env!("CARGO_BIN_EXE_omni-bridge-service")
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
            "monitorPlaybackEnabled": false
        }),
    );
    assert_eq!(response["type"], "bridge.init.ack");
    assert_eq!(response["protocolVersion"], BRIDGE_PROTOCOL_VERSION);
}

fn translation_header(session_id: &str, event_type: &str, frame_count: u64, payload_bytes: u64) -> Value {
    json!({
        "type": event_type,
        "requestId": "translation-1",
        "sessionId": session_id,
        "frameId": "frame-1",
        "streamId": "stream-1",
        "sampleRateHz": 24000,
        "channelCount": 1,
        "frameCount": frame_count,
        "timestampMs": 1,
        "payloadBytes": payload_bytes
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
        "channelCount": 1,
        "frameCount": 2,
        "timestampMs": 1,
        "payloadBytes": 4
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


#[test]
fn oversized_control_message_is_dropped_without_killing_the_sidecar() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-control-limit-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);

    {
        let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}"));
        pipe.write_all(&vec![b'x'; MAX_CONTROL_MESSAGE_BYTES + 1])
            .unwrap();
        pipe.write_all(b"\n").unwrap();

        let mut byte = [0u8; 1];
        assert!(
            pipe.read_exact(&mut byte).is_err(),
            "an oversized command must be rejected by closing the connection"
        );
    }

    // Rejecting one client must not stop the control server.
    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn invalid_audio_header_lengths_are_dropped_without_killing_the_sidecar() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-header-limit-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    init_session(&pipe_name, "session-1");

    for header_length in [0, MAX_AUDIO_FRAME_HEADER_BYTES + 1] {
        let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}-audio"));
        pipe.write_all(&(header_length as u32).to_le_bytes()).unwrap();

        let mut byte = [0u8; 1];
        assert!(
            pipe.read_exact(&mut byte).is_err(),
            "invalid header length {header_length} must close the connection"
        );
    }

    let valid = translation_header("session-1", "bridge.translation.frame", 2, 4);
    let ack = exchange_audio_frame(&pipe_name, &valid, &[1, 0, 2, 0])
        .expect("sidecar must keep serving after invalid header lengths");
    assert_eq!(ack["type"], "bridge.translation.ack");

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}

#[test]
fn oversized_audio_payload_declaration_is_dropped_before_allocation() {
    let runtime_root = TempDir::new().unwrap();
    let pipe_name = format!("omni-bridge-payload-limit-{}", std::process::id());
    let mut sidecar = spawn_sidecar(&pipe_name, runtime_root.path());
    wait_until_ready(&mut sidecar);
    init_session(&pipe_name, "session-1");

    let oversized = translation_header(
        "session-1",
        "bridge.translation.frame",
        2,
        (MAX_AUDIO_FRAME_PAYLOAD_BYTES + 1) as u64,
    );
    assert!(
        exchange_audio_frame(&pipe_name, &oversized, &[]).is_none(),
        "an oversized payload declaration must be rejected before reading or allocating the body"
    );

    let valid = translation_header("session-1", "bridge.translation.frame", 2, 4);
    let ack = exchange_audio_frame(&pipe_name, &valid, &[1, 0, 2, 0])
        .expect("sidecar must keep serving after an oversized payload declaration");
    assert_eq!(ack["type"], "bridge.translation.ack");

    shutdown(&pipe_name);
    assert!(sidecar.wait().unwrap().success());
    fs::remove_dir_all(runtime_root.path()).ok();
}
