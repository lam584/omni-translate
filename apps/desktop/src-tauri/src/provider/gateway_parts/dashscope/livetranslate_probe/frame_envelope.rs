use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn admit_livetranslate_frame_envelope(
    value: &Value,
    state: LiveTranslateProbeState,
    started: &Instant,
    last_monotonic_ms: &mut u64,
    evidence: &mut ProviderProbeWireEvidence,
    result: &mut ProviderSmokeResult,
    server_event_ids: &mut HashSet<String>,
) -> Result<String, ProviderRuntimeError> {
    let event_type =
        crate::audio::realtime_ws::server_event_type(value, "unknown").to_string();
    let raw_error_payload =
        (event_type == "error").then(|| sanitized_provider_error_payload(value));
    let raw_error_sha256 = raw_error_payload
        .as_ref()
        .map(|payload| sha256_text(payload));
    let monotonic_ms = record_wire_trace(
        evidence,
        started,
        last_monotonic_ms,
        "server-to-client",
        &event_type,
        |entry| {
            entry.raw_redacted_payload.clone_from(&raw_error_payload);
            entry.sha256.clone_from(&raw_error_sha256);
        },
    );
    if evidence.first_server_event.is_none() {
        evidence.first_server_event = Some(ProviderFirstServerEventEvidence {
            event_type: event_type.clone(),
            monotonic_ms,
        });
        result.first_event_latency_ms = Some(monotonic_ms);
    }
    result.stream_observed = true;

    if matches!(
        event_type.as_str(),
        "session.created" | "session.updated" | "session.finished"
    ) {
        if let Err(error) =
            validate_livetranslate_server_event_id(value, &event_type, server_event_ids)
        {
            evidence.evidence_outcome = "invalid-livetranslate-server-event-id".to_string();
            attach_trace_payload(evidence, sanitized_livetranslate_server_frame(value));
            return Err(error);
        }
    }

    if event_type == "error" {
        let raw_redacted_payload = raw_error_payload.unwrap_or_else(|| "{}".to_string());
        let provider_code = provider_error_code(value);
        evidence.evidence_outcome = "provider-error-frame".to_string();
        evidence.provider_error_frame = Some(ProviderErrorFrameEvidence {
            event_type,
            provider_code: provider_code.clone(),
            sha256: format!("{:x}", Sha256::digest(raw_redacted_payload.as_bytes())),
            raw_redacted_payload,
            monotonic_ms,
        });
        return Err(
            ProviderRuntimeError::new(
                "upstream.error",
                "DashScope LiveTranslate returned an error frame.",
            )
            .with_provider_code(provider_code),
        );
    }

    if state == LiveTranslateProbeState::AwaitSessionCreated && monotonic_ms > 12_000 {
        evidence.evidence_outcome = "first-server-event-late".to_string();
        return Err(ProviderRuntimeError::new(
            "timeout",
            format!(
                "DashScope LiveTranslate first server event arrived after {}ms",
                monotonic_ms
            ),
        ));
    }

    Ok(event_type)
}
