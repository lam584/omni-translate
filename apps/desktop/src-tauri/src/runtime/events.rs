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
use super::windows::sync_subtitle_overlay_unlock_window;

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
    let _ = apply_subtitle_overlay_click_through(window, locked);
    let _ = sync_subtitle_overlay_unlock_window(app, window, false);
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
    let mut windows = collect_window_snapshots(app);

    if let Some(overlay_window) = windows
        .iter_mut()
        .find(|item| item.label == "subtitle-overlay")
    {
        state.set_overlay_window_visible(overlay_window.visible);
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
    let payload = to_value(snapshot).unwrap_or_default();
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
    let payload = to_value(notification).unwrap_or_default();
    crate::api_v2::emit_runtime_event_v2(app, "notification", payload)?;
    emit_runtime_snapshot(app, state)
}

pub fn toggle_subtitle_overlay_with_state(
    app: &AppHandle,
    state: &RuntimeStateStore,
) -> Result<RuntimeSnapshot, String> {
    let window = ensure_subtitle_overlay_window(app).map_err(|error| error.to_string())?;
    let is_visible = window
        .is_visible()
        .unwrap_or_else(|_| state.overlay_window_visible());

    if is_visible {
        let _ = sync_subtitle_overlay_unlock_window(app, &window, false);
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

    let is_visible = window
        .is_visible()
        .unwrap_or_else(|_| state.overlay_window_visible());

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

#[tauri::command]
pub fn get_runtime_snapshot(
    app: AppHandle,
    state: State<'_, RuntimeStateStore>,
) -> RuntimeSnapshot {
    build_runtime_snapshot(&app, &state)
}

#[tauri::command]
pub fn bootstrap_runtime(
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
    hotspot_interactive: bool,
) -> Result<(), String> {
    let window = ensure_subtitle_overlay_window(&app).map_err(|error| error.to_string())?;

    sync_subtitle_overlay_input_state(&window, locked)?;
    apply_subtitle_overlay_click_through(&window, locked)?;
    sync_subtitle_overlay_unlock_window(&app, &window, locked && hotspot_interactive)?;
    apply_subtitle_overlay_window_chrome(&window)?;
    apply_subtitle_overlay_region(&window, true)
}
