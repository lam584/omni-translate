const BRIDGE_TRANSLATION_GENERATION_ENDED: &str = "bridge.translation-generation-ended";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BridgeTranslationSinkOwner {
    session_id: String,
    bridge_instance_id: String,
    source_generation: u64,
    source_generation_token: String,
    resolved_physical_playback_device_id: String,
    playback_owner_generation: u64,
}

impl BridgeTranslationSinkOwner {
    pub(crate) fn from_snapshot(snapshot: &BridgeRuntimeSnapshot) -> Option<Self> {
        let endpoint_id = snapshot.resolved_physical_playback_device_id.trim();
        if snapshot.physical_playback_status != "ready"
            || matches!(
                endpoint_id.to_ascii_lowercase().as_str(),
                "" | "default" | "speaker-default" | "system-output-default"
            )
            || snapshot.source_generation == 0
            || snapshot.playback_owner_generation == 0
        {
            return None;
        }
        let session_id = snapshot.session_id.clone()?;
        let bridge_instance_id = snapshot.bridge_instance_id.clone()?;
        let source_generation_token = snapshot.source_generation_token.clone()?;
        let expected_token = format!(
            "{}:{}:{}",
            bridge_instance_id, session_id, snapshot.source_generation
        );
        if source_generation_token != expected_token {
            return None;
        }
        Some(Self {
            session_id,
            bridge_instance_id,
            source_generation: snapshot.source_generation,
            source_generation_token,
            resolved_physical_playback_device_id: endpoint_id.to_string(),
            playback_owner_generation: snapshot.playback_owner_generation,
        })
    }

    fn evidence(&self) -> String {
        format!(
            "sessionId={} bridgeInstanceId={} sourceGeneration={} sourceGenerationToken={} endpointId={} playbackOwnerGeneration={}",
            self.session_id,
            self.bridge_instance_id,
            self.source_generation,
            self.source_generation_token,
            self.resolved_physical_playback_device_id,
            self.playback_owner_generation
        )
    }

    pub(crate) fn bridge_instance_id(&self) -> &str {
        &self.bridge_instance_id
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) fn source_generation(&self) -> u64 {
        self.source_generation
    }

    pub(crate) fn source_generation_token(&self) -> &str {
        &self.source_generation_token
    }

    pub(crate) fn playback_owner_generation(&self) -> u64 {
        self.playback_owner_generation
    }

    pub(crate) fn physical_playback_device_id(&self) -> &str {
        &self.resolved_physical_playback_device_id
    }

    pub(crate) fn playback_authority(
        &self,
    ) -> crate::audio::state::TranslationPlaybackAuthority {
        crate::audio::state::TranslationPlaybackAuthority {
            session_id: self.session_id.clone(),
            bridge_instance_id: self.bridge_instance_id.clone(),
            source_generation: self.source_generation,
            source_generation_token: self.source_generation_token.clone(),
            playback_owner_generation: self.playback_owner_generation,
            physical_playback_device_id: self.resolved_physical_playback_device_id.clone(),
        }
    }

    pub(crate) fn matches_playback_authority(
        &self,
        authority: &crate::audio::state::TranslationPlaybackAuthority,
    ) -> bool {
        self.playback_authority() == *authority
    }
}

fn translation_sink_owner_changed(
    expected: &BridgeTranslationSinkOwner,
    current: &BridgeRuntimeSnapshot,
) -> bool {
    BridgeTranslationSinkOwner::from_snapshot(current).as_ref() != Some(expected)
}

fn translation_write_error_for_owner(
    expected: Option<&BridgeTranslationSinkOwner>,
    current: &BridgeRuntimeSnapshot,
    error: String,
) -> String {
    let Some(expected) = expected.filter(|owner| translation_sink_owner_changed(owner, current))
    else {
        return error;
    };
    translation_generation_ended_error(expected, current, error)
}

fn translation_generation_ended_error(
    expected: &BridgeTranslationSinkOwner,
    current: &BridgeRuntimeSnapshot,
    error: String,
) -> String {
    let current = BridgeTranslationSinkOwner::from_snapshot(current)
        .map(|owner| owner.evidence())
        .unwrap_or_else(|| "sessionId=- bridgeInstanceId=-".to_string());
    format!(
        "{BRIDGE_TRANSLATION_GENERATION_ENDED}: expectedOwner=[{}] currentOwner=[{current}] cause={error}",
        expected.evidence()
    )
}

