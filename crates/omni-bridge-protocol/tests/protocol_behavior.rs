use omni_bridge_protocol::{
    accepted_audio_frame_ack, audio_pipe_path, control_pipe_path, decode_pcm16le,
    encode_pcm16le, rejected_audio_frame_ack, source_pipe_path, translation_header_fixture,
    AudioFrameHeader, AudioRouteDirection, CaptureBackend, MixControl, ProcessLoopbackStatus,
    SourceCaptureMode, TranslationAudioSink, TranslationPlaybackStatusAck,
    TranslationPlaybackStatusEvent, TranslationPlaybackStatusKind, TranslationStreamState,
    DEFAULT_PIPE_NAME,
};

#[test]
fn public_capture_contract_keeps_stable_wire_values_and_defaults() {
    assert_eq!(SourceCaptureMode::default(), SourceCaptureMode::None);
    assert_eq!(CaptureBackend::default(), CaptureBackend::None);
    assert_eq!(ProcessLoopbackStatus::default(), ProcessLoopbackStatus::Unknown);
    assert_eq!(
        [
            SourceCaptureMode::None.as_str(),
            SourceCaptureMode::VirtualDriver.as_str(),
            SourceCaptureMode::ProcessExclusion.as_str(),
        ],
        ["none", "virtual-driver", "process-exclusion"]
    );
    assert_eq!(
        [
            CaptureBackend::None.as_str(),
            CaptureBackend::DriverVirtualSpeaker.as_str(),
            CaptureBackend::WasapiProcessExclusion.as_str(),
        ],
        ["none", "driver-virtual-speaker", "wasapi-process-exclusion"]
    );
    assert_eq!(
        [
            ProcessLoopbackStatus::Unknown.as_str(),
            ProcessLoopbackStatus::Probing.as_str(),
            ProcessLoopbackStatus::Ready.as_str(),
            ProcessLoopbackStatus::Unsupported.as_str(),
            ProcessLoopbackStatus::Failed.as_str(),
        ],
        ["unknown", "probing", "ready", "unsupported", "failed"]
    );
    assert_eq!(
        serde_json::to_value(SourceCaptureMode::ProcessExclusion).unwrap(),
        "process-exclusion"
    );
    assert_eq!(
        serde_json::from_value::<CaptureBackend>(serde_json::json!(
            "wasapi-process-exclusion"
        ))
        .unwrap(),
        CaptureBackend::WasapiProcessExclusion
    );

    let mix = MixControl::default();
    assert!(mix.keep_original_audio);
    assert!(mix.translated_audio_enabled);
    assert_eq!(mix.translated_audio_gain_db, 0.0);
    assert!(mix.translated_audio_auto_gain_enabled);
    assert_eq!(mix.original_audio_gain_db, 0.0);
    assert!(mix.ducking_enabled);
    assert_eq!(mix.ducking_depth_percent, 35);
    assert_eq!(mix.monitor_mode, "original-and-translated");

    let legacy_mix: MixControl = serde_json::from_value(serde_json::json!({
        "keepOriginalAudio": true,
        "translatedAudioEnabled": true,
        "translatedAudioGainDb": 0.0,
        "originalAudioGainDb": 0.0,
        "duckingEnabled": true,
        "duckingDepthPercent": 35,
        "monitorMode": "original-and-translated"
    }))
    .unwrap();
    assert!(legacy_mix.translated_audio_auto_gain_enabled);
}

#[test]
fn public_translation_route_and_stream_states_keep_stable_wire_values() {
    assert_eq!(
        [
            TranslationAudioSink::PhysicalPlayback.as_str(),
            TranslationAudioSink::VirtualMic.as_str(),
        ],
        ["physical-playback", "virtual-mic"]
    );
    assert_eq!(
        [
            AudioRouteDirection::Inbound.as_str(),
            AudioRouteDirection::Outbound.as_str(),
        ],
        ["inbound", "outbound"]
    );
    assert_eq!(
        [
            TranslationStreamState::Start.as_str(),
            TranslationStreamState::Chunk.as_str(),
            TranslationStreamState::End.as_str(),
            TranslationStreamState::Abort.as_str(),
        ],
        ["start", "chunk", "end", "abort"]
    );

    for (state, wire_value) in [
        (TranslationStreamState::Start, "start"),
        (TranslationStreamState::Chunk, "chunk"),
        (TranslationStreamState::End, "end"),
        (TranslationStreamState::Abort, "abort"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), wire_value);
        assert_eq!(
            serde_json::from_value::<TranslationStreamState>(serde_json::json!(wire_value))
                .unwrap(),
            state
        );
    }
}

