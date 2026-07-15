use super::*;

pub(super) struct OmniReconnectState {
    pub(super) socket: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    pub(super) reconnect_count: usize,
    pub(super) pending_audio_buffer: Vec<i16>,
    pub(super) active_voice: String,
    pub(super) voice_fallback_applied: bool,
}

pub(super) struct OmniConnectionCoordinator;

impl OmniConnectionCoordinator {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_provider_error(
        mut state: OmniReconnectState,
        app: &AppHandle,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        target_language: &str,
        buffer_size: u64,
        trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall,
        evt: &Value,
        raw_text: &str,
    ) -> OmniReconnectState {
        let err_code = evt["error"]["code"].as_str().unwrap_or("?");
        let err_msg = evt["error"]["message"].as_str().unwrap_or("链路错误");
        let _ = diag_log(
            app,
            "omni",
            "error",
            format!("[EVENT] error: code={err_code} message=\"{err_msg}\" raw={raw_text}"),
        );
        let handled_voice_fallback = is_unsupported_voice_error(err_code, err_msg)
            && !state.voice_fallback_applied
            && !state.active_voice.trim().is_empty()
            && state.reconnect_count < OMNI_RECONNECT_MAX_RETRIES;
        if handled_voice_fallback {
            let rejected_voice = state.active_voice.clone();
            state.voice_fallback_applied = true;
            state.active_voice.clear();
            let _ = diag_log_detail(
                app,
                "omni",
                "warning",
                format!(
                    "[VOICE] Provider rejected voice '{rejected_voice}'. Reconnecting without voice to use provider default."
                ),
                format!("errorCode={err_code}"),
            );
            if let Ok(new_socket) = try_reconnect(
                &mut state.reconnect_count,
                &mut state.pending_audio_buffer,
                store,
                app,
                provider,
                &state.active_voice,
                instructions,
                audio_mode,
                target_language,
                buffer_size,
            ) {
                state.socket = new_socket;
            }
        } else {
            trace_call.error(format!(
                "model error code={err_code} message={err_msg} raw={raw_text}"
            ));
        }
        state
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn reconnect_after_close(
        mut state: OmniReconnectState,
        app: &AppHandle,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        target_language: &str,
        buffer_size: u64,
    ) -> Result<OmniReconnectState, String> {
        let _ = diag_log(app, "omni", "warning", "[SOCKET] WebSocket closed");
        state.socket = try_reconnect(
            &mut state.reconnect_count,
            &mut state.pending_audio_buffer,
            store,
            app,
            provider,
            &state.active_voice,
            instructions,
            audio_mode,
            target_language,
            buffer_size,
        )?;
        Ok(state)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn recover_read_error(
        mut state: OmniReconnectState,
        app: &AppHandle,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        target_language: &str,
        buffer_size: u64,
        error: tungstenite::Error,
    ) -> Result<OmniReconnectState, String> {
        let err_str = error.to_string();
        if err_str.contains("timed out")
            || err_str.contains("WouldBlock")
            || err_str.contains("10060")
        {
            return Ok(state);
        }
        let _ = diag_log(
            app,
            "omni",
            "error",
            format!("[SOCKET_FATAL] WebSocket read failed: {error}"),
        );
        let _ = diag_log(
            app,
            "omni",
            "warning",
            format!("[SOCKET] read error: {error}"),
        );
        state.socket = try_reconnect(
            &mut state.reconnect_count,
            &mut state.pending_audio_buffer,
            store,
            app,
            provider,
            &state.active_voice,
            instructions,
            audio_mode,
            target_language,
            buffer_size,
        )
        .map_err(|_| format!("Omni WebSocket read failed and reconnect limit exhausted: {error}"))?;
        Ok(state)
    }
}

pub(super) struct OmniCommitState {
    pub(super) last_commit_time: SystemTime,
    pub(super) sent_audio_since_commit: bool,
}

impl OmniConnectionCoordinator {
    pub(super) fn maintain_manual_commit(
        state: OmniCommitState,
        app: &AppHandle,
        socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
        trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall,
        audio_mode: RealtimeAudioMode,
        chunk_count: u64,
    ) -> OmniCommitState {
        let OmniCommitState {
            mut last_commit_time,
            mut sent_audio_since_commit,
        } = state;
        if audio_mode.uses_manual_commit() {
            if let Ok(elapsed) = last_commit_time.elapsed() {
                if elapsed.as_secs() >= 10 && sent_audio_since_commit {
                    let commit_msg = json!({ "type": "input_audio_buffer.commit" });
                    trace_call.record_ws_send("input_audio_buffer.commit", commit_msg.clone());
                    if let Err(error) = socket.send(Message::Text(commit_msg.to_string().into())) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[VAD] bypass commit 发送失败: {error}"),
                        );
                    } else {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[VAD] bypass: 已发送 commit（距上次 {:.0}s，已发送 {} 块音频）",
                                elapsed.as_secs_f64(),
                                chunk_count
                            ),
                        );
                        last_commit_time = SystemTime::now();
                        sent_audio_since_commit = false;
                    }
                    let create_msg = json!({ "type": "response.create" });
                    trace_call.record_ws_send("response.create", create_msg.clone());
                    if let Err(error) = socket.send(Message::Text(create_msg.to_string().into())) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[VAD] bypass response.create 发送失败: {error}"),
                        );
                    }
                }
            }
        }
        OmniCommitState {
            last_commit_time,
            sent_audio_since_commit,
        }
    }
}

