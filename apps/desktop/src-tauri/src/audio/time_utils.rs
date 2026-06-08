use std::time::{SystemTime, UNIX_EPOCH};

pub fn unix_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

pub fn now_marker() -> String {
    format!("unix:{}", unix_ms())
}

pub fn ms_marker(value: u64) -> String {
    format!("unix-ms:{}", value)
}
