use super::*;

#[derive(Debug, PartialEq)]
pub(super) enum BridgeSourceEnvelope {
    Frame {
        payload: Vec<u8>,
        identity: BridgeSourceFrameIdentity,
    },
    Heartbeat(BridgeSourceFrameIdentity),
    RouteError {
        code: String,
        message: String,
    },
    TranslationStatus {
        status_id: String,
        session_id: String,
        bridge_instance_id: String,
        source_generation: u64,
        source_generation_token: String,
        playback_owner_generation: u64,
        physical_playback_device_id: String,
        cue_id: String,
        status: String,
        reason: String,
        error_code: Option<String>,
        timestamp_ms: u64,
    },
    Ignored(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum BridgeSourceIdentityDisposition {
    Current,
    Rebind,
    Reject(String),
}

pub(super) fn bridge_source_identity_disposition(
    current: &crate::bridge::contracts::BridgeRuntimeSnapshot,
    identity: &BridgeSourceFrameIdentity,
) -> BridgeSourceIdentityDisposition {
    if current.bridge_process_id != Some(identity.bridge_process_id) {
        return BridgeSourceIdentityDisposition::Reject(format!(
            "bridge-process-mismatch expected={} actual={}",
            current
                .bridge_process_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string()),
            identity.bridge_process_id,
        ));
    }
    if current.bridge_instance_id.as_deref() != Some(identity.bridge_instance_id.as_str()) {
        return BridgeSourceIdentityDisposition::Reject(format!(
            "bridge-instance-mismatch expected={} actual={}",
            current.bridge_instance_id.as_deref().unwrap_or("none"),
            identity.bridge_instance_id,
        ));
    }
    if current.session_id.as_deref() != Some(identity.session_id.as_str()) {
        return BridgeSourceIdentityDisposition::Reject(format!(
            "bridge-session-mismatch expected={} actual={}",
            current.session_id.as_deref().unwrap_or("none"),
            identity.session_id,
        ));
    }
    // A controlled restart revokes the whole producer incarnation by clearing
    // its token before terminating the sidecar. The same process can reconnect
    // its source pipe and mint a higher generation, so generation monotonicity
    // alone must never restore an explicitly revoked incarnation.
    if current.source_generation_token.is_none() {
        return BridgeSourceIdentityDisposition::Reject(
            "bridge-source-incarnation-revoked".to_string(),
        );
    }
    let expected_token = format!(
        "{}:{}:{}",
        identity.bridge_instance_id, identity.session_id, identity.source_generation
    );
    if identity.source_generation_token != expected_token {
        return BridgeSourceIdentityDisposition::Reject(
            "source-generation-token-invalid".to_string(),
        );
    }
    if identity.source_generation < current.source_generation {
        return BridgeSourceIdentityDisposition::Reject(format!(
            "stale-source-generation expectedAtLeast={} actual={}",
            current.source_generation, identity.source_generation,
        ));
    }
    if identity.source_generation == current.source_generation {
        return if current.source_generation_token.as_deref()
            == Some(identity.source_generation_token.as_str())
        {
            BridgeSourceIdentityDisposition::Current
        } else {
            BridgeSourceIdentityDisposition::Reject(
                "source-generation-token-mismatch".to_string(),
            )
        };
    }
    BridgeSourceIdentityDisposition::Rebind
}

/// Applies evidence carried by an accepted source envelope to the cached
/// runtime snapshot. Query snapshots can briefly lag the source pipe during a
/// subscription handoff; a frame from the authoritative generation proves that
/// the subscriber is active and that PCM delivery has progressed.
pub(super) fn apply_bridge_source_identity_observation(
    current: &mut crate::bridge::contracts::BridgeRuntimeSnapshot,
    identity: &BridgeSourceFrameIdentity,
    disposition: &BridgeSourceIdentityDisposition,
    is_pcm_frame: bool,
) -> bool {
    if matches!(disposition, BridgeSourceIdentityDisposition::Reject(_)) {
        return false;
    }
    if *disposition == BridgeSourceIdentityDisposition::Rebind {
        current.source_generation = identity.source_generation;
        current.source_generation_token = Some(identity.source_generation_token.clone());
    }
    current.source_subscriber_active = true;
    if is_pcm_frame {
        current.source_worker_phase = "source-frame-delivered".to_string();
        current.source_worker_last_progress_timestamp_ms = Some(
            current
                .source_worker_last_progress_timestamp_ms
                .unwrap_or_default()
                .max(identity.read_timestamp_ms),
        );
        current.last_frame_timestamp_ms = Some(
            current
                .last_frame_timestamp_ms
                .unwrap_or_default()
                .max(identity.frame_timestamp_ms),
        );
    }
    true
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BridgeTranslationStatusDisposition {
    Apply,
    DuplicateReplay,
    SessionMismatch,
}

impl BridgeTranslationStatusDisposition {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::DuplicateReplay => "duplicate-replay",
            Self::SessionMismatch => "session-mismatch",
        }
    }
}

