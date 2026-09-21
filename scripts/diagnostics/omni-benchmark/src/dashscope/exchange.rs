//! One socket, one protocol ledger, paced sends and nonblocking receive between sends.
use super::*;
use std::net::TcpStream;
use tungstenite::stream::MaybeTlsStream;

type Socket = tungstenite::WebSocket<MaybeTlsStream<TcpStream>>;
const AUDIO_FRAME_INTERVAL: Duration = Duration::from_millis(CHUNK_SAMPLES as u64 * 1000 / 16_000);
const POLL_INTERVAL: Duration = Duration::from_millis(1);
const MAX_READ_BURST: usize = 64;

#[derive(Debug, Default, serde::Serialize)]
pub(super) struct WireEvidence {
    pub server_error: Option<Value>,
    pub close_observed: bool,
    pub close_frame: Option<Value>,
    pub last_event_type: Option<String>,
    pub server_events_received: usize,
    pub session_finished: bool,
}

#[derive(Debug, Default, serde::Serialize)]
pub(super) struct ExchangeFailure {
    pub message: String,
    pub partial: RawResult,
    pub wire: WireEvidence,
    pub audio_chunks_sent: usize,
    pub pending_audio_chunk: Option<usize>,
    pub session_finish_sent: bool,
    pub elapsed_ms: f64,
    pub audio_send_ms: f64,
    pub transport_error: Option<String>,
}

fn nonblocking(socket: &mut Socket) -> Result<(), String> {
    let tcp = match socket.get_mut() {
        MaybeTlsStream::Plain(tcp) => tcp,
        MaybeTlsStream::Rustls(tls) => &mut tls.sock,
        _ => return Err("unsupported LiveTranslate transport".to_string()),
    };
    tcp.set_nonblocking(true).map_err(|e| format!("set nonblocking: {e}"))
}

fn would_block(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(e) if e.kind() == std::io::ErrorKind::WouldBlock)
}

pub(super) fn exchange_audio(socket: &mut Socket, plan: &crate::bailian_contract::LiveTranslateClientPlan, lifecycle: &mut LiveTranslateLifecycle, samples: &[i16], _quiet: bool) -> Result<(RawResult, usize, f64), ExchangeFailure> {
    let start = Instant::now();
    let mut state = ExchangeFailure::default();
    if let Err(error) = nonblocking(socket) {
        state.message = error;
        return Err(state);
    }
    let result = pump(socket, plan, lifecycle, samples, &start, &mut state);
    match result {
        Ok(()) => Ok((state.partial, state.audio_chunks_sent, state.audio_send_ms)),
        Err(error) => {
            state.message = error;
            // Preserve already-buffered inbound evidence even when a write fails first.
            // No sleep, reconnect, application-message resend or unbounded drain.
            for _ in 0..MAX_READ_BURST {
                match socket.read() {
                    Ok(message) => { let _ = process_server_message(message, &start, lifecycle, &mut state.partial, &mut state.wire); }
                    Err(e) => {
                        if !would_block(&e) && !matches!(e, tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) && state.transport_error.is_none() {
                            state.transport_error = Some(format!("failure-drain read: {e}"));
                        }
                        break;
                    },
                }
            }
            if let Some(event) = &state.wire.server_error {
                state.message = format!("LiveTranslate server error: {}", event["error"]);
            }
            state.elapsed_ms = elapsed_ms(&start);
            Err(state)
        }
    }
}

fn pump(socket: &mut Socket, plan: &crate::bailian_contract::LiveTranslateClientPlan, lifecycle: &mut LiveTranslateLifecycle, samples: &[i16], start: &Instant, state: &mut ExchangeFailure) -> Result<(), String> {
    let mut chunks = samples.chunks(CHUNK_SAMPLES);
    let mut next_send = Instant::now();
    let mut last_event = Instant::now();
    let mut pending = false;
    let mut finishing = false;
    loop {
        if start.elapsed() > Duration::from_secs(TOTAL_TIMEOUT_SECS) || (state.session_finish_sent && last_event.elapsed() > Duration::from_secs(IDLE_TIMEOUT_SECS)) {
            return Err("timed out before LiveTranslate session.finished".to_string());
        }
        // Complete buffered writes without ever passing the same application message to write twice.
        if pending {
            match socket.flush() {
                Ok(()) => {
                    pending = false;
                    if finishing {
                        lifecycle.record_finish_sent()?;
                        state.session_finish_sent = true;
                        last_event = Instant::now();
                    } else {
                        state.audio_chunks_sent += 1;
                        state.pending_audio_chunk = None;
                        state.audio_send_ms = elapsed_ms(start);
                        next_send = Instant::now() + AUDIO_FRAME_INTERVAL;
                    }
                }
                Err(e) if would_block(&e) => {}
                Err(e) => {
                    let error = format!("write flush at chunk {}: {e}", state.audio_chunks_sent);
                    state.transport_error = Some(error.clone());
                    return Err(error);
                }
            }
        }
        if pending && finishing {
            // Do not let read auto-flush session.finish and consume its acknowledgement
            // before the sole lifecycle records that the finish write completed.
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        for _ in 0..MAX_READ_BURST {
            match socket.read() {
                Ok(message) => {
                    last_event = Instant::now();
                    if process_server_message(message, start, lifecycle, &mut state.partial, &mut state.wire)? { return Ok(()); }
                }
                Err(e) if would_block(&e) => break,
                Err(e) => {
                    let error = format!("read error: {e}");
                    state.transport_error = Some(error.clone());
                    return Err(error);
                }
            }
        }
        if !pending && !state.session_finish_sent && Instant::now() >= next_send {
            let message = if let Some(chunk) = chunks.next() {
                let message = build_audio_append(chunk);
                plan.admit_audio_append(&message)?;
                state.pending_audio_chunk = Some(state.audio_chunks_sent);
                message
            } else {
                finishing = true;
                plan.session_finish().clone()
            };
            pending = true;
            match socket.write(Message::Text(message.to_string().into())) {
                Ok(()) => {}
                // tungstenite retains this frame in its write buffer. Only flush it subsequently.
                Err(e) if would_block(&e) => {}
                Err(e) => {
                    let error = format!("{} send at chunk {}: {e}", if finishing { "session.finish" } else { "audio" }, state.audio_chunks_sent);
                    state.transport_error = Some(error.clone());
                    return Err(error);
                }
            }
            // Flush immediately, without adding a polling interval to every audio frame.
            continue;
        }
        std::thread::sleep(if pending || state.session_finish_sent { POLL_INTERVAL } else { POLL_INTERVAL.min(next_send.saturating_duration_since(Instant::now())) });
    }
}
