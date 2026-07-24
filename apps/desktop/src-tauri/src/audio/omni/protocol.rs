fn set_socket_write_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_write_timeout(Some(Duration::from_secs(OMNI_WRITE_TIMEOUT_SECS)));
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream
                .get_mut()
                .set_write_timeout(Some(Duration::from_secs(OMNI_WRITE_TIMEOUT_SECS)));
        }
        _ => {}
    }
}

fn set_socket_read_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(OMNI_READ_TIMEOUT_MS)));
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(OMNI_READ_TIMEOUT_MS)));
        }
        _ => {}
    }
}

fn notify_reconnecting(store: &AudioStateStore, attempt: usize) {
    use super::contracts::SubtitleCueRuntime;
    let cue = SubtitleCueRuntime {
        cue_id: format!("omni-reconnecting-{}", unix_ms()),
        route_direction: "inbound".to_string(),
        source_text: format!(
            "[Omni] 正在重新连接实时翻译服务 (第 {}/{})...",
            attempt, OMNI_RECONNECT_MAX_RETRIES
        ),
        display_source_text: String::new(),
        display_segments: Vec::new(),
        translated_text: String::new(),
        started_at: ms_marker(unix_ms()),
        ended_at: ms_marker(unix_ms()),
        committed: true,
    };
    store.push_subtitle_cue(cue);
}

fn try_reconnect(
    reconnect_count: &mut usize,
    pending_audio_buffer: &mut Vec<i16>,
    store: &AudioStateStore,
    app: &AppHandle,
    provider: &ProviderDraftInput,
    active_voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
    buffer_size: u64,
) -> Result<tungstenite::WebSocket<MaybeTlsStream<TcpStream>>, String> {
    pending_audio_buffer.clear();
    let mut last_error = None;

    // A provider may close a long-running realtime response normally. Treat
    // retries as belonging to this disconnect, not as a lifetime quota for the
    // route. The previous implementation attempted only once per disconnect
    // and never reset the counter, eventually dropping audio_rx and leaving the
    // capture worker with a closed sender.
    for attempt in 1..=OMNI_RECONNECT_MAX_RETRIES {
        *reconnect_count = attempt;
        notify_reconnecting(store, attempt);
        thread::sleep(backoff_delay(attempt));
        match reconnect_socket(
            app.clone(),
            provider,
            active_voice,
            instructions,
            audio_mode,
            target_language,
        ) {
            Ok(socket) => {
                *reconnect_count = 0;
                store.set_stt_connected(true, buffer_size);
                return Ok(socket);
            }
            Err(error) => {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "warning",
                    "watch_mode.omni_reconnect_attempt_failed",
                    format!("attempt={attempt} maxAttempts={OMNI_RECONNECT_MAX_RETRIES} error={error}"),
                );
                last_error = Some(error);
            }
        }
    }

    store.set_stt_connected(false, buffer_size);
    Err(format!(
        "Omni WebSocket reconnect retry limit exhausted after {OMNI_RECONNECT_MAX_RETRIES} attempts: {}",
        last_error.unwrap_or_else(|| "unknown reconnect error".to_string())
    ))
}

fn check_vad_warning(
    app: &AppHandle,
    last_vad_event_time: &SystemTime,
    chunk_count: u64,
    vad_event_count: u64,
    buffer_size: u64,
) -> bool {
    if let Ok(elapsed) = last_vad_event_time.elapsed() {
        if elapsed.as_secs() >= OMNI_VAD_WARNING_INTERVAL_SECS && chunk_count > 0 {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[VAD] 尚无 VAD 事件（已等待 {}s, 已发送 {} 块音频, {} 字节, VAD 事件计数={})",
                    elapsed.as_secs(),
                    chunk_count,
                    buffer_size,
                    vad_event_count
                ),
            );
            return true;
        }
    }
    false
}

fn handle_session_ready_event(
    app: &AppHandle,
    event_type: &str,
    evt: &Value,
    session_ready_for_audio: &mut bool,
    pre_session_audio_dropped: u64,
    pre_session_audio_queue_len: usize,
) {
    match event_type {
        "session.created" => {
            let became_ready = !*session_ready_for_audio;
            *session_ready_for_audio = true;
            let session_id = evt["session"]["id"].as_str().unwrap_or("?");
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] session.created: id={session_id} audioReady=true queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                    pre_session_audio_queue_len
                ),
            );
            if became_ready {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "info",
                    "watch_mode.omni_session_ready",
                    format!(
                        "event={} queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                        event_type, pre_session_audio_queue_len
                    ),
                );
            }
        }
        "session.updated" if is_session_ready_event(event_type) => {
            let became_ready = !*session_ready_for_audio;
            *session_ready_for_audio = true;
            let _ = diag_log(
                app,
                "omni",
                "debug",
                format!(
                    "[EVENT] session.updated: session config confirmed audioReady=true queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                    pre_session_audio_queue_len
                ),
            );
            if became_ready {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "info",
                    "watch_mode.omni_session_ready",
                    format!(
                        "event={} queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                        event_type, pre_session_audio_queue_len
                    ),
                );
            }
        }
        _ => {}
    }
}

