//! Composition-layer wiring for the diagnostics <-> runtime seams.
//!
//! Like `api_v2`, this module may import both subsystems: it is the single
//! place that connects their shared-bus signals, so neither side calls the
//! other directly. Called once from `main.rs` setup.

use tauri::{AppHandle, Manager};

use crate::diagnostics::state::DiagnosticsStateStore;
use crate::runtime::events::{emit_runtime_snapshot, log_should_emit_runtime_snapshot};
use crate::runtime::state::RuntimeStateStore;
use crate::shared;
use crate::shared::signals::RuntimeNotificationSignal;

/// Exact field mapping the notification -> diagnostics-log mirror uses;
/// pinned by tests because desktop-runtime's IPC-hang history makes the
/// category/detail/timestamp shape load-bearing for log forensics.
fn mirror_notification_into_log(store: &DiagnosticsStateStore, signal: &RuntimeNotificationSignal<'_>) {
    let _ = store.append_log(
        "runtime",
        signal.level,
        signal.message.to_string(),
        Some(format!("source={}", signal.source)),
        signal.emitted_at.to_string(),
        None,
        None,
    );
}

pub fn install_diagnostics_runtime_seams(
    app_handle: &AppHandle,
    notification_log_store: DiagnosticsStateStore,
) {
    let signals = shared::signals::global();
    {
        // Runtime aggregate snapshot pulls its diagnostics section here.
        let handle = app_handle.clone();
        signals.set_diagnostics_snapshot_provider(move || {
            crate::diagnostics::events::build_diagnostics_snapshot(&handle)
        });
    }
    {
        // Runtime notifications mirror into the diagnostics log.
        signals.subscribe_runtime_notification(move |signal| {
            mirror_notification_into_log(&notification_log_store, signal);
        });
    }
    {
        // Native diagnostics log lines drive runtime snapshot pushes,
        // filtered by the runtime-side emission policy.
        let handle = app_handle.clone();
        signals.subscribe_diagnostics_log(move |signal| {
            if log_should_emit_runtime_snapshot(signal.category, signal.level) {
                if let Some(runtime_state) = handle.try_state::<RuntimeStateStore>() {
                    let _ = emit_runtime_snapshot(&handle, &runtime_state);
                }
            }
        });
    }
    {
        // Log-less diagnostics updates (model trace) refresh unconditionally.
        let handle = app_handle.clone();
        signals.subscribe_runtime_snapshot_refresh(move || {
            if let Some(runtime_state) = handle.try_state::<RuntimeStateStore>() {
                let _ = emit_runtime_snapshot(&handle, &runtime_state);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn notification_mirror_keeps_the_exact_log_fields() {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let root_dir = std::env::temp_dir().join(format!("omni-wiring-mirror-{marker}"));
        let store = DiagnosticsStateStore::new_with_root(root_dir.to_string_lossy().to_string());

        mirror_notification_into_log(
            &store,
            &RuntimeNotificationSignal {
                level: "warning",
                source: "rust-core",
                message: "bridge degraded",
                emitted_at: "unix:1778883200",
            },
        );

        let entry = store
            .snapshot_base()
            .recent_logs
            .into_iter()
            .next()
            .expect("mirrored log entry");
        assert_eq!(entry.category, "runtime");
        assert_eq!(entry.level, "warning");
        assert_eq!(entry.summary, "bridge degraded");
        assert_eq!(entry.detail.as_deref(), Some("source=rust-core"));
        assert_eq!(entry.emitted_at, "unix:1778883200");
        assert_eq!(entry.source, None);
        assert_eq!(entry.elapsed_ms, None);

        let _ = fs::remove_dir_all(root_dir);
    }
}
