use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::contracts::{BridgeRuntimeSnapshot, DriverOperationResult, DriverProbeResult};
use super::ipc::workspace_root;

fn scripts_root() -> PathBuf {
    workspace_root().join("scripts").join("installer")
}

fn script_path(script_name: &str) -> PathBuf {
    scripts_root().join(script_name)
}

const ELEVATED_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);

fn parse_driver_probe_output(output: &[u8]) -> Result<DriverProbeResult, String> {
    let contents = std::str::from_utf8(output)
        .map_err(|error| format!("driver.probe-invalid-utf8: {error}"))?;
    let contents = contents.trim().trim_start_matches('\u{feff}').trim();
    serde_json::from_str(contents).map_err(|error| format!("driver.probe-invalid-json: {error}"))
}

pub fn apply_driver_probe(snapshot: &mut BridgeRuntimeSnapshot, probe: DriverProbeResult) {
    let preserved_bridge_error = if probe.error_code.is_none() {
        snapshot
            .last_error_code
            .as_deref()
            .filter(|code| code.starts_with("bridge."))
            .map(str::to_string)
    } else {
        None
    };
    snapshot.driver_health = probe.driver_health;
    snapshot.driver_probe_state = "ready".to_string();
    snapshot.driver_version = probe.installed_driver_version;
    snapshot.last_error_code = probe.error_code.or(preserved_bridge_error);
    snapshot.test_signing_enabled = probe.test_signing_enabled;
    snapshot.signature_enforcement_bypassed = probe.signature_enforcement_bypassed;
    snapshot.memory_integrity_enabled = probe.memory_integrity_enabled;
    snapshot.secure_boot_enabled = probe.secure_boot_enabled;
    snapshot.secure_boot_probe_status = probe.secure_boot_probe_status;
    snapshot.root_device_count = probe.root_device_count;
    snapshot.root_instance_ids = probe.root_instance_ids;
    snapshot.endpoint_name = probe.endpoint_name;
    snapshot.abi_version = probe.abi_version;
    snapshot.ioctl_available = probe.ioctl_available;
    snapshot.driver_detail = probe.detail;
}

pub fn probe_driver(
    snapshot: &BridgeRuntimeSnapshot,
    probe_secure_boot_elevated: bool,
) -> Result<DriverProbeResult, String> {
    let script = script_path("probe-development-driver.ps1");
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script)
        .arg("-WorkspaceRoot")
        .arg(workspace_root())
        .arg("-RuntimeRoot")
        .arg(&snapshot.runtime_root);
    if probe_secure_boot_elevated {
        command.arg("-ProbeSecureBootElevated");
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    parse_driver_probe_output(&output.stdout)
}

fn operation_result_path(snapshot: &BridgeRuntimeSnapshot, operation_id: &str) -> PathBuf {
    Path::new(&snapshot.runtime_root)
        .join("driver-operations")
        .join(format!("{operation_id}.json"))
}

