mod config;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use self::config::{configure_watch_mode, configure_watch_realtime_provider};
use crate::audio::events::{
    preconnect_omni_realtime_inner, start_audio_route_inner, stop_audio_route,
};
use crate::audio::state::AudioStateStore;
use crate::bridge::events::start_bridge_service;
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

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
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
    let feedback_loop_prevention = std::env::var("OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION")
        .map(|value| {
            if value.trim().eq_ignore_ascii_case("echo-cancel") {
                "echo-cancel".to_string()
            } else {
                "virtual-driver".to_string()
            }
        })
        .unwrap_or_else(|_| "virtual-driver".to_string());

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

    let storage = app.state::<StorageStateStore>();
    let mut config = match storage.load_config() {
        Ok(config) => config,
        Err(error) => {
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

    match start_audio_route_inner(
        app_handle.clone(),
        &app.state::<AudioStateStore>(),
        "inbound".to_string(),
        config,
    ) {
        Ok(snapshot) => {
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "info",
                "watch_mode.diagnostic_autostart_route_started",
                Some(format!(
                    "runMarker={} status={} outputDeviceId={}",
                    if run_marker.is_empty() {
                        "-"
                    } else {
                        run_marker.as_str()
                    },
                    snapshot.status,
                    if output_device_id.is_empty() {
                        "-"
                    } else {
                        output_device_id.as_str()
                    }
                )),
                None,
                None,
            );
            schedule_capture(&app_handle, &run_marker);
        }
        Err(error) => {
            let _ = append_diagnostics_log(
                &app_handle,
                "runtime",
                "error",
                "watch_mode.diagnostic_autostart_route_failed",
                Some(error),
                None,
                None,
            );
        }
    }
}

/// The live Watch matrix must stop the same desktop process that owns the
/// in-memory report. Launching a second executable with `tauri invoke` creates
/// another app instance and can never read that report. Keep this diagnostic
/// escape hatch opt-in and bounded: normal application sessions neither stop
/// automatically nor write a report to disk.
fn schedule_capture(app: &AppHandle, run_marker: &str) {
    let duration_ms = std::env::var("OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        // Reserve startup and shutdown time so one live model run stays
        // strictly below the user's two-minute ceiling.
        .map(|value| value.clamp(1_000, 100_000));
    let report_path = std::env::var("OMNI_WATCH_MODE_REPORT_PATH")
        .unwrap_or_default()
        .trim()
        .to_string();

    let (Some(duration_ms), false) = (duration_ms, report_path.is_empty()) else {
        return;
    };

    let app = app.clone();
    let run_marker = run_marker.to_string();
    let exit_after_report = env_flag_enabled("OMNI_WATCH_MODE_EXIT_AFTER_REPORT");
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(duration_ms)).await;
        let stop_result = stop_audio_route(app.clone(), "inbound".to_string()).await;
        if let Err(error) = &stop_result {
            let _ = append_diagnostics_log(
                &app,
                "runtime",
                "error",
                "watch_mode.diagnostic_auto_stop_failed",
                Some(format!("runMarker={run_marker} error={error}")),
                None,
                None,
            );
        }

        // `stop_audio_route` marks the report completed before returning, but
        // the renderer receipt crosses a browser frame and can arrive a few
        // hundred milliseconds later. Preserve that final evidence before
        // taking the immutable snapshot.
        tokio::time::sleep(Duration::from_millis(750)).await;
        let report = app
            .state::<AudioStateStore>()
            .watch_session_report
            .snapshot();
        let report_completed = report
            .as_ref()
            .is_some_and(|report| report.status == "completed");
        let write_path = report_path.clone();
        let write_result = tauri::async_runtime::spawn_blocking(move || {
            let report = report.ok_or_else(|| "Watch session report is missing".to_string())?;
            write_report_atomic(&write_path, &report)
        })
        .await
        .map_err(|error| format!("report writer task failed: {error}"))
        .and_then(|result| result);

        let succeeded = stop_result.is_ok() && report_completed && write_result.is_ok();
        let (level, message, detail) = if succeeded {
            (
                "info",
                "watch_mode.diagnostic_report_saved",
                format!(
                    "runMarker={run_marker} durationMs={duration_ms} reportPath={report_path} stopOk=true reportCompleted=true"
                ),
            )
        } else {
            (
                "error",
                "watch_mode.diagnostic_report_capture_failed",
                format!(
                    "runMarker={run_marker} durationMs={duration_ms} reportPath={report_path} stopOk={} reportCompleted={report_completed} reportSaved={} stopError={} writeError={}",
                    stop_result.is_ok(),
                    write_result.is_ok(),
                    stop_result
                        .as_ref()
                        .err()
                        .map(String::as_str)
                        .unwrap_or("-"),
                    write_result
                        .as_ref()
                        .err()
                        .map(String::as_str)
                        .unwrap_or("-"),
                ),
            )
        };
        let _ = append_diagnostics_log(
            &app,
            "runtime",
            level,
            message,
            Some(detail),
            None,
            None,
        );
        if exit_after_report {
            app.exit(if succeeded { 0 } else { 1 });
        }
    });
}

fn write_report_atomic(
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
