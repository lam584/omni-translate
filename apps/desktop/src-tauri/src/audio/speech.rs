use std::collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use omni_audio_dsp::{enhance_speech_i16, SpeechEnhancementMetrics};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::bridge::ipc::BridgeAudioWriter;
use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway::ProviderGateway;
use crate::storage::StorageStateStore;

use super::contracts::{
    AudioRuntimeSnapshot, SpeechDispatchEventRuntime, SubtitleCueRuntime,
    SubtitleTranslationStateRuntime,
};
use super::engine::emit_audio_snapshot;
use super::state::{AudioRouteHandle, AudioStateStore, CachedTtsAudio, CapturedSegmentAudio};

const SPEECH_POLL_INTERVAL_MS: u64 = 120;
const SPEECH_DISPATCH_IDLE_INTERVAL_MS: u64 = 40;
const MAX_PROCESSED_CUES: usize = 128;
const PROMPT_TONE_MS: u32 = 90;
const MAX_TTS_QUEUE_DEPTH: usize = 32;
const TTS_START_DEADLINE: Duration = Duration::from_secs(5);
const PLAYBACK_START_DEADLINE_MS: u64 = 4_000;

mod playback_engine;
mod aec_live_scenario;
mod speaker_render_event;
mod output_device;

use self::aec_live_scenario::{
    active_aec_live_scenario_assignments, AecLiveScenarioRender,
};
use self::playback_engine::{SpeechPlaybackEngine, SpeechPlaybackResult, SynthesisOutput};
pub(crate) use self::speaker_render_event::SpeakerRenderEvent;
use self::output_device::resolve_wasapi_render_device;
#[cfg(test)]
use self::output_device::normalized_device_name;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranslationAudioSource {
    None,
    OmniNative,
    SubtitleTts,
}

pub(crate) fn resolve_translation_audio_source(
    config: &Value,
    omni_native_supported: bool,
) -> TranslationAudioSource {
    match config
        .pointer("/speech/translationAudioSource")
        .and_then(Value::as_str)
        .unwrap_or("auto")
    {
        "omni-native" if omni_native_supported => TranslationAudioSource::OmniNative,
        "omni-native" => TranslationAudioSource::None,
        "subtitle-tts" => TranslationAudioSource::SubtitleTts,
        _ if omni_native_supported => TranslationAudioSource::OmniNative,
        _ => TranslationAudioSource::SubtitleTts,
    }
}

