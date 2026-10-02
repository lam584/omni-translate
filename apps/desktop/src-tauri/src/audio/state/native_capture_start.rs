use std::sync::Arc;

/// A native Start acknowledgement belongs to one handle, not an endpoint or UI
/// snapshot. Clones share the same owner token; a replacement handle gets a new
/// token even when it opens the very same endpoint.
#[derive(Clone)]
pub(crate) struct NativeCaptureStartAck(Arc<std::sync::atomic::AtomicBool>);

impl NativeCaptureStartAck {
    pub(crate) fn new() -> Self {
        Self(Arc::new(std::sync::atomic::AtomicBool::new(false)))
    }

    /// Called by the native producer with the actual IAudioClient Start result.
    /// Initialization, optimistic stream_bound, and Bridge readiness cannot ack.
    pub(crate) fn observe_native_start<T, E>(&self, result: Result<T, E>) -> Result<T, E> {
        if result.is_ok() {
            self.0.store(true, std::sync::atomic::Ordering::Release);
        }
        result
    }

    pub(crate) fn is_started(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }

    pub(crate) fn same_owner(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

