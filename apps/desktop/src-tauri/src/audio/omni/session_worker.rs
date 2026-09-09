use super::*;
use crate::audio::glossary::GlossaryContext;

use self::livetranslate_shutdown::LivetranslateShutdown;
use self::shutdown_failure::{
    terminalize_livetranslate_shutdown_failure, LivetranslateShutdownFailure,
};

#[path = "session_worker/start.rs"]
mod start;
pub(crate) use start::{start_omni, OmniHandle};
#[path = "session_worker/shutdown_failure.rs"]
mod shutdown_failure;
#[path = "session_worker/reconnect_reset.rs"]
mod reconnect_reset;
pub(super) use reconnect_reset::reset_manual_gate_after_reconnect;

struct OmniSessionWorker {
    app: AppHandle,
    config: OmniSessionConfig,
    readiness_tx: mpsc::Sender<Result<u64, String>>,
    readiness_sent: Arc<AtomicBool>,
    trace: ModelTraceRecorder,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
    stop_requested: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OmniWorkerShutdown {
    Immediate,
    LivetranslateSessionFinished,
}

fn should_discard_uncommitted_after_worker(
    result: &Result<OmniWorkerShutdown, String>,
) -> bool {
    !matches!(result, Ok(OmniWorkerShutdown::LivetranslateSessionFinished))
}

fn should_defer_manual_audio_for_response(
    uses_manual_commit: bool,
    manual_response_pending: bool,
    livetranslate_shutdown_requested: bool,
) -> bool {
    uses_manual_commit && manual_response_pending && !livetranslate_shutdown_requested
}

struct OmniSessionRuntime {
    current_cue_id: Option<String>,
    pending_source_text: String,
    pending_translated_text: String,
    buffer_size: u64,
    reconnect_count: usize,
    chunk_count: u64,
    sent_audio_since_commit: bool,
    audio_samples_since_commit: u64,
    manual_response_pending: bool,
    manual_response_requested: bool,
    manual_response_item_id: Option<String>,
    manual_response_released_at: Option<SystemTime>,
    manual_turn_audio_after_response: bool,
    last_vad_event_time: SystemTime,
    vad_event_count: u64,
    last_commit_time: SystemTime,
    manual_turn_started_at: Option<SystemTime>,
    manual_turn_started_during_playback: Option<bool>,
    st_skip_logged: bool,
    transcription_completed_flag: bool,
    transcription_completed_at: Option<SystemTime>,
    event_diagnostics: OmniEventDiagnostics,
    last_waiting_log_chunk_count: u64,
    pending_audio_delta_count: u64,
    pending_audio_delta_base64_bytes: u64,
    pending_audio_response_id: Option<String>,
    pending_audio_stream_cue_id: Option<String>,
    pending_audio_stream_chunk_index: u32,
    pending_audio_stream_created_at_ms: Option<u64>,
    pending_audio_stream_aborted: bool,
    session_ready_for_audio: bool,
    pre_session_audio_queue: VecDeque<Vec<u8>>,
    pre_session_audio_dropped: u64,
    silence_chunks_skipped: u64,
    silence_grace_chunks_sent: u32,
    has_sent_audible_audio: bool,
    total_input_chunks: u64,
    first_audible_chunk_ms: Option<u64>,
    total_silence_skipped_before_first_audible: u64,
    first_audio_sent_ms: Option<u64>,
    pending_audio_buffer: Vec<i16>,
}

impl OmniSessionRuntime {
    fn new() -> Self {
        Self {
            current_cue_id: None,
            pending_source_text: String::new(),
            pending_translated_text: String::new(),
            buffer_size: 0,
            reconnect_count: 0,
            chunk_count: 0,
            sent_audio_since_commit: false,
            audio_samples_since_commit: 0,
            manual_response_pending: false,
            manual_response_requested: false,
            manual_response_item_id: None,
            manual_response_released_at: None,
            manual_turn_audio_after_response: false,
            last_vad_event_time: SystemTime::now(),
            vad_event_count: 0,
            last_commit_time: SystemTime::now(),
            manual_turn_started_at: None,
            manual_turn_started_during_playback: None,
            st_skip_logged: false,
            transcription_completed_flag: false,
            transcription_completed_at: None,
            event_diagnostics: OmniEventDiagnostics::default(),
            last_waiting_log_chunk_count: 0,
            pending_audio_delta_count: 0,
            pending_audio_delta_base64_bytes: 0,
            pending_audio_response_id: None,
            pending_audio_stream_cue_id: None,
            pending_audio_stream_chunk_index: 0,
            pending_audio_stream_created_at_ms: None,
            pending_audio_stream_aborted: false,
            session_ready_for_audio: false,
            pre_session_audio_queue: VecDeque::new(),
            pre_session_audio_dropped: 0,
            silence_chunks_skipped: 0,
            silence_grace_chunks_sent: 0,
            has_sent_audible_audio: false,
            total_input_chunks: 0,
            first_audible_chunk_ms: None,
            total_silence_skipped_before_first_audible: 0,
            first_audio_sent_ms: None,
            pending_audio_buffer: Vec::new(),
        }
    }
}

impl OmniSessionWorker {
    fn run(self, store: &AudioStateStore) -> Result<OmniWorkerShutdown, String> {
        run_omni_worker(
            self.app,
            store,
            self.config.direction,
            self.config.session_generation,
            self.readiness_tx,
            self.readiness_sent,
            self.config.provider,
            self.config.voice,
            self.config.instructions,
            self.config.glossary,
            self.config.audio_mode,
            self.config.output_mode,
            self.config.source_language,
            self.config.target_language,
            self.config.subtitle_translate_active,
            self.config.speech_config,
            self.trace,
            self.audio_rx,
            self.stop_rx,
            self.stop_requested,
        )
    }
}

fn run_omni_worker(
    app: AppHandle,
    store: &AudioStateStore,
    direction: String,
    session_generation: u64,
    readiness_tx: mpsc::Sender<Result<u64, String>>,
    readiness_sent: Arc<AtomicBool>,
    provider: ProviderDraftInput,
    voice: String,
    instructions: String,
    glossary: GlossaryContext,
    audio_mode: RealtimeAudioMode,
    output_mode: OmniOutputMode,
    source_language: String,
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
    trace: ModelTraceRecorder,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
    stop_requested: Arc<AtomicBool>,
) -> Result<OmniWorkerShutdown, String> {
    let echo_guard_enabled = speech_config.echo_guard_enabled();
    // Strict diagnostic budget binding must be validated, and its ledger must
    // be exclusively created, before even the first provider connection.
    let mut provider_input_budget =
        ProviderInputBudget::from_env(&provider, &direction, session_generation)?;
    let mut provider_input_dump = ProviderInputPcmDump::from_env(
        &app,
        provider_input_budget.max_samples(),
        provider_input_budget.strict_paid_authority_enabled(),
    )?;
    let mut provider_input_prefilter_dump = ProviderInputPrefilterDump::from_provider_pcm_path(
        provider_input_dump.as_ref().map(|dump| dump.path.as_str()),
        provider_input_budget.strict_paid_authority_enabled(),
    )?;
    // Create the translated-PCM evidence directory before connecting to the
    // paid provider. A missing, stale, or non-exclusive authority path must
    // fail without consuming any provider input.
    let translated_pcm_authority = TranslatedPcmAuthority::from_env(
        &provider,
        &direction,
        session_generation,
    )?;
    let mut trace_call = trace.call("omni.websocket_session");
    trace_call.fail_on_drop(
        "omni provider worker exited without an explicit trace terminal result",
    );
    let connected = connect_initial_with_trace(&mut trace_call, |trace_call| {
        OmniConnectionCoordinator::connect_initial(
            &app,
            store,
            &direction,
            &provider,
            &voice,
            &instructions,
            audio_mode,
            output_mode,
            &source_language,
            &target_language,
            subtitle_translate_active,
            speech_config,
            &provider_input_budget,
            translated_pcm_authority,
            trace_call,
        )
    });
    let OmniConnectedSession {
        mut socket,
        session_update,
        session_started_at,
        mut active_voice,
        mut voice_fallback_applied,
        native_translation_reuse_active,
        playback_tx,
        mut playback_worker,
    } = connected?;
    let OmniSessionRuntime {
        mut current_cue_id,
        mut pending_source_text,
        mut pending_translated_text,
        mut buffer_size,
        mut reconnect_count,
        mut chunk_count,
        mut sent_audio_since_commit,
        mut audio_samples_since_commit,
        mut manual_response_pending,
        mut manual_response_requested,
        mut manual_response_item_id,
        mut manual_response_released_at,
        mut manual_turn_audio_after_response,
        mut last_vad_event_time,
        mut vad_event_count,
        mut last_commit_time,
        mut manual_turn_started_at,
        mut manual_turn_started_during_playback,
        mut st_skip_logged,
        mut transcription_completed_flag,
        mut transcription_completed_at,
        mut event_diagnostics,
        mut last_waiting_log_chunk_count,
        mut pending_audio_delta_count,
        mut pending_audio_delta_base64_bytes,
        mut pending_audio_response_id,
        mut pending_audio_stream_cue_id,
        mut pending_audio_stream_chunk_index,
        mut pending_audio_stream_created_at_ms,
        mut pending_audio_stream_aborted,
        mut session_ready_for_audio,
        mut pre_session_audio_queue,
        mut pre_session_audio_dropped,
        mut silence_chunks_skipped,
        mut silence_grace_chunks_sent,
        mut has_sent_audible_audio,
        mut total_input_chunks,
        mut first_audible_chunk_ms,
        mut total_silence_skipped_before_first_audible,
        mut first_audio_sent_ms,
        mut pending_audio_buffer,
    } = OmniSessionRuntime::new();
    let livetranslate_authority = if crate::audio::events::is_livetranslate_route_model(
        &provider,
        &provider.model,
    ) {
        match crate::audio::events::authorize_bailian_native_translate(&provider) {
            Ok(authority) => Some(authority),
            Err(error) => {
                let error = provider_input_budget.finalize_failure(
                    "livetranslate-authority-initialization-failed",
                    error,
                );
                let error = finalize_trace_error(
                    &mut trace_call,
                    Instant::now() + Duration::from_millis(300),
                    error,
                );
                let socket_result = socket
                    .close(None)
                    .map_err(|error| format!("socketTeardown={error}"));
                let playback_result = playback_worker.shutdown_gracefully();
                let snapshot_result = emit_audio_snapshot(&app, store);
                return Err(append_secondary_failure(
                    error,
                    combine_all_teardown_results(socket_result, playback_result, snapshot_result)
                        .err(),
                ));
            }
        }
    } else {
        None
    };
    if let Some(authority) = livetranslate_authority.as_ref() {
        if let Err(error) = event_diagnostics
            .livetranslate_server_state
            .record_client_session_update(authority, &session_update)
        {
            let error = provider_input_budget.finalize_failure(
                "livetranslate-initial-session-update-authority-invalid",
                error,
            );
            let error = finalize_trace_error(
                &mut trace_call,
                Instant::now() + Duration::from_millis(300),
                error,
            );
            let socket_result = socket
                .close(None)
                .map_err(|error| format!("socketTeardown={error}"));
            let playback_result = playback_worker.shutdown_gracefully();
            let snapshot_result = emit_audio_snapshot(&app, store);
            return Err(append_secondary_failure(
                error,
                combine_all_teardown_results(socket_result, playback_result, snapshot_result).err(),
            ));
        }
    }
    let mut livetranslate_shutdown = match LivetranslateShutdown::for_provider(&provider, stop_requested) {
        Ok(shutdown) => shutdown,
        Err(error) => {
            let error = provider_input_budget.finalize_failure(
                "livetranslate-shutdown-initialization-failed",
                error,
            );
            let error = finalize_trace_error(
                &mut trace_call,
                Instant::now() + Duration::from_millis(300),
                error,
            );
            let socket_result = socket
                .close(None)
                .map_err(|error| format!("socketTeardown={error}"));
            let playback_result = playback_worker.shutdown_gracefully();
            let snapshot_result = emit_audio_snapshot(&app, store);
            return Err(append_secondary_failure(
                error,
                combine_all_teardown_results(socket_result, playback_result, snapshot_result).err(),
            ));
        }
    };
    let mut audio_input_disconnected = false;
    let mut socket = livetranslate_shutdown.wrap_socket(socket);
    let connector = livetranslate_shutdown.wrap_connector(TungsteniteConnector);
    macro_rules! terminalize_livetranslate_shutdown {
        () => {{
            let native_cue_ids = event_diagnostics.unfinished_native_response_cue_ids();
            terminalize_livetranslate_shutdown_failure(LivetranslateShutdownFailure {
                store,
                direction: &direction,
                current_cue_id: current_cue_id.as_deref(),
                pending_source_text: &pending_source_text,
                native_cue_ids: &native_cue_ids,
                native_translation_reuse_active,
                playback_tx: &playback_tx,
                pending_audio_stream_cue_id: pending_audio_stream_cue_id.as_deref(),
                pending_audio_stream_chunk_index,
                pending_audio_stream_created_at_ms,
            });
        }};
    }
    macro_rules! fail_before_teardown {
        ($error:expr, $teardown:block) => {{
            let (error, teardown_result) = finalize_trace_error_before_teardown(
                &mut trace_call,
                livetranslate_shutdown.failure_evidence_deadline(Instant::now()),
                $error,
                || -> Result<(), String> { $teardown },
            );
            let secondary = teardown_result.err();
            let mut combined = append_secondary_failure(error, secondary.clone());
            if let Some(secondary) = secondary {
                let persistence = trace_call.persist_terminal_supplement(
                    "worker_teardown_failure",
                    json!({ "error": secondary }),
                    livetranslate_shutdown.failure_evidence_deadline(Instant::now()),
                );
                if !persistence.confirmed() {
                    combined = format!(
                        "{combined} | teardownTraceEvidenceFinalization={}",
                        persistence.detail()
                    );
                }
            }
            return Err(combined);
        }};
    }
    macro_rules! fail_connected {
        ($reason:expr, $error:expr) => {{
            let error = provider_input_budget.finalize_failure($reason, $error);
            fail_before_teardown!(error, {
                let socket = socket
                    .close()
                    .map_err(|error| format!("socketTeardown={error}"));
                let playback = playback_worker.shutdown_gracefully();
                let snapshot = emit_audio_snapshot(&app, store);
                combine_all_teardown_results(socket, playback, snapshot)
            });
        }};
    }
    macro_rules! complete_before_teardown {
        ($outcome:expr, $teardown:block) => {{
            let completion = provider_input_budget
                .finalize("worker-completed")
                .map(|()| $outcome);
            return finalize_worker_trace_before_teardown(
                &mut trace_call,
                &livetranslate_shutdown,
                completion,
                || -> Result<(), String> {
                    $teardown
                    Ok(())
                },
            );
        }};
    }
    let worker_result = (|| -> Result<OmniWorkerShutdown, String> {
    loop {
        if stop_rx.try_recv().is_ok() {
            if livetranslate_shutdown.request(Instant::now()) {
                let _ = diag_log(
                    &app,
                    "omni",
                    "info",
                    "event=livetranslate_shutdown action=drain_audio_before_session_finish",
                );
            } else {
                store.set_stt_connected(false, buffer_size);
                let _ = diag_log(
                    &app,
                    "omni",
                    "info",
                    format!(
                        "[STOP] Omni worker 已停止, 共发送 {} 个音频块, {} 字节",
                        chunk_count, buffer_size
                    ),
                );
                check_vad_warning(
                    &app,
                    audio_mode,
                    &last_vad_event_time,
                    chunk_count,
                    vad_event_count,
                    buffer_size,
                );
                // In-flight deferred cues can never be approved once the worker
                // stops; flush them with the same semantics as a gate timeout so
                // the overlay does not keep cues the subtitle worker skips forever.
                for cue_id in store.discard_expired_deferred_subtitle_cues(Duration::ZERO) {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "event=manual_response_gate action=discard_deferred_on_stop cueId={cue_id}"
                        ),
                    );
                }
                // A stopped realtime session cannot produce another response for
                // its live tail. Remove only this route's unfinished cues so the
                // queue does not keep showing a terminal session as translating.
                if store.is_current_omni_session(&direction, session_generation) {
                    store.discard_uncommitted_subtitle_cues_by_direction(&direction);
                }
                complete_before_teardown!(OmniWorkerShutdown::Immediate, {
                    let socket_result = socket
                        .close()
                        .map_err(|error| format!("socketTeardown={error}"));
                    let playback_result = playback_worker.shutdown_gracefully();
                    let snapshot_result = emit_audio_snapshot(&app, store);
                    combine_all_teardown_results(
                        socket_result,
                        playback_result,
                        snapshot_result,
                    )?;
                });
            }
        }
        let now = Instant::now();
        if livetranslate_shutdown.take_evidence_queue_deadline(now) {
            trace_call.queue_pending_audio_evidence();
        }
        if let Some((reason, error)) = livetranslate_shutdown.deadline_error(now) {
            let error = provider_input_budget.finalize_failure(reason, error);
            let _ = diag_log(
                &app,
                "omni",
                "error",
                format!("event=livetranslate_shutdown action=fail_closed reason={reason} error={error}"),
            );
            fail_before_teardown!(error, {
                terminalize_livetranslate_shutdown!();
                let socket_result = socket
                    .close()
                    .map_err(|error| format!("socketTeardown={error}"));
                let playback = playback_worker.shutdown_gracefully();
                let snapshot = emit_audio_snapshot(&app, store);
                combine_all_teardown_results(socket_result, playback, snapshot)
            });
        }

        let pump_state = OmniAudioPump::new(OmniAudioPumpState {
            buffer_size,
            reconnect_count,
            chunk_count,
            sent_audio_since_commit,
            audio_samples_since_commit,
            manual_turn_audio_after_response,
            manual_turn_started_at,
            manual_turn_started_during_playback,
            session_ready_for_audio,
            pre_session_audio_queue,
            pre_session_audio_dropped,
            silence_chunks_skipped,
            silence_grace_chunks_sent,
            has_sent_audible_audio,
            total_input_chunks,
            first_audible_chunk_ms,
            total_silence_skipped_before_first_audible,
            first_audio_sent_ms,
            pending_audio_buffer,
            provider_input_prefilter_dump,
            provider_input_dump,
            provider_input_budget,
            audio_input_disconnected,
            chunks_sent_this_tick: 0,
            socket_reconnected: false,
            reconnected_session_update: None,
        })
        .pump(
            &connector,
            &app,
            store,
            &audio_rx,
            &mut socket,
            &mut trace_call,
            &provider,
            &active_voice,
            &instructions,
            audio_mode,
            output_mode,
            &source_language,
            &target_language,
            &session_started_at,
            should_defer_manual_audio_for_response(
                audio_mode.uses_manual_commit(),
                manual_response_pending,
                livetranslate_shutdown.is_requested(),
            ),
            livetranslate_shutdown.is_requested(),
        );
        let pump_state = match pump_state {
            Ok(state) => state,
            Err(error) if livetranslate_shutdown.is_requested() => {
                let _ = diag_log(
                    &app,
                    "omni",
                    "error",
                    "event=livetranslate_shutdown action=fail_closed reason=write_failed",
                );
                fail_before_teardown!(
                    format!(
                        "LiveTranslate fail-closed while draining the existing session: {error}"
                    ),
                    {
                        terminalize_livetranslate_shutdown!();
                        let socket_result = socket
                            .close()
                            .map_err(|error| format!("socketTeardown={error}"));
                        let playback = playback_worker.shutdown_gracefully();
                        let snapshot = emit_audio_snapshot(&app, store);
                        combine_all_teardown_results(socket_result, playback, snapshot)
                    }
                );
            }
            Err(error) => return Err(error),
        };
        let pump_socket_reconnected = pump_state.socket_reconnected;
        let pump_reconnected_session_update = pump_state.reconnected_session_update;
        buffer_size = pump_state.buffer_size;
        reconnect_count = pump_state.reconnect_count;
        chunk_count = pump_state.chunk_count;
        sent_audio_since_commit = pump_state.sent_audio_since_commit;
        audio_samples_since_commit = pump_state.audio_samples_since_commit;
        manual_turn_audio_after_response = pump_state.manual_turn_audio_after_response;
        manual_turn_started_at = pump_state.manual_turn_started_at;
        manual_turn_started_during_playback = pump_state.manual_turn_started_during_playback;
        session_ready_for_audio = pump_state.session_ready_for_audio;
        pre_session_audio_queue = pump_state.pre_session_audio_queue;
        pre_session_audio_dropped = pump_state.pre_session_audio_dropped;
        silence_chunks_skipped = pump_state.silence_chunks_skipped;
        silence_grace_chunks_sent = pump_state.silence_grace_chunks_sent;
        has_sent_audible_audio = pump_state.has_sent_audible_audio;
        total_input_chunks = pump_state.total_input_chunks;
        first_audible_chunk_ms = pump_state.first_audible_chunk_ms;
        total_silence_skipped_before_first_audible =
            pump_state.total_silence_skipped_before_first_audible;
        first_audio_sent_ms = pump_state.first_audio_sent_ms;
        pending_audio_buffer = pump_state.pending_audio_buffer;
        provider_input_prefilter_dump = pump_state.provider_input_prefilter_dump;
        provider_input_dump = pump_state.provider_input_dump;
        provider_input_budget = pump_state.provider_input_budget;
        audio_input_disconnected = pump_state.audio_input_disconnected;
        let chunks_sent_this_tick = pump_state.chunks_sent_this_tick;
        let should_send_livetranslate_finish = livetranslate_shutdown.should_send_finish(
            chunks_sent_this_tick,
            pre_session_audio_queue.is_empty(),
            audio_input_disconnected,
        );
        let should_send_livetranslate_finish = match should_send_livetranslate_finish {
            Ok(value) => value,
            Err(error) => {
                let error = provider_input_budget.finalize_failure(
                    "livetranslate-session-finished-before-finish",
                    error,
                );
                fail_before_teardown!(error, {
                    terminalize_livetranslate_shutdown!();
                    let socket = socket
                        .close()
                        .map_err(|error| format!("socketTeardown={error}"));
                    let playback = playback_worker.shutdown_gracefully();
                    let snapshot = emit_audio_snapshot(&app, store);
                    combine_all_teardown_results(socket, playback, snapshot)
                });
            }
        };
        if should_send_livetranslate_finish {
            let finish_event = livetranslate_shutdown.finish_event(&format!(
                "event_session_finish_{}",
                unix_ms()
            ));
            if let Err(error) = event_diagnostics
                .livetranslate_server_state
                .record_client_finish()
            {
                let error = provider_input_budget.finalize_failure(
                    "livetranslate-client-finish-state-invalid",
                    error,
                );
                fail_before_teardown!(error, {
                    terminalize_livetranslate_shutdown!();
                    let socket_result = socket
                        .close()
                        .map_err(|error| format!("socketTeardown={error}"));
                    let playback = playback_worker.shutdown_gracefully();
                    let snapshot = emit_audio_snapshot(&app, store);
                    combine_all_teardown_results(socket_result, playback, snapshot)
                });
            }
            trace_call.record_ws_send("session.finish", finish_event.clone());
            if let Err(error) = socket.send_message(Message::Text(
                finish_event.to_string().into(),
            )) {
                let error = provider_input_budget.finalize_failure(
                    "livetranslate-session-finish-send-failed",
                    format!(
                        "LiveTranslate fail-closed: session.finish send failed on the existing socket: {error}"
                    ),
                );
                let _ = diag_log(
                    &app,
                    "omni",
                    "error",
                    format!(
                        "event=livetranslate_shutdown action=fail_closed reason=session_finish_send_failed error={error}"
                    ),
                );
                fail_before_teardown!(error, {
                    terminalize_livetranslate_shutdown!();
                    let socket = socket
                        .close()
                        .map_err(|error| format!("socketTeardown={error}"));
                    let playback = playback_worker.shutdown_gracefully();
                    let snapshot = emit_audio_snapshot(&app, store);
                    combine_all_teardown_results(socket, playback, snapshot)
                });
            }
            if direction == "inbound" {
                if let Err(error) = store.record_strict_watch_session_finish_sent() {
                    let error = provider_input_budget.finalize_failure(
                        "livetranslate-session-finish-authority-invalid",
                        error,
                    );
                    fail_before_teardown!(error, {
                        terminalize_livetranslate_shutdown!();
                        let socket = socket
                            .close()
                            .map_err(|error| format!("socketTeardown={error}"));
                        let playback = playback_worker.shutdown_gracefully();
                        let snapshot = emit_audio_snapshot(&app, store);
                        combine_all_teardown_results(socket, playback, snapshot)
                    });
                }
            }
            livetranslate_shutdown.record_finish_sent(Instant::now());
            playback_worker.begin_provider_finishing();
            let _ = diag_log(
                &app,
                "omni",
                "info",
                "event=livetranslate_shutdown action=session_finish_sent awaiting=session.finished",
            );
        }
        // Both the pre-pump and post-poll reconnect paths must reset the exact
        // same manual-gate/turn/pre-session-audio locals. A local macro keeps
        // that 18-argument call in one place without threading the locals
        // through a helper struct across the whole pump loop.
        macro_rules! reset_gate_after_reconnect {
            ($sent_session_update:expr) => {{
                let sent_session_update = ($sent_session_update).ok_or_else(|| {
                    "Omni reconnect invariant violated: replacement socket lacks exact sent session.update provenance"
                        .to_string()
                })?;
                event_diagnostics
                    .livetranslate_server_state
                    .reset_for_reconnect();
                if let Some(authority) = livetranslate_authority.as_ref() {
                    event_diagnostics
                        .livetranslate_server_state
                        .record_client_session_update(authority, sent_session_update)?;
                }
                if let Some(cue_id) = pending_audio_stream_cue_id.as_deref() {
                    playback_tx.abort_stream(
                        cue_id,
                        pending_audio_stream_chunk_index,
                        pending_audio_stream_created_at_ms.unwrap_or_else(unix_ms),
                    );
                }
                reset_manual_gate_after_reconnect(
                    &app,
                    store,
                    audio_mode,
                    &mut manual_response_pending,
                    &mut manual_response_requested,
                    &mut manual_response_item_id,
                    &mut sent_audio_since_commit,
                    &mut audio_samples_since_commit,
                    &mut manual_turn_audio_after_response,
                    &mut last_commit_time,
                    &mut manual_turn_started_at,
                    &mut manual_turn_started_during_playback,
                    &mut current_cue_id,
                    &mut pending_source_text,
                    &mut pending_translated_text,
                    &mut transcription_completed_flag,
                    &mut transcription_completed_at,
                    &mut event_diagnostics,
                    &mut pending_audio_buffer,
                    &mut pending_audio_delta_count,
                    &mut pending_audio_delta_base64_bytes,
                    &mut pending_audio_response_id,
                    &mut pending_audio_stream_cue_id,
                    &mut pending_audio_stream_chunk_index,
                    &mut pending_audio_stream_created_at_ms,
                    &mut pending_audio_stream_aborted,
                    &mut session_ready_for_audio,
                )
            }};
        }
        if pump_socket_reconnected {
            let reset = (|| -> Result<(), String> {
                reset_gate_after_reconnect!(pump_reconnected_session_update.as_ref());
                Ok(())
            })();
            if let Err(error) = reset {
                fail_connected!("reconnect-session-update-invalid", error);
            }
        }

        OmniAudioPump::log_waiting_if_needed(
            &app,
            chunk_count,
            chunks_sent_this_tick,
            &mut last_waiting_log_chunk_count,
        );

        let pending_manual_audio_origin_ms =
            audio_origin::manual_origin_ms(manual_turn_started_at.as_ref(), &session_started_at);
        let commit_state = OmniConnectionCoordinator::maintain_manual_commit(
            OmniCommitState {
                last_commit_time,
                manual_turn_started_at,
                manual_turn_started_during_playback,
                sent_audio_since_commit,
                audio_samples_since_commit,
                manual_turn_audio_after_response,
                manual_response_pending,
                manual_response_requested,
                manual_response_item_id,
                manual_response_released_at,
                manual_turn_timed_out: false,
                committed_source_started_during_playback: None,
            },
            &app,
            &mut socket,
            &mut trace_call,
            audio_mode,
            chunk_count,
            silence_grace_chunks_sent >= OMNI_ASR_SILENCE_GRACE_CHUNKS,
            &session_started_at,
            &event_diagnostics,
        );
        last_commit_time = commit_state.last_commit_time;
        manual_turn_started_at = commit_state.manual_turn_started_at;
        manual_turn_started_during_playback = commit_state.manual_turn_started_during_playback;
        sent_audio_since_commit = commit_state.sent_audio_since_commit;
        audio_samples_since_commit = commit_state.audio_samples_since_commit;
        manual_turn_audio_after_response = commit_state.manual_turn_audio_after_response;
        manual_response_pending = commit_state.manual_response_pending;
        manual_response_requested = commit_state.manual_response_requested;
        manual_response_item_id = commit_state.manual_response_item_id;
        manual_response_released_at = commit_state.manual_response_released_at;
        audio_origin::record_committed_manual_source_segment(
            &app, store, pending_manual_audio_origin_ms,
            commit_state.committed_source_started_during_playback,
            &session_started_at, &mut event_diagnostics,
        );
        if commit_state.manual_turn_timed_out {
            // A timed-out turn never issued response.create; buffered output
            // and, in native-reuse/audio-only modes, `current_cue_id` may still
            // belong to a previous turn's streaming response. Only reset the
            // input side; output state resets at response.done / audio.done.
            let response_stream_active = manual_turn_response_stream_active(
                pending_audio_delta_count,
                pending_audio_buffer.len(),
                pending_audio_response_id.as_deref(),
                &pending_translated_text,
            );
            if !response_stream_owns_current_cue(
                response_stream_active,
                subtitle_translate_active,
                native_translation_reuse_active,
            ) {
                if let Some(cue_id) = current_cue_id.as_deref() {
                    store.discard_uncommitted_subtitle_cue(cue_id);
                }
                reset_manual_turn_input_state(
                    &mut current_cue_id,
                    &mut pending_source_text,
                    &mut transcription_completed_flag,
                    &mut transcription_completed_at,
                    &mut event_diagnostics,
                );
            }
        }

        OmniEventProcessor::expire_stale_transcription(
            &app,
            &mut transcription_completed_flag,
            &mut transcription_completed_at,
        );

        // Deferred secondary-translation entries strand when their manual turn
        // can no longer be adjudicated (missing completed item ids, reconnects,
        // released `current_cue_id`); age them out so the overlay does not keep
        // cues the subtitle worker skips forever.
        for cue_id in store.discard_expired_deferred_subtitle_cues(Duration::from_secs(
            MANUAL_RESPONSE_TIMEOUT_SECS,
        )) {
            let _ = diag_log(
                &app,
                "omni",
                "warning",
                format!(
                    "event=manual_response_gate action=discard_stale_deferred_cue cueId={cue_id}"
                ),
            );
        }

        let shutdown_failure_tail = livetranslate_shutdown.is_requested().then(|| {
            (
                event_diagnostics.unfinished_native_response_cue_ids(),
                current_cue_id.clone(),
                pending_source_text.clone(),
                pending_audio_stream_cue_id.clone(),
                pending_audio_stream_chunk_index,
                pending_audio_stream_created_at_ms,
            )
        });

        let poll = OmniSocketEventProcessor::poll(
            OmniSocketEventState {
                socket,
                reconnect_count,
                pending_audio_buffer,
                active_voice,
                voice_fallback_applied,
                session_ready_for_audio,
                event_diagnostics,
                current_cue_id,
                pending_source_text,
                pending_translated_text,
                st_skip_logged,
                pending_audio_delta_count,
                pending_audio_delta_base64_bytes,
                pending_audio_response_id,
                pending_audio_stream_cue_id,
                pending_audio_stream_chunk_index,
                pending_audio_stream_created_at_ms,
                pending_audio_stream_aborted,
                last_vad_event_time,
                vad_event_count,
                transcription_completed_flag,
                transcription_completed_at,
                manual_response_pending,
                manual_response_requested,
                manual_response_item_id,
                manual_response_released_at,
                sent_audio_since_commit,
                audio_samples_since_commit,
                manual_turn_audio_after_response,
            },
            &mut trace_call,
            OmniSocketEventContext {
                app: &app,
                store,
                direction: &direction,
                session_generation,
                session_started_at: &session_started_at,
                subtitle_translate_active,
                native_translation_reuse_active,
                total_input_chunks,
                first_audio_sent_ms,
                first_audible_chunk_ms,
                chunk_count,
                total_silence_skipped_before_first_audible,
                playback_tx: &playback_tx,
                readiness_sent: readiness_sent.as_ref(),
                readiness_tx: &readiness_tx,
                provider: &provider,
                provider_input_budget: &provider_input_budget,
                instructions: &instructions,
                glossary: &glossary,
                audio_mode,
                output_mode,
                source_language: &source_language,
                target_language: &target_language,
                buffer_size,
                pre_session_audio_queue_len: pre_session_audio_queue.len(),
                pre_session_audio_dropped,
                echo_guard_enabled,
            },
            &connector,
        );
        let poll = match poll {
            Ok(poll) => poll,
            Err(error) if livetranslate_shutdown.is_requested() => {
                let error = provider_input_budget.finalize_failure(
                    "livetranslate-shutdown-poll-failed",
                    format!(
                        "LiveTranslate fail-closed while awaiting session.finished on the existing socket: {error}"
                    ),
                );
                let _ = diag_log(
                    &app,
                    "omni",
                    "error",
                    "event=livetranslate_shutdown action=fail_closed reason=poll_failed",
                );
                fail_before_teardown!(error, {
                    if let Some((
                        native_cue_ids,
                        shutdown_cue_id,
                        shutdown_source_text,
                        shutdown_audio_cue_id,
                        shutdown_audio_chunk_index,
                        shutdown_audio_created_at_ms,
                    )) = shutdown_failure_tail.as_ref()
                    {
                        terminalize_livetranslate_shutdown_failure(
                            LivetranslateShutdownFailure {
                                store,
                                direction: &direction,
                                current_cue_id: shutdown_cue_id.as_deref(),
                                pending_source_text: shutdown_source_text,
                                native_cue_ids,
                                native_translation_reuse_active,
                                playback_tx: &playback_tx,
                                pending_audio_stream_cue_id: shutdown_audio_cue_id.as_deref(),
                                pending_audio_stream_chunk_index: *shutdown_audio_chunk_index,
                                pending_audio_stream_created_at_ms: *shutdown_audio_created_at_ms,
                            },
                        );
                    }
                    let playback = playback_worker.shutdown_gracefully();
                    let snapshot = emit_audio_snapshot(&app, store);
                    combine_teardown_results(playback, snapshot)
                });
            }
            Err(error) => {
                let error = provider_input_budget.finalize_failure("socket-poll-failed", error);
                fail_before_teardown!(error, {
                    let playback = playback_worker.shutdown_gracefully();
                    let snapshot = emit_audio_snapshot(&app, store);
                    combine_teardown_results(playback, snapshot)
                });
            }
        };
        let poll_socket_reconnected = poll.socket_reconnected;
        let poll_reconnected_session_update = poll.reconnected_session_update;
        socket = poll.state.socket;
        reconnect_count = poll.state.reconnect_count;
        pending_audio_buffer = poll.state.pending_audio_buffer;
        active_voice = poll.state.active_voice;
        voice_fallback_applied = poll.state.voice_fallback_applied;
        session_ready_for_audio = poll.state.session_ready_for_audio;
        event_diagnostics = poll.state.event_diagnostics;
        current_cue_id = poll.state.current_cue_id;
        pending_source_text = poll.state.pending_source_text;
        pending_translated_text = poll.state.pending_translated_text;
        st_skip_logged = poll.state.st_skip_logged;
        pending_audio_delta_count = poll.state.pending_audio_delta_count;
        pending_audio_delta_base64_bytes = poll.state.pending_audio_delta_base64_bytes;
        pending_audio_response_id = poll.state.pending_audio_response_id;
        pending_audio_stream_cue_id = poll.state.pending_audio_stream_cue_id;
        pending_audio_stream_chunk_index = poll.state.pending_audio_stream_chunk_index;
        pending_audio_stream_created_at_ms = poll.state.pending_audio_stream_created_at_ms;
        pending_audio_stream_aborted = poll.state.pending_audio_stream_aborted;
        last_vad_event_time = poll.state.last_vad_event_time;
        vad_event_count = poll.state.vad_event_count;
        transcription_completed_flag = poll.state.transcription_completed_flag;
        transcription_completed_at = poll.state.transcription_completed_at;
        manual_response_pending = poll.state.manual_response_pending;
        manual_response_requested = poll.state.manual_response_requested;
        manual_response_item_id = poll.state.manual_response_item_id;
        manual_response_released_at = poll.state.manual_response_released_at;
        sent_audio_since_commit = poll.state.sent_audio_since_commit;
        audio_samples_since_commit = poll.state.audio_samples_since_commit;
        manual_turn_audio_after_response = poll.state.manual_turn_audio_after_response;
        if poll_socket_reconnected {
            if let Err(error) = provider_input_budget.record_reconnect() {
                fail_connected!("provider-input-budget-reconnect-record-failed", error);
            }
            let reset = (|| -> Result<(), String> {
                reset_gate_after_reconnect!(poll_reconnected_session_update.as_ref());
                Ok(())
            })();
            if let Err(error) = reset {
                fail_connected!("reconnect-session-update-invalid", error);
            }
        }
        if livetranslate_shutdown.session_finished_received() {
            if direction == "inbound" {
                if let Err(error) = store.record_strict_watch_session_finished_received() {
                    fail_connected!("livetranslate-session-finished-authority-invalid", error);
                }
            }
            store.set_stt_connected(false, buffer_size);
            let _ = diag_log(
                &app,
                "omni",
                "info",
                format!(
                    "event=livetranslate_shutdown action=session_finished_received sentAudioChunks={chunk_count} sentAudioBytes={buffer_size}"
                ),
            );
            check_vad_warning(
                &app,
                audio_mode,
                &last_vad_event_time,
                chunk_count,
                vad_event_count,
                buffer_size,
            );
            // `session.finished` is ordered after the provider's final ASR and
            // translation events. Those events were passed through the normal
            // processor above; do not apply the immediate-stop discard policy
            // here, because a final cue may intentionally remain visible as
            // incomplete evidence rather than being silently erased.
            complete_before_teardown!(OmniWorkerShutdown::LivetranslateSessionFinished, {
                let socket = socket
                    .close()
                    .map_err(|error| format!("socketTeardown={error}"));
                let playback = playback_worker.shutdown_gracefully();
                let snapshot = emit_audio_snapshot(&app, store);
                combine_all_teardown_results(socket, playback, snapshot)?;
            });
        }
        if poll.stop_worker {
            if livetranslate_shutdown.is_requested() {
                let error = provider_input_budget.finalize_failure(
                    "livetranslate-session-ended-before-finished",
                    "LiveTranslate fail-closed: provider ended the session before session.finished"
                        .to_string(),
                );
                fail_before_teardown!(error, {
                    terminalize_livetranslate_shutdown!();
                    let socket = socket
                        .close()
                        .map_err(|error| format!("socketTeardown={error}"));
                    let playback = playback_worker.shutdown_gracefully();
                    let snapshot = emit_audio_snapshot(&app, store);
                    combine_all_teardown_results(socket, playback, snapshot)
                });
            }
            store.set_stt_connected(false, buffer_size);
            let _ = diag_log(
                &app,
                "omni",
                "info",
                format!(
                    "[PRECONNECT] parked Omni worker stopped after provider idle timeout, sentAudioChunks={chunk_count}"
                ),
            );
            complete_before_teardown!(OmniWorkerShutdown::Immediate, {
                let socket = socket
                    .close()
                    .map_err(|error| format!("socketTeardown={error}"));
                let playback = playback_worker.shutdown_gracefully();
                let snapshot = emit_audio_snapshot(&app, store);
                combine_all_teardown_results(socket, playback, snapshot)?;
            });
        }
        if poll.skip_tick {
            continue;
        }
        if check_vad_warning(
            &app,
            audio_mode,
            &last_vad_event_time,
            chunk_count,
            vad_event_count,
            buffer_size,
        ) {
            last_vad_event_time = SystemTime::now();
        }
        if let Err(error) = emit_audio_snapshot(&app, store) {
            fail_connected!("audio-snapshot-emission-failed", error);
        }
        livetranslate_shutdown.pace_tick(thread::sleep, thread::yield_now);
    }

    })();
    finalize_worker_trace(&mut trace_call, &livetranslate_shutdown, worker_result)
}

