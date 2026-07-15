#[tauri::command]
pub async fn run_model_benchmark(
    app: AppHandle,
    model: String,
    api_key: String,
    mp3_path: String,
    run_id: String,
    realtime_audio_mode: Option<String>,
    interaction_capabilities: Option<Vec<String>>,
    provider_kind: Option<String>,
    base_url: Option<String>,
    auth_header_name: Option<String>,
    auth_scheme: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let audio_mode = RealtimeAudioMode::from_frontend(realtime_audio_mode.as_deref(), &model)?;
        let config = BenchmarkConfig {
            api_key,
            mp3_path: PathBuf::from(&mp3_path),
            model: model.clone(),
            audio_mode,
            interaction_capabilities: interaction_capabilities.unwrap_or_default(),
            provider_kind: provider_kind.unwrap_or_else(|| "dashscope".to_string()),
            base_url: base_url
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_WS_BASE_URL.to_string()),
            auth_header_name: auth_header_name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Authorization".to_string()),
            auth_scheme: auth_scheme
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "bearer".to_string()),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            source_language: "en".to_string(),
        };

        if !config.mp3_path.exists() {
            return Err(format!("MP3 file not found: {}", config.mp3_path.display()));
        }

        let samples = read_mp3_samples(&config.mp3_path)?;
        let audio_duration = samples.len() as f64 / 16_000.0;
        let total_audio_chunks = samples.chunks(CHUNK_SAMPLES).count();

        let mut progress = BenchmarkProgressState::new(
            app.clone(),
            run_id.clone(),
            model.clone(),
            mp3_path.clone(),
            config.audio_mode,
            config.interaction_capabilities.clone(),
            audio_duration,
            total_audio_chunks,
        );
        progress.emit(
            "running",
            "mp3-decoded",
            format!("MP3 已解码，音频时长 {:.1}s", audio_duration),
            None,
        );

        let result = match run_single_benchmark(0, &config, &samples, audio_duration, &mut progress)
        {
            Ok(result) => result,
            Err(error) => {
                progress.emit("error", "failed", error.clone(), Some(error.clone()));
                return Err(error);
            }
        };

        let output_delta_count = result.output_deltas.len();
        let total_output_duration_ms = match (
            result.response_done_ms,
            result.first_output_ms,
            result.response_created_ms,
        ) {
            (Some(done), Some(ftt), _) => Some(done - ftt),
            (Some(done), None, Some(created)) => Some(done - created),
            _ => None,
        };

        let run_result = RunResult {
            run_index: 0,
            model: model.clone(),
            connect_ms: result.connect_ms,
            session_ready_ms: result.session_ready_ms,
            audio_send_ms: result.audio_send_ms,
            audio_chunks_sent: result.audio_chunks_sent,
            audio_duration_secs: audio_duration,
            first_asr_ms: result.first_asr_ms,
            asr_deltas: result.asr_deltas,
            asr_final: result.asr_final,
            first_output_ms: result.first_output_ms,
            first_committed_ms: result.first_committed_ms,
            output_deltas: result.output_deltas,
            translation_final: result.translation_final,
            response_created_ms: result.response_created_ms,
            response_done_ms: result.response_done_ms,
            response_done_audio_chunks_sent: result.response_done_audio_chunks_sent,
            response_done_audio_sent_secs: result.response_done_audio_sent_secs,
            response_count: result.response_count,
            speech_started_ms: result.speech_started_ms,
            speech_stopped_ms: result.speech_stopped_ms,
            time_to_first_token_ms: result.first_output_ms,
            time_to_first_committed_ms: result.first_committed_ms,
            total_output_duration_ms,
            output_delta_count,
        };

        let summary = compute_summary(&[run_result.clone()], audio_duration);
        let report = BenchmarkReport {
            model,
            realtime_audio_mode: config.audio_mode.as_str().to_string(),
            interaction_capabilities: config.interaction_capabilities.clone(),
            audio_file: mp3_path,
            audio_duration_secs: audio_duration,
            runs: vec![run_result],
            summary,
        };

        progress.run = report.runs[0].clone();
        progress.emit("completed", "completed", "基准测试完成", None);

        serde_json::to_string(&report).map_err(|e| format!("JSON serialize failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

// ──────────────────────────────── Single Run ────────────────────────────────

struct IntermediateResult {
    connect_ms: f64,
    session_ready_ms: f64,
    audio_send_ms: f64,
    audio_chunks_sent: usize,
    first_asr_ms: Option<f64>,
    asr_deltas: Vec<AsrDelta>,
    asr_final: String,
    first_output_ms: Option<f64>,
    first_committed_ms: Option<f64>,
    output_deltas: Vec<OutputDelta>,
    translation_final: String,
    response_created_ms: Option<f64>,
    response_done_ms: Option<f64>,
    response_done_audio_chunks_sent: Option<usize>,
    response_done_audio_sent_secs: Option<f64>,
    response_count: u32,
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,
}

fn run_single_benchmark(
    _run_idx: usize,
    config: &BenchmarkConfig,
    samples: &[i16],
    audio_duration: f64,
    progress: &mut BenchmarkProgressState,
) -> Result<IntermediateResult, String> {
    reject_non_turn_based_benchmark(config)?;

    if config.audio_mode.is_gemini() {
        return run_single_gemini_benchmark(config, samples, audio_duration, progress);
    }
    if config.provider_kind == "openai-compatible" {
        return run_single_openai_benchmark(config, samples, audio_duration, progress);
    }

    // ── Phase 1: Connect ──
    let audio_mode_driver = benchmark_audio_mode_driver(config.audio_mode);
    let manual_response = audio_mode_driver.uses_manual_response();
    let connect_start = Instant::now();
    let ws_url = build_default_benchmark_url(&config.base_url, &config.model)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("request build failed: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        build_auth_header_value(config)
            .parse()
            .map_err(|e| format!("auth header parse: {e}"))?,
    );

    let (mut socket, _) = connect(request).map_err(|e| format!("connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);
    progress.run.connect_ms = connect_ms;
    progress.emit("running", "connected", "WebSocket 已连接", None);

    set_read_timeout(&mut socket, Duration::from_secs(10));

    // ── Phase 2: Session setup ──
    let session_start = Instant::now();
    let session_cfg = build_session_update(config);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|e| format!("session.update send: {e}"))?;
    wait_session_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);
    progress.run.session_ready_ms = session_ready_ms;
    progress.emit("running", "session-ready", "Session 已就绪", None);

    // ── Phase 3+4: Interleaved audio streaming + event receiving ──
    // After each 20ms audio chunk send, briefly poll for server events with
    // a 1ms read timeout. This gives pseudo-concurrency without lock contention —
    // events are captured within 1ms of arrival during the 18ms inter-chunk gaps.
    set_read_timeout(&mut socket, Duration::from_millis(1));
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();

    let mut raw = RawResult {
        first_asr_ms: None,
        asr_deltas: Vec::new(),
        asr_final: String::new(),
        first_output_ms: None,
        first_committed_ms: None,
        output_deltas: Vec::new(),
        translation_final: String::new(),
        response_created_ms: None,
        response_done_ms: None,
        response_done_audio_chunks_sent: None,
        response_done_audio_sent_secs: None,
        response_count: 0,
        speech_started_ms: None,
        speech_stopped_ms: None,
    };
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收模型输出",
        None,
    );

    let idle_timeout = Duration::from_secs(10);
    let mut last_event = Instant::now();
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);

    for (i, chunk) in chunks.iter().enumerate() {
        // 1. Drain pending events first (non-blocking)
        drain_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;

        // 2. Send the next audio chunk
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": base64_encode_i16(chunk),
        });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("audio send at chunk {i}: {e}"))?;
        progress.run.audio_chunks_sent = i + 1;
        progress.run.audio_send_ms = elapsed_ms(&audio_start);
        progress.run.audio_duration_secs = audio_duration;
        progress.emit_audio_progress(i + 1 == chunks.len());

        // 3. Wait until it's time for the next chunk (poll events during wait)
        let deadline = audio_start + Duration::from_millis((i + 1) as u64 * CHUNK_SEND_INTERVAL_MS);
        while Instant::now() < deadline {
            if audio_start.elapsed() > total_timeout {
                break;
            }
            drain_available(
                &mut socket,
                &audio_start,
                &mut raw,
                &mut last_event,
                progress,
            )?;
            let remain = deadline.saturating_duration_since(Instant::now());
            if remain > Duration::from_millis(1) {
                thread::sleep(remain.min(Duration::from_millis(5)));
            }
        }

        if audio_start.elapsed() > total_timeout {
            break;
        }
    }

    let audio_send_ms = elapsed_ms(&audio_start);
    progress.run.audio_send_ms = audio_send_ms;
    progress.run.audio_chunks_sent = chunks.len();
    if manual_response {
        socket
            .send(Message::Text(
                json!({ "type": "input_audio_buffer.commit" })
                    .to_string()
                    .into(),
            ))
            .map_err(|e| format!("audio commit send: {e}"))?;
        socket
            .send(Message::Text(
                json!({ "type": "response.create", "response": { "modalities": ["text", "audio"] } })
                    .to_string()
                    .into(),
            ))
            .map_err(|e| format!("response.create send: {e}"))?;
        progress.emit(
            "running",
            "response-requested",
            "音频发送完成，已请求模型生成完整响应",
            None,
        );
    }
    progress.emit(
        "running",
        "audio-sent",
        "音频发送完成，等待剩余模型事件",
        None,
    );

    // ── Phase 5: Drain remaining server events ──
    // Switch back to longer timeout, wait for idle or response.done
    set_read_timeout(&mut socket, Duration::from_secs(5));
    let done_quiet_period = Duration::from_millis(700);
    while last_event.elapsed() < idle_timeout && audio_start.elapsed() < total_timeout {
        drain_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;
        if raw.response_done_ms.is_some() && last_event.elapsed() >= done_quiet_period {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = socket.close(None);

    Ok(IntermediateResult {
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        audio_chunks_sent: chunks.len(),
        first_asr_ms: raw.first_asr_ms,
        asr_deltas: raw.asr_deltas,
        asr_final: raw.asr_final,
        first_output_ms: raw.first_output_ms,
        first_committed_ms: raw.first_committed_ms,
        output_deltas: raw.output_deltas,
        translation_final: raw.translation_final,
        response_created_ms: raw.response_created_ms,
        response_done_ms: raw.response_done_ms,
        response_done_audio_chunks_sent: raw.response_done_audio_chunks_sent,
        response_done_audio_sent_secs: raw.response_done_audio_sent_secs,
        response_count: raw.response_count,
        speech_started_ms: raw.speech_started_ms,
        speech_stopped_ms: raw.speech_stopped_ms,
    })
}

fn run_single_openai_benchmark(
    config: &BenchmarkConfig,
    samples: &[i16],
    _audio_duration: f64,
    progress: &mut BenchmarkProgressState,
) -> Result<IntermediateResult, String> {
    let audio_mode_driver = benchmark_audio_mode_driver(config.audio_mode);
    let manual_response = audio_mode_driver.uses_manual_response();
    let connect_start = Instant::now();
    let ws_url = build_openai_benchmark_url(&config.base_url, &config.model)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("OpenAI request build failed: {e}"))?;
    apply_benchmark_auth(request.headers_mut(), config)?;
    request.headers_mut().insert(
        "OpenAI-Beta",
        "realtime=v1"
            .parse()
            .map_err(|e| format!("OpenAI-Beta header parse: {e}"))?,
    );

    let (mut socket, _) = connect(request).map_err(|e| format!("OpenAI connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);
    progress.run.connect_ms = connect_ms;
    progress.emit(
        "running",
        "connected",
        "OpenAI Realtime WebSocket 已连接",
        None,
    );
    set_read_timeout(&mut socket, Duration::from_secs(10));

    let session_start = Instant::now();
    let session_cfg = build_openai_session_update(config);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|e| format!("OpenAI session.update send: {e}"))?;
    wait_session_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);
    progress.run.session_ready_ms = session_ready_ms;
    progress.emit(
        "running",
        "session-ready",
        "OpenAI Realtime session 已就绪",
        None,
    );

    let mut raw = RawResult::default();
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();
    let mut last_event = Instant::now();
    let idle_timeout = Duration::from_secs(20);
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);
    set_read_timeout(&mut socket, Duration::from_millis(1));
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收 OpenAI 输出",
        None,
    );

    for (idx, chunk) in chunks.iter().enumerate() {
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": base64_encode_i16(chunk)
        });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("OpenAI audio append send: {e}"))?;
        progress.run.audio_chunks_sent = idx + 1;
        progress.emit_audio_progress(false);
        let deadline = Instant::now() + Duration::from_millis(CHUNK_SEND_INTERVAL_MS);
        while Instant::now() < deadline {
            drain_available(
                &mut socket,
                &audio_start,
                &mut raw,
                &mut last_event,
                progress,
            )?;
            let remain = deadline.saturating_duration_since(Instant::now());
            if remain > Duration::from_millis(1) {
                thread::sleep(remain.min(Duration::from_millis(5)));
            }
        }
    }

    let audio_send_ms = elapsed_ms(&audio_start);
    progress.run.audio_send_ms = audio_send_ms;
    progress.run.audio_chunks_sent = chunks.len();
    if manual_response {
        for msg in [
            json!({ "type": "input_audio_buffer.commit" }),
            json!({ "type": "response.create", "response": { "modalities": ["text"] } }),
        ] {
            socket
                .send(Message::Text(msg.to_string().into()))
                .map_err(|e| format!("OpenAI manual response send: {e}"))?;
        }
        progress.emit(
            "running",
            "response-requested",
            "音频发送完成，已请求 OpenAI 生成完整响应",
            None,
        );
    }
    progress.emit(
        "running",
        "audio-sent",
        "音频发送完成，等待 OpenAI 剩余事件",
        None,
    );

    set_read_timeout(&mut socket, Duration::from_secs(5));
    while last_event.elapsed() < idle_timeout && audio_start.elapsed() < total_timeout {
        drain_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;
        if raw.response_done_ms.is_some() && last_event.elapsed() >= Duration::from_millis(700) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = socket.close(None);

    Ok(intermediate_from_raw(
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        chunks.len(),
        raw,
    ))
}

