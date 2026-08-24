//! Versioned command boundary for the desktop shell.
//!
//! The existing subsystem commands remain implementation details while the
//! renderer talks to five scene-oriented commands.  Keeping the envelope here
//! makes error handling and future protocol migrations explicit.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, to_value, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::contracts::AudioRuntimeSnapshot;
use crate::audio::events as audio_events;
use crate::audio::state::AudioStateStore;
use crate::bridge::events as bridge_events;
use crate::bridge::state::BridgeStateStore;
use crate::diagnostics::events as diagnostics_events;
use crate::diagnostics::state::DiagnosticsStateStore;
use crate::history::HistoryStateStore;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::events as provider_events;
use crate::runtime::events as runtime_events;
use crate::runtime::state::RuntimeStateStore;
use crate::storage::events as storage_events;
use crate::storage::{BenchmarkHistorySaveInput, StorageStateStore};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceResult<T> {
    pub data: T,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ServiceWarning>,
    /// Correlation id of this command execution; also present in the
    /// entry/exit `api_v2.request` / `api_v2.response` log lines. Optional and
    /// additive, so older payload consumers keep working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceWarning {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceErrorV2 {
    pub code: String,
    pub message: String,
    pub retriable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl From<String> for ServiceErrorV2 {
    fn from(message: String) -> Self {
        Self {
            code: "runtime.operation-failed".to_string(),
            message: message.clone(),
            // Keep the untruncated original error text in details so the
            // generic code/message folding no longer destroys attribution.
            details: Some(serde_json::json!({ "rawError": message })),
            retriable: false,
        }
    }
}

fn serialize_result<T: Serialize>(result: Result<T, String>) -> Result<Value, ServiceErrorV2> {
    let value = result.map_err(ServiceErrorV2::from)?;
    to_value(value).map_err(|error| ServiceErrorV2::from(error.to_string()))
}

fn new_request_id() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

/// Write the request id into `ServiceErrorV2.details.requestId`, preserving
/// any existing details payload (non-object details move under `inner`).
fn attach_request_id(mut error: ServiceErrorV2, request_id: &str) -> ServiceErrorV2 {
    let mut details = match error.details.take() {
        Some(Value::Object(map)) => map,
        Some(other) => {
            let mut map = serde_json::Map::new();
            map.insert("inner".to_string(), other);
            map
        }
        None => serde_json::Map::new(),
    };
    details.insert(
        "requestId".to_string(),
        Value::String(request_id.to_string()),
    );
    error.details = Some(Value::Object(details));
    error
}

fn log_v2_entry<R: tauri::Runtime>(app: &AppHandle<R>, command: &str, request_id: &str) {
    crate::log_debug!(
        app,
        "runtime",
        format!("api_v2.request command={command}"),
        format!("requestId={request_id}")
    );
}

/// Shared exit path for the five v2 commands: logs the outcome with its
/// elapsed time and stamps the request id on the success envelope or into
/// `ServiceErrorV2.details.requestId` on failure.
fn finish_v2<T, R: tauri::Runtime>(
    app: &AppHandle<R>,
    command: &str,
    request_id: String,
    started: std::time::Instant,
    outcome: Result<T, ServiceErrorV2>,
) -> Result<ServiceResult<T>, ServiceErrorV2> {
    let elapsed_ms = started.elapsed().as_millis();
    match outcome {
        Ok(data) => {
            crate::log_debug!(
                app,
                "runtime",
                format!("api_v2.response command={command} status=ok"),
                format!("requestId={request_id}"),
                elapsed_ms
            );
            Ok(ServiceResult {
                data,
                warnings: Vec::new(),
                request_id: Some(request_id),
            })
        }
        Err(error) => {
            crate::log_warn!(
                app,
                "runtime",
                format!("api_v2.response command={command} status=error code={}", error.code),
                format!("requestId={request_id}"),
                elapsed_ms
            );
            Err(attach_request_id(error, &request_id))
        }
    }
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum HistoryCommandV2 {
    ListSessions {
        #[ts(optional)]
        cursor: Option<String>,
        #[ts(optional)]
        limit: Option<u32>,
    },
    GetSession { session_id: String },
    ListCues {
        session_id: String,
        #[ts(optional)]
        cursor: Option<String>,
        #[ts(optional)]
        limit: Option<u32>,
    },
    GetStats,
    DeleteSession { session_id: String },
    ClearHistory,
    PlayCueAudio {
        session_id: String,
        cue_id: String,
        #[ts(type = "'source' | 'translated'")]
        track: crate::history::HistoryAudioTrack,
    },
    StopPlayback,
}

#[tauri::command]
pub(crate) fn history_v2(
    app: AppHandle,
    command: HistoryCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "history_v2", &request_id);
    let history = app.state::<HistoryStateStore>();
    let outcome = match command {
        HistoryCommandV2::ListSessions { cursor, limit } => {
            history.list_sessions(cursor.as_deref(), limit.unwrap_or(25)).and_then(|value| {
                to_value(value).map_err(|error| error.to_string())
            })
        }
        HistoryCommandV2::GetSession { session_id } => history
            .get_session(&session_id)
            .and_then(|value| to_value(value).map_err(|error| error.to_string())),
        HistoryCommandV2::ListCues { session_id, cursor, limit } => history
            .list_cues(&session_id, cursor.as_deref(), limit.unwrap_or(50))
            .and_then(|value| to_value(value).map_err(|error| error.to_string())),
        HistoryCommandV2::GetStats => history
            .statistics()
            .and_then(|value| to_value(value).map_err(|error| error.to_string())),
        HistoryCommandV2::DeleteSession { session_id } => history
            .delete_session(&session_id)
            .map(|deleted| {
                if deleted {
                    crate::history::emit_changed(&app, "sessionDeleted", Some(session_id));
                }
                json!({ "deleted": deleted })
            }),
        HistoryCommandV2::ClearHistory => history.clear(&app).map(|deleted_count| {
            if deleted_count > 0 {
                crate::history::emit_changed(&app, "historyCleared", None);
            }
            json!({ "deletedCount": deleted_count })
        }),
        HistoryCommandV2::PlayCueAudio { session_id, cue_id, track } => history
            .play_cue_audio(&app, &session_id, &cue_id, track)
            .and_then(|value| to_value(value).map_err(|error| error.to_string())),
        HistoryCommandV2::StopPlayback => history
            .stop_playback(&app, "user")
            .and_then(|value| to_value(value).map_err(|error| error.to_string())),
    }
    .map_err(ServiceErrorV2::from);
    finish_v2(&app, "history_v2", request_id, started, outcome)
}

/// Stable event shape for renderer subscriptions.  Individual producers can
/// adopt this without changing their domain payload shape.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeEventV2 {
    pub topic: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub payload: Value,
}

