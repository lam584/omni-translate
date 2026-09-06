use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;
use tungstenite::Message;

use crate::provider::contracts::ProviderDraftInput;
use crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile;

use super::super::realtime_socket::{ReconnectedRealtimeSocket, TungsteniteSocket};
use super::super::{
    OmniOutputMode, RealtimeAudioMode, RealtimeSocket, RealtimeSocketConnector,
};

const LIVETRANSLATE_TOTAL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

struct LivetranslateShutdownShared {
    enabled: bool,
    authority: Option<AuthorizedModelProtocolProfile>,
    shutdown_requested: Arc<AtomicBool>,
    session_finish_sent: AtomicBool,
    session_finished_received: AtomicBool,
    pre_finish_session_finished_observed: AtomicBool,
    idle_read_observation_count: AtomicU64,
}

pub(super) struct LivetranslateShutdown {
    enabled: bool,
    shared: Arc<LivetranslateShutdownShared>,
    requested_at: Option<Instant>,
    pre_finish_drain_barrier: Option<u64>,
    last_finish_observation: Option<(usize, bool, bool)>,
}

impl LivetranslateShutdown {
    pub(super) fn for_provider(
        provider: &ProviderDraftInput,
        stop_requested: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let enabled = crate::audio::events::is_livetranslate_route_model(
            provider,
            &provider.model,
        );
        let authority = enabled
            .then(|| crate::audio::events::authorize_bailian_native_translate(provider))
            .transpose()?;
        Ok(Self::with_authority(enabled, authority, stop_requested))
    }

    #[cfg(test)]
    fn new(enabled: bool) -> Self {
        Self::with_stop_signal(enabled, Arc::new(AtomicBool::new(false)))
    }

    #[cfg(test)]
    fn with_stop_signal(enabled: bool, shutdown_requested: Arc<AtomicBool>) -> Self {
        let authority = enabled.then(crate::audio::bailian_protocol::livetranslate_test_authority);
        Self::with_authority(enabled, authority, shutdown_requested)
    }

