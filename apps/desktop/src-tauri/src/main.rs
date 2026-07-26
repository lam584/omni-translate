mod audio;
mod api_v2;
mod benchmark;
mod bridge;
mod common;
#[cfg(test)]
mod contract_export;
mod diagnostics;
mod provider;
mod runtime;
mod shared;
mod storage;
mod wiring;

use audio::events::{
    preconnect_omni_realtime, preconnect_omni_realtime_inner, start_audio_route,
    start_audio_route_inner, stop_audio_route,
};
use api_v2::{bridge_v2, configuration_v2, diagnostics_v2, provider_v2, session_v2};
use audio::state::AudioStateStore;
use bridge::events::start_bridge_service;
use bridge::state::BridgeStateStore;
use diagnostics::events::{
    append_diagnostics_log, append_frontend_diagnostics_logs, set_diagnostics_log_level,
};
use runtime::contracts::RuntimeNotification;
use runtime::events::sync_subtitle_overlay_window_state;
use runtime::events::unlock_subtitle_overlay;
use runtime::events::{
    emit_runtime_notification, emit_runtime_snapshot, show_subtitle_overlay,
    toggle_subtitle_overlay,
};
use runtime::windows::ensure_subtitle_overlay_window;
use runtime::state::RuntimeStateStore;
use shared::time::now_unix_seconds_marker;
use runtime::tray::initialize_tray;
use storage::credential::{CredentialVault, KeyringCredentialVault};
use storage::events::{bootstrap_storage, load_config_draft};
use tauri::{AppHandle, Emitter, Manager};

use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use storage::StorageStateStore;
use uuid::Uuid;

const CREDENTIAL_DIRECT_RESULT_EVENT: &str = "credential://direct-result";
const DEFAULT_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID: &str =
    "template-dashscope-realtime::qwen3.6-flash-2026-04-16";
const DEFAULT_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID: &str =
    "template-dashscope-realtime::qwen3.5-omni-plus-realtime";
static IPC_PING_RECEIVED: AtomicBool = AtomicBool::new(false);

// The renderer owns IPC warm-up recovery (an escalating ping-retry loop plus a
// background reconnect probe — see apps/desktop/src/runtime/desktop-runtime.ts).
// This watchdog is PASSIVE: after the grace window elapses it only records
// whether the native IPC channel ever came up. It must never reload or
// recreate the window — neither re-binds a native channel that failed to
// initialize, and destroying the sole main window quits/crashes the whole app.
const IPC_WATCHDOG_GRACE: Duration = Duration::from_secs(65);

