use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use super::contracts::AudioRuntimeSnapshot;
use super::engine;
use super::gemini_live;
use super::omni;
use super::openai_realtime;
use super::speech;
use super::state::AudioStateStore;
use super::stt;
use super::subtitle_translate;
use super::translate;
use crate::bridge::{ipc::flush_bridge_source, state::BridgeStateStore};
use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::ProviderDraftInput;
use crate::runtime::events::show_subtitle_overlay_with_state;
use crate::runtime::state::RuntimeStateStore;

pub const AUDIO_RUNTIME_SNAPSHOT_EVENT: &str = "audio://snapshot";
const OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT: Duration = Duration::from_secs(45);
const OMNI_ROUTE_SESSION_READINESS_TIMEOUT: Duration = Duration::from_secs(90);
const OMNI_PRECONNECT_COMMAND_TIMEOUT: Duration = Duration::from_secs(50);
const OMNI_ROUTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(95);
const DEFAULT_ROUTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

fn should_show_subtitle_overlay_for_route(direction: &str, config: &Value) -> bool {
    direction == "inbound"
        && config.pointer("/devices/routeMode").and_then(Value::as_str) == Some("watch")
}

fn route_command_timeout(direction: &str, config: &Value) -> Duration {
    if direction == "inbound"
        && config.pointer("/devices/routeMode").and_then(Value::as_str) == Some("watch")
        && config
            .pointer("/devices/inboundVoiceModelId")
            .and_then(Value::as_str)
            .map(resolve_voice_model_runtime_id)
            .map(|model| is_omni_model(&model))
            .unwrap_or(false)
    {
        return OMNI_ROUTE_COMMAND_TIMEOUT;
    }

    DEFAULT_ROUTE_COMMAND_TIMEOUT
}

fn route_command_timeout_message(direction: &str, config: &Value, timeout: Duration) -> String {
    let route_mode = config
        .pointer("/devices/routeMode")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!(
        "音频采集启动超时：direction={direction} routeMode={route_mode}，{} 秒内未收到后端结果。请检查 Bridge/驱动状态和实时模型连接。",
        timeout.as_secs()
    )
}

fn resolve_voice_model_runtime_id(value: &str) -> String {
    value
        .rsplit_once("::")
        .map(|(_, model)| model)
        .unwrap_or(value)
        .to_string()
}

fn stop_existing_inbound_pipeline(
    app: &AppHandle,
    state: &AudioStateStore,
    keep_omni: bool,
) -> Result<(), String> {
    engine::stop_route(app.clone(), state, "inbound")?;
    if let Some(bridge_state) = app.try_state::<BridgeStateStore>() {
        let _ = flush_bridge_source(&bridge_state.snapshot());
    }
    if let Some(handle) = state.take_stt_handle("inbound") {
        let _ = handle.stop_tx.send(());
    }
    if !keep_omni {
        if let Some(handle) = state.take_omni_handle("inbound") {
            let _ = handle.stop_tx.send(());
        }
    }
    let _ = subtitle_translate::stop_subtitle_translate(app.clone(), state);
    let _ = speech::stop_dispatch(app.clone(), state);
    Ok(())
}

fn start_route_with_overlay(
    app: AppHandle,
    state: &AudioStateStore,
    direction: &str,
    config: Value,
    stt_sender: Option<std::sync::mpsc::Sender<Vec<u8>>>,
) -> Result<AudioRuntimeSnapshot, String> {
    let should_show_overlay = should_show_subtitle_overlay_for_route(direction, &config);
    let route_mode = config
        .pointer("/devices/routeMode")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "watch_mode.route_start",
        Some(format!(
            "direction={direction} routeMode={route_mode} overlayExpected={should_show_overlay}"
        )),
        None,
        None,
    );
    let snapshot = engine::start_route(app.clone(), state, direction, config, stt_sender)?;

    if should_show_overlay {
        if let Some(runtime_state) = app.try_state::<RuntimeStateStore>() {
            let runtime_snapshot = show_subtitle_overlay_with_state(&app, &runtime_state)?;
            let overlay_visible = runtime_snapshot
                .windows
                .iter()
                .find(|window| window.label == "subtitle-overlay")
                .map(|window| window.visible)
                .unwrap_or(false);
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "info",
                "watch_mode.overlay_visible",
                Some(format!("label=subtitle-overlay visible={overlay_visible}")),
                None,
                None,
            );
        }
    }

    Ok(snapshot)
}

#[tauri::command]
pub fn bootstrap_audio(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
) -> Result<AudioRuntimeSnapshot, String> {
    engine::bootstrap_audio_runtime(&app, &state)
}

#[tauri::command]
pub fn get_audio_runtime_snapshot(state: State<'_, AudioStateStore>) -> AudioRuntimeSnapshot {
    state.snapshot()
}

#[tauri::command]
pub fn refresh_audio_devices(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
) -> Result<AudioRuntimeSnapshot, String> {
    engine::refresh_devices(&app, &state)
}

