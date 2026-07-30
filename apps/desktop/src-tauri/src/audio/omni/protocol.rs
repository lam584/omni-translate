use super::*;

use crate::audio::realtime_ws;

pub(super) fn set_socket_write_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    realtime_ws::set_socket_timeouts(
        socket,
        None,
        Some(Duration::from_secs(OMNI_WRITE_TIMEOUT_SECS)),
    );
}

pub(super) fn set_socket_read_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    realtime_ws::set_socket_timeouts(
        socket,
        Some(Duration::from_millis(OMNI_READ_TIMEOUT_MS)),
        None,
    );
}

fn notify_reconnecting(store: &AudioStateStore, attempt: usize) {
    realtime_ws::push_reconnecting_cue(
        store,
        "omni-reconnecting",
        format!(
            "[Omni] 正在重新连接实时翻译服务 (第 {}/{})...",
            attempt, OMNI_RECONNECT_MAX_RETRIES
        ),
    );
}

pub(super) fn try_reconnect<C: RealtimeSocketConnector, R: tauri::Runtime>(
    connector: &C,
    reconnect_count: &mut usize,
    pending_audio_buffer: &mut Vec<i16>,
    store: &AudioStateStore,
    app: &AppHandle<R>,
    provider: &ProviderDraftInput,
    active_voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
    buffer_size: u64,
    disconnect_reason: &str,
) -> Result<C::Socket, String> {
    pending_audio_buffer.clear();
    let mut last_error = None;

    // A provider may close a long-running realtime response normally. Treat
    // retries as belonging to this disconnect, not as a lifetime quota for the
    // route. The previous implementation attempted only once per disconnect
    // and never reset the counter, eventually dropping audio_rx and leaving the
    // capture worker with a closed sender.
    for attempt in 1..=OMNI_RECONNECT_MAX_RETRIES {
        *reconnect_count = attempt;
        store.mark_stt_reconnecting(
            attempt as u64,
            OMNI_RECONNECT_MAX_RETRIES as u64,
            disconnect_reason,
        );
        let _ = emit_audio_snapshot(app, store);
        notify_reconnecting(store, attempt);
        thread::sleep(backoff_delay(attempt));
        match connector.reconnect(
            app,
            provider,
            active_voice,
            instructions,
            audio_mode,
            target_language,
        ) {
            Ok(socket) => {
                *reconnect_count = 0;
                store.discard_uncommitted_subtitle_cues();
                store.bump_reconnect_generation();
                store.set_stt_connected(true, buffer_size);
                let _ = emit_audio_snapshot(app, store);
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
    let _ = emit_audio_snapshot(app, store);
    // Classify the final connect failure so the frontend can distinguish a
    // credential rejection from plain network trouble after exhaustion.
    let last_error = last_error.unwrap_or_else(|| "unknown reconnect error".to_string());
    let code = classify_connect_error(&last_error);
    Err(with_error_markers(
        &format!(
            "Omni WebSocket reconnect retry limit exhausted after {OMNI_RECONNECT_MAX_RETRIES} attempts: {last_error}"
        ),
        code,
    ))
}

pub(super) fn check_vad_warning<R: tauri::Runtime>(
    app: &AppHandle<R>,
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

pub(super) fn handle_session_ready_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
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

pub(super) fn is_session_ready_event(event_type: &str) -> bool {
    matches!(event_type, "session.created" | "session.updated")
}

#[derive(Debug, Default, Clone)]
pub(super) struct OmniEventDiagnostics {
    pub(super) readiness_event: Option<String>,
    pub(super) current_cue_origin: Option<String>,
    pub(super) last_asr_delta_text: String,
    pub(super) last_asr_delta_at_ms: Option<u64>,
    pub(super) last_asr_delta_item_id: Option<String>,
    pub(super) last_asr_completed_text: String,
    pub(super) last_asr_completed_at_ms: Option<u64>,
    pub(super) empty_asr_completed_count: u64,
    pub(super) first_non_empty_asr_completed_at_ms: Option<u64>,
    pub(super) last_output_done_text: String,
    pub(super) last_output_done_at_ms: Option<u64>,
    pub(super) first_response_done_at_ms: Option<u64>,
    pub(super) response_done_count: u64,
}

pub(super) fn elapsed_ms_since(start: &SystemTime) -> u64 {
    start
        .elapsed()
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub(super) fn should_use_native_output_fallback(
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
pub(super) fn handle_response_done<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    direction: &str,
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
        .unwrap_or_else(|| format!("omni-cue-{direction}-{}", unix_ms()));
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
    } else if !pending_translated_text.trim().is_empty() {
        let source = if pending_source_text.is_empty() {
            pending_translated_text.clone()
        } else {
            pending_source_text.clone()
        };
        write_committed_native_translation_to_cue(
            store,
            &cue_id,
            &source,
            pending_translated_text,
        );
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
    reset_omni_turn_state(
        current_cue_id,
        pending_source_text,
        pending_translated_text,
        transcription_completed_flag,
        transcription_completed_at,
        event_diagnostics,
    );
}

pub(super) fn reset_omni_turn_state(
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
) {
    pending_translated_text.clear();
    reset_manual_turn_input_state(
        current_cue_id,
        pending_source_text,
        transcription_completed_flag,
        transcription_completed_at,
        event_diagnostics,
    );
}

/// Releases the input-side state of a manual turn without touching the
/// response output stream (`pending_audio_*`, `pending_translated_text`).
/// A skipped or timed-out manual turn never issued `response.create`, so any
/// buffered output belongs to a previous turn that may still be streaming.
pub(super) fn reset_manual_turn_input_state(
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
) {
    pending_source_text.clear();
    *current_cue_id = None;
    event_diagnostics.current_cue_origin = None;
    event_diagnostics.last_asr_delta_item_id = None;
    *transcription_completed_flag = false;
    *transcription_completed_at = None;
}

/// A response output stream is active between its first output event and the
/// response.done / audio.done cleanup. While it is active, the output buffers
/// must survive a manual-gate reset for a later, skipped turn.
pub(super) fn manual_turn_response_stream_active(
    pending_audio_delta_count: u64,
    pending_audio_buffer_len: usize,
    pending_audio_response_id: Option<&str>,
    pending_translated_text: &str,
) -> bool {
    pending_audio_delta_count > 0
        || pending_audio_buffer_len > 0
        || pending_audio_response_id.is_some()
        || !pending_translated_text.is_empty()
}

/// In native-reuse and audio-only modes the streaming response writes into
/// `current_cue_id`; discarding that shared cue on a skipped turn would delete
/// the previous turn's live translation from the overlay. Only the secondary
/// subtitle path keeps `current_cue_id` exclusively on the input side.
pub(super) fn response_stream_owns_current_cue(
    response_stream_active: bool,
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
) -> bool {
    response_stream_active
        && (native_translation_reuse_active || !subtitle_translate_active)
}

#[cfg(test)]
mod manual_turn_state_tests {
    use super::*;

    #[test]
    fn skipped_manual_response_clears_turn_state_without_response_done() {
        let mut current_cue_id = Some("manual-turn".to_string());
        let mut pending_source_text = "echoed translation".to_string();
        let mut pending_translated_text = "stale translation".to_string();
        let mut transcription_completed_flag = true;
        let mut transcription_completed_at = Some(SystemTime::now());
        let mut event_diagnostics = OmniEventDiagnostics {
            current_cue_origin: Some("transcription_completed".to_string()),
            ..OmniEventDiagnostics::default()
        };

        reset_omni_turn_state(
            &mut current_cue_id,
            &mut pending_source_text,
            &mut pending_translated_text,
            &mut transcription_completed_flag,
            &mut transcription_completed_at,
            &mut event_diagnostics,
        );

        assert!(current_cue_id.is_none());
        assert!(pending_source_text.is_empty());
        assert!(pending_translated_text.is_empty());
        assert!(!transcription_completed_flag);
        assert!(transcription_completed_at.is_none());
        assert!(event_diagnostics.current_cue_origin.is_none());
    }

    #[test]
    fn skipped_turn_reset_detects_a_previous_turns_streaming_response() {
        assert!(manual_turn_response_stream_active(3, 4_800, Some("resp-1"), "部分译文"));
        assert!(manual_turn_response_stream_active(0, 0, None, "译文尾部"));
        assert!(!manual_turn_response_stream_active(0, 0, None, ""));

        // Native-reuse and audio-only modes stream output into the shared cue.
        assert!(response_stream_owns_current_cue(true, true, true));
        assert!(response_stream_owns_current_cue(true, false, false));
        // The secondary subtitle path never writes response output into cues.
        assert!(!response_stream_owns_current_cue(true, true, false));
        assert!(!response_stream_owns_current_cue(false, true, true));
    }

    #[test]
    fn manual_turn_input_reset_releases_only_input_side_state() {
        let mut current_cue_id = Some("skipped-turn".to_string());
        let mut pending_source_text = "skipped source".to_string();
        let mut transcription_completed_flag = true;
        let mut transcription_completed_at = Some(SystemTime::now());
        let mut event_diagnostics = OmniEventDiagnostics {
            current_cue_origin: Some("transcription_delta".to_string()),
            last_asr_delta_item_id: Some("item-skip".to_string()),
            ..OmniEventDiagnostics::default()
        };

        reset_manual_turn_input_state(
            &mut current_cue_id,
            &mut pending_source_text,
            &mut transcription_completed_flag,
            &mut transcription_completed_at,
            &mut event_diagnostics,
        );

        assert!(current_cue_id.is_none());
        assert!(pending_source_text.is_empty());
        assert!(!transcription_completed_flag);
        assert!(transcription_completed_at.is_none());
        assert!(event_diagnostics.current_cue_origin.is_none());
        assert!(event_diagnostics.last_asr_delta_item_id.is_none());
    }
}

#[cfg(test)]
pub(super) fn is_livetranslate_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("livetranslate")
}

pub(super) fn ensure_transcription_cue_id(
    direction: &str,
    current_cue_id: &mut Option<String>,
) -> String {
    // The direction marker inside the id is how the state store tags the
    // created cue's route_direction (see cue_lifecycle::route_direction_from_cue_id).
    current_cue_id
        .get_or_insert_with(|| format!("omni-cue-{direction}-{}", unix_ms()))
        .clone()
}

pub(super) fn write_live_source_to_cue(
    store: &AudioStateStore,
    direction: &str,
    current_cue_id: &mut Option<String>,
    source_text: &str,
    defer_secondary_translation: bool,
) -> String {
    let cue_id = ensure_transcription_cue_id(direction, current_cue_id);
    if defer_secondary_translation {
        store.defer_subtitle_cue_translation(&cue_id);
    }
    store.update_or_push_stt_cue(&cue_id, source_text, false);
    cue_id
}

pub(super) fn write_native_output_preview_to_cue(
    store: &AudioStateStore,
    direction: &str,
    current_cue_id: &mut Option<String>,
    source_text: &str,
    translated_text: &str,
) -> String {
    let cue_id = ensure_transcription_cue_id(direction, current_cue_id);
    write_native_translation_payload_to_cue(
        store,
        &cue_id,
        source_text,
        translated_text,
        false,
        true,
        false,
        false,
    );
    cue_id
}

pub(super) fn write_native_output_final_to_cue(
    store: &AudioStateStore,
    direction: &str,
    current_cue_id: &mut Option<String>,
    source_text: &str,
    translated_text: &str,
) -> String {
    let cue_id = ensure_transcription_cue_id(direction, current_cue_id);
    write_native_translation_payload_to_cue(
        store,
        &cue_id,
        source_text,
        translated_text,
        false,
        false,
        false,
        false,
    );
    cue_id
}

pub(super) struct ResolvedCompletedTranscription {
    pub(super) display_text: String,
    pub(super) response_gate_text: String,
}

pub(super) fn resolve_completed_transcription(
    pending: &str,
    completed: &str,
    pending_matches_completed_item: bool,
) -> ResolvedCompletedTranscription {
    ResolvedCompletedTranscription {
        display_text: if completed.trim().is_empty() {
            pending.to_string()
        } else {
            completed.to_string()
        },
        response_gate_text: if completed.trim().is_empty()
            && pending_matches_completed_item
        {
            pending.to_string()
        } else {
            completed.to_string()
        },
    }
}

pub(super) fn write_native_translation_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
    committed: bool,
    streaming: bool,
) {
    write_native_translation_payload_to_cue(
        store,
        cue_id,
        source_text,
        translated_text,
        committed,
        streaming,
        true,
        false,
    );
}

/// Commit write for the native path that runs without the secondary subtitle
/// worker (and therefore without segment TTS): allowed to re-arrange rows into
/// source/translation blocks when the two sides do not line up.
pub(super) fn write_committed_native_translation_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
) {
    write_native_translation_payload_to_cue(
        store,
        cue_id,
        source_text,
        translated_text,
        true,
        false,
        false,
        true,
    );
}

#[allow(clippy::too_many_arguments)]
fn write_native_translation_payload_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
    committed: bool,
    streaming: bool,
    fallback_to_translation_source: bool,
    align_mismatched_lines: bool,
) {
    if translated_text.trim().is_empty() {
        return;
    }
    let display_source_text = if fallback_to_translation_source && source_text.trim().is_empty() {
        translated_text.trim().to_string()
    } else {
        source_text.trim().to_string()
    };
    let source_lines = SubtitleDisplaySegmenter::split_text(&display_source_text);
    let translated_lines = SubtitleDisplaySegmenter::split_text(translated_text);
    let display_segments: Vec<SubtitleDisplaySegmentRuntime> = if align_mismatched_lines
        && source_lines.len() != translated_lines.len()
    {
        // Committed turn whose translation does not line up with the source
        // (realtime models often merge sentences or re-translate only the tail
        // of the audio window). Index pairing would attach translations to the
        // wrong source rows and leave the leftover rows looking permanently
        // failed, so render the full source block followed by the full
        // translation block. Only the commit path with segment TTS out of the
        // picture opts in: segment-TTS dedupe keys embed row indices and
        // texts, and re-slotting the rows of a cue that already streamed
        // would replay already-spoken audio.
        source_lines
            .iter()
            .map(|row| SubtitleDisplaySegmentRuntime {
                source_text: row.clone(),
                translated_text: String::new(),
                pending: false,
            })
            .chain(
                translated_lines
                    .iter()
                    .map(|row| SubtitleDisplaySegmentRuntime {
                        source_text: String::new(),
                        translated_text: row.clone(),
                        pending: false,
                    }),
            )
            .collect()
    } else {
        let line_count = source_lines.len().max(translated_lines.len());
        let has_untranslated_source = source_lines
            .iter()
            .enumerate()
            .any(|(index, source)| !source.trim().is_empty() && translated_lines.get(index).is_none_or(|translated| translated.trim().is_empty()));
        let keep_live_tail = streaming
            && (has_untranslated_source || !has_terminal_subtitle_boundary(translated_text));
        // Source and translation wrap independently. When their line counts differ,
        // the two live tails must remain independently identifiable instead of
        // marking only the final row of the wider column.
        let pending_source_index = if keep_live_tail {
            source_lines.len().checked_sub(1)
        } else {
            None
        };
        let pending_translation_index = if streaming
            && !has_terminal_subtitle_boundary(translated_text)
        {
            translated_lines.len().checked_sub(1)
        } else {
            None
        };
        (0..line_count)
            .map(|index| SubtitleDisplaySegmentRuntime {
                source_text: source_lines.get(index).cloned().unwrap_or_default(),
                translated_text: translated_lines.get(index).cloned().unwrap_or_default(),
                pending: pending_source_index == Some(index)
                    || pending_translation_index == Some(index),
            })
            .collect()
    };
    store.update_or_push_stt_cue(cue_id, &display_source_text, false);
    store.update_subtitle_cue_display_segments(
        cue_id,
        source_lines.join("\n"),
        display_segments,
        translated_lines.join("\n"),
        committed,
    );
}

fn has_terminal_subtitle_boundary(text: &str) -> bool {
    text.trim_end()
        .chars()
        .next_back()
        .is_some_and(|character| matches!(character, '.' | '!' | '?' | ';' | '。' | '！' | '？' | '；'))
        || text.ends_with('\n')
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

fn build_omni_session_update_with_dialect(
    is_livetranslate: bool,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Value {
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

pub(crate) fn build_dashscope_session_update(
    protocol: crate::audio::events::RealtimeProtocol,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Result<Value, String> {
    let is_livetranslate = match protocol {
        crate::audio::events::RealtimeProtocol::DashscopeOmni => false,
        crate::audio::events::RealtimeProtocol::DashscopeLivetranslate => true,
        other => return Err(format!("unsupported DashScope session protocol: {other:?}")),
    };
    Ok(build_omni_session_update_with_dialect(
        is_livetranslate,
        voice,
        instructions,
        audio_mode,
        target_language,
    ))
}

pub(crate) fn build_dashscope_audio_append(audio: &str) -> Value {
    json!({ "type": "input_audio_buffer.append", "audio": audio })
}

pub(crate) fn build_dashscope_input_audio_commit() -> Value {
    json!({ "type": "input_audio_buffer.commit" })
}

pub(crate) fn build_dashscope_response_create() -> Value {
    json!({ "type": "response.create" })
}

pub(crate) fn build_dashscope_text_item(text: &str) -> Value {
    json!({
      "type": "conversation.item.create",
      "item": {
        "type": "message",
        "role": "user",
        "content": [{ "type": "input_text", "text": text }]
      }
    })
}

pub(crate) fn build_omni_session_update_for_provider(
    provider: &ProviderDraftInput,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Value {
    let protocol = crate::audio::events::resolve_realtime_profile(provider, &provider.model)
        .protocol_dialect
        .expect("Omni session builder requires an explicit or compatibility-resolved protocol");
    build_dashscope_session_update(
        protocol,
        voice,
        instructions,
        audio_mode,
        target_language,
    )
    .expect("Omni session builder requires a DashScope Omni/LiveTranslate protocol")
}

#[cfg(test)]
pub(super) fn build_omni_session_update(
    model: &str,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Value {
    build_omni_session_update_with_dialect(
        is_livetranslate_model(model),
        voice,
        instructions,
        audio_mode,
        target_language,
    )
}

pub(super) enum OmniPlaybackCommand {
    Play {
        samples: Vec<i16>,
        cue_id: String,
        sample_rate_hz: u32,
        queued_at: Instant,
    },
    Stop,
}

fn render_omni_output_samples(
    samples: &[i16],
    sample_rate_hz: u32,
    output_level: u64,
    translated_audio_gain_db: f32,
    translated_audio_auto_gain_enabled: bool,
) -> (Vec<i16>, omni_audio_dsp::SpeechEnhancementMetrics) {
    let (enhanced, metrics) = omni_audio_dsp::enhance_speech_i16(
        samples,
        sample_rate_hz,
        1,
        translated_audio_gain_db,
        translated_audio_auto_gain_enabled,
    );
    (
        crate::audio::speech::scale_i16_by_output_level(&enhanced, output_level),
        metrics,
    )
}

fn omni_playback_queue_age_expired(age: Duration) -> bool {
    age > OMNI_PLAYBACK_MAX_QUEUE_AGE
}

pub(super) fn request_omni_playback_stop(
    stop_requested: &AtomicBool,
    playback_tx: &mpsc::SyncSender<OmniPlaybackCommand>,
) {
    stop_requested.store(true, Ordering::Release);
    let _ = playback_tx.try_send(OmniPlaybackCommand::Stop);
}

#[derive(Debug, Clone)]
pub(crate) struct OmniSpeechConfig {
    pub(super) enabled: bool,
    pub(super) local_playback_enabled: bool,
    pub(super) virtual_mic_output_enabled: bool,
    speaker_device_id: Option<String>,
    speaker_output_level: u64,
    translated_audio_gain_db: f32,
    translated_audio_auto_gain_enabled: bool,
    echo_guard_enabled: bool,
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
            crate::audio::speech::resolve_translation_audio_source(config_value, true)
                == crate::audio::speech::TranslationAudioSource::OmniNative;
        let local_playback_enabled =
            crate::audio::speech::desktop_direct_playback_enabled_for_config(config_value);
        // Text-level self-output detection protects every physical playback
        // route, including sessions that have not explicitly enabled AEC.
        let echo_guard_enabled =
            local_playback_enabled && (speech_enabled || device_output_enabled);
        Self {
            enabled: native_audio_enabled && (speech_enabled || device_output_enabled),
            local_playback_enabled,
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
            translated_audio_gain_db: config_value
                .pointer("/devices/inboundRoute/mixControl/translatedAudioGainDb")
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as f32,
            translated_audio_auto_gain_enabled: config_value
                .pointer("/devices/inboundRoute/mixControl/translatedAudioAutoGainEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            echo_guard_enabled,
        }
    }

    pub(super) fn any_output(&self) -> bool {
        self.enabled && (self.local_playback_enabled || self.virtual_mic_output_enabled)
    }

    pub(super) fn echo_guard_enabled(&self) -> bool {
        self.echo_guard_enabled
    }

}

pub(super) fn start_omni_playback<R: tauri::Runtime>(
    app: AppHandle<R>,
    speech_config: Arc<std::sync::RwLock<OmniSpeechConfig>>,
) -> (
    mpsc::SyncSender<OmniPlaybackCommand>,
    Arc<AtomicBool>,
    JoinHandle<()>,
) {
    let (tx, rx) = mpsc::sync_channel::<OmniPlaybackCommand>(OMNI_PLAYBACK_QUEUE_CAPACITY);
    let stop_requested = Arc::new(AtomicBool::new(false));
    let playback_stop_requested = stop_requested.clone();
    let join = thread::Builder::new()
        .name("omni-playback".to_string())
        .spawn(move || {
            let audio_state = app.state::<AudioStateStore>();
            loop {
                if playback_stop_requested.load(Ordering::Acquire) {
                    break;
                }
                let cmd = match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(cmd) => cmd,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                match cmd {
                    OmniPlaybackCommand::Stop => break,
                    OmniPlaybackCommand::Play {
                        samples,
                        cue_id,
                        sample_rate_hz,
                        queued_at,
                    } => {
                        if playback_stop_requested.load(Ordering::Acquire) {
                            break;
                        }
                        let queued_for = queued_at.elapsed();
                        if omni_playback_queue_age_expired(queued_for) {
                            let _ = diag_log(
                                &app,
                                "omni",
                                "warning",
                                format!(
                                    "[AUDIO] stale native playback dropped: cue_id={cue_id} queued_ms={}",
                                    queued_for.as_millis()
                                ),
                            );
                            continue;
                        }
                        // Re-read the shared config for every Play command:
                        // config saves during the session (output device,
                        // playback toggles, gain) must apply to the next cue,
                        // not only after a route restart.
                        let current_config = match speech_config.read() {
                            Ok(config) => config.clone(),
                            Err(poisoned) => poisoned.into_inner().clone(),
                        };
                        let cfg = &current_config;
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

                        let output_route = crate::audio::speech::SpeechOutputRoutePlan::new(
                            cfg.local_playback_enabled,
                            cfg.virtual_mic_output_enabled,
                        );
                        let (output_samples, enhancement) = render_omni_output_samples(
                            &samples,
                            sample_rate_hz,
                            cfg.speaker_output_level,
                            cfg.translated_audio_gain_db,
                            cfg.translated_audio_auto_gain_enabled,
                        );
                        let _ = diag_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[AUDIO] native translation gain applied: cue_id={cue_id} active_rms_dbfs={:?} input_peak_dbfs={:?} auto_gain_db={:.3} requested_gain_db={:.3} applied_gain_db={:.3} peak_limited={} muted={}",
                                enhancement.active_rms_dbfs,
                                enhancement.input_peak_dbfs,
                                enhancement.auto_gain_db,
                                enhancement.requested_gain_db,
                                enhancement.applied_gain_db,
                                enhancement.peak_limited,
                                enhancement.muted,
                            ),
                        );
                        let speaker_frames = if output_route.play_to_speaker {
                            // The AEC reference must be the exact PCM submitted to the
                            // speaker. Output level and translated-audio gain are already
                            // baked in, so speaker playback stays at unity volume.
                            let echo_reference = crate::audio::speech::i16_to_f32(&output_samples);
                            audio_state.push_echo_reference(&echo_reference, sample_rate_hz, 1);
                            let result = crate::audio::speech::play_to_speaker(
                                &output_samples,
                                sample_rate_hz,
                                1,
                                cfg.speaker_device_id.as_deref(),
                                100,
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
                            match BridgeAudioWriter::new(&app).write_translation_frame(
                                &cue_id,
                                &req_id,
                                &output_samples,
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
            audio_state.update_speech(|s| {
                s.dispatch_state = "idle".to_string();
                s.current_cue_id = None;
            });
            let _ = emit_audio_snapshot(&app, &audio_state);
        })
        .expect("failed to spawn omni-playback thread");
    (tx, stop_requested, join)
}

#[cfg(test)]
mod omni_playback_tests {
    use super::*;

    fn queued_play(cue_id: &str) -> OmniPlaybackCommand {
        OmniPlaybackCommand::Play {
            samples: vec![1, -1],
            cue_id: cue_id.to_string(),
            sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
            queued_at: Instant::now(),
        }
    }

    #[test]
    fn native_playback_config_enables_echo_guard_and_reads_translated_gain() {
        let config = json!({
            "devices": {
                "outputLevel": 75,
                "inboundRoute": {
                    "mixControl": {
                        "translatedAudioGainDb": -6.0206,
                        "translatedAudioAutoGainEnabled": false
                    }
                }
            },
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": true
            }
        });

        let speech = OmniSpeechConfig::from_config(&config);
        assert_eq!(speech.speaker_output_level, 75);
        assert!((speech.translated_audio_gain_db + 6.0206).abs() < f32::EPSILON);
        assert!(!speech.translated_audio_auto_gain_enabled);
        assert!(speech.echo_guard_enabled());
    }

    #[test]
    fn native_output_gain_is_applied_to_the_pcm_used_for_playback() {
        let samples = [20_000, -20_000, i16::MAX, i16::MIN];
        let (half_from_route_gain, _) =
            render_omni_output_samples(&samples, 24_000, 100, -6.0206, false);
        let (half_from_output_level, _) =
            render_omni_output_samples(&samples, 24_000, 50, 0.0, false);

        for (route_sample, level_sample) in
            half_from_route_gain.iter().zip(&half_from_output_level)
        {
            assert!((*route_sample as i32 - *level_sample as i32).abs() <= 1);
        }
        assert_eq!(half_from_output_level, vec![10_000, -10_000, 16_383, -16_384]);

        let (protected, metrics) =
            render_omni_output_samples(&samples, 24_000, 100, 6.0206, false);
        let ceiling = 10.0_f32.powf(-1.0 / 20.0) * i16::MAX as f32;
        assert!(protected.iter().all(|sample| (*sample as f32).abs() <= ceiling + 1.0));
        assert!(metrics.peak_limited);
    }

    #[test]
    fn echo_reference_conversion_uses_the_gain_adjusted_samples() {
        let (rendered, _) =
            render_omni_output_samples(&[12_000, -8_000], 24_000, 50, 0.0, false);
        let echo_reference = crate::audio::speech::i16_to_f32(&rendered);

        assert_eq!(rendered, vec![6_000, -4_000]);
        assert_eq!(echo_reference[0], 6_000_f32 / i16::MAX as f32);
        assert_eq!(echo_reference[1], -4_000_f32 / i16::MAX as f32);
    }

    /// Field bug: the playback thread cloned `OmniSpeechConfig` at session
    /// start, so switching the output device or playback toggles mid-session
    /// had no effect until the route was restarted. Queue one cue under the
    /// speaker config, swap the shared config (as a config save does), and
    /// assert the next cue is dispatched with the new routing.
    #[test]
    fn playback_thread_reads_the_shared_config_for_every_play_command() {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        app.manage(crate::bridge::state::BridgeStateStore::new());
        let handle = app.handle().clone();
        let audio_state = handle.state::<AudioStateStore>();

        let speaker_config = json!({
            "devices": { "outputSpeechEnabled": true, "outputLevel": 100 },
            "speech": { "enabled": true, "localPlaybackEnabled": true }
        });
        let shared = audio_state
            .register_omni_speech_config(OmniSpeechConfig::from_config(&speaker_config));
        assert!(shared.read().expect("shared config readable").any_output());
        let (tx, stop_requested, join) = start_omni_playback(handle.clone(), shared);

        let wait_for = |description: &str,
                        predicate: &dyn Fn(&crate::audio::contracts::SpeechRuntimeSnapshot) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let speech = audio_state.snapshot().speech;
                if predicate(&speech) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {description}; dispatchState={} outputTarget={}",
                    speech.dispatch_state,
                    speech.output_target,
                );
                thread::sleep(Duration::from_millis(10));
            }
        };

        tx.send(queued_play("cue-live-config-1")).expect("queue first cue");
        wait_for("first cue processed under the speaker config", &|speech| {
            speech.dispatch_state == "waiting-subtitle" && speech.output_target == "speaker"
        });

        // Mid-session config save: route output to the virtual mic instead.
        audio_state.refresh_omni_speech_config(&json!({
            "devices": { "outputSpeechEnabled": true, "outputLevel": 100 },
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": false,
                "virtualMicOutputEnabled": true
            }
        }));
        tx.send(queued_play("cue-live-config-2")).expect("queue second cue");
        wait_for("second cue dispatched with the new config", &|speech| {
            speech.output_target == "virtual-mic"
        });

        request_omni_playback_stop(&stop_requested, &tx);
        let _ = join.join();
    }

    #[test]
    fn bounded_queue_and_out_of_band_stop_prevent_post_stop_backlog_growth() {
        let (tx, rx) = mpsc::sync_channel(OMNI_PLAYBACK_QUEUE_CAPACITY);
        assert!(tx.try_send(queued_play("first")).is_ok());
        assert!(tx.try_send(queued_play("second")).is_ok());
        assert!(tx.try_send(queued_play("third")).is_ok());
        assert!(matches!(
            tx.try_send(queued_play("fourth")),
            Err(mpsc::TrySendError::Full(_))
        ));

        let stop_requested = AtomicBool::new(false);
        request_omni_playback_stop(&stop_requested, &tx);
        assert!(stop_requested.load(Ordering::Acquire));
        assert!(matches!(rx.try_recv(), Ok(OmniPlaybackCommand::Play { .. })));
        assert!(matches!(rx.try_recv(), Ok(OmniPlaybackCommand::Play { .. })));
        assert!(matches!(rx.try_recv(), Ok(OmniPlaybackCommand::Play { .. })));
        assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(!omni_playback_queue_age_expired(
            OMNI_PLAYBACK_MAX_QUEUE_AGE
        ));
        assert!(omni_playback_queue_age_expired(
            OMNI_PLAYBACK_MAX_QUEUE_AGE + Duration::from_millis(1)
        ));
    }
}
