use super::*;
use std::collections::HashSet;

const MANUAL_COMMIT_INTERVAL_SECS: u64 = 10;
const MANUAL_RESPONSE_TIMEOUT_SECS: u64 = 30;
pub(super) const RECENT_OUTPUT_ECHO_WINDOW_MS: u64 = 30_000;
// One manual turn is ten seconds. The extra two seconds cover provider ASR
// completion latency while retaining only the capture evidence for this turn.
pub(super) const MANUAL_ECHO_ACTIVITY_WINDOW: Duration = Duration::from_secs(12);
// Normal media plus translated playback is preserved by the AEC double-talk
// path. A paused source recapturing only local playback produces a sustained,
// much higher suppressed-chunk share; require both duration and ratio evidence.
const MIN_ECHO_ACTIVITY_CHUNKS: u64 = 120;
const ECHO_DOMINATED_PERCENT: u64 = 35;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ManualResponseDecision {
    Create,
    SkipEmpty,
    SkipRecentOutputEcho,
    SkipEchoDominatedPlayback,
}

pub(super) fn classify_manual_response(
    source: &str,
    recent_output: &str,
    recent_output_age_ms: Option<u64>,
    echo_guard_enabled: bool,
    echo_dominated_input: bool,
) -> ManualResponseDecision {
    if source.trim().is_empty() {
        return ManualResponseDecision::SkipEmpty;
    }
    let recent_output_is_active = echo_guard_enabled
        && !recent_output.trim().is_empty()
        && recent_output_age_ms.is_some_and(|age| age <= RECENT_OUTPUT_ECHO_WINDOW_MS);
    if recent_output_is_active {
        if texts_are_probable_echoes(source, recent_output) {
            return ManualResponseDecision::SkipRecentOutputEcho;
        }
        if echo_dominated_input {
            return ManualResponseDecision::SkipEchoDominatedPlayback;
        }
    }
    ManualResponseDecision::Create
}

pub(super) fn classify_completed_manual_response(
    manual_response_pending: bool,
    committed_item_id: Option<&str>,
    completed_item_id: Option<&str>,
    completed_source_text: Option<&str>,
    recent_output: &str,
    recent_output_age_ms: Option<u64>,
    echo_guard_enabled: bool,
    echo_dominated_input: bool,
) -> Option<ManualResponseDecision> {
    if !manual_response_pending
        || committed_item_id.is_none()
        || committed_item_id != completed_item_id
    {
        return None;
    }
    completed_source_text.map(|source| {
        classify_manual_response(
            source,
            recent_output,
            recent_output_age_ms,
            echo_guard_enabled,
            echo_dominated_input,
        )
    })
}

pub(super) fn recent_echo_input_is_dominated(
    total_chunks: u64,
    suppressed_chunks: u64,
) -> bool {
    total_chunks >= MIN_ECHO_ACTIVITY_CHUNKS
        && suppressed_chunks
            .saturating_mul(100)
            >= total_chunks.saturating_mul(ECHO_DOMINATED_PERCENT)
}

pub(super) fn manual_turn_cue_to_discard<'a>(
    completed_cue_id: Option<&'a str>,
    current_cue_id: Option<&'a str>,
) -> Option<&'a str> {
    completed_cue_id.or(current_cue_id)
}

fn texts_are_probable_echoes(source: &str, output: &str) -> bool {
    let source = normalize_echo_text(source);
    let output = normalize_echo_text(output);
    if source.is_empty() || output.is_empty() {
        return false;
    }
    if source == output {
        return true;
    }

    let source_chars = source.chars().collect::<Vec<_>>();
    let output_chars = output.chars().collect::<Vec<_>>();
    let shorter_len = source_chars.len().min(output_chars.len());
    let longer_len = source_chars.len().max(output_chars.len());
    let length_ratio = shorter_len as f32 / longer_len as f32;
    if length_ratio >= 0.65 && (source.contains(&output) || output.contains(&source)) {
        return true;
    }
    if shorter_len < 4 || length_ratio < 0.6 {
        return false;
    }

    let source_bigrams = echo_bigrams(&source_chars);
    let output_bigrams = echo_bigrams(&output_chars);
    if source_bigrams.is_empty() || output_bigrams.is_empty() {
        return false;
    }
    let intersection = source_bigrams.intersection(&output_bigrams).count();
    let dice = (2 * intersection) as f32
        / (source_bigrams.len() + output_bigrams.len()) as f32;
    dice >= 0.8
}

fn normalize_echo_text(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn echo_bigrams(characters: &[char]) -> HashSet<(char, char)> {
    characters
        .windows(2)
        .map(|pair| (pair[0], pair[1]))
        .collect()
}

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
    pub(super) manual_response_pending: bool,
    pub(super) manual_response_item_id: Option<String>,
    pub(super) manual_turn_timed_out: bool,
}

#[cfg(test)]
mod manual_response_gate_tests {
    use super::*;

    #[test]
    fn rejects_empty_transcriptions() {
        assert_eq!(
            classify_manual_response("  ", "previous output", Some(500), true, false),
            ManualResponseDecision::SkipEmpty
        );
    }