fn finalize_worker_trace<R: tauri::Runtime>(
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    livetranslate_shutdown: &LivetranslateShutdown,
    result: Result<OmniWorkerShutdown, String>,
) -> Result<OmniWorkerShutdown, String> {
    match result {
        Ok(outcome) => {
            let deadline = livetranslate_shutdown.failure_evidence_deadline(Instant::now());
            let persistence = trace_call.end_and_flush(deadline);
            if persistence.confirmed() {
                Ok(outcome)
            } else {
                Err(with_trace_evidence_details(
                    "Omni provider worker completed without confirmed terminal trace evidence"
                        .to_string(),
                    persistence,
                ))
            }
        }
        Err(error) => {
            let deadline = livetranslate_shutdown.failure_evidence_deadline(Instant::now());
            Err(finalize_trace_error(trace_call, deadline, error))
        }
    }
}

fn finalize_worker_trace_before_teardown<R: tauri::Runtime>(
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    livetranslate_shutdown: &LivetranslateShutdown,
    result: Result<OmniWorkerShutdown, String>,
    teardown: impl FnOnce() -> Result<(), String>,
) -> Result<OmniWorkerShutdown, String> {
    let completion = finalize_worker_trace(trace_call, livetranslate_shutdown, result);
    let teardown_result = teardown();
    let Err(teardown_error) = teardown_result else {
        return completion;
    };
    let persistence = trace_call.persist_terminal_supplement(
        "worker_teardown_failure",
        json!({ "error": teardown_error }),
        livetranslate_shutdown.failure_evidence_deadline(Instant::now()),
    );
    let teardown_error = if persistence.confirmed() {
        teardown_error
    } else {
        format!(
            "{teardown_error} | teardownTraceEvidenceFinalization={}",
            persistence.detail()
        )
    };
    match completion {
        Ok(_) => Err(teardown_error),
        Err(primary) => Err(append_secondary_failure(primary, Some(teardown_error))),
    }
}

