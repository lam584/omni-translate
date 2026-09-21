use super::*;
use serde_json::json;

fn authority() -> AuthorizedModelProtocolProfile {
    use crate::provider::model_protocol_profile::*;
    authorize_model_protocol_invocation(ModelProtocolAuthorizationRequest {
        exact_model_id: "qwen3.8-livetranslate-flash-realtime",
        operation: "native_translate", transport: "websocket", region: "cn-beijing",
        endpoint_host: "workspace-test.cn-beijing.maas.aliyuncs.com",
        audio_input: Some(ModelProtocolRequestedAudio { codec: "pcm16", sample_rate_hz: 16_000, channels: 1 }),
        audio_output: Some(ModelProtocolRequestedAudio { codec: "pcm16", sample_rate_hz: 24_000, channels: 1 }),
        declared_registry_version: None, declared_profile_id: None, declared_profile_version: None,
        declared_wire_dialect: None, declared_endpoint_family: None, declared_terminal_lifecycle: None,
    }).expect("3.8 manifest must enable the independently implemented v2 adapter")
}

fn admit(state: &mut LiveTranslateServerState, authority: &AuthorizedModelProtocolProfile, mut event: Value) -> Result<LiveTranslateServerMutation, String> {
    event["event_id"] = json!(format!("event-{}", state.seen_event_ids.len()));
    state.admit(authority, &event)
}

fn active(authority: &AuthorizedModelProtocolProfile) -> LiveTranslateServerState {
    let mut state = LiveTranslateServerState::default();
    let update = json!({"type":"session.update","session":{
        "output_modalities":["text","audio"], "translation":{"language":"zh"},
        "audio":{"input":{"turn_detection":{"type":"server_vad"}}}
    }});
    state.record_client_session_update(authority, &update).unwrap();
    let mut session = update["session"].clone();
    session["id"] = json!("session-1");
    session["object"] = json!("realtime.session");
    session["model"] = json!(&authority.exact_model_id);
    for kind in ["session.created", "session.updated"] {
        admit(&mut state, authority, json!({"type":kind,"session":session})).unwrap();
    }
    state
}

fn text_event(kind: &str, response: &str) -> Value {
    json!({"type":kind,"response_id":response,"item_id":format!("item-{response}"),
        "output_index":0,"content_index":0})
}

fn open_response(state: &mut LiveTranslateServerState, authority: &AuthorizedModelProtocolProfile, response: &str, part: &str) {
    admit(state, authority, json!({"type":"response.created","response":{
        "id":response,"conversation_id":"conv-1","object":"realtime.response",
        "status":"in_progress","modalities":["text","audio"],"output":[]
    }})).unwrap();
    let mut output = text_event("response.output_item.added", response);
    output["item"] = json!({"id":format!("item-{response}"),"object":"realtime.item",
        "type":"message","status":"in_progress","role":"assistant","content":[]});
    admit(state, authority, output).unwrap();
    let mut content = text_event("response.content_part.added", response);
    content["part"] = json!({"type":part,"text":""});
    admit(state, authority, content).unwrap();
}

fn close_response(state: &mut LiveTranslateServerState, authority: &AuthorizedModelProtocolProfile, response: &str, part: &str, status: &str) -> LiveTranslateServerMutation {
    if part == "audio" { admit(state, authority, text_event("response.audio.done", response)).unwrap(); }
    let mut content = text_event("response.content_part.done", response);
    content["part"] = json!({"type":part,"text":""});
    admit(state, authority, content).unwrap();
    let item = json!({"id":format!("item-{response}"),"object":"realtime.item",
        "type":"message","status":"completed","role":"assistant","content":[]});
    let mut output = text_event("response.output_item.done", response);
    output["item"] = item.clone();
    admit(state, authority, output).unwrap();
    admit(state, authority, json!({"type":"response.done","response":{
        "id":response,"conversation_id":"conv-1","object":"realtime.response",
        "status":status,"modalities":["text","audio"],"output":[item]
    }})).unwrap()
}