static RUNTIME_EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn emit_runtime_event_v2<R: tauri::Runtime>(
    app: &AppHandle<R>,
    topic: impl Into<String>,
    payload: Value,
) -> tauri::Result<()> {
    let topic = topic.into();
    let event = RuntimeEventV2 {
        topic: topic.clone(),
        sequence: RUNTIME_EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        payload,
    };
    let event_name = format!("runtime-v2://{topic}");
    app.emit(&event_name, event)
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ProviderCommandV2 {
    ResolveRealtimeProfile {
        #[ts(type = "unknown")]
        config: Value,
        model_reference: String,
    },
    FetchModels {
        #[ts(type = "unknown")]
        provider: ProviderDraftInput,
    },
    Probe {
        #[ts(type = "unknown")]
        provider: ProviderDraftInput,
    },
    Smoke {
        #[ts(type = "unknown")]
        provider: ProviderDraftInput,
        #[ts(optional)]
        source_text: Option<String>,
        #[ts(optional)]
        source_language: Option<String>,
        #[ts(optional)]
        target_language: Option<String>,
    },
    RunModelBenchmark {
        model: String,
        api_key: String,
        mp3_path: String,
        run_id: String,
        #[ts(optional)]
        realtime_audio_mode: Option<String>,
        #[ts(optional)]
        interaction_capabilities: Option<Vec<String>>,
        #[ts(optional)]
        provider_kind: Option<String>,
        #[ts(optional)]
        base_url: Option<String>,
        #[ts(optional)]
        auth_header_name: Option<String>,
        #[ts(optional)]
        auth_scheme: Option<String>,
        #[ts(optional)]
        #[ts(type = "unknown")]
        provider: Option<ProviderDraftInput>,
    },
}

// Runs off the main thread (async) so provider network I/O cannot starve the
// Tauri IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub(crate) async fn provider_v2(
    app: AppHandle,
    command: ProviderCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "provider_v2", &request_id);
    let outcome = async {
        match command {
            ProviderCommandV2::ResolveRealtimeProfile { config, model_reference } => {
                let provider = audio_events::resolve_model_provider_from_config_value(&config, &model_reference)
                    .ok_or_else(|| ServiceErrorV2::from(format!("realtime model reference cannot be resolved: {model_reference}")))?;
                let profile = audio_events::resolve_realtime_profile(&provider, &provider.model);
                Ok(json!({
                    "providerId": profile.provider_id,
                    "modelId": profile.model_id,
                    "routeKind": profile.route_kind.as_str(),
                    "protocolDialect": profile.protocol_dialect.map(|protocol| protocol.as_str()),
                    "realtimeAudioMode": profile.realtime_audio_mode,
                    "inputFormat": profile.input_format,
                    "outputFormat": profile.output_format,
                    "sampleRate": profile.sample_rate,
                    "serverSegmentation": profile.server_segmentation,
                    "nativeTranslation": profile.native_translation,
                    "nativeAudioOutput": profile.native_audio_output,
                    "secondaryTranslationPolicy": profile.secondary_translation_policy,
                    "speechDispatchPolicy": profile.speech_dispatch_policy,
                    "preconnectPolicy": profile.preconnect_policy,
                    "timeoutBudgetMs": profile.timeout_budget_ms,
                    "source": profile.source.as_str(),
                    "diagnostics": profile.diagnostics,
                }))
            }
            ProviderCommandV2::FetchModels { provider } => {
                to_value(provider_events::fetch_provider_models(app.clone(), provider).await)
            }
            ProviderCommandV2::Probe { provider } => {
                to_value(provider_events::probe_provider(app.clone(), provider).await)
            }
            ProviderCommandV2::Smoke {
                provider,
                source_text,
                source_language,
                target_language,
            } => to_value(
                provider_events::execute_provider_smoke(
                    app.clone(),
                    provider,
                    source_text,
                    source_language,
                    target_language,
                )
                .await,
            ),
            ProviderCommandV2::RunModelBenchmark {
                model,
                api_key,
                mp3_path,
                run_id,
                realtime_audio_mode,
                interaction_capabilities,
                provider_kind,
                base_url,
                auth_header_name,
                auth_scheme,
                provider,
            } => {
                return serialize_result(
                    crate::benchmark::run_model_benchmark(
                        app.clone(),
                        model,
                        api_key,
                        mp3_path,
                        run_id,
                        realtime_audio_mode,
                        interaction_capabilities,
                        provider_kind,
                        base_url,
                        auth_header_name,
                        auth_scheme,
                        provider,
                    )
                    .await,
                );
            }
        }
        .map_err(|error| ServiceErrorV2::from(error.to_string()))
    }
    .await;
    finish_v2(&app, "provider_v2", request_id, started, outcome)
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum SessionCommandV2 {
    Snapshot,
    Bootstrap,
    RefreshDevices,
    Preconnect {
        #[ts(type = "unknown")]
        config: Value,
    },
    CancelPreconnect,
    PrewarmRoutes {
        #[ts(type = "unknown")]
        config: Value,
    },
    StartRoute {
        direction: String,
        #[ts(type = "unknown")]
        config: Value,
    },
    StopRoute { direction: String },
    ClearCues,
    StartSpeech {
        #[ts(type = "unknown")]
        config: Value,
    },
    StopSpeech,
    StartTranslation {
        #[ts(type = "unknown")]
        config: Value,
    },
    StopTranslation,
    SyncOverlayRegion { rounded: bool },
    SyncOverlayWindowState {
        locked: bool,
        rounded: bool,
        hotspot_interactive: bool,
    },
}

