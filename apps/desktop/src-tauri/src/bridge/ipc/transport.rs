/// Spawn a background thread that reads a single newline-terminated line from
/// the pipe and forwards the result over a channel, returning the receiver so
/// callers can apply their own `recv_timeout` handling. Shared by the retrying
/// and quiet writers, which previously repeated this spawn verbatim.
fn control_response_payload_len(response: &str) -> usize {
    match response.strip_suffix('\n') {
        Some(line) => line.strip_suffix('\r').unwrap_or(line).len(),
        None => response.len(),
    }
}

fn spawn_pipe_line_reader(pipe: fs::File) -> mpsc::Receiver<std::io::Result<String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(pipe);
        let mut response = String::new();
        // The protocol limit covers the JSON payload, not its LF/CRLF delimiter.
        let result = reader
            .take((omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES + 2) as u64)
            .read_line(&mut response)
            .and_then(|_| {
                if control_response_payload_len(&response)
                    > omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES
                {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Bridge Service IPC response exceeds protocol limit",
                    ))
                } else {
                    Ok(response)
                }
            });
        let _ = tx.send(result);
    });
    rx
}

fn write_command(
    pipe_path: &str,
    command: &DriverBridgeCommand,
) -> Result<DriverBridgeEvent, String> {
    write_command_with_retry(
        pipe_path,
        command,
        BRIDGE_CONNECT_RETRIES,
        Duration::from_millis(BRIDGE_CONNECT_DELAY_MS),
    )
}

fn write_command_with_retry(
    pipe_path: &str,
    command: &DriverBridgeCommand,
    connect_retries: usize,
    connect_delay: Duration,
) -> Result<DriverBridgeEvent, String> {
    for attempt in 0..connect_retries {
        match OpenOptions::new().read(true).write(true).open(pipe_path) {
            Ok(mut pipe) => {
                let payload = serde_json::to_string(command).map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] failed to serialize command pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;
                if payload.len() > omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES {
                    return Err("Bridge Service IPC command exceeds protocol limit.".to_string());
                }
                pipe.write_all(payload.as_bytes()).map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe write failed pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;
                pipe.write_all(b"\n").map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe write newline failed pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;
                pipe.flush().map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe flush failed pipe={} err={}",
                        pipe_path,
                        error
                    );
                    error.to_string()
                })?;

                let pipe_path_owned = pipe_path.to_string();
                let rx = spawn_pipe_line_reader(pipe);
                let response = match rx.recv_timeout(Duration::from_secs(IPC_READ_TIMEOUT_SECS)) {
                    Ok(Ok(response)) => response,
                    Ok(Err(error)) => {
                        log::error!(
                            "[omni][bridge-ipc] pipe read failed pipe={} err={}",
                            pipe_path_owned,
                            error
                        );
                        return Err(error.to_string());
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        log::error!(
                            "[omni][bridge-ipc] pipe read timed out after {}s pipe={}",
                            IPC_READ_TIMEOUT_SECS,
                            pipe_path_owned
                        );
                        return Err(format!(
                            "Bridge Service IPC read timed out ({}s).",
                            IPC_READ_TIMEOUT_SECS
                        ));
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        log::error!(
                            "[omni][bridge-ipc] pipe read thread disconnected pipe={}",
                            pipe_path_owned
                        );
                        return Err("Bridge Service IPC read thread disconnected.".to_string());
                    }
                };
                return serde_json::from_str(response.trim()).map_err(|error| {
                    log::error!(
                        "[omni][bridge-ipc] pipe response parse failed pipe={} response={} err={}",
                        pipe_path,
                        response.trim(),
                        error
                    );
                    error.to_string()
                });
            }
            Err(_) => {
                if connect_retries > 1 && (attempt == 0 || attempt == connect_retries - 1) {
                    log::warn!(
                        "[omni][bridge-ipc] pipe not ready (attempt {}/{}) pipe={}",
                        attempt + 1,
                        connect_retries,
                        pipe_path
                    );
                }
                thread::sleep(connect_delay)
            }
        }
    }

    if connect_retries > 1 {
        log::error!(
            "[omni][bridge-ipc] pipe never ready after {} retries pipe={}",
            connect_retries,
            pipe_path
        );
    }
    Err("Bridge Service named pipe 未在预期时间内就绪。".to_string())
}

