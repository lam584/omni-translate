//! Incident replay tests: scripted realtime sessions driven through the REAL
//! worker slice (poll → reconnect reset → manual-commit maintenance), with
//! cue-store and gate end-states asserted. Each replay mirrors an escaped
//! field incident class (b4a5e49 / ba9912e / 77782a7): reconnects racing the
//! manual gate, and late transcriptions after the gate moved on.

use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::json;
use tauri::Manager;

use super::realtime_socket::scripted::{
    ScriptStep, ScriptedConnector, ScriptedRealtimeSocket, ScriptedSharedState,
};
use super::session_worker::reset_manual_gate_after_reconnect;
use super::*;
use crate::audio::state::AudioStateStore;

type MockHandle = tauri::AppHandle<tauri::test::MockRuntime>;

/// Collects the source text of every recent overlay cue in a snapshot.
fn cue_source_texts(snapshot: &crate::audio::contracts::AudioRuntimeSnapshot) -> Vec<String> {
    snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .map(|cue| cue.source_text.clone())
        .collect()
}

fn fixture_provider() -> ProviderDraftInput {
    serde_json::from_value(json!({
        "templateId": "t",
        "providerId": "p",
        "kind": "dashscope",
        "displayName": "P",
        "model": "qwen3.5-omni-plus-realtime",
        "baseUrl": "wss://example.invalid",
        "transport": "websocket",
        "authRef": {
            "kind": "header",
            "reference": "ref",
            "headerName": "Authorization",
            "scheme": "Bearer"
        },
        "region": null,
        "streamEnabled": true,
        "timeoutMs": 1000,
        "systemPromptTemplate": ""
    }))
    .expect("provider fixture deserializes")
}

/// The mutable worker-slice state run_omni_worker threads between ticks.
struct WorkerSlice {
    current_cue_id: Option<String>,
    pending_source_text: String,
    pending_translated_text: String,
    reconnect_count: usize,
    sent_audio_since_commit: bool,
    manual_response_pending: bool,
    manual_response_item_id: Option<String>,
    last_vad_event_time: SystemTime,
    vad_event_count: u64,
    last_commit_time: SystemTime,
    st_skip_logged: bool,
    transcription_completed_flag: bool,
    transcription_completed_at: Option<SystemTime>,
    event_diagnostics: OmniEventDiagnostics,
    pending_audio_delta_count: u64,
    pending_audio_delta_base64_bytes: u64,
    pending_audio_response_id: Option<String>,
    session_ready_for_audio: bool,
    active_voice: String,
    voice_fallback_applied: bool,
    pending_audio_buffer: Vec<i16>,
}

impl WorkerSlice {
    fn new() -> Self {
        Self {
            current_cue_id: None,
            pending_source_text: String::new(),
            pending_translated_text: String::new(),
            reconnect_count: 0,
            sent_audio_since_commit: false,
            manual_response_pending: false,
            manual_response_item_id: None,
            last_vad_event_time: SystemTime::now(),
            vad_event_count: 0,
            last_commit_time: SystemTime::now(),
            st_skip_logged: false,
            transcription_completed_flag: false,
            transcription_completed_at: None,
            event_diagnostics: OmniEventDiagnostics::default(),
            pending_audio_delta_count: 0,
            pending_audio_delta_base64_bytes: 0,
            pending_audio_response_id: None,
            session_ready_for_audio: true,
            active_voice: "Ethan".to_string(),
            voice_fallback_applied: false,
            pending_audio_buffer: Vec::new(),
        }
    }
}

struct ReplayHarness {
    app: tauri::App<tauri::test::MockRuntime>,
    shared: Arc<Mutex<ScriptedSharedState>>,
    connector: ScriptedConnector,
    provider: ProviderDraftInput,
    audio_mode: RealtimeAudioMode,
    subtitle_translate_active: bool,
    session_started_at: SystemTime,
    playback_tx: mpsc::SyncSender<OmniPlaybackCommand>,
    _playback_rx: mpsc::Receiver<OmniPlaybackCommand>,
    readiness_sent: AtomicBool,
    readiness_tx: mpsc::Sender<Result<u64, String>>,
    _readiness_rx: mpsc::Receiver<Result<u64, String>>,
}

