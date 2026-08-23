use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;
use tungstenite::Message;

use crate::provider::contracts::ProviderDraftInput;

use super::super::realtime_socket::TungsteniteSocket;
use super::super::{
    OmniOutputMode, RealtimeAudioMode, RealtimeSocket, RealtimeSocketConnector,
};

const LIVETRANSLATE_AUDIO_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const LIVETRANSLATE_SESSION_FINISHED_TIMEOUT: Duration = Duration::from_secs(15);

struct LivetranslateShutdownShared {
    enabled: bool,
    shutdown_requested: Arc<AtomicBool>,
    session_finish_sent: AtomicBool,
    session_finished_received: AtomicBool,
}

pub(super) struct LivetranslateShutdown {
    enabled: bool,
    shared: Arc<LivetranslateShutdownShared>,
    requested_at: Option<Instant>,
    finish_sent_at: Option<Instant>,
}

impl LivetranslateShutdown {
    pub(super) fn for_provider(
        provider: &ProviderDraftInput,
        stop_requested: Arc<AtomicBool>,
    ) -> Self {
        Self::with_stop_signal(
            crate::audio::events::is_livetranslate_route_model(
                provider,
                &provider.model,
            ),
            stop_requested,
        )
    }

    fn new(enabled: bool) -> Self {
        Self::with_stop_signal(enabled, Arc::new(AtomicBool::new(false)))
    }

    fn with_stop_signal(enabled: bool, shutdown_requested: Arc<AtomicBool>) -> Self {
        Self {
            enabled,
            shared: Arc::new(LivetranslateShutdownShared {
                enabled,
                shutdown_requested,
                session_finish_sent: AtomicBool::new(false),
                session_finished_received: AtomicBool::new(false),
            }),
            requested_at: None,
            finish_sent_at: None,
        }
    }

    pub(super) fn wrap_socket<S>(&self, inner: S) -> LivetranslateSocket<S> {
        LivetranslateSocket {
            inner,
            shared: self.shared.clone(),
        }
    }

    pub(super) fn wrap_connector<C>(&self, inner: C) -> LivetranslateConnector<C> {
        LivetranslateConnector {
            inner,
            shared: self.shared.clone(),
        }
    }

    /// Returns true when LiveTranslate owns the shutdown and the caller must
    /// keep polling the existing socket instead of closing it immediately.
    pub(super) fn request(&mut self, now: Instant) -> bool {
        if !self.enabled {
            return false;
        }
        if self.requested_at.is_none() {
            self.requested_at = Some(now);
            self.shared
                .shutdown_requested
                .store(true, Ordering::SeqCst);
        }
        true
    }

    pub(super) fn is_requested(&self) -> bool {
        self.requested_at.is_some()
    }

    pub(super) fn should_send_finish(
        &self,
        chunks_sent_this_tick: usize,
        pre_session_audio_queue_is_empty: bool,
    ) -> bool {
        self.is_requested()
            && !self.shared.session_finish_sent.load(Ordering::SeqCst)
            && chunks_sent_this_tick == 0
            && pre_session_audio_queue_is_empty
    }

    pub(super) fn finish_event(&self, event_id: &str) -> Value {
        json!({
            "event_id": event_id,
            "type": "session.finish",
        })
    }

    pub(super) fn record_finish_sent(&mut self, now: Instant) {
        self.finish_sent_at = Some(now);
        self.shared
            .session_finish_sent
            .store(true, Ordering::SeqCst);
    }

    pub(super) fn session_finished_received(&self) -> bool {
        self.shared.session_finish_sent.load(Ordering::SeqCst)
            && self
                .shared
                .session_finished_received
                .load(Ordering::SeqCst)
    }

    pub(super) fn deadline_error(&self, now: Instant) -> Option<(&'static str, String)> {
        if self.session_finished_received() {
            return None;
        }
        if let Some(finish_sent_at) = self.finish_sent_at {
            if now.saturating_duration_since(finish_sent_at)
                >= LIVETRANSLATE_SESSION_FINISHED_TIMEOUT
            {
                return Some((
                    "livetranslate-session-finished-timeout",
                    format!(
                        "LiveTranslate fail-closed: session.finished was not received within {} seconds after session.finish",
                        LIVETRANSLATE_SESSION_FINISHED_TIMEOUT.as_secs()
                    ),
                ));
            }
        } else if let Some(requested_at) = self.requested_at {
            if now.saturating_duration_since(requested_at)
                >= LIVETRANSLATE_AUDIO_DRAIN_TIMEOUT
            {
                return Some((
                    "livetranslate-audio-drain-timeout",
                    format!(
                        "LiveTranslate fail-closed: local audio did not drain within {} seconds before session.finish",
                        LIVETRANSLATE_AUDIO_DRAIN_TIMEOUT.as_secs()
                    ),
                ));
            }
        }
        None
    }
}

