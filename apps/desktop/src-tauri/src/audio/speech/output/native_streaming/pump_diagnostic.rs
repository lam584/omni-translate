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
const DECISION_KEYS: [&str; 11] = [
    "startup-buffering", "stage-draining", "stage-transition", "write-requested",
    "write-accepted", "start-requested", "device-full", "awaiting-reference-block",
    "physical-draining", "physical-drained", "underrun",
];
impl Decision {
    fn counter_index(self) -> usize {
        match self {
            Self::StartupBuffering => 0, Self::StageDraining => 1, Self::StageTransition => 2,
            Self::WriteRequested => 3, Self::WriteAccepted => 4, Self::StartRequested => 5,
            Self::DeviceFull => 6, Self::AwaitingReferenceBlock => 7,
            Self::PhysicalDraining => 8, Self::PhysicalDrained => 9, Self::Underrun => 10,
        }
    }
}
#[derive(Clone, Copy, Default)]
struct DecisionCounts {
    observed: u64,
    decisions: [u64; 11],
    zero_padding: [u64; 11],
}
impl DecisionCounts {
    fn next(self, decision: usize, zero_padding: bool) -> Option<Self> {
        let mut next = self;
        next.observed = next.observed.checked_add(1)?;
        next.decisions[decision] = next.decisions[decision].checked_add(1)?;
        if zero_padding {
            next.zero_padding[decision] = next.zero_padding[decision].checked_add(1)?;
        }
        Some(next)
    }
    // Keyed objects are built only for the terminal receipt, not on the pump path.
    fn receipt(&self) -> Value {
        let decisions: serde_json::Map<String, Value> = DECISION_KEYS.iter().enumerate()
            .map(|(index, key)| ((*key).to_owned(), json!(self.decisions[index]))).collect();
        let zero_padding: serde_json::Map<String, Value> = DECISION_KEYS.iter().enumerate()
            .map(|(index, key)| ((*key).to_owned(), json!(self.zero_padding[index]))).collect();
        json!({"observedDecisionCount":self.observed,"decisionCounts":decisions,
            "zeroPaddingDecisionCounts":zero_padding})
    }
}
#[derive(Default)]
struct FullRunDecisionCounts {
    total: DecisionCounts,
    stages: [DecisionCounts; 3],
    other_stage: DecisionCounts,
}
impl FullRunDecisionCounts {
    fn record(&mut self, row: &Observation) -> bool {
        let decision = row.decision.counter_index();
        let zero_padding = row.padding_frames == Some(0);
        let bucket = self.stages.get_mut(row.stage_index).unwrap_or(&mut self.other_stage);
        // Commit both counters together; on overflow retain consistent totals rather
        // than partially counting a decision. The sticky flag disclaims exactness.
        match (self.total.next(decision, zero_padding), bucket.next(decision, zero_padding)) {
            (Some(total), Some(stage)) => { self.total = total; *bucket = stage; false }
            _ => true,
        }
    }
    fn receipt(&self, counter_overflowed: bool) -> Value {
        let mut receipt = self.total.receipt();
        receipt["schemaVersion"] = json!(1);
        receipt["coverage"] = json!("all-recorded-decisions-before-recent-eviction");
        receipt["counterOverflowed"] = json!(counter_overflowed);
        receipt["stages"] = Value::Array(self.stages.iter().enumerate().map(|(index, counts)| {
            let mut stage = counts.receipt(); stage["stageIndex"] = json!(index); stage
        }).collect());
        receipt["otherStage"] = self.other_stage.receipt();
        receipt
    }
}
fn increment_checked(counter: &mut u64, counter_overflowed: &mut bool) {
    match counter.checked_add(1) {
        Some(next) => *counter = next,
        None => *counter_overflowed = true,
    }
}
pub(super) struct PumpDiagnostic {
    recent: VecDeque<Observation>, count: u64, invalid_qpc: u64,
    full_run: FullRunDecisionCounts, counter_overflowed: bool,
}
impl PumpDiagnostic {
    pub(super) fn new() -> Self { Self { recent: VecDeque::with_capacity(LIMIT), count: 0, invalid_qpc: 0,
        full_run: FullRunDecisionCounts::default(), counter_overflowed: false } }
    pub(super) fn record(&mut self, mut row: Observation) {
        row.sequence = self.count;
        increment_checked(&mut self.count, &mut self.counter_overflowed);
        if row.padding_qpc_100ns.is_none_or(|qpc| qpc == 0) {
            increment_checked(&mut self.invalid_qpc, &mut self.counter_overflowed);
        }
        self.counter_overflowed |= self.full_run.record(&row);
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
            "recentObservations":self.recent,
            "fullRunDecisionCounts":self.full_run.receipt(self.counter_overflowed)})
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
    const ALL_DECISIONS: [Decision; 11] = [
        Decision::StartupBuffering, Decision::StageDraining, Decision::StageTransition,
        Decision::WriteRequested, Decision::WriteAccepted, Decision::StartRequested,
        Decision::DeviceFull, Decision::AwaitingReferenceBlock, Decision::PhysicalDraining,
        Decision::PhysicalDrained, Decision::Underrun,
    ];
    fn assert_diagnostic_only(receipt: &Value) {
        assert_eq!(receipt["schemaVersion"], 1);
        assert_eq!(receipt["diagnosticOnly"], true);
        assert_eq!(receipt["qualityAcceptance"], false);
        assert_eq!(receipt["releaseEligible"], false);
    }
    fn assert_full_run_sums(full: &Value) {
        assert_eq!(full.as_object().unwrap().len(), 8);
        assert_eq!(full["schemaVersion"], 1);
        assert_eq!(full["coverage"], "all-recorded-decisions-before-recent-eviction");
        let stages = full["stages"].as_array().unwrap();
        assert_eq!(stages.len(), 3);
        for (index, stage) in stages.iter().enumerate() {
            assert_eq!(stage["stageIndex"], index);
            assert_eq!(stage.as_object().unwrap().len(), 4);
        }
        assert_eq!(full["otherStage"].as_object().unwrap().len(), 3);
        let buckets: Vec<&Value> = stages.iter().chain(std::iter::once(&full["otherStage"])).collect();
        assert_eq!(full["observedDecisionCount"].as_u64().unwrap(), buckets.iter()
            .map(|bucket| bucket["observedDecisionCount"].as_u64().unwrap()).sum::<u64>());
        for counts in std::iter::once(full).chain(buckets.iter().copied()) {
            let mut decisions = 0u64;
            for key in DECISION_KEYS {
                let count = counts["decisionCounts"][key].as_u64().unwrap();
                decisions += count;
                assert!(counts["zeroPaddingDecisionCounts"][key].as_u64().unwrap() <= count);
            }
            assert_eq!(decisions, counts["observedDecisionCount"].as_u64().unwrap());
            for field in ["decisionCounts", "zeroPaddingDecisionCounts"] {
                assert_eq!(counts[field].as_object().unwrap().len(), 11);
            }
        }
        for field in ["decisionCounts", "zeroPaddingDecisionCounts"] {
            for key in DECISION_KEYS {
                assert_eq!(full[field][key].as_u64().unwrap(), buckets.iter()
                    .map(|bucket| bucket[field][key].as_u64().unwrap()).sum::<u64>());
            }
        }
    }
    #[test]
    fn early_underrun_survives_recent_observation_eviction() {
        let mut recorder = PumpDiagnostic::new();
        let mut underrun = row(Some(1));
        underrun.decision = Decision::Underrun; underrun.padding_frames = Some(0);
        recorder.record(underrun);
        for qpc in 2..=1025 { recorder.record(row(Some(qpc))); }
        let receipt = recorder.receipt();
        assert_eq!(receipt["recentObservations"].as_array().unwrap().len(), LIMIT);
        assert!(receipt["recentObservations"].as_array().unwrap().iter()
            .all(|row| row["decision"] != "underrun"));
        assert_eq!(receipt["evictedOldDiagnosticObservations"], 513);
        let full = &receipt["fullRunDecisionCounts"];
        assert_eq!(full["observedDecisionCount"], 1025);
        assert_eq!(full["decisionCounts"]["underrun"], 1);
        assert_eq!(full["zeroPaddingDecisionCounts"]["underrun"], 1);
        assert_eq!(full["decisionCounts"]["write-requested"], 1024);
        assert_eq!(full["counterOverflowed"], false);
        assert_full_run_sums(full); assert_diagnostic_only(&receipt);
    }
    #[test]
    fn healthy_zero_padding_is_not_reclassified_as_underrun() {
        let mut recorder = PumpDiagnostic::new();
        for decision in [Decision::StartupBuffering, Decision::StageTransition,
            Decision::PhysicalDraining, Decision::PhysicalDrained] {
            let mut observation = row(Some(1));
            observation.decision = decision; observation.padding_frames = Some(0);
            observation.started = !matches!(decision, Decision::StartupBuffering);
            observation.ended = matches!(decision, Decision::PhysicalDraining | Decision::PhysicalDrained);
            recorder.record(observation);
        }
        let healthy = recorder.receipt();
        assert_eq!(healthy["fullRunDecisionCounts"]["decisionCounts"]["underrun"], 0);
        let mut underrun = row(Some(2));
        underrun.decision = Decision::Underrun; underrun.padding_frames = Some(0);
        recorder.record(underrun);
        let receipt = recorder.receipt(); let full = &receipt["fullRunDecisionCounts"];
        for key in ["startup-buffering", "stage-transition", "physical-draining", "physical-drained", "underrun"] {
            assert_eq!(full["decisionCounts"][key], 1);
            assert_eq!(full["zeroPaddingDecisionCounts"][key], 1);
        }
        assert_full_run_sums(full); assert_diagnostic_only(&receipt);
    }
    #[test]
    fn every_decision_and_phase_and_other_stage_has_exact_totals() {
        let mut recorder = PumpDiagnostic::new();
        for stage in [0, 1, 2, 3, usize::MAX] {
            for (index, decision) in ALL_DECISIONS.iter().copied().enumerate() {
                // Assert the keyed counters exactly match the existing Decision serialization.
                assert_eq!(serde_json::to_value(decision).unwrap(), DECISION_KEYS[index]);
                for padding in [None, Some(0), Some(480)] {
                    let mut observation = row(Some(1));
                    observation.stage_index = stage; observation.decision = decision;
                    observation.padding_frames = padding; recorder.record(observation);
                }
            }
        }
        let receipt = recorder.receipt(); let full = &receipt["fullRunDecisionCounts"];
        assert_eq!(full["observedDecisionCount"], 165);
        for stage in full["stages"].as_array().unwrap() {
            assert_eq!(stage["observedDecisionCount"], 33);
            for key in DECISION_KEYS {
                assert_eq!(stage["decisionCounts"][key], 3);
                assert_eq!(stage["zeroPaddingDecisionCounts"][key], 1);
            }
        }
        assert_eq!(full["otherStage"]["observedDecisionCount"], 66);
        for key in DECISION_KEYS {
            assert_eq!(full["decisionCounts"][key], 15);
            assert_eq!(full["zeroPaddingDecisionCounts"][key], 5);
            assert_eq!(full["otherStage"]["decisionCounts"][key], 6);
            assert_eq!(full["otherStage"]["zeroPaddingDecisionCounts"][key], 2);
        }
        assert_full_run_sums(full); assert_diagnostic_only(&receipt);
    }
    #[test]
    fn missing_and_zero_qpc_do_not_exclude_decisions_or_invent_zero_padding() {
        let mut recorder = PumpDiagnostic::new();
        for qpc in [None, Some(0), Some(1)] {
            for padding in [None, Some(0), Some(480)] {
                let mut observation = row(qpc); observation.padding_frames = padding;
                recorder.record(observation);
            }
        }
        let receipt = recorder.receipt(); let full = &receipt["fullRunDecisionCounts"];
        assert_eq!(receipt["invalidQpcObservations"], 6);
        assert_eq!(full["observedDecisionCount"], 9);
        assert_eq!(full["decisionCounts"]["write-requested"], 9);
        assert_eq!(full["zeroPaddingDecisionCounts"]["write-requested"], 3);
        assert_eq!(full["counterOverflowed"], false);
        assert!(receipt["recentObservations"][0]["paddingQpc100ns"].is_null());
        assert_eq!(receipt["recentObservations"][3]["paddingQpc100ns"], 0);
        assert_full_run_sums(full); assert_diagnostic_only(&receipt);
    }
    #[test]
    fn full_run_overflow_preserves_totals_and_stays_diagnostic_only() {
        let mut recorder = PumpDiagnostic::new();
        let index = Decision::WriteRequested.counter_index();
        let mut counts = DecisionCounts { observed: u64::MAX - 1, ..Default::default() };
        counts.decisions[index] = u64::MAX - 1; counts.zero_padding[index] = u64::MAX - 1;
        recorder.full_run.total = counts; recorder.full_run.stages[0] = counts;
        recorder.count = u64::MAX - 1;
        let mut observation = row(Some(1)); observation.padding_frames = Some(0);
        recorder.record(observation.clone());
        assert!(!recorder.counter_overflowed);
        recorder.record(observation);
        recorder.record(row(Some(2)));
        let receipt = recorder.receipt(); let full = &receipt["fullRunDecisionCounts"];
        assert_eq!(receipt["observedPollCount"], u64::MAX);
        assert_eq!(full["observedDecisionCount"], u64::MAX);
        assert_eq!(full["decisionCounts"]["write-requested"], u64::MAX);
        assert_eq!(full["zeroPaddingDecisionCounts"]["write-requested"], u64::MAX);
        assert_eq!(full["counterOverflowed"], true);
        assert_eq!(receipt["recentObservations"][1]["sequence"], u64::MAX);
        assert_full_run_sums(full); assert_diagnostic_only(&receipt);
    }
    #[test]
    fn legacy_counter_overflows_are_checked_and_flag_is_sticky() {
        for overflow_poll_count in [false, true] {
            let mut recorder = PumpDiagnostic::new();
            if overflow_poll_count { recorder.count = u64::MAX; }
            else { recorder.invalid_qpc = u64::MAX; }
            recorder.record(row(None));
            assert!(recorder.counter_overflowed);
            recorder.record(row(Some(1))); // A valid QPC must not clear the flag.
            let receipt = recorder.receipt();
            if overflow_poll_count { assert_eq!(receipt["observedPollCount"], u64::MAX); }
            else { assert_eq!(receipt["invalidQpcObservations"], u64::MAX); }
            assert_eq!(receipt["fullRunDecisionCounts"]["counterOverflowed"], true);
            assert_eq!(receipt["fullRunDecisionCounts"]["observedDecisionCount"], 2);
            assert_full_run_sums(&receipt["fullRunDecisionCounts"]); assert_diagnostic_only(&receipt);
        }
    }
    #[test]
    fn every_counter_uses_checked_add_and_bucket_update_is_atomic() {
        let index = Decision::Underrun.counter_index();
        for field in 0..3 {
            let mut counts = DecisionCounts::default();
            match field {
                0 => counts.observed = u64::MAX,
                1 => counts.decisions[index] = u64::MAX,
                _ => counts.zero_padding[index] = u64::MAX,
            }
            assert!(counts.next(index, true).is_none());
        }
        let mut recorder = PumpDiagnostic::new();
        recorder.full_run.stages[1].observed = u64::MAX;
        let mut observation = row(Some(1)); observation.stage_index = 1;
        recorder.record(observation);
        assert_eq!(recorder.full_run.total.observed, 0);
        assert_eq!(recorder.full_run.stages[1].observed, u64::MAX);
        assert!(recorder.counter_overflowed);
        recorder.record(row(Some(2)));
        assert_eq!(recorder.full_run.total.observed, 1);
        assert!(recorder.counter_overflowed);
        assert_diagnostic_only(&recorder.receipt());
    }
}