fn write_command_once_quiet(
    pipe_path: &str,
    command: &DriverBridgeCommand,
) -> Result<DriverBridgeEvent, String> {
    write_command_once_quiet_with_open(pipe_path, command, || {
        OpenOptions::new().read(true).write(true).open(pipe_path)
    })
}

fn write_command_once_quiet_with_open(
    pipe_path: &str,
    command: &DriverBridgeCommand,
    mut open: impl FnMut() -> std::io::Result<fs::File>,
) -> Result<DriverBridgeEvent, String> {
    let mut pipe = if matches!(command, DriverBridgeCommand::SourceFlush(_)) {
        open_source_flush_pipe(&mut open)
    } else {
        open()
    }
        .map_err(|error| error.to_string())?;
    let payload = serde_json::to_string(command).map_err(|error| error.to_string())?;
    if payload.len() > omni_bridge_protocol::MAX_CONTROL_MESSAGE_BYTES {
        return Err("Bridge Service IPC command exceeds protocol limit.".to_string());
    }
    pipe.write_all(payload.as_bytes())
        .map_err(|error| error.to_string())?;
    pipe.write_all(b"\n").map_err(|error| error.to_string())?;
    pipe.flush().map_err(|error| error.to_string())?;

    let pipe_path_owned = pipe_path.to_string();
    let rx = spawn_pipe_line_reader(pipe);
    let response = match rx.recv_timeout(Duration::from_secs(IPC_READ_TIMEOUT_SECS)) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(format!(
                "Bridge Service IPC read timed out ({}s) on pipe {}.",
                IPC_READ_TIMEOUT_SECS, pipe_path_owned
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("Bridge Service IPC read thread disconnected.".to_string());
        }
    };
    serde_json::from_str(response.trim()).map_err(|error| error.to_string())
}

fn open_source_flush_pipe(
    mut open: impl FnMut() -> std::io::Result<fs::File>,
) -> std::io::Result<fs::File> {
    // Only an unopened SourceFlush may wait for a busy control instance. Missing
    // pipes and all other errors remain immediate; no write/read is retried.
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match open() {
            Ok(pipe) => return Ok(pipe),
            Err(error) => {
                if !cfg!(windows) || error.raw_os_error() != Some(231) {
                    return Err(error);
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                thread::sleep(remaining.min(Duration::from_millis(10)));
                if Instant::now() >= deadline {
                    return Err(error);
                }
            }
        }
    }
}

