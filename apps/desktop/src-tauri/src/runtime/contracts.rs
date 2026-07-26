use serde::Serialize;

use crate::bridge::contracts::BridgeRuntimeSnapshot;
use crate::shared::contracts::DiagnosticsRuntimeSnapshot;
use crate::storage::contracts::StorageRuntimeSnapshot;

/// Runtime notifications are mirrored into the diagnostics log through the
/// shared signal seam, so the type itself lives in `crate::shared::contracts`.
pub use crate::shared::contracts::RuntimeNotification;

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
    /// Application-run session id (the trailing ` sid=` token in the logs),
    /// handed to the renderer so frontend records correlate across processes.
    pub session_id: String,
    pub bridge: BridgeRuntimeSnapshot,
    pub diagnostics: DiagnosticsRuntimeSnapshot,
    pub storage: StorageRuntimeSnapshot,
    pub windows: Vec<RuntimeWindowSnapshot>,
    pub notifications: Vec<RuntimeNotification>,
}
