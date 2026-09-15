use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RouteJoinWaitError {
    Timeout,
    Disconnected,
}

pub(super) fn wait_for_route_join(
    done_rx: &mpsc::Receiver<()>,
    timeout: Duration,
) -> Result<(), RouteJoinWaitError> {
    match done_rx.recv_timeout(timeout) {
        Ok(()) => Ok(()),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(RouteJoinWaitError::Timeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(RouteJoinWaitError::Disconnected),
    }
}

pub(super) fn route_join_terminal_result(
    direction: &str,
    join_wait: Result<(), RouteJoinWaitError>,
) -> Result<(), String> {
    match join_wait {
        Ok(()) => Ok(()),
        Err(RouteJoinWaitError::Timeout) => Err(format!(
            "audio capture producer did not join for {direction} within 1500ms | code: watch.capture-join-timeout"
        )),
        Err(RouteJoinWaitError::Disconnected) => Err(format!(
            "audio capture producer join receipt disconnected for {direction} | code: watch.capture-join-disconnected"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_join_timeout_is_not_a_successful_stop_boundary() {
        let (_tx, rx) = mpsc::channel::<()>();
        assert_eq!(
            wait_for_route_join(&rx, Duration::ZERO),
            Err(RouteJoinWaitError::Timeout)
        );
    }

    #[test]
    fn capture_join_receipt_channel_disconnect_is_not_a_successful_stop_boundary() {
        let (tx, rx) = mpsc::channel::<()>();
        drop(tx);
        assert_eq!(
            wait_for_route_join(&rx, Duration::ZERO),
            Err(RouteJoinWaitError::Disconnected)
        );
    }

    #[test]
    fn route_stop_cannot_resolve_success_after_capture_join_timeout() {
        assert!(
            route_join_terminal_result("inbound", Err(RouteJoinWaitError::Timeout)).is_err(),
            "a live capture producer cannot be hidden behind stream_bound=false"
        );
        assert!(
            route_join_terminal_result("inbound", Err(RouteJoinWaitError::Disconnected)).is_err(),
            "a missing join receipt cannot authorize terminal success"
        );
    }
}
