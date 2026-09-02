use super::*;

#[path = "livetranslate_probe/connection.rs"]
mod connection;
use connection::{
    connect_livetranslate_probe, read_livetranslate_frame_before,
    ConnectedLiveTranslateProbe,
};

#[path = "livetranslate_probe/frame_envelope.rs"]
mod frame_envelope;
use frame_envelope::admit_livetranslate_frame_envelope;

#[path = "livetranslate_probe/plan.rs"]
mod plan;
use plan::{prepare_livetranslate_probe_plan, PreparedLiveTranslateProbePlan};

#[cfg(test)]
#[path = "livetranslate_probe/preconnect_plan_tests.rs"]
mod preconnect_plan_tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveTranslateProbeState {
    AwaitSessionCreated,
    AwaitSessionUpdated,
    AwaitSessionFinished,
}

type ProviderWebSocket = tungstenite::WebSocket<
    tungstenite::stream::MaybeTlsStream<TcpStream>,
>;

const MAX_PROVIDER_CODE_CHARS: usize = 128;
const MAX_PROVIDER_ERROR_MESSAGE_CHARS: usize = 512;
const MAX_PROVIDER_ERROR_PAYLOAD_CHARS: usize = 2_048;
const MAX_WEBSOCKET_CLOSE_REASON_CHARS: usize = 96;

