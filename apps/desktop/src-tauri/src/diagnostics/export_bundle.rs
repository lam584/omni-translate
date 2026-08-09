mod logs;
mod report;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use chrono::Local;
use serde::Serialize;
use serde_json::{json, Value};

use logs::{export_logs, redact_log_text};
use report::{build_manifest_text, build_readable_report, count_bundle_files};

const BUNDLE_SCHEMA_VERSION: u64 = 2;
const REDACTION_POLICY: &str = "credential-patterns-v2";
const SUMMARY_LOG_TAIL_BYTES: usize = 32 * 1024;
const QUICK_LOG_TAIL_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DiagnosticsExportScope {
    Summary,
    Quick,
    Full,
}

impl DiagnosticsExportScope {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "summary" => Ok(Self::Summary),
            "quick" => Ok(Self::Quick),
            "full" => Ok(Self::Full),
            _ => Err(format!(
                "invalid diagnostics export scope `{value}`; expected summary, quick, or full"
            )),
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Quick => "quick",
            Self::Full => "full",
        }
    }

    const fn log_tail_limit(self) -> Option<usize> {
        match self {
            Self::Summary => Some(SUMMARY_LOG_TAIL_BYTES),
            Self::Quick => Some(QUICK_LOG_TAIL_BYTES),
            Self::Full => None,
        }
    }

    const fn privacy_notice(self) -> &'static str {
        match self {
            Self::Summary => {
                "Credentials are redacted. This summary bundle contains core state and short log tails; those tails may still contain conversation text, device identifiers, and local paths. Review it before sharing."
            }
            Self::Quick => {
                "Credentials are redacted. This quick bundle contains core state and redacted log tails capped at approximately 512 KiB per file; those tails may still contain conversation text, device identifiers, and local paths. Review it before sharing."
            }
            Self::Full => {
                "Credentials are redacted, but this full bundle may contain conversation text, model output, device identifiers, local paths, and complete runtime snapshots. Review it before sharing."
            }
        }
    }
}

