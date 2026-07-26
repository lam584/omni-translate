pub mod contracts;
pub mod events;
pub mod file_logger;
pub mod log_pipeline;
pub mod macros;
pub mod model_trace;
pub mod state;

/// Application-run session id: generated once per process start (UUIDv7, so
/// lexically time-ordered), appended as the trailing ` sid=<value>` token to
/// every app.log line, propagated to the bridge service via the `bridge.init`
/// handshake and to the renderer through `bootstrap_runtime`. This is the
/// cross-process log correlation key — never inject it as a line prefix (the
/// leading-timestamp contract is load-bearing for the testing scripts).
pub fn session_id() -> &'static str {
    static SESSION_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SESSION_ID.get_or_init(|| uuid::Uuid::now_v7().simple().to_string())
}

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
