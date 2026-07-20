use tauri::AppHandle;

use super::contracts::{BridgeRuntimeSnapshot, BridgeStateResponse};
use super::ipc::{
    ensure_bridge_runtime_root, flush_bridge_source, initialize_bridge,
    query_state, query_state_fast, stop_bridge_process, terminate_stale_bridge_process,
    write_virtual_mic_frame,
};

/// Typed client for all named-pipe operations bound to one Bridge runtime.
pub struct BridgeIpcClient<'a> {
    snapshot: &'a BridgeRuntimeSnapshot,
}

impl<'a> BridgeIpcClient<'a> {
    pub fn new(snapshot: &'a BridgeRuntimeSnapshot) -> Self {
        Self { snapshot }
    }

    pub fn query_state(&self, fast: bool) -> Result<BridgeStateResponse, String> {
        BridgeCommandClient::new(&self.snapshot.pipe_path).query_state(fast)
    }

    pub fn initialize(&self) -> Result<BridgeRuntimeSnapshot, String> {
        initialize_bridge(self.snapshot)
    }

    pub fn stop(&self) -> Result<(), String> {
        BridgeProcessSupervisor::new(self.snapshot).stop()
    }

    pub fn flush_source(&self) -> Result<(), String> {
        flush_bridge_source(self.snapshot)
    }
}

pub(crate) struct BridgeProcessSupervisor<'a> {
    snapshot: &'a BridgeRuntimeSnapshot,
}

impl<'a> BridgeProcessSupervisor<'a> {
    pub(crate) fn new(snapshot: &'a BridgeRuntimeSnapshot) -> Self {
        Self { snapshot }
    }

    pub(crate) fn ensure_runtime_root(&self) -> Result<(), String> {
        ensure_bridge_runtime_root(self.snapshot)
    }

    pub(crate) fn terminate_stale(&self) -> Result<(), String> {
        terminate_stale_bridge_process(self.snapshot)
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        stop_bridge_process(self.snapshot)
    }
}

pub(crate) struct BridgeCommandClient<'a> {
    pipe_path: &'a str,
}

impl<'a> BridgeCommandClient<'a> {
    pub(crate) fn new(pipe_path: &'a str) -> Self {
        Self { pipe_path }
    }

    pub(crate) fn query_state(&self, fast: bool) -> Result<BridgeStateResponse, String> {
        if fast { query_state_fast(self.pipe_path) } else { query_state(self.pipe_path) }
    }

}

pub(crate) struct BridgeAudioWriter<'a> {
    app: &'a AppHandle,
}

impl<'a> BridgeAudioWriter<'a> {
    pub(crate) fn new(app: &'a AppHandle) -> Self {
        Self { app }
    }

    pub(crate) fn write_translation_frame(
        &self,
        cue_id: &str,
        request_id: &str,
        samples: &[i16],
        sample_rate_hz: u32,
        channels: u16,
    ) -> Result<u64, String> {
        write_virtual_mic_frame(self.app, cue_id, request_id, samples, sample_rate_hz, channels)
    }
}