#[tauri::command]
pub(crate) async fn session_v2(
    app: AppHandle,
    command: SessionCommandV2,
) -> Result<ServiceResult<AudioRuntimeSnapshot>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "session_v2", &request_id);
    let result = match command {
        SessionCommandV2::Snapshot => Ok(app.state::<AudioStateStore>().snapshot()),
        SessionCommandV2::Bootstrap => audio_events::bootstrap_audio(app.clone()).await,
        SessionCommandV2::RefreshDevices => {
            audio_events::refresh_audio_devices(app.clone(), app.state::<AudioStateStore>())
        }
        SessionCommandV2::Preconnect { config } => audio_events::preconnect_omni_realtime(app.clone(), config).await,
        SessionCommandV2::CancelPreconnect => audio_events::cancel_omni_preconnect(app.clone()).await,
        SessionCommandV2::PrewarmRoutes { config } => {
            audio_events::prewarm_capture_routes(app.clone(), config)
        }
        SessionCommandV2::StartRoute { direction, config } => {
            log::warn!("[omni][session_v2] startRoute direction={direction}");
            audio_events::start_audio_route(app.clone(), direction, config).await
        }
        SessionCommandV2::StopRoute { direction } => audio_events::stop_audio_route(app.clone(), direction).await,
        SessionCommandV2::ClearCues => {
            audio_events::clear_subtitle_cues(app.clone(), app.state::<AudioStateStore>())
        }
        SessionCommandV2::StartSpeech { config } => {
            audio_events::start_speech_dispatch(app.clone(), app.state::<AudioStateStore>(), config)
        }
        SessionCommandV2::StopSpeech => audio_events::stop_speech_dispatch(app.clone()).await,
        SessionCommandV2::StartTranslation { config } => {
            audio_events::start_translate_worker(app.clone(), app.state::<AudioStateStore>(), config)
        }
        SessionCommandV2::StopTranslation => audio_events::stop_translate_worker(app.clone()).await,
        SessionCommandV2::SyncOverlayRegion { rounded } => {
            crate::runtime::events::sync_subtitle_overlay_region(app.clone(), rounded)
                .map(|_| app.state::<AudioStateStore>().snapshot())
        }
        SessionCommandV2::SyncOverlayWindowState {
            locked,
            rounded,
            hotspot_interactive,
        } => crate::runtime::events::sync_subtitle_overlay_window_state(
            app.clone(),
            locked,
            rounded,
            hotspot_interactive,
        )
        .map(|_| app.state::<AudioStateStore>().snapshot()),
    };
    finish_v2(
        &app,
        "session_v2",
        request_id,
        started,
        result.map_err(ServiceErrorV2::from),
    )
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum BridgeCommandV2 {
    Snapshot,
    Refresh,
    ProbeProcessLoopback,
    Start {
        #[ts(type = "unknown")]
        config: Value,
    },
    Stop,
    Install {
        #[ts(type = "unknown")]
        config: Value,
    },
    Uninstall,
    Repair {
        #[ts(type = "unknown")]
        config: Value,
        repair_action: String,
    },
}