#[cfg(test)]
pub(super) fn bridge_translation_status_disposition(
    store: &AudioStateStore,
    active_session_id: Option<&str>,
    status_id: &str,
    event_session_id: &str,
) -> BridgeTranslationStatusDisposition {
    if !store.accept_bridge_translation_status_once(status_id) {
        return BridgeTranslationStatusDisposition::DuplicateReplay;
    }
    if active_session_id != Some(event_session_id) {
        return BridgeTranslationStatusDisposition::SessionMismatch;
    }
    BridgeTranslationStatusDisposition::Apply
}

pub(super) fn bridge_translation_status_disposition_for_authority(
    store: &AudioStateStore,
    status_id: &str,
    authority_matches: bool,
) -> BridgeTranslationStatusDisposition {
    if !authority_matches {
        return BridgeTranslationStatusDisposition::SessionMismatch;
    }
    if !store.accept_bridge_translation_status_once(status_id) {
        return BridgeTranslationStatusDisposition::DuplicateReplay;
    }
    BridgeTranslationStatusDisposition::Apply
}

pub(super) fn bridge_source_route_error(code: &str, message: &str) -> String {
    let recommended_action = if code == "bridge.process-loopback-unsupported" {
        "open-diagnostics"
    } else {
        "restart-bridge"
    };
    format!(
        "Bridge source route failed: {message} | code: {code} | recommended: {recommended_action}"
    )
}

pub(super) fn record_bridge_translation_status(
    app: &AppHandle,
    store: &AudioStateStore,
    status_id: &str,
    cue_id: &str,
    status: &str,
    reason: &str,
    error_code: Option<&str>,
    timestamp_ms: u64,
) {
    let detail = format!(
        "statusId={status_id} cueId={cue_id} status={status} reason={reason} errorCode={} timestampMs={timestamp_ms}",
        error_code.unwrap_or("-"),
    );
    let level = if status == "route-failed" {
        "error"
    } else if status == "stale-dropped" {
        "warning"
    } else {
        "info"
    };
    let _ = diag_log_detail(
        app,
        "bridge",
        level,
        "event=translation_playback_status",
        detail.clone(),
    );

    if status == "route-failed" {
        let stable_code = error_code.unwrap_or("bridge.translation-playback-failed");
        store.watch_session_report.record_session_issue(
            "output",
            "bridge-translation-playback-failed",
            "error",
            &detail,
        );
        let bridge_state = app.state::<BridgeStateStore>();
        bridge_state.update_snapshot(|snapshot| {
            snapshot.last_error_code = Some(stable_code.to_string());
            snapshot.monitor_playback_state = "blocked".to_string();
            crate::bridge::contracts::reconcile_bridge_snapshot(snapshot);
        });
        if let Some(runtime_state) = app.try_state::<RuntimeStateStore>() {
            let _ = emit_runtime_notification(
                app,
                &runtime_state,
                crate::runtime::contracts::RuntimeNotification::error(
                    &format!("bridge-translation-playback-failed-{cue_id}"),
                    "bridge-runtime",
                    &format!("译音播放失败（{cue_id}）：{reason} [{stable_code}]"),
                    ms_marker(unix_ms()),
                ),
            );
        }
    } else if status == "stale-dropped" {
        store.watch_session_report.record_session_issue(
            "output",
            "bridge-translation-stale-dropped",
            "warning",
            &detail,
        );
    }
}

pub(super) fn write_bridge_translation_status_ack(
    source_pipe: &mut impl Write,
    status_id: &str,
    authority: &crate::audio::state::TranslationPlaybackAuthority,
) -> Result<(), String> {
    let ack = omni_bridge_protocol::TranslationPlaybackStatusAck {
        event_type: "bridge.translation.status.ack".to_string(),
        status_id: status_id.to_string(),
        session_id: authority.session_id.clone(),
        bridge_instance_id: authority.bridge_instance_id.clone(),
        source_generation: authority.source_generation,
        source_generation_token: authority.source_generation_token.clone(),
        playback_owner_generation: authority.playback_owner_generation,
        physical_playback_device_id: authority.physical_playback_device_id.clone(),
    };
    let header = serde_json::to_vec(&ack).map_err_str()?;
    source_pipe
        .write_all(&(header.len() as u32).to_le_bytes())
        .map_err(|error| format!("Bridge translation status ack size write failed: {error}"))?;
    source_pipe
        .write_all(&header)
        .map_err(|error| format!("Bridge translation status ack write failed: {error}"))?;
    source_pipe
        .flush()
        .map_err(|error| format!("Bridge translation status ack flush failed: {error}"))
}