#[test]
fn v2_authorized_delta_streams_are_isolated_and_finish_drains() {
    let authority = authority();
    assert!(is_v2(&authority));
    let mut state = active(&authority);
    open_response(&mut state, &authority, "a", "text");
    open_response(&mut state, &authority, "b", "audio");
    state.record_client_finish().unwrap();
    assert!(admit(&mut state, &authority, json!({"type":"session.finished"})).is_err());
    for (response, kind, delta, expected) in [
        ("a", "response.text.delta", "你", "你"),
        ("b", "response.audio_transcript.delta", "Hello", "Hello"),
        ("a", "response.text.delta", "好", "你好"),
        ("b", "response.audio_transcript.delta", " world", "Hello world"),
    ] {
        let mut event = text_event(kind, response);
        event["delta"] = json!(delta);
        assert_eq!(admit(&mut state, &authority, event).unwrap().normalized_text.as_deref(), Some(expected));
    }
    let mut malformed = text_event("response.text.delta", "a");
    malformed["delta"] = json!(42);
    assert!(admit(&mut state, &authority, malformed).is_err());
    for (response, kind, expected) in [("a","response.text.done","你好"),("b","response.audio_transcript.done","Hello world")] {
        assert_eq!(admit(&mut state, &authority, text_event(kind,response)).unwrap().normalized_text.as_deref(), Some(expected));
        assert!(admit(&mut state, &authority, text_event(kind,response)).is_err());
    }
    let mut late = text_event("response.text.delta", "a");
    late["delta"] = json!("late");
    assert!(admit(&mut state, &authority, late).is_err());
    let a = close_response(&mut state, &authority, "a", "text", "completed");
    assert_eq!(a.completed_response_text.as_deref(), Some("你好"));
    assert!(admit(&mut state, &authority, json!({"type":"session.finished"})).is_err());
    let b = close_response(&mut state, &authority, "b", "audio", "failed");
    assert!(!b.response_completed);
    assert!(b.completed_response_text.is_none());
    assert!(admit(&mut state, &authority, json!({"type":"session.finished"})).unwrap().session_finished);
    assert!(admit(&mut state, &authority, json!({"type":"session.finished"})).is_err());
}

#[test]
fn v2_asr_deltas_accumulate_without_required_metadata_and_drain_on_finish() {
    let authority = authority();
    let mut state = active(&authority);
    admit(&mut state, &authority, json!({"type":"input_audio_buffer.speech_started","item_id":"source", "audio_start_ms":0})).unwrap();
    admit(&mut state, &authority, json!({"type":"conversation.item.created", "item":{
        "id":"source","object":"realtime.item","type":"message","status":"in_progress",
        "role":"user","content":[{"type":"input_audio"}]
    }})).unwrap();
    for (delta, expected) in [("Hello", "Hello"),(" world", "Hello world")] {
        let mutation = admit(&mut state, &authority, json!({"type":"conversation.item.input_audio_transcription.delta",
            "item_id":"source","content_index":0,"delta":delta})).unwrap();
        assert_eq!(mutation.normalized_text.as_deref(), Some(expected));
    }
    state.record_client_finish().unwrap();
    assert!(admit(&mut state, &authority, json!({"type":"session.finished"})).is_err());
    admit(&mut state, &authority, json!({"type":"input_audio_buffer.speech_stopped","item_id":"source", "audio_end_ms":1000})).unwrap();
    admit(&mut state, &authority, json!({"type":"conversation.item.input_audio_transcription.completed",
        "item_id":"source","content_index":0,"transcript":"Hello world"})).unwrap();
    assert!(admit(&mut state, &authority, json!({"type":"session.finished"})).unwrap().session_finished);
}

#[test]
fn v2_authority_rejects_v1_client_fields_and_manual_before_connect() {
    let authority = authority();
    assert!(admit_livetranslate_client_event(&authority, &json!({"type":"input_audio_buffer.commit"})).is_err());
    let mut update = json!({"type":"session.update","session":{"output_modalities":["text"],"translation":{"language":"zh"}}});
    admit_livetranslate_client_event(&authority, &update).unwrap();
    update["session"]["turn_detection"] = Value::Null;
    assert!(admit_livetranslate_client_event(&authority, &update).is_err());
    let old = livetranslate_test_authority();
    assert!(admit_livetranslate_client_event(&old, &json!({"type":"session.update","session":{"output_modalities":["text"],"translation":{"language":"zh"}}})).is_err());
}
