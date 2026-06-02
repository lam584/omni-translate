use tauri::utils::config::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::RECT;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR,
    DWMWA_NCRENDERING_POLICY, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_TEXT_COLOR,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, GetWindow, GetWindowLongW, GetWindowRect, SetWindowLongPtrW,
    SetWindowLongW, SetWindowPos, SetWindowTextW, GWLP_WNDPROC, GWL_EXSTYLE, GWL_STYLE, GW_CHILD,
    GW_HWNDNEXT, HTCLIENT, HTTRANSPARENT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, WM_NCACTIVATE, WM_NCCALCSIZE, WM_NCHITTEST, WM_NCPAINT, WS_BORDER, WS_CAPTION,
    WS_DLGFRAME, WS_EX_APPWINDOW, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_EX_LAYERED,
    WS_EX_STATICEDGE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX,
    WS_MINIMIZEBOX, WS_POPUP, WS_SIZEBOX, WS_SYSMENU,
};

use super::contracts::RuntimeWindowSnapshot;

const SUBTITLE_OVERLAY_CORNER_RADIUS: f64 = 22.0;
const SUBTITLE_OVERLAY_LOCK_HOTSPOT_HEIGHT: f64 = 36.0;
const SUBTITLE_OVERLAY_LOCK_HOTSPOT_INSET: f64 = 6.0;
const SUBTITLE_OVERLAY_LOCK_HOTSPOT_WIDTH: f64 = 65.0;
const SUBTITLE_OVERLAY_BACKGROUND_COLOR: Color = Color(0, 0, 0, 0);
#[cfg(target_os = "windows")]
const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;
#[cfg(target_os = "windows")]
const DWMSBT_NONE: u32 = 1;
#[cfg(target_os = "windows")]
static SUBTITLE_OVERLAY_PREVIOUS_WNDPROC: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();
#[cfg(target_os = "windows")]
static SUBTITLE_OVERLAY_WINDOW_REGION_STATE: OnceLock<
    Mutex<HashMap<isize, SubtitleOverlayRegionState>>,
> = OnceLock::new();
#[cfg(target_os = "windows")]
static SUBTITLE_OVERLAY_WINDOW_INPUT_STATE: OnceLock<
    Mutex<HashMap<isize, SubtitleOverlayInputState>>,
> = OnceLock::new();

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq)]
struct SubtitleOverlayRegionState {
    width: i32,
    height: i32,
    corner_diameter: i32,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq)]
struct SubtitleOverlayInputState {
    locked: bool,
    hotspot_height: i32,
    hotspot_inset: i32,
    hotspot_width: i32,
}

#[cfg(target_os = "windows")]
fn subtitle_overlay_previous_wndproc() -> &'static Mutex<HashMap<isize, isize>> {
    SUBTITLE_OVERLAY_PREVIOUS_WNDPROC.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
fn subtitle_overlay_window_region_state(
) -> &'static Mutex<HashMap<isize, SubtitleOverlayRegionState>> {
    SUBTITLE_OVERLAY_WINDOW_REGION_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