fn start_or_reuse_omni_session(
    app: &AppHandle,
    state: &AudioStateStore,
    config: &Value,
    voice_provider: ProviderDraftInput,
    direction: &str,
    phase: &str,
    st_active: bool,
    target_lang: &str,
    readiness_timeout: Duration,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    let voice_model = voice_provider.model.clone();
    let log_readiness_failure = |reason: &str, detail: String| {
        let _ = append_diagnostics_log(
            app,
            "audio",
            "error",
            "watch_mode.omni_session_readiness_failed",
            Some(format!(
                "phase={phase} direction={direction} model={} subtitleTranslateActive={st_active} reason={reason} timeoutMs={} {detail}",
                voice_model,
                readiness_timeout.as_millis()
            )),
            None,
            None,
        );
    };
    if let Some(sender) = state.take_matching_omni_sender(direction, &voice_model, st_active) {
        let generation = state
            .matching_ready_omni_session(direction, &voice_model, st_active)
            .unwrap_or_default();
        let _ = append_diagnostics_log(
            app,
            "audio",
            "info",
            "watch_mode.omni_preconnect_reused",
            Some(format!(
                "direction={direction} generation={generation} model={} subtitleTranslateActive={st_active}",
                voice_model
            )),
            None,
            None,
        );
        return Ok(sender);
    }

    if state.omni_session_metadata(direction).is_some() || state.has_omni_sender(direction) {
        stop_preconnected_omni_session(app, state, direction, "preconnect_not_reusable");
    }

    let voice = config
        .pointer("/speech/voice")
        .and_then(Value::as_str)
        .unwrap_or("Ethan")
        .to_string();
    let instructions = config
        .pointer("/subtitles/instructions")
        .and_then(Value::as_str)
        .unwrap_or("你是一个实时翻译助手，请将听到的外语内容翻译成中文输出。")
        .to_string();
    let audio_mode = resolve_realtime_audio_mode_for_route(direction, config, &voice_provider)?;
    let session_generation = state.begin_omni_session(direction, &voice_provider.model, st_active);
    let (omni_sender, handle, readiness_rx) = match omni::start_omni(
        app.clone(),
        state,
        direction.to_string(),
        session_generation,
        voice_provider,
        voice,
        instructions,
        audio_mode,
        target_lang.to_string(),
        st_active,
        omni::OmniSpeechConfig::from_config(config),
    ) {
        Ok(result) => result,
        Err(error) => {
            log_readiness_failure("start_failed", format!("error=\"{error}\""));
            return Err(error);
        }
    };
    if let Some(previous) = state.store_omni_handle(direction, handle) {
        let _ = previous.stop_tx.send(());
    }
    match readiness_rx.recv_timeout(readiness_timeout) {
        Ok(Ok(ready_generation)) if ready_generation == session_generation => {}
        Ok(Ok(ready_generation)) => {
            let message = format!(
                "Omni session readiness generation mismatch: expected={session_generation} actual={ready_generation}"
            );
            log_readiness_failure(
                "generation_mismatch",
                format!(
                    "expectedGeneration={session_generation} actualGeneration={ready_generation}"
                ),
            );
            stop_preconnected_omni_session(app, state, direction, "readiness_generation_mismatch");
            return Err(message);
        }
        Ok(Err(error)) => {
            let reason = if error.to_ascii_lowercase().contains("connect") {
                "websocket_connect_failed"
            } else {
                "session_event_failed"
            };
            log_readiness_failure(
                reason,
                format!("generation={session_generation} error=\"{error}\""),
            );
            stop_preconnected_omni_session(app, state, direction, "readiness_failed");
            return Err(error);
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            let _ = state.mark_omni_session_stopping(
                direction,
                session_generation,
                "readiness_timeout",
            );
            log_readiness_failure(
                "session_event_timeout",
                format!("generation={session_generation}"),
            );
            stop_preconnected_omni_session(app, state, direction, "readiness_timeout");
            return Err(format!(
                "Omni session readiness timed out after {}ms",
                readiness_timeout.as_millis()
            ));
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            log_readiness_failure(
                "readiness_channel_disconnected",
                format!("generation={session_generation}"),
            );
            stop_preconnected_omni_session(app, state, direction, "readiness_channel_disconnected");
            return Err(
                "Omni session readiness channel disconnected before ready event".to_string(),
            );
        }
    }
    Ok(omni_sender)
}

fn subtitle_translate_mode_and_model(config: &Value) -> (&str, &str) {
    let mode = config
        .pointer("/devices/subtitleTranslationMode")
        .and_then(Value::as_str)
        .unwrap_or("secondary");
    let model_id = config
        .pointer("/devices/subtitleTranslationModelId")
        .and_then(Value::as_str)
        .unwrap_or("");
    (mode, model_id)
}

fn apply_native_subtitle_translate_fallback(config: &mut Value) {
    if !config.get("speech").map(Value::is_object).unwrap_or(false) {
        config["speech"] = Value::Object(Default::default());
    }
    if let Some(speech) = config.get_mut("speech").and_then(Value::as_object_mut) {
        speech.insert(
            "translationAudioSource".to_string(),
            Value::String("omni-native".to_string()),
        );
    }
}

fn resolve_secondary_subtitle_provider(
    app: &AppHandle,
    config: &Value,
    mode: &str,
    model_id: &str,
    phase: &str,
) -> Option<ProviderDraftInput> {
    if mode != "secondary" {
        return None;
    }

    if model_id.trim().is_empty() {
        let _ = append_diagnostics_log(
            app,
            "audio",
            "error",
            "watch_mode.subtitle_translate_config_failed",
            Some(format!(
                "phase={phase} subtitleTranslationMode={mode} subtitleTranslationModelId=(empty) fallback=native reason=empty_model_id"
            )),
            None,
            None,
        );
        return None;
    }

    let resolved = resolve_model_provider_from_config(app, config, model_id, "subtitle-translate");
    if resolved.is_none() {
        let _ = append_diagnostics_log(
            app,
            "audio",
            "error",
            "watch_mode.subtitle_translate_config_failed",
            Some(format!(
                "phase={phase} subtitleTranslationMode={mode} subtitleTranslationModelId={model_id} fallback=native reason=provider_not_found"
            )),
            None,
            None,
        );
    }
    resolved
}

fn stop_preconnected_omni_session(
    app: &AppHandle,
    state: &AudioStateStore,
    direction: &str,
    reason: &str,
) {
    let generation = state
        .omni_session_metadata(direction)
        .map(|session| session.session_generation);
    if let Some(generation) = generation {
        let _ = state.mark_omni_session_stopping(direction, generation, reason.to_string());
    }
    let mut discarded = false;
    if let Some(handle) = state.take_omni_handle(direction) {
        let _ = handle.stop_tx.send(());
        discarded = true;
    } else if state.take_omni_sender(direction).is_some() {
        discarded = true;
    }
    if discarded {
        let _ = append_diagnostics_log(
            app,
            "audio",
            "warning",
            "watch_mode.omni_preconnect_discarded",
            Some(format!("direction={direction} reason={reason}")),
            None,
            None,
        );
    }
}

fn start_or_reuse_openai_realtime_session(
    app: &AppHandle,
    state: &AudioStateStore,
    config: &Value,
    voice_provider: ProviderDraftInput,
    direction: &str,
    target_lang: &str,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    if let Some(sender) = state.take_omni_sender(direction) {
        return Ok(sender);
    }

    let instructions = config
        .pointer("/subtitles/instructions")
        .and_then(Value::as_str)
        .unwrap_or("You are a realtime subtitle translator. Translate incoming audio into concise subtitles.")
        .to_string();
    let audio_mode = resolve_realtime_audio_mode_for_route(direction, config, &voice_provider)?;
    let (sender, handle) = openai_realtime::start_openai_realtime(
        app.clone(),
        state,
        voice_provider,
        instructions,
        audio_mode,
        target_lang.to_string(),
    )?;
    if let Some(previous) = state.store_omni_handle(direction, handle) {
        let _ = previous.stop_tx.send(());
    }
    Ok(sender)
}

