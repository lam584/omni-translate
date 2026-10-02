//! Bounded diagnostic timing only. No PCM, I/O, locks held across callbacks,
//! waits, scheduling changes or acceptance authority are introduced here.
use std::{cell::RefCell, collections::VecDeque, time::Instant};
use serde::Serialize;
use serde_json::{json, Value};

const RETAINED_SPANS: usize = 512;
const PART_COUNT: usize = 13;

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Part {
    LoopGap, HealthyCapture, MediaPoll, DeltaAdmission, NativePump,
    ReferenceCallback, PhysicalCallback, LifecycleCallback, DrainCheck,
    RequestedSleep, NativeRenderWait, Abort, SourceCleanup,
}
const PARTS: [Part; PART_COUNT] = [Part::LoopGap, Part::HealthyCapture, Part::MediaPoll,
    Part::DeltaAdmission, Part::NativePump, Part::ReferenceCallback,
    Part::PhysicalCallback, Part::LifecycleCallback, Part::DrainCheck,
    Part::RequestedSleep, Part::NativeRenderWait, Part::Abort, Part::SourceCleanup];

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Outcome { Completed, Rejected, Unwound }

// Derived only from this operation's returned native result, not aggregate counters.
#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum NativeRenderWake { NotStarted, Signaled, TimedOut, DeadlineSignaled }
impl From<crate::audio::speech::DesktopRenderWake> for NativeRenderWake {
    fn from(wake: crate::audio::speech::DesktopRenderWake) -> Self {
        use crate::audio::speech::DesktopRenderWake;
        match wake {
            DesktopRenderWake::NotStarted => Self::NotStarted,
            DesktopRenderWake::Signaled => Self::Signaled,
            DesktopRenderWake::TimedOut => Self::TimedOut,
            DesktopRenderWake::DeadlineSignaled => Self::DeadlineSignaled,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Span {
    sequence: u64,
    part: Part,
    start_elapsed_micros: u64,
    end_elapsed_micros: u64,
    duration_micros: u64,
    start_qpc_100ns: Option<u64>,
    end_qpc_100ns: Option<u64>,
    qpc_valid: bool,
    outcome: Outcome,
    native_render_wake: Option<NativeRenderWake>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    count: u64,
    rejected: u64,
    unwound: u64,
    invalid_qpc: u64,
    total_micros: u64,
    maximum_micros: u64,
    maximum_span: Option<Span>,
}

pub(super) struct PumpTiming {
    origin: Instant,
    previous_loop: Option<(Instant, Option<u64>)>,
    completed: u64,
    active: u64,
    evicted: u64,
    totals: [Totals; PART_COUNT],
    native_render_wakes: [u64; 4],
    spans: VecDeque<Span>,
}
impl PumpTiming {
    pub(super) fn new() -> Self {
        Self { origin: Instant::now(), previous_loop: None, completed: 0,
            active: 0, evicted: 0, totals: std::array::from_fn(|_| Totals::default()),
            spans: VecDeque::with_capacity(RETAINED_SPANS), native_render_wakes: [0; 4] }
    }
    pub(super) fn loop_started(&mut self) {
        let now = Instant::now();
        let qpc = crate::audio::engine::aec_timing::qpc_now_100ns();
        if let Some((before, before_qpc)) = self.previous_loop.replace((now, qpc)) {
            self.record(Part::LoopGap, before, now, before_qpc, qpc, Outcome::Completed, None);
        }
    }
    fn record(&mut self, part: Part, before: Instant, now: Instant,
        before_qpc: Option<u64>, qpc: Option<u64>, outcome: Outcome,
        native_render_wake: Option<NativeRenderWake>) {
        assert_eq!(native_render_wake.is_some(), part == Part::NativeRenderWait && outcome == Outcome::Completed);
        if let Some(wake) = native_render_wake { self.native_render_wakes[wake as usize] += 1; }
        let micros = |time: std::time::Duration| u64::try_from(time.as_micros()).unwrap_or(u64::MAX);
        let span = Span { sequence: self.completed, part,
            start_elapsed_micros: micros(before.saturating_duration_since(self.origin)),
            end_elapsed_micros: micros(now.saturating_duration_since(self.origin)),
            duration_micros: micros(now.saturating_duration_since(before)),
            start_qpc_100ns: before_qpc, end_qpc_100ns: qpc,
            qpc_valid: before_qpc.zip(qpc).is_some_and(|(start,end)| start > 0 && end >= start), outcome, native_render_wake };
        self.completed += 1;
        let totals = &mut self.totals[part as usize];
        totals.count += 1;
        totals.rejected += u64::from(outcome == Outcome::Rejected);
        totals.unwound += u64::from(outcome == Outcome::Unwound);
        totals.invalid_qpc += u64::from(!span.qpc_valid);
        totals.total_micros = totals.total_micros.saturating_add(span.duration_micros);
        if totals.maximum_span.is_none() || span.duration_micros > totals.maximum_micros {
            totals.maximum_micros = span.duration_micros;
            totals.maximum_span = Some(span.clone());
        }
        if self.spans.len() == RETAINED_SPANS { self.spans.pop_front(); self.evicted += 1; }
        self.spans.push_back(span);
    }
    // Serialize only AFTER the stream has drained/aborted and owned cleanup.
    pub(super) fn receipt(&self) -> Value {
        json!({"schemaVersion":3,"artifactKind":"local-aec-pump-timing-diagnostic",
            "wakeIdentityPolicy":"returned-native-result/v1",
            "nativeRenderWaitMechanism":"event-or-local-high-resolution-deadline/v1",
            "diagnosticOnly":true,"qualityAcceptance":false,"releaseEligible":false,
            "monotonicDurationUnit":"microseconds","qpcUnit":"100ns",
            "requestedSleepMs":2,"nativeRenderWaitTimeoutMs":2,"retainedSpanLimit":RETAINED_SPANS,
            "completedSpanCount":self.completed,"activeSpanCount":self.active,
            "evictedOldDiagnosticSpans":self.evicted,"nestedSpansMayOverlap":true,
            "sumAcrossPartsIsNotLoopDuration":true,
            "nativeRenderWakeTotals":{"notStarted":self.native_render_wakes[0],"signaled":self.native_render_wakes[1],"timedOut":self.native_render_wakes[2],"deadlineSignaled":self.native_render_wakes[3]},
            "parts":PARTS.iter().zip(&self.totals).map(|(part,total)|json!({"part":part,"totals":total})).collect::<Vec<_>>(),
            "recentSpans":self.spans})
    }
}

struct Measuring<'a> {
    timing: &'a RefCell<PumpTiming>, part: Part, before: Instant,
    qpc: Option<u64>, finished: bool,
}
impl Measuring<'_> {
    fn finish(&mut self, outcome: Outcome, native_render_wake: Option<NativeRenderWake>) {
        let now = Instant::now();
        let qpc = crate::audio::engine::aec_timing::qpc_now_100ns();
        let mut timing = self.timing.borrow_mut();
        timing.active -= 1;
        timing.record(self.part, self.before, now, self.qpc, qpc, outcome, native_render_wake);
        self.finished = true;
    }
}
impl Drop for Measuring<'_> {
    fn drop(&mut self) { if !self.finished { self.finish(Outcome::Unwound, None); } }
}
pub(super) fn measure<T>(timing: &RefCell<PumpTiming>, part: Part,
    operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    assert_ne!(part, Part::NativeRenderWait, "native waits require result-bound measurement");
    measure_with_wake(timing, part, operation, |_| None)
}
pub(super) fn measure_native_render_wait(timing: &RefCell<PumpTiming>,
    operation: impl FnOnce() -> Result<crate::audio::speech::DesktopRenderWake, String>)
    -> Result<crate::audio::speech::DesktopRenderWake, String> {
    measure_with_wake(timing, Part::NativeRenderWait, operation,
        |result| result.as_ref().ok().copied().map(NativeRenderWake::from))
}
fn measure_with_wake<T>(timing: &RefCell<PumpTiming>, part: Part,
    operation: impl FnOnce() -> Result<T, String>,
    returned_wake: impl FnOnce(&Result<T, String>) -> Option<NativeRenderWake>) -> Result<T, String> {
    let mut measuring = Measuring { timing, part, before: Instant::now(),
        qpc: crate::audio::engine::aec_timing::qpc_now_100ns(), finished: false };
    timing.borrow_mut().active += 1;
    // No RefCell/Mutex guard crosses the operation. NativePump may invoke
    // callbacks that measure nested spans in this same recorder.
    let result = operation();
    measuring.finish(if result.is_ok() { Outcome::Completed } else { Outcome::Rejected }, returned_wake(&result));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn recorder_is_bounded_retains_recent_and_keeps_all_part_totals() {
        let mut timing = PumpTiming::new();
        let origin = timing.origin;
        for sequence in 0..1024_u64 {
            timing.record(Part::RequestedSleep,origin,origin+Duration::from_micros(sequence),Some(100),Some(100+sequence*10),Outcome::Completed,None);
        }
        assert_eq!(timing.spans.len(),512);
        assert_eq!(timing.spans.front().unwrap().sequence,512);
        assert_eq!(timing.spans.back().unwrap().sequence,1023);
        assert_eq!(timing.evicted,512);
        assert_eq!(timing.totals[Part::RequestedSleep as usize].count,1024);
        assert_eq!(timing.totals[Part::RequestedSleep as usize].maximum_micros,1023);
        let receipt=timing.receipt();
        assert_eq!(receipt["diagnosticOnly"],true); assert_eq!(receipt["qualityAcceptance"],false);
    }
    #[test]
    fn nested_measurement_does_not_hold_recorder_borrow_or_double_classify_time() {
        let timing=RefCell::new(PumpTiming::new());
        let result=measure(&timing,Part::NativePump,|| measure(&timing,Part::ReferenceCallback,|| Ok(7)));
        assert_eq!(result,Ok(7));
        let timing=timing.borrow();
        assert_eq!(timing.active,0); assert_eq!(timing.completed,2);
        assert_eq!(timing.spans[0].part as usize,Part::ReferenceCallback as usize);
        assert_eq!(timing.spans[1].part as usize,Part::NativePump as usize);
        assert_eq!(timing.receipt()["nestedSpansMayOverlap"],true);
    }
    #[test]
    fn rejection_and_panic_are_recorded_without_turning_operation_into_success() {
        let timing=RefCell::new(PumpTiming::new());
        let result:Result<(),String>=measure(&timing,Part::NativePump,|| Err("device fault".into()));
        assert_eq!(result,Err("device fault".into()));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _:Result<(),String>=measure(&timing,Part::MediaPoll,|| panic!("collector panic"));
        })).is_err());
        let timing=timing.borrow();
        assert_eq!(timing.active,0);
        assert_eq!(timing.totals[Part::NativePump as usize].rejected,1);
        assert_eq!(timing.totals[Part::MediaPoll as usize].unwound,1);
    }
    #[test]
    fn native_render_wait_is_separate_from_sleep_and_preserves_errors() {
        let timing = RefCell::new(PumpTiming::new());
        // Successful wakes (including timeout/not-started) are not rejections.
        use crate::audio::speech::DesktopRenderWake;
        for wake in [DesktopRenderWake::NotStarted, DesktopRenderWake::Signaled, DesktopRenderWake::TimedOut, DesktopRenderWake::DeadlineSignaled] {
            assert_eq!(measure_native_render_wait(&timing, || Ok(wake)), Ok(wake));
        }
        let result = measure_native_render_wait(&timing,
            || Err("permit cancelled".into()));
        assert_eq!(result, Err("permit cancelled".into()));
        let timing = timing.borrow();
        assert_eq!(timing.totals[Part::NativeRenderWait as usize].count, 5);
        assert_eq!(timing.totals[Part::NativeRenderWait as usize].rejected, 1);
        assert_eq!(timing.totals[Part::RequestedSleep as usize].count, 0);
        let receipt = timing.receipt();
        let parts = receipt["parts"].as_array().unwrap();
        assert_eq!(parts.len(), PART_COUNT);
        for (index, part) in PARTS.iter().enumerate() {
            assert_eq!(*part as usize, index);
            assert_eq!(parts[index]["part"], serde_json::to_value(part).unwrap());
        }
        assert_eq!(parts[Part::NativeRenderWait as usize]["part"], "nativeRenderWait");
        assert_eq!(receipt["schemaVersion"], 3);
        assert_eq!(receipt["wakeIdentityPolicy"], "returned-native-result/v1");
        assert_eq!(receipt["nativeRenderWaitMechanism"], "event-or-local-high-resolution-deadline/v1");
        assert_eq!(receipt["nativeRenderWaitTimeoutMs"], 2);
        for (index, wake) in ["notStarted", "signaled", "timedOut", "deadlineSignaled"].iter().enumerate() {
            assert_eq!(receipt["recentSpans"][index]["nativeRenderWake"], *wake);
            assert_eq!(receipt["recentSpans"][index]["outcome"], "completed");
        }
        assert_eq!(receipt["recentSpans"][4]["nativeRenderWake"], Value::Null);
        let maximum = &receipt["parts"][Part::NativeRenderWait as usize]["totals"]["maximumSpan"];
        let sequence = maximum["sequence"].as_u64().unwrap() as usize;
        assert_eq!(maximum, &receipt["recentSpans"][sequence]);
        assert_eq!(receipt["nativeRenderWakeTotals"],json!({"notStarted":1,"signaled":1,"timedOut":1,"deadlineSignaled":1}));
        assert_eq!(receipt["activeSpanCount"], 0);
    }
    #[test]
    fn returned_wait_identity_survives_nested_callback_and_unwind() {
        use crate::audio::speech::DesktopRenderWake;
        let timing = RefCell::new(PumpTiming::new());
        assert_eq!(measure_native_render_wait(&timing, || {
            measure(&timing, Part::ReferenceCallback, || Ok(()))?;
            Ok(DesktopRenderWake::Signaled)
        }), Ok(DesktopRenderWake::Signaled));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = measure_native_render_wait(&timing, || {
                measure(&timing, Part::MediaPoll, || Ok(()))?;
                panic!("wait panic");
            });
        })).is_err());
        let timing = timing.borrow();
        assert_eq!(timing.active, 0); assert_eq!(timing.completed, 4);
        assert_eq!(timing.spans[0].native_render_wake, None);
        assert_eq!(timing.spans[1].native_render_wake, Some(NativeRenderWake::Signaled));
        assert_eq!(timing.spans[2].native_render_wake, None);
        assert_eq!(timing.spans[3].outcome, Outcome::Unwound);
        assert_eq!(timing.spans[3].native_render_wake, None);
        assert_eq!(timing.native_render_wakes, [0, 1, 0, 0]);
    }
    #[test]
    fn evicted_maximum_keeps_its_own_wake_not_the_latest_aggregate() {
        let mut timing = PumpTiming::new(); let origin = timing.origin;
        for sequence in 0..1024_u64 {
            let wake = if sequence == 0 { NativeRenderWake::Signaled } else { NativeRenderWake::TimedOut };
            let duration = if sequence == 0 { 2000 } else { sequence };
            timing.record(Part::NativeRenderWait, origin, origin + Duration::from_micros(duration),
                Some(100), Some(100 + duration * 10), Outcome::Completed, Some(wake));
        }
        assert_eq!(timing.native_render_wakes, [0, 1, 1023, 0]);
        assert_eq!(timing.evicted, 512);
        assert!(timing.spans.iter().all(|span| span.native_render_wake == Some(NativeRenderWake::TimedOut)));
        let maximum = timing.totals[Part::NativeRenderWait as usize].maximum_span.as_ref().unwrap();
        assert_eq!(maximum.sequence, 0);
        assert_eq!(maximum.native_render_wake, Some(NativeRenderWake::Signaled));
        assert_eq!(timing.receipt()["parts"][Part::NativeRenderWait as usize]["totals"]["maximumSpan"]["nativeRenderWake"], "signaled");
    }
    #[test]
    fn generic_measurement_cannot_fabricate_a_completed_native_wait() {
        let timing = RefCell::new(PumpTiming::new()); let mut called = false;
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = measure(&timing, Part::NativeRenderWait, || { called = true; Ok(()) });
        })).is_err());
        assert!(!called); assert_eq!(timing.borrow().completed, 0); assert_eq!(timing.borrow().active, 0);
    }
    #[test]
    fn missing_zero_or_retreating_qpc_never_becomes_clock_authority() {
        let mut timing=PumpTiming::new();let now=timing.origin;
        for (start,end) in [(None,Some(1)),(Some(0),Some(1)),(Some(5),Some(4))] {
            timing.record(Part::LoopGap,now,now+Duration::from_micros(100),start,end,Outcome::Completed,None);
        }
        assert_eq!(timing.totals[Part::LoopGap as usize].invalid_qpc,3);
        assert!(timing.spans.iter().all(|span|!span.qpc_valid));
    }
}
