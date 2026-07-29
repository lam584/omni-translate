use serde_json::to_value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::state::BridgeStateStore;
use crate::storage::StorageStateStore;

use super::contracts::{RuntimeNotification, RuntimeSnapshot};
use super::state::RuntimeStateStore;
use crate::shared::time::now_unix_seconds_marker;
use super::windows::apply_subtitle_overlay_background;
use super::windows::apply_subtitle_overlay_click_through;
use super::windows::apply_subtitle_overlay_region;
use super::windows::apply_subtitle_overlay_window_chrome;
use super::windows::collect_window_snapshots;
use super::windows::ensure_subtitle_overlay_window;
use super::windows::sync_subtitle_overlay_input_state;

pub const RUNTIME_SNAPSHOT_EVENT: &str = "runtime://snapshot";
pub const RUNTIME_NOTIFICATION_EVENT: &str = "runtime://notification";
const CONFIG_DRAFT_UPDATED_EVENT: &str = "config://draft-updated";

fn should_ignore_subtitle_overlay_cursor_events(locked: bool, hotspot_interactive: bool) -> bool {
    locked && !hotspot_interactive
}

fn apply_subtitle_overlay_input_policy<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    locked: bool,
    hotspot_interactive: bool,
) -> Result<(), String> {
    sync_subtitle_overlay_input_state(window, locked)?;
    apply_subtitle_overlay_click_through(
        window,
        should_ignore_subtitle_overlay_cursor_events(locked, hotspot_interactive),
    )
}

fn sync_persisted_subtitle_overlay_input<R: tauri::Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) {
    let locked = app
        .state::<StorageStateStore>()
        .load_config()
        .ok()
        .and_then(|config| {
            config
                .pointer("/subtitles/overlayLocked")
                .and_then(|value| value.as_bool())
        })
        .unwrap_or(false);
    let _ = apply_subtitle_overlay_input_policy(window, locked, false);
}

/// Whether a diagnostics log line of this `category`/`level` should rebuild
/// and emit a full runtime snapshot to the webview. Applied by the
/// log-appended subscriber the composition root registers.
///
/// High-frequency audio/omni route + session traces must NOT each trigger
/// this. During a scene launch ~15 such lines fire back-to-back (provider
/// resolution, Omni session start, route/overlay steps), and a live session
/// keeps emitting them from the audio pump. Emitting on every line rebuilds
/// the whole runtime snapshot (window enumeration + bridge + diagnostics +
/// storage) and pushes it twice to the webview; that backend->frontend storm
/// adds ~40ms per line to the launch worker and contends with the WebView2
/// invoke channel the renderer uses to poll watch-route readiness, so a
/// pre-warmed route cannot report ready within its budget and the launch
/// aborts before it converges.
///
/// Audio/omni state already reaches the UI through the much cheaper
/// `emit_audio_snapshot` path, so only their warnings/errors need to be
/// surfaced live here. Every other category (runtime/bridge/storage/...)
/// always emits so startup progress and lifecycle updates are unaffected.
pub fn log_should_emit_runtime_snapshot(category: &str, level: &str) -> bool {
    let is_high_frequency_trace =
        matches!(category, "audio" | "omni") && !matches!(level, "warning" | "error");
    !is_high_frequency_trace
}

pub fn build_runtime_snapshot<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &RuntimeStateStore,
) -> RuntimeSnapshot {
    let mut snapshot = state.snapshot_base();
    if let Some(bridge) = app.try_state::<BridgeStateStore>() {
        snapshot.bridge = bridge.snapshot();
    }
    // The diagnostics section comes through the shared provider seam (the
    // composition root registers it); an unregistered provider yields the
    // preview baseline, mirroring the old try_state fallback.
    snapshot.diagnostics = crate::shared::signals::global().diagnostics_snapshot();
    if let Some(storage) = app.try_state::<StorageStateStore>() {
        snapshot.storage = storage.snapshot();
    }
    let mut windows = collect_window_snapshots(app, state.overlay_window_visible());

    if let Some(overlay_window) = windows
        .iter_mut()
        .find(|item| item.label == "subtitle-overlay")
    {
        if !overlay_window.visible {
            overlay_window.focused = false;
        }
    }

    snapshot.windows = windows;
    snapshot
}

pub fn emit_runtime_snapshot<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &RuntimeStateStore,
) -> tauri::Result<()> {
    let snapshot = build_runtime_snapshot(app, state);
    app.emit(RUNTIME_SNAPSHOT_EVENT, snapshot.clone())?;
    let payload = to_value(&snapshot).unwrap_or_else(|error| {
        log::error!("[omni][runtime] failed to serialize runtime snapshot: {error}");
        serde_json::Value::Null
    });
    crate::api_v2::emit_runtime_event_v2(app, "snapshot", payload)
}