fn is_session_ready_event(event_type: &str) -> bool {
    matches!(event_type, "session.created" | "session.updated")
}

#[derive(Debug, Default, Clone)]
struct OmniEventDiagnostics {
    readiness_event: Option<String>,
    current_cue_origin: Option<String>,
    last_asr_delta_text: String,
    last_asr_delta_at_ms: Option<u64>,
    last_asr_completed_text: String,
    last_asr_completed_at_ms: Option<u64>,
    empty_asr_completed_count: u64,
    first_non_empty_asr_completed_at_ms: Option<u64>,
    last_output_done_text: String,
    last_output_done_at_ms: Option<u64>,
    first_response_done_at_ms: Option<u64>,
    response_done_count: u64,
}

fn elapsed_ms_since(start: &SystemTime) -> u64 {
    start
        .elapsed()
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn should_use_native_output_fallback(
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
    source_text: &str,
    translated_text: &str,
) -> bool {
    subtitle_translate_active
        && !native_translation_reuse_active
        && source_text.trim().is_empty()
        && !translated_text.trim().is_empty()
}

#[allow(clippy::too_many_arguments)]
fn handle_response_done(
    app: &AppHandle,
    store: &AudioStateStore,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall,
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
    session_started_at: &SystemTime,
) {
    let response_done_at_ms = elapsed_ms_since(session_started_at);
    event_diagnostics.response_done_count = event_diagnostics.response_done_count.saturating_add(1);
    event_diagnostics
        .first_response_done_at_ms
        .get_or_insert(response_done_at_ms);
    let cue_id = current_cue_id
        .take()
        .unwrap_or_else(|| format!("omni-cue-{}", unix_ms()));
    let source_len = pending_source_text.len();
    let translated_len = pending_translated_text.len();
    let st_flag = if subtitle_translate_active {
        " st_active=true"
    } else {
        ""
    };
    trace_call.output(
        "response.done",
        json!({
          "cueId": cue_id,
          "sourceText": pending_source_text.clone(),
          "translatedText": pending_translated_text.clone(),
          "sourceLen": source_len,
          "translatedLen": translated_len,
          "subtitleTranslateActive": subtitle_translate_active,
        }),
    );
    let readiness_event = event_diagnostics
        .readiness_event
        .as_deref()
        .unwrap_or("(none)");
    let cue_origin = event_diagnostics
        .current_cue_origin
        .as_deref()
        .unwrap_or("(none)");
    let _ = diag_log(
        app,
        "omni",
        "info",
        format!(
            "[EVENT_CONTEXT] response.done cue_id={cue_id} responseDoneCount={} responseDoneAtMs={} firstResponseDoneAtMs={} readinessEvent={} cueOrigin={} sourceLen={} translatedLen={} lastAsrDeltaAtMs={} lastAsrDelta=\"{}\" lastAsrCompletedAtMs={} lastAsrCompleted=\"{}\" firstNonEmptyAsrCompletedAtMs={} emptyAsrCompletedCount={} lastOutputDoneAtMs={} lastOutputDone=\"{}\" st_active={} nativeTranslationReuse={}",
            event_diagnostics.response_done_count,
            response_done_at_ms,
            event_diagnostics.first_response_done_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            readiness_event,
            cue_origin,
            source_len,
            translated_len,
            event_diagnostics.last_asr_delta_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_asr_delta_text,
            event_diagnostics.last_asr_completed_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_asr_completed_text,
            event_diagnostics.first_non_empty_asr_completed_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.empty_asr_completed_count,
            event_diagnostics.last_output_done_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_output_done_text,
            subtitle_translate_active,
            native_translation_reuse_active,
        ),
    );
    if subtitle_translate_active {
        if native_translation_reuse_active && !pending_translated_text.trim().is_empty() {
            let source = if pending_source_text.trim().is_empty() {
                pending_translated_text.clone()
            } else {
                pending_source_text.clone()
            };
            write_native_translation_to_cue(
                store,
                &cue_id,
                &source,
                pending_translated_text,
                true,
                false,
            );
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] response.done -> ST_NATIVE_TRANSLATION_COMMIT{st_flag} cue_id={cue_id} source_len={} translated_len={translated_len} translated=\"{}\"",
                    source.len(),
                    pending_translated_text
                ),
            );
        } else if !pending_source_text.is_empty() {
            let src_preview = if pending_source_text.len() > 200 {
                format!("{}...", crate::audio::str_utils::truncate_chars(pending_source_text, 200))
            } else {
                pending_source_text.clone()
            };
            store.update_or_push_stt_cue(&cue_id, pending_source_text, false);
            let snapshot = store.snapshot();
            let cue_state = snapshot
                .subtitle_overlay
                .recent_cues
                .iter()
                .find(|c| c.cue_id == cue_id)
                .map(|c| {
                    format!(
                        "committed={} translated_empty={} src_len={}B",
                        c.committed,
                        c.translated_text.is_empty(),
                        c.source_text.len()
                    )
                })
                .unwrap_or_else(|| "cue_not_found".to_string());
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] response.done → ST_SOURCE_ONLY{st_flag} cue_id={cue_id} src=\"{src_preview}\" src_len={source_len} cue_state=[{cue_state}] (翻译留给 subtitle_translate worker)"
                ),
            );
        } else if should_use_native_output_fallback(
            subtitle_translate_active,
            native_translation_reuse_active,
            pending_source_text,
            pending_translated_text,
        ) {
            write_native_translation_to_cue(
                store,
                &cue_id,
                pending_translated_text,
                pending_translated_text,
                true,
                false,
            );
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[EVENT] response.done -> ST_NATIVE_OUTPUT_FALLBACK{st_flag} cue_id={cue_id} source_len=0 translated_len={translated_len} translated=\"{}\" reason=empty_source_text",
                    pending_translated_text
                ),
            );
        } else {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!("[EVENT] response.done → SKIP{st_flag} cue_id={cue_id} 源文本为空！"),
            );
        }
    } else if !pending_translated_text.is_empty() {
        let source = if pending_source_text.is_empty() {
            pending_translated_text.clone()
        } else {
            pending_source_text.clone()
        };
        store.update_or_push_stt_cue(&cue_id, &source, true);
        store.update_subtitle_cue_translation(&cue_id, pending_translated_text.clone(), true);
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!(
                    "[EVENT] response.done → COMMIT{st_flag} cue_id={cue_id} source_len={source_len} translated_len={translated_len} translated=\"{}\"",
                pending_translated_text
            ),
        );
    } else if !pending_source_text.is_empty() {
        let src_preview = if pending_source_text.len() > 150 {
            format!("{}...", crate::audio::str_utils::truncate_chars(pending_source_text, 150))
        } else {
            pending_source_text.clone()
        };
        store.update_or_push_stt_cue(&cue_id, pending_source_text, true);
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!(
                    "[EVENT] response.done → COMMIT(仅源文本, 无翻译){st_flag} cue_id={cue_id} src=\"{src_preview}\" src_len={source_len} translated_len={translated_len}"
            ),
        );
    } else {
        let _ = diag_log(
            app,
            "omni",
            "warning",
            format!(
                "[EVENT] response.done → SKIP{st_flag} cue_id={cue_id} 源文本和翻译文本均为空"
            ),
        );
    }
    let _ = diag_log(
        app,
        "omni",
        "debug",
        "[STATE] 重置: current_cue_id=None, pending_source_text cleared, pending_translated_text cleared".to_string(),
    );
    pending_source_text.clear();
    pending_translated_text.clear();
    *current_cue_id = None;
    event_diagnostics.current_cue_origin = None;
    *transcription_completed_flag = false;
    *transcription_completed_at = None;
}