pub(super) struct OmniConnectedSession {
    pub(super) socket: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    pub(super) trace_call: crate::diagnostics::model_trace::ModelTraceCall,
    pub(super) session_started_at: SystemTime,
    pub(super) active_voice: String,
    pub(super) voice_fallback_applied: bool,
    pub(super) native_translation_reuse_active: bool,
    pub(super) playback_tx: mpsc::Sender<OmniPlaybackCommand>,
    pub(super) playback_join: JoinHandle<()>,
}

impl OmniConnectionCoordinator {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn connect_initial(
        app: &AppHandle,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        voice: &str,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        target_language: &str,
        subtitle_translate_active: bool,
        speech_config: OmniSpeechConfig,
        trace: ModelTraceRecorder,
    ) -> Result<OmniConnectedSession, String> {
        let mut trace_call = trace.call("omni.websocket_session");
        trace_call.input(
            "connect",
            json!({
              "providerId": provider.provider_id.clone(),
              "kind": provider.kind.clone(),
              "model": provider.model.clone(),
              "baseUrl": provider.base_url.clone(),
              "voice": voice,
              "instructions": instructions,
              "realtimeAudioMode": audio_mode.as_str(),
              "targetLanguage": target_language,
              "subtitleTranslateActive": subtitle_translate_active,
            }),
        );
        if provider.kind != "dashscope" {
            return Err(format!(
                "Omni 实时翻译仅支持 dashscope provider，当前为 {} (provider_id={})",
                provider.kind, provider.provider_id
            ));
        }
        let ws_url = to_websocket_url(&provider.base_url, &provider.model)
            .map_err(|error| format!("无法构建 WebSocket URL: {}", error.message))?;

        let mut request = ws_url
            .as_str()
            .into_client_request()
            .map_err(|error| format!("无法创建 WebSocket 请求: {error}"))?;
        apply_ws_auth(&provider, request.headers_mut())
            .map_err(|error| format!("无法应用认证头: {}", error.message))?;

        let initial_connect_started = SystemTime::now();
        let mut initial_attempt = 0usize;
        let (socket, _) = loop {
            initial_attempt += 1;
            match connect(request.clone()) {
                Ok(connected) => break connected,
                Err(error) if initial_attempt <= OMNI_INITIAL_CONNECT_RETRIES => {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "warning",
                        format!(
                            "[CONNECT] Omni 初次连接失败，准备重试: attempt={initial_attempt}/{} error={error}",
                            OMNI_INITIAL_CONNECT_RETRIES + 1
                        ),
                    );
                    thread::sleep(initial_connect_backoff(initial_attempt));
                }
                Err(error) => {
                    let elapsed_ms = initial_connect_started
                        .elapsed()
                        .map(|elapsed| elapsed.as_millis())
                        .unwrap_or_default();
                    trace_call.error(format!(
                        "initial websocket connect failed attempts={initial_attempt} elapsedMs={elapsed_ms} error={error}"
                    ));
                    return Err(format!("无法连接 Omni 服务: {error}"));
                }
            }
        };
        let connection = OmniConnection::from_connected(socket, initial_connect_started);
        let (mut socket, ws_connect_ms) = connection.into_parts();
        let session_started_at = SystemTime::now();
        store.set_stt_connected(true, 0);
        store.live_session_events.record_milestone("preconnect_started", ws_connect_ms);
        let _ = diag_log(
            &app,
            "omni",
            "info",
            format!("[CONNECT] 已连接 Omni 服务, model={}", provider.model),
        );

        let active_voice = voice.to_string();
        let voice_fallback_applied = false;
        let session_cfg = build_omni_session_update(
            &provider.model,
            &active_voice,
            &instructions,
            audio_mode,
            &target_language,
        );
        let input_audio_format = session_cfg
            .pointer("/session/input_audio_format")
            .and_then(Value::as_str)
            .unwrap_or("(missing)");
        let turn_detection_summary = session_cfg
            .pointer("/session/turn_detection")
            .map(|value| value.to_string())
            .unwrap_or_else(|| "(missing)".to_string());
        let _ = diag_log_detail(
            &app,
            "omni",
            "info",
            "watch_mode.omni_session_config",
            format!(
                "model={} realtimeAudioMode={} inputAudioFormat={} isLivetranslate={} subtitleTranslateActive={} turnDetection={}",
                provider.model,
                audio_mode.as_str(),
                input_audio_format,
                is_livetranslate_model(&provider.model),
                subtitle_translate_active,
                turn_detection_summary,
            ),
        );
        trace_call.record_ws_send("session.update", session_cfg.clone());
        socket
            .send(Message::Text(session_cfg.to_string().into()))
            .map_err(|error| format!("无法发送 Omni session 配置: {error}"))?;

        let _ = diag_log(
            &app,
            "omni",
            "debug",
            format!(
                "[SESSION] 已发送 session.update: modalities=[text,audio] voice={voice} instructions_len={}",
                instructions.len()
            ),
        );

        if audio_mode.uses_manual_commit() {
            let _ = diag_log(
                &app,
                "omni",
                "info",
                "[VAD] 当前模式: manual（VAD bypass 已启用，每 10 秒自动 commit）",
            );
        } else {
            let _ = diag_log(
                &app,
                "omni",
                "info",
                "[VAD] turn_detection 配置: type=server_vad threshold=0.0 silence_duration_ms=800",
            );
        }

        let native_translation_reuse_active =
            subtitle_translate_active && is_livetranslate_model(&provider.model);
        let (playback_tx, playback_join) = start_omni_playback(app.clone(), speech_config);
        Ok(OmniConnectedSession {
            socket,
            trace_call,
            session_started_at,
            active_voice,
            voice_fallback_applied,
            native_translation_reuse_active,
            playback_tx,
            playback_join,
        })
    }
}
