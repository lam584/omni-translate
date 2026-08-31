use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use super::*;

struct RawTextLifecycleSocket {
    frames: VecDeque<Message>,
    observation: Arc<RawTextSocketObservation>,
}

#[derive(Default)]
struct RawTextSocketObservation {
    reads: AtomicUsize,
    sent: Mutex<Vec<serde_json::Value>>,
}

impl RawTextLifecycleSocket {
    fn new(frames: Vec<Message>) -> (Self, Arc<RawTextSocketObservation>) {
        let observation = Arc::new(RawTextSocketObservation::default());
        (
            Self {
                frames: frames.into(),
                observation: observation.clone(),
            },
            observation,
        )
    }
}

impl RealtimeSocket for RawTextLifecycleSocket {
    fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
        self.observation.reads.fetch_add(1, Ordering::SeqCst);
        self.frames.pop_front().ok_or_else(|| {
            tungstenite::Error::Io(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "raw lifecycle socket exhausted",
            ))
        })
    }

    fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error> {
        if let Message::Text(text) = message {
            if let Ok(value) = serde_json::from_str(&text) {
                self.observation
                    .sent
                    .lock()
                    .expect("raw socket observation")
                    .push(value);
            }
        }
        Ok(())
    }
}

struct NoReconnectRawTextConnector;

impl RealtimeSocketConnector for NoReconnectRawTextConnector {
    type Socket = RawTextLifecycleSocket;

    fn reconnect<R: tauri::Runtime>(
        &self,
        _app: &tauri::AppHandle<R>,
        _provider: &ProviderDraftInput,
        _voice: &str,
        _instructions: &str,
        _audio_mode: RealtimeAudioMode,
        _output_mode: OmniOutputMode,
        _source_language: &str,
        _target_language: &str,
    ) -> Result<super::super::realtime_socket::ReconnectedRealtimeSocket<Self::Socket>, String>
    {
        Err("malformed-frame replay must fail before reconnect".to_string())
    }
}

fn poll_one_livetranslate_socket<C: RealtimeSocketConnector>(
    harness: &ReplayHarness,
    socket: C::Socket,
    connector: &C,
    slice: WorkerSlice,
) -> Result<(), String> {
    let app = harness.handle();
    let store = harness.store();
    let recorder = crate::diagnostics::model_trace::ModelTraceRecorder::new(
        app.clone(),
        crate::diagnostics::model_trace::ModelTraceContext::new(
            "provider-dashscope-old-red",
            "qwen3-livetranslate-flash-realtime",
            "bailian-c01-old-red",
        ),
    );
    let trace_call = recorder.call("bailian.c01.poll");
    let glossary = GlossaryContext::default();
    let provider_input_budget = ProviderInputBudget::disabled_for_test();

    OmniSocketEventProcessor::poll(
        OmniSocketEventState {
            socket,
            trace_call,
            reconnect_count: slice.reconnect_count,
            pending_audio_buffer: slice.pending_audio_buffer,
            active_voice: slice.active_voice,
            voice_fallback_applied: slice.voice_fallback_applied,
            session_ready_for_audio: slice.session_ready_for_audio,
            event_diagnostics: slice.event_diagnostics,
            current_cue_id: slice.current_cue_id,
            pending_source_text: slice.pending_source_text,
            pending_translated_text: slice.pending_translated_text,
            st_skip_logged: slice.st_skip_logged,
            pending_audio_delta_count: slice.pending_audio_delta_count,
            pending_audio_delta_base64_bytes: slice.pending_audio_delta_base64_bytes,
            pending_audio_response_id: slice.pending_audio_response_id,
            pending_audio_stream_cue_id: None,
            pending_audio_stream_chunk_index: 0,
            pending_audio_stream_created_at_ms: None,
            pending_audio_stream_aborted: false,
            last_vad_event_time: slice.last_vad_event_time,
            vad_event_count: slice.vad_event_count,
            transcription_completed_flag: slice.transcription_completed_flag,
            transcription_completed_at: slice.transcription_completed_at,
            manual_response_pending: slice.manual_response_pending,
            manual_response_requested: slice.manual_response_requested,
            manual_response_item_id: slice.manual_response_item_id,
            manual_response_released_at: slice.manual_response_released_at,
            sent_audio_since_commit: slice.sent_audio_since_commit,
            audio_samples_since_commit: slice.audio_samples_since_commit,
            manual_turn_audio_after_response: slice.manual_turn_audio_after_response,
        },
        OmniSocketEventContext {
            app: &app,
            store: &store,
            direction: "inbound",
            session_generation: 1,
            session_started_at: &harness.session_started_at,
            subtitle_translate_active: false,
            native_translation_reuse_active: false,
            total_input_chunks: 0,
            first_audio_sent_ms: None,
            first_audible_chunk_ms: None,
            chunk_count: 0,
            total_silence_skipped_before_first_audible: 0,
            playback_tx: &harness.playback_tx,
            readiness_sent: &harness.readiness_sent,
            readiness_tx: &harness.readiness_tx,
            provider: &harness.provider,
            provider_input_budget: &provider_input_budget,
            instructions: "",
            glossary: &glossary,
            audio_mode: RealtimeAudioMode::ServerVad,
            output_mode: OmniOutputMode::TextOnly,
            source_language: "en",
            target_language: "zh-CN",
            buffer_size: 0,
            pre_session_audio_queue_len: 0,
            pre_session_audio_dropped: 0,
            echo_guard_enabled: false,
        },
        connector,
    )
    .map(|_| ())
}