fn start_or_reuse_gemini_live_session(
    app: &AppHandle,
    state: &AudioStateStore,
    config: &Value,
    voice_provider: ProviderDraftInput,
    direction: &str,
    target_lang: &str,
    mode_value: &str,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    if let Some(sender) = state.take_omni_sender(direction) {
        return Ok(sender);
    }

    let instructions = config
        .pointer("/subtitles/instructions")
        .and_then(Value::as_str)
        .unwrap_or("You are a realtime subtitle translator. Translate incoming audio into concise subtitles.")
        .to_string();
    let mode = gemini_live::GeminiActivityMode::from_config_value(mode_value)?;
    let (sender, handle) = gemini_live::start_gemini_live(
        app.clone(),
        state,
        voice_provider,
        instructions,
        mode,
        target_lang.to_string(),
    )?;
    if let Some(previous) = state.store_omni_handle(direction, handle) {
        let _ = previous.stop_tx.send(());
    }
    Ok(sender)
}

#[tauri::command]
pub async fn preconnect_omni_realtime(
    app: AppHandle,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    let app_for_task = app.clone();
    match tokio::time::timeout(
        OMNI_PRECONNECT_COMMAND_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            let app_for_state = app_for_task.clone();
            let state = app_for_state.state::<AudioStateStore>();
            preconnect_omni_realtime_inner(app_for_task, &state, config)
        }),
    )
    .await
    {
        Ok(joined) => joined.map_err(|error| error.to_string())?,
        Err(_) => {
            let message = format!(
                "Omni 预连接超时：{} 秒内未完成会话就绪检查，已取消本次等待。",
                OMNI_PRECONNECT_COMMAND_TIMEOUT.as_secs()
            );
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "error",
                "watch_mode.omni_preconnect_command_timeout",
                Some(message.clone()),
                None,
                None,
            );
            let state = app.state::<AudioStateStore>();
            Ok(state.snapshot())
        }
    }
}

pub(crate) fn preconnect_omni_realtime_inner(
    app: AppHandle,
    state: &AudioStateStore,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    let _pipeline_guard = state.lock_inbound_pipeline();
    let requested_voice_model = config
        .pointer("/devices/inboundVoiceModelId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let Some(voice_provider) =
        resolve_model_provider_from_config(&app, &config, &requested_voice_model, "voice")
    else {
        return Ok(state.snapshot());
    };
    if !is_omni_model(&voice_provider.model) {
        return Ok(state.snapshot());
    }

    let (subtitle_translate_mode, subtitle_translate_model_id) =
        subtitle_translate_mode_and_model(&config);
    let st_active = resolve_secondary_subtitle_provider(
        &app,
        &config,
        subtitle_translate_mode,
        subtitle_translate_model_id,
        "preconnect",
    )
    .is_some();
    if state
        .matching_ready_omni_session("inbound", &voice_provider.model, st_active)
        .is_some()
        && state.has_omni_sender("inbound")
    {
        return Ok(state.snapshot());
    }
    if state.omni_session_metadata("inbound").is_some() || state.has_omni_sender("inbound") {
        stop_preconnected_omni_session(&app, &state, "inbound", "preconnect_config_changed");
    }
    let target_lang = config
        .pointer("/subtitles/targetLanguage")
        .and_then(Value::as_str)
        .unwrap_or("zh")
        .to_string();
    let sender = start_or_reuse_omni_session(
        &app,
        &state,
        &config,
        voice_provider,
        "inbound",
        "preconnect",
        st_active,
        &target_lang,
        OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT,
    )?;
    state.store_omni_sender("inbound", sender);
    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "watch_mode.omni_preconnect_started",
        Some("direction=inbound".to_string()),
        None,
        None,
    );
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn start_audio_route(
    app: AppHandle,
    direction: String,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    let timeout = route_command_timeout(&direction, &config);
    let timeout_message = route_command_timeout_message(&direction, &config, timeout);
    let app_for_task = app.clone();
    let direction_for_task = direction.clone();
    match tokio::time::timeout(
        timeout,
        tauri::async_runtime::spawn_blocking(move || {
            let app_for_state = app_for_task.clone();
            let state = app_for_state.state::<AudioStateStore>();
            start_audio_route_inner(app_for_task, &state, direction_for_task, config)
        }),
    )
    .await
    {
        Ok(joined) => joined.map_err(|error| error.to_string())?,
        Err(_) => {
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "error",
                "watch_mode.route_command_timeout",
                Some(timeout_message.clone()),
                None,
                None,
            );
            let state = app.state::<AudioStateStore>();
            if direction == "inbound" {
                state.mark_route_error(
                    "inbound",
                    timeout_message.clone(),
                    Some("restart-bridge".to_string()),
                );
                let _ = engine::emit_audio_snapshot(&app, &state);
            }
            Err(timeout_message)
        }
    }
}

