mod config;
mod playback_drain;
mod process_exclusion_restart;
mod terminal_authority;
mod terminal_capture;
pub(crate) mod readiness;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod terminal_authority_tests;
#[cfg(test)]
mod terminal_lifecycle_tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use self::config::{configure_watch_mode, configure_watch_realtime_provider};
use self::process_exclusion_restart::schedule_process_exclusion_restart;
use self::playback_drain::wait_for_local_playback_quiescence;
use self::terminal_authority::{
    current_process_start_time_utc_ticks, process_start_unix_ms_from_utc_ticks,
    ExpectedInputCompleteIdentity, InputCompleteMarker, StrictPaidTerminalConfig, TerminalAuthority,
    TerminalAuthorityRecorder, TerminalProducerIdentity,
};
use self::terminal_capture::{
    log_process_exclusion_restart_failure, query_and_cache_bridge_runtime,
    start_diagnostic_audio_route, wait_for_process_exclusion_source,
};
#[cfg(test)]
use self::playback_drain::{
    local_playback_drain_authority, local_playback_drain_estimate,
};
#[cfg(test)]
use self::terminal_capture::{
    write_json_immutable, write_report_atomic, write_terminal_authority_immutable,
};
use crate::audio::events::{
    finalize_strict_watch_inbound_after_terminal_drain,
    finish_strict_watch_provider_after_input_complete, preconnect_omni_realtime_inner,
    start_audio_route_inner, stop_audio_route,
};
use crate::audio::state::{
    AudioStateStore, StrictWatchTerminalLifecycleSnapshot,
    TranslationPlaybackQuiescenceSnapshot,
};
use crate::bridge::events::{repair_driver_runtime, start_bridge_service};
use crate::bridge::ipc::{apply_query as apply_bridge_query, BridgeIpcClient};
use crate::bridge::contracts::{
    BridgeRuntimeSnapshot, CaptureBackend, ProcessLoopbackStatus, SourceCaptureMode,
};
use crate::bridge::state::BridgeStateStore;
use crate::diagnostics::events::append_diagnostics_log;
use crate::runtime::state::RuntimeStateStore;
use crate::storage::StorageStateStore;

const DEFAULT_SUBTITLE_TRANSLATION_MODEL_ID: &str =
    "template-dashscope-realtime::qwen3.6-flash-2026-04-16";
const DEFAULT_INBOUND_SECONDARY_AUDIO_MODEL_ID: &str =
    "template-dashscope-realtime::qwen3.5-omni-plus-realtime";

// Diagnostic autostart is the only startup path that may create the overlay
// without a user gesture. It must wait until the renderer proves that Tauri's
// IPC channel is bound; otherwise WebView2 controller creation can race the
// main window's IPC initialization. Keep the wait well inside the live
// runner's absolute two-minute budget.
const IPC_READY_TIMEOUT: Duration = Duration::from_secs(30);
const IPC_READY_POLL: Duration = Duration::from_millis(50);
const MIN_AUTOSTART_CAPTURE_DURATION_MS: u64 = 1_000;
// The live matrix runner accepts captures up to 7,200 seconds. Keep the native
// diagnostic owner aligned so a requested 30-minute cell is never silently
// truncated to the historical five-minute limit.
const MAX_AUTOSTART_CAPTURE_DURATION_MS: u64 = 7_200_000;
const PROCESS_EXCLUSION_RESTART_RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_EXCLUSION_RESTART_POLL: Duration = Duration::from_millis(50);
const PROCESS_EXCLUSION_RESTART_PLAYBACK_DRAIN_TIMEOUT: Duration = Duration::from_secs(90);
const PROCESS_EXCLUSION_RESTART_PLAYBACK_IDLE_CONFIRMATION: Duration = Duration::from_millis(250);
const INPUT_COMPLETE_POLL: Duration = Duration::from_millis(50);
const PROVIDER_FINISH_OBSERVATION_GRACE: Duration = Duration::from_millis(250);
const LOCAL_PLAYBACK_IDLE_CONFIRMATION: Duration = Duration::from_millis(750);
const STRICT_LIVETRANSLATE_MODEL: &str = "qwen3.5-livetranslate-flash-realtime";
const STRICT_LIVETRANSLATE_PROTOCOL: &str = "dashscope-livetranslate";