fn poll_one_livetranslate_event(
    harness: &ReplayHarness,
    event: serde_json::Value,
) -> Result<(), String> {
    let socket = ScriptedRealtimeSocket::new(
        vec![ScriptStep::Event(event)],
        harness.shared.clone(),
    );
    poll_one_livetranslate_socket(harness, socket, &harness.connector, WorkerSlice::new())
}

#[test]
fn production_text_boundary_rejects_malformed_json_before_lifecycle_admission() {
    let (harness, slice, mut lifecycle) = exact_livetranslate_replay();
    lifecycle.extend(livetranslate_source_steps());
    lifecycle.extend(livetranslate_text_response_steps("completed", "completed"));
    lifecycle.push(ScriptStep::Event(with_event_id(
        "event-session-finished",
        json!({"type":"session.finished"}),
    )));

    let mut frames = vec![Message::Text(
        r#"{"type":"session.created","session":BROKEN"#.into(),
    )];
    frames.extend(lifecycle.into_iter().map(|step| match step {
        ScriptStep::Event(event) => Message::Text(event.to_string().into()),
        ScriptStep::Idle | ScriptStep::Close => {
            unreachable!("the malformed-frame fixture contains only server Text frames")
        }
    }));

    harness.readiness_sent.store(false, Ordering::SeqCst);
    harness
        .store()
        .begin_strict_watch_terminal_lifecycle("run-malformed", "cell", "lease")
        .unwrap();
    let (socket, observation) = RawTextLifecycleSocket::new(frames);
    let result = poll_one_livetranslate_socket(
        &harness,
        socket,
        &NoReconnectRawTextConnector,
        slice,
    );

    let error = result.expect_err(
        "a malformed initial Text frame must fail the production boundary even when a complete LiveTranslate lifecycle follows",
    );
    assert!(
        error.starts_with("model_protocol.payload_invalid: server Text frame is not valid JSON"),
        "malformed JSON must expose the stable production protocol failure stage: {error}"
    );
    assert_eq!(
        observation.reads.load(Ordering::SeqCst),
        1,
        "the malformed initial frame must stop the socket before any queued lifecycle event"
    );
    assert!(
        matches!(
            harness._readiness_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ),
        "a malformed frame must not release production readiness"
    );
    assert!(
        harness
            .store()
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("a malformed frame cannot produce strict terminal evidence")
            .contains("sessionUpdatedReceived"),
        "a malformed frame must not admit even the first lifecycle boundary"
    );
    assert!(
        !harness
            .store()
            .strict_watch_session_finished_received()
            .unwrap(),
        "a malformed frame must not admit the queued session terminal"
    );
}