    fn with_authority(
        enabled: bool,
        authority: Option<AuthorizedModelProtocolProfile>,
        shutdown_requested: Arc<AtomicBool>,
    ) -> Self {
        Self {
            enabled,
            shared: Arc::new(LivetranslateShutdownShared {
                enabled,
                authority,
                shutdown_requested,
                session_finish_sent: AtomicBool::new(false),
                session_finished_received: AtomicBool::new(false),
                pre_finish_session_finished_observed: AtomicBool::new(false),
                idle_read_observation_count: AtomicU64::new(0),
            }),
            requested_at: None,
            pre_finish_drain_barrier: None,
            last_finish_observation: None,
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

    pub(super) fn tick_pause(&self) -> Duration {
        // Once input is fenced, drain already queued inbound frames without
        // adding a fixed delay per frame. The idle-read barrier and total
        // shutdown deadline still decide whether finish may be sent.
        if self.pre_finish_drain_barrier.is_some()
            && !self.shared.session_finish_sent.load(Ordering::SeqCst)
        {
            Duration::ZERO
        } else {
            Duration::from_millis(10)
        }
    }

    pub(super) fn pace_tick(&self, wait: impl FnOnce(Duration), yield_tick: impl FnOnce()) {
        let pause = self.tick_pause();
        if pause.is_zero() {
            yield_tick();
        } else {
            wait(pause);
        }
    }

    pub(super) fn should_send_finish(
        &mut self,
        chunks_sent_this_tick: usize,
        pre_session_audio_queue_is_empty: bool,
        audio_input_disconnected: bool,
    ) -> Result<bool, String> {
        self.last_finish_observation = Some((
            chunks_sent_this_tick,
            pre_session_audio_queue_is_empty,
            audio_input_disconnected,
        ));
        if self
            .shared
            .pre_finish_session_finished_observed
            .load(Ordering::SeqCst)
        {
            return Err(
                "LiveTranslate fail-closed: session.finished was observed before the local session.finish send boundary | code: livetranslate-session-finished-before-finish"
                    .to_string(),
            );
        }
        let input_fenced = self.is_requested()
            && !self.shared.session_finish_sent.load(Ordering::SeqCst)
            && chunks_sent_this_tick == 0
            && pre_session_audio_queue_is_empty
            && audio_input_disconnected;
        if !input_fenced {
            self.pre_finish_drain_barrier = None;
            return Ok(false);
        }
        let idle_reads = self
            .shared
            .idle_read_observation_count
            .load(Ordering::SeqCst);
        let Some(barrier) = self.pre_finish_drain_barrier else {
            // Force at least one nonblocking socket read to observe an empty
            // inbound queue after the capture/send fence. This prevents an
            // already-queued, out-of-order session.finished from being
            // reclassified as the acknowledgement to our later finish.
            self.pre_finish_drain_barrier = Some(idle_reads);
            return Ok(false);
        };
        Ok(idle_reads > barrier)
    }

    pub(super) fn finish_event(&self, event_id: &str) -> Value {
        json!({
            "event_id": event_id,
            "type": "session.finish",
        })
    }

    pub(super) fn record_finish_sent(&mut self, _now: Instant) {
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
        let requested_at = self.requested_at?;
        if now.saturating_duration_since(requested_at) < LIVETRANSLATE_TOTAL_SHUTDOWN_TIMEOUT {
            return None;
        }
        let finish_sent = self.shared.session_finish_sent.load(Ordering::SeqCst);
        let reason = if finish_sent {
            "livetranslate-session-finished-timeout"
        } else {
            "livetranslate-audio-drain-timeout"
        };
        // These inputs describe the last predicate evaluation, not live queue state.
        let observation = match self.last_finish_observation {
            Some((chunks, empty, disconnected)) => format!(
                "lastObservedChunksSent={chunks} lastObservedPrequeueEmpty={empty} lastObservedInputDisconnected={disconnected}"
            ),
            None => "lastObservedChunksSent=unknown lastObservedPrequeueEmpty=unknown lastObservedInputDisconnected=unknown".to_string(),
        };
        let idle_reads = self.shared.idle_read_observation_count.load(Ordering::SeqCst);
        let barrier = self.pre_finish_drain_barrier
            .map(|value| value.to_string()).unwrap_or_else(|| "none".to_string());
        Some((
            reason,
            format!(
                "LiveTranslate fail-closed: shutdown did not complete within {} seconds of the stop request (session.finish sent={finish_sent}) {observation} currentIdleReadCount={idle_reads} currentDrainBarrier={barrier}",
                LIVETRANSLATE_TOTAL_SHUTDOWN_TIMEOUT.as_secs()
            ),
        ))
    }
}

pub(super) struct LivetranslateSocket<S> {
    inner: S,
    shared: Arc<LivetranslateShutdownShared>,
}

impl<S: RealtimeSocket> RealtimeSocket for LivetranslateSocket<S> {
    fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
        let message = match self.inner.read_message() {
            Ok(message) => message,
            Err(error) => {
                if matches!(
                    &error,
                    tungstenite::Error::Io(io_error)
                        if matches!(io_error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
                ) {
                    self.shared
                        .idle_read_observation_count
                        .fetch_add(1, Ordering::SeqCst);
                }
                return Err(error);
            }
        };
        if message_event_type(&message) == Some("session.finished") {
            if self.shared.session_finish_sent.load(Ordering::SeqCst) {
                // Mark receipt before returning the exact event. The ordinary
                // processor still consumes it (and every preceding final event)
                // before the worker closes the socket.
                self.shared
                    .session_finished_received
                    .store(true, Ordering::SeqCst);
            } else {
                self.shared
                    .pre_finish_session_finished_observed
                    .store(true, Ordering::SeqCst);
            }
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
        if let Some(authority) = self.shared.authority.as_ref() {
            let Message::Text(text) = &message else {
                return Err(tungstenite::Error::Io(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "LiveTranslate typed sender forbids non-JSON client frames",
                )));
            };
            let event = serde_json::from_str::<Value>(text).map_err(|error| {
                tungstenite::Error::Io(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("LiveTranslate typed sender requires JSON: {error}"),
                ))
            })?;
            crate::audio::bailian_protocol::admit_livetranslate_client_event(
                authority,
                &event,
            )
            .map_err(|error| {
                tungstenite::Error::Io(io::Error::new(io::ErrorKind::InvalidData, error))
            })?;
            if event.get("type").and_then(Value::as_str) == Some("session.finish") {
                self.shared
                    .session_finish_sent
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .map_err(|_| {
                        tungstenite::Error::Io(io::Error::new(
                            io::ErrorKind::ConnectionAborted,
                            "LiveTranslate session.finish already sent",
                        ))
                    })?;
            }
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
        source_language: &str,
        target_language: &str,
    ) -> Result<ReconnectedRealtimeSocket<Self::Socket>, String> {
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
                source_language,
                target_language,
            )
            .map(|reconnected| ReconnectedRealtimeSocket {
                socket: LivetranslateSocket {
                    inner: reconnected.socket,
                    shared: self.shared.clone(),
                },
                session_update: reconnected.session_update,
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
        let append_after_finish = socket.send_message(Message::Text(
            json!({"type":"input_audio_buffer.append","audio":"AA=="})
                .to_string()
                .into(),
        ));

        assert!(duplicate.is_err());
        assert!(
            append_after_finish.is_err(),
            "the real socket wrapper must reject every Provider write after session.finish"
        );
        let sent = &state.lock().expect("fake socket state").sent;
        assert_eq!(sent.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(sent[0].to_text().expect("text message"))
                .expect("json event"),
            finish
        );
    }

    #[test]
    fn typed_sender_rejects_livetranslate_response_create_before_inner_write() {
        let shutdown = LivetranslateShutdown::new(true);
        let state = Arc::new(Mutex::new(FakeSocketState::default()));
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::new(),
            state: state.clone(),
        });

        assert!(socket.send_message(text_event("response.create")).is_err());
        assert!(state.lock().expect("fake socket state").sent.is_empty());
        socket
            .send_message(Message::Text(
                json!({"type":"input_audio_buffer.append","audio":"AA=="})
                    .to_string()
                    .into(),
            ))
            .expect("admitted audio append reaches the inner socket");
        assert_eq!(state.lock().expect("fake socket state").sent.len(), 1);
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
    fn empty_but_still_connected_audio_input_cannot_authorize_session_finish() {
        let mut shutdown = LivetranslateShutdown::new(true);
        assert!(shutdown.request(Instant::now()));

        assert!(
            !shutdown.should_send_finish(0, true, false).unwrap(),
            "an instantaneous empty queue is not a producer completion fence"
        );
        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
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
        assert!(shutdown.should_send_finish(0, true, true).is_err());
    }

    #[test]
    fn prequeued_session_finished_is_rejected_before_finish_can_cross_the_send_boundary() {
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(Instant::now());
        let state = Arc::new(Mutex::new(FakeSocketState::default()));
        let event = text_event("session.finished");
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::from([event.clone()]),
            state,
        });

        assert!(
            !shutdown.should_send_finish(0, true, true).unwrap(),
            "the first eligible tick must arm an inbound drain barrier"
        );
        assert_eq!(socket.read_message().expect("prequeued event"), event);
        assert!(
            shutdown.should_send_finish(0, true, true).is_err(),
            "an event queued before finish cannot become its acknowledgement"
        );
        assert!(!shutdown.session_finished_received());
    }