pub(crate) fn start_audio_route_inner(
    app: AppHandle,
    state: &AudioStateStore,
    direction: String,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    if direction == "inbound" {
        let _pipeline_guard = state.lock_inbound_pipeline();
        let keep_omni = state.has_omni_sender("inbound");
        stop_existing_inbound_pipeline(&app, &state, keep_omni)?;
        let requested_voice_model = config
            .pointer("/devices/inboundVoiceModelId")
            .and_then(Value::as_str)
            .filter(|model| !model.trim().is_empty())
            .unwrap_or("")
            .to_string();

        if !requested_voice_model.is_empty() {
            let voice_provider = match resolve_model_provider_from_config(
                &app,
                &config,
                &requested_voice_model,
                "voice",
            ) {
                Some(resolved_provider) => {
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "info",
                        format!(
                            "start_audio_route inbound: provider.kind={} provider.model={} provider.template_id={}",
                            resolved_provider.kind,
                            resolved_provider.model,
                            resolved_provider.template_id
                        ),
                        None,
                        None,
                        None,
                    );
                    resolved_provider
                }
                None => {
                    let message = format!(
                        "model provider not found for requested voice model '{requested_voice_model}'"
                    );
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "error",
                        format!("start_audio_route: {message}"),
                        Some(format!("requestedModel={requested_voice_model}")),
                        None,
                        None,
                    );
                    return Err(format!(
                        "无法解析语音模型 Provider: {message}. 请检查模型是否已关联到某个已启用的平台模板。"
                    ));
                }
            };
            let is_dashscope = is_dashscope_provider(&voice_provider);
            let is_omni = is_omni_model(&voice_provider.model);
            let realtime_audio_mode_value =
                resolve_realtime_audio_mode_value(&voice_provider, &voice_provider.model);
            let is_gemini_live = gemini_live::is_gemini_activity_mode(&realtime_audio_mode_value);
            let is_openai_realtime = is_openai_realtime_provider(&voice_provider);
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "info",
                format!(
                    "start_audio_route 分支判定: is_dashscope={is_dashscope} is_omni={is_omni} is_gemini_live={is_gemini_live} is_openai_realtime={is_openai_realtime}"
                ),
                None,
                None,
                None,
            );
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "info",
                format!(
                    "start_audio_route resolved voice provider: requested_model={} provider_id={} kind={} model={} base_url={}",
                    requested_voice_model,
                    voice_provider.provider_id,
                    voice_provider.kind,
                    voice_provider.model,
                    voice_provider.base_url
                ),
                None,
                None,
                None,
            );
            if is_gemini_live {
                let target_lang = config
                    .pointer("/subtitles/targetLanguage")
                    .and_then(Value::as_str)
                    .unwrap_or("zh")
                    .to_string();
                let gemini_sender = start_or_reuse_gemini_live_session(
                    &app,
                    &state,
                    &config,
                    voice_provider,
                    &direction,
                    &target_lang,
                    &realtime_audio_mode_value,
                )?;
                start_route_with_overlay(app, &state, &direction, config, Some(gemini_sender))
            } else if is_omni {
                let mut omni_route_config = config;
                let _voice = omni_route_config
                    .pointer("/speech/voice")
                    .and_then(Value::as_str)
                    .unwrap_or("Ethan")
                    .to_string();
                let _instructions = omni_route_config
                    .pointer("/subtitles/instructions")
                    .and_then(Value::as_str)
                    .unwrap_or("你是一个实时翻译助手，请将听到的外语内容翻译成中文输出。")
                    .to_string();
                let _audio_mode = resolve_realtime_audio_mode_for_route(
                    &direction,
                    &omni_route_config,
                    &voice_provider,
                )?;
                let (subtitle_translate_mode, subtitle_translate_model_id) =
                    subtitle_translate_mode_and_model(&omni_route_config);
                let subtitle_translate_mode = subtitle_translate_mode.to_string();
                let subtitle_translate_model_id = subtitle_translate_model_id.to_string();
                let target_lang = omni_route_config
                    .pointer("/subtitles/targetLanguage")
                    .and_then(Value::as_str)
                    .unwrap_or("zh")
                    .to_string();
                let speech_dispatch_state = state.snapshot().speech.dispatch_state;
                let mut st_active = false;
                if let Some(text_provider) = resolve_secondary_subtitle_provider(
                    &app,
                    &omni_route_config,
                    &subtitle_translate_mode,
                    &subtitle_translate_model_id,
                    "route",
                ) {
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "info",
                        format!(
                            "二次翻译已启用: text_provider.kind={} model={} base_url={}",
                            text_provider.kind, text_provider.model, text_provider.base_url
                        ),
                        None,
                        None,
                        None,
                    );
                    match subtitle_translate::start_subtitle_translate(
                        app.clone(),
                        &state,
                        text_provider,
                        target_lang.clone(),
                    ) {
                        Ok(snapshot) => {
                            st_active = true;
                            let _ = append_diagnostics_log(
                                &app,
                                "audio",
                                "info",
                                format!(
                                    "subtitle_translate worker 启动成功: queue_depth={}",
                                    snapshot.subtitle_overlay.queue_depth
                                ),
                                None,
                                None,
                                None,
                            );
                        }
                        Err(error) => {
                            apply_native_subtitle_translate_fallback(&mut omni_route_config);
                            stop_preconnected_omni_session(
                                &app,
                                &state,
                                &direction,
                                "subtitle_translate_worker_failed",
                            );
                            let _ = append_diagnostics_log(
                                &app,
                                "audio",
                                "error",
                                "watch_mode.subtitle_translate_worker_unavailable",
                                Some(format!(
                                    "subtitleTranslationModelId={subtitle_translate_model_id} fallback=native error={error}"
                                )),
                                None,
                                None,
                            );
                            let _ = append_diagnostics_log(
                                &app,
                                "audio",
                                "warning",
                                "watch_mode.subtitle_translate_fallback_native_applied",
                                Some(format!(
                                    "reason=worker_failed subtitleTranslationModelId={subtitle_translate_model_id} translationAudioSource=omni-native originalError={error}"
                                )),
                                None,
                                None,
                            );
                        }
                    }
                } else if subtitle_translate_mode == "secondary" {
                    apply_native_subtitle_translate_fallback(&mut omni_route_config);
                    stop_preconnected_omni_session(
                        &app,
                        &state,
                        &direction,
                        "subtitle_translate_provider_unresolved",
                    );
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "warning",
                        "watch_mode.subtitle_translate_fallback_native_applied",
                        Some(format!(
                            "reason=provider_unresolved subtitleTranslationModelId={subtitle_translate_model_id} translationAudioSource=omni-native"
                        )),
                        None,
                        None,
                    );
                }
                let speech_enabled = speech::speech_output_enabled(&omni_route_config);
                let translation_audio_source =
                    speech::resolve_translation_audio_source(&omni_route_config, true);
                let should_start_speech_dispatch = should_start_secondary_speech_dispatch(
                    &omni_route_config,
                    st_active,
                    &speech_dispatch_state,
                );
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "info",
                    format!(
                        "start_audio_route 二次翻译判定: subtitleTranslationMode={subtitle_translate_mode} subtitleTranslationModelId={subtitle_translate_model_id} st_active={st_active}"
                    ),
                    None,
                    None,
                    None,
                );
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "info",
                    format!(
                        "start_audio_route secondary speech decision: speech.enabled={} devices.outputSpeechEnabled={} speechEnabled={speech_enabled} translationAudioSource={translation_audio_source:?} speechDispatchState={speech_dispatch_state}",
                        omni_route_config
                            .pointer("/speech/enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        omni_route_config
                            .pointer("/devices/outputSpeechEnabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    ),
                    None,
                    None,
                    None,
                );
                let omni_sender = start_or_reuse_omni_session(
                    &app,
                    &state,
                    &omni_route_config,
                    voice_provider.clone(),
                    &direction,
                    "route",
                    st_active,
                    &target_lang,
                    OMNI_ROUTE_SESSION_READINESS_TIMEOUT,
                )?;
                state.live_session_events.record_milestone_now("route_started");

                if should_start_speech_dispatch {
                    match speech::start_dispatch(app.clone(), &state, omni_route_config.clone()) {
                        Ok(snapshot) => {
                            let _ = append_diagnostics_log(
                                &app,
                                "audio",
                                "info",
                                format!(
                                    "speech dispatch fallback started for Omni secondary watch: dispatch_state={} queue_depth={}",
                                    snapshot.speech.dispatch_state, snapshot.speech.queue_depth
                                ),
                                None,
                                None,
                                None,
                            );
                        }
                        Err(error) => {
                            let _ = append_diagnostics_log(
                                &app,
                                "audio",
                                "error",
                                format!(
                                    "speech dispatch fallback failed for Omni secondary watch: {error}"
                                ),
                                None,
                                None,
                                None,
                            );
                        }
                    }
                } else {
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "info",
                        format!(
                            "speech dispatch fallback skipped for Omni secondary watch: st_active={st_active} speechEnabled={speech_enabled} speechDispatchState={speech_dispatch_state}"
                        ),
                        None,
                        None,
                        None,
                    );
                }

                start_route_with_overlay(
                    app,
                    &state,
                    &direction,
                    omni_route_config,
                    Some(omni_sender),
                )
            } else if is_openai_realtime {
                let target_lang = config
                    .pointer("/subtitles/targetLanguage")
                    .and_then(Value::as_str)
                    .unwrap_or("zh")
                    .to_string();
                let openai_sender = start_or_reuse_openai_realtime_session(
                    &app,
                    &state,
                    &config,
                    voice_provider,
                    &direction,
                    &target_lang,
                )?;
                start_route_with_overlay(app, &state, &direction, config, Some(openai_sender))
            } else if is_dashscope {
                let (stt_sender, handle) = stt::start_stt(app.clone(), &state, voice_provider)?;
                if let Some(previous) = state.store_stt_handle("inbound", handle) {
                    let _ = previous.stop_tx.send(());
                }
                start_route_with_overlay(app, &state, &direction, config, Some(stt_sender))
            } else {
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "warning",
                    "start_audio_route: 通用分支（非 DashScope/Omni），不会启动 STT/Omni worker, 仅做本地 VAD",
                    None,
                    None,
                    None,
                );
                start_route_with_overlay(app, &state, &direction, config, None)
            }
        } else {
            start_route_with_overlay(app, &state, &direction, config, None)
        }
    } else {
        start_route_with_overlay(app, &state, &direction, config, None)
    }
}

