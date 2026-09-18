use uuid::Uuid;

pub(crate) fn write_report_atomic(
    report_path: &str,
    report: &crate::audio::contracts::WatchSessionReportRuntime,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(report_path);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Watch report path has no file name: {report_path}"))?;
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.{}.tmp",
        Uuid::new_v4().simple()
    ));
    let result = (|| -> Result<(), String> {
        let json = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
        std::fs::write(&temporary_path, json).map_err(|error| error.to_string())?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&temporary_path, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

