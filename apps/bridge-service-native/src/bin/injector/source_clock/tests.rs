use super::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct WriterState {
    pending: Vec<u8>, persisted: Vec<u8>, flushes: usize, syncs: usize,
    fail_write: bool, fail_newline: bool, fail_flush: bool, fail_sync: bool,
}
#[derive(Clone, Default)]
struct TestWriter(Arc<Mutex<WriterState>>);
impl Write for TestWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut state = self.0.lock().unwrap();
        if state.fail_write || (state.fail_newline && bytes == b"\n") {
            return Err(std::io::Error::other("injected write failure"));
        }
        state.pending.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let mut state = self.0.lock().unwrap();
        state.flushes += 1;
        if state.fail_flush { return Err(std::io::Error::other("injected flush failure")); }
        let pending = std::mem::take(&mut state.pending);
        state.persisted.extend_from_slice(&pending);
        Ok(())
    }
}
impl EvidenceWriter for TestWriter {
    fn sync_all(&self) -> std::io::Result<()> {
        let mut state = self.0.lock().unwrap();
        state.syncs += 1;
        if state.fail_sync { return Err(std::io::Error::other("injected sync failure")); }
        Ok(())
    }
}
impl TestWriter {
    fn rows(&self) -> Vec<serde_json::Value> {
        let state = self.0.lock().unwrap();
        std::str::from_utf8(&state.persisted).unwrap().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }
}
fn harness() -> (SourcePlaybackClock, TestWriter, TestWriter) {
    let accepted = TestWriter::default();
    let failed = TestWriter::default();
    let clock = SourcePlaybackClock {
        writer: Some(Box::new(accepted.clone())), metadata_path: None,
        failure_writer: Some(Box::new(failed.clone())), failure: None,
        origin: None, frequency: None, previous_position: 0,
        endpoint_id: "test-endpoint".into(), rate: 48_000, sequence: 0,
    };
    (clock, accepted, failed)
}
fn sample(position: u64, frequency: u64, qpc: u64) -> ClockObservation {
    ClockObservation { position, frequency, qpc, submitted: 960, padding: Ok(144) }
}
fn accept_two(clock: &mut SourcePlaybackClock) {
    clock.observe_sample(sample(48, 384_000, 10_001_250)).unwrap();
    clock.observe_sample(sample(48, 384_000, 10_002_238)).unwrap();
}
fn anchor(clock: &SourcePlaybackClock) -> (Option<u64>, Option<u64>, u64, u64) {
    (clock.origin, clock.frequency, clock.previous_position, clock.sequence)
}

#[test]
fn offending_third_sample_is_durable_but_not_accepted_and_finish_stays_failed() {
    let (mut clock, accepted, failed) = harness();
    accept_two(&mut clock);
    let before = anchor(&clock);
    let error = clock.observe_sample(sample(48, 384_000, 10_011_251)).unwrap_err();
    assert_eq!(error, "source render clock origin drift exceeds frozen 1ms bound");
    assert_eq!(anchor(&clock), before);
    let successes = accepted.rows();
    assert_eq!(successes.len(), 2);
    assert_eq!(successes[0], serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock",
        "sequence":0,"processId":std::process::id(),"endpointId":"test-endpoint","sampleRateHz":48_000,
        "clockPosition":48,"clockFrequency":384_000,"qpc100ns":10_001_250,
        "playbackStartQpc100ns":10_000_000,"submittedFrames":960,"paddingFrames":144}));
    let rows = failed.rows();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row["artifactKind"], "aec-source-playback-clock-failure");
    assert_eq!(row["sequence"], 2);
    assert_eq!(row["clockPosition"], 48);
    assert_eq!(row["clockFrequency"], 384_000);
    assert_eq!(row["qpc100ns"], 10_011_251);
    assert_eq!(row["paddingFrames"], 144);
    assert_eq!(row["submittedFrames"], 960);
    assert_eq!(row["computedPlaybackStartQpc100ns"], 10_010_001);
    assert_eq!(row["acceptedAnchor"], serde_json::json!({"playbackStartQpc100ns":10_000_000,
        "clockFrequency":384_000,"clockPosition":48,"successfulObservations":2}));
    assert_eq!(row["validationError"], error);
    assert_eq!(accepted.0.lock().unwrap().syncs, 1);
    assert_eq!(failed.0.lock().unwrap().syncs, 1);
    assert_eq!(clock.finish().unwrap_err(), error);
    // A terminal error cannot be cleared by another otherwise-valid sample;
    // no retry grows the sidecar or changes the accepted sequence.
    assert_eq!(clock.observe_sample(sample(96, 384_000, 10_002_500)).unwrap_err(), error);
    assert_eq!(anchor(&clock), before);
    assert_eq!(failed.rows().len(), 1);
}

