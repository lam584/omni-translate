use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use super::contracts::AudioRuntimeSnapshot;
use super::engine::AudioRouteSupervisor;
#[cfg(test)]
use super::gemini_live;
use super::speech;
use super::session_supervisor::AudioSessionSupervisor;
use super::state::AudioStateStore;
use super::subtitle_translate;
use super::translate;
use crate::bridge::{ipc::BridgeIpcClient, state::BridgeStateStore};
use crate::diagnostics::events::append_diagnostics_log;
#[cfg(test)]
use crate::provider::contracts::ProviderDraftInput;
use crate::runtime::events::show_subtitle_overlay_with_state;
use crate::runtime::state::RuntimeStateStore;

mod route_config;

mod realtime_session;

mod route_orchestrator;

pub(crate) use realtime_session::{cancel_omni_preconnect, preconnect_omni_realtime};
pub(crate) use realtime_session::preconnect_omni_realtime_inner;
#[cfg(test)]
use realtime_session::should_wait_for_omni_session_readiness;

pub(crate) use route_config::resolve_model_provider_from_config_value;
pub(crate) use route_config::resolve_composite_template_provider;
pub(crate) use route_config::subtitle_source_language_or_english;
pub(crate) use route_config::{resolve_realtime_profile, RealtimeProtocol};
pub(crate) use route_config::is_livetranslate_route_model;
pub(crate) use route_config::model_name_is_livetranslate;
use route_config::infer_legacy_omni_model;
#[cfg(test)]
use route_config::{
    is_openai_realtime_provider, resolve_realtime_audio_mode_for_route,
    resolve_realtime_audio_mode_value, resolve_route_target_language,
    should_start_secondary_speech_dispatch, ResolvedRouteKind, ResolvedRoutePlan,
    ResolvedVadPolicy, SpeechDispatchPolicy, SubtitleFallbackPolicy,
};

pub(crate) use route_orchestrator::{start_audio_route, stop_audio_route, stop_speech_dispatch};
pub(crate) use route_orchestrator::start_audio_route_inner;
#[cfg(test)]
use route_orchestrator::{
    execute_fast_watch_start, run_fast_watch_start_body, FastWatchStartOutcome,
};

pub(crate) const AUDIO_RUNTIME_SNAPSHOT_EVENT: &str = "audio://snapshot";
const AUDIO_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(6);
const OMNI_PRECONNECT_SESSION_READINESS_TIMEOUT: Duration = Duration::from_secs(45);
const OMNI_ROUTE_SESSION_READINESS_TIMEOUT: Duration = Duration::from_secs(90);
const OMNI_PRECONNECT_COMMAND_TIMEOUT: Duration = Duration::from_secs(50);
const OMNI_ROUTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(95);
const DEFAULT_ROUTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Single source for the route mode: a document missing `devices.routeMode`
/// (only reachable with corrupt/Null configs, since the default document pins
/// the key) behaves like the product default "watch". Call sites used to
/// disagree ("" vs "unknown" fallbacks) — keep them on this helper.
fn configured_route_mode(config: &Value) -> &str {
    config
        .pointer("/devices/routeMode")
        .and_then(Value::as_str)
        .unwrap_or("watch")
}

fn should_show_subtitle_overlay_for_route(direction: &str, config: &Value) -> bool {
    direction == "inbound" && configured_route_mode(config) == "watch"
}

fn route_command_timeout(direction: &str, config: &Value) -> Duration {
    if direction == "inbound" && configured_route_mode(config) == "watch" {
        // Registry-promoted omni models need the same generous budget as
        // name-inferred ones, so resolve the provider first and only fall
        // back to name inference when no provider matches.
        let timeout_budget = config
            .pointer("/devices/inboundVoiceModelId")
            .and_then(Value::as_str)
            .map(|requested| match resolve_model_provider_from_config_value(config, requested) {
                Some(provider) => Duration::from_millis(resolve_realtime_profile(&provider, &provider.model).timeout_budget_ms),
                None if infer_legacy_omni_model(&resolve_voice_model_runtime_id(requested)) => OMNI_ROUTE_COMMAND_TIMEOUT,
                None => DEFAULT_ROUTE_COMMAND_TIMEOUT,
            });
        if let Some(timeout) = timeout_budget { return timeout; }
    }

    DEFAULT_ROUTE_COMMAND_TIMEOUT
}

