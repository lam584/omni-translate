//! Windows OS authority for the release overlay click-through scenario.
//!
//! A dedicated Node runner reaches this command through the existing real
//! tauri-driver session. The command is environment-gated, uses the production
//! overlay window/input handlers, performs a real `WM_NCHITTEST` and `SendInput`
//! click against a separate native target process, and captures the actual
//! screen. It never accepts caller-authored result JSON.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{GetLastError, HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowThreadProcessId,
    IsWindow, IsWindowVisible, SendMessageW, SetForegroundWindow, ShowWindow, WindowFromPoint,
    HTTRANSPARENT, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    SW_RESTORE, WM_NCHITTEST,
};

use crate::runtime::events::sync_subtitle_overlay_window_state;

mod screenshot;

use screenshot::capture_screen_png;

const ENABLE_ENV: &str = "OMNI_OVERLAY_RELEASE_EVIDENCE";
const OUTPUT_ENV: &str = "OMNI_OVERLAY_RELEASE_EVIDENCE_OUTPUT_DIRECTORY";
const INVOCATION_ENV: &str = "OMNI_OVERLAY_RELEASE_EVIDENCE_INVOCATION_ID";
const SOURCE_HEAD_ENV: &str = "OMNI_RELEASE_EVIDENCE_HEAD_COMMIT";
const COLLECTOR_ID: &str = "omni-overlay-click-through-release-evidence";
const COLLECTOR_VERSION: &str = env!("CARGO_PKG_VERSION");

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn verified_authority_environment() -> Result<(PathBuf, String, String), String> {
    if env_value(ENABLE_ENV).as_deref() != Some("1") {
        return Err("overlay release evidence command is disabled".to_string());
    }
    let output = PathBuf::from(env_value(OUTPUT_ENV).ok_or_else(|| format!("{OUTPUT_ENV} is required"))?);
    if !output.is_absolute() || !output.is_dir() {
        return Err(format!("{OUTPUT_ENV} must be an existing absolute directory"));
    }
    let invocation_id = env_value(INVOCATION_ENV).ok_or_else(|| format!("{INVOCATION_ENV} is required"))?;
    Uuid::parse_str(&invocation_id)
        .map_err(|error| format!("{INVOCATION_ENV} must be a UUID: {error}"))?;
    let source_head_commit = env_value(SOURCE_HEAD_ENV)
        .ok_or_else(|| format!("{SOURCE_HEAD_ENV} is required"))?
        .to_ascii_lowercase();
    if source_head_commit.len() != 40
        || !source_head_commit.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err(format!("{SOURCE_HEAD_ENV} must be a 40-character Git commit"));
    }
    let compiled = option_env!("OMNI_BUILD_COMMIT")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "release Desktop has no compile-time OMNI_BUILD_COMMIT; rebuild it".to_string()
        })?
        .to_ascii_lowercase();
    if compiled != source_head_commit {
        return Err(format!(
            "release Desktop commit {compiled} does not match current clean HEAD {source_head_commit}"
        ));
    }
    Ok((output, invocation_id, source_head_commit))
}

fn rect_value(rect: RECT) -> Value {
    json!({
        "left": rect.left,
        "top": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    })
}

fn window_rect(hwnd: HWND, subject: &str) -> Result<RECT, String> {
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(format!("GetWindowRect({subject}) failed: {}", unsafe {
            GetLastError()
        }));
    }
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return Err(format!("{subject} window bounds are empty"));
    }
    Ok(rect)
}

