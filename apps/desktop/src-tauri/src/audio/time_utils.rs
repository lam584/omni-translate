//! Audio-domain time helpers. The marker implementations live in
//! `crate::shared::time`; these wrappers keep the audio-local names that
//! the pipeline uses pervasively while making the millisecond semantics
//! explicit at the single definition site.

/// Current unix time in milliseconds.
pub(crate) use crate::shared::time::now_unix_millis as unix_ms;

/// `unix-ms:` marker for an explicit millisecond value.
pub(crate) use crate::shared::time::unix_millis_marker as ms_marker;

/// `unix-ms:` marker for the current instant.
pub(crate) use crate::shared::time::now_unix_millis_marker;

#[cfg(test)]
mod tests {
    use super::{ms_marker, now_unix_millis_marker};

    /// The frontend parser (utils/runtime-timestamp.ts) pins `unix:` to
    /// seconds and `unix-ms:` to milliseconds; every millisecond marker
    /// emitted by the audio pipeline must therefore use the `unix-ms:` prefix.
    #[test]
    fn millisecond_markers_use_the_unix_ms_prefix() {
        assert_eq!(ms_marker(1_779_974_788_817), "unix-ms:1779974788817");
        assert!(now_unix_millis_marker().starts_with("unix-ms:"));
    }
}
