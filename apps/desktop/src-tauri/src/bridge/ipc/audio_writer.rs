pub(crate) fn write_virtual_mic_frame<R: tauri::Runtime>(
    app: &AppHandle<R>,
    cue_id: &str,
    request_id: &str,
    route_direction: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    created_at_ms: u64,
    estimated_duration_ms: u64,
) -> Result<u64, String> {
    let chunks = virtual_mic_pacing_chunks(samples, sample_rate_hz, channel_count)?;
    let bridge_state = app.state::<BridgeStateStore>();
    let expected_session_id = bridge_state.snapshot().session_id;
    let started_at = Instant::now();
    let mut accepted_frames = 0;
    for (index, chunk) in chunks.iter().enumerate() {
        if bridge_state.snapshot().session_id != expected_session_id {
            return Err("Bridge session changed while virtual mic audio was paced; remaining stale audio was discarded.".to_string());
        }
        if index > 0 {
            let deadline = started_at + Duration::from_millis(index as u64 * 20);
            if let Some(delay) = deadline.checked_duration_since(Instant::now()) {
                thread::sleep(delay);
            }
        }
        accepted_frames += write_bridge_audio_frame(
            app,
            "bridge.translation.frame",
            cue_id,
            &format!("{request_id}-chunk-{index}"),
            route_direction,
            TranslationAudioSink::VirtualMic,
            chunk,
            sample_rate_hz,
            channel_count,
            created_at_ms,
            estimated_duration_ms,
            Some(index as u32),
            Some(chunks.len() as u32),
            None,
        )?;
    }
    Ok(accepted_frames)
}