#[tauri::command]
pub fn clear_subtitle_cues(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
) -> Result<AudioRuntimeSnapshot, String> {
    engine::clear_cues(&app, &state)
}

#[tauri::command]
pub fn start_speech_dispatch(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    speech::start_dispatch(app, &state, config)
}

#[tauri::command]
pub fn start_translate_worker(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    translate::start_translate(app, &state, config)
}

#[tauri::command]
pub async fn stop_translate_worker(app: AppHandle) -> Result<AudioRuntimeSnapshot, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let app2 = app.clone();
        let state = app2.state::<AudioStateStore>();
        let result = translate::stop_translate(app, &state);
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| e.to_string())?
}

fn is_omni_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("realtime") && (lower.contains("omni") || lower.contains("livetranslate"))
}

fn is_openai_realtime_provider(provider: &ProviderDraftInput) -> bool {
    provider.kind == "openai-compatible" && {
        let lower = provider.model.to_ascii_lowercase();
        lower.contains("realtime") || lower.contains("live")
    }
}

fn resolve_legacy_vad_bypass_for_route(direction: &str, config: &Value) -> bool {
    let configured = config
        .pointer("/vad/bypass")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let route_mode = config
        .pointer("/devices/routeMode")
        .and_then(Value::as_str)
        .unwrap_or("");
    if direction == "inbound" && route_mode == "watch" {
        return false;
    }
    configured
}

fn default_realtime_audio_mode_name(model: &str) -> &'static str {
    let lower = model.to_ascii_lowercase();
    if lower.contains("livetranslate") {
        "server_vad"
    } else if lower.contains("omni") && lower.contains("realtime") {
        "manual"
    } else if lower.contains("gemini") && (lower.contains("live") || lower.contains("realtime")) {
        "gemini_auto_activity"
    } else {
        "server_vad"
    }
}

fn resolve_realtime_audio_mode_value(provider: &ProviderDraftInput, model: &str) -> String {
    let normalized_model = model.trim().to_ascii_lowercase();
    provider
        .local_model_capability_registry
        .iter()
        .find(|entry| {
            entry
                .model_id
                .trim()
                .eq_ignore_ascii_case(&normalized_model)
        })
        .and_then(|entry| entry.realtime_audio_mode.as_deref())
        .filter(|mode| !mode.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_realtime_audio_mode_name(model).to_string())
}

fn resolve_realtime_audio_mode_for_route(
    direction: &str,
    config: &Value,
    provider: &ProviderDraftInput,
) -> Result<omni::RealtimeAudioMode, String> {
    let configured_mode = resolve_realtime_audio_mode_value(provider, &provider.model);
    let legacy_bypass = resolve_legacy_vad_bypass_for_route(direction, config);
    let mode = if legacy_bypass {
        Some("manual")
    } else {
        Some(configured_mode.as_str())
    };
    omni::RealtimeAudioMode::from_config_value(mode, &provider.model)
}

fn is_dashscope_provider(provider: &ProviderDraftInput) -> bool {
    provider.kind == "dashscope"
        || provider.template_id.to_lowercase().contains("dashscope")
        || provider.model.to_lowercase().contains("dashscope")
}

fn should_start_secondary_speech_dispatch(
    config: &Value,
    st_active: bool,
    speech_dispatch_state: &str,
) -> bool {
    st_active
        && speech::speech_output_enabled(config)
        && speech_dispatch_state == "idle"
        && speech::resolve_translation_audio_source(config, true)
            == speech::TranslationAudioSource::SubtitleTts
}

