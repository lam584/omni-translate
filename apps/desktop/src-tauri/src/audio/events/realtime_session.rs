use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::super::contracts::AudioRuntimeSnapshot;
use super::super::state::AudioStateStore;
use super::super::{gemini_live, omni, openai_realtime};
use super::route_config::{is_omni_model, resolve_model_provider_from_config, ResolvedRoutePlan};
use super::{OMNI_PRECONNECT_COMMAND_TIMEOUT, OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT};
use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::ProviderDraftInput;

pub(super) fn should_wait_for_omni_session_readiness(phase: &str) -> bool {
    phase == "preconnect"
}

pub(super) fn start_or_reuse_omni_session(
    app: &AppHandle,
    state: &AudioStateStore,
    voice_provider: ProviderDraftInput,
    direction: &str,
    phase: &str,
    st_active: bool,
    target_lang: &str,
    realtime_audio_mode: &str,
    voice: String,
    instructions: String,
    speech_config: omni::OmniSpeechConfig,
    readiness_timeout: Duration,
) -> Result<(std::sync::mpsc::Sender<Vec<u8>>, u64), String> {
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
        return Ok((sender, generation));
    }

    if state.omni_session_metadata(direction).is_some() || state.has_omni_sender(direction) {
        stop_preconnected_omni_session(app, state, direction, "preconnect_not_reusable");
    }

    let audio_mode = omni::RealtimeAudioMode::from_config_value(
        Some(realtime_audio_mode),
        &voice_provider.model,
    )?;
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
        speech_config,
    ) {
        Ok(result) => result,
        Err(error) => {
            log_readiness_failure("start_failed", format!("error=\"{error}\""));
            return Err(error);
        }
    };
    if !state.is_current_omni_session(direction, session_generation) {
        let _ = handle.stop_tx.send(());
        return Err("Omni session was cancelled before handle registration".to_string());
    }
    if let Some(previous) = state.store_omni_handle(direction, handle) {
        let _ = previous.stop_tx.send(());
    }
    if !should_wait_for_omni_session_readiness(phase) {
        let _ = append_diagnostics_log(
            app,
            "audio",
            "info",
            "watch_mode.omni_route_started_before_session_ready",
            Some(format!(
                "direction={direction} generation={session_generation} model={} queuedAudio=true",
                voice_model
            )),
            None,
            None,
        );
        return Ok((omni_sender, session_generation));
    }
    let readiness_deadline = std::time::Instant::now() + readiness_timeout;
    let readiness_result = loop {
        if !state.is_current_omni_session(direction, session_generation) {
            break Err(std::sync::mpsc::RecvTimeoutError::Disconnected);
        }
        let remaining = readiness_deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break Err(std::sync::mpsc::RecvTimeoutError::Timeout);
        }
        match readiness_rx.recv_timeout(remaining.min(Duration::from_millis(50))) {
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            result => break result,
        }
    };
    match readiness_result {
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
    Ok((omni_sender, session_generation))
}

pub(super) fn apply_native_subtitle_translate_fallback(config: &mut Value) {
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

pub(super) fn stop_preconnected_omni_session(
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

pub(super) fn start_or_reuse_openai_realtime_session(
    app: &AppHandle,
    state: &AudioStateStore,
    voice_provider: ProviderDraftInput,
    direction: &str,
    target_lang: &str,
    realtime_audio_mode: &str,
    instructions: String,
    subtitle_translate_active: bool,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    if let Some(sender) = state.take_omni_sender(direction) {
        return Ok(sender);
    }

    let audio_mode = omni::RealtimeAudioMode::from_config_value(
        Some(realtime_audio_mode),
        &voice_provider.model,
    )?;
    let (sender, handle) = openai_realtime::start_openai_realtime(
        app.clone(),
        state,
        voice_provider,
        instructions,
        audio_mode,
        target_lang.to_string(),
        subtitle_translate_active,
    )?;
    if let Some(previous) = state.store_omni_handle(direction, handle) {
        let _ = previous.stop_tx.send(());
    }
    Ok(sender)
}

pub(super) fn start_or_reuse_gemini_live_session(
    app: &AppHandle,
    state: &AudioStateStore,
    voice_provider: ProviderDraftInput,
    direction: &str,
    target_lang: &str,
    mode_value: &str,
    instructions: String,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    if let Some(sender) = state.take_omni_sender(direction) {
        return Ok(sender);
    }

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
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let app_for_state = app_for_task.clone();
        let state = app_for_state.state::<AudioStateStore>();
        preconnect_omni_realtime_inner(app_for_task, &state, config)
    });
    match tokio::time::timeout(OMNI_PRECONNECT_COMMAND_TIMEOUT, &mut task).await {
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
            stop_preconnected_omni_session(&app, &state, "inbound", "preconnect_command_timeout");
            match task.await {
                Ok(Ok(_)) => Err(message),
                Ok(Err(error)) => Err(format!("{message} cleanup={error}")),
                Err(error) => Err(format!("{message} cleanupJoin={error}")),
            }
        }
    }
}

pub async fn cancel_omni_preconnect(app: AppHandle) -> Result<AudioRuntimeSnapshot, String> {
    let state = app.state::<AudioStateStore>();
    stop_preconnected_omni_session(&app, &state, "inbound", "preconnect_cancelled");
    Ok(state.snapshot())
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
    let plan = ResolvedRoutePlan::from_resolved_provider(
        "inbound",
        &config,
        requested_voice_model,
        voice_provider,
    );
    let st_active = plan.session_reuse_key.subtitle_translate_active;
    if state
        .matching_ready_omni_session(
            &plan.session_reuse_key.direction,
            &plan.session_reuse_key.model,
            st_active,
        )
        .is_some()
        && state.has_omni_sender("inbound")
    {
        return Ok(state.snapshot());
    }
    if state.omni_session_metadata("inbound").is_some() || state.has_omni_sender("inbound") {
        stop_preconnected_omni_session(&app, &state, "inbound", "preconnect_config_changed");
    }
    let (sender, generation) = start_or_reuse_omni_session(
        &app,
        &state,
        plan.provider,
        "inbound",
        "preconnect",
        st_active,
        &plan.target_language,
        &plan.realtime_audio_mode,
        plan.voice,
        plan.instructions,
        plan.omni_speech_config,
        OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT,
    )?;
    if !state.is_current_omni_session("inbound", generation) {
        return Err("Omni preconnect generation became stale before sender registration".to_string());
    }
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
