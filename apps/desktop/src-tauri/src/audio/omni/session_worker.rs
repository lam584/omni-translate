use super::*;

pub(crate) struct OmniHandle {
    pub stop_tx: mpsc::Sender<()>,
    #[allow(dead_code, reason = "join handle is retained for supervised shutdown on supported runners")]
    pub join_handle: JoinHandle<()>,
}

struct OmniSessionWorker {
    app: AppHandle,
    config: OmniSessionConfig,
    readiness_tx: mpsc::Sender<Result<u64, String>>,
    readiness_sent: Arc<AtomicBool>,
    trace: ModelTraceRecorder,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
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
    manual_response_item_id: Option<String>,
    last_vad_event_time: SystemTime,
    vad_event_count: u64,
    last_commit_time: SystemTime,
    manual_turn_started_at: Option<SystemTime>,
    st_skip_logged: bool,
    transcription_completed_flag: bool,
    transcription_completed_at: Option<SystemTime>,
    event_diagnostics: OmniEventDiagnostics,
    last_waiting_log_chunk_count: u64,
    pending_audio_delta_count: u64,
    pending_audio_delta_base64_bytes: u64,
    pending_audio_response_id: Option<String>,
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
            manual_response_item_id: None,
            last_vad_event_time: SystemTime::now(),
            vad_event_count: 0,
            last_commit_time: SystemTime::now(),
            manual_turn_started_at: None,
            st_skip_logged: false,
            transcription_completed_flag: false,
            transcription_completed_at: None,
            event_diagnostics: OmniEventDiagnostics::default(),
            last_waiting_log_chunk_count: 0,
            pending_audio_delta_count: 0,
            pending_audio_delta_base64_bytes: 0,
            pending_audio_response_id: None,
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
    fn run(self, store: &AudioStateStore) -> Result<(), String> {
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
            self.config.audio_mode,
            self.config.output_mode,
            self.config.target_language,
            self.config.subtitle_translate_active,
            self.config.speech_config,
            self.trace,
            self.audio_rx,
            self.stop_rx,
        )
    }
}

pub(crate) fn start_omni(
    app: AppHandle,
    store: &AudioStateStore,
    direction: String,
    session_generation: u64,
    provider: ProviderDraftInput,
    voice: String,
    instructions: String,
    audio_mode: RealtimeAudioMode,
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
) -> Result<
    (
        mpsc::Sender<Vec<u8>>,
        OmniHandle,
        mpsc::Receiver<Result<u64, String>>,
    ),
    String,
