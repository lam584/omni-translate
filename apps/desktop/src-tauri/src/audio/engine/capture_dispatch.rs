use super::*;

pub(super) fn process_captured_chunk(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    processor: &mut RouteProcessor,
    stt_sender: &Option<mpsc::Sender<Vec<u8>>>,
    chunk: Vec<u8>,
    queued_bytes: usize,
) -> Result<(), String> {
    process_captured_chunk_with_provenance(app, store, direction, processor, stt_sender, chunk, queued_bytes, None)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn process_captured_chunk_with_provenance(
    app: &AppHandle, store: &AudioStateStore, direction: &str, processor: &mut RouteProcessor,
    stt_sender: &Option<mpsc::Sender<Vec<u8>>>, chunk: Vec<u8>, queued_bytes: usize,
    provenance: Option<crate::audio::aec_diagnostic_tap::AecPostPacket>,
) -> Result<(), String> {
    if let Some(stt_tx) = stt_sender {
        store.dispatch_aec_provider_packet(provenance, &chunk)?;
        if let Err(error) = stt_tx.send(chunk.clone()) {
            let message = format!("audio route sender unavailable for {direction}: {error}");
            let _ = diag_log_detail(
                app,
                "audio",
                "error",
                "watch_mode.omni_sender_unavailable",
                format!("direction={direction} error={error}"),
            );
            return Err(format!("{message} | recommended: restart-route"));
        }
    }
    let update = processor.ingest_chunk(&chunk, queued_bytes);
    store.update_route_metrics(
        direction,
        &update.capture_state,
        &update.pre_buffer_state,
        &update.vad_state,
        update.buffer_ahead_ms,
        update.frames_captured,
        update.last_energy_db,
        Some(now_unix_millis_marker()),
        update.active_segment_id.clone(),
    );
    if let Some(segment) = update.finalized_segment {
        store.increment_segment_count(direction);
        store.cache_segment_audio(segment.audio);
        if should_push_placeholder_cue(direction, stt_sender.is_some()) {
            store.push_subtitle_cue(segment.cue);
        }
    }
    emit_audio_snapshot(app, store)
}

/// Whether a finalized VAD segment should surface a placeholder subtitle cue
/// ("检测到麦克风片段 N"). These exist only to show microphone activity when
/// no recognition session is attached: inbound never shows them (loopback can
/// be legitimately silent), and once outbound has an ASR/realtime sender the
/// session emits the real transcript cues, so the placeholder would otherwise
/// pollute the translate queue with untranslatable diagnostic text.
pub(super) fn should_push_placeholder_cue(direction: &str, has_recognition_sender: bool) -> bool {
    direction != "inbound" && !has_recognition_sender
}