struct PlaybackDrainConfirmation {
    confirmation: Duration,
    quiescent_since: Option<Instant>,
}

impl PlaybackDrainConfirmation {
    fn new(confirmation: Duration) -> Self {
        Self {
            confirmation,
            quiescent_since: None,
        }
    }

    fn observe(&mut self, now: Instant, quiescent: bool) -> bool {
        if !quiescent {
            self.quiescent_since = None;
            return false;
        }
        let since = self.quiescent_since.get_or_insert(now);
        now.saturating_duration_since(*since) >= self.confirmation
    }
}

fn process_exclusion_restart_is_quiescent(
    speaker_playback_active: bool,
    playback: TranslationPlaybackQuiescenceSnapshot,
) -> bool {
    !speaker_playback_active && playback.is_quiescent()
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn bounded_autostart_capture_duration_ms(value: u64) -> u64 {
    value.clamp(
        MIN_AUTOSTART_CAPTURE_DURATION_MS,
        MAX_AUTOSTART_CAPTURE_DURATION_MS,
    )
}

fn required_environment_value<F>(read_env: &F, name: &str) -> Result<String, String>
where
    F: Fn(&str) -> Option<String>,
{
    read_env(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required for strict paid LiveTranslate terminal authority"))
}

fn required_lower_hex_environment_value<F>(
    read_env: &F,
    name: &str,
    expected_length: usize,
) -> Result<String, String>
where
    F: Fn(&str) -> Option<String>,
{
    let value = required_environment_value(read_env, name)?;
    if value.len() != expected_length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{name} must be exactly {expected_length} lowercase hexadecimal characters"
        ));
    }
    Ok(value)
}