pub(super) fn execute_livetranslate_session_probe(
    context: &ProviderCallContext<'_>,
) -> Result<ProviderSmokeResult, ProviderRuntimeError> {
    let provider = context.provider;
    let plan = prepare_livetranslate_probe_plan(context)?;
    let connected = match connect_livetranslate_probe(context, plan)? {
        Ok(connected) => connected,
        Err(failed) => return Ok(failed),
    };
    let ConnectedLiveTranslateProbe {
        mut socket,
        plan,
        started,
        websocket_timeout,
        first_event_deadline,
        mut last_monotonic_ms,
        mut evidence,
        mut result,
    } = connected;
    let PreparedLiveTranslateProbePlan {
        session_update,
        session_finish,
        requested_config,
        mut protocol_authority,
        mut protocol_state,
    } = plan;
    let mut state = LiveTranslateProbeState::AwaitSessionCreated;
    let mut session_finish = Some(session_finish);
    let mut response_completion_deadline = None;
    let mut response_completion_started_monotonic_ms = None;
    let mut session_id = None::<String>;
    let mut server_event_ids = HashSet::new();

    loop {
        let deadline = if state == LiveTranslateProbeState::AwaitSessionCreated {
            first_event_deadline
        } else {
            response_completion_deadline.unwrap_or(first_event_deadline)
        };
        let frame = match read_livetranslate_frame_before(
            &mut socket,
            deadline,
            websocket_timeout,
            "无法解析 DashScope LiveTranslate WebSocket 响应",
        ) {
            Ok(frame) => frame,
            Err(error) => {
                if error.code == "timeout" {
                    if Instant::now() < deadline {
                        // Socket timers can fire just before their requested
                        // duration on some Windows stacks. Re-arm only for the
                        // remaining absolute budget; never move the deadline.
                        continue;
                    }
                    let phase = if state == LiveTranslateProbeState::AwaitSessionCreated {
                        "read-first-event"
                    } else {
                        "response-completion"
                    };
                    record_livetranslate_timeout(
                        &mut evidence,
                        &started,
                        &mut last_monotonic_ms,
                        phase,
                        if phase == "read-first-event" {
                            0
                        } else {
                            response_completion_started_monotonic_ms.unwrap_or(0)
                        },
                        websocket_timeout,
                        "read.timeout",
                    );
                    let timeout_error = ProviderRuntimeError::new(
                        "timeout",
                        format!(
                            "DashScope LiveTranslate timeout phase={phase} after {}ms",
                            evidence.timeout_budget_ms.unwrap_or_default()
                        ),
                    )
                    .retriable(true);
                    return Ok(failed_connected_livetranslate_result(
                        socket,
                        result,
                        evidence,
                        timeout_error,
                    ));
                }
                record_wire_trace(
                    &mut evidence,
                    &started,
                    &mut last_monotonic_ms,
                    "local",
                    "read.error",
                    |_| {},
                );
                return Ok(failed_connected_livetranslate_result(
                    socket, result, evidence, error,
                ));
            }
        };

        match frame {
            WebSocketFrame::Ignored => continue,
            WebSocketFrame::Binary => {
                evidence.evidence_outcome = "invalid-livetranslate-binary-frame".to_string();
                record_wire_trace(
                    &mut evidence,
                    &started,
                    &mut last_monotonic_ms,
                    "server-to-client",
                    "websocket.binary",
                    |_| {},
                );
                let error = ProviderRuntimeError::new(
                    "response.unparseable",
                    "DashScope LiveTranslate zero-input probe received an undocumented binary frame.",
                );
                return Ok(failed_connected_livetranslate_result(
                    socket, result, evidence, error,
                ));
            }
            WebSocketFrame::Closed(close) => {
                let close_reason = sanitize_diagnostic_text(
                    &close.reason,
                    MAX_WEBSOCKET_CLOSE_REASON_CHARS,
                );
                let close_payload = redacted_provider_payload(&json!({
                    "code": close.code,
                    "reason": close_reason,
                    "normal": close.normal,
                }));
                let close_sha256 = sha256_text(&close_payload);
                let monotonic_ms = record_wire_trace(
                    &mut evidence,
                    &started,
                    &mut last_monotonic_ms,
                    "server-to-client",
                    "websocket.close",
                    |entry| {
                        entry.code = Some(close.code);
                        entry.reason = Some(close_reason.clone());
                        entry.normal = Some(close.normal);
                        entry.raw_redacted_payload = Some(close_payload);
                        entry.sha256 = Some(close_sha256);
                    },
                );
                evidence.evidence_outcome = if close.normal {
                    "websocket-close-normal".to_string()
                } else {
                    "websocket-close-abnormal".to_string()
                };
                evidence.websocket_close = Some(ProviderWebSocketCloseEvidence {
                    code: close.code,
                    reason: close_reason.clone(),
                    normal: close.normal,
                    monotonic_ms,
                });
                let error = ProviderRuntimeError::new(
                    "transport.closed",
                    format!(
                        "DashScope LiveTranslate WebSocket closed code={} reason={}",
                        close.code, close_reason
                    ),
                );
                return Ok(failed_connected_livetranslate_result(
                    socket, result, evidence, error,
                ));
            }
            WebSocketFrame::Json(value) => {
                let lifecycle = LiveTranslateProbeLifecycle {
                    state,
                    session_finish,
                    response_completion_deadline,
                    response_completion_started_monotonic_ms,
                    session_id,
                    server_event_ids,
                    protocol_authority,
                    protocol_state,
                };
                let (next, outcome) = handle_livetranslate_json_frame(
                    &mut socket,
                    provider,
                    value,
                    &started,
                    &mut last_monotonic_ms,
                    &mut evidence,
                    &mut result,
                    &session_update,
                    &requested_config,
                    websocket_timeout,
                    lifecycle,
                );
                match outcome {
                    JsonFrameOutcome::Continue => {
                        let next = next.expect("continuing LiveTranslate probe retains lifecycle");
                        state = next.state;
                        session_finish = next.session_finish;
                        response_completion_deadline = next.response_completion_deadline;
                        response_completion_started_monotonic_ms =
                            next.response_completion_started_monotonic_ms;
                        session_id = next.session_id;
                        server_event_ids = next.server_event_ids;
                        protocol_authority = next.protocol_authority;
                        protocol_state = next.protocol_state;
                    }
                    JsonFrameOutcome::Completed => {
                        return Ok(completed_connected_livetranslate_result(
                            socket, result, evidence,
                        ));
                    }
                    JsonFrameOutcome::Failed(error) => {
                        return Ok(failed_connected_livetranslate_result(
                            socket, result, evidence, error,
                        ));
                    }
                }
            }
        }
    }
}



struct LiveTranslateProbeLifecycle {
    state: LiveTranslateProbeState,
    session_finish: Option<Value>,
    response_completion_deadline: Option<Instant>,
    response_completion_started_monotonic_ms: Option<u64>,
    session_id: Option<String>,
    server_event_ids: HashSet<String>,
    protocol_authority:
        crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    protocol_state: crate::audio::bailian_protocol::LiveTranslateServerState,
}

enum JsonFrameOutcome {
    Continue,
    Completed,
    Failed(ProviderRuntimeError),
}

