const ROUTE_INPUT_COMPLETION_TIMEOUT: Duration = Duration::from_millis(1_500);

impl AudioRouteSupervisor<'_> {
    pub(crate) fn complete_input(
        &self,
        direction: &str,
    ) -> Result<RouteInputCompletionEvidence, String> {
        if let Some(request_tx) = self
            .store
            .take_route_input_completion_sender(direction)
        {
            let (ack_tx, ack_rx) = mpsc::channel();
            request_tx
                .send(RouteInputCompletionRequest { ack_tx })
                .map_err(|error| {
                    format!(
                        "audio capture input-completion request failed for {direction}: {error} | code: watch.capture-input-fence-failed"
                    )
                })?;
            return ack_rx
                .recv_timeout(ROUTE_INPUT_COMPLETION_TIMEOUT)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => format!(
                        "audio capture input-completion fence timed out for {direction} after {}ms | code: watch.capture-input-fence-timeout",
                        ROUTE_INPUT_COMPLETION_TIMEOUT.as_millis()
                    ),
                    mpsc::RecvTimeoutError::Disconnected => format!(
                        "audio capture input-completion fence disconnected for {direction} | code: watch.capture-input-fence-disconnected"
                    ),
                })?;
        }

        self.stop(direction)?;
        Ok(RouteInputCompletionEvidence {
            observed_at_unix_ms: unix_ms(),
            provider_input_closed_source_sequence: 0,
            provider_sender_released: true,
            status_consumer_retained: false,
            padded_tail_bytes: 0,
        })
    }
}