    #[test]
    fn waits_for_a_completed_transcript_before_creating_a_response() {
        assert_eq!(
            classify_completed_manual_response(
                true,
                Some("item-current"),
                Some("item-current"),
                None,
                "",
                None,
                true,
                false,
            ),
            None
        );
        assert_eq!(
            classify_completed_manual_response(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("new completed source"),
                "",
                None,
                true,
                false,
            ),
            Some(ManualResponseDecision::Create)
        );
        assert_eq!(
            classify_completed_manual_response(
                false,
                Some("item-late"),
                Some("item-late"),
                Some("late completed source"),
                "",
                None,
                true,
                false,
            ),
            None
        );
    }

    #[test]
    fn rejects_uncorrelated_or_stale_completed_transcripts() {
        assert_eq!(
            classify_completed_manual_response(
                true,
                None,
                Some("item-current"),
                Some("source"),
                "",
                None,
                true,
                false,
            ),
            None
        );
        assert_eq!(
            classify_completed_manual_response(
                true,
                Some("item-current"),
                Some("item-stale"),
                Some("stale source"),
                "",
                None,
                true,
                false,
            ),
            None
        );
    }

    #[test]
    fn rejects_recent_translated_audio_echoes() {
        assert_eq!(
            classify_manual_response(
                "是的，就是这样。",
                "是的，就是这样！",
                Some(9_500),
                true,
                false,
            ),
            ManualResponseDecision::SkipRecentOutputEcho
        );
        assert_eq!(
            classify_manual_response(
                "Yes, that is exactly right",
                "Yes, that is exactly right.",
                Some(1_000),
                true,
                false,
            ),
            ManualResponseDecision::SkipRecentOutputEcho
        );
    }

    #[test]
    fn rejects_echo_dominated_asr_in_any_language_during_recent_playback() {
        assert_eq!(
            classify_manual_response(
                "这是直播版。我天，你快到我家过生日。",
                "这个视频将向你展示未来有多么史诗般。",
                Some(8_000),
                true,
                true,
            ),
            ManualResponseDecision::SkipEchoDominatedPlayback
        );
        assert_eq!(
            classify_manual_response(
                "A garbled replay in a Latin script",
                "The previous translated playback is different",
                Some(2_000),
                true,
                true,
            ),
            ManualResponseDecision::SkipEchoDominatedPlayback
        );
        assert!(recent_echo_input_is_dominated(360, 190));
        assert!(!recent_echo_input_is_dominated(360, 28));
    }

    #[test]
    fn allows_new_or_stale_source_audio() {
        assert_eq!(
            classify_manual_response(
                "A genuinely new sentence",
                "previous output",
                Some(500),
                true,
                false,
            ),
            ManualResponseDecision::Create
        );
        assert_eq!(
            classify_manual_response(
                "视频里本来就有的中文对白",
                "先前播放的中文译音",
                Some(500),
                true,
                false,
            ),
            ManualResponseDecision::Create
        );
        assert_eq!(
            classify_manual_response(
                "same sentence",
                "same sentence",
                Some(31_000),
                true,
                true,
            ),
            ManualResponseDecision::Create
        );
        assert_eq!(
            classify_manual_response(
                "same sentence",
                "same sentence",
                Some(500),
                false,
                true,
            ),
            ManualResponseDecision::Create
        );
    }

    #[test]
    fn secondary_turn_cleanup_keeps_the_completed_cue_id_after_current_is_released() {
        assert_eq!(
            manual_turn_cue_to_discard(Some("completed-secondary-cue"), None),
            Some("completed-secondary-cue"),
        );
        assert_eq!(
            manual_turn_cue_to_discard(None, Some("current-native-cue")),
            Some("current-native-cue"),
        );
    }
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
            mut manual_response_pending,
            mut manual_response_item_id,
            manual_turn_timed_out: _,
        } = state;
        let mut manual_turn_timed_out = false;
        if audio_mode.uses_manual_commit() {
            if let Ok(elapsed) = last_commit_time.elapsed() {
                if manual_response_pending
                    && elapsed.as_secs() >= MANUAL_RESPONSE_TIMEOUT_SECS
                {
                    manual_response_pending = false;
                    manual_response_item_id = None;
                    manual_turn_timed_out = true;
                    last_commit_time = SystemTime::now();
                    let _ = diag_log(
                        app,
                        "omni",
                        "warning",
                        "event=manual_response_gate_timeout action=drop_pending_response",
                    );
                } else if !manual_response_pending
                    && elapsed.as_secs() >= MANUAL_COMMIT_INTERVAL_SECS
                    && sent_audio_since_commit
                {
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
                        manual_response_pending = true;
                        manual_response_item_id = None;
                        let _ = diag_log(
                            app,
                            "omni",
                            "debug",
                            "event=manual_response_gate state=awaiting_transcription",
                        );
                    }
                }
            }
        }
        OmniCommitState {
            last_commit_time,
            sent_audio_since_commit,
            manual_response_pending,
            manual_response_item_id,
            manual_turn_timed_out,
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
    pub(super) playback_tx: mpsc::SyncSender<OmniPlaybackCommand>,
    pub(super) playback_stop_requested: Arc<AtomicBool>,
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
        let (playback_tx, playback_stop_requested, playback_join) =
            start_omni_playback(app.clone(), speech_config);
        Ok(OmniConnectedSession {
            socket,
            trace_call,
            session_started_at,
            active_voice,
            voice_fallback_applied,
            native_translation_reuse_active,
            playback_tx,
            playback_stop_requested,
            playback_join,
        })
    }
}