impl ReplayHarness {
    fn new(audio_mode: RealtimeAudioMode, reconnect_scripts: Vec<Vec<ScriptStep>>) -> Self {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        let shared = Arc::new(Mutex::new(ScriptedSharedState::default()));
        shared
            .lock()
            .expect("scripted state")
            .reconnect_scripts
            .extend(reconnect_scripts);
        let (playback_tx, playback_rx) = mpsc::sync_channel::<OmniPlaybackCommand>(64);
        let (readiness_tx, readiness_rx) = mpsc::channel::<Result<u64, String>>();
        Self {
            connector: ScriptedConnector {
                shared: shared.clone(),
            },
            shared,
            provider: fixture_provider(),
            audio_mode,
            subtitle_translate_active: false,
            session_started_at: SystemTime::now(),
            playback_tx,
            _playback_rx: playback_rx,
            readiness_sent: AtomicBool::new(true),
            readiness_tx,
            _readiness_rx: readiness_rx,
            app,
        }
    }

    fn handle(&self) -> MockHandle {
        self.app.handle().clone()
    }

    fn store(&self) -> tauri::State<'_, AudioStateStore> {
        self.app.handle().state::<AudioStateStore>()
    }

    fn sent_types(&self) -> Vec<String> {
        self.shared
            .lock()
            .expect("scripted state")
            .sent
            .iter()
            .filter_map(|value| value["type"].as_str().map(str::to_owned))
            .collect()
    }

    /// One worker tick over the real production pieces: manual-commit
    /// maintenance (with its timed-out turn handling), stale-transcription
    /// expiry, socket poll, and the post-reconnect gate reset.
    fn tick(&self, socket: ScriptedRealtimeSocket, slice: &mut WorkerSlice) -> ScriptedRealtimeSocket {
        let app = self.handle();
        let store = self.store();
        let recorder = crate::diagnostics::model_trace::ModelTraceRecorder::new(
            app.clone(),
            crate::diagnostics::model_trace::ModelTraceContext::new("p", "m", "omni-replay"),
        );
        let mut trace_call = recorder.call("replay.tick");
        let mut socket = socket;

        let commit_state = OmniConnectionCoordinator::maintain_manual_commit(
            OmniCommitState {
                last_commit_time: slice.last_commit_time,
                sent_audio_since_commit: slice.sent_audio_since_commit,
                manual_response_pending: slice.manual_response_pending,
                manual_response_item_id: slice.manual_response_item_id.clone(),
                manual_turn_timed_out: false,
            },
            &app,
            &mut socket,
            &mut trace_call,
            self.audio_mode,
            0,
        );
        slice.last_commit_time = commit_state.last_commit_time;
        slice.sent_audio_since_commit = commit_state.sent_audio_since_commit;
        slice.manual_response_pending = commit_state.manual_response_pending;
        slice.manual_response_item_id = commit_state.manual_response_item_id;
        if commit_state.manual_turn_timed_out {
            let response_stream_active = manual_turn_response_stream_active(
                slice.pending_audio_delta_count,
                slice.pending_audio_buffer.len(),
                slice.pending_audio_response_id.as_deref(),
                &slice.pending_translated_text,
            );
            if !response_stream_owns_current_cue(
                response_stream_active,
                self.subtitle_translate_active,
                false,
            ) {
                if let Some(cue_id) = slice.current_cue_id.as_deref() {
                    store.discard_uncommitted_subtitle_cue(cue_id);
                }
                reset_manual_turn_input_state(
                    &mut slice.current_cue_id,
                    &mut slice.pending_source_text,
                    &mut slice.transcription_completed_flag,
                    &mut slice.transcription_completed_at,
                    &mut slice.event_diagnostics,
                );
            }
        }

        OmniEventProcessor::expire_stale_transcription(
            &app,
            &mut slice.transcription_completed_flag,
            &mut slice.transcription_completed_at,
        );

        let poll = OmniSocketEventProcessor::poll(
            OmniSocketEventState {
                socket,
                trace_call,
                reconnect_count: slice.reconnect_count,
                pending_audio_buffer: std::mem::take(&mut slice.pending_audio_buffer),
                active_voice: slice.active_voice.clone(),
                voice_fallback_applied: slice.voice_fallback_applied,
                session_ready_for_audio: slice.session_ready_for_audio,
                event_diagnostics: slice.event_diagnostics.clone(),
                current_cue_id: slice.current_cue_id.clone(),
                pending_source_text: slice.pending_source_text.clone(),
                pending_translated_text: slice.pending_translated_text.clone(),
                st_skip_logged: slice.st_skip_logged,
                pending_audio_delta_count: slice.pending_audio_delta_count,
                pending_audio_delta_base64_bytes: slice.pending_audio_delta_base64_bytes,
                pending_audio_response_id: slice.pending_audio_response_id.clone(),
                last_vad_event_time: slice.last_vad_event_time,
                vad_event_count: slice.vad_event_count,
                transcription_completed_flag: slice.transcription_completed_flag,
                transcription_completed_at: slice.transcription_completed_at,
                manual_response_pending: slice.manual_response_pending,
                manual_response_item_id: slice.manual_response_item_id.clone(),
            },
            OmniSocketEventContext {
                app: &app,
                store: &store,
                direction: "inbound",
                session_generation: 1,
                session_started_at: &self.session_started_at,
                subtitle_translate_active: self.subtitle_translate_active,
                native_translation_reuse_active: false,
                total_input_chunks: 0,
                first_audio_sent_ms: None,
                first_audible_chunk_ms: None,
                chunk_count: 0,
                total_silence_skipped_before_first_audible: 0,
                playback_tx: &self.playback_tx,
                readiness_sent: &self.readiness_sent,
                readiness_tx: &self.readiness_tx,
                provider: &self.provider,
                instructions: "",
                audio_mode: self.audio_mode,
                target_language: "zh-CN",
                buffer_size: 0,
                pre_session_audio_queue_len: 0,
                pre_session_audio_dropped: 0,
                echo_guard_enabled: false,
            },
            &self.connector,
        )
        .expect("replay poll must not fail the session");

        let state = poll.state;
        slice.reconnect_count = state.reconnect_count;
        slice.pending_audio_buffer = state.pending_audio_buffer;
        slice.active_voice = state.active_voice;
        slice.voice_fallback_applied = state.voice_fallback_applied;
        slice.session_ready_for_audio = state.session_ready_for_audio;
        slice.event_diagnostics = state.event_diagnostics;
        slice.current_cue_id = state.current_cue_id;
        slice.pending_source_text = state.pending_source_text;
        slice.pending_translated_text = state.pending_translated_text;
        slice.st_skip_logged = state.st_skip_logged;
        slice.pending_audio_delta_count = state.pending_audio_delta_count;
        slice.pending_audio_delta_base64_bytes = state.pending_audio_delta_base64_bytes;
        slice.pending_audio_response_id = state.pending_audio_response_id;
        slice.last_vad_event_time = state.last_vad_event_time;
        slice.vad_event_count = state.vad_event_count;
        slice.transcription_completed_flag = state.transcription_completed_flag;
        slice.transcription_completed_at = state.transcription_completed_at;
        slice.manual_response_pending = state.manual_response_pending;
        slice.manual_response_item_id = state.manual_response_item_id;
        let mut socket = state.socket;

        if poll.socket_reconnected {
            reset_manual_gate_after_reconnect(
                &self.handle(),
                &self.store(),
                self.audio_mode,
                &mut slice.manual_response_pending,
                &mut slice.manual_response_item_id,
                &mut slice.sent_audio_since_commit,
                &mut slice.last_commit_time,
                &mut slice.current_cue_id,
                &mut slice.pending_source_text,
                &mut slice.pending_translated_text,
                &mut slice.transcription_completed_flag,
                &mut slice.transcription_completed_at,
                &mut slice.event_diagnostics,
                &mut slice.pending_audio_buffer,
                &mut slice.pending_audio_delta_count,
                &mut slice.pending_audio_delta_base64_bytes,
                &mut slice.pending_audio_response_id,
                &mut slice.session_ready_for_audio,
            );
        }
        let _ = &mut socket;
        socket
    }
}

