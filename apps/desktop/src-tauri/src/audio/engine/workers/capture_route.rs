use super::RouteSpec;

// Production initialization can try other devices. Reject any fallback before
// starting capture, for cold and pre-warmed routes alike.
pub(super) fn ensure_local_aec_probe_capture_route(
    spec: &RouteSpec,
    stt_sender_present: bool,
    effective_device_id: &str,
) -> Result<(), String> {
    if crate::watch_mode_diagnostic::local_aec_probe::enabled()
        && (!spec.echo_cancel_enabled()
            || stt_sender_present
            || effective_device_id != spec.requested_device_id)
    {
        return Err(
            "local AEC probe requires exact-endpoint echo-cancel capture without recognition"
                .into(),
        );
    }
    Ok(())
}