pub fn emit_runtime_notification<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &RuntimeStateStore,
    notification: RuntimeNotification,
) -> tauri::Result<()> {
    state.push_notification(notification.clone());
    // The diagnostics subscriber (registered by the composition root) mirrors
    // the notification into the log store; publishing before the window emit
    // preserves the original log-then-emit ordering.
    crate::shared::signals::global().publish_runtime_notification(
        &crate::shared::signals::RuntimeNotificationSignal {
            level: &notification.level,
            source: &notification.source,
            message: &notification.message,
            emitted_at: &notification.emitted_at,
        },
    );
    app.emit(RUNTIME_NOTIFICATION_EVENT, notification.clone())?;
    let payload = to_value(&notification).unwrap_or_else(|error| {
        log::error!("[omni][runtime] failed to serialize runtime notification: {error}");
        serde_json::Value::Null
    });
    crate::api_v2::emit_runtime_event_v2(app, "notification", payload)?;
    emit_runtime_snapshot(app, state)
}

/// Apply the full show sequence for the subtitle overlay window: sync persisted
/// input, strip decorations/shadow, apply chrome/background, unminimize, show,
/// then re-apply background/chrome/region once visible. Shared by the toggle and
/// show commands, which historically repeated this exact ordering.
fn reveal_subtitle_overlay_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    sync_persisted_subtitle_overlay_input(app, window);
    let _ = apply_subtitle_overlay_background(window);
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(false);
    let _ = apply_subtitle_overlay_window_chrome(window);
    let _ = window.unminimize();
    window.show().map_err(|error| error.to_string())?;
    let _ = apply_subtitle_overlay_background(window);
    let _ = apply_subtitle_overlay_window_chrome(window);
    let _ = apply_subtitle_overlay_region(window, true);
    Ok(())
}

pub fn toggle_subtitle_overlay_with_state<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &RuntimeStateStore,
) -> Result<RuntimeSnapshot, String> {
    let window = ensure_subtitle_overlay_window(app).map_err(|error| error.to_string())?;
    // Read cached visibility instead of the blocking Win32 `is_visible()`
    // round-trip (see collect_window_snapshots). State is the source of truth,
    // kept in sync by set_overlay_window_visible below.
    let is_visible = state.overlay_window_visible();

    if is_visible {
        window.hide().map_err(|error| error.to_string())?;
        state.set_overlay_window_visible(false);
    } else {
        reveal_subtitle_overlay_window(app, &window)?;
        state.set_overlay_window_visible(true);
    }

    emit_runtime_snapshot(app, state).map_err(|error| error.to_string())?;

    Ok(build_runtime_snapshot(app, state))
}

pub fn show_subtitle_overlay_with_state<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &RuntimeStateStore,
) -> Result<RuntimeSnapshot, String> {
    let window = ensure_subtitle_overlay_window(app).map_err(|error| error.to_string())?;

    // Read cached visibility instead of the blocking Win32 `is_visible()`
    // round-trip (see collect_window_snapshots). State is the source of truth,
    // kept in sync by set_overlay_window_visible below.
    let is_visible = state.overlay_window_visible();

    if !is_visible {
        reveal_subtitle_overlay_window(app, &window)?;
    }

    state.set_overlay_window_visible(true);
    emit_runtime_snapshot(app, state).map_err(|error| error.to_string())?;

    Ok(build_runtime_snapshot(app, state))
}

// Both commands build a `RuntimeSnapshot`. Historically that meant calling
// `collect_window_snapshots` -> `WebviewWindow::is_visible/is_focused/title`,
// which on Windows are synchronous Win32 round-trips that need the main-thread
// message pump. Running them from a sync command *on* the main thread deadlocked
// the event loop and hung `bootstrap_runtime` right after the IPC ping. The
// snapshot builder no longer queries the OS at all (it reads cached window state
// from `RuntimeStateStore`), so these commands are safe. Do NOT reintroduce live
// `WebviewWindow::is_*`/`title` calls on any command/emit path.
//
// They are also declared `async` so Tauri runs them on a worker thread instead
// of the main/UI thread. The WebView2 IPC custom-protocol handler runs on the
// main thread; keeping command bodies off it prevents a burst of concurrent
// invokes from starving that handler (which manifested as `invoke` round-trips
// that never returned -> `bootstrap_runtime` "timeout").
pub async fn get_runtime_snapshot<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, RuntimeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    Ok(build_runtime_snapshot(&app, &state))
}