> {
    let output_mode = OmniOutputMode::from_speech_config(&speech_config);
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (readiness_tx, readiness_rx) = mpsc::channel::<Result<u64, String>>();
    let readiness_sent = Arc::new(AtomicBool::new(false));

    store.set_stt_connected(false, 0);
    let _ = diag_log_detail(
        &app,
        "omni",
        "info",
        "正在启动 Omni 实时翻译...",
        format!("model={} voice={}", provider.model, voice),
    );

    let app_handle = app.clone();
    let model = provider.model.clone();
    let worker_direction = direction.clone();
    let readiness_tx_for_worker = readiness_tx.clone();
    let readiness_sent_for_worker = readiness_sent.clone();
    let trace = ModelTraceRecorder::new(
        app.clone(),
        ModelTraceContext::new(
            provider.provider_id.clone(),
            provider.model.clone(),
            "omni-realtime",
        )
        .with_session_id(ms_marker(unix_ms()))
        .with_route_mode("watch"),
    );

    let join_handle = thread::Builder::new()
        .name("omni".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            let worker = OmniSessionWorker {
                app: app_handle.clone(),
                config: OmniSessionConfig {
                    direction: worker_direction.clone(),
                    session_generation,
                    provider,
                    voice,
                    instructions,
                    audio_mode,
                    output_mode,
                    target_language,
                    subtitle_translate_active,
                    speech_config,
                },
                readiness_tx: readiness_tx_for_worker.clone(),
                readiness_sent: readiness_sent_for_worker.clone(),
                trace,
                audio_rx,
                stop_rx,
            };
            let result = worker.run(&audio_state);
            if let Err(error) = result {
                audio_state.set_stt_connected(false, 0);
                // Mirror the engine route-worker convention: trailing
                // `| code:` / `| recommended:` markers become the snapshot's
                // last_error_code and recommended_action so the session page
                // can surface a translated message and a concrete next step
                // instead of a silent session death.
                let normalized_error = if split_error_markers(&error).1.is_some() {
                    error.clone()
                } else {
                    super::session_errors::with_error_markers(
                        &error,
                        super::session_errors::SessionErrorCode::ProviderInternal,
                    )
                };
                let (route_message, error_code, recommended_action) =
                    split_error_markers(&normalized_error);
                audio_state.mark_route_last_error(
                    &worker_direction,
                    route_message.clone(),
                    error_code,
                    recommended_action,
                );
                let _ = audio_state.mark_omni_session_failed(
                    &worker_direction,
                    session_generation,
                    normalized_error.clone(),
                );
                if !readiness_sent_for_worker.swap(true, Ordering::SeqCst) {
                    let _ = readiness_tx_for_worker.send(Err(normalized_error.clone()));
                }
                let _ = diag_log_detail(
                    &app_handle,
                    "omni",
                    "error",
                    format!("Omni 实时翻译出错: {error}"),
                    format!("model={model}"),
                );
                let _ = crate::audio::worker_notify::emit_worker_notification(
                    &app_handle,
                    crate::runtime::contracts::RuntimeNotification::error(
                        &format!("omni-session-failed-{worker_direction}"),
                        "session",
                        &normalized_error,
                        ms_marker(unix_ms()),
                    ),
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
                let _ =
                    audio_state.clear_omni_session(&worker_direction, session_generation, normalized_error);
            } else {
                if !readiness_sent_for_worker.swap(true, Ordering::SeqCst) {
                    let _ = readiness_tx_for_worker.send(Err(
                        "Omni worker exited before session readiness".to_string(),
                    ));
                }
                let _ = audio_state.clear_omni_session(
                    &worker_direction,
                    session_generation,
                    "worker_exit",
                );
            }
        })
        .map_err(|error| format!("无法启动 Omni 线程: {error}"))?;

    Ok((
        audio_tx,
        OmniHandle {
            stop_tx,
            join_handle,
        },
        readiness_rx,
    ))
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
    audio_mode: RealtimeAudioMode,
    output_mode: OmniOutputMode,
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
    trace: ModelTraceRecorder,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let echo_guard_enabled = speech_config.echo_guard_enabled();
    let OmniConnectedSession {
        mut socket,
        mut trace_call,
        session_started_at,
        mut active_voice,
        mut voice_fallback_applied,
        native_translation_reuse_active,
        playback_tx,
        playback_stop_requested,
        playback_join,
    } = OmniConnectionCoordinator::connect_initial(
        &app,
        store,
        &direction,
        &provider,
        &voice,
        &instructions,
        audio_mode,
        output_mode,
        &target_language,
        subtitle_translate_active,
        speech_config,
        trace,
    )?;
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
        mut manual_response_item_id,
        mut last_vad_event_time,
        mut vad_event_count,
        mut last_commit_time,
        mut manual_turn_started_at,
        mut st_skip_logged,
        mut transcription_completed_flag,
        mut transcription_completed_at,
        mut event_diagnostics,
        mut last_waiting_log_chunk_count,
        mut pending_audio_delta_count,
        mut pending_audio_delta_base64_bytes,
        mut pending_audio_response_id,
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
    let mut provider_input_dump = ProviderInputPcmDump::from_env(&app);

    let connector = TungsteniteConnector;
    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = socket.close(None);
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
            request_omni_playback_stop(&playback_stop_requested, &playback_tx);
            let _ = playback_join.join();
            emit_audio_snapshot(&app, store)?;
            break;
        }

        let pump_state = OmniAudioPump::new(OmniAudioPumpState {
            buffer_size,
            reconnect_count,
            chunk_count,
            sent_audio_since_commit,
            audio_samples_since_commit,
            manual_turn_started_at,
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
            provider_input_dump,
            chunks_sent_this_tick: 0,
            socket_reconnected: false,
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
            &target_language,
            &session_started_at,
        )?;
        buffer_size = pump_state.buffer_size;
        reconnect_count = pump_state.reconnect_count;
        chunk_count = pump_state.chunk_count;
        sent_audio_since_commit = pump_state.sent_audio_since_commit;
        audio_samples_since_commit = pump_state.audio_samples_since_commit;
        manual_turn_started_at = pump_state.manual_turn_started_at;
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
        provider_input_dump = pump_state.provider_input_dump;
        let chunks_sent_this_tick = pump_state.chunks_sent_this_tick;
        // Both the pre-pump and post-poll reconnect paths must reset the exact
        // same manual-gate/turn/pre-session-audio locals. A local macro keeps
        // that 18-argument call in one place without threading the locals
        // through a helper struct across the whole pump loop.
        macro_rules! reset_gate_after_reconnect {
            () => {
                reset_manual_gate_after_reconnect(
                    &app,
                    store,
                    audio_mode,
                    &mut manual_response_pending,
                    &mut manual_response_item_id,
                    &mut sent_audio_since_commit,
                    &mut audio_samples_since_commit,
                    &mut last_commit_time,
                    &mut manual_turn_started_at,
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
                    &mut session_ready_for_audio,
                )
            };
        }
        if pump_state.socket_reconnected {
            reset_gate_after_reconnect!();
        }

        OmniAudioPump::log_waiting_if_needed(
            &app,
            chunk_count,
            chunks_sent_this_tick,
            &mut last_waiting_log_chunk_count,
        );

        let commit_state = OmniConnectionCoordinator::maintain_manual_commit(
            OmniCommitState {
                last_commit_time,
                manual_turn_started_at,
                sent_audio_since_commit,
                audio_samples_since_commit,
                manual_response_pending,
                manual_response_item_id,
                manual_turn_timed_out: false,
            },
            &app,
            &mut socket,
            &mut trace_call,
            audio_mode,
            chunk_count,
            silence_grace_chunks_sent >= OMNI_ASR_SILENCE_GRACE_CHUNKS,
        );
        last_commit_time = commit_state.last_commit_time;
        manual_turn_started_at = commit_state.manual_turn_started_at;
        sent_audio_since_commit = commit_state.sent_audio_since_commit;
        audio_samples_since_commit = commit_state.audio_samples_since_commit;
        manual_response_pending = commit_state.manual_response_pending;
        manual_response_item_id = commit_state.manual_response_item_id;
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

        let poll = OmniSocketEventProcessor::poll(
            OmniSocketEventState {
                socket,
                trace_call,
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
                last_vad_event_time,
                vad_event_count,
                transcription_completed_flag,
                transcription_completed_at,
                manual_response_pending,
                manual_response_item_id,
            },
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
                instructions: &instructions,
                audio_mode,
                output_mode,
                target_language: &target_language,
                buffer_size,
                pre_session_audio_queue_len: pre_session_audio_queue.len(),
                pre_session_audio_dropped,
                echo_guard_enabled,
            },
            &connector,
        )?;
        socket = poll.state.socket;
        trace_call = poll.state.trace_call;
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
        last_vad_event_time = poll.state.last_vad_event_time;
        vad_event_count = poll.state.vad_event_count;
        transcription_completed_flag = poll.state.transcription_completed_flag;
        transcription_completed_at = poll.state.transcription_completed_at;
        manual_response_pending = poll.state.manual_response_pending;
        manual_response_item_id = poll.state.manual_response_item_id;
        if poll.socket_reconnected {
            reset_gate_after_reconnect!();
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
        emit_audio_snapshot(&app, store)?;
        thread::sleep(Duration::from_millis(10));
    }

    Ok(())
}