fn backdated(seconds: u64) -> SystemTime {
    SystemTime::now()
        .checked_sub(Duration::from_secs(seconds))
        .expect("backdated timestamp")
}

/// Replay 1 — commit → reconnect → the OLD item's transcription.completed.
/// The reconnect voids the awaited item; the late completed event must still
/// complete a display cue while the gate never arms response.create for it.
#[test]
fn replay_commit_then_reconnect_then_old_item_completed() {
    let harness = ReplayHarness::new(
        RealtimeAudioMode::Manual,
        vec![vec![
            ScriptStep::Event(json!({ "type": "session.updated", "session": { "id": "s2" } })),
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "item-old",
                "transcript": "the tail of the pre-reconnect turn"
            })),
        ]],
    );
    let mut slice = WorkerSlice::new();
    // Post-commit state: the gate awaits item-old on the OLD session.
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-old".to_string());

    // Tick 1: the provider closes the socket → reconnect + gate reset.
    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Close], harness.shared.clone());
    let socket = harness.tick(socket, &mut slice);
    assert_eq!(harness.shared.lock().unwrap().reconnect_count, 1);
    assert!(!slice.manual_response_pending, "reconnect must drop the manual gate");
    assert!(slice.manual_response_item_id.is_none());
    assert!(
        !slice.session_ready_for_audio,
        "audio must wait for the new session to confirm"
    );

    // Tick 2: the new session confirms.
    let socket = harness.tick(socket, &mut slice);
    assert!(slice.session_ready_for_audio, "session.updated re-arms audio");

    // Tick 3: the OLD item's transcription arrives on the NEW session.
    let _socket = harness.tick(socket, &mut slice);

    let snapshot = harness.store().snapshot();
    let cue_texts = cue_source_texts(&snapshot);
    assert!(
        cue_texts.iter().any(|text| text.contains("the tail of the pre-reconnect turn")),
        "late completed transcription must reach the overlay; cues: {cue_texts:?}"
    );
    assert!(
        !harness.sent_types().iter().any(|kind| kind == "response.create"),
        "a stale item must never arm response.create; sent: {:?}",
        harness.sent_types()
    );
    assert!(!slice.manual_response_pending, "gate stays closed at end of replay");
}

