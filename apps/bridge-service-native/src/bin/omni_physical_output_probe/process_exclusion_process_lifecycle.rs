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
        receipt_id: &str,
        ready_receipt_path: &PathBuf,
        start_signal_path: &PathBuf,
        abort_signal_path: &PathBuf,
    ) -> Result<OwnedToneProcess, String> {
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
            .arg("--receipt-id")
            .arg(receipt_id)
            .arg("--ready-receipt-path")
            .arg(ready_receipt_path)
            .arg("--start-signal-path")
            .arg(start_signal_path)
            .arg("--abort-signal-path")
            .arg(abort_signal_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map(OwnedToneProcess::new)
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

    fn process_executable_path(handle: HANDLE) -> Result<PathBuf, String> {
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
            return Err(format!(
                "QueryFullProcessImageNameW(diagnostic child tone) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        buffer.truncate(length as usize);
        Ok(PathBuf::from(String::from_utf16_lossy(&buffer)))
    }

    fn normalized_windows_path(path: &std::path::Path) -> String {
        let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        resolved
            .to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_lowercase()
    }

    fn validate_diagnostic_child_identity(
        process_id: u32,
        parent_process_id: u32,
        expected_parent_process_id: u32,
        actual_executable: &std::path::Path,
        expected_executable: &std::path::Path,
    ) -> Result<(), String> {
        if parent_process_id != expected_parent_process_id {
            return Err(format!(
                "diagnostic child PID {process_id} parent identity mismatch: actual={parent_process_id} expected={expected_parent_process_id}"
            ));
        }
        if normalized_windows_path(actual_executable)
            != normalized_windows_path(expected_executable)
        {
            return Err(format!(
                "diagnostic child PID {process_id} executable identity mismatch: actual={} expected={}",
                actual_executable.display(),
                expected_executable.display()
            ));
        }
        Ok(())
    }

    fn snapshot_diagnostic_child_process_ids(
        parent_process_id: u32,
        expected_executable: &PathBuf,
    ) -> Result<Vec<u32>, String> {
        let snapshot = WinHandle::new(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) },
            "CreateToolhelp32Snapshot(diagnostic child cleanup)",
        )?;
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32FirstW(snapshot.raw(), &mut entry) } == 0 {
            return Err(format!(
                "Process32FirstW(diagnostic child cleanup) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let expected_file_name = expected_executable
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                format!(
                    "diagnostic child executable omitted a file name: {}",
                    expected_executable.display()
                )
            })?;
        let mut process_ids = Vec::new();
        loop {
            if entry.th32ParentProcessID == parent_process_id && entry.th32ProcessID != 0 {
                let name_length = entry
                    .szExeFile
                    .iter()
                    .position(|value| *value == 0)
                    .unwrap_or(entry.szExeFile.len());
                let file_name = String::from_utf16_lossy(&entry.szExeFile[..name_length]);
                if file_name.eq_ignore_ascii_case(expected_file_name) {
                    process_ids.push(entry.th32ProcessID);
                }
            }
            if unsafe { Process32NextW(snapshot.raw(), &mut entry) } == 0 {
                break;
            }
        }
        Ok(process_ids)
    }

    fn retain_candidates_while_owned_bridge_is_active<P, IsActive, Enumerate, Open>(
        authority: &mut RetainedDiagnosticChildAuthority<P>,
        mut bridge_is_active: IsActive,
        enumerate: Enumerate,
        mut open_verified: Open,
    ) -> Result<usize, String>
    where
        P: RetainedDiagnosticProcess,
        IsActive: FnMut() -> Result<bool, String>,
        Enumerate: FnOnce() -> Result<Vec<u32>, String>,
        Open: FnMut(u32) -> Result<P, String>,
    {
        if !bridge_is_active()? {
            return Err(
                "owned Bridge process became terminal before diagnostic child enumeration"
                    .to_string(),
            );
        }
        let process_ids = enumerate()?;
        let mut retained_count = 0;
        for process_id in process_ids {
            if !bridge_is_active()? {
                return Err(format!(
                    "owned Bridge process became terminal before opening diagnostic child PID {process_id}"
                ));
            }
            let child = open_verified(process_id)?;
            if !bridge_is_active()? {
                return Err(format!(
                    "owned Bridge process became terminal before retaining diagnostic child PID {process_id}"
                ));
            }
            authority.retain_while_bridge_alive(child)?;
            retained_count += 1;
        }
        Ok(retained_count)
    }

    fn retain_exact_candidate_while_owned_bridge_is_active<P, IsActive, Open>(
        authority: &mut RetainedDiagnosticChildAuthority<P>,
        bridge_is_active: IsActive,
        process_id: u32,
        open_verified: Open,
    ) -> Result<(), String>
    where
        P: RetainedDiagnosticProcess,
        IsActive: FnMut() -> Result<bool, String>,
        Open: FnMut(u32) -> Result<P, String>,
    {
        let retained_count = retain_candidates_while_owned_bridge_is_active(
            authority,
            bridge_is_active,
            || Ok(vec![process_id]),
            open_verified,
        )?;
        if retained_count != 1 {
            return Err(format!(
                "exact diagnostic child PID {process_id} did not produce one retained handle"
            ));
        }
        Ok(())
    }

    fn owned_bridge_process_is_active(bridge: &mut Child) -> Result<bool, String> {
        bridge
            .try_wait()
            .map(|status| status.is_none())
            .map_err(error_text)
    }

    fn retain_diagnostic_child_authority_before_bridge_shutdown(
        authority: &mut RetainedDiagnosticChildAuthority,
        bridge: &mut Child,
        expected_executable: &PathBuf,
        pid_path: &PathBuf,
        result_path: &PathBuf,
        timeout: Duration,
    ) -> Result<(), String> {
        let bridge_process_id = bridge.id();
        let deadline = Instant::now() + timeout;
        loop {
            retain_candidates_while_owned_bridge_is_active(
                authority,
                || owned_bridge_process_is_active(bridge),
                || snapshot_diagnostic_child_process_ids(bridge_process_id, expected_executable),
                |process_id| {
                    VerifiedDiagnosticChildProcess::open(
                        process_id,
                        bridge_process_id,
                        expected_executable,
                    )
                },
            )?;
            if !authority.children.is_empty() {
                return Ok(());
            }
            if let Ok(raw) = fs::read_to_string(pid_path) {
                let process_id = raw.trim().parse::<u32>().map_err(|error| {
                    format!(
                        "Bridge-child PID file '{}' is invalid during cleanup: {error}",
                        pid_path.display()
                    )
                })?;
                retain_exact_candidate_while_owned_bridge_is_active(
                    authority,
                    || owned_bridge_process_is_active(bridge),
                    process_id,
                    |candidate_process_id| {
                        VerifiedDiagnosticChildProcess::open(
                            candidate_process_id,
                            bridge_process_id,
                            expected_executable,
                        )
                    },
                )?;
                return Ok(());
            }
            if let Ok(bytes) = fs::read(result_path) {
                if !owned_bridge_process_is_active(bridge)? {
                    return Err(
                        "owned Bridge process became terminal before diagnostic child terminal receipt was accepted"
                            .to_string(),
                    );
                }
                let _: Value = serde_json::from_slice(&bytes).map_err(|error| {
                    format!(
                        "diagnostic child terminal receipt '{}' was invalid during cleanup: {error}",
                        result_path.display()
                    )
                })?;
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "diagnostic child ownership did not converge while Bridge PID {bridge_process_id} was alive within {} ms",
                    timeout.as_millis()
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
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
