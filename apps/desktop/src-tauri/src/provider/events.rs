use tauri::AppHandle;

use crate::diagnostics::events::append_diagnostics_log;

use super::contracts::{
    ProviderDraftInput, ProviderModelCatalogRuntime, ProviderProbeProfileRuntime,
    ProviderSmokeResult,
};
use super::gateway::ProviderGateway;

#[tauri::command]
pub fn fetch_provider_models(
    app: AppHandle,
    provider: ProviderDraftInput,
) -> ProviderModelCatalogRuntime {
    let result = ProviderGateway::new().fetch_models(provider);
    let level = if result.error.is_some() || result.models.is_empty() {
        "warning"
    } else {
        "info"
    };
    let detail = Some(format!(
        "providerId={} endpoint={} models={}",
        result.provider_id,
        result.endpoint,
        result.models.len()
    ));
    let _ = append_diagnostics_log(
        &app,
        "provider",
        level,
        format!("Provider models 拉取完成，count={}", result.models.len()),
        detail,
        None,
        None,
    );
    result
}

#[tauri::command]
pub fn probe_provider(app: AppHandle, provider: ProviderDraftInput) -> ProviderProbeProfileRuntime {
    let result = ProviderGateway::new().probe(provider);
    let level = if result.error.is_some() || result.verdict != "available" {
        "warning"
    } else {
        "info"
    };
    let detail = Some(format!(
        "providerId={} transport={} effective={} latencyMs={}",
        result.provider_id,
        result.transport_requested,
        result.transport_effective,
        result.measured_latency_ms
    ));
    let _ = append_diagnostics_log(
        &app,
        "provider",
        level,
        format!("Provider probe 完成，verdict={}", result.verdict),
        detail,
        None,
        None,
    );
    result
}

#[tauri::command]
pub fn execute_provider_smoke(
    app: AppHandle,
    provider: ProviderDraftInput,
    source_text: Option<String>,
    source_language: Option<String>,
    target_language: Option<String>,
) -> ProviderSmokeResult {
    let result = ProviderGateway::new().execute_smoke(
        provider,
        source_text.unwrap_or_else(|| "请把这句中文翻译成英文，并保留语气自然。".to_string()),
        source_language.unwrap_or_else(|| "zh-CN".to_string()),
        target_language.unwrap_or_else(|| "en-US".to_string()),
    );
    let level = if result.error.is_some() || result.status != "completed" {
        "warning"
    } else {
        "info"
    };
    let detail = Some(format!(
        "providerId={} requested={} effective={} events={} durationMs={}",
        result.provider_id,
        result.transport_requested,
        result.transport_effective,
        result.event_log.len(),
        result.duration_ms
    ));
    let _ = append_diagnostics_log(
        &app,
        "provider",
        level,
        format!("Provider smoke 完成，status={}", result.status),
        detail,
        None,
        None,
    );
    result
}
