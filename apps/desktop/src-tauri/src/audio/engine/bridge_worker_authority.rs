use tauri::{AppHandle, Manager};
use std::sync::{Arc, Mutex, PoisonError};

use super::diag_log_detail;
use crate::audio::state::AudioStateStore;
use crate::bridge::contracts::{BridgeRuntimeSnapshot, BridgeStateResponse};
use crate::bridge::ipc::{
    apply_query as apply_bridge_query, mark_process_loopback_capture_failed, BridgeIpcClient,
};
use crate::bridge::state::BridgeStateStore;

/// Authority captured when one Bridge-backed source worker is spawned. Both
/// the audio command generation and the native Bridge capture generation must
/// still match before a late worker failure may mutate shared runtime state.
#[derive(Clone)]
pub(super) struct BridgeSourceWorkerContext {
    pub(super) inbound_route_generation: u64,
    bridge_snapshot: Arc<Mutex<BridgeRuntimeSnapshot>>,
}

impl BridgeSourceWorkerContext {
    pub(super) fn new(
        inbound_route_generation: u64,
        bridge_snapshot: BridgeRuntimeSnapshot,
    ) -> Self {
        Self {
            inbound_route_generation,
            bridge_snapshot: Arc::new(Mutex::new(bridge_snapshot)),
        }
    }

