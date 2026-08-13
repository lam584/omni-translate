//! Same-process production authority for release-manual evidence.
//!
//! Tauri has no cross-process `tauri invoke` transport. The release runner
//! therefore launches one controlled Desktop process with the environment
//! below, waits for that process's real renderer to complete `debug_ipc_ping`,
//! and executes the existing production handlers on the same `AppHandle` and
//! managed state. The module never accepts caller-authored result JSON.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

mod artifacts;
mod provider_preflight_authority;
mod provider_selection;

use artifacts::{
    copy_directory, env_value, hash_artifact, hash_file, now, read_json, walk_files, write_json,
    ArtifactHash,
};
use provider_preflight_authority::{
    current_desktop_executable_path, ProviderPreflightAuthorization,
    PROVIDER_ID as AUTHORIZED_PROVIDER_ID,
};
use provider_selection::{select_provider, select_provider_by_id};

use crate::diagnostics::events::{append_diagnostics_log, export_diagnostics_bundle};
use crate::diagnostics::state::DiagnosticsStateStore;
use crate::provider::events::probe_provider;
use crate::storage::events::{
    get_secret_ref_status, load_config_draft, save_config_draft,
};
use crate::storage::StorageStateStore;

const SCENARIO_ENV: &str = "OMNI_RELEASE_EVIDENCE_SCENARIO";
const OUTPUT_ENV: &str = "OMNI_RELEASE_EVIDENCE_OUTPUT_DIRECTORY";
const PROVIDER_ID_ENV: &str = "OMNI_RELEASE_EVIDENCE_PROVIDER_ID";
const SOURCE_HEAD_ENV: &str = "OMNI_RELEASE_EVIDENCE_HEAD_COMMIT";
const IPC_READY_TIMEOUT: Duration = Duration::from_secs(45);
const IPC_READY_POLL: Duration = Duration::from_millis(50);
const EMITTER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EvidenceScenario {
    ProviderConfig,
    ProviderProbe,
    DiagnosticsExport,
}

impl EvidenceScenario {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "E2E-PROVIDER-CONFIG" => Ok(Self::ProviderConfig),
            "E2E-PROVIDER-PROBE" => Ok(Self::ProviderProbe),
            "E2E-DIAGNOSTICS-EXPORT" => Ok(Self::DiagnosticsExport),
            other => Err(format!(
                "unsupported {SCENARIO_ENV} '{other}'; expected E2E-PROVIDER-CONFIG, E2E-PROVIDER-PROBE, or E2E-DIAGNOSTICS-EXPORT"
            )),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::ProviderConfig => "E2E-PROVIDER-CONFIG",
            Self::ProviderProbe => "E2E-PROVIDER-PROBE",
            Self::DiagnosticsExport => "E2E-DIAGNOSTICS-EXPORT",
        }
    }

    fn collector_id(self) -> &'static str {
        match self {
            Self::ProviderConfig => "omni-desktop-provider-config-release-evidence",
            Self::ProviderProbe => "omni-desktop-provider-probe-release-evidence",
            Self::DiagnosticsExport => "omni-desktop-diagnostics-export-release-evidence",
        }
    }

    fn artifact_paths(self) -> &'static [&'static str] {
        match self {
            Self::ProviderConfig => &["provider-config-snapshot.json", "diagnostics-bundle"],
            Self::ProviderProbe => &["provider-probe-result.json", "diagnostics-bundle"],
            Self::DiagnosticsExport => {
                &["diagnostics-export-receipt.json", "diagnostics-bundle"]
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsAuthority {
    scope: String,
    canonical_output_path: String,
    generated_at: String,
    file_count: usize,
    canonical_bundle_sha256: String,
    packaged_bundle_sha256: String,
    bundle_manifest_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmitterResult {
    schema_version: u32,
    artifact_kind: &'static str,
    collector_id: &'static str,
    collector_version: &'static str,
    scenario_id: &'static str,
    invocation_id: String,
    status: &'static str,
    started_at: String,
    completed_at: String,
    desktop_process_id: u32,
    desktop_executable: String,
    desktop_executable_sha256: String,
    source_head_commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    preflight_authorization: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_connect_started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_connect_completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_seconds: Option<f64>,
    diagnostics_export: Option<DiagnosticsAuthority>,
    timeline: Vec<Value>,
    artifacts: Vec<ArtifactHash>,
    error: Option<String>,
}

fn compiled_build_commit() -> Option<&'static str> {
    option_env!("OMNI_BUILD_COMMIT")
        .or(option_env!("GIT_COMMIT_HASH"))
        .or(option_env!("VERGEN_GIT_SHA"))
}

fn verified_source_head_commit() -> Result<String, String> {
    let requested = env_value(SOURCE_HEAD_ENV)
        .ok_or_else(|| format!("{SOURCE_HEAD_ENV} is required"))?
        .to_ascii_lowercase();
    if requested.len() != 40 || !requested.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(format!("{SOURCE_HEAD_ENV} must be a 40-character Git commit"));
    }
    let compiled = compiled_build_commit()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "release evidence Desktop binary has no compile-time build commit; rebuild with npm run build:desktop-shell"
                .to_string()
        })?
        .to_ascii_lowercase();
    if compiled != requested {
        return Err(format!(
            "release evidence Desktop binary commit {compiled} does not match current clean HEAD {requested}; rebuild it"
        ));
    }
    Ok(requested)
}

