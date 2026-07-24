use std::collections::{hash_map::DefaultHasher, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use rodio::{buffer::SamplesBuffer, DeviceSinkBuilder, Player};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::bridge::ipc::BridgeAudioWriter;
use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway::ProviderGateway;
use crate::storage::StorageStateStore;

use super::contracts::{AudioRuntimeSnapshot, SpeechDispatchEventRuntime, SubtitleCueRuntime};
use super::engine::emit_audio_snapshot;
use super::state::{AudioRouteHandle, AudioStateStore, CachedTtsAudio, CapturedSegmentAudio};

const SPEECH_POLL_INTERVAL_MS: u64 = 120;
const SPEECH_DISPATCH_IDLE_INTERVAL_MS: u64 = 40;
const MAX_PROCESSED_CUES: usize = 32;
const PROMPT_TONE_MS: u32 = 90;

mod playback_engine;

use self::playback_engine::SpeechPlaybackEngine;

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

pub fn start_dispatch(
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
    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "已启动 speech dispatch worker。",
        None,
        None,
        None,
    );
    emit_audio_snapshot(&app, store)?;

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
        .map_err(|error| error.to_string())?;

    store.insert_session(
        "speech",
        AudioRouteHandle {
            stop_tx,
            join_handle,
        },
    );
    Ok(store.snapshot())
}

