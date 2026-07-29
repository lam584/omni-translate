//! Shared helper for emitting runtime notifications from audio worker
//! failure paths. The session / subtitle-translate / speech workers all
//! resolve the `RuntimeStateStore` and forward a pre-built notification the
//! exact same way; only the notification payload differs between them.

use tauri::{AppHandle, Manager};

use crate::audio::state::AudioStateStore;
use crate::runtime::contracts::RuntimeNotification;

/// Resolve the shared `RuntimeStateStore` and emit `notification`.
///
/// This is the boilerplate half that every audio worker failure branch
/// shares; the caller keeps ownership of the notification payload (id,
/// severity and message text) so wording stays identical to before.
pub(crate) fn emit_worker_notification<R: tauri::Runtime>(
    app: &AppHandle<R>,
    notification: RuntimeNotification,
) {
    let runtime_state = app.state::<crate::runtime::state::RuntimeStateStore>();
    let _ = crate::runtime::events::emit_runtime_notification(app, &runtime_state, notification);
}

/// Log the standard "worker started" info line and push a fresh audio
/// snapshot. Every audio dispatch worker announces startup the same way,
/// differing only in the localized `message`.
pub(crate) fn announce_worker_started<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    message: &str,
) -> Result<(), String> {
    let _ = crate::diagnostics::events::append_diagnostics_log(
        app, "audio", "info", message, None, None, None,
    );
    crate::audio::engine::emit_audio_snapshot(app, store)
}