fn client_screen_rect(hwnd: HWND) -> Result<RECT, String> {
    let mut client = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if unsafe { GetClientRect(hwnd, &mut client) } == 0 {
        return Err(format!("GetClientRect(target) failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut top_left = POINT { x: 0, y: 0 };
    let mut bottom_right = POINT {
        x: client.right,
        y: client.bottom,
    };
    if unsafe { ClientToScreen(hwnd, &mut top_left) } == 0
        || unsafe { ClientToScreen(hwnd, &mut bottom_right) } == 0
    {
        return Err(format!("ClientToScreen(target) failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(RECT {
        left: top_left.x,
        top: top_left.y,
        right: bottom_right.x,
        bottom: bottom_right.y,
    })
}

fn window_process_id(hwnd: HWND) -> u32 {
    let mut process_id = 0_u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
    process_id
}

fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

fn push_timeline(timeline: &mut Vec<Value>, event: &str, detail: Value) {
    timeline.push(json!({
        "event": event,
        "sequence": timeline.len() + 1,
        "observedAt": now(),
        "detail": detail,
    }));
}

fn position_overlay(
    overlay: &tauri::WebviewWindow,
    target_client: RECT,
) -> Result<(), String> {
    let target_width = target_client.right - target_client.left;
    let target_height = target_client.bottom - target_client.top;
    if target_width < 420 || target_height < 260 {
        return Err(format!(
            "target client area must be at least 420x260; got {target_width}x{target_height}"
        ));
    }
    let width = target_width.clamp(420, 720);
    let height = target_height.clamp(180, 240);
    let left = target_client.left + (target_width - width) / 2;
    let top = target_client.top + (target_height - height) / 2;
    overlay
        .set_position(PhysicalPosition::new(left, top))
        .map_err(|error| error.to_string())?;
    overlay
        .set_size(PhysicalSize::new(width as u32, height as u32))
        .map_err(|error| error.to_string())?;
    overlay
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn hit_test_lparam(point: POINT) -> Result<isize, String> {
    if point.x < i16::MIN as i32
        || point.x > i16::MAX as i32
        || point.y < i16::MIN as i32
        || point.y > i16::MAX as i32
    {
        return Err("click point is outside WM_NCHITTEST signed-16 coordinate range".to_string());
    }
    Ok((((point.y as i16 as u16 as u32) << 16) | point.x as i16 as u16 as u32) as isize)
}

fn send_real_click(point: POINT) -> Result<u32, String> {
    let virtual_left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let virtual_top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if virtual_width <= 1 || virtual_height <= 1 {
        return Err("virtual screen metrics are invalid".to_string());
    }
    let point_x = i64::from(point.x);
    let point_y = i64::from(point.y);
    let virtual_left = i64::from(virtual_left);
    let virtual_top = i64::from(virtual_top);
    let virtual_width = i64::from(virtual_width);
    let virtual_height = i64::from(virtual_height);
    if point_x < virtual_left
        || point_x >= virtual_left + virtual_width
        || point_y < virtual_top
        || point_y >= virtual_top + virtual_height
    {
        return Err("click point is outside the Windows virtual screen".to_string());
    }
    let absolute_x = (((point_x - virtual_left) * 65_535_i64) / (virtual_width - 1)) as i32;
    let absolute_y = (((point_y - virtual_top) * 65_535_i64) / (virtual_height - 1)) as i32;
    let mouse_input = |flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: absolute_x,
                dy: absolute_y,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [
        mouse_input(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
        mouse_input(MOUSEEVENTF_LEFTDOWN),
        mouse_input(MOUSEEVENTF_LEFTUP),
    ];
    let inserted = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if inserted != inputs.len() as u32 {
        return Err(format!(
            "SendInput inserted {inserted}/{} events: {}",
            inputs.len(),
            unsafe { GetLastError() }
        ));
    }
    Ok(inserted)
}

fn wait_for_target_click(
    path: &Path,
    invocation_id: &str,
    source_head_commit: &str,
    target_process_id: u32,
    target_hwnd: isize,
    click_point: POINT,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if path.is_file() {
            let value = read_json(path)?;
            if value.get("artifactKind").and_then(Value::as_str)
                != Some("overlay-click-target-receipt")
                || value.get("invocationId").and_then(Value::as_str) != Some(invocation_id)
                || value.get("sourceHeadCommit").and_then(Value::as_str)
                    != Some(source_head_commit)
                || value.get("buildCommit").and_then(Value::as_str) != Some(source_head_commit)
                || value.get("processId").and_then(Value::as_u64)
                    != Some(u64::from(target_process_id))
                || value.get("hwnd").and_then(Value::as_i64) != Some(target_hwnd as i64)
                || value
                    .get("screenPoint")
                    .and_then(|point| point.get("x"))
                    .and_then(Value::as_i64)
                    != Some(i64::from(click_point.x))
                || value
                    .get("screenPoint")
                    .and_then(|point| point.get("y"))
                    .and_then(Value::as_i64)
                    != Some(i64::from(click_point.y))
                || value.get("message").and_then(Value::as_str) != Some("WM_LBUTTONDOWN")
                || value.get("clickCount").and_then(Value::as_u64) != Some(1)
            {
                return Err("target click receipt does not match the real SendInput click".to_string());
            }
            return Ok(value);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("target process did not publish a WM_LBUTTONDOWN receipt within 5 seconds".to_string())
}

fn collect_sync(
    app: AppHandle,
    target_process_id: u32,
    target_hwnd_value: isize,
) -> Result<Value, String> {
    let (output_directory, invocation_id, source_head_commit) = verified_authority_environment()?;
    if target_process_id == 0 || target_hwnd_value == 0 {
        return Err("target PID and HWND must be non-zero".to_string());
    }
    let target_hwnd = target_hwnd_value as HWND;
    if unsafe { IsWindow(target_hwnd) } == 0 || unsafe { IsWindowVisible(target_hwnd) } == 0 {
        return Err("target HWND must be a real visible window".to_string());
    }
    if window_process_id(target_hwnd) != target_process_id {
        return Err("target HWND does not belong to the target process ID".to_string());
    }
    let desktop_process_id = std::process::id();
    if target_process_id == desktop_process_id {
        return Err("target process must differ from the Desktop process".to_string());
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "production Desktop main window is unavailable".to_string())?;
    let overlay = app
        .get_webview_window("subtitle-overlay")
        .ok_or_else(|| "production subtitle overlay window is unavailable".to_string())?;
    let main_hwnd = main.hwnd().map_err(|error| error.to_string())?.0;
    let overlay_hwnd = overlay.hwnd().map_err(|error| error.to_string())?.0;
    if main_hwnd.is_null() || overlay_hwnd.is_null() || main_hwnd == overlay_hwnd {
        return Err("Desktop main and overlay HWNDs must be real and distinct".to_string());
    }
    if window_process_id(main_hwnd) != desktop_process_id
        || window_process_id(overlay_hwnd) != desktop_process_id
    {
        return Err("Desktop main/overlay HWND ownership is invalid".to_string());
    }

    let mut timeline = Vec::new();
    push_timeline(
        &mut timeline,
        "authority-started",
        json!({ "invocationId": invocation_id }),
    );
    let target_bounds = window_rect(target_hwnd, "target")?;
    let target_client = client_screen_rect(target_hwnd)?;
    let target_ready = read_json(&output_directory.join("target-ready.json"))?;
    if target_ready.get("processId").and_then(Value::as_u64)
        != Some(u64::from(target_process_id))
        || target_ready.get("hwnd").and_then(Value::as_i64) != Some(target_hwnd_value as i64)
        || target_ready.get("invocationId").and_then(Value::as_str) != Some(&invocation_id)
        || target_ready.get("sourceHeadCommit").and_then(Value::as_str)
            != Some(&source_head_commit)
        || target_ready.get("buildCommit").and_then(Value::as_str)
            != Some(&source_head_commit)
    {
        return Err("target-ready.json does not match the live target process/window".to_string());
    }
    push_timeline(
        &mut timeline,
        "target-validated",
        json!({ "processId": target_process_id, "hwnd": target_hwnd_value }),
    );

    position_overlay(&overlay, target_client)?;
    sync_subtitle_overlay_window_state(app.clone(), true, true, false)?;
    std::thread::sleep(Duration::from_millis(300));
    if unsafe { IsWindowVisible(overlay_hwnd) } == 0 {
        return Err("production overlay is not visible after the WebDriver show handler".to_string());
    }
    let overlay_bounds = window_rect(overlay_hwnd, "overlay")?;
    let main_bounds = window_rect(main_hwnd, "main")?;
    let click_point = POINT {
        x: overlay_bounds.left + (overlay_bounds.right - overlay_bounds.left) / 3,
        y: overlay_bounds.top + (overlay_bounds.bottom - overlay_bounds.top) / 2,
    };
    if click_point.x < target_client.left
        || click_point.x >= target_client.right
        || click_point.y < target_client.top
        || click_point.y >= target_client.bottom
    {
        return Err("computed click point is not inside the target client area".to_string());
    }
    push_timeline(
        &mut timeline,
        "overlay-shown-locked",
        json!({ "hwnd": overlay_hwnd as isize, "bounds": rect_value(overlay_bounds) }),
    );

    let hit_test_code = unsafe {
        SendMessageW(
            overlay_hwnd,
            WM_NCHITTEST,
            0,
            hit_test_lparam(click_point)?,
        )
    };
    if hit_test_code != HTTRANSPARENT as isize {
        return Err(format!(
            "locked production overlay returned hit-test {hit_test_code}, expected HTTRANSPARENT"
        ));
    }
    let window_from_point = unsafe { WindowFromPoint(click_point) };
    push_timeline(
        &mut timeline,
        "hit-test-observed",
        json!({
            "message": "WM_NCHITTEST",
            "result": "HTTRANSPARENT",
            "resultCode": hit_test_code,
            "windowFromPointHwnd": window_from_point as isize,
        }),
    );

    unsafe {
        ShowWindow(target_hwnd, SW_RESTORE);
        SetForegroundWindow(target_hwnd);
    }
    let focus_deadline = Instant::now() + Duration::from_secs(2);
    while unsafe { GetForegroundWindow() } != target_hwnd && Instant::now() < focus_deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    let foreground_before = unsafe { GetForegroundWindow() };
    if foreground_before != target_hwnd {
        return Err("target window could not become foreground before the real click".to_string());
    }
    push_timeline(
        &mut timeline,
        "target-foreground-before-click",
        json!({ "hwnd": foreground_before as isize }),
    );

    let inserted = send_real_click(click_point)?;
    push_timeline(
        &mut timeline,
        "send-input-click",
        json!({ "requested": 3, "inserted": inserted, "point": { "x": click_point.x, "y": click_point.y } }),
    );
    let target_click = wait_for_target_click(
        &output_directory.join("target-click.json"),
        &invocation_id,
        &source_head_commit,
        target_process_id,
        target_hwnd_value,
        click_point,
    )?;
    push_timeline(
        &mut timeline,
        "target-click-received",
        json!({ "message": "WM_LBUTTONDOWN", "clickCount": 1 }),
    );
    let foreground_after = unsafe { GetForegroundWindow() };
    if foreground_after != target_hwnd || foreground_after == overlay_hwnd {
        return Err("foreground did not remain on the target after click-through".to_string());
    }
    push_timeline(
        &mut timeline,
        "target-foreground-confirmed",
        json!({ "hwnd": foreground_after as isize, "overlayActivated": false }),
    );

    let screenshot_path = output_directory.join("overlay-click-through.png");
    let screenshot = capture_screen_png(&screenshot_path, overlay_bounds)?;
    push_timeline(
        &mut timeline,
        "screenshot-captured",
        json!({ "sha256": screenshot.sha256, "width": screenshot.width, "height": screenshot.height }),
    );
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(json!({
        "schemaVersion": 1,
        "artifactKind": "overlay-os-click-through-probe",
        "collectorId": COLLECTOR_ID,
        "collectorVersion": COLLECTOR_VERSION,
        "productionMode": true,
        "passed": true,
        "capturedAt": now(),
        "invocationId": invocation_id,
        "sourceHeadCommit": source_head_commit,
        "desktopBuildCommit": option_env!("OMNI_BUILD_COMMIT")
            .expect("verified_authority_environment requires a compiled build commit"),
        "desktopProcessId": desktop_process_id,
        "desktopExecutable": executable,
        "desktopExecutableSha256": hash_file(&executable)?,
        "mainHwnd": main_hwnd as isize,
        "mainBounds": rect_value(main_bounds),
        "overlayHwnd": overlay_hwnd as isize,
        "overlayBounds": rect_value(overlay_bounds),
        "overlayLocked": true,
        "overlayVisible": true,
        "targetProcessId": target_process_id,
        "targetHwnd": target_hwnd_value,
        "targetBounds": rect_value(target_bounds),
        "targetClientBounds": rect_value(target_client),
        "hitTestMessage": "WM_NCHITTEST",
        "hitTestResult": "HTTRANSPARENT",
        "hitTestResultCode": hit_test_code,
        "windowFromPointHwnd": window_from_point as isize,
        "clickPoint": { "x": click_point.x, "y": click_point.y },
        "sendInput": { "requested": 3, "inserted": inserted },
        "foregroundBeforeHwnd": foreground_before as isize,
        "foregroundAfterHwnd": foreground_after as isize,
        "overlayActivatedAfterClick": false,
        "targetReady": target_ready,
        "targetClick": target_click,
        "screenshot": "overlay-click-through.png",
        "screenshotSha256": screenshot.sha256,
        "screenshotByteCount": screenshot.byte_count,
        "screenshotWidth": screenshot.width,
        "screenshotHeight": screenshot.height,
        "eventTimeline": timeline,
    }))
}

#[tauri::command]
pub(crate) async fn collect_overlay_click_through_release_evidence(
    app: AppHandle,
    target_process_id: u32,
    target_hwnd: isize,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        collect_sync(app, target_process_id, target_hwnd)
    })
    .await
    .map_err(|error| format!("overlay authority worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{hit_test_lparam, rect_value};
    use windows_sys::Win32::Foundation::{POINT, RECT};

    #[test]
    fn hit_test_lparam_preserves_signed_screen_coordinates() {
        let value = hit_test_lparam(POINT { x: -25, y: 240 }).unwrap() as u32;
        assert_eq!((value & 0xffff) as u16 as i16, -25);
        assert_eq!((value >> 16) as u16 as i16, 240);
    }

    #[test]
    fn rect_contract_uses_origin_and_positive_extent() {
        assert_eq!(
            rect_value(RECT {
                left: 10,
                top: 20,
                right: 650,
                bottom: 240,
            }),
            serde_json::json!({ "left": 10, "top": 20, "width": 640, "height": 220 })
        );
    }
}
