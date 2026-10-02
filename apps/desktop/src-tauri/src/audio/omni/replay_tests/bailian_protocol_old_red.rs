use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use super::*;

mod fixtures;
mod terminal_replay;
use fixtures::{exact_livetranslate_replay, with_event_id, livetranslate_source_steps, livetranslate_text_response_steps, run_steps};

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
    poll_one_socket_with_drain(harness, socket, connector, slice, false)
}

fn poll_one_socket_with_drain<C: RealtimeSocketConnector>(
    harness: &ReplayHarness,
    socket: C::Socket,
    connector: &C,
    slice: WorkerSlice,
    dialogue_draining: bool,
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
    let mut trace_call = recorder.call("bailian.c01.poll");
    let glossary = GlossaryContext::default();
    let provider_input_budget = ProviderInputBudget::disabled_for_test();

    OmniSocketEventProcessor::poll(
        OmniSocketEventState {
            socket,
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
        &mut trace_call,
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
            dialogue_draining,
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

#[test]
fn dialogue_drain_owns_deadline_instead_of_cancel_grace_reconnect() {
    for draining in [false, true] {
        let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
        harness.provider.model = "qwen-audio-3.1-realtime-plus".to_string();
        let mut slice = WorkerSlice::new();
        slice.event_diagnostics.begin_native_response_lifecycle(Some("draining-response"));
        slice.event_diagnostics.mark_native_response_cancel_sent(Instant::now() - Duration::from_secs(3));
        assert!(matches!(slice.event_diagnostics.native_response_stall_action(Instant::now(), harness.provider.timeout_ms, true), ResponseStallAction::Reconnect));
        let (socket, observation) = RawTextLifecycleSocket::new(vec![Message::Pong(Vec::new().into())]);
        let result = poll_one_socket_with_drain(&harness, socket, &NoReconnectRawTextConnector, slice, draining);
        if draining {
            result.expect("shutdown must retain its longer terminal deadline");
        } else {
            assert!(result.unwrap_err().contains("must fail before reconnect"), "normal watchdog must still attempt recovery outside shutdown");
        }
        assert_eq!(observation.reads.load(Ordering::SeqCst), 1, "draining still polls provider events");
    }
}