#[test]
fn invalid_units_regression_and_frequency_changes_preserve_raw_sample_and_anchor() {
    for (position, frequency, qpc) in [
        (48, 0, 10_002_238), (48, 384_000, 0), (47, 384_000, 10_002_238),
        (0, 384_000, 10_002_238), (48, 48_000, 10_002_238),
    ] {
        let (mut clock, accepted, failed) = harness();
        accept_two(&mut clock);
        let before = anchor(&clock);
        let error = clock.observe_sample(sample(position, frequency, qpc)).unwrap_err();
        assert_eq!(error, "source render clock invalid/non-monotonic/frequency changed");
        assert_eq!(anchor(&clock), before);
        assert_eq!(accepted.rows().len(), 2);
        let rows = failed.rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["clockPosition"], position);
        assert_eq!(rows[0]["clockFrequency"], frequency);
        assert_eq!(rows[0]["qpc100ns"], qpc);
        assert_eq!(rows[0]["validationError"], error);
        if frequency == 0 || qpc == 0 {
            assert!(rows[0]["computedPlaybackStartQpc100ns"].is_null());
            assert_eq!(rows[0]["originCalculationError"], "source render clock units invalid");
        } else {
            assert_eq!(rows[0]["computedPlaybackStartQpc100ns"], source_clock_origin(position, frequency, qpc).unwrap());
        }
        assert!(clock.finish().is_err());
    }
}

#[test]
fn origin_underflow_and_overflow_are_recorded_without_creating_an_anchor() {
    for (position, frequency, qpc, expected) in [
        (48, 384_000, 1, "source render origin invalid"),
        (u64::MAX, 1, u64::MAX, "source render clock offset overflow"),
    ] {
        let (mut clock, accepted, failed) = harness();
        let before = anchor(&clock);
        assert_eq!(clock.observe_sample(sample(position, frequency, qpc)).unwrap_err(), expected);
        assert_eq!(anchor(&clock), before);
        assert!(accepted.rows().is_empty());
        let rows = failed.rows();
        assert_eq!(rows[0]["originCalculationError"], expected);
        assert_eq!(rows[0]["clockPosition"], position);
        assert_eq!(rows[0]["clockFrequency"], frequency);
        assert_eq!(rows[0]["qpc100ns"], qpc);
        assert!(rows[0]["acceptedAnchor"]["playbackStartQpc100ns"].is_null());
        assert!(clock.finish().is_err());
    }
}

#[test]
fn startup_skip_exact_bound_and_two_row_finish_gate_remain_unchanged() {
    let (mut clock, accepted, failed) = harness();
    let mut startup = sample(0, 384_000, 10_000_000);
    startup.padding = Err("startup padding unused".into());
    clock.observe_sample(startup).unwrap();
    assert_eq!(anchor(&clock), (None, None, 0, 0));
    assert_eq!(clock.finish().unwrap_err(), "source actual playback clock evidence incomplete");
    clock.observe_sample(sample(48, 384_000, 10_001_250)).unwrap();
    assert_eq!(clock.finish().unwrap_err(), "source actual playback clock evidence incomplete");
    assert_eq!(accepted.rows().len(), 1); // incomplete finish still flushes
    clock.observe_sample(sample(48, 384_000, 10_011_250)).unwrap();
    clock.finish().unwrap();
    assert_eq!(anchor(&clock), (Some(10_000_000), Some(384_000), 48, 2));
    assert_eq!(accepted.rows().len(), 2);
    assert!(failed.rows().is_empty());
}

