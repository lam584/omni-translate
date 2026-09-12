fn drain_available(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    r: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
    model_protocol_authority: Option<
        &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    >,
) -> Result<(), String> {
    drain_text_events(
        handle_realtime_event,
        "read error",
        socket,
        audio_start,
        r,
        last_event,
        progress,
        model_protocol_authority,
    )
}

fn admit_benchmark_server_event(
    authority: &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    event: &Value,
) -> Result<(), String> {
    if authority.adapter_id == crate::audio::bailian_protocol::LIVETRANSLATE_ADAPTER_ID {
        return Err(
            "model_protocol.event_order_invalid: LiveTranslate benchmark events require the stateful typed reducer"
                .to_string(),
        );
    }
    let event_type = crate::audio::realtime_ws::server_event_type(event, "");
    let frame_kind = if authority
        .server_json_base64_event_types
        .iter()
        .any(|candidate| candidate == event_type)
    {
        crate::provider::model_protocol_profile::ModelProtocolFrameKind::JsonBase64
    } else {
        crate::provider::model_protocol_profile::ModelProtocolFrameKind::Json
    };
    crate::provider::model_protocol_profile::admit_model_protocol_event(
        authority,
        crate::provider::model_protocol_profile::ModelProtocolEventAdmissionRequest {
            direction: crate::provider::model_protocol_profile::ModelProtocolEventDirection::Server,
            event_type,
            frame_kind,
        },
    )
    .map(|_| ())
    .map_err(|error| {
        format!(
            "unexpected_event: {} benchmark profileId={} profileVersion={} eventType={event_type}",
            error.code(), authority.profile_id, authority.profile_version
        )
    })
}

fn drain_text_events(
    handle: fn(&mut RawResult, &mut BenchmarkProgressState, f64, &Value) -> Result<(), String>,
    read_error_prefix: &str,
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    r: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
    model_protocol_authority: Option<
        &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    >,
) -> Result<(), String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                *last_event = Instant::now();
                let event: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(error) if r.live_translate_plan.is_some() => {
                        return Err(format!(
                            "model_protocol.payload_invalid: LiveTranslate server JSON: {error}"
                        ));
                    }
                    Err(_) => continue,
                };
                if r.live_translate_plan.is_some() {
                    handle_livetranslate_event(
                        r,
                        progress,
                        elapsed_ms(audio_start),
                        &event,
                    )?;
                } else {
                    if let Some(authority) = model_protocol_authority {
                        admit_benchmark_server_event(authority, &event)?;
                    }
                    handle(r, progress, elapsed_ms(audio_start), &event)?;
                }
            }
            Ok(Message::Binary(_)) if model_protocol_authority.is_some() => {
                return Err(
                    "unexpected_event: model_protocol.frame_kind_mismatch benchmark received an unauthorized binary frame"
                        .to_string(),
                );
            }
            Ok(Message::Close(_)) => return Ok(()),
            Err(e) if is_timeout(&e.to_string()) => return Ok(()), // No more events right now
            Err(e) => return Err(format!("{read_error_prefix}: {e}")),
            _ => continue,
        }
    }
}

fn handle_livetranslate_event(
    r: &mut RawResult,
    progress: &mut BenchmarkProgressState,
    ms: f64,
    event: &Value,
) -> Result<(), String> {
    apply_livetranslate_event_to_raw(r, ms, progress.run.audio_chunks_sent, event)?;
    progress.run.speech_started_ms = r.speech_started_ms;
    progress.run.speech_stopped_ms = r.speech_stopped_ms;
    progress.run.first_asr_ms = r.first_asr_ms;
    progress.run.asr_deltas = r.asr_deltas.clone();
    progress.run.asr_final = r.asr_final.clone();
    progress.run.response_created_ms = r.response_created_ms;
    sync_response_done_progress(progress, r);
    let event_type = crate::audio::realtime_ws::server_event_type(event, "?");
    let (phase, message) = match event_type {
        "session.finished" => ("session-finished", "LiveTranslate 服务端会话已完成"),
        "response.done" => ("response-done", "LiveTranslate 模型响应完成"),
        "response.text.text" | "response.audio_transcript.text" => {
            ("output-text", "收到 LiveTranslate 权威文本快照")
        }
        "conversation.item.input_audio_transcription.text" => {
            ("asr", "收到 LiveTranslate 权威输入转写")
        }
        "input_audio_buffer.speech_started" => ("vad", "检测到语音开始"),
        "input_audio_buffer.speech_stopped" => ("vad", "检测到语音结束"),
        _ => ("provider-event", "收到 LiveTranslate 已验证事件"),
    };
    progress.emit("running", phase, message, None);
    Ok(())
}

