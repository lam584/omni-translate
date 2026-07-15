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
                let pipe_for_read = pipe;
                let (tx, rx) = mpsc::channel();
                thread::spawn(move || {
                    let mut reader = BufReader::new(pipe_for_read);
                    let mut response = String::new();
                    let result = reader.read_line(&mut response).map(|_| response);
                    let _ = tx.send(result);
                });
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
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(pipe_path)
        .map_err(|error| error.to_string())?;
    let payload = serde_json::to_string(command).map_err(|error| error.to_string())?;
    pipe.write_all(payload.as_bytes())
        .map_err(|error| error.to_string())?;
    pipe.write_all(b"\n").map_err(|error| error.to_string())?;
    pipe.flush().map_err(|error| error.to_string())?;

    let pipe_path_owned = pipe_path.to_string();
    let pipe_for_read = pipe;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(pipe_for_read);
        let mut response = String::new();
        let result = reader.read_line(&mut response).map(|_| response);
        let _ = tx.send(result);
    });
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

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

pub fn query_state(pipe_path: &str) -> Result<BridgeStateResponse, String> {
    match write_command(
        pipe_path,
        &DriverBridgeCommand::StateQuery(BridgeStateQuery {
            request_id: format!("bridge-state-{}", now_unix_ms()),
        }),
    )? {
        DriverBridgeEvent::StateSnapshot(snapshot) => Ok(snapshot),
        DriverBridgeEvent::Error(error) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Bridge Service 返回了意外响应。".to_string()),
    }
}

pub fn query_state_fast(pipe_path: &str) -> Result<BridgeStateResponse, String> {
    match write_command_with_retry(
        pipe_path,
        &DriverBridgeCommand::StateQuery(BridgeStateQuery {
            request_id: format!("bridge-state-fast-{}", now_unix_ms()),
        }),
        1,
        Duration::ZERO,
    )? {
        DriverBridgeEvent::StateSnapshot(snapshot) => Ok(snapshot),
        DriverBridgeEvent::Error(error) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Bridge Service 返回了意外响应。".to_string()),
    }
}

/// Performs a fast bridge health check with a short timeout.
///
/// This opens the bridge pipe, sends a state query, and reads the response
/// with a timeout to detect zombie bridge processes that accept connections
/// but never respond.
pub fn check_bridge_health(pipe_path: &str) -> Result<(), String> {
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(pipe_path)
        .map_err(|error| format!("Bridge pipe not available: {}", error))?;

    let command = DriverBridgeCommand::StateQuery(BridgeStateQuery {
        request_id: format!("bridge-health-{}", now_unix_ms()),
    });
    let payload = serde_json::to_string(&command).map_err(|error| error.to_string())?;
    pipe.write_all(payload.as_bytes())
        .map_err(|error| format!("Bridge pipe write failed: {}", error))?;
    pipe.write_all(b"\n")
        .map_err(|error| format!("Bridge pipe write newline failed: {}", error))?;
    pipe.flush()
        .map_err(|error| format!("Bridge pipe flush failed: {}", error))?;

    let pipe_path_owned = pipe_path.to_string();
    let pipe_for_read = pipe;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(pipe_for_read);
        let mut response = String::new();
        let result = reader.read_line(&mut response).map(|_| response);
        let _ = tx.send(result);
    });

    let response = match rx.recv_timeout(Duration::from_secs(IPC_READ_TIMEOUT_SECS)) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(format!("Bridge pipe read failed: {}", error)),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(format!(
                "Bridge health check timed out ({}s): pipe {} accepted connection but never responded.",
                IPC_READ_TIMEOUT_SECS, pipe_path_owned
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("Bridge health check read thread disconnected.".to_string());
        }
    };

    match serde_json::from_str::<DriverBridgeEvent>(response.trim()) {
        Ok(DriverBridgeEvent::StateSnapshot(_)) => Ok(()),
        Ok(DriverBridgeEvent::Error(error)) => {
            Err(format!("{}: {}", error.code, error.message))
        }
        Ok(_) => Err("Bridge health check returned unexpected event type.".to_string()),
        Err(error) => Err(format!(
            "Bridge health check response parse failed: {}",
            error
        )),
    }
}