    pub(super) fn snapshot(&self) -> BridgeRuntimeSnapshot {
        self.bridge_snapshot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Rebinds both the running source worker and its late-error publication
    /// guard because clones share this authority cell. This is essential when
    /// a controlled Bridge restart happens without replacing the Desktop
    /// inbound route generation.
    pub(super) fn rebind(&self, bridge_snapshot: BridgeRuntimeSnapshot) {
        *self
            .bridge_snapshot
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = bridge_snapshot;
    }

    fn matches_bridge_snapshot(&self, current: &BridgeRuntimeSnapshot) -> bool {
        let expected = self.snapshot();
        current.session_id == expected.session_id
            && current.bridge_process_id == expected.bridge_process_id
            && current.bridge_instance_id == expected.bridge_instance_id
            && current.source_generation == expected.source_generation
            && current.source_generation_token == expected.source_generation_token
            && current.source_capture_mode == expected.source_capture_mode
            && current.capture_backend == expected.capture_backend
    }

    fn matches_bridge_response(&self, response: &BridgeStateResponse) -> bool {
        let expected = self.snapshot();
        response.bridge_process_id == expected.bridge_process_id
            && response.bridge_instance_id == expected.bridge_instance_id
            && response.source_generation == expected.source_generation
            && response.source_generation_token == expected.source_generation_token
            && response.source_capture_mode == expected.source_capture_mode
            && response.capture_backend == expected.capture_backend
    }

    fn describe(&self) -> String {
        let bridge_snapshot = self.snapshot();
        format!(
            "routeGeneration={} bridgeProcessId={} bridgeInstanceId={} bridgeSession={} sourceGeneration={} sourceGenerationToken={} captureMode={} captureBackend={}",
            self.inbound_route_generation,
            bridge_snapshot.bridge_process_id.map(|value| value.to_string()).unwrap_or_else(|| "none".to_string()),
            bridge_snapshot.bridge_instance_id.as_deref().unwrap_or("none"),
            bridge_snapshot.session_id.as_deref().unwrap_or("none"),
            bridge_snapshot.source_generation,
            bridge_snapshot.source_generation_token.as_deref().unwrap_or("none"),
            bridge_snapshot.source_capture_mode.as_str(),
            bridge_snapshot.capture_backend.as_str(),
        )
    }
}

pub(super) fn commit_bridge_source_worker_error_if_current<O>(
    audio_state: &AudioStateStore,
    worker_context: &BridgeSourceWorkerContext,
    direction: &str,
    message: &str,
    error_code: Option<&str>,
    recommended_action: Option<&str>,
    prepare: impl FnOnce() -> Option<O>,
    commit_bridge: impl FnOnce(O) -> bool,
    publish: impl FnOnce(),
) -> bool {
    // Cheap first check avoids querying a Bridge for a worker that was already
    // superseded. Do not retain this gate (or the pipeline lock) across the
    // blocking query performed by `prepare`: a start/stop must remain able to
    // revoke this generation while that query is in flight.
    {
        let _authority = audio_state.lock_inbound_route_authority();
        if audio_state.inbound_route_generation() != worker_context.inbound_route_generation {
            return false;
        }
    }

    let Some(observation) = prepare() else {
        return false;
    };

    // Route mutation and publication are one linearized commit. The pipeline
    // prevents a concurrent start/stop from changing audio state, while the
    // authority gate prevents its earlier generation bump from racing the
    // final check. The fixed lock order is pipeline -> authority; generation
    // bumpers hold authority only for the increment and release it before
    // attempting the pipeline lock.
    let _pipeline = audio_state.lock_inbound_pipeline();
    let _authority = audio_state.lock_inbound_route_authority();
    if audio_state.inbound_route_generation() != worker_context.inbound_route_generation {
        return false;
    }
    if !commit_bridge(observation) {
        return false;
    }
    if error_code == Some("bridge.process-loopback-capture-failed") {
        audio_state.watch_session_report.record_session_issue(
            "session",
            "bridge-process-loopback-capture-failed",
            "error",
            message,
        );
    }
    audio_state.mark_route_error(
        direction,
        message.to_string(),
        error_code.map(str::to_string),
        recommended_action.map(str::to_string),
    );
    publish();
    true
}

struct ProcessLoopbackCaptureFailureObservation {
    query: Option<BridgeStateResponse>,
    query_error: Option<String>,
}

enum BridgeSourceFailureObservation {
    NonProcess,
    Process(ProcessLoopbackCaptureFailureObservation),
}

fn observe_process_loopback_capture_failure<R: tauri::Runtime>(
    app: &AppHandle<R>,
    worker_context: &BridgeSourceWorkerContext,
) -> Option<ProcessLoopbackCaptureFailureObservation> {
    let bridge_state = app.state::<BridgeStateStore>();
    let cached = bridge_state.snapshot();
    if !worker_context.matches_bridge_snapshot(&cached) {
        return None;
    }
    let query = BridgeIpcClient::new(&cached).query_state(true);
    Some(ProcessLoopbackCaptureFailureObservation {
        query_error: query.as_ref().err().cloned(),
        query: query.ok(),
    })
}

pub(super) fn apply_bridge_source_worker_error_if_current<R: tauri::Runtime>(
    app: &AppHandle<R>,
    audio_state: &AudioStateStore,
    worker_context: &BridgeSourceWorkerContext,
    direction: &str,
    message: &str,
    error_code: Option<&str>,
    recommended_action: Option<&str>,
) -> bool {
    let is_process_failure =
        error_code == Some("bridge.process-loopback-capture-failed");
    commit_bridge_source_worker_error_if_current(
        audio_state,
        worker_context,
        direction,
        message,
        error_code,
        recommended_action,
        || {
            if is_process_failure {
                observe_process_loopback_capture_failure(app, worker_context)
                    .map(BridgeSourceFailureObservation::Process)
            } else {
                Some(BridgeSourceFailureObservation::NonProcess)
            }
        },
        |observation| match observation {
            BridgeSourceFailureObservation::NonProcess => true,
            BridgeSourceFailureObservation::Process(observation) => {
                let bridge_state = app.state::<BridgeStateStore>();
                let applied = apply_process_loopback_capture_failure_if_current(
                    &bridge_state,
                    worker_context,
                    message,
                    observation.query,
                );
                if applied {
                    if let Some(error) = observation.query_error {
                        let _ = diag_log_detail(
                            app,
                            "bridge",
                            "warning",
                            "event=process_loopback_failure_state_query_failed",
                            format!("error={error}"),
                        );
                    }
                }
                applied
            }
        },
        || {
            super::notify_route_worker_error(app, direction, message, error_code);
            let _ = super::emit_audio_snapshot(app, audio_state);
        },
    )
}

pub(super) fn apply_process_loopback_capture_failure_if_current(
    bridge_state: &BridgeStateStore,
    worker_context: &BridgeSourceWorkerContext,
    detail: &str,
    query: Option<BridgeStateResponse>,
) -> bool {
    let mut applied = false;
    bridge_state.update_snapshot(|current| {
        if !worker_context.matches_bridge_snapshot(current) {
            return;
        }
        if let Some(response) = query {
            if !worker_context.matches_bridge_response(&response) {
                return;
            }
            apply_bridge_query(current, response);
        }
        mark_process_loopback_capture_failed(current, detail.to_string());
        applied = true;
    });
    applied
}

pub(super) fn log_stale_bridge_source_failure<R: tauri::Runtime>(
    app: &AppHandle<R>,
    worker_context: &BridgeSourceWorkerContext,
    detail: &str,
    reason: &str,
) {
    let current_bridge = app.state::<BridgeStateStore>().snapshot();
    let current_route_generation = app
        .state::<AudioStateStore>()
        .inbound_route_generation();
    let _ = diag_log_detail(
        app,
        "bridge",
        "info",
        "event=stale_bridge_source_worker_failure_ignored",
        format!(
            "reason={reason} worker=[{}] currentRouteGeneration={} currentBridgeSession={} currentSourceGeneration={} currentCaptureMode={} currentCaptureBackend={} detail={detail}",
            worker_context.describe(),
            current_route_generation,
            current_bridge.session_id.as_deref().unwrap_or("none"),
            current_bridge.source_generation,
            current_bridge.source_capture_mode.as_str(),
            current_bridge.capture_backend.as_str(),
        ),
    );
}
