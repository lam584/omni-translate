use super::*;

type DrainEventsFn = fn(
    &mut WebSocket<MaybeTlsStream<TcpStream>>,
    &Instant,
    &mut RawResult,
    &mut Instant,
    &mut BenchmarkProgressState,
    Option<&crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile>,
) -> Result<(), String>;

/// Polls server events until `deadline`, sleeping in short slices so the next
/// audio chunk still goes out on schedule.
pub(super) fn poll_events_until_deadline(
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
pub(super) fn poll_chunk_gap_events(
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
pub(super) fn drain_remaining_and_finish(
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