pub(crate) struct BundleInput<'a> {
    pub(crate) generated_at: &'a str,
    pub(crate) scope: DiagnosticsExportScope,
    pub(crate) diagnostics: Value,
    pub(crate) runtime: Option<Value>,
    pub(crate) audio: Value,
    pub(crate) bridge: Value,
    pub(crate) storage: Value,
    pub(crate) config: Value,
    pub(crate) logs_dir: &'a Path,
    pub(crate) bridge_runtime_root: &'a Path,
    pub(crate) extra_json: BTreeMap<String, Value>,
    pub(crate) collection_warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BundleWriteResult {
    pub(crate) file_count: usize,
    pub(crate) total_bytes: u64,
    pub(crate) redaction_count: u64,
    pub(crate) logs_truncated: usize,
    pub(crate) original_log_bytes: u64,
    pub(crate) exported_log_bytes: u64,
    pub(crate) exported_log_lines: u64,
    pub(crate) warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PayloadFileRecord {
    path: String,
    kind: String,
    bytes: u64,
}

struct SanitizedPayload {
    diagnostics: Value,
    runtime: Option<Value>,
    audio: Value,
    bridge: Value,
    storage: Value,
    config: Option<Value>,
    extra_json: BTreeMap<String, Value>,
    redaction_count: u64,
}

pub(crate) fn write_diagnostics_bundle(
    staging_dir: &Path,
    input: BundleInput<'_>,
) -> Result<BundleWriteResult, String> {
    prepare_staging_dir(staging_dir)?;

    let mut warning_redaction_count = 0;
    let mut warnings = input
        .collection_warnings
        .into_iter()
        .map(|warning| {
            let (warning, count) = redact_log_text(&warning);
            warning_redaction_count += count;
            warning
        })
        .collect::<Vec<_>>();
    let sanitized = sanitize_payload(
        input.scope,
        input.diagnostics,
        input.runtime,
        input.audio,
        input.bridge,
        input.storage,
        input.config,
        input.extra_json,
    )?;
    let core_summary = build_core_summary(
        input.generated_at,
        input.scope,
        &sanitized.diagnostics,
        sanitized.runtime.as_ref(),
        &sanitized.audio,
        &sanitized.bridge,
        &sanitized.storage,
    );
    let written_json_redactions = if input.scope == DiagnosticsExportScope::Full {
        sanitized.redaction_count
    } else {
        count_redaction_markers(&core_summary)
    };

    let mut payload_files = Vec::new();
    write_json_payload(
        staging_dir,
        "environment.json",
        "environment",
        &json!({
            "schemaVersion": BUNDLE_SCHEMA_VERSION,
            "generatedAt": input.generated_at,
            "scope": input.scope.as_str(),
            "platform": std::env::consts::OS,
            "family": std::env::consts::FAMILY,
            "arch": std::env::consts::ARCH,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "debugAssertions": cfg!(debug_assertions),
            "buildCommit": build_commit(),
            "processId": std::process::id(),
            "executableName": executable_name(),
            "availableParallelism": std::thread::available_parallelism().ok().map(|value| value.get()),
            "timezoneOffsetMinutes": Local::now().offset().local_minus_utc() / 60,
            "locale": {
                "lang": non_empty_env("LANG"),
                "lcAll": non_empty_env("LC_ALL"),
            },
            "logLevel": non_empty_env("OMNI_LOG_LEVEL"),
            "redactionPolicy": REDACTION_POLICY,
            "privacyNotice": input.scope.privacy_notice(),
        }),
        &mut payload_files,
    )?;
    write_json_payload(
        staging_dir,
        "diagnostics-summary.json",
        "core-summary",
        &core_summary,
        &mut payload_files,
    )?;

    if input.scope == DiagnosticsExportScope::Full {
        write_json_payload(
            staging_dir,
            "snapshots/diagnostics.json",
            "snapshot",
            &sanitized.diagnostics,
            &mut payload_files,
        )?;
        if let Some(runtime) = &sanitized.runtime {
            write_json_payload(
                staging_dir,
                "snapshots/runtime.json",
                "snapshot",
                runtime,
                &mut payload_files,
            )?;
        } else {
            warnings.push("Runtime snapshot was unavailable during collection.".to_string());
        }
        write_json_payload(
            staging_dir,
            "snapshots/audio.json",
            "snapshot",
            &sanitized.audio,
            &mut payload_files,
        )?;
        write_json_payload(
            staging_dir,
            "snapshots/bridge.json",
            "snapshot",
            &sanitized.bridge,
            &mut payload_files,
        )?;
        write_json_payload(
            staging_dir,
            "snapshots/storage.json",
            "snapshot",
            &sanitized.storage,
            &mut payload_files,
        )?;
        if let Some(config) = &sanitized.config {
            write_json_payload(
                staging_dir,
                "snapshots/config.json",
                "snapshot",
                config,
                &mut payload_files,
            )?;
        }
        for (name, value) in &sanitized.extra_json {
            let relative_path = format!("snapshots/extra/{name}");
            write_json_payload(
                staging_dir,
                &relative_path,
                "extra-json",
                value,
                &mut payload_files,
            )?;
        }
    } else if !sanitized.extra_json.is_empty() {
        warnings.push(format!(
            "{} optional JSON payload(s) were omitted by the {} scope.",
            sanitized.extra_json.len(),
            input.scope.as_str()
        ));
    }

    let (log_files, log_totals) = export_logs(
        staging_dir,
        input.scope,
        input.logs_dir,
        input.bridge_runtime_root,
        &mut warnings,
        &mut payload_files,
    )?;
    let log_summary = json!({
        "schemaVersion": BUNDLE_SCHEMA_VERSION,
        "scope": input.scope.as_str(),
        "perFileTailBytes": input.scope.log_tail_limit(),
        "redactionPolicy": REDACTION_POLICY,
        "files": log_files,
        "totals": log_totals,
    });
    write_json_payload(
        staging_dir,
        "log-summary.json",
        "log-summary",
        &log_summary,
        &mut payload_files,
    )?;

    // Collection can append warnings after the initial input is sanitized
    // (for example, filesystem errors while reading logs). Sanitize the final
    // warning set before it is rendered into the text report as well as JSON.
    for warning in &mut warnings {
        let (sanitized_warning, count) = redact_log_text(warning);
        *warning = sanitized_warning;
        warning_redaction_count += count;
    }
    let total_redactions =
        written_json_redactions + warning_redaction_count + log_totals.redaction_count;
    let report = build_readable_report(
        input.generated_at,
        input.scope,
        &core_summary,
        &log_files,
        &log_totals,
        total_redactions,
        &warnings,
        payload_files.len() + 2,
    );
    write_text_payload(
        staging_dir,
        "diagnostics-report.txt",
        "human-readable-report",
        &report,
        &mut payload_files,
    )?;

    let payload_bytes = payload_files.iter().map(|file| file.bytes).sum::<u64>();
    let expected_file_count = payload_files.len() + 1;
    let manifest_path = staging_dir.join("bundle-manifest.json");
    let manifest_text = build_manifest_text(
        input.generated_at,
        input.scope,
        &payload_files,
        &warnings,
        &log_totals,
        total_redactions,
        expected_file_count,
        payload_bytes,
    )?;
    let expected_total_bytes = payload_bytes + manifest_text.len() as u64;
    fs::write(&manifest_path, manifest_text.as_bytes())
        .map_err(|error| format!("failed to write bundle-manifest.json: {error}"))?;

    let (actual_file_count, actual_total_bytes) = count_bundle_files(staging_dir)?;
    if actual_file_count != expected_file_count {
        return Err(format!(
            "diagnostics bundle file count mismatch: manifest={expected_file_count}, actual={actual_file_count}"
        ));
    }
    if actual_total_bytes != expected_total_bytes {
        return Err(format!(
            "diagnostics bundle byte count mismatch: manifest={expected_total_bytes}, actual={actual_total_bytes}"
        ));
    }

    Ok(BundleWriteResult {
        file_count: actual_file_count,
        total_bytes: actual_total_bytes,
        redaction_count: total_redactions,
        logs_truncated: log_totals.truncated_file_count,
        original_log_bytes: log_totals.original_bytes,
        exported_log_bytes: log_totals.exported_bytes,
        exported_log_lines: log_totals.exported_line_count,
        warnings,
    })
}

fn prepare_staging_dir(staging_dir: &Path) -> Result<(), String> {
    if staging_dir.as_os_str().is_empty() {
        return Err("diagnostics bundle staging directory is empty".to_string());
    }
    if staging_dir.exists() {
        if !staging_dir.is_dir() {
            return Err(format!(
                "diagnostics bundle staging path is not a directory: {}",
                staging_dir.display()
            ));
        }
        let mut entries = fs::read_dir(staging_dir)
            .map_err(|error| format!("failed to inspect diagnostics staging directory: {error}"))?;
        if entries.next().is_some() {
            return Err("diagnostics bundle staging directory must be empty".to_string());
        }
    } else {
        fs::create_dir_all(staging_dir)
            .map_err(|error| format!("failed to create diagnostics staging directory: {error}"))?;
    }
    Ok(())
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn executable_name() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_string()))
}

