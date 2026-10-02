use super::*;

pub(super) fn exact_livetranslate_replay() -> (ReplayHarness, WorkerSlice, Vec<ScriptStep>) {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.provider.model = "qwen3.5-livetranslate-flash-realtime".to_string();
    harness.provider.template_realtime_protocol = Some("dashscope-livetranslate".to_string());
    harness.provider.region = Some("cn-beijing".to_string());
    harness.provider.base_url = "https://dashscope.aliyuncs.com/api/v1".to_string();
    harness.output_mode = OmniOutputMode::TextOnly;

    let client_update = super::super::super::protocol::build_omni_session_update_for_provider_with_output_mode(
        &harness.provider,
        "Ethan",
        "",
        RealtimeAudioMode::ServerVad,
        "en",
        "zh-CN",
        OmniOutputMode::TextOnly,
    );
    let authority = crate::audio::events::authorize_bailian_native_translate(&harness.provider)
        .expect("exact LiveTranslate provider must authorize");
    let mut slice = WorkerSlice::new();
    slice.session_ready_for_audio = false;
    slice
        .event_diagnostics
        .livetranslate_server_state
        .record_client_session_update(&authority, &client_update)
        .expect("the exact production session.update must bind before its server echo");

    let mut echoed_session = client_update["session"].clone();
    echoed_session["id"] = json!("session-production-replay");
    echoed_session["object"] = json!("realtime.session");
    echoed_session["model"] = json!("qwen3.5-livetranslate-flash-realtime");
    let activation = vec![
        ScriptStep::Event(json!({
            "event_id":"event-session-created",
            "type":"session.created",
            "session":{
                "id":"session-production-replay",
                "object":"realtime.session",
                "model":"qwen3.5-livetranslate-flash-realtime"
            }
        })),
        ScriptStep::Event(json!({
            "event_id":"event-session-updated",
            "type":"session.updated",
            "session":echoed_session
        })),
    ];
    (harness, slice, activation)
}

pub(super) fn with_event_id(id: &str, mut event: serde_json::Value) -> serde_json::Value {
    event["event_id"] = json!(id);
    event
}

pub(super) fn livetranslate_source_steps() -> Vec<ScriptStep> {
    vec![
        ScriptStep::Event(with_event_id(
            "event-speech-started",
            json!({
                "type":"input_audio_buffer.speech_started",
                "item_id":"source-item",
                "audio_start_ms":10
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-source-item",
            json!({
                "type":"conversation.item.created",
                "previous_item_id":"previous-item",
                "item":{
                    "id":"source-item",
                    "object":"realtime.item",
                    "type":"message",
                    "status":"in_progress",
                    "role":"user",
                    "content":[]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-source-text",
            json!({
                "type":"conversation.item.input_audio_transcription.text",
                "item_id":"source-item",
                "content_index":0,
                "text":"source phrase",
                "stash":"",
                "language":"en",
                "emotion":"neutral"
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-speech-stopped",
            json!({
                "type":"input_audio_buffer.speech_stopped",
                "item_id":"source-item",
                "audio_end_ms":800
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-source-completed",
            json!({
                "type":"conversation.item.input_audio_transcription.completed",
                "item_id":"source-item",
                "content_index":0,
                "transcript":"source phrase",
                "language":"en",
                "emotion":"neutral"
            }),
        )),
    ]
}

pub(super) fn livetranslate_text_response_steps(
    response_status: &str,
    item_status: &str,
) -> Vec<ScriptStep> {
    let translated = "目标译文";
    vec![
        ScriptStep::Event(with_event_id(
            "event-response-created",
            json!({
                "type":"response.created",
                "response":{
                    "id":"response-text",
                    "conversation_id":"conversation-1",
                    "object":"realtime.response",
                    "status":"in_progress",
                    "modalities":["text"],
                    "output":[]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-output-added",
            json!({
                "type":"response.output_item.added",
                "response_id":"response-text",
                "output_index":0,
                "item":{
                    "id":"output-item",
                    "object":"realtime.item",
                    "type":"message",
                    "status":"in_progress",
                    "role":"assistant",
                    "content":[]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-content-added",
            json!({
                "type":"response.content_part.added",
                "response_id":"response-text",
                "item_id":"output-item",
                "output_index":0,
                "content_index":0,
                "part":{"type":"text","text":""}
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-response-text",
            json!({
                "type":"response.text.text",
                "response_id":"response-text",
                "item_id":"output-item",
                "output_index":0,
                "content_index":0,
                "text":translated,
                "stash":""
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-response-text-done",
            json!({
                "type":"response.text.done",
                "response_id":"response-text",
                "item_id":"output-item",
                "output_index":0,
                "content_index":0,
                "text":translated
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-content-done",
            json!({
                "type":"response.content_part.done",
                "response_id":"response-text",
                "item_id":"output-item",
                "output_index":0,
                "content_index":0,
                "part":{"type":"text","text":translated}
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-output-done",
            json!({
                "type":"response.output_item.done",
                "response_id":"response-text",
                "output_index":0,
                "item":{
                    "id":"output-item",
                    "object":"realtime.item",
                    "type":"message",
                    "status":item_status,
                    "role":"assistant",
                    "content":[{"type":"text","text":translated}]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-response-done",
            json!({
                "type":"response.done",
                "response":{
                    "id":"response-text",
                    "conversation_id":"conversation-1",
                    "object":"realtime.response",
                    "status":response_status,
                    "modalities":["text"],
                    "output":[{
                        "id":"output-item",
                        "object":"realtime.item",
                        "type":"message",
                        "status":item_status,
                        "role":"assistant",
                        "content":[{"type":"text","text":translated}]
                    }]
                }
            }),
        )),
    ]
}

pub(super) fn run_steps(
    harness: &ReplayHarness,
    slice: &mut WorkerSlice,
    steps: Vec<ScriptStep>,
) -> Result<(), String> {
    let count = steps.len();
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..count {
        socket = harness.try_tick(socket, slice)?;
    }
    Ok(())
}
