use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::super::contracts::AudioRuntimeSnapshot;
use super::super::engine;
use super::super::engine::AudioRouteSupervisor;
use super::super::omni::session_errors::{
    split_error_markers, with_error_markers, SessionErrorCode,
};
use super::super::state::AudioStateStore;
use super::super::{speech, stt, subtitle_translate};
use super::realtime_session::{
    apply_native_subtitle_translate_fallback, start_or_reuse_gemini_live_session,
    start_or_reuse_omni_session, start_or_reuse_openai_realtime_session,
    start_or_reuse_tencent_speech_translate_session, stop_preconnected_omni_session,
};
use super::route_config::{
    resolve_model_provider_from_config, ResolvedRouteKind, ResolvedRoutePlan, SpeechDispatchPolicy,
    SubtitleFallbackPolicy,
};
use super::{
    route_command_timeout, route_command_timeout_message, start_route_with_overlay,
    stop_existing_inbound_pipeline, OMNI_ROUTE_SESSION_READINESS_TIMEOUT,
};
use crate::diagnostics::events::append_diagnostics_log;

/// Normalized result of the fast-watch background worker.
///
/// The worker runs on a detached `spawn_blocking` task whose `JoinHandle` is
/// dropped, so an escaping panic would otherwise vanish and the failure could
/// only be inferred from the outer command timeout. Collapsing both `Err`
/// returns and panics into `Failed` keeps every initialization failure
/// attributable.
pub(super) enum FastWatchStartOutcome {
    Ready(AudioRuntimeSnapshot),
    Failed(String),
}

/// Extracts a human-readable reason from a caught panic payload.
fn describe_panic_payload(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "未知原因".to_string()
    }
}

/// Runs the fast-watch worker body while capturing panics, so a panic inside
/// `start_audio_route_inner` becomes an attributable failure instead of an
/// unobserved `JoinError`.
pub(super) fn run_fast_watch_start_body<R>(run_inner: R) -> FastWatchStartOutcome
where
    R: FnOnce() -> Result<AudioRuntimeSnapshot, String> + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(run_inner) {
        Ok(Ok(snapshot)) => FastWatchStartOutcome::Ready(snapshot),
        Ok(Err(error)) => FastWatchStartOutcome::Failed(error),
        Err(panic) => FastWatchStartOutcome::Failed(format!(
            "后台采集初始化线程崩溃（panic）：{}",
            describe_panic_payload(panic)
        )),
    }
}

/// True while no later inbound start/stop command has superseded the detached
/// fast-watch start that was accepted at `accepted_generation`. Must be
/// evaluated only while holding the inbound pipeline lock: the check and the
/// route mutation must be atomic against the competing stop command.
pub(super) fn fast_watch_start_still_current(
    state: &AudioStateStore,
    accepted_generation: u64,
) -> bool {
    state.inbound_route_generation() == accepted_generation
}

/// Runs the fast-watch worker and, on any failure (`Err` or panic), writes a
/// readable reason via `mark_route_error` and emits a snapshot so front-end
/// polling can read `lastError` without waiting for a timeout fallback.
pub(super) fn execute_fast_watch_start<R>(
    state: &AudioStateStore,
    run_inner: R,
    mut emit_snapshot: impl FnMut(),
) -> FastWatchStartOutcome
where
    R: FnOnce() -> Result<AudioRuntimeSnapshot, String> + std::panic::UnwindSafe,
{
    let outcome = run_fast_watch_start_body(run_inner);
    if let FastWatchStartOutcome::Failed(reason) = &outcome {
        let (message, error_code, recommended_action) = split_error_markers(reason);
        state.mark_route_error(
            "inbound",
            message,
            error_code,
            recommended_action.or_else(|| Some("restart-route".to_string())),
        );
        emit_snapshot();
    }
    outcome
}

fn unsupported_realtime_model_error(model: &str) -> String {
    with_error_markers(
        &format!(
            "所选模型 {model} 不支持实时语音识别或翻译。请在提供商设置中为当前场景选择支持实时语音的模型"
        ),
        SessionErrorCode::VoiceUnsupported,
    )
}

