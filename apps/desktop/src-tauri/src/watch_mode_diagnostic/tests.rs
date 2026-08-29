use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use uuid::Uuid;

use super::config::{
    configure_watch_mode, configure_watch_realtime_provider,
    configure_watch_realtime_provider_with_environment,
};
use super::{
    bounded_autostart_capture_duration_ms, build_debug_ipc_ping_response,
    parse_feedback_loop_prevention, should_run_idle_overlay_prewarm,
    wait_for_frontend_ipc_ready, write_report_atomic,
};
use crate::audio::state::AudioStateStore;
use crate::audio::state::TranslationPlaybackQuiescenceSnapshot;

fn strict_watch_environment(name: &str) -> Option<String> {
    match name {
        "OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY" => Some("1".to_string()),
        "OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID" => Some("provider-dashscope".to_string()),
        _ => None,
    }
}

fn default_watch_config() -> Value {
    serde_json::from_str(include_str!("../../defaults/app-config.default.json"))
        .expect("default Watch config should be valid JSON")
}

#[test]
fn ipc_ping_exposes_runtime_diagnostic_authority_without_changing_legacy_prefix() {
    let diagnostic = build_debug_ipc_ping_response("ready", 12, true);
    assert!(diagnostic.starts_with("pong storage_status=ready elapsed_ms=12"));
    assert!(diagnostic.contains("watchDiagnostic=true"));
    assert!(diagnostic.contains("backendAutostartAuthoritative=true"));

    let ordinary = build_debug_ipc_ping_response("ready", 7, false);
    assert!(ordinary.contains("watchDiagnostic=false"));
    assert!(ordinary.contains("backendAutostartAuthoritative=false"));
}

#[test]
fn diagnostic_route_is_the_only_overlay_creator_during_autostart() {
    assert!(!should_run_idle_overlay_prewarm(true));
    assert!(should_run_idle_overlay_prewarm(false));
}

#[test]
fn diagnostic_capture_duration_keeps_full_benchmark_time_and_a_hard_bound() {
    assert_eq!(bounded_autostart_capture_duration_ms(500), 1_000);
    assert_eq!(bounded_autostart_capture_duration_ms(180_000), 180_000);
    assert_eq!(bounded_autostart_capture_duration_ms(1_800_000), 1_800_000);
    assert_eq!(bounded_autostart_capture_duration_ms(7_200_001), 7_200_000);
}

#[test]
fn diagnostic_feedback_mode_accepts_all_three_routes_and_rejects_typos() {
    assert_eq!(
        parse_feedback_loop_prevention(Some("process-exclusion")).unwrap(),
        "process-exclusion"
    );
    assert_eq!(
        parse_feedback_loop_prevention(Some("VIRTUAL-DRIVER")).unwrap(),
        "virtual-driver"
    );
    assert_eq!(
        parse_feedback_loop_prevention(Some("echo-cancel")).unwrap(),
        "echo-cancel"
    );
    assert_eq!(
        parse_feedback_loop_prevention(None).unwrap(),
        "virtual-driver"
    );
    assert!(parse_feedback_loop_prevention(Some("process-loopback"))
        .unwrap_err()
        .contains("Unsupported"));
}

#[test]
fn midpoint_restart_requires_every_translated_playback_owner_to_be_idle() {
    let idle = TranslationPlaybackQuiescenceSnapshot::default();
    assert!(super::process_exclusion_restart_is_quiescent(false, idle));
    assert!(!super::process_exclusion_restart_is_quiescent(true, idle));

    for busy in [
        TranslationPlaybackQuiescenceSnapshot {
            pending_native_audio: true,
            ..idle
        },
        TranslationPlaybackQuiescenceSnapshot {
            queued_commands: 1,
            ..idle
        },
        TranslationPlaybackQuiescenceSnapshot {
            active_commands: 1,
            ..idle
        },
        TranslationPlaybackQuiescenceSnapshot {
            pending_bridge_acks: 1,
            ..idle
        },
        TranslationPlaybackQuiescenceSnapshot {
            active_bridge_cues: 1,
            ..idle
        },
        TranslationPlaybackQuiescenceSnapshot {
            restart_barrier: true,
            ..idle
        },
    ] {
        assert!(!super::process_exclusion_restart_is_quiescent(false, busy));
    }
}