    #[test]
    fn finish_requires_a_post_fence_idle_socket_read() {
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(Instant::now());
        let state = Arc::new(Mutex::new(FakeSocketState::default()));
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::new(),
            state,
        });

        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        assert!(socket.read_message().is_err(), "empty scripted socket is idle");
        assert!(shutdown.should_send_finish(0, true, true).unwrap());
    }

    #[test]
    fn missing_session_finished_reaches_a_deterministic_bounded_timeout() {
        let now = Instant::now();
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(now);
        shutdown.record_finish_sent(now + Duration::from_secs(14));

        assert!(shutdown
            .deadline_error(now + LIVETRANSLATE_TOTAL_SHUTDOWN_TIMEOUT - Duration::from_millis(1))
            .is_none());

        let (reason, error) = shutdown
            .deadline_error(now + LIVETRANSLATE_TOTAL_SHUTDOWN_TIMEOUT)
            .expect("bounded terminal failure");

        assert_eq!(reason, "livetranslate-session-finished-timeout");
        assert!(error.contains("within 15 seconds of the stop request"));
    }

    #[test]
    fn ordinary_recv_requires_eventual_idle_before_finish() {
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(Instant::now());
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::from([text_event("response.audio.delta"), text_event("response.done")]),
            state: Arc::new(Mutex::new(FakeSocketState::default())),
        });
        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        for _ in 0..2 {
            socket.read_message().unwrap();
            assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        }
        assert!(socket.read_message().is_err());
        assert!(shutdown.should_send_finish(0, true, true).unwrap());
    }

    #[test]
    fn fenced_finite_receive_backlog_drains_without_per_frame_pacing() {
        let now = Instant::now();
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(now);
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::from(vec![text_event("response.audio.delta"); 1500]),
            state: Arc::new(Mutex::new(FakeSocketState::default())),
        });
        let mut elapsed = Duration::ZERO;
        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        for _ in 0..1500 {
            socket.read_message().unwrap();
            assert!(!shutdown.should_send_finish(0, true, true).unwrap());
            elapsed += Duration::from_millis(1) + shutdown.tick_pause();
        }
        assert!(shutdown.deadline_error(now + elapsed).is_none(),
            "finite receive backlog must not exhaust shutdown through fixed per-frame pacing: {elapsed:?}");
        assert!(socket.read_message().is_err());
        assert!(shutdown.should_send_finish(0, true, true).unwrap());
        shutdown.record_finish_sent(now + elapsed);
        assert_eq!(shutdown.tick_pause(), Duration::from_millis(10));
    }

    #[test]
    fn accelerated_receive_pacing_requires_and_tracks_the_input_fence() {
        for enabled in [false, true] {
            let mut shutdown = LivetranslateShutdown::new(enabled);
            assert_eq!(shutdown.tick_pause(), Duration::from_millis(10));
            shutdown.request(Instant::now());
            for (chunks, empty, disconnected) in
                [(0, true, false), (1, true, true), (0, false, true)]
            {
                assert!(!shutdown.should_send_finish(chunks, empty, disconnected).unwrap());
                assert_eq!(shutdown.tick_pause(), Duration::from_millis(10));
            }
            assert!(!shutdown.should_send_finish(0, true, true).unwrap());
            assert_eq!(shutdown.tick_pause(), if enabled { Duration::ZERO } else { Duration::from_millis(10) });
            // A newly observed send invalidates the fence and restores pacing.
            assert!(!shutdown.should_send_finish(1, true, true).unwrap());
            assert_eq!(shutdown.tick_pause(), Duration::from_millis(10));
        }
    }

    #[test]
    fn production_pacing_seam_yields_fenced_backlog_and_waits_otherwise() {
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.pace_tick(|pause| assert_eq!(pause, Duration::from_millis(10)),
            || panic!("ordinary tick must wait"));
        shutdown.request(Instant::now());
        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        let mut yields = 0;
        for _ in 0..1500 {
            shutdown.pace_tick(|_| panic!("fenced drain must not sleep per frame"),
                || yields += 1);
        }
        assert_eq!(yields, 1500);
        assert!(!shutdown.should_send_finish(0, false, true).unwrap());
        shutdown.pace_tick(|pause| assert_eq!(pause, Duration::from_millis(10)),
            || panic!("invalidated fence must restore waiting"));
    }

    #[test]
    fn uninterrupted_recv_cannot_authorize_finish_before_total_deadline() {
        let now = Instant::now();
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(now);
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::from(vec![text_event("response.audio.delta"); 16]),
            state: Arc::new(Mutex::new(FakeSocketState::default())),
        });
        for second in 0..15 {
            assert!(!shutdown.should_send_finish(0, true, true).unwrap());
            socket.read_message().unwrap();
            assert!(shutdown.deadline_error(now + Duration::from_secs(second)).is_none());
        }
        let (reason, error) = shutdown.deadline_error(now + Duration::from_secs(15)).unwrap();
        assert_eq!(reason, "livetranslate-audio-drain-timeout");
        assert!(error.contains("session.finish sent=false"));
        assert!(error.contains("currentIdleReadCount=0 currentDrainBarrier=0"));
    }

    #[test]
    fn input_predicates_block_finish_and_recover_after_a_fresh_idle() {
        for (chunks, empty, disconnected) in [(1, true, true), (0, false, true), (0, true, false)] {
            let now = Instant::now();
            let mut shutdown = LivetranslateShutdown::new(true);
            shutdown.request(now);
            let mut socket = shutdown.wrap_socket(FakeSocket {
                inbound: VecDeque::new(),
                state: Arc::new(Mutex::new(FakeSocketState::default())),
            });
            assert!(!shutdown.should_send_finish(chunks, empty, disconnected).unwrap());
            let (_, error) = shutdown.deadline_error(now + Duration::from_secs(15)).unwrap();
            assert!(error.contains(&format!("lastObservedChunksSent={chunks} lastObservedPrequeueEmpty={empty} lastObservedInputDisconnected={disconnected}")));
            assert!(error.contains("currentDrainBarrier=none"));
            assert!(socket.read_message().is_err());
            assert!(!shutdown.should_send_finish(0, true, true).unwrap());
            assert!(socket.read_message().is_err());
            assert!(shutdown.should_send_finish(0, true, true).unwrap());
        }
    }

    #[test]
    fn invalidated_input_fence_does_not_reuse_an_older_idle_observation() {
        let now = Instant::now();
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(now);
        let (_, error) = shutdown.deadline_error(now + Duration::from_secs(15)).unwrap();
        assert!(error.contains("lastObservedChunksSent=unknown lastObservedPrequeueEmpty=unknown lastObservedInputDisconnected=unknown"));
        let mut socket = shutdown.wrap_socket(FakeSocket {
            inbound: VecDeque::new(),
            state: Arc::new(Mutex::new(FakeSocketState::default())),
        });
        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        assert!(socket.read_message().is_err());
        assert!(!shutdown.should_send_finish(1, true, true).unwrap());
        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        assert!(!shutdown.should_send_finish(0, true, true).unwrap());
        assert!(socket.read_message().is_err());
        assert!(shutdown.should_send_finish(0, true, true).unwrap());
    }

    #[test]
    fn audio_drain_and_finish_share_the_same_total_deadline() {
        let now = Instant::now();
        let mut shutdown = LivetranslateShutdown::new(true);
        shutdown.request(now);

        assert!(shutdown
            .deadline_error(now + LIVETRANSLATE_TOTAL_SHUTDOWN_TIMEOUT - Duration::from_millis(1))
            .is_none());
        let (reason, _) = shutdown
            .deadline_error(now + LIVETRANSLATE_TOTAL_SHUTDOWN_TIMEOUT)
            .expect("audio drain shares the total shutdown deadline");
        assert_eq!(reason, "livetranslate-audio-drain-timeout");
    }
}