fn resolve_model_provider_from_config(
    app: &AppHandle,
    config: &Value,
    composite_model_id: &str,
    purpose: &str,
) -> Option<ProviderDraftInput> {
    let linked_count = config
        .get("linkedProviders")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let _ = append_diagnostics_log(
        app,
        "audio",
        "debug",
        format!(
            "resolve_model_provider_from_config: purpose={purpose} composite_model_id={composite_model_id} linkedProviders={linked_count}"
        ),
        None,
        None,
        None,
    );

    let resolved = resolve_model_provider_from_config_value(config, composite_model_id);
    match &resolved {
        Some(provider) => {
            let _ = append_diagnostics_log(
                app,
                "audio",
                "info",
                format!(
                    "resolve_model_provider_from_config: purpose={purpose} provider_id={} kind={} model={} base_url={} template_id={}",
                    provider.provider_id,
                    provider.kind,
                    provider.model,
                    provider.base_url,
                    provider.template_id
                ),
                None,
                None,
                None,
            );
        }
        None => {
            let target_template = composite_model_id
                .split_once("::")
                .map(|(template_id, _)| template_id)
                .unwrap_or("(main-provider)");
            let _ = append_diagnostics_log(
                app,
                "audio",
                "warning",
                format!(
                    "resolve_model_provider_from_config: purpose={purpose} no provider matched target_template={target_template} composite_model_id={composite_model_id} linkedProviders={linked_count}"
                ),
                None,
                None,
                None,
            );
        }
    }
    resolved
}