#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
struct CredentialDirectResultEvent {
    job_id: String,
    reference: String,
    success: bool,
    detail: Option<String>,
    error: Option<String>,
    elapsed_ms: u128,
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn set_json_pointer_string(config: &mut Value, path: &[&str], value: String) {
    if path.is_empty() {
        return;
    }
    let mut current = config;
    for key in &path[..path.len() - 1] {
        if !current.get(*key).is_some_and(Value::is_object) {
            current[*key] = Value::Object(Default::default());
        }
        current = current
            .get_mut(*key)
            .expect("object key exists after insert");
    }
    current[path[path.len() - 1]] = Value::String(value);
}

fn set_json_pointer_number(config: &mut Value, path: &[&str], value: i64) {
    if path.is_empty() {
        return;
    }
    let mut current = config;
    for key in &path[..path.len() - 1] {
        if !current.get(*key).is_some_and(Value::is_object) {
            current[*key] = Value::Object(Default::default());
        }
        current = current
            .get_mut(*key)
            .expect("object key exists after insert");
    }
    current[path[path.len() - 1]] = Value::Number(value.into());
}

fn set_json_pointer_bool(config: &mut Value, path: &[&str], value: bool) {
    if path.is_empty() {
        return;
    }
    let mut current = config;
    for key in &path[..path.len() - 1] {
        if !current.get(*key).is_some_and(Value::is_object) {
            current[*key] = Value::Object(Default::default());
        }
        current = current
            .get_mut(*key)
            .expect("object key exists after insert");
    }
    current[path[path.len() - 1]] = Value::Bool(value);
}

fn configure_watch_mode(
    mut config: &mut Value,
    output_device_id: &str,
    output_level: i64,
    watch_model_id: &str,
    subtitle_translation_model_id: &str,
    inbound_secondary_audio_model_id: &str,
    force_subtitle_tts: bool,
    feedback_loop_prevention: &str,
) {
    set_json_pointer_string(&mut config, &["devices", "routeMode"], "watch".to_string());
    if !output_device_id.is_empty() {
        set_json_pointer_string(
            &mut config,
            &["devices", "outputDeviceId"],
            output_device_id.to_string(),
        );
    }
    set_json_pointer_number(&mut config, &["devices", "outputLevel"], output_level);
    set_json_pointer_string(
        &mut config,
        &["devices", "subtitleTranslationMode"],
        "secondary".to_string(),
    );
    set_json_pointer_string(
        &mut config,
        &["devices", "subtitleTranslationModelId"],
        subtitle_translation_model_id.to_string(),
    );
    set_json_pointer_string(
        &mut config,
        &["devices", "inboundSecondaryAudioModelId"],
        inbound_secondary_audio_model_id.to_string(),
    );
    if !watch_model_id.is_empty() {
        set_json_pointer_string(
            &mut config,
            &["devices", "inboundVoiceModelId"],
            watch_model_id.to_string(),
        );
        set_json_pointer_string(
            &mut config,
            &["devices", "outboundVoiceModelId"],
            watch_model_id.to_string(),
        );
        set_json_pointer_string(
            &mut config,
            &["devices", "textToSpeechModelId"],
            watch_model_id.to_string(),
        );
        set_json_pointer_string(
            &mut config,
            &["speech", "textToSpeechModelId"],
            watch_model_id.to_string(),
        );
    }
    set_json_pointer_string(
        &mut config,
        &["devices", "textToSpeechModelId"],
        inbound_secondary_audio_model_id.to_string(),
    );
    set_json_pointer_string(
        &mut config,
        &["speech", "textToSpeechModelId"],
        inbound_secondary_audio_model_id.to_string(),
    );
    set_json_pointer_bool(&mut config, &["speech", "enabled"], true);
    set_json_pointer_bool(&mut config, &["devices", "outputSpeechEnabled"], true);
    set_json_pointer_string(
        &mut config,
        &["speech", "outputTarget"],
        "speaker".to_string(),
    );
    set_json_pointer_bool(&mut config, &["speech", "localPlaybackEnabled"], true);
    set_json_pointer_bool(&mut config, &["speech", "virtualMicOutputEnabled"], false);
    set_json_pointer_string(
        &mut config,
        &["devices", "feedbackLoopPrevention"],
        feedback_loop_prevention.to_string(),
    );
    set_json_pointer_bool(
        &mut config,
        &["devices", "inboundRoute", "mixControl", "keepOriginalAudio"],
        true,
    );
    set_json_pointer_bool(
        &mut config,
        &[
            "devices",
            "inboundRoute",
            "mixControl",
            "translatedAudioEnabled",
        ],
        true,
    );
    set_json_pointer_number(
        &mut config,
        &[
            "devices",
            "inboundRoute",
            "mixControl",
            "originalAudioGainDb",
        ],
        0,
    );
    set_json_pointer_number(
        &mut config,
        &[
            "devices",
            "inboundRoute",
            "mixControl",
            "translatedAudioGainDb",
        ],
        0,
    );
    set_json_pointer_bool(&mut config, &["vad", "bypass"], true);
    set_json_pointer_bool(
        &mut config,
        &["devices", "inboundRoute", "mixControl", "duckingEnabled"],
        true,
    );
    set_json_pointer_string(
        &mut config,
        &["devices", "inboundRoute", "mixControl", "monitorMode"],
        "original-and-translated".to_string(),
    );
    if force_subtitle_tts {
        set_json_pointer_string(
            &mut config,
            &["speech", "translationAudioSource"],
            "subtitle-tts".to_string(),
        );
    }

}

fn maybe_start_watch_mode_diagnostic(app: &tauri::App) {
    if !env_flag_enabled("OMNI_WATCH_MODE_AUTOSTART") {
        return;
    }

    let app_handle = app.handle().clone();
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
    let subtitle_translation_model_id =
        std::env::var("OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID")
            .unwrap_or_else(|_| DEFAULT_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID.to_string())
            .trim()
            .to_string();
    let subtitle_translation_model_id = if subtitle_translation_model_id.is_empty() {
        DEFAULT_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID.to_string()
    } else {
        subtitle_translation_model_id
    };
    let inbound_secondary_audio_model_id =
        std::env::var("OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID")
            .unwrap_or_else(|_| DEFAULT_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID.to_string())
            .trim()
            .to_string();
    let inbound_secondary_audio_model_id = if inbound_secondary_audio_model_id.is_empty() {
        DEFAULT_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID.to_string()
    } else {
        inbound_secondary_audio_model_id
    };
    let force_subtitle_tts = std::env::var("OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE")
        .map(|value| value.trim().eq_ignore_ascii_case("subtitle-tts"))
        .unwrap_or(true);
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
            "runMarker={} outputDeviceIdSet={} outputLevel={} watchModelId={} subtitleTranslationModelId={} inboundSecondaryAudioModelId={}",
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
            subtitle_translation_model_id,
            inbound_secondary_audio_model_id
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

    configure_watch_mode(
        &mut config,
        &output_device_id,
        output_level,
        &watch_model_id,
        &subtitle_translation_model_id,
        &inbound_secondary_audio_model_id,
        force_subtitle_tts,
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
                    "runMarker={} outputDeviceId={} outputLevel={} translationAudioSource={} watchModelId={} feedbackLoopPrevention={}",
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
                    if force_subtitle_tts {
                        "subtitle-tts"
                    } else {
                        "configured"
                    },
                    if watch_model_id.is_empty() {
                        "-"
                    } else {
                        watch_model_id.as_str()
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

#[tauri::command]
async fn debug_ipc_ping(
    app: AppHandle,
    storage: tauri::State<'_, StorageStateStore>,
) -> Result<String, String> {
    IPC_PING_RECEIVED.store(true, Ordering::Release);
    let start = Instant::now();
    let snapshot = storage.snapshot();
    log_debug!(
        &app,
        "runtime",
        "debug_ipc_ping",
        format!(
            "status={} elapsedMs={}",
            snapshot.status,
            start.elapsed().as_millis()
        ),
        start.elapsed().as_millis()
    );
    Ok(format!(
        "pong storage_status={} elapsed_ms={}",
        snapshot.status,
        start.elapsed().as_millis()
    ))
}

#[tauri::command]
async fn debug_cred_direct(
    app: AppHandle,
    reference: String,
    secret: String,
) -> Result<String, String> {
    let t0 = Instant::now();
    let job_id = format!("cred-job-{}", Uuid::new_v4());
    log_debug!(
        &app,
        "storage",
        "debug_cred_direct started",
        format!(
            "jobId={} reference={} secretLength={}",
            job_id,
            reference,
            secret.len()
        )
    );

    let app_handle = app.clone();
    let reference_for_task = reference.clone();
    let reference_for_event = reference.clone();
    let secret_for_task = secret.clone();
    let job_id_for_task = job_id.clone();
    let job_id_for_event = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let vault = KeyringCredentialVault::new();
            vault.upsert_secret(&reference_for_task, &secret_for_task)
        })
        .await;

        let elapsed_ms = t0.elapsed().as_millis();
        match result {
            Ok(Ok(())) => {
                log_info!(
                    &app_handle,
                    "storage",
                    "debug_cred_direct ok",
                    format!(
                        "jobId={} reference={} elapsedMs={}",
                        job_id_for_task, reference_for_event, elapsed_ms
                    )
                );
                let detail = Some(format!(
                    "written ref={} elapsedMs={}",
                    reference_for_event.clone(),
                    elapsed_ms
                ));
                let _ = app_handle.emit(
                    CREDENTIAL_DIRECT_RESULT_EVENT,
                    CredentialDirectResultEvent {
                        job_id: job_id_for_event,
                        reference: reference_for_event,
                        success: true,
                        detail,
                        error: None,
                        elapsed_ms,
                    },
                );
            }
            Ok(Err(error)) => {
                log_error!(
                    &app_handle,
                    "storage",
                    "debug_cred_direct error",
                    format!(
                        "jobId={} reference={} elapsedMs={} error={}",
                        job_id_for_task, reference_for_event, elapsed_ms, error
                    )
                );
                let _ = app_handle.emit(
                    CREDENTIAL_DIRECT_RESULT_EVENT,
                    CredentialDirectResultEvent {
                        job_id: job_id_for_event,
                        reference: reference_for_event,
                        success: false,
                        detail: None,
                        error: Some(error),
                        elapsed_ms,
                    },
                );
            }
            Err(join_error) => {
                let error = join_error.to_string();
                log_error!(
                    &app_handle,
                    "storage",
                    "debug_cred_direct join error",
                    format!(
                        "jobId={} reference={} elapsedMs={} error={}",
                        job_id_for_task, reference_for_event, elapsed_ms, error
                    )
                );
                let _ = app_handle.emit(
                    CREDENTIAL_DIRECT_RESULT_EVENT,
                    CredentialDirectResultEvent {
                        job_id: job_id_for_event,
                        reference: reference_for_event,
                        success: false,
                        detail: None,
                        error: Some(error),
                        elapsed_ms,
                    },
                );
            }
        }
    });

