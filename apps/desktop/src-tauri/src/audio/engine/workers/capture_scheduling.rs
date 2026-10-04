//! Owner-local scheduling lifecycle. No retries, global priority/timer changes,
//! PCM changes or AEC/clock acceptance authority.
use crate::audio::mmcss_audio::{CleanupPath, RegistrationFailure, SchedulingLease};

pub(super) fn combine_capture_cleanup<T>(primary: Result<T, String>, cleanup: Result<(), String>) -> Result<T, String> {
    match (primary, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(primary), Ok(())) => Err(primary),
        (Ok(_), Err(cleanup)) => Err(cleanup),
        (Err(primary), Err(cleanup)) => Err(format!("{primary}; MMCSS cleanup: {cleanup}")),
    }
}

/// Attempt native Stop exactly once, then restore on the same owner before
/// returning its final typed receipt. Stop truth is not scheduling success.
pub(super) fn finish_native_capture_stop(
    stop: impl FnOnce() -> Result<(), String>,
    scheduling: &mut dyn SchedulingLease,
    native_stop_succeeded: &std::cell::Cell<bool>,
    final_scheduling: &std::cell::RefCell<Option<crate::audio::mmcss_audio::MmcssAudioReceipt>>,
) -> Result<(), String> {
    let result = stop();
    native_stop_succeeded.set(result.is_ok());
    let restored = scheduling.finish(CleanupPath::Explicit);
    *final_scheduling.borrow_mut() = Some(scheduling.receipt());
    combine_capture_cleanup(result, restored)
}

pub(super) fn run_with_audio_scheduling<T>(
    register: impl FnOnce() -> Result<Box<dyn SchedulingLease>, RegistrationFailure>,
    work: impl FnOnce(&mut dyn SchedulingLease) -> Result<T, String>,
) -> Result<T, String> {
    let mut scheduling = register().map_err(|failure| failure.detail)?;
    // The lease is !Send/!Sync and the closure is synchronous. If work unwinds,
    // its existing owner-affine Drop fallback still restores exactly once.
    let result = work(scheduling.as_mut());
    let cleanup = scheduling.finish(CleanupPath::Explicit);
    combine_capture_cleanup(result, cleanup)
}

#[cfg(test)]
#[path = "capture_scheduling_tests.rs"]
mod tests;