pub fn run_elevated_driver_operation(
    snapshot: &BridgeRuntimeSnapshot,
    action: &str,
) -> Result<DriverOperationResult, String> {
    let operation_id = Uuid::new_v4().to_string();
    let result_path = operation_result_path(snapshot, &operation_id);
    if let Some(parent) = result_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let script = script_path("request-elevated-driver-operation.ps1");
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script)
        .arg("-Action")
        .arg(action)
        .arg("-OperationId")
        .arg(&operation_id)
        .arg("-ResultPath")
        .arg(&result_path)
        .arg("-WorkspaceRoot")
        .arg(workspace_root())
        .arg("-RuntimeRoot")
        .arg(&snapshot.runtime_root)
        .arg("-InstallChannel")
        .arg(&snapshot.install_channel)
        .arg("-DriverVersion")
        .arg(&snapshot.expected_driver_version)
        .arg("-BridgeVersion")
        .arg(&snapshot.expected_bridge_version)
        .arg("-TargetDeviceId")
        .arg(&snapshot.target_device_id)
        .arg("-VirtualRenderDeviceId")
        .arg(&snapshot.virtual_render_device_id)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let mut child = command.spawn().map_err(|error| {
        let message = error.to_string();
        if message.contains("1223") {
            "driver.elevation-cancelled".to_string()
        } else {
            message
        }
    })?;
    loop {
        if started.elapsed() >= ELEVATED_OPERATION_TIMEOUT {
            let _ = child.kill();
            return Err("driver.operation-failed: elevated driver operation timed out".to_string());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let contents = fs::read_to_string(&result_path).map_err(|error| {
                if status.code() == Some(1223) {
                    "driver.elevation-cancelled".to_string()
                } else {
                    format!("driver.operation-failed: elevated result missing: {error}")
                }
            })?;
            let result: DriverOperationResult =
                serde_json::from_str(&contents).map_err(|error| error.to_string())?;
            if result.succeeded {
                return Ok(result);
            }
            return Err(format!(
                "{}: {} [operationId={}] [logPath={}]",
                result
                    .error_code
                    .as_deref()
                    .unwrap_or("driver.operation-failed"),
                result.summary,
                result.operation_id,
                result.log_path
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::{apply_driver_probe, parse_driver_probe_output};
    use crate::bridge::contracts::{BridgeRuntimeSnapshot, DriverProbeResult};

    const PROBE_JSON: &str = r#"{"schemaVersion":1,"driverHealth":"running","errorCode":null,"testSigningEnabled":true,"signatureEnforcementBypassed":false,"memoryIntegrityEnabled":false,"secureBootEnabled":null,"secureBootProbeStatus":"unavailable","rootDeviceCount":1,"rootInstanceIds":["ROOT\\MEDIA\\0000"],"endpointName":"扬声器 (Omni Translate Virtual Speaker)","abiVersion":"0X20260602","ioctlAvailable":true,"installedDriverVersion":"0.10.0-dev","detail":null}"#;

    #[test]
    fn parses_utf8_driver_probe_with_localized_endpoint_name() {
        let probe = parse_driver_probe_output(PROBE_JSON.as_bytes()).expect("probe should parse");

        assert_eq!(probe.driver_health, "running");
        assert_eq!(
            probe.endpoint_name.as_deref(),
            Some("扬声器 (Omni Translate Virtual Speaker)")
        );
        assert_eq!(probe.abi_version.as_deref(), Some("0X20260602"));
    }

    #[test]
    fn parses_driver_probe_with_utf8_bom_and_whitespace() {
        let output = format!(" \r\n\u{feff}{PROBE_JSON}\r\n ");
        let probe = parse_driver_probe_output(output.as_bytes()).expect("probe should parse");

        assert_eq!(probe.root_instance_ids, vec!["ROOT\\MEDIA\\0000"]);
    }

    #[test]
    fn rejects_invalid_utf8_driver_probe() {
        let error = match parse_driver_probe_output(&[0xff, 0xfe]) {
            Ok(_) => panic!("invalid UTF-8 should fail"),
            Err(error) => error,
        };

        assert!(error.starts_with("driver.probe-invalid-utf8:"));
    }

    #[test]
    fn rejects_invalid_json_driver_probe() {
        let error = match parse_driver_probe_output(b"{") {
            Ok(_) => panic!("invalid JSON should fail"),
            Err(error) => error,
        };

        assert!(error.starts_with("driver.probe-invalid-json:"));
    }

    #[test]
    fn successful_driver_probe_preserves_bridge_startup_error() {
        let mut snapshot = BridgeRuntimeSnapshot {
            last_error_code: Some("bridge.start-failed".to_string()),
            driver_detail: Some("Bridge failed to start.".to_string()),
            ..Default::default()
        };

        apply_driver_probe(
            &mut snapshot,
            DriverProbeResult {
                schema_version: 1,
                driver_health: "running".to_string(),
                error_code: None,
                test_signing_enabled: true,
                signature_enforcement_bypassed: false,
                memory_integrity_enabled: false,
                secure_boot_enabled: Some(false),
                secure_boot_probe_status: "ready".to_string(),
                root_device_count: 1,
                root_instance_ids: vec!["ROOT\\MEDIA\\0000".to_string()],
                endpoint_name: Some("Speakers (Omni Translate Virtual Speaker)".to_string()),
                abi_version: Some("0X20260604".to_string()),
                ioctl_available: true,
                installed_driver_version: Some("0.10.0-dev".to_string()),
                detail: None,
            },
        );

        assert_eq!(
            snapshot.last_error_code.as_deref(),
            Some("bridge.start-failed")
        );
    }
}
