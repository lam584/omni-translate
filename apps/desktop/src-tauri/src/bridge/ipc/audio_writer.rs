pub(crate) fn write_virtual_mic_frame<R: tauri::Runtime>(
    app: &AppHandle<R>,
    cue_id: &str,
    request_id: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
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
            chunk,
            sample_rate_hz,
            channel_count,
        )?;
    }
    Ok(accepted_frames)
}

fn virtual_mic_pacing_chunks(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Result<Vec<&[i16]>, String> {
    if sample_rate_hz == 0 || channel_count == 0 {
        return Err(
            "Virtual mic pacing requires a non-zero sample rate and channel count.".to_string(),
        );
    }
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

fn write_bridge_audio_frame<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    cue_id: &str,
    request_id: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Result<u64, String> {
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

    let frame_id = format!("{}-{}", cue_id, Uuid::new_v4());
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let header = BridgeTranslationFrameHeader {
        event_type: event_type.to_string(),
        request_id: request_id.to_string(),
        session_id,
        frame_id,
        stream_id: cue_id.to_string(),
        sample_rate_hz,
        channel_count,
        frame_count: samples.len() / channel_count as usize,
        timestamp_ms: now_unix_ms(),
        payload_bytes: bytes.len(),
        translated_audio_enhancement_applied: true,
    };
    let header_bytes = serde_json::to_vec(&header).map_err(|error| error.to_string())?;
    if header_bytes.len() > omni_bridge_protocol::MAX_AUDIO_FRAME_HEADER_BYTES {
        return Err("Bridge audio frame header exceeds protocol limit.".to_string());
    }
    if bytes.len() > omni_bridge_protocol::MAX_AUDIO_FRAME_PAYLOAD_BYTES {
        return Err("Bridge audio frame payload exceeds protocol limit.".to_string());
    }
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
    let ack_size = u32::from_le_bytes(ack_size) as usize;
    if ack_size == 0 || ack_size > omni_bridge_protocol::MAX_AUDIO_FRAME_ACK_BYTES {
        return Err("Bridge audio pipe ack size is invalid.".to_string());
    }
    let mut ack_bytes = vec![0_u8; ack_size];
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