#[allow(clippy::too_many_arguments)]
fn handle_livetranslate_json_frame(
    mut socket: &mut ProviderWebSocket,
    provider: &ProviderDraftInput,
    value: Value,
    started: &Instant,
    mut last_monotonic_ms: &mut u64,
    mut evidence: &mut ProviderProbeWireEvidence,
    result: &mut ProviderSmokeResult,
    session_update: &Value,
    requested_config: &Value,
    websocket_timeout: Duration,
    lifecycle: LiveTranslateProbeLifecycle,
) -> (Option<LiveTranslateProbeLifecycle>, JsonFrameOutcome) {
    let LiveTranslateProbeLifecycle {
        mut state,
        mut session_finish,
        mut response_completion_deadline,
        mut response_completion_started_monotonic_ms,
        mut session_id,
        mut server_event_ids,
        protocol_authority,
        mut protocol_state,
    } = lifecycle;
                let event_type = match admit_livetranslate_frame_envelope(
                    &value,
                    state,
                    &started,
                    &mut last_monotonic_ms,
                    &mut evidence,
                    result,
                    &mut server_event_ids,
                ) {
                    Ok(event_type) => event_type,
                    Err(error) => return (None, JsonFrameOutcome::Failed(error)),
                };

                match (state, event_type.as_str()) {
                    (LiveTranslateProbeState::AwaitSessionCreated, "session.created") => {
                        if let Err(error) = protocol_state.admit(&protocol_authority, &value) {
                            evidence.evidence_outcome =
                                "invalid-livetranslate-session-authority".to_string();
                            attach_trace_payload(
                                &mut evidence,
                                invalid_session_authority_summary(&value),
                            );
                            return (
                                None,
                                JsonFrameOutcome::Failed(ProviderRuntimeError::new(
                                    "protocol.identity-invalid",
                                    error,
                                )),
                            );
                        }
                        let (created_session_id, _server_model) = match
                            validate_livetranslate_session_created(&value, &provider.model)
                        {
                            Ok(authority) => authority,
                            Err(error) => {
                                evidence.evidence_outcome =
                                    "invalid-livetranslate-session-authority".to_string();
                                attach_trace_payload(
                                    &mut evidence,
                                    invalid_session_authority_summary(&value),
                                );
                                return (None, JsonFrameOutcome::Failed(error));
                            }
                        };
                        attach_trace_payload(
                            &mut evidence,
                            sanitized_livetranslate_server_frame(&value),
                        );
                        session_id = Some(created_session_id);
                        result.event_log.push(ProviderStreamEventRecord::new(
                            "session.created",
                            "DashScope LiveTranslate session.created 已接收。",
                        ));
                        if let Err(error) = send_json_frame(
                            &mut socket,
                            &session_update,
                            "DashScope LiveTranslate session.update 发送失败",
                        ) {
                            return (None, JsonFrameOutcome::Failed(error));
                        }
                        let outbound = redacted_provider_payload(&session_update);
                        let outbound_sha256 = sha256_text(&outbound);
                        let session_update_monotonic_ms = record_wire_trace(
                            &mut evidence,
                            &started,
                            &mut last_monotonic_ms,
                            "client-to-server",
                            "session.update",
                            |entry| {
                                entry.raw_redacted_payload = Some(outbound);
                                entry.sha256 = Some(outbound_sha256);
                            },
                        );
                        state = LiveTranslateProbeState::AwaitSessionUpdated;
                        response_completion_started_monotonic_ms =
                            Some(session_update_monotonic_ms);
                        response_completion_deadline =
                            Instant::now().checked_add(websocket_timeout);
                    }
                    (LiveTranslateProbeState::AwaitSessionUpdated, "session.updated") => {
                        if let Err(error) = protocol_state.admit(&protocol_authority, &value) {
                            evidence.evidence_outcome =
                                "invalid-livetranslate-session-authority".to_string();
                            attach_trace_payload(
                                &mut evidence,
                                invalid_session_authority_summary(&value),
                            );
                            return (
                                None,
                                JsonFrameOutcome::Failed(ProviderRuntimeError::new(
                                    "protocol.config-mismatch",
                                    error,
                                )),
                            );
                        }
                        let Some(created_session_id) = session_id.as_deref() else {
                            evidence.evidence_outcome =
                                "invalid-livetranslate-session-authority".to_string();
                            let error = ProviderRuntimeError::new(
                                "protocol.identity-invalid",
                                "DashScope LiveTranslate session.created identity was not retained.",
                            );
                            return (None, JsonFrameOutcome::Failed(error));
                        };
                        let updated_config = match validate_livetranslate_session_updated(
                            &value,
                            created_session_id,
                            &provider.model,
                            &requested_config,
                        ) {
                            Ok(config) => config,
                            Err(error) => {
                                evidence.evidence_outcome =
                                    "invalid-livetranslate-session-authority".to_string();
                                attach_trace_payload(
                                    &mut evidence,
                                    invalid_session_authority_summary(&value),
                                );
                                return (None, JsonFrameOutcome::Failed(error));
                            }
                        };
                        let session_id_sha256 = sha256_text(created_session_id);
                        let updated_config_sha256 =
                            sha256_text(&redacted_provider_payload(&updated_config));
                        attach_trace_payload(
                            &mut evidence,
                            sanitized_livetranslate_server_frame(&value),
                        );
                        evidence.session_authority = Some(ProviderSessionAuthorityEvidence {
                            session_identity_sha256: session_id_sha256,
                            server_model: provider.model.clone(),
                            echoed_session_config_sha256: updated_config_sha256,
                        });
                        result.event_log.push(ProviderStreamEventRecord::new(
                            "session.updated",
                            "DashScope LiveTranslate session.updated 已接收。",
                        ));
                        let Some(prepared_session_finish) = session_finish.take() else {
                            let error = ProviderRuntimeError::new(
                                "protocol.invalid",
                                "DashScope LiveTranslate session.finish would be sent more than once.",
                            );
                            return (None, JsonFrameOutcome::Failed(error));
                        };
                        if let Err(error) = protocol_state.record_client_finish() {
                            return (
                                None,
                                JsonFrameOutcome::Failed(ProviderRuntimeError::new(
                                    "protocol.invalid",
                                    error,
                                )),
                            );
                        }
                        if let Err(error) = send_json_frame(
                            &mut socket,
                            &prepared_session_finish,
                            "DashScope LiveTranslate session.finish 发送失败",
                        ) {
                            return (None, JsonFrameOutcome::Failed(error));
                        }
                        let outbound = redacted_provider_payload(&prepared_session_finish);
                        let outbound_sha256 = sha256_text(&outbound);
                        record_wire_trace(
                            &mut evidence,
                            &started,
                            &mut last_monotonic_ms,
                            "client-to-server",
                            "session.finish",
                            |entry| {
                                entry.raw_redacted_payload = Some(outbound);
                                entry.sha256 = Some(outbound_sha256);
                            },
                        );
                        state = LiveTranslateProbeState::AwaitSessionFinished;
                    }
                    (LiveTranslateProbeState::AwaitSessionFinished, "session.finished") => {
                        if session_finish.is_some() {
                            let error = ProviderRuntimeError::new(
                                "protocol.invalid",
                                "DashScope LiveTranslate session.finished arrived before session.finish.",
                            );
                            return (None, JsonFrameOutcome::Failed(error));
                        }
                        if let Err(error) = protocol_state.admit(&protocol_authority, &value) {
                            evidence.evidence_outcome =
                                "invalid-livetranslate-session-authority".to_string();
                            attach_trace_payload(
                                &mut evidence,
                                invalid_session_authority_summary(&value),
                            );
                            return (
                                None,
                                JsonFrameOutcome::Failed(ProviderRuntimeError::new(
                                    "protocol.invalid",
                                    error,
                                )),
                            );
                        }
                        attach_trace_payload(
                            &mut evidence,
                            sanitized_livetranslate_server_frame(&value),
                        );
                        result.event_log.push(ProviderStreamEventRecord::new(
                            "session.finished",
                            "DashScope LiveTranslate session.finished 已接收。",
                        ));
                        evidence.evidence_outcome =
                            "livetranslate-session-finished".to_string();
                        return (None, JsonFrameOutcome::Completed);
                    }
                    _ => {
                        let error = ProviderRuntimeError::new(
                            "protocol.invalid",
                            format!(
                                "DashScope LiveTranslate event {event_type} arrived in state {state:?}."
                            ),
                        );
                        return (None, JsonFrameOutcome::Failed(error));
                    }
                }
    (
        Some(LiveTranslateProbeLifecycle {
            state,
            session_finish,
            response_completion_deadline,
            response_completion_started_monotonic_ms,
            session_id,
            server_event_ids,
            protocol_authority,
            protocol_state,
        }),
        JsonFrameOutcome::Continue,
    )
}

