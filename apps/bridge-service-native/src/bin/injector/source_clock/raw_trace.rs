//! Isolated observation channel. Never supplies a successful source/c03 receipt.
use super::{error_text, MediaRender, SourcePlaybackClock};
use std::io::Write;
use std::path::{Path, PathBuf};
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

pub(super) struct RawClockTrace {
    writer: std::io::BufWriter<std::fs::File>,
    pub(super) path: PathBuf,
    sequence: u64,
    endpoint: String,
    rate: u32,
    qpc_frequency: u64,
    last_clock: Option<(u64,u64)>,
    last_padding: Option<usize>,
    last_submitted: usize,
}
impl RawClockTrace {
    pub(super) fn new(pcm: &Path, endpoint: &str, rate: u32) -> Result<Self, String> {
        let mut frequency = 0_i64;
        if unsafe { QueryPerformanceFrequency(&mut frequency) } == 0 || frequency <= 0 {
            return Err("diagnostic independent QPC frequency unavailable".into());
        }
        Self::open(pcm, endpoint, rate, frequency as u64)
    }
    fn open(pcm: &Path, endpoint: &str, rate: u32, qpc_frequency: u64) -> Result<Self, String> {
        let path = pcm.with_file_name("aec-source-playback-clock-raw-diagnostic.jsonl");
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|e| format!("create raw clock diagnostic: {e}"))?;
        Ok(Self { writer: std::io::BufWriter::new(file), path, sequence: 0,
            endpoint: endpoint.into(), rate, qpc_frequency, last_clock: None, last_padding: None, last_submitted: 0 })
    }
    fn independent_qpc(&self) -> Result<u64, String> {
        let mut counter = 0_i64;
        if unsafe { QueryPerformanceCounter(&mut counter) } == 0 || counter < 0 {
            return Err("diagnostic independent QPC unavailable".into());
        }
        let ticks = counter as u128 * 10_000_000 / self.qpc_frequency as u128;
        ticks.try_into().map_err(|_| "diagnostic independent QPC overflow".into())
    }
    pub(super) fn observe(&mut self, render: &MediaRender, submitted: usize, strict: &mut SourcePlaybackClock) -> Result<(), String> {
        // Always sample the same native client, even after strict validation latches failure.
        let padding = render.current_padding_frames();
        let Some(clock) = render.audio_clock.as_ref() else {
            return self.observe_reading(Err("source clock missing".into()), submitted, padding,
                (0, 0), None, strict, None);
        };
        let frequency = clock.get_frequency().map_err(error_text);
        let before = self.independent_qpc();
        let (hresult, reading) = clock.get_position_with_status();
        let after = self.independent_qpc();
        let raw = reading.and_then(|(position, qpc)| frequency.map(|frequency| (position, frequency, qpc)));
        let observation_error = before.as_ref().err().or(after.as_ref().err()).cloned();
        self.observe_reading(raw, submitted, padding, (before.unwrap_or(0), after.unwrap_or(0)),
            Some(hresult), strict, observation_error)
    }
    fn observe_reading(&mut self, raw: Result<(u64,u64,u64),String>, submitted: usize,
        padding: Result<usize,String>, call_qpc: (u64,u64), hresult: Option<i32>,
        strict: &mut SourcePlaybackClock, observation_error: Option<String>) -> Result<(), String> {
        // API failures abort playback, but only AFTER preserving their native evidence.
        // A strict validation error alone is sticky acceptance failure, NOT a Stop.
        let api_error = raw.as_ref().err().or(padding.as_ref().err()).cloned().or(observation_error.clone())
            .or_else(|| hresult.filter(|status| *status < 0).map(|status| format!("source clock API failure: HRESULT {status}")));
        let strict_raw = if hresult == Some(0) { raw.clone() } else {
            Err(format!("source clock accuracy/status unavailable: HRESULT {hresult:?}"))
        };
        let _strict_result = strict.observe_raw_clock(strict_raw, submitted, padding.clone());
        self.record(raw, submitted, padding, call_qpc, hresult, strict.validation_failure(), observation_error)?;
        if let Some(error) = api_error { Err(error) } else { Ok(()) }
    }
    fn record(&mut self, raw: Result<(u64,u64,u64),String>, submitted: usize, padding: Result<usize,String>,
        call_qpc: (u64, u64), hresult: Option<i32>, strict_failure: Option<&str>, observation_error: Option<String>) -> Result<(), String> {
        let value = serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock-raw-diagnostic",
            "scope":"diagnostic-only-not-c03","releaseEligible":false,"aecQualityAcceptance":false,
            "sequence":self.sequence,"processId":std::process::id(),"endpointId":self.endpoint,"sampleRateHz":self.rate,
            "clockPosition":raw.as_ref().ok().map(|v|v.0),"clockFrequency":raw.as_ref().ok().map(|v|v.1),
            "qpc100ns":raw.as_ref().ok().map(|v|v.2),"nativeApiError":raw.as_ref().err(),
            "callStartQpc100ns":call_qpc.0,"callEndQpc100ns":call_qpc.1,"independentQpcFrequency":self.qpc_frequency,
            "submittedFrames":submitted,"paddingFrames":padding.as_ref().ok(),"paddingError":padding.as_ref().err(),
            "observationError":observation_error,
            // Native typed vtable returns the actual HRESULT, including S_FALSE and errors.
            "rawClockHresult":hresult,"rawClockAccuracyAvailable":hresult.is_some(),
            "strictValidationFailure":strict_failure});
        serde_json::to_writer(&mut self.writer, &value).map_err(|e|format!("write raw clock diagnostic: {e}"))?;
        self.writer.write_all(b"\n").map_err(|e|format!("write raw clock diagnostic newline: {e}"))?;
        self.sequence += 1;
        // Completion cannot use failed/unreliable calls or observations not yet written.
        self.last_clock = if hresult == Some(0) && observation_error.is_none() {
            raw.as_ref().ok().filter(|v| v.1 > 0 && v.2 > 0).map(|v| (v.0,v.1))
        } else { None };
        self.last_padding = padding.ok();
        self.last_submitted = submitted;
        Ok(())
    }
    fn source_crossed(&self, frames: usize, rate: u32) -> bool {
        self.last_clock.is_some_and(|(position, frequency)| frequency > 0
            && position as u128 * rate as u128 >= frames as u128 * frequency as u128)
    }
    fn physical_playback_observed(&self, frames: usize, rate: u32) -> bool {
        self.last_submitted == frames && self.last_padding == Some(0) && self.source_crossed(frames, rate)
    }
    pub(super) fn wait_until_device_crosses_source(&mut self, render: &MediaRender, frames: usize, rate: u32,
        strict: &mut SourcePlaybackClock, started: std::time::Instant, timeout: std::time::Duration) -> Result<(), String> {
        // Require a fresh S_OK sample and zero padding within the ORIGINAL deadline.
        // The strict anchor/1ms gate is never used as a substitute for physical drain.
        loop {
            if started.elapsed() > timeout { return Err("device clock did not cross full source before the original safety deadline".into()); }
            self.observe(render, frames, strict)?;
            if started.elapsed() > timeout { return Err("device clock observation exceeded the original safety deadline".into()); }
            if self.physical_playback_observed(frames, rate) { return Ok(()); }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    pub(super) fn finish(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Err(error) = self.writer.flush() { errors.push(format!("flush raw clock diagnostic: {error}")); }
        if let Err(error) = self.writer.get_ref().sync_all() { errors.push(format!("sync raw clock diagnostic: {error}")); }
        if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_trace_keeps_post_failure_samples_without_ever_clearing_strict_failure() {
        let dir=tempfile::tempdir().unwrap(); let pcm=dir.path().join("source.f32le");
        let mut clock=SourcePlaybackClock::new(Some(&pcm), "endpoint",48000).unwrap();
        let mut trace=RawClockTrace::open(&pcm,"endpoint",48000,10_000_000).unwrap();
        let samples=[(48,384000,10_001_250),(48,384000,10_002_238),(48,384000,10_011_251),(38448,384000,11_001_250)];
        for (i,sample) in samples.into_iter().enumerate() {
            let raw=Ok(sample); let _=clock.observe_raw_clock(raw.clone(),960,Ok(144));
            trace.record(raw,960,Ok(144),(sample.2-10,sample.2+10),None,clock.validation_failure(),None).unwrap();
            if i>=2 { assert!(clock.validation_failure().is_some()); }
        }
        trace.finish().unwrap(); assert!(clock.finish().is_err());
        let rows:Vec<serde_json::Value>=std::fs::read_to_string(&trace.path).unwrap().lines().map(|l|serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows.len(),4); assert_eq!(rows[3]["clockPosition"],38448);
        for row in &rows { assert_eq!(row["aecQualityAcceptance"],false); assert_eq!(row["rawClockAccuracyAvailable"],false); assert_eq!(row["rawClockHresult"],serde_json::Value::Null); }
        assert_eq!(rows[2]["strictValidationFailure"],rows[3]["strictValidationFailure"]);
        assert_eq!(std::fs::read_to_string(dir.path().join("aec-source-playback-clock.jsonl")).unwrap().lines().count(),2);
    }
    #[test]
    fn device_crossing_uses_clock_frequency_and_full_frame_span() {
        let dir=tempfile::tempdir().unwrap();let mut trace=RawClockTrace::open(&dir.path().join("s.pcm"),"endpoint",48000,10_000_000).unwrap();
        assert!(!trace.source_crossed(48_000,48_000));
        trace.last_clock=Some((383_999,384_000));assert!(!trace.source_crossed(48_000,48_000));
        trace.last_clock=Some((384_000,384_000));assert!(trace.source_crossed(48_000,48_000));
        trace.last_clock=Some((48_000,384_000));assert!(!trace.source_crossed(48_000,48_000));
        trace.last_clock=Some((u64::MAX,0));assert!(!trace.source_crossed(48_000,48_000));
    }
    #[test]
    fn raw_api_errors_are_written_as_unknown_not_a_fake_clock_reading() {
        let dir=tempfile::tempdir().unwrap();let mut trace=RawClockTrace::open(&dir.path().join("s.pcm"),"endpoint",48000,10_000_000).unwrap();
        trace.record(Err("native query failed".into()),10,Err("padding failed".into()),(1,2),None,Some("native query failed"),None).unwrap();trace.finish().unwrap();
        let row:serde_json::Value=serde_json::from_str(std::fs::read_to_string(&trace.path).unwrap().trim()).unwrap();
        assert!(row["clockPosition"].is_null());assert_eq!(row["nativeApiError"],"native query failed");assert_eq!(row["paddingError"],"padding failed");assert_eq!(row["releaseEligible"],false);
    }
    #[test]
    fn native_hresult_is_retained_without_reclassifying_s_false_or_failure_as_s_ok() {
        let dir=tempfile::tempdir().unwrap();let mut trace=RawClockTrace::open(&dir.path().join("s.pcm"),"endpoint",48000,10_000_000).unwrap();
        for status in [0_i32,1_i32,-2147024891_i32] {
            let raw=if status<0 { Err("native GetPosition failed".into()) } else { Ok((48,384000,10001250)) };
            trace.record(raw,960,Ok(144),(10001240,10001260),Some(status),None,None).unwrap();
        }
        trace.finish().unwrap();
        let rows:Vec<serde_json::Value>=std::fs::read_to_string(&trace.path).unwrap().lines().map(|l|serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows[0]["rawClockHresult"],0);assert_eq!(rows[1]["rawClockHresult"],1);
        assert_eq!(rows[2]["rawClockHresult"],-2147024891_i32);assert!(rows[2]["clockPosition"].is_null());
        for row in rows { assert_eq!(row["rawClockAccuracyAvailable"],true);assert_eq!(row["aecQualityAcceptance"],false); }
    }

    #[test]
    fn failed_first_anchor_clock_keeps_one_source_sampling_through_full_natural_drain() {
        let dir = tempfile::tempdir().unwrap();
        let pcm = dir.path().join("source.f32le");
        let mut strict = SourcePlaybackClock::new(Some(&pcm), "one-native-client", 48_000).unwrap();
        let mut trace = RawClockTrace::open(&pcm, "one-native-client", 48_000, 10_000_000).unwrap();
        let frames = 6_039_136;
        let full_position = frames as u64 * 8; // 384k clock units, NOT 48k frames.
        // A single read source, including the unchanged first-anchor 1ms rejection.
        let mut source = [
            (40, 3_066_304_583_946, 96_000, 90_000),
            (3_864, 3_066_304_675_778, 100_000, 90_000),
            (7_712, 3_066_304_779_540, 100_480, 90_000),
            (11_544, 3_066_304_879_188, 100_960, 90_000),
            (15_392, 3_066_304_971_078, 101_440, 90_000),
            (full_position - 1, 3_067_600_000_000, frames, 1),
            (full_position, 3_067_600_000_001, frames, 0),
        ].into_iter();
        let mut reads = 0;
        for (position, qpc, submitted, padding) in source.by_ref() {
            trace.observe_reading(Ok((position, 384_000, qpc)), submitted, Ok(padding),
                (qpc - 1, qpc + 1), Some(0), &mut strict, None).unwrap();
            reads += 1;
            assert_eq!(trace.physical_playback_observed(frames, 48_000), reads == 7);
            if reads >= 5 {
                assert_eq!(strict.validation_failure(), Some("source render clock origin drift exceeds frozen 1ms bound"));
            }
        }
        assert_eq!(reads, 7);
        assert!(source.next().is_none());
        assert!(!strict.persistence_failed());
        assert!(strict.finish().unwrap_err().contains("frozen 1ms"));
        trace.finish().unwrap();
        let rows: Vec<serde_json::Value> = std::fs::read_to_string(&trace.path).unwrap().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows.len(), 7);
        assert_eq!(rows[6]["clockPosition"], full_position);
        assert_eq!(rows[6]["submittedFrames"], 6_039_136);
        assert_eq!(rows[6]["paddingFrames"], 0);
        assert_eq!(rows[4]["strictValidationFailure"], rows[6]["strictValidationFailure"]);
        for row in &rows { assert_eq!(row["endpointId"], "one-native-client"); assert_eq!(row["sampleRateHz"], 48_000); }
        let accepted = std::fs::read_to_string(dir.path().join("aec-source-playback-clock.jsonl")).unwrap();
        assert_eq!(accepted.lines().count(), 4);
        let failure: serde_json::Value = serde_json::from_str(std::fs::read_to_string(
            dir.path().join("aec-source-playback-clock-failures.jsonl")).unwrap().trim()).unwrap();
        assert_eq!(failure["clockPosition"], 15_392);
        assert_eq!(failure["qpc100ns"], 3_066_304_971_078_u64);
        assert_eq!(failure["acceptedAnchor"]["successfulObservations"], 4);
    }

    #[test]
    fn physical_completion_needs_full_span_zero_padding_and_reliable_written_sample() {
        let dir = tempfile::tempdir().unwrap();
        let pcm = dir.path().join("source.pcm");
        let mut strict = SourcePlaybackClock::new(Some(&pcm), "endpoint", 48_000).unwrap();
        let mut trace = RawClockTrace::open(&pcm, "endpoint", 48_000, 10_000_000).unwrap();
        for (position, padding, status, expected) in [
            (383_999, 0, 0, false), (384_000, 1, 0, false),
            (384_000, 0, 1, false), (384_000, 0, 0, true),
        ] {
            trace.observe_reading(Ok((position, 384_000, 30_000_000)), 48_000, Ok(padding),
                (30_000_000, 30_000_001), Some(status), &mut strict, None).unwrap();
            assert_eq!(trace.physical_playback_observed(48_000, 48_000), expected);
        }
        trace.observe_reading(Ok((384_000, 384_000, 30_000_000)), 47_999, Ok(0),
            (30_000_000, 30_000_001), Some(0), &mut strict, None).unwrap();
        assert!(!trace.physical_playback_observed(48_000, 48_000));
        assert!(strict.finish().is_err()); // S_FALSE does not turn into clock acceptance.
        trace.finish().unwrap();
    }

    #[test]
    fn api_errors_abort_after_raw_evidence_is_written_instead_of_becoming_drain_success() {
        for failure in ["frequency", "position", "padding", "independent-qpc"] {
            let dir = tempfile::tempdir().unwrap();
            let pcm = dir.path().join("source.pcm");
            let mut strict = SourcePlaybackClock::new(Some(&pcm), "endpoint", 48_000).unwrap();
            let mut trace = RawClockTrace::open(&pcm, "endpoint", 48_000, 10_000_000).unwrap();
            let raw = if failure == "frequency" || failure == "position" { Err(failure.into()) }
                else { Ok((384_000, 384_000, 30_000_000)) };
            let padding = if failure == "padding" { Err(failure.into()) } else { Ok(0) };
            let observation_error = (failure == "independent-qpc").then(|| failure.into());
            let status = if failure == "position" { -2147024891 } else { 0 };
            let error = trace.observe_reading(raw, 48_000, padding, (1, 2), Some(status),
                &mut strict, observation_error).unwrap_err();
            assert!(error.contains(failure));
            assert!(!trace.physical_playback_observed(48_000, 48_000));
            let _ = strict.finish();
            trace.finish().unwrap();
            let row: serde_json::Value = serde_json::from_str(std::fs::read_to_string(&trace.path).unwrap().trim()).unwrap();
            assert_eq!(row["rawClockHresult"], status);
            assert_eq!(row["sequence"], 0);
            assert_eq!(row["submittedFrames"], 48_000);
        }
    }

}
