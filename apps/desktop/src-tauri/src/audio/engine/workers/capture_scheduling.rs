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
