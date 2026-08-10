use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::*;

fn temp_dir(name: &str) -> PathBuf {
    crate::diagnostics::test_support::temp_dir("export-bundle", name)
}

fn input<'a>(
    scope: DiagnosticsExportScope,
    logs_dir: &'a Path,
    bridge_runtime_root: &'a Path,
) -> BundleInput<'a> {
    BundleInput {
        generated_at: "2026-07-31T12:00:00Z",
        scope,
        diagnostics: json!({
            "status": "warning",
            "supportTier": "experimental",
            "recentErrors": [{ "summary": "probe failed" }],
            "logDroppedCount": 2,
            "logWriteErrorCount": 0,
        }),
        runtime: Some(json!({
            "coreState": "ready",
            "bridgeStatus": "tauri-shell",
            "sessionId": "session-test",
            "windows": [{ "label": "main" }],
            "notifications": [],
        })),
        audio: json!({
            "status": "ready",
            "host": "wasapi",
            "renderDevices": [{ "deviceId": "speaker" }],
            "captureDevices": [{ "deviceId": "microphone" }],
            "inbound": { "captureState": "capturing" },
            "outbound": { "captureState": "idle" },
            "subtitleOverlay": {
                "queueDepth": 1,
                "recentCues": [{ "sourceText": "private conversation" }],
            },
            "echoCaptureDiagnostics": {
                "processedChunks": 19,
                "playbackActiveChunks": 19,
                "forwardedToAsrChunks": 19,
                "droppedChunks": 0,
            },
            "speech": { "status": "ready", "dispatchState": "idle" },
            "sttConnected": true,
        }),
        bridge: json!({
            "status": "warning",
            "bridgeState": "degraded",
            "driverHealth": "running",
            "bridgeVersion": "1.2.3",
        }),
        storage: json!({
            "status": "ready",
            "schemaVersion": 4,
            "credentialBackend": "windows-credential-manager",
            "hasPersistedConfig": true,
        }),
        config: json!({
            "providers": [{
                "apiKey": "config-secret",
                "maxOutputTokens": 4096,
                "customHeaders": [{ "name": "Authorization", "value": "header-secret" }],
            }],
        }),
        logs_dir,
        bridge_runtime_root,
        extra_json: BTreeMap::new(),
        collection_warnings: Vec::new(),
    }
}

fn write_log(root: &Path, name: &str, content: &str) {
    fs::create_dir_all(root).expect("create test log root");
    fs::write(root.join(name), content.as_bytes()).expect("write test log");
}

#[test]
fn scope_parser_is_strict() {
    assert_eq!(
        DiagnosticsExportScope::parse("summary"),
        Ok(DiagnosticsExportScope::Summary)
    );
    assert_eq!(
        DiagnosticsExportScope::parse("quick"),
        Ok(DiagnosticsExportScope::Quick)
    );
    assert_eq!(
        DiagnosticsExportScope::parse("full"),
        Ok(DiagnosticsExportScope::Full)
    );
    assert!(DiagnosticsExportScope::parse("FULL").is_err());
    assert!(DiagnosticsExportScope::parse("../full").is_err());
    assert!(DiagnosticsExportScope::parse("").is_err());
}

