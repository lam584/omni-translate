use tauri::AppHandle;

use super::contracts::{
    BridgeProcessLoopbackProbeResponse, BridgeRuntimeSnapshot, BridgeStateResponse,
};
use super::ipc::{
    ensure_bridge_runtime_root, flush_bridge_source, initialize_bridge, query_state,
    probe_process_loopback, query_state_fast, stop_bridge_process, terminate_stale_bridge_process,
    write_process_playback_cue, write_virtual_mic_frame, BridgeInitializationFailure,
};

/// Typed client for all named-pipe operations bound to one Bridge runtime.
pub(crate) struct BridgeIpcClient<'a> {
    snapshot: &'a BridgeRuntimeSnapshot,
}

impl<'a> BridgeIpcClient<'a> {
    pub(crate) fn new(snapshot: &'a BridgeRuntimeSnapshot) -> Self {
        Self { snapshot }
    }

    pub(crate) fn query_state(&self, fast: bool) -> Result<BridgeStateResponse, String> {
        BridgeCommandClient::new(&self.snapshot.pipe_path).query_state(fast)
    }

    pub(crate) fn initialize(
        &self,
    ) -> Result<BridgeRuntimeSnapshot, BridgeInitializationFailure> {
        initialize_bridge(self.snapshot)
    }

    pub(crate) fn probe_process_loopback(
        &self,
    ) -> Result<BridgeProcessLoopbackProbeResponse, String> {
        BridgeCommandClient::new(&self.snapshot.pipe_path).probe_process_loopback()
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        BridgeProcessSupervisor::new(self.snapshot).stop()
    }

    pub(crate) fn flush_source(&self) -> Result<(), String> {
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

    pub(crate) fn probe_process_loopback(
        &self,
    ) -> Result<BridgeProcessLoopbackProbeResponse, String> {
        probe_process_loopback(self.pipe_path)
    }

}

pub(crate) struct BridgeAudioWriter<'a, R: tauri::Runtime = tauri::Wry> {
    app: &'a AppHandle<R>,
}

impl<'a, R: tauri::Runtime> BridgeAudioWriter<'a, R> {
    pub(crate) fn new(app: &'a AppHandle<R>) -> Self {
        Self { app }
    }

    /// Writes translated PCM to the virtual-microphone route. This path keeps
    /// the existing 20 ms pacing required by the driver-facing transport.
    pub(crate) fn write_virtual_mic_frame(
        &self,
        cue_id: &str,
        request_id: &str,
        route_direction: &str,
        samples: &[i16],
        sample_rate_hz: u32,
        channels: u16,
        created_at_ms: u64,
        estimated_duration_ms: u64,
    ) -> Result<u64, String> {
        write_virtual_mic_frame(
            self.app,
            cue_id,
            request_id,
            route_direction,
            samples,
            sample_rate_hz,
            channels,
            created_at_ms,
            estimated_duration_ms,
        )
    }

    /// Enqueues one complete translated cue for Bridge-owned physical
    /// playback. Process exclusion relies on cue-level queue semantics, so the
    /// PCM must not be split into driver-style 20 ms jobs.
    pub(crate) fn write_process_playback_cue(
        &self,
        cue_id: &str,
        request_id: &str,
        route_direction: &str,
        samples: &[i16],
        sample_rate_hz: u32,
        channels: u16,
        created_at_ms: u64,
        estimated_duration_ms: u64,
    ) -> Result<u64, String> {
        write_process_playback_cue(
            self.app,
            cue_id,
            request_id,
            route_direction,
            samples,
            sample_rate_hz,
            channels,
            created_at_ms,
            estimated_duration_ms,
        )
    }
}
