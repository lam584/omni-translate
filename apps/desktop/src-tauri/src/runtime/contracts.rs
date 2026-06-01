use serde::Serialize;

use crate::bridge::contracts::BridgeRuntimeSnapshot;
use crate::diagnostics::contracts::DiagnosticsRuntimeSnapshot;
use crate::storage::contracts::StorageRuntimeSnapshot;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeNotification {
    pub id: String,
    pub level: String,
    pub source: String,
    pub message: String,
    pub emitted_at: String,
}

impl RuntimeNotification {
    pub fn info(id: &str, source: &str, message: &str, emitted_at: String) -> Self {
        Self {
            id: id.to_string(),
            level: "info".to_string(),
            source: source.to_string(),
            message: message.to_string(),
            emitted_at,
        }
    }

    pub fn warning(id: &str, source: &str, message: &str, emitted_at: String) -> Self {
        Self {
            id: id.to_string(),
            level: "warning".to_string(),
            source: source.to_string(),
            message: message.to_string(),
            emitted_at,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWindowSnapshot {
    pub label: String,
    pub title: String,
    pub kind: String,
    pub visible: bool,
    pub focused: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub core_state: String,
    pub bridge_status: String,
    pub active_profile_id: String,
    pub tray_ready: bool,
    pub last_sync_at: String,
    pub bridge: BridgeRuntimeSnapshot,
    pub diagnostics: DiagnosticsRuntimeSnapshot,
    pub storage: StorageRuntimeSnapshot,
    pub windows: Vec<RuntimeWindowSnapshot>,
    pub notifications: Vec<RuntimeNotification>,
}