pub(super) struct LivetranslateSocket<S> {
    inner: S,
    shared: Arc<LivetranslateShutdownShared>,
}

impl<S: RealtimeSocket> RealtimeSocket for LivetranslateSocket<S> {
    fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
        let message = self.inner.read_message()?;
        if self.shared.session_finish_sent.load(Ordering::SeqCst)
            && message_event_type(&message) == Some("session.finished")
        {
            // Mark receipt before returning the exact event. The ordinary
            // processor still consumes it (and every preceding final event)
            // before the worker closes the socket.
            self.shared
                .session_finished_received
                .store(true, Ordering::SeqCst);
        }
        Ok(message)
    }

    fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error> {
        if self.shared.session_finish_sent.load(Ordering::SeqCst) {
            return Err(tungstenite::Error::Io(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "LiveTranslate session.finish already sent; further writes are forbidden",
            )));
        }
        self.inner.send_message(message)
    }
}

impl LivetranslateSocket<TungsteniteSocket> {
    pub(super) fn close(&mut self) -> tungstenite::Result<()> {
        self.inner.close(None)
    }
}

pub(super) struct LivetranslateConnector<C> {
    inner: C,
    shared: Arc<LivetranslateShutdownShared>,
}

impl<C> LivetranslateConnector<C> {
    fn authorize_reconnect(&self) -> Result<(), String> {
        if self.shared.enabled
            && self.shared.shutdown_requested.load(Ordering::SeqCst)
        {
            Err(
                "LiveTranslate fail-closed: reconnect is forbidden after shutdown begins"
                    .to_string(),
            )
        } else {
            Ok(())
        }
    }
}

impl<C: RealtimeSocketConnector> RealtimeSocketConnector for LivetranslateConnector<C> {
    type Socket = LivetranslateSocket<C::Socket>;

    fn reconnect<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        provider: &ProviderDraftInput,
        voice: &str,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        output_mode: OmniOutputMode,
        target_language: &str,
    ) -> Result<Self::Socket, String> {
        // This check happens before the inner connector, so a shutdown-time
        // transport failure cannot create or bill a replacement session.
        self.authorize_reconnect()?;
        self.inner
            .reconnect(
                app,
                provider,
                voice,
                instructions,
                audio_mode,
                output_mode,
                target_language,
            )
            .map(|inner| LivetranslateSocket {
                inner,
                shared: self.shared.clone(),
            })
    }
}