#[test]
fn echo_cancel_speech_model_diagnostic_replays_native_audio_on_default_output() {
    let mut config = json!({
        "devices": {
            "outputDeviceId": "stale-device-id",
            "inboundRoute": {
                "input": { "deviceId": "stale-capture-device-id" }
            },
            "subtitleTranslationMode": "secondary",
            "subtitleTranslationModelId": "stale-text-model",
            "inboundSecondaryAudioModelId": "stale-audio-model"
        },
        "speech": {
            "translationAudioSource": "subtitle-tts"
        }
    });

    configure_watch_mode(
        &mut config,
        "",
        50,
        "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
        "native",
        "",
        "",
        "omni-native",
        "echo-cancel",
    );

    assert_eq!(config["devices"]["subtitleTranslationMode"], "native");
    assert_eq!(config["devices"]["subtitleTranslationModelId"], "");
    assert_eq!(config["devices"]["inboundSecondaryAudioModelId"], "");
    assert_eq!(
        config["devices"]["textToSpeechModelId"],
        "template-dashscope-realtime::qwen3.5-omni-plus-realtime"
    );
    assert_eq!(config["speech"]["translationAudioSource"], "omni-native");
    assert_eq!(config["devices"]["outputDeviceId"], "default");
    assert_eq!(
        config["devices"]["inboundRoute"]["input"]["deviceId"],
        "default"
    );
    assert_eq!(config["devices"]["outputSpeechEnabled"], true);
    assert_eq!(config["speech"]["localPlaybackEnabled"], true);
    assert_eq!(
        config["devices"]["inboundRoute"]["mixControl"]["translatedAudioEnabled"],
        true
    );
    assert_eq!(
        config["devices"]["inboundRoute"]["mixControl"]["keepOriginalAudio"],
        true
    );
}

#[test]
fn virtual_driver_native_diagnostic_routes_translation_through_bridge() {
    let mut config = json!({
        "devices": {
            "inboundRoute": {
                "input": { "deviceId": "persisted-physical-device" }
            }
        }
    });

    configure_watch_mode(
        &mut config,
        "",
        50,
        "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
        "native",
        "",
        "",
        "omni-native",
        "virtual-driver",
    );

    assert_eq!(config["devices"]["outputDeviceId"], "default");
    assert_eq!(config["devices"]["feedbackLoopPrevention"], "virtual-driver");
    assert_eq!(
        config["devices"]["inboundRoute"]["input"]["deviceId"],
        "persisted-physical-device"
    );
    assert_eq!(config["devices"]["subtitleTranslationMode"], "native");
    assert_eq!(config["devices"]["subtitleTranslationModelId"], "");
    assert_eq!(config["devices"]["inboundSecondaryAudioModelId"], "");
    assert_eq!(
        config["devices"]["textToSpeechModelId"],
        "template-dashscope-realtime::qwen3.5-omni-plus-realtime"
    );
    assert_eq!(config["speech"]["translationAudioSource"], "omni-native");
    assert_eq!(config["devices"]["outputSpeechEnabled"], true);
    assert_eq!(config["speech"]["localPlaybackEnabled"], true);
    assert!(crate::audio::speech::bridge_translation_playback_enabled_for_config(
        &config
    ));
    assert!(!crate::audio::speech::desktop_direct_playback_enabled_for_config(
        &config
    ));
    assert_eq!(
        config["devices"]["inboundRoute"]["mixControl"]["translatedAudioEnabled"],
        true
    );
}

#[test]
fn process_exclusion_native_diagnostic_routes_translation_through_bridge() {
    let mut config = json!({});

    configure_watch_mode(
        &mut config,
        "",
        50,
        "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
        "native",
        "",
        "",
        "omni-native",
        "process-exclusion",
    );

    assert_eq!(config["devices"]["feedbackLoopPrevention"], "process-exclusion");
    assert_eq!(config["devices"]["outputSpeechEnabled"], true);
    assert_eq!(config["speech"]["localPlaybackEnabled"], true);
    assert_eq!(
        config["devices"]["inboundRoute"]["mixControl"]["translatedAudioEnabled"],
        true
    );
}

#[test]
fn secondary_diagnostic_keeps_explicit_text_and_audio_models() {
    let mut config = json!({});

    configure_watch_mode(
        &mut config,
        "",
        50,
        "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
        "secondary",
        "template-text::qwen-text",
        "template-audio::qwen-audio",
        "subtitle-tts",
        "virtual-driver",
    );

    assert_eq!(config["devices"]["subtitleTranslationMode"], "secondary");
    assert_eq!(
        config["devices"]["subtitleTranslationModelId"],
        "template-text::qwen-text"
    );
    assert_eq!(
        config["devices"]["inboundSecondaryAudioModelId"],
        "template-audio::qwen-audio"
    );
    assert_eq!(
        config["devices"]["textToSpeechModelId"],
        "template-audio::qwen-audio"
    );
    assert_eq!(config["speech"]["translationAudioSource"], "subtitle-tts");
    assert_eq!(config["devices"]["outputSpeechEnabled"], true);
    assert_eq!(config["speech"]["localPlaybackEnabled"], true);
}

