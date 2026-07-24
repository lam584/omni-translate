use serde_json::to_value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::state::BridgeStateStore;
use crate::diagnostics::events::build_diagnostics_snapshot;
use crate::diagnostics::state::DiagnosticsStateStore;
use crate::storage::StorageStateStore;

use super::contracts::{RuntimeNotification, RuntimeSnapshot};
use super::state::{now_marker, RuntimeStateStore};
use super::windows::apply_subtitle_overlay_background;
use super::windows::apply_subtitle_overlay_click_through;
use super::windows::apply_subtitle_overlay_region;
use super::windows::apply_subtitle_overlay_window_chrome;
use super::windows::collect_window_snapshots;
use super::windows::ensure_subtitle_overlay_window;
use super::windows::sync_subtitle_overlay_input_state;

pub const RUNTIME_SNAPSHOT_EVENT: &str = "runtime://snapshot";
pub const RUNTIME_NOTIFICATION_EVENT: &str = "runtime://notification";

fn sync_persisted_subtitle_overlay_input(app: &AppHandle, window: &tauri::WebviewWindow) {
    let locked = app
        .state::<StorageStateStore>()
        .load_config()
        .ok()
        .and_then(|config| config.pointer("/subtitles/overlayLocked").and_then(|value| value.as_bool()))
        .unwrap_or(false);
    let _ = sync_subtitle_overlay_input_state(window, locked);
    // Never mark the overlay globally click-through: the per-region WM_NCHITTEST
    // hook keeps the unlock hotspot interactive while the rest stays passthrough,
    // so the in-page unlock pill can be clicked without a separate catcher window.
    let _ = apply_subtitle_overlay_click_through(window, false);
}

pub fn build_runtime_snapshot(app: &AppHandle, state: &RuntimeStateStore) -> RuntimeSnapshot {
    let mut snapshot = state.snapshot_base();
    if let Some(bridge) = app.try_state::<BridgeStateStore>() {
        snapshot.bridge = bridge.snapshot();
    }
    snapshot.diagnostics = build_diagnostics_snapshot(app);
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

pub fn emit_runtime_snapshot(app: &AppHandle, state: &RuntimeStateStore) -> tauri::Result<()> {
    let snapshot = build_runtime_snapshot(app, state);
    app.emit(RUNTIME_SNAPSHOT_EVENT, snapshot.clone())?;
    let payload = to_value(&snapshot).unwrap_or_else(|error| {
        log::error!("[omni][runtime] failed to serialize runtime snapshot: {error}");
        serde_json::Value::Null
    });
    crate::api_v2::emit_runtime_event_v2(app, "snapshot", payload)
}

pub fn emit_runtime_notification(
    app: &AppHandle,
    state: &RuntimeStateStore,
    notification: RuntimeNotification,
) -> tauri::Result<()> {
    state.push_notification(notification.clone());
    if let Some(diagnostics) = app.try_state::<DiagnosticsStateStore>() {
        let _ = diagnostics.append_log(
            "runtime",
            &notification.level,
            notification.message.clone(),
            Some(format!("source={}", notification.source)),
            notification.emitted_at.clone(),
            None,
            None,
        );
    }
    app.emit(RUNTIME_NOTIFICATION_EVENT, notification.clone())?;
    let payload = to_value(&notification).unwrap_or_else(|error| {
        log::error!("[omni][runtime] failed to serialize runtime notification: {error}");
        serde_json::Value::Null
    });
    crate::api_v2::emit_runtime_event_v2(app, "notification", payload)?;
    emit_runtime_snapshot(app, state)
}

pub fn toggle_subtitle_overlay_with_state(
    app: &AppHandle,
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
        sync_persisted_subtitle_overlay_input(app, &window);
        let _ = apply_subtitle_overlay_background(&window);
        let _ = window.set_decorations(false);
        let _ = window.set_shadow(false);
        let _ = apply_subtitle_overlay_window_chrome(&window);
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        let _ = apply_subtitle_overlay_background(&window);
        let _ = apply_subtitle_overlay_window_chrome(&window);
        let _ = apply_subtitle_overlay_region(&window, true);
        state.set_overlay_window_visible(true);
    }

    emit_runtime_snapshot(app, state).map_err(|error| error.to_string())?;

    Ok(build_runtime_snapshot(app, state))
}

pub fn show_subtitle_overlay_with_state(
    app: &AppHandle,
    state: &RuntimeStateStore,
) -> Result<RuntimeSnapshot, String> {
    let window = ensure_subtitle_overlay_window(app).map_err(|error| error.to_string())?;

    // Read cached visibility instead of the blocking Win32 `is_visible()`
    // round-trip (see collect_window_snapshots). State is the source of truth,
    // kept in sync by set_overlay_window_visible below.
    let is_visible = state.overlay_window_visible();

    if !is_visible {
        sync_persisted_subtitle_overlay_input(app, &window);
        let _ = apply_subtitle_overlay_background(&window);
        let _ = window.set_decorations(false);
        let _ = window.set_shadow(false);
        let _ = apply_subtitle_overlay_window_chrome(&window);
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        let _ = apply_subtitle_overlay_background(&window);
        let _ = apply_subtitle_overlay_window_chrome(&window);
        let _ = apply_subtitle_overlay_region(&window, true);
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
#[tauri::command]
pub async fn get_runtime_snapshot(
    app: AppHandle,
    state: State<'_, RuntimeStateStore>,
) -> Result<RuntimeSnapshot, String> {
    Ok(build_runtime_snapshot(&app, &state))
}

#[tauri::command]
pub async fn bootstrap_runtime(
    app: AppHandle,
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
            now_marker(),
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

#[tauri::command]
pub fn sync_subtitle_overlay_region(app: AppHandle, rounded: bool) -> Result<(), String> {
    let window = ensure_subtitle_overlay_window(&app).map_err(|error| error.to_string())?;
    apply_subtitle_overlay_region(&window, rounded)
}

#[tauri::command]
pub fn sync_subtitle_overlay_chrome(app: AppHandle) -> Result<(), String> {
    let window = ensure_subtitle_overlay_window(&app).map_err(|error| error.to_string())?;
    apply_subtitle_overlay_window_chrome(&window)
}

#[tauri::command]
pub fn sync_subtitle_overlay_window_state(
    app: AppHandle,
    locked: bool,
    _rounded: bool,
    _hotspot_interactive: bool,
) -> Result<(), String> {
    let window = ensure_subtitle_overlay_window(&app).map_err(|error| error.to_string())?;

    sync_subtitle_overlay_input_state(&window, locked)?;
    // Keep the overlay cursor-interactive at the OS level even while locked and
    // let the per-region WM_NCHITTEST hook decide passthrough: everything except
    // the top-right unlock hotspot reports HTTRANSPARENT (click-through), while
    // the hotspot reports HTCLIENT so the in-page unlock pill stays clickable.
    apply_subtitle_overlay_click_through(&window, false)?;
    apply_subtitle_overlay_window_chrome(&window)?;
    apply_subtitle_overlay_region(&window, true)
}