/// After a WebSocket reconnect the provider session and its input buffer are
/// gone: an awaited `input_audio_buffer.committed` ack or
/// `transcription.completed` will never arrive, and a streaming response
/// cannot resume. Drop the manual response gate and the stale turn/output
/// state, restart the commit timer so the next audible chunk cannot create a
/// tiny empty turn, and mark the session not ready for audio: the new socket has not confirmed
/// its `session.update` yet, so audio must buffer in the pre-session queue
/// until the new `session.created`/`session.updated` arrives.
#[allow(clippy::too_many_arguments)]
pub(super) fn reset_manual_gate_after_reconnect<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    audio_mode: RealtimeAudioMode,
    manual_response_pending: &mut bool,
    manual_response_item_id: &mut Option<String>,
    sent_audio_since_commit: &mut bool,
    audio_samples_since_commit: &mut u64,
    last_commit_time: &mut SystemTime,
    manual_turn_started_at: &mut Option<SystemTime>,
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
    pending_audio_buffer: &mut Vec<i16>,
    pending_audio_delta_count: &mut u64,
    pending_audio_delta_base64_bytes: &mut u64,
    pending_audio_response_id: &mut Option<String>,
    session_ready_for_audio: &mut bool,
) {
    if audio_mode.uses_manual_commit() && *manual_response_pending {
        let _ = diag_log(
            app,
            "omni",
            "warning",
            "event=manual_response_gate action=reset_after_reconnect reason=server_session_lost",
        );
    }
    reset_session_state_after_reconnect(
        store,
        manual_response_pending,
        manual_response_item_id,
        sent_audio_since_commit,
        audio_samples_since_commit,
        last_commit_time,
        manual_turn_started_at,
        current_cue_id,
        pending_source_text,
        pending_translated_text,
        transcription_completed_flag,
        transcription_completed_at,
        event_diagnostics,
        pending_audio_buffer,
        pending_audio_delta_count,
        pending_audio_delta_base64_bytes,
        pending_audio_response_id,
        session_ready_for_audio,
    );
}

