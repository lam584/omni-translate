//! Shared WebSocket plumbing for the realtime speech links (stt / omni /
//! openai_realtime / gemini_live): socket timeout setup, reconnect backoff,
//! the "reconnecting" subtitle cue, and recursive server-event text
//! collection. Per-link wording, cue-id prefixes, and timeout values stay
//! with the callers; only the mechanics live here.

use std::net::TcpStream;
use std::time::Duration;

use serde_json::Value;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::WebSocket;

use super::contracts::{SubtitleCueRuntime, SubtitleTranslationStateRuntime};
use super::state::AudioStateStore;
use super::time_utils::{ms_marker, unix_ms};

pub(crate) type WsSocket = WebSocket<MaybeTlsStream<TcpStream>>;

pub(crate) fn server_event_type<'a>(event: &'a Value, fallback: &'a str) -> &'a str {
    event.pointer("/type").and_then(Value::as_str).unwrap_or(fallback)
}

pub(crate) fn server_text_delta(event: &Value) -> Option<&str> {
    event.pointer("/delta").and_then(Value::as_str)
        .or_else(|| event.pointer("/text").and_then(Value::as_str))
        .or_else(|| event.pointer("/transcript").and_then(Value::as_str))
}

/// Apply blocking read/write timeouts to the TCP stream under the TLS
/// wrapper. `None` leaves that direction untouched.
pub(crate) fn set_socket_timeouts(
    socket: &mut WsSocket,
    read: Option<Duration>,
    write: Option<Duration>,
) {
    let stream = match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream,
        MaybeTlsStream::Rustls(stream) => stream.get_mut(),
        _ => return,
    };
    if let Some(read) = read {
        let _ = stream.set_read_timeout(Some(read));
    }
    if let Some(write) = write {
        let _ = stream.set_write_timeout(Some(write));
    }
}

/// Exponential reconnect backoff used by the stt and omni links:
/// 2^retry_count seconds, capped at 10 s (first retry sleeps 2 s).
pub(crate) fn backoff_delay(retry_count: usize) -> Duration {
    let seconds = (1u64 << retry_count).min(10);
    Duration::from_secs(seconds)
}

/// Backoff variant used by the openai/gemini links where the first attempt
/// sleeps 1 s: 2^(attempt-1) seconds, capped at 10 s.
pub(crate) fn attempt_backoff_delay(attempt: usize) -> Duration {
    Duration::from_secs((1u64 << attempt.saturating_sub(1)).min(10))
}

/// Push a committed "reconnecting" subtitle cue to the overlay. Each link
/// supplies its own cue-id prefix and user-facing text.
pub(crate) fn push_reconnecting_cue(
    store: &AudioStateStore,
    cue_id_prefix: &str,
    source_text: String,
) {
    let cue = SubtitleCueRuntime {
        cue_id: format!("{cue_id_prefix}-{}", unix_ms()),
        revision: None,
        sequence: None,
        route_direction: "inbound".to_string(),
        source_text,
        display_source_text: String::new(),
        display_segments: Vec::new(),
        translated_text: String::new(),
        started_at: ms_marker(unix_ms()),
        ended_at: ms_marker(unix_ms()),
        committed: true,
        translation_committed: true,
        translation_state: Some(SubtitleTranslationStateRuntime::Final),
    };
    store.push_subtitle_cue(cue);
}

/// Depth-first concatenation of every `"text"` string field in a server
/// event payload; `include_transcript` also accepts `"transcript"` fields
/// (OpenAI response payloads carry both spellings).
pub(crate) fn collect_text_fields(value: &Value, include_transcript: bool) -> String {
    fn walk(value: &Value, include_transcript: bool, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut text = map.get("text").and_then(Value::as_str);
                if text.is_none() && include_transcript {
                    text = map.get("transcript").and_then(Value::as_str);
                }
                if let Some(text) = text {
                    out.push_str(text);
                }
                for child in map.values() {
                    walk(child, include_transcript, out);
                }
            }
            Value::Array(items) => {
                for child in items {
                    walk(child, include_transcript, out);
                }
            }
            _ => {}
        }
    }

    let mut out = String::new();
    walk(value, include_transcript, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stt_backoff_doubles_and_caps_at_ten_seconds() {
        assert_eq!(backoff_delay(0), Duration::from_secs(1));
        assert_eq!(backoff_delay(1), Duration::from_secs(2));
        assert_eq!(backoff_delay(3), Duration::from_secs(8));
        assert_eq!(backoff_delay(4), Duration::from_secs(10));
        // Large retry counts must stay capped instead of shifting into
        // overflow territory.
        assert_eq!(backoff_delay(40), Duration::from_secs(10));
    }

    #[test]
    fn attempt_backoff_starts_at_one_second_and_caps_at_ten() {
        // Attempt numbering starts at 1; 0 must not underflow the shift.
        assert_eq!(attempt_backoff_delay(0), Duration::from_secs(1));
        assert_eq!(attempt_backoff_delay(1), Duration::from_secs(1));
        assert_eq!(attempt_backoff_delay(2), Duration::from_secs(2));
        assert_eq!(attempt_backoff_delay(5), Duration::from_secs(10));
        assert_eq!(attempt_backoff_delay(60), Duration::from_secs(10));
    }

    #[test]
    fn reconnecting_cue_is_committed_and_prefixed() {
        let store = AudioStateStore::new();
        push_reconnecting_cue(&store, "omni-reconnect", "正在重新连接…".to_string());

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id.starts_with("omni-reconnect-"))
            .expect("reconnect cue must reach the overlay");
        assert!(cue.committed, "progress cues must not linger as active partials");
        assert_eq!(cue.source_text, "正在重新连接…");
        assert_eq!(cue.route_direction, "inbound");
    }

    #[test]
    fn collect_text_fields_walks_nested_payloads_depth_first() {
        let event = json!({
            "response": {
                "output": [
                    { "content": [ { "text": "你好" }, { "transcript": "hello" } ] },
                    { "text": "世界" }
                ]
            }
        });

        assert_eq!(collect_text_fields(&event, false), "你好世界");
        assert_eq!(collect_text_fields(&event, true), "你好hello世界");
        // Non-object payloads collapse to empty rather than panicking.
        assert_eq!(collect_text_fields(&json!("bare string"), true), "");
        assert_eq!(collect_text_fields(&json!(null), true), "");
    }
}
