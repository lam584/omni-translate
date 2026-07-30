//! Shared foundation both `runtime` and `diagnostics` depend on.
//!
//! The two subsystems used to call each other directly (a compile-time
//! cycle inside the crate). Everything they must agree on — contract types,
//! timestamp markers, the log/notification signal seams and the session id —
//! lives here so the dependency direction is `runtime -> shared` and
//! `diagnostics -> shared`, never sideways.

pub(crate) mod contracts;
pub(crate) mod signals;
pub(crate) mod time;

/// Application-run session id: generated once per process start (UUIDv7, so
/// lexically time-ordered), appended as the trailing ` sid=<value>` token to
/// every app.log line, propagated to the bridge service via the `bridge.init`
/// handshake and to the renderer through `bootstrap_runtime`. This is the
/// cross-process log correlation key — never inject it as a line prefix (the
/// leading-timestamp contract is load-bearing for the testing scripts).
pub(crate) fn session_id() -> &'static str {
    static SESSION_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SESSION_ID.get_or_init(|| uuid::Uuid::now_v7().simple().to_string())
}