// Runs off the main thread (async) so blocking driver/process management cannot
// starve the Tauri IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub(crate) async fn bridge_v2<R: tauri::Runtime>(
    app: AppHandle<R>,
    command: BridgeCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "bridge_v2", &request_id);
    let outcome = async {
        match command {
            BridgeCommandV2::Snapshot => to_value(bridge_events::get_bridge_runtime_snapshot(app.state::<BridgeStateStore>()))
                .map_err(|error| ServiceErrorV2::from(error.to_string())),
            BridgeCommandV2::Refresh => serialize_result(bridge_events::refresh_bridge_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>())),
            BridgeCommandV2::ProbeProcessLoopback => serialize_result(bridge_events::probe_process_loopback_capability(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>())),
            BridgeCommandV2::Start { config } => serialize_result(bridge_events::start_bridge_service(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>(), config)),
            BridgeCommandV2::Stop => serialize_result(bridge_events::stop_bridge_service(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>())),
            BridgeCommandV2::Install { config } => serialize_result(bridge_events::install_driver_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>(), config)),
            BridgeCommandV2::Uninstall => serialize_result(bridge_events::uninstall_driver_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>())),
            BridgeCommandV2::Repair { config, repair_action } => serialize_result(bridge_events::repair_driver_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>(), config, repair_action)),
        }
    }
    .await;
    finish_v2(&app, "bridge_v2", request_id, started, outcome)
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum DiagnosticsCommandV2 {
    SelfCheck,
    OverlaySelfCheck,
    Export { scope: String },
    WatchSessionReport,
    ClearWatchSessionReport,
    Snapshot,
    OpenExportDirectory { output_path: String },
    WriteExportArtifact { filename: String, content: String },
    OpenExternalUrl { url: String },
    /// Creates a new `benchmark-score/v2` record when `recordId` is omitted,
    /// or replaces the complete persisted snapshot for that record when it is
    /// supplied.  The report/score values are arbitrary JSON and are scrubbed
    /// for credentials before they reach SQLite.
    SaveBenchmarkHistory {
        #[ts(optional)]
        record_id: Option<String>,
        run_id: String,
        model: String,
        #[ts(type = "'running' | 'completed' | 'failed' | 'interrupted'")]
        run_status: String,
        #[ts(type = "'pending' | 'judging' | 'final' | 'evidence-insufficient' | 'judge-failed' | 'benchmark-failed'")]
        score_status: String,
        #[ts(optional, type = "'benchmark-score/v2'")]
        score_version: Option<String>,
        #[ts(optional = nullable)]
        total_score: Option<f64>,
        #[ts(optional = nullable)]
        grade: Option<String>,
        #[ts(optional, type = "unknown")]
        report: Option<Value>,
        #[ts(optional, type = "unknown")]
        score: Option<Value>,
        #[ts(optional = nullable)]
        error: Option<String>,
    },
    ListBenchmarkHistory {
        #[ts(optional)]
        page: Option<u32>,
        #[ts(optional)]
        page_size: Option<u32>,
    },
    GetBenchmarkHistory { record_id: String },
    DeleteBenchmarkHistory { record_id: String },
    ClearBenchmarkHistory,
}