#[test]
fn authorized_livetranslate_error_stops_before_following_response() {
    let (harness, mut slice, activation) = exact_livetranslate_replay();
    harness
        .store()
        .begin_strict_watch_terminal_lifecycle("run-error", "cell", "lease")
        .unwrap();
    run_steps(&harness, &mut slice, activation)
        .expect("created and exact updated activate the authorized LiveTranslate route");

    let mut following = livetranslate_source_steps();
    following.extend(livetranslate_text_response_steps("completed", "completed"));
    following.push(ScriptStep::Event(with_event_id(
        "event-session-finished-after-error",
        json!({"type":"session.finished"}),
    )));
    let mut frames = vec![Message::Text(
        with_event_id(
            "event-provider-error",
            json!({
                "type":"error",
                "error":{
                    "type":"server_error",
                    "code":"InternalError",
                    "message":"synthetic LiveTranslate internal failure",
                    "param":"session"
                }
            }),
        )
        .to_string()
        .into(),
    )];
    frames.extend(following.into_iter().map(|step| match step {
        ScriptStep::Event(event) => Message::Text(event.to_string().into()),
        ScriptStep::Idle | ScriptStep::Close => {
            unreachable!("the provider-error fixture contains only server Text frames")
        }
    }));
    let (socket, observation) = RawTextLifecycleSocket::new(frames);

    let result = poll_one_livetranslate_socket(
        &harness,
        socket,
        &NoReconnectRawTextConnector,
        slice,
    );
    let error = result.expect_err(
        "an admitted top-level error must terminate an explicitly authorized LiveTranslate route",
    );
    assert!(
        error.starts_with("model_protocol.provider_error: authorized LiveTranslate server error"),
        "the provider error must expose a stable fail-closed stage: {error}"
    );
    assert_eq!(
        observation.reads.load(Ordering::SeqCst),
        1,
        "no response or session terminal after the error may be read"
    );
    let sent = observation.sent.lock().expect("raw socket observation");
    assert!(
        sent.iter().all(|event| !matches!(
            event["type"].as_str(),
            Some("input_audio_buffer.append" | "session.finish")
        )),
        "the failed route must not append Provider input or send session.finish"
    );
    assert!(
        harness
            .store()
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("the failed route has no append, finish, or response terminal")
            .contains("lastProviderAppend"),
        "the failed route must remain before its first Provider append"
    );
    assert!(
        !harness
            .store()
            .strict_watch_session_finished_received()
            .unwrap(),
        "the queued terminal cannot cross the provider error"
    );
}

#[test]
fn livetranslate_rejects_omni_text_delta() {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.provider.model = "qwen3.5-livetranslate-flash-realtime".to_string();
    harness.provider.template_realtime_protocol = Some("dashscope-livetranslate".to_string());
    harness.provider.region = Some("cn-beijing".to_string());
    harness.provider.base_url = "https://dashscope.aliyuncs.com/api/v1".to_string();
    harness.provider.local_model_capability_registry = vec![serde_json::from_value(json!({
        "id": "seed-qwen3-5-livetranslate-flash-realtime",
        "modelId": "qwen3.5-livetranslate-flash-realtime",
        "capabilities": ["speech-to-text", "speech-to-speech"],
        "registryVersion": "bailian-model-protocol-registry/v1",
        "profileId": "bailian.livetranslate.realtime.ws",
        "profileVersion": 1,
        "realtimeProtocol": "dashscope-livetranslate",
        "realtimeAudioMode": "server_vad",
        "interactionCapabilities": ["native-translation"],
        "apiModes": ["realtime"],
        "releasedAt": null,
        "source": "official",
        "notes": "Synthetic old-red manifest declaration"
    }))
    .expect("LiveTranslate manifest declaration fixture must deserialize")];
    harness.output_mode = OmniOutputMode::TextOnly;

    let result = poll_one_livetranslate_event(
        &harness,
        json!({
            "type": "response.text.delta",
            "delta": "不应被 LiveTranslate adapter 接受",
            "fixtureMetadata": {
                "sourceUrls": [
                    "https://help.aliyun.com/zh/model-studio/live-translate",
                    "https://help.aliyun.com/zh/model-studio/qwen-omni"
                ],
                "checkedAt": "2026-08-30",
                "profileId": "dashscope-livetranslate-realtime",
                "profileVersion": 1,
                "redaction": "Synthetic text only; no credential, audio, or customer payload.",
                "expectedOrdering": "reject unexpected_event before any cue mutation"
            }
        }),
    );

    let error = match result {
        Ok(()) => panic!(
            "C01: LiveTranslate accepted the Omni-only response.text.delta event instead of returning unexpected_event"
        ),
        Err(error) => error,
    };
    assert!(
        error.contains("unexpected_event"),
        "C01 must expose a stable unexpected_event protocol violation, got: {error}"
    );
    assert!(
        harness
            .store()
            .snapshot()
            .subtitle_overlay
            .recent_cues
            .is_empty(),
        "C01: rejected cross-dialect events must not mutate subtitle cues"
    );
}

