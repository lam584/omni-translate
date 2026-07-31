pub(crate) mod contracts;
pub(crate) mod events;
pub(crate) mod export_artifacts;
pub(crate) mod export_bundle;
pub(crate) mod file_logger;
pub(crate) mod log_pipeline;
pub(crate) mod macros;
pub(crate) mod model_trace;
pub(crate) mod redaction;
pub(crate) mod state;

/// Moved to the shared foundation (`crate::shared::session_id`) so the
/// runtime snapshot baseline can carry it without depending on this module;
/// re-exported here for the existing `diagnostics::session_id()` callers.
pub(crate) use crate::shared::session_id;

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Build a unique temp directory path shared by the diagnostics test
    /// modules. `component` distinguishes the caller (e.g. `diagnostics`,
    /// `log-pipeline`) so the produced names stay identical to the previous
    /// per-module helpers.
    pub(crate) fn temp_dir(component: &str, name: &str) -> PathBuf {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("omni-{component}-{name}-{marker}"))
    }
}

/// Build the diagnostics store and wire every process-global logging concern
/// to it: the panic hook (app.log single line + panic.log backtrace) and the
/// `log::` facade forwarder sharing the store's writer thread and dynamic
/// level. Called exactly once from `main` before the Tauri builder runs.
pub(crate) fn bootstrap_logging() -> state::DiagnosticsStateStore {
    let store = state::DiagnosticsStateStore::new();
    log_pipeline::install_panic_hook(store.logs_dir().into());
    file_logger::init(store.clone());
    store
}
