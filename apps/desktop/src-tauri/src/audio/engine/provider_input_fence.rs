fn observe_bridge_input_completion_request(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    input_completion_rx: &mpsc::Receiver<RouteInputCompletionRequest>,
    processor: &mut RouteProcessor,
    sample_queue: &mut VecDeque<u8>,
    stt_sender: &mut Option<mpsc::Sender<Vec<u8>>>,
    provider_input_completed: &mut bool,
) -> Result<(), String> {
    let request = match input_completion_rx.try_recv() {
        Ok(request) => request,
        Err(mpsc::TryRecvError::Empty) => return Ok(()),
        Err(mpsc::TryRecvError::Disconnected) if *provider_input_completed => return Ok(()),
        Err(mpsc::TryRecvError::Disconnected) => {
            return Err(
                "Bridge input-completion request owner disconnected before fencing Provider input | code: watch.capture-input-fence-disconnected"
                    .to_string(),
            )
        }
    };
    let completion = complete_bridge_provider_input(
        app,
        store,
        direction,
        processor,
        sample_queue,
        stt_sender,
        *provider_input_completed,
    );
    if completion.is_ok() {
        *provider_input_completed = true;
    }
    let result_for_requester = completion.clone();
    request.ack_tx.send(result_for_requester).map_err(|error| {
        format!(
            "Bridge input-completion acknowledgement owner disconnected: {error} | code: watch.capture-input-fence-disconnected"
        )
    })?;
    completion.map(|_| ())
}

fn complete_bridge_provider_input(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    processor: &mut RouteProcessor,
    sample_queue: &mut VecDeque<u8>,
    stt_sender: &mut Option<mpsc::Sender<Vec<u8>>>,
    already_completed: bool,
) -> Result<RouteInputCompletionEvidence, String> {
    if already_completed {
        return Err(
            "Bridge Provider input-completion fence was requested more than once | code: watch.capture-input-fence-duplicate"
                .to_string(),
        );
    }
    let chunk_len = CHUNK_FRAMES * CHANNEL_COUNT * std::mem::size_of::<f32>();
    for chunk in drain_sample_chunks(sample_queue, chunk_len) {
        process_captured_chunk(
            app,
            store,
            direction,
            processor,
            stt_sender,
            chunk,
            sample_queue.len(),
        )?;
    }
    let padded_tail_bytes = if sample_queue.is_empty() {
        0
    } else {
        let tail_bytes = sample_queue.len();
        let padding = chunk_len.saturating_sub(tail_bytes);
        let mut chunk = sample_queue.drain(..).collect::<Vec<_>>();
        chunk.resize(chunk_len, 0);
        process_captured_chunk(
            app,
            store,
            direction,
            processor,
            stt_sender,
            chunk,
            0,
        )?;
        padding
    };
    release_bridge_provider_sender(stt_sender, sample_queue)?;
    Ok(RouteInputCompletionEvidence {
        observed_at_unix_ms: unix_ms(),
        provider_input_closed_source_sequence: 0,
        provider_sender_released: true,
        status_consumer_retained: true,
        padded_tail_bytes,
    })
}

fn release_bridge_provider_sender(
    stt_sender: &mut Option<mpsc::Sender<Vec<u8>>>,
    sample_queue: &VecDeque<u8>,
) -> Result<(), String> {
    if !sample_queue.is_empty() {
        return Err(
            "Bridge Provider input sender cannot close with a non-empty local sample queue"
                .to_string(),
        );
    }
    stt_sender.take().ok_or_else(|| {
        "Bridge Provider input sender was already released before input-completion authority"
            .to_string()
    })?;
    Ok(())
}

#[cfg(test)]
mod provider_input_fence_tests {
    use super::release_bridge_provider_sender;
    use std::collections::VecDeque;
    use std::sync::mpsc;

    #[test]
    fn bridge_input_fence_preserves_queued_send_then_disconnects_provider_input() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        tx.send(vec![7, 8, 9]).expect("last capture send crosses boundary");
        let mut sender = Some(tx);
        release_bridge_provider_sender(&mut sender, &VecDeque::new())
            .expect("empty local queue releases sole producer sender");

        assert_eq!(rx.recv().expect("queued final chunk drains"), vec![7, 8, 9]);
        assert_eq!(rx.try_recv(), Err(mpsc::TryRecvError::Disconnected));
    }

    #[test]
    fn bridge_input_fence_rejects_a_nonempty_local_sample_queue() {
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();
        let mut sender = Some(tx);
        let queue = VecDeque::from([1_u8]);
        assert!(release_bridge_provider_sender(&mut sender, &queue).is_err());
        assert!(sender.is_some(), "failed fence must retain producer ownership");
    }
}
