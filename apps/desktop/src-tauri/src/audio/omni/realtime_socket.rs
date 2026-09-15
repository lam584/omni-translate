//! Socket seam for the Omni realtime worker.
//!
//! The worker's poll/pump/coordinator paths are generic over
//! [`RealtimeSocket`] (read/send/close) plus a [`RealtimeSocketConnector`]
//! that establishes replacement sessions after a disconnect. Production wires
//! the tungstenite implementations; tests wire [`ScriptedRealtimeSocket`] and
//! replay incident sequences (reconnects, late transcriptions, duplicated
//! turns) entirely in-process.

use std::net::TcpStream;

use tauri::AppHandle;
use serde_json::Value;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

use crate::provider::contracts::ProviderDraftInput;

use super::reconnect_socket;
use super::{OmniOutputMode, RealtimeAudioMode};

pub(crate) trait RealtimeSocket {
    fn read_message(&mut self) -> Result<Message, tungstenite::Error>;
    fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error>;
}

pub(crate) type TungsteniteSocket = tungstenite::WebSocket<MaybeTlsStream<TcpStream>>;

pub(crate) fn is_retryable_read_poll_error(error: &tungstenite::Error) -> bool {
    matches!(
        error,
        tungstenite::Error::Io(io_error)
            if matches!(
                io_error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
    )
}

/// Execute one Provider read while the underlying stream is temporarily pollable.
///
/// Restoring blocking mode is part of the read transaction. If restoration
/// fails after a frame was consumed, the frame is deliberately not returned to
/// the event processor: the socket mode is unknown, so treating the event as
/// processed could allow a later blocking-contract write on an unsafe stream.
/// Returning the restoration error forces the existing fatal/fail-closed path.
fn read_with_temporary_nonblocking<S, T>(
    socket: &mut S,
    set_mode: impl Fn(&mut S, bool) -> std::io::Result<()>,
    read: impl FnOnce(&mut S) -> Result<T, tungstenite::Error>,
) -> Result<T, tungstenite::Error> {
    set_mode(socket, true).map_err(tungstenite::Error::Io)?;
    let read_result = read(socket);
    set_mode(socket, false).map_err(tungstenite::Error::Io)?;
    read_result
}

#[cfg(test)]
mod temporary_nonblocking_read_tests {
    use super::*;

    #[derive(Default)]
    struct FakeSocket { consumed: bool }

    #[test]
    fn consumed_event_is_not_returned_when_blocking_restore_fails() {
        let mut socket = FakeSocket::default();
        let result = read_with_temporary_nonblocking(
            &mut socket,
            |_socket, nonblocking| {
                if nonblocking { Ok(()) } else {
                    Err(std::io::Error::new(std::io::ErrorKind::Other, "restore failed"))
                }
            },
            |socket| { socket.consumed = true; Ok("consumed event") },
        );
        assert!(socket.consumed, "fixture must consume the event first");
        assert!(matches!(result, Err(tungstenite::Error::Io(ref error)) if error.to_string() == "restore failed"));
    }
}

/// Replacement socket plus the exact `session.update` value admitted and
/// written to that socket. The value is provenance, not a rebuild hint.
pub(crate) struct ReconnectedRealtimeSocket<S> {
    pub(crate) socket: S,
    pub(crate) session_update: Value,
}

impl RealtimeSocket for TungsteniteSocket {
    fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
        read_with_temporary_nonblocking(
            self,
            crate::audio::realtime_ws::set_socket_nonblocking_mode,
            |socket| socket.read(),
        )
    }

    fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error> {
        self.send(message)
    }

}

/// Establishes replacement realtime sessions after a disconnect.
pub(crate) trait RealtimeSocketConnector {
    type Socket: RealtimeSocket;

    #[allow(clippy::too_many_arguments)]
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
    ) -> Result<ReconnectedRealtimeSocket<Self::Socket>, String>;
}

/// Production connector: real WebSocket connect + session.update replay.
pub(crate) struct TungsteniteConnector;