fn route_command_timeout_message(direction: &str, config: &Value, timeout: Duration) -> String {
    let route_mode = configured_route_mode(config);
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
    AudioRouteSupervisor::new(app.clone(), state).stop("inbound")?;
    if let Some(bridge_state) = app.try_state::<BridgeStateStore>() {
        let snapshot = bridge_state.snapshot();
        let _ = BridgeIpcClient::new(&snapshot).flush_source();
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

/// Tear down any prior session for `direction` before a new route start.
/// Inbound also owns the Bridge loopback source and the shared
/// subtitle-translate / speech-dispatch singletons; outbound only owns its own
/// capture route and realtime session handles, so it must not stop those
/// shared workers (doing so would kill an active inbound pipeline in
/// conversation mode).
fn stop_existing_route_pipeline(
    app: &AppHandle,
    state: &AudioStateStore,
    direction: &str,
    keep_omni: bool,
) -> Result<(), String> {
    if direction == "inbound" {
        return stop_existing_inbound_pipeline(app, state, keep_omni);
    }
    AudioRouteSupervisor::new(app.clone(), state).stop(direction)?;
    if let Some(handle) = state.take_stt_handle(direction) {
        let _ = handle.stop_tx.send(());
    }
    if !keep_omni {
        if let Some(handle) = state.take_omni_handle(direction) {
            let _ = handle.stop_tx.send(());
        }
    }
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
    let route_mode = configured_route_mode(&config);
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
    let snapshot = AudioRouteSupervisor::new(app.clone(), state).start(direction, config, stt_sender)?;

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

pub(crate) async fn bootstrap_audio(
    app: AppHandle,
) -> Result<AudioRuntimeSnapshot, String> {
    let task = tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AudioStateStore>();
            AudioSessionSupervisor::new(app.clone(), &state).bootstrap()
        });

    tokio::time::timeout(AUDIO_BOOTSTRAP_TIMEOUT, task)
        .await
        .map_err(|_| format!(
            "音频设备枚举超时（{} 秒）。可能存在无响应的音频设备或驱动；应用将以降级模式继续启动。",
            AUDIO_BOOTSTRAP_TIMEOUT.as_secs()
        ))?
        .map_err(|error| format!("音频初始化线程意外退出: {error}"))?
}

pub(crate) fn refresh_audio_devices(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
) -> Result<AudioRuntimeSnapshot, String> {
    AudioSessionSupervisor::new(app, &state).refresh_devices()
}

/// Best-effort idle-time pre-open of capture devices so a later route start only
/// has to `start_stream`. Both directions are warmed from one call so watch mode
/// (inbound) and conversation mode (inbound + outbound) share the same warmer;
/// virtual-driver inbound is skipped by the warmer since it flows through the
/// Bridge pipe. Never blocks the caller and never surfaces failures.
pub(crate) fn prewarm_capture_routes(
    app: AppHandle,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    let state = app.state::<AudioStateStore>();
    for direction in ["inbound", "outbound"] {
        state.warmer().prewarm(&app, direction, &config);
    }
    Ok(state.snapshot())
}

pub(crate) fn clear_subtitle_cues(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
) -> Result<AudioRuntimeSnapshot, String> {
    AudioSessionSupervisor::new(app, &state).clear_cues()
}

pub(crate) fn start_speech_dispatch(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    AudioSessionSupervisor::new(app, &state).start_speech(config)
}

pub(crate) fn start_translate_worker(
    app: AppHandle,
    state: State<'_, AudioStateStore>,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    AudioSessionSupervisor::new(app, &state).start_translation(config)
}

pub(crate) async fn stop_translate_worker(app: AppHandle) -> Result<AudioRuntimeSnapshot, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let app2 = app.clone();
        let state = app2.state::<AudioStateStore>();
        let result = translate::stop_translate(app, &state);
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| e.to_string())?
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
    fn omni_route_does_not_wait_for_remote_session_readiness() {
        assert!(!should_wait_for_omni_session_readiness("route"));
        assert!(should_wait_for_omni_session_readiness("preconnect"));
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
                    "realtimeProtocol": "gemini-live",
                    "realtimeAudioMode": "gemini_manual_activity"
                }
            ]
        }))
        .expect("provider should parse");

        let mode_value = resolve_realtime_audio_mode_value(&provider, &provider.model);
        assert_eq!(mode_value, "gemini_manual_activity");
        assert!(gemini_live::is_gemini_activity_mode(&mode_value));
        assert!(!is_openai_realtime_provider(&provider));
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
    fn named_dashscope_realtime_model_ignores_earlier_openai_exact_match() {
        let model = "qwen3.5-omni-plus-realtime";
        let config = config_with_providers(vec![
            provider_value(
                "template-openai-compatible",
                "provider-openai-compatible",
                "openai-compatible",
                model,
                "https://openai-compatible.test/v1",
                "websocket",
                "credential://provider/openai-compatible/default",
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

        let provider = resolve_model_provider_from_config_value(&config, model)
            .expect("named DashScope realtime model should resolve");

        assert_eq!(provider.kind, "dashscope");
        assert_eq!(provider.provider_id, "provider-dashscope");
        assert_eq!(provider.model, model);
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

    #[test]
    fn outbound_target_language_reverses_and_falls_back() {
        // Explicit outbound target wins.
        let explicit = json!({
            "subtitles": { "sourceLanguage": "en", "targetLanguage": "zh-CN", "outboundTargetLanguage": "ja" }
        });
        assert_eq!(resolve_route_target_language("outbound", &explicit), "ja");
        // No explicit outbound target -> derive from the subtitle source language.
        let derived = json!({
            "subtitles": { "sourceLanguage": "en", "targetLanguage": "zh-CN", "outboundTargetLanguage": "" }
        });
        assert_eq!(resolve_route_target_language("outbound", &derived), "en");
        // Source language is auto -> fall back to English.
        let auto = json!({
            "subtitles": { "sourceLanguage": "auto", "targetLanguage": "zh-CN", "outboundTargetLanguage": "" }
        });
        assert_eq!(resolve_route_target_language("outbound", &auto), "en");
        // Inbound keeps the subtitle target regardless of outbound settings.
        assert_eq!(resolve_route_target_language("inbound", &explicit), "zh-CN");
    }

    #[test]
    fn outbound_resolved_route_plan_targets_the_reversed_language() {
        let provider: ProviderDraftInput = serde_json::from_value(provider_value(
            "template-dashscope-realtime",
            "dashscope",
            "dashscope",
            "qwen3.5-omni-plus-realtime",
            "https://dashscope.aliyuncs.com/api/v1",
            "websocket",
            "dashscope",
        ))
        .expect("provider should parse");
        let config = json!({
            "devices": { "routeMode": "voice-room" },
            "subtitles": { "sourceLanguage": "en", "targetLanguage": "zh-CN", "outboundTargetLanguage": "" }
        });
        let plan = ResolvedRoutePlan::from_resolved_provider(
            "outbound", &config, provider.model.clone(), provider.clone(),
        );
        assert_eq!(plan.direction, "outbound");
        // sourceLanguage=en (non-auto) becomes the outbound target.
        assert_eq!(plan.target_language, "en");
        // Outbound Omni instructions are parameterized to the resolved target.
        assert!(plan.instructions.contains("en"));
    }

    #[test]
    fn resolved_route_plan_builds_vad_policy_table() {
        let provider: ProviderDraftInput = serde_json::from_value(provider_value(
            "template-dashscope-realtime",
            "dashscope",
            "dashscope",
            "qwen3.5-omni-plus-realtime",
            "https://dashscope.aliyuncs.com/api/v1",
            "websocket",
            "dashscope",
        )).expect("provider should parse");
        let cases = [
            ("watch", true, ResolvedVadPolicy::ManualCommit, false),
            ("game", true, ResolvedVadPolicy::ManualCommit, true),
            ("watch", false, ResolvedVadPolicy::ManualCommit, false),
        ];
        for (route_mode, bypass, expected_policy, expected_legacy_bypass) in cases {
            let config = json!({
                "devices": { "routeMode": route_mode },
                "vad": { "bypass": bypass },
                "subtitles": { "targetLanguage": "ja" }
            });
            let plan = ResolvedRoutePlan::from_resolved_provider(
                "inbound", &config, provider.model.clone(), provider.clone(),
            );
            assert_eq!(plan.vad_policy, expected_policy, "routeMode={route_mode}");
            assert_eq!(plan.legacy_vad_bypass, expected_legacy_bypass, "routeMode={route_mode}");
            assert_eq!(plan.target_language, "ja");
            assert_eq!(plan.session_reuse_key.model, provider.model);
        }
    }

    #[test]
    fn resolved_route_plan_requires_explicit_protocol_instead_of_s2s_capability_inference() {
        let mut value = provider_value(
            "template-dashscope-realtime",
            "dashscope",
            "dashscope",
            "qwen-audio-3.0-realtime-plus",
            "https://dashscope.aliyuncs.com/api/v1",
            "websocket",
            "dashscope",
        );
        let config = json!({
            "devices": { "routeMode": "watch" },
            "subtitles": { "targetLanguage": "zh-CN" }
        });

        // No registry entry: the model name contains "qwen-audio" + "realtime",
        // so infer_realtime_protocol classifies it as DashscopeOmni.
        let plain: ProviderDraftInput =
            serde_json::from_value(value.clone()).expect("provider should parse");
        let plan = ResolvedRoutePlan::from_resolved_provider(
            "inbound", &config, plain.model.clone(), plain.clone(),
        );
        assert_eq!(plan.kind, ResolvedRouteKind::Omni);
        assert_eq!(plan.voice, "longanqian");

        // Capabilities describe what the model can do; the explicit protocol
        // describes how to communicate with it.
        value["localModelCapabilityRegistry"] = json!([{
            "id": "registry-audio-realtime",
            "modelId": "qwen-audio-3.0-realtime-plus",
            "capabilities": ["speech-to-speech"],
            "realtimeProtocol": "dashscope-omni",
            "realtimeAudioMode": "server_vad",
            "interactionCapabilities": ["auto_vad", "streaming", "chunked_http_audio", "server_commit_tts"]
        }]);
        let registered: ProviderDraftInput =
            serde_json::from_value(value.clone()).expect("provider should parse");
        let plan = ResolvedRoutePlan::from_resolved_provider(
            "inbound", &config, registered.model.clone(), registered,
        );
        assert_eq!(plan.kind, ResolvedRouteKind::Omni);
        assert_eq!(plan.voice, "longanqian");

        // STT-only registry entries must not be promoted.
        value["localModelCapabilityRegistry"] = json!([{
            "id": "registry-audio-realtime",
            "modelId": "qwen-audio-3.0-realtime-plus",
            "capabilities": ["speech-to-text"],
            "realtimeProtocol": "dashscope-asr",
            "realtimeAudioMode": "server_vad",
            "interactionCapabilities": ["auto_vad", "streaming"]
        }]);
        let stt_only: ProviderDraftInput =
            serde_json::from_value(value).expect("provider should parse");
        let plan = ResolvedRoutePlan::from_resolved_provider(
            "inbound", &config, stt_only.model.clone(), stt_only,
        );
        assert_eq!(plan.kind, ResolvedRouteKind::DashscopeStt);
    }

    #[test]
    fn resolved_profile_honors_explicit_protocol_denial_and_first_duplicate() {
        let mut value = provider_value(
            "template-dashscope-realtime", "dashscope", "dashscope",
            "named-omni-realtime", "https://dashscope.aliyuncs.com/api/v1",
            "websocket", "dashscope",
        );
        value["localModelCapabilityRegistry"] = json!([
            {
                "id": "first-deny", "modelId": "named-omni-realtime",
                "capabilities": ["speech-to-text"],
                "realtimeProtocol": "dashscope-asr",
                "realtimeAudioMode": "server_vad",
                "interactionCapabilities": ["streaming"]
            },
            {
                "id": "second-omni", "modelId": "named-omni-realtime",
                "capabilities": ["speech-to-speech"],
                "realtimeProtocol": "dashscope-omni",
                "realtimeAudioMode": "manual",
                "interactionCapabilities": ["streaming"]
            }
        ]);
        let provider: ProviderDraftInput = serde_json::from_value(value).expect("provider");
        let profile = resolve_realtime_profile(&provider, &provider.model);
        assert_eq!(profile.route_kind, ResolvedRouteKind::DashscopeStt);
        assert_eq!(profile.realtime_audio_mode, "server_vad");
        assert_eq!(profile.diagnostics.len(), 1);
        assert!(profile.diagnostics[0].contains("first-deny"));
    }

    #[test]
    fn explicit_unhinted_protocol_gets_omni_timeout_and_preconnect_policy() {
        let mut value = provider_value(
            "template-dashscope-realtime", "dashscope", "dashscope",
            "deployment-blue", "https://dashscope.aliyuncs.com/api/v1",
            "websocket", "dashscope",
        );
        value["localModelCapabilityRegistry"] = json!([{
            "id": "blue", "modelId": "deployment-blue",
            "capabilities": ["speech-to-speech"],
            "realtimeProtocol": "dashscope-livetranslate",
            "realtimeAudioMode": "server_vad",
            "interactionCapabilities": ["streaming"]
        }]);
        let provider: ProviderDraftInput = serde_json::from_value(value.clone()).expect("provider");
        let profile = resolve_realtime_profile(&provider, &provider.model);
        assert_eq!(profile.route_kind, ResolvedRouteKind::Omni);
        assert!(profile.preconnect_allowed);
        assert_eq!(Duration::from_millis(profile.timeout_budget_ms), OMNI_ROUTE_COMMAND_TIMEOUT);

        let config = json!({
            "providers": [value],
            "devices": { "routeMode": "watch", "inboundVoiceModelId": "deployment-blue" }
        });
        assert_eq!(route_command_timeout("inbound", &config), OMNI_ROUTE_COMMAND_TIMEOUT);
    }

    #[test]
    fn explicit_protocol_matrix_is_alias_invariant() {
        let matrix = [
            ("dashscope-omni", "dashscope", ResolvedRouteKind::Omni, "pcm16", 16_000),
            ("dashscope-livetranslate", "dashscope", ResolvedRouteKind::Omni, "pcm", 16_000),
            ("dashscope-asr", "dashscope", ResolvedRouteKind::DashscopeStt, "pcm", 16_000),
            ("openai-conversation", "openai-compatible", ResolvedRouteKind::OpenAiRealtime, "pcm16", 24_000),
            ("openai-translation", "openai-compatible", ResolvedRouteKind::OpenAiRealtime, "pcm16", 24_000),
            ("openai-transcription", "openai-compatible", ResolvedRouteKind::OpenAiRealtime, "pcm16", 24_000),
            ("openai-flat", "openai-compatible", ResolvedRouteKind::OpenAiRealtime, "pcm16", 16_000),
            ("gemini-live", "openai-compatible", ResolvedRouteKind::GeminiLive, "pcm16", 16_000),
        ];
        for (index, (protocol, kind, route_kind, input_format, sample_rate)) in
            matrix.into_iter().enumerate()
        {
            for model in [format!("standard-{protocol}"), format!("deployment-{index}")] {
                let mut value = provider_value(
                    "template-explicit", "explicit", kind, &model,
                    "https://example.invalid/v1", "websocket", "explicit",
                );
                value["localModelCapabilityRegistry"] = json!([{
                    "id": format!("entry-{index}"),
                    "modelId": model,
                    "capabilities": [],
                    "interactionCapabilities": [],
                    "realtimeProtocol": protocol
                }]);
                let provider: ProviderDraftInput = serde_json::from_value(value).expect("provider");
                let profile = resolve_realtime_profile(&provider, &provider.model);
                assert_eq!(profile.protocol_dialect.map(|value| value.as_str()), Some(protocol));
                assert_eq!(profile.route_kind, route_kind);
                assert_eq!(profile.input_format, input_format);
                assert_eq!(profile.sample_rate, sample_rate);
                assert_eq!(profile.source, route_config::RealtimeProfileSource::Registry);
            }
        }
    }

    #[test]
    fn non_dashscope_s2s_capabilities_do_not_select_dashscope_omni() {
        let mut value = provider_value(
            "template-custom", "custom", "openai-compatible",
            "deployment-green", "https://example.invalid/v1", "websocket", "custom",
        );
        value["localModelCapabilityRegistry"] = json!([{
            "id": "green", "modelId": "deployment-green",
            "capabilities": ["speech-to-speech"],
            "realtimeAudioMode": "server_vad",
            "interactionCapabilities": ["streaming"]
        }]);
        let provider: ProviderDraftInput = serde_json::from_value(value).expect("provider");
        assert_eq!(
            resolve_realtime_profile(&provider, &provider.model).route_kind,
            ResolvedRouteKind::LocalVad
        );
    }

    #[test]
    fn resolved_route_plan_owns_secondary_provider_and_speech_policy() {
        let voice_value = provider_value(
            "template-dashscope-realtime", "dashscope", "dashscope",
            "qwen3.5-omni-plus-realtime", "https://dashscope.aliyuncs.com/api/v1",
            "websocket", "dashscope",
        );
        let text_value = provider_value(
            "template-deepseek", "deepseek", "openai-compatible", "deepseek-chat",
            "https://api.deepseek.com/v1", "streaming-http", "deepseek",
        );
        let voice_provider: ProviderDraftInput = serde_json::from_value(voice_value.clone())
            .expect("voice provider should parse");
        let config = json!({
            "providers": [voice_value, text_value],
            "devices": {
                "routeMode": "watch",
                "subtitleTranslationMode": "secondary",
                "subtitleTranslationModelId": "template-deepseek::deepseek-chat",
                "outputSpeechEnabled": true
            },
            "speech": { "translationAudioSource": "subtitle-tts" }
        });
        let plan = ResolvedRoutePlan::from_resolved_provider(
            "inbound", &config, voice_provider.model.clone(), voice_provider,
        );
        assert_eq!(plan.subtitle_fallback_policy, SubtitleFallbackPolicy::Secondary);
        assert_eq!(plan.speech_dispatch_policy, SpeechDispatchPolicy::SubtitleTtsWhenIdle);
        assert_eq!(plan.secondary_subtitle_provider.as_ref().map(|provider| provider.model.as_str()), Some("deepseek-chat"));
        assert!(plan.session_reuse_key.subtitle_translate_active);
    }

    #[test]
    fn fast_watch_start_body_normalizes_err_and_panic() {
        // A plain `Err` from the worker stays attributable verbatim.
        match run_fast_watch_start_body(std::panic::AssertUnwindSafe(
            || -> Result<AudioRuntimeSnapshot, String> { Err("boom".to_string()) },
        )) {
            FastWatchStartOutcome::Failed(reason) => assert_eq!(reason, "boom"),
            _ => panic!("expected the Err path to become a Failed outcome"),
        }

        // A panic is captured and surfaced with a readable reason instead of
        // escaping the worker as an unobserved JoinError.
        match run_fast_watch_start_body(std::panic::AssertUnwindSafe(
            || -> Result<AudioRuntimeSnapshot, String> {
                panic!("kaboom from start_audio_route_inner")
            },
        )) {
            FastWatchStartOutcome::Failed(reason) => {
                assert!(reason.contains("panic"), "reason should mark the panic: {reason}");
                assert!(reason.contains("kaboom from start_audio_route_inner"));
            }
            _ => panic!("expected the panic path to become a Failed outcome"),
        }
    }

    #[test]
    fn fast_watch_start_attributes_worker_panic_within_window() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let state = Arc::new(AudioStateStore::new());
        // Mirror the command's accepted (not-yet-ready) state.
        state.mark_route_start_requested(
            "inbound",
            "audio-route-inbound-watch",
            "system-output-default",
        );
        assert!(
            state.snapshot().inbound.last_error.is_none(),
            "accepted state must start without an error"
        );

        let emit_count = Arc::new(AtomicUsize::new(0));
        let started_at = std::time::Instant::now();

        // Run the worker on a detached thread, exactly like the dropped
        // spawn_blocking JoinHandle in the command, and inject a panic where
        // `start_audio_route_inner` would run.
        let worker_state = Arc::clone(&state);
        let worker_emit = Arc::clone(&emit_count);
        let worker = std::thread::spawn(move || {
            execute_fast_watch_start(
                &worker_state,
                std::panic::AssertUnwindSafe(|| -> Result<AudioRuntimeSnapshot, String> {
                    panic!("injected start_audio_route_inner failure")
                }),
                || {
                    worker_emit.fetch_add(1, Ordering::SeqCst);
                },
            );
        });

        // Poll like the front-end would, asserting the error lands inside a
        // bounded window rather than depending on the command timeout.
        let deadline = started_at + Duration::from_secs(2);
        let mut observed = None;
        while std::time::Instant::now() < deadline {
            if let Some(error) = state.snapshot().inbound.last_error {
                observed = Some(error);
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        worker.join().expect("worker thread should catch the panic, not propagate it");

        let error = observed.expect("lastError should be set within the expected window");
        assert!(error.contains("panic"), "reason should attribute the panic: {error}");
        assert!(error.contains("injected start_audio_route_inner failure"));
        assert_eq!(
            emit_count.load(Ordering::SeqCst),
            1,
            "a snapshot must be emitted once so polling can observe lastError"
        );
    }
}
