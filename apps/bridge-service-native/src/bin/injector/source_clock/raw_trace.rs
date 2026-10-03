//! Isolated observation channel. Never supplies a successful source/c03 receipt.
use super::{error_text, MediaRender, SourcePlaybackClock};
use std::io::Write;
use windows::core::Interface;
use windows::Win32::Media::Audio::IAudioClock2;
use std::path::{Path, PathBuf};
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

// Capture actual bounds even if either QPC call fails. No fallback timestamp.
fn capture_start(
    mut qpc: impl FnMut() -> Result<u64, String>,
    start: impl FnOnce() -> (i32, Result<(), String>),
) -> (serde_json::Value, Result<(), String>) {
    let before = qpc();
    let (status, result) = start();
    let after = qpc();
    let value = serde_json::json!({"schemaVersion":1,
        "artifactKind":"aec-source-playback-clock-start-diagnostic",
        "scope":"diagnostic-only-not-c03", "releaseEligible":false,"aecQualityAcceptance":false,
        "callStartQpc100ns":before.as_ref().ok(),"callEndQpc100ns":after.as_ref().ok(),
        "callStartQpcError":before.as_ref().err(),"callEndQpcError":after.as_ref().err(),
        "rawStartHresult":status,"nativeApiError":result.as_ref().err(),
        "bracketMonotonic":before.as_ref().ok().zip(after.as_ref().ok()).map(|(a,b)| a <= b)});
    (value, result)
}

fn read_device_position(clock: &IAudioClock2) -> (i32, Result<(u64, u64), String>) {
    let mut position = 0;
    let mut qpc = 0;
    let status = unsafe {
        (Interface::vtable(clock).GetDevicePosition)(Interface::as_raw(clock), &mut position, &mut qpc)
    };
    interpret_device_position(status.0, position, qpc)
}

fn interpret_device_position(status: i32, position: u64, qpc: u64) -> (i32, Result<(u64, u64), String>) {
    // Stalled/non-S_OK calls must not expose potentially untouched outputs.
    let reading = if status == 0 { Ok((position, qpc)) } else {
        Err(format!("GetDevicePosition unavailable HRESULT=0x{:08X}", status as u32))
    };
    (status, reading)
}

fn unavailable_device_clock(status: i32, error: String) -> serde_json::Value {
    serde_json::json!({"supported":(status == 0x8000_4002_u32 as i32).then_some(false),
        "acceptanceAuthority":false,"interfaceQueryErrorHresult":status,"nativeApiError":error,
        "clockPosition":null,"qpc100ns":null,"rawClockHresult":null,
        "callStartQpc100ns":null,"callEndQpc100ns":null})
}

fn capture_device_clock(
    mut qpc: impl FnMut() -> Result<u64, String>,
    query: impl FnOnce() -> (i32, Result<(u64, u64), String>),
) -> serde_json::Value {
    let before = qpc();
    let (status, reading) = query();
    let after = qpc();
    serde_json::json!({"supported":true,"acceptanceAuthority":false,
        "positionUnits":"unprocessed-device-position-no-conversion", "deviceRateHz":null,
        "clockPosition":reading.as_ref().ok().map(|v|v.0),
        "qpc100ns":reading.as_ref().ok().map(|v|v.1),"rawClockHresult":status,
        "nativeApiError":reading.as_ref().err(),
        "callStartQpc100ns":before.as_ref().ok(),"callEndQpc100ns":after.as_ref().ok(),
        "callStartQpcError":before.as_ref().err(),"callEndQpcError":after.as_ref().err(),
        "bracketMonotonic":before.as_ref().ok().zip(after.as_ref().ok()).map(|(a,b)| a <= b)})
}

pub(super) fn start_render_optional(
    trace: &mut Option<RawClockTrace>, render: &MediaRender,
) -> Result<std::time::Instant, String> {
    dispatch_start(trace, |trace| trace.start_render(render), || render.start())
}

