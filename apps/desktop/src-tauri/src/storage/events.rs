use std::time::Instant;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::diagnostics::events::append_diagnostics_log_quiet;

use super::contracts::{
    ConfigExportArtifact, ConfigSnapshotRecord, CredentialRefStatus, CredentialSecretPayload,
    StorageRuntimeSnapshot,
};
use super::credential::{CredentialVault, KeyringCredentialVault};
use super::service::ConfigurationService;
use super::StorageStateStore;

fn log_storage_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    level: &str,
    summary: impl Into<String>,
    detail: Option<String>,
) {
    let _ = append_diagnostics_log_quiet(app, "storage", level, summary, detail, None, None);
}

/// Emit the standard info/error diagnostics for a config-draft operation that
/// returns a provider config, then propagate the result unchanged. Shared by
/// the load and reset commands, whose success/failure logging is identical
/// apart from the summary wording.
fn finish_config_draft<R: tauri::Runtime>(
    app: &AppHandle<R>,
    result: Result<Value, String>,
    success_summary: &str,
    failure_summary: &str,
) -> Result<Value, String> {
    match result {
        Ok(config) => {
            log_storage_event(app, "info", success_summary, Some(summarize_provider_config(&config)));
            Ok(config)
        }
        Err(error) => {
            log_storage_event(app, "error", failure_summary, Some(error.clone()));
            Err(error)
        }
    }
}

fn summarize_provider_config(config: &Value) -> String {
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .map(|arr| arr.len())
        .unwrap_or(0);
    let provider_kind = config
        .pointer("/providers/0/kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let provider_model = config
        .pointer("/providers/0/model")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let provider_transport = config
        .pointer("/providers/0/transport")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let onboarding_preset = config
        .pointer("/onboarding/activePresetId")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    format!(
        "providers.count={} providers[0].kind={} providers[0].model={} providers[0].transport={} onboarding.activePresetId={}",
        providers, provider_kind, provider_model, provider_transport, onboarding_preset
    )
}

#[tauri::command(async)]
pub(crate) fn bootstrap_storage<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
) -> Result<StorageRuntimeSnapshot, String> {
    let snapshot = storage.ensure_initialized(&app)?;
    log_storage_event(
        &app,
        "info",
        "Storage 层已初始化。",
        Some(format!(
            "db={} exports={}",
            snapshot.database_path,
            snapshot
                .last_export_path
                .clone()
                .unwrap_or_else(|| "none".to_string())
        )),
    );
    Ok(snapshot)
}

#[tauri::command(async)]
pub(crate) fn load_config_draft<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
) -> Result<Value, String> {
    storage.ensure_initialized(&app)?;
    finish_config_draft(
        &app,
        ConfigurationService::new(&storage).load(),
        "已加载配置草稿。",
        "加载配置草稿失败。",
    )
}

pub(crate) fn save_config_draft<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
    config: Value,
) -> Result<StorageRuntimeSnapshot, String> {
    storage.ensure_initialized(&app)?;
    let summary = summarize_provider_config(&config);
    match ConfigurationService::new(&storage).save(&config) {
        Ok(snapshot) => {
            log_storage_event(
                &app,
                "info",
                "已保存配置草稿。",
                Some(format!(
                    "{} db={} schemaVersion={}",
                    summary, snapshot.database_path, snapshot.schema_version
                )),
            );
            Ok(snapshot)
        }
        Err(error) => {
            log_storage_event(
                &app,
                "error",
                "保存配置草稿失败。",
                Some(format!("{} error={}", summary, error.clone())),
            );
            Err(error)
        }
    }
}

pub(crate) fn reset_config_draft<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
) -> Result<Value, String> {
    storage.ensure_initialized(&app)?;
    finish_config_draft(
        &app,
        ConfigurationService::new(&storage).reset(),
        "已重置配置草稿。",
        "重置配置草稿失败。",
    )
}

pub(crate) fn export_config_draft<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
) -> Result<ConfigExportArtifact, String> {
    storage.ensure_initialized(&app)?;
    match ConfigurationService::new(&storage).export() {
        Ok(artifact) => {
            log_storage_event(
                &app,
                "info",
                "已导出配置草稿。",
                Some(format!(
                    "file={} savedAt={} snapshots={}",
                    artifact.file_path, artifact.exported_at, artifact.snapshot_count
                )),
            );
            Ok(artifact)
        }
        Err(error) => {
            log_storage_event(&app, "error", "导出配置草稿失败。", Some(error.clone()));
            Err(error)
        }
    }
}

