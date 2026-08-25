fn drain_available(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    r: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
) -> Result<(), String> {
    drain_text_events(
        handle_realtime_event,
        "read error",
        socket,
        audio_start,
        r,
        last_event,
        progress,
    )
}

fn drain_text_events(
    handle: fn(&mut RawResult, &mut BenchmarkProgressState, f64, &Value) -> Result<(), String>,
    read_error_prefix: &str,
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    r: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
) -> Result<(), String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                *last_event = Instant::now();
                let event: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                handle(r, progress, elapsed_ms(audio_start), &event)?;
            }
            Ok(Message::Close(_)) => return Ok(()),
            Err(e) if is_timeout(&e.to_string()) => return Ok(()), // No more events right now
            Err(e) => return Err(format!("{read_error_prefix}: {e}")),
            _ => continue,
        }
    }
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
    r.response_done_ms = Some(ms);
    r.response_count += 1;
    if r.response_done_audio_chunks_sent.is_none() {
        let chunks_sent = progress.run.audio_chunks_sent;
        r.response_done_audio_chunks_sent = Some(chunks_sent);
        r.response_done_audio_sent_secs =
            Some(chunks_sent as f64 * CHUNK_SAMPLES as f64 / 16_000.0);
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
) -> Result<(), String> {
    drain_text_events(
        handle_gemini_event,
        "Gemini read error",
        socket,
        audio_start,
        r,
        last_event,
        progress,
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
