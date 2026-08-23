use serde::Serialize;
use std::process::Command;
use tauri::{AppHandle, Manager};
use url::Url;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::ShellExecuteW;
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportArtifactReceipt {
    output_path: String,
    file_count: usize,
}

pub(crate) fn open_export_directory(output_path: &str) -> Result<(), String> {
    let target = std::fs::canonicalize(output_path)
        .map_err(|error| format!("export artifact path is unavailable: {error}"))?;
    let argument = if target.is_file() {
        format!("/select,{}", target.display())
    } else {
        target.display().to_string()
    };
    Command::new("explorer.exe")
        .arg(argument)
        .spawn()
        .map_err(|error| format!("failed to open export directory: {error}"))?;
    Ok(())
}

pub(crate) fn open_external_url(url: &str) -> Result<(), String> {
    let url = validate_external_url(url)?;
    open_validated_external_url(url.as_str())
}

fn validate_external_url(value: &str) -> Result<Url, String> {
    if value.chars().any(char::is_control) {
        return Err("refusing to open a URL containing control characters".to_string());
    }
    let parsed = Url::parse(value).map_err(|error| format!("invalid external URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("refusing to open a non-HTTP(S) URL".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("refusing to open a URL containing embedded credentials".to_string());
    }
    Ok(parsed)
}

#[cfg(windows)]
fn open_validated_external_url(url: &str) -> Result<(), String> {
    let operation = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(format!(
            "failed to open external URL (ShellExecuteW={})",
            result as isize
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_validated_external_url(_url: &str) -> Result<(), String> {
    Err("opening external URLs is only supported on Windows".to_string())
}

pub(crate) fn write_export_artifact<R: tauri::Runtime>(
    app: &AppHandle<R>,
    filename: &str,
    content: &str,
) -> Result<ExportArtifactReceipt, String> {
    let safe_name = std::path::Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "export filename is invalid".to_string())?;
    let export_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?
        .join("exports");
    std::fs::create_dir_all(&export_dir)
        .map_err(|error| format!("failed to create export directory: {error}"))?;
    let output_path = export_dir.join(safe_name);
    std::fs::write(&output_path, content.as_bytes())
        .map_err(|error| format!("failed to write export artifact: {error}"))?;
    Ok(ExportArtifactReceipt {
        output_path: output_path.display().to_string(),
        file_count: 1,
    })
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn external_url_validation_accepts_only_safe_http_urls() {
        assert!(validate_external_url("https://example.test/docs?q=a&lang=zh").is_ok());
        assert!(validate_external_url("http://127.0.0.1:8080/status").is_ok());
        assert!(validate_external_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(validate_external_url("https://user:secret@example.test/").is_err());
        assert!(validate_external_url("https://example.test/\ncalc.exe").is_err());
        assert!(validate_external_url("not a url").is_err());
    }
}