fn strict_paid_terminal_config_with_environment<F>(
    read_env: F,
) -> Result<StrictPaidTerminalConfig, String>
where
    F: Fn(&str) -> Option<String>,
{
    if read_env("OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY").as_deref() != Some("1") {
        return Err(
            "OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY must be exactly 1 for strict paid terminal authority"
                .to_string(),
        );
    }
    let model = required_environment_value(&read_env, "OMNI_WATCH_MODE_MODEL_ID")?;
    let protocol = required_environment_value(&read_env, "OMNI_WATCH_MODE_REALTIME_PROTOCOL")?;
    if model != STRICT_LIVETRANSLATE_MODEL || protocol != STRICT_LIVETRANSLATE_PROTOCOL {
        return Err(format!(
            "strict paid terminal authority requires model={STRICT_LIVETRANSLATE_MODEL} protocol={STRICT_LIVETRANSLATE_PROTOCOL}; observed model={model} protocol={protocol}"
        ));
    }
    let auto_stop_watchdog_ms = required_environment_value(
        &read_env,
        "OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS",
    )?
    .parse::<u64>()
    .map_err(|error| {
        format!("OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS must be a positive integer: {error}")
    })?;
    if auto_stop_watchdog_ms == 0 {
        return Err("OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS must be greater than zero".to_string());
    }
    let timeout_ms = |name: &str| -> Result<u64, String> {
        let value = required_environment_value(&read_env, name)?
            .parse::<u64>()
            .map_err(|error| format!("{name} must be a positive integer: {error}"))?;
        if value == 0 || value > MAX_AUTOSTART_CAPTURE_DURATION_MS {
            return Err(format!(
                "{name} must be between 1 and {MAX_AUTOSTART_CAPTURE_DURATION_MS}"
            ));
        }
        Ok(value)
    };
    let input_completion_watchdog_ms = timeout_ms(
        "OMNI_WATCH_MODE_INPUT_COMPLETION_WATCHDOG_MS",
    )?;
    if read_env("OMNI_WATCH_MODE_EXIT_AFTER_REPORT").as_deref() != Some("1") {
        return Err(
            "OMNI_WATCH_MODE_EXIT_AFTER_REPORT must be exactly 1 for strict paid terminal authority"
                .to_string(),
        );
    }
    let producer_start_time_utc_ticks = current_process_start_time_utc_ticks()?;
    let producer_started_at_unix_ms =
        process_start_unix_ms_from_utc_ticks(producer_start_time_utc_ticks)?;
    Ok(StrictPaidTerminalConfig {
        identity: ExpectedInputCompleteIdentity {
            run_marker: required_environment_value(&read_env, "OMNI_WATCH_MODE_RUN_MARKER")?,
            cell_id: required_environment_value(&read_env, "OMNI_WATCH_MODE_CELL_ID")?,
            lease_id: required_environment_value(
                &read_env,
                "OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID",
            )?,
        },
        producer: TerminalProducerIdentity {
            process_id: std::process::id(),
            start_time_utc_ticks: producer_start_time_utc_ticks,
            started_at_unix_ms: producer_started_at_unix_ms,
            executable_sha256: required_lower_hex_environment_value(
                &read_env,
                "OMNI_WATCH_MODE_EXECUTABLE_SHA256",
                64,
            )?,
            source_head_commit: required_lower_hex_environment_value(
                &read_env,
                "OMNI_WATCH_MODE_SOURCE_HEAD_COMMIT",
                40,
            )?,
            runtime_bundle_digest: required_lower_hex_environment_value(
                &read_env,
                "OMNI_WATCH_MODE_RUNTIME_BUNDLE_DIGEST",
                64,
            )?,
            launch_id: {
                let value = required_environment_value(&read_env, "OMNI_WATCH_MODE_LAUNCH_ID")?;
                let parsed = Uuid::parse_str(&value)
                    .map_err(|error| format!("OMNI_WATCH_MODE_LAUNCH_ID must be a UUID: {error}"))?;
                if parsed.to_string() != value {
                    return Err(
                        "OMNI_WATCH_MODE_LAUNCH_ID must use canonical lowercase UUID form"
                            .to_string(),
                    );
                }
                value
            },
        },
        input_complete_path: required_environment_value(
            &read_env,
            "OMNI_WATCH_MODE_INPUT_COMPLETE_PATH",
        )?,
        terminal_authority_path: required_environment_value(
            &read_env,
            "OMNI_WATCH_MODE_TERMINAL_AUTHORITY_PATH",
        )?,
        report_path: required_environment_value(&read_env, "OMNI_WATCH_MODE_REPORT_PATH")?,
        // The legacy auto-stop is retained only as a hard watchdog. Whichever
        // watchdog is shorter wins; neither is a successful completion path.
        input_completion_watchdog: Duration::from_millis(
            bounded_autostart_capture_duration_ms(
                auto_stop_watchdog_ms.min(input_completion_watchdog_ms),
            ),
        ),
        provider_shutdown_timeout: Duration::from_millis(timeout_ms(
            "OMNI_WATCH_MODE_PROVIDER_FINISH_TIMEOUT_MS",
        )?),
        local_playback_drain_timeout: Duration::from_millis(timeout_ms(
            "OMNI_WATCH_MODE_LOCAL_PLAYBACK_DRAIN_TIMEOUT_MS",
        )?),
        report_write_timeout: Duration::from_millis(timeout_ms(
            "OMNI_WATCH_MODE_REPORT_WRITE_TIMEOUT_MS",
        )?),
    })
}

