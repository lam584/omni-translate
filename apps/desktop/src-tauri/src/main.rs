mod audio;
mod benchmark;
mod bridge;
mod common;
mod diagnostics;
mod provider;
mod runtime;
mod storage;

use audio::events::{
    bootstrap_audio, clear_subtitle_cues, get_audio_runtime_snapshot, preconnect_omni_realtime,
    preconnect_omni_realtime_inner, refresh_audio_devices, start_audio_route,
    start_audio_route_inner, start_speech_dispatch, start_translate_worker, stop_audio_route,
    stop_speech_dispatch, stop_translate_worker,
};
use audio::state::AudioStateStore;
use benchmark::run_model_benchmark;
use bridge::events::{
    get_bridge_runtime_snapshot, install_driver_runtime, refresh_bridge_runtime,
    repair_driver_runtime, start_bridge_service, stop_bridge_service, uninstall_driver_runtime,
};
use bridge::state::BridgeStateStore;
use diagnostics::events::{
    append_diagnostics_log, append_frontend_diagnostics_log, export_diagnostics_bundle,
    get_diagnostics_snapshot, get_live_session_events, run_diagnostics_self_check,
    run_subtitle_overlay_self_check, set_diagnostics_log_level,
};
use diagnostics::state::DiagnosticsStateStore;
use provider::events::{execute_provider_smoke, fetch_provider_models, probe_provider};
use runtime::contracts::RuntimeNotification;
use runtime::events::sync_subtitle_overlay_window_state;
use runtime::events::{
    bootstrap_runtime, emit_runtime_notification, emit_runtime_snapshot, get_runtime_snapshot,
    show_subtitle_overlay, sync_subtitle_overlay_chrome, sync_subtitle_overlay_region,
    toggle_subtitle_overlay,
};
use runtime::state::{now_marker, RuntimeStateStore};
use runtime::tray::initialize_tray;
use runtime::windows::ensure_subtitle_overlay_window;
use storage::credential::{CredentialVault, KeyringCredentialVault};
use storage::events::{
    bootstrap_storage, create_config_snapshot, export_config_draft, get_secret_ref_status,
    get_storage_snapshot, import_config_draft, load_config_draft, read_secret_ref,
    reset_config_draft, rollback_config_snapshot, save_config_draft, upsert_secret_ref,
};
use tauri::{AppHandle, Emitter, Manager};

use serde::Serialize;
use serde_json::Value;
use std::time::Instant;
use storage::StorageStateStore;
use uuid::Uuid;

const CREDENTIAL_DIRECT_RESULT_EVENT: &str = "credential://direct-result";
const DEFAULT_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID: &str =
    "template-dashscope-realtime::qwen3.6-flash-2026-04-16";
const DEFAULT_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID: &str =
    "template-dashscope-realtime::qwen3.5-omni-plus-realtime";

#[derive(Clone, Serialize)]
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

    set_json_pointer_string(&mut config, &["devices", "routeMode"], "watch".to_string());
    if !output_device_id.is_empty() {
        set_json_pointer_string(
            &mut config,
            &["devices", "outputDeviceId"],
            output_device_id.clone(),
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
        subtitle_translation_model_id.clone(),
    );
    set_json_pointer_string(
        &mut config,
        &["devices", "inboundSecondaryAudioModelId"],
        inbound_secondary_audio_model_id.clone(),
    );
    if !watch_model_id.is_empty() {
        set_json_pointer_string(
            &mut config,
            &["devices", "inboundVoiceModelId"],
            watch_model_id.clone(),
        );
        set_json_pointer_string(
            &mut config,
            &["devices", "outboundVoiceModelId"],
            watch_model_id.clone(),
        );
        set_json_pointer_string(
            &mut config,
            &["devices", "textToSpeechModelId"],
            watch_model_id.clone(),
        );
        set_json_pointer_string(
            &mut config,
            &["speech", "textToSpeechModelId"],
            watch_model_id.clone(),
        );
    }
    set_json_pointer_string(
        &mut config,
        &["devices", "textToSpeechModelId"],
        inbound_secondary_audio_model_id.clone(),
    );
    set_json_pointer_string(
        &mut config,
        &["speech", "textToSpeechModelId"],
        inbound_secondary_audio_model_id.clone(),
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
        "virtual-driver".to_string(),
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
                    "runMarker={} outputDeviceId={} outputLevel={} translationAudioSource={} watchModelId={} feedbackLoopPrevention=virtual-driver",
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
fn debug_ipc_ping(
    app: AppHandle,
    storage: tauri::State<'_, StorageStateStore>,
) -> Result<String, String> {
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
    diagnostics::file_logger::init(log::Level::Warn);

    tauri::Builder::default()
        .manage(AudioStateStore::new())
        .manage(BridgeStateStore::new())
        .manage(DiagnosticsStateStore::new())
        .manage(RuntimeStateStore::new())
        .manage(StorageStateStore::new())
        .invoke_handler(tauri::generate_handler![
            get_runtime_snapshot,
            bootstrap_runtime,
            toggle_subtitle_overlay,
            show_subtitle_overlay,
            sync_subtitle_overlay_chrome,
            sync_subtitle_overlay_region,
            sync_subtitle_overlay_window_state,
            get_bridge_runtime_snapshot,
            refresh_bridge_runtime,
            start_bridge_service,
            stop_bridge_service,
            install_driver_runtime,
            uninstall_driver_runtime,
            repair_driver_runtime,
            get_diagnostics_snapshot,
            set_diagnostics_log_level,
            append_frontend_diagnostics_log,
            run_diagnostics_self_check,
            run_subtitle_overlay_self_check,
            export_diagnostics_bundle,
            get_live_session_events,
            bootstrap_audio,
            get_audio_runtime_snapshot,
            refresh_audio_devices,
            preconnect_omni_realtime,
            start_audio_route,
            stop_audio_route,
            start_speech_dispatch,
            stop_speech_dispatch,
            start_translate_worker,
            stop_translate_worker,
            clear_subtitle_cues,
            fetch_provider_models,
            probe_provider,
            execute_provider_smoke,
            bootstrap_storage,
            get_storage_snapshot,
            load_config_draft,
            save_config_draft,
            reset_config_draft,
            export_config_draft,
            import_config_draft,
            create_config_snapshot,
            rollback_config_snapshot,
            upsert_secret_ref,
            get_secret_ref_status,
            read_secret_ref,
            debug_ipc_ping,
            debug_cred_direct,
            run_model_benchmark
        ])
        .setup(|app| {
            let setup_start = Instant::now();
            let app_handle = app.handle().clone();
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

            match ensure_subtitle_overlay_window(&app_handle) {
                Ok(_) => {
                    log_info!(
                        &app_handle,
                        "runtime",
                        "字幕浮窗已预创建",
                        "label=subtitle-overlay visible=false".to_string()
                    );
                }
                Err(error) => {
                    let detail = error.to_string();
                    let _ = append_diagnostics_log(
                        &app_handle,
                        "runtime",
                        "warning",
                        "字幕浮窗预创建失败，首次显示时将重试。",
                        Some(detail),
                        None,
                        None,
                    );
                }
            }

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
                        now_marker(),
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
                        now_marker(),
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

            maybe_start_watch_mode_diagnostic(app);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
