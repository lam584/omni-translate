use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::audio::contracts::SubtitleCueRuntime;
use crate::audio::state::AudioStateStore;
use crate::bridge::contracts::BridgeRuntimeSnapshot;
use crate::bridge::state::BridgeStateStore;
use crate::shared::time::now_unix_seconds_marker;
use crate::storage::contracts::StorageRuntimeSnapshot;
use crate::storage::StorageStateStore;

use super::contracts::{
    DiagnosticSupportSignalRuntime, DiagnosticsExportArtifact, DiagnosticsRuntimeSnapshot,
};
use super::state::{copy_logs_into, DiagnosticsStateStore};

fn write_diagnostics_bundle(
    export_dir: &Path,
    generated_at: &str,
    scope: &str,
    diagnostics_snapshot: &DiagnosticsRuntimeSnapshot,
    audio_snapshot: &crate::audio::contracts::AudioRuntimeSnapshot,
    bridge_snapshot: &BridgeRuntimeSnapshot,
    storage_snapshot: &StorageRuntimeSnapshot,
    config_value: &Value,
    logs_dir: &str,
    bridge_runtime_root: &str,
) -> Result<usize, String> {
    let diagnostics_json =
        serde_json::to_string_pretty(diagnostics_snapshot).map_err(|error| error.to_string())?;
    let audio_json =
        serde_json::to_string_pretty(audio_snapshot).map_err(|error| error.to_string())?;
    let bridge_json =
        serde_json::to_string_pretty(bridge_snapshot).map_err(|error| error.to_string())?;
    let storage_json =
        serde_json::to_string_pretty(storage_snapshot).map_err(|error| error.to_string())?;
    let sanitized_config = super::model_trace::sanitize_value(config_value.clone());
    let config_json =
        serde_json::to_string_pretty(&sanitized_config).map_err(|error| error.to_string())?;
    let env_json = serde_json::to_string_pretty(&json!({
      "generatedAt": generated_at,
      "scope": scope,
      "platform": std::env::consts::OS,
      "arch": std::env::consts::ARCH,
      "appVersion": env!("CARGO_PKG_VERSION"),
      "cwd": std::env::current_dir().ok().map(|path| path.to_string_lossy().to_string()),
    }))
    .map_err(|error| error.to_string())?;

    fs::write(
        export_dir.join("diagnostics-summary.json"),
        diagnostics_json,
    )
    .map_err(|error| error.to_string())?;
    fs::write(export_dir.join("audio-runtime.json"), audio_json)
        .map_err(|error| error.to_string())?;
    fs::write(export_dir.join("bridge-runtime.json"), bridge_json)
        .map_err(|error| error.to_string())?;
    fs::write(export_dir.join("storage-runtime.json"), storage_json)
        .map_err(|error| error.to_string())?;
    fs::write(export_dir.join("config-draft.json"), config_json)
        .map_err(|error| error.to_string())?;
    fs::write(export_dir.join("environment.json"), env_json).map_err(|error| error.to_string())?;
    let export_logs_dir = export_dir.join("logs");
    let mut copied_logs = copy_logs_into(&export_logs_dir.to_string_lossy(), logs_dir)?;
    let bridge_service_log = Path::new(bridge_runtime_root).join("bridge-service.log");
    if bridge_service_log.exists() {
        fs::create_dir_all(&export_logs_dir).map_err(|error| error.to_string())?;
        fs::copy(
            &bridge_service_log,
            export_logs_dir.join("bridge-service.log"),
        )
        .map_err(|error| error.to_string())?;
        copied_logs += 1;
    }
    Ok(copied_logs + 6)
}

fn status_from_probe_verdict(verdict: Option<&str>) -> String {
    match verdict {
        Some("available") => "ready".to_string(),
        Some("unavailable") => "unsupported".to_string(),
        Some(_) => "warning".to_string(),
        None => "warning".to_string(),
    }
}

fn support_signal(
    id: &str,
    label: &str,
    status: String,
    summary: String,
    recommended_action: Option<String>,
) -> DiagnosticSupportSignalRuntime {
    DiagnosticSupportSignalRuntime {
        id: id.to_string(),
        label: label.to_string(),
        status,
        summary,
        recommended_action,
    }
}

