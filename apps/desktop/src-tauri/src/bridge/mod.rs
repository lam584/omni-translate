pub mod contracts;
mod clients;
pub mod events;
pub mod installer;
pub mod ipc;
pub mod state;

/// Bridge session ids embed the app-level session id (so the trailing ` sid=`
/// tokens in bridge-service.log align with app.log by substring) while
/// staying unique per bridge (re)start: the audio-pipe session-mismatch nack
/// depends on per-start uniqueness
/// (`tests/windows_sidecar.rs::audio_pipe_returns_a_framed_session_mismatch_nack`).
pub(crate) fn new_bridge_session_id() -> String {
    format!(
        "bridge-{}-{}",
        crate::diagnostics::session_id(),
        ipc::now_unix_ms()
    )
}
