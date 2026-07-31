use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{write_text_payload, DiagnosticsExportScope, PayloadFileRecord};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LogTotals {
    pub(super) file_count: usize,
    pub(super) truncated_file_count: usize,
    pub(super) redaction_count: u64,
    pub(super) original_bytes: u64,
    pub(super) exported_bytes: u64,
    pub(super) original_line_count: u64,
    pub(super) exported_line_count: u64,
    pub(super) level_stats: BTreeMap<String, u64>,
    pub(super) category_stats: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LogFileSummary {
    pub(super) source: String,
    pub(super) name: String,
    pub(super) output_path: String,
    pub(super) original_bytes: u64,
    pub(super) exported_bytes: u64,
    pub(super) original_line_count: u64,
    pub(super) exported_line_count: u64,
    pub(super) redaction_count: u64,
    pub(super) truncated: bool,
    pub(super) level_stats: BTreeMap<String, u64>,
    pub(super) category_stats: BTreeMap<String, u64>,
}

#[derive(Clone, Debug)]
struct LogCandidate {
    source: &'static str,
    priority: u8,
    path: PathBuf,
}

pub(super) fn export_logs(
    staging_dir: &Path,
    scope: DiagnosticsExportScope,
    logs_dir: &Path,
    bridge_runtime_root: &Path,
    warnings: &mut Vec<String>,
    payload_files: &mut Vec<PayloadFileRecord>,
) -> Result<(Vec<LogFileSummary>, LogTotals), String> {
    let candidates = collect_log_candidates(logs_dir, bridge_runtime_root, warnings);
    let mut summaries = Vec::new();
    let mut totals = LogTotals::default();
    let mut used_output_paths = BTreeSet::new();

    for candidate in candidates {
        let raw = match fs::read(&candidate.path) {
            Ok(raw) => raw,
            Err(error) => {
                warnings.push(format!(
                    "Failed to read {} log `{}`: {error}",
                    candidate.source,
                    candidate
                        .path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("unknown")
                ));
                continue;
            }
        };
        let valid_utf8 = std::str::from_utf8(&raw).is_ok();
        let original_text = String::from_utf8_lossy(&raw).into_owned();
        if !valid_utf8 {
            warnings.push(format!(
                "Log `{}` contained invalid UTF-8 and was converted lossily.",
                candidate
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown")
            ));
        }
        let original_line_count = count_lines(&original_text);
        let (redacted, redaction_count) = redact_log_text(&original_text);
        let (exported, truncated) = match scope.log_tail_limit() {
            Some(limit) => {
                let truncated = redacted.len() > limit;
                (tail_utf8(&redacted, limit), truncated)
            }
            None => (redacted, false),
        };
        let exported_line_count = count_lines(&exported);
        let (level_stats, category_stats) = log_stats(&exported);

        let filename = candidate
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.log");
        let relative_path =
            unique_log_output_path(candidate.source, filename, &mut used_output_paths);
        write_text_payload(
            staging_dir,
            &relative_path,
            "redacted-log",
            &exported,
            payload_files,
        )?;

        merge_stats(&mut totals.level_stats, &level_stats);
        merge_stats(&mut totals.category_stats, &category_stats);
        totals.file_count += 1;
        totals.truncated_file_count += usize::from(truncated);
        totals.redaction_count += redaction_count;
        totals.original_bytes += raw.len() as u64;
        totals.exported_bytes += exported.len() as u64;
        totals.original_line_count += original_line_count;
        totals.exported_line_count += exported_line_count;
        summaries.push(LogFileSummary {
            source: candidate.source.to_string(),
            name: filename.to_string(),
            output_path: relative_path,
            original_bytes: raw.len() as u64,
            exported_bytes: exported.len() as u64,
            original_line_count,
            exported_line_count,
            redaction_count,
            truncated,
            level_stats,
            category_stats,
        });
    }

    if summaries.is_empty() {
        warnings.push("No diagnostic log files were available for export.".to_string());
    }
    Ok((summaries, totals))
}

fn collect_log_candidates(
    logs_dir: &Path,
    bridge_runtime_root: &Path,
    warnings: &mut Vec<String>,
) -> Vec<LogCandidate> {
    let mut raw_candidates = Vec::new();
    collect_log_root(logs_dir, "desktop", 0, warnings, &mut raw_candidates);
    collect_log_root(
        bridge_runtime_root,
        "bridge",
        1,
        warnings,
        &mut raw_candidates,
    );
    raw_candidates.sort_by(|left, right| {
        left.priority.cmp(&right.priority).then_with(|| {
            left.path
                .to_string_lossy()
                .to_ascii_lowercase()
                .cmp(&right.path.to_string_lossy().to_ascii_lowercase())
        })
    });

    let mut canonical_paths = BTreeSet::new();
    let mut candidates = Vec::new();
    for candidate in raw_candidates {
        let canonical = match fs::canonicalize(&candidate.path) {
            Ok(path) => path,
            Err(error) => {
                warnings.push(format!(
                    "Failed to resolve log `{}`: {error}",
                    candidate
                        .path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("unknown")
                ));
                continue;
            }
        };
        let canonical_key = if cfg!(windows) {
            canonical.to_string_lossy().to_ascii_lowercase()
        } else {
            canonical.to_string_lossy().to_string()
        };
        if !canonical_paths.insert(canonical_key) {
            warnings.push(format!(
                "Skipped duplicate log source `{}`.",
                candidate
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown")
            ));
            continue;
        }
        candidates.push(LogCandidate {
            path: canonical,
            ..candidate
        });
    }
    candidates
}

fn collect_log_root(
    root: &Path,
    source: &'static str,
    priority: u8,
    warnings: &mut Vec<String>,
    candidates: &mut Vec<LogCandidate>,
) {
    if root.as_os_str().is_empty() {
        warnings.push(format!(
            "The {source} log root was empty; this source was skipped."
        ));
        return;
    }
    if !root.exists() {
        warnings.push(format!(
            "The {source} log root was unavailable; this source was skipped."
        ));
        return;
    }
    if !root.is_dir() {
        warnings.push(format!(
            "The {source} log root was not a directory; this source was skipped."
        ));
        return;
    }

    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("Failed to enumerate the {source} log root: {error}"));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!("Failed to inspect a {source} log entry: {error}"));
                continue;
            }
        };
        let path = entry.path();
        if path.is_file() && is_log_candidate(&path) {
            candidates.push(LogCandidate {
                source,
                priority,
                path,
            });
        }
    }
}