fn run_single_gemini_benchmark(
    config: &BenchmarkConfig,
    samples: &[i16],
    _audio_duration: f64,
    progress: &mut BenchmarkProgressState,
) -> Result<IntermediateResult, String> {
    let connect_start = Instant::now();
    let ws_url = build_gemini_benchmark_url(&config.base_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Gemini request build failed: {e}"))?;
    apply_benchmark_auth(request.headers_mut(), config)?;

    let (mut socket, _) = connect(request).map_err(|e| format!("Gemini connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);
    progress.run.connect_ms = connect_ms;
    progress.emit("running", "connected", "Gemini Live WebSocket 已连接", None);
    set_read_timeout(&mut socket, Duration::from_secs(10));

    let session_start = Instant::now();
    let setup = build_gemini_setup(config);
    socket
        .send(Message::Text(setup.to_string().into()))
        .map_err(|e| format!("Gemini setup send: {e}"))?;
    wait_gemini_setup_ready(&mut socket)?;
    let session_ready_ms = elapsed_ms(&session_start);
    progress.run.session_ready_ms = session_ready_ms;
    progress.emit("running", "session-ready", "Gemini Live setup 已完成", None);

    let mut raw = RawResult::default();
    let chunks: Vec<&[i16]> = samples.chunks(CHUNK_SAMPLES).collect();
    let audio_start = Instant::now();
    let mut last_event = Instant::now();
    let idle_timeout = Duration::from_secs(20);
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);
    let manual_activity = config.audio_mode == RealtimeAudioMode::GeminiManualActivity;
    set_read_timeout(&mut socket, Duration::from_millis(1));
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收 Gemini Live 输出",
        None,
    );

    if manual_activity {
        socket
            .send(Message::Text(
                json!({ "realtimeInput": { "activityStart": {} } })
                    .to_string()
                    .into(),
            ))
            .map_err(|e| format!("Gemini activityStart send: {e}"))?;
    }

    for (idx, chunk) in chunks.iter().enumerate() {
        let msg = json!({
            "realtimeInput": {
                "audio": {
                    "mimeType": "audio/pcm;rate=16000",
                    "data": base64_encode_i16(chunk)
                }
            }
        });
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("Gemini audio send: {e}"))?;
        progress.run.audio_chunks_sent = idx + 1;
        progress.emit_audio_progress(false);
        let deadline = Instant::now() + Duration::from_millis(CHUNK_SEND_INTERVAL_MS);
        while Instant::now() < deadline {
            drain_gemini_available(
                &mut socket,
                &audio_start,
                &mut raw,
                &mut last_event,
                progress,
            )?;
            let remain = deadline.saturating_duration_since(Instant::now());
            if remain > Duration::from_millis(1) {
                thread::sleep(remain.min(Duration::from_millis(5)));
            }
        }
    }

    let audio_send_ms = elapsed_ms(&audio_start);
    progress.run.audio_send_ms = audio_send_ms;
    progress.run.audio_chunks_sent = chunks.len();
    let end_msg = if manual_activity {
        json!({ "realtimeInput": { "activityEnd": {} } })
    } else {
        json!({ "realtimeInput": { "audioStreamEnd": true } })
    };
    socket
        .send(Message::Text(end_msg.to_string().into()))
        .map_err(|e| format!("Gemini audio end send: {e}"))?;
    progress.emit(
        "running",
        "audio-sent",
        "音频发送完成，等待 Gemini Live 剩余事件",
        None,
    );

    set_read_timeout(&mut socket, Duration::from_secs(5));
    while last_event.elapsed() < idle_timeout && audio_start.elapsed() < total_timeout {
        drain_gemini_available(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
        )?;
        if raw.response_done_ms.is_some() && last_event.elapsed() >= Duration::from_millis(700) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = socket.close(None);

    Ok(intermediate_from_raw(
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        chunks.len(),
        raw,
    ))
}

// ──────────────────────────────── Event Drain ───────────────────────────────
