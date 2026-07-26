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
            let _ = notification_log_store.append_log(
                "runtime",
                signal.level,
                signal.message.to_string(),
                Some(format!("source={}", signal.source)),
                signal.emitted_at.to_string(),
                None,
                None,
            );
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
