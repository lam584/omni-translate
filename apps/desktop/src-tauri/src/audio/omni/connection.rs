use std::net::TcpStream;
use std::time::SystemTime;

use tungstenite::stream::MaybeTlsStream;
use tungstenite::WebSocket;

use super::{set_socket_read_timeout, set_socket_write_timeout};

/// Owns a connected Omni WebSocket after connection setup has completed.
pub(super) struct OmniConnection {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    connected_in_ms: u64,
}

impl OmniConnection {
    pub(super) fn from_connected(
        mut socket: WebSocket<MaybeTlsStream<TcpStream>>,
        started_at: SystemTime,
    ) -> Self {
        set_socket_write_timeout(&mut socket);
        set_socket_read_timeout(&mut socket);
        Self {
            socket,
            connected_in_ms: started_at.elapsed().unwrap_or_default().as_millis() as u64,
        }
    }

    pub(super) fn into_parts(self) -> (WebSocket<MaybeTlsStream<TcpStream>>, u64) {
        (self.socket, self.connected_in_ms)
    }
}
