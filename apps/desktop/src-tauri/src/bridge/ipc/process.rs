pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

pub fn bridge_cli_path() -> PathBuf {
    let release_path = workspace_root()
        .join("apps")
        .join("bridge-service-native")
        .join("target")
        .join("release")
        .join("omni-bridge-service.exe");
    if release_path.exists() {
        return release_path;
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for candidate in &[
                exe_dir
                    .join("resources")
                    .join("bridge-service-native")
                    .join("omni-bridge-service.exe"),
                exe_dir
                    .join("bridge-service-native")
                    .join("omni-bridge-service.exe"),
                exe_dir
                    .parent()
                    .unwrap_or(exe_dir)
                    .join("bridge-service-native")
                    .join("omni-bridge-service.exe"),
            ] {
                if candidate.exists() {
                    return candidate.clone();
                }
            }
        }
    }

    release_path
}

#[allow(dead_code, reason = "legacy install-state path is retained for upgrade compatibility")]
pub fn driver_state_path(runtime_root: &str) -> PathBuf {
    Path::new(runtime_root).join("driver-install-state.json")
}

pub fn bridge_pid_path(runtime_root: &str) -> PathBuf {
    Path::new(runtime_root).join("bridge-service.pid")
}

fn normalized_executable_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

pub fn process_path_matches_expected_bridge(actual: &Path, expected: &Path) -> bool {
    normalized_executable_path(actual) == normalized_executable_path(expected)
}

fn read_bridge_pid(runtime_root: &str) -> Result<Option<u32>, String> {
    let path = bridge_pid_path(runtime_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    parse_bridge_pid(&raw).map(Some)
}

fn parse_bridge_pid(raw: &str) -> Result<u32, String> {
    raw.trim()
        .parse::<u32>()
        .map_err(|error| format!("bridge.stale-pid-invalid: {error}"))
}

#[derive(Debug, PartialEq, Eq)]
enum StaleBridgeProcessAction {
    RemovePidFile,
    Terminate(u32),
}

fn decide_stale_bridge_process_action(
    pid: u32,
    current_pid: u32,
    actual_path: Option<&Path>,
    expected_path: &Path,
) -> Result<StaleBridgeProcessAction, String> {
    if pid == current_pid {
        return Err("bridge.stale-pid-points-to-desktop-process".to_string());
    }
    let Some(actual_path) = actual_path else {
        return Ok(StaleBridgeProcessAction::RemovePidFile);
    };
    if !process_path_matches_expected_bridge(actual_path, expected_path) {
        return Err(format!(
            "bridge.stale-process-path-mismatch: pid={pid} actual={} expected={}",
            actual_path.display(),
            expected_path.display()
        ));
    }
    Ok(StaleBridgeProcessAction::Terminate(pid))
}

#[cfg(windows)]
fn query_process_executable_path(pid: u32) -> Result<Option<PathBuf>, String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(None)
        } else {
            Err(format!("bridge.stale-process-open-failed: {error}"))
        };
    }
    let mut path = vec![0_u16; 32_768];
    let mut len = path.len() as u32;
    let queried = unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut len) };
    unsafe {
        CloseHandle(process);
    }
    if queried == 0 {
        return Err(format!(
            "bridge.stale-process-query-failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    path.truncate(len as usize);
    Ok(Some(PathBuf::from(String::from_utf16_lossy(&path))))
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if process.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(())
        } else {
            Err(format!("bridge.stale-process-open-failed: {error}"))
        };
    }
    let terminated = unsafe { TerminateProcess(process, 0) };
    unsafe {
        CloseHandle(process);
    }
    if terminated == 0 {
        Err(format!(
            "bridge.stale-process-terminate-failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

pub fn terminate_stale_bridge_process(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    let Some(pid) = read_bridge_pid(&snapshot.runtime_root)? else {
        return Ok(());
    };
    let pid_path = bridge_pid_path(&snapshot.runtime_root);
    let actual_path = query_process_executable_path(pid)?;
    let expected_path = bridge_cli_path();
    match decide_stale_bridge_process_action(
        pid,
        std::process::id(),
        actual_path.as_deref(),
        &expected_path,
    )? {
        StaleBridgeProcessAction::RemovePidFile => {
            let _ = fs::remove_file(pid_path);
        }
        StaleBridgeProcessAction::Terminate(pid) => {
            terminate_process(pid)?;
            let _ = fs::remove_file(pid_path);
        }
    }
    Ok(())
}

pub fn stop_bridge_process(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    let _ = write_command_once_quiet(&snapshot.pipe_path, &build_shutdown_command(snapshot));
    Ok(())
}

fn build_shutdown_command(snapshot: &BridgeRuntimeSnapshot) -> DriverBridgeCommand {
    DriverBridgeCommand::Shutdown(BridgeShutdownRequest {
        request_id: format!("bridge-shutdown-{}", now_unix_ms()),
        session_id: snapshot
            .session_id
            .clone()
            .unwrap_or_else(|| "desktop-cleanup".to_string()),
        reason: "manual-stop".to_string(),
    })
}

pub fn ensure_bridge_runtime_root(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    std::fs::create_dir_all(&snapshot.runtime_root).map_err(|error| error.to_string())
}
