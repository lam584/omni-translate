use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use super::contracts::AudioRuntimeSnapshot;
use super::engine;
use super::omni;
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

fn should_show_subtitle_overlay_for_route(direction: &str, config: &Value) -> bool {
    direction == "inbound"
        && config.pointer("/devices/routeMode").and_then(Value::as_str) == Some("watch")
}

fn stop_existing_inbound_pipeline(app: &AppHandle, state: &AudioStateStore) -> Result<(), String> {
    engine::stop_route(app.clone(), state, "inbound")?;
    if let Some(bridge_state) = app.try_state::<BridgeStateStore>() {
        let _ = flush_bridge_source(&bridge_state.snapshot());
    }
    if let Some(handle) = state.take_stt_handle("inbound") {
        let _ = handle.stop_tx.send(());
    }
    if let Some(handle) = state.take_omni_handle("inbound") {
        let _ = handle.stop_tx.send(());
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
                "watch route ensured subtitle overlay visible",
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

#[tauri::command]
pub fn start_audio_route(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
    direction: String,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    if direction == "inbound" {
        stop_existing_inbound_pipeline(&app, &state)?;
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
                        format!("start_audio_route inbound: provider.kind={} provider.model={} provider.template_id={}",
                            resolved_provider.kind, resolved_provider.model, resolved_provider.template_id),
                        None, None, None,
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
            let _ = append_diagnostics_log(
                &app,
                "audio",
                "info",
                format!(
                    "start_audio_route 分支判定: is_dashscope={is_dashscope} is_omni={is_omni}"
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
            if is_omni {
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
                let vad_bypass = config
                    .pointer("/vad/bypass")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let subtitle_translate_mode = config
                    .pointer("/devices/subtitleTranslationMode")
                    .and_then(Value::as_str)
                    .unwrap_or("secondary");
                let subtitle_translate_model_id = config
                    .pointer("/devices/subtitleTranslationModelId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let st_active = subtitle_translate_mode == "secondary"
                    && !subtitle_translate_model_id.is_empty();
                let target_lang = config
                    .pointer("/subtitles/targetLanguage")
                    .and_then(Value::as_str)
                    .unwrap_or("zh")
                    .to_string();
                let speech_enabled = speech::speech_output_enabled(&config);
                let translation_audio_source =
                    speech::resolve_translation_audio_source(&config, true);
                let speech_dispatch_state = state.snapshot().speech.dispatch_state;
                let should_start_speech_dispatch = should_start_secondary_speech_dispatch(
                    &config,
                    st_active,
                    &speech_dispatch_state,
                );
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "info",
                    format!("start_audio_route 二次翻译判定: subtitleTranslationMode={subtitle_translate_mode} subtitleTranslationModelId={subtitle_translate_model_id} st_active={st_active}"),
                    None, None, None,
                );
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "info",
                    format!(
                        "start_audio_route secondary speech decision: speech.enabled={} devices.outputSpeechEnabled={} speechEnabled={speech_enabled} translationAudioSource={translation_audio_source:?} speechDispatchState={speech_dispatch_state}",
                        config
                            .pointer("/speech/enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        config
                            .pointer("/devices/outputSpeechEnabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    ),
                    None,
                    None,
                    None,
                );
                let (omni_sender, handle) = omni::start_omni(
                    app.clone(),
                    &state,
                    voice_provider.clone(),
                    voice,
                    instructions,
                    vad_bypass,
                    target_lang.clone(),
                    st_active,
                    omni::OmniSpeechConfig::from_config(&config),
                )?;
                if let Some(previous) = state.store_omni_handle("inbound", handle) {
                    let _ = previous.stop_tx.send(());
                }

                if st_active {
                    match resolve_model_provider_from_config(
                        &app,
                        &config,
                        subtitle_translate_model_id,
                        "subtitle-translate",
                    ) {
                        Some(text_provider) => {
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
                                target_lang,
                            ) {
                                Ok(snapshot) => {
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
                                    let _ = append_diagnostics_log(
                                        &app,
                                        "audio",
                                        "error",
                                        format!("subtitle_translate worker 启动失败: {error}"),
                                        None,
                                        None,
                                        None,
                                    );
                                }
                            }
                        }
                        None => {
                            let _ = append_diagnostics_log(
                                &app,
                                "audio",
                                "warning",
                                format!("二次翻译启用(st_active=true)但 resolve_text_model_from_config 返回 None，subtitle_translate worker 未启动! subtitleTranslationModelId={subtitle_translate_model_id}"),
                                None, None, None,
                            );
                        }
                    }
                }

                if should_start_speech_dispatch {
                    match speech::start_dispatch(app.clone(), &state, config.clone()) {
                        Ok(snapshot) => {
                            let _ = append_diagnostics_log(
                                &app,
                                "audio",
                                "info",
                                format!(
                                    "speech dispatch fallback started for Omni secondary watch: dispatch_state={} queue_depth={}",
                                    snapshot.speech.dispatch_state,
                                    snapshot.speech.queue_depth
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

                start_route_with_overlay(app, &state, &direction, config, Some(omni_sender))
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
                    None, None, None,
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
        assert!(resolve_model_provider_from_config_value(
            &config,
            "template-nonexistent::some-model"
        )
        .is_none());
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
                stop_existing_inbound_pipeline(&app, &state)?;
            } else {
                engine::stop_route(app.clone(), &state, &direction)?;
            }
            Ok(state.snapshot())
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| e.to_string())?
}