fn dispatch_start<T>(
    trace: &mut Option<T>,
    traced_start: impl FnOnce(&mut T) -> Result<std::time::Instant, String>,
    untraced_start: impl FnOnce() -> Result<(), String>,
) -> Result<std::time::Instant, String> {
    match trace {
        Some(trace) => traced_start(trace),
        None => {
            untraced_start()?;
            Ok(std::time::Instant::now())
        }
    }
}

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
    start_observation: Option<serde_json::Value>,
    device_clock: Option<Result<IAudioClock2, (i32, String)>>,
    device_clock_observation: Option<serde_json::Value>,
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
            endpoint: endpoint.into(), rate, qpc_frequency, last_clock: None, last_padding: None, last_submitted: 0,
            start_observation: None, device_clock: None, device_clock_observation: None })
    }
    pub(super) fn start_render(&mut self, render: &MediaRender) -> Result<std::time::Instant, String> {
        let (mut value, result) = capture_start(|| self.independent_qpc(), || render.start_with_status());
        // Anchor only the existing safety budget BEFORE diagnostic file I/O.
        // This Instant never supplies a source playback origin.
        let started_at = std::time::Instant::now();
        value["processId"] = std::process::id().into();
        value["endpointId"] = self.endpoint.clone().into();
        value["independentQpcFrequency"] = self.qpc_frequency.into();
        let persisted = self.persist_start(value);
        match (result, persisted) {
            (Err(native), Err(diagnostic)) => Err(format!("{native}; {diagnostic}")),
            (Err(native), _) => Err(native),
            (Ok(()), persisted) => persisted.map(|()| started_at),
        }
    }
    fn persist_start(&mut self, value: serde_json::Value) -> Result<(), String> {
        // Separate artifact survives a failed Start with no subsequent clock row.
        self.start_observation = Some(value.clone());
        let path = self.path.with_file_name("aec-source-playback-clock-start-diagnostic.json");
        let persist = || -> Result<(), String> {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
                .map_err(|e| format!("create Start clock diagnostic: {e}"))?;
            serde_json::to_writer(&mut file, &value).map_err(|e| format!("write Start clock diagnostic: {e}"))?;
            file.write_all(b"\n").map_err(|e| format!("write Start clock diagnostic newline: {e}"))?;
            file.sync_all().map_err(|e| format!("sync Start clock diagnostic: {e}"))
        };
        persist().map_err(|error| {
            self.start_observation.as_mut().unwrap()["persistenceError"] = error.clone().into();
            error
        })
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
                (0, 0), None, strict, Some("source clock missing; GetPosition not called".into()));
        };
        let frequency = clock.get_frequency().map_err(error_text);
        let before = self.independent_qpc();
        let (hresult, reading) = clock.get_position_with_status();
        let after = self.independent_qpc();
        let raw = reading.and_then(|(position, qpc)| frequency.map(|frequency| (position, frequency, qpc)));
        // QueryInterface once; optional failures never enter strict_raw or api_error.
        let optional = self.device_clock.get_or_insert_with(|| clock.diagnostic_clock2()
            .map_err(|error| (error.code().0, error_text(error)))).clone();
        self.device_clock_observation = Some(match optional {
            Ok(clock) => capture_device_clock(|| self.independent_qpc(), || read_device_position(&clock)),
            Err((status, error)) => unavailable_device_clock(status, error),
        });
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
        let mut value = serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock-raw-diagnostic",
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
        value["diagnosticStart"] = self.start_observation.clone().into();
        value["diagnosticDeviceClock"] = self.device_clock_observation.take().into();
        // Legacy brackets formerly used zero on QPC loss; unknown is explicit now.
        if observation_error.is_some() {
            value["callStartQpc100ns"] = serde_json::Value::Null;
            value["callEndQpc100ns"] = serde_json::Value::Null;
        }
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
        if let Some(error) = self.start_observation.as_ref()
            .and_then(|value| value["persistenceError"].as_str()) { errors.push(error.to_string()); }
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

    #[test]
    fn start_brackets_capture_one_call_and_preserve_native_failure_without_fallback_time() {
        for failed_start in [false, true] {
            let calls = std::cell::Cell::new(0);
            let mut bounds = [Ok(123), Err("QPC after Start unavailable".to_string())].into_iter();
            let native = if failed_start { Err("original Start failure".to_string()) } else { Ok(()) };
            let (value, result) = capture_start(|| bounds.next().unwrap(), || {
                calls.set(calls.get() + 1);
                (if failed_start { -1 } else { 0 }, native.clone())
            });
            assert_eq!(calls.get(), 1);
            assert_eq!(result, native);
            assert_eq!(value["callStartQpc100ns"], 123);
            assert!(value["callEndQpc100ns"].is_null());
            assert_eq!(value["callEndQpcError"], "QPC after Start unavailable");
            assert_eq!(value["rawStartHresult"], if failed_start { -1 } else { 0 });
            assert_eq!(value["releaseEligible"], false);
        }
        let mut bounds = [Ok(100), Ok(110)].into_iter();
        let (value, result) = capture_start(|| bounds.next().unwrap(), || (1, Ok(())));
        assert!(result.is_ok()); // Preserve original HRESULT::ok() semantics for Start.
        assert_eq!(value["rawStartHresult"], 1);
        assert_eq!(value["callEndQpc100ns"], 110);
        assert_eq!(value["bracketMonotonic"], true);
    }

    #[test]
    fn start_sidecar_survives_no_clock_rows_and_persistence_loss_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let pcm = dir.path().join("source.pcm");
        let mut trace = RawClockTrace::open(&pcm, "endpoint", 48_000, 10_000_000).unwrap();
        let mut bounds = [Ok(100), Ok(110)].into_iter();
        let (value, _) = capture_start(|| bounds.next().unwrap(), || (-1, Err("Start failed".into())));
        trace.persist_start(value.clone()).unwrap();
        let path = dir.path().join("aec-source-playback-clock-start-diagnostic.json");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(), value);
        let error = trace.persist_start(value).unwrap_err();
        assert!(error.contains("create Start clock diagnostic"));
        assert_eq!(std::fs::read(path).unwrap(), bytes); // Never overwrite first evidence.
        assert!(trace.start_observation.as_ref().unwrap()["persistenceError"].is_string());
        assert!(trace.finish().unwrap_err().contains("create Start clock diagnostic"));
        assert_eq!(std::fs::metadata(&trace.path).unwrap().len(), 0);
    }

    #[test]
    fn optional_device_query_retains_status_brackets_and_unknowns_only_as_diagnostics() {
        for status in [0, 1, 0x0889_0006, -1] {
            let mut bounds = [Ok(100), Ok(110)].into_iter();
            let value = capture_device_clock(|| bounds.next().unwrap(), || interpret_device_position(status, 17, 105));
            assert_eq!(value["rawClockHresult"], status);
            assert_eq!(value["callStartQpc100ns"], 100);
            assert_eq!(value["callEndQpc100ns"], 110);
            assert_eq!(value["acceptanceAuthority"], false);
            assert!(value["deviceRateHz"].is_null()); // Never infer device units from stream frequency.
            if status == 0 { assert_eq!(value["clockPosition"], 17); assert_eq!(value["qpc100ns"], 105); }
            else { assert!(value["clockPosition"].is_null()); assert!(value["qpc100ns"].is_null()); }
        }
        let unavailable = unavailable_device_clock(0x8000_4002_u32 as i32, "E_NOINTERFACE".into());
        assert_eq!(unavailable["supported"], false);
        let unknown = unavailable_device_clock(-1, "QueryInterface failed".into());
        assert!(unknown["supported"].is_null());
        assert_eq!(unknown["interfaceQueryErrorHresult"], -1);
        let mut bounds = [Err("QPC before device query lost".into()), Ok(110)].into_iter();
        let value = capture_device_clock(|| bounds.next().unwrap(), || (0, Ok((17, 105))));
        assert!(value["callStartQpc100ns"].is_null());
        assert_eq!(value["callEndQpc100ns"], 110);
        assert_eq!(value["callStartQpcError"], "QPC before device query lost");
        assert_eq!(value["qpc100ns"], 105);
    }

    #[test]
    fn diagnostic_queries_cannot_change_original_values_acceptance_or_sticky_failure() {
        for primary_fails in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut stricts = Vec::new();
            let mut traces = Vec::new();
            for name in ["baseline", "optional"] {
                let root = dir.path().join(name); std::fs::create_dir(&root).unwrap();
                let pcm = root.join("source.pcm");
                stricts.push(SourcePlaybackClock::new(Some(&pcm), "endpoint", 48_000).unwrap());
                traces.push(RawClockTrace::open(&pcm, "endpoint", 48_000, 10_000_000).unwrap());
            }
            let readings = if primary_fails {
                [(40, 384_000, 3_865_048_583_818), (3_880, 384_000, 3_865_048_661_680), (7_720, 384_000, 3_865_048_760_934)]
            } else { [(40, 384_000, 10_001_041), (3_880, 384_000, 10_101_041), (7_720, 384_000, 10_201_041)] };
            for (i, raw) in readings.into_iter().enumerate() {
                // Success, unavailable interface, and query/QPC failure cannot affect strict input.
                traces[1].device_clock_observation = Some(match i {
                    0 => capture_device_clock(|| Ok(1), || (0, Ok((u64::MAX, u64::MAX)))),
                    1 => serde_json::json!({"supported":false,"acceptanceAuthority":false,
                        "interfaceQueryErrorHresult":-2147467262_i32,"nativeApiError":"E_NOINTERFACE"}),
                    _ => capture_device_clock(|| Err("optional QPC unavailable".into()), || (-1, Err("optional API error".into()))),
                });
                traces[1].start_observation = Some(serde_json::json!({"rawStartHresult":0,
                    "callStartQpc100ns":null,"callStartQpcError":"optional QPC loss"}));
                for index in 0..2 {
                    traces[index].observe_reading(Ok(raw), 960, Ok(144), (raw.2 - 1, raw.2 + 1),
                        Some(0), &mut stricts[index], None).unwrap();
                }
                assert_eq!(stricts[0].origin, stricts[1].origin);
                assert_eq!(stricts[0].frequency, stricts[1].frequency);
                assert_eq!(stricts[0].validation_failure(), stricts[1].validation_failure());
                assert_eq!(traces[0].last_clock, traces[1].last_clock);
            }
            assert_eq!(stricts[0].finish(), stricts[1].finish());
            assert_eq!(stricts[0].validation_failure().is_some(), primary_fails);
            for trace in &mut traces { trace.finish().unwrap(); }
            for name in ["aec-source-playback-clock.jsonl", "aec-source-playback-clock-failures.jsonl"] {
                assert_eq!(std::fs::read(dir.path().join("baseline").join(name)).unwrap(),
                    std::fs::read(dir.path().join("optional").join(name)).unwrap());
            }
            let parse = |p: &Path| -> Vec<serde_json::Value> { std::fs::read_to_string(p).unwrap().lines()
                .map(|line| serde_json::from_str(line).unwrap()).collect() };
            let baseline = parse(&traces[0].path);
            let optional = parse(&traces[1].path);
            for (original, mut augmented) in baseline.into_iter().zip(optional) {
                assert!(!augmented["diagnosticDeviceClock"].is_null());
                augmented["diagnosticDeviceClock"] = serde_json::Value::Null;
                augmented["diagnosticStart"] = serde_json::Value::Null;
                assert_eq!(original, augmented);
            }
        }
    }

    #[test]
    fn optional_start_dispatch_calls_one_branch_and_preserves_deadline_or_failure() {
        for traced in [false, true] {
            for fails in [false, true] {
                let mut trace = traced.then_some(0_u32);
                let traced_calls = std::cell::Cell::new(0);
                let untraced_calls = std::cell::Cell::new(0);
                let deadline_anchor = std::time::Instant::now();
                let result = dispatch_start(&mut trace, |state| {
                    *state += 1;
                    traced_calls.set(traced_calls.get() + 1);
                    if fails { Err("traced Start failure".into()) } else { Ok(deadline_anchor) }
                }, || {
                    untraced_calls.set(untraced_calls.get() + 1);
                    if fails { Err("untraced Start failure".into()) } else { Ok(()) }
                });
                assert_eq!(traced_calls.get(), u32::from(traced));
                assert_eq!(untraced_calls.get(), u32::from(!traced));
                assert_eq!(trace, traced.then_some(1));
                if fails {
                    assert_eq!(result.unwrap_err(), if traced { "traced Start failure" } else { "untraced Start failure" });
                } else if traced {
                    assert_eq!(result.unwrap(), deadline_anchor); // Never reset after diagnostic I/O.
                } else {
                    assert!(result.unwrap() >= deadline_anchor);
                }
            }
        }
    }

}