#[test]
fn diagnostic_report_writer_replaces_the_target_with_complete_json() {
    let state = AudioStateStore::new();
    state
        .watch_session_report
        .begin_or_reuse("provider-test", "model-test");
    state.watch_session_report.complete();
    let report = state
        .watch_session_report
        .snapshot()
        .expect("report should exist");
    let directory = std::env::temp_dir().join(format!(
        "omni-watch-report-writer-{}",
        Uuid::new_v4().simple()
    ));
    let path = directory.join("watch-session-report.json");
    std::fs::create_dir_all(&directory).expect("temporary directory should be created");
    std::fs::write(&path, b"stale").expect("stale target should be created");

    write_report_atomic(path.to_string_lossy().as_ref(), &report)
        .expect("report should be written");

    let value: Value = serde_json::from_slice(
        &std::fs::read(&path).expect("written report should be readable"),
    )
    .expect("written report should be valid JSON");
    assert_eq!(value["status"], "completed");
    assert_eq!(value["providerId"], "provider-test");
    let temporary_files = std::fs::read_dir(&directory)
        .expect("temporary directory should be readable")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(temporary_files, 0);

    std::fs::remove_dir_all(directory).expect("temporary directory should be removed");
}

#[test]
fn explicit_dashscope_protocol_binds_model_to_dashscope_provider() {
    let model = "qwen3.5-omni-plus-realtime";
    let mut config = json!({
        "providers": [
            {
                "templateId": "template-openai-compatible",
                "kind": "openai-compatible",
                "model": model
            },
            {
                "templateId": "template-dashscope-realtime",
                "kind": "dashscope",
                "model": "qwen-plus",
                "localModelCapabilityRegistry": []
            }
        ]
    });

    let effective = configure_watch_realtime_provider(&mut config, model, "dashscope-omni")
        .expect("DashScope provider should be selected");

    assert_eq!(
        effective,
        "template-dashscope-realtime::qwen3.5-omni-plus-realtime"
    );
    assert_eq!(config["providers"][0]["kind"], "openai-compatible");
    assert_eq!(config["providers"][1]["model"], model);
    assert_eq!(
        config["providers"][1]["localModelCapabilityRegistry"][0]["realtimeProtocol"],
        "dashscope-omni"
    );
    assert_eq!(
        config["providers"][1]["localModelCapabilityRegistry"][0]
            ["interactionCapabilities"],
        json!(["streaming", "auto_vad", "manual_commit"])
    );
}

#[test]
fn strict_paid_provider_selection_cannot_be_hijacked_by_an_earlier_dashscope_provider() {
    let mut config = default_watch_config();
    let exact = config["providers"][0].clone();
    let mut alternate = exact.clone();
    alternate["providerId"] = json!("provider-dashscope-alternate");
    alternate["displayName"] = json!("alternate DashScope provider");
    alternate["model"] = json!("alternate-stale-model");
    config["providers"] = json!([alternate, exact]);

    let effective = configure_watch_realtime_provider_with_environment(
        &mut config,
        "qwen3.5-omni-flash-realtime",
        "dashscope-omni",
        strict_watch_environment,
    )
    .expect("strict provider authority should select the exact provider id");

    assert_eq!(
        effective,
        "template-dashscope-realtime::qwen3.5-omni-flash-realtime"
    );
    assert_eq!(config["providers"][0]["providerId"], "provider-dashscope");
    assert_eq!(
        config["providers"][0]["model"],
        "qwen3.5-omni-flash-realtime"
    );
    assert_eq!(
        config["providers"][0]["realtimeProtocol"],
        "dashscope-omni"
    );
    assert_eq!(
        config["providers"][1]["providerId"],
        "provider-dashscope-alternate"
    );
    assert_eq!(config["providers"][1]["model"], "alternate-stale-model");

    let resolved = crate::audio::events::resolve_model_provider_from_config_value(
        &config,
        &effective,
    )
    .expect("downstream route resolution should preserve the authorized provider");
    assert_eq!(resolved.provider_id, "provider-dashscope");
    assert_eq!(resolved.model, "qwen3.5-omni-flash-realtime");
}