fn apply_livetranslate_event_to_raw(
    r: &mut RawResult,
    ms: f64,
    audio_chunks_sent: usize,
    event: &Value,
) -> Result<(), String> {
    let mutation = r
        .live_translate_plan
        .as_mut()
        .ok_or_else(|| {
            "model_protocol.adapter_unavailable: LiveTranslate event has no typed benchmark plan"
                .to_string()
        })?
        .admit_server_event(event)?;
    let event_type = crate::audio::realtime_ws::server_event_type(event, "?");
    if let Some(status) = mutation.response_terminal_status.as_deref() {
        if status != "completed" {
            return Err(format!(
                "provider-response-terminal-{status}: LiveTranslate response.done was not completed"
            ));
        }
    }

    match event_type {
        "error" => {
            return Err(format!(
                "provider-error: LiveTranslate server error: {}",
                event.get("error").unwrap_or(&Value::Null)
            ));
        }
        "input_audio_buffer.speech_started" => r.speech_started_ms = Some(ms),
        "input_audio_buffer.speech_stopped" => r.speech_stopped_ms = Some(ms),
        "conversation.item.input_audio_transcription.text" => {
            let text = mutation.normalized_text.ok_or_else(|| {
                "model_protocol.payload_invalid: admitted input transcription has no normalized snapshot"
                    .to_string()
            })?;
            if r.first_asr_ms.is_none() {
                r.first_asr_ms = Some(ms);
            }
            r.asr_final = text.clone();
            r.asr_deltas.push(AsrDelta {
                elapsed_ms: ms,
                stash: text,
                text: event
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        "conversation.item.input_audio_transcription.completed" => {
            if let Some(transcript) = event
                .get("transcript")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                r.asr_final = transcript.to_string();
            }
        }
        "response.created" => {
            if r.response_created_ms.is_none() {
                r.response_created_ms = Some(ms);
            }
        }
        "response.text.text" | "response.audio_transcript.text" => {
            let text = mutation.normalized_text.ok_or_else(|| {
                "model_protocol.payload_invalid: admitted LiveTranslate text event has no normalized snapshot"
                    .to_string()
            })?;
            record_authorized_output(r, ms, event_type, text, false);
        }
        "response.text.done" | "response.audio_transcript.done" => {
            let text = mutation.normalized_text.ok_or_else(|| {
                "model_protocol.payload_invalid: admitted LiveTranslate text terminal has no normalized text"
                    .to_string()
            })?;
            record_authorized_output(r, ms, event_type, text, true);
        }
        "response.done" => {
            if !mutation.response_completed {
                return Err(
                    "model_protocol.event_order_invalid: response.done did not authorize a completed response"
                        .to_string(),
                );
            }
            let text = mutation
                .completed_response_text
                .filter(|text| !text.is_empty())
                .ok_or_else(|| {
                    "model_protocol.identity_mismatch: completed response.done has no text bound to its response ledger"
                        .to_string()
                })?;
            record_authorized_output(r, ms, event_type, text, true);
            record_authorized_response_done(r, ms, audio_chunks_sent);
        }
        "session.finished" => {
            if !mutation.session_finished {
                return Err(
                    "model_protocol.event_order_invalid: session.finished lacked reducer terminal authority"
                        .to_string(),
                );
            }
            if r.response_count == 0 || r.translation_final.trim().is_empty() {
                return Err(
                    "provider-output-missing: non-empty LiveTranslate benchmark input reached session.finished without one completed translated response"
                        .to_string(),
                );
            }
            r.session_finished = true;
        }
        _ => {}
    }
    Ok(())
}

fn record_authorized_output(
    r: &mut RawResult,
    ms: f64,
    event_type: &str,
    text: String,
    committed: bool,
) {
    if r.first_output_ms.is_none() {
        r.first_output_ms = Some(ms);
    }
    if committed && r.first_committed_ms.is_none() {
        r.first_committed_ms = Some(ms);
    }
    r.translation_final = text.clone();
    r.output_deltas.push(OutputDelta {
        elapsed_ms: ms,
        event_type: event_type.to_string(),
        stash: (!committed).then_some(text.clone()).unwrap_or_default(),
        committed_text: committed.then_some(text.clone()).unwrap_or_default(),
        raw_text: text,
    });
}

fn handle_realtime_event(
    r: &mut RawResult,
    progress: &mut BenchmarkProgressState,
    ms: f64,
    event: &Value,
) -> Result<(), String> {
    let etype = crate::audio::realtime_ws::server_event_type(event, "?");

    match etype {
        "input_audio_buffer.speech_started" => {
            r.speech_started_ms = Some(ms);
            progress.run.speech_started_ms = Some(ms);
            progress.emit("running", "vad", "检测到语音开始", None);
        }
        "input_audio_buffer.speech_stopped" => {
            r.speech_stopped_ms = Some(ms);
            progress.run.speech_stopped_ms = Some(ms);
            progress.emit("running", "vad", "检测到语音结束", None);
        }
        "conversation.item.input_audio_transcription.text" => {
            let stash = event["stash"].as_str().unwrap_or("").to_string();
            let text_val = event["text"].as_str().unwrap_or("").to_string();
            if r.first_asr_ms.is_none() {
                r.first_asr_ms = Some(ms);
            }
            r.asr_deltas.push(AsrDelta {
                elapsed_ms: ms,
                stash: stash.clone(),
                text: text_val.clone(),
            });
            if !stash.is_empty() {
                r.asr_final = stash;
            }
            progress.run.first_asr_ms = r.first_asr_ms;
            progress.run.asr_deltas = r.asr_deltas.clone();
            progress.run.asr_final = r.asr_final.clone();
            progress.emit("running", "asr", "收到 ASR 流式文本", None);
        }
        "conversation.item.input_audio_transcription.completed" => {
            let transcript = event["transcript"].as_str().unwrap_or("").to_string();
            if !transcript.is_empty() {
                r.asr_final = transcript;
            }
            progress.run.asr_final = r.asr_final.clone();
            progress.emit("running", "asr-completed", "ASR 识别完成", None);
        }
        "response.created" => {
            if r.response_created_ms.is_none() {
                r.response_created_ms = Some(ms);
            }
            progress.run.response_created_ms = r.response_created_ms;
            progress.emit("running", "response-created", "模型开始响应", None);
        }
        "response.done" => {
            record_response_done(r, progress, ms);
            if r.translation_final.is_empty() && r.output_deltas.is_empty() {
                if let Some(text) = extract_response_text(event) {
                    r.translation_final = text.clone();
                    if r.first_committed_ms.is_none() {
                        r.first_committed_ms = Some(ms);
                    }
                    if r.first_output_ms.is_none() {
                        r.first_output_ms = Some(ms);
                    }
                    r.output_deltas.push(OutputDelta {
                        elapsed_ms: ms,
                        event_type: etype.to_string(),
                        stash: String::new(),
                        committed_text: text.clone(),
                        raw_text: text,
                    });
                }
            }
            sync_response_done_progress(progress, r);
            progress.emit("running", "response-done", "模型响应完成", None);
        }
        "session.finished" => {
            r.session_finished = true;
            progress.emit(
                "running",
                "session-finished",
                "LiveTranslate 服务端会话已完成",
                None,
            );
        }
        "response.audio_transcript.delta" => {
            record_output_delta(r, progress, ms, etype, event, "asr", "收到音频转写 delta");
        }
        "response.text.delta" | "response.output_text.delta" | "response.transcript.delta" => {
            record_output_delta(
                r,
                progress,
                ms,
                etype,
                event,
                "output-delta",
                "收到模型输出 delta",
            );
        }
        "response.audio_transcript.done" => {
            record_committed_output(
                r,
                progress,
                ms,
                etype,
                extract_audio_transcript_text(event).unwrap_or_default(),
                "模型音频转写完成",
            );
        }
        "response.text.done" | "response.output_text.done" | "response.transcript.done" => {
            record_committed_output(
                r,
                progress,
                ms,
                etype,
                extract_response_text(event).unwrap_or_default(),
                "模型输出已提交",
            );
        }
        "response.audio_transcript.text" => {
            let stash = event["stash"].as_str().unwrap_or("").to_string();
            let text_val = event["text"].as_str().unwrap_or("").to_string();
            let current_text = if !stash.is_empty() {
                stash.clone()
            } else {
                text_val.clone()
            };
            if r.first_output_ms.is_none() && (!stash.is_empty() || !text_val.is_empty()) {
                r.first_output_ms = Some(ms);
            }
            if !current_text.is_empty() {
                r.translation_final = current_text.clone();
                if r.first_committed_ms.is_none() {
                    r.first_committed_ms = Some(ms);
                }
            }
            r.output_deltas.push(OutputDelta {
                elapsed_ms: ms,
                event_type: etype.to_string(),
                stash,
                committed_text: text_val.clone(),
                raw_text: current_text,
            });
            sync_output_progress(progress, r);
            progress.emit("running", "output-text", "收到模型输出文本", None);
        }
        "error" => {
            return Err(format!("server error: {}", event["error"]));
        }
        _ => {
            if is_model_text_output_event(etype) {
                if let Some(text) = extract_response_text(event) {
                    if r.first_output_ms.is_none() {
                        r.first_output_ms = Some(ms);
                    }
                    if etype.ends_with(".done") || etype.ends_with(".completed") {
                        if r.first_committed_ms.is_none() {
                            r.first_committed_ms = Some(ms);
                        }
                        r.translation_final = text.clone();
                    }
                    r.output_deltas.push(OutputDelta {
                        elapsed_ms: ms,
                        event_type: etype.to_string(),
                        stash: if etype.ends_with(".delta") {
                            text.clone()
                        } else {
                            String::new()
                        },
                        committed_text: if etype.ends_with(".delta") {
                            String::new()
                        } else {
                            text.clone()
                        },
                        raw_text: text,
                    });
                    sync_output_progress(progress, r);
                    progress.emit("running", "output-event", "收到模型输出事件", None);
                }
            }
        }
    }

    Ok(())
}

fn record_output_delta(
    r: &mut RawResult,
    progress: &mut BenchmarkProgressState,
    ms: f64,
    etype: &str,
    event: &Value,
    phase: &str,
    message: &str,
) {
    let delta = extract_direct_text(event).unwrap_or_default();
    if r.first_output_ms.is_none() && !delta.is_empty() {
        r.first_output_ms = Some(ms);
    }
    r.output_deltas.push(OutputDelta {
        elapsed_ms: ms,
        event_type: etype.to_string(),
        stash: delta.clone(),
        committed_text: String::new(),
        raw_text: delta,
    });
    sync_output_progress(progress, r);
    progress.emit("running", phase, message, None);
}

fn record_committed_output(
    r: &mut RawResult,
    progress: &mut BenchmarkProgressState,
    ms: f64,
    etype: &str,
    text: String,
    message: &str,
) {
    if !text.is_empty() {
        if should_replace_final_text(&r.translation_final, &text) {
            r.translation_final = text.clone();
        }
        if r.first_output_ms.is_none() {
            r.first_output_ms = Some(ms);
        }
        if r.first_committed_ms.is_none() {
            r.first_committed_ms = Some(ms);
        }
    }
    r.output_deltas.push(OutputDelta {
        elapsed_ms: ms,
        event_type: etype.to_string(),
        stash: String::new(),
        committed_text: text.clone(),
        raw_text: text,
    });
    sync_output_progress(progress, r);
    progress.emit("running", "output-committed", message, None);
}

fn record_response_done(r: &mut RawResult, progress: &BenchmarkProgressState, ms: f64) {
    record_authorized_response_done(r, ms, progress.run.audio_chunks_sent);
}

fn record_authorized_response_done(r: &mut RawResult, ms: f64, audio_chunks_sent: usize) {
    r.response_done_ms = Some(ms);
    r.response_count += 1;
    if r.response_done_audio_chunks_sent.is_none() {
        r.response_done_audio_chunks_sent = Some(audio_chunks_sent);
        r.response_done_audio_sent_secs =
            Some(audio_chunks_sent as f64 * CHUNK_SAMPLES as f64 / 16_000.0);
    }
}

fn sync_response_done_progress(progress: &mut BenchmarkProgressState, r: &RawResult) {
    progress.run.response_done_ms = r.response_done_ms;
    progress.run.response_done_audio_chunks_sent = r.response_done_audio_chunks_sent;
    progress.run.response_done_audio_sent_secs = r.response_done_audio_sent_secs;
    progress.run.response_count = r.response_count;
    sync_output_progress(progress, r);
}

fn reject_non_turn_based_benchmark(config: &BenchmarkConfig) -> Result<(), String> {
    let provider_kind = config.provider_kind.to_ascii_lowercase();
    if matches!(
        provider_kind.as_str(),
        "openrouter" | "ollama" | "lmstudio" | "nvidia"
    ) {
        return Err(format!(
            "provider kind '{}' is not a turn-based realtime voice session backend for this benchmark",
            config.provider_kind
        ));
    }

    let capabilities: Vec<String> = config
        .interaction_capabilities
        .iter()
        .map(|item| item.to_ascii_lowercase())
        .collect();
    let has = |capability: &str| capabilities.iter().any(|item| item == capability);
    let has_turn_session = has("auto_vad") || has("manual_commit") || has("client_activity");

    if has("text_only_backend") {
        return Err("text_only_backend models require an external ASR/TTS chain; realtime voice benchmark is unsupported".to_string());
    }
    if has("pipeline_asr_mt_tts") {
        return Err("pipeline_asr_mt_tts backends should be benchmarked as ASR -> MT -> TTS pipelines, not turn-based realtime sessions".to_string());
    }
    if has("chunked_http_audio") && !has_turn_session {
        return Err("chunked_http_audio models expose request/stream audio endpoints, not turn-level realtime VAD/manual sessions".to_string());
    }
    if (has("server_commit_tts") || has("commit_tts")) && !has_turn_session {
        return Err("TTS commit modes synthesize text buffers and do not accept microphone audio benchmark input".to_string());
    }

    Ok(())
}

// ──────────────────────────────── Event Receiver ────────────────────────────

fn drain_gemini_available(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    r: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
    model_protocol_authority: Option<
        &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    >,
) -> Result<(), String> {
    drain_text_events(
        handle_gemini_event,
        "Gemini read error",
        socket,
        audio_start,
        r,
        last_event,
        progress,
        model_protocol_authority,
    )
}

fn handle_gemini_event(
    r: &mut RawResult,
    progress: &mut BenchmarkProgressState,
    ms: f64,
    event: &Value,
) -> Result<(), String> {
    if event.get("setupComplete").is_some() {
        return Ok(());
    }
    if event.get("error").is_some() {
        return Err(format!("Gemini server error: {}", event["error"]));
    }

    if let Some(input_text) = event
        .pointer("/serverContent/inputTranscription/text")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        if r.first_asr_ms.is_none() {
            r.first_asr_ms = Some(ms);
        }
        r.asr_final.push_str(input_text);
        r.asr_deltas.push(AsrDelta {
            elapsed_ms: ms,
            stash: r.asr_final.clone(),
            text: input_text.to_string(),
        });
        progress.run.first_asr_ms = r.first_asr_ms;
        progress.run.asr_deltas = r.asr_deltas.clone();
        progress.run.asr_final = r.asr_final.clone();
        progress.emit("running", "asr", "收到 Gemini 输入转写文本", None);
    }

    if let Some(output_text) = event
        .pointer("/serverContent/outputTranscription/text")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        push_gemini_output_delta(
            r,
            progress,
            ms,
            "serverContent.outputTranscription",
            output_text,
        );
    }

    let model_text = collect_gemini_model_text(
        event
            .pointer("/serverContent/modelTurn")
            .unwrap_or(&Value::Null),
    );
    if !model_text.is_empty() {
        push_gemini_output_delta(
            r,
            progress,
            ms,
            "serverContent.modelTurn",
            &model_text,
        );
    }

    let turn_complete = event
        .pointer("/serverContent/turnComplete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if turn_complete {
        record_response_done(r, progress, ms);
        if r.first_committed_ms.is_none() && !r.translation_final.is_empty() {
            r.first_committed_ms = Some(ms);
        }
        sync_response_done_progress(progress, r);
        progress.emit("running", "response-done", "Gemini Live 响应完成", None);
    }

    Ok(())
}

