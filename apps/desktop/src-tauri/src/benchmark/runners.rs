#[path = "runners/connection.rs"]
mod connection;
#[path = "runners/livetranslate_plan.rs"]
mod livetranslate_plan;
use connection::{
    authorize_bailian_model_operation_for_benchmark_invocation,
    connect_benchmark_websocket,
};
use livetranslate_plan::{
    with_prepared_livetranslate_plan, PreparedLiveTranslateBenchmarkPlan,
};

pub(crate) async fn run_model_benchmark(
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
    provider: Option<crate::provider::contracts::ProviderDraftInput>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let requested_provider_kind = provider_kind
            .as_deref()
            .or_else(|| provider.as_ref().map(|provider| provider.kind.as_str()))
            .unwrap_or("dashscope")
            .to_string();
        let model_protocol_authority =
            authorize_bailian_model_operation_for_benchmark_invocation(
                &model,
                &requested_provider_kind,
                provider.as_ref(),
                base_url.as_deref(),
                auth_header_name.as_deref(),
                auth_scheme.as_deref(),
            )?;
        let resolved_profile = provider
            .as_ref()
            .map(|provider| crate::audio::events::resolve_realtime_profile(provider, &model));
        if let Some(authority) = model_protocol_authority.as_ref() {
            let resolved_authority = resolved_profile
                .as_ref()
                .and_then(|profile| profile.model_protocol_authority.as_ref());
            if resolved_authority != Some(authority) {
                return Err(
                    "model_protocol.authorization_identity_mismatch: benchmark route resolution does not match the pre-connect invocation authority"
                        .to_string(),
                );
            }
        }
        let resolved_mode = resolved_profile
            .as_ref()
            .map(|profile| profile.realtime_audio_mode.as_str())
            .or(realtime_audio_mode.as_deref());
        let audio_mode = RealtimeAudioMode::from_frontend(resolved_mode, &model)?;
        let config = BenchmarkConfig {
            api_key,
            mp3_path: PathBuf::from(&mp3_path),
            model: model.clone(),
            audio_mode,
            interaction_capabilities: interaction_capabilities.unwrap_or_default(),
            provider_kind: requested_provider_kind,
            base_url: base_url
                .filter(|value| !value.trim().is_empty())
                .or_else(|| provider.as_ref().map(|provider| provider.base_url.clone()))
                .unwrap_or_else(|| DEFAULT_WS_BASE_URL.to_string()),
            auth_header_name: auth_header_name
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    provider
                        .as_ref()
                        .map(|provider| provider.auth_ref.header_name.clone())
                })
                .unwrap_or_else(|| "Authorization".to_string()),
            auth_scheme: auth_scheme
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    provider
                        .as_ref()
                        .map(|provider| provider.auth_ref.scheme.clone())
                })
                .unwrap_or_else(|| "bearer".to_string()),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            protocol_dialect: resolved_profile.and_then(|profile| profile.protocol_dialect),
            model_protocol_authority,
        };

        if !config.mp3_path.exists() {
            return Err(format!("Audio file not found: {}", config.mp3_path.display()));
        }

        let decode_result = read_audio_samples_with_info(&config.mp3_path)?;
        let samples = decode_result.samples;
        let audio_duration = samples.len() as f64 / 16_000.0;
        let total_audio_chunks = samples.chunks(CHUNK_SAMPLES).count();

        let file_name = config.mp3_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| config.mp3_path.display().to_string());
        let format = config.mp3_path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("unknown")
            .to_ascii_lowercase();
        let audio_info = AudioFileInfo {
            file_name,
            format,
            file_size_bytes: decode_result.file_size_bytes,
            original_sample_rate: decode_result.original_sample_rate,
            channels: decode_result.channels,
            decoded_samples: samples.len(),
            duration_secs: audio_duration,
        };

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
        progress.audio_info = Some(audio_info.clone());
        progress.emit(
            "running",
            "audio-decoded",
            format!("音频已解码，音频时长 {:.1}s", audio_duration),
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

        let output_delta_count = result.raw.output_deltas.len();
        let total_output_duration_ms = total_output_duration_from(
            result.raw.response_done_ms,
            result.raw.first_output_ms,
            result.raw.response_created_ms,
        );

        let run_result = RunResult {
            run_index: 0,
            model: model.clone(),
            connect_ms: result.connect_ms,
            session_ready_ms: result.session_ready_ms,
            audio_send_ms: result.audio_send_ms,
            audio_chunks_sent: result.audio_chunks_sent,
            audio_duration_secs: audio_duration,
            first_asr_ms: result.raw.first_asr_ms,
            asr_deltas: result.raw.asr_deltas,
            asr_final: result.raw.asr_final,
            first_output_ms: result.raw.first_output_ms,
            first_committed_ms: result.raw.first_committed_ms,
            output_deltas: result.raw.output_deltas,
            translation_final: result.raw.translation_final,
            response_created_ms: result.raw.response_created_ms,
            response_done_ms: result.raw.response_done_ms,
            response_done_audio_chunks_sent: result.raw.response_done_audio_chunks_sent,
            response_done_audio_sent_secs: result.raw.response_done_audio_sent_secs,
            response_count: result.raw.response_count,
            speech_started_ms: result.raw.speech_started_ms,
            speech_stopped_ms: result.raw.speech_stopped_ms,
            time_to_first_token_ms: result.raw.first_output_ms,
            time_to_first_committed_ms: result.raw.first_committed_ms,
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
            audio_info: Some(audio_info),
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
    raw: RawResult,
}

fn run_single_benchmark(
    _run_idx: usize,
    config: &BenchmarkConfig,
    samples: &[i16],
    audio_duration: f64,
    progress: &mut BenchmarkProgressState,
) -> Result<IntermediateResult, String> {
    reject_non_turn_based_benchmark(config)?;

    if config.protocol_dialect == Some(crate::audio::events::RealtimeProtocol::GeminiLive)
        || (config.protocol_dialect.is_none() && config.audio_mode.is_gemini())
    {
        return run_single_gemini_benchmark(config, samples, audio_duration, progress);
    }
    if config
        .protocol_dialect
        .is_some_and(|protocol| {
            matches!(
                protocol,
                crate::audio::events::RealtimeProtocol::OpenAiConversation
                    | crate::audio::events::RealtimeProtocol::OpenAiTranslation
                    | crate::audio::events::RealtimeProtocol::OpenAiTranscription
                    | crate::audio::events::RealtimeProtocol::OpenAiFlat
            )
        })
        || (config.protocol_dialect.is_none() && config.provider_kind == "openai-compatible")
    {
        return run_single_openai_benchmark(config, samples, audio_duration, progress);
    }

    let requires_livetranslate_plan = config.provider_kind == "dashscope";

    // ── Phase 1: Connect ──
    let audio_mode_driver = benchmark_audio_mode_driver(config.audio_mode);
    let manual_response = audio_mode_driver.uses_manual_response();
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

    let (mut live_translate_plan, mut socket, connect_ms) = if requires_livetranslate_plan {
        let (plan, (socket, connect_ms)) = with_prepared_livetranslate_plan(
            config,
            samples,
            || {
                let connect_start = Instant::now();
                let (socket, _) =
                    connect_benchmark_websocket(config, request, "connect failed")?;
                Ok((socket, elapsed_ms(&connect_start)))
            },
        )?;
        (Some(plan), socket, connect_ms)
    } else {
        let connect_start = Instant::now();
        let (socket, _) = connect_benchmark_websocket(config, request, "connect failed")?;
        (None, socket, elapsed_ms(&connect_start))
    };
    progress.run.connect_ms = connect_ms;
    progress.emit("running", "connected", "WebSocket 已连接", None);

    set_read_timeout(&mut socket, Duration::from_secs(10));

    // ── Phase 2: Session setup ──
    let session_start = Instant::now();
    let session_cfg = live_translate_plan
        .as_ref()
        .map(|plan| plan.session_update())
        .cloned()
        .unwrap_or_else(|| build_session_update(config));
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|e| format!("session.update send: {e}"))?;
    if let Some(plan) = live_translate_plan.as_mut() {
        plan.wait_until_ready(&mut socket)?;
    } else {
        wait_session_ready(&mut socket)?;
    }
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
        live_translate_plan,
        ..Default::default()
    };
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收模型输出",
        None,
    );

    let requires_session_finished = config
        .model_protocol_authority
        .as_ref()
        .is_some_and(|authority| {
            authority.terminal_lifecycle == "session.finish->session.finished"
        });
    let idle_timeout = Duration::from_secs(if requires_session_finished { 15 } else { 10 });
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
            config.model_protocol_authority.as_ref(),
        )?;

        // 2. Send the next audio chunk
        let msg = raw
            .live_translate_plan
            .as_ref()
            .map(|plan| plan.audio_append(i).cloned())
            .transpose()?
            .unwrap_or_else(|| {
                crate::audio::omni::build_dashscope_audio_append(&base64_encode_i16(chunk))
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
        poll_events_until_deadline(
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
            deadline,
            Some(total_timeout),
            drain_available,
            config.model_protocol_authority.as_ref(),
        )?;

        if audio_start.elapsed() > total_timeout {
            break;
        }
    }

    if progress.run.audio_chunks_sent != chunks.len() {
        return Err(format!(
            "benchmark input watchdog expired before the authoritative audio completed: sentChunks={} expectedChunks={}",
            progress.run.audio_chunks_sent,
            chunks.len()
        ));
    }
    let audio_send_ms = finish_audio_send(progress, &audio_start, chunks.len());
    if manual_response {
        let commit = raw
            .live_translate_plan
            .as_ref()
            .and_then(|plan| plan.manual_commit())
            .cloned()
            .unwrap_or_else(crate::audio::omni::build_dashscope_input_audio_commit);
        socket
            .send(Message::Text(commit.to_string().into()))
            .map_err(|e| format!("audio commit send: {e}"))?;
        if raw.live_translate_plan.is_none() {
            if let Some(response_create) = config
                .protocol_dialect
                .or(Some(crate::audio::events::RealtimeProtocol::DashscopeOmni))
                .and_then(crate::audio::omni::build_dashscope_response_create_for_protocol)
            {
                socket
                    .send(Message::Text(response_create.to_string().into()))
                    .map_err(|e| format!("response.create send: {e}"))?;
            }
        }
        progress.emit(
            "running",
            "response-requested",
            "音频发送完成，已请求模型生成完整响应",
            None,
        );
    }
    if requires_session_finished {
        let finish = raw
            .live_translate_plan
            .as_mut()
            .ok_or_else(|| {
                "model_protocol.adapter_unavailable: session.finish has no typed LiveTranslate plan"
                    .to_string()
            })?
            .take_session_finish()?;
        socket
            .send(Message::Text(finish.to_string().into()))
            .map_err(|error| format!("session.finish send: {error}"))?;
        progress.emit(
            "running",
            "session-finish-sent",
            "音频发送完成，等待 LiveTranslate session.finished",
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
    drain_remaining_and_finish(
        &mut socket,
        &audio_start,
        raw,
        &mut last_event,
        progress,
        idle_timeout,
        drain_available,
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        chunks.len(),
        config.model_protocol_authority.as_ref(),
    )
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
    let dialect = config
        .protocol_dialect
        .map(crate::audio::openai_realtime::dialect_from_protocol)
        .transpose()?
        .unwrap_or(crate::audio::openai_realtime::OpenAiRealtimeDialect::Conversation);
    let ws_url = crate::audio::openai_realtime::build_ws_url(
        dialect,
        &config.base_url,
        &config.model,
    )?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("OpenAI request build failed: {e}"))?;
    apply_benchmark_auth(request.headers_mut(), config)?;

    let (mut socket, _) =
        connect_benchmark_websocket(config, request, "OpenAI connect failed")?;
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
    let input_rate = match dialect {
        crate::audio::openai_realtime::OpenAiRealtimeDialect::FlatCompat => 16_000,
        _ => 24_000,
    };
    let resampled = crate::audio::pcm_resample::resample_mono_i16(samples, 16_000, input_rate);
    let chunks: Vec<&[i16]> = resampled.chunks((input_rate / 50) as usize).collect();
    let audio_start = Instant::now();
    let mut last_event = Instant::now();
    let idle_timeout = Duration::from_secs(20);
    set_read_timeout(&mut socket, Duration::from_millis(1));
    progress.emit(
        "running",
        "audio-streaming",
        "开始发送音频并接收 OpenAI 输出",
        None,
    );

    for (idx, chunk) in chunks.iter().enumerate() {
        let encoded = base64_encode_i16(chunk);
        let msg = crate::audio::openai_realtime::audio_append_event(dialect, &encoded);
        socket
            .send(Message::Text(msg.to_string().into()))
            .map_err(|e| format!("OpenAI audio append send: {e}"))?;
        progress.run.audio_chunks_sent = idx + 1;
        progress.emit_audio_progress(false);
        poll_chunk_gap_events(
            drain_available,
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
            None,
        )?;
    }

    let audio_send_ms = finish_audio_send(progress, &audio_start, chunks.len());
    if manual_response {
        for msg in crate::audio::openai_realtime::manual_commit_messages(dialect, false) {
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

    drain_remaining_and_finish(
        &mut socket,
        &audio_start,
        raw,
        &mut last_event,
        progress,
        idle_timeout,
        drain_available,
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        chunks.len(),
        None,
    )
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

    let (mut socket, _) =
        connect_benchmark_websocket(config, request, "Gemini connect failed")?;
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
        poll_chunk_gap_events(
            drain_gemini_available,
            &mut socket,
            &audio_start,
            &mut raw,
            &mut last_event,
            progress,
            None,
        )?;
    }

    let audio_send_ms = finish_audio_send(progress, &audio_start, chunks.len());
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

    drain_remaining_and_finish(
        &mut socket,
        &audio_start,
        raw,
        &mut last_event,
        progress,
        idle_timeout,
        drain_gemini_available,
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        chunks.len(),
        None,
    )
}

// ─────────────────────────────── Shared Phases ──────────────────────────────

type DrainEventsFn = fn(
    &mut WebSocket<MaybeTlsStream<TcpStream>>,
    &Instant,
    &mut RawResult,
    &mut Instant,
    &mut BenchmarkProgressState,
    Option<&crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile>,
) -> Result<(), String>;

/// Marks the audio-send phase complete and returns its duration.
fn finish_audio_send(
    progress: &mut BenchmarkProgressState,
    audio_start: &Instant,
    total_chunks: usize,
) -> f64 {
    let audio_send_ms = elapsed_ms(audio_start);
    progress.run.audio_send_ms = audio_send_ms;
    progress.run.audio_chunks_sent = total_chunks;
    audio_send_ms
}

/// Polls server events until `deadline`, sleeping in short slices so the next
/// audio chunk still goes out on schedule.
fn poll_events_until_deadline(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    raw: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
    deadline: Instant,
    total_timeout: Option<Duration>,
    drain: DrainEventsFn,
    model_protocol_authority: Option<
        &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    >,
) -> Result<(), String> {
    while Instant::now() < deadline {
        if let Some(total) = total_timeout {
            if audio_start.elapsed() > total {
                break;
            }
        }
        drain(
            socket,
            audio_start,
            raw,
            last_event,
            progress,
            model_protocol_authority,
        )?;
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain > Duration::from_millis(1) {
            thread::sleep(remain.min(Duration::from_millis(5)));
        }
    }
    Ok(())
}

/// Fixed 20ms inter-chunk gap poll shared by the OpenAI and Gemini runners.
fn poll_chunk_gap_events(
    drain: DrainEventsFn,
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    raw: &mut RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
    model_protocol_authority: Option<
        &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    >,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(CHUNK_SEND_INTERVAL_MS);
    poll_events_until_deadline(
        socket,
        audio_start,
        raw,
        last_event,
        progress,
        deadline,
        None,
        drain,
        model_protocol_authority,
    )
}

/// Drains the remaining server events after audio send completes: switch back
/// to a longer read timeout, wait for idle or a settled `response.done`, then
/// close the socket and assemble the intermediate result.
fn drain_remaining_and_finish(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    audio_start: &Instant,
    mut raw: RawResult,
    last_event: &mut Instant,
    progress: &mut BenchmarkProgressState,
    idle_timeout: Duration,
    drain: DrainEventsFn,
    connect_ms: f64,
    session_ready_ms: f64,
    audio_send_ms: f64,
    audio_chunks_sent: usize,
    model_protocol_authority: Option<
        &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    >,
) -> Result<IntermediateResult, String> {
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);
    let done_quiet_period = Duration::from_millis(700);
    set_read_timeout(socket, Duration::from_secs(5));
    while last_event.elapsed() < idle_timeout && audio_start.elapsed() < total_timeout {
        drain(
            socket,
            audio_start,
            &mut raw,
            last_event,
            progress,
            model_protocol_authority,
        )?;
        let requires_session_finished = model_protocol_authority.is_some_and(|authority| {
            authority.terminal_lifecycle == "session.finish->session.finished"
        });
        if (requires_session_finished && raw.session_finished)
            || (!requires_session_finished
                && raw.response_done_ms.is_some()
                && last_event.elapsed() >= done_quiet_period)
        {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if model_protocol_authority.is_some_and(|authority| {
        authority.terminal_lifecycle == "session.finish->session.finished"
    }) && !raw.session_finished
    {
        let _ = socket.close(None);
        return Err(
            "provider-finish-timeout: LiveTranslate benchmark did not receive session.finished after session.finish"
                .to_string(),
        );
    }
    let _ = socket.close(None);

    Ok(IntermediateResult {
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        audio_chunks_sent,
        raw,
    })
}

// ──────────────────────────────── Event Drain ───────────────────────────────