fn build_commit() -> Option<String> {
    option_env!("OMNI_BUILD_COMMIT")
        .or(option_env!("GIT_COMMIT_HASH"))
        .or(option_env!("VERGEN_GIT_SHA"))
        .map(str::to_string)
        .or_else(|| non_empty_env("OMNI_BUILD_COMMIT"))
}

fn sanitize_payload(
    scope: DiagnosticsExportScope,
    diagnostics: Value,
    runtime: Option<Value>,
    audio: Value,
    bridge: Value,
    storage: Value,
    config: Value,
    extra_json: BTreeMap<String, Value>,
) -> Result<SanitizedPayload, String> {
    let (diagnostics, mut redaction_count) = sanitize_json_with_count(diagnostics);
    let runtime = runtime.map(|value| {
        let (value, count) = sanitize_json_with_count(value);
        redaction_count += count;
        value
    });
    let (audio, count) = sanitize_json_with_count(audio);
    redaction_count += count;
    let (bridge, count) = sanitize_json_with_count(bridge);
    redaction_count += count;
    let (storage, count) = sanitize_json_with_count(storage);
    redaction_count += count;

    let config = if scope == DiagnosticsExportScope::Full {
        let (value, count) = sanitize_json_with_count(config);
        redaction_count += count;
        Some(value)
    } else {
        None
    };

    let mut sanitized_extra = BTreeMap::new();
    for (name, value) in extra_json {
        let safe_name = validate_extra_json_name(&name)?;
        let value = if scope == DiagnosticsExportScope::Full {
            let (value, count) = sanitize_json_with_count(value);
            redaction_count += count;
            value
        } else {
            value
        };
        if sanitized_extra.insert(safe_name.clone(), value).is_some() {
            return Err(format!("duplicate optional JSON payload name `{safe_name}`"));
        }
    }

    Ok(SanitizedPayload {
        diagnostics,
        runtime,
        audio,
        bridge,
        storage,
        config,
        extra_json: sanitized_extra,
        redaction_count,
    })
}

fn sanitize_json_with_count(value: Value) -> (Value, u64) {
    let before = count_redaction_markers(&value);
    let sanitized = super::redaction::sanitize_value(value);
    let after = count_redaction_markers(&sanitized);
    (sanitized, after.saturating_sub(before))
}