fn parse_input_complete_marker(
    bytes: &[u8],
    expected: &ExpectedInputCompleteIdentity,
) -> Result<InputCompleteMarker, String> {
    let marker: InputCompleteMarker =
        serde_json::from_slice(bytes).map_err(|error| format!("input-complete JSON is invalid: {error}"))?;
    if marker.artifact_kind != "watch-mode-input-complete" {
        return Err(format!(
            "artifactKind mismatch: expected watch-mode-input-complete, observed {}",
            marker.artifact_kind
        ));
    }
    if marker.schema_version != 1 {
        return Err(format!(
            "schemaVersion mismatch: expected 1, observed {}",
            marker.schema_version
        ));
    }
    for (field, observed, required) in [
        ("runMarker", marker.run_marker.as_str(), expected.run_marker.as_str()),
        ("cellId", marker.cell_id.as_str(), expected.cell_id.as_str()),
        ("leaseId", marker.lease_id.as_str(), expected.lease_id.as_str()),
    ] {
        if observed != required {
            return Err(format!(
                "{field} mismatch: expected {required}, observed {observed}"
            ));
        }
    }
    if marker.completed_at_unix_ms == 0 {
        return Err("completedAtUnixMs must be greater than zero".to_string());
    }
    if marker.signaled_at_unix_ms == 0 {
        return Err("signaledAtUnixMs must be greater than zero".to_string());
    }
    if marker.signaled_at_unix_ms < marker.media_playback_completed_at_unix_ms.unwrap_or(0)
        || marker.completed_at_unix_ms < marker.signaled_at_unix_ms
    {
        return Err(
            "input-complete marker timestamps do not preserve media -> signal -> completion order"
                .to_string(),
        );
    }
    Ok(marker)
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn parse_feedback_loop_prevention(value: Option<&str>) -> Result<String, String> {
    let Some(value) = value else {
        return Ok("virtual-driver".to_string());
    };
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "process-exclusion" | "virtual-driver" | "echo-cancel" => Ok(normalized),
        _ => Err(format!(
            "Unsupported OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION '{value}'; expected process-exclusion, virtual-driver, or echo-cancel"
        )),
    }
}

fn process_exclusion_restart_after_ms() -> Result<Option<u64>, String> {
    let Ok(raw) = std::env::var("OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS") else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value = trimmed.parse::<u64>().map_err(|error| {
        format!(
            "OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS must be a positive integer: {error}"
        )
    })?;
    if value == 0 {
        return Err(
            "OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS must be greater than zero"
                .to_string(),
        );
    }
    Ok(Some(value))
}

pub(crate) fn autostart_enabled() -> bool {
    env_flag_enabled("OMNI_WATCH_MODE_AUTOSTART")
}

/// A diagnostic route creates and reveals the overlay itself. Running the
/// ordinary idle prewarm at the same time lets two `ensure` calls both miss
/// the label lookup and race to build separate WebView2 instances. Keep the
/// optimization for normal launches, but give diagnostic startup one owner.
pub(crate) fn should_run_idle_overlay_prewarm(watch_diagnostic: bool) -> bool {
    !watch_diagnostic
}

// Kept separate from the Tauri command so the runtime gate contract can be
// unit-tested without constructing an application instance.
pub(crate) fn build_debug_ipc_ping_response(
    storage_status: &str,
    elapsed_ms: u128,
    watch_diagnostic: bool,
) -> String {
    format!(
        "pong storage_status={storage_status} elapsed_ms={elapsed_ms} watchDiagnostic={watch_diagnostic} backendAutostartAuthoritative={watch_diagnostic}"
    )
}

async fn wait_for_frontend_ipc_ready<F>(
    timeout: Duration,
    poll_interval: Duration,
    mut is_ready: F,
) -> bool
where
    F: FnMut() -> bool,
{
    let started = Instant::now();
    let poll_interval = if poll_interval.is_zero() {
        Duration::from_millis(1)
    } else {
        poll_interval
    };
    loop {
        if is_ready() {
            return true;
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return false;
        }
        tokio::time::sleep(poll_interval.min(remaining)).await;
    }
}