fn build_support_matrix(app: &AppHandle) -> Vec<DiagnosticSupportSignalRuntime> {
    let audio_snapshot = app
        .try_state::<AudioStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_else(crate::audio::contracts::AudioRuntimeSnapshot::preview);
    let bridge_snapshot = app
        .try_state::<BridgeStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_default();
    let config_value = app
        .try_state::<StorageStateStore>()
        .and_then(|storage| storage.load_config().ok())
        .unwrap_or(Value::Null);
    let provider_transport = config_value
        .pointer("/provider/transport")
        .and_then(Value::as_str)
        .unwrap_or("http");
    let provider_verdict = config_value
        .pointer("/provider/probe/verdict")
        .and_then(Value::as_str);
    let provider_checked_at = config_value
        .pointer("/provider/probe/checkedAt")
        .and_then(Value::as_str)
        .unwrap_or("未探测");

    let device_status = if !audio_snapshot.capture_devices.is_empty()
        && !audio_snapshot.render_devices.is_empty()
    {
        "ready".to_string()
    } else {
        "warning".to_string()
    };
    let bridge_status = if bridge_snapshot.driver_health == "running"
        && bridge_snapshot.bridge_state == "running"
    {
        "ready".to_string()
    } else {
        "warning".to_string()
    };
    let provider_status = status_from_probe_verdict(provider_verdict);
    let permission_status = if bridge_snapshot.rollback_supported {
        "ready"
    } else {
        "warning"
    }
    .to_string();

    vec![
        support_signal(
            "device-binding",
            "设备与音频链路",
            device_status,
            format!(
                "render={} / capture={} / inbound={} / outbound={}",
                audio_snapshot.render_devices.len(),
                audio_snapshot.capture_devices.len(),
                audio_snapshot.inbound.capture_state,
                audio_snapshot.outbound.capture_state
            ),
            Some("open-diagnostics".to_string()),
        ),
        support_signal(
            "driver-bridge",
            "Driver 与 Bridge",
            bridge_status,
            format!(
                "health={} / bridge={} / phase={}",
                bridge_snapshot.driver_health,
                bridge_snapshot.bridge_state,
                bridge_snapshot.install_phase
            ),
            bridge_snapshot.recommended_action.clone(),
        ),
        support_signal(
            "provider-transport",
            "Provider 传输与探测",
            provider_status,
            format!(
                "transport={} / checkedAt={}",
                provider_transport, provider_checked_at
            ),
            Some("open-diagnostics".to_string()),
        ),
        support_signal(
            "permissions-and-rollback",
            "权限与回滚保障",
            permission_status,
            format!(
                "channel={} / rollbackSupported={} / runtimeRoot={}",
                bridge_snapshot.install_channel,
                bridge_snapshot.rollback_supported,
                bridge_snapshot.runtime_root
            ),
            bridge_snapshot.recommended_action.clone(),
        ),
    ]
}

pub fn build_diagnostics_snapshot(app: &AppHandle) -> DiagnosticsRuntimeSnapshot {
    let diagnostics = app
        .try_state::<DiagnosticsStateStore>()
        .map(|store| store.snapshot_base())
        .unwrap_or_else(DiagnosticsRuntimeSnapshot::preview);
    let bridge_snapshot = app
        .try_state::<BridgeStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_default();
    let config_value = app
        .try_state::<StorageStateStore>()
        .and_then(|storage| storage.load_config().ok())
        .unwrap_or(Value::Null);
    let support_matrix = build_support_matrix(app);
    let install_status = if bridge_snapshot.install_phase == "ready" {
        "ready"
    } else {
        "warning"
    }
    .to_string();
    let provider_status = status_from_probe_verdict(
        config_value
            .pointer("/provider/probe/verdict")
            .and_then(Value::as_str),
    );
    let driver_status = if bridge_snapshot.status == "ready" {
        "ready"
    } else {
        "warning"
    }
    .to_string();
    let device_status = support_matrix
        .iter()
        .find(|item| item.id == "device-binding")
        .map(|item| item.status.clone())
        .unwrap_or_else(|| "warning".to_string());
    let support_tier = if support_matrix.iter().all(|item| item.status == "ready")
        && bridge_snapshot.install_channel == "release"
    {
        "stable".to_string()
    } else {
        "experimental".to_string()
    };
    let status = if support_matrix
        .iter()
        .any(|item| item.status == "unsupported")
    {
        "unsupported".to_string()
    } else if support_matrix.iter().all(|item| item.status == "ready") {
        "ready".to_string()
    } else {
        "warning".to_string()
    };

    DiagnosticsRuntimeSnapshot {
        status,
        support_tier,
        install_status,
        provider_status,
        driver_status,
        device_status,
        support_matrix,
        ..diagnostics
    }
}