#[tauri::command]
pub async fn start_audio_route(
    app: AppHandle,
    direction: String,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    let requested_device_id = config
        .pointer("/devices/inboundRoute/input/deviceId")
        .and_then(Value::as_str)
        .unwrap_or("system-output-default");
    let _ = append_diagnostics_log(
        &app,
        "audio",
        "warning",
        "watch_mode.direct_route_command_received",
        Some(format!("direction={direction} requestedDeviceId={requested_device_id}")),
        None,
        None,
    );
    // Watch capture initialization is worker-owned. A Tauri command must
    // acknowledge acceptance immediately; the renderer then waits for the
    // later snapshot that confirms the route actually owns a capture stream.
    let fast_watch_start = direction == "inbound" && super::configured_route_mode(&config) == "watch";
    if fast_watch_start {
        let state = app.state::<AudioStateStore>();
        let route_id = config
            .pointer("/devices/inboundRoute/routeId")
            .and_then(Value::as_str)
            .unwrap_or("audio-route-inbound-watch");
        let requested_device_id = config
            .pointer("/devices/inboundRoute/input/deviceId")
            .and_then(Value::as_str)
            .unwrap_or("system-output-default");
        // Claim a fresh command generation: this start supersedes any earlier
        // pending detached start, and a later stop (or start) supersedes this
        // one. The detached worker re-checks the generation once it holds the
        // pipeline lock and aborts when it lost the race.
        let accepted_generation = state.bump_inbound_route_generation();
        state.mark_route_start_requested(
            "inbound",
            route_id,
            requested_device_id,
        );
        // Freeze the accepted state before the worker can contend for the
        // pipeline/session locks. It is intentionally not a ready snapshot.
        let accepted_snapshot = state.snapshot();
        let started_at = std::time::Instant::now();
        let _ = append_diagnostics_log(
            &app,
            "audio",
            "info",
            "watch_mode.route_start_acknowledged",
            Some(format!("direction=inbound routeId={route_id} ready=false")),
            None,
            None,
        );

        let task_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let task_state = task_app.state::<AudioStateStore>();
            // Take the pipeline lock *before* re-checking the generation: a
            // stop command that raced this worker either already holds the
            // lock (we block, then observe its bump and abort) or has already
            // bumped and finished (we observe the bump immediately). Without
            // this token a stop that won the lock was silently undone by the
            // pending start.
            let pipeline_guard = task_state.lock_inbound_pipeline();
            if !fast_watch_start_still_current(&task_state, accepted_generation) {
                let _ = append_diagnostics_log(
                    &task_app,
                    "audio",
                    "info",
                    "watch_mode.route_start_superseded",
                    Some(format!(
                        "direction=inbound acceptedGeneration={accepted_generation} currentGeneration={} elapsedMs={}",
                        task_state.inbound_route_generation(),
                        started_at.elapsed().as_millis(),
                    )),
                    None,
                    None,
                );
                return;
            }
            // Capture both `Err` and panic so a failed background init is always
            // attributed to `lastError` and pushed via a snapshot, rather than
            // being swallowed by the dropped JoinHandle and left for the timeout.
            let outcome = execute_fast_watch_start(
                &task_state,
                std::panic::AssertUnwindSafe(|| {
                    start_inbound_route_locked(
                        task_app.clone(),
                        &task_state,
                        config,
                    )
                }),
                || {
                    let _ = engine::emit_audio_snapshot(&task_app, &task_state);
                },
            );
            drop(pipeline_guard);
            match outcome {
                FastWatchStartOutcome::Ready(snapshot) => {
                    let _ = append_diagnostics_log(
                        &task_app,
                        "audio",
                        "info",
                        "watch_mode.route_ready",
                        Some(format!(
                            "direction=inbound elapsedMs={} captureState={} streamBound={}",
                            started_at.elapsed().as_millis(),
                            snapshot.inbound.capture_state,
                            snapshot.inbound.stream_bound,
                        )),
                        None,
                        None,
                    );
                }
                FastWatchStartOutcome::Failed(reason) => {
                    let _ = append_diagnostics_log(
                        &task_app,
                        "audio",
                        "error",
                        "watch_mode.route_failed",
                        Some(format!(
                            "direction=inbound elapsedMs={} error={reason}",
                            started_at.elapsed().as_millis(),
                        )),
                        None,
                        None,
                    );
                }
            }
        });
        return Ok(accepted_snapshot);
    }

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
                    None,
                    Some("restart-bridge".to_string()),
                );
                let _ = engine::emit_audio_snapshot(&app, &state);
            }
            Err(timeout_message)
        }
    }
}

