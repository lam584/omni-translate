use super::*;
use serde_json::json;

const MODEL: &str = "qwen3.5-livetranslate-flash-realtime";
const URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

fn update() -> Value {
    json!({
        "event_id": "evt-update",
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "sample_rate": 16000,
            "input_audio_format": "pcm",
            "turn_detection": {"type":"server_vad","threshold":0.0,"silence_duration_ms":400},
            "input_audio_transcription": {"model":"qwen3-asr-flash-realtime","language":"en"},
            "translation": {
                "language":"zh",
                "corpus": {"phrases": {
                    "Mars": "火星",
                    "artificial biosphere": "人工生物圈",
                    "light bulb": "灯泡",
                    "one billion": "十亿"
                }}
            }
        }
    })
}

fn finish() -> Value {
    json!({"event_id":"evt-finish","type":"session.finish"})
}

fn audio_append() -> Value {
    json!({"type":"input_audio_buffer.append","audio":"AAA="})
}

fn created() -> Value {
    json!({
        "type":"session.created", "event_id":"evt-created",
        "session":{"id":"session-1","object":"realtime.session","model":MODEL}
    })
}

fn updated() -> Value {
    let mut session = update()["session"].clone();
    session["id"] = json!("session-1");
    session["object"] = json!("realtime.session");
    session["model"] = json!(MODEL);
    json!({"type":"session.updated","event_id":"evt-updated","session":session})
}

#[test]
fn registry_authority_is_exact_enabled_livetranslate_only() {
    authorize_enabled_livetranslate(MODEL, URL).expect("enabled exact profile");
    for rejected in [
        "qwen3.5-livetranslate-flash-realtime-2026-05-19",
        "qwen3.5-omni-plus-realtime",
        "qwen3.5-livetranslate-flash-realtime-lookalike",
        "unknown",
    ] {
        assert!(authorize_enabled_livetranslate(rejected, URL).is_err(), "{rejected}");
    }
    assert!(authorize_enabled_livetranslate(
        MODEL,
        "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime"
    )
    .is_err());
}