fn push_gemini_output_delta(
    r: &mut RawResult,
    progress: &mut BenchmarkProgressState,
    ms: f64,
    event_type: &str,
    text: &str,
) {
    if r.first_output_ms.is_none() {
        r.first_output_ms = Some(ms);
    }
    r.translation_final.push_str(text);
    r.output_deltas.push(OutputDelta {
        elapsed_ms: ms,
        event_type: event_type.to_string(),
        stash: text.to_string(),
        committed_text: String::new(),
        raw_text: text.to_string(),
    });
    sync_output_progress(progress, r);
    progress.emit("running", "output-delta", "收到 Gemini Live 输出文本", None);
}

#[cfg(test)]
mod protocol_regression_tests {
    use super::*;

    fn config() -> BenchmarkConfig {
        BenchmarkConfig {
            api_key: "unused-test-key".to_string(),
            mp3_path: PathBuf::from("unused-test-audio.pcm"),
            model: "qwen3.5-livetranslate-flash-realtime".to_string(),
            audio_mode: RealtimeAudioMode::ServerVad,
            interaction_capabilities: vec!["auto_vad".to_string()],
            provider_kind: "dashscope".to_string(),
            base_url: DEFAULT_WS_BASE_URL.to_string(),
            auth_header_name: "Authorization".to_string(),
            auth_scheme: "bearer".to_string(),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            protocol_dialect: Some(
                crate::audio::events::RealtimeProtocol::DashscopeLivetranslate,
            ),
            model_protocol_authority: Some(
                crate::audio::bailian_protocol::livetranslate_test_authority(),
            ),
        }
    }

