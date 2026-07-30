use serde::Serialize;
use ts_rs::TS;

use crate::bridge::contracts::BridgeRuntimeSnapshot;
use crate::shared::contracts::DiagnosticsRuntimeSnapshot;
use crate::storage::contracts::StorageRuntimeSnapshot;

/// Runtime notifications are mirrored into the diagnostics log through the
/// shared signal seam, so the type itself lives in `crate::shared::contracts`.
pub(crate) use crate::shared::contracts::RuntimeNotification;

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeWindowSnapshot {
    pub label: String,
    pub title: String,
    #[ts(type = "'main' | 'subtitle-overlay'")]
    pub kind: String,
    pub visible: bool,
    pub focused: bool,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSnapshot {
    #[ts(type = "'booting' | 'ready' | 'degraded'")]
    pub core_state: String,
    #[ts(type = "'browser-preview' | 'tauri-shell' | 'runtime-error'")]
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
