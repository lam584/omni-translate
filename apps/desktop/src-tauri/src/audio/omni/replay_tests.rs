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
use crate::audio::glossary::GlossaryContext;
use crate::audio::state::AudioStateStore;

mod native_response;
mod text_only_reconnect;

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
    audio_samples_since_commit: u64,
    manual_turn_audio_after_response: bool,
    manual_response_pending: bool,
    manual_response_item_id: Option<String>,
    last_vad_event_time: SystemTime,
    vad_event_count: u64,
    last_commit_time: SystemTime,
    manual_turn_started_at: Option<SystemTime>,
    manual_turn_started_during_playback: Option<bool>,
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
            audio_samples_since_commit: 0,
            manual_turn_audio_after_response: false,
            manual_response_pending: false,
            manual_response_item_id: None,
            last_vad_event_time: SystemTime::now(),
            vad_event_count: 0,
            last_commit_time: SystemTime::now(),
            manual_turn_started_at: None,
            manual_turn_started_during_playback: None,
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
    output_mode: OmniOutputMode,
    subtitle_translate_active: bool,
    session_started_at: SystemTime,
    playback_tx: OmniPlaybackQueue,
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
        let playback_tx = OmniPlaybackQueue::new(64);
        let (readiness_tx, readiness_rx) = mpsc::channel::<Result<u64, String>>();
        Self {
            connector: ScriptedConnector {
                shared: shared.clone(),
            },
            shared,
            provider: fixture_provider(),
            audio_mode,
            output_mode: OmniOutputMode::TextAndAudio,
            subtitle_translate_active: false,
            session_started_at: SystemTime::now(),
            playback_tx,
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
                manual_turn_started_at: slice.manual_turn_started_at,
                manual_turn_started_during_playback: slice.manual_turn_started_during_playback,
                sent_audio_since_commit: slice.sent_audio_since_commit,
                audio_samples_since_commit: slice.audio_samples_since_commit,
                manual_turn_audio_after_response: slice.manual_turn_audio_after_response,
                manual_response_pending: slice.manual_response_pending,
                manual_response_item_id: slice.manual_response_item_id.clone(),
                manual_turn_timed_out: false,
                committed_source_started_during_playback: None,
            },
            &app,
            &mut socket,
            &mut trace_call,
            self.audio_mode,
            0,
            false,
        );
        slice.last_commit_time = commit_state.last_commit_time;
        slice.manual_turn_started_at = commit_state.manual_turn_started_at;
        slice.manual_turn_started_during_playback = commit_state.manual_turn_started_during_playback;
        slice.sent_audio_since_commit = commit_state.sent_audio_since_commit;
        slice.audio_samples_since_commit = commit_state.audio_samples_since_commit;
        slice.manual_turn_audio_after_response = commit_state.manual_turn_audio_after_response;
        slice.manual_response_pending = commit_state.manual_response_pending;
        slice.manual_response_item_id = commit_state.manual_response_item_id;
        if let Some(started_during_playback) =
            commit_state.committed_source_started_during_playback
        {
            slice.event_diagnostics.begin_manual_source_segment(
                elapsed_ms_since(&self.session_started_at),
                started_during_playback,
            );
        }
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

        let glossary = GlossaryContext::default();
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
                sent_audio_since_commit: slice.sent_audio_since_commit,
                audio_samples_since_commit: slice.audio_samples_since_commit,
                manual_turn_audio_after_response: slice.manual_turn_audio_after_response,
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
                glossary: &glossary,
                audio_mode: self.audio_mode,
                output_mode: self.output_mode,
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
        slice.sent_audio_since_commit = state.sent_audio_since_commit;
        slice.audio_samples_since_commit = state.audio_samples_since_commit;
        slice.manual_turn_audio_after_response = state.manual_turn_audio_after_response;
        let mut socket = state.socket;

        if poll.socket_reconnected {
            reset_manual_gate_after_reconnect(
                &self.handle(),
                &self.store(),
                self.audio_mode,
                &mut slice.manual_response_pending,
                &mut slice.manual_response_item_id,
                &mut slice.sent_audio_since_commit,
                &mut slice.audio_samples_since_commit,
                &mut slice.manual_turn_audio_after_response,
                &mut slice.last_commit_time,
                &mut slice.manual_turn_started_at,
                &mut slice.manual_turn_started_during_playback,
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

/// A realtime provider may deliver an earlier ASR final after server VAD has
/// already opened the next cue. The secondary subtitle path must keep that
/// final attached to the item that produced its deltas; otherwise the LLM is
/// handed audio from the previous turn and the visible translations repeat.
#[test]
fn replay_secondary_late_asr_final_stays_with_original_cue() {
    let mut harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    harness.subtitle_translate_active = true;
    let mut slice = WorkerSlice::new();
    let steps = vec![
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-one",
            "text": "first sentence",
            "stash": ""
        })),
        ScriptStep::Event(json!({
            "type": "input_audio_buffer.speech_started"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-two",
            "text": "second sentence",
            "stash": ""
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-one",
            "transcript": "first sentence"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-two",
            "transcript": "second sentence"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for (index, _) in [0, 1, 2, 3, 4, 5].iter().enumerate() {
        socket = harness.tick(socket, &mut slice);
        if index == 1 {
            // Cue ids use millisecond timestamps; ensure the second VAD
            // event represents a genuinely new cue in this deterministic
            // replay rather than a same-millisecond id collision.
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    let cues = harness.store().snapshot().subtitle_overlay.recent_cues;
    let source_texts: Vec<_> = cues.iter().map(|cue| cue.source_text.as_str()).collect();
    assert_eq!(
        source_texts
            .iter()
            .filter(|&&source| source == "first sentence")
            .count(),
        1
    );
    assert_eq!(
        source_texts
            .iter()
            .filter(|&&source| source == "second sentence")
            .count(),
        1
    );
    assert!(cues.iter().all(|cue| {
        cue.source_text != "first sentence second sentence"
            && cue.source_text != "second sentence first sentence"
    }));
}

/// A provider item id is the only admissible merge key. Even if the native
/// cue id looks arbitrarily old, a late ASR cue carrying that same item id is
/// folded into it and the already committed translation survives unchanged.
#[test]
fn replay_same_provider_item_merges_by_lineage_without_a_time_window() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let native_cue_id = format!(
        "omni-cue-inbound-{}",
        unix_ms().saturating_sub(24 * 60 * 60 * 1_000)
    );
    super::protocol::write_committed_native_translation_to_cue(
        &harness.store(),
        &native_cue_id,
        "provisional output",
        "保留的最终译文",
    );
    slice.event_diagnostics.capture_native_response_owner(
        native_cue_id.clone(),
        Some("item-shared".to_string()),
    );
    slice
        .event_diagnostics
        .claim_native_response_owner_for_response(Some("response-shared"), None);
    slice.event_diagnostics.complete_native_response_owner();

    let steps = vec![
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-shared",
            "delta": "authoritative final source"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-shared",
            "transcript": "authoritative final source"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-shared",
            "transcript": "authoritative final source"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..3 {
        socket = harness.tick(socket, &mut slice);
    }

    let cues = harness.store().snapshot().subtitle_overlay.recent_cues;
    assert_eq!(cues.len(), 1, "same-item live cue must be structurally folded");
    let cue = &cues[0];
    assert_eq!(cue.cue_id, native_cue_id);
    assert_eq!(cue.source_text, "authoritative final source");
    assert_eq!(cue.translated_text, "保留的最终译文");
    assert!(cue.committed);
    assert_eq!(
        slice
            .event_diagnostics
            .native_response_id_for_input_item("item-shared")
            .as_deref(),
        Some("response-shared"),
        "response_id -> item_id -> cue lineage must survive late completion",
    );
}

/// Identical text is not identity. Two provider items remain two visible cues
/// even when the older native cue has source and translation strings that are
/// byte-for-byte equal to the newer ASR final.
#[test]
fn replay_same_text_with_different_provider_items_preserves_both_cues() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let native_cue_id = format!(
        "omni-cue-inbound-{}",
        unix_ms().saturating_sub(24 * 60 * 60 * 1_000)
    );
    super::protocol::write_committed_native_translation_to_cue(
        &harness.store(),
        &native_cue_id,
        "same visible text",
        "same visible text",
    );
    slice.event_diagnostics.capture_native_response_owner(
        native_cue_id.clone(),
        Some("item-older".to_string()),
    );
    slice
        .event_diagnostics
        .claim_native_response_owner_for_response(Some("response-older"), None);
    slice.event_diagnostics.complete_native_response_owner();

    let steps = vec![
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-newer",
            "delta": "same visible text"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-newer",
            "transcript": "same visible text"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..2 {
        socket = harness.tick(socket, &mut slice);
    }

    let cues = harness.store().snapshot().subtitle_overlay.recent_cues;
    assert_eq!(cues.len(), 2, "different item ids must never content-merge");
    assert!(cues.iter().any(|cue| cue.cue_id == native_cue_id && cue.committed));
    assert_eq!(
        cues.iter()
            .filter(|cue| cue.source_text == "same visible text")
            .count(),
        2
    );
}

/// Missing provider identity is unresolved, not permission to guess from the
/// text. The new cue remains alongside the older committed native output.
#[test]
fn replay_same_text_without_provider_identity_preserves_both_cues() {
    let harness = ReplayHarness::new(RealtimeAudioMode::ServerVad, Vec::new());
    let mut slice = WorkerSlice::new();
    let native_cue_id = format!(
        "omni-cue-inbound-{}",
        unix_ms().saturating_sub(24 * 60 * 60 * 1_000)
    );
    super::protocol::write_committed_native_translation_to_cue(
        &harness.store(),
        &native_cue_id,
        "same visible text",
        "same visible text",
    );

    let steps = vec![
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": "same visible text"
        })),
        ScriptStep::Event(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "same visible text"
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..2 {
        socket = harness.tick(socket, &mut slice);
    }

    let cues = harness.store().snapshot().subtitle_overlay.recent_cues;
    assert_eq!(cues.len(), 2, "missing item id must preserve both cue rows");
    assert!(cues.iter().any(|cue| cue.cue_id == native_cue_id && cue.committed));
}

/// Production regression: a long idle after the previous commit must not make
/// the first short fragment of a new turn immediately satisfy the turn ceiling.
#[test]
fn replay_long_idle_then_new_audio_starts_a_fresh_commit_timer() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    let mut slice = WorkerSlice::new();
    slice.last_commit_time = backdated(MANUAL_COMMIT_INTERVAL_SECS + 10);
    slice.manual_turn_started_at = Some(SystemTime::now());
    slice.sent_audio_since_commit = true;
    slice.manual_turn_audio_after_response = true;
    slice.audio_samples_since_commit = MANUAL_COMMIT_MIN_AUDIO_SAMPLES;

    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Idle], harness.shared.clone());
    let _socket = harness.tick(socket, &mut slice);

    assert!(
        !harness
            .sent_types()
            .iter()
            .any(|kind| kind == "input_audio_buffer.commit"),
        "the next turn must age from its own first successful audible append",
    );
}

/// Exact Flash failure family: after a completed turn only a short tail was
/// appended, then the timer fired and the provider rejected the tiny buffer.
#[test]
fn replay_short_tail_never_arms_an_empty_manual_commit() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    let mut slice = WorkerSlice::new();
    slice.last_commit_time = backdated(MANUAL_COMMIT_INTERVAL_SECS + 1);
    slice.manual_turn_started_at = Some(backdated(MANUAL_COMMIT_INTERVAL_SECS + 1));
    slice.sent_audio_since_commit = true;
    slice.manual_turn_audio_after_response = true;
    // A real Flash run rejected this 300 ms tail as "buffer too small".
    slice.audio_samples_since_commit = 4_800;

    let socket = ScriptedRealtimeSocket::new(vec![ScriptStep::Idle], harness.shared.clone());
    let socket = harness.tick(socket, &mut slice);
    assert!(
        !harness
            .sent_types()
            .iter()
            .any(|kind| kind == "input_audio_buffer.commit"),
        "a 300 ms tail is below the observed provider commit minimum",
    );

    slice.audio_samples_since_commit = MANUAL_COMMIT_MIN_AUDIO_SAMPLES;
    let _socket = harness.tick(socket, &mut slice);
    assert_eq!(
        harness
            .sent_types()
            .iter()
            .filter(|kind| kind.as_str() == "input_audio_buffer.commit")
            .count(),
        1,
        "enough audio still commits without extending the one-second ceiling",
    );
}

