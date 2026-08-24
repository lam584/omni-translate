use std::time::{Duration, Instant};

const MIN_BASE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BASE_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TOTAL_TIMEOUT: Duration = Duration::from_secs(90);
pub(super) const OMNI_CANCEL_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ResponseStallAction {
    None,
    Cancel { response_id: String },
    Reconnect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ResponseDeadlineBudget {
    pub(super) first_output: Duration,
    pub(super) no_progress: Duration,
    pub(super) total: Duration,
}

impl ResponseDeadlineBudget {
    pub(super) fn from_provider_timeout_ms(timeout_ms: u64) -> Self {
        let base = Duration::from_millis(timeout_ms).clamp(MIN_BASE_TIMEOUT, MAX_BASE_TIMEOUT);
        Self {
            first_output: base,
            no_progress: base,
            total: base.saturating_mul(3).clamp(MIN_TOTAL_TIMEOUT, MAX_TOTAL_TIMEOUT),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct ResponseLifecycle {
    active: bool,
    response_id: Option<String>,
    started_at: Option<Instant>,
    last_progress_at: Option<Instant>,
    output_observed: bool,
    cancel_sent_at: Option<Instant>,
}

impl ResponseLifecycle {
    pub(super) fn begin(&mut self, response_id: Option<&str>, now: Instant) {
        let response_id = normalized_id(response_id);
        if self.active {
            if self.response_id.is_none() {
                self.response_id = response_id;
            }
            return;
        }
        self.active = true;
        self.response_id = response_id;
        self.started_at = Some(now);
        self.last_progress_at = None;
        self.output_observed = false;
        self.cancel_sent_at = None;
    }

    pub(super) fn progress(&mut self, response_id: Option<&str>, now: Instant) {
        self.begin(response_id, now);
        self.output_observed = true;
        self.last_progress_at = Some(now);
    }

    pub(super) fn complete(&mut self, response_id: Option<&str>) {
        let response_id = normalized_id(response_id);
        if response_id.is_some()
            && self.response_id.is_some()
            && response_id != self.response_id
        {
            return;
        }
        *self = Self::default();
    }

    pub(super) fn action(
        &self,
        now: Instant,
        budget: ResponseDeadlineBudget,
        allow_cancel: bool,
    ) -> ResponseStallAction {
        if !self.active {
            return ResponseStallAction::None;
        }
        if let Some(cancel_sent_at) = self.cancel_sent_at {
            return if now.saturating_duration_since(cancel_sent_at) >= OMNI_CANCEL_GRACE {
                ResponseStallAction::Reconnect
            } else {
                ResponseStallAction::None
            };
        }
        let Some(started_at) = self.started_at else {
            return ResponseStallAction::None;
        };
        let total_expired = now.saturating_duration_since(started_at) >= budget.total;
        let progress_expired = if self.output_observed {
            self.last_progress_at.is_some_and(|progress_at| {
                now.saturating_duration_since(progress_at) >= budget.no_progress
            })
        } else {
            now.saturating_duration_since(started_at) >= budget.first_output
        };
        if !total_expired && !progress_expired {
            return ResponseStallAction::None;
        }
        if allow_cancel {
            if let Some(response_id) = self.response_id.clone() {
                return ResponseStallAction::Cancel { response_id };
            }
        }
        ResponseStallAction::Reconnect
    }

    pub(super) fn mark_cancel_sent(&mut self, now: Instant) {
        if self.cancel_sent_at.is_none() {
            self.cancel_sent_at = Some(now);
        }
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }
}

fn normalized_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "(none)")
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_budget_is_clamped_and_total_is_three_times_base() {
        let low = ResponseDeadlineBudget::from_provider_timeout_ms(1_000);
        assert_eq!(low.first_output, Duration::from_secs(5));
        assert_eq!(low.total, Duration::from_secs(30));

        let normal = ResponseDeadlineBudget::from_provider_timeout_ms(20_000);
        assert_eq!(normal.no_progress, Duration::from_secs(20));
        assert_eq!(normal.total, Duration::from_secs(60));

        let high = ResponseDeadlineBudget::from_provider_timeout_ms(120_000);
        assert_eq!(high.first_output, Duration::from_secs(30));
        assert_eq!(high.total, Duration::from_secs(90));
    }

    #[test]
    fn livetranslate_stall_reconnects_without_cancel() {
        let now = Instant::now();
        let budget = ResponseDeadlineBudget::from_provider_timeout_ms(5_000);
        let mut lifecycle = ResponseLifecycle::default();
        lifecycle.begin(Some("response-live"), now);

        assert_eq!(
            lifecycle.action(now + Duration::from_secs(5), budget, false),
            ResponseStallAction::Reconnect
        );
    }

    #[test]
    fn omni_cancel_is_once_and_reconnect_waits_for_two_second_grace() {
        let now = Instant::now();
        let budget = ResponseDeadlineBudget::from_provider_timeout_ms(5_000);
        let mut lifecycle = ResponseLifecycle::default();
        lifecycle.begin(Some("response-omni"), now);
        let stalled_at = now + Duration::from_secs(5);

        assert_eq!(
            lifecycle.action(stalled_at, budget, true),
            ResponseStallAction::Cancel {
                response_id: "response-omni".to_string()
            }
        );
        lifecycle.mark_cancel_sent(stalled_at);
        assert_eq!(
            lifecycle.action(stalled_at + Duration::from_millis(1_999), budget, true),
            ResponseStallAction::None
        );
        assert_eq!(
            lifecycle.action(stalled_at + OMNI_CANCEL_GRACE, budget, true),
            ResponseStallAction::Reconnect
        );
    }

    #[test]
    fn omni_without_known_active_response_id_never_sends_cancel() {
        let now = Instant::now();
        let budget = ResponseDeadlineBudget::from_provider_timeout_ms(5_000);
        let mut lifecycle = ResponseLifecycle::default();
        lifecycle.begin(None, now);

        assert_eq!(
            lifecycle.action(now + Duration::from_secs(5), budget, true),
            ResponseStallAction::Reconnect
        );
    }
}
