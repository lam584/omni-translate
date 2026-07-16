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
}

impl<T> ServiceResult<T> {
    fn ok(data: T) -> Self {
        Self {
            data,
            warnings: Vec::new(),
        }
    }
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
            message,
            retriable: false,
            details: None,
        }
    }
}

fn serialize_result<T: Serialize>(result: Result<T, String>) -> Result<Value, ServiceErrorV2> {
    let value = result.map_err(ServiceErrorV2::from)?;
    to_value(value).map_err(|error| ServiceErrorV2::from(error.to_string()))
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

#[tauri::command]
pub fn provider_v2(
    app: AppHandle,
    command: ProviderCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let result = match command {
        ProviderCommandV2::FetchModels { provider } => {
            to_value(provider_events::fetch_provider_models(app, provider))
        }
        ProviderCommandV2::Probe { provider } => to_value(provider_events::probe_provider(app, provider)),
        ProviderCommandV2::Smoke {
            provider,
            source_text,
            source_language,
            target_language,
        } => to_value(provider_events::execute_provider_smoke(
            app,
            provider,
            source_text,
            source_language,
            target_language,
        )),
    }
    .map_err(|error| ServiceErrorV2::from(error.to_string()))?;
    Ok(ServiceResult::ok(result))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SessionCommandV2 {
    Snapshot,
    RefreshDevices,
    Preconnect { config: Value },
    CancelPreconnect,
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
    let result = match command {
        SessionCommandV2::Snapshot => Ok(app.state::<AudioStateStore>().snapshot()),
        SessionCommandV2::RefreshDevices => {
            audio_events::refresh_audio_devices(app.clone(), app.state::<AudioStateStore>())
        }
        SessionCommandV2::Preconnect { config } => audio_events::preconnect_omni_realtime(app.clone(), config).await,
        SessionCommandV2::CancelPreconnect => audio_events::cancel_omni_preconnect(app.clone()).await,
        SessionCommandV2::StartRoute { direction, config } => {
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
    result.map(ServiceResult::ok).map_err(ServiceErrorV2::from)
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

#[tauri::command]
pub fn bridge_v2(app: AppHandle, command: BridgeCommandV2) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let result = match command {
        BridgeCommandV2::Snapshot => to_value(bridge_events::get_bridge_runtime_snapshot(app.state::<BridgeStateStore>()))
            .map_err(|error| ServiceErrorV2::from(error.to_string()))?,
        BridgeCommandV2::Refresh => serialize_result(bridge_events::refresh_bridge_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>()))?,
        BridgeCommandV2::Start { config } => serialize_result(bridge_events::start_bridge_service(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>(), config))?,
        BridgeCommandV2::Stop => serialize_result(bridge_events::stop_bridge_service(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>()))?,
        BridgeCommandV2::Install { config } => serialize_result(bridge_events::install_driver_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>(), config))?,
        BridgeCommandV2::Uninstall => serialize_result(bridge_events::uninstall_driver_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>()))?,
        BridgeCommandV2::Repair { config, repair_action } => serialize_result(bridge_events::repair_driver_runtime(app.clone(), app.state::<RuntimeStateStore>(), app.state::<BridgeStateStore>(), config, repair_action))?,
    };
    Ok(ServiceResult::ok(result))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum DiagnosticsCommandV2 {
    SelfCheck,
    OverlaySelfCheck,
    Export { scope: String },
    LiveSessionEvents,
}

#[tauri::command]
pub fn diagnostics_v2(
    app: AppHandle,
    command: DiagnosticsCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let result = match command {
        DiagnosticsCommandV2::SelfCheck => serialize_result(diagnostics_events::run_diagnostics_self_check(app.clone(), app.state::<RuntimeStateStore>(), app.state::<DiagnosticsStateStore>()))?,
        DiagnosticsCommandV2::OverlaySelfCheck => serialize_result(diagnostics_events::run_subtitle_overlay_self_check(app.clone(), app.state::<RuntimeStateStore>(), app.state::<AudioStateStore>()))?,
        DiagnosticsCommandV2::Export { scope } => serialize_result(diagnostics_events::export_diagnostics_bundle(app.clone(), app.state::<RuntimeStateStore>(), app.state::<DiagnosticsStateStore>(), scope))?,
        DiagnosticsCommandV2::LiveSessionEvents => diagnostics_events::get_live_session_events(app.state::<AudioStateStore>())
            .and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
            .map_err(ServiceErrorV2::from)?,
    };
    Ok(ServiceResult::ok(result))
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

#[tauri::command]
pub fn configuration_v2(
    app: AppHandle,
    command: ConfigurationCommandV2,
) -> Result<ServiceResult<Value>, ServiceErrorV2> {
    let result = match command {
        ConfigurationCommandV2::Load => serialize_result(storage_events::load_config_draft(app.clone(), app.state::<StorageStateStore>()))?,
        ConfigurationCommandV2::Save { config } => serialize_result(storage_events::save_config_draft(app.clone(), app.state::<StorageStateStore>(), config))?,
        ConfigurationCommandV2::Reset => serialize_result(storage_events::reset_config_draft(app.clone(), app.state::<StorageStateStore>()))?,
        ConfigurationCommandV2::Export => serialize_result(storage_events::export_config_draft(app.clone(), app.state::<StorageStateStore>()))?,
        ConfigurationCommandV2::Import { file_path } => serialize_result(storage_events::import_config_draft(app.clone(), app.state::<StorageStateStore>(), file_path))?,
        ConfigurationCommandV2::CreateSnapshot { reason } => serialize_result(storage_events::create_config_snapshot(app.clone(), app.state::<StorageStateStore>(), reason))?,
        ConfigurationCommandV2::Rollback { snapshot_id } => serialize_result(storage_events::rollback_config_snapshot(app.clone(), app.state::<StorageStateStore>(), snapshot_id))?,
    };
    Ok(ServiceResult::ok(result))
}

#[cfg(test)]
mod tests {
    use super::{BridgeCommandV2, ConfigurationCommandV2, RuntimeEventV2, ServiceErrorV2, SessionCommandV2};

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
        assert_eq!(ServiceErrorV2::from("nope".to_string()).code, "runtime.operation-failed");
    }
}
