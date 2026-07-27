use serde::Serialize;
use std::process::Command;
use tauri::{AppHandle, Manager};

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