pub async fn bootstrap_runtime<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, RuntimeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    state.mark_ready();
    emit_runtime_notification(
        &app,
        &state,
        RuntimeNotification::info(
            "runtime-bootstrap",
            "rust-core",
            "前端已建立 invoke/event 通道，主窗口与托盘就绪。字幕浮窗将在首次使用时懒加载。",
            now_unix_seconds_marker(),
        ),
    )
    .map_err(|error| error.to_string())?;

    Ok(build_runtime_snapshot(&app, &state))
}

#[tauri::command]
pub fn toggle_subtitle_overlay(
    app: AppHandle,
    state: State<'_, RuntimeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    toggle_subtitle_overlay_with_state(&app, &state)
}

#[tauri::command]
pub fn show_subtitle_overlay(
    app: AppHandle,
    state: State<'_, RuntimeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    show_subtitle_overlay_with_state(&app, &state)
}

pub fn sync_subtitle_overlay_region(app: AppHandle, rounded: bool) -> Result<(), String> {
    let window = ensure_subtitle_overlay_window(&app).map_err(|error| error.to_string())?;
    apply_subtitle_overlay_region(&window, rounded)
}

#[tauri::command]
pub fn sync_subtitle_overlay_window_state(
    app: AppHandle,
    locked: bool,
    _rounded: bool,
    hotspot_interactive: bool,
) -> Result<(), String> {
    let window = ensure_subtitle_overlay_window(&app).map_err(|error| error.to_string())?;

    // While locked, the whole window ignores cursor input until polling reports
    // that the pointer is over the unlock hotspot. At that point input is
    // restored on this same window, and the WM_NCHITTEST hook still confines it
    // to the hotspot. This works reliably with WebView2's child HWND hierarchy.
    apply_subtitle_overlay_input_policy(&window, locked, hotspot_interactive)?;
    apply_subtitle_overlay_window_chrome(&window)?;
    apply_subtitle_overlay_region(&window, true)
}

#[tauri::command]
pub fn unlock_subtitle_overlay(app: AppHandle) -> Result<(), String> {
    let storage = app.state::<StorageStateStore>();
    storage.ensure_initialized(&app)?;
    let mut config = storage.load_config()?;
    let locked = config
        .pointer_mut("/subtitles/overlayLocked")
        .ok_or_else(|| "missing subtitles.overlayLocked in persisted config".to_string())?;
    *locked = serde_json::Value::Bool(false);
    storage.save_config(&config)?;
    app.emit(CONFIG_DRAFT_UPDATED_EVENT, config)
        .map_err(|error| error.to_string())?;

    let window = ensure_subtitle_overlay_window(&app).map_err(|error| error.to_string())?;
    apply_subtitle_overlay_input_policy(&window, false, false)?;
    apply_subtitle_overlay_window_chrome(&window)?;
    apply_subtitle_overlay_region(&window, true)
}

#[cfg(test)]
mod tests {
    use super::{log_should_emit_runtime_snapshot, should_ignore_subtitle_overlay_cursor_events};

    #[test]
    fn locked_overlay_only_accepts_input_inside_the_unlock_hotspot() {
        assert!(should_ignore_subtitle_overlay_cursor_events(true, false));
        assert!(!should_ignore_subtitle_overlay_cursor_events(true, true));
        assert!(!should_ignore_subtitle_overlay_cursor_events(false, false));
        assert!(!should_ignore_subtitle_overlay_cursor_events(false, true));
    }

    #[test]
    fn high_frequency_audio_and_omni_traces_skip_runtime_snapshot_emit() {
        // Info/debug/trace lines from the audio route and Omni session hot paths
        // must not each rebuild + emit a runtime snapshot: that storm is what
        // starved the readiness poll and made watch mode abort before it bound.
        for level in ["info", "debug", "trace"] {
            assert!(
                !log_should_emit_runtime_snapshot("audio", level),
                "audio {level} traces must not emit a runtime snapshot"
            );
            assert!(
                !log_should_emit_runtime_snapshot("omni", level),
                "omni {level} traces must not emit a runtime snapshot"
            );
        }
    }

    #[test]
    fn audio_and_omni_warnings_and_errors_still_emit_runtime_snapshot() {
        // Failures are rare and user-facing, so they must still reach the UI live.
        for level in ["warning", "error"] {
            assert!(log_should_emit_runtime_snapshot("audio", level));
            assert!(log_should_emit_runtime_snapshot("omni", level));
        }
    }

    #[test]
    fn other_categories_always_emit_runtime_snapshot() {
        // Startup progress and lifecycle updates depend on these emitting live.
        for category in ["runtime", "bridge", "storage", "model-trace"] {
            for level in ["info", "debug", "warning", "error"] {
                assert!(
                    log_should_emit_runtime_snapshot(category, level),
                    "{category} {level} must emit a runtime snapshot"
                );
            }
        }
    }
}