fn connect_initial_with_trace<R: tauri::Runtime, T>(
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    connect: impl FnOnce(
        &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    ) -> Result<T, String>,
) -> Result<T, String> {
    connect(trace_call).map_err(|error| {
        finalize_trace_error(
            trace_call,
            Instant::now() + Duration::from_millis(300),
            error,
        )
    })
}

fn finalize_trace_error<R: tauri::Runtime>(
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    deadline: Instant,
    error: String,
) -> String {
    let persistence = trace_call.error_and_flush(error.clone(), deadline);
    if persistence.confirmed() {
        error
    } else {
        with_trace_evidence_details(error, persistence)
    }
}

fn finalize_trace_error_before_teardown<R: tauri::Runtime, T>(
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    deadline: Instant,
    error: String,
    teardown: impl FnOnce() -> T,
) -> (String, T) {
    let error = finalize_trace_error(trace_call, deadline, error);
    (error, teardown())
}

fn combine_teardown_results(
    playback: Result<(), String>,
    snapshot: Result<(), String>,
) -> Result<(), String> {
    match (playback, snapshot) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(playback), Err(snapshot)) => Err(format!(
            "playbackTeardown={playback}; snapshotTeardown={snapshot}"
        )),
    }
}

fn combine_all_teardown_results(
    socket: Result<(), String>,
    playback: Result<(), String>,
    snapshot: Result<(), String>,
) -> Result<(), String> {
    let failures = [socket.err(), playback.err(), snapshot.err()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn append_secondary_failure(primary: String, secondary: Option<String>) -> String {
    let Some(secondary) = secondary else { return primary; };
    let (message, code, recommended) = super::session_errors::split_error_markers(&primary);
    let mut combined = format!("{message} | secondaryTeardownFailure={secondary}");
    if let Some(code) = code {
        combined.push_str(super::session_errors::SESSION_ERROR_CODE_MARKER);
        combined.push_str(&code);
    }
    if let Some(recommended) = recommended {
        combined.push_str(super::session_errors::RECOMMENDED_ACTION_MARKER);
        combined.push_str(&recommended);
    }
    combined
}

fn with_trace_evidence_details(
    error: String,
    persistence: crate::diagnostics::model_trace::ModelTracePersistence,
) -> String {
    if error.contains("modelTraceEvidenceFinalization=") {
        return error;
    }
    let (message, code, recommended) = super::session_errors::split_error_markers(&error);
    let mut structured = format!(
        "{message} | details: modelTraceEvidenceFinalization=unacknowledged {}",
        persistence.detail()
    );
    if let Some(code) = code {
        structured.push_str(super::session_errors::SESSION_ERROR_CODE_MARKER);
        structured.push_str(&code);
    }
    if let Some(recommended) = recommended {
        structured.push_str(super::session_errors::RECOMMENDED_ACTION_MARKER);
        structured.push_str(&recommended);
    }
    structured
}

#[cfg(test)]
mod trace_finalizer_tests {
    use std::fs;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

    use tauri::Manager;

    use super::*;
    use crate::diagnostics::model_trace::{ModelTraceContext, ModelTraceRecorder};
    use crate::diagnostics::state::DiagnosticsStateStore;

    #[test]
    fn secondary_teardown_failure_preserves_primary_markers() {
        let primary = format!(
            "provider failed{}provider-code{}restart",
            super::super::session_errors::SESSION_ERROR_CODE_MARKER,
            super::super::session_errors::RECOMMENDED_ACTION_MARKER,
        );
        let combined = super::append_secondary_failure(
            primary,
            Some("playback join failed".to_string()),
        );
        assert!(combined.contains("provider failed"));
        assert!(combined.contains("secondaryTeardownFailure=playback join failed"));
        assert!(combined.contains("provider-code"));
        assert!(combined.contains("restart"));
    }

    #[test]
    fn failure_receipt_is_confirmed_before_blocking_teardown_begins() {
        let root = crate::diagnostics::test_support::temp_dir(
            "session-worker",
            "finalizer-before-teardown",
        );
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(DiagnosticsStateStore::new_with_root(root.to_string_lossy().to_string()));
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut trace_call = recorder.call("worker.failure.before-teardown");
        trace_call.fail_on_drop("unexpected exit");
        trace_call.record_ws_send(
            "input_audio_buffer.append",
            serde_json::json!({"type":"input_audio_buffer.append","resampledSamples":320}),
        );
        let teardown_started = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&teardown_started);
        let receipt_returned = Arc::new(AtomicBool::new(false));
        let receipt_observed = Arc::clone(&receipt_returned);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let deadline = Instant::now() + Duration::from_millis(300);
        trace_call.set_test_evidence_persister(move |records, actual_deadline| {
            assert_eq!(actual_deadline, deadline);
            assert_eq!(records.len(), 2, "real audio and terminal evidence must be generated");
            assert!(records.iter().any(|record| record.id.ends_with(":end")));
            let ids = records.iter().map(|record| record.id.clone()).collect();
            entered_tx.send(()).unwrap();
            release_rx.recv().expect("controller must release the receipt");
            receipt_returned.store(true, Ordering::SeqCst);
            ids
        });
        let controller = std::thread::spawn(move || {
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(!observed.load(Ordering::SeqCst), "teardown ran before receipt completion");
            release_tx.send(()).unwrap();
        });

        let (error, ()) = finalize_trace_error_before_teardown(
            &mut trace_call,
            deadline,
            "poll failed".to_string(),
            || {
                assert!(receipt_observed.load(Ordering::SeqCst));
                teardown_started.store(true, Ordering::SeqCst);
            },
        );
        controller.join().unwrap();
        // File visibility is checked separately from the controlled receipt.
        assert!(app.state::<DiagnosticsStateStore>().flush_logs());
        let content = fs::read_to_string(root.join("logs").join("app.log")).unwrap();
        assert!(content.contains("input_audio_buffer.append.summary"));
        assert!(content.contains("worker.failure.before-teardown end_call"));
        assert_eq!(error, "poll failed");
        assert!(teardown_started.load(Ordering::SeqCst));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn success_receipt_is_confirmed_before_blocking_teardown_begins() {
        let root = crate::diagnostics::test_support::temp_dir(
            "session-worker",
            "success-finalizer-before-teardown",
        );
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(DiagnosticsStateStore::new_with_root(root.to_string_lossy().to_string()));
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut trace_call = recorder.call("worker.success.before-teardown");
        trace_call.record_ws_send(
            "input_audio_buffer.append",
            serde_json::json!({"type":"input_audio_buffer.append","resampledSamples":320}),
        );
        let shutdown = LivetranslateShutdown::with_stop_signal(
            false,
            Arc::new(AtomicBool::new(false)),
        );
        let teardown_started = Arc::new(AtomicBool::new(false));
        let teardown_observed = Arc::clone(&teardown_started);
        let receipt_returned = Arc::new(AtomicBool::new(false));
        let receipt_observed = Arc::clone(&receipt_returned);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        trace_call.set_test_evidence_persister(move |records, deadline| {
            assert!(deadline > Instant::now());
            assert_eq!(records.len(), 2, "real audio and terminal evidence must be generated");
            assert!(records.iter().any(|record| record.id.ends_with(":end")));
            let ids = records.iter().map(|record| record.id.clone()).collect();
            entered_tx.send(()).unwrap();
            release_rx.recv().expect("controller must release the receipt");
            receipt_returned.store(true, Ordering::SeqCst);
            ids
        });
        let controller = std::thread::spawn(move || {
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(
                !teardown_observed.load(Ordering::SeqCst),
                "success teardown ran before receipt completion",
            );
            release_tx.send(()).unwrap();
        });

        let result = finalize_worker_trace_before_teardown(
            &mut trace_call,
            &shutdown,
            Ok(OmniWorkerShutdown::LivetranslateSessionFinished),
            || {
                assert!(receipt_observed.load(Ordering::SeqCst));
                teardown_started.store(true, Ordering::SeqCst);
                Ok(())
            },
        );
        controller.join().unwrap();
        assert!(matches!(result, Ok(OmniWorkerShutdown::LivetranslateSessionFinished)));
        assert!(teardown_started.load(Ordering::SeqCst));
        assert!(app.state::<DiagnosticsStateStore>().flush_logs());
        let content = fs::read_to_string(root.join("logs").join("app.log")).unwrap();
        assert!(content.contains("input_audio_buffer.append.summary"));
        assert!(content.contains("worker.success.before-teardown end_call"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn initialization_failure_is_finalized_by_the_outer_trace_owner() {
        let root = crate::diagnostics::test_support::temp_dir(
            "session-worker",
            "initialization-failure",
        );
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(DiagnosticsStateStore::new_with_root(root.to_string_lossy().to_string()));
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut trace_call = recorder.call("worker.initialization");
        trace_call.set_test_evidence_persister(|records, _| {
            assert_eq!(records.len(), 1);
            assert!(records[0].id.ends_with(":end"));
            assert!(records[0].line.contains("session.update initialization failed"));
            records.iter().map(|record| record.id.clone()).collect()
        });
        trace_call.fail_on_drop("initialization escaped without finalization");

        let result: Result<(), String> = connect_initial_with_trace(&mut trace_call, |_| {
            Err("session.update initialization failed".to_string())
        });
        assert_eq!(result.unwrap_err(), "session.update initialization failed");
        let snapshot = app.state::<DiagnosticsStateStore>().snapshot_base();
        assert_eq!(snapshot.model_trace_summary.failed_calls, 1);
        assert_eq!(snapshot.model_trace_summary.succeeded_calls, 0);
        assert!(app.state::<DiagnosticsStateStore>().flush_logs());
        let content = fs::read_to_string(root.join("logs").join("app.log")).unwrap();
        assert!(content.contains("worker.initialization end_call"));
        assert!(content.contains("session.update initialization failed"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_receipts_remain_failures_through_initialization_and_teardown() {
        for (audio_ack, end_ack) in [(false, true), (true, false), (false, false)] {
            let root = tempfile::tempdir().unwrap();
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            app.manage(DiagnosticsStateStore::new_with_root(root.path().to_string_lossy().to_string()));
            app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
            let recorder = ModelTraceRecorder::new(
                app.handle().clone(), ModelTraceContext::new("provider", "model", "omni"),
            );
            let mut call = recorder.call("worker.partial-receipt");
            let receipt_returned = Arc::new(AtomicBool::new(false));
            let observed = Arc::clone(&receipt_returned);
            call.set_test_evidence_persister(move |records, _| {
                assert_eq!(records.len(), 2);
                observed.store(true, Ordering::SeqCst);
                records.iter().filter(|record| {
                    if record.id.ends_with(":end") { end_ack } else { audio_ack }
                }).map(|record| record.id.clone()).collect()
            });
            let primary = "initialization failed | code: session.quota-exceeded | recommended: check-provider-quota";
            let result: Result<(), String> = connect_initial_with_trace(&mut call, |call| {
                call.record_ws_send("input_audio_buffer.append", json!({"resampledSamples":320}));
                Err(primary.to_string())
            });
            let expected = format!(
                "initialization failed | details: modelTraceEvidenceFinalization=unacknowledged traceSelected=true audioConfirmed={audio_ack} endConfirmed={end_ack} audioEvidenceOverflowed=false pendingAudioEvidenceCount={} | code: session.quota-exceeded | recommended: check-provider-quota",
                usize::from(!audio_ack),
            );
            assert_eq!(result.unwrap_err(), expected);
            call.set_test_evidence_persister(|_, _| panic!("late receipt must not replace first result"));
            let (error, teardown) = finalize_trace_error_before_teardown(
                &mut call, Instant::now(), primary.to_string(), || {
                    assert!(receipt_returned.load(Ordering::SeqCst));
                    Err::<(), _>("secondary teardown failure")
                },
            );
            assert_eq!(error, expected);
            assert_eq!(teardown.unwrap_err(), "secondary teardown failure");
            drop(call);
            let store = app.state::<DiagnosticsStateStore>();
            assert_eq!(store.snapshot_base().model_trace_summary.failed_calls, 1);
            assert_eq!(store.snapshot_base().model_trace_summary.succeeded_calls, 0);
            assert!(store.flush_logs());
            let content = fs::read_to_string(root.path().join("logs/app.log")).unwrap();
            assert!(content.contains("input_audio_buffer.append.summary"));
            assert!(content.contains("worker.partial-receipt end_call"));
        }
    }

    #[test]
    fn finalizer_failure_is_structured_without_replacing_original_error_markers() {
        let root = crate::diagnostics::test_support::temp_dir(
            "session-worker",
            "unwritable-finalizer",
        );
        fs::create_dir_all(&root).unwrap();
        let blocked_root = root.join("blocked-root");
        fs::write(&blocked_root, b"not a directory").unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(DiagnosticsStateStore::new_with_root(
            blocked_root.to_string_lossy().to_string(),
        ));
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut trace_call = recorder.call("worker.unmanaged-diagnostics");
        trace_call.fail_on_drop("unexpected exit");
        let original = "provider failed | code: session.quota-exceeded | recommended: check-provider-quota";
        let error = finalize_trace_error(
            &mut trace_call,
            Instant::now() + Duration::from_millis(20),
            original.to_string(),
        );
        let (message, code, recommended) = super::super::session_errors::split_error_markers(&error);
        assert!(message.contains("modelTraceEvidenceFinalization=unacknowledged"));
        assert_eq!(code.as_deref(), Some("session.quota-exceeded"));
        assert_eq!(recommended.as_deref(), Some("check-provider-quota"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn successful_worker_without_a_terminal_receipt_becomes_a_worker_failure() {
        let root = crate::diagnostics::test_support::temp_dir(
            "session-worker",
            "unwritable-success-terminal",
        );
        fs::create_dir_all(&root).unwrap();
        let blocked_root = root.join("blocked-root");
        fs::write(&blocked_root, b"not a directory").unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(DiagnosticsStateStore::new_with_root(
            blocked_root.to_string_lossy().to_string(),
        ));
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut trace_call = recorder.call("worker.success-without-receipt");
        let shutdown = LivetranslateShutdown::with_stop_signal(
            false,
            Arc::new(AtomicBool::new(false)),
        );
        let error = finalize_worker_trace(
            &mut trace_call,
            &shutdown,
            Ok(OmniWorkerShutdown::Immediate),
        )
        .unwrap_err();
        assert!(error.contains("completed without confirmed terminal trace evidence"));
        assert!(error.contains("modelTraceEvidenceFinalization=unacknowledged"));
        let snapshot = app.state::<DiagnosticsStateStore>().snapshot_base();
        assert_eq!(snapshot.model_trace_summary.failed_calls, 1);
        assert_eq!(snapshot.model_trace_summary.succeeded_calls, 0);
        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(test)]
#[path = "session_worker/reconnect_reset_tests.rs"]
mod reconnect_reset_tests;

#[path = "session_worker/livetranslate_shutdown.rs"]
mod livetranslate_shutdown;

#[path = "session_worker/reconnect.rs"]
mod reconnect;
pub(super) use reconnect::reconnect_socket;

#[path = "session_worker/reconnect_state.rs"]
mod reconnect_state;
pub(super) use reconnect_state::reset_session_state_after_reconnect;
