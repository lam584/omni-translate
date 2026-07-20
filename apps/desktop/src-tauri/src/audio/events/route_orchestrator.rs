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
    let fast_watch_start = direction == "inbound"
        && config.pointer("/devices/routeMode").and_then(Value::as_str) == Some("watch");
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
            match start_audio_route_inner(
                task_app.clone(),
                &task_state,
                "inbound".to_string(),
                config,
            ) {
                Ok(snapshot) => {
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
                Err(error) => {
                    task_state.mark_route_error(
                        "inbound",
                        error,
                        Some("restart-route".to_string()),
                    );
                    let _ = engine::emit_audio_snapshot(&task_app, &task_state);
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
            let plan = ResolvedRoutePlan::from_resolved_provider(
                &direction,
                &config,
                requested_voice_model.clone(),
                voice_provider,
            );
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
            ResolvedRouteKind::OpenAiRealtime => {
                let openai_sender = start_or_reuse_openai_realtime_session(
                    &app,
                    &state,
                    plan.provider,
                    &plan.direction,
                    &plan.target_language,
                    &plan.realtime_audio_mode,
                    plan.instructions,
                )?;
                start_route_with_overlay(app, &state, &direction, config, Some(openai_sender))
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
                start_route_with_overlay(app, &state, &direction, config, None)
            }
            }
        } else {
            start_route_with_overlay(app, &state, &direction, config, None)
        }
    } else {
        start_route_with_overlay(app, &state, &direction, config, None)
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