pub(crate) fn enabled() -> bool {
    env_value(SCENARIO_ENV).is_some()
}

pub(crate) fn schedule_after_ipc(app: &tauri::App, ipc_ping_received: &'static AtomicBool) {
    if !enabled() {
        return;
    }
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let wait_started = Instant::now();
        while !ipc_ping_received.load(Ordering::Acquire)
            && wait_started.elapsed() < IPC_READY_TIMEOUT
        {
            tokio::time::sleep(IPC_READY_POLL).await;
        }
        if !ipc_ping_received.load(Ordering::Acquire) {
            publish_startup_failure(
                "release evidence renderer IPC did not become ready within 45 seconds",
            );
            app_handle.exit(2);
            return;
        }

        let exit_code = match run(&app_handle).await {
            Ok(()) => 0,
            Err(error) => {
                let _ = append_diagnostics_log(
                    &app_handle,
                    "runtime",
                    "error",
                    "release_evidence.production_emitter_failed",
                    Some(error.clone()),
                    Some(format!("{}:{}", file!(), line!())),
                    None,
                );
                publish_startup_failure(&error);
                2
            }
        };
        app_handle.exit(exit_code);
    });
}

async fn run(app: &AppHandle) -> Result<(), String> {
    if crate::watch_mode_diagnostic::autostart_enabled() {
        return Err(
            "release evidence diagnostic cannot run with OMNI_WATCH_MODE_AUTOSTART".to_string(),
        );
    }
    let scenario = EvidenceScenario::parse(
        &env_value(SCENARIO_ENV).ok_or_else(|| format!("{SCENARIO_ENV} is required"))?,
    )?;
    let source_head_commit = verified_source_head_commit()?;
    let output = PathBuf::from(
        env_value(OUTPUT_ENV).ok_or_else(|| format!("{OUTPUT_ENV} is required"))?,
    );
    if !output.is_absolute() {
        return Err(format!("{OUTPUT_ENV} must be an absolute path"));
    }
    if output.exists() {
        return Err(format!(
            "release evidence output must not already exist: {}",
            output.display()
        ));
    }
    let parent = output
        .parent()
        .ok_or_else(|| "release evidence output has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = parent.join(format!(
        ".{}-partial-{}",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("release-evidence"),
        Uuid::now_v7().simple()
    ));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;

    let invocation_id = Uuid::now_v7().to_string();
    let started_at = now();
    let executable = current_desktop_executable_path()?;
    let executable_sha256 = hash_file(&executable)?;
    let mut timeline = Vec::new();
    push_timeline(
        &mut timeline,
        "invocation-started",
        &invocation_id,
        Some(json!({ "scenarioId": scenario.id() })),
    );
    log_authority_event(app, scenario, &invocation_id, "invocation-started", None);

    let execution = match scenario {
        EvidenceScenario::ProviderConfig => collect_provider_config(
            app,
            &staging,
            &invocation_id,
            &source_head_commit,
            &mut timeline,
        )
        .await,
        EvidenceScenario::ProviderProbe => collect_provider_probe(
            app,
            &staging,
            &invocation_id,
            &source_head_commit,
            &mut timeline,
        )
        .await,
        EvidenceScenario::DiagnosticsExport => collect_diagnostics_export(
            app,
            &staging,
            &invocation_id,
            &source_head_commit,
            &mut timeline,
        )
        .await,
    };

    let diagnostics = match execution {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    push_timeline(
        &mut timeline,
        "invocation-completed",
        &invocation_id,
        None,
    );

    let artifacts = scenario
        .artifact_paths()
        .iter()
        .map(|relative| hash_artifact(&staging.join(relative), relative))
        .collect::<Result<Vec<_>, _>>()?;
    let provider_result = if scenario == EvidenceScenario::ProviderProbe {
        Some(read_json::<Value>(&staging.join("provider-probe-result.json"))?)
    } else {
        None
    };
    let result = EmitterResult {
        schema_version: 1,
        artifact_kind: "desktop-release-evidence-emitter-result",
        collector_id: scenario.collector_id(),
        collector_version: EMITTER_VERSION,
        scenario_id: scenario.id(),
        invocation_id,
        status: "completed",
        started_at,
        completed_at: now(),
        desktop_process_id: std::process::id(),
        desktop_executable: executable.to_string_lossy().to_string(),
        desktop_executable_sha256: executable_sha256,
        source_head_commit,
        preflight_authorization: provider_result
            .as_ref()
            .and_then(|value| value.get("preflightAuthorization"))
            .filter(|value| !value.is_null())
            .cloned(),
        provider_connect_started_at: provider_result
            .as_ref()
            .and_then(|value| value.get("providerConnectStartedAt"))
            .and_then(Value::as_str)
            .map(str::to_string),
        provider_connect_completed_at: provider_result
            .as_ref()
            .and_then(|value| value.get("providerConnectCompletedAt"))
            .and_then(Value::as_str)
            .map(str::to_string),
        input_tokens: provider_result
            .as_ref()
            .and_then(|value| value.get("inputTokens"))
            .and_then(Value::as_u64),
        output_tokens: provider_result
            .as_ref()
            .and_then(|value| value.get("outputTokens"))
            .and_then(Value::as_u64),
        audio_seconds: provider_result
            .as_ref()
            .and_then(|value| value.get("audioSeconds"))
            .and_then(Value::as_f64),
        diagnostics_export: Some(diagnostics),
        timeline,
        artifacts,
        error: None,
    };
    write_json(&staging.join("emitter-result.json"), &result)?;
    fs::rename(&staging, &output).map_err(|error| {
        format!(
            "failed to atomically publish release evidence {}: {error}",
            output.display()
        )
    })?;
    Ok(())
}