fn close_failed_translation_cue<R: tauri::Runtime>(
    app: &AppHandle<R>,
    cue_id: &str,
    owner: Option<&BridgeTranslationSinkOwner>,
    error: String,
) -> String {
    if let Some(owner) = owner {
        app.state::<crate::audio::state::AudioStateStore>()
            .translation_playback_quiescence()
            .observe_bridge_playback_status_for_owner(
                cue_id,
                "route-failed",
                &owner.playback_authority(),
            );
    }
    error
}

pub(crate) fn is_bridge_translation_generation_ended_error(error: &str) -> bool {
    error.starts_with(BRIDGE_TRANSLATION_GENERATION_ENDED)
}

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
    write_process_playback_cue_for_owner(
        app,
        cue_id,
        request_id,
        route_direction,
        samples,
        sample_rate_hz,
        channel_count,
        created_at_ms,
        estimated_duration_ms,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn write_process_playback_cue_for_owner<R: tauri::Runtime>(
    app: &AppHandle<R>,
    cue_id: &str,
    request_id: &str,
    route_direction: &str,
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    created_at_ms: u64,
    estimated_duration_ms: u64,
    expected_owner: Option<&BridgeTranslationSinkOwner>,
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
        expected_owner,
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
    expected_owner: &BridgeTranslationSinkOwner,
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
        Some(expected_owner),
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

fn accepted_translation_frames_for_header(
    header: &BridgeTranslationFrameHeader,
    ack: &BridgeTranslationFrameAck,
) -> Result<u64, String> {
    let authority_matches = ack.request_id == header.request_id
        && ack.frame_id == header.frame_id
        && ack.session_id == header.session_id
        && Some(ack.bridge_instance_id.as_str()) == header.bridge_instance_id.as_deref()
        && Some(ack.source_generation) == header.source_generation
        && Some(ack.source_generation_token.as_str()) == header.source_generation_token.as_deref()
        && Some(ack.playback_owner_generation) == header.playback_owner_generation
        && Some(ack.physical_playback_device_id.as_str())
            == header.physical_playback_device_id.as_deref();
    if !authority_matches {
        return Err("Bridge Service returned a translation ACK for a different authority tuple."
            .to_string());
    }
    accepted_translation_frames(ack)
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
    bridge_process_id: Option<u32>,
    bridge_instance_id: Option<String>,
    source_generation: Option<u64>,
    source_generation_token: Option<String>,
    playback_owner_generation: Option<u64>,
    physical_playback_device_id: Option<String>,
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
        bridge_process_id,
        bridge_instance_id,
        playback_owner_generation,
        source_generation,
        source_generation_token,
        physical_playback_device_id,
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
    expected_owner: Option<&BridgeTranslationSinkOwner>,
) -> Result<u64, String> {
    let _pending_ack = matches!(translation_sink, TranslationAudioSink::PhysicalPlayback)
        .then(|| {
            app.state::<crate::audio::state::AudioStateStore>()
                .translation_playback_quiescence()
                .begin_bridge_ack()
        });
    let route_direction = parse_route_direction(route_direction)?;
    let bridge_state = app.state::<BridgeStateStore>();
    let snapshot = bridge_state.snapshot();
    let frame_owner = BridgeTranslationSinkOwner::from_snapshot(&snapshot).ok_or_else(|| {
        "bridge.translation-generation-ended: translation frame authority is incomplete"
            .to_string()
    })?;
    let physical_owner = if matches!(translation_sink, TranslationAudioSink::PhysicalPlayback) {
        let owner = expected_owner
            .cloned()
            .or_else(|| Some(frame_owner.clone()))
            .ok_or_else(|| {
                "bridge.translation-generation-ended: physical playback authority is incomplete"
                    .to_string()
            })?;
        Some(owner)
    } else {
        None
    };
    if let Some(expected_owner) = physical_owner.as_ref() {
        if translation_sink_owner_changed(expected_owner, &snapshot) {
            return Err(translation_write_error_for_owner(
                Some(expected_owner),
                &snapshot,
                "translation write reached a superseded Bridge owner before pipe open".to_string(),
            ));
        }
    }
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
        snapshot.bridge_process_id,
        Some(frame_owner.bridge_instance_id.clone()),
        Some(frame_owner.source_generation),
        Some(frame_owner.source_generation_token.clone()),
        Some(frame_owner.playback_owner_generation),
        Some(frame_owner.resolved_physical_playback_device_id.clone()),
    );
    if let Some(owner) = physical_owner.as_ref() {
        app.state::<crate::audio::state::AudioStateStore>()
            .translation_playback_quiescence()
            .expect_bridge_playback_cue_for_owner(
                cue_id,
                owner.playback_authority(),
                frame_count as u64,
                sample_rate_hz,
            );
    }
    let header_bytes = serde_json::to_vec(&header).map_err(|error| {
        close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), error.to_string())
    })?;
    let mut audio_pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&snapshot.audio_pipe_path)
        .map_err(|error| {
            close_failed_translation_cue(
                app,
                cue_id,
                physical_owner.as_ref(),
                translation_write_error_for_owner(
                    physical_owner.as_ref(),
                    &bridge_state.snapshot(),
                    format!("Bridge audio pipe open failed: {}", error),
                ),
            )
        })?;
    audio_pipe
        .write_all(&(header_bytes.len() as u32).to_le_bytes())
        .and_then(|_| audio_pipe.write_all(&header_bytes))
        .and_then(|_| audio_pipe.write_all(&bytes))
        .and_then(|_| audio_pipe.flush())
        .map_err(|error| {
            close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), translation_write_error_for_owner(
                physical_owner.as_ref(), &bridge_state.snapshot(), format!("Bridge audio pipe write failed: {}", error),
            ))
        })?;
    let mut ack_size = [0_u8; 4];
    audio_pipe
        .read_exact(&mut ack_size)
        .map_err(|error| {
            close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), translation_write_error_for_owner(
                physical_owner.as_ref(), &bridge_state.snapshot(), format!("Bridge audio pipe ack size read failed: {}", error),
            ))
        })?;
    let mut ack_bytes = vec![0_u8; u32::from_le_bytes(ack_size) as usize];
    audio_pipe
        .read_exact(&mut ack_bytes)
        .map_err(|error| {
            close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), translation_write_error_for_owner(
                physical_owner.as_ref(), &bridge_state.snapshot(), format!("Bridge audio pipe ack read failed: {}", error),
            ))
        })?;
    let ack: BridgeTranslationFrameAck = serde_json::from_slice(&ack_bytes).map_err(|error| {
        close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), error.to_string())
    })?;

    let accepted_result = accepted_translation_frames_for_header(&header, &ack);

    {
        let current = bridge_state.snapshot();
        if translation_sink_owner_changed(&frame_owner, &current) {
            return Err(close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), translation_write_error_for_owner(
                Some(&frame_owner),
                &current,
                "translation acknowledgement arrived after the Bridge owner changed".to_string(),
            )));
        }
    }

    if let Some(error_code) = ack.error_code.as_deref() {
        if error_code == "bridge.session-mismatch" {
            if let Some(expected_owner) = physical_owner.as_ref() {
                return Err(close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), translation_generation_ended_error(
                    expected_owner,
                    &bridge_state.snapshot(),
                    accepted_result.unwrap_err(),
                )));
            }
        }
        bridge_state.update_snapshot(|current| {
            current.last_error_code = Some(error_code.to_string());
            reconcile_bridge_snapshot(current);
        });
        return accepted_result.map_err(|error| {
            close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), error)
        });
    }
    let accepted_frames = accepted_result.map_err(|error| {
        close_failed_translation_cue(app, cue_id, physical_owner.as_ref(), error)
    })?;
    if stream_state == Some(TranslationStreamState::Start) {
        let owner = expected_owner
            .map(BridgeTranslationSinkOwner::evidence)
            .unwrap_or_else(|| "sessionId=- bridgeInstanceId=-".to_string());
        log_info!(
            app,
            "bridge",
            "event=translation_stream_first_write_accepted",
            format!(
                "cueId={cue_id} requestId={request_id} {owner} acceptedFrames={accepted_frames}"
            )
        );
    }
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
    let request_id = format!("bridge-source-flush-{}", now_unix_ms());
    let event = write_command_once_quiet(
        &snapshot.pipe_path,
        &DriverBridgeCommand::SourceFlush(BridgeSourceFlushRequest {
            request_id: request_id.clone(),
        }),
    )?;
    match event {
        DriverBridgeEvent::StateSnapshot(state)
            if state.request_id == request_id
                && !state.source_subscriber_active
                && state.source_pending_bytes == 0
                && state.source_pacer_queued_frames == 0
                && state.monitor_source_queued_frames == 0 => {
            Ok(())
        }
        DriverBridgeEvent::StateSnapshot(state) => Err(format!(
            "bridge.source.flush acknowledgement did not close the source boundary: requestId={} responseRequestId={} subscriberActive={} pendingBytes={} pacerQueuedFrames={} monitorQueuedFrames={}",
            request_id,
            state.request_id,
            state.source_subscriber_active,
            state.source_pending_bytes,
            state.source_pacer_queued_frames,
            state.monitor_source_queued_frames,
        )),
        DriverBridgeEvent::Error(error) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Bridge Service returned an unexpected source flush response".to_string()),
    }
}
