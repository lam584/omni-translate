use tauri::{AppHandle, Manager};

use crate::diagnostics::events::append_diagnostics_log;

use super::contracts::{
    ProviderDraftInput, ProviderModelCatalogRuntime, ProviderProbeProfileRuntime,
    ProviderSmokeResult,
};
use super::gateway::ProviderGateway;

// `async fn`: the gateway performs blocking network IO. Keep it off the main
// thread so a slow/hung provider endpoint never freezes the message pump
// (IPC + tray). Same main-thread-starvation hazard as export.
pub(crate) async fn fetch_provider_models(
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

// `async fn`: blocking network probe, kept off the main thread.
pub(crate) async fn probe_provider(app: AppHandle, provider: ProviderDraftInput) -> ProviderProbeProfileRuntime {
    record_provider_probe(app, ProviderGateway::new().probe(provider))
}

pub(crate) async fn probe_provider_strict_livetranslate(
    app: AppHandle,
    provider: ProviderDraftInput,
) -> ProviderProbeProfileRuntime {
    record_provider_probe(
        app,
        ProviderGateway::new().probe_strict_livetranslate(provider),
    )
}

fn record_provider_probe(
    app: AppHandle,
    result: ProviderProbeProfileRuntime,
) -> ProviderProbeProfileRuntime {
    if let Some(store) = app.try_state::<crate::provider::state::ProviderStateStore>() {
        store.record_probe(crate::provider::state::ProviderProbeSummary {
            verdict: result.verdict.clone(),
            checked_at: result.checked_at.clone(),
            transport_effective: result.transport_effective.clone(),
            configured_model: None,
            model: None,
            protocol: None,
            preflight_authorization: None,
            provider_connect_started_at: None,
            provider_connect_completed_at: None,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            audio_seconds: result.audio_seconds,
        });
    }
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

// `async fn`: blocking network smoke test, kept off the main thread.
pub(crate) async fn execute_provider_smoke(
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