/// Provider errors can arrive after `response.done` has released the active
/// cue. Replaying that production ordering must still preserve both errors in
/// the Watch report, including the `error.type` fallback used by DashScope's
/// buffer-too-small event.
#[test]
fn replay_provider_errors_without_current_cue_are_kept_in_the_watch_report() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    harness
        .store()
        .watch_session_report
        .begin_or_reuse("provider-dashscope", "qwen3.5-omni-flash-realtime");
    let mut slice = WorkerSlice::new();
    assert!(slice.current_cue_id.is_none());
    let steps = vec![
        ScriptStep::Event(json!({
            "event_id": "event-internal",
            "type": "error",
            "error": {
                "code": "InternalError",
                "message": "Internal service error: null"
            }
        })),
        ScriptStep::Event(json!({
            "event_id": "event-small-buffer",
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": "Error committing input audio buffer: buffer too small, or have no audio."
            }
        })),
    ];
    let mut socket = ScriptedRealtimeSocket::new(steps, harness.shared.clone());
    for _ in 0..2 {
        socket = harness.tick(socket, &mut slice);
    }

    let report = harness
        .store()
        .watch_session_report
        .snapshot()
        .expect("watch report");
    assert!(report.cues.is_empty(), "session errors must not invent a cue");
    for expected_code in ["InternalError", "invalid_request_error"] {
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.code == expected_code)
            .expect("provider error must survive without cue correlation");
        assert_eq!(issue.category, "model");
        assert_eq!(issue.cue_id, None);
    }
    let details = report
        .events
        .iter()
        .filter(|event| event.kind == "provider-error")
        .filter_map(|event| event.detail.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(details.len(), 2);
    assert!(details
        .iter()
        .any(|detail| detail.contains("Internal service error: null")));
    assert!(details
        .iter()
        .any(|detail| detail.contains("buffer too small")));
}