#[test]
fn padding_error_does_not_hide_a_clock_violation_or_update_anchor() {
    let (mut clock, accepted, failed) = harness();
    accept_two(&mut clock);
    let before = anchor(&clock);
    let mut raw = sample(48, 384_000, 10_011_251);
    raw.padding = Err("injected padding API failure".into());
    assert!(clock.observe_sample(raw).unwrap_err().contains("origin drift"));
    assert_eq!(anchor(&clock), before);
    assert_eq!(accepted.rows().len(), 2);
    let rows = failed.rows();
    assert!(rows[0]["paddingFrames"].is_null());
    assert_eq!(rows[0]["paddingError"], "injected padding API failure");
    assert!(clock.finish().is_err());
}

#[test]
fn otherwise_valid_sample_with_padding_error_is_diagnostic_not_success() {
    let (mut clock, accepted, failed) = harness();
    let mut raw = sample(48, 384_000, 10_001_250);
    raw.padding = Err("injected padding API failure".into());
    assert_eq!(clock.observe_sample(raw).unwrap_err(), "injected padding API failure");
    assert_eq!(anchor(&clock), (None, None, 0, 0));
    assert!(accepted.rows().is_empty());
    assert_eq!(failed.rows()[0]["computedPlaybackStartQpc100ns"], 10_000_000);
    assert!(clock.finish().is_err());
}

#[test]
fn accepted_write_or_newline_error_never_commits_state() {
    for newline_only in [false, true] {
        let (mut clock, accepted, failed) = harness();
        {
            let mut state = accepted.0.lock().unwrap();
            state.fail_write = !newline_only;
            state.fail_newline = newline_only;
        }
        assert!(clock.observe_sample(sample(48, 384_000, 10_001_250)).unwrap_err().contains("write source clock evidence"));
        assert_eq!(anchor(&clock), (None, None, 0, 0));
        assert_eq!(failed.rows().len(), 1);
        assert!(failed.rows()[0]["validationError"].as_str().unwrap().contains("injected write failure"));
        assert!(clock.finish().is_err());
    }
}

#[test]
fn sidecar_write_flush_and_sync_errors_fail_closed_and_still_flush_accepted_rows() {
    for operation in ["write", "newline", "flush", "sync"] {
        let (mut clock, accepted, failed) = harness();
        accept_two(&mut clock);
        let before = anchor(&clock);
        {
            let mut state = failed.0.lock().unwrap();
            state.fail_write = operation == "write";
            state.fail_newline = operation == "newline";
            state.fail_flush = operation == "flush";
            state.fail_sync = operation == "sync";
        }
        let error = clock.observe_sample(sample(48, 384_000, 10_011_251)).unwrap_err();
        assert!(error.contains("origin drift exceeds frozen 1ms bound"));
        assert!(error.contains("injected"));
        assert_eq!(anchor(&clock), before);
        assert_eq!(accepted.rows().len(), 2);
        assert_eq!(accepted.0.lock().unwrap().syncs, 1);
        assert_eq!(failed.0.lock().unwrap().syncs, 1);
        assert!(clock.finish().is_err());
    }
}

#[test]
fn accepted_flush_or_sync_failure_is_sticky_and_does_not_prevent_sidecar_flush() {
    for sync_only in [false, true] {
        let (mut clock, accepted, failed) = harness();
        accept_two(&mut clock);
        {
            let mut state = accepted.0.lock().unwrap();
            state.fail_flush = !sync_only;
            state.fail_sync = sync_only;
        }
        assert!(clock.finish().unwrap_err().contains("injected"));
        assert_eq!(failed.0.lock().unwrap().flushes, 1);
        assert_eq!(failed.0.lock().unwrap().syncs, 1);
        {
            let mut state = accepted.0.lock().unwrap();
            state.fail_flush = false;
            state.fail_sync = false;
        }
        assert!(clock.finish().is_err());
        assert_eq!(clock.sequence, 2);
    }
}

