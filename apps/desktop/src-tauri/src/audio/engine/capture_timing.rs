fn active_render_delay_frames(
    playback_active: bool,
    endpoint_padding_frames: Option<u32>,
    reference_lead_frames: Option<u32>,
) -> (Option<u32>, Option<u32>) {
    if playback_active {
        (endpoint_padding_frames, reference_lead_frames)
    } else {
        (None, None)
    }
}

fn capture_queue_head_clock(
    packet_device_frame_index: u64,
    packet_qpc_100ns: u64,
    queued_bytes_before_read: usize,
    block_align: usize,
    sample_rate_hz: u32,
) -> (u64, u64, u64) {
    if block_align == 0 || sample_rate_hz == 0 {
        return (packet_device_frame_index, packet_qpc_100ns, 0);
    }
    let queued_frames = (queued_bytes_before_read / block_align) as u64;
    let queued_duration_100ns = queued_frames
        .saturating_mul(10_000_000)
        .saturating_div(u64::from(sample_rate_hz));
    (
        packet_device_frame_index.saturating_sub(queued_frames),
        packet_qpc_100ns.saturating_sub(queued_duration_100ns),
        queued_frames,
    )
}