pub(crate) fn import_config_draft<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
    file_path: String,
) -> Result<Value, String> {
    storage.ensure_initialized(&app)?;
    match ConfigurationService::new(&storage).import(std::path::Path::new(&file_path)) {
        Ok(config) => {
            log_storage_event(
                &app,
                "info",
                "已导入配置草稿。",
                Some(format!(
                    "file={} {}",
                    file_path,
                    summarize_provider_config(&config)
                )),
            );
            Ok(config)
        }
        Err(error) => {
            log_storage_event(
                &app,
                "error",
                "导入配置草稿失败。",
                Some(format!("file={} error={}", file_path, error.clone())),
            );
            Err(error)
        }
    }
}

pub(crate) fn create_config_snapshot<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
    reason: Option<String>,
) -> Result<ConfigSnapshotRecord, String> {
    storage.ensure_initialized(&app)?;
    let snapshot_reason = reason.as_deref().unwrap_or("manual-snapshot");
    match ConfigurationService::new(&storage).snapshot(snapshot_reason) {
        Ok(snapshot) => {
            log_storage_event(
                &app,
                "info",
                "已创建配置快照。",
                Some(format!(
                    "snapshotId={} reason={}",
                    snapshot.snapshot_id, snapshot_reason
                )),
            );
            Ok(snapshot)
        }
        Err(error) => {
            log_storage_event(
                &app,
                "error",
                "创建配置快照失败。",
                Some(format!(
                    "reason={} error={}",
                    snapshot_reason,
                    error.clone()
                )),
            );
            Err(error)
        }
    }
}

pub(crate) fn rollback_config_snapshot<R: tauri::Runtime>(
    app: AppHandle<R>,
    storage: State<'_, StorageStateStore>,
    snapshot_id: String,
) -> Result<Value, String> {
    storage.ensure_initialized(&app)?;
    match ConfigurationService::new(&storage).rollback(&snapshot_id) {
        Ok(config) => {
            log_storage_event(
                &app,
                "info",
                "已回滚配置快照。",
                Some(format!(
                    "snapshotId={} {}",
                    snapshot_id,
                    summarize_provider_config(&config)
                )),
            );
            Ok(config)
        }
        Err(error) => {
            log_storage_event(
                &app,
                "error",
                "回滚配置快照失败。",
                Some(format!(
                    "snapshotId={} error={}",
                    snapshot_id,
                    error.clone()
                )),
            );
            Err(error)
        }
    }
}

pub(crate) async fn upsert_secret_ref<R: tauri::Runtime>(
    app: AppHandle<R>,
    reference: String,
    secret: String,
) -> Result<CredentialRefStatus, String> {
    let command_started_at = Instant::now();
    let secret_length = secret.len();
    log_storage_event(
        &app,
        "info",
        "收到 API Key 保存命令。",
        Some(format!(
            "reference={} secretLength={}",
            reference, secret_length
        )),
    );
    let started_at = Instant::now();
    log_storage_event(
        &app,
        "info",
        "开始写入 API Key。",
        Some(format!(
            "reference={} secretLength={}",
            reference, secret_length
        )),
    );
    let reference_for_task = reference.clone();
    let secret_for_task = secret.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let vault = KeyringCredentialVault::new();
        vault.upsert_secret(&reference_for_task, &secret_for_task)?;

        Ok::<CredentialRefStatus, String>(CredentialRefStatus {
            reference: reference_for_task,
            backend: "windows-credential-manager".to_string(),
            has_secret: true,
        })
    })
    .await;

    match result {
        Ok(Ok(status)) => {
            log_storage_event(
        &app,
        "info",
        "已写入 API Key。",
        Some(format!(
          "reference={} backend={} hasSecret={} vaultElapsedMs={} totalElapsedMs={} secretLength={}",
          status.reference,
          status.backend,
          status.has_secret,
          started_at.elapsed().as_millis(),
          command_started_at.elapsed().as_millis(),
          secret_length
        )),
      );
            Ok(status)
        }
        Ok(Err(error)) => {
            log_storage_event(
                &app,
                "error",
                "写入 API Key 失败。",
                Some(format!(
                    "reference={} vaultElapsedMs={} totalElapsedMs={} secretLength={} error={}",
                    reference,
                    started_at.elapsed().as_millis(),
                    command_started_at.elapsed().as_millis(),
                    secret_length,
                    error.clone()
                )),
            );
            Err(error)
        }
        Err(join_error) => {
            let error = join_error.to_string();
            log_storage_event(
                &app,
                "error",
                "写入 API Key 任务异常结束。",
                Some(format!(
                    "reference={} vaultElapsedMs={} totalElapsedMs={} secretLength={} error={}",
                    reference,
                    started_at.elapsed().as_millis(),
                    command_started_at.elapsed().as_millis(),
                    secret_length,
                    error.clone()
                )),
            );
            Err(error)
        }
    }
}