fn start_omni_inbound_route(
    app: AppHandle,
    state: &AudioStateStore,
    direction: &str,
    config: Value,
    plan: ResolvedRoutePlan,
) -> Result<AudioRuntimeSnapshot, String> {
    let mut omni_route_config = config;
    let voice_provider = plan.provider.clone();
    let subtitle_translate_mode = match plan.subtitle_fallback_policy {
        SubtitleFallbackPolicy::Secondary => "secondary",
        SubtitleFallbackPolicy::Native => "native",
    };
    let subtitle_translate_model_id = plan.subtitle_translation_model_id.clone();
    let target_lang = plan.target_language.clone();
    let speech_dispatch_state = state.snapshot().speech.dispatch_state;
    let mut st_active = false;
    if let Some(text_provider) = plan.secondary_subtitle_provider.clone() {
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
    } else if plan.subtitle_fallback_policy == SubtitleFallbackPolicy::Secondary {
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
    let speech_enabled = plan.speech_output_enabled;
    let translation_audio_source = plan.translation_audio_source;
    let should_start_speech_dispatch = plan.speech_dispatch_policy
        == SpeechDispatchPolicy::SubtitleTtsWhenIdle
        && st_active
        && speech_dispatch_state == "idle";
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
            "start_audio_route secondary speech decision: speechEnabled={speech_enabled} translationAudioSource={translation_audio_source:?} speechDispatchState={speech_dispatch_state}",
        ),
        None,
        None,
        None,
    );
    let (omni_sender, _) = start_or_reuse_omni_session(
        &app,
        &state,
        voice_provider.clone(),
        &direction,
        "route",
        st_active,
        &target_lang,
        &plan.realtime_audio_mode,
        plan.voice.clone(),
        plan.instructions.clone(),
        plan.omni_speech_config.clone(),
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
}

fn start_openai_inbound_route(
    app: AppHandle,
    state: &AudioStateStore,
    direction: &str,
    config: Value,
    plan: ResolvedRoutePlan,
) -> Result<AudioRuntimeSnapshot, String> {
    let speech_dispatch_state = state.snapshot().speech.dispatch_state;
    let mut st_active = false;
    if let Some(text_provider) = plan.secondary_subtitle_provider.clone() {
        let _ = append_diagnostics_log(
            &app,
            "audio",
            "info",
            format!(
                "二次翻译已启用 (openai-realtime): text_provider.kind={} model={} base_url={}",
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
            plan.target_language.clone(),
        ) {
            Ok(_) => {
                st_active = true;
            }
            Err(error) => {
                // Fall back to the realtime model's own translation output.
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "warning",
                    "watch_mode.subtitle_translate_fallback_native_applied",
                    Some(format!(
                        "reason=worker_failed provider=openai-realtime subtitleTranslationModelId={} error={error}",
                        plan.subtitle_translation_model_id
                    )),
                    None,
                    None,
                );
            }
        }
    }
    let should_start_speech_dispatch = plan.speech_dispatch_policy
        == SpeechDispatchPolicy::SubtitleTtsWhenIdle
        && st_active
        && speech_dispatch_state == "idle";
    let openai_sender = start_or_reuse_openai_realtime_session(
        &app,
        &state,
        plan.provider.clone(),
        &plan.direction,
        &plan.target_language,
        &plan.realtime_audio_mode,
        plan.instructions.clone(),
        st_active,
    )?;
    state.live_session_events.record_milestone_now("route_started");
    if should_start_speech_dispatch {
        if let Err(error) = speech::start_dispatch(app.clone(), &state, config.clone()) {
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "error",
                format!("speech dispatch fallback failed for OpenAI secondary watch: {error}"),
                None,
                None,
                None,
            );
        }
    }
    start_route_with_overlay(app, &state, direction, config, Some(openai_sender))
}

pub(crate) fn start_audio_route_inner(
    app: AppHandle,
    state: &AudioStateStore,
    direction: String,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    if direction == "inbound" {
        let _pipeline_guard = state.lock_inbound_pipeline();
        start_inbound_route_locked(app, state, config)
    } else {
        start_route_with_overlay(app, state, &direction, config, None)
    }
}