#[test]
fn versioned_identity_tampering_keeps_connector_accept_count_zero() {
    let registry: Value = serde_json::from_str(REGISTRY).unwrap();
    let profile_index = registry["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .position(|profile| profile["profileId"] == PROFILE_ID)
        .unwrap();
    let dialect_index = registry["dialects"]
        .as_array()
        .unwrap()
        .iter()
        .position(|dialect| dialect["dialectId"] == LIVETRANSLATE_DIALECT)
        .unwrap();
    let mut mutations = Vec::new();
    for (pointer, value) in [
        ("/registryVersion", json!("bailian-model-protocol-registry/v2")),
        ("/profileId", json!("bailian.livetranslate.realtime.ws.v2")),
        ("/profileVersion", json!(2)),
        ("/adapterId", json!("diagnostic-unregistered-adapter")),
        ("/dialectVersion", json!(2)),
        ("/transport", json!("http")),
        ("/inputFraming", json!("binary")),
        ("/outputFraming", json!("json-events")),
        ("/terminalLifecycle", json!("owner-close")),
    ] {
        let mut mutated = registry.clone();
        match pointer {
            "/registryVersion" => mutated["registryVersion"] = value,
            "/profileId" => mutated["profiles"][profile_index]["profileId"] = value,
            "/profileVersion" => {
                mutated["profiles"][profile_index]["profileVersion"] = value
            }
            "/adapterId" => {
                mutated["profiles"][profile_index]["adapter"]["adapterId"] = value
            }
            other => mutated["dialects"][dialect_index][&other[1..]] = value,
        }
        mutations.push((pointer, mutated));
    }
    for (field, mutated) in mutations {
        let mut listener_accept_count = 0_u32;
        let preflight = preflight_from_registry(
            &mutated,
            MODEL,
            URL,
            update(),
            &audio_append(),
            finish(),
        );
        if preflight.is_ok() {
            listener_accept_count += 1;
        }
        assert!(preflight.is_err(), "tampered {field} must fail closed");
        assert_eq!(listener_accept_count, 0, "tampered {field} reached connect");
    }
}

#[test]
fn invalid_client_plan_keeps_connector_accept_count_zero() {
    let registry: Value = serde_json::from_str(REGISTRY).unwrap();
    let mut invalid_plans = Vec::new();
    let mut instructions = update();
    instructions["session"]["instructions"] = json!("Omni-only");
    invalid_plans.push(instructions);
    let mut response_create = update();
    response_create["type"] = json!("response.create");
    invalid_plans.push(response_create);
    let mut unknown = update();
    unknown["session"]["unknown"] = json!(true);
    invalid_plans.push(unknown);
    for corpus in [
        json!({"phrases": {}}),
        json!({"phrases": {" ": "火星"}}),
        json!({"phrases": {"Mars": " "}}),
        json!({"phrases": {"Mars": 1}}),
        json!({"phrases": {"Mars": "火星"}, "unknown": true}),
    ] {
        let mut invalid = update();
        invalid["session"]["translation"]["corpus"] = corpus;
        invalid_plans.push(invalid);
    }
    for invalid in invalid_plans {
        let mut listener_accept_count = 0_u32;
        let preflight = preflight_from_registry(
            &registry,
            MODEL,
            URL,
            invalid,
            &audio_append(),
            finish(),
        );
        if preflight.is_ok() {
            listener_accept_count += 1;
        }
        assert!(preflight.is_err());
        assert_eq!(listener_accept_count, 0);
    }
}

#[test]
fn handshake_requires_created_then_matching_typed_updated() {
    let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
    let request = update();
    let mut lifecycle = LiveTranslateLifecycle::new(authority.clone(), MODEL, &request).unwrap();
    assert_eq!(
        lifecycle.admit_server_event(&created()).unwrap(),
        ServerAction::SendSessionUpdate
    );
    assert_eq!(
        lifecycle.admit_server_event(&updated()).unwrap(),
        ServerAction::Ready
    );

    let mut wrong_order = LiveTranslateLifecycle::new(authority.clone(), MODEL, &request).unwrap();
    assert!(wrong_order.admit_server_event(&updated()).is_err());

    let mut wrong_session = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
    wrong_session.admit_server_event(&created()).unwrap();
    let mut event = updated();
    event["session"]["id"] = json!("session-other");
    assert!(wrong_session.admit_server_event(&event).is_err());
}

#[test]
fn terminal_lifecycle_allows_one_finish_and_requires_finished() {
    let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
    let request = update();
    let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
    lifecycle.admit_server_event(&created()).unwrap();
    lifecycle.admit_server_event(&updated()).unwrap();
    assert!(lifecycle.record_transport_closed().is_err());
    assert!(lifecycle
        .admit_server_event(&json!({"type":"session.finished","event_id":"evt-too-early"}))
        .is_err());
    lifecycle.record_finish_sent().unwrap();
    assert!(lifecycle.record_finish_sent().is_err());
    assert!(lifecycle
        .admit_server_event(&json!({
            "type":"error",
            "error":{"code":"invalid_request"}
        }))
        .is_err());
    assert!(lifecycle
        .admit_server_event(&json!({"type":"session.finished","event_id":"evt-empty-finished"}))
        .is_err());
    lifecycle
        .admit_server_event(&json!({
            "type":"response.created","event_id":"evt-response-created",
            "response":{"id":"response-1","object":"realtime.response","status":"in_progress"}
        }))
        .unwrap();
    lifecycle
        .admit_server_event(&json!({
            "type":"response.output_item.added","event_id":"evt-output-added",
            "response_id":"response-1","output_index":0,
            "item":{"id":"item-1","object":"realtime.item","type":"message","status":"in_progress","role":"assistant","content":[]}
        }))
        .unwrap();
    lifecycle
        .admit_server_event(&json!({
            "type":"response.text.done","event_id":"evt-text-done",
            "response_id":"response-1","item_id":"item-1",
            "output_index":0,"content_index":0,"text":"translated"
        }))
        .unwrap();
    lifecycle
        .admit_server_event(&json!({
            "type":"response.output_item.done","event_id":"evt-output-done",
            "response_id":"response-1","output_index":0,
            "item":{"id":"item-1","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[]}
        }))
        .unwrap();
    lifecycle
        .admit_server_event(&json!({
            "type":"response.done","event_id":"evt-response-done",
            "response":{
                "id":"response-1","object":"realtime.response","status":"completed",
                "modalities":["text"],
                "output":[{"id":"item-1","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[{"type":"text","text":"translated"}]}]
            }
        }))
        .unwrap();
    assert_eq!(
        lifecycle
            .admit_server_event(&json!({"type":"session.finished","event_id":"evt-finished"}))
            .unwrap(),
        ServerAction::Finished
    );
    lifecycle.record_transport_closed().unwrap();
}

#[test]
fn transcription_events_require_typed_item_content_language_and_emotion_ledger() {
    let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
    let request = update();
    let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
    lifecycle.admit_server_event(&created()).unwrap();
    lifecycle.admit_server_event(&updated()).unwrap();
    lifecycle.record_finish_sent().unwrap();

    assert!(lifecycle.admit_server_event(&json!({
        "type":"conversation.item.input_audio_transcription.completed",
        "event_id":"evt-transcription-before-item","item_id":"source-1",
        "content_index":0,"transcript":"source","language":"en","emotion":"neutral"
    })).is_err());
    lifecycle.admit_server_event(&json!({
        "type":"conversation.item.created","event_id":"evt-source-item",
        "previous_item_id":"previous-1",
        "item":{"id":"source-1","object":"realtime.item","type":"message","status":"in_progress","role":"user","content":[]}
    })).unwrap();
    assert!(lifecycle.admit_server_event(&json!({
        "type":"conversation.item.input_audio_transcription.text",
        "event_id":"evt-wrong-source-language","item_id":"source-1",
        "content_index":0,"text":"source","stash":"","language":"zh","emotion":"neutral"
    })).is_err());
    assert!(lifecycle.admit_server_event(&json!({
        "type":"conversation.item.input_audio_transcription.text",
        "event_id":"evt-wrong-emotion","item_id":"source-1",
        "content_index":0,"text":"source","stash":"","language":"en","emotion":"invented"
    })).is_err());
    lifecycle.admit_server_event(&json!({
        "type":"conversation.item.input_audio_transcription.text",
        "event_id":"evt-source-text","item_id":"source-1",
        "content_index":0,"text":"source","stash":"","language":"en","emotion":"neutral"
    })).unwrap();
    lifecycle.admit_server_event(&json!({
        "type":"conversation.item.input_audio_transcription.completed",
        "event_id":"evt-source-completed","item_id":"source-1",
        "content_index":0,"transcript":"source","language":"en","emotion":"neutral"
    })).unwrap();
    assert!(lifecycle.admit_server_event(&json!({
        "type":"conversation.item.input_audio_transcription.completed",
        "event_id":"evt-source-completed-twice","item_id":"source-1",
        "content_index":0,"transcript":"source","language":"en","emotion":"neutral"
    })).is_err());
}

#[test]
fn empty_terminal_transcription_metadata_is_unknown_but_still_typed() {
    let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
    let request = update();
    let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
    lifecycle.admit_server_event(&created()).unwrap();
    lifecycle.admit_server_event(&updated()).unwrap();
    lifecycle.record_finish_sent().unwrap();
    lifecycle
        .admit_server_event(&json!({
            "type":"conversation.item.created",
            "event_id":"evt-empty-source-item",
            "previous_item_id":"previous-1",
            "item":{
                "id":"source-empty",
                "object":"realtime.item",
                "type":"message",
                "status":"in_progress",
                "role":"user",
                "content":[]
            }
        }))
        .unwrap();
    lifecycle
        .admit_server_event(&json!({
            "type":"conversation.item.input_audio_transcription.completed",
            "event_id":"evt-empty-source-completed",
            "item_id":"source-empty",
            "content_index":0,
            "transcript":"",
            "language":"",
            "emotion":""
        }))
        .unwrap();

    lifecycle
        .admit_server_event(&json!({
            "type":"conversation.item.created",
            "event_id":"evt-missing-source-item",
            "previous_item_id":"source-empty",
            "item":{
                "id":"source-missing",
                "object":"realtime.item",
                "type":"message",
                "status":"in_progress",
                "role":"user",
                "content":[]
            }
        }))
        .unwrap();
    assert!(lifecycle
        .admit_server_event(&json!({
            "type":"conversation.item.input_audio_transcription.completed",
            "event_id":"evt-missing-source-completed",
            "item_id":"source-missing",
            "content_index":0,
            "transcript":"",
            "emotion":""
        }))
        .is_err());
}

#[test]
fn conversation_item_roles_match_the_livetranslate_server_contract() {
    for role in ["assistant", "user"] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created", "event_id":"evt-item",
                "previous_item_id":"previous-1",
                "item":{
                    "id":"item-1", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":role, "content":[]
                }
            }))
            .unwrap();
    }
}

