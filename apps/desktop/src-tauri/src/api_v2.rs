//! Versioned command boundary for the desktop shell.
//!
//! The existing subsystem commands remain implementation details while the
//! renderer talks to five scene-oriented commands.  Keeping the envelope here
//! makes error handling and future protocol migrations explicit.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{to_value, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::contracts::AudioRuntimeSnapshot;
use crate::audio::events as audio_events;
use crate::audio::state::AudioStateStore;
use crate::bridge::events as bridge_events;
use crate::bridge::state::BridgeStateStore;
use crate::diagnostics::events as diagnostics_events;
use crate::diagnostics::state::DiagnosticsStateStore;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::events as provider_events;
use crate::runtime::state::RuntimeStateStore;
use crate::storage::events as storage_events;
use crate::storage::StorageStateStore;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResult<T> {
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
pub struct ServiceWarning {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceErrorV2 {
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

fn log_v2_entry(app: &AppHandle, command: &str, request_id: &str) {
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
fn finish_v2<T>(
    app: &AppHandle,
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

/// Stable event shape for renderer subscriptions.  Individual producers can
/// adopt this without changing their domain payload shape.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventV2 {
    pub topic: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub payload: Value,
}

static RUNTIME_EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn emit_runtime_event_v2(
    app: &AppHandle,
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

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ProviderCommandV2 {
    FetchModels { provider: ProviderDraftInput },
    Probe { provider: ProviderDraftInput },
    Smoke {
        provider: ProviderDraftInput,
        source_text: Option<String>,
        source_language: Option<String>,
        target_language: Option<String>,
    },
}

// Runs off the main thread (async) so provider network I/O cannot starve the
// Tauri IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub async fn provider_v2(
    app: AppHandle,
    command: ProviderCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "provider_v2", &request_id);
    let outcome = async {
        match command {
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
        }
        .map_err(|error| ServiceErrorV2::from(error.to_string()))
    }
    .await;
    finish_v2(&app, "provider_v2", request_id, started, outcome)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SessionCommandV2 {
    Snapshot,
    RefreshDevices,
    Preconnect { config: Value },
    CancelPreconnect,
    PrewarmRoutes { config: Value },
    StartRoute { direction: String, config: Value },
    StopRoute { direction: String },
    ClearCues,
    StartSpeech { config: Value },
    StopSpeech,
    StartTranslation { config: Value },
    StopTranslation,
    SyncOverlayRegion { rounded: bool },
    SyncOverlayWindowState {
        locked: bool,
        rounded: bool,
        hotspot_interactive: bool,
    },
}

#[tauri::command]
pub async fn session_v2(
    app: AppHandle,
    command: SessionCommandV2,
) -> Result<ServiceResult<AudioRuntimeSnapshot>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "session_v2", &request_id);
    let result = match command {
        SessionCommandV2::Snapshot => Ok(app.state::<AudioStateStore>().snapshot()),
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

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum BridgeCommandV2 {
    Snapshot,
    Refresh,
    Start { config: Value },
    Stop,
    Install { config: Value },
    Uninstall,
    Repair {
        config: Value,
        #[serde(rename = "repairAction")]
        repair_action: String,
    },
}

// Runs off the main thread (async) so blocking driver/process management cannot
// starve the Tauri IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub async fn bridge_v2(app: AppHandle, command: BridgeCommandV2) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "bridge_v2", &request_id);
    let outcome = async {
        match command {
            BridgeCommandV2::Snapshot => to_value(bridge_events::get_bridge_runtime_snapshot(app.state::<BridgeStateStore>()))
                .map_err(|error| ServiceErrorV2::from(error.to_string())),
            BridgeCommandV2::Refresh => serialize_result(bridge_events::refresh_bridge_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>())),
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

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum DiagnosticsCommandV2 {
    SelfCheck,
    OverlaySelfCheck,
    Export { scope: String },
    LiveSessionEvents,
}

// Runs off the main thread (async) so bundle/file I/O (e.g. export) cannot
// freeze the Tauri IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub async fn diagnostics_v2(
    app: AppHandle,
    command: DiagnosticsCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "diagnostics_v2", &request_id);
    let outcome = async {
        match command {
            DiagnosticsCommandV2::SelfCheck => serialize_result(diagnostics_events::run_diagnostics_self_check(app.clone(), app.state::<RuntimeStateStore>(), app.state::<DiagnosticsStateStore>())),
            DiagnosticsCommandV2::OverlaySelfCheck => serialize_result(diagnostics_events::run_subtitle_overlay_self_check(app.clone(), app.state::<RuntimeStateStore>(), app.state::<AudioStateStore>())),
            DiagnosticsCommandV2::Export { scope } => serialize_result(diagnostics_events::export_diagnostics_bundle(app.clone(), app.state::<RuntimeStateStore>(), app.state::<DiagnosticsStateStore>(), scope).await),
            DiagnosticsCommandV2::LiveSessionEvents => diagnostics_events::get_live_session_events(app.state::<AudioStateStore>())
                .and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
                .map_err(ServiceErrorV2::from),
        }
    }
    .await;
    finish_v2(&app, "diagnostics_v2", request_id, started, outcome)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ConfigurationCommandV2 {
    Load,
    Save { config: Value },
    Reset,
    Export,
    Import { file_path: String },
    CreateSnapshot { reason: Option<String> },
    Rollback { snapshot_id: String },
}

// Runs off the main thread (async) so SQLite/config I/O cannot starve the Tauri
// IPC event loop — mirrors `session_v2`.
#[tauri::command]
pub async fn configuration_v2(
    app: AppHandle,
    command: ConfigurationCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let request_id = new_request_id();
    let started = std::time::Instant::now();
    log_v2_entry(&app, "configuration_v2", &request_id);
    let outcome = async {
        match command {
            ConfigurationCommandV2::Load => serialize_result(storage_events::load_config_draft(app.clone(), app.state::<StorageStateStore>())),
            ConfigurationCommandV2::Save { config } => serialize_result(storage_events::save_config_draft(app.clone(), app.state::<StorageStateStore>(), config)),
            ConfigurationCommandV2::Reset => serialize_result(storage_events::reset_config_draft(app.clone(), app.state::<StorageStateStore>())),
            ConfigurationCommandV2::Export => serialize_result(storage_events::export_config_draft(app.clone(), app.state::<StorageStateStore>())),
            ConfigurationCommandV2::Import { file_path } => serialize_result(storage_events::import_config_draft(app.clone(), app.state::<StorageStateStore>(), file_path)),
            ConfigurationCommandV2::CreateSnapshot { reason } => serialize_result(storage_events::create_config_snapshot(app.clone(), app.state::<StorageStateStore>(), reason)),
            ConfigurationCommandV2::Rollback { snapshot_id } => serialize_result(storage_events::rollback_config_snapshot(app.clone(), app.state::<StorageStateStore>(), snapshot_id)),
        }
    }
    .await;
    finish_v2(&app, "configuration_v2", request_id, started, outcome)
}

#[cfg(test)]
mod tests {
    use super::{
        attach_request_id, BridgeCommandV2, ConfigurationCommandV2, RuntimeEventV2, ServiceErrorV2,
        ServiceResult, SessionCommandV2,
    };

    #[test]
    fn v2_types_use_the_renderer_contract_shape() {
        let command: SessionCommandV2 = serde_json::from_str(r#"{"action":"snapshot"}"#).unwrap();
        assert!(matches!(command, SessionCommandV2::Snapshot));
        let configuration: ConfigurationCommandV2 =
            serde_json::from_str(r#"{"action":"createSnapshot","reason":"before-import"}"#)
                .unwrap();
        assert!(matches!(configuration, ConfigurationCommandV2::CreateSnapshot { .. }));
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