/// State portion of the post-reconnect reset, kept free of `AppHandle` so the
/// reconnect contract stays directly unit-testable.
#[allow(clippy::too_many_arguments)]
pub(super) fn reset_session_state_after_reconnect(
    store: &AudioStateStore,
    manual_response_pending: &mut bool,
    manual_response_item_id: &mut Option<String>,
    sent_audio_since_commit: &mut bool,
    audio_samples_since_commit: &mut u64,
    last_commit_time: &mut SystemTime,
    manual_turn_started_at: &mut Option<SystemTime>,
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
    pending_audio_buffer: &mut Vec<i16>,
    pending_audio_delta_count: &mut u64,
    pending_audio_delta_base64_bytes: &mut u64,
    pending_audio_response_id: &mut Option<String>,
    session_ready_for_audio: &mut bool,
) {
    *manual_response_pending = false;
    *manual_response_item_id = None;
    *sent_audio_since_commit = false;
    *audio_samples_since_commit = 0;
    *last_commit_time = SystemTime::now();
    *manual_turn_started_at = None;
    if let Some(cue_id) = current_cue_id.as_deref() {
        store.discard_uncommitted_subtitle_cue(cue_id);
    }
    reset_omni_turn_state(
        current_cue_id,
        pending_source_text,
        pending_translated_text,
        transcription_completed_flag,
        transcription_completed_at,
        event_diagnostics,
    );
    pending_audio_buffer.clear();
    *pending_audio_delta_count = 0;
    *pending_audio_delta_base64_bytes = 0;
    *pending_audio_response_id = None;
    // The replacement socket has not confirmed its session.update yet; audio
    // sent now would race the provider's session setup and be dropped (or
    // transcribed against the wrong configuration). Buffer through the
    // pre-session queue until the new session.created/session.updated lands.
    *session_ready_for_audio = false;
}