fn subtitle_overlay_window_input_state() -> &'static Mutex<HashMap<isize, SubtitleOverlayInputState>>
{
    SUBTITLE_OVERLAY_WINDOW_INPUT_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
fn subtitle_overlay_input_hit_test(hwnd: isize, lparam: isize) -> Option<isize> {
    let input_state = subtitle_overlay_window_input_state()
        .lock()
        .ok()
        .and_then(|state| state.get(&hwnd).copied())?;

    let x = (lparam as u32 & 0xffff) as i16 as i32;
    let y = ((lparam as u32 >> 16) & 0xffff) as i16 as i32;
    let mut window_rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };

    unsafe {
        if GetWindowRect(hwnd as _, &mut window_rect) == 0 {
            return Some(HTCLIENT as isize);
        }
    }

    if !input_state.locked {
        return Some(HTCLIENT as isize);
    }

    let hotspot_left = window_rect.right - input_state.hotspot_width - input_state.hotspot_inset;
    let hotspot_top = window_rect.top + input_state.hotspot_inset;
    let hotspot_right = hotspot_left + input_state.hotspot_width;
    let hotspot_bottom = hotspot_top + input_state.hotspot_height;
    let inside_hotspot =
        x >= hotspot_left && x <= hotspot_right && y >= hotspot_top && y <= hotspot_bottom;

    if inside_hotspot {
        Some(HTCLIENT as isize)
    } else {
        Some(HTTRANSPARENT as isize)
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn subtitle_overlay_window_proc(
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    match message {
        WM_NCCALCSIZE | WM_NCPAINT => return 0,
        WM_NCACTIVATE => return 1,
        WM_NCHITTEST => {
            if let Some(result) = subtitle_overlay_input_hit_test(hwnd, lparam) {
                return result;
            }
        }
        _ => {}
    }

    let previous = subtitle_overlay_previous_wndproc()
        .lock()
        .ok()
        .and_then(|state| state.get(&hwnd).copied());

    if let Some(previous) = previous {
        return unsafe {
            #[allow(clippy::missing_transmute_annotations)]
            CallWindowProcW(
                Some(std::mem::transmute(previous)),
                hwnd as _,
                message,
                wparam,
                lparam,
            )
        };
    }

    unsafe { DefWindowProcW(hwnd as _, message, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn ensure_subtitle_overlay_subclass(hwnd: isize) {
    let Ok(mut state) = subtitle_overlay_previous_wndproc().lock() else {
        return;
    };

    if state.contains_key(&hwnd) {
        return;
    }

    let previous = unsafe {
        SetWindowLongPtrW(
            hwnd as _,
            GWLP_WNDPROC,
            subtitle_overlay_window_proc as *const () as usize as isize,
        )
    };
    if previous != 0 {
        state.insert(hwnd, previous);
    }
}

#[cfg(target_os = "windows")]
fn suppress_subtitle_overlay_dwm_frame(hwnd: isize) {
    let nc_rendering_policy = DWMNCRP_DISABLED;
    let no_border = DWMWA_COLOR_NONE;
    let no_backdrop = DWMSBT_NONE;

    unsafe {
        if DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_NCRENDERING_POLICY as u32,
            &nc_rendering_policy as *const _ as _,
            std::mem::size_of_val(&nc_rendering_policy) as u32,
        ) != 0
        {
            log::error!(
                "DwmSetWindowAttribute NCRENDERING_POLICY failed hwnd={}",
                hwnd
            );
        }
        if DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_BORDER_COLOR as u32,
            &no_border as *const _ as _,
            std::mem::size_of_val(&no_border) as u32,
        ) != 0
        {
            log::error!("DwmSetWindowAttribute BORDER_COLOR failed hwnd={}", hwnd);
        }
        if DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_CAPTION_COLOR as u32,
            &no_border as *const _ as _,
            std::mem::size_of_val(&no_border) as u32,
        ) != 0
        {
            log::error!("DwmSetWindowAttribute CAPTION_COLOR failed hwnd={}", hwnd);
        }
        if DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_TEXT_COLOR as u32,
            &no_border as *const _ as _,
            std::mem::size_of_val(&no_border) as u32,
        ) != 0
        {
            log::error!("DwmSetWindowAttribute TEXT_COLOR failed hwnd={}", hwnd);
        }
        if DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &no_backdrop as *const _ as _,
            std::mem::size_of_val(&no_backdrop) as u32,
        ) != 0
        {
            log::error!(
                "DwmSetWindowAttribute SYSTEMBACKDROP_TYPE failed hwnd={}",
                hwnd
            );
        }
    }
}