/// Replay 2 — speech_started → delta → disconnect → reconnect → delta.
/// The pre-reconnect uncommitted cue must not absorb the post-reconnect turn:
/// the new delta opens a NEW cue and the stale uncommitted cue is discarded.
#[test]
fn replay_streaming_turn_across_a_reconnect() {
    let harness = ReplayHarness::new(
        RealtimeAudioMode::ServerVad,
        vec![vec![
            ScriptStep::Event(json!({ "type": "session.updated", "session": { "id": "s2" } })),
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.delta",
                "item_id": "item-new",
                "delta": "the new turn after reconnect"
            })),
        ]],
    );
    let mut slice = WorkerSlice::new();

    let socket = ScriptedRealtimeSocket::new(
        vec![
            ScriptStep::Event(json!({ "type": "input_audio_buffer.speech_started" })),
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.delta",
                "item_id": "item-pre",
                "delta": "half a pre-reconnect sent"
            })),
            ScriptStep::Close,
        ],
        harness.shared.clone(),
    );

    let socket = harness.tick(socket, &mut slice); // speech_started → new cue
    let first_cue_id = slice.current_cue_id.clone().expect("speech_started opens a cue");
    let socket = harness.tick(socket, &mut slice); // delta streams into the cue
    assert_eq!(slice.pending_source_text, "half a pre-reconnect sent");

    let socket = harness.tick(socket, &mut slice); // disconnect → reconnect + reset
    assert_eq!(harness.shared.lock().unwrap().reconnect_count, 1);
    assert!(slice.current_cue_id.is_none(), "reconnect releases the streaming cue");
    assert!(!slice.session_ready_for_audio);
    let after_reset = harness.store().snapshot();
    assert!(
        !after_reset
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == first_cue_id && !cue.committed),
        "the stale uncommitted cue must be discarded on reconnect"
    );

    let socket = harness.tick(socket, &mut slice); // session.updated on the new socket
    assert!(slice.session_ready_for_audio);
    let _socket = harness.tick(socket, &mut slice); // post-reconnect delta

    let second_cue_id = slice.current_cue_id.clone().expect("new delta opens a new cue");
    assert_ne!(first_cue_id, second_cue_id, "turns must not merge across a reconnect");
    assert_eq!(slice.pending_source_text, "the new turn after reconnect");
    let snapshot = harness.store().snapshot();
    assert!(
        snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == second_cue_id && cue.source_text.contains("the new turn")),
        "the post-reconnect turn must stream into its own cue"
    );
}

/// Replay 3 — manual-gate timeout → the awaited item's completed arrives late.
/// The timed-out turn released the gate and its input state; the late
/// transcription must still complete a display cue and must not arm
/// response.create.
#[test]
fn replay_gate_timeout_then_late_completed() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    let mut slice = WorkerSlice::new();
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-timeout".to_string());
    slice.last_commit_time = backdated(MANUAL_RESPONSE_TIMEOUT_SECS + 1);

    // Tick 1: the gate times out (no socket traffic).
    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Idle], harness.shared.clone());
    let socket = harness.tick(socket, &mut slice);
    assert!(!slice.manual_response_pending, "gate must drop after the timeout");
    assert!(slice.manual_response_item_id.is_none());

    // Tick 2: the awaited item's transcription.completed arrives late.
    let late_socket = ScriptedRealtimeSocket::new(
        vec![ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-timeout",
            "transcript": "the user's last sentence"
        }))],
        harness.shared.clone(),
    );
    drop(socket);
    let _socket = harness.tick(late_socket, &mut slice);

    let snapshot = harness.store().snapshot();
    let cue_texts = cue_source_texts(&snapshot);
    assert!(
        cue_texts.iter().any(|text| text.contains("the user's last sentence")),
        "the late completed transcription must be displayed; cues: {cue_texts:?}"
    );
    assert!(
        !harness.sent_types().iter().any(|kind| kind == "response.create"),
        "a timed-out turn must never arm response.create; sent: {:?}",
        harness.sent_types()
    );
    assert!(!slice.manual_response_pending);
}