// Runs off the main thread (async) so bundle/file I/O (e.g. export) cannot
// freeze the Tauri IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub(crate) async fn diagnostics_v2<R: tauri::Runtime>(
    app: AppHandle<R>,
    command: DiagnosticsCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "diagnostics_v2", &request_id);
    let outcome = async {
        match command {
            // The self checks and export are cross-cutting: the diagnostics
            // half runs in the diagnostics module, and this dispatch (the
            // composition layer) owns the runtime-snapshot emission and the
            // aggregate return value, so neither subsystem calls the other.
            DiagnosticsCommandV2::SelfCheck => serialize_result(
                diagnostics_events::run_diagnostics_self_check(app.clone(), app.state::<DiagnosticsStateStore>())
                    .and_then(|()| {
                        let runtime_state = app.state::<RuntimeStateStore>();
                        runtime_events::emit_runtime_snapshot(&app, &runtime_state)
                            .map_err(|error| error.to_string())?;
                        Ok(runtime_events::build_runtime_snapshot(&app, &runtime_state))
                    }),
            ),
            DiagnosticsCommandV2::OverlaySelfCheck => serialize_result((|| {
                let runtime_state = app.state::<RuntimeStateStore>();
                let audio_state = app.state::<AudioStateStore>();
                diagnostics_events::push_overlay_self_check_cue(&audio_state);
                runtime_events::show_subtitle_overlay_with_state(&app, &runtime_state)?;
                crate::audio::engine::emit_audio_snapshot(&app, &audio_state)?;
                diagnostics_events::log_overlay_self_check_cue(&app)?;
                Ok(runtime_events::build_runtime_snapshot(&app, &runtime_state))
            })()),
            DiagnosticsCommandV2::Export { scope } => serialize_result(
                match diagnostics_events::export_diagnostics_bundle(app.clone(), app.state::<DiagnosticsStateStore>(), scope).await {
                    Ok(artifact) => {
                        let runtime_state = app.state::<RuntimeStateStore>();
                        runtime_events::emit_runtime_snapshot(&app, &runtime_state)
                            .map_err(|error| error.to_string())?;
                        Ok(artifact)
                    }
                    Err(error) => Err(error),
                },
            ),
            DiagnosticsCommandV2::WatchSessionReport => to_value(
                app.state::<AudioStateStore>().watch_session_report.snapshot(),
            )
            .map_err(|error| ServiceErrorV2::from(error.to_string())),
            DiagnosticsCommandV2::ClearWatchSessionReport => {
                app.state::<AudioStateStore>().watch_session_report.clear();
                Ok(Value::Null)
            }
            DiagnosticsCommandV2::Snapshot => to_value(diagnostics_events::get_diagnostics_snapshot(app.clone()))
                .map_err(|error| ServiceErrorV2::from(error.to_string())),
            DiagnosticsCommandV2::OpenExportDirectory { output_path } =>
                serialize_result(crate::diagnostics::export_artifacts::open_export_directory(&output_path)),
            DiagnosticsCommandV2::WriteExportArtifact { filename, content } =>
                serialize_result(crate::diagnostics::export_artifacts::write_export_artifact(&app, &filename, &content)),
            DiagnosticsCommandV2::OpenExternalUrl { url } =>
                serialize_result(crate::diagnostics::export_artifacts::open_external_url(&url)),
            DiagnosticsCommandV2::SaveBenchmarkHistory {
                record_id,
                run_id,
                model,
                run_status,
                score_status,
                score_version,
                total_score,
                grade,
                report,
                score,
                error,
            } => serialize_result((|| {
                let storage = app.state::<StorageStateStore>();
                storage.ensure_initialized(&app)?;
                storage.save_benchmark_history(BenchmarkHistorySaveInput {
                    record_id,
                    run_id,
                    model,
                    run_status,
                    score_status,
                    score_version,
                    total_score,
                    grade,
                    report,
                    score,
                    error,
                })
            })()),
            DiagnosticsCommandV2::ListBenchmarkHistory { page, page_size } => serialize_result((|| {
                let storage = app.state::<StorageStateStore>();
                storage.ensure_initialized(&app)?;
                storage.list_benchmark_history(page, page_size)
            })()),
            DiagnosticsCommandV2::GetBenchmarkHistory { record_id } => serialize_result((|| {
                let storage = app.state::<StorageStateStore>();
                storage.ensure_initialized(&app)?;
                storage.get_benchmark_history(&record_id)
            })()),
            DiagnosticsCommandV2::DeleteBenchmarkHistory { record_id } => serialize_result((|| {
                let storage = app.state::<StorageStateStore>();
                storage.ensure_initialized(&app)?;
                storage.delete_benchmark_history(&record_id)
            })()),
            DiagnosticsCommandV2::ClearBenchmarkHistory => serialize_result((|| {
                let storage = app.state::<StorageStateStore>();
                storage.ensure_initialized(&app)?;
                storage.clear_benchmark_history()
            })()),
        }
    }
    .await;
    finish_v2(&app, "diagnostics_v2", request_id, started, outcome)
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ConfigurationCommandV2 {
    Load,
    Save {
        #[ts(type = "unknown")]
        config: Value,
    },
    Reset,
    Export,
    Import { file_path: String },
    CreateSnapshot {
        #[ts(optional)]
        reason: Option<String>,
    },
    Rollback { snapshot_id: String },
    RuntimeSnapshot,
    BootstrapRuntime,
    SecretStatus { reference: String },
    SecretRead { reference: String },
    SecretUpsert { reference: String, secret: String },
}

