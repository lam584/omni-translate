// Diagnostic-only Bridge child-process tone launcher used by the physical
// process-exclusion fingerprint probe.

struct DiagnosticChildTone {
    executable: PathBuf,
    trigger_path: PathBuf,
    pid_path: PathBuf,
    ready_receipt_path: PathBuf,
    result_path: PathBuf,
    start_signal_path: PathBuf,
    abort_signal_path: PathBuf,
    receipt_id: String,
    endpoint_id: String,
    frequency_hz: f32,
    amplitude: f32,
    seconds: f32,
}

/// Publishes readiness/result evidence without exposing a created-but-empty
/// target file to the probe process. The files are always on the same volume,
/// so the final rename is the single visibility boundary for readers.
fn publish_diagnostic_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut temporary_name = path.as_os_str().to_os_string();
    temporary_name.push(".tmp");
    let temporary_path = PathBuf::from(temporary_name);
    fs::write(&temporary_path, contents).map_err_str()?;
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error.to_string());
    }
    Ok(())
}

impl DiagnosticChildTone {
    fn from_args(args: &[String]) -> Option<Self> {
        Some(Self {
            executable: PathBuf::from(read_arg(args, "--diagnostic-child-tone-exe")?),
            trigger_path: PathBuf::from(read_arg(
                args,
                "--diagnostic-child-tone-trigger-path",
            )?),
            pid_path: PathBuf::from(read_arg(args, "--diagnostic-child-tone-pid-path")?),
            ready_receipt_path: PathBuf::from(read_arg(
                args,
                "--diagnostic-child-tone-ready-receipt-path",
            )?),
            result_path: PathBuf::from(read_arg(
                args,
                "--diagnostic-child-tone-result-path",
            )?),
            start_signal_path: PathBuf::from(read_arg(
                args,
                "--diagnostic-child-tone-start-signal-path",
            )?),
            abort_signal_path: PathBuf::from(read_arg(
                args,
                "--diagnostic-child-tone-abort-signal-path",
            )?),
            receipt_id: read_arg(args, "--diagnostic-child-tone-receipt-id")?,
            endpoint_id: read_arg(args, "--diagnostic-child-tone-endpoint-id")?,
            frequency_hz: read_arg(args, "--diagnostic-child-tone-frequency-hz")?
                .parse()
                .ok()?,
            amplitude: read_arg(args, "--diagnostic-child-tone-amplitude")?
                .parse()
                .ok()?,
            seconds: read_arg(args, "--diagnostic-child-tone-seconds")?
                .parse()
                .ok()?,
        })
    }
}

struct DiagnosticChildProcess(Option<std::process::Child>);

impl DiagnosticChildProcess {
    fn new(child: std::process::Child) -> Self {
        Self(Some(child))
    }

    fn id(&self) -> u32 {
        self.0.as_ref().expect("diagnostic child must exist").id()
    }