pub(crate) fn resolve_model_provider_from_config_value(
    config: &Value,
    composite_model_id: &str,
) -> Option<ProviderDraftInput> {
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some((template_id, model_id)) = composite_model_id.split_once("::") {
        for provider_value in &providers {
            let parsed: Option<ProviderDraftInput> =
                serde_json::from_value(provider_value.clone()).ok();
            if let Some(mut provider) = parsed {
                if provider.template_id == template_id {
                    provider.model = model_id.to_string();
                    return Some(provider);
                }
            }
        }
        return None;
    }

    // Bare model name: search all providers equally.
    for provider_value in &providers {
        let parsed: Option<ProviderDraftInput> =
            serde_json::from_value(provider_value.clone()).ok();
        if let Some(provider) = parsed {
            if provider.model == composite_model_id {
                return Some(provider);
            }
            if provider
                .scene_model_assignments
                .iter()
                .any(|a| a.model_ids.iter().any(|m| m == composite_model_id))
            {
                let mut p = provider;
                p.model = composite_model_id.to_string();
                return Some(p);
            }
            if is_omni_model(composite_model_id) && is_dashscope_provider(&provider) {
                let mut p = provider;
                p.model = composite_model_id.to_string();
                return Some(p);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn watch_inbound_route_ensures_subtitle_overlay_visibility() {
        let watch_config = json!({ "devices": { "routeMode": "watch" } });
        let game_config = json!({ "devices": { "routeMode": "game" } });

        assert!(should_show_subtitle_overlay_for_route(
            "inbound",
            &watch_config
        ));
        assert!(!should_show_subtitle_overlay_for_route(
            "outbound",
            &watch_config
        ));
        assert!(!should_show_subtitle_overlay_for_route(
            "inbound",
            &game_config
        ));
    }

    #[test]
    fn omni_session_readiness_timeouts_fit_live_runner_flow() {
        assert!(OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT >= Duration::from_secs(20));
        assert!(OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT <= Duration::from_secs(45));
        assert!(OMNI_ROUTE_SESSION_READINESS_TIMEOUT >= Duration::from_secs(75));
        assert!(OMNI_ROUTE_SESSION_READINESS_TIMEOUT <= Duration::from_secs(90));
        assert!(OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT < OMNI_ROUTE_SESSION_READINESS_TIMEOUT);
    }

    #[test]
    fn watch_inbound_route_resolves_realtime_audio_mode_from_model_and_registry() {
        let watch_config = json!({
            "devices": { "routeMode": "watch" },
            "vad": { "bypass": true }
        });
        let game_config = json!({
            "devices": { "routeMode": "game" },
            "vad": { "bypass": true }
        });
        let omni_provider: ProviderDraftInput = serde_json::from_value(provider_value(
            "template-dashscope-realtime",
            "dashscope",
            "dashscope",
            "qwen3.5-omni-plus-realtime",
            "https://dashscope.aliyuncs.com/api/v1",
            "websocket",
            "dashscope",
        ))
        .expect("provider should parse");
        let live_provider: ProviderDraftInput = serde_json::from_value(provider_value(
            "template-dashscope-realtime",
            "dashscope",
            "dashscope",
            "qwen3.5-livetranslate-flash-realtime",
            "https://dashscope.aliyuncs.com/api/v1",
            "websocket",
            "dashscope",
        ))
        .expect("provider should parse");
        let registry_provider: ProviderDraftInput = serde_json::from_value(json!({
            "templateId": "template-dashscope-realtime",
            "providerId": "dashscope",
            "kind": "dashscope",
            "displayName": "dashscope",
            "model": "custom-realtime",
            "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
            "transport": "websocket",
            "authRef": { "kind": "system", "reference": "dashscope", "headerName": "Authorization", "scheme": "bearer" },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": "",
            "sceneModelAssignments": [],
            "localModelCapabilityRegistry": [
                {
                    "id": "registry-custom",
                    "modelId": "custom-realtime",
                    "capabilities": ["speech-to-speech"],
                    "realtimeAudioMode": "semantic_vad"
                }
            ]
        }))
        .expect("provider should parse");

        assert_eq!(
            resolve_realtime_audio_mode_for_route("inbound", &watch_config, &omni_provider)
                .expect("mode")
                .as_str(),
            "manual"
        );
        assert_eq!(
            resolve_realtime_audio_mode_for_route("inbound", &watch_config, &live_provider)
                .expect("mode")
                .as_str(),
            "server_vad"
        );
        assert_eq!(
            resolve_realtime_audio_mode_for_route(
                "inbound",
                &json!({"devices": {"routeMode": "watch"}}),
                &live_provider
            )
            .expect("mode")
            .as_str(),
            "server_vad"
        );
        assert_eq!(
            resolve_realtime_audio_mode_for_route(
                "inbound",
                &json!({"devices": {"routeMode": "watch"}}),
                &registry_provider
            )
            .expect("mode")
            .as_str(),
            "semantic_vad"
        );
        assert_eq!(
            resolve_realtime_audio_mode_for_route("inbound", &game_config, &omni_provider)
                .expect("mode")
                .as_str(),
            "manual"
        );
    }

    #[test]
    fn gemini_realtime_audio_mode_is_rejected_for_omni_watch_runner() {
        let provider: ProviderDraftInput = serde_json::from_value(json!({
            "templateId": "template-gemini-live",
            "providerId": "gemini",
            "kind": "dashscope",
            "displayName": "gemini",
            "model": "gemini-2.5-flash-live",
            "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
            "transport": "websocket",
            "authRef": { "kind": "system", "reference": "gemini", "headerName": "Authorization", "scheme": "bearer" },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": "",
            "sceneModelAssignments": [],
            "localModelCapabilityRegistry": [
                {
                    "id": "registry-gemini",
                    "modelId": "gemini-2.5-flash-live",
                    "capabilities": ["speech-to-speech"],
                    "realtimeAudioMode": "gemini_auto_activity"
                }
            ]
        }))
        .expect("provider should parse");

        let error = resolve_realtime_audio_mode_for_route(
            "inbound",
            &json!({"devices": {"routeMode": "watch"}}),
            &provider,
        )
        .expect_err("gemini mode should not enter the Omni/DashScope runner");
        assert!(error.contains("Gemini"));
    }

    #[test]
    fn openai_realtime_provider_is_routed_to_realtime_runner() {
        let realtime_provider: ProviderDraftInput = serde_json::from_value(provider_value(
            "template-openai-compatible-realtime",
            "provider-openai",
            "openai-compatible",
            "gpt-realtime",
            "https://api.openai.com/v1",
            "streaming-http",
            "credential://provider/openai/default",
        ))
        .expect("provider should parse");
        let text_provider: ProviderDraftInput = serde_json::from_value(provider_value(
            "template-openai-compatible",
            "provider-openai",
            "openai-compatible",
            "gpt-4o-mini",
            "https://api.openai.com/v1",
            "streaming-http",
            "credential://provider/openai/default",
        ))
        .expect("provider should parse");

        assert!(is_openai_realtime_provider(&realtime_provider));
        assert!(!is_openai_realtime_provider(&text_provider));
    }

    #[test]
    fn gemini_realtime_mode_is_detected_before_openai_compatible_fallback() {
        let provider: ProviderDraftInput = serde_json::from_value(json!({
            "templateId": "template-gemini-live",
            "providerId": "provider-gemini",
            "kind": "openai-compatible",
            "displayName": "Gemini",
            "model": "gemini-2.5-flash-live",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
            "transport": "streaming-http",
            "authRef": { "kind": "credential-ref", "reference": "credential://provider/gemini/default", "headerName": "x-goog-api-key", "scheme": "raw" },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": "",
            "sceneModelAssignments": [],
            "localModelCapabilityRegistry": [
                {
                    "id": "registry-gemini-live",
                    "modelId": "gemini-2.5-flash-live",
                    "capabilities": ["speech-to-speech"],
                    "realtimeAudioMode": "gemini_manual_activity"
                }
            ]
        }))
        .expect("provider should parse");

        let mode_value = resolve_realtime_audio_mode_value(&provider, &provider.model);
        assert_eq!(mode_value, "gemini_manual_activity");
        assert!(gemini_live::is_gemini_activity_mode(&mode_value));
        assert!(is_openai_realtime_provider(&provider));
    }

    fn provider_value(
        template_id: &str,
        provider_id: &str,
        kind: &str,
        model: &str,
        base_url: &str,
        transport: &str,
        auth_reference: &str,
    ) -> Value {
        json!({
            "templateId": template_id,
            "providerId": provider_id,
            "kind": kind,
            "displayName": provider_id,
            "model": model,
            "baseUrl": base_url,
            "transport": transport,
            "authRef": {
                "kind": "credential-ref",
                "reference": auth_reference,
                "headerName": "Authorization",
                "scheme": "bearer"
            },
            "region": null,
            "streamEnabled": true,
            "timeoutMs": 12000,
            "systemPromptTemplate": "video-realtime-cn",
            "temperature": 0.2,
            "maxOutputTokens": 256,
            "responseModalities": ["text"],
            "customHeaders": []
        })
    }

    fn config_with_providers(providers: Vec<Value>) -> Value {
        json!({ "providers": providers })
    }

    #[test]
    fn composite_voice_model_resolves_to_linked_dashscope_provider() {
        let config = config_with_providers(vec![
            provider_value(
                "template-custom-deepseek",
                "provider-custom-deepseek",
                "openai-compatible",
                "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
                "https://api.deepseek.com/v1",
                "streaming-http",
                "credential://provider/custom/deepseek",
            ),
            provider_value(
                "template-dashscope-realtime",
                "provider-dashscope",
                "dashscope",
                "qwen3.5-omni-plus-realtime",
                "https://dashscope.aliyuncs.com/api/v1",
                "websocket",
                "credential://provider/dashscope/default",
            ),
        ]);

        let provider = resolve_model_provider_from_config_value(
            &config,
            "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
        )
        .expect("DashScope provider should resolve via composite ID");

        assert_eq!(provider.kind, "dashscope");
        assert_eq!(provider.provider_id, "provider-dashscope");
        assert_eq!(provider.base_url, "https://dashscope.aliyuncs.com/api/v1");
        assert_eq!(provider.transport, "websocket");
        assert_eq!(provider.model, "qwen3.5-omni-plus-realtime");
    }

    #[test]
    fn plain_voice_model_resolves_to_dashscope_by_scene_assignment() {
        let config = config_with_providers(vec![
            provider_value(
                "template-deepseek",
                "provider-deepseek",
                "openai-compatible",
                "deepseek-chat",
                "https://api.deepseek.com/v1",
                "streaming-http",
                "credential://provider/deepseek/default",
            ),
            json!({
                "templateId": "template-dashscope-realtime",
                "providerId": "provider-dashscope",
                "kind": "dashscope",
                "displayName": "provider-dashscope",
                "model": "qwen3.5-omni-plus-realtime",
                "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
                "transport": "websocket",
                "authRef": {
                    "kind": "credential-ref",
                    "reference": "credential://provider/dashscope/default",
                    "headerName": "Authorization",
                    "scheme": "bearer"
                },
                "region": null,
                "streamEnabled": true,
                "timeoutMs": 12000,
                "systemPromptTemplate": "video-realtime-cn",
                "temperature": 0.2,
                "maxOutputTokens": 256,
                "responseModalities": ["text"],
                "customHeaders": [],
                "sceneModelAssignments": [
                    {"scenario": "watch", "modelIds": ["qwen3.5-omni-plus-realtime"]}
                ]
            }),
        ]);

        let provider =
            resolve_model_provider_from_config_value(&config, "qwen3.5-omni-plus-realtime")
                .expect("plain voice model should resolve via scene assignment");

        assert_eq!(provider.kind, "dashscope");
        assert_eq!(provider.provider_id, "provider-dashscope");
        assert_eq!(provider.base_url, "https://dashscope.aliyuncs.com/api/v1");
        assert_eq!(provider.model, "qwen3.5-omni-plus-realtime");
    }

    #[test]
    fn plain_omni_voice_model_resolves_to_dashscope_without_scene_assignment() {
        let config = config_with_providers(vec![
            provider_value(
                "template-deepseek",
                "provider-deepseek",
                "openai-compatible",
                "deepseek-chat",
                "https://api.deepseek.com/v1",
                "streaming-http",
                "credential://provider/deepseek/default",
            ),
            provider_value(
                "template-dashscope-realtime",
                "provider-dashscope",
                "dashscope",
                "qwen-plus",
                "https://dashscope.aliyuncs.com/api/v1",
                "websocket",
                "credential://provider/dashscope/default",
            ),
        ]);

        let provider =
            resolve_model_provider_from_config_value(&config, "qwen3.5-omni-plus-realtime")
                .expect("plain Omni model should resolve to DashScope provider");

        assert_eq!(provider.kind, "dashscope");
        assert_eq!(provider.provider_id, "provider-dashscope");
        assert_eq!(provider.base_url, "https://dashscope.aliyuncs.com/api/v1");
        assert_eq!(provider.model, "qwen3.5-omni-plus-realtime");
    }

    #[test]
    fn missing_composite_template_returns_none() {
        let config = config_with_providers(vec![provider_value(
            "template-custom-deepseek",
            "provider-custom-deepseek",
            "openai-compatible",
            "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
            "https://api.deepseek.com/v1",
            "streaming-http",
            "credential://provider/custom/deepseek",
        )]);

        let provider = resolve_model_provider_from_config_value(
            &config,
            "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
        );

        assert!(provider.is_none());
    }

    #[test]
    fn plain_model_resolves_by_scene_assignment() {
        let config = config_with_providers(vec![json!({
            "templateId": "template-deepseek", "providerId": "provider-deepseek",
            "kind": "openai-compatible", "displayName": "DeepSeek",
            "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1",
            "transport": "streaming-http",
            "authRef": { "kind": "credential-ref", "reference": "credential://provider/deepseek/default", "headerName": "Authorization", "scheme": "bearer" },
            "region": null, "streamEnabled": true, "timeoutMs": 15000,
            "systemPromptTemplate": "video-realtime-cn", "temperature": 0.2,
            "maxOutputTokens": 256, "responseModalities": ["text"], "customHeaders": [],
            "sceneModelAssignments": [
                {"scenario": "watch", "modelIds": ["deepseek-chat", "deepseek-reasoner"]}
            ]
        })]);
        let provider = resolve_model_provider_from_config_value(&config, "deepseek-reasoner")
            .expect("model in scene assignments should resolve");
        assert_eq!(provider.kind, "openai-compatible");
        assert_eq!(provider.base_url, "https://api.deepseek.com/v1");
        assert_eq!(provider.model, "deepseek-reasoner");
    }

    #[test]
    fn bare_model_not_in_any_provider_returns_none() {
        let config = config_with_providers(vec![provider_value(
            "template-deepseek",
            "provider-deepseek",
            "openai-compatible",
            "deepseek-chat",
            "https://api.deepseek.com/v1",
            "streaming-http",
            "credential://provider/deepseek/default",
        )]);
        assert!(resolve_model_provider_from_config_value(&config, "unknown-model-xyz").is_none());
    }

    #[test]
    fn omni_model_with_non_dashscope_main_and_no_linked_returns_none() {
        let config = config_with_providers(vec![provider_value(
            "template-deepseek",
            "provider-deepseek",
            "openai-compatible",
            "deepseek-chat",
            "https://api.deepseek.com/v1",
            "streaming-http",
            "credential://provider/deepseek/default",
        )]);
        assert!(
            resolve_model_provider_from_config_value(&config, "qwen3.5-omni-plus-realtime")
                .is_none()
        );
    }

    #[test]
    fn composite_id_template_not_found_returns_none() {
        let config = config_with_providers(vec![provider_value(
            "template-deepseek",
            "provider-deepseek",
            "openai-compatible",
            "deepseek-chat",
            "https://api.deepseek.com/v1",
            "streaming-http",
            "credential://provider/deepseek/default",
        )]);
        assert!(
            resolve_model_provider_from_config_value(&config, "template-nonexistent::some-model")
                .is_none()
        );
    }

    #[test]
    fn secondary_speech_dispatch_starts_when_device_output_speech_is_enabled() {
        let config = json!({
            "devices": {
                "outputSpeechEnabled": true
            },
            "speech": {
                "enabled": false,
                "translationAudioSource": "subtitle-tts"
            }
        });

        assert!(should_start_secondary_speech_dispatch(
            &config, true, "idle"
        ));
    }

    #[test]
    fn secondary_speech_dispatch_stays_off_when_auto_prefers_omni_native_audio() {
        let config = json!({
            "devices": {
                "outputSpeechEnabled": true
            },
            "speech": {
                "enabled": false
            }
        });

        assert!(!should_start_secondary_speech_dispatch(
            &config, true, "idle"
        ));
    }

    #[test]
    fn secondary_speech_dispatch_stays_off_when_translated_speech_is_disabled() {
        let config = json!({
            "devices": {
                "outputSpeechEnabled": false
            },
            "speech": {
                "enabled": false
            }
        });

        assert!(!should_start_secondary_speech_dispatch(
            &config, true, "idle"
        ));
    }

    #[test]
    fn secondary_speech_dispatch_does_not_restart_when_already_running() {
        let config = json!({
            "devices": {
                "outputSpeechEnabled": true
            },
            "speech": {
                "enabled": false
            }
        });

        assert!(!should_start_secondary_speech_dispatch(
            &config,
            true,
            "waiting-subtitle"
        ));
    }
}

#[tauri::command]
pub async fn stop_speech_dispatch(app: AppHandle) -> Result<AudioRuntimeSnapshot, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let app2 = app.clone();
        let state = app2.state::<AudioStateStore>();
        let result = speech::stop_dispatch(app, &state);
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_audio_route(
    app: AppHandle,
    direction: String,
) -> Result<AudioRuntimeSnapshot, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let state = app.state::<AudioStateStore>();
        let result = (|| -> Result<AudioRuntimeSnapshot, String> {
            if direction == "inbound" {
                let _pipeline_guard = state.lock_inbound_pipeline();
                stop_existing_inbound_pipeline(&app, &state, false)?;
            } else {
                engine::stop_route(app.clone(), &state, &direction)?;
            }
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "info",
                "watch_mode.route_stop",
                Some(format!("direction={direction}")),
                None,
                None,
            );
            Ok(state.snapshot())
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| e.to_string())?
}