async fn collect_provider_config(
    app: &AppHandle,
    staging: &Path,
    invocation_id: &str,
    source_head_commit: &str,
    timeline: &mut Vec<Value>,
) -> Result<DiagnosticsAuthority, String> {
    log_authority_event(
        app,
        EvidenceScenario::ProviderConfig,
        invocation_id,
        "production-handler-invoked",
        Some("storage_events::load_config_draft"),
    );
    let before = load_config_draft(app.clone(), app.state::<StorageStateStore>())?;
    let (provider_before, provider) =
        select_provider(&before, env_value(PROVIDER_ID_ENV).as_deref())?;
    push_timeline(
        timeline,
        "configuration-loaded",
        invocation_id,
        Some(json!({ "providerId": provider.provider_id })),
    );

    save_config_draft(
        app.clone(),
        app.state::<StorageStateStore>(),
        before.clone(),
    )?;
    let after = load_config_draft(app.clone(), app.state::<StorageStateStore>())?;
    let (provider_after, _) = select_provider_by_id(&after, &provider.provider_id)?;
    if provider_before != provider_after {
        return Err("production configuration save/load changed the selected provider".to_string());
    }
    push_timeline(
        timeline,
        "configuration-saved-and-reloaded",
        invocation_id,
        None,
    );

    let checked_at = now();
    let credential = get_secret_ref_status(app.clone(), provider.auth_ref.reference.clone()).await?;
    if credential.backend != "windows-credential-manager" || !credential.has_secret {
        return Err(format!(
            "provider credential reference is unavailable in Windows Credential Manager: {}",
            credential.reference
        ));
    }
    push_timeline(
        timeline,
        "credential-status-read",
        invocation_id,
        Some(json!({ "reference": credential.reference, "hasSecret": credential.has_secret })),
    );

    let diagnostics = capture_full_diagnostics(
        app,
        staging,
        EvidenceScenario::ProviderConfig,
        invocation_id,
        source_head_commit,
        timeline,
    )
    .await?;
    let snapshot = json!({
        "schemaVersion": 1,
        "artifactKind": "provider-config-production-snapshot",
        "collectorId": EvidenceScenario::ProviderConfig.collector_id(),
        "collectorVersion": EMITTER_VERSION,
        "invocationId": invocation_id,
        "source": "desktop-api-v2",
        "productionMode": true,
        "capturedAt": now(),
        "desktopProcessId": std::process::id(),
        "sourceHeadCommit": source_head_commit,
        "provider": {
            "templateId": provider.template_id,
            "providerId": provider.provider_id,
            "kind": provider.kind,
            "model": provider.model,
            "baseUrl": provider.base_url,
            "transport": provider.transport,
            "configPersisted": true,
            "authRef": {
                "kind": provider.auth_ref.kind,
                "reference": provider.auth_ref.reference,
                "headerName": provider.auth_ref.header_name,
                "scheme": provider.auth_ref.scheme,
            },
            "secretValuePresent": false,
        },
        "credentialStatus": {
            "backend": credential.backend,
            "exists": credential.has_secret,
            "reference": credential.reference,
            "checkedAt": checked_at,
        },
        "diagnosticsExport": diagnostics,
    });
    write_json(&staging.join("provider-config-snapshot.json"), &snapshot)?;
    Ok(diagnostics)
}