fn validate_livetranslate_session_created(
    value: &Value,
    expected_model: &str,
) -> Result<(String, String), ProviderRuntimeError> {
    let session_id = value
        .pointer("/session/id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ProviderRuntimeError::new(
                "protocol.identity-invalid",
                "DashScope LiveTranslate session.created is missing session.id.",
            )
        })?;
    let server_model = value
        .pointer("/session/model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ProviderRuntimeError::new(
                "protocol.identity-invalid",
                "DashScope LiveTranslate session.created is missing session.model.",
            )
        })?;
    if server_model != expected_model {
        return Err(ProviderRuntimeError::new(
            "protocol.identity-invalid",
            format!(
                "DashScope LiveTranslate session.created model mismatch: expected {expected_model}, observed {server_model}."
            ),
        ));
    }
    Ok((session_id.to_string(), server_model.to_string()))
}

fn validate_livetranslate_server_event_id(
    value: &Value,
    event_type: &str,
    observed: &mut HashSet<String>,
) -> Result<(), ProviderRuntimeError> {
    let event_id = value
        .get("event_id")
        .and_then(Value::as_str)
        .filter(|event_id| !event_id.trim().is_empty())
        .ok_or_else(|| {
            ProviderRuntimeError::new(
                "protocol.event-id-invalid",
                format!("DashScope LiveTranslate {event_type} is missing event_id."),
            )
        })?;
    // The official contract only requires a unique string.  Do not invent a
    // client-side prefix, alphabet, or length restriction for provider-issued
    // identifiers; retain only a fixed-size digest for uniqueness tracking.
    if !observed.insert(sha256_text(event_id)) {
        return Err(ProviderRuntimeError::new(
            "protocol.event-id-reused",
            format!(
                "DashScope LiveTranslate {event_type} reused a prior server event_id."
            ),
        ));
    }
    Ok(())
}