#[test]
fn first_conversation_item_requires_root_proof_without_weakening_later_links() {
    for previous_item_id in [None, Some(Value::Null)] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"input_audio_buffer.speech_started",
                "event_id":"evt-speech-started",
                "item_id":"item-1",
                "audio_start_ms":0
            }))
            .unwrap();
        let mut first = json!({
            "type":"conversation.item.created", "event_id":"evt-first-item",
            "item":{
                "id":"item-1", "object":"realtime.item", "type":"message",
                "status":"in_progress", "role":"user", "content":[{"type":"input_audio"}]
            }
        });
        if let Some(previous_item_id) = previous_item_id {
            first["previous_item_id"] = previous_item_id;
        }
        lifecycle.admit_server_event(&first).unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created", "event_id":"evt-linked-item",
                "previous_item_id":"item-1",
                "item":{
                    "id":"item-2", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"user", "content":[{"type":"input_audio"}]
                }
            }))
            .unwrap();
        assert!(lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created", "event_id":"evt-unlinked-item",
                "item":{
                    "id":"item-3", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"assistant", "content":[]
                }
            }))
            .is_err());
    }

    for previous_item_id in [None, Some(Value::Null)] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        let mut unproven = json!({
            "type":"conversation.item.created", "event_id":"evt-unproven-item",
            "item":{
                "id":"item-1", "object":"realtime.item", "type":"message",
                "status":"in_progress", "role":"assistant", "content":[]
            }
        });
        if let Some(previous_item_id) = previous_item_id {
            unproven["previous_item_id"] = previous_item_id;
        }
        assert!(lifecycle.admit_server_event(&unproven).is_err());
    }

    for invalid_previous_item_id in [
        json!(""),
        json!(" "),
        json!(0),
        json!(true),
        json!({}),
        json!([]),
    ] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        assert!(lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created", "event_id":"evt-invalid-item",
                "previous_item_id":invalid_previous_item_id,
                "item":{
                    "id":"item-1", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"assistant", "content":[]
                }
            }))
            .is_err());
    }
}

