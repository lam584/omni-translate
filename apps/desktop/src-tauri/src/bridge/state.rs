use std::process::Child;
use std::sync::{Mutex, MutexGuard, PoisonError};
#[cfg(test)]
use std::sync::TryLockResult;

use super::contracts::BridgeRuntimeSnapshot;

pub(crate) struct BridgeProcessHandle {
    pub child: Child,
}

pub(crate) struct BridgeStateStore {
    inner: Mutex<BridgeState>,
    /// Serializes every native operation that can observe or replace the
    /// Bridge process/capture route. This is deliberately separate from
    /// `inner`: lifecycle operations hold this guard across blocking process
    /// cleanup, launch, Init, and playback-ownership handoff while taking the
    /// snapshot/process mutex only for short updates.
    lifecycle_operation: Mutex<()>,
}

struct BridgeState {
    snapshot: BridgeRuntimeSnapshot,
    process: Option<BridgeProcessHandle>,
}

impl BridgeStateStore {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(BridgeState {
                snapshot: BridgeRuntimeSnapshot::default(),
                process: None,
            }),
            lifecycle_operation: Mutex::new(()),
        }
    }

    pub(crate) fn lock_lifecycle_operation(&self) -> MutexGuard<'_, ()> {
        self.lifecycle_operation
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(crate) fn try_lock_lifecycle_operation(&self) -> TryLockResult<MutexGuard<'_, ()>> {
        self.lifecycle_operation.try_lock()
    }

    pub(crate) fn snapshot(&self) -> BridgeRuntimeSnapshot {
        self.inner
            .lock()
            .expect("bridge state poisoned")
            .snapshot
            .clone()
    }

    pub(crate) fn update_snapshot<F>(&self, updater: F) -> BridgeRuntimeSnapshot
    where
        F: FnOnce(&mut BridgeRuntimeSnapshot),
    {
        let mut state = self.inner.lock().expect("bridge state poisoned");
        updater(&mut state.snapshot);
        state.snapshot.clone()
    }

    pub(crate) fn set_process(&self, child: Child) {
        let mut state = self.inner.lock().expect("bridge state poisoned");
        state.process = Some(BridgeProcessHandle { child });
    }

    pub(crate) fn take_process(&self) -> Option<BridgeProcessHandle> {
        self.inner
            .lock()
            .expect("bridge state poisoned")
            .process
            .take()
    }
}

impl Drop for BridgeStateStore {
    fn drop(&mut self) {
        let Ok(state) = self.inner.get_mut() else {
            return;
        };
        if let Some(process) = state.process.as_mut() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
        state.process = None;
    }
}
