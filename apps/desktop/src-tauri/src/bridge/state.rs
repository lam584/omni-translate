use std::process::Child;
use std::sync::Mutex;

use super::contracts::BridgeRuntimeSnapshot;

pub(crate) struct BridgeProcessHandle {
    pub child: Child,
}

pub(crate) struct BridgeStateStore {
    inner: Mutex<BridgeState>,
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
        }
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