/// A Watch diagnostic builds an in-memory route configuration from its
/// environment. The renderer can save the user's persisted draft while it is
/// still bootstrapping, and that draft may describe a different output route.
/// Do not let that unrelated save replace the diagnostic's live speaker/AEC
/// configuration mid-capture.
fn should_refresh_live_omni_speech_config(watch_diagnostic_autostart: bool) -> bool {
    !watch_diagnostic_autostart
}

// Runs off the main thread (async) so SQLite/config I/O cannot starve the Tauri
// IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub(crate) async fn configuration_v2<R: tauri::Runtime>(
    app: AppHandle<R>,
    command: ConfigurationCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "configuration_v2", &request_id);
    let outcome = async {
        match command {
            ConfigurationCommandV2::Load => serialize_result(storage_events::load_config_draft(app.clone(), app.state::<StorageStateStore>())),
            ConfigurationCommandV2::Save { config } => {
                let result = storage_events::save_config_draft(app.clone(), app.state::<StorageStateStore>(), config.clone());
                if result.is_ok() {
                    // Propagate the saved config to the live Omni playback
                    // thread so device/toggle changes apply on the next cue
                    // instead of waiting for a route restart. A diagnostic
                    // route is an explicit runtime overlay, however: the
                    // renderer's bootstrap save contains the persisted user
                    // draft, not the echo-cancel route configuration.
                    if let Some(audio_state) = app.try_state::<crate::audio::state::AudioStateStore>() {
                        if should_refresh_live_omni_speech_config(
                            crate::watch_mode_diagnostic::autostart_enabled(),
                        ) {
                            audio_state.refresh_omni_speech_config(&config);
                        } else {
                            let _ = diagnostics_events::append_diagnostics_log(
                                &app,
                                "audio",
                                "info",
                                "watch_mode.diagnostic_runtime_speech_config_preserved",
                                Some(
                                    "reason=persisted_config_save_must_not_override_diagnostic_route"
                                        .to_string(),
                                ),
                                None,
                                None,
                            );
                        }
                    }
                }
                serialize_result(result)
            }
            ConfigurationCommandV2::Reset => serialize_result(storage_events::reset_config_draft(app.clone(), app.state::<StorageStateStore>())),
            ConfigurationCommandV2::Export => serialize_result(storage_events::export_config_draft(app.clone(), app.state::<StorageStateStore>())),
            ConfigurationCommandV2::Import { file_path } => serialize_result(storage_events::import_config_draft(app.clone(), app.state::<StorageStateStore>(), file_path)),
            ConfigurationCommandV2::CreateSnapshot { reason } => serialize_result(storage_events::create_config_snapshot(app.clone(), app.state::<StorageStateStore>(), reason)),
            ConfigurationCommandV2::Rollback { snapshot_id } => serialize_result(storage_events::rollback_config_snapshot(app.clone(), app.state::<StorageStateStore>(), snapshot_id)),
            ConfigurationCommandV2::RuntimeSnapshot => serialize_result(runtime_events::get_runtime_snapshot(app.clone(), app.state::<RuntimeStateStore>()).await),
            ConfigurationCommandV2::BootstrapRuntime => serialize_result(runtime_events::bootstrap_runtime(app.clone(), app.state::<RuntimeStateStore>()).await),
            ConfigurationCommandV2::SecretStatus { reference } => serialize_result(storage_events::get_secret_ref_status(app.clone(), reference).await),
            ConfigurationCommandV2::SecretRead { reference } => serialize_result(storage_events::read_secret_ref(app.clone(), reference).await),
            ConfigurationCommandV2::SecretUpsert { reference, secret } => serialize_result(storage_events::upsert_secret_ref(app.clone(), reference, secret).await),
        }
    }
    .await;
    finish_v2(&app, "configuration_v2", request_id, started, outcome)
}

#[cfg(test)]
mod tests {
    use super::{
        attach_request_id, BridgeCommandV2, ConfigurationCommandV2, DiagnosticsCommandV2,
        RuntimeEventV2, ServiceErrorV2, ServiceResult, SessionCommandV2,
        should_refresh_live_omni_speech_config,
    };

    #[test]
    fn persisted_config_save_preserves_a_diagnostic_runtime_speech_config() {
        assert!(should_refresh_live_omni_speech_config(false));
        assert!(!should_refresh_live_omni_speech_config(true));
    }

