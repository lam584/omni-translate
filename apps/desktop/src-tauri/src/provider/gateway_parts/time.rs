use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_marker() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("unix:{}", duration.as_secs()),
        Err(_) => "unix:0".to_string(),
    }
}

pub(crate) fn normalize_timestamp(timestamp: &str) -> String {
    timestamp.replace(':', "-")
}