fn is_log_candidate(path: &Path) -> bool {
    let Some(filename) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let filename = filename.to_ascii_lowercase();
    filename.ends_with(".log")
        || (filename.contains("panic")
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "txt" | "log"))
                .unwrap_or(true))
}

fn unique_log_output_path(
    source: &str,
    filename: &str,
    used_paths: &mut BTreeSet<String>,
) -> String {
    let base = format!("logs/{source}/{filename}");
    if used_paths.insert(base.to_ascii_lowercase()) {
        return base;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("log");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("log");
    for suffix in 2.. {
        let candidate = format!("logs/{source}/{stem}-{suffix}.{extension}");
        if used_paths.insert(candidate.to_ascii_lowercase()) {
            return candidate;
        }
    }
    unreachable!("unbounded numeric suffix must yield a unique log path")
}

pub(super) fn redact_log_text(input: &str) -> (String, u64) {
    crate::diagnostics::redaction::sanitize_text_with_count(input)
}

fn tail_utf8(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut start = text.len() - limit;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

fn count_lines(text: &str) -> u64 {
    text.lines().count() as u64
}

fn log_stats(text: &str) -> (BTreeMap<String, u64>, BTreeMap<String, u64>) {
    let mut levels = BTreeMap::new();
    let mut categories = BTreeMap::new();
    for line in text.lines() {
        let Some((level, category)) = parse_level_category(line) else {
            continue;
        };
        *levels.entry(level).or_insert(0) += 1;
        *categories.entry(category).or_insert(0) += 1;
    }
    (levels, categories)
}

fn parse_level_category(line: &str) -> Option<(String, String)> {
    let level_start = line.find('[')? + 1;
    let level_end = line[level_start..].find(']')? + level_start;
    let level = &line[level_start..level_end];
    if !matches!(
        level,
        "ERROR" | "WARNING" | "NORMAL" | "INFO" | "DEBUG" | "TRACE" | "VERBOSE"
    ) {
        return None;
    }
    let category_start = line[level_end + 1..].find('[')? + level_end + 2;
    let category_end = line[category_start..].find(']')? + category_start;
    let category = line[category_start..category_end].trim();
    if category.is_empty() {
        return None;
    }
    Some((level.to_string(), category.to_string()))
}

fn merge_stats(target: &mut BTreeMap<String, u64>, source: &BTreeMap<String, u64>) {
    for (key, count) in source {
        *target.entry(key.clone()).or_insert(0) += count;
    }
}