    #[test]
    fn v2_types_use_the_renderer_contract_shape() {
        let command: SessionCommandV2 = serde_json::from_str(r#"{"action":"snapshot"}"#).unwrap();
        assert!(matches!(command, SessionCommandV2::Snapshot));
        let configuration: ConfigurationCommandV2 =
            serde_json::from_str(r#"{"action":"createSnapshot","reason":"before-import"}"#)
                .unwrap();
        assert!(matches!(configuration, ConfigurationCommandV2::CreateSnapshot { .. }));
        let history: DiagnosticsCommandV2 = serde_json::from_str(
            r#"{"action":"saveBenchmarkHistory","runId":"run-1","model":"judge-model","runStatus":"completed","scoreStatus":"final","scoreVersion":"benchmark-score/v2","totalScore":91,"grade":"A","report":{"event":"done"},"score":{"version":"benchmark-score/v2"}}"#,
        )
        .unwrap();
        assert!(matches!(
            history,
            DiagnosticsCommandV2::SaveBenchmarkHistory {
                ref run_id,
                ref score_status,
                total_score: Some(91.0),
                ..
            } if run_id == "run-1" && score_status == "final"
        ));
        let list: DiagnosticsCommandV2 =
            serde_json::from_str(r#"{"action":"listBenchmarkHistory","page":2,"pageSize":50}"#)
                .unwrap();
        assert!(matches!(
            list,
            DiagnosticsCommandV2::ListBenchmarkHistory {
                page: Some(2),
                page_size: Some(50)
            }
        ));
        let bridge: BridgeCommandV2 = serde_json::from_str(
            r#"{"action":"repair","repairAction":"rollback-driver","config":{}}"#,
        )
        .unwrap();
        assert!(matches!(
            bridge,
            BridgeCommandV2::Repair { repair_action, .. } if repair_action == "rollback-driver"
        ));
        let event = RuntimeEventV2 { topic: "session".into(), sequence: 1, timestamp_ms: 2, payload: serde_json::json!({}) };
        assert_eq!(serde_json::to_value(event).unwrap()["timestampMs"], 2);
        let error = ServiceErrorV2::from("nope".to_string());
        assert_eq!(error.code, "runtime.operation-failed");
        assert_eq!(
            error.details.as_ref().and_then(|details| details["rawError"].as_str()),
            Some("nope"),
            "the original error text must survive the generic folding"
        );
    }

    /// Round-trips the literal JSON the renderer's DesktopApiV2 emits (the
    /// committed fixture written by desktop-api-v2.fixture.test.ts) through
    /// the real command enums. A TS-side rename of an action or payload field
    /// changes the fixture and fails here even when tsc cannot see it.
    #[test]
    fn renderer_command_payloads_deserialize_into_the_v2_enums() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../fixtures/desktop-api-v2-commands.json"
        ))
        .expect("fixture parses");
        let entries = fixture.as_array().expect("fixture is an array");
        assert!(
            entries.len() >= 40,
            "fixture unexpectedly small ({} entries); regenerate it",
            entries.len()
        );
        let mut round_tripped = 0usize;
        for entry in entries {
            let label = entry["label"].as_str().unwrap_or("(unlabeled)");
            let command = entry["command"].as_str().expect("entry command");
            let payload = entry["payload"]["command"].clone();
            let outcome: Result<(), String> = match command {
                "provider_v2" => serde_json::from_value::<super::ProviderCommandV2>(payload)
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
                "session_v2" => serde_json::from_value::<SessionCommandV2>(payload)
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
                "bridge_v2" => serde_json::from_value::<BridgeCommandV2>(payload)
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
                "diagnostics_v2" => serde_json::from_value::<super::DiagnosticsCommandV2>(payload)
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
                "configuration_v2" => serde_json::from_value::<ConfigurationCommandV2>(payload)
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
                other => panic!("fixture entry {label} targets unknown command {other}"),
            };
            assert!(
                outcome.is_ok(),
                "renderer payload for {label} no longer deserializes into {command}: {}",
                outcome.unwrap_err()
            );
            round_tripped += 1;
        }
        assert_eq!(round_tripped, entries.len());
    }