#[test]
fn livetranslate_keeps_provider_input_closed_until_session_updated() {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.provider.model = "qwen3.5-livetranslate-flash-realtime".to_string();
    harness.provider.template_realtime_protocol = Some("dashscope-livetranslate".to_string());
    harness.provider.region = Some("cn-beijing".to_string());
    harness.provider.base_url = "https://dashscope.aliyuncs.com/api/v1".to_string();
    harness.output_mode = OmniOutputMode::TextOnly;
    let mut slice = WorkerSlice::new();
    slice.session_ready_for_audio = false;
    let authority = crate::audio::events::authorize_bailian_native_translate(&harness.provider)
        .expect("exact LiveTranslate provider must authorize");
    slice
        .event_diagnostics
        .livetranslate_server_state
        .record_client_session_update(
            &authority,
            &json!({
                "type":"session.update",
                "session":{
                    "modalities":["text"],
                    "input_audio_format":"pcm",
                    "sample_rate":16000,
                    "turn_detection":{
                        "type":"server_vad",
                        "threshold":0.0,
                        "silence_duration_ms":400
                    },
                    "input_audio_transcription":{
                        "model":"qwen3-asr-flash-realtime",
                        "language":"en"
                    },
                    "translation":{"language":"zh"}
                }
            }),
        )
        .expect("production client session.update must bind before the server echo");
    let mut socket = ScriptedRealtimeSocket::new(
        vec![
            ScriptStep::Event(json!({
                "event_id":"event-session-created", "type":"session.created",
                "session":{
                    "id":"session-1", "object":"realtime.session",
                    "model":"qwen3.5-livetranslate-flash-realtime"
                }
            })),
            ScriptStep::Event(json!({
                "event_id":"event-session-updated", "type":"session.updated",
                "session":{
                    "id":"session-1", "object":"realtime.session",
                    "model":"qwen3.5-livetranslate-flash-realtime",
                    "modalities":["text"], "input_audio_format":"pcm", "sample_rate":16000,
                    "turn_detection":{"type":"server_vad","threshold":0.0,"silence_duration_ms":400},
                    "input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"en"},
                    "translation":{"language":"zh"}
                }
            })),
        ],
        harness.shared.clone(),
    );

    socket = harness.tick(socket, &mut slice);
    assert!(
        !slice.session_ready_for_audio,
        "session.created is transport identity only; it must not release queued paid input"
    );
    let _socket = harness.tick(socket, &mut slice);
    assert!(
        slice.session_ready_for_audio,
        "session.updated is the first LiveTranslate provider-input send boundary"
    );
}

