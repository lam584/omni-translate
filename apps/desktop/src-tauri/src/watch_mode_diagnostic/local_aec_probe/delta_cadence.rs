//! Simulator delivery authority: jitter never changes the PCM sample clock.
//! No skipped deltas, fabricated PCM, sleeps or device-policy changes.
use std::time::{Duration, Instant};
use serde_json::{json, Value};

const MAXIMUM_LATENESS: Duration = Duration::from_millis(100);
pub(super) struct DeltaCadence {
    origin: Instant,
    origin_qpc_100ns: u64,
    next_index: u64,
    last_admission: Instant,
    last_offset_micros: u64,
    last_qpc_100ns: u64,
}
pub(super) struct Admission {
    pub(super) index: u64,
    pub(super) scheduled_offset_micros: u64,
    pub(super) admission_offset_micros: u64,
    pub(super) admission_qpc_100ns: u64,
    pub(super) lateness_micros: u64,
    pub(super) interval_ms: u64,
}
impl DeltaCadence {
    pub(super) fn new(origin: Instant, qpc: Option<u64>) -> Result<Self, String> {
        let qpc = qpc.filter(|qpc| *qpc > 0).ok_or("delta cadence requires a positive QPC origin")?;
        Ok(Self { origin, origin_qpc_100ns: qpc, next_index: 0, last_admission: origin, last_offset_micros: 0, last_qpc_100ns: qpc })
    }
    fn scheduled_offset(&self) -> Duration { Duration::from_millis(self.next_index * 100) }
    pub(super) fn due(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.origin) >= self.scheduled_offset()
    }
    // Call only after real PCM admission. Backpressure/polling never moves due.
    pub(super) fn admitted(&mut self, now: Instant, qpc: Option<u64>) -> Result<Admission, String> {
        let offset = now.checked_duration_since(self.origin).ok_or("delta admission precedes origin")?;
        let lateness = offset.checked_sub(self.scheduled_offset()).ok_or("delta admission precedes its sample deadline")?;
        if lateness >= MAXIMUM_LATENESS { return Err("delta admission missed its bounded sample-clock deadline".into()); }
        let qpc = qpc.filter(|qpc| if self.next_index == 0 { *qpc >= self.last_qpc_100ns } else { *qpc > self.last_qpc_100ns }).ok_or("delta admission QPC missing or retreated")?;
        let offset_micros = u64::try_from(offset.as_micros()).map_err(|_| "delta sample clock overflow")?;
        if (qpc - self.origin_qpc_100ns).abs_diff(offset_micros.saturating_mul(10)) > 10_000 {
            return Err("delta admission QPC and monotonic clocks disagree".into());
        }
        now.checked_duration_since(self.last_admission).ok_or("delta admission clock retreated")?;
        let interval_micros = offset_micros.checked_sub(self.last_offset_micros).ok_or("delta reported clock retreated")?;
        if self.next_index > 0 && interval_micros == 0 { return Err("delta reported admission clock did not advance".into()); }
        let admission = Admission { index: self.next_index,
            scheduled_offset_micros: self.next_index * 100_000,
            admission_offset_micros: offset_micros, admission_qpc_100ns: qpc,
            lateness_micros: lateness.as_micros() as u64, interval_ms: interval_micros / 1000 };
        self.next_index += 1;
        self.last_admission = now;
        self.last_offset_micros = offset_micros;
        self.last_qpc_100ns = qpc;
        Ok(admission)
    }
    pub(super) fn contract(&self) -> Value {
        json!({"schemaVersion":1,"policy":"absolute-sample-clock/v1","intervalMs":100,
            "originQpc100ns":self.origin_qpc_100ns,"maximumLatenessMicros":100_000,
            "singleAdmissionPerPump":true})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGIN_QPC: u64 = 10_000_000;
    fn qpc(us: u64) -> Option<u64> { Some(ORIGIN_QPC + us * 10) }
    #[test]
    fn two_ms_poll_jitter_does_not_accumulate_for_full_fixture() {
        let origin = Instant::now(); let mut cadence = DeltaCadence::new(origin, qpc(0)).unwrap();
        for index in 0..1800_u64 {
            let due = origin + Duration::from_millis(index * 100);
            if index > 0 { assert!(!cadence.due(due - Duration::from_micros(1))); }
            let now = due + Duration::from_millis(2);
            assert!(cadence.due(now));
            let admitted = cadence.admitted(now, qpc(index * 100_000 + 2000)).unwrap();
            assert_eq!(admitted.index, index); assert_eq!(admitted.lateness_micros, 2000);
            assert_eq!(admitted.scheduled_offset_micros, index * 100_000);
        }
        assert_eq!(cadence.next_index, 1800);
    }
    #[test]
    fn a_late_delta_does_not_postpone_next_deadline_or_reorder_pcm() {
        let origin = Instant::now(); let mut cadence = DeltaCadence::new(origin,qpc(0)).unwrap();
        cadence.admitted(origin,qpc(0)).unwrap();
        let late = cadence.admitted(origin + Duration::from_millis(180),qpc(180_000)).unwrap();
        assert_eq!(late.interval_ms,180); assert_eq!(late.lateness_micros,80_000);
        assert!(!cadence.due(origin + Duration::from_millis(199)));
        let restored = cadence.admitted(origin + Duration::from_millis(200),qpc(200_000)).unwrap();
        assert_eq!(restored.index,2); assert_eq!(restored.interval_ms,20); assert_eq!(restored.lateness_micros,0);
    }
    #[test]
    fn interval_uses_the_same_reported_microsecond_offsets_as_the_consumer() {
        let origin=Instant::now(); let mut cadence=DeltaCadence::new(origin,qpc(0)).unwrap();
        cadence.admitted(origin+Duration::from_nanos(1900),qpc(1)).unwrap();
        let admission=cadence.admitted(origin+Duration::from_nanos(100_001_100),qpc(100_001)).unwrap();
        assert_eq!(admission.admission_offset_micros,100_001);
        assert_eq!(admission.interval_ms,100);
    }
    #[test]
    fn device_preparation_does_not_consume_the_producer_deadline() {
        let device_opened_at=Instant::now();
        let producer_origin=device_opened_at+Duration::from_millis(180);
        let mut cadence=DeltaCadence::new(producer_origin,qpc(180_000)).unwrap();
        let admission=cadence.admitted(producer_origin,qpc(180_000)).unwrap();
        assert_eq!(admission.scheduled_offset_micros,0); assert_eq!(admission.lateness_micros,0);
    }
    #[test]
    fn subsequent_admissions_require_strict_qpc_and_reported_progress() {
        let origin=Instant::now(); let mut cadence=DeltaCadence::new(origin,qpc(0)).unwrap();
        cadence.admitted(origin+Duration::from_nanos(99_999_100),qpc(100_000)).unwrap();
        assert!(cadence.admitted(origin+Duration::from_nanos(100_000_100),qpc(100_000)).is_err());
        assert_eq!(cadence.next_index,1);
    }
    #[test]
    fn blocked_polling_does_not_consume_or_reanchor_deadline() {
        let origin=Instant::now(); let mut cadence=DeltaCadence::new(origin,qpc(0)).unwrap();
        for us in [0,2000,8000,42_000] {assert!(cadence.due(origin+Duration::from_micros(us)));}
        assert_eq!(cadence.next_index,0);
        assert_eq!(cadence.admitted(origin+Duration::from_millis(50),qpc(50_000)).unwrap().index,0);
        assert!(!cadence.due(origin+Duration::from_millis(99)));
    }
    #[test]
    fn early_excessively_late_missing_or_inconsistent_clock_is_rejected_without_advancing() {
        let origin=Instant::now(); assert!(DeltaCadence::new(origin,None).is_err()); assert!(DeltaCadence::new(origin,Some(0)).is_err());
        let mut cadence=DeltaCadence::new(origin,qpc(0)).unwrap();
        for (ms, clock) in [(100,qpc(100_000)),(2,None),(2,Some(1)),(2,qpc(5000))] {
            assert!(cadence.admitted(origin+Duration::from_millis(ms),clock).is_err()); assert_eq!(cadence.next_index,0);
        }
        cadence.admitted(origin,qpc(0)).unwrap();
        assert!(cadence.admitted(origin+Duration::from_millis(99),qpc(99_000)).is_err()); assert_eq!(cadence.next_index,1);
    }
}