pub(crate) fn write_process_playback_cue<R: tauri::Runtime>(
    app: &AppHandle<R>,
    cue_id: &str,
    request_id: &str,
    route_direction: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    created_at_ms: u64,
    estimated_duration_ms: u64,
) -> Result<u64, String> {
    let chunks = process_playback_cue_chunks(samples, sample_rate_hz, channel_count)?;
    let Some(cue) = chunks.first() else {
        return Ok(0);
    };
    write_bridge_audio_frame(
        app,
        "bridge.translation.frame",
        cue_id,
        request_id,
        route_direction,
        TranslationAudioSink::PhysicalPlayback,
        cue,
        sample_rate_hz,
        channel_count,
        created_at_ms,
        estimated_duration_ms,
        None,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn write_process_playback_stream<R: tauri::Runtime>(
    app: &AppHandle<R>,
    cue_id: &str,
    request_id: &str,
    route_direction: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    created_at_ms: u64,
    estimated_duration_ms: u64,
    chunk_index: u32,
    stream_state: TranslationStreamState,
) -> Result<u64, String> {
    validate_translation_audio_format(samples, sample_rate_hz, channel_count)?;
    write_bridge_audio_frame(
        app,
        "bridge.translation.frame",
        cue_id,
        request_id,
        route_direction,
        TranslationAudioSink::PhysicalPlayback,
        samples,
        sample_rate_hz,
        channel_count,
        created_at_ms,
        estimated_duration_ms,
        Some(chunk_index),
        None,
        Some(stream_state),
    )
}

fn validate_translation_audio_format(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Result<(), String> {
    if sample_rate_hz == 0 || channel_count == 0 {
        return Err(
            "Bridge translation audio requires a non-zero sample rate and channel count."
                .to_string(),
        );
    }
    if samples.len() % channel_count as usize != 0 {
        return Err(format!(
            "Bridge translation audio contains a partial channel frame (samples={}, channels={channel_count}).",
            samples.len(),
        ));
    }
    Ok(())
}

fn process_playback_cue_chunks(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Result<Vec<&[i16]>, String> {
    validate_translation_audio_format(samples, sample_rate_hz, channel_count)?;
    Ok(if samples.is_empty() {
        Vec::new()
    } else {
        vec![samples]
    })
}

fn virtual_mic_pacing_chunks(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Result<Vec<&[i16]>, String> {
    validate_translation_audio_format(samples, sample_rate_hz, channel_count)?;
    let samples_per_chunk = (sample_rate_hz as usize / 50).max(1) * channel_count as usize;
    Ok(samples.chunks(samples_per_chunk).collect())
}

fn accepted_translation_frames(ack: &BridgeTranslationFrameAck) -> Result<u64, String> {
    if let Some(error_code) = ack.error_code.as_deref() {
        return Err(format!(
            "{}: {}",
            error_code,
            ack.message
                .as_deref()
                .unwrap_or("Bridge Service rejected the translation frame.")
        ));
    }
    if ack.event_type != "bridge.translation.ack" {
        return Err(
            "Bridge Service returned an invalid translation frame acknowledgement.".to_string(),
        );
    }
    Ok(ack.accepted_frames as u64)
}

#[allow(clippy::too_many_arguments)]
fn translation_frame_header(
    event_type: &str,
    request_id: &str,
    session_id: String,
    cue_id: &str,
    route_direction: AudioRouteDirection,
    translation_sink: TranslationAudioSink,
    sample_rate_hz: u32,
    channel_count: u16,
    frame_count: usize,
    payload_bytes: usize,
    created_at_ms: u64,
    estimated_duration_ms: u64,
    chunk_index: Option<u32>,
    chunk_count: Option<u32>,
    stream_state: Option<TranslationStreamState>,
) -> BridgeTranslationFrameHeader {
    BridgeTranslationFrameHeader {
        event_type: event_type.to_string(),
        request_id: request_id.to_string(),
        session_id,
        frame_id: format!("{}-{}", cue_id, Uuid::new_v4()),
        stream_id: cue_id.to_string(),
        sample_rate_hz,
        sample_format: AudioSampleFormat::PcmS16le,
        channel_count,
        frame_count,
        timestamp_ms: now_unix_ms(),
        payload_bytes,
        bridge_process_id: None,
        bridge_instance_id: None,
        source_generation: None,
        source_generation_token: None,
        cue_id: Some(cue_id.to_string()),
        created_at_ms: Some(created_at_ms),
        estimated_duration_ms: Some(estimated_duration_ms),
        chunk_index,
        chunk_count,
        stream_state,
        translated_audio_enhancement_applied: true,
        translation_sink: Some(translation_sink),
        route_direction: Some(route_direction),
    }
}

fn parse_route_direction(value: &str) -> Result<AudioRouteDirection, String> {
    match value {
        "inbound" => Ok(AudioRouteDirection::Inbound),
        "outbound" => Ok(AudioRouteDirection::Outbound),
        _ => Err(format!(
            "bridge.invalid-audio-direction: translated audio has unsupported routeDirection={value}"
        )),
    }
}

fn write_bridge_audio_frame<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    cue_id: &str,
    request_id: &str,
    route_direction: &str,
    translation_sink: TranslationAudioSink,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    created_at_ms: u64,
    estimated_duration_ms: u64,
    chunk_index: Option<u32>,
    chunk_count: Option<u32>,
    stream_state: Option<TranslationStreamState>,
) -> Result<u64, String> {
    let route_direction = parse_route_direction(route_direction)?;
    let bridge_state = app.state::<BridgeStateStore>();
    let snapshot = bridge_state.snapshot();
    if snapshot.process_status != "running" || snapshot.bridge_state != "running" {
        log_error!(
            app,
            "bridge",
            "Bridge Service 未运行，无法写入虚拟麦克风帧",
            format!(
                "cueId={} processStatus={} bridgeState={}",
                cue_id, snapshot.process_status, snapshot.bridge_state
            )
        );
        return Err("Bridge Service 未启动或尚未完成握手。".to_string());
    }

    let session_id = snapshot.session_id.clone().ok_or_else(|| {
        log_error!(
            app,
            "bridge",
            "Bridge Service 会话不存在，无法写入虚拟麦克风帧",
            format!("cueId={}", cue_id)
        );
        "Bridge Service 会话不存在。".to_string()
    })?;

    let frame_count = samples.len() / channel_count as usize;
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let header = translation_frame_header(
        event_type,
        request_id,
        session_id,
        cue_id,
        route_direction,
        translation_sink,
        sample_rate_hz,
        channel_count,
        frame_count,
        bytes.len(),
        created_at_ms,
        estimated_duration_ms,
        chunk_index,
        chunk_count,
        stream_state,
    );
    let header_bytes = serde_json::to_vec(&header).map_err(|error| error.to_string())?;
    let mut audio_pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&snapshot.audio_pipe_path)
        .map_err(|error| format!("Bridge audio pipe open failed: {}", error))?;
    audio_pipe
        .write_all(&(header_bytes.len() as u32).to_le_bytes())
        .and_then(|_| audio_pipe.write_all(&header_bytes))
        .and_then(|_| audio_pipe.write_all(&bytes))
        .and_then(|_| audio_pipe.flush())
        .map_err(|error| format!("Bridge audio pipe write failed: {}", error))?;
    let mut ack_size = [0_u8; 4];
    audio_pipe
        .read_exact(&mut ack_size)
        .map_err(|error| format!("Bridge audio pipe ack size read failed: {}", error))?;
    let mut ack_bytes = vec![0_u8; u32::from_le_bytes(ack_size) as usize];
    audio_pipe
        .read_exact(&mut ack_bytes)
        .map_err(|error| format!("Bridge audio pipe ack read failed: {}", error))?;
    let ack: BridgeTranslationFrameAck =
        serde_json::from_slice(&ack_bytes).map_err(|error| error.to_string())?;

    if let Some(error_code) = ack.error_code.as_deref() {
        bridge_state.update_snapshot(|current| {
            current.last_error_code = Some(error_code.to_string());
            reconcile_bridge_snapshot(current);
        });
        return accepted_translation_frames(&ack);
    }
    let accepted_frames = accepted_translation_frames(&ack)?;
    bridge_state.update_snapshot(|current| {
        current.translated_frames_accepted += ack.accepted_frames as u64;
        current.playback_frames_written = ack.playback_frames_written;
        current.last_frame_timestamp_ms = Some(now_unix_ms());
        current.last_error_code = None;
        reconcile_bridge_snapshot(current);
    });
    let runtime_state = app.state::<crate::runtime::state::RuntimeStateStore>();
    let _ = emit_runtime_snapshot(app, &runtime_state);
    Ok(accepted_frames)
    /*
        _ => Err("Bridge Service 写帧响应无效。".to_string()),
    */
}


pub(crate) fn flush_bridge_source(snapshot: &BridgeRuntimeSnapshot) -> Result<(), String> {
    let _ = write_command_once_quiet(
        &snapshot.pipe_path,
        &DriverBridgeCommand::SourceFlush(BridgeSourceFlushRequest {
            request_id: format!("bridge-source-flush-{}", now_unix_ms()),
        }),
    );
    Ok(())
}
