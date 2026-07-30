use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use super::events::{emit_runtime_snapshot, toggle_subtitle_overlay_with_state};
use super::state::RuntimeStateStore;
use crate::log_debug;
use crate::log_info;

fn load_tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../../icons/tray-icon.png")).map(Image::to_owned)
}

pub(crate) fn initialize_tray(app: &AppHandle, state: &RuntimeStateStore) -> tauri::Result<()> {
    let show_main = MenuItemBuilder::with_id("show-main", "显示主窗口").build(app)?;
    let toggle_overlay = MenuItemBuilder::with_id("toggle-overlay", "切换字幕浮窗").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show_main, &toggle_overlay, &quit])
        .build()?;

    let icon = load_tray_icon()?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Omni Translate")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-main" => {
                log_info!(app, "runtime", "托盘菜单: 显示主窗口");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle-overlay" => {
                log_info!(app, "runtime", "托盘菜单: 切换字幕浮窗");
                let state = app.state::<RuntimeStateStore>();
                let _ = toggle_subtitle_overlay_with_state(app, &state);
            }
            "quit" => {
                log_info!(app, "runtime", "托盘菜单: 退出应用");
                app.exit(0);
            }
            _ => {
                log_debug!(
                    app,
                    "runtime",
                    format!("托盘菜单: 未知事件 {:?}", event.id())
                );
            }
        })
        .build(app)?;

    state.set_tray_ready(true);
    emit_runtime_snapshot(app, state)?;

    Ok(())
}
