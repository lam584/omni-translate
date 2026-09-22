use super::*;

/// Keep the receiver lease across the ownership check and receive so a new
/// subscriber cannot drain or claim this queue in between them.
pub(super) fn receive_owned_source_payload(
    state: &Arc<Mutex<BridgeState>>,
    source_rx: &Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    generation: u64,
    receive: impl FnOnce(&mpsc::Receiver<Vec<u8>>) -> Result<Vec<u8>, mpsc::RecvTimeoutError>,
) -> Option<Result<Vec<u8>, mpsc::RecvTimeoutError>> {
    let receiver = source_rx.lock().unwrap();
    let current = state.lock().unwrap();
    if !source_subscription_is_owner(&current, generation) {
        return None;
    }
    // Capture/dispatch need BridgeState before enqueueing. Waiting with this
    // guard held forces the producer to wait for every empty receive timeout.
    drop(current);
    let payload = receive(&receiver);
    if !source_subscription_is_owner(&state.lock().unwrap(), generation) {
        return None;
    }
    Some(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Arc<Mutex<BridgeState>> {
        let mut state = BridgeState::new("0.1.0".to_string());
        state.source_subscriber_active = true;
        state.source_generation = 7;
        state.source_capture_mode = SourceCaptureMode::ProcessExclusion;
        state.source_monitor_playback_enabled = false;
        Arc::new(Mutex::new(state))
    }

    #[test]
    fn source_delivery_regression_empty_receive_allows_capture_to_publish() {
        let state = state();
        let (source_tx, source_rx) = mpsc::sync_channel(1);
        let source_rx = Arc::new(Mutex::new(source_rx));
        let (playback_tx, _playback_rx) = mpsc::sync_channel(1);
        let payload = vec![0; OMNI_SOURCE_CHUNK_BYTES];
        let actual = receive_owned_source_payload(&state, &source_rx, 7, |receiver| {
            // Deterministic lock-availability assertion, not a scheduling deadline.
            assert!(state.try_lock().is_ok(), "source wait holds the producer's BridgeState lock");
            assert!(source_rx.try_lock().is_err(), "the receiver lease must survive the wait");
            assert!(dispatch_source_frame(&state, Path::new("."), &playback_tx,
                &source_tx, 7, SourceCaptureMode::ProcessExclusion, payload.clone()));
            receiver.recv_timeout(Duration::from_millis(25))
        });
        assert_eq!(actual, Some(Ok(payload)));
    }

    #[test]
    fn source_delivery_regression_rejects_nonowner_before_receiving() {
        let state = state();
        let (_tx, rx) = mpsc::sync_channel(1);
        let rx = Arc::new(Mutex::new(rx));
        assert_eq!(receive_owned_source_payload(&state, &rx, 6, |_| {
            panic!("old owner must not consume the new owner's payload")
        }), None);
    }

    #[test]
    fn source_delivery_regression_revoked_owner_cannot_publish_received_payload() {
        for deactivate in [false, true] {
            let state = state();
            let (_tx, rx) = mpsc::sync_channel(1);
            let rx = Arc::new(Mutex::new(rx));
            let result = receive_owned_source_payload(&state, &rx, 7, |_| {
                let mut current = state.try_lock().expect("state must be available during receive");
                if deactivate { current.source_subscriber_active = false; }
                else { current.source_generation += 1; }
                Ok(vec![1, 2, 3, 4])
            });
            assert_eq!(result, None, "revoked payload must not be relabelled as current");
        }
    }

    #[test]
    fn source_delivery_regression_preserves_timeout_and_disconnect() {
        for outcome in [mpsc::RecvTimeoutError::Timeout, mpsc::RecvTimeoutError::Disconnected] {
            let state = state();
            let (_tx, rx) = mpsc::sync_channel(1);
            let rx = Arc::new(Mutex::new(rx));
            assert_eq!(receive_owned_source_payload(&state, &rx, 7, |_| Err(outcome)), Some(Err(outcome)));
        }
    }
}