fn count_redaction_markers(value: &Value) -> u64 {
    match value {
        Value::Object(map) => {
            let own_marker = u64::from(
                map.get("redacted") == Some(&Value::Bool(true))
                    && map.get("kind").and_then(Value::as_str).is_some(),
            );
            own_marker
                + map
                    .values()
                    .map(count_redaction_markers)
                    .sum::<u64>()
        }
        Value::Array(items) => items.iter().map(count_redaction_markers).sum(),
        Value::String(text) if text == "[REDACTED]" => 1,
        _ => 0,
    }
}

fn validate_extra_json_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("optional JSON payload name is empty or invalid".to_string());
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err(format!(
            "optional JSON payload name `{trimmed}` contains unsupported characters"
        ));
    }
    let filename = if trimmed.ends_with(".json") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.json")
    };
    Ok(filename)
}

fn build_core_summary(
    generated_at: &str,
    scope: DiagnosticsExportScope,
    diagnostics: &Value,
    runtime: Option<&Value>,
    audio: &Value,
    bridge: &Value,
    storage: &Value,
) -> Value {
    let runtime = runtime.unwrap_or(&Value::Null);
    json!({
        "schemaVersion": BUNDLE_SCHEMA_VERSION,
        "generatedAt": generated_at,
        "scope": scope.as_str(),
        "diagnostics": {
            "status": at(diagnostics, "/status"),
            "supportTier": at(diagnostics, "/supportTier"),
            "installStatus": at(diagnostics, "/installStatus"),
            "providerStatus": at(diagnostics, "/providerStatus"),
            "driverStatus": at(diagnostics, "/driverStatus"),
            "deviceStatus": at(diagnostics, "/deviceStatus"),
            "lastSelfCheckAt": at(diagnostics, "/lastSelfCheckAt"),
            "logDroppedCount": at(diagnostics, "/logDroppedCount"),
            "logWriteErrorCount": at(diagnostics, "/logWriteErrorCount"),
            "recentErrorCount": array_len(diagnostics, "/recentErrors"),
        },
        "runtime": {
            "available": !runtime.is_null(),
            "coreState": at(runtime, "/coreState"),
            "bridgeStatus": at(runtime, "/bridgeStatus"),
            "activeProfileId": at(runtime, "/activeProfileId"),
            "trayReady": at(runtime, "/trayReady"),
            "lastSyncAt": at(runtime, "/lastSyncAt"),
            "sessionId": at(runtime, "/sessionId"),
            "windowCount": array_len(runtime, "/windows"),
            "notificationCount": array_len(runtime, "/notifications"),
        },
        "audio": {
            "status": at(audio, "/status"),
            "host": at(audio, "/host"),
            "renderDeviceCount": array_len(audio, "/renderDevices"),
            "captureDeviceCount": array_len(audio, "/captureDevices"),
            "sessionStartedAt": at(audio, "/sessionStartedAt"),
            "sttConnected": at(audio, "/sttConnected"),
            "sttBufferSize": at(audio, "/sttBufferSize"),
            "sttConnection": at(audio, "/sttConnection"),
            "inbound": route_summary(audio, "/inbound"),
            "outbound": route_summary(audio, "/outbound"),
            "subtitle": {
                "queueDepth": at(audio, "/subtitleOverlay/queueDepth"),
                "droppedCueCount": at(audio, "/subtitleOverlay/droppedCueCount"),
                "firstTranslationAverageMs": at(audio, "/subtitleOverlay/firstTranslationAverageMs"),
                "firstTranslationLastMs": at(audio, "/subtitleOverlay/firstTranslationLastMs"),
                "firstTranslationSampleCount": at(audio, "/subtitleOverlay/firstTranslationSampleCount"),
            },
            "echoCaptureDiagnostics": {
                "aecSuppressedChunks": at(audio, "/echoCaptureDiagnostics/aecSuppressedChunks"),
                "playbackActiveChunks": at(audio, "/echoCaptureDiagnostics/playbackActiveChunks"),
                "effectiveSuppressedChunks": at(audio, "/echoCaptureDiagnostics/effectiveSuppressedChunks"),
            },
            "speech": {
                "status": at(audio, "/speech/status"),
                "dispatchState": at(audio, "/speech/dispatchState"),
                "queueDepth": at(audio, "/speech/queueDepth"),
                "policy": at(audio, "/speech/policy"),
                "outputTarget": at(audio, "/speech/outputTarget"),
                "lastError": at(audio, "/speech/lastError"),
                "speakerFramesWritten": at(audio, "/speech/speakerFramesWritten"),
                "virtualMicFramesWritten": at(audio, "/speech/virtualMicFramesWritten"),
            },
        },
        "bridge": {
            "status": at(bridge, "/status"),
            "processStatus": at(bridge, "/processStatus"),
            "bridgeState": at(bridge, "/bridgeState"),
            "lifecycleState": at(bridge, "/lifecycleState"),
            "installChannel": at(bridge, "/installChannel"),
            "installPhase": at(bridge, "/installPhase"),
            "driverHealth": at(bridge, "/driverHealth"),
            "driverVersion": at(bridge, "/driverVersion"),
            "bridgeVersion": at(bridge, "/bridgeVersion"),
            "captureBackend": at(bridge, "/captureBackend"),
            "captureRestartCount": at(bridge, "/captureRestartCount"),
            "underrunCount": at(bridge, "/underrunCount"),
            "droppedFrameCount": at(bridge, "/droppedFrameCount"),
            "lastErrorCode": at(bridge, "/lastErrorCode"),
            "recommendedAction": at(bridge, "/recommendedAction"),
            "driverProbeState": at(bridge, "/driverProbeState"),
            "testSigningEnabled": at(bridge, "/testSigningEnabled"),
            "memoryIntegrityEnabled": at(bridge, "/memoryIntegrityEnabled"),
            "secureBootEnabled": at(bridge, "/secureBootEnabled"),
            "ioctlAvailable": at(bridge, "/ioctlAvailable"),
        },
        "storage": {
            "status": at(storage, "/status"),
            "schemaVersion": at(storage, "/schemaVersion"),
            "credentialBackend": at(storage, "/credentialBackend"),
            "hasPersistedConfig": at(storage, "/hasPersistedConfig"),
            "snapshotCount": at(storage, "/snapshotCount"),
            "lastSavedAt": at(storage, "/lastSavedAt"),
        },
    })
}