#[test]
fn late_root_conversation_item_requires_vad_or_assistant_predecessor_proof() {
    for (proof, root_previous_item_id) in [
        ("vad", None),
        ("vad", Some(Value::Null)),
        ("assistant-predecessor", None),
        ("assistant-predecessor", Some(Value::Null)),
    ] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();

        if proof == "vad" {
            lifecycle
                .admit_server_event(&json!({
                    "type":"input_audio_buffer.speech_started",
                    "event_id":"evt-speech-started",
                    "item_id":"source-root",
                    "audio_start_ms":0
                }))
                .unwrap();
        }

        lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created",
                "event_id":"evt-assistant-item",
                "previous_item_id":if proof == "assistant-predecessor" {
                    "source-root"
                } else {
                    "earlier-item"
                },
                "item":{
                    "id":"translation-item", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"assistant", "content":[]
                }
            }))
            .unwrap();

        let mut root_item = json!({
            "type":"conversation.item.created",
            "event_id":"evt-root-item",
            "item":{
                "id":"source-root", "object":"realtime.item", "type":"message",
                "status":"in_progress", "role":"assistant", "content":[{"type":"input_audio"}]
            }
        });
        if let Some(previous_item_id) = root_previous_item_id {
            root_item["previous_item_id"] = previous_item_id;
        }
        lifecycle.admit_server_event(&root_item).unwrap();
    }

    for invalid_previous_item_id in [
        json!(""),
        json!(" "),
        json!(0),
        json!(true),
        json!({}),
        json!([]),
    ] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"input_audio_buffer.speech_started",
                "event_id":"evt-speech-started",
                "item_id":"source-root",
                "audio_start_ms":0
            }))
            .unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created",
                "event_id":"evt-assistant-item",
                "previous_item_id":"source-root",
                "item":{
                    "id":"translation-item", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"assistant", "content":[]
                }
            }))
            .unwrap();
        assert!(lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created",
                "event_id":"evt-invalid-root-item",
                "previous_item_id":invalid_previous_item_id,
                "item":{
                    "id":"source-root", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"user", "content":[{"type":"input_audio"}]
                }
            }))
            .is_err());
    }

    for (proof, previous_item_id) in [
        ("vad", None),
        ("vad", Some(Value::Null)),
        ("assistant-predecessor", None),
        ("assistant-predecessor", Some(Value::Null)),
    ] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        if proof == "vad" {
            lifecycle
                .admit_server_event(&json!({
                    "type":"input_audio_buffer.speech_started",
                    "event_id":"evt-assistant-proof-speech-started",
                    "item_id":"source-root",
                    "audio_start_ms":0
                }))
                .unwrap();
        } else {
            lifecycle
                .admit_server_event(&json!({
                    "type":"conversation.item.created",
                    "event_id":"evt-assistant-proof-translation",
                    "previous_item_id":"source-root",
                    "item":{
                        "id":"translation-item", "object":"realtime.item", "type":"message",
                        "status":"in_progress", "role":"assistant", "content":[]
                    }
                }))
                .unwrap();
        }
        let mut assistant_root = json!({
            "type":"conversation.item.created",
            "event_id":"evt-proven-assistant-root",
            "item":{
                "id":"source-root", "object":"realtime.item", "type":"message",
                "status":"in_progress", "role":"assistant", "content":[]
            }
        });
        if let Some(previous_item_id) = previous_item_id {
            assistant_root["previous_item_id"] = previous_item_id;
        }
        assert!(lifecycle.admit_server_event(&assistant_root).is_err());
    }
}

