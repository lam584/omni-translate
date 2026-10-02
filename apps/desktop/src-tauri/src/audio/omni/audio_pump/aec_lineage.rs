//! Bind the sideband dispatch FIFO on every actual channel receive, not on send.
use super::*;

pub(super) fn receive_with_lineage(
    audio_rx: &mpsc::Receiver<Vec<u8>>, disconnected: &mut bool, store: &AudioStateStore,
) -> Result<Option<Vec<u8>>, String> {
    let raw = try_receive_provider_input(audio_rx, disconnected);
    if let Some(raw) = &raw { store.bind_aec_provider_receive(raw)?; }
    Ok(raw)
}

pub(super) fn observe_fence_with_lineage(
    audio_rx: &mpsc::Receiver<Vec<u8>>, queue: &mut VecDeque<Vec<u8>>,
    disconnected: &mut bool, store: &AudioStateStore,
) -> Result<(), String> {
    if let Some(raw) = receive_with_lineage(audio_rx, disconnected, store)? { queue.push_back(raw); }
    Ok(())
}
