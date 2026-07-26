use chrono::Local;

/// The repository-wide log timestamp: `yyyy-MM-dd HH:mm:ss.fff`, local time.
///
/// Leading-timestamp parsing in `scripts/testing` (startup readiness, the
/// watch-mode live timeline and `textAfterLocalTimestamp` in the report
/// generator) depends on this exact shape — never change it without updating
/// those parsers and their tests first.
pub fn format_log_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

#[cfg(test)]
mod tests {
    use super::format_log_timestamp;

    #[test]
    fn timestamp_matches_the_contract_shape() {
        let stamp = format_log_timestamp();
        let bytes = stamp.as_bytes();
        assert_eq!(stamp.len(), 23, "yyyy-MM-dd HH:mm:ss.fff is 23 chars: {stamp}");
        assert_eq!(bytes[4], b'-');
        assert_eq!(bytes[7], b'-');
        assert_eq!(bytes[10], b' ');
        assert_eq!(bytes[13], b':');
        assert_eq!(bytes[16], b':');
        assert_eq!(bytes[19], b'.');
    }
}
