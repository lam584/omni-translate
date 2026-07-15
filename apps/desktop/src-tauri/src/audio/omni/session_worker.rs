use super::*;

pub struct OmniHandle {
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
    last_vad_event_time: SystemTime,
    vad_event_count: u64,
    last_commit_time: SystemTime,
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
            last_vad_event_time: SystemTime::now(),
            vad_event_count: 0,
            last_commit_time: SystemTime::now(),
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
            self.config.target_language,
            self.config.subtitle_translate_active,
            self.config.speech_config,
            self.trace,
            self.audio_rx,
            self.stop_rx,
        )
    }
}

pub fn start_omni(
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
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (readiness_tx, readiness_rx) = mpsc::channel::<Result<u64, String>>();
    let readiness_sent = Arc::new(AtomicBool::new(false));

    store.set_stt_connected(false, 0);
    store
        .live_session_events
        .clear(&provider.model, &ms_marker(unix_ms()));
    let _ = diag_log_detail(
        &app,
        "omni",
        "info",
        "姝ｅ湪鍚姩 Omni 瀹炴椂缈昏瘧...",
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
                let _ = audio_state.mark_omni_session_failed(
                    &worker_direction,
                    session_generation,
                    error.clone(),
                );
                if !readiness_sent_for_worker.swap(true, Ordering::SeqCst) {
                    let _ = readiness_tx_for_worker.send(Err(error.clone()));
                }
                let _ = diag_log_detail(
                    &app_handle,
                    "omni",
                    "error",
                    format!("Omni 瀹炴椂缈昏瘧鍑洪敊: {error}"),
                    format!("model={model}"),
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
                let _ =
                    audio_state.clear_omni_session(&worker_direction, session_generation, error);
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
        .map_err(|error| format!("鏃犳硶鍚姩 Omni 绾跨▼: {error}"))?;

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
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
    trace: ModelTraceRecorder,
    audio_rx: mpsc::Receiver<Vec<u8>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let OmniConnectedSession {
        mut socket,
        mut trace_call,
        session_started_at,
        mut active_voice,
        mut voice_fallback_applied,
        native_translation_reuse_active,
        playback_tx,
        playback_join,
    } = OmniConnectionCoordinator::connect_initial(
        &app,
        store,
        &provider,
        &voice,
        &instructions,
        audio_mode,
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
        mut last_vad_event_time,
        mut vad_event_count,
        mut last_commit_time,
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

    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = socket.close(None);
            store.set_stt_connected(false, buffer_size);
            let _ = diag_log(
                &app,
                "omni",
                "info",
                format!(
                    "[STOP] Omni worker 宸插仠姝? 鍏卞彂閫?{} 涓煶棰戝潡, {} 瀛楄妭",
                    chunk_count, buffer_size
                ),
            );
            check_vad_warning(
                &app,
                &last_vad_event_time,
                chunk_count,
                vad_event_count,
                buffer_size,
            );
            let _ = playback_tx.send(OmniPlaybackCommand::Stop);
            let _ = playback_join.join();
            emit_audio_snapshot(&app, store)?;
            break;
        }

        let pump_state = OmniAudioPump::new(OmniAudioPumpState {
            buffer_size,
            reconnect_count,
            chunk_count,
            sent_audio_since_commit,
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
        })
        .pump(
            &app,
            store,
            &audio_rx,
            &mut socket,
            &mut trace_call,
            &provider,
            &active_voice,
            &instructions,
            audio_mode,
            &target_language,
            &session_started_at,
        )?;
        buffer_size = pump_state.buffer_size;
        reconnect_count = pump_state.reconnect_count;
        chunk_count = pump_state.chunk_count;
        sent_audio_since_commit = pump_state.sent_audio_since_commit;
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

        OmniAudioPump::log_waiting_if_needed(
            &app,
            chunk_count,
            chunks_sent_this_tick,
            &mut last_waiting_log_chunk_count,
        );

        let commit_state = OmniConnectionCoordinator::maintain_manual_commit(
            OmniCommitState {
                last_commit_time,
                sent_audio_since_commit,
            },
            &app,
            &mut socket,
            &mut trace_call,
            audio_mode,
            chunk_count,
        );
        last_commit_time = commit_state.last_commit_time;
        sent_audio_since_commit = commit_state.sent_audio_since_commit;

        OmniEventProcessor::expire_stale_transcription(
            &app,
            &mut transcription_completed_flag,
            &mut transcription_completed_at,
        );

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
                target_language: &target_language,
                buffer_size,
                pre_session_audio_queue_len: pre_session_audio_queue.len(),
                pre_session_audio_dropped,
            },
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
        if poll.skip_tick {
            continue;
        }
        if check_vad_warning(
            &app,
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

pub(super) fn reconnect_socket(
    app: AppHandle,
    provider: &ProviderDraftInput,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, String>
{
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 閲嶈繛浠呮敮鎸?dashscope provider锛屽綋鍓嶄负 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let ws_url = to_websocket_url(&provider.base_url, &provider.model)
        .map_err(|error| format!("鏃犳硶鏋勫缓 WebSocket URL: {}", error.message))?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("鏃犳硶鍒涘缓 WebSocket 璇锋眰: {error}"))?;
    apply_ws_auth(provider, request.headers_mut())
        .map_err(|error| format!("鏃犳硶搴旂敤璁よ瘉澶? {}", error.message))?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("鏃犳硶閲嶆柊杩炴帴 Omni 鏈嶅姟: {error}"))?;
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);

    let session_cfg = build_omni_session_update(
        &provider.model,
        voice,
        instructions,
        audio_mode,
        target_language,
    );
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("鏃犳硶閲嶅彂 Omni session 閰嶇疆: {error}"))?;

    let _ = diag_log(&app, "omni", "info", "reconnected to Omni service");
    Ok(socket)
}