pub fn stop_dispatch(
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

    fn provider_input() -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: "template".to_string(),
            provider_id: "provider".to_string(),
            kind: "openai-compatible".to_string(),
            display_name: "Provider".to_string(),
            model: "tts-model".to_string(),
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
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    #[test]
    fn build_mix_plan_adds_prompt_and_original_audio() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-outbound-1".to_string(),
            route_direction: "outbound".to_string(),
            source_text: "source".to_string(),
            display_source_text: String::new(),
            display_segments: vec![],
            translated_text: "translated".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: true,
        };
        let config = SpeechConfig {
            provider: provider_input(),
            enabled: true,
            target_language: "zh-CN".to_string(),
            voice_preset_id: "voice-cn-neutral".to_string(),
            voice: "Ethan".to_string(),
            output_target: "both".to_string(),
            local_playback_enabled: true,
            virtual_mic_output_enabled: true,
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
                original_audio_gain_db: 0.0,
                ducking_enabled: false,
                ducking_depth_percent: 0,
            },
            outbound_mix: RouteMixConfig {
                keep_original_audio: true,
                translated_audio_enabled: true,
                translated_audio_gain_db: 0.0,
                original_audio_gain_db: 0.0,
                ducking_enabled: true,
                ducking_depth_percent: 30,
            },
            secondary_segment_tts_enabled: false,
        };
        let captured = CapturedSegmentAudio {
            cue_id: cue.cue_id.clone(),
            route_direction: cue.route_direction.clone(),
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
    fn virtual_driver_feedback_prevention_disables_local_playback() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(!desktop_direct_playback_enabled_for_config(&config));
    }

    #[test]
    fn virtual_driver_feedback_prevention_keeps_explicit_physical_output() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver",
                "outputDeviceId": "耳机 (iBasso-DC-Series)"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(desktop_direct_playback_enabled_for_config(&config));
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
            route_direction: "inbound".to_string(),
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
    fn speech_ready_accepts_final_secondary_translation_before_cue_commit() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-1".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: vec![SubtitleDisplaySegmentRuntime {
                source_text: "hello".to_string(),
                translated_text: "你好。".to_string(),
                pending: false,
            }],
            translated_text: "你好。".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };

        assert!(is_speech_ready_cue(&cue));
    }

    #[test]
    fn speech_ready_ignores_pending_secondary_translation() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-1".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: vec![SubtitleDisplaySegmentRuntime {
                source_text: "hello".to_string(),
                translated_text: "你".to_string(),
                pending: true,
            }],
            translated_text: "你".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };

        assert!(!is_speech_ready_cue(&cue));
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
        let cue = SubtitleCueRuntime {
            cue_id: "cue-native".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: vec![SubtitleDisplaySegmentRuntime {
                source_text: "hello".to_string(),
                translated_text: "你好。".to_string(),
                pending: false,
            }],
            translated_text: "你好。".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: true,
        };

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config);

        assert_eq!(tasks.len(), 1);
        assert!(!tasks[0].segment_mode);
        assert_eq!(tasks[0].translated_text, "你好。");
    }

    #[test]
    fn secondary_route_dispatches_only_final_display_segments() {
        let config = SpeechConfig::from_value(&json!({
            "speech": {
                "translationAudioSource": "subtitle-tts"
            },
            "devices": {
                "subtitleTranslationMode": "secondary",
                "subtitleTranslationModelId": "template::text-model",
                "outputSpeechEnabled": true
            }
        }))
        .unwrap();
        let cue = SubtitleCueRuntime {
            cue_id: "cue-secondary".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello then wait".to_string(),
            display_source_text: "hello\nthen wait".to_string(),
            display_segments: vec![
                SubtitleDisplaySegmentRuntime {
                    source_text: "hello".to_string(),
                    translated_text: "你好。".to_string(),
                    pending: false,
                },
                SubtitleDisplaySegmentRuntime {
                    source_text: "then wait".to_string(),
                    translated_text: "然后等等".to_string(),
                    pending: true,
                },
            ],
            translated_text: "你好。\n然后等等".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config);

        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].segment_mode);
        assert_eq!(tasks[0].segment_index, 0);
        assert_eq!(tasks[0].translated_text, "你好。");
    }

    #[test]
    fn secondary_route_splits_multiline_translation_into_tts_tasks() {
        let config = SpeechConfig::from_value(&json!({
            "speech": {
                "translationAudioSource": "subtitle-tts"
            },
            "devices": {
                "subtitleTranslationMode": "secondary",
                "subtitleTranslationModelId": "template::text-model",
                "outputSpeechEnabled": true
            }
        }))
        .unwrap();
        let cue = SubtitleCueRuntime {
            cue_id: "cue-secondary".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "rocket and future then pending".to_string(),
            display_source_text: "rocket and future\nthen pending".to_string(),
            display_segments: vec![
                SubtitleDisplaySegmentRuntime {
                    source_text: "rocket and future".to_string(),
                    translated_text: "现在你看到的这艘火箭造价十亿美元\n这项未来科技有朝一日将会带你远赴火星".to_string(),
                    pending: false,
                },
                SubtitleDisplaySegmentRuntime {
                    source_text: "then pending".to_string(),
                    translated_text: "还在等待".to_string(),
                    pending: true,
                },
            ],
            translated_text: "现在你看到的这艘火箭造价十亿美元\n这项未来科技有朝一日将会带你远赴火星\n还在等待".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config);

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
        let cue = SubtitleCueRuntime {
            cue_id: "cue-secondary".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: Vec::new(),
            translated_text: "hello translated".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };
        let first = SpeechDispatchTask {
            cue: cue.clone(),
            segment_index: 0,
            source_text: "hello".to_string(),
            translated_text: "hello translated".to_string(),
            segment_mode: true,
        };
        let replacement = SpeechDispatchTask {
            cue,
            segment_index: 0,
            source_text: "hello there".to_string(),
            translated_text: "hello there translated".to_string(),
            segment_mode: true,
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
    fn speech_config_uses_subtitle_priority_to_compute_dispatch_delay() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [{
            "templateId": "template",
            "providerId": "provider",
            "kind": "openai-compatible",
            "displayName": "Provider",
            "model": "tts-model",
            "baseUrl": "http://127.0.0.1:1",
            "transport": "http",
            "authRef": {
              "kind": "credential-ref",
              "reference": "none",
              "headerName": "Authorization",
              "scheme": "none"
            },
            "region": null,
            "streamEnabled": false,
            "timeoutMs": 1000,
            "systemPromptTemplate": "video-realtime-cn"
          }],
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
    fn speech_config_prefers_explicit_text_to_speech_model() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [{
            "templateId": "template-main",
            "providerId": "provider-main",
            "kind": "openai-compatible",
            "displayName": "Main Provider",
            "model": "main-model",
            "baseUrl": "http://main.test",
            "transport": "http",
            "authRef": {
              "kind": "credential-ref",
              "reference": "none",
              "headerName": "Authorization",
              "scheme": "none"
            },
            "region": null,
            "streamEnabled": false,
            "timeoutMs": 1000,
            "systemPromptTemplate": "video-realtime-cn"
          },
          {
            "templateId": "template-linked",
            "providerId": "provider-linked",
            "kind": "dashscope",
            "displayName": "Linked Provider",
            "model": "linked-default",
            "baseUrl": "http://linked.test",
            "transport": "websocket",
            "authRef": {
              "kind": "credential-ref",
              "reference": "none",
              "headerName": "Authorization",
              "scheme": "none"
            },
            "region": null,
            "streamEnabled": false,
            "timeoutMs": 1000,
            "systemPromptTemplate": "video-realtime-cn"
          }],
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
        }))
        .expect("speech config should parse");

        assert_eq!(config.provider.provider_id, "provider-linked");
        assert_eq!(config.provider.model, "tts-model");
    }

    #[test]
    fn secondary_tts_prefers_inbound_secondary_audio_model() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [
            {
              "templateId": "template-default",
              "providerId": "provider-default",
              "kind": "openai-compatible",
              "displayName": "Default Provider",
              "model": "default-model",
              "baseUrl": "http://default.test",
              "transport": "http",
              "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
              "region": null,
              "streamEnabled": false,
              "timeoutMs": 1000,
              "systemPromptTemplate": "video-realtime-cn"
            },
            {
              "templateId": "template-secondary",
              "providerId": "provider-secondary",
              "kind": "dashscope",
              "displayName": "Secondary Provider",
              "model": "old-model",
              "baseUrl": "http://secondary.test",
              "transport": "websocket",
              "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
              "region": null,
              "streamEnabled": false,
              "timeoutMs": 1000,
              "systemPromptTemplate": "video-realtime-cn"
            }
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
        }))
        .expect("speech config should parse");

        assert!(config.secondary_segment_tts_enabled);
        assert_eq!(config.provider.provider_id, "provider-secondary");
        assert_eq!(config.provider.model, "secondary-tts");
    }

    #[test]
    fn secondary_tts_skips_livetranslate_and_uses_bare_tts_model() {
        let config = SpeechConfig::from_value(&json!({
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
        }))
        .expect("speech config should parse");

        assert!(config.secondary_segment_tts_enabled);
        assert_eq!(config.provider.provider_id, "provider-dashscope");
        assert_eq!(config.provider.model, "qwen3.5-omni-plus-realtime");
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
    fn resolve_model_provider_composite_id_matches_linked_by_template() {
        let config = json!({
            "providers": [
                {
                    "templateId": "template-main", "providerId": "provider-main",
                    "kind": "openai-compatible", "displayName": "Main",
                    "model": "main-model", "baseUrl": "http://main.test",
                    "transport": "http",
                    "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                    "region": null, "streamEnabled": false, "timeoutMs": 1000,
                    "systemPromptTemplate": "video-realtime-cn"
                },
                {
                    "templateId": "template-linked", "providerId": "provider-linked",
                    "kind": "dashscope", "displayName": "Linked",
                    "model": "linked-default", "baseUrl": "http://linked.test",
                    "transport": "websocket",
                    "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                    "region": null, "streamEnabled": false, "timeoutMs": 1000,
                    "systemPromptTemplate": "video-realtime-cn"
                }
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
            "providers": [{
                "templateId": "template-main", "providerId": "provider-main",
                "kind": "openai-compatible", "displayName": "Main",
                "model": "main-model", "baseUrl": "http://main.test",
                "transport": "http",
                "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                "region": null, "streamEnabled": false, "timeoutMs": 1000,
                "systemPromptTemplate": "video-realtime-cn"
            }]
        });
        assert!(resolve_model_provider_from_config_value(&config, "unknown-model").is_none());
    }

    #[test]
    fn resolve_model_provider_returns_none_for_unknown_composite_template() {
        let config = json!({
            "providers": [{
                "templateId": "template-main", "providerId": "provider-main",
                "kind": "openai-compatible", "displayName": "Main",
                "model": "main-model", "baseUrl": "http://main.test",
                "transport": "http",
                "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                "region": null, "streamEnabled": false, "timeoutMs": 1000,
                "systemPromptTemplate": "video-realtime-cn"
            }]
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
            "providers": [{
                "templateId": "template-main", "providerId": "provider-main",
                "kind": "openai-compatible", "displayName": "Main",
                "model": "main-model", "baseUrl": "http://main.test",
                "transport": "http",
                "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                "region": null, "streamEnabled": false, "timeoutMs": 1000,
                "systemPromptTemplate": "video-realtime-cn"
            }]
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
}
