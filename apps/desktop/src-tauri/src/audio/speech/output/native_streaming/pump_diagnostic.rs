//! Bounded opt-in observation of the SAME padding used by the native pump.
//! Never read a second device state, change a decision, or authorize acceptance.
use std::collections::VecDeque;
use serde::Serialize;
use serde_json::{json, Value};
const LIMIT: usize = 512;
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Decision { StartupBuffering, StageDraining, StageTransition, WriteRequested, WriteAccepted, StartRequested, DeviceFull,
    AwaitingReferenceBlock, PhysicalDraining, PhysicalDrained, Underrun }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Observation {
    pub(super) sequence: u64,
    pub(super) padding_qpc_100ns: Option<u64>,
    pub(super) buffer_frames: u32,
    pub(super) padding_frames: Option<u32>,
    pub(super) reference_buffered_frames: usize,
    pub(super) pending_prefix_frames: usize,
    pub(super) submitted_frames: u64,
    pub(super) requested_frames: usize,
    pub(super) started: bool,
    pub(super) ended: bool,
    pub(super) stage_index: usize,
    pub(super) decision: Decision,
}
pub(super) struct PumpDiagnostic {
    recent: VecDeque<Observation>, count: u64, invalid_qpc: u64,
}
impl PumpDiagnostic {
    pub(super) fn new() -> Self { Self { recent: VecDeque::with_capacity(LIMIT), count: 0, invalid_qpc: 0 } }
    pub(super) fn record(&mut self, mut row: Observation) {
        row.sequence = self.count; self.count += 1;
        self.invalid_qpc += u64::from(row.padding_qpc_100ns.is_none_or(|qpc| qpc == 0));
        if self.recent.len() == LIMIT { self.recent.pop_front(); }
        self.recent.push_back(row);
    }
    // Only called after terminal cleanup, never from the device pump.
    pub(super) fn receipt(&self) -> Value {
        json!({"schemaVersion":1,"artifactKind":"native-desktop-pump-decision-diagnostic",
            "diagnosticOnly":true,"qualityAcceptance":false,"releaseEligible":false,
            "retainedObservationLimit":LIMIT,"observedPollCount":self.count,
            "evictedOldDiagnosticObservations":self.count.saturating_sub(self.recent.len() as u64),
            "invalidQpcObservations":self.invalid_qpc,"sampleRateHz":48_000,
            "samePaddingSampleAsDecision":true,"writeRequestedIsNotPhysicalOutput":true,
            "recentObservations":self.recent})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn row(qpc: Option<u64>) -> Observation {
        Observation { sequence: 999, padding_qpc_100ns:qpc, buffer_frames:960, padding_frames:Some(480),
            reference_buffered_frames:40_000, pending_prefix_frames:0, submitted_frames:80_000,
            requested_frames:480, started:true, ended:false, stage_index:0, decision:Decision::WriteRequested }
    }
    #[test]
    fn bounded_rows_keep_truthful_recent_state_and_never_accept_quality() {
        let mut recorder=PumpDiagnostic::new();
        for qpc in 1..=1024 {recorder.record(row(Some(qpc)));}
        let report=recorder.receipt(); assert_eq!(report["observedPollCount"],1024);
        assert_eq!(report["evictedOldDiagnosticObservations"],512);
        assert_eq!(report["recentObservations"][0]["sequence"],512);
        assert_eq!(report["recentObservations"][511]["paddingQpc100ns"],1024);
        assert_eq!(report["qualityAcceptance"],false); assert_eq!(report["releaseEligible"],false);
        assert_eq!(report["recentObservations"][511]["referenceBufferedFrames"],40_000);
    }
    #[test]
    fn missing_qpc_is_retained_as_unknown_not_fabricated() {
        let mut recorder=PumpDiagnostic::new(); recorder.record(row(None)); recorder.record(row(Some(0)));
        let receipt=recorder.receipt(); assert_eq!(receipt["invalidQpcObservations"],2);
        assert!(receipt["recentObservations"][0]["paddingQpc100ns"].is_null());
    }
}
