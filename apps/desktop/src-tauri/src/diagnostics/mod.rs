pub mod contracts;
pub mod events;
pub mod export_artifacts;
pub mod file_logger;
pub mod log_pipeline;
pub mod macros;
pub mod model_trace;
pub mod state;

/// Moved to the shared foundation (`crate::shared::session_id`) so the
/// runtime snapshot baseline can carry it without depending on this module;
/// re-exported here for the existing `diagnostics::session_id()` callers.
pub use crate::shared::session_id;

/// Build the diagnostics store and wire every process-global logging concern
/// to it: the panic hook (app.log single line + panic.log backtrace) and the
/// `log::` facade forwarder sharing the store's writer thread and dynamic
/// level. Called exactly once from `main` before the Tauri builder runs.
pub fn bootstrap_logging() -> state::DiagnosticsStateStore {
    let store = state::DiagnosticsStateStore::new();
    log_pipeline::install_panic_hook(store.logs_dir().into());
    file_logger::init(store.clone());
    store
}