#[test]
fn strict_paid_provider_selection_fails_when_the_expected_provider_is_missing() {
    let mut config = default_watch_config();
    config["providers"][0]["providerId"] = json!("provider-dashscope-alternate");
    let before = config.clone();

    let error = configure_watch_realtime_provider_with_environment(
        &mut config,
        "qwen3.5-omni-flash-realtime",
        "dashscope-omni",
        strict_watch_environment,
    )
    .expect_err("strict provider authority must fail before selecting an alternate provider");

    assert!(error.contains("providerId 'provider-dashscope' is missing before provider connect"));
    assert_eq!(config, before);
}

#[test]
fn strict_paid_provider_selection_requires_the_fixed_expected_provider_input() {
    for (expected_provider_id, expected_error) in [
        (
            None,
            "requires OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID before provider connect",
        ),
        (
            Some("provider-dashscope-alternate"),
            "requires OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID=provider-dashscope",
        ),
    ] {
        let mut config = default_watch_config();
        let before = config.clone();

        let error = configure_watch_realtime_provider_with_environment(
            &mut config,
            "qwen3.5-omni-flash-realtime",
            "dashscope-omni",
            |name| match name {
                "OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY" => Some("1".to_string()),
                "OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID" => {
                    expected_provider_id.map(str::to_string)
                }
                _ => None,
            },
        )
        .expect_err("strict provider authority must require the fixed expected provider input");

        assert!(error.contains(expected_error), "unexpected error: {error}");
        assert_eq!(config, before);
    }
}

#[test]
fn strict_paid_provider_selection_rejects_kind_and_template_mismatches() {
    for (field, wrong_value, expected_error) in [
        (
            "kind",
            "openai-compatible",
            "provider kind mismatch for provider-dashscope",
        ),
        (
            "templateId",
            "template-dashscope-alternate",
            "provider templateId mismatch for provider-dashscope",
        ),
    ] {
        let mut config = default_watch_config();
        config["providers"][0][field] = json!(wrong_value);
        let before = config.clone();

        let error = configure_watch_realtime_provider_with_environment(
            &mut config,
            "qwen3.5-omni-flash-realtime",
            "dashscope-omni",
            strict_watch_environment,
        )
        .expect_err("strict provider authority must reject identity metadata mismatches");

        assert!(error.contains(expected_error), "unexpected error: {error}");
        assert_eq!(config, before);
    }
}

#[test]
fn non_strict_provider_selection_keeps_legacy_first_compatible_behavior() {
    let mut config = default_watch_config();
    let exact = config["providers"][0].clone();
    let mut alternate = exact.clone();
    alternate["providerId"] = json!("provider-dashscope-alternate");
    alternate["model"] = json!("alternate-stale-model");
    config["providers"] = json!([alternate, exact]);

    let effective = configure_watch_realtime_provider_with_environment(
        &mut config,
        "qwen3.5-omni-flash-realtime",
        "dashscope-omni",
        |_| None,
    )
    .expect("ordinary diagnostics should retain compatibility selection");

    assert_eq!(
        effective,
        "template-dashscope-realtime::qwen3.5-omni-flash-realtime"
    );
    assert_eq!(
        config["providers"][0]["providerId"],
        "provider-dashscope-alternate"
    );
    assert_eq!(
        config["providers"][0]["model"],
        "qwen3.5-omni-flash-realtime"
    );
    assert_eq!(config["providers"][1]["providerId"], "provider-dashscope");
}

#[test]
fn explicit_protocol_fails_when_matching_provider_is_missing() {
    let mut config = json!({
        "providers": [{
            "templateId": "template-openai-compatible",
            "kind": "openai-compatible",
            "model": "gpt-realtime"
        }]
    });

    let error = configure_watch_realtime_provider(
        &mut config,
        "qwen3.5-omni-plus-realtime",
        "dashscope-omni",
    )
    .expect_err("missing DashScope provider should fail autostart config");

    assert!(error.contains("No provider can host Watch realtime protocol"));
}

#[test]
fn diagnostic_ipc_gate_releases_after_readiness_signal() {
    let checks = AtomicUsize::new(0);

    let ready = tauri::async_runtime::block_on(wait_for_frontend_ipc_ready(
        Duration::from_millis(100),
        Duration::from_millis(1),
        || checks.fetch_add(1, Ordering::AcqRel) >= 2,
    ));

    assert!(ready);
    assert!(checks.load(Ordering::Acquire) >= 3);
}

#[test]
fn diagnostic_ipc_gate_times_out_without_readiness_signal() {
    let started = Instant::now();

    let ready = tauri::async_runtime::block_on(wait_for_frontend_ipc_ready(
        Duration::from_millis(12),
        Duration::from_millis(2),
        || false,
    ));

    assert!(!ready);
    assert!(started.elapsed() >= Duration::from_millis(10));
    assert!(started.elapsed() < Duration::from_secs(1));
}