fn exact_livetranslate_replay() -> (ReplayHarness, WorkerSlice, Vec<ScriptStep>) {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.provider.model = "qwen3.5-livetranslate-flash-realtime".to_string();
    harness.provider.template_realtime_protocol = Some("dashscope-livetranslate".to_string());
    harness.provider.region = Some("cn-beijing".to_string());
    harness.provider.base_url = "https://dashscope.aliyuncs.com/api/v1".to_string();
    harness.output_mode = OmniOutputMode::TextOnly;

    let client_update = super::super::protocol::build_omni_session_update_for_provider_with_output_mode(
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

fn with_event_id(id: &str, mut event: serde_json::Value) -> serde_json::Value {
    event["event_id"] = json!(id);
    event
}

fn livetranslate_source_steps() -> Vec<ScriptStep> {
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

fn livetranslate_text_response_steps(
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

fn run_steps(
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

#[test]
fn production_replay_failed_response_never_commits_cue_or_strict_terminal() {
    for response_status in ["failed", "incomplete"] {
        let (harness, mut slice, mut steps) = exact_livetranslate_replay();
        harness
            .store()
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        steps.extend(livetranslate_source_steps());
        steps.extend(livetranslate_text_response_steps(response_status, "completed"));
        run_steps(&harness, &mut slice, steps)
            .expect("a typed failed response is consumed as a terminal failure");

        let snapshot = harness.store().snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.source_text == "source phrase")
            .expect("the production source cue must remain inspectable");
        assert!(!cue.translation_committed);
        assert_eq!(
            cue.translation_state,
            Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error),
            "partial Provider text may remain inspectable, but its cue must be terminally failed"
        );
        let terminal_error = harness
            .store()
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("failed Provider response must poison strict terminal authority");
        assert!(terminal_error.contains("failed Provider responses"), "{terminal_error}");
    }
}

#[test]
fn production_replay_completed_response_rejects_noncompleted_output_item() {
    for item_status in ["failed", "incomplete"] {
        let (harness, mut slice, mut steps) = exact_livetranslate_replay();
        steps.extend(livetranslate_source_steps());
        let response_steps = livetranslate_text_response_steps("completed", item_status);
        let final_index = response_steps.len() - 1;
        steps.extend(response_steps.into_iter().take(final_index));
        run_steps(&harness, &mut slice, steps).unwrap();

        let final_socket = ScriptedRealtimeSocket::new(
            vec![ScriptStep::Event(
                livetranslate_text_response_steps("completed", item_status)
                    .pop()
                    .and_then(|step| match step {
                        ScriptStep::Event(event) => Some(event),
                        _ => None,
                    })
                    .expect("final response.done fixture"),
            )],
            harness.shared.clone(),
        );
        let error = match harness.try_tick(final_socket, &mut slice) {
            Ok(_) => panic!("completed response with a non-completed item must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("terminal status"), "{error}");
        let snapshot = harness.store().snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.source_text == "source phrase")
            .expect("the production source cue must remain inspectable");
        assert!(!cue.translation_committed);
    }
}

#[test]
fn production_replay_normalizes_audio_text_alias_before_strict_terminal_commit() {
    let (harness, mut slice, mut steps) = exact_livetranslate_replay();
    let store = harness.store();
    store
        .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
        .unwrap();
    run_steps(&harness, &mut slice, std::mem::take(&mut steps))
        .expect("the production typed session.updated must authorize Provider input");
    store.record_strict_watch_provider_append(16_000).unwrap();
    store.record_strict_watch_provider_input_closed().unwrap();
    store.record_strict_watch_session_finish_sent().unwrap();
    steps.extend(livetranslate_source_steps());
    steps.extend([
        ScriptStep::Event(with_event_id(
            "event-response-created",
            json!({
                "type":"response.created",
                "response":{
                    "id":"response-audio",
                    "conversation_id":"conversation-1",
                    "object":"realtime.response",
                    "status":"in_progress",
                    "modalities":["audio","text"],
                    "output":[]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-output-added",
            json!({
                "type":"response.output_item.added",
                "response_id":"response-audio",
                "output_index":0,
                "item":{
                    "id":"output-audio",
                    "object":"realtime.item",
                    "type":"message",
                    "status":"in_progress",
                    "role":"assistant",
                    "content":[]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-output-done",
            json!({
                "type":"response.output_item.done",
                "response_id":"response-audio",
                "output_index":0,
                "item":{
                    "id":"output-audio",
                    "object":"realtime.item",
                    "type":"message",
                    "status":"completed",
                    "role":"assistant",
                    "content":[{"type":"audio","text":"文档译音文本"}]
                }
            }),
        )),
        ScriptStep::Event(with_event_id(
            "event-response-done",
            json!({
                "type":"response.done",
                "response":{
                    "id":"response-audio",
                    "conversation_id":"conversation-1",
                    "object":"realtime.response",
                    "status":"completed",
                    "modalities":["audio","text"],
                    "output":[{
                        "id":"output-audio",
                        "object":"realtime.item",
                        "type":"message",
                        "status":"completed",
                        "role":"assistant",
                        "content":[{"type":"audio","transcript":"文档译音文本"}]
                    }]
                }
            }),
        )),
    ]);
    run_steps(&harness, &mut slice, steps).unwrap();

    let snapshot = store.snapshot();
    let cue = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.source_text == "source phrase")
        .expect("the normalized response must resolve the production source cue");
    assert!(cue.translation_committed);
    assert_eq!(cue.translated_text, "文档译音文本");
    store
        .record_strict_watch_renderer_cue_submitted(&cue.cue_id, "response-audio")
        .unwrap();
    store
        .record_strict_watch_renderer_ack(
            &cue.cue_id,
            "bridge-translation-status-ack",
            "receipt-audio",
        )
        .unwrap();
    store.record_strict_watch_session_finished_received().unwrap();
    let terminal = store.strict_watch_terminal_lifecycle_snapshot().unwrap();
    assert_eq!(terminal.last_response_terminal.response_id, "response-audio");
    assert_eq!(terminal.final_renderer_ack.cue_id, cue.cue_id);
}