#[test]
fn public_translation_contract_round_trips_cue_timing_and_terminal_status() {
    let mut header = translation_header_fixture();
    header.cue_id = Some("cue-subtitle-42".to_string());
    header.created_at_ms = Some(1_750_000_000_123);
    header.estimated_duration_ms = Some(2_750);
    header.translated_audio_enhancement_applied = true;

    let wire = serde_json::to_value(&header).unwrap();
    assert_eq!(wire["cueId"], "cue-subtitle-42");
    assert_eq!(wire["createdAtMs"], 1_750_000_000_123_u64);
    assert_eq!(wire["estimatedDurationMs"], 2_750_u64);
    let decoded: AudioFrameHeader = serde_json::from_value(wire).unwrap();
    assert_eq!(decoded.cue_id, header.cue_id);
    assert_eq!(decoded.created_at_ms, header.created_at_ms);
    assert_eq!(decoded.estimated_duration_ms, header.estimated_duration_ms);
    assert!(decoded.translated_audio_enhancement_applied);

    let lifecycle = [
        TranslationPlaybackStatusKind::Queued,
        TranslationPlaybackStatusKind::Started,
        TranslationPlaybackStatusKind::Completed,
        TranslationPlaybackStatusKind::StaleDropped,
        TranslationPlaybackStatusKind::RouteFailed,
    ];
    assert_eq!(
        lifecycle.map(TranslationPlaybackStatusKind::as_str),
        ["queued", "started", "completed", "stale-dropped", "route-failed"]
    );
    assert_eq!(
        lifecycle.map(TranslationPlaybackStatusKind::is_terminal),
        [false, false, true, true, true]
    );

    let status = TranslationPlaybackStatusEvent {
        event_type: "bridge.translation.status".to_string(),
        status_id: "bridge-status-public-42".to_string(),
        request_id: "status-42".to_string(),
        session_id: "session-42".to_string(),
        bridge_instance_id: "bridge-instance-42".to_string(),
        source_generation: 42,
        source_generation_token: "bridge-instance-42:session-42:42".to_string(),
        playback_owner_generation: 84,
        physical_playback_device_id: "physical-endpoint-42".to_string(),
        cue_id: "cue-subtitle-42".to_string(),
        playback_status: TranslationPlaybackStatusKind::RouteFailed,
        reason: "queue-overflow".to_string(),
        error_code: Some("bridge.queue-overflow".to_string()),
        timestamp_ms: 1_750_000_000_999,
    };
    let status_wire = serde_json::to_value(&status).unwrap();
    assert_eq!(status_wire["playbackStatus"], "route-failed");
    assert_eq!(status_wire["statusId"], "bridge-status-public-42");
    assert_eq!(status_wire["errorCode"], "bridge.queue-overflow");
    let decoded_status: TranslationPlaybackStatusEvent =
        serde_json::from_value(status_wire).unwrap();
    assert_eq!(
        decoded_status.playback_status,
        TranslationPlaybackStatusKind::RouteFailed
    );
    assert_eq!(decoded_status.cue_id, "cue-subtitle-42");

    let status_ack = TranslationPlaybackStatusAck {
        event_type: "bridge.translation.status.ack".to_string(),
        status_id: decoded_status.status_id.clone(),
        session_id: decoded_status.session_id.clone(),
        bridge_instance_id: decoded_status.bridge_instance_id.clone(),
        source_generation: decoded_status.source_generation,
        source_generation_token: decoded_status.source_generation_token.clone(),
        playback_owner_generation: decoded_status.playback_owner_generation,
        physical_playback_device_id: decoded_status.physical_playback_device_id.clone(),
    };
    let ack_wire = serde_json::to_value(&status_ack).unwrap();
    assert_eq!(ack_wire["type"], "bridge.translation.status.ack");
    assert_eq!(ack_wire["statusId"], "bridge-status-public-42");
    assert_eq!(
        serde_json::from_value::<TranslationPlaybackStatusAck>(ack_wire).unwrap(),
        status_ack
    );
}

#[test]
fn public_frame_helpers_preserve_payload_identity_and_typed_nacks() {
    assert_eq!(
        control_pipe_path(DEFAULT_PIPE_NAME),
        r"\\.\pipe\omni-bridge-ipc"
    );
    assert_eq!(
        audio_pipe_path(DEFAULT_PIPE_NAME),
        r"\\.\pipe\omni-bridge-ipc-audio"
    );
    assert_eq!(
        source_pipe_path(DEFAULT_PIPE_NAME),
        r"\\.\pipe\omni-bridge-ipc-source"
    );

    let samples = [i16::MIN, -1, 0, 1, i16::MAX];
    let encoded = encode_pcm16le(&samples);
    assert_eq!(decode_pcm16le(&encoded).unwrap(), samples);
    assert_eq!(
        decode_pcm16le(&[0, 1, 2]).unwrap_err(),
        "pcm16le payload must contain an even number of bytes"
    );

    let header = translation_header_fixture();
    let accepted = accepted_audio_frame_ack(&header, 84);
    assert_eq!(accepted.event_type, "bridge.translation.ack");
    assert_eq!(accepted.request_id, header.request_id);
    assert_eq!(accepted.frame_id, header.frame_id);
    assert_eq!(accepted.accepted_frames, header.frame_count);
    assert_eq!(accepted.playback_frames_written, 84);
    assert!(accepted.error_code.is_none());

    let rejected = rejected_audio_frame_ack(
        &header,
        "bridge.queue-overflow",
        "all pending cues are still within the realtime budget",
    );
    assert_eq!(rejected.event_type, "bridge.translation.nack");
    assert_eq!(rejected.accepted_frames, 0);
    assert_eq!(rejected.playback_frames_written, 0);
    assert_eq!(rejected.error_code.as_deref(), Some("bridge.queue-overflow"));
    assert_eq!(
        rejected.message.as_deref(),
        Some("all pending cues are still within the realtime budget")
    );
}