async fn collect_provider_probe(
    app: &AppHandle,
    staging: &Path,
    invocation_id: &str,
    source_head_commit: &str,
    timeline: &mut Vec<Value>,
) -> Result<DiagnosticsAuthority, String> {
    let config = load_config_draft(app.clone(), app.state::<StorageStateStore>())?;
    let mut authorization = ProviderPreflightAuthorization::load_required(source_head_commit)?;
    let (_, mut provider) = select_provider_by_id(&config, AUTHORIZED_PROVIDER_ID)?;
    let configured_model = authorization.apply_to_provider(&mut provider)?;
    let protocol = crate::audio::events::resolve_realtime_profile(&provider, &provider.model)
        .protocol_dialect
        .map(|value| value.as_str().to_string())
        .ok_or_else(|| "provider preflight did not resolve a realtime protocol".to_string())?;
    let credential = get_secret_ref_status(app.clone(), provider.auth_ref.reference.clone()).await?;
    if credential.backend != "windows-credential-manager" || !credential.has_secret {
        return Err(format!(
            "provider credential reference is unavailable in Windows Credential Manager: {}",
            credential.reference
        ));
    }
    authorization.claim_before_connect()?;
    push_timeline(
        timeline,
        "provider-loaded-and-credential-checked",
        invocation_id,
        Some(json!({ "providerId": provider.provider_id })),
    );
    log_authority_event(
        app,
        EvidenceScenario::ProviderProbe,
        invocation_id,
        "production-handler-invoked",
        Some("provider_events::probe_provider"),
    );
    let provider_connect_started_at = now();
    let probe = probe_provider(app.clone(), provider.clone()).await;
    let provider_connect_completed_at = now();
    let probe_checked_at = provider_connect_completed_at.clone();
    if probe.verdict != "available" {
        return Err(format!(
            "production provider probe did not report available: verdict={} error={}",
            probe.verdict,
            probe
                .error
                .as_ref()
                .map(|error| error.message.as_str())
                .unwrap_or("none")
        ));
    }
    push_timeline(
        timeline,
        "provider-probe-completed",
        invocation_id,
        Some(json!({
            "verdict": probe.verdict,
            "latencyMs": probe.measured_latency_ms,
        })),
    );

    let endpoint_host = url::Url::parse(&provider.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .ok_or_else(|| "provider baseUrl has no valid endpoint host".to_string())?;
    let preflight_authorization = Some(authorization.authority.clone());
    if probe.provider_id != provider.provider_id {
        return Err("authorized provider probe returned a different provider identity".to_string());
    }
    let input_tokens = probe
        .input_tokens
        .ok_or_else(|| "authorized provider probe omitted input token usage".to_string())?;
    let output_tokens = probe
        .output_tokens
        .ok_or_else(|| "authorized provider probe omitted output token usage".to_string())?;
    if input_tokens > 4_096
        || output_tokens > provider.max_output_tokens
        || probe.audio_seconds.is_some_and(|seconds| seconds != 0.0)
    {
        return Err("authorized provider probe exceeded its signed text-only token/audio budget".to_string());
    }
    if let Some(store) = app.try_state::<crate::provider::state::ProviderStateStore>() {
        store.record_probe(crate::provider::state::ProviderProbeSummary {
            verdict: probe.verdict.clone(),
            checked_at: probe_checked_at.clone(),
            transport_effective: probe.transport_effective.clone(),
            configured_model: Some(configured_model.clone()),
            model: Some(provider.model.clone()),
            protocol: Some(protocol.clone()),
            preflight_authorization: preflight_authorization.clone(),
            provider_connect_started_at: Some(provider_connect_started_at.clone()),
            provider_connect_completed_at: Some(provider_connect_completed_at.clone()),
            input_tokens: Some(input_tokens),
            output_tokens: Some(output_tokens),
            audio_seconds: probe.audio_seconds,
        });
    }
    let diagnostics = capture_full_diagnostics(
        app,
        staging,
        EvidenceScenario::ProviderProbe,
        invocation_id,
        source_head_commit,
        timeline,
    )
    .await?;
    let mut raw_probe_result = serde_json::to_value(&probe).map_err(|error| error.to_string())?;
    if let Some(object) = raw_probe_result.as_object_mut() {
        object.insert("configuredModel".to_string(), json!(configured_model));
        object.insert("checkedAt".to_string(), json!(probe_checked_at));
        object.insert("model".to_string(), json!(provider.model));
        object.insert("protocol".to_string(), json!(protocol));
        object.insert(
            "preflightAuthorization".to_string(),
            preflight_authorization.clone().unwrap_or(Value::Null),
        );
        object.insert(
            "providerConnectStartedAt".to_string(),
            json!(provider_connect_started_at),
        );
        object.insert(
            "providerConnectCompletedAt".to_string(),
            json!(provider_connect_completed_at),
        );
    }
    let result = json!({
        "schemaVersion": 1,
        "artifactKind": "provider-production-probe-result",
        "collectorId": EvidenceScenario::ProviderProbe.collector_id(),
        "collectorVersion": EMITTER_VERSION,
        "invocationId": invocation_id,
        "source": "desktop-api-v2",
        "productionMode": true,
        "operation": "text-translation-preflight",
        "inputMode": "text-only",
        "externalAudioSamples": 0,
        "providerInvocationCount": 1,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "audioSeconds": probe.audio_seconds,
        "checkedAt": probe_checked_at,
        "desktopProcessId": std::process::id(),
        "sourceHeadCommit": source_head_commit,
        "templateId": provider.template_id,
        "providerId": provider.provider_id,
        "configuredModel": configured_model,
        "model": provider.model,
        "protocol": protocol,
        "preflightAuthorization": preflight_authorization,
        "providerConnectStartedAt": provider_connect_started_at,
        "providerConnectCompletedAt": provider_connect_completed_at,
        "transportRequested": probe.transport_requested,
        "effectiveTransport": probe.transport_effective,
        "endpointHost": endpoint_host,
        "verdict": probe.verdict,
        "latencyMs": probe.measured_latency_ms,
        "latencyBudgetMs": probe.latency_budget_ms,
        "streamObserved": probe.stream_supported,
        "responseShapeStable": probe.response_shape_stable,
        "errorShapeStable": probe.error_shape_stable,
        "credentialStatus": {
            "backend": credential.backend,
            "exists": credential.has_secret,
            "reference": credential.reference,
        },
        "rawProbeResult": raw_probe_result,
        "diagnosticsExport": diagnostics,
    });
    write_json(&staging.join("provider-probe-result.json"), &result)?;
    Ok(diagnostics)
}

async fn collect_diagnostics_export(
    app: &AppHandle,
    staging: &Path,
    invocation_id: &str,
    source_head_commit: &str,
    timeline: &mut Vec<Value>,
) -> Result<DiagnosticsAuthority, String> {
    let diagnostics = capture_full_diagnostics(
        app,
        staging,
        EvidenceScenario::DiagnosticsExport,
        invocation_id,
        source_head_commit,
        timeline,
    )
    .await?;
    let receipt = json!({
        "schemaVersion": 1,
        "artifactKind": "diagnostics-full-export-production-receipt",
        "collectorId": EvidenceScenario::DiagnosticsExport.collector_id(),
        "collectorVersion": EMITTER_VERSION,
        "invocationId": invocation_id,
        "capturedAt": now(),
        "desktopProcessId": std::process::id(),
        "sourceHeadCommit": source_head_commit,
        "productionHandler": "diagnostics_events::export_diagnostics_bundle",
        "diagnosticsExport": diagnostics,
    });
    write_json(&staging.join("diagnostics-export-receipt.json"), &receipt)?;
    Ok(diagnostics)
}

async fn capture_full_diagnostics(
    app: &AppHandle,
    staging: &Path,
    scenario: EvidenceScenario,
    invocation_id: &str,
    source_head_commit: &str,
    timeline: &mut Vec<Value>,
) -> Result<DiagnosticsAuthority, String> {
    log_authority_event(
        app,
        scenario,
        invocation_id,
        "production-handler-invoked",
        Some("diagnostics_events::export_diagnostics_bundle"),
    );
    push_timeline(
        timeline,
        "diagnostics-export-requested",
        invocation_id,
        None,
    );
    let artifact = export_diagnostics_bundle(
        app.clone(),
        app.state::<DiagnosticsStateStore>(),
        "full".to_string(),
    )
    .await?;
    if artifact.scope != "full" {
        return Err("production diagnostics export did not return full scope".to_string());
    }
    let canonical = fs::canonicalize(&artifact.output_path).map_err(|error| {
        format!(
            "production diagnostics export path is unavailable {}: {error}",
            artifact.output_path
        )
    })?;
    let exports_root = fs::canonicalize(app.state::<DiagnosticsStateStore>().exports_dir())
        .map_err(|error| format!("diagnostics exports root is unavailable: {error}"))?;
    if !canonical.starts_with(&exports_root) || canonical == exports_root {
        return Err(format!(
            "production diagnostics export escaped the canonical exports root: {}",
            canonical.display()
        ));
    }
    validate_bundle_identity(
        &canonical,
        std::process::id(),
        invocation_id,
        source_head_commit,
    )?;
    let packaged = staging.join("diagnostics-bundle");
    copy_directory(&canonical, &packaged)?;
    let canonical_hash = hash_artifact(&canonical, "diagnostics-bundle")?;
    let packaged_hash = hash_artifact(&packaged, "diagnostics-bundle")?;
    if canonical_hash.sha256 != packaged_hash.sha256
        || canonical_hash.file_count != packaged_hash.file_count
        || canonical_hash.byte_count != packaged_hash.byte_count
    {
        return Err("packaged diagnostics bundle differs from canonical export".to_string());
    }
    push_timeline(
        timeline,
        "diagnostics-export-packaged",
        invocation_id,
        Some(json!({ "canonicalOutputPath": canonical })),
    );
    Ok(DiagnosticsAuthority {
        scope: artifact.scope,
        canonical_output_path: canonical.to_string_lossy().to_string(),
        generated_at: artifact.generated_at,
        file_count: artifact.file_count,
        canonical_bundle_sha256: canonical_hash.sha256,
        packaged_bundle_sha256: packaged_hash.sha256,
        bundle_manifest_sha256: hash_file(&packaged.join("bundle-manifest.json"))?,
    })
}

fn validate_bundle_identity(
    bundle: &Path,
    desktop_process_id: u32,
    invocation_id: &str,
    source_head_commit: &str,
) -> Result<(), String> {
    let manifest: Value = read_json(&bundle.join("bundle-manifest.json"))?;
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || manifest.get("scope").and_then(Value::as_str) != Some("full")
    {
        return Err("canonical diagnostics bundle must be schemaVersion 2/full".to_string());
    }
    let environment: Value = read_json(&bundle.join("environment.json"))?;
    if environment.get("processId").and_then(Value::as_u64)
        != Some(u64::from(desktop_process_id))
    {
        return Err("diagnostics environment processId does not match the emitter".to_string());
    }
    if environment.get("buildProfile").and_then(Value::as_str) != Some("release")
        || environment.get("debugAssertions").and_then(Value::as_bool) != Some(false)
        || environment.get("buildCommit").and_then(Value::as_str) != Some(source_head_commit)
    {
        return Err(
            "diagnostics environment must bind a release binary built from the current clean HEAD"
                .to_string(),
        );
    }
    let logs_contain_invocation = walk_files(bundle)?
        .into_iter()
        .filter(|path| path.to_string_lossy().contains("logs"))
        .any(|path| {
            fs::read_to_string(path)
                .map(|content| content.contains(invocation_id))
                .unwrap_or(false)
        });
    if !logs_contain_invocation {
        return Err("full diagnostics bundle does not contain the release invocationId".to_string());
    }
    Ok(())
}

fn log_authority_event(
    app: &AppHandle,
    scenario: EvidenceScenario,
    invocation_id: &str,
    event: &str,
    production_handler: Option<&str>,
) {
    let detail = format!(
        "scenarioId={} invocationId={} event={} productionHandler={}",
        scenario.id(),
        invocation_id,
        event,
        production_handler.unwrap_or("-")
    );
    let _ = append_diagnostics_log(
        app,
        "runtime",
        "info",
        "release_evidence.authority_event",
        Some(detail),
        Some(format!("{}:{}", file!(), line!())),
        None,
    );
}

fn push_timeline(
    timeline: &mut Vec<Value>,
    event: &str,
    invocation_id: &str,
    detail: Option<Value>,
) {
    timeline.push(json!({
        "event": event,
        "invocationId": invocation_id,
        "observedAt": now(),
        "sequence": timeline.len() + 1,
        "detail": detail,
    }));
}

fn publish_startup_failure(error: &str) {
    let Some(raw_output) = env_value(OUTPUT_ENV) else {
        return;
    };
    let output = PathBuf::from(raw_output);
    if !output.is_absolute() || output.exists() {
        return;
    }
    if let Some(parent) = output.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::create_dir(&output).is_err() {
        return;
    }
    let scenario = env_value(SCENARIO_ENV).unwrap_or_default();
    let _ = write_json(
        &output.join("emitter-result.json"),
        &json!({
            "schemaVersion": 1,
            "artifactKind": "desktop-release-evidence-emitter-result",
            "scenarioId": scenario,
            "status": "failed",
            "completedAt": now(),
            "desktopProcessId": std::process::id(),
            "error": error,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn startup_scenario_contract_routes_overlay_to_the_webdriver_os_authority() {
        assert_eq!(
            EvidenceScenario::parse("E2E-PROVIDER-CONFIG")
                .unwrap()
                .collector_id(),
            "omni-desktop-provider-config-release-evidence"
        );
        assert_eq!(
            EvidenceScenario::parse("E2E-PROVIDER-PROBE")
                .unwrap()
                .artifact_paths(),
            &["provider-probe-result.json", "diagnostics-bundle"]
        );
        // Overlay evidence needs a separate target HWND and a real WebDriver
        // session, so it is intentionally not accepted by this startup-only
        // provider/diagnostics emitter.
        assert!(EvidenceScenario::parse("E2E-OVERLAY-CLICK-THROUGH").is_err());
    }

    #[test]
    fn artifact_directory_hash_matches_the_node_collector_grammar() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        fs::write(root.path().join("a.txt"), b"alpha").unwrap();
        fs::write(root.path().join("nested/b.txt"), b"beta").unwrap();
        let record = hash_artifact(root.path(), "bundle").unwrap();
        let mut expected = Sha256::new();
        for (name, bytes) in [("a.txt", b"alpha".as_slice()), ("nested/b.txt", b"beta".as_slice())] {
            expected.update(b"file\0");
            expected.update(name.as_bytes());
            expected.update(b"\0");
            expected.update(bytes.len().to_string().as_bytes());
            expected.update(b"\0");
            expected.update(bytes);
            expected.update(b"\0");
        }
        assert_eq!(record.sha256, format!("{:x}", expected.finalize()));
        assert_eq!(record.file_count, 2);
        assert_eq!(record.byte_count, 9);
    }

    #[test]
    fn provider_selection_uses_active_template_without_exposing_secret_material() {
        let config = json!({
            "activeProviderTemplateId": "template-b",
            "providers": [
                {
                    "templateId": "template-a", "providerId": "provider-a", "kind": "openai",
                    "displayName": "A", "model": "a", "baseUrl": "https://a.invalid", "transport": "http",
                    "authRef": { "kind": "credential-ref", "reference": "credential://a", "headerName": "Authorization", "scheme": "bearer" },
                    "region": null, "streamEnabled": true, "timeoutMs": 1000, "systemPromptTemplate": ""
                },
                {
                    "templateId": "template-b", "providerId": "provider-b", "kind": "openai",
                    "displayName": "B", "model": "b", "baseUrl": "https://b.invalid", "transport": "http",
                    "authRef": { "kind": "credential-ref", "reference": "credential://b", "headerName": "Authorization", "scheme": "bearer" },
                    "region": null, "streamEnabled": true, "timeoutMs": 1000, "systemPromptTemplate": ""
                }
            ]
        });
        let (_, provider) = select_provider(&config, None).unwrap();
        assert_eq!(provider.provider_id, "provider-b");
        assert_eq!(provider.auth_ref.reference, "credential://b");
    }

}