/// Inbound route startup body. Caller must hold the inbound pipeline lock
/// (and, for detached fast-watch starts, must have re-checked the route
/// generation while holding it).
fn start_inbound_route_locked(
    app: AppHandle,
    state: &AudioStateStore,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    let direction = "inbound".to_string();
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
            let plan = ResolvedRoutePlan::from_resolved_provider(
                &direction,
                &config,
                requested_voice_model.clone(),
                voice_provider,
            );
            if let Some(error) = plan.configuration_error.clone() {
                return Err(error);
            }
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "info",
                format!(
                    "start_audio_route 分支判定: kind={:?} realtimeAudioMode={} vadPolicy={:?} legacyVadBypass={}",
                    plan.kind, plan.realtime_audio_mode, plan.vad_policy, plan.legacy_vad_bypass
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
                    plan.requested_voice_model,
                    plan.provider.provider_id,
                    plan.provider.kind,
                    plan.provider.model,
                    plan.provider.base_url
                ),
                None,
                None,
                None,
            );
            match plan.kind {
            ResolvedRouteKind::GeminiLive => {
                let gemini_sender = start_or_reuse_gemini_live_session(
                    &app,
                    &state,
                    plan.provider,
                    &plan.direction,
                    &plan.target_language,
                    &plan.realtime_audio_mode,
                    plan.instructions,
                )?;
                start_route_with_overlay(app, &state, &direction, config, Some(gemini_sender))
            }
            ResolvedRouteKind::Omni => {
                start_omni_inbound_route(app, state, &direction, config, plan)
            }
            ResolvedRouteKind::TencentSpeechTranslate => {
                // Tencent's speech_translate stream carries ASR + Hunyuan
                // translation natively; no secondary worker is wired.
                let source_language = config
                    .pointer("/subtitles/sourceLanguage")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|lang| !lang.is_empty() && !lang.eq_ignore_ascii_case("auto"))
                    .unwrap_or("en")
                    .to_string();
                let tencent_sender = start_or_reuse_tencent_speech_translate_session(
                    &app,
                    &state,
                    plan.provider,
                    &plan.direction,
                    &source_language,
                    &plan.target_language,
                )?;
                state.live_session_events.record_milestone_now("route_started");
                start_route_with_overlay(app, &state, &direction, config, Some(tencent_sender))
            }
            ResolvedRouteKind::OpenAiRealtime => {
                start_openai_inbound_route(app, state, &direction, config, plan)
            }
            ResolvedRouteKind::DashscopeStt => {
                let (stt_sender, handle) = stt::start_stt(app.clone(), &state, plan.provider)?;
                if let Some(previous) = state.store_stt_handle("inbound", handle) {
                    let _ = previous.stop_tx.send(());
                }
                start_route_with_overlay(app, &state, &direction, config, Some(stt_sender))
            }
            ResolvedRouteKind::LocalVad => {
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "warning",
                    "start_audio_route: 通用分支（非 DashScope/Omni），不会启动 STT/Omni worker, 仅做本地 VAD",
                    None,
                    None,
                    None,
                );
                Err(unsupported_realtime_model_error(&plan.requested_voice_model))
            }
            }
        } else {
            start_route_with_overlay(app, &state, &direction, config, None)
        }
}

#[cfg(test)]
mod fast_watch_supersede_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn unsupported_realtime_models_return_a_structured_session_error() {
        let error = unsupported_realtime_model_error("chat-only-model");
        let (message, code, action) = split_error_markers(&error);
        assert!(message.contains("chat-only-model"));
        assert_eq!(code.as_deref(), Some("session.voice-unsupported"));
        assert_eq!(action.as_deref(), Some("switch-voice"));
    }

    /// Field incident: the user pressed stop while a detached fast-watch start
    /// was still queued behind the pipeline lock. The stop won the lock, tore
    /// the route down, and the pending start then silently restarted capture.
    /// The generation token forces the late worker to abort instead.
    #[test]
    fn a_stop_that_wins_the_pipeline_lock_revokes_the_pending_fast_watch_start() {
        let store = Arc::new(AudioStateStore::new());
        // Fast-watch command accepted: worker will run under this generation.
        let accepted_generation = store.bump_inbound_route_generation();
        // Stop command arrives and bumps before its stop work, exactly as
        // stop_audio_route does.
        store.bump_inbound_route_generation();
        let stop_guard = store.lock_inbound_pipeline();

        let worker_store = store.clone();
        let started = Arc::new(AtomicBool::new(false));
        let started_flag = started.clone();
        let worker = std::thread::spawn(move || {
            // Mirrors the detached worker: lock first, then re-check.
            let _guard = worker_store.lock_inbound_pipeline();
            if fast_watch_start_still_current(&worker_store, accepted_generation) {
                started_flag.store(true, Ordering::SeqCst);
            }
        });
        // The worker blocks on the lock held by the stop; release it once the
        // stop has finished its teardown.
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(stop_guard);
        worker.join().expect("fast-watch worker thread");

        assert!(
            !started.load(Ordering::SeqCst),
            "a fast-watch start superseded by stop must abort instead of restarting the route"
        );
    }

    #[test]
    fn an_undisturbed_fast_watch_start_runs_under_its_accepted_generation() {
        let store = AudioStateStore::new();
        let accepted_generation = store.bump_inbound_route_generation();
        let _guard = store.lock_inbound_pipeline();
        assert!(fast_watch_start_still_current(&store, accepted_generation));
    }

    #[test]
    fn a_second_fast_watch_start_supersedes_the_first_pending_one() {
        let store = AudioStateStore::new();
        let first = store.bump_inbound_route_generation();
        let second = store.bump_inbound_route_generation();
        assert!(!fast_watch_start_still_current(&store, first));
        assert!(fast_watch_start_still_current(&store, second));
    }
}

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
                // Supersede any detached fast-watch start that has not yet
                // acquired the pipeline lock: without this bump, a pending
                // start acquiring the lock after us restarted the route the
                // user just stopped.
                state.bump_inbound_route_generation();
                let _pipeline_guard = state.lock_inbound_pipeline();
                stop_existing_inbound_pipeline(&app, &state, false)?;
            } else {
                AudioRouteSupervisor::new(app.clone(), &state).stop(&direction)?;
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