    fn event(event_id: &str, mut value: Value) -> Value {
        value["event_id"] = json!(event_id);
        value
    }

    fn raw_plan() -> RawResult {
        RawResult {
            live_translate_plan: Some(
                livetranslate_plan::prepare_livetranslate_benchmark_plan(
                    &config(),
                    &[1_i16; CHUNK_SAMPLES],
                )
                    .expect("test plan should be admitted"),
            ),
            ..Default::default()
        }
    }

    fn activate(raw: &mut RawResult, session_id: &str) {
        let session_update = raw
            .live_translate_plan
            .as_ref()
            .expect("test plan")
            .session_update()
            .get("session")
            .cloned()
            .expect("session config");
        apply_livetranslate_event_to_raw(
            raw,
            1.0,
            0,
            &event(
                "event-session-created",
                json!({
                    "type":"session.created",
                    "session":{
                        "id":session_id,
                        "object":"realtime.session",
                        "model":"qwen3.5-livetranslate-flash-realtime"
                    }
                }),
            ),
        )
        .expect("session.created should be admitted");
        apply_livetranslate_event_to_raw(
            raw,
            2.0,
            0,
            &event(
                "event-session-updated",
                json!({
                    "type":"session.updated",
                    "session":{
                        "id":session_id,
                        "object":"realtime.session",
                        "model":"qwen3.5-livetranslate-flash-realtime"
                    }
                }),
            )
            .as_object()
            .map(|object| {
                let mut updated = Value::Object(object.clone());
                updated["session"]
                    .as_object_mut()
                    .expect("session object")
                    .extend(
                        session_update
                            .as_object()
                            .expect("sent session object")
                            .clone(),
                    );
                updated
            })
            .expect("updated object"),
        )
        .expect("exact session.updated should be admitted");
    }

