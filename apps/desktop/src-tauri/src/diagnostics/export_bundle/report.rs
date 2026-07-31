use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::logs::{LogFileSummary, LogTotals};
use super::{
    DiagnosticsExportScope, PayloadFileRecord, BUNDLE_SCHEMA_VERSION, REDACTION_POLICY,
};

pub(super) fn build_readable_report(
    generated_at: &str,
    scope: DiagnosticsExportScope,
    core_summary: &Value,
    log_files: &[LogFileSummary],
    log_totals: &LogTotals,
    redaction_count: u64,
    warnings: &[String],
    file_count: usize,
) -> String {
    let mut report = String::new();
    report.push_str("Omni Translate Diagnostics Report\n");
    report.push_str("=================================\n");
    report.push_str(&format!("Generated: {generated_at}\n"));
    report.push_str(&format!("Scope: {}\n", scope.as_str()));
    report.push_str(&format!("Files: {file_count}\n"));
    report.push_str(&format!("Privacy: {}\n\n", scope.privacy_notice()));
    report.push_str("Core status\n");
    report.push_str(&format!(
        "- Diagnostics: {}\n",
        report_value(core_summary, "/diagnostics/status")
    ));
    report.push_str(&format!(
        "- Runtime: {}\n",
        report_value(core_summary, "/runtime/coreState")
    ));
    report.push_str(&format!(
        "- Audio: {}\n",
        report_value(core_summary, "/audio/status")
    ));
    report.push_str(&format!(
        "- Bridge: {} (driver: {})\n",
        report_value(core_summary, "/bridge/bridgeState"),
        report_value(core_summary, "/bridge/driverHealth")
    ));
    report.push_str(&format!(
        "- Storage: {}\n\n",
        report_value(core_summary, "/storage/status")
    ));
    report.push_str("Logs\n");
    report.push_str(&format!(
        "- {} file(s), {} original bytes, {} exported bytes, {} exported lines\n",
        log_totals.file_count,
        log_totals.original_bytes,
        log_totals.exported_bytes,
        log_totals.exported_line_count
    ));
    report.push_str(&format!(
        "- {} file(s) truncated, {} credential-like value(s) redacted\n",
        log_totals.truncated_file_count, redaction_count
    ));
    for log in log_files {
        report.push_str(&format!(
            "- {}/{}: {} bytes, {} lines{}\n",
            log.source,
            log.name,
            log.exported_bytes,
            log.exported_line_count,
            if log.truncated { " (tail only)" } else { "" }
        ));
    }
    report.push('\n');
    report.push_str("Warnings\n");
    if warnings.is_empty() {
        report.push_str("- None\n");
    } else {
        for warning in warnings {
            report.push_str("- ");
            report.push_str(&warning.replace('\r', " ").replace('\n', " "));
            report.push('\n');
        }
    }
    report
}

fn report_value(value: &Value, pointer: &str) -> String {
    match value.pointer(pointer) {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => "unavailable".to_string(),
    }
}

pub(super) fn build_manifest_text(
    generated_at: &str,
    scope: DiagnosticsExportScope,
    payload_files: &[PayloadFileRecord],
    warnings: &[String],
    log_totals: &LogTotals,
    redaction_count: u64,
    file_count: usize,
    payload_bytes: u64,
) -> Result<String, String> {
    let mut manifest_bytes = 0u64;
    for _ in 0..16 {
        let manifest = json!({
            "schemaVersion": BUNDLE_SCHEMA_VERSION,
            "scope": scope.as_str(),
            "generatedAt": generated_at,
            "privacyNotice": scope.privacy_notice(),
            "redactionPolicy": REDACTION_POLICY,
            "payloadFiles": payload_files,
            "warnings": warnings,
            "totals": {
                "fileCount": file_count,
                "payloadFileCount": payload_files.len(),
                "payloadBytes": payload_bytes,
                "manifestBytes": manifest_bytes,
                "bundleBytes": payload_bytes + manifest_bytes,
                "redactionCount": redaction_count,
                "logFileCount": log_totals.file_count,
                "truncatedLogFileCount": log_totals.truncated_file_count,
                "originalLogBytes": log_totals.original_bytes,
                "exportedLogBytes": log_totals.exported_bytes,
                "originalLogLines": log_totals.original_line_count,
                "exportedLogLines": log_totals.exported_line_count,
            },
        });
        let manifest = crate::diagnostics::redaction::sanitize_value(manifest);
        let mut serialized = serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("failed to serialize bundle manifest: {error}"))?;
        serialized.push('\n');
        let next_size = serialized.len() as u64;
        if next_size == manifest_bytes {
            return Ok(serialized);
        }
        manifest_bytes = next_size;
    }
    Err("bundle manifest size did not stabilize".to_string())
}

pub(super) fn count_bundle_files(root: &Path) -> Result<(usize, u64), String> {
    fn visit(path: &Path, count: &mut usize, bytes: &mut u64) -> Result<(), String> {
        for entry in fs::read_dir(path)
            .map_err(|error| format!("failed to inspect completed diagnostics bundle: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("failed to inspect completed diagnostics entry: {error}"))?;
            let path = entry.path();
            if path.is_dir() {
                visit(&path, count, bytes)?;
            } else if path.is_file() {
                *count += 1;
                *bytes += entry
                    .metadata()
                    .map_err(|error| format!("failed to inspect diagnostics payload size: {error}"))?
                    .len();
            }
        }
        Ok(())
    }

    let mut count = 0;
    let mut bytes = 0;
    visit(root, &mut count, &mut bytes)?;
    Ok((count, bytes))
}
