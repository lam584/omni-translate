//! The single implementation of the frontend-parsed timestamp markers.
//!
//! Two marker grammars exist on the wire and the renderer's
//! `utils/runtime-timestamp.ts` parses both by prefix:
//! - `unix:<seconds>` — second precision, used by runtime/diagnostics/
//!   provider metadata timestamps.
//! - `unix-ms:<milliseconds>` — millisecond precision, used by the audio
//!   pipeline where cue timing needs sub-second resolution.
//!
//! Mixing the units behind one name is exactly the bug this module retires:
//! four identically-named `now_marker` implementations with two different
//! semantics. Pick the marker by unit, explicitly.

use std::time::{SystemTime, UNIX_EPOCH};

/// `unix:<seconds>` — second-precision marker.
pub(crate) fn now_unix_seconds_marker() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("unix:{}", duration.as_secs()),
        Err(_) => "unix:0".to_string(),
    }
}

/// `unix-ms:<milliseconds>` — millisecond-precision marker.
pub(crate) fn now_unix_millis_marker() -> String {
    unix_millis_marker(now_unix_millis())
}

/// Format an explicit millisecond value as a `unix-ms:` marker.
pub(crate) fn unix_millis_marker(value: u64) -> String {
    format!("unix-ms:{}", value)
}

/// Current unix time in milliseconds (0 if the clock is before the epoch).
pub(crate) fn now_unix_millis() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_keep_their_prefix_grammar_and_units() {
        let seconds = now_unix_seconds_marker();
        let millis = now_unix_millis_marker();
        assert!(seconds.starts_with("unix:"), "{seconds}");
        assert!(millis.starts_with("unix-ms:"), "{millis}");

        let seconds_value: u64 = seconds["unix:".len()..].parse().expect("seconds value");
        let millis_value: u64 = millis["unix-ms:".len()..].parse().expect("millis value");
        // The millisecond marker must actually carry milliseconds: it is three
        // orders of magnitude larger than the second marker of the same instant.
        assert!(millis_value / 1000 >= seconds_value - 1);
        assert!(millis_value / 1000 <= seconds_value + 1);

        assert_eq!(unix_millis_marker(1234), "unix-ms:1234");
    }
}