/// A completed transcription starts the model response but must not release
/// the next manual commit until response.done. The production Flash ordering
/// previously overlapped response.create calls and ended in InternalError.
#[test]
fn replay_manual_gate_serializes_response_create_until_response_done() {
    let harness = ReplayHarness::new(RealtimeAudioMode::Manual, Vec::new());
    let mut slice = WorkerSlice::new();
    slice.manual_response_pending = true;
    slice.manual_response_item_id = Some("item-current".to_string());
    slice.sent_audio_since_commit = true;
    slice.manual_turn_audio_after_response = true;
    slice.audio_samples_since_commit = MANUAL_COMMIT_MIN_AUDIO_SAMPLES;
    slice.manual_turn_started_at = Some(backdated(MANUAL_COMMIT_INTERVAL_SECS + 1));

    let socket = ScriptedRealtimeSocket::new(
        vec![
            ScriptStep::Event(json!({
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "item-current",
                "transcript": "the current translated turn"
            })),
            ScriptStep::Event(json!({
                "type": "response.text.delta",
                "delta": "当前"
            })),
            ScriptStep::Event(json!({
                "type": "response.text.done",
                "text": "当前译文"
            })),
            ScriptStep::Event(json!({ "type": "response.done" })),
            ScriptStep::Idle,
        ],
        harness.shared.clone(),
    );

    let socket = harness.tick(socket, &mut slice);
    assert!(
        slice.manual_response_pending,
        "response.create keeps the manual gate closed until response.done"
    );
    assert_eq!(
        harness
            .sent_types()
            .iter()
            .filter(|kind| kind.as_str() == "response.create")
            .count(),
        1,
    );
    assert!(
        !harness
            .sent_types()
            .iter()
            .any(|kind| kind == "input_audio_buffer.commit"),
        "the buffered next turn must not overlap the active response",
    );

    let socket = harness.tick(socket, &mut slice);
    assert!(
        slice.manual_response_pending,
        "a text delta must not release the manual response gate"
    );
    assert!(!harness
        .sent_types()
        .iter()
        .any(|kind| kind == "input_audio_buffer.commit"));

    let socket = harness.tick(socket, &mut slice);
    assert!(
        slice.manual_response_pending,
        "response.text.done must still wait for response.done"
    );
    assert_eq!(slice.pending_translated_text, "当前译文");
    assert!(!harness
        .sent_types()
        .iter()
        .any(|kind| kind == "input_audio_buffer.commit"));

    let socket = harness.tick(socket, &mut slice);
    assert!(
        !slice.manual_response_pending,
        "response.done releases the next manual turn"
    );

    // The response handler deliberately closes the old post-response tail.
    // Model the next successful append before asking the coordinator to arm a
    // new commit; a response.done tick alone must never commit stale audio.
    slice.sent_audio_since_commit = true;
    slice.manual_turn_audio_after_response = true;
    slice.audio_samples_since_commit = MANUAL_COMMIT_MIN_AUDIO_SAMPLES;
    slice.manual_turn_started_at = Some(backdated(MANUAL_COMMIT_INTERVAL_SECS + 1));
    let _socket = harness.tick(socket, &mut slice);
    assert_eq!(
        harness
            .sent_types()
            .iter()
            .filter(|kind| kind.as_str() == "input_audio_buffer.commit")
            .count(),
        1,
        "the accumulated turn commits on the first tick after response.done",
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