pub fn apply_subtitle_overlay_window_chrome(window: &WebviewWindow) -> Result<(), String> {
    let _ = window.set_title("");

    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        ensure_subtitle_overlay_subclass(hwnd.0 as _);
        let empty_title = [0u16];
        let style = unsafe { GetWindowLongW(hwnd.0 as _, GWL_STYLE) as u32 };
        let style_ex = unsafe { GetWindowLongW(hwnd.0 as _, GWL_EXSTYLE) as u32 };
        let next_style = (style | WS_POPUP)
            & !(WS_CAPTION
                | WS_SYSMENU
                | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX
                | WS_BORDER
                | WS_DLGFRAME
                | WS_SIZEBOX);
        let next_style_ex = (style_ex | WS_EX_TOOLWINDOW)
            & !(WS_EX_APPWINDOW
                | WS_EX_CLIENTEDGE
                | WS_EX_DLGMODALFRAME
                | WS_EX_STATICEDGE
                | WS_EX_WINDOWEDGE);
        let style_changed = style != next_style;
        let style_ex_changed = style_ex != next_style_ex;

        unsafe {
            SetWindowTextW(hwnd.0 as _, empty_title.as_ptr());
            if style_changed {
                SetWindowLongW(hwnd.0 as _, GWL_STYLE, next_style as i32);
            }
            if style_ex_changed {
                SetWindowLongW(hwnd.0 as _, GWL_EXSTYLE, next_style_ex as i32);
            }

            if style_changed || style_ex_changed {
                SetWindowPos(
                    hwnd.0 as _,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        }

        suppress_subtitle_overlay_dwm_frame(hwnd.0 as _);
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn update_window_click_through_style(hwnd: isize, enabled: bool) {
    let style_ex = unsafe { GetWindowLongW(hwnd as _, GWL_EXSTYLE) as u32 };
    let next_style_ex = if enabled {
        style_ex | WS_EX_TRANSPARENT | WS_EX_LAYERED
    } else {
        style_ex & !WS_EX_TRANSPARENT
        // We optionally keep WS_EX_LAYERED if it was already there, or we can strip it.
        // Some apps need WS_EX_LAYERED for alpha. Tauri usually uses WS_EX_LAYERED for transparent=true.
        // Let's just remove WS_EX_TRANSPARENT.
    };

    if style_ex == next_style_ex {
        return;
    }

    unsafe {
        SetWindowLongW(hwnd as _, GWL_EXSTYLE, next_style_ex as i32);
        SetWindowPos(
            hwnd as _,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

#[cfg(target_os = "windows")]
fn for_each_child_window(mut hwnd: isize, visit: &mut impl FnMut(isize)) {
    while hwnd != 0 {
        visit(hwnd);

        let child = unsafe { GetWindow(hwnd as _, GW_CHILD) };
        if !child.is_null() {
            for_each_child_window(child as isize, visit);
        }

        hwnd = unsafe { GetWindow(hwnd as _, GW_HWNDNEXT) } as isize;
    }
}

pub fn apply_subtitle_overlay_click_through(
    window: &WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        update_window_click_through_style(hwnd.0 as isize, enabled);
        let child = unsafe { GetWindow(hwnd.0 as _, GW_CHILD) };
        if !child.is_null() {
            let mut configure_child = |next_hwnd: isize| {
                ensure_subtitle_overlay_subclass(next_hwnd);
                unsafe {
                    EnableWindow(next_hwnd as _, if enabled { 0 } else { 1 });
                }
            };
            for_each_child_window(child as isize, &mut configure_child);
        }
    }

    Ok(())
}

pub fn apply_subtitle_overlay_region(window: &WebviewWindow, rounded: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        let width = size.width as i32 + 1;
        let height = size.height as i32 + 1;
        let corner_diameter = if rounded {
            ((SUBTITLE_OVERLAY_CORNER_RADIUS * 2.0) * scale_factor).round() as i32
        } else {
            0
        };
        let next_region_state = SubtitleOverlayRegionState {
            width,
            height,
            corner_diameter,
        };

        if subtitle_overlay_window_region_state()
            .lock()
            .ok()
            .and_then(|state| state.get(&(hwnd.0 as isize)).copied())
            == Some(next_region_state)
        {
            return Ok(());
        }

        let region = if rounded {
            unsafe { CreateRoundRectRgn(0, 0, width, height, corner_diameter, corner_diameter) }
        } else {
            unsafe { CreateRectRgn(0, 0, width, height) }
        };
        if region.is_null() {
            return Err("CreateRoundRectRgn failed".to_string());
        }

        let applied = unsafe { SetWindowRgn(hwnd.0 as _, region, 0) };
        if applied == 0 {
            unsafe {
                DeleteObject(region as _);
            }
            return Err("SetWindowRgn failed".to_string());
        }

        if let Ok(mut state) = subtitle_overlay_window_region_state().lock() {
            state.insert(hwnd.0 as isize, next_region_state);
        }
    }

    Ok(())
}

pub fn sync_subtitle_overlay_input_state(
    window: &WebviewWindow,
    locked: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        let next_input_state = SubtitleOverlayInputState {
            locked,
            hotspot_height: (SUBTITLE_OVERLAY_LOCK_HOTSPOT_HEIGHT * scale_factor).round() as i32,
            hotspot_inset: (SUBTITLE_OVERLAY_LOCK_HOTSPOT_INSET * scale_factor).round() as i32,
            hotspot_width: (SUBTITLE_OVERLAY_LOCK_HOTSPOT_WIDTH * scale_factor).round() as i32,
        };

        if let Ok(mut state) = subtitle_overlay_window_input_state().lock() {
            state.insert(hwnd.0 as isize, next_input_state);

            let child = unsafe { GetWindow(hwnd.0 as _, GW_CHILD) };
            if !child.is_null() {
                let mut sync_child_state = |next_hwnd: isize| {
                    state.insert(next_hwnd, next_input_state);
                    unsafe {
                        EnableWindow(next_hwnd as _, if locked { 0 } else { 1 });
                    }
                };
                for_each_child_window(child as isize, &mut sync_child_state);
            }
        }
    }

    Ok(())
}

pub fn apply_subtitle_overlay_background(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_background_color(Some(SUBTITLE_OVERLAY_BACKGROUND_COLOR))
        .map_err(|error| error.to_string())
}

pub fn ensure_subtitle_overlay_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if app.get_webview_window("subtitle-overlay").is_some() {
        let window = app
            .get_webview_window("subtitle-overlay")
            .expect("subtitle overlay window should exist");
        let _ = apply_subtitle_overlay_background(&window);
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        "subtitle-overlay",
        WebviewUrl::App("overlay.html".into()),
    )
    .title("")
    .visible(false)
    .always_on_top(true)
    .decorations(false)
    .transparent(true)
    .background_color(SUBTITLE_OVERLAY_BACKGROUND_COLOR)
    .skip_taskbar(true)
    .resizable(false)
    .inner_size(960.0, 220.0)
    .build()?;

    let _ = apply_subtitle_overlay_background(&window);
    let _ = apply_subtitle_overlay_click_through(&window, false);
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(false);
    let _ = window.set_shadow(false);
    let _ = apply_subtitle_overlay_window_chrome(&window);
    let _ = sync_subtitle_overlay_input_state(&window, false);
    let _ = apply_subtitle_overlay_region(&window, true);

    Ok(window)
}

pub fn collect_window_snapshots(app: &AppHandle) -> Vec<RuntimeWindowSnapshot> {
    app.webview_windows()
        .iter()
        .map(|(label, window)| RuntimeWindowSnapshot {
            label: label.clone(),
            title: window.title().unwrap_or_else(|_| label.clone()),
            kind: if label == "subtitle-overlay" {
                "subtitle-overlay".to_string()
            } else {
                "main".to_string()
            },
            visible: window.is_visible().unwrap_or(false),
            focused: window.is_focused().unwrap_or(false),
        })
        .collect()
}
