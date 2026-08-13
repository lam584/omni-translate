use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::audio::contracts::SubtitleCueRuntime;
use crate::audio::state::AudioStateStore;
use crate::bridge::contracts::BridgeRuntimeSnapshot;
use crate::bridge::state::BridgeStateStore;
use crate::runtime::events::build_runtime_snapshot;
use crate::runtime::state::RuntimeStateStore;
use crate::shared::time::{now_unix_millis_marker, now_unix_seconds_marker};
use crate::storage::StorageStateStore;

use super::contracts::{
    DiagnosticSupportSignalRuntime, DiagnosticsExportArtifact, DiagnosticsRuntimeSnapshot,
};
use super::export_bundle::{
    write_diagnostics_bundle, BundleInput, DiagnosticsExportScope,
};
use super::state::DiagnosticsStateStore;

fn serialize_export_value<T: Serialize>(label: &str, value: &T) -> Result<Value, String> {
    serde_json::to_value(value)
        .map_err(|error| format!("failed to serialize {label} for diagnostics export: {error}"))
}

fn safe_export_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn status_from_probe_verdict(verdict: Option<&str>) -> String {
    match verdict {
        Some("available") => "ready".to_string(),
        Some("unavailable") => "unsupported".to_string(),
        Some(_) => "warning".to_string(),
        None => "warning".to_string(),
    }
}

/// Fetch the audio snapshot from the managed state, falling back to the
/// preview baseline before the audio store is registered.
fn audio_snapshot_or_preview<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> crate::audio::contracts::AudioRuntimeSnapshot {
    app.try_state::<AudioStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_else(crate::audio::contracts::AudioRuntimeSnapshot::preview)
}

/// Fetch the bridge snapshot from the managed state, falling back to the
/// default snapshot before the bridge store is registered.
fn bridge_snapshot_or_default<R: tauri::Runtime>(app: &AppHandle<R>) -> BridgeRuntimeSnapshot {
    app.try_state::<BridgeStateStore>()
        .map(|state| state.snapshot())
        .unwrap_or_default()
}

