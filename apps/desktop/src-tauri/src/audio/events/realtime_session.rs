use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::super::contracts::AudioRuntimeSnapshot;
use super::super::state::AudioStateStore;
use super::super::{gemini_live, omni, openai_realtime, tencent_speech_translate};
use super::route_config::{resolve_model_provider_from_config, resolve_realtime_profile, ResolvedRoutePlan};
use super::{
    OMNI_PRECONNECT_COMMAND_TIMEOUT, OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT,
    OMNI_ROUTE_SESSION_READINESS_TIMEOUT,
};
use crate::diagnostics::events::append_diagnostics_log;
use crate::audio::glossary::GlossaryContext;
use crate::provider::contracts::ProviderDraftInput;

/// A preconnect is only safe while the inbound route is fully idle.
///
/// The route-owned realtime sender is removed from the preconnect slot once
/// capture starts, while its session metadata/handle deliberately remain
/// registered for route lifetime management. Without this route-state guard,
/// a later background prewarm sees "metadata but no parked sender" and treats
/// the active worker as a stale preconnect, stopping it under
/// `preconnect_config_changed`.
fn inbound_route_blocks_preconnect(snapshot: &AudioRuntimeSnapshot) -> bool {
    snapshot.inbound.stream_bound || snapshot.inbound.capture_state != "idle"
}

