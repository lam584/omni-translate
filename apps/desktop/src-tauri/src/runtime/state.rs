use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::bridge::contracts::BridgeRuntimeSnapshot;
use crate::diagnostics::contracts::DiagnosticsRuntimeSnapshot;
use crate::storage::contracts::StorageRuntimeSnapshot;

use super::contracts::{RuntimeNotification, RuntimeSnapshot};

pub struct RuntimeStateStore {
    inner: Mutex<RuntimeState>,
}

pub struct RuntimeState {
    pub core_state: String,
    pub bridge_status: String,
    pub active_profile_id: String,
    pub tray_ready: bool,
    pub overlay_window_visible: bool,
    pub last_sync_at: String,
    pub notifications: Vec<RuntimeNotification>,
}

impl RuntimeStateStore {
    pub fn new() -> Self {
        let now = now_marker();

        Self {
            inner: Mutex::new(RuntimeState {
                core_state: "booting".to_string(),
                bridge_status: "tauri-shell".to_string(),
                active_profile_id: "desktop-shell".to_string(),
                tray_ready: false,
                overlay_window_visible: false,
                last_sync_at: now.clone(),
                notifications: vec![RuntimeNotification::info(
                    "runtime-boot",
                    "rust-core",
                    "Rust Core 已启动，等待前端通过 invoke/event 拉起状态同步。",
                    now,
                )],
            }),
        }
    }

    pub fn mark_ready(&self) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.core_state = "ready".to_string();
        state.last_sync_at = now_marker();
    }

    pub fn set_tray_ready(&self, tray_ready: bool) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.tray_ready = tray_ready;
        state.last_sync_at = now_marker();
    }

    pub fn overlay_window_visible(&self) -> bool {
        let state = self.inner.lock().expect("runtime state poisoned");
        state.overlay_window_visible
    }

    pub fn set_overlay_window_visible(&self, visible: bool) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.overlay_window_visible = visible;
        state.last_sync_at = now_marker();
    }

    pub fn push_notification(&self, notification: RuntimeNotification) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state
            .notifications
            .retain(|item| item.id != notification.id);
        state.notifications.insert(0, notification.clone());
        state.notifications.truncate(6);
        state.last_sync_at = notification.emitted_at;
    }

    pub fn snapshot_base(&self) -> RuntimeSnapshot {
        let state = self.inner.lock().expect("runtime state poisoned");

        RuntimeSnapshot {
            core_state: state.core_state.clone(),
            bridge_status: state.bridge_status.clone(),
            active_profile_id: state.active_profile_id.clone(),
            tray_ready: state.tray_ready,
            last_sync_at: state.last_sync_at.clone(),
            session_id: crate::diagnostics::session_id().to_string(),
            bridge: BridgeRuntimeSnapshot::default(),
            diagnostics: DiagnosticsRuntimeSnapshot::preview(),
            storage: StorageRuntimeSnapshot::preview(),
            windows: Vec::new(),
            notifications: state.notifications.clone(),
        }
    }
}

pub fn now_marker() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("unix:{}", duration.as_secs()),
        Err(_) => "unix:0".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_base_starts_with_preview_dependencies() {
        let store = RuntimeStateStore::new();

        let snapshot = store.snapshot_base();

        assert_eq!(snapshot.core_state, "booting");
        assert_eq!(snapshot.bridge.status, "warning");
        assert_eq!(snapshot.diagnostics.status, "preview");
        assert_eq!(snapshot.storage.status, "preview");
        assert_eq!(snapshot.notifications.len(), 1);
    }

    #[test]
    fn push_notification_deduplicates_and_truncates_recent_items() {
        let store = RuntimeStateStore::new();
        for index in 0..8 {
            let id = format!("runtime-{index}");
            store.push_notification(RuntimeNotification::info(
                if index == 7 { "runtime-3" } else { &id },
                "runtime-tests",
                &format!("message-{index}"),
                format!("unix:{index}"),
            ));
        }

        let snapshot = store.snapshot_base();

        assert_eq!(snapshot.notifications.len(), 6);
        assert_eq!(snapshot.notifications[0].id, "runtime-3");
        assert_eq!(snapshot.last_sync_at, "unix:7");
    }
}