pub(crate) fn schedule_after_ipc(app: &tauri::App, ipc_ping_received: &'static AtomicBool) {
    if !autostart_enabled() {
        return;
    }

    let app_handle = app.handle().clone();
    readiness::initialize();
    let run_marker = std::env::var("OMNI_WATCH_MODE_RUN_MARKER").unwrap_or_default();
    let _ = append_diagnostics_log(
        &app_handle,
        "runtime",
        "info",
        "watch_mode.diagnostic_autostart_waiting_for_ipc",
        Some(format!(
            "runMarker={} timeoutMs={}",
            if run_marker.is_empty() {
                "-"
            } else {
                run_marker.as_str()
            },
            IPC_READY_TIMEOUT.as_millis(),
        )),
        None,
        None,
    );

    tauri::async_runtime::spawn(async move {
        let wait_started = Instant::now();
        let ready = wait_for_frontend_ipc_ready(IPC_READY_TIMEOUT, IPC_READY_POLL, || {
            ipc_ping_received.load(Ordering::Acquire)
        })
        .await;
        if !ready {
            readiness::fail(
                "frontendIpc",
                "frontend.ipc.timeout",
                "frontend never reached debug_ipc_ping",
            );
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "error",
                "watch_mode.diagnostic_autostart_infrastructure_failed",
                Some(format!(
                    "category=infrastructure code=frontend-ipc-not-ready runMarker={} waitedMs={} action=autostart-aborted note=frontend never reached debug_ipc_ping",
                    if run_marker.is_empty() {
                        "-"
                    } else {
                        run_marker.as_str()
                    },
                    wait_started.elapsed().as_millis(),
                )),
                None,
                None,
            );
            if env_flag_enabled("OMNI_WATCH_MODE_EXIT_AFTER_REPORT") {
                app_handle.exit(2);
            }
            return;
        }

        readiness::mark_frontend_ipc_ready();

        let _ = append_diagnostics_log(
            &app_handle,
            "runtime",
            "info",
            "watch_mode.diagnostic_autostart_ipc_ready",
            Some(format!(
                "runMarker={} waitedMs={}",
                if run_marker.is_empty() {
                    "-"
                } else {
                    run_marker.as_str()
                },
                wait_started.elapsed().as_millis(),
            )),
            None,
            None,
        );
        start(&app_handle);
    });
}

fn initialize_strict_paid_terminal(app: &AppHandle, run_marker: &str) -> bool {
    if std::env::var("OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY").as_deref() != Ok("1") {
        return true;
    }
    let strict_terminal_config =
        strict_paid_terminal_config_with_environment(|name| std::env::var(name).ok());
    let strict_terminal_config = strict_terminal_config.and_then(|config| {
        for (label, path) in [
            ("input-complete marker", config.input_complete_path.as_str()),
            ("terminal authority", config.terminal_authority_path.as_str()),
            ("Watch report", config.report_path.as_str()),
        ] {
            if std::path::Path::new(path).exists() {
                return Err(format!(
                    "strict paid {label} path must not exist before provider preconnect: {path}"
                ));
            }
        }
        app.state::<AudioStateStore>()
            .begin_strict_watch_terminal_lifecycle(
                &config.identity.run_marker,
                &config.identity.cell_id,
                &config.identity.lease_id,
            )?;
        Ok(config)
    });
    if let Err(error) = strict_terminal_config {
        readiness::fail("terminal", "watch.terminal.config-invalid", error.clone());
        let _ = append_diagnostics_log(
            app,
            "runtime",
            "error",
            "watch_mode.evidence_driven_terminal_config_failed",
            Some(format!("runMarker={run_marker} error={error}")),
            None,
            None,
        );
        if env_flag_enabled("OMNI_WATCH_MODE_EXIT_AFTER_REPORT") {
            app.exit(2);
        }
        return false;
    }
    true
}