pub(crate) fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(all(test, windows))]
mod source_flush_busy_tests {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(name: *const u16, access: u32, mode: u32, instances: u32,
            output: u32, input: u32, timeout: u32, security: *const std::ffi::c_void)
            -> *mut std::ffi::c_void;
        fn DisconnectNamedPipe(pipe: *mut std::ffi::c_void) -> i32;
        fn ConnectNamedPipe(pipe: *mut std::ffi::c_void, overlapped: *mut std::ffi::c_void) -> i32;
    }

    fn busy_pipe() -> (BridgeRuntimeSnapshot, fs::File, fs::File) {
        let mut snapshot = BridgeRuntimeSnapshot::default();
        snapshot.pipe_path = format!(r"\\.\pipe\omni-source-flush-test-{}", Uuid::new_v4());
        let name: Vec<u16> = snapshot.pipe_path.encode_utf16().chain(Some(0)).collect();
        // One byte-mode, nonblocking instance: the held client guarantees 231.
        let raw = unsafe { CreateNamedPipeW(name.as_ptr(), 3, 1, 1, 4096, 4096, 0, std::ptr::null()) };
        assert_ne!(raw as isize, -1, "{}", std::io::Error::last_os_error());
        let server = unsafe { fs::File::from_raw_handle(raw) };
        let occupied = OpenOptions::new().read(true).write(true).open(&snapshot.pipe_path).unwrap();
        let error = OpenOptions::new().read(true).write(true).open(&snapshot.pipe_path).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(231));
        (snapshot, server, occupied)
    }

    fn exchange_with_listening_pipe(response: impl FnOnce(serde_json::Value) -> String + Send + 'static)
        -> Result<(), String>
    {
        let (snapshot, mut server, occupied) = busy_pipe();
        drop(occupied);
        assert_ne!(unsafe { DisconnectNamedPipe(server.as_raw_handle()) }, 0);
        // ACK end-to-end coverage starts listening; busy retry is tested below
        // through the production open seam, not inferred from thread timing.
        unsafe { ConnectNamedPipe(server.as_raw_handle(), std::ptr::null_mut()); }
        let (done_tx, done_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut request = Vec::new();
            while Instant::now() < deadline {
                let mut buffer = [0; 4096];
                if let Ok(count) = server.read(&mut buffer) {
                    request.extend_from_slice(&buffer[..count]);
                    if request.contains(&b'\n') { break; }
                }
                thread::sleep(Duration::from_millis(5));
            }
            if request.is_empty() { return 0; }
            let command: serde_json::Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(command["type"], "bridge.source.flush");
            let response = response(command);
            writeln!(server, "{response}").unwrap();
            let _ = done_rx.recv_timeout(Duration::from_secs(10));
            request.iter().filter(|&&byte| byte == b'\n').count()
        });
        let result = flush_bridge_source(&snapshot);
        let _ = done_tx.send(());
        let received = worker.join().unwrap();
        assert_eq!(received, 1);
        result
    }

    #[test]
    fn source_flush_preserves_terminal_ack() {
        let result = exchange_with_listening_pipe(|command| serde_json::json!({
            "type": "bridge.error", "requestId": command["requestId"],
            "code": "bridge.source-flush-failed", "message": "terminal-test-ack",
            "retriable": true, "bridgeState": "running", "driverHealth": "running"
        }).to_string());
        assert_eq!(result, Err("bridge.source-flush-failed: terminal-test-ack".to_string()));
    }

    fn closed_ack(command: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "type": "bridge.state.snapshot", "requestId": command["requestId"],
            "protocolVersion": omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION,
            "bridgeState": "running", "lifecycleState": "ready", "driverHealth": "running",
            "bridgeVersion": "test", "physicalPlaybackStatus": "ready",
            "playbackOwnerGeneration": 0, "queuedFrames": 0,
            "sourceSubscriberActive": false, "sourcePendingBytes": 0,
            "sourcePacerQueuedFrames": 0, "monitorSourceQueuedFrames": 0
        })
    }

    #[test]
    fn source_flush_accepts_only_closed_matching_ack() {
        assert_eq!(exchange_with_listening_pipe(|command| closed_ack(&command).to_string()), Ok(()));
        for (field, value) in [
            ("requestId", serde_json::json!("wrong-request")),
            ("sourceSubscriberActive", serde_json::json!(true)),
            ("sourcePendingBytes", serde_json::json!(1)),
            ("sourcePacerQueuedFrames", serde_json::json!(1)),
            ("monitorSourceQueuedFrames", serde_json::json!(1)),
        ] {
            let result = exchange_with_listening_pipe(move |command| {
                let mut ack = closed_ack(&command);
                ack[field] = value;
                ack.to_string()
            });
            assert!(result.unwrap_err().contains("acknowledgement did not close the source boundary"));
        }
    }

    #[test]
    fn source_flush_observed_busy_retries_only_before_send() {
        // Both outcomes happen after the server has received the complete RPC.
        // Count every open through the same helper used by the production caller.
        for disconnect in [false, true] {
            let (snapshot, mut server, occupied) = busy_pipe();
            let mut occupied = Some(occupied);
            let (connected_tx, connected_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let mut server_control = Some(server.try_clone().unwrap());
            let worker = thread::spawn(move || {
                if connected_rx.recv_timeout(Duration::from_secs(2)).is_err() { return 0; }
                let deadline = Instant::now() + Duration::from_secs(2);
                let mut request = Vec::new();
                while Instant::now() < deadline {
                    let mut buffer = [0; 4096];
                    if let Ok(count) = server.read(&mut buffer) {
                        request.extend_from_slice(&buffer[..count]);
                        if request.contains(&b'\n') { break; }
                    }
                    thread::yield_now();
                }
                let command: serde_json::Value = serde_json::from_slice(&request).unwrap();
                assert_eq!(command["type"], "bridge.source.flush");
                if disconnect {
                    assert_ne!(unsafe { DisconnectNamedPipe(server.as_raw_handle()) }, 0);
                } else {
                    writeln!(server, "invalid-json").unwrap();
                    let _ = done_rx.recv_timeout(Duration::from_secs(10));
                }
                request.iter().filter(|&&byte| byte == b'\n').count()
            });
            let mut opens = 0;
            let result = write_command_once_quiet_with_open(&snapshot.pipe_path,
                &DriverBridgeCommand::SourceFlush(BridgeSourceFlushRequest {
                    request_id: "observed-busy".into(),
                }), || {
                    opens += 1;
                    assert!(opens <= 2, "must not reopen after sending an RPC");
                    let opened = OpenOptions::new().read(true).write(true).open(&snapshot.pipe_path);
                    if opens == 1 {
                        // This is the actual first production-helper open, not a
                        // preflight. Release only after capturing its real 231.
                        assert_eq!(opened.as_ref().unwrap_err().raw_os_error(), Some(231));
                        drop(occupied.take());
                        let control = server_control.take().unwrap();
                        assert_ne!(unsafe { DisconnectNamedPipe(control.as_raw_handle()) }, 0);
                        unsafe { ConnectNamedPipe(control.as_raw_handle(), std::ptr::null_mut()); }
                    } else {
                        assert!(opened.is_ok());
                        connected_tx.send(()).unwrap();
                    }
                    opened
                });
            let _ = done_tx.send(());
            drop(connected_tx);
            let received = worker.join().unwrap();
            assert_eq!(opens, 2, "one observed busy open, then exactly one successful open");
            assert_eq!(received, 1);
            let error = result.err().expect("invalid response/disconnect must fail");
            if !disconnect { assert!(error.contains("expected value"), "{error}"); }
        }
    }

    #[test]
    fn source_flush_busy_is_bounded_and_other_quiet_commands_remain_immediate() {
        let (snapshot, _server, _occupied) = busy_pipe();
        let started = Instant::now();
        assert!(write_command_once_quiet(&snapshot.pipe_path,
            &DriverBridgeCommand::StateQuery(BridgeStateQuery { request_id: "busy-query".into() })).is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
        let started = Instant::now();
        assert!(flush_bridge_source(&snapshot).is_err());
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn source_flush_missing_pipe_is_immediate() {
        let mut snapshot = BridgeRuntimeSnapshot::default();
        snapshot.pipe_path = format!(r"\\.\pipe\omni-missing-{}", Uuid::new_v4());
        let started = Instant::now();
        assert!(flush_bridge_source(&snapshot).is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}

/// Map a bridge state-query response into the public `BridgeStateResponse`
/// result. Shared by `query_state` and `query_state_fast`, whose response
/// interpretation is identical.
fn interpret_state_response(
    event: DriverBridgeEvent,
) -> Result<BridgeStateResponse, String> {
    match event {
        DriverBridgeEvent::StateSnapshot(snapshot) => Ok(snapshot),
        DriverBridgeEvent::Error(error) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Bridge Service 返回了意外响应。".to_string()),
    }
}

pub(crate) fn query_state(pipe_path: &str) -> Result<BridgeStateResponse, String> {
    interpret_state_response(write_command(
        pipe_path,
        &DriverBridgeCommand::StateQuery(BridgeStateQuery {
            request_id: format!("bridge-state-{}", now_unix_ms()),
        }),
    )?)
}

pub(crate) fn query_state_fast(pipe_path: &str) -> Result<BridgeStateResponse, String> {
    interpret_state_response(write_command_with_retry(
        pipe_path,
        &DriverBridgeCommand::StateQuery(BridgeStateQuery {
            request_id: format!("bridge-state-fast-{}", now_unix_ms()),
        }),
        1,
        Duration::ZERO,
    )?)
}

pub(crate) fn probe_process_loopback(
    pipe_path: &str,
) -> Result<BridgeProcessLoopbackProbeResponse, String> {
    let event = write_command(
        pipe_path,
        &DriverBridgeCommand::ProcessLoopbackProbe(BridgeProcessLoopbackProbeRequest {
            request_id: format!("bridge-process-loopback-probe-{}", now_unix_ms()),
            protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
        }),
    )?;
    match event {
        DriverBridgeEvent::ProcessLoopbackProbeAck(probe) => Ok(probe),
        DriverBridgeEvent::Error(error) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Bridge Service returned an unexpected process-loopback probe response."
            .to_string()),
    }
}
