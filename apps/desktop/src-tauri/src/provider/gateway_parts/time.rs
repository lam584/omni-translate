/// Second-precision `unix:` marker; the single implementation lives in
/// `crate::shared::time` (this module re-exports it for gateway callers).
pub(crate) use crate::shared::time::now_unix_seconds_marker;

pub(crate) fn normalize_timestamp(timestamp: &str) -> String {
    timestamp.replace(':', "-")
}
