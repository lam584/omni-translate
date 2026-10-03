//! Owner-local, bounded capture diagnostics. No PCM, I/O, scheduling changes,
//! JSON on the measurement path, or acoustic/clock acceptance authority.
use std::{cell::{Cell, RefCell}, collections::VecDeque, rc::Rc, time::Instant};
use serde::Serialize;
use serde_json::{json, Value};

pub(super) type Handle = Option<Rc<CapturePumpTrace>>;

// The conflict bit lives outside the RefCell: diagnostics can fail to borrow
// without suppressing, panicking before, or changing the audio operation.
pub(super) struct CapturePumpTrace {
    collector: RefCell<CapturePumpTiming>,
    recording_borrow_conflict: Cell<bool>,
}
pub(super) fn new_handle(capture_owner_id: u64, thread_id: u32, endpoint_id: String) -> Handle {
    Some(Rc::new(CapturePumpTrace {
        collector: RefCell::new(CapturePumpTiming::new(capture_owner_id, thread_id, endpoint_id)),
        recording_borrow_conflict: Cell::new(false),
    }))
}
const PRE_LIMIT: usize = 8192;
const RETAINED_LIMIT: usize = 65536;
const WINDOW_LIMIT: usize = 65536;
const CONTEXT_MICROS: u64 = 1_000_000;
const PART_COUNT: usize = 12;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Part {
    ReadPacket, WorkAccounting, PacketAdmission, BoundaryProcess, PreparePacket,
    Dequeue, FullChunkProcess, Aec, Dispatch, QueryPacket, TailProcess, EventWait,
}
const PARTS: [Part; PART_COUNT] = [Part::ReadPacket, Part::WorkAccounting,
    Part::PacketAdmission, Part::BoundaryProcess, Part::PreparePacket, Part::Dequeue,
    Part::FullChunkProcess, Part::Aec, Part::Dispatch, Part::QueryPacket,
    Part::TailProcess, Part::EventWait];

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum WaitStatus { Signaled, TimedOut, Failed }

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(super) enum Observation {
    #[default]
    None,
    Query { packet_size: Option<u32> },
    Wait { status: WaitStatus, timeout_ms: u32 },
    Packet { device_frame_index: u64, qpc_100ns: u64, frames: usize,
        data_discontinuity: bool, timestamp_error: bool, silent: bool },
}
impl Observation {
    fn triggers_window(self) -> bool {
        matches!(self, Self::Packet { frames: 1.., data_discontinuity: true, .. }
            | Self::Packet { frames: 1.., timestamp_error: true, .. })
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Outcome { Completed, Rejected, Unwound }

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
    observation: Observation,
    frame_gap: Option<FrameGap>,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameGap {
    previous_end_device_frame_index: u64,
    current_device_frame_index: u64,
    forward_gap_frames: Option<u64>,
}
struct PreSpan { span: Span, retained: bool }
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Window { start_elapsed_micros: u64, end_elapsed_micros: u64 }
impl Window {
    fn intersects(self, span: &Span) -> bool {
        span.start_elapsed_micros <= self.end_elapsed_micros
            && span.end_elapsed_micros >= self.start_elapsed_micros
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    count: u64, rejected: u64, unwound: u64, invalid_qpc: u64,
    total_micros: u64, maximum_micros: u64, maximum_span: Option<Span>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservationTotals {
    queries: u64, query_size_unavailable: u64, query_empty: u64,
    query_nonempty: u64, maximum_packet_size: u32,
    waits: u64, signaled: u64, timed_out: u64, failed: u64,
    packets: u64, empty_packets: u64, data_discontinuities: u64, timestamp_errors: u64,
    frame_gaps: u64, last_frame_gap: Option<FrameGap>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Incomplete {
    invalid_qpc: bool, invalid_instant: bool, pre_ring_overflow: bool,
    retained_overflow: bool, window_overflow: bool, counter_overflow: bool,
    pre_window_unavailable: bool, unwound: bool, packet_frame_overflow: bool,
}
impl Incomplete {
    fn any(&self) -> bool {
        self.invalid_qpc || self.invalid_instant || self.pre_ring_overflow
            || self.retained_overflow || self.window_overflow || self.counter_overflow
            || self.pre_window_unavailable || self.unwound || self.packet_frame_overflow
    }
}
fn add(target: &mut u64, amount: u64, overflow: &mut bool) {
    match target.checked_add(amount) {
        Some(value) => *target = value,
        None => { *target = u64::MAX; *overflow = true; }
    }
}

pub(super) struct CapturePumpTiming {
    capture_owner_id: u64,
    thread_id: u32,
    endpoint_id: String,
    origin: Instant,
    active: u64,
    finished: u64,
    latest_end: u64,
    trigger_count: u64,
    pre_capacity_evictions: u64,
    pre_time_evictions: u64,
    retained_dropped: u64,
    windows_dropped: u64,
    totals: [Totals; PART_COUNT],
    observations: ObservationTotals,
    previous_packet_end: Option<u64>,
    incomplete: Incomplete,
    pre: VecDeque<PreSpan>,
    retained: Vec<Span>,
    windows: Vec<Window>,
    pre_limit: usize,
    retained_limit: usize,
    window_limit: usize,
}
impl CapturePumpTiming {
    pub(super) fn new(capture_owner_id: u64, thread_id: u32, endpoint_id: String) -> Self {
        Self::with_limits(capture_owner_id, thread_id, endpoint_id,
            PRE_LIMIT, RETAINED_LIMIT, WINDOW_LIMIT)
    }
    fn with_limits(capture_owner_id: u64, thread_id: u32, endpoint_id: String,
        pre_limit: usize, retained_limit: usize, window_limit: usize) -> Self {
        Self { capture_owner_id, thread_id, endpoint_id, origin: instant_now(),
            active: 0, finished: 0, latest_end: 0, trigger_count: 0,
            pre_capacity_evictions: 0, pre_time_evictions: 0, retained_dropped: 0,
            windows_dropped: 0, totals: std::array::from_fn(|_| Totals::default()),
            observations: ObservationTotals::default(), previous_packet_end: None,
            incomplete: Incomplete::default(),
            pre: VecDeque::with_capacity(pre_limit),
            retained: Vec::with_capacity(retained_limit), windows: Vec::with_capacity(window_limit),
            pre_limit, retained_limit, window_limit }
    }
    fn observe(&mut self, observation: Observation) -> Option<FrameGap> {
        let mut frame_gap = None;
        let t = &mut self.observations;
        let overflow = &mut self.incomplete.counter_overflow;
        match observation {
            Observation::None => {},
            Observation::Query { packet_size } => {
                add(&mut t.queries, 1, overflow);
                match packet_size {
                    None => add(&mut t.query_size_unavailable, 1, overflow),
                    Some(0) => add(&mut t.query_empty, 1, overflow),
                    Some(size) => {
                        add(&mut t.query_nonempty, 1, overflow);
                        t.maximum_packet_size = t.maximum_packet_size.max(size);
                    }
                }
            },
            Observation::Wait { status, .. } => {
                add(&mut t.waits, 1, overflow);
                add(match status { WaitStatus::Signaled => &mut t.signaled,
                    WaitStatus::TimedOut => &mut t.timed_out,
                    WaitStatus::Failed => &mut t.failed }, 1, overflow);
            },
            Observation::Packet { device_frame_index, frames, data_discontinuity,
                timestamp_error, .. } => {
                add(&mut t.packets, 1, overflow);
                if frames == 0 { add(&mut t.empty_packets, 1, overflow); }
                else {
                    add(&mut t.data_discontinuities, u64::from(data_discontinuity), overflow);
                    add(&mut t.timestamp_errors, u64::from(timestamp_error), overflow);
                    if let Some(previous_end) = self.previous_packet_end {
                        if previous_end != device_frame_index {
                            frame_gap = Some(FrameGap {
                                previous_end_device_frame_index: previous_end,
                                current_device_frame_index: device_frame_index,
                                forward_gap_frames: device_frame_index.checked_sub(previous_end),
                            });
                            add(&mut t.frame_gaps, 1, overflow);
                            t.last_frame_gap = frame_gap;
                        }
                    }
                    self.previous_packet_end = u64::try_from(frames).ok()
                        .and_then(|frames| device_frame_index.checked_add(frames));
                    if self.previous_packet_end.is_none() {
                        self.incomplete.packet_frame_overflow = true;
                    }
                }
            },
        }
        frame_gap
    }
    fn retain(&mut self, span: Span) {
        if self.retained.len() < self.retained_limit { self.retained.push(span); }
        else {
            self.incomplete.retained_overflow = true;
            add(&mut self.retained_dropped, 1, &mut self.incomplete.counter_overflow);
        }
    }
    fn trigger(&mut self, at: u64) {
        add(&mut self.trigger_count, 1, &mut self.incomplete.counter_overflow);
        if at < CONTEXT_MICROS { self.incomplete.pre_window_unavailable = true; }
        let end = at.checked_add(CONTEXT_MICROS).unwrap_or_else(|| {
            self.incomplete.counter_overflow = true; u64::MAX
        });
        let window = Window { start_elapsed_micros: at.saturating_sub(CONTEXT_MICROS),
            end_elapsed_micros: end };
        if let Some(last) = self.windows.last_mut().filter(|last|
            window.start_elapsed_micros <= last.end_elapsed_micros) {
            last.end_elapsed_micros = last.end_elapsed_micros.max(end);
        } else if self.windows.len() < self.window_limit { self.windows.push(window); }
        else {
            self.incomplete.window_overflow = true;
            add(&mut self.windows_dropped, 1, &mut self.incomplete.counter_overflow);
        }
        // Per-ring-entry membership, NOT a sequence high-water mark: a long
        // nested span may already be retained while an earlier short span was
        // outside the previous window and now belongs to this new one.
        for i in 0..self.pre.len() {
            if !self.pre[i].retained && window.intersects(&self.pre[i].span) {
                let span = self.pre[i].span.clone();
                self.pre[i].retained = true;
                self.retain(span);
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn record(&mut self, part: Part, start: u64, end: u64,
        start_qpc: Option<u64>, end_qpc: Option<u64>, outcome: Outcome,
        observation: Observation, invalid_instant: bool) {
        let duration = end.checked_sub(start).unwrap_or_else(|| {
            self.incomplete.invalid_instant = true; 0
        });
        self.incomplete.invalid_instant |= invalid_instant || end < self.latest_end;
        self.latest_end = self.latest_end.max(end);
        let qpc_valid = start_qpc.zip(end_qpc).is_some_and(|(a,b)| a > 0 && b >= a);
        self.incomplete.invalid_qpc |= !qpc_valid;
        self.incomplete.unwound |= outcome == Outcome::Unwound;
        let frame_gap = self.observe(observation);
        let span = Span { sequence: self.finished, part, start_elapsed_micros: start,
            end_elapsed_micros: end, duration_micros: duration,
            start_qpc_100ns: start_qpc, end_qpc_100ns: end_qpc, qpc_valid,
            outcome, observation, frame_gap };
        add(&mut self.finished, 1, &mut self.incomplete.counter_overflow);
        let totals = &mut self.totals[part as usize];
        let overflow = &mut self.incomplete.counter_overflow;
        add(&mut totals.count, 1, overflow);
        add(&mut totals.rejected, u64::from(outcome == Outcome::Rejected), overflow);
        add(&mut totals.unwound, u64::from(outcome == Outcome::Unwound), overflow);
        add(&mut totals.invalid_qpc, u64::from(!qpc_valid), overflow);
        add(&mut totals.total_micros, duration, overflow);
        if totals.maximum_span.is_none() || duration > totals.maximum_micros {
            totals.maximum_micros = duration;
            totals.maximum_span = Some(span.clone());
        }
        let earliest = end.saturating_sub(CONTEXT_MICROS);
        while self.pre.front().is_some_and(|s| s.span.end_elapsed_micros < earliest) {
            self.pre.pop_front();
            add(&mut self.pre_time_evictions, 1, &mut self.incomplete.counter_overflow);
        }
        if observation.triggers_window() || frame_gap.is_some() { self.trigger(end); }
        let window_index = self.windows.partition_point(|w| w.end_elapsed_micros < start);
        let retained = self.windows.get(window_index).is_some_and(|w| w.intersects(&span));
        if retained { self.retain(span.clone()); }
        if self.pre.len() == self.pre_limit {
            self.pre.pop_front();
            self.incomplete.pre_ring_overflow = true;
            add(&mut self.pre_capacity_evictions, 1, &mut self.incomplete.counter_overflow);
        }
        if self.pre_limit > 0 { self.pre.push_back(PreSpan { span, retained }); }
    }
    fn receipt(&self) -> Value {
        // Sorting/serialization occurs only when the caller explicitly asks for
        // a receipt, never inside an audio operation or the span destructor.
        let mut retained: Vec<&Span> = self.retained.iter().collect();
        retained.sort_by_key(|s| s.sequence);
        let pending_post_window = self.windows.last().is_some_and(|w|
            self.latest_end < w.end_elapsed_micros);
        json!({
            "schemaVersion":1,"artifactKind":"capture-pump-timing-diagnostic",
            "diagnosticOnly":true,"qualityAcceptance":false,
            "formalCaptureClockAcceptance":false,"releaseEligible":false,
            "captureOwnerId":self.capture_owner_id,"threadId":self.thread_id,
            "endpointId":self.endpoint_id,"monotonicDurationUnit":"microseconds",
            "windowTimeDomain":"collector-instant-elapsed-microseconds",
            "windowTriggerPolicy":"nonempty-packet-raw-flags-or-device-frame-gap",
            "contextBeforeMicros":CONTEXT_MICROS,"contextAfterMicros":CONTEXT_MICROS,
            "preSpanLimit":self.pre_limit,"retainedSpanLimit":self.retained_limit,
            "windowLimit":self.window_limit,"activeSpanCount":self.active,
            "finishedSpanCount":self.finished,"triggerCount":self.trigger_count,
            "frameGapTriggerCount":self.observations.frame_gaps,
            "preCapacityEvictions":self.pre_capacity_evictions,
            "preTimeEvictions":self.pre_time_evictions,
            "retainedDropped":self.retained_dropped,"windowsDropped":self.windows_dropped,
            "diagnosticIncomplete":self.incomplete.any() || self.active > 0
                || pending_post_window,
            "incompleteReasons":self.incomplete,"pendingPostWindow":pending_post_window,
            "unfinishedSpans":self.active > 0,"recordingBorrowConflict":false,
            "nestedSpansMayOverlap":true,"sumAcrossPartsIsNotLoopDuration":true,
            "observationTotals":self.observations,"windows":self.windows,
            "parts":PARTS.iter().map(|p| json!({"part":p,"totals":self.totals[*p as usize]}))
                .collect::<Vec<_>>(),
            "retainedSpans":retained,
            "preRingSpans":self.pre.iter().map(|p| &p.span).collect::<Vec<_>>()
        })
    }
}

struct Guard {
    timing: Rc<CapturePumpTrace>,
    origin: Instant,
    start: Instant,
    start_qpc: Option<u64>,
    part: Part,
    outcome: Outcome,
    observation: Observation,
}
impl Guard {
    fn new(timing: &Rc<CapturePumpTrace>, part: Part) -> Option<Self> {
        let Ok(mut collector) = timing.collector.try_borrow_mut() else {
            timing.recording_borrow_conflict.set(true);
            return None;
        };
        let mut active = collector.active;
        add(&mut active, 1, &mut collector.incomplete.counter_overflow);
        collector.active = active;
        let origin = collector.origin;
        drop(collector);
        Some(Self { timing: Rc::clone(timing), origin, start: instant_now(),
            start_qpc: qpc_now(), part, outcome: Outcome::Unwound,
            observation: Observation::None })
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let end = instant_now();
        let end_qpc = qpc_now();
        let elapsed = |at: Instant| at.checked_duration_since(self.origin)
            .and_then(|d| u64::try_from(d.as_micros()).ok());
        let start_us = elapsed(self.start);
        let end_us = elapsed(end);
        if let Ok(mut collector) = self.timing.collector.try_borrow_mut() {
            collector.active = collector.active.saturating_sub(1);
            collector.record(self.part, start_us.unwrap_or(0), end_us.unwrap_or(0),
                self.start_qpc, end_qpc, self.outcome, self.observation,
                start_us.is_none() || end_us.is_none());
        } else { self.timing.recording_borrow_conflict.set(true); }
    }
}

pub(super) fn measure<T,E>(timing: &Handle, part: Part,
    operation: impl FnOnce() -> Result<T,E>) -> Result<T,E> {
    // This branch must precede every clock read, Rc clone and allocation.
    let Some(timing) = timing else { return operation(); };
    let mut guard = Guard::new(timing, part);
    let result = operation();
    if let Some(guard) = &mut guard {
        guard.outcome = if result.is_ok() { Outcome::Completed } else { Outcome::Rejected };
    }
    result
}
pub(super) fn measure_observed<T,E>(timing: &Handle, part: Part,
    operation: impl FnOnce() -> (Result<T,E>, Observation)) -> Result<T,E> {
    let Some(timing) = timing else { return operation().0; };
    let mut guard = Guard::new(timing, part);
    let (result, observation) = operation();
    if let Some(guard) = &mut guard {
        guard.outcome = if result.is_ok() { Outcome::Completed } else { Outcome::Rejected };
        guard.observation = observation;
    }
    result
}
pub(super) fn receipt(timing: &Handle) -> Option<Value> {
    timing.as_ref().and_then(|timing| {
        let Ok(collector) = timing.collector.try_borrow() else {
            timing.recording_borrow_conflict.set(true);
            return None;
        };
        let mut value = collector.receipt();
        if timing.recording_borrow_conflict.get() {
            value["recordingBorrowConflict"] = json!(true);
            value["diagnosticIncomplete"] = json!(true);
        }
        Some(value)
    })
}

fn instant_now() -> Instant {
    #[cfg(test)]
    tests::CLOCK_READS.with(|reads| reads.set(reads.get() + 1));
    Instant::now()
}
fn qpc_now() -> Option<u64> {
    #[cfg(test)]
    {
        tests::QPC_READS.with(|reads| reads.set(reads.get() + 1));
        tests::TEST_QPC.with(Cell::get)
    }
    #[cfg(not(test))]
    { crate::audio::engine::aec_timing::qpc_now_100ns() }
}

#[cfg(test)]
#[path = "capture_pump_timing_tests.rs"]
mod tests;