    log_debug!(
        &app,
        "storage",
        "debug_cred_direct submitted",
        format!(
            "jobId={} reference={} elapsedMs={}",
            job_id,
            reference,
            t0.elapsed().as_millis()
        )
    );
    Ok(job_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn main() {
    let diagnostics_store = diagnostics::bootstrap_logging();
    let diagnostics_store_for_notifications = diagnostics_store.clone();

    tauri::Builder::default()
        .manage(AudioStateStore::new())
        .manage(BridgeStateStore::new())
        .manage(diagnostics_store)
        .manage(RuntimeStateStore::new())
        .manage(provider::state::ProviderStateStore::new())
        .manage(StorageStateStore::new())
        // Registration whitelist. The renderer talks to the five *_v2 service
        // envelopes; every other entry below is a deliberately direct command
        // with a written reason — see the header comment of
        // apps/desktop/src/runtime/desktop-api-v2.ts for the authoritative
        // list. In short: overlay window commands (separately bootstrapped
        // renderer), logger plumbing (fire-and-forget), the IPC liveness
        // probe, the sub-second start_audio_route click path, and the
        // commands the live-matrix / IPC self-test scripts invoke over CLI
        // (start_bridge_service, preconnect_omni_realtime, stop_audio_route,
        // bootstrap_storage, load_config_draft, debug_ipc_ping,
        // debug_cred_direct). Removing a script-invoked command requires
        // re-running the live matrix on real hardware.
        .invoke_handler(tauri::generate_handler![
            toggle_subtitle_overlay,
            show_subtitle_overlay,
            sync_subtitle_overlay_window_state,
            start_bridge_service,
            set_diagnostics_log_level,
            append_frontend_diagnostics_logs,
            preconnect_omni_realtime,
            start_audio_route,
            stop_audio_route,
            bootstrap_storage,
            load_config_draft,
            debug_ipc_ping,
            debug_cred_direct,
            provider_v2,
            session_v2,
            bridge_v2,
            diagnostics_v2,
            configuration_v2,
            unlock_subtitle_overlay
        ])
        .setup(move |app| {
            let setup_start = Instant::now();
            let app_handle = app.handle().clone();
            IPC_PING_RECEIVED.store(false, Ordering::Release);

            // Connect the diagnostics <-> runtime shared-bus seams; the
            // wiring module is the only place that references both sides.
            wiring::install_diagnostics_runtime_seams(
                &app_handle,
                diagnostics_store_for_notifications.clone(),
            );
            let state = app.state::<RuntimeStateStore>();
            let storage = app.state::<StorageStateStore>();

            log_info!(
                &app_handle,
                "runtime",
                "Tauri setup 开始，正在初始化存储层..."
            );

            let storage_snapshot = storage
                .ensure_initialized(&app_handle)
                .map_err(std::io::Error::other)?;

            log_info!(
                &app_handle,
                "runtime",
                "存储层初始化完成",
                format!(
                    "db={} schemaVersion={}",
                    storage_snapshot.database_path, storage_snapshot.schema_version
                )
            );

            state.mark_ready();
            log_info!(
                &app_handle,
                "runtime",
                "Runtime state 已标记为 ready，开始初始化系统托盘..."
            );

            let tray_status = match initialize_tray(&app_handle, &state) {
                Ok(()) => {
                    log_info!(&app_handle, "runtime", "系统托盘初始化成功");
                    "ready"
                }
                Err(error) => {
                    let detail = error.to_string();
                    let _ = append_diagnostics_log(
                        &app_handle,
                        "runtime",
                        "warning",
                        "系统托盘初始化失败，主窗口继续运行。",
                        Some(detail),
                        None,
                        None,
                    );
                    state.set_tray_ready(false);
                    "warning"
                }
            };

            // NOTE: Do NOT synchronously build the subtitle-overlay WebView2
            // window here during `setup`. Creating a second WebView2 controller
            // synchronously pumps nested window messages on the main thread
            // while the *main* window's WebView2 IPC channel is still binding
            // asynchronously. The two race on the shared main-thread message
            // pump and can drop the main window's IPC-init messages, leaving the
            // native IPC channel permanently unbound -> every `invoke` hangs and
            // the renderer falls back to "运行时错误" / browser-preview mode.
            // The overlay is created lazily on first show via
            // `ensure_subtitle_overlay_window` (idempotent), which runs only
            // after the main IPC channel is warm.

            emit_runtime_notification(
                &app_handle,
                &state,
                if tray_status == "ready" {
                    RuntimeNotification::info(
                        "runtime-shell-ready",
                        "rust-core",
                        &format!(
                            "Tauri shell、主窗口、托盘与存储层已初始化。schemaVersion={} / db={}",
                            storage_snapshot.schema_version, storage_snapshot.database_path
                        ),
                        now_unix_seconds_marker(),
                    )
                } else {
                    RuntimeNotification::warning(
                        "runtime-shell-ready-without-tray",
                        "rust-core",
                        &format!(
              "Tauri shell 与存储层已初始化，但系统托盘未就绪。schemaVersion={} / db={}",
              storage_snapshot.schema_version,
              storage_snapshot.database_path
            ),
                        now_unix_seconds_marker(),
                    )
                },
            )?;
            emit_runtime_snapshot(&app_handle, &state)?;

            log_info!(
                &app_handle,
                "runtime",
                "Tauri setup 完成",
                format!(
                    "trayStatus={} totalElapsedMs={}",
                    tray_status,
                    setup_start.elapsed().as_millis()
                ),
                setup_start.elapsed().as_millis()
            );

            let ipc_watchdog_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(IPC_WATCHDOG_GRACE).await;
                if IPC_PING_RECEIVED.load(Ordering::Acquire) {
                    return;
                }

                // Passive diagnostic only. The renderer owns IPC warm-up
                // recovery; reloading or recreating the window here does not
                // re-bind a native IPC channel that never initialized and
                // previously crashed the app, so we only record the condition.
                let _ = append_diagnostics_log(
                    &ipc_watchdog_handle,
                    "runtime",
                    "error",
                    "startup.ipc_never_connected",
                    Some(format!(
                        "graceSecs={} note=frontend never reached debug_ipc_ping; native IPC channel did not initialize",
                        IPC_WATCHDOG_GRACE.as_secs(),
                    )),
                    None,
                    None,
                );
            });

            // Pre-create the subtitle-overlay WebView2 window during the startup
            // idle window, once the renderer's IPC channel is warm. Building it
            // lazily inside the *synchronous* `toggle_subtitle_overlay` command
            // deadlocks: WebView2 controller creation needs the main-thread
            // message loop that the command is blocking, so the first "显示浮窗"
            // click hangs until the renderer's 15s timeout fires. Creating it here
            // (on the idle event loop, via run_on_main_thread) means
            // `ensure_subtitle_overlay_window` in the toggle command always hits
            // the fast "already exists" path. Gating on IPC_PING_RECEIVED avoids
            // the setup-time race that previously dropped the main window's
            // IPC-init messages (see the note above about not building here).
            let overlay_prewarm_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..600 {
                    if IPC_PING_RECEIVED.load(Ordering::Acquire) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                if !IPC_PING_RECEIVED.load(Ordering::Acquire) {
                    return;
                }
                // Small extra grace so the main window finishes its startup message
                // storm before the nested pump inside WebView2 creation runs.
                tokio::time::sleep(Duration::from_millis(250)).await;
                let overlay_app = overlay_prewarm_handle.clone();
                let _ = overlay_prewarm_handle.run_on_main_thread(move || {
                    match ensure_subtitle_overlay_window(&overlay_app) {
                        Ok(_) => {
                            log_info!(
                                &overlay_app,
                                "runtime",
                                "字幕浮窗已在启动空闲期预创建（隐藏），点击显示时无需再建窗。"
                            );
                        }
                        Err(error) => {
                            let _ = append_diagnostics_log(
                                &overlay_app,
                                "runtime",
                                "warning",
                                "字幕浮窗预创建失败，将在首次点击时懒加载（可能较慢）。",
                                Some(error.to_string()),
                                None,
                                None,
                            );
                        }
                    }
                });
            });

            maybe_start_watch_mode_diagnostic(app);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