fn message_event_type(message: &Message) -> Option<&str> {
    let Message::Text(text) = message else {
        return None;
    };
    let event = serde_json::from_str::<Value>(text).ok()?;
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|event_type| match event_type {
            "session.finished" => "session.finished",
            _ => "other",
        })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct FakeSocketState {
        sent: Vec<Message>,
    }

    struct FakeSocket {
        inbound: VecDeque<Message>,
        state: Arc<Mutex<FakeSocketState>>,
    }

    impl RealtimeSocket for FakeSocket {
        fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
            self.inbound.pop_front().ok_or_else(|| {
                tungstenite::Error::Io(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "no scripted event",
                ))
            })
        }

        fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error> {
            self.state.lock().expect("fake socket state").sent.push(message);
            Ok(())
        }
    }

    fn text_event(event_type: &str) -> Message {
        Message::Text(json!({ "type": event_type }).to_string().into())
    }

    #[test]
    fn session_finish_event_contains_required_event_id_and_type() {
        let shutdown = LivetranslateShutdown::new(true);
        assert_eq!(
            shutdown.finish_event("event_session_finish_42"),
            json!({
                "event_id": "event_session_finish_42",
                "type": "session.finish",
            })
        );
    }

    #[test]
    fn final_events_remain_fifo_and_only_session_finished_completes_shutdown() {
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(Instant::now());
        shutdown.record_finish_sent(Instant::now());
        let state = Arc::new(Mutex::new(FakeSocketState::default()));
        let first = text_event("conversation.item.input_audio_transcription.completed");
        let second = text_event("session.finished");
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::from([first.clone(), second.clone()]),
            state,
        });

        assert_eq!(socket.read_message().expect("final transcription"), first);
        assert!(!shutdown.session_finished_received());
        assert_eq!(socket.read_message().expect("session finished"), second);
        assert!(shutdown.session_finished_received());
    }

    #[test]
    fn finish_is_sent_once_and_all_later_socket_writes_fail_closed() {
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(Instant::now());
        let state = Arc::new(Mutex::new(FakeSocketState::default()));
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::new(),
            state: state.clone(),
        });
        let finish = shutdown.finish_event("event_session_finish_once");

        socket
            .send_message(Message::Text(finish.to_string().into()))
            .expect("first finish send");
        shutdown.record_finish_sent(Instant::now());
        let duplicate = socket.send_message(Message::Text(finish.to_string().into()));

        assert!(duplicate.is_err());
        let sent = &state.lock().expect("fake socket state").sent;
        assert_eq!(sent.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(sent[0].to_text().expect("text message"))
                .expect("json event"),
            finish
        );
    }

    #[test]
    fn reconnect_gate_is_open_before_stop_and_closed_after_stop() {
        let mut shutdown = LivetranslateShutdown::new(true);
        let connector = shutdown.wrap_connector(());
        assert!(connector.authorize_reconnect().is_ok());

        shutdown.request(Instant::now());

        assert_eq!(
            connector.authorize_reconnect().expect_err("must fail closed"),
            "LiveTranslate fail-closed: reconnect is forbidden after shutdown begins"
        );
    }

    #[test]
    fn external_stop_signal_closes_reconnect_before_worker_consumes_channel() {
        let stop_requested = Arc::new(AtomicBool::new(false));
        let shutdown = LivetranslateShutdown::with_stop_signal(
            true,
            stop_requested.clone(),
        );
        let connector = shutdown.wrap_connector(());
        assert!(connector.authorize_reconnect().is_ok());

        // OmniStopSender performs this store before its channel send. The
        // worker has not called request(), but reconnect is already forbidden.
        stop_requested.store(true, Ordering::SeqCst);

        assert_eq!(
            connector.authorize_reconnect().expect_err("must fail closed"),
            "LiveTranslate fail-closed: reconnect is forbidden after shutdown begins"
        );
    }

    #[test]
    fn external_stop_signal_does_not_change_ordinary_omni_reconnects() {
        let stop_requested = Arc::new(AtomicBool::new(true));
        let shutdown = LivetranslateShutdown::with_stop_signal(false, stop_requested);
        let connector = shutdown.wrap_connector(());

        assert!(connector.authorize_reconnect().is_ok());
    }

    #[test]
    fn non_livetranslate_stop_keeps_the_existing_immediate_close_path() {
        let mut shutdown = LivetranslateShutdown::new(false);
        let state = Arc::new(Mutex::new(FakeSocketState::default()));
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::new(),
            state: state.clone(),
        });

        assert!(!shutdown.request(Instant::now()));
        socket
            .send_message(text_event("input_audio_buffer.append"))
            .expect("ordinary Omni write remains available");
        assert_eq!(state.lock().expect("fake socket state").sent.len(), 1);
        assert!(!shutdown.is_requested());
    }

    #[test]
    fn unsolicited_session_finished_before_our_finish_is_not_an_ack() {
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(Instant::now());
        let state = Arc::new(Mutex::new(FakeSocketState::default()));
        let event = text_event("session.finished");
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::from([event.clone()]),
            state,
        });

        assert_eq!(socket.read_message().expect("forwarded event"), event);
        assert!(!shutdown.session_finished_received());
    }

    #[test]
    fn missing_session_finished_reaches_a_deterministic_bounded_timeout() {
        let now = Instant::now();
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(now);
        shutdown.record_finish_sent(now);

        let (reason, error) = shutdown
            .deadline_error(now + LIVETRANSLATE_SESSION_FINISHED_TIMEOUT)
            .expect("bounded terminal failure");

        assert_eq!(reason, "livetranslate-session-finished-timeout");
        assert!(error.contains("session.finished was not received"));
    }
}