impl RealtimeSocketConnector for TungsteniteConnector {
    type Socket = TungsteniteSocket;

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
        reconnect_socket(
            app,
            provider,
            voice,
            instructions,
            audio_mode,
            output_mode,
            source_language,
            target_language,
        )
    }
}

#[cfg(test)]
pub(crate) mod scripted {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use serde_json::Value;

    use super::*;
    use crate::audio::omni::build_omni_session_update_for_provider_with_output_mode;

    /// One step of a scripted realtime session, consumed per `read_message`.
    #[derive(Clone, Debug)]
    pub(crate) enum ScriptStep {
        /// The provider sends this JSON event.
        Event(Value),
        /// The socket has nothing to deliver this tick (read timeout).
        Idle,
        /// The provider closes the WebSocket (drives the reconnect path).
        Close,
    }

    #[derive(Default)]
    pub(crate) struct ScriptedSharedState {
        /// Every message the worker sent, in order, across all sockets.
        pub(crate) sent: Vec<Value>,
        /// Scripts for sockets produced by future reconnects, in order.
        pub(crate) reconnect_scripts: VecDeque<Vec<ScriptStep>>,
        pub(crate) reconnect_count: usize,
    }

    pub(crate) struct ScriptedRealtimeSocket {
        script: VecDeque<ScriptStep>,
        shared: Arc<Mutex<ScriptedSharedState>>,
    }

    impl ScriptedRealtimeSocket {
        pub(crate) fn new(
            script: Vec<ScriptStep>,
            shared: Arc<Mutex<ScriptedSharedState>>,
        ) -> Self {
            Self {
                script: script.into(),
                shared,
            }
        }
    }

    fn read_timeout_error() -> tungstenite::Error {
        tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "Scripted read timed out (WouldBlock)",
        ))
    }

    impl RealtimeSocket for ScriptedRealtimeSocket {
        fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
            match self.script.pop_front() {
                Some(ScriptStep::Event(event)) => Ok(Message::Text(event.to_string().into())),
                Some(ScriptStep::Idle) | None => Err(read_timeout_error()),
                Some(ScriptStep::Close) => Ok(Message::Close(None)),
            }
        }

        fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error> {
            if let Message::Text(text) = &message {
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    self.shared.lock().expect("scripted state").sent.push(value);
                }
            }
            Ok(())
        }

    }

    /// Test connector: each reconnect pops the next scripted session.
    pub(crate) struct ScriptedConnector {
        pub(crate) shared: Arc<Mutex<ScriptedSharedState>>,
    }

    impl RealtimeSocketConnector for ScriptedConnector {
        type Socket = ScriptedRealtimeSocket;

        fn reconnect<R: tauri::Runtime>(
            &self,
            _app: &AppHandle<R>,
            provider: &ProviderDraftInput,
            voice: &str,
            instructions: &str,
            audio_mode: RealtimeAudioMode,
            output_mode: OmniOutputMode,
            source_language: &str,
            target_language: &str,
        ) -> Result<ReconnectedRealtimeSocket<Self::Socket>, String> {
            let session_update = build_omni_session_update_for_provider_with_output_mode(
                provider,
                voice,
                instructions,
                audio_mode,
                source_language,
                target_language,
                output_mode,
            );
            if crate::audio::events::is_livetranslate_route_model(provider, &provider.model) {
                crate::audio::bailian_protocol::admit_livetranslate_client_event_for_provider(
                    provider,
                    &session_update,
                )?;
            }
            let mut shared = self.shared.lock().expect("scripted state");
            shared.reconnect_count += 1;
            let script = shared
                .reconnect_scripts
                .pop_front()
                .ok_or_else(|| "scripted connector has no further sessions".to_string())?;
            shared.sent.push(session_update.clone());
            drop(shared);
            Ok(ReconnectedRealtimeSocket {
                socket: ScriptedRealtimeSocket::new(script, self.shared.clone()),
                session_update,
            })
        }
    }
}