pub(crate) fn start_dispatch(
    app: AppHandle,
    store: &AudioStateStore,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    stop_dispatch(app.clone(), store)?;

    let initial_config = SpeechConfig::from_value(&config)?;
    store.update_speech(|speech| {
        speech.status = "ready".to_string();
        speech.dispatch_state = if initial_config.enabled {
            "waiting-subtitle".to_string()
        } else {
            "idle".to_string()
        };
        speech.policy = initial_config.priority.clone();
        speech.output_target = initial_config.output_target.clone();
        speech.ptt_gate_open = !initial_config.outbound_ptt_enabled
            || initial_config.outbound_ptt_state == "recording";
        speech.last_error = None;
    });
    crate::audio::worker_notify::announce_worker_started(&app, store, "已启动 speech dispatch worker。")?;

    let (stop_tx, stop_rx) = mpsc::channel();
    let app_handle = app.clone();
    let config_for_worker = config.clone();

    let join_handle = thread::Builder::new()
        .name("speech-dispatch".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            let result = SpeechDispatchWorker::new(app_handle.clone(), config_for_worker, stop_rx)
                .and_then(|worker| worker.run(&audio_state));
            if let Err(error) = result {
                audio_state.update_speech(|speech| {
                    speech.status = "degraded".to_string();
                    speech.dispatch_state = "error".to_string();
                    speech.last_error = Some(error.clone());
                    push_event(speech, "speech.error", error.clone(), None, None);
                });
                let _ = crate::audio::worker_notify::emit_worker_notification(
                    &app_handle,
                    crate::runtime::contracts::RuntimeNotification::warning(
                        "subtitle-tts-worker-failed",
                        "session",
                        &format!("字幕仍可用，但语音播报不可用：{error} | recommended: restart-route"),
                        crate::shared::time::now_unix_millis_marker(),
                    ),
                );
                let _ = append_diagnostics_log(
                    &app_handle,
                    "audio",
                    "error",
                    "speech dispatch worker 失败。",
                    Some(error),
                    None,
                    None,
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| {
            let message = format!("字幕仍可用，但语音播报 worker 启动失败：{error} | recommended: restart-route");
            store.update_speech(|speech| {
                speech.status = "degraded".to_string();
                speech.dispatch_state = "error".to_string();
                speech.last_error = Some(message.clone());
                push_event(speech, "speech.error", message.clone(), None, None);
            });
            let runtime_state = app.state::<crate::runtime::state::RuntimeStateStore>();
            let _ = crate::runtime::events::emit_runtime_notification(
                &app,
                &runtime_state,
                crate::runtime::contracts::RuntimeNotification::warning(
                    "subtitle-tts-worker-start-failed",
                    "session",
                    &message,
                    crate::shared::time::now_unix_millis_marker(),
                ),
            );
            let _ = emit_audio_snapshot(&app, store);
            message
        })?;

    store.insert_session(
        "speech",
        AudioRouteHandle {
            stop_tx,
            join_handle,
        },
    );
    Ok(store.snapshot())
}

pub(crate) fn stop_dispatch(
    app: AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    if let Some(handle) = store.take_session("speech") {
        let _ = handle.stop_tx.send(());
        let _ = handle.join_handle.join();
    }

    store.update_speech(|speech| {
        speech.dispatch_state = "idle".to_string();
        speech.current_cue_id = None;
        speech.current_request_id = None;
        speech.last_error = None;
        push_event(
            speech,
            "speech.stopped",
            "译音调度已停止。".to_string(),
            None,
            None,
        );
    });
    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "已停止 speech dispatch worker。",
        None,
        None,
        None,
    );
    emit_audio_snapshot(&app, store)?;
    Ok(store.snapshot())
}

include!("speech/dispatch.rs");

include!("speech/planner.rs");

include!("speech/mixer.rs");

include!("speech/output.rs");
include!("speech/bridge_route_recovery.rs");

include!("speech/config.rs");

#[cfg(test)]
mod translation_audio_source_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_config_automatically_prefers_omni_native_audio() {
        assert_eq!(
            resolve_translation_audio_source(&json!({}), true),
            TranslationAudioSource::OmniNative
        );
    }

    #[test]
    fn automatic_source_falls_back_to_subtitle_tts_without_native_audio() {
        assert_eq!(
            resolve_translation_audio_source(&json!({}), false),
            TranslationAudioSource::SubtitleTts
        );
    }

    #[test]
    fn explicit_unsupported_omni_native_source_stays_silent() {
        assert_eq!(
            resolve_translation_audio_source(
                &json!({ "speech": { "translationAudioSource": "omni-native" } }),
                false
            ),
            TranslationAudioSource::None
        );
    }

    #[test]
    fn explicit_subtitle_tts_ignores_available_native_audio() {
        assert_eq!(
            resolve_translation_audio_source(
                &json!({ "speech": { "translationAudioSource": "subtitle-tts" } }),
                true
            ),
            TranslationAudioSource::SubtitleTts
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::contracts::SubtitleDisplaySegmentRuntime;
    use super::*;
    use serde_json::json;

    /// Builds a provider entry `Value` for `providers` arrays in config
    /// fixtures. The auth/region/stream/timeout/template fields are fixed to
    /// the values these tests share; only the identifying fields vary.
    fn speech_provider_value(
        template_id: &str,
        provider_id: &str,
        kind: &str,
        display_name: &str,
        model: &str,
        base_url: &str,
        transport: &str,
    ) -> serde_json::Value {
        json!({
            "templateId": template_id, "providerId": provider_id,
            "kind": kind, "displayName": display_name,
            "model": model, "baseUrl": base_url,
            "transport": transport,
            "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
            "region": null, "streamEnabled": false, "timeoutMs": 1000,
            "systemPromptTemplate": "video-realtime-cn"
        })
    }

    /// Builds a `SubtitleDisplaySegmentRuntime` for cue fixtures.
    fn subtitle_segment(
        source_text: &str,
        translated_text: &str,
        pending: bool,
    ) -> SubtitleDisplaySegmentRuntime {
        SubtitleDisplaySegmentRuntime {
            source_text: source_text.to_string(),
            translated_text: translated_text.to_string(),
            pending,
        }
    }

    /// Builds a `SubtitleCueRuntime` for cue fixtures. The inbound route
    /// direction and `unix-ms:1`/`unix-ms:2` timestamps are fixed to the
    /// values these tests share; only the identifying/segment/commit fields
    /// vary.
    fn subtitle_cue_runtime(
        cue_id: &str,
        source_text: &str,
        display_source_text: &str,
        display_segments: Vec<SubtitleDisplaySegmentRuntime>,
        translated_text: &str,
        committed: bool,
        translation_committed: bool,
    ) -> SubtitleCueRuntime {
        SubtitleCueRuntime {
            cue_id: cue_id.to_string(),
            revision: None,
            sequence: None,
            route_direction: "inbound".to_string(),
            source_text: source_text.to_string(),
            display_source_text: display_source_text.to_string(),
            display_segments,
            translated_text: translated_text.to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed,
            translation_committed,
            translation_state: Some(if translation_committed {
                SubtitleTranslationStateRuntime::Final
            } else {
                SubtitleTranslationStateRuntime::Pending
            }),
        }
    }

    fn provider_input() -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: "template".to_string(),
            provider_id: "provider".to_string(),
            manifest_provider_id: None,
            kind: "openai-compatible".to_string(),
            template_realtime_protocol: None,
            realtime_protocol: None,
            display_name: "Provider".to_string(),
            model: "tts-model".to_string(),
            deployment_id: None,
            base_url: "http://127.0.0.1:1".to_string(),
            transport: "http".to_string(),
            auth_ref: crate::provider::contracts::ProviderAuthRefInput {
                kind: "credential-ref".to_string(),
                reference: "none".to_string(),
                header_name: "Authorization".to_string(),
                scheme: "none".to_string(),
            },
            region: None,
            stream_enabled: false,
            timeout_ms: 1000,
            system_prompt_template: "video-realtime-cn".to_string(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: vec![],
            scene_model_assignments: vec![],
            model_protocol_bindings: vec![],
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    #[test]
    fn build_mix_plan_adds_prompt_and_original_audio() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-outbound-1".to_string(),
            revision: None,
            sequence: None,
            route_direction: "outbound".to_string(),
            source_text: "source".to_string(),
            display_source_text: String::new(),
            display_segments: vec![],
            translated_text: "translated".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: true,
            translation_committed: true,
            translation_state: Some(SubtitleTranslationStateRuntime::Final),
        };
        let config = SpeechConfig {
            provider: provider_input(),
            enabled: true,
            target_language: "zh-CN".to_string(),
            voice: "Ethan".to_string(),
            output_target: "both".to_string(),
            local_playback_enabled: true,
            virtual_mic_output_enabled: true,
            bridge_playback_enabled: false,
            bridge_capture_mode: None,
            speaker_device_id: None,
            speaker_output_level: 100,
            priority: "subtitle-first".to_string(),
            inbound_delay_ms: 0,
            outbound_delay_ms: 0,
            outbound_ptt_enabled: false,
            outbound_ptt_state: "recording".to_string(),
            inbound_mix: RouteMixConfig {
                keep_original_audio: false,
                translated_audio_enabled: true,
                translated_audio_gain_db: 0.0,
                translated_audio_auto_gain_enabled: true,
                original_audio_gain_db: 0.0,
                ducking_enabled: false,
                ducking_depth_percent: 0,
            },
            outbound_mix: RouteMixConfig {
                keep_original_audio: true,
                translated_audio_enabled: true,
                translated_audio_gain_db: 0.0,
                translated_audio_auto_gain_enabled: false,
                original_audio_gain_db: 0.0,
                ducking_enabled: true,
                ducking_depth_percent: 30,
            },
            secondary_segment_tts_enabled: false,
        };
        let captured = CapturedSegmentAudio {
            cue_id: cue.cue_id.clone(),
            sample_rate_hz: 48_000,
            channel_count: 2,
            pcm_f32le: vec![0, 0, 64, 63, 0, 0, 64, 63, 0, 0, 64, 63, 0, 0, 64, 63],
        };

        let plan = SpeechMixPlanner::new(
            &cue,
            Some(captured),
            vec![2000, -2000, 1000, -1000],
            24_000,
            1,
            &config,
        )
        .build();

        assert!(!plan.speaker_samples.is_empty());
        assert!(!plan.virtual_mic_samples.is_empty());
        assert_eq!(plan.mix_mode, "original-plus-translated");
        assert!(plan.ducking_active);
        assert_eq!(plan.enhancement_metrics.auto_gain_db, 0.0);

        let mut bridge_config = config.clone();
        bridge_config.local_playback_enabled = false;
        bridge_config.virtual_mic_output_enabled = false;
        bridge_config.bridge_playback_enabled = true;
        let captured = CapturedSegmentAudio {
            cue_id: cue.cue_id.clone(),
            sample_rate_hz: 48_000,
            channel_count: 2,
            pcm_f32le: vec![0, 0, 64, 63, 0, 0, 64, 63, 0, 0, 64, 63, 0, 0, 64, 63],
        };
        let bridge_with_original = SpeechMixPlanner::new(
            &cue,
            Some(captured),
            vec![2000, -2000, 1000, -1000],
            24_000,
            1,
            &bridge_config,
        )
        .build();
        let bridge_without_original = SpeechMixPlanner::new(
            &cue,
            None,
            vec![2000, -2000, 1000, -1000],
            24_000,
            1,
            &bridge_config,
        )
        .build();
        assert!(bridge_with_original.speaker_samples.is_empty());
        assert!(bridge_with_original.virtual_mic_samples.is_empty());
        assert!(!bridge_with_original.bridge_playback_samples.is_empty());
        assert_eq!(
            bridge_with_original.bridge_playback_samples,
            bridge_without_original.bridge_playback_samples,
            "Bridge playback must not replay source audio that is already audible"
        );
    }

    #[test]
    fn output_route_plan_keeps_local_playback_and_virtual_mic_as_independent_targets() {
        let plan = SpeechOutputRoutePlan::new(true, true);

        assert!(plan.play_to_speaker);
        assert!(plan.write_to_virtual_mic);
    }

    #[test]
    fn output_route_plan_does_not_require_virtual_mic_for_local_playback() {
        let plan = SpeechOutputRoutePlan::new(true, false);

        assert!(plan.play_to_speaker);
        assert!(!plan.write_to_virtual_mic);
    }

    #[test]
    fn inbound_translation_is_only_played_to_the_local_listener() {
        let plan = SpeechOutputRoutePlan::for_route("inbound", true, true);

        assert!(plan.play_to_speaker);
        assert!(!plan.write_to_virtual_mic);
    }

    #[test]
    fn outbound_translation_is_only_sent_to_the_remote_party() {
        let plan = SpeechOutputRoutePlan::for_route("outbound", true, true);

        assert!(!plan.play_to_speaker);
        assert!(plan.write_to_virtual_mic);
    }

    #[test]
    fn outbound_translation_uses_speaker_when_aec_replaces_virtual_mic() {
        let plan = SpeechOutputRoutePlan::for_route("outbound", true, false);

        assert!(plan.play_to_speaker);
        assert!(!plan.write_to_virtual_mic);
    }

    #[test]
    fn unknown_translation_route_preserves_configured_outputs() {
        let plan = SpeechOutputRoutePlan::for_route("diagnostics", true, true);

        assert!(plan.play_to_speaker);
        assert!(plan.write_to_virtual_mic);
    }

    #[test]
    fn bridge_owned_physical_playback_does_not_override_outbound_virtual_mic_semantics() {
        let inbound = SpeechOutputRoutePlan::for_configured_route("inbound", true, true, true);
        assert!(!inbound.play_to_speaker);
        assert!(!inbound.write_to_virtual_mic);
        assert!(inbound.write_to_bridge_playback);

        let outbound = SpeechOutputRoutePlan::for_configured_route("outbound", true, true, true);
        assert!(!outbound.play_to_speaker);
        assert!(outbound.write_to_virtual_mic);
        assert!(!outbound.write_to_bridge_playback);
    }

    fn ready_bridge_translation_snapshot(
        mode: crate::bridge::contracts::SourceCaptureMode,
    ) -> crate::bridge::contracts::BridgeRuntimeSnapshot {
        use crate::bridge::contracts::{CaptureBackend, ProcessLoopbackStatus, SourceCaptureMode};

        let mut snapshot = crate::bridge::contracts::BridgeRuntimeSnapshot::default();
        snapshot.process_status = "running".to_string();
        snapshot.bridge_state = "running".to_string();
        snapshot.lifecycle_state = "ready".to_string();
        snapshot.session_id = Some("session-route-owner".to_string());
        snapshot.source_capture_mode = mode;
        snapshot.translation_playback_enabled = true;
        match mode {
            SourceCaptureMode::VirtualDriver => {
                snapshot.capture_backend = CaptureBackend::DriverVirtualSpeaker;
                snapshot.driver_health = "running".to_string();
            }
            SourceCaptureMode::ProcessExclusion => {
                snapshot.capture_backend = CaptureBackend::WasapiProcessExclusion;
                snapshot.process_loopback_supported = true;
                snapshot.process_loopback_status = ProcessLoopbackStatus::Ready;
                snapshot.excluded_process_id = Some(4242);
            }
            SourceCaptureMode::None => {}
        }
        snapshot
    }

    #[test]
    fn active_bridge_capture_blocks_process_or_driver_to_desktop_config_drift() {
        use crate::bridge::contracts::SourceCaptureMode;

        let desktop_plan = SpeechOutputRoutePlan::for_configured_route(
            "inbound",
            true,
            false,
            false,
        );
        for active_mode in [
            SourceCaptureMode::ProcessExclusion,
            SourceCaptureMode::VirtualDriver,
        ] {
            let snapshot = ready_bridge_translation_snapshot(active_mode);
            let error = translation_output_route_violation(
                "cue-config-drift",
                "inbound",
                None,
                &desktop_plan,
                &snapshot,
            )
            .expect("an active isolated capture route must block Desktop playback");
            assert!(error.contains("bridge.translation-output-bypass"));
            assert!(error.contains(active_mode.as_str()));
        }
    }

    #[test]
    fn configured_bridge_capture_blocks_runtime_route_mismatch() {
        use crate::bridge::contracts::SourceCaptureMode;

        let bridge_plan = SpeechOutputRoutePlan::for_configured_route(
            "inbound",
            false,
            false,
            true,
        );
        let inactive = crate::bridge::contracts::BridgeRuntimeSnapshot::default();
        for configured_mode in [
            SourceCaptureMode::ProcessExclusion,
            SourceCaptureMode::VirtualDriver,
        ] {
            let error = translation_output_route_violation(
                "cue-runtime-mismatch",
                "inbound",
                Some(configured_mode),
                &bridge_plan,
                &inactive,
            )
            .expect("a configured isolated route must not write to a mismatched Bridge");
            assert!(error.contains("bridge.translation-output-bypass"));
            assert!(error.contains(configured_mode.as_str()));
        }
    }

    #[test]
    fn controlled_process_restart_waits_for_bridge_owner_to_recover() {
        use crate::bridge::contracts::{
            CaptureBackend, ProcessLoopbackStatus, SourceCaptureMode,
        };

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(crate::bridge::state::BridgeStateStore::new());
        let bridge_state = app.state::<crate::bridge::state::BridgeStateStore>();
        bridge_state.update_snapshot(|snapshot| {
            snapshot.source_capture_mode = SourceCaptureMode::None;
            snapshot.capture_backend = CaptureBackend::WasapiProcessExclusion;
            snapshot.process_loopback_supported = true;
            snapshot.process_loopback_status = ProcessLoopbackStatus::Ready;
            snapshot.process_status = "stopped".to_string();
            snapshot.bridge_state = "stopped".to_string();
            snapshot.lifecycle_state = "starting".to_string();
        });
        let handle = app.handle().clone();
        let updater = handle.clone();
        let join = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            updater
                .state::<crate::bridge::state::BridgeStateStore>()
                .update_snapshot(|snapshot| {
                    snapshot.source_capture_mode = SourceCaptureMode::ProcessExclusion;
                    snapshot.process_status = "running".to_string();
                    snapshot.bridge_state = "running".to_string();
                    snapshot.lifecycle_state = "ready".to_string();
                    snapshot.translation_playback_enabled = true;
                    snapshot.session_id = Some("restarted-session".to_string());
                });
        });
        let plan = SpeechOutputRoutePlan::for_configured_route("inbound", false, false, true);
        let started = Instant::now();
        let snapshot = wait_for_translation_output_route(
            &handle,
            "inbound",
            Some(SourceCaptureMode::ProcessExclusion),
            &plan,
        );
        join.join().expect("snapshot updater");

        assert!(started.elapsed() >= Duration::from_millis(75));
        assert_eq!(snapshot.process_status, "running");
        assert_eq!(snapshot.source_capture_mode, SourceCaptureMode::ProcessExclusion);
        assert_eq!(translation_output_route_violation(
            "cue-after-restart",
            "inbound",
            Some(SourceCaptureMode::ProcessExclusion),
            &plan,
            &snapshot,
        ), None);
    }

    #[test]
    fn unrelated_stopped_bridge_does_not_enter_recovery_wait() {
        use crate::bridge::contracts::SourceCaptureMode;

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(crate::bridge::state::BridgeStateStore::new());
        let plan = SpeechOutputRoutePlan::for_configured_route("inbound", false, false, true);
        let started = Instant::now();
        let snapshot = wait_for_translation_output_route(
            &app.handle().clone(),
            "inbound",
            Some(SourceCaptureMode::ProcessExclusion),
            &plan,
        );

        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(translation_output_route_violation(
            "cue-stopped",
            "inbound",
            Some(SourceCaptureMode::ProcessExclusion),
            &plan,
            &snapshot,
        ).is_some());
    }

    #[test]
    fn matching_process_and_driver_routes_keep_bridge_as_the_only_owner() {
        use crate::bridge::contracts::SourceCaptureMode;

        let bridge_plan = SpeechOutputRoutePlan::for_configured_route(
            "inbound",
            false,
            false,
            true,
        );
        for configured_mode in [
            SourceCaptureMode::ProcessExclusion,
            SourceCaptureMode::VirtualDriver,
        ] {
            let snapshot = ready_bridge_translation_snapshot(configured_mode);
            assert_eq!(
                translation_output_route_violation(
                    "cue-matching-route",
                    "inbound",
                    Some(configured_mode),
                    &bridge_plan,
                    &snapshot,
                ),
                None,
            );
        }
    }

    #[test]
    fn isolated_routes_allow_outbound_only_through_the_bridge_virtual_mic_sink() {
        use crate::bridge::contracts::SourceCaptureMode;

        let outbound = SpeechOutputRoutePlan::for_configured_route("outbound", true, true, true);
        for mode in [
            SourceCaptureMode::VirtualDriver,
            SourceCaptureMode::ProcessExclusion,
        ] {
            let snapshot = ready_bridge_translation_snapshot(mode);
            assert_eq!(translation_output_route_violation(
                "cue-outbound-virtual-mic",
                "outbound",
                Some(mode),
                &outbound,
                &snapshot,
            ), None);
        }
    }

    #[test]
    fn process_exclusion_disables_desktop_playback_and_enables_bridge_playback() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "process-exclusion"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(!desktop_direct_playback_enabled_for_config(&config));
        assert!(bridge_translation_playback_enabled_for_config(&config));
    }

    #[test]
    fn virtual_driver_routes_default_local_playback_only_through_bridge() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver",
                "outputDeviceId": "speaker-default"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(!desktop_direct_playback_enabled_for_config(&config));
        assert!(bridge_translation_playback_enabled_for_config(&config));
    }

    #[test]
    fn virtual_driver_keeps_bridge_as_the_single_owner_for_explicit_physical_output() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver",
                "outputDeviceId": "耳机 (iBasso-DC-Series)"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(!desktop_direct_playback_enabled_for_config(&config));
        assert!(bridge_translation_playback_enabled_for_config(&config));
        let plan = SpeechOutputRoutePlan::for_configured_route(
            "inbound",
            desktop_direct_playback_enabled_for_config(&config),
            false,
            bridge_translation_playback_enabled_for_config(&config),
        );
        assert_eq!(
            plan,
            SpeechOutputRoutePlan {
                play_to_speaker: false,
                write_to_virtual_mic: false,
                write_to_bridge_playback: true,
            }
        );
    }

    #[test]
    fn virtual_driver_tts_config_keeps_a_bridge_sink_with_the_default_alias() {
        let config = SpeechConfig::from_value(&json!({
            "speech": {
                "enabled": true,
                "translationAudioSource": "subtitle-tts",
                "localPlaybackEnabled": true,
                "outputTarget": "speaker"
            },
            "devices": {
                "feedbackLoopPrevention": "virtual-driver",
                "outputDeviceId": "speaker-default",
                "outputSpeechEnabled": true
            }
        }))
        .expect("virtual-driver TTS config should parse");

        assert!(!config.local_playback_enabled);
        assert!(config.bridge_playback_enabled);
        assert_eq!(config.output_target, "bridge-playback");
        let plan = SpeechOutputRoutePlan::for_configured_route(
            "inbound",
            config.local_playback_enabled,
            config.virtual_mic_output_enabled,
            config.bridge_playback_enabled,
        );
        assert!(!plan.play_to_speaker);
        assert!(!plan.write_to_virtual_mic);
        assert!(plan.write_to_bridge_playback);
    }

    #[test]
    fn echo_cancel_feedback_prevention_keeps_requested_local_playback() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "echo-cancel"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(desktop_direct_playback_enabled_for_config(&config));
    }

    #[test]
    fn convert_captured_audio_downsamples_stereo_float_to_mono_24k() {
        let audio = CapturedSegmentAudio {
            cue_id: "cue-inbound-1".to_string(),
            sample_rate_hz: 48_000,
            channel_count: 2,
            pcm_f32le: [
                1.0_f32.to_le_bytes(),
                (-1.0_f32).to_le_bytes(),
                0.5_f32.to_le_bytes(),
                0.5_f32.to_le_bytes(),
                0.25_f32.to_le_bytes(),
                0.25_f32.to_le_bytes(),
                (-0.5_f32).to_le_bytes(),
                (-0.5_f32).to_le_bytes(),
            ]
            .into_iter()
            .flatten()
            .collect(),
        };

        let mono = convert_captured_audio_to_mono_i16_24k(&audio);

        assert_eq!(mono.len(), 2);
        assert_eq!(mono[0], 0);
        assert!(mono[1] > 7_000 && mono[1] < 9_000);
    }

    #[test]
    fn speech_ready_rejects_nonfinal_translation_even_when_segment_is_stable() {
        let cue = subtitle_cue_runtime(
            "cue-1",
            "hello",
            "hello",
            vec![subtitle_segment("hello", "你好。", false)],
            "你好。",
            false,
            false,
        );

        assert!(!is_speech_ready_cue(&cue));
    }

    #[test]
    fn speech_ready_ignores_pending_secondary_translation() {
        let cue = subtitle_cue_runtime(
            "cue-1",
            "hello",
            "hello",
            vec![subtitle_segment("hello", "你", true)],
            "你",
            false,
            false,
        );

        assert!(!is_speech_ready_cue(&cue));
    }

    #[test]
    fn terminal_translation_error_is_never_enqueued_for_tts() {
        let config = secondary_subtitle_tts_config();
        let mut cue = subtitle_cue_runtime(
            "cue-error",
            "hello",
            "hello",
            vec![subtitle_segment(
                "hello",
                "[翻译失败] 本地翻译队列过载",
                false,
            )],
            "[翻译失败] 本地翻译队列过载",
            true,
            false,
        );
        cue.translation_state = Some(SubtitleTranslationStateRuntime::Error);

        assert!(!is_speech_ready_cue(&cue));
        assert!(speech_dispatch_tasks_for_cue(&cue, &config, &HashSet::new()).is_empty());
    }

    #[test]
    fn final_translation_text_is_not_classified_by_failure_prefix() {
        let config = secondary_subtitle_tts_config();
        let cue = subtitle_cue_runtime(
            "cue-quoted-error",
            "say the label",
            "say the label",
            vec![subtitle_segment("say the label", "[翻译失败] 是界面标签。", false)],
            "[翻译失败] 是界面标签。",
            true,
            true,
        );

        assert!(is_speech_ready_cue(&cue));
        assert_eq!(
            speech_dispatch_tasks_for_cue(&cue, &config, &HashSet::new()).len(),
            1
        );
    }

    #[test]
    fn native_route_uses_single_cue_task_without_segment_tts() {
        let config = SpeechConfig::from_value(&json!({
            "speech": {
                "enabled": true,
                "translationAudioSource": "auto"
            },
            "devices": {
                "subtitleTranslationMode": "native",
                "outputSpeechEnabled": false
            }
        }))
        .unwrap();
        let cue = subtitle_cue_runtime(
            "cue-native",
            "hello",
            "hello",
            vec![subtitle_segment("hello", "你好。", false)],
            "你好。",
            true,
            true,
        );

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config, &HashSet::new());

        assert_eq!(tasks.len(), 1);
        assert!(!tasks[0].segment_mode);
        assert_eq!(tasks[0].translated_text, "你好。");
    }

    /// Secondary subtitle-TTS speech config shared by the segment-dispatch
    /// tests.
    fn secondary_subtitle_tts_config() -> SpeechConfig {
        SpeechConfig::from_value(&json!({
            "speech": {
                "translationAudioSource": "subtitle-tts"
            },
            "devices": {
                "subtitleTranslationMode": "secondary",
                "subtitleTranslationModelId": "template::text-model",
                "outputSpeechEnabled": true
            }
        }))
        .unwrap()
    }

    #[test]
    fn secondary_route_dispatches_only_final_display_segments() {
        let config = secondary_subtitle_tts_config();
        let cue = subtitle_cue_runtime(
            "cue-secondary",
            "hello then wait",
            "hello\nthen wait",
            vec![
                subtitle_segment("hello", "你好。", false),
                subtitle_segment("then wait", "然后等等", false),
                subtitle_segment("", "", true),
            ],
            "你好。\n然后等等",
            false,
            true,
        );

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config, &HashSet::new());

        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].segment_mode);
        assert_eq!(tasks[0].segment_index, 0);
        assert_eq!(tasks[0].translated_text, "你好。");
    }

    #[test]
    fn secondary_route_splits_multiline_translation_into_tts_tasks() {
        let config = secondary_subtitle_tts_config();
        let cue = subtitle_cue_runtime(
            "cue-secondary",
            "rocket and future then pending",
            "rocket and future\nthen pending",
            vec![
                subtitle_segment(
                    "rocket and future",
                    "现在你看到的这艘火箭造价十亿美元\n这项未来科技有朝一日将会带你远赴火星",
                    false,
                ),
                subtitle_segment("then pending", "还在等待", false),
                subtitle_segment("", "", true),
            ],
            "现在你看到的这艘火箭造价十亿美元\n这项未来科技有朝一日将会带你远赴火星\n还在等待",
            false,
            true,
        );

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config, &HashSet::new());

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].segment_index, 0);
        assert_eq!(tasks[0].translated_text, "现在你看到的这艘火箭造价十亿美元");
        assert_eq!(tasks[1].segment_index, 1);
        assert_eq!(tasks[1].translated_text, "这项未来科技有朝一日将会带你远赴火星");
    }

    #[test]
    fn secondary_tts_clause_splitter_preserves_sentence_punctuation() {
        let parts = split_tts_clauses("我的天哪。在本期视频中 我们将展示未来！\n以及更多科技");

        assert_eq!(
            parts,
            vec![
                "我的天哪。".to_string(),
                "在本期视频中 我们将展示未来！".to_string(),
                "以及更多科技".to_string(),
            ]
        );
    }

    #[test]
    fn secondary_segment_slot_allows_changed_replacement_replay() {
        let cue = subtitle_cue_runtime(
            "cue-secondary",
            "hello",
            "hello",
            Vec::new(),
            "hello translated",
            false,
            false,
        );
        let first = SpeechDispatchTask {
            cue: cue.clone(),
            segment_index: 0,
            source_text: "hello".to_string(),
            translated_text: "hello translated".to_string(),
            segment_mode: true,
            queued_at: Instant::now(),
        };
        let replacement = SpeechDispatchTask {
            cue,
            segment_index: 0,
            source_text: "hello there".to_string(),
            translated_text: "hello there translated".to_string(),
            segment_mode: true,
            queued_at: Instant::now(),
        };
        let mut processed = HashSet::new();
        let mut processed_order = VecDeque::new();
        let mut processed_slots = HashSet::new();
        let mut processed_slot_order = VecDeque::new();

        assert_ne!(first.dispatch_key(), replacement.dispatch_key());
        assert_ne!(first.segment_slot_key(), replacement.segment_slot_key());

        let dispatch_key = first.dispatch_key();
        remember_processed(&mut processed, &mut processed_order, &dispatch_key);
        remember_segment_slot_processed(&first, &mut processed_slots, &mut processed_slot_order);

        assert!(!is_processed_task(
            &replacement,
            &processed,
            &processed_slots
        ));
    }

    #[test]
    fn tts_admission_keeps_only_the_newest_32_tasks() {
        let cue = subtitle_cue_runtime(
            "cue-base",
            "hello",
            "hello",
            Vec::new(),
            "你好",
            true,
            true,
        );
        let tasks: Vec<_> = (0..MAX_TTS_QUEUE_DEPTH + 3)
            .map(|index| SpeechDispatchTask {
                cue: SubtitleCueRuntime {
                    cue_id: format!("cue-{index}"),
                    ..cue.clone()
                },
                segment_index: 0,
                source_text: format!("source-{index}"),
                translated_text: format!("translated-{index}"),
                segment_mode: false,
                queued_at: Instant::now(),
            })
            .collect();
        let mut queue = SpeechDispatchQueue::default();

        let (admitted, overflow) = queue.admit(tasks);

        assert_eq!(admitted.len(), MAX_TTS_QUEUE_DEPTH);
        assert_eq!(overflow.len(), 3);
        assert_eq!(admitted.first().unwrap().cue.cue_id, "cue-3");
        assert!(overflow
            .iter()
            .all(|task| queue.contains(task)));
    }

    #[test]
    fn tts_admission_preserves_original_queue_age() {
        let cue = subtitle_cue_runtime(
            "cue-aged",
            "hello",
            "hello",
            Vec::new(),
            "你好",
            true,
            true,
        );
        let task = SpeechDispatchTask {
            cue,
            segment_index: 0,
            source_text: "hello".to_string(),
            translated_text: "你好".to_string(),
            segment_mode: false,
            queued_at: Instant::now(),
        };
        let key = task.dispatch_key();
        let original = Instant::now() - TTS_START_DEADLINE;
        let mut queue = SpeechDispatchQueue::default();
        queue.queued_at.insert(key, original);

        let (admitted, overflow) = queue.admit(vec![task]);

        assert!(overflow.is_empty());
        assert!(admitted[0].queued_at <= original + Duration::from_millis(1));
        assert!(admitted[0].queued_at.elapsed() >= TTS_START_DEADLINE);
    }

    #[test]
    fn speech_config_uses_subtitle_priority_to_compute_dispatch_delay() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [speech_provider_value("template", "provider", "openai-compatible", "Provider", "tts-model", "http://127.0.0.1:1", "http")],
          "speech": {
            "enabled": true,
            "targetLanguage": "en-US",
            "voicePresetId": "voice-en-neutral",
            "outputTarget": "both",
            "localPlaybackEnabled": true,
            "virtualMicOutputEnabled": true
          },
          "subtitles": {
            "priority": "subtitle-first"
          },
          "devices": {
            "inboundRoute": {
              "latencyControl": {
                "translationBufferMs": 120,
                "playbackBufferMs": 40
              },
              "mixControl": {}
            },
            "outboundRoute": {
              "latencyControl": {
                "translationBufferMs": 90,
                "playbackBufferMs": 50
              },
              "pushToTalk": {
                "enabled": true,
                "state": "recording"
              },
              "mixControl": {}
            }
          }
        }))
        .expect("speech config should parse");

        assert_eq!(config.dispatch_delay_ms("inbound"), 160);
        assert_eq!(config.dispatch_delay_ms("outbound"), 140);
    }

    #[test]
    fn speech_config_rejects_unregistered_explicit_text_to_speech_model() {
        let result = SpeechConfig::from_value(&json!({
          "providers": [
            speech_provider_value("template-main", "provider-main", "openai-compatible", "Main Provider", "main-model", "http://main.test", "http"),
            speech_provider_value("template-linked", "provider-linked", "dashscope", "Linked Provider", "linked-default", "http://linked.test", "websocket")
          ],
          "speech": {
            "enabled": true,
            "targetLanguage": "en-US",
            "voicePresetId": "voice-en-neutral",
            "textToSpeechModelId": "template-linked::tts-model",
            "outputTarget": "both",
            "localPlaybackEnabled": true,
            "virtualMicOutputEnabled": true
          },
          "subtitles": {
            "priority": "balanced"
          },
          "devices": {
            "textToSpeechModelId": "template-main::device-tts-model",
            "outboundVoiceModelId": "template-main::outbound-model",
            "inboundRoute": {
              "latencyControl": {},
              "mixControl": {}
            },
            "outboundRoute": {
              "latencyControl": {},
              "pushToTalk": {},
              "mixControl": {}
            }
          }
        }));
        let error = match result {
            Ok(_) => panic!("an unregistered DashScope TTS model must fail before connect"),
            Err(error) => error,
        };

        assert!(error.contains("tts-model"), "{error}");
        assert!(error.contains("model_protocol.model_not_registered"), "{error}");
    }

    #[test]
    fn secondary_tts_rejects_unregistered_inbound_secondary_audio_model() {
        let result = SpeechConfig::from_value(&json!({
          "providers": [
            speech_provider_value("template-default", "provider-default", "openai-compatible", "Default Provider", "default-model", "http://default.test", "http"),
            speech_provider_value("template-secondary", "provider-secondary", "dashscope", "Secondary Provider", "old-model", "http://secondary.test", "websocket")
          ],
          "devices": {
            "subtitleTranslationMode": "secondary",
            "subtitleTranslationModelId": "template-default::text-model",
            "outputSpeechEnabled": true,
            "inboundSecondaryAudioModelId": "template-secondary::secondary-tts",
            "inboundRoute": { "latencyControl": {}, "mixControl": {} },
            "outboundRoute": { "latencyControl": {}, "pushToTalk": {}, "mixControl": {} }
          },
          "speech": {
            "translationAudioSource": "subtitle-tts"
          }
        }));
        let error = match result {
            Ok(_) => panic!("an unregistered secondary TTS model must fail before connect"),
            Err(error) => error,
        };

        assert!(error.contains("secondary-tts"), "{error}");
        assert!(error.contains("model_protocol.model_not_registered"), "{error}");
    }

    #[test]
    fn secondary_tts_rejects_livetranslate_and_omni_as_tts_before_connect() {
        let result = SpeechConfig::from_value(&json!({
          "providers": [
            {
              "templateId": "template-dashscope-realtime",
              "providerId": "provider-dashscope",
              "kind": "dashscope",
              "displayName": "DashScope",
              "model": "qwen3.5-livetranslate-flash-realtime",
              "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
              "transport": "websocket",
              "authRef": { "kind": "credential-ref", "reference": "credential://provider/dashscope/default", "headerName": "Authorization", "scheme": "Bearer" },
              "region": null,
              "streamEnabled": false,
              "timeoutMs": 1000,
              "systemPromptTemplate": "video-realtime-cn"
            }
          ],
          "devices": {
            "subtitleTranslationMode": "secondary",
            "subtitleTranslationModelId": "template-deepseek::deepseek-v4-flash",
            "outputSpeechEnabled": true,
            "inboundSecondaryAudioModelId": "template-dashscope-realtime::qwen3.5-livetranslate-flash-realtime",
            "inboundRoute": { "latencyControl": {}, "mixControl": {} },
            "outboundRoute": { "latencyControl": {}, "pushToTalk": {}, "mixControl": {} }
          },
          "speech": {
            "translationAudioSource": "subtitle-tts",
            "textToSpeechModelId": "qwen3.5-omni-plus-realtime"
          }
        }));
        let error = match result {
            Ok(_) => panic!("neither LiveTranslate nor Omni is a TTS product profile"),
            Err(error) => error,
        };

        assert!(error.contains("model_protocol.operation_not_supported"));
    }

    #[test]
    fn output_level_scales_virtual_mic_samples() {
        assert_eq!(
            scale_i16_by_output_level(&[1000, -1000], 50),
            vec![500, -500]
        );
        assert_eq!(scale_i16_by_output_level(&[1000], 0), vec![0]);
        assert_eq!(scale_i16_by_output_level(&[1000], 200), vec![1000]);
    }

    #[test]
    fn final_speech_mix_uses_peak_safe_scaling_instead_of_hard_clipping() {
        let mixed = mix_pcm_tracks(&[30_000, -30_000], &[20_000, -20_000]);
        let ceiling = 10.0_f32.powf(-1.0 / 20.0) * i16::MAX as f32;

        assert!(mixed.iter().all(|sample| (*sample as f32).abs() <= ceiling + 1.0));
        assert_eq!(mixed[0], -mixed[1]);
        assert!(mixed[0] < i16::MAX);
    }

    #[test]
    fn resolve_model_provider_composite_id_matches_linked_by_template() {
        let config = json!({
            "providers": [
                speech_provider_value("template-main", "provider-main", "openai-compatible", "Main", "main-model", "http://main.test", "http"),
                speech_provider_value("template-linked", "provider-linked", "dashscope", "Linked", "linked-default", "http://linked.test", "websocket")
            ]
        });
        let provider =
            resolve_model_provider_from_config_value(&config, "template-linked::tts-model")
                .expect("composite ID should resolve to linked provider");
        assert_eq!(provider.provider_id, "provider-linked");
        assert_eq!(provider.model, "tts-model");
        assert_eq!(provider.kind, "dashscope");
    }

    #[test]
    fn resolve_model_provider_returns_none_for_unmatched_model() {
        let config = json!({
            "providers": [speech_provider_value("template-main", "provider-main", "openai-compatible", "Main", "main-model", "http://main.test", "http")]
        });
        assert!(resolve_model_provider_from_config_value(&config, "unknown-model").is_none());
    }

    #[test]
    fn resolve_model_provider_returns_none_for_unknown_composite_template() {
        let config = json!({
            "providers": [speech_provider_value("template-main", "provider-main", "openai-compatible", "Main", "main-model", "http://main.test", "http")]
        });
        assert!(resolve_model_provider_from_config_value(
            &config,
            "template-nonexistent::some-model"
        )
        .is_none());
    }

    #[test]
    fn resolve_model_provider_composite_id_matches_main_by_template() {
        let config = json!({
            "providers": [speech_provider_value("template-main", "provider-main", "openai-compatible", "Main", "main-model", "http://main.test", "http")]
        });
        let provider =
            resolve_model_provider_from_config_value(&config, "template-main::custom-model")
                .expect("composite ID should resolve to main provider");
        assert_eq!(provider.provider_id, "provider-main");
        assert_eq!(provider.model, "custom-model");
        assert_eq!(provider.kind, "openai-compatible");
    }

    #[test]
    fn playback_volume_normalizes_and_clamps_output_level() {
        assert_eq!(playback_volume(0), 0.0);
        assert_eq!(playback_volume(66), 0.66);
        assert_eq!(playback_volume(100), 1.0);
        assert_eq!(playback_volume(101), 1.0);
    }

    #[test]
    fn speaker_output_name_matching_ignores_case_and_spaces() {
        let resolved = normalized_device_name("Headphones (iBasso-DC-Series)");
        let requested = normalized_device_name("ibasso-dc-series");

        assert!(resolved.contains(&requested));
    }

    // ── planner tests ──────────────────────────────────────────────

    fn planner_test_cue(
        cue_id: &str,
        translated_text: &str,
        committed: bool,
        translation_committed: bool,
    ) -> SubtitleCueRuntime {
        SubtitleCueRuntime {
            cue_id: cue_id.to_string(),
            revision: None,
            sequence: None,
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: vec![],
            translated_text: translated_text.to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed,
            translation_committed,
            translation_state: Some(if translation_committed {
                SubtitleTranslationStateRuntime::Final
            } else {
                SubtitleTranslationStateRuntime::Pending
            }),
        }
    }

    fn planner_test_config() -> SpeechConfig {
        SpeechConfig::from_value(&json!({
            "speech": {
                "enabled": true,
                "translationAudioSource": "auto"
            },
            "devices": {
                "subtitleTranslationMode": "native",
                "outputSpeechEnabled": false
            }
        }))
        .unwrap()
    }

    #[test]
    fn committed_cue_already_played_returns_empty_tasks() {
        let config = planner_test_config();
        let cue = planner_test_cue("cue-played", "hello translated", true, true);
        let mut committed_played = HashSet::new();
        committed_played.insert("cue-played".to_string());

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config, &committed_played);

        assert!(tasks.is_empty());
    }

    #[test]
    fn stale_uncommitted_cue_returns_empty_tasks() {
        let config = planner_test_config();
        let cue = planner_test_cue("cue-stale", "hello translated", false, false);

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config, &HashSet::new());

        assert!(tasks.is_empty());
    }

    #[test]
    fn playback_money_guard_corrects_a_wrong_native_amount_before_tts() {
        let source = "Its construction budget is five hundred million dollars.";
        let corrected = corrected_money_translation_for_playback(source, "建设预算是一亿美元。");
        assert_eq!(corrected, "建设预算是五亿美元。");
        assert_eq!(
            corrected_money_translation_for_playback(source, "建设预算是五亿美元。"),
            "建设预算是五亿美元。"
        );
    }

    #[test]
    fn planner_uses_corrected_money_text_for_native_playback() {
        let config = planner_test_config();
        let mut cue = planner_test_cue("cue-money", "建设预算是一亿美元。", true, true);
        cue.display_source_text = "Its construction budget is five hundred million dollars.".to_string();

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config, &HashSet::new());

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].translated_text, "建设预算是五亿美元。");
    }

    #[test]
    fn remember_committed_cue_played_evicts_oldest() {
        let mut committed_played = HashSet::new();
        let mut order = VecDeque::new();

        // Fill beyond MAX_PROCESSED_CUES to trigger eviction.
        for i in 0..=MAX_PROCESSED_CUES {
            remember_committed_cue_played(
                &format!("cue-{i}"),
                &mut committed_played,
                &mut order,
            );
        }

        // The oldest entry (cue-0) must have been evicted.
        assert!(!committed_played.contains("cue-0"));
        // The newest entry must still be present.
        assert!(committed_played.contains(&format!("cue-{}", MAX_PROCESSED_CUES)));
        // The deque never exceeds the cap.
        assert!(order.len() <= MAX_PROCESSED_CUES);
    }
}
