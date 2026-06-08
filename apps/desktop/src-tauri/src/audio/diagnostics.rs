use tauri::AppHandle;

use crate::diagnostics::events::append_diagnostics_log;

/// Simplified diagnostics log with no detail, source, or elapsed_ms.
pub fn diag_log(app: &AppHandle, category: &str, level: &str, summary: impl Into<String>) {
    let _ = append_diagnostics_log(app, category, level, summary, None, None, None);
}

/// Simplified diagnostics log with detail but no source or elapsed_ms.
pub fn diag_log_detail(
    app: &AppHandle,
    category: &str,
    level: &str,
    summary: impl Into<String>,
    detail: impl Into<String>,
) {
    let _ = append_diagnostics_log(
        app,
        category,
        level,
        summary,
        Some(detail.into()),
        None,
        None,
    );
}