pub(crate) async fn get_secret_ref_status<R: tauri::Runtime>(
    app: AppHandle<R>,
    reference: String,
) -> Result<CredentialRefStatus, String> {
    let command_started_at = Instant::now();
    log_storage_event(
        &app,
        "info",
        "收到 API Key 状态读取命令。",
        Some(format!("reference={}", reference)),
    );
    let started_at = Instant::now();
    log_storage_event(
        &app,
        "info",
        "开始读取 API Key 状态。",
        Some(format!("reference={}", reference)),
    );
    let reference_for_task = reference.clone();
    let result: Result<CredentialRefStatus, String> =
        tauri::async_runtime::spawn_blocking(move || {
            let vault = KeyringCredentialVault::new();

            Ok(CredentialRefStatus {
                reference: reference_for_task.clone(),
                backend: "windows-credential-manager".to_string(),
                has_secret: vault.has_secret(&reference_for_task)?,
            })
        })
        .await
        .map_err(|error| error.to_string())?;

    match result {
        Ok(status) => {
            log_storage_event(
                &app,
                "info",
                "已读取 API Key 状态。",
                Some(format!(
                    "reference={} backend={} hasSecret={} vaultElapsedMs={} totalElapsedMs={}",
                    status.reference,
                    status.backend,
                    status.has_secret,
                    started_at.elapsed().as_millis(),
                    command_started_at.elapsed().as_millis()
                )),
            );
            Ok(status)
        }
        Err(error) => {
            log_storage_event(
                &app,
                "error",
                "读取 API Key 状态失败。",
                Some(format!(
                    "reference={} vaultElapsedMs={} totalElapsedMs={} error={}",
                    reference,
                    started_at.elapsed().as_millis(),
                    command_started_at.elapsed().as_millis(),
                    error.clone()
                )),
            );
            Err(error)
        }
    }
}

pub(crate) async fn read_secret_ref<R: tauri::Runtime>(
    app: AppHandle<R>,
    reference: String,
) -> Result<CredentialSecretPayload, String> {
    let command_started_at = Instant::now();
    log_storage_event(
        &app,
        "info",
        "收到 API Key 明文读取命令。",
        Some(format!("reference={}", reference)),
    );
    let started_at = Instant::now();
    log_storage_event(
        &app,
        "info",
        "开始读取 API Key 明文。",
        Some(format!("reference={}", reference)),
    );
    let reference_for_task = reference.clone();
    let result: Result<CredentialSecretPayload, String> =
        tauri::async_runtime::spawn_blocking(move || {
            let vault = KeyringCredentialVault::new();

            Ok(CredentialSecretPayload {
                reference: reference_for_task.clone(),
                backend: "windows-credential-manager".to_string(),
                secret: vault.read_secret(&reference_for_task)?,
            })
        })
        .await
        .map_err(|error| error.to_string())?;

    match result {
        Ok(payload) => {
            log_storage_event(
                &app,
                "info",
                "已读取 API Key 明文。",
                Some(format!(
                    "reference={} backend={} hasSecret={} vaultElapsedMs={} totalElapsedMs={}",
                    payload.reference,
                    payload.backend,
                    payload
                        .secret
                        .as_ref()
                        .map(|value| !value.is_empty())
                        .unwrap_or(false),
                    started_at.elapsed().as_millis(),
                    command_started_at.elapsed().as_millis()
                )),
            );
            Ok(payload)
        }
        Err(error) => {
            log_storage_event(
                &app,
                "error",
                "读取 API Key 明文失败。",
                Some(format!(
                    "reference={} vaultElapsedMs={} totalElapsedMs={} error={}",
                    reference,
                    started_at.elapsed().as_millis(),
                    command_started_at.elapsed().as_millis(),
                    error.clone()
                )),
            );
            Err(error)
        }
    }
}
