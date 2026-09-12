use super::*;

pub(super) struct ConnectedLiveTranslateProbe {
    pub(super) socket: ProviderWebSocket,
    pub(super) plan: plan::PreparedLiveTranslateProbePlan,
    pub(super) started: Instant,
    pub(super) websocket_timeout: Duration,
    pub(super) first_event_deadline: Instant,
    pub(super) last_monotonic_ms: u64,
    pub(super) evidence: ProviderProbeWireEvidence,
    pub(super) result: ProviderSmokeResult,
}

pub(super) fn connect_livetranslate_probe(
    context: &ProviderCallContext<'_>,
    plan: plan::PreparedLiveTranslateProbePlan,
) -> Result<Result<ConnectedLiveTranslateProbe, ProviderSmokeResult>, ProviderRuntimeError> {
    let provider = context.provider;
    let started = Instant::now();
    let websocket_timeout = resolve_websocket_timeout(provider.timeout_ms);
    let first_event_deadline = started
        .checked_add(websocket_timeout)
        .unwrap_or_else(Instant::now);
    let mut last_monotonic_ms = 0_u64;
    let mut evidence = ProviderProbeWireEvidence {
        evidence_outcome: "incomplete-livetranslate-lifecycle".to_string(),
        first_server_event: None,
        provider_input_mode: "none".to_string(),
        response_mode: "text-only".to_string(),
        provider_invocation_count: 1,
        connection_count: 0,
        external_audio_samples: 0,
        input_audio_buffer_commit_count: 0,
        conversation_item_create_input_text_count: 0,
        response_create_count: 0,
        session_authority: None,
        provider_error_frame: None,
        websocket_close: None,
        timeout_phase: None,
        timeout_budget_ms: None,
        trace: Vec::new(),
    };
    let mut result = new_streaming_smoke_result(
        context,
        "websocket",
        format!(
            "{} LiveTranslate Realtime WebSocket 会话已建立。",
            provider.display_name
        ),
    );
    result.connection_attempts = 1;
    result.connection_count = 0;
    result.connection_opened = false;
    result.connection_closed = false;
    let (socket, _) = match WebSocketTransport::default()
        .connect_provider_before(provider, "native_translate", first_event_deadline)
    {
        Ok(connected) => connected,
        Err(error) => {
            result.connection_opened = false;
            result.connection_closed = false;
            let request_authority = provider_websocket_request_authority(provider)
                .unwrap_or_else(|_| json!({"authority": "unavailable"}));
            let terminal_payload = redacted_provider_payload(&json!({
                "request": request_authority,
                "errorCode": error.code.clone(),
            }));
            let terminal_sha256 = sha256_text(&terminal_payload);
            if matches!(
                error.code.as_str(),
                "transport.connect-timeout" | "transport.upgrade-timeout"
            ) {
                let (phase, event_type) = if error.code == "transport.connect-timeout" {
                    ("connect", "connect.timeout")
                } else {
                    ("websocket-upgrade", "websocket.upgrade.timeout")
                };
                record_livetranslate_timeout(
                    &mut evidence,
                    &started,
                    &mut last_monotonic_ms,
                    phase,
                    0,
                    websocket_timeout,
                    event_type,
                );
                if let Some(entry) = evidence.trace.last_mut() {
                    entry.raw_redacted_payload = Some(terminal_payload);
                    entry.sha256 = Some(terminal_sha256);
                }
            } else {
                let outcome = if error.code == "transport.upgrade-failed" {
                    "transport-upgrade-error"
                } else {
                    "transport-connect-error"
                };
                let event_type = if error.code == "transport.upgrade-failed" {
                    "websocket.upgrade.error"
                } else {
                    "connect.error"
                };
                evidence.evidence_outcome = outcome.to_string();
                record_wire_trace(
                    &mut evidence,
                    &started,
                    &mut last_monotonic_ms,
                    "local",
                    event_type,
                    |entry| {
                        entry.raw_redacted_payload = Some(terminal_payload);
                        entry.sha256 = Some(terminal_sha256);
                    },
                );
            }
            return Ok(Err(failed_livetranslate_result(result, evidence, error)));
        }
    };
    result.connection_count = 1;
    result.connection_opened = true;
    evidence.connection_count = 1;
    record_wire_trace(
        &mut evidence,
        &started,
        &mut last_monotonic_ms,
        "transport",
        "websocket.upgrade",
        |entry| {
            entry.status = Some(101);
            let payload = redacted_provider_payload(
                &provider_websocket_request_authority(provider)
                    .unwrap_or_else(|_| json!({"authority": "unavailable"})),
            );
            entry.sha256 = Some(sha256_text(&payload));
            entry.raw_redacted_payload = Some(payload);
        },
    );
    Ok(Ok(ConnectedLiveTranslateProbe {
        socket,
        plan,
        started,
        websocket_timeout,
        first_event_deadline,
        last_monotonic_ms,
        evidence,
        result,
    }))
}

pub(super) fn read_livetranslate_frame_before(
    socket: &mut ProviderWebSocket,
    deadline: Instant,
    phase_timeout: Duration,
    parse_error_context: &str,
) -> Result<WebSocketFrame, ProviderRuntimeError> {
    let remaining = remaining_before(deadline, "DashScope LiveTranslate 响应")?;
    let read_timeout = remaining.min(phase_timeout);
    apply_websocket_timeouts(socket, read_timeout)?;
    read_json_frame(socket, read_timeout, parse_error_context)
}

fn provider_websocket_request_authority(
    provider: &ProviderDraftInput,
) -> Result<Value, ProviderRuntimeError> {
    let url = to_websocket_url(&provider.base_url, &provider.model)?;
    let mut header_names = Vec::new();
    let auth_header = provider.auth_ref.header_name.trim();
    if !auth_header.is_empty() {
        header_names.push(auth_header.to_ascii_lowercase());
    }
    header_names.extend(
        provider
            .custom_headers
            .iter()
            .filter(|header| header.enabled && !header.name.trim().is_empty())
            .map(|header| header.name.trim().to_ascii_lowercase()),
    );
    header_names.sort();
    header_names.dedup();
    Ok(json!({
        "scheme": url.scheme(),
        "host": url.host_str(),
        "path": url.path(),
        "query": { "model": provider.model },
        "requestHeaderNames": header_names,
    }))
}