fn start(app: &AppHandle) {
    let app_handle = app.clone();
    let run_marker = std::env::var("OMNI_WATCH_MODE_RUN_MARKER").unwrap_or_default();
    let output_device_id = std::env::var("OMNI_WATCH_MODE_OUTPUT_DEVICE_ID").unwrap_or_default();
    let output_level = std::env::var("OMNI_WATCH_MODE_OUTPUT_LEVEL")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .map(|value| value.clamp(0, 100))
        .unwrap_or(50);
    let watch_model_id = std::env::var("OMNI_WATCH_MODE_MODEL_ID")
        .unwrap_or_default()
        .trim()
        .to_string();
    let watch_realtime_protocol = std::env::var("OMNI_WATCH_MODE_REALTIME_PROTOCOL")
        .unwrap_or_default()
        .trim()
        .to_string();
    let subtitle_translation_mode =
        std::env::var("OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE")
            .unwrap_or_else(|_| "native".to_string())
            .trim()
            .to_ascii_lowercase();
    let subtitle_translation_mode = if subtitle_translation_mode == "secondary" {
        "secondary"
    } else {
        "native"
    };
    let subtitle_translation_model_id =
        std::env::var("OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID")
            .unwrap_or_else(|_| DEFAULT_SUBTITLE_TRANSLATION_MODEL_ID.to_string())
            .trim()
            .to_string();
    let subtitle_translation_model_id = if subtitle_translation_mode == "native" {
        String::new()
    } else if subtitle_translation_model_id.is_empty() {
        DEFAULT_SUBTITLE_TRANSLATION_MODEL_ID.to_string()
    } else {
        subtitle_translation_model_id
    };
    let inbound_secondary_audio_model_id =
        std::env::var("OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID")
            .unwrap_or_else(|_| DEFAULT_INBOUND_SECONDARY_AUDIO_MODEL_ID.to_string())
            .trim()
            .to_string();
    let inbound_secondary_audio_model_id = if subtitle_translation_mode == "native" {
        String::new()
    } else if inbound_secondary_audio_model_id.is_empty() {
        DEFAULT_INBOUND_SECONDARY_AUDIO_MODEL_ID.to_string()
    } else {
        inbound_secondary_audio_model_id
    };
    let translation_audio_source = if subtitle_translation_mode == "native" {
        "omni-native".to_string()
    } else {
        std::env::var("OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE")
            .unwrap_or_else(|_| "subtitle-tts".to_string())
    };
    let feedback_loop_prevention_raw =
        std::env::var("OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION").ok();
    let feedback_loop_prevention = match parse_feedback_loop_prevention(
        feedback_loop_prevention_raw.as_deref(),
    ) {
        Ok(value) => value,
        Err(error) => {
            readiness::fail("route", "watch.config.invalid", error.clone());
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "error",
                "watch_mode.diagnostic_autostart_config_failed",
                Some(format!(
                    "runMarker={} error={error}",
                    if run_marker.is_empty() {
                        "-"
                    } else {
                        run_marker.as_str()
                    }
                )),
                None,
                None,
            );
            return;
        }
    };

    let _ = append_diagnostics_log(
        &app_handle,
        "runtime",
        "info",
        "watch_mode.diagnostic_autostart_requested",
        Some(format!(
            "runMarker={} outputDeviceIdSet={} outputLevel={} watchModelId={} watchRealtimeProtocol={} subtitleTranslationMode={} subtitleTranslationModelId={} inboundSecondaryAudioModelId={} translationAudioSource={}",
            if run_marker.is_empty() {
                "-"
            } else {
                run_marker.as_str()
            },
            !output_device_id.is_empty(),
            output_level,
            if watch_model_id.is_empty() {
                "-"
            } else {
                watch_model_id.as_str()
            },
            if watch_realtime_protocol.is_empty() {
                "-"
            } else {
                watch_realtime_protocol.as_str()
            },
            subtitle_translation_mode,
            subtitle_translation_model_id,
            inbound_secondary_audio_model_id,
            translation_audio_source.trim()
        )),
        None,
        None,
    );

    // Strict paid LiveTranslate runs must establish the runner-to-desktop
    // terminal contract before any provider preconnect or route start. This
    // prevents a missing marker path from degrading into timer-based success
    // after a paid socket has already been opened.
    if !initialize_strict_paid_terminal(&app_handle, &run_marker) {
        return;
    }

    let storage = app.state::<StorageStateStore>();
    let mut config = match storage.load_config() {
        Ok(config) => config,
        Err(error) => {
            readiness::fail("route", "watch.config.load-failed", error.clone());
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "error",
                "watch_mode.diagnostic_autostart_config_failed",
                Some(error),
                None,
                None,
            );
            return;
        }
    };

    let effective_watch_model_id = match configure_watch_realtime_provider(
        &mut config,
        &watch_model_id,
        &watch_realtime_protocol,
    ) {
        Ok(model_id) => model_id,
        Err(error) => {
            readiness::fail("provider", "watch.provider.config-failed", error.clone());
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "error",
                "watch_mode.diagnostic_autostart_config_failed",
                Some(error),
                None,
                None,
            );
            return;
        }
    };
    configure_watch_mode(
        &mut config,
        &output_device_id,
        output_level,
        &effective_watch_model_id,
        subtitle_translation_mode,
        &subtitle_translation_model_id,
        &inbound_secondary_audio_model_id,
        translation_audio_source.trim(),
        &feedback_loop_prevention,
    );

    let audio_state = app.state::<AudioStateStore>();
    match preconnect_omni_realtime_inner(app_handle.clone(), &audio_state, config.clone()) {
        Ok(_) => {
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "info",
                "watch_mode.diagnostic_autostart_omni_preconnect_started",
                Some(format!(
                    "runMarker={}",
                    if run_marker.is_empty() {
                        "-"
                    } else {
                        run_marker.as_str()
                    }
                )),
                None,
                None,
            );
        }
        Err(error) => {
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "warning",
                "watch_mode.diagnostic_autostart_omni_preconnect_failed",
                Some(error),
                None,
                None,
            );
        }
    }

    let runtime_state = app.state::<RuntimeStateStore>();
    let bridge_state = app.state::<BridgeStateStore>();
    match start_bridge_service(
        app_handle.clone(),
        runtime_state,
        bridge_state,
        config.clone(),
    ) {
        Ok(_) => {
            readiness::mark_bridge_ready();
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "info",
                "watch_mode.diagnostic_autostart_bridge_started",
                Some(format!(
                    "runMarker={} outputDeviceId={} outputLevel={} translationAudioSource={} watchModelId={} watchRealtimeProtocol={} feedbackLoopPrevention={}",
                    if run_marker.is_empty() {
                        "-"
                    } else {
                        run_marker.as_str()
                    },
                    if output_device_id.is_empty() {
                        "-"
                    } else {
                        output_device_id.as_str()
                    },
                    output_level,
                    translation_audio_source.trim(),
                    if effective_watch_model_id.is_empty() {
                        "-"
                    } else {
                        effective_watch_model_id.as_str()
                    },
                    if watch_realtime_protocol.is_empty() {
                        "-"
                    } else {
                        watch_realtime_protocol.as_str()
                    },
                    feedback_loop_prevention
                )),
                None,
                None,
            );
        }
        Err(error) => {
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "error",
                "watch_mode.diagnostic_autostart_bridge_failed",
                Some(error),
                None,
                None,
            );
            return;
        }
    }

    start_diagnostic_audio_route(
        &app_handle,
        &run_marker,
        &output_device_id,
        config,
        &feedback_loop_prevention,
    );
}