fn validate_livetranslate_session_updated(
    value: &Value,
    expected_session_id: &str,
    expected_model: &str,
    requested_config: &Value,
) -> Result<Value, ProviderRuntimeError> {
    let session = value.pointer("/session").ok_or_else(|| {
        ProviderRuntimeError::new(
            "protocol.identity-invalid",
            "DashScope LiveTranslate session.updated is missing session authority.",
        )
    })?;
    let session_id = session.pointer("/id").and_then(Value::as_str);
    let server_model = session.pointer("/model").and_then(Value::as_str);
    if session_id != Some(expected_session_id) || server_model != Some(expected_model) {
        return Err(ProviderRuntimeError::new(
            "protocol.identity-invalid",
            "DashScope LiveTranslate session.updated identity does not match session.created.",
        ));
    }
    let normalized = normalized_livetranslate_probe_config(session);
    if &normalized != requested_config {
        return Err(ProviderRuntimeError::new(
            "protocol.config-mismatch",
            "DashScope LiveTranslate session.updated did not echo the requested zero-input configuration.",
        ));
    }
    Ok(normalized)
}

fn normalized_livetranslate_probe_config(session: &Value) -> Value {
    let turn_detection = session.get("turn_detection").unwrap_or(&Value::Null);
    let mut translation = json!({
        "language": session
            .pointer("/translation/language")
            .cloned()
            .unwrap_or(Value::Null),
    });
    if let Some(corpus) = session.pointer("/translation/corpus") {
        translation["corpus"] = corpus.clone();
    }
    json!({
        "modalities": session.pointer("/modalities").cloned().unwrap_or(Value::Null),
        "sample_rate": session.pointer("/sample_rate").cloned().unwrap_or(Value::Null),
        "input_audio_format": session.pointer("/input_audio_format").cloned().unwrap_or(Value::Null),
        "turn_detection": {
            "type": turn_detection.get("type").cloned().unwrap_or(Value::Null),
            "threshold": turn_detection.get("threshold").cloned().unwrap_or(Value::Null),
            "silence_duration_ms": turn_detection
                .get("silence_duration_ms")
                .cloned()
                .unwrap_or(Value::Null),
        },
        "input_audio_transcription": {
            "model": session
                .pointer("/input_audio_transcription/model")
                .cloned()
                .unwrap_or(Value::Null),
            "language": session
                .pointer("/input_audio_transcription/language")
                .cloned()
                .unwrap_or(Value::Null),
        },
        "translation": translation,
    })
}

fn invalid_session_authority_summary(value: &Value) -> Value {
    sanitized_livetranslate_server_frame(value)
}