    fn response_created(status: &str) -> Value {
        event(
            "event-response-created",
            json!({
                "type":"response.created",
                "response":{
                    "id":"response-1", "conversation_id":"conversation-1",
                    "object":"realtime.response", "status":status,
                    "modalities":["text"], "output":[]
                }
            }),
        )
    }

    fn completed_response_sequence() -> Vec<Value> {
        vec![
            response_created("in_progress"),
            event("event-output-added", json!({
                "type":"response.output_item.added", "response_id":"response-1", "output_index":0,
                "item":{"id":"item-1","object":"realtime.item","type":"message","status":"in_progress","role":"assistant","content":[]}
            })),
            event("event-content-added", json!({
                "type":"response.content_part.added", "response_id":"response-1", "item_id":"item-1",
                "output_index":0, "content_index":0, "part":{"type":"text","text":""}
            })),
            event("event-text", json!({
                "type":"response.text.text", "response_id":"response-1", "item_id":"item-1",
                "output_index":0, "content_index":0, "text":"你", "stash":"好"
            })),
            event("event-text-done", json!({
                "type":"response.text.done", "response_id":"response-1", "item_id":"item-1",
                "output_index":0, "content_index":0, "text":"你好"
            })),
            event("event-content-done", json!({
                "type":"response.content_part.done", "response_id":"response-1", "item_id":"item-1",
                "output_index":0, "content_index":0, "part":{"type":"text","text":"你好"}
            })),
            event("event-output-done", json!({
                "type":"response.output_item.done", "response_id":"response-1", "output_index":0,
                "item":{"id":"item-1","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[]}
            })),
            event("event-response-done", json!({
                "type":"response.done",
                "response":{
                    "id":"response-1", "conversation_id":"conversation-1",
                    "object":"realtime.response", "status":"completed",
                    "modalities":["text"],
                    "output":[{"id":"item-1","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[]}]
                }
            })),
        ]
    }

    #[test]
    fn generic_event_name_admission_cannot_authorize_livetranslate_readiness() {
        let authority = crate::audio::bailian_protocol::livetranslate_test_authority();
        let bare_updated = json!({
            "event_id": "event-bare-updated",
            "type": "session.updated",
            "session": {
                "id": "session-1",
                "object": "realtime.session",
                "model": "qwen3.5-livetranslate-flash-realtime"
            }
        });

        let error = admit_benchmark_server_event(&authority, &bare_updated)
            .expect_err("LiveTranslate readiness requires the stateful typed reducer");
        assert!(error.contains("stateful typed reducer"), "{error}");
    }

    #[test]
    fn full_typed_sequence_is_the_only_source_of_translation_count_and_finish() {
        let mut raw = raw_plan();
        activate(&mut raw, "session-1");
        for (index, event) in completed_response_sequence().iter().enumerate() {
            apply_livetranslate_event_to_raw(&mut raw, 10.0 + index as f64, 1, event)
                .expect("complete documented response sequence should be admitted");
        }
        assert_eq!(raw.translation_final, "你好");
        assert_eq!(raw.response_count, 1);
        assert_eq!(raw.response_done_audio_chunks_sent, Some(1));
        assert!(!raw.session_finished);

        raw.live_translate_plan
            .as_mut()
            .expect("test plan")
            .take_session_finish()
            .expect("finish should transition exactly once after readiness");
        assert!(raw
            .live_translate_plan
            .as_mut()
            .expect("test plan")
            .take_session_finish()
            .is_err());
        apply_livetranslate_event_to_raw(
            &mut raw,
            20.0,
            1,
            &event("event-session-finished", json!({"type":"session.finished"})),
        )
        .expect("closed response ledger should authorize session.finished");
        assert!(raw.session_finished);
    }

    #[test]
    fn bare_updated_wrong_identity_and_premature_finish_fail_closed() {
        let mut bare = raw_plan();
        let error = apply_livetranslate_event_to_raw(
            &mut bare,
            1.0,
            0,
            &event("event-bare-updated", json!({
                "type":"session.updated",
                "session":{"id":"session-1","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}
            })),
        )
        .expect_err("session.updated cannot create readiness by itself");
        assert!(error.contains("must follow session.created"), "{error}");

        let mut wrong_identity = raw_plan();
        let session = wrong_identity
            .live_translate_plan
            .as_ref()
            .expect("test plan")
            .session_update()["session"]
            .clone();
        apply_livetranslate_event_to_raw(
            &mut wrong_identity,
            1.0,
            0,
            &event("event-created", json!({
                "type":"session.created",
                "session":{"id":"session-1","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}
            })),
        )
        .unwrap();
        let mut updated = event("event-updated", json!({
            "type":"session.updated",
            "session":{"id":"session-other","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}
        }));
        updated["session"]
            .as_object_mut()
            .unwrap()
            .extend(session.as_object().unwrap().clone());
        updated["session"]["id"] = json!("session-other");
        assert!(apply_livetranslate_event_to_raw(&mut wrong_identity, 2.0, 0, &updated)
            .expect_err("session identity switch must fail")
            .contains("changed session identity"));

        let mut premature = raw_plan();
        activate(&mut premature, "session-1");
        apply_livetranslate_event_to_raw(
            &mut premature,
            3.0,
            0,
            &response_created("in_progress"),
        )
        .unwrap();
        premature
            .live_translate_plan
            .as_mut()
            .unwrap()
            .take_session_finish()
            .unwrap();
        assert!(apply_livetranslate_event_to_raw(
            &mut premature,
            4.0,
            0,
            &event("event-finished", json!({"type":"session.finished"})),
        )
        .expect_err("active response ledger must block session.finished")
        .contains("before every active response"));
    }

    #[test]
    fn failed_incomplete_and_unbound_completed_responses_never_count() {
        for status in ["failed", "incomplete"] {
            let mut raw = raw_plan();
            activate(&mut raw, "session-1");
            apply_livetranslate_event_to_raw(
                &mut raw,
                3.0,
                0,
                &response_created("in_progress"),
            )
            .unwrap();
            let terminal = event("event-response-terminal", json!({
                "type":"response.done",
                "response":{
                    "id":"response-1","conversation_id":"conversation-1",
                    "object":"realtime.response","status":status,
                    "modalities":["text"],"output":[]
                }
            }));
            let error = apply_livetranslate_event_to_raw(&mut raw, 4.0, 0, &terminal)
                .expect_err("non-completed response must fail the benchmark");
            assert!(error.contains(&format!("provider-response-terminal-{status}")));
            assert_eq!(raw.response_count, 0);
            assert!(raw.translation_final.is_empty());
        }

        let mut unbound = raw_plan();
        activate(&mut unbound, "session-1");
        apply_livetranslate_event_to_raw(
            &mut unbound,
            3.0,
            0,
            &response_created("in_progress"),
        )
        .unwrap();
        let error = apply_livetranslate_event_to_raw(
            &mut unbound,
            4.0,
            0,
            &event("event-response-done", json!({
                "type":"response.done",
                "response":{
                    "id":"response-1","conversation_id":"conversation-1",
                    "object":"realtime.response","status":"completed",
                    "modalities":["text"],"output":[]
                }
            })),
        )
        .expect_err("completed response without bound text must not look successful");
        assert!(error.contains("no text bound"), "{error}");
        assert_eq!(unbound.response_count, 0);
    }

    #[test]
    fn provider_error_and_zero_response_finish_cannot_complete_nonempty_input() {
        let mut provider_error = raw_plan();
        activate(&mut provider_error, "session-1");
        let error = apply_livetranslate_event_to_raw(
            &mut provider_error,
            3.0,
            0,
            &event("event-provider-error", json!({
                "type":"error",
                "error":{
                    "type":"invalid_request_error", "code":"invalid_event",
                    "message":"invalid event", "param":"type"
                }
            })),
        )
        .expect_err("an admitted provider error shape must still fail the benchmark");
        assert!(error.contains("provider-error"), "{error}");

        let mut zero_response = raw_plan();
        activate(&mut zero_response, "session-1");
        zero_response
            .live_translate_plan
            .as_mut()
            .unwrap()
            .take_session_finish()
            .unwrap();
        let error = apply_livetranslate_event_to_raw(
            &mut zero_response,
            4.0,
            1,
            &event("event-session-finished", json!({"type":"session.finished"})),
        )
        .expect_err("non-empty input cannot complete without translated output");
        assert!(error.contains("provider-output-missing"), "{error}");
        assert!(!zero_response.session_finished);
    }

    #[derive(Clone, Copy)]
    enum LoopbackScenario {
        Complete,
        BareUpdated,
        ReadinessError,
        ProviderError,
        ZeroResponse,
    }

    fn run_livetranslate_loopback(scenario: LoopbackScenario) -> Result<RawResult, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let response_events = match scenario {
            LoopbackScenario::Complete => completed_response_sequence(),
            LoopbackScenario::BareUpdated | LoopbackScenario::ReadinessError => Vec::new(),
            LoopbackScenario::ProviderError => vec![event("event-provider-error", json!({
                "type":"error",
                "error":{
                    "type":"invalid_request_error", "code":"invalid_event",
                    "message":"invalid event", "param":"type"
                }
            }))],
            LoopbackScenario::ZeroResponse => Vec::new(),
        };
        let response_count = response_events.len();
        let server = thread::spawn(move || -> Result<(), String> {
            let (stream, _) = listener.accept().map_err(|error| error.to_string())?;
            let mut socket = tungstenite::accept(stream).map_err(|error| error.to_string())?;
            let update: Value = match socket.read().map_err(|error| error.to_string())? {
                Message::Text(text) => {
                    serde_json::from_str(&text).map_err(|error| error.to_string())?
                }
                other => return Err(format!("expected session.update text, got {other:?}")),
            };
            if update.get("type").and_then(Value::as_str) != Some("session.update") {
                return Err("client did not send the prepared session.update".to_string());
            }
            let mut updated = event("event-updated", json!({
                "type":"session.updated",
                "session":{"id":"session-1","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}
            }));
            updated["session"]
                .as_object_mut()
                .expect("session object")
                .extend(
                    update["session"]
                        .as_object()
                        .ok_or_else(|| "sent session config is not an object".to_string())?
                        .clone(),
                );
            if matches!(scenario, LoopbackScenario::BareUpdated) {
                return socket
                    .send(Message::Text(updated.to_string().into()))
                    .map_err(|error| error.to_string());
            }
            socket
                .send(Message::Text(
                    event("event-created", json!({
                        "type":"session.created",
                        "session":{"id":"session-1","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}
                    }))
                    .to_string()
                    .into(),
                ))
                .map_err(|error| error.to_string())?;
            if matches!(scenario, LoopbackScenario::ReadinessError) {
                return socket
                    .send(Message::Text(
                        event("event-setup-error", json!({
                            "type":"error",
                            "error":{
                                "type":"invalid_request_error", "code":"invalid_session",
                                "message":"invalid session", "param":"session"
                            }
                        }))
                        .to_string()
                        .into(),
                    ))
                    .map_err(|error| error.to_string());
            }
            socket
                .send(Message::Text(updated.to_string().into()))
                .map_err(|error| error.to_string())?;
            let append: Value = match socket.read().map_err(|error| error.to_string())? {
                Message::Text(text) => {
                    serde_json::from_str(&text).map_err(|error| error.to_string())?
                }
                other => return Err(format!("expected audio append text, got {other:?}")),
            };
            if append.get("type").and_then(Value::as_str)
                != Some("input_audio_buffer.append")
            {
                return Err("client did not send the prepared audio append".to_string());
            }
            for event in response_events {
                socket
                    .send(Message::Text(event.to_string().into()))
                    .map_err(|error| error.to_string())?;
            }
            if matches!(scenario, LoopbackScenario::ProviderError) {
                return Ok(());
            }
            let finish: Value = match socket.read().map_err(|error| error.to_string())? {
                Message::Text(text) => {
                    serde_json::from_str(&text).map_err(|error| error.to_string())?
                }
                other => return Err(format!("expected session.finish text, got {other:?}")),
            };
            if finish.get("type").and_then(Value::as_str) != Some("session.finish") {
                return Err("client did not send the prepared session.finish".to_string());
            }
            socket
                .send(Message::Text(
                    event("event-finished", json!({"type":"session.finished"}))
                        .to_string()
                        .into(),
                ))
                .map_err(|error| error.to_string())
        });

        let request = format!("ws://{address}/benchmark")
            .into_client_request()
            .map_err(|error| error.to_string())?;
        let (mut plan, (mut socket, _)) =
            livetranslate_plan::with_prepared_livetranslate_plan(
                &config(),
                &[1_i16; CHUNK_SAMPLES],
                || connect(request).map_err(|error| error.to_string()),
            )?;
        let outcome = (|| {
            socket
                .send(Message::Text(plan.session_update().to_string().into()))
                .map_err(|error| error.to_string())?;
            plan.wait_until_ready(&mut socket)?;
            socket
                .send(Message::Text(plan.audio_append(0)?.to_string().into()))
                .map_err(|error| error.to_string())?;
            let mut raw = RawResult {
                live_translate_plan: Some(plan),
                ..Default::default()
            };
            for index in 0..response_count {
                let event: Value = match socket.read().map_err(|error| error.to_string())? {
                    Message::Text(text) => {
                        serde_json::from_str(&text).map_err(|error| error.to_string())?
                    }
                    other => return Err(format!("expected server event, got {other:?}")),
                };
                apply_livetranslate_event_to_raw(&mut raw, 10.0 + index as f64, 1, &event)?;
            }
            if matches!(scenario, LoopbackScenario::ProviderError) {
                return Err("provider error fixture unexpectedly continued".to_string());
            }
            let finish = raw
                .live_translate_plan
                .as_mut()
                .expect("loopback plan")
                .take_session_finish()?;
            socket
                .send(Message::Text(finish.to_string().into()))
                .map_err(|error| error.to_string())?;
            let finished: Value = match socket.read().map_err(|error| error.to_string())? {
                Message::Text(text) => {
                    serde_json::from_str(&text).map_err(|error| error.to_string())?
                }
                other => return Err(format!("expected session.finished, got {other:?}")),
            };
            apply_livetranslate_event_to_raw(&mut raw, 30.0, 1, &finished)?;
            Ok(raw)
        })();
        let _ = socket.close(None);
        server
            .join()
            .map_err(|_| "loopback server panicked".to_string())??;
        outcome
    }

    #[test]
    fn real_loopback_requires_a_complete_response_before_terminal_success() {
        let complete = run_livetranslate_loopback(LoopbackScenario::Complete)
            .expect("complete typed fixture should succeed over the real socket boundary");
        assert_eq!(complete.response_count, 1);
        assert_eq!(complete.translation_final, "你好");
        assert!(complete.session_finished);

        let bare_updated = match run_livetranslate_loopback(LoopbackScenario::BareUpdated) {
            Ok(_) => panic!("bare session.updated cannot establish readiness"),
            Err(error) => error,
        };
        assert!(bare_updated.contains("must follow session.created"), "{bare_updated}");

        let readiness_error = match run_livetranslate_loopback(LoopbackScenario::ReadinessError) {
            Ok(_) => panic!("setup provider error cannot be treated as readiness progress"),
            Err(error) => error,
        };
        assert!(readiness_error.contains("provider-error"), "{readiness_error}");

        let provider_error = match run_livetranslate_loopback(LoopbackScenario::ProviderError) {
            Ok(_) => panic!("provider error cannot be followed by synthetic success"),
            Err(error) => error,
        };
        assert!(provider_error.contains("provider-error"), "{provider_error}");

        let zero_response = match run_livetranslate_loopback(LoopbackScenario::ZeroResponse) {
            Ok(_) => panic!("zero-response terminal cannot complete non-empty input"),
            Err(error) => error,
        };
        assert!(zero_response.contains("provider-output-missing"), "{zero_response}");
    }
}
