use super::*;

pub(super) struct OmniAudioPumpState {
    pub(super) buffer_size: u64,
    pub(super) reconnect_count: usize,
    pub(super) chunk_count: u64,
    /// At least one above-threshold input chunk was sent in the current manual
    /// turn. Silence-grace frames must not create another turn by themselves.
    pub(super) sent_audio_since_commit: bool,
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
    pub(super) chunks_sent_this_tick: usize,
    /// The send path replaced the socket via reconnect during this tick. The
    /// worker must reset the manual response gate tied to the old session.
    pub(super) socket_reconnected: bool,
}

pub(super) struct OmniAudioPump {
    state: OmniAudioPumpState,
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
        target_language: &str,
        session_started_at: &SystemTime,
    ) -> Result<OmniAudioPumpState, String> {
        let OmniAudioPumpState {
            mut buffer_size,
            mut reconnect_count,
            mut chunk_count,
            mut sent_audio_since_commit,
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
            chunks_sent_this_tick: _,
            socket_reconnected: _,
        } = self.state;
        let mut chunks_sent_this_tick: usize = 0;
        let mut socket_reconnected = false;
        let mut pre_session_chunks_drained_this_tick = 0usize;
        loop {
            let raw_chunk = if session_ready_for_audio {
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
                                    "[SESSION] buffering audio before session ready: queued={} dropped={pre_session_audio_dropped}",
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
                    store.live_session_events.record_audio_diagnostic(
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
            buffer_size = buffer_size.wrapping_add(raw_chunk.len() as u64);
            chunk_count += 1;
            sent_audio_since_commit = manual_turn_has_audible_input(
                sent_audio_since_commit,
                chunk_rms,
            );
            chunks_sent_this_tick += 1;

            if chunk_count == 1 {
                let elapsed = elapsed_ms_since(&session_started_at);
                first_audio_sent_ms = Some(elapsed);
                store.live_session_events.record_milestone(
                    "first_audio_sent",
                    elapsed,
                );
                let _ = diag_log(
                    &app,
                    "omni",
                    "info",
                    format!(
                        "[AUDIO] 首个音频块已发送 ({} samples @ 16kHz)",
                        asr_chunk.len()
                    ),
                );
            }
            if chunk_count.is_multiple_of(100) {
                let _ = diag_log(
                    &app,
                    "omni",
                    "debug",
                    format!(
                        "[AUDIO] 已发送 {} 个音频块 ({} 字节)",
                        chunk_count, buffer_size
                    ),
                );
            }
            if let Some(dump) = provider_input_dump.as_mut() {
                dump.append(&app, &asr_chunk);
            }
            let b64 = base64_encode_i16(&asr_chunk);
            let append = json!({
              "type": "input_audio_buffer.append",
              "audio": b64
            });
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
            if let Err(error) = socket.send_message(Message::Text(append.to_string().into())) {
                let _ = diag_log(
                    app,
                    "omni",
                    "warning",
                    format!("[AUDIO] 发送失败: {error}"),
                );
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
                    &target_language,
                    buffer_size,
                    &format!("audio send failed: {error}"),
                ) {
                    Ok(new_socket) => {
                        *socket = new_socket;
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
                        return Err(format!(
                            "Omni WebSocket 发送失败且重连次数已用尽: {error}"
                        ));
                    }
                }
            }
            store.set_stt_connected(true, buffer_size);

            if chunks_sent_this_tick > 1 {
                thread::sleep(Duration::from_millis(OMNI_INTER_CHUNK_THROTTLE_MS));
            }
        }
        Ok(OmniAudioPumpState {
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