fn is_livetranslate_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("livetranslate")
}

fn ensure_transcription_cue_id(current_cue_id: &mut Option<String>) -> String {
    current_cue_id
        .get_or_insert_with(|| format!("omni-cue-{}", unix_ms()))
        .clone()
}

fn write_native_translation_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
    committed: bool,
    segment_pending: bool,
) {
    if translated_text.trim().is_empty() {
        return;
    }
    let display_source_text = if source_text.trim().is_empty() {
        translated_text.trim().to_string()
    } else {
        source_text.trim().to_string()
    };
    let source_lines = SubtitleDisplaySegmenter::split_text(&display_source_text);
    let translated_lines = SubtitleDisplaySegmenter::split_text(translated_text);
    let display_segments = (0..source_lines.len().max(translated_lines.len()))
        .map(|index| SubtitleDisplaySegmentRuntime {
            source_text: source_lines.get(index).cloned().unwrap_or_default(),
            translated_text: translated_lines.get(index).cloned().unwrap_or_default(),
            pending: segment_pending,
        })
        .collect();
    store.update_or_push_stt_cue(cue_id, &display_source_text, false);
    store.update_subtitle_cue_display_segments(
        cue_id,
        source_lines.join("\n"),
        display_segments,
        translated_lines.join("\n"),
        committed,
    );
}