#[test]
fn unavailable_native_api_result_flushes_existing_rows_and_latches_failure() {
    let (mut clock, accepted, failed) = harness();
    accept_two(&mut clock);
    let before = anchor(&clock);
    assert_eq!(clock.reject(None, "injected clock API failure".into()).unwrap_err(), "injected clock API failure");
    assert_eq!(anchor(&clock), before);
    assert_eq!(accepted.rows().len(), 2);
    assert!(failed.rows().is_empty()); // no fabricated raw API result
    assert!(clock.finish().is_err());
}

#[test]
fn accepted_flush_failure_during_rejection_still_persists_the_offending_sample() {
    let (mut clock, accepted, failed) = harness();
    accept_two(&mut clock);
    let before = anchor(&clock);
    accepted.0.lock().unwrap().fail_flush = true;
    let error = clock.observe_sample(sample(48, 384_000, 10_011_251)).unwrap_err();
    assert!(error.contains("origin drift exceeds frozen 1ms bound"));
    assert!(error.contains("flush accepted source clock evidence"));
    assert_eq!(anchor(&clock), before);
    assert_eq!(failed.rows()[0]["qpc100ns"], 10_011_251);
    assert_eq!(failed.0.lock().unwrap().syncs, 1);
    accepted.0.lock().unwrap().fail_flush = false;
    assert!(clock.finish().is_err());
    assert_eq!(accepted.rows().len(), 2);
}

#[test]
fn frozen_vm171_five_points_reject_first_anchor_without_certifying_clock_fault() {
    // Exact raw values from diagnostic-b70ad2f0; never an acceptance calibration.
    let readings = [
        (40, 3_066_304_583_946),
        (3_864, 3_066_304_675_778),
        (7_712, 3_066_304_779_540),
        (11_544, 3_066_304_879_188),
        (15_392, 3_066_304_971_078),
    ];
    let origins: Vec<u64> = readings.iter().map(|(p, q)| source_clock_origin(*p, 384_000, *q).unwrap()).collect();
    let low = origins.iter().map(|o| o - 10_000).max().unwrap();
    let high = origins.iter().map(|o| o + 10_000).min().unwrap();
    // A feasible unknown-origin interval is a diagnostic fact, NOT a green gate.
    assert!(low <= high);
    assert_eq!(origins[0].abs_diff(origins[4]), 12_660);
    let (mut clock, accepted, failed) = harness();
    for (position, qpc) in readings.iter().take(4) {
        clock.observe_sample(sample(*position, 384_000, *qpc)).unwrap();
    }
    let before = anchor(&clock);
    assert!(clock.observe_sample(sample(readings[4].0, 384_000, readings[4].1)).is_err());
    assert_eq!(anchor(&clock), before);
    assert_eq!(accepted.rows().len(), 4);
    assert_eq!(failed.rows().len(), 1);
    assert!(clock.finish().is_err());
}

#[test]
fn small_consecutive_clock_errors_cannot_replace_the_global_origin_gate() {
    let (mut clock, accepted, failed) = harness();
    let mut previous_origin = None;
    for index in 0_u64..=11 {
        let position = 40 + 3_840 * index;
        let qpc = 10_001_250 + 99_000 * index;
        let origin = source_clock_origin(position, 384_000, qpc).unwrap();
        if let Some(previous) = previous_origin {
            // Only 0.1 ms per interval, but the error accumulates without bound.
            assert_eq!(origin.abs_diff(previous), 1_000);
        }
        previous_origin = Some(origin);
        let result = clock.observe_sample(sample(position, 384_000, qpc));
        if index <= 10 { assert!(result.is_ok()); } else { assert!(result.is_err()); }
    }
    assert_eq!(accepted.rows().len(), 11);
    let rejected = failed.rows();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["sequence"], 11);
    assert!(clock.finish().is_err());
}