pub(super) fn read_bridge_source_payload(
    source_pipe: &mut impl Read,
) -> Result<BridgeSourceEnvelope, String> {
    let mut header_size = [0_u8; 4];
    source_pipe
        .read_exact(&mut header_size)
        .map_err(|error| format!("Bridge source header size read failed: {error}"))?;
    let header_size = u32::from_le_bytes(header_size) as usize;
    if header_size == 0 || header_size > 64 * 1024 {
        return Err("Bridge source header size is invalid.".to_string());
    }
    let mut header_bytes = vec![0_u8; header_size];
    source_pipe
        .read_exact(&mut header_bytes)
        .map_err(|error| format!("Bridge source header read failed: {error}"))?;
    let header_value: Value = serde_json::from_slice(&header_bytes).map_err_str()?;
    if header_value["type"].as_str() == Some("bridge.translation.status") {
        let status: omni_bridge_protocol::TranslationPlaybackStatusEvent =
            serde_json::from_value(header_value).map_err_str()?;
        if status.status_id.trim().is_empty() {
            return Err("Bridge translation status envelope is missing statusId.".to_string());
        }
        return Ok(BridgeSourceEnvelope::TranslationStatus {
            status_id: status.status_id,
            session_id: status.session_id,
            bridge_instance_id: status.bridge_instance_id,
            source_generation: status.source_generation,
            source_generation_token: status.source_generation_token,
            playback_owner_generation: status.playback_owner_generation,
            physical_playback_device_id: status.physical_playback_device_id,
            cue_id: status.cue_id,
            status: status.playback_status.as_str().to_string(),
            reason: status.reason,
            error_code: status.error_code,
            timestamp_ms: status.timestamp_ms,
        });
    }
    let header: BridgeTranslationFrameHeader =
        serde_json::from_value(header_value.clone()).map_err_str()?;
    let mut payload = vec![0_u8; header.payload_bytes];
    source_pipe
        .read_exact(&mut payload)
        .map_err(|error| format!("Bridge source payload read failed: {error}"))?;
    let source_identity = || -> Result<BridgeSourceFrameIdentity, String> {
        let bridge_process_id = header.bridge_process_id.ok_or_else(|| {
            "Bridge source envelope is missing bridgeProcessId.".to_string()
        })?;
        let bridge_instance_id = header
            .bridge_instance_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Bridge source envelope is missing bridgeInstanceId.".to_string())?;
        let source_generation = header.source_generation.ok_or_else(|| {
            "Bridge source envelope is missing sourceGeneration.".to_string()
        })?;
        let source_generation_token = header
            .source_generation_token
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "Bridge source envelope is missing sourceGenerationToken.".to_string()
            })?;
        if header.session_id.trim().is_empty() {
            return Err("Bridge source envelope is missing sessionId.".to_string());
        }
        Ok(BridgeSourceFrameIdentity {
            bridge_process_id,
            bridge_instance_id,
            session_id: header.session_id.clone(),
            source_generation,
            source_generation_token,
            frame_timestamp_ms: header.timestamp_ms,
            read_timestamp_ms: unix_ms(),
        })
    };
    if header.event_type == "bridge.source.heartbeat" {
        return Ok(BridgeSourceEnvelope::Heartbeat(source_identity()?));
    }
    if header.event_type == "bridge.source.error" {
        let code = header_value["errorCode"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Bridge source error envelope is missing errorCode.".to_string())?;
        let message = header_value["message"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Bridge source route failed without diagnostic detail.");
        return Ok(BridgeSourceEnvelope::RouteError {
            code: code.to_string(),
            message: message.to_string(),
        });
    }
    if header.event_type != "bridge.source.frame" {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=unexpected-event-type eventType={}",
            header.event_type
        )));
    }
    if header.sample_rate_hz != SAMPLE_RATE_HZ as u32 {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=sample-rate-mismatch actual={} expected={}",
            header.sample_rate_hz, SAMPLE_RATE_HZ
        )));
    }
    if header.channel_count != CHANNEL_COUNT as u16 {
        return Ok(BridgeSourceEnvelope::Ignored(format!(
            "reason=channel-count-mismatch actual={} expected={}",
            header.channel_count, CHANNEL_COUNT
        )));
    }
    Ok(BridgeSourceEnvelope::Frame {
        payload,
        identity: source_identity()?,
    })
}
