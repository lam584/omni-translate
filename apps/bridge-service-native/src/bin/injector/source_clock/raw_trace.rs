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
            endpoint: endpoint.into(), rate, qpc_frequency, last_clock: None })
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
        let clock = render.audio_clock.as_ref().ok_or("source clock missing")?;
        let frequency = clock.get_frequency().map_err(error_text)?;
        let before = self.independent_qpc()?;
        let (hresult, reading) = clock.get_position_with_status();
        let after = self.independent_qpc()?;
        let raw = reading.map(|(position, qpc)| (position, frequency, qpc));
        let padding = render.current_padding_frames();
        // Keep unsuccessful/slow native reads as raw evidence, never a trusted source anchor.
        let strict_raw = if hresult == 0 { raw.clone() } else {
            Err(format!("source clock accuracy/status unavailable: HRESULT {hresult}"))
        };
        let _strict_result = strict.observe_raw_clock(strict_raw, submitted, padding.clone());
        self.record(raw, submitted, padding, (before, after), Some(hresult), strict.validation_failure())
    }
    fn record(&mut self, raw: Result<(u64,u64,u64),String>, submitted: usize, padding: Result<usize,String>,
        call_qpc: (u64, u64), hresult: Option<i32>, strict_failure: Option<&str>) -> Result<(), String> {
        self.last_clock = raw.as_ref().ok().map(|v| (v.0,v.1));
        let value = serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock-raw-diagnostic",
            "scope":"diagnostic-only-not-c03","releaseEligible":false,"aecQualityAcceptance":false,
            "sequence":self.sequence,"processId":std::process::id(),"endpointId":self.endpoint,"sampleRateHz":self.rate,
            "clockPosition":raw.as_ref().ok().map(|v|v.0),"clockFrequency":raw.as_ref().ok().map(|v|v.1),
            "qpc100ns":raw.as_ref().ok().map(|v|v.2),"nativeApiError":raw.as_ref().err(),
            "callStartQpc100ns":call_qpc.0,"callEndQpc100ns":call_qpc.1,"independentQpcFrequency":self.qpc_frequency,
            "submittedFrames":submitted,"paddingFrames":padding.as_ref().ok(),"paddingError":padding.as_ref().err(),
            // Native typed vtable returns the actual HRESULT, including S_FALSE and errors.
            "rawClockHresult":hresult,"rawClockAccuracyAvailable":hresult.is_some(),
            "strictValidationFailure":strict_failure});
        serde_json::to_writer(&mut self.writer, &value).map_err(|e|format!("write raw clock diagnostic: {e}"))?;
        self.writer.write_all(b"\n").map_err(|e|format!("write raw clock diagnostic newline: {e}"))?;
        self.sequence += 1;
        Ok(())
    }
    fn source_crossed(&self, frames: usize, rate: u32) -> bool {
        self.last_clock.is_some_and(|(position, frequency)| frequency > 0
            && position as u128 * rate as u128 >= frames as u128 * frequency as u128)
    }
    pub(super) fn wait_until_device_crosses_source(&mut self, render: &MediaRender, frames: usize, rate: u32,
        strict: &mut SourcePlaybackClock, started: std::time::Instant, timeout: std::time::Duration) -> Result<(), String> {
        // Padding drained is not proof of the final sample reaching the device.
        while !self.source_crossed(frames, rate) {
            if started.elapsed() > timeout { return Err("diagnostic device clock did not cross full source before the original safety deadline".into()); }
            self.observe(render, frames, strict)?;
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(())
    }
    pub(super) fn finish(&mut self) -> Result<(), String> {
        self.writer.flush().map_err(|e|format!("flush raw clock diagnostic: {e}"))?;
        self.writer.get_ref().sync_all().map_err(|e|format!("sync raw clock diagnostic: {e}"))
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
            trace.record(raw,960,Ok(144),(sample.2-10,sample.2+10),None,clock.validation_failure()).unwrap();
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
        trace.record(Err("native query failed".into()),10,Err("padding failed".into()),(1,2),None,Some("native query failed")).unwrap();trace.finish().unwrap();
        let row:serde_json::Value=serde_json::from_str(std::fs::read_to_string(&trace.path).unwrap().trim()).unwrap();
        assert!(row["clockPosition"].is_null());assert_eq!(row["nativeApiError"],"native query failed");assert_eq!(row["paddingError"],"padding failed");assert_eq!(row["releaseEligible"],false);
    }
    #[test]
    fn native_hresult_is_retained_without_reclassifying_s_false_or_failure_as_s_ok() {
        let dir=tempfile::tempdir().unwrap();let mut trace=RawClockTrace::open(&dir.path().join("s.pcm"),"endpoint",48000,10_000_000).unwrap();
        for status in [0_i32,1_i32,-2147024891_i32] {
            let raw=if status<0 { Err("native GetPosition failed".into()) } else { Ok((48,384000,10001250)) };
            trace.record(raw,960,Ok(144),(10001240,10001260),Some(status),None).unwrap();
        }
        trace.finish().unwrap();
        let rows:Vec<serde_json::Value>=std::fs::read_to_string(&trace.path).unwrap().lines().map(|l|serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows[0]["rawClockHresult"],0);assert_eq!(rows[1]["rawClockHresult"],1);
        assert_eq!(rows[2]["rawClockHresult"],-2147024891_i32);assert!(rows[2]["clockPosition"].is_null());
        for row in rows { assert_eq!(row["rawClockAccuracyAvailable"],true);assert_eq!(row["aecQualityAcceptance"],false); }
    }

}