#[test]
fn assistant_predecessor_identity_preserves_whitespace_for_exact_matching() {
    for root_previous_item_id in [None, Some(Value::Null)] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created",
                "event_id":"evt-whitespace-assistant-item",
                "previous_item_id":" source-root ",
                "item":{
                    "id":"translation-item", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"assistant", "content":[]
                }
            }))
            .unwrap();
        let mut root_item = json!({
            "type":"conversation.item.created",
            "event_id":"evt-exact-root-item",
            "item":{
                "id":"source-root", "object":"realtime.item", "type":"message",
                "status":"in_progress", "role":"assistant", "content":[{"type":"input_audio"}]
            }
        });
        if let Some(previous_item_id) = root_previous_item_id {
            root_item["previous_item_id"] = previous_item_id;
        }
        assert!(lifecycle.admit_server_event(&root_item).is_err());
    }
}

#[test]
fn late_unproven_user_root_rejects_absent_or_null_previous_identity() {
    for root_previous_item_id in [None, Some(Value::Null)] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"conversation.item.created",
                "event_id":"evt-existing-assistant-item",
                "previous_item_id":"different-source",
                "item":{
                    "id":"translation-item", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"assistant", "content":[]
                }
            }))
            .unwrap();
        let mut root_item = json!({
            "type":"conversation.item.created",
            "event_id":"evt-unproven-user-root",
            "item":{
                "id":"source-root", "object":"realtime.item", "type":"message",
                "status":"in_progress", "role":"user", "content":[{"type":"input_audio"}]
            }
        });
        if let Some(previous_item_id) = root_previous_item_id {
            root_item["previous_item_id"] = previous_item_id;
        }
        assert!(lifecycle.admit_server_event(&root_item).is_err());
    }
}