/// Load the persisted config value, falling back to JSON null when the storage
/// store is unavailable or the config cannot be read.
fn config_value_or_null<R: tauri::Runtime>(app: &AppHandle<R>) -> Value {
    app.try_state::<StorageStateStore>()
        .and_then(|storage| storage.load_config().ok())
        .unwrap_or(Value::Null)
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

fn build_support_matrix<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Vec<DiagnosticSupportSignalRuntime> {
    let audio_snapshot = audio_snapshot_or_preview(app);
    let bridge_snapshot = bridge_snapshot_or_default(app);
    let config_value = config_value_or_null(app);
    // Probe data lives in the provider state store (recorded by
    // events::probe_provider); before the first probe the row falls back to
    // the configured transport of the active provider.
    let last_probe = app
        .try_state::<crate::provider::state::ProviderStateStore>()
        .and_then(|store| store.last_probe());
    let configured_transport = config_value
        .pointer("/providers/0/transport")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let provider_transport = last_probe
        .as_ref()
        .map(|probe| probe.transport_effective.clone())
        .unwrap_or(configured_transport);
    let provider_verdict = last_probe.as_ref().map(|probe| probe.verdict.as_str());
    let provider_checked_at = last_probe
        .as_ref()
        .map(|probe| probe.checked_at.as_str())
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

pub(crate) fn build_diagnostics_snapshot<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> DiagnosticsRuntimeSnapshot {
    let diagnostics = app
        .try_state::<DiagnosticsStateStore>()
        .map(|store| store.snapshot_base())
        .unwrap_or_else(DiagnosticsRuntimeSnapshot::preview);
    let bridge_snapshot = bridge_snapshot_or_default(app);
    let support_matrix = build_support_matrix(app);
    let install_status = if bridge_snapshot.install_phase == "ready" {
        "ready"
    } else {
        "warning"
    }
    .to_string();
    let provider_status = status_from_probe_verdict(
        app.try_state::<crate::provider::state::ProviderStateStore>()
            .and_then(|store| store.last_probe())
            .as_ref()
            .map(|probe| probe.verdict.as_str()),
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

pub(crate) fn append_diagnostics_log<R: tauri::Runtime>(
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

pub(crate) fn append_diagnostics_log_quiet<R: tauri::Runtime>(
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

    let summary = super::redaction::sanitize_text(&summary.into());
    let detail = detail.map(|value| super::redaction::sanitize_text(&value));
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
pub(crate) fn set_diagnostics_log_level(
    diagnostics: State<'_, DiagnosticsStateStore>,
    level: String,
) -> Result<(), String> {
    diagnostics.set_min_log_level(&level);
    Ok(())
}

pub(crate) fn get_diagnostics_snapshot<R: tauri::Runtime>(app: AppHandle<R>) -> DiagnosticsRuntimeSnapshot {
    build_diagnostics_snapshot(&app)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontendDiagnosticsBatchEntry {
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
pub(crate) async fn append_frontend_diagnostics_logs(
    app: AppHandle,
    entries: Vec<FrontendDiagnosticsBatchEntry>,
    dropped_count: Option<u64>,
) -> Result<(), String> {
    let Some(store) = app.try_state::<DiagnosticsStateStore>() else {
        return Ok(());
    };

    for entry in entries {
        let summary = super::redaction::sanitize_text(&entry.summary);
        let detail = entry
            .detail
            .as_deref()
            .map(super::redaction::sanitize_text);
        let _ = store.append_log(
            &entry.category,
            &entry.level,
            summary,
            detail,
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
pub(crate) fn run_diagnostics_self_check<R: tauri::Runtime>(
    app: AppHandle<R>,
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
pub(crate) fn push_overlay_self_check_cue(audio_state: &AudioStateStore) {
    static SELF_CHECK_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SELF_CHECK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let emitted_at = now_unix_millis_marker();
    audio_state.push_subtitle_cue(SubtitleCueRuntime {
        cue_id: format!("overlay-self-check-{emitted_at}-{seq}"),
        route_direction: "diagnostics".to_string(),
        source_text: "Subtitle overlay self-check".to_string(),
        display_source_text: "Subtitle overlay self-check".to_string(),
        display_segments: Vec::new(),
        translated_text: "字幕浮窗自检已通过".to_string(),
        started_at: emitted_at.clone(),
        ended_at: emitted_at,
        committed: true,
        translation_committed: true,
    });
}

/// The log line the overlay self check records after the cue became visible.
pub(crate) fn log_overlay_self_check_cue<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
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
pub(crate) async fn export_diagnostics_bundle<R: tauri::Runtime>(
    app: AppHandle<R>,
    diagnostics: State<'_, DiagnosticsStateStore>,
    requested_scope: String,
) -> Result<DiagnosticsExportArtifact, String> {
    let scope = DiagnosticsExportScope::parse(&requested_scope)?;
    let scope_name = scope.as_str().to_string();
    diagnostics.ensure_directories()?;
    let generated_at = now_unix_seconds_marker();
    let export_id = Uuid::now_v7().simple().to_string();
    let exports_root = PathBuf::from(diagnostics.exports_dir());
    let final_dir = exports_root.join(format!(
        "{}-{}-{}",
        safe_export_component(&generated_at),
        scope.as_str(),
        &export_id[..8]
    ));
    let staging_dir = exports_root.join(format!(".partial-{export_id}"));

    let mut collection_warnings = Vec::new();
    if let Err(error) = append_diagnostics_log(
        &app,
        "runtime",
        "info",
        format!("正在收集 diagnostics 导出包，scope={}。", scope.as_str()),
        None,
        Some(format!("{}:{}", file!(), line!())),
        None,
    ) {
        collection_warnings.push(format!(
            "the diagnostics export start event could not be recorded: {error}"
        ));
    }

    if !diagnostics.flush_logs() {
        collection_warnings.push(
            "diagnostics log writer did not acknowledge the pre-export flush".to_string(),
        );
    }

    let mut diagnostics_snapshot = build_diagnostics_snapshot(&app);
    let final_output_path = final_dir.to_string_lossy().to_string();
    diagnostics_snapshot.last_export_scope = Some(scope_name.clone());
    diagnostics_snapshot.last_export_path = Some(final_output_path.clone());
    diagnostics_snapshot.last_exported_at = Some(generated_at.clone());

    if app.try_state::<AudioStateStore>().is_none() {
        collection_warnings.push(
            "audio runtime state was unavailable; preview values were exported".to_string(),
        );
    }
    let audio_snapshot = audio_snapshot_or_preview(&app);
    if app.try_state::<BridgeStateStore>().is_none() {
        collection_warnings.push(
            "bridge runtime state was unavailable; default values were exported".to_string(),
        );
    }
    let bridge_snapshot = bridge_snapshot_or_default(&app);
    let storage_state = app.try_state::<StorageStateStore>();
    if storage_state.is_none() {
        collection_warnings.push(
            "storage runtime state was unavailable; preview values were exported".to_string(),
        );
    }
    let storage_snapshot = storage_state
        .as_ref()
        .map(|state| state.snapshot())
        .unwrap_or_else(crate::storage::contracts::StorageRuntimeSnapshot::preview);
    let config_value = match storage_state.as_ref() {
        Some(storage) => match storage.load_config() {
            Ok(config) => config,
            Err(error) => {
                collection_warnings.push(format!(
                    "persisted configuration could not be read and was exported as null: {error}"
                ));
                Value::Null
            }
        },
        None => Value::Null,
    };

    let runtime_snapshot = match app.try_state::<RuntimeStateStore>() {
        Some(runtime_state) => {
            let mut snapshot = build_runtime_snapshot(&app, &runtime_state);
            snapshot.diagnostics = diagnostics_snapshot.clone();
            Some(serialize_export_value("runtime snapshot", &snapshot)?)
        }
        None => {
            collection_warnings.push("runtime state was unavailable".to_string());
            None
        }
    };

    let mut extra_json = BTreeMap::new();
    if scope == DiagnosticsExportScope::Full {
        if let Some(report) = app
            .try_state::<AudioStateStore>()
            .and_then(|state| state.watch_session_report.snapshot())
        {
            extra_json.insert(
                "watch-session-report.json".to_string(),
                serialize_export_value("watch session report", &report)?,
            );
        } else {
            collection_warnings.push(
                "no completed watch session report was available for the full export".to_string(),
            );
        }
    }
    if let Some(probe) = app
        .try_state::<crate::provider::state::ProviderStateStore>()
        .and_then(|store| store.last_probe())
    {
        extra_json.insert(
            "provider-probe-summary.json".to_string(),
            json!({
                "checkedAt": probe.checked_at,
                "configuredModel": probe.configured_model,
                "model": probe.model,
                "preflightAuthorization": probe.preflight_authorization,
                "protocol": probe.protocol,
                "providerConnectCompletedAt": probe.provider_connect_completed_at,
                "providerConnectStartedAt": probe.provider_connect_started_at,
                "inputTokens": probe.input_tokens,
                "outputTokens": probe.output_tokens,
                "audioSeconds": probe.audio_seconds,
                "transportEffective": probe.transport_effective,
                "verdict": probe.verdict,
            }),
        );
    } else {
        collection_warnings.push("no provider probe result was available".to_string());
    }

    let logs_dir = PathBuf::from(diagnostics.logs_dir());
    let bridge_runtime_root = PathBuf::from(&bridge_snapshot.runtime_root);
    let input = BundleInput {
        generated_at: &generated_at,
        scope,
        diagnostics: serialize_export_value("diagnostics snapshot", &diagnostics_snapshot)?,
        runtime: runtime_snapshot,
        audio: serialize_export_value("audio snapshot", &audio_snapshot)?,
        bridge: serialize_export_value("bridge snapshot", &bridge_snapshot)?,
        storage: serialize_export_value("storage snapshot", &storage_snapshot)?,
        config: config_value,
        logs_dir: &logs_dir,
        bridge_runtime_root: &bridge_runtime_root,
        extra_json,
        collection_warnings,
    };

    let bundle = match write_diagnostics_bundle(&staging_dir, input) {
        Ok(bundle) => bundle,
        Err(error) => {
            let error = cleanup_failed_staging(&staging_dir, error);
            let _ = append_diagnostics_log(
                &app,
                "runtime",
                "error",
                format!("diagnostics 导出失败，scope={scope_name}。"),
                Some(error.clone()),
                Some(format!("{}:{}", file!(), line!())),
                None,
            );
            return Err(error);
        }
    };

    if let Err(error) = fs::rename(&staging_dir, &final_dir) {
        return Err(cleanup_failed_staging(
            &staging_dir,
            format!("failed to finalize diagnostics export directory: {error}"),
        ));
    }

    diagnostics.mark_export(
        scope_name.clone(),
        final_output_path.clone(),
        generated_at.clone(),
    );
    // Publishing the bundle is the success boundary. A best-effort audit log
    // failure after the atomic rename must not make the UI report that an
    // already available export failed.
    let _ = append_diagnostics_log(
        &app,
        "runtime",
        "info",
        format!(
            "已生成 diagnostics 导出包，scope={} files={} bytes={} redactions={} truncatedLogs={} logBytes={}->{} logLines={} warnings={}。",
            scope_name,
            bundle.file_count,
            bundle.total_bytes,
            bundle.redaction_count,
            bundle.logs_truncated,
            bundle.original_log_bytes,
            bundle.exported_log_bytes,
            bundle.exported_log_lines,
            bundle.warnings.len(),
        ),
        Some(final_output_path.clone()),
        Some(format!("{}:{}", file!(), line!())),
        None,
    );

    Ok(DiagnosticsExportArtifact {
        scope: scope_name,
        output_path: final_output_path,
        generated_at,
        file_count: bundle.file_count,
    })
}

fn cleanup_failed_staging(staging_dir: &std::path::Path, primary_error: String) -> String {
    match fs::remove_dir_all(staging_dir) {
        Ok(()) => primary_error,
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => primary_error,
        Err(cleanup_error) => format!(
            "{primary_error}; additionally failed to remove partial diagnostics export `{}`: {cleanup_error}",
            staging_dir.display()
        ),
    }
}