pub fn append_diagnostics_log<R: tauri::Runtime>(
    app: &AppHandle<R>,
    category: &str,
    level: &str,
    summary: impl Into<String>,
    detail: Option<String>,
    source: Option<String>,
    elapsed_ms: Option<u128>,
) -> Result<(), String> {
    append_diagnostics_log_quiet(app, category, level, summary, detail, source, elapsed_ms)?;
    // Native-origin log lines publish a signal; the runtime subscriber
    // (registered by the composition root) decides whether to rebuild and
    // emit the runtime snapshot. The quiet frontend-forwarding path below
    // never publishes — a frontend-originated line must not race the
    // WebView2 invoke-response channel with snapshot events.
    crate::shared::signals::global().publish_diagnostics_log(category, level);
    Ok(())
}

pub fn append_diagnostics_log_quiet<R: tauri::Runtime>(
    app: &AppHandle<R>,
    category: &str,
    level: &str,
    summary: impl Into<String>,
    detail: Option<String>,
    source: Option<String>,
    elapsed_ms: Option<u128>,
) -> Result<(), String> {
    let Some(store) = app.try_state::<DiagnosticsStateStore>() else {
        return Ok(());
    };

    store.append_log(
        category,
        level,
        summary,
        detail,
        now_unix_seconds_marker(),
        source,
        elapsed_ms,
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_diagnostics_log_level(
    diagnostics: State<'_, DiagnosticsStateStore>,
    level: String,
) -> Result<(), String> {
    diagnostics.set_min_log_level(&level);
    Ok(())
}

pub fn get_diagnostics_snapshot(app: AppHandle) -> DiagnosticsRuntimeSnapshot {
    build_diagnostics_snapshot(&app)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendDiagnosticsBatchEntry {
    pub category: String,
    pub level: String,
    pub summary: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub emitted_at: Option<String>,
}

/// Batched frontend log ingestion (renderer logger flushes up to ~100 entries
/// per call instead of one IPC round trip per line). `async` + quiet appends
/// for the same reasons as `append_frontend_diagnostics_logs` below.
#[tauri::command]
pub async fn append_frontend_diagnostics_logs(
    app: AppHandle,
    entries: Vec<FrontendDiagnosticsBatchEntry>,
    dropped_count: Option<u64>,
) -> Result<(), String> {
    let Some(store) = app.try_state::<DiagnosticsStateStore>() else {
        return Ok(());
    };

    for entry in entries {
        let _ = store.append_log(
            &entry.category,
            &entry.level,
            entry.summary,
            entry.detail,
            entry.emitted_at.unwrap_or_else(now_unix_seconds_marker),
            None,
            None,
        );
    }

    let dropped = dropped_count.unwrap_or(0);
    if dropped > 0 {
        let _ = store.append_log(
            "runtime",
            "warning",
            format!("frontend log buffer dropped {dropped} entries before forwarding"),
            None,
            now_unix_seconds_marker(),
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    }

    Ok(())
}

/// Diagnostics half of the one-click self check: refresh the diagnostics
/// snapshot state and record the outcome. The runtime-snapshot emission and
/// aggregate return value are orchestrated by the `diagnostics_v2` dispatch
/// (the composition layer), so this module no longer calls into `runtime`.
pub fn run_diagnostics_self_check(
    app: AppHandle,
    diagnostics: State<'_, DiagnosticsStateStore>,
) -> Result<(), String> {
    let snapshot = build_diagnostics_snapshot(&app);
    diagnostics.mark_self_check(now_unix_seconds_marker());
    append_diagnostics_log(
        &app,
        "runtime",
        if snapshot.status == "ready" {
            "info"
        } else {
            "warning"
        },
        format!(
            "已执行一键诊断，自检结果={} / supportTier={}。",
            snapshot.status, snapshot.support_tier
        ),
        Some(format!("signals={}", snapshot.support_matrix.len())),
        Some(format!("{}:{}", file!(), line!())),
        None,
    )
}

/// Diagnostics half of the overlay self check: inject the visible cue. The
/// overlay window handling and snapshot emission live in the `diagnostics_v2`
/// dispatch so the ordering (cue -> show window -> audio emit -> log) is
/// composed in one place without a diagnostics -> runtime call.
pub fn push_overlay_self_check_cue(audio_state: &AudioStateStore) {
    let emitted_at = now_unix_seconds_marker();
    audio_state.push_subtitle_cue(SubtitleCueRuntime {
        cue_id: format!("overlay-self-check-{emitted_at}"),
        route_direction: "diagnostics".to_string(),
        source_text: "Subtitle overlay self-check".to_string(),
        display_source_text: "Subtitle overlay self-check".to_string(),
        display_segments: Vec::new(),
        translated_text: "字幕浮窗自检已通过".to_string(),
        started_at: emitted_at.clone(),
        ended_at: emitted_at,
        committed: true,
    });
}

/// The log line the overlay self check records after the cue became visible.
pub fn log_overlay_self_check_cue(app: &AppHandle) -> Result<(), String> {
    append_diagnostics_log(
        app,
        "runtime",
        "info",
        "subtitle overlay self-check injected a visible cue",
        Some("cue=overlay-self-check source=diagnostics".to_string()),
        Some(format!("{}:{}", file!(), line!())),
        None,
    )
}

// `async fn` so this runs on a tokio worker thread, NOT the main thread.
// The body performs heavy synchronous filesystem IO (snapshot build + bundle
// write). A synchronous `#[tauri::command] fn` would run that IO on the main
// thread, freezing the message pump (and therefore all IPC + the tray) until
// the export finishes -- exactly the "导出中" stall users hit. Moving it off
// the main thread keeps the UI/IPC responsive while the bundle is written.
pub async fn export_diagnostics_bundle(
    app: AppHandle,
    diagnostics: State<'_, DiagnosticsStateStore>,
    scope: String,
) -> Result<DiagnosticsExportArtifact, String> {
    diagnostics.ensure_directories()?;
    let generated_at = now_unix_seconds_marker();
    let export_dir = format!(
        r"{}\{}-{}",
        diagnostics.exports_dir(),
        generated_at.replace(':', "-"),
        scope
    );
    fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;

    let diagnostics_snapshot = build_diagnostics_snapshot(&app);
    let audio_snapshot = app
        .try_state::<AudioStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_else(crate::audio::contracts::AudioRuntimeSnapshot::preview);
    let bridge_snapshot = app
        .try_state::<BridgeStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_default();
    let storage_snapshot = app
        .try_state::<StorageStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_else(crate::storage::contracts::StorageRuntimeSnapshot::preview);
    let config_value = app
        .try_state::<StorageStateStore>()
        .and_then(|storage| storage.load_config().ok())
        .unwrap_or(Value::Null);

    let file_count = write_diagnostics_bundle(
        Path::new(&export_dir),
        &generated_at,
        &scope,
        &diagnostics_snapshot,
        &audio_snapshot,
        &bridge_snapshot,
        &storage_snapshot,
        &config_value,
        &diagnostics.logs_dir(),
        &bridge_snapshot.runtime_root,
    )?;

    diagnostics.mark_export(scope.clone(), export_dir.clone(), now_unix_seconds_marker());
    append_diagnostics_log(
        &app,
        "runtime",
        "info",
        format!("已生成 diagnostics 导出包，scope={}。", scope),
        Some(export_dir.clone()),
        Some(format!("{}:{}", file!(), line!())),
        None,
    )?;

    Ok(DiagnosticsExportArtifact {
        scope,
        output_path: export_dir,
        generated_at,
        file_count,
    })
}

pub fn get_live_session_events(
    audio_state: State<'_, AudioStateStore>,
) -> Result<String, String> {
    let snapshot = audio_state.live_session_events.snapshot();
    serde_json::to_string(&snapshot).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use crate::audio::contracts::AudioRuntimeSnapshot;
    use crate::bridge::contracts::BridgeRuntimeSnapshot;
    use crate::storage::contracts::StorageRuntimeSnapshot;

    use super::{write_diagnostics_bundle, DiagnosticsRuntimeSnapshot};

    fn temp_dir(name: &str) -> PathBuf {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("omni-diagnostics-export-{name}-{marker}"))
    }

    #[test]
    fn write_diagnostics_bundle_outputs_expected_files() {
        let root_dir = temp_dir("root");
        let logs_dir = root_dir.join("logs");
        let export_dir = root_dir.join("bundle");
        fs::create_dir_all(&logs_dir).expect("create logs dir");
        fs::create_dir_all(&export_dir).expect("create export dir");
        fs::write(
            logs_dir.join("app.log"),
            "2025-01-01 00:00:00.000 [NORMAL] [runtime] test.rs:1 - ready\n",
        )
        .expect("write log file");

        let file_count = write_diagnostics_bundle(
            &export_dir,
            "2025-01-01T00:00:00Z",
            "full",
            &DiagnosticsRuntimeSnapshot::preview(),
            &AudioRuntimeSnapshot::preview(),
            &BridgeRuntimeSnapshot::default(),
            &StorageRuntimeSnapshot::preview(),
            &json!({"provider": {"transport": "http"}}),
            &logs_dir.to_string_lossy(),
            &root_dir.join("bridge-runtime").to_string_lossy(),
        )
        .expect("write diagnostics bundle");

        assert_eq!(file_count, 7);
        assert!(export_dir.join("diagnostics-summary.json").exists());
        assert!(export_dir.join("audio-runtime.json").exists());
        assert!(export_dir.join("bridge-runtime.json").exists());
        assert!(export_dir.join("storage-runtime.json").exists());
        assert!(export_dir.join("config-draft.json").exists());
        assert!(export_dir.join("environment.json").exists());
        assert!(export_dir.join("logs").join("app.log").exists());

        let _ = fs::remove_dir_all(root_dir);
    }

    #[test]
    fn write_diagnostics_bundle_never_exports_config_credentials() {
        let root_dir = temp_dir("redacted");
        let logs_dir = root_dir.join("logs");
        let export_dir = root_dir.join("bundle");
        fs::create_dir_all(&logs_dir).expect("create logs dir");
        fs::create_dir_all(&export_dir).expect("create export dir");
        fs::write(logs_dir.join("app.log"), "safe log\n").expect("write log file");
        let secret = "diagnostics-test-secret-7f3a";

        write_diagnostics_bundle(
            &export_dir,
            "2025-01-01T00:00:00Z",
            "full",
            &DiagnosticsRuntimeSnapshot::preview(),
            &AudioRuntimeSnapshot::preview(),
            &BridgeRuntimeSnapshot::default(),
            &StorageRuntimeSnapshot::preview(),
            &json!({
                "providers": [{
                    "apiKey": secret,
                    "customHeaders": [{"name": "Authorization", "value": secret}],
                    "baseUrl": format!("https://example.test/v1?token={secret}")
                }]
            }),
            &logs_dir.to_string_lossy(),
            &root_dir.join("bridge-runtime").to_string_lossy(),
        )
        .expect("write diagnostics bundle");

        let exported = fs::read_to_string(export_dir.join("config-draft.json"))
            .expect("read exported config");
        assert!(!exported.contains(secret));
        assert!(exported.contains("[REDACTED]"));
        let _ = fs::remove_dir_all(root_dir);
    }

    #[test]
    fn write_diagnostics_bundle_copies_optional_bridge_service_log() {
        let root_dir = temp_dir("bridge-log");
        let logs_dir = root_dir.join("logs");
        let bridge_runtime_root = root_dir.join("bridge-runtime");
        let export_dir = root_dir.join("bundle");
        fs::create_dir_all(&logs_dir).expect("create logs dir");
        fs::create_dir_all(&bridge_runtime_root).expect("create bridge runtime dir");
        fs::create_dir_all(&export_dir).expect("create export dir");
        fs::write(logs_dir.join("app.log"), "app\n").expect("write app log");
        fs::write(bridge_runtime_root.join("bridge-service.log"), "bridge\n")
            .expect("write bridge log");

        let file_count = write_diagnostics_bundle(
            &export_dir,
            "2025-01-01T00:00:00Z",
            "full",
            &DiagnosticsRuntimeSnapshot::preview(),
            &AudioRuntimeSnapshot::preview(),
            &BridgeRuntimeSnapshot::default(),
            &StorageRuntimeSnapshot::preview(),
            &json!({}),
            &logs_dir.to_string_lossy(),
            &bridge_runtime_root.to_string_lossy(),
        )
        .expect("write diagnostics bundle");

        assert_eq!(file_count, 8);
        assert!(export_dir.join("logs").join("bridge-service.log").exists());
        let _ = fs::remove_dir_all(root_dir);
    }
}
