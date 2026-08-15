use super::*;

// A continuously fed receiver must yield back to the session worker so it can
// poll provider events and run the manual-commit timer. Without this bound,
// `try_recv()` can drain an entire long media stream in one call and postpone
// the first commit/final transcript until the session is already stopping.
const OMNI_AUDIO_PUMP_MAX_CHUNKS_PER_TICK: usize = 8;

fn audio_pump_should_yield(chunks_sent_this_tick: usize) -> bool {
    chunks_sent_this_tick >= OMNI_AUDIO_PUMP_MAX_CHUNKS_PER_TICK
}

pub(super) struct OmniAudioPumpState {
    pub(super) buffer_size: u64,
    pub(super) reconnect_count: usize,
    pub(super) chunk_count: u64,
    /// At least one above-threshold input chunk was sent in the current manual
    /// turn. Silence-grace frames must not create another turn by themselves.
    pub(super) sent_audio_since_commit: bool,
    /// Number of 16 kHz mono PCM samples appended after the latest successful
    /// manual commit. This prevents a lone tail frame from being committed.
    pub(super) audio_samples_since_commit: u64,
    /// At least one accepted append belongs to the input buffer following the
    /// latest manual commit. It may arrive while the prior response streams;
    /// after response.done the manual gate serially commits this accumulated
    /// turn, subject to the normal audible/minimum-length checks.
    pub(super) manual_turn_audio_after_response: bool,
    pub(super) manual_turn_started_at: Option<SystemTime>,
    /// Actual speaker state observed when the current manual turn received its
    /// first audible capture. Manual providers omit server VAD, so this is the
    /// continuity signal used by the late echo gate.
    pub(super) manual_turn_started_during_playback: Option<bool>,
    pub(super) session_ready_for_audio: bool,
    pub(super) pre_session_audio_queue: VecDeque<Vec<u8>>,
    pub(super) pre_session_audio_dropped: u64,
    pub(super) silence_chunks_skipped: u64,
    pub(super) silence_grace_chunks_sent: u32,
    pub(super) has_sent_audible_audio: bool,
    pub(super) total_input_chunks: u64,
    pub(super) first_audible_chunk_ms: Option<u64>,
    pub(super) total_silence_skipped_before_first_audible: u64,
    pub(super) first_audio_sent_ms: Option<u64>,
    pub(super) pending_audio_buffer: Vec<i16>,
    pub(super) provider_input_dump: Option<ProviderInputPcmDump>,
    pub(super) provider_input_budget: ProviderInputBudget,
    pub(super) chunks_sent_this_tick: usize,
    /// The send path replaced the socket via reconnect during this tick. The
    /// worker must reset the manual response gate tied to the old session.
    pub(super) socket_reconnected: bool,
}

pub(super) struct OmniAudioPump {
    state: OmniAudioPumpState,
}

fn provider_input_is_writable(
    session_ready_for_audio: bool,
    _response_pending: bool,
) -> bool {
    // Manual mode serializes commit/response.create, not input audio.  Audio
    // captured while the previous response streams belongs to the next turn;
    // deferring append here makes a high-frequency provider response consume
    // the bounded pre-session queue faster than it can drain and silently
    // drops the live source.
    session_ready_for_audio
}

fn record_append_attempt_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    session_started_at: &SystemTime,
    chunk_count: u64,
    buffer_size: u64,
    sample_count: usize,
) -> Option<u64> {
    let first_audio_sent_ms = (chunk_count == 1).then(|| {
        let elapsed = elapsed_ms_since(session_started_at);
        store.watch_session_report.record_milestone_with_detail(
            "first_audio_sent",
            Some(format!("providerSessionElapsedMs={elapsed}")),
        );
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!("[AUDIO] 首个音频块已发送 ({sample_count} samples @ 16kHz)"),
        );
        elapsed
    });
    if chunk_count.is_multiple_of(100) {
        let _ = diag_log(
            app,
            "omni",
            "debug",
            format!("[AUDIO] 已发送 {chunk_count} 个音频块 ({buffer_size} 字节)"),
        );
    }
    first_audio_sent_ms
}