    #[test]
    fn v2_struct_variant_fields_accept_the_renderer_camel_case_payloads() {
        // The renderer always sends camelCase keys. serde's container-level
        // `rename_all` only renames *variants*, so multi-word fields need
        // their own rename attribute — this test pins that the whole wire
        // shape actually deserializes.
        let session: Result<SessionCommandV2, _> = serde_json::from_str(
            r#"{"action":"syncOverlayWindowState","locked":true,"rounded":false,"hotspotInteractive":true}"#,
        );
        assert!(
            matches!(
                session,
                Ok(SessionCommandV2::SyncOverlayWindowState { hotspot_interactive: true, .. })
            ),
            "syncOverlayWindowState must accept the camelCase hotspotInteractive key: {session:?}"
        );
        let configuration: Result<ConfigurationCommandV2, _> =
            serde_json::from_str(r#"{"action":"import","filePath":"C:/config.json"}"#);
        assert!(
            matches!(
                configuration,
                Ok(ConfigurationCommandV2::Import { ref file_path }) if file_path == "C:/config.json"
            ),
            "import must accept the camelCase filePath key: {configuration:?}"
        );
        let rollback: Result<ConfigurationCommandV2, _> =
            serde_json::from_str(r#"{"action":"rollback","snapshotId":"snapshot-1"}"#);
        assert!(
            matches!(
                rollback,
                Ok(ConfigurationCommandV2::Rollback { ref snapshot_id }) if snapshot_id == "snapshot-1"
            ),
            "rollback must accept the camelCase snapshotId key: {rollback:?}"
        );
        let smoke: Result<super::ProviderCommandV2, _> = serde_json::from_str(
            r#"{"action":"smoke","provider":{"templateId":"t","providerId":"p","kind":"openai","displayName":"P","model":"m","baseUrl":"https://example.invalid","transport":"websocket","authRef":{"kind":"header","reference":"ref","headerName":"Authorization","scheme":"Bearer"},"region":null,"streamEnabled":true,"timeoutMs":1000,"systemPromptTemplate":""},"sourceText":"hello","sourceLanguage":"en","targetLanguage":"zh-CN"}"#,
        );
        assert!(
            matches!(
                smoke,
                Ok(super::ProviderCommandV2::Smoke { ref source_text, .. }) if source_text.as_deref() == Some("hello")
            ),
            "smoke must not silently drop the camelCase sourceText key: {smoke:?}"
        );
    }

    #[test]
    fn migrated_direct_commands_deserialize_as_v2_actions() {
        // Phase-1 command retirement moved these former direct commands into
        // the service envelopes; pin the action names the renderer sends.
        let session: SessionCommandV2 = serde_json::from_str(r#"{"action":"bootstrap"}"#).unwrap();
        assert!(matches!(session, SessionCommandV2::Bootstrap));
        let diagnostics: super::DiagnosticsCommandV2 =
            serde_json::from_str(r#"{"action":"snapshot"}"#).unwrap();
        assert!(matches!(diagnostics, super::DiagnosticsCommandV2::Snapshot));
        for (payload, expects_secret) in [
            (r#"{"action":"runtimeSnapshot"}"#, false),
            (r#"{"action":"bootstrapRuntime"}"#, false),
            (r#"{"action":"secretStatus","reference":"r"}"#, false),
            (r#"{"action":"secretRead","reference":"r"}"#, false),
            (r#"{"action":"secretUpsert","reference":"r","secret":"s"}"#, true),
        ] {
            let command: ConfigurationCommandV2 = serde_json::from_str(payload).unwrap();
            if expects_secret {
                assert!(matches!(
                    command,
                    ConfigurationCommandV2::SecretUpsert { ref secret, .. } if secret == "s"
                ));
            }
        }
        let benchmark: super::ProviderCommandV2 = serde_json::from_str(
            r#"{"action":"runModelBenchmark","model":"m","apiKey":"k","mp3Path":"p","runId":"r"}"#,
        )
        .unwrap();
        assert!(matches!(
            benchmark,
            super::ProviderCommandV2::RunModelBenchmark { ref run_id, .. } if run_id == "r"
        ));
    }

    #[test]
    fn request_id_reaches_the_success_envelope_and_error_details() {
        let success = ServiceResult {
            data: serde_json::json!({"ok": true}),
            warnings: Vec::new(),
            request_id: Some("req-1".to_string()),
        };
        let serialized = serde_json::to_value(&success).unwrap();
        assert_eq!(serialized["requestId"], "req-1");

        let without_id = ServiceResult {
            data: serde_json::json!({"ok": true}),
            warnings: Vec::new(),
            request_id: None,
        };
        let serialized = serde_json::to_value(&without_id).unwrap();
        assert!(
            serialized.get("requestId").is_none(),
            "absent request ids must not serialize (older consumers see the old shape)"
        );

        // Existing details are preserved when the request id is attached.
        let error = attach_request_id(ServiceErrorV2::from("boom".to_string()), "req-2");
        let details = error.details.expect("details present");
        assert_eq!(details["requestId"], "req-2");
        assert_eq!(details["rawError"], "boom");

        // Non-object details move under `inner` instead of being destroyed.
        let error = attach_request_id(
            ServiceErrorV2 {
                code: "x".into(),
                message: "y".into(),
                retriable: false,
                details: Some(serde_json::json!("plain-text")),
            },
            "req-3",
        );
        let details = error.details.expect("details present");
        assert_eq!(details["requestId"], "req-3");
        assert_eq!(details["inner"], "plain-text");
    }
}