fn sanitized_livetranslate_server_frame(value: &Value) -> Value {
    let mut sanitized = value.clone();
    if let Some(session) = sanitized
        .pointer_mut("/session")
        .and_then(Value::as_object_mut)
    {
        let session_id_sha256 = session
            .remove("id")
            .and_then(|value| value.as_str().map(sha256_text));
        if let Some(session_id_sha256) = session_id_sha256 {
            session.insert(
                "id".to_string(),
                Value::String(session_id_sha256),
            );
        }
    }
    sanitized
}

fn attach_trace_payload(evidence: &mut ProviderProbeWireEvidence, value: Value) {
    let payload = redacted_provider_payload(&value);
    let digest = sha256_text(&payload);
    if let Some(entry) = evidence.trace.last_mut() {
        entry.raw_redacted_payload = Some(payload);
        entry.sha256 = Some(digest);
    }
}

fn record_livetranslate_timeout(
    evidence: &mut ProviderProbeWireEvidence,
    started: &Instant,
    last_monotonic_ms: &mut u64,
    phase: &str,
    phase_started_monotonic_ms: u64,
    timeout: Duration,
    event_type: &str,
) {
    let timeout_ms = timeout
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let deadline_monotonic_ms =
        phase_started_monotonic_ms.saturating_add(timeout_ms);
    evidence.evidence_outcome = format!("timeout:{phase}");
    evidence.timeout_phase = Some(phase.to_string());
    evidence.timeout_budget_ms = Some(timeout_ms);
    let terminal_monotonic_ms = record_wire_trace(
        evidence,
        started,
        last_monotonic_ms,
        "local",
        event_type,
        |entry| {
            entry.timeout_phase = Some(phase.to_string());
            entry.started_monotonic_ms = Some(phase_started_monotonic_ms);
            entry.deadline_monotonic_ms = Some(deadline_monotonic_ms);
        },
    );
    if terminal_monotonic_ms < deadline_monotonic_ms {
        if let Some(entry) = evidence.trace.last_mut() {
            entry.monotonic_ms = deadline_monotonic_ms;
        }
        *last_monotonic_ms = deadline_monotonic_ms;
    }
}

fn record_wire_trace(
    evidence: &mut ProviderProbeWireEvidence,
    started: &Instant,
    last_monotonic_ms: &mut u64,
    direction: &str,
    event_type: &str,
    configure: impl FnOnce(&mut ProviderWebSocketTraceEntry),
) -> u64 {
    let observed = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let monotonic_ms = if evidence.trace.is_empty() {
        observed
    } else {
        observed.max(last_monotonic_ms.saturating_add(1))
    };
    *last_monotonic_ms = monotonic_ms;
    let mut entry = ProviderWebSocketTraceEntry {
        monotonic_ms,
        direction: direction.to_string(),
        event_type: event_type.to_string(),
        status: None,
        raw_redacted_payload: None,
        sha256: None,
        code: None,
        reason: None,
        normal: None,
        timeout_phase: None,
        started_monotonic_ms: None,
        deadline_monotonic_ms: None,
    };
    configure(&mut entry);
    evidence.trace.push(entry);
    monotonic_ms
}

fn sha256_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn failed_livetranslate_result(
    mut result: ProviderSmokeResult,
    evidence: ProviderProbeWireEvidence,
    error: ProviderRuntimeError,
) -> ProviderSmokeResult {
    result.status = "failed".to_string();
    result.error = Some(error);
    result.wire_evidence = Some(evidence);
    result
}

fn failed_connected_livetranslate_result(
    socket: ProviderWebSocket,
    mut result: ProviderSmokeResult,
    evidence: ProviderProbeWireEvidence,
    error: ProviderRuntimeError,
) -> ProviderSmokeResult {
    drop(socket);
    result.connection_closed = true;
    failed_livetranslate_result(result, evidence, error)
}

fn completed_connected_livetranslate_result(
    socket: ProviderWebSocket,
    mut result: ProviderSmokeResult,
    evidence: ProviderProbeWireEvidence,
) -> ProviderSmokeResult {
    drop(socket);
    result.connection_closed = true;
    result.wire_evidence = Some(evidence);
    result
}

#[path = "livetranslate_probe/sanitization.rs"]
mod sanitization;
use sanitization::*;

#[cfg(test)]
#[path = "livetranslate_probe/strict_evidence_tests.rs"]
mod strict_evidence_tests;