impl OmniAudioPump {
    pub(super) fn log_waiting_if_needed(
        app: &AppHandle,
        chunk_count: u64,
        chunks_sent_this_tick: usize,
        last_waiting_log_chunk_count: &mut u64,
    ) {
        if chunk_count > 0
            && chunks_sent_this_tick == 0
            && chunk_count.is_multiple_of(500)
            && *last_waiting_log_chunk_count != chunk_count
        {
            *last_waiting_log_chunk_count = chunk_count;
            let _ = diag_log(
                app,
                "omni",
                "debug",
                format!("[AUDIO] waiting for audio data... (sent {chunk_count} chunks)"),
            );
        }
    }

    pub(super) fn new(state: OmniAudioPumpState) -> Self {
        Self { state }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn pump<C: RealtimeSocketConnector, R: tauri::Runtime>(
        self,
        connector: &C,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        audio_rx: &mpsc::Receiver<Vec<u8>>,
        socket: &mut C::Socket,
        trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
        provider: &ProviderDraftInput,
        active_voice: &str,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        output_mode: OmniOutputMode,
        target_language: &str,
        session_started_at: &SystemTime,
        defer_audio_until_response_done: bool,
    ) -> Result<OmniAudioPumpState, String> {
        let OmniAudioPumpState {
            mut buffer_size,
            mut reconnect_count,
            mut chunk_count,
            mut sent_audio_since_commit,
            mut audio_samples_since_commit,
            mut manual_turn_audio_after_response,
            mut manual_turn_started_at,
            mut manual_turn_started_during_playback,
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
            mut provider_input_dump,
            provider_input_budget,
            chunks_sent_this_tick: _,
            socket_reconnected: _,
        } = self.state;
        let mut chunks_sent_this_tick: usize = 0;
        let mut socket_reconnected = false;
        let mut pre_session_chunks_drained_this_tick = 0usize;
        loop {
            let raw_chunk = if provider_input_is_writable(session_ready_for_audio, defer_audio_until_response_done) {
                match pre_session_audio_queue
                    .pop_front()
                    .or_else(|| audio_rx.try_recv().ok())
                {
                    Some(chunk) => chunk,
                    None => break,
                }
            } else {
                match audio_rx.try_recv() {
                    Ok(chunk) => {
                        pre_session_chunks_drained_this_tick += 1;
                        if pre_session_audio_queue.len() >= OMNI_PRE_SESSION_AUDIO_QUEUE_LIMIT {
                            pre_session_audio_queue.pop_front();
                            pre_session_audio_dropped += 1;
                        }
                        pre_session_audio_queue.push_back(chunk);
                        if pre_session_audio_queue.len() == 1
                            || pre_session_audio_queue.len().is_multiple_of(100)
                        {
                            let _ = diag_log(
                                &app,
                                "omni",
                                "debug",
                                format!(
                                    "[SESSION] buffering audio before provider input is writable: queued={} dropped={pre_session_audio_dropped} responseActive={defer_audio_until_response_done}",
                                    pre_session_audio_queue.len()
                                ),
                            );
                        }
                        if pre_session_chunks_drained_this_tick
                            >= OMNI_PRE_SESSION_AUDIO_DRAIN_PER_TICK
                        {
                            break;
                        }
                        continue;
                    }
                    Err(_) => break,
                }
            };
            let asr_chunk = resample_48k_stereo_to_16k_mono(&raw_chunk);
            if asr_chunk.is_empty() {
                let _ = diag_log(
                    &app,
                    "omni",
                    "warning",
                    "[TRACE] resampled empty ASR frame dropped",
                );
                continue;
            }
            let chunk_rms = asr_chunk_rms(&asr_chunk);
            total_input_chunks += 1;
            if chunk_rms < OMNI_ASR_MIN_CHUNK_RMS {
                if has_sent_audible_audio
                    && silence_grace_chunks_sent < OMNI_ASR_SILENCE_GRACE_CHUNKS
                {
                    silence_grace_chunks_sent += 1;
                } else {
                    silence_chunks_skipped = silence_chunks_skipped.saturating_add(1);
                    if silence_chunks_skipped == 1 || silence_chunks_skipped.is_multiple_of(250) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "debug",
                            format!(
                                "event=omni.asr_silence_chunk_skipped skipped={} rms={:.6} threshold={:.6}",
                                silence_chunks_skipped, chunk_rms, OMNI_ASR_MIN_CHUNK_RMS
                            ),
                        );
                    }
                    continue;
                }
            } else {
                if !has_sent_audible_audio {
                    first_audible_chunk_ms = Some(elapsed_ms_since(&session_started_at));
                    total_silence_skipped_before_first_audible = silence_chunks_skipped;
                    store.watch_session_report.record_audio_diagnostic(
                        first_audible_chunk_ms,
                        Some(silence_chunks_skipped),
                        None,
                    );
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[AUDIO] first audible chunk: elapsed_ms={} rms={:.6} threshold={:.6} silence_skipped_before={} total_input_chunks={}",
                            first_audible_chunk_ms.unwrap_or(0),
                            chunk_rms,
                            OMNI_ASR_MIN_CHUNK_RMS,
                            silence_chunks_skipped,
                            total_input_chunks,
                        ),
                    );
                }
                has_sent_audible_audio = true;
                silence_grace_chunks_sent = 0;
                silence_chunks_skipped = 0;
            }
            let b64 = base64_encode_i16(&asr_chunk);
            let append = super::build_dashscope_audio_append(&b64);
            let next_chunk_count = chunk_count.saturating_add(1);
            let send_result = provider_input_budget.attempt_send(
                asr_chunk.len() as u64,
                || {
                    // Strict authority writes and flushes the exact charged
                    // PCM before any trace/socket side effect. A dump failure
                    // returns with the reservation consumed and no send.
                    if let Some(dump) = provider_input_dump.as_mut() {
                        dump.append(app, &asr_chunk)?;
                    }
                    buffer_size = buffer_size.wrapping_add(raw_chunk.len() as u64);
                    chunk_count = next_chunk_count;
                    chunks_sent_this_tick += 1;
                    if let Some(elapsed) = record_append_attempt_progress(
                        app,
                        store,
                        session_started_at,
                        chunk_count,
                        buffer_size,
                        asr_chunk.len(),
                    ) {
                        first_audio_sent_ms = Some(elapsed);
                    }
                    trace_call.record_ws_send(
                        "input_audio_buffer.append",
                        json!({
                          "type": "input_audio_buffer.append",
                          "rawBytes": raw_chunk.len(),
                          "resampledSamples": asr_chunk.len(),
                          "audio": append["audio"].clone(),
                          "chunkCount": chunk_count,
                          "rms": chunk_rms,
                        }),
                    );
                    Ok(())
                },
                || socket.send_message(Message::Text(append.to_string().into())),
            )?;
            if let Err(error) = send_result {
                let _ = diag_log(
                    app,
                    "omni",
                    "warning",
                    format!("[AUDIO] 发送失败: {error}"),
                );
                // A failed append may already have reached the paid peer.
                // Strict cells permit no replacement WebSocket, so persist a
                // terminal rejection before `try_reconnect` can back off or
                // invoke the connector. Ordinary sessions continue below.
                provider_input_budget.authorize_reconnect_before_connect("send-failure")?;
                match try_reconnect(
                    connector,
                    &mut reconnect_count,
                    &mut pending_audio_buffer,
                    store,
                    app,
                    &provider,
                    &active_voice,
                    &instructions,
                    audio_mode,
                    output_mode,
                    &target_language,
                    buffer_size,
                    &format!("audio send failed: {error}"),
                ) {
                    Ok(new_socket) => {
                        *socket = new_socket;
                        provider_input_budget.record_reconnect()?;
                        socket_reconnected = true;
                        // The replacement session has not confirmed its
                        // session.update yet: sending now races the provider's
                        // session setup (the audio lands before the session is
                        // configured). Re-queue this chunk at the front of the
                        // pre-session buffer and stop treating the session as
                        // ready; the queue drains once the new
                        // session.created/session.updated arrives.
                        session_ready_for_audio = false;
                        buffer_size = buffer_size.wrapping_sub(raw_chunk.len() as u64);
                        chunk_count = chunk_count.saturating_sub(1);
                        chunks_sent_this_tick = chunks_sent_this_tick.saturating_sub(1);
                        pre_session_audio_queue.push_front(raw_chunk);
                        continue;
                    }
                    Err(_) => {
                        provider_input_budget.mark_terminal("send-reconnect-exhausted");
                        return Err(format!(
                            "Omni WebSocket 发送失败且重连次数已用尽: {error}"
                        ));
                    }
                }
            }
            manual_turn_audio_after_response = true;
            // Only audio accepted by the current socket belongs to the
            // provider's current input buffer. A failed append that triggers
            // reconnect must not arm or grow the next manual commit.
            let had_audible_since_commit = sent_audio_since_commit;
            sent_audio_since_commit = manual_turn_has_audible_input(
                sent_audio_since_commit,
                chunk_rms,
            );
            if should_anchor_manual_turn_to_first_audible_append(
                audio_mode,
                had_audible_since_commit,
                sent_audio_since_commit,
            ) {
                manual_turn_started_at = Some(SystemTime::now());
                let (playback_active, playback_recent) =
                    store.inbound_speaker_playback_context(Duration::from_secs(4));
                manual_turn_started_during_playback =
                    Some(playback_active || playback_recent);
                let _ = diag_log(
                    app,
                    "omni",
                    "debug",
                    format!(
                        "event=manual_commit_timer action=anchor_turn_first_audible_append playbackActive={playback_active} playbackRecent={playback_recent}"
                    ),
                );
            }
            audio_samples_since_commit = audio_samples_since_commit
                .saturating_add(asr_chunk.len() as u64);
            store.set_stt_connected(true, buffer_size);

            if chunks_sent_this_tick > 1 {
                thread::sleep(Duration::from_millis(OMNI_INTER_CHUNK_THROTTLE_MS));
            }
            if audio_pump_should_yield(chunks_sent_this_tick) {
                break;
            }
        }
        Ok(OmniAudioPumpState {
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
            provider_input_dump,
            provider_input_budget,
            chunks_sent_this_tick,
            socket_reconnected,
        })
    }
}

