//! Dialogue has response terminals, not LiveTranslate's session.finish handshake.
//! Fence local input, drain the current turn, then cancel only on a bounded timeout.
use std::time::{Duration, Instant};

const QUIET_SETTLE: Duration = Duration::from_millis(800);
const CANCEL_AFTER: Duration = Duration::from_secs(10);
const HARD_LIMIT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct DialogueShutdown {
    enabled: bool,
    requested_at: Option<Instant>,
    quiet_since: Option<Instant>,
    cancel_sent: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DrainAction { Pending, CancelResponse, Complete }
impl DialogueShutdown {
    pub(super) fn new(enabled: bool) -> Self { Self { enabled, ..Self::default() } }
    pub(super) fn request(&mut self, now: Instant) -> bool {
        if !self.enabled { return false; }
        self.requested_at.get_or_insert(now); true
    }
    pub(super) fn is_requested(&self) -> bool { self.requested_at.is_some() }
    pub(super) fn observe(&mut self, now: Instant, input_fenced: bool, turn_active: bool, response_active: bool) -> Result<DrainAction, String> {
        let Some(start) = self.requested_at else { return Ok(DrainAction::Pending); };
        if now.duration_since(start) >= HARD_LIMIT {
            return Err("model_protocol.terminal_missing: dialogue shutdown did not drain the input/response terminal before the deadline".to_string());
        }
        if input_fenced && !turn_active && !response_active {
            let quiet = self.quiet_since.get_or_insert(now);
            if now.duration_since(*quiet) >= QUIET_SETTLE { return Ok(DrainAction::Complete); }
        } else { self.quiet_since = None; }
        if input_fenced && response_active && !self.cancel_sent && now.duration_since(start) >= CANCEL_AFTER {
            self.cancel_sent = true; return Ok(DrainAction::CancelResponse);
        }
        Ok(DrainAction::Pending)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn stop_drains_input_and_response_before_quiet_terminal() {
        let t = Instant::now(); let mut s = DialogueShutdown::new(true); assert!(s.request(t));
        assert_eq!(s.observe(t, false, false, false).unwrap(), DrainAction::Pending);
        assert_eq!(s.observe(t+Duration::from_secs(1), true, false, false).unwrap(), DrainAction::Pending);
        assert_eq!(s.observe(t+Duration::from_millis(1700), true, false, true).unwrap(), DrainAction::Pending);
        assert_eq!(s.observe(t+Duration::from_secs(2), true, false, false).unwrap(), DrainAction::Pending);
        assert_eq!(s.observe(t+Duration::from_millis(2800), true, false, false).unwrap(), DrainAction::Complete);
    }
    #[test] fn late_cancel_terminal_drains_within_own_deadline() {
        let t = Instant::now(); let mut s = DialogueShutdown::new(true); s.request(t);
        assert_eq!(s.observe(t + Duration::from_secs(10), true, false, true).unwrap(), DrainAction::CancelResponse);
        assert_eq!(s.observe(t + Duration::from_millis(12500), true, false, false).unwrap(), DrainAction::Pending);
        assert_eq!(s.observe(t + Duration::from_millis(13300), true, false, false).unwrap(), DrainAction::Complete);
    }
    #[test] fn missing_terminal_cancels_once_then_fails_not_success() {
        let t=Instant::now(); let mut s=DialogueShutdown::new(true); s.request(t);
        assert_eq!(s.observe(t+Duration::from_secs(10),true,false,true).unwrap(), DrainAction::CancelResponse);
        assert_eq!(s.observe(t+Duration::from_secs(11),true,false,true).unwrap(), DrainAction::Pending);
        assert!(s.observe(t+Duration::from_secs(15),true,false,true).unwrap_err().contains("terminal_missing"));
        assert!(!DialogueShutdown::new(false).request(t));
    }
}