fn diagnostic_autostart_enabled() -> bool {
    std::env::var("OMNI_WATCH_MODE_AUTOSTART")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn release_evidence_blocks_background_preconnect(scenario: Option<&str>) -> bool {
    matches!(
        scenario.map(str::trim),
        Some(
            "E2E-PROVIDER-CONFIG"
                | "E2E-PROVIDER-PROBE"
                | "E2E-DIAGNOSTICS-EXPORT"
        )
    )
}

fn release_evidence_scenario() -> Option<String> {
    std::env::var("OMNI_RELEASE_EVIDENCE_SCENARIO")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn diagnostic_model_id(value: &str) -> &str {
    value
        .trim()
        .split_once("::")
        .map(|(_, model_id)| model_id.trim())
        .unwrap_or_else(|| value.trim())
}

/// Native Watch diagnostics build an in-memory route config from process env,
/// while the renderer's ordinary idle prewarm still holds the persisted user
/// config. Both calls share this command and can race during bootstrap. The
/// persisted prewarm must not replace the authoritative diagnostic websocket:
/// doing so pays three provider handshakes and briefly switches model/output
/// contracts before the real route repairs it.
///
/// This guard is deliberately process-env scoped. Normal user sessions retain
/// the existing config-change replacement behavior.
fn should_skip_diagnostic_preconnect_override(
    autostart_enabled: bool,
    authoritative_model: &str,
    requested_model: &str,
    requested_output_mode: omni::OmniOutputMode,
) -> bool {
    if !autostart_enabled {
        return false;
    }
    let authoritative_model = diagnostic_model_id(authoritative_model);
    if authoritative_model.is_empty() {
        return false;
    }
    requested_model != authoritative_model
        || requested_output_mode != omni::OmniOutputMode::TextOnly
}

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
    source_lang: &str,
    target_lang: &str,
    realtime_audio_mode: &str,
    voice: String,
    instructions: String,
    glossary: GlossaryContext,
    contract_signature: u64,
    output_mode: omni::OmniOutputMode,
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
    let audio_mode = omni::RealtimeAudioMode::from_config_value(
        Some(realtime_audio_mode),
        &voice_provider.model,
    )?;
    if let Some(sender) = state.take_matching_omni_sender_with_languages(
        direction,
        &voice_model,
        source_lang,
        target_lang,
        realtime_audio_mode,
        st_active,
        output_mode,
        contract_signature,
    ) {
        state.replace_omni_speech_config(speech_config);
        let generation = state
            .matching_ready_omni_session_with_languages(
                direction,
                &voice_model,
                source_lang,
                target_lang,
                realtime_audio_mode,
                st_active,
                output_mode,
                contract_signature,
            )
            .unwrap_or_default();
        let _ = append_diagnostics_log(
            app,
            "audio",
            "info",
            "watch_mode.omni_preconnect_reused",
            Some(format!(
                "direction={direction} generation={generation} model={} realtimeAudioMode={realtime_audio_mode} subtitleTranslateActive={st_active} outputMode={}",
                voice_model,
                output_mode.as_str(),
            )),
            None,
            None,
        );
        return Ok((sender, generation));
    }

    if state.omni_session_metadata(direction).is_some() || state.has_omni_sender(direction) {
        stop_preconnected_omni_session(app, state, direction, "preconnect_not_reusable");
    }

    let session_generation = state.begin_omni_session_with_languages(
        direction,
        &voice_provider.model,
        source_lang,
        target_lang,
        realtime_audio_mode,
        st_active,
        output_mode,
        contract_signature,
    );
    let (omni_sender, handle, readiness_rx) = match omni::start_omni(
        app.clone(),
        state,
        direction.to_string(),
        session_generation,
        voice_provider,
        voice,
        instructions,
        glossary,
        audio_mode,
        output_mode,
        source_lang.to_string(),
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

pub(super) fn start_or_reuse_route_omni_session(
    app: &AppHandle,
    state: &AudioStateStore,
    direction: &str,
    subtitle_translate_active: bool,
    plan: &ResolvedRoutePlan,
) -> Result<(std::sync::mpsc::Sender<Vec<u8>>, u64), String> {
    start_or_reuse_omni_session(
        app,
        state,
        plan.provider.clone(),
        direction,
        "route",
        subtitle_translate_active,
        &plan.session_reuse_key.source_language,
        &plan.session_reuse_key.target_language,
        &plan.realtime_audio_mode,
        plan.voice.clone(),
        plan.instructions.clone(),
        plan.glossary.clone(),
        plan.session_reuse_key.contract_signature,
        plan.session_reuse_key.output_mode,
        plan.omni_speech_config.clone(),
        OMNI_ROUTE_SESSION_READINESS_TIMEOUT,
    )
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
    glossary: GlossaryContext,
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
        direction.to_string(),
        instructions,
        audio_mode,
        target_lang.to_string(),
        subtitle_translate_active,
        glossary,
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
    glossary: GlossaryContext,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    if let Some(sender) = state.take_omni_sender(direction) {
        return Ok(sender);
    }

    let mode = gemini_live::GeminiActivityMode::from_config_value(mode_value)?;
    let (sender, handle) = gemini_live::start_gemini_live(
        app.clone(),
        state,
        voice_provider,
        direction.to_string(),
        instructions,
        mode,
        target_lang.to_string(),
        glossary,
    )?;
    if let Some(previous) = state.store_omni_handle(direction, handle) {
        let _ = previous.stop_tx.send(());
    }
    Ok(sender)
}

pub(super) fn start_or_reuse_tencent_speech_translate_session(
    app: &AppHandle,
    state: &AudioStateStore,
    voice_provider: ProviderDraftInput,
    direction: &str,
    source_lang: &str,
    target_lang: &str,
    glossary: GlossaryContext,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    if let Some(sender) = state.take_omni_sender(direction) {
        return Ok(sender);
    }

    let (sender, handle) = tencent_speech_translate::start_tencent_speech_translate(
        app.clone(),
        state,
        voice_provider,
        direction.to_string(),
        source_lang.to_string(),
        target_lang.to_string(),
        glossary,
    )?;
    if let Some(previous) = state.store_omni_handle(direction, handle) {
        let _ = previous.stop_tx.send(());
    }
    Ok(sender)
}

#[tauri::command]
pub(crate) async fn preconnect_omni_realtime(
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

pub(crate) async fn cancel_omni_preconnect(app: AppHandle) -> Result<AudioRuntimeSnapshot, String> {
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
    if release_evidence_blocks_background_preconnect(release_evidence_scenario().as_deref()) {
        let snapshot = state.snapshot();
        let _ = append_diagnostics_log(
            &app,
            "audio",
            "info",
            "release_evidence.background_preconnect_blocked",
            Some("reason=release-evidence-provider-authority-is-exclusive".to_string()),
            None,
            None,
        );
        return Ok(snapshot);
    }
    // The pipeline lock makes this check atomic against inbound start/stop.
    // Preconnect is an idle-time optimization and must never replace a worker
    // already owned by an accepted, converging, or active route.
    let current_snapshot = state.snapshot();
    if inbound_route_blocks_preconnect(&current_snapshot) {
        let _ = append_diagnostics_log(
            &app,
            "audio",
            "info",
            "watch_mode.omni_preconnect_skipped_active_route",
            Some(format!(
                "direction=inbound captureState={} streamBound={}",
                current_snapshot.inbound.capture_state,
                current_snapshot.inbound.stream_bound,
            )),
            None,
            None,
        );
        return Ok(current_snapshot);
    }
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
    if !resolve_realtime_profile(&voice_provider, &voice_provider.model).preconnect_allowed {
        return Ok(state.snapshot());
    }
    let plan = ResolvedRoutePlan::from_resolved_provider(
        "inbound",
        &config,
        requested_voice_model,
        voice_provider,
    );
    if let Some(error) = plan.configuration_error.clone() {
        return Err(error);
    }
    let diagnostic_model = std::env::var("OMNI_WATCH_MODE_MODEL_ID").unwrap_or_default();
    if should_skip_diagnostic_preconnect_override(
        diagnostic_autostart_enabled(),
        &diagnostic_model,
        &plan.session_reuse_key.model,
        plan.session_reuse_key.output_mode,
    ) {
        let _ = append_diagnostics_log(
            &app,
            "audio",
            "info",
            "watch_mode.omni_preconnect_skipped_diagnostic_override",
            Some(format!(
                "direction=inbound authoritativeModel={} requestedModel={} requestedOutputMode={}",
                diagnostic_model_id(&diagnostic_model),
                plan.session_reuse_key.model,
                plan.session_reuse_key.output_mode.as_str(),
            )),
            None,
            None,
        );
        return Ok(state.snapshot());
    }
    if super::configured_route_mode(&config) == "watch" {
        state.watch_session_report.begin_or_reuse(
            &plan.provider.provider_id,
            &plan.provider.model,
        );
    }
    let st_active = plan.session_reuse_key.subtitle_translate_active;
    if state
        .matching_ready_omni_session_with_languages(
            &plan.session_reuse_key.direction,
            &plan.session_reuse_key.model,
            &plan.session_reuse_key.source_language,
            &plan.session_reuse_key.target_language,
            &plan.session_reuse_key.realtime_audio_mode,
            st_active,
            plan.session_reuse_key.output_mode,
            plan.session_reuse_key.contract_signature,
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
        &plan.session_reuse_key.source_language,
        &plan.session_reuse_key.target_language,
        &plan.realtime_audio_mode,
        plan.voice,
        plan.instructions,
        plan.glossary,
        plan.session_reuse_key.contract_signature,
        plan.session_reuse_key.output_mode,
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

#[cfg(test)]
mod active_route_preconnect_tests {
    use super::*;

    #[test]
    fn fully_idle_inbound_route_allows_background_preconnect() {
        let snapshot = AudioRuntimeSnapshot::preview();
        assert_eq!(snapshot.inbound.capture_state, "idle");
        assert!(!snapshot.inbound.stream_bound);
        assert!(!inbound_route_blocks_preconnect(&snapshot));
    }

    #[test]
    fn accepted_route_blocks_preconnect_before_stream_binding() {
        let mut snapshot = AudioRuntimeSnapshot::preview();
        snapshot.inbound.capture_state = "armed".to_string();
        snapshot.inbound.stream_bound = false;
        assert!(inbound_route_blocks_preconnect(&snapshot));
    }

    #[test]
    fn active_route_blocks_preconnect_during_speech_and_silence() {
        for capture_state in ["capturing", "buffering"] {
            let mut snapshot = AudioRuntimeSnapshot::preview();
            snapshot.inbound.capture_state = capture_state.to_string();
            snapshot.inbound.stream_bound = true;
            assert!(
                inbound_route_blocks_preconnect(&snapshot),
                "captureState={capture_state}"
            );
        }
    }

    #[test]
    fn stopping_or_muted_route_blocks_preconnect_until_explicit_teardown() {
        for capture_state in ["stopping", "muted"] {
            let mut snapshot = AudioRuntimeSnapshot::preview();
            snapshot.inbound.capture_state = capture_state.to_string();
            snapshot.inbound.stream_bound = false;
            assert!(
                inbound_route_blocks_preconnect(&snapshot),
                "captureState={capture_state}"
            );
        }
    }

    #[test]
    fn diagnostic_preconnect_accepts_only_the_authoritative_text_only_contract() {
        assert!(!should_skip_diagnostic_preconnect_override(
            true,
            "template-dashscope-realtime::qwen3.5-livetranslate-flash-realtime",
            "qwen3.5-livetranslate-flash-realtime",
            omni::OmniOutputMode::TextOnly,
        ));
        assert!(should_skip_diagnostic_preconnect_override(
            true,
            "qwen3.5-livetranslate-flash-realtime",
            "qwen3.5-omni-plus-realtime",
            omni::OmniOutputMode::TextOnly,
        ));
        assert!(should_skip_diagnostic_preconnect_override(
            true,
            "qwen3.5-livetranslate-flash-realtime",
            "qwen3.5-livetranslate-flash-realtime",
            omni::OmniOutputMode::TextAndAudio,
        ));
    }

    #[test]
    fn ordinary_and_unpinned_preconnects_keep_config_change_replacement() {
        assert!(!should_skip_diagnostic_preconnect_override(
            false,
            "qwen3.5-livetranslate-flash-realtime",
            "qwen3.5-omni-plus-realtime",
            omni::OmniOutputMode::TextAndAudio,
        ));
        assert!(!should_skip_diagnostic_preconnect_override(
            true,
            "",
            "qwen3.5-omni-plus-realtime",
            omni::OmniOutputMode::TextAndAudio,
        ));
    }

    #[test]
    fn release_evidence_scenarios_exclusively_own_provider_connections() {
        for scenario in [
            "E2E-PROVIDER-CONFIG",
            "E2E-PROVIDER-PROBE",
            "E2E-DIAGNOSTICS-EXPORT",
        ] {
            assert!(release_evidence_blocks_background_preconnect(Some(scenario)));
        }
        assert!(!release_evidence_blocks_background_preconnect(None));
        assert!(!release_evidence_blocks_background_preconnect(Some("")));
        assert!(!release_evidence_blocks_background_preconnect(Some("ordinary-startup")));
    }
}