fn route_summary(audio: &Value, route_pointer: &str) -> Value {
    json!({
        "captureState": at(audio, &format!("{route_pointer}/captureState")),
        "preBufferState": at(audio, &format!("{route_pointer}/preBufferState")),
        "vadState": at(audio, &format!("{route_pointer}/vadState")),
        "bufferAheadMs": at(audio, &format!("{route_pointer}/bufferAheadMs")),
        "framesCaptured": at(audio, &format!("{route_pointer}/framesCaptured")),
        "segmentCount": at(audio, &format!("{route_pointer}/segmentCount")),
        "streamBound": at(audio, &format!("{route_pointer}/streamBound")),
        "lastEnergyDb": at(audio, &format!("{route_pointer}/lastEnergyDb")),
        "lastFrameAt": at(audio, &format!("{route_pointer}/lastFrameAt")),
        "lastErrorCode": at(audio, &format!("{route_pointer}/lastErrorCode")),
        "recommendedAction": at(audio, &format!("{route_pointer}/recommendedAction")),
    })
}

fn at(value: &Value, pointer: &str) -> Value {
    value.pointer(pointer).cloned().unwrap_or(Value::Null)
}

fn array_len(value: &Value, pointer: &str) -> Value {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map(|items| json!(items.len()))
        .unwrap_or(Value::Null)
}

fn write_json_payload(
    staging_dir: &Path,
    relative_path: &str,
    kind: &str,
    value: &Value,
    files: &mut Vec<PayloadFileRecord>,
) -> Result<(), String> {
    let value = super::redaction::sanitize_value(value.clone());
    let mut text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("failed to serialize {relative_path}: {error}"))?;
    text.push('\n');
    write_text_payload(staging_dir, relative_path, kind, &text, files)
}

fn write_text_payload(
    staging_dir: &Path,
    relative_path: &str,
    kind: &str,
    text: &str,
    files: &mut Vec<PayloadFileRecord>,
) -> Result<(), String> {
    let output_path = staging_dir.join(relative_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("failed to create payload directory for {relative_path}: {error}")
        })?;
    }
    fs::write(&output_path, text.as_bytes())
        .map_err(|error| format!("failed to write {relative_path}: {error}"))?;
    files.push(PayloadFileRecord {
        path: relative_path.replace('\\', "/"),
        kind: kind.to_string(),
        bytes: text.len() as u64,
    });
    Ok(())
}