fn normalize_livetranslate_language(language: &str, fallback: &str) -> String {
    let trimmed = language.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "zh-cn" | "zh-hans" | "zh_cn" | "zh" | "chinese" => "zh".to_string(),
        "en-us" | "en-gb" | "en" | "english" => "en".to_string(),
        _ => lower
            .split(['-', '_'])
            .next()
            .filter(|part| !part.is_empty())
            .unwrap_or(fallback)
            .to_string(),
    }
}

fn build_omni_session_update(
    model: &str,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Value {
    let is_livetranslate = is_livetranslate_model(model);
    let input_audio_format = if is_livetranslate { "pcm" } else { "pcm16" };
    let turn_detection = audio_mode.turn_detection();
    let mut session_cfg = json!({
      "type": "session.update",
      "session": {
        "modalities": ["text", "audio"],
        "instructions": instructions,
        "input_audio_format": input_audio_format,
        "sample_rate": 16000,
        "output_audio_format": "pcm",
        "turn_detection": turn_detection
      }
    });
    let trimmed_voice = voice.trim();
    if !trimmed_voice.is_empty() {
        session_cfg["session"]["voice"] = json!(trimmed_voice);
    }
    if is_livetranslate {
        let source_language = "en";
        let target_language = normalize_livetranslate_language(target_language, "zh");
        session_cfg["session"]["input_audio_transcription"] = json!({
          "model": "qwen3-asr-flash-realtime",
          "language": source_language
        });
        session_cfg["session"]["translation"] = json!({
          "language": target_language
        });
    }
    session_cfg
}

fn is_unsupported_voice_error(code: &str, message: &str) -> bool {
    let lower_message = message.to_ascii_lowercase();
    code == "InternalError.Algo.InvalidParameter"
        || (lower_message.contains("voice") && lower_message.contains("not supported"))
        || (message.contains("InvalidParameter") && lower_message.contains("voice"))
}

enum OmniPlaybackCommand {
    Play {
        samples: Vec<i16>,
        cue_id: String,
        sample_rate_hz: u32,
    },
    Stop,
}

#[derive(Debug, Clone)]
pub(crate) struct OmniSpeechConfig {
    enabled: bool,
    local_playback_enabled: bool,
    virtual_mic_output_enabled: bool,
    speaker_device_id: Option<String>,
    speaker_output_level: u64,
}

impl OmniSpeechConfig {
    pub(crate) fn from_config(config_value: &Value) -> Self {
        let speech_enabled = config_value
            .pointer("/speech/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let device_output_enabled = config_value
            .pointer("/devices/outputSpeechEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let native_audio_enabled =
            super::speech::resolve_translation_audio_source(config_value, true)
                == super::speech::TranslationAudioSource::OmniNative;
        Self {
            enabled: native_audio_enabled && (speech_enabled || device_output_enabled),
            local_playback_enabled: super::speech::desktop_direct_playback_enabled_for_config(
                config_value,
            ),
            virtual_mic_output_enabled: config_value
                .pointer("/speech/virtualMicOutputEnabled")
                .and_then(Value::as_bool)
                .or_else(|| {
                    config_value
                        .pointer("/devices/virtualMicOutputEnabled")
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false),
            speaker_device_id: config_value
                .pointer("/devices/outputDeviceId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
            speaker_output_level: config_value
                .pointer("/devices/outputLevel")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(100),
        }
    }

    fn any_output(&self) -> bool {
        self.enabled && (self.local_playback_enabled || self.virtual_mic_output_enabled)
    }
}

fn start_omni_playback(
    app: AppHandle,
    speech_config: OmniSpeechConfig,
) -> (mpsc::Sender<OmniPlaybackCommand>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<OmniPlaybackCommand>();
    let join = thread::Builder::new()
        .name("omni-playback".to_string())
        .spawn(move || {
            let audio_state = app.state::<AudioStateStore>();
            loop {
                let cmd = match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(cmd) => cmd,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                match cmd {
                    OmniPlaybackCommand::Stop => {
                        audio_state.update_speech(|s| {
                            s.dispatch_state = "idle".to_string();
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);
                        break;
                    }
                    OmniPlaybackCommand::Play {
                        samples,
                        cue_id,
                        sample_rate_hz,
                    } => {
                        let cfg = &speech_config;
                        let duration_ms =
                            ((samples.len() as u64) * 1000).saturating_div(sample_rate_hz as u64);
                        let _ = diag_log(&app, "omni", "info",
                            format!(
                                "[AUDIO] playback request received: cue_id={cue_id} samples={} sample_rate_hz={sample_rate_hz} duration_ms={duration_ms} enabled={} local_playback={} virtual_mic={}",
                                samples.len(),
                                cfg.enabled,
                                cfg.local_playback_enabled,
                                cfg.virtual_mic_output_enabled
                            ));
                        if !cfg.any_output() {
                            let _ = diag_log(&app, "omni", "warning",
                                format!(
                                    "[AUDIO] speech output disabled, skipping {} samples for cue_id={cue_id}; enabled={} local_playback={} virtual_mic={}",
                                    samples.len(),
                                    cfg.enabled,
                                    cfg.local_playback_enabled,
                                    cfg.virtual_mic_output_enabled
                                ));
                            continue;
                        }
                        audio_state.update_speech(|s| {
                            s.dispatch_state = "playing".to_string();
                            s.output_target =
                                match (cfg.local_playback_enabled, cfg.virtual_mic_output_enabled) {
                                    (true, true) => "both".to_string(),
                                    (false, true) => "virtual-mic".to_string(),
                                    _ => "speaker".to_string(),
                                };
                            s.current_cue_id = Some(cue_id.clone());
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);

                        let output_route = super::speech::SpeechOutputRoutePlan::new(
                            cfg.local_playback_enabled,
                            cfg.virtual_mic_output_enabled,
                        );
                        let speaker_frames = if output_route.play_to_speaker {
                            let echo_reference = super::speech::i16_to_f32(&samples);
                            audio_state.push_echo_reference(&echo_reference, sample_rate_hz, 1);
                            let result = super::speech::play_to_speaker(
                                &samples,
                                sample_rate_hz,
                                1,
                                cfg.speaker_device_id.as_deref(),
                                cfg.speaker_output_level,
                            );
                            match result {
                                Ok(frames) => {
                                    let _ = diag_log(&app, "omni", "info",
                                        format!(
                                            "[AUDIO] speaker playback completed: cue_id={cue_id} frames={frames} sample_rate_hz={sample_rate_hz}"
                                        ));
                                    frames
                                }
                                Err(error) => {
                                    let _ = diag_log(&app, "omni", "error",
                                        format!(
                                            "[AUDIO] speaker playback failed: cue_id={cue_id} error={error}"
                                        ));
                                    0
                                }
                            }
                        } else {
                            0
                        };

                        let vmic_frames = if output_route.write_to_virtual_mic {
                            let req_id = format!("omni-play-{}", unix_ms());
                            let vmic_samples = super::speech::scale_i16_by_output_level(
                                &samples,
                                cfg.speaker_output_level,
                            );
                            match BridgeAudioWriter::new(&app).write_translation_frame(
                                &cue_id,
                                &req_id,
                                &vmic_samples,
                                sample_rate_hz,
                                1,
                            )
                            {
                                Ok(frames) => {
                                    let _ = diag_log(&app, "omni", "info",
                                        format!(
                                            "[AUDIO] virtual mic write completed: cue_id={cue_id} request_id={req_id} frames={frames} sample_rate_hz={sample_rate_hz}"
                                        ));
                                    frames
                                }
                                Err(error) => {
                                    let _ = diag_log(&app, "omni", "error",
                                        format!(
                                            "[AUDIO] virtual mic write failed: cue_id={cue_id} request_id={req_id} error={error}"
                                        ));
                                    0
                                }
                            }
                        } else {
                            0
                        };

                        audio_state.update_speech(|s| {
                            s.dispatch_state = "waiting-subtitle".to_string();
                            s.current_cue_id = None;
                            s.speaker_frames_written += speaker_frames;
                            s.virtual_mic_frames_written += vmic_frames;
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);
                        let _ = diag_log(&app, "omni", "info",
                            format!(
                                "[AUDIO] 鎾斁瀹屾垚: cue_id={cue_id} speaker={speaker_frames} frames, vmic={vmic_frames} frames"
                            ));
                    }
                }
            }
        })
        .expect("failed to spawn omni-playback thread");
    (tx, join)
}