pub(super) fn manual_turn_has_audible_input(
    already_audible: bool,
    chunk_rms: f32,
) -> bool {
    already_audible || chunk_rms >= OMNI_ASR_MIN_CHUNK_RMS
}

pub(super) fn should_anchor_manual_turn_to_first_audible_append(
    audio_mode: RealtimeAudioMode,
    had_audible_since_commit: bool,
    has_audible_since_commit: bool,
) -> bool {
    audio_mode.uses_manual_commit()
        && !had_audible_since_commit
        && has_audible_since_commit
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tauri::Manager;
    use tempfile::tempdir;

    use super::*;

    struct SendFailSocket;

    impl RealtimeSocket for SendFailSocket {
        fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
            Err(tungstenite::Error::Io(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "test socket idle",
            )))
        }

        fn send_message(&mut self, _message: Message) -> Result<(), tungstenite::Error> {
            Err(tungstenite::Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "scripted append failure",
            )))
        }
    }

    #[derive(Default)]
    struct CountingConnector {
        attempts: AtomicUsize,
    }

    impl RealtimeSocketConnector for CountingConnector {
        type Socket = SendFailSocket;

        fn reconnect<R: tauri::Runtime>(
            &self,
            _app: &AppHandle<R>,
            _provider: &ProviderDraftInput,
            _voice: &str,
            _instructions: &str,
            _audio_mode: RealtimeAudioMode,
            _output_mode: OmniOutputMode,
            _target_language: &str,
        ) -> Result<Self::Socket, String> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            Ok(SendFailSocket)
        }
    }

    #[test]
    fn manual_response_gate_keeps_ready_provider_input_open_during_response() {
        assert!(!provider_input_is_writable(false, false));
        assert!(provider_input_is_writable(true, true));
        assert!(provider_input_is_writable(true, false));
    }

    #[test]
    fn continuous_audio_pump_yields_to_commit_and_socket_polling() {
        assert!(!audio_pump_should_yield(OMNI_AUDIO_PUMP_MAX_CHUNKS_PER_TICK - 1));
        assert!(audio_pump_should_yield(OMNI_AUDIO_PUMP_MAX_CHUNKS_PER_TICK));
        assert!(audio_pump_should_yield(OMNI_AUDIO_PUMP_MAX_CHUNKS_PER_TICK + 1));
    }

    #[test]
    fn strict_send_failure_never_reaches_the_reconnect_connector() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        let handle = app.handle().clone();
        let store = handle.state::<AudioStateStore>();
        let provider = ProviderInputBudget::strict_provider_for_test();
        let directory = tempdir().expect("tempdir");
        let ledger_path = directory.path().join("send-failure.json");
        let budget = ProviderInputBudget::strict_for_test(&provider, &ledger_path)
            .expect("strict budget fixture");
        budget
            .record_initial_connect_attempt()
            .expect("one initial connect attempt");
        let connector = CountingConnector::default();
        let mut socket = SendFailSocket;
        let recorder = crate::diagnostics::model_trace::ModelTraceRecorder::new(
            handle.clone(),
            crate::diagnostics::model_trace::ModelTraceContext::new(
                &provider.provider_id,
                &provider.model,
                "strict-send-test",
            ),
        );
        let mut trace_call = recorder.call("strict.send-failure");
        let (audio_tx, audio_rx) = mpsc::channel();
        let mut raw_chunk = Vec::with_capacity(960 * 8);
        for _ in 0..960 {
            raw_chunk.extend_from_slice(&0.25f32.to_le_bytes());
            raw_chunk.extend_from_slice(&0.25f32.to_le_bytes());
        }
        audio_tx.send(raw_chunk).expect("audible chunk");

        let result = OmniAudioPump::new(OmniAudioPumpState {
            buffer_size: 0,
            reconnect_count: 0,
            chunk_count: 0,
            sent_audio_since_commit: false,
            audio_samples_since_commit: 0,
            manual_turn_audio_after_response: false,
            manual_turn_started_at: None,
            manual_turn_started_during_playback: None,
            session_ready_for_audio: true,
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
            provider_input_dump: None,
            provider_input_budget: budget,
            chunks_sent_this_tick: 0,
            socket_reconnected: false,
        })
        .pump(
            &connector,
            &handle,
            &store,
            &audio_rx,
            &mut socket,
            &mut trace_call,
            &provider,
            "Ethan",
            "translate",
            RealtimeAudioMode::Manual,
            OmniOutputMode::TextAndAudio,
            "zh-CN",
            &SystemTime::now(),
            false,
        );

        let error = match result {
            Ok(_) => panic!("strict send reconnect must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("forbids reconnect after send-failure"), "{error}");
        assert_eq!(connector.attempts.load(Ordering::SeqCst), 0);
        let ledger: Value = serde_json::from_slice(
            &std::fs::read(&ledger_path).expect("strict ledger must be readable"),
        )
        .expect("strict ledger must be valid JSON");
        assert_eq!(ledger["initialConnectAttempts"], 1);
        assert_eq!(ledger["sendFailures"], 1);
        assert_eq!(ledger["reconnects"], 0);
        assert_eq!(
            ledger["terminalReason"],
            "reconnect-forbidden-send-failure"
        );
        let journal_path = format!("{}.journal.jsonl", ledger_path.display());
        let journal = std::fs::read_to_string(journal_path)
            .expect("strict send journal must be readable");
        let rejected: Value = journal
            .lines()
            .rev()
            .map(|line| {
                serde_json::from_str(line)
                    .expect("strict send journal event must be valid JSON")
            })
            .find(|entry: &Value| entry["event"] == "reconnect_rejected")
            .expect("strict send journal must record reconnect rejection");
        assert_eq!(rejected["event"], "reconnect_rejected");
        assert_eq!(
            rejected["terminalReason"],
            "reconnect-forbidden-send-failure"
        );
    }
}