    fn wait_with_abort(&mut self, abort_path: &Path) -> Result<(std::process::Output, bool), String> {
        loop {
            let child = self.0.as_mut().expect("diagnostic child must exist");
            if child.try_wait().map_err_str()?.is_some() {
                let child = self.0.take().expect("diagnostic child must exist");
                return child.wait_with_output().map(|output| (output, false)).map_err_str();
            }
            if abort_path.is_file() {
                child.kill().map_err_str()?;
                let child = self.0.take().expect("diagnostic child must exist");
                return child.wait_with_output().map(|output| (output, true)).map_err_str();
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
}

impl Drop for DiagnosticChildProcess {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

fn spawn_diagnostic_child_tone_launcher(config: DiagnosticChildTone) {
    thread::Builder::new()
        .name("bridge-diagnostic-child-tone".to_string())
        .spawn(move || {
            let result = run_diagnostic_child_tone(config);
            if let Err(detail) = result {
                service_log(
                    LogLevel::Error,
                    &format!("{}:{}", file!(), line!()),
                    &format!("diagnostic Bridge-child tone failed: {detail}"),
                );
            }
        })
        .expect("diagnostic child-tone launcher thread must spawn");
}

fn run_diagnostic_child_tone(config: DiagnosticChildTone) -> Result<(), String> {
    let result = (|| {
        let executable = fs::canonicalize(&config.executable).map_err_str()?;
        let bridge_executable =
            fs::canonicalize(std::env::current_exe().map_err_str()?).map_err_str()?;
        let bridge_directory = bridge_executable
            .parent()
            .ok_or_else(|| "Bridge executable has no parent directory".to_string())?;
        let helper_directory = executable
            .parent()
            .ok_or_else(|| "diagnostic child-tone executable has no parent directory".to_string())?;
        let helper_name = executable
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !helper_name.eq_ignore_ascii_case("omni-tone-render-probe.exe")
            || helper_directory != bridge_directory
        {
            return Err(format!(
                "diagnostic child-tone executable must be the sibling omni-tone-render-probe.exe: {}",
                executable.display()
            ));
        }
        if !(20.0..=20_000.0).contains(&config.frequency_hz)
            || !(0.0..=1.0).contains(&config.amplitude)
            || config.amplitude == 0.0
            || !(0.1..=30.0).contains(&config.seconds)
        {
            return Err("diagnostic child-tone parameters are outside safe ranges".to_string());
        }

        let deadline = Instant::now() + Duration::from_secs(30);
        while !config.trigger_path.is_file() {
            if config.abort_signal_path.is_file() {
                return Err("diagnostic child-tone was aborted before spawn".to_string());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "diagnostic child-tone trigger did not appear within 30 seconds: {}",
                    config.trigger_path.display()
                ));
            }
            thread::sleep(Duration::from_millis(5));
        }

        let child = Command::new(&executable)
            .arg("--endpoint-id")
            .arg(&config.endpoint_id)
            .arg("--frequency-hz")
            .arg(config.frequency_hz.to_string())
            .arg("--amplitude")
            .arg(config.amplitude.to_string())
            .arg("--seconds")
            .arg(config.seconds.to_string())
            .arg("--receipt-id")
            .arg(&config.receipt_id)
            .arg("--ready-receipt-path")
            .arg(&config.ready_receipt_path)
            .arg("--start-signal-path")
            .arg(&config.start_signal_path)
            .arg("--abort-signal-path")
            .arg(&config.abort_signal_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err_str()?;
        let mut child = DiagnosticChildProcess::new(child);
        let child_process_id = child.id();
        publish_diagnostic_file(&config.pid_path, child_process_id.to_string().as_bytes())?;
        let (output, aborted) = child.wait_with_abort(&config.abort_signal_path)?;
        let child_stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let child_stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let child_evidence = serde_json::from_str::<Value>(&child_stdout).ok();
        let exit_code = output.status.code();
        let passed = !aborted
            && output.status.success()
            && child_evidence
                .as_ref()
                .and_then(|value| value["passed"].as_bool())
                == Some(true);
        let result = json!({
            "passed": passed,
            "processId": child_process_id,
            "parentProcessId": std::process::id(),
            "exitCode": exit_code,
            "aborted": aborted,
            "childEvidence": child_evidence,
            "stdout": child_stdout,
            "stderr": child_stderr,
        });
        publish_diagnostic_file(
            &config.result_path,
            &serde_json::to_vec_pretty(&result).map_err_str()?,
        )?;
        if passed {
            Ok(())
        } else {
            Err(format!("diagnostic child-tone process failed: {result}"))
        }
    })();

    if let Err(detail) = &result {
        let failure = json!({
            "passed": false,
            "parentProcessId": std::process::id(),
            "detail": detail,
        });
        if !config.result_path.is_file() {
            let _ = publish_diagnostic_file(
                &config.result_path,
                &serde_json::to_vec_pretty(&failure).unwrap_or_default(),
            );
        }
    }
    result
}
