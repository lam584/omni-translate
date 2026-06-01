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