#[test]
fn scopes_have_distinct_log_limits_and_full_snapshot_content() {
    let root = temp_dir("scopes");
    let logs = root.join("source-logs");
    let bridge = root.join("bridge");
    fs::create_dir_all(&bridge).expect("create bridge root");
    let mut large_log = String::new();
    for index in 0..20_000 {
        large_log.push_str(&format!(
            "2026-07-31 12:00:00.000 [NORMAL] [runtime] test.rs:1 - line={index} padding-padding-padding-padding-padding-padding\n"
        ));
    }
    write_log(&logs, "app.log", &large_log);

    let summary_dir = root.join("summary");
    let quick_dir = root.join("quick");
    let full_dir = root.join("full");
    write_diagnostics_bundle(
        &summary_dir,
        input(DiagnosticsExportScope::Summary, &logs, &bridge),
    )
    .expect("write summary bundle");
    write_diagnostics_bundle(
        &quick_dir,
        input(DiagnosticsExportScope::Quick, &logs, &bridge),
    )
    .expect("write quick bundle");
    write_diagnostics_bundle(
        &full_dir,
        input(DiagnosticsExportScope::Full, &logs, &bridge),
    )
    .expect("write full bundle");

    let summary_size = fs::metadata(summary_dir.join("logs/desktop/app.log"))
        .expect("summary log metadata")
        .len();
    let quick_size = fs::metadata(quick_dir.join("logs/desktop/app.log"))
        .expect("quick log metadata")
        .len();
    let full_size = fs::metadata(full_dir.join("logs/desktop/app.log"))
        .expect("full log metadata")
        .len();
    assert!(summary_size <= SUMMARY_LOG_TAIL_BYTES as u64);
    assert!(quick_size <= QUICK_LOG_TAIL_BYTES as u64);
    assert!(summary_size < quick_size);
    assert!(quick_size < full_size);
    assert!(!summary_dir.join("snapshots/config.json").exists());
    assert!(!quick_dir.join("snapshots/config.json").exists());
    assert!(full_dir.join("snapshots/config.json").exists());
    let full_config: Value = serde_json::from_str(
        &fs::read_to_string(full_dir.join("snapshots/config.json"))
            .expect("read full config snapshot"),
    )
    .expect("parse full config snapshot");
    assert_eq!(full_config["providers"][0]["apiKey"], "[REDACTED]");
    assert_eq!(full_config["providers"][0]["maxOutputTokens"], 4096);
    let full_audio = fs::read_to_string(full_dir.join("snapshots/audio.json"))
        .expect("read full audio snapshot");
    assert!(full_audio.contains("private conversation"));
    assert!(full_audio.contains("processedChunks"));
    assert!(full_audio.contains("playbackActiveChunks"));
    assert!(full_audio.contains("forwardedToAsrChunks"));
    assert!(full_audio.contains("droppedChunks"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn log_and_json_credentials_are_redacted() {
    let root = temp_dir("redaction");
    let logs = root.join("logs");
    let bridge = root.join("bridge");
    fs::create_dir_all(&bridge).expect("create bridge root");
    write_log(
        &logs,
        "app.log",
        concat!(
            "2026-07-31 12:00:00.000 [TRACE] [runtime] request Authorization: Bearer bearer-secret\n",
            "2026-07-31 12:00:00.001 [DEBUG] [provider] headers={\"x-api-key\":\"api-secret\"}\n",
            "2026-07-31 12:00:00.002 [NORMAL] [provider] Cookie: session=cookie-secret\n",
            "2026-07-31 12:00:00.003 [ERROR] [provider] password=password-secret\n",
        ),
    );
    let mut bundle_input = input(DiagnosticsExportScope::Full, &logs, &bridge);
    bundle_input.extra_json.insert(
        "provider-probe".to_string(),
        json!({
            "Authorization": "Bearer json-secret",
            "customHeaders": [{ "name": "X-Key", "value": "custom-secret" }],
        }),
    );
    let output = root.join("bundle");
    let result = write_diagnostics_bundle(&output, bundle_input).expect("write full bundle");

    let exported_log = fs::read_to_string(output.join("logs/desktop/app.log"))
        .expect("read exported log");
    for secret in [
        "bearer-secret",
        "api-secret",
        "cookie-secret",
        "password-secret",
    ] {
        assert!(!exported_log.contains(secret), "log leaked {secret}");
    }
    assert!(exported_log.contains("[REDACTED]"));
    let extra = fs::read_to_string(output.join("snapshots/extra/provider-probe.json"))
        .expect("read sanitized extra JSON");
    assert!(!extra.contains("json-secret"));
    assert!(!extra.contains("custom-secret"));
    assert!(result.redaction_count >= 6);

    let log_summary: Value = serde_json::from_str(
        &fs::read_to_string(output.join("log-summary.json")).expect("read log summary"),
    )
    .expect("parse log summary");
    assert_eq!(log_summary["totals"]["levelStats"]["ERROR"], 1);
    assert_eq!(log_summary["totals"]["categoryStats"]["provider"], 3);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn canonical_log_deduplication_and_manifest_file_count_match_disk() {
    let root = temp_dir("dedupe");
    let shared_logs = root.join("shared-logs");
    write_log(
        &shared_logs,
        "app.log",
        "2026-07-31 12:00:00.000 [NORMAL] [runtime] test.rs:1 - ready\n",
    );
    write_log(
        &shared_logs,
        "bridge-service.log",
        "2026-07-31 12:00:00.000 [WARNING] [bridge] test.rs:1 - degraded\n",
    );
    let output = root.join("bundle");
    let result = write_diagnostics_bundle(
        &output,
        input(
            DiagnosticsExportScope::Summary,
            &shared_logs,
            &shared_logs,
        ),
    )
    .expect("write deduplicated bundle");

    let log_summary: Value = serde_json::from_str(
        &fs::read_to_string(output.join("log-summary.json")).expect("read log summary"),
    )
    .expect("parse log summary");
    assert_eq!(log_summary["files"].as_array().map(Vec::len), Some(2));
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(output.join("bundle-manifest.json")).expect("read manifest"),
    )
    .expect("parse manifest");
    assert_eq!(manifest["schemaVersion"], BUNDLE_SCHEMA_VERSION);
    assert_eq!(manifest["redactionPolicy"], REDACTION_POLICY);
    assert_eq!(
        manifest["totals"]["fileCount"].as_u64(),
        Some(result.file_count as u64)
    );
    assert_eq!(
        manifest["payloadFiles"].as_array().map(Vec::len),
        Some(result.file_count - 1)
    );
    let (disk_count, disk_bytes) = count_bundle_files(&output).expect("count bundle files");
    assert_eq!(result.file_count, disk_count);
    assert_eq!(result.total_bytes, disk_bytes);
    assert_eq!(result.file_count, 7);
    assert_eq!(manifest["totals"]["bundleBytes"].as_u64(), Some(disk_bytes));
    for payload in manifest["payloadFiles"]
        .as_array()
        .expect("manifest payload list")
    {
        let relative_path = payload["path"].as_str().expect("manifest payload path");
        let expected_bytes = payload["bytes"].as_u64().expect("manifest payload bytes");
        assert_eq!(
            fs::metadata(output.join(relative_path))
                .expect("manifest payload metadata")
                .len(),
            expected_bytes,
            "payload byte count mismatch for {relative_path}"
        );
    }

    let environment: Value = serde_json::from_str(
        &fs::read_to_string(output.join("environment.json")).expect("read environment"),
    )
    .expect("parse environment");
    assert!(environment.get("cwd").is_none());
    assert!(environment["executableName"].is_string());
    assert!(environment["processId"].as_u64().is_some());
    assert!(environment["availableParallelism"].as_u64().is_some());
    assert_eq!(environment["redactionPolicy"], REDACTION_POLICY);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn empty_log_roots_are_skipped_instead_of_scanning_the_working_directory() {
    let root = temp_dir("empty-roots");
    let empty_root = Path::new("");
    let result = write_diagnostics_bundle(
        &root,
        input(DiagnosticsExportScope::Summary, empty_root, empty_root),
    )
    .expect("write bundle without log roots");

    assert_eq!(result.original_log_bytes, 0);
    assert_eq!(result.exported_log_bytes, 0);
    assert!(result
        .warnings
        .iter()
        .filter(|warning| warning.contains("log root was empty"))
        .count()
        >= 2);
    assert!(!root.join("logs").exists());

    let _ = fs::remove_dir_all(root);
}