#[test]
fn speech_stop_keeps_the_vad_root_identity_for_a_late_source_item() {
    for root_previous_item_id in [None, Some(Value::Null)] {
        let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
        let request = update();
        let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
        lifecycle.admit_server_event(&created()).unwrap();
        lifecycle.admit_server_event(&updated()).unwrap();
        lifecycle.record_finish_sent().unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"input_audio_buffer.speech_started",
                "event_id":"evt-speech-started",
                "item_id":"source-root",
                "audio_start_ms":10
            }))
            .unwrap();
        lifecycle
            .admit_server_event(&json!({
                "type":"input_audio_buffer.speech_stopped",
                "event_id":"evt-speech-stopped",
                "item_id":"source-root",
                "audio_end_ms":20
            }))
            .unwrap();
        let mut root_item = json!({
            "type":"conversation.item.created",
            "event_id":"evt-late-source-root",
            "item":{
                "id":"source-root", "object":"realtime.item", "type":"message",
                "status":"in_progress", "role":"assistant", "content":[{"type":"input_audio"}]
            }
        });
        if let Some(previous_item_id) = root_previous_item_id {
            root_item["previous_item_id"] = previous_item_id;
        }
        lifecycle.admit_server_event(&root_item).unwrap();
    }
}

#[test]
fn speech_stop_requires_a_matching_start_and_non_decreasing_timestamp() {
    let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
    let request = update();
    let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
    lifecycle.admit_server_event(&created()).unwrap();
    lifecycle.admit_server_event(&updated()).unwrap();
    lifecycle.record_finish_sent().unwrap();
    assert!(lifecycle
        .admit_server_event(&json!({
            "type":"input_audio_buffer.speech_stopped",
            "event_id":"evt-orphan-speech-stopped",
            "item_id":"source-root",
            "audio_end_ms":20
        }))
        .is_err());

    let authority = authorize_enabled_livetranslate(MODEL, URL).unwrap();
    let request = update();
    let mut lifecycle = LiveTranslateLifecycle::new(authority, MODEL, &request).unwrap();
    lifecycle.admit_server_event(&created()).unwrap();
    lifecycle.admit_server_event(&updated()).unwrap();
    lifecycle.record_finish_sent().unwrap();
    lifecycle
        .admit_server_event(&json!({
            "type":"input_audio_buffer.speech_started",
            "event_id":"evt-speech-started",
            "item_id":"source-root",
            "audio_start_ms":20
        }))
        .unwrap();
    assert!(lifecycle
        .admit_server_event(&json!({
            "type":"input_audio_buffer.speech_stopped",
            "event_id":"evt-backward-speech-stopped",
            "item_id":"source-root",
            "audio_end_ms":10
        }))
        .is_err());
}