#[cfg(test)]
mod reconnect_reset_tests {
    use super::*;

    #[test]
    fn every_manual_turn_anchors_on_its_first_successful_audible_append() {
        assert!(should_anchor_manual_turn_to_first_audible_append(
            RealtimeAudioMode::Manual,
            false,
            true,
        ));
        assert!(!should_anchor_manual_turn_to_first_audible_append(
            RealtimeAudioMode::Manual,
            true,
            true,
        ));
        assert!(!should_anchor_manual_turn_to_first_audible_append(
            RealtimeAudioMode::ServerVad,
            false,
            true,
        ));
    }

    /// Field bug: after a mid-session reconnect, `session_ready_for_audio`
    /// stayed true, so captured audio was pumped into the new socket before
    /// the provider confirmed the new session.
    #[test]
    fn reconnect_reset_marks_the_session_not_ready_for_audio() {
        let store = AudioStateStore::new();
        let mut manual_response_pending = true;
        let mut manual_response_item_id = Some("item-old".to_string());
        let mut sent_audio_since_commit = true;
        let mut audio_samples_since_commit = 32_000_u64;
        let mut last_commit_time = SystemTime::now();
        let mut manual_turn_started_at = Some(SystemTime::now());
        let mut current_cue_id = Some("cue-old".to_string());
        let mut pending_source_text = "half a sentence".to_string();
        let mut pending_translated_text = "半句译文".to_string();
        let mut transcription_completed_flag = true;
        let mut transcription_completed_at = Some(SystemTime::now());
        let mut event_diagnostics = OmniEventDiagnostics::default();
        let mut pending_audio_buffer = vec![1_i16, -1];
        let mut pending_audio_delta_count = 3_u64;
        let mut pending_audio_delta_base64_bytes = 4_096_u64;
        let mut pending_audio_response_id = Some("resp-old".to_string());
        let mut session_ready_for_audio = true;

        reset_session_state_after_reconnect(
            &store,
            &mut manual_response_pending,
            &mut manual_response_item_id,
            &mut sent_audio_since_commit,
            &mut audio_samples_since_commit,
            &mut last_commit_time,
            &mut manual_turn_started_at,
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
            &mut session_ready_for_audio,
        );

        assert!(
            !session_ready_for_audio,
            "audio must buffer in the pre-session queue until the new session confirms"
        );
        assert!(!manual_response_pending);
        assert!(manual_response_item_id.is_none());
        assert!(!sent_audio_since_commit);
        assert_eq!(audio_samples_since_commit, 0);
        assert!(manual_turn_started_at.is_none());
        assert!(current_cue_id.is_none());
        assert!(pending_audio_buffer.is_empty());
        assert_eq!(pending_audio_delta_count, 0);
        assert!(pending_audio_response_id.is_none());
        // A reconnect must not inherit a stale timer and immediately commit a
        // tiny fragment before enough new-session audio has accumulated.
        assert!(
            last_commit_time.elapsed().unwrap_or_default()
                < Duration::from_secs(MANUAL_COMMIT_INTERVAL_SECS)
        );
    }
}

pub(super) fn reconnect_socket<R: tauri::Runtime>(
    app: &AppHandle<R>,
    provider: &ProviderDraftInput,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    output_mode: OmniOutputMode,
    target_language: &str,
) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, String>
{
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 重连仅支持 dashscope provider，当前为 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let request = build_dashscope_ws_request(provider)?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("无法重新连接 Omni 服务: {error}"))?;
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);

    let session_cfg = build_omni_session_update_for_provider_with_output_mode(
        provider,
        voice,
        instructions,
        audio_mode,
        target_language,
        output_mode,
    );
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("无法重发 Omni session 配置: {error}"))?;

    let _ = diag_log(app, "omni", "info", "reconnected to Omni service");
    Ok(socket)
}
