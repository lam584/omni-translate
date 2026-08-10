#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("omni-overlay-click-target requires Windows");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
mod windows_target {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::OnceLock;

    use chrono::{SecondsFormat, Utc};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use uuid::Uuid;
    use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, UpdateWindow};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        GetForegroundWindow, GetMessageW, GetWindowRect, PostQuitMessage, RegisterClassW,
        ShowWindow, TranslateMessage, CREATESTRUCTW, MSG,
        SW_SHOW, WM_CLOSE, WM_CREATE, WM_DESTROY, WM_LBUTTONDOWN, WNDCLASSW,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    const COLLECTOR_ID: &str = "omni-overlay-click-target";
    const COLLECTOR_VERSION: &str = env!("CARGO_PKG_VERSION");
    const READY_FILE: &str = "target-ready.json";
    const CLICK_FILE: &str = "target-click.json";

    #[derive(Clone)]
    struct TargetContext {
        output_directory: PathBuf,
        invocation_id: String,
        source_head_commit: String,
        build_commit: String,
        executable_path: String,
        executable_sha256: String,
        window_title: String,
    }

    static TARGET_CONTEXT: OnceLock<TargetContext> = OnceLock::new();
    static CLICK_COUNT: AtomicU32 = AtomicU32::new(0);

    fn now() -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn utf16(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn hash_file(path: &Path) -> Result<String, String> {
        let bytes = fs::read(path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }

    fn write_json_atomic(path: &Path, value: &serde_json::Value) -> Result<(), String> {
        let temporary = path.with_extension("partial");
        if path.exists() || temporary.exists() {
            return Err(format!("target receipt already exists: {}", path.display()));
        }
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        fs::write(&temporary, bytes)
            .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("failed to publish {}: {error}", path.display()))
    }

    fn rect_json(rect: RECT) -> serde_json::Value {
        json!({
            "left": rect.left,
            "top": rect.top,
            "width": rect.right - rect.left,
            "height": rect.bottom - rect.top,
        })
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_CREATE => {
                let _ = lparam as *const CREATESTRUCTW;
                0
            }
            WM_LBUTTONDOWN => {
                let count = CLICK_COUNT.fetch_add(1, Ordering::AcqRel) + 1;
                if count == 1 {
                    if let Some(context) = TARGET_CONTEXT.get() {
                        let client_x = (lparam as u32 & 0xffff) as i16 as i32;
                        let client_y = ((lparam as u32 >> 16) & 0xffff) as i16 as i32;
                        let mut screen = POINT { x: client_x, y: client_y };
                        let mut bounds = RECT {
                            left: 0,
                            top: 0,
                            right: 0,
                            bottom: 0,
                        };
                        unsafe {
                            ClientToScreen(hwnd, &mut screen);
                            GetWindowRect(hwnd, &mut bounds);
                        }
                        let _ = write_json_atomic(
                            &context.output_directory.join(CLICK_FILE),
                            &json!({
                                "schemaVersion": 1,
                                "artifactKind": "overlay-click-target-receipt",
                                "collectorId": COLLECTOR_ID,
                                "collectorVersion": COLLECTOR_VERSION,
                                "invocationId": context.invocation_id,
                                "sourceHeadCommit": context.source_head_commit,
                                "buildCommit": context.build_commit,
                                "receivedAt": now(),
                                "processId": std::process::id(),
                                "hwnd": hwnd as isize,
                                "windowTitle": context.window_title,
                                "windowBounds": rect_json(bounds),
                                "message": "WM_LBUTTONDOWN",
                                "messageCode": WM_LBUTTONDOWN,
                                "clickCount": count,
                                "clientPoint": { "x": client_x, "y": client_y },
                                "screenPoint": { "x": screen.x, "y": screen.y },
                                "foregroundHwndAtReceipt": unsafe { GetForegroundWindow() } as isize,
                            }),
                        );
                    }
                }
                0
            }
            WM_CLOSE => {
                unsafe { DestroyWindow(hwnd) };
                0
            }
            WM_DESTROY => {
                unsafe { PostQuitMessage(0) };
                0
            }
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    fn parse_args() -> Result<(PathBuf, String, String), String> {
        let mut output_directory = None;
        let mut invocation_id = None;
        let mut source_head_commit = None;
        let mut args = std::env::args().skip(1);
        while let Some(argument) = args.next() {
            let value = args
                .next()
                .ok_or_else(|| format!("{argument} requires a value"))?;
            match argument.as_str() {
                "--output-directory" => output_directory = Some(PathBuf::from(value)),
                "--invocation-id" => invocation_id = Some(value),
                "--source-head-commit" => source_head_commit = Some(value),
                _ => return Err(format!("unsupported argument: {argument}")),
            }
        }
        let output_directory = output_directory
            .ok_or_else(|| "--output-directory is required".to_string())?;
        if !output_directory.is_absolute() {
            return Err("--output-directory must be absolute".to_string());
        }
        fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;
        let invocation_id = invocation_id.ok_or_else(|| "--invocation-id is required".to_string())?;
        Uuid::parse_str(&invocation_id)
            .map_err(|error| format!("--invocation-id must be a UUID: {error}"))?;
        let source_head_commit = source_head_commit
            .ok_or_else(|| "--source-head-commit is required".to_string())?
            .to_ascii_lowercase();
        if source_head_commit.len() != 40
            || !source_head_commit.bytes().all(|value| value.is_ascii_hexdigit())
        {
            return Err("--source-head-commit must be a 40-character Git commit".to_string());
        }
        let compiled = option_env!("OMNI_BUILD_COMMIT")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "overlay target binary has no compile-time OMNI_BUILD_COMMIT".to_string()
            })?
            .to_ascii_lowercase();
        if compiled != source_head_commit {
            return Err(format!(
                "overlay target binary commit {compiled} does not match {source_head_commit}"
            ));
        }
        Ok((output_directory, invocation_id, source_head_commit))
    }

    fn run() -> Result<(), String> {
        let (output_directory, invocation_id, source_head_commit) = parse_args()?;
        for name in [READY_FILE, CLICK_FILE] {
            if output_directory.join(name).exists() {
                return Err(format!("target output already exists: {name}"));
            }
        }
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let window_title = format!(
            "Omni Overlay Click Target {}",
            invocation_id.chars().take(8).collect::<String>()
        );
        TARGET_CONTEXT
            .set(TargetContext {
                output_directory: output_directory.clone(),
                invocation_id: invocation_id.clone(),
                source_head_commit: source_head_commit.clone(),
                build_commit: source_head_commit.clone(),
                executable_path: executable.to_string_lossy().to_string(),
                executable_sha256: hash_file(&executable)?,
                window_title: window_title.clone(),
            })
            .map_err(|_| "target context was already initialized".to_string())?;

        let class_name = utf16(&format!("OmniOverlayClickTarget.{invocation_id}"));
        let title = utf16(&window_title);
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        if instance.is_null() {
            return Err(format!("GetModuleHandleW failed: {}", unsafe {
                GetLastError()
            }));
        }
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: (6_isize) as _,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        if unsafe { RegisterClassW(&window_class) } == 0 {
            return Err(format!("RegisterClassW failed: {}", unsafe {
                GetLastError()
            }));
        }
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                240,
                220,
                760,
                420,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            return Err(format!("CreateWindowExW failed: {}", unsafe {
                GetLastError()
            }));
        }
        unsafe {
            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);
        }
        let mut bounds = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut bounds) } == 0 {
            return Err(format!("GetWindowRect failed: {}", unsafe {
                GetLastError()
            }));
        }
        let context = TARGET_CONTEXT.get().expect("target context initialized");
        write_json_atomic(
            &output_directory.join(READY_FILE),
            &json!({
                "schemaVersion": 1,
                "artifactKind": "overlay-click-target-ready",
                "collectorId": COLLECTOR_ID,
                "collectorVersion": COLLECTOR_VERSION,
                "invocationId": invocation_id,
                "sourceHeadCommit": source_head_commit,
                "buildCommit": context.build_commit,
                "capturedAt": now(),
                "processId": std::process::id(),
                "hwnd": hwnd as isize,
                "windowTitle": window_title,
                "windowBounds": rect_json(bounds),
                "executablePath": context.executable_path,
                "executableSha256": context.executable_sha256,
            }),
        )?;

        let mut message: MSG = unsafe { std::mem::zeroed() };
        loop {
            let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
            if result == -1 {
                return Err(format!("GetMessageW failed: {}", unsafe {
                    GetLastError()
                }));
            }
            if result == 0 {
                break;
            }
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        Ok(())
    }

    pub(super) fn main() {
        if let Err(error) = run() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(target_os = "windows")]
fn main() {
    windows_target::main();
}
