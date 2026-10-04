//! Optional post-capture APM observations for the file-only offline benchmark.
use super::{FRAME, Result};
use serde::Serialize;

const APM_STATS_CADENCE_SAMPLES: usize = FRAME * 10;

// These are post-frame observation points, not 100ms window averages. The
// existing APM GetStatistics consumes a capacity-one reporter queue: current
// FFI counters do not prove the signal payload belongs to the latest frame.
// The exported signals expose no origin sample ordinal. A cadence range labels
// capture input ordinals only: no output latency, lag fit, or acceptance clock.
// Production reads its last-good wrapper cache, without an extra native query;
// linked-direct uses the existing public stats query. Neither signal gates PCM.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct ApmStatsObservation {
    observed_render_frames: Option<u64>, observed_capture_frames: Option<u64>,
    native_reset_count: Option<u64>, erle_db: Option<f64>,
    residual_echo_likelihood: Option<f64>, reported_delay_ms: Option<i32>,
    production_stats_read_failure_count: Option<u64>,
}
impl ApmStatsObservation {
    #[cfg(feature = "webrtc-aec3")]
    pub(super) fn from_production(stats: super::super::EchoCancellerEngineStats) -> Self {
        Self { observed_render_frames: Some(stats.render_10ms_frames),
            observed_capture_frames: Some(stats.capture_10ms_frames),
            native_reset_count: Some(stats.reset_count), erle_db: stats.erle_db,
            residual_echo_likelihood: stats.residual_echo_likelihood,
            reported_delay_ms: stats.reported_delay_ms,
            production_stats_read_failure_count: Some(stats.stats_read_failure_count) }
    }
    #[cfg(feature = "webrtc-aec3")]
    pub(super) fn from_linked_direct(stats: omni_webrtc_aec3::Aec3Stats) -> Self {
        Self { observed_render_frames: Some(stats.render_10ms_frames),
            observed_capture_frames: Some(stats.capture_10ms_frames),
            native_reset_count: Some(stats.reset_count), erle_db: stats.erle_db,
            residual_echo_likelihood: stats.residual_echo_likelihood,
            reported_delay_ms: stats.delay_ms, production_stats_read_failure_count: None }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ApmSnapshotStatus { FreshCounterMatched, StaleOrCounterMismatch, ReadError }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApmSnapshot {
    start_sample: usize, end_sample: usize,
    expected_render_frames: u64, expected_capture_frames: u64,
    observed_render_frames: Option<u64>, observed_capture_frames: Option<u64>,
    native_reset_count: Option<u64>, erle_db: Option<f64>,
    residual_echo_likelihood: Option<f64>, reported_delay_ms: Option<i32>,
    production_stats_read_failure_count: Option<u64>, collection_read_failure_count: u64,
    status: ApmSnapshotStatus, error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApmTelemetry {
    version: u32, cadence_samples: usize, sample_range_authority: &'static str,
    observation_meaning: &'static str, stats_source: &'static str,
    signal_sample_authority: &'static str, freshness_meaning: &'static str,
    snapshots: Vec<ApmSnapshot>,
}
pub(super) struct ApmTelemetryCollector {
    telemetry: Option<ApmTelemetry>, sample_count: usize, start_sample: usize,
    collection_read_failure_count: u64,
}
impl ApmTelemetryCollector {
    pub(super) fn new(enabled: bool, sample_count: usize, stats_source: &'static str) -> Self {
        Self { telemetry: enabled.then(|| ApmTelemetry { version: 1,
                cadence_samples: APM_STATS_CADENCE_SAMPLES,
                sample_range_authority: "capture-input-sample-ordinal-not-output-latency-or-clock",
                observation_meaning: "point-after-last-frame-not-window-average",
                stats_source,
                signal_sample_authority: "public-statistics-payload-has-no-origin-sample-ordinal",
                freshness_meaning: "getter-counters-match-processed-frames-not-signal-payload-age",
                snapshots: Vec::new() }),
            sample_count, start_sample: 0, collection_read_failure_count: 0 }
    }
    // Invoke only after a complete capture frame has been collected. A lazy
    // query makes disabled/non-cadence calls inert. Failure cannot propagate
    // into the audio loop, erase PCM, reset adaptation, or skip a later read.
    pub(super) fn after_capture_frame(&mut self, end_sample: usize,
        read: impl FnOnce() -> Result<ApmStatsObservation>) {
        let Some(telemetry) = self.telemetry.as_mut() else { return; };
        if end_sample % APM_STATS_CADENCE_SAMPLES != 0 && end_sample != self.sample_count { return; }
        let expected_frames = (end_sample / FRAME) as u64;
        let (observation, status, error) = match read() {
            Ok(observation) => {
                let matched = observation.observed_render_frames == Some(expected_frames)
                    && observation.observed_capture_frames == Some(expected_frames);
                (observation, if matched { ApmSnapshotStatus::FreshCounterMatched }
                    else { ApmSnapshotStatus::StaleOrCounterMismatch }, None)
            }
            Err(error) => {
                self.collection_read_failure_count += 1;
                (ApmStatsObservation::default(), ApmSnapshotStatus::ReadError, Some(error))
            }
        };
        let fresh = status == ApmSnapshotStatus::FreshCounterMatched;
        telemetry.snapshots.push(ApmSnapshot { start_sample: self.start_sample, end_sample,
            expected_render_frames: expected_frames, expected_capture_frames: expected_frames,
            observed_render_frames: observation.observed_render_frames,
            observed_capture_frames: observation.observed_capture_frames,
            native_reset_count: observation.native_reset_count,
            erle_db: if fresh { observation.erle_db.filter(|v| v.is_finite()) } else { None },
            residual_echo_likelihood: if fresh { observation.residual_echo_likelihood.filter(|v| v.is_finite()) } else { None },
            reported_delay_ms: if fresh { observation.reported_delay_ms } else { None },
            production_stats_read_failure_count: observation.production_stats_read_failure_count,
            collection_read_failure_count: self.collection_read_failure_count, status, error });
        self.start_sample = end_sample;
    }
    pub(super) fn finish(self) -> Option<ApmTelemetry> { self.telemetry }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{analyze, toy_manifest, validate_manifest, BackendReport, ControlReport,
        Manifest, OutputFile, OutputFiles, RATE};

    // Collector fixtures below test only metadata/control flow, never AEC quality.
    fn apm_test_observation(frames: u64) -> ApmStatsObservation {
        ApmStatsObservation { observed_render_frames: Some(frames),
            observed_capture_frames: Some(frames), native_reset_count: Some(0),
            erle_db: Some(12.0), residual_echo_likelihood: Some(0.25), reported_delay_ms: Some(8),
            production_stats_read_failure_count: None }
    }
    fn apm_test_output_files() -> OutputFiles {
        let file = || OutputFile { path: "unused-test-descriptor".into(), sha256: "0".repeat(64),
            channel_count: 1, sample_count: FRAME, sample_rate_hz: RATE, encoding: "f32le" };
        OutputFiles { raw_stereo: file(), raw_mono: file(), wav_stereo: file(), wav_mono: file() }
    }
    #[test]
    fn apm_manifest_flag_is_opt_in_and_uses_camel_case() {
        assert!(!toy_manifest().diagnostic_apm_stats);
        let file = serde_json::json!({"path":"audio.f32le","sha256":"0".repeat(64)});
        let case = serde_json::json!({"id":"case","sampleCount":480,
            "files":{"render":file,"source":file,"echo":file,"input":file},
            "delayHintMs":0,"segments":[{"name":"all","startSample":0,"endSample":480}],
            "changes":[],"sourceEndSample":480,"renderEndSample":480,"negativeControl":false});
        let manifest: Manifest = serde_json::from_value(serde_json::json!({"schemaVersion":1,
            "artifactKind":"production-aec-offline-benchmark-inputs","sampleRateHz":48000,
            "channelCount":1,"frameSamples":480,"benchmarkId":"00000000-0000-4000-8000-000000000001",
            "definitionSha256":"0".repeat(64),"cases":[case],"diagnosticApmStats":true})).unwrap();
        assert!(manifest.diagnostic_apm_stats);
        assert!(validate_manifest(&manifest).is_ok());
    }
    #[test]
    fn apm_disabled_does_not_query_or_serialize_backend_telemetry() {
        let mut collector = ApmTelemetryCollector::new(false, FRAME * 21, "linked-direct-public-stats");
        let mut calls = 0;
        for i in 1..=21 {
            collector.after_capture_frame(i * FRAME, || { calls += 1; Ok(apm_test_observation(i as u64)) });
        }
        assert_eq!(calls, 0);
        let apm_telemetry = collector.finish();
        assert!(apm_telemetry.is_none());
        let quiet = vec![0.0; FRAME];
        let backend = BackendReport { id: "production", role: "metadata-test-not-algorithm-output",
            output_files: apm_test_output_files(), frame_counters: serde_json::json!({}),
            analysis: analyze(&quiet, &quiet, &quiet, &quiet), apm_telemetry };
        assert!(serde_json::to_value(backend).unwrap().get("apmTelemetry").is_none());
        let control = ControlReport { case_id: "double-talk".into(), id: "silence",
            role: "negative-control-not-algorithm-output", output_files: apm_test_output_files(),
            analysis: analyze(&quiet, &quiet, &quiet, &quiet) };
        assert!(serde_json::to_value(control).unwrap().get("apmTelemetry").is_none());
    }
    #[test]
    fn apm_missing_signals_and_optional_counters_stay_null() {
        let mut collector = ApmTelemetryCollector::new(true, FRAME, "linked-direct-public-stats");
        collector.after_capture_frame(FRAME, || Ok(ApmStatsObservation {
            observed_render_frames: Some(1), observed_capture_frames: Some(1),
            ..ApmStatsObservation::default() }));
        let telemetry = collector.finish().unwrap();
        assert_eq!(telemetry.snapshots[0].status, ApmSnapshotStatus::FreshCounterMatched);
        let json = serde_json::to_value(&telemetry).unwrap();
        let snapshot = &json["snapshots"][0];
        for name in ["nativeResetCount", "erleDb", "residualEchoLikelihood", "reportedDelayMs",
            "productionStatsReadFailureCount", "error"] {
            assert!(snapshot.get(name).unwrap().is_null(), "{name} must not become zero");
        }
        assert_eq!(snapshot["status"], "fresh-counter-matched");
        assert_eq!(snapshot["collectionReadFailureCount"], 0);
        assert_eq!(json["version"], 1);
        assert_eq!(json["cadenceSamples"], 4800);
        assert_eq!(json["sampleRangeAuthority"], "capture-input-sample-ordinal-not-output-latency-or-clock");
        assert_eq!(json["observationMeaning"], "point-after-last-frame-not-window-average");
        assert_eq!(json["statsSource"], "linked-direct-public-stats");
        assert_eq!(json["signalSampleAuthority"], "public-statistics-payload-has-no-origin-sample-ordinal");
        assert_eq!(json["freshnessMeaning"], "getter-counters-match-processed-frames-not-signal-payload-age");
    }
    #[test]
    fn apm_stale_or_mismatched_counters_clear_signals_not_evidence() {
        for (render, capture) in [(Some(9), Some(9)), (Some(10), Some(9)),
            (Some(11), Some(10)), (None, Some(10)), (Some(10), None)] {
            let mut collector = ApmTelemetryCollector::new(true, FRAME * 10, "production-cached-native-stats");
            let mut observation = apm_test_observation(10);
            observation.observed_render_frames = render;
            observation.observed_capture_frames = capture;
            observation.production_stats_read_failure_count = Some(3);
            collector.after_capture_frame(FRAME * 10, || Ok(observation));
            let telemetry = collector.finish().unwrap();
            let snapshot = &telemetry.snapshots[0];
            assert_eq!(snapshot.status, ApmSnapshotStatus::StaleOrCounterMismatch);
            assert_eq!(snapshot.observed_render_frames, render);
            assert_eq!(snapshot.observed_capture_frames, capture);
            assert_eq!(snapshot.native_reset_count, Some(0));
            assert_eq!(snapshot.production_stats_read_failure_count, Some(3));
            assert_eq!(snapshot.collection_read_failure_count, 0);
            assert!(snapshot.erle_db.is_none() && snapshot.residual_echo_likelihood.is_none()
                && snapshot.reported_delay_ms.is_none() && snapshot.error.is_none());
            assert_eq!(serde_json::to_value(snapshot).unwrap()["status"], "stale-or-counter-mismatch");
        }
    }
    #[test]
    fn apm_collection_errors_accumulate_without_losing_pcm_or_later_snapshots() {
        let mut collector = ApmTelemetryCollector::new(true, FRAME * 21, "linked-direct-public-stats");
        let frame = vec![0.25_f32; FRAME * 2];
        let mut pcm = Vec::new();
        let mut reads = 0;
        for i in 1..=21 {
            pcm.extend_from_slice(&frame); // mirrors run_backend's collect-before-query order
            collector.after_capture_frame(i * FRAME, || {
                reads += 1;
                if reads <= 2 { Err(format!("injected stats read failure {reads}")) }
                else { Ok(apm_test_observation(i as u64)) }
            });
        }
        assert_eq!(reads, 3);
        assert_eq!(pcm.len(), FRAME * 2 * 21);
        assert!(pcm.iter().all(|s| *s == 0.25));
        let telemetry = collector.finish().unwrap();
        assert_eq!(telemetry.snapshots.len(), 3);
        for (index, snapshot) in telemetry.snapshots[..2].iter().enumerate() {
            assert_eq!(snapshot.status, ApmSnapshotStatus::ReadError);
            assert_eq!(snapshot.collection_read_failure_count, (index + 1) as u64);
            assert!(snapshot.error.as_ref().unwrap().contains("injected stats read failure"));
            assert!(snapshot.observed_render_frames.is_none() && snapshot.observed_capture_frames.is_none()
                && snapshot.native_reset_count.is_none() && snapshot.erle_db.is_none()
                && snapshot.residual_echo_likelihood.is_none() && snapshot.reported_delay_ms.is_none()
                && snapshot.production_stats_read_failure_count.is_none());
            assert_eq!(serde_json::to_value(snapshot).unwrap()["status"], "read-error");
        }
        let final_snapshot = &telemetry.snapshots[2];
        assert_eq!(final_snapshot.status, ApmSnapshotStatus::FreshCounterMatched);
        assert_eq!(final_snapshot.collection_read_failure_count, 2);
        assert_eq!(final_snapshot.observed_capture_frames, Some(21));
        assert_eq!(final_snapshot.erle_db, Some(12.0));
        assert!(final_snapshot.error.is_none());
    }
    #[test]
    fn apm_full_cadence_and_short_tail_cover_all_capture_input_ordinals() {
        for frames in [3, 20, 21, 400, 14_100] {
            let count = frames * FRAME;
            let mut collector = ApmTelemetryCollector::new(true, count, "linked-direct-public-stats");
            let mut reads = 0;
            for i in 1..=frames {
                collector.after_capture_frame(i * FRAME, || {
                    reads += 1; Ok(apm_test_observation(i as u64))
                });
            }
            let telemetry = collector.finish().unwrap();
            let expected_reads = (count + APM_STATS_CADENCE_SAMPLES - 1) / APM_STATS_CADENCE_SAMPLES;
            assert_eq!(reads, expected_reads);
            assert_eq!(telemetry.snapshots.len(), expected_reads);
            let mut previous_end = 0;
            for (index, snapshot) in telemetry.snapshots.iter().enumerate() {
                let expected_end = ((index + 1) * APM_STATS_CADENCE_SAMPLES).min(count);
                assert_eq!(snapshot.start_sample, previous_end);
                assert_eq!(snapshot.end_sample, expected_end);
                assert_eq!(snapshot.expected_render_frames, (expected_end / FRAME) as u64);
                assert_eq!(snapshot.expected_capture_frames, (expected_end / FRAME) as u64);
                assert_eq!(snapshot.observed_render_frames, Some((expected_end / FRAME) as u64));
                assert_eq!(snapshot.observed_capture_frames, Some((expected_end / FRAME) as u64));
                assert_eq!(snapshot.status, ApmSnapshotStatus::FreshCounterMatched);
                previous_end = expected_end;
            }
            assert_eq!(previous_end, count);
        }
    }
    #[test]
    fn apm_fresh_signals_are_optional_finite_and_failures_are_separate() {
        let mut collector = ApmTelemetryCollector::new(true, FRAME * 20, "production-cached-native-stats");
        let mut first = apm_test_observation(10);
        first.erle_db = Some(f64::NAN);
        first.residual_echo_likelihood = Some(f64::INFINITY);
        first.production_stats_read_failure_count = Some(2);
        collector.after_capture_frame(FRAME * 10, || Ok(first));
        let mut second = apm_test_observation(20);
        second.production_stats_read_failure_count = Some(2);
        collector.after_capture_frame(FRAME * 20, || Ok(second));
        let telemetry = collector.finish().unwrap();
        assert!(telemetry.snapshots[0].erle_db.is_none()
            && telemetry.snapshots[0].residual_echo_likelihood.is_none());
        assert_eq!(telemetry.snapshots[0].reported_delay_ms, Some(8));
        assert_eq!(telemetry.snapshots[1].erle_db, Some(12.0));
        assert_eq!(telemetry.snapshots[1].residual_echo_likelihood, Some(0.25));
        for snapshot in &telemetry.snapshots {
            assert_eq!(snapshot.status, ApmSnapshotStatus::FreshCounterMatched);
            assert_eq!(snapshot.production_stats_read_failure_count, Some(2));
            assert_eq!(snapshot.collection_read_failure_count, 0);
        }
    }
}
