use std::time::{SystemTime, UNIX_EPOCH};

pub fn unix_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

pub fn now_marker() -> String {
    ms_marker(unix_ms())
}

pub fn ms_marker(value: u64) -> String {
    format!("unix-ms:{}", value)
}

#[cfg(test)]
mod tests {
    use super::{ms_marker, now_marker};

    /// The frontend parser (utils/runtime-timestamp.ts) pins `unix:` to
    /// seconds and `unix-ms:` to milliseconds; every millisecond marker
    /// emitted by the audio pipeline must therefore use the `unix-ms:` prefix.
    #[test]
    fn millisecond_markers_use_the_unix_ms_prefix() {
        assert_eq!(ms_marker(1_779_974_788_817), "unix-ms:1779974788817");
        assert!(now_marker().starts_with("unix-ms:"));
    }
}
