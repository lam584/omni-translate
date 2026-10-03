//! Isolated observation channel. Never supplies a successful source/c03 receipt.
use super::{error_text, MediaRender, SourcePlaybackClock};
#[path = "host_time_observation.rs"]
mod host_time_observation;
use host_time_observation::HostTimeObserver;
use std::io::Write;
use windows::core::Interface;
use windows::Win32::Media::Audio::IAudioClock2;
use std::path::{Path, PathBuf};
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows_sys::Win32::System::WindowsProgramming::QueryUnbiasedInterruptTime;
use super::render::{DiagnosticEndpoint, independent_observation::{capture_time_boundary, TimeBoundary}};

fn boundary_value(boundary: TimeBoundary) -> serde_json::Value {
    serde_json::json!({"origin":"QueryUnbiasedInterruptTime-NON-Precise-around-the-same-QueryPerformanceCounter",
        "scope":"diagnostic-only-not-c03","acceptanceAuthority":false,
        "rawQpcTicks":boundary.raw_qpc_ticks,"qpcFrequency":boundary.qpc_frequency,
        "qpcRawBool":boundary.qpc_bool,
        "qpcRawError":boundary.raw_qpc_ticks.is_none().then_some("QueryPerformanceCounter unavailable or invalid signed counter"),
        "interruptBeforeRawBool":boundary.interrupt_before_bool,
        "interruptBefore100ns":boundary.interrupt_before_100ns,
        "interruptBeforeError":(boundary.interrupt_before_bool == 0).then_some("QueryUnbiasedInterruptTime returned FALSE"),
        "interruptAfterRawBool":boundary.interrupt_after_bool,
        "interruptAfter100ns":boundary.interrupt_after_100ns,
        "interruptAfterError":(boundary.interrupt_after_bool == 0).then_some("QueryUnbiasedInterruptTime returned FALSE"),
        "interruptMonotonic":boundary.interrupt_before_100ns.zip(boundary.interrupt_after_100ns).map(|(a,b)| a <= b)})
}

fn time_bracket(origin: &str, boundaries: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({"origin":origin,"scope":"diagnostic-only-not-c03","acceptanceAuthority":false,
        "before":boundaries.first(),"after":boundaries.get(1)})
}

// This *additional* file is optional. Failure is explicit, but cannot change the
// existing raw journal/strict result. Existing mandatory writer errors stay errors.
fn persist_optional_snapshot(
    mut value: serde_json::Value,
    write: impl FnOnce(&serde_json::Value) -> Result<(), String>,
) -> serde_json::Value {
    if let Err(error) = write(&value) { value["persistenceError"] = error.into(); }
    value
}

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
    independent_time_observation: Option<serde_json::Value>,
    host_time: Option<HostTimeObserver>,
    host_time_observation: Option<serde_json::Value>,
    format_endpoint: Option<DiagnosticEndpoint>,
    final_observation: Option<serde_json::Value>,
    format_before_start: Option<serde_json::Value>,
    start_time_observation: Option<serde_json::Value>,
    independent_path: PathBuf,
    independent_writer: Option<std::io::BufWriter<std::fs::File>>,
    independent_error: Option<String>,
    independent_rows: u64,
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
        let independent_path = pcm.with_file_name("aec-source-playback-clock-independent-time.jsonl");
        let (independent_writer, independent_error) = match std::fs::OpenOptions::new()
            .write(true).create_new(true).open(&independent_path) {
            Ok(file) => (Some(std::io::BufWriter::new(file)), None),
            Err(error) => (None, Some(format!("create optional independent time journal: {error}"))),
        };
        Ok(Self { writer: std::io::BufWriter::new(file), path, sequence: 0,
            endpoint: endpoint.into(), rate, qpc_frequency, last_clock: None, last_padding: None, last_submitted: 0,
            start_observation: None, device_clock: None, device_clock_observation: None,
            // Pin/hash/load once BEFORE MediaRender::start_render, never in the audio pump.
            independent_time_observation: None, host_time: Some(HostTimeObserver::from_env()), host_time_observation: None,
            format_endpoint: None, final_observation: None,
            format_before_start: None, start_time_observation: None, independent_path,
            independent_writer, independent_error, independent_rows: 0 })
    }
    pub(super) fn start_render(&mut self, render: &MediaRender) -> Result<std::time::Instant, String> {
        self.format_endpoint = render.diagnostic_endpoint();
        let format_before = self.observe_endpoint_format("before-Start");
        let mut boundaries = Vec::with_capacity(2);
        let (mut value, result) = capture_start(|| {
            let (qpc, diagnostic) = self.independent_boundary(); boundaries.push(diagnostic); qpc
        }, || render.start_with_status());
        // Anchor only the existing safety budget BEFORE diagnostic file I/O.
        // This Instant never supplies a source playback origin.
        let started_at = std::time::Instant::now();
        value["processId"] = std::process::id().into();
        value["endpointId"] = self.endpoint.clone().into();
        value["independentQpcFrequency"] = self.qpc_frequency.into();
        let start_time = time_bracket("IAudioClient::Start-call-bracket", boundaries);
        self.start_time_observation = Some(start_time.clone());
        self.format_before_start = Some(format_before.clone());
        value["diagnosticIndependentTime"] = start_time;
        value["diagnosticEndpointFormat"] = format_before;
        let persisted = self.persist_start(value);
        match (result, persisted) {
            (Err(native), Err(diagnostic)) => Err(format!("{native}; {diagnostic}")),
            (Err(native), _) => Err(native),
            (Ok(()), persisted) => persisted.map(|()| started_at),
        }
    }
    fn persist_start(&mut self, value: serde_json::Value) -> Result<(), String> {
        // Separate artifact survives a failed Start with no subsequent clock row.
        let mut legacy = value.clone();
        // Keep repeated legacy raw rows byte-compatible and under the existing
        // 32MiB collection bound. Full additions live in Start/independent files.
        if let Some(fields) = legacy.as_object_mut() {
            fields.remove("diagnosticIndependentTime");
            fields.remove("diagnosticEndpointFormat");
        }
        self.start_observation = Some(legacy);
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
    fn independent_boundary(&self) -> (Result<u64, String>, serde_json::Value) {
        let (qpc, boundary) = capture_time_boundary(self.qpc_frequency, || {
            let mut counter = 0_i64;
            let status = unsafe { QueryPerformanceCounter(&mut counter) };
            (status, counter)
        }, || {
            let mut interrupt = 0_u64;
            // Deliberately NOT QueryUnbiasedInterruptTimePrecise (QPC derived).
            let status = unsafe { QueryUnbiasedInterruptTime(&mut interrupt) };
            (status, interrupt)
        });
        (qpc, boundary_value(boundary))
    }
    fn observe_endpoint_format(&self, phase: &str) -> serde_json::Value {
        if self.format_endpoint.is_none() {
            return serde_json::json!({"scope":"diagnostic-only-not-c03","acceptanceAuthority":false,
                "origin":"same-render-client-IMMDevice-PKEY_AudioEngine_DeviceFormat","phase":phase,
                "endpointId":self.endpoint,"deviceRateHz":null,"nativeApiError":"diagnostic endpoint unavailable",
                "diagnosticIndependentTime":null});
        }
        let (_, before) = self.independent_boundary();
        let mut value = self.format_endpoint.as_ref().map(|endpoint| endpoint.query_device_format(phase))
            .unwrap_or_else(|| serde_json::json!({"scope":"diagnostic-only-not-c03","acceptanceAuthority":false,
                "origin":"same-render-client-IMMDevice-PKEY_AudioEngine_DeviceFormat", "phase":phase,
                "endpointId":self.endpoint,"deviceRateHz":null,"nativeApiError":"diagnostic endpoint unavailable"}));
        let (_, after) = self.independent_boundary();
        value["diagnosticIndependentTime"] = time_bracket("PKEY_AudioEngine_DeviceFormat-query-bracket", vec![before, after]);
        value
    }
    pub(super) fn observe(&mut self, render: &MediaRender, submitted: usize, strict: &mut SourcePlaybackClock) -> Result<(), String> {
        // Wall-time sidecar stays outside existing native GetPosition/QPC brackets.
        // Missing opt-in never loads the DLL. Ownership lasts through the last read.
        let host_before = self.host_time.as_ref().expect("host-time observer initialized before Start").observe(self.qpc_frequency);
        // Always sample the same native client, even after strict validation latches failure.
        let padding = render.current_padding_frames();
        let Some(clock) = render.audio_clock.as_ref() else {
            let host_after = self.host_time.as_ref().unwrap().observe(self.qpc_frequency);
            self.host_time_observation = Some(self.host_time.as_ref().unwrap().bracket(host_before, host_after, "host-wall-time-around-raw-GetPosition-not-called"));
            return self.observe_reading(Err("source clock missing".into()), submitted, padding,
                (0, 0), None, strict, Some("source clock missing; GetPosition not called".into()));
        };
        let frequency = clock.get_frequency().map_err(error_text);
        let (before, time_before) = self.independent_boundary();
        let (hresult, reading) = clock.get_position_with_status();
        let (after, time_after) = self.independent_boundary();
        let host_after = self.host_time.as_ref().unwrap().observe(self.qpc_frequency);
        self.host_time_observation = Some(self.host_time.as_ref().unwrap().bracket(host_before, host_after, "host-wall-time-around-raw-GetPosition"));
        self.independent_time_observation = Some(time_bracket("IAudioClock::GetPosition-call-bracket", vec![time_before, time_after]));
        let raw = reading.and_then(|(position, qpc)| frequency.map(|frequency| (position, frequency, qpc)));
        // QueryInterface once; optional failures never enter strict_raw or api_error.
        let optional = self.device_clock.get_or_insert_with(|| clock.diagnostic_clock2()
            .map_err(|error| (error.code().0, error_text(error)))).clone();
        self.device_clock_observation = Some(match optional {
            Ok(clock) => {
                let mut boundaries = Vec::with_capacity(2);
                let mut value = capture_device_clock(|| {
                    let (qpc, diagnostic) = self.independent_boundary(); boundaries.push(diagnostic); qpc
                }, || read_device_position(&clock));
                value["diagnosticIndependentTime"] = time_bracket("IAudioClock2::GetDevicePosition-call-bracket", boundaries);
                value
            },
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
        let mut device = self.device_clock_observation.take();
        let device_time = device.as_mut().and_then(|v| v.as_object_mut())
            .and_then(|fields| fields.remove("diagnosticIndependentTime"));
        value["diagnosticDeviceClock"] = device.into();
        let primary_time = self.independent_time_observation.take();
        // Legacy brackets formerly used zero on QPC loss; unknown is explicit now.
        if observation_error.is_some() {
            value["callStartQpc100ns"] = serde_json::Value::Null;
            value["callEndQpc100ns"] = serde_json::Value::Null;
        }
        serde_json::to_writer(&mut self.writer, &value).map_err(|e|format!("write raw clock diagnostic: {e}"))?;
        self.writer.write_all(b"\n").map_err(|e|format!("write raw clock diagnostic newline: {e}"))?;
        self.record_independent_time(primary_time, device_time, &value);
        self.sequence += 1;
        // Completion cannot use failed/unreliable calls or observations not yet written.
        self.last_clock = if hresult == Some(0) && observation_error.is_none() {
            raw.as_ref().ok().filter(|v| v.1 > 0 && v.2 > 0).map(|v| (v.0,v.1))
        } else { None };
        self.last_padding = padding.ok();
        self.last_submitted = submitted;
        Ok(())
    }
    // Host evidence is sequence-linked here, never copied into strict/legacy clocks.
    fn record_independent_time(&mut self, primary: Option<serde_json::Value>,
        device: Option<serde_json::Value>, legacy: &serde_json::Value) {
        let host_time = self.host_time_observation.take();
        if self.independent_error.is_some() { return; }
        let value = serde_json::json!({"schemaVersion":1,
            "artifactKind":"aec-source-independent-time-observation",
            "scope":"diagnostic-only-not-c03","acceptanceAuthority":false,
            "origin":"same-legacy-raw-clock-sequence-independent-brackets",
            "sequence":self.sequence,"endpointId":self.endpoint,"processId":std::process::id(),
            "clock1":primary,"clock2":device,"diagnosticHostTime":host_time,"clock1Position":legacy["clockPosition"],
            "clock1Qpc100ns":legacy["qpc100ns"],"clock1Hresult":legacy["rawClockHresult"],
            "clock2Position":legacy["diagnosticDeviceClock"]["clockPosition"],
            "clock2Qpc100ns":legacy["diagnosticDeviceClock"]["qpc100ns"],
            "clock2Hresult":legacy["diagnosticDeviceClock"]["rawClockHresult"],
            "strictValidationFailure":legacy["strictValidationFailure"]});
        let result = (|| {
            let writer = self.independent_writer.as_mut().ok_or("optional independent time writer missing")?;
            serde_json::to_writer(&mut *writer, &value).map_err(|e| e.to_string())?;
            writer.write_all(b"\n").map_err(|e| e.to_string())
        })();
        match result {
            Ok(()) => self.independent_rows += 1,
            Err(error) => self.independent_error = Some(format!("write optional independent time journal: {error}")),
        }
    }
    fn flush_independent_time(&mut self) {
        let mut errors: Vec<String> = self.independent_error.take().into_iter().collect();
        if let Some(writer) = self.independent_writer.as_mut() {
            if let Err(error) = writer.flush() { errors.push(format!("flush optional independent time journal: {error}")); }
            if let Err(error) = writer.get_ref().sync_all() { errors.push(format!("sync optional independent time journal: {error}")); }
        }
        self.independent_error = (!errors.is_empty()).then(|| errors.join("; "));
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
        // Same retained endpoint/thread after playback (including failed Start/API),
        // before owners drop. No Stop, restart, gate alteration or deadline reset.
        if self.final_observation.is_none() {
            self.flush_independent_time();
            let value = serde_json::json!({"schemaVersion":1,
                "artifactKind":"aec-source-playback-clock-independent-diagnostic",
                "scope":"diagnostic-only-not-c03","acceptanceAuthority":false,
                "origin":"optional-independent-time-and-endpoint-format-observation",
                "endpointId":self.endpoint,"processId":std::process::id(),
                "deviceFormatBeforeStart":self.format_before_start,
                "startIndependentTime":self.start_time_observation,
                "independentTimeTracePath":self.independent_path,
                "independentTimeRowsWritten":self.independent_rows,
                "independentTimePersistenceError":self.independent_error,
                "deviceFormatAfterPlayback":self.observe_endpoint_format("finish-after-playback-attempt-before-render-drop"),
                "rawClockRows":self.sequence,"persistenceError":null});
            let path = self.path.with_file_name("aec-source-playback-clock-independent-diagnostic.json");
            let observed = persist_optional_snapshot(value, |value| {
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
                    .map_err(|e| format!("create optional independent diagnostic: {e}"))?;
                serde_json::to_writer(&mut file, value).map_err(|e| format!("write optional independent diagnostic: {e}"))?;
                file.write_all(b"\n").map_err(|e| format!("newline optional independent diagnostic: {e}"))?;
                file.sync_all().map_err(|e| format!("sync optional independent diagnostic: {e}"))
            });
            if let Some(error) = observed["persistenceError"].as_str() { eprintln!("optional-independent-diagnostic-persistence-error: {error}"); }
            if let Some(error) = self.independent_error.as_deref() { eprintln!("optional-independent-time-persistence-error: {error}"); }
            self.final_observation = Some(observed);
        }
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
    #[test]
    fn host_time_unavailability_is_only_sequence_linked_optional_evidence() {
        let dir=tempfile::tempdir().unwrap();
        let mut trace=super::RawClockTrace::open(&dir.path().join("host.pcm"),"endpoint",48000,10_000_000).unwrap();
        trace.host_time_observation=Some(serde_json::json!({"acceptanceAuthority":false,
            "dllAvailable":false,"availabilityError":"SHA256 mismatch","before":null,"after":null}));
        trace.record(Ok((48,384000,10001250)),960,Ok(144),(10001240,10001260),Some(0),Some("original strict failure"),None).unwrap();
        trace.flush_independent_time();
        let optional:serde_json::Value=serde_json::from_str(std::fs::read_to_string(&trace.independent_path).unwrap().trim()).unwrap();
        trace.writer.flush().unwrap();
        let legacy:serde_json::Value=serde_json::from_str(std::fs::read_to_string(&trace.path).unwrap().trim()).unwrap();
        assert_eq!(optional["sequence"],legacy["sequence"]);
        assert_eq!(optional["diagnosticHostTime"]["availabilityError"],"SHA256 mismatch");
        assert_eq!(optional["strictValidationFailure"],"original strict failure");
        assert!(legacy.get("diagnosticHostTime").is_none());
        assert_eq!(legacy["qpc100ns"],10001250); assert!(legacy["nativeApiError"].is_null());
        assert!(trace.host_time_observation.is_none());
    }
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

    #[test]
    fn independent_optional_success_failure_and_malformed_fields_preserve_canonical_bytes() {
        for fails in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut clocks=Vec::new();let mut traces=Vec::new();
            for name in ["baseline", "augmented"] {
                let root=dir.path().join(name);std::fs::create_dir(&root).unwrap();let pcm=root.join("source.pcm");
                clocks.push(SourcePlaybackClock::new(Some(&pcm), "endpoint", 48000).unwrap());
                traces.push(RawClockTrace::open(&pcm, "endpoint", 48000, 10000000).unwrap());
            }
            let readings=if fails {[(40,384000,3865048583818),(3880,384000,3865048661680),(7720,384000,3865048760934)]}
                else {[(40,384000,10001041),(3880,384000,10101041),(7720,384000,10201041)]};
            for (i, raw) in readings.into_iter().enumerate() {
                let status=if i == 1 {0}else{1};
                let (_, boundary)=capture_time_boundary(10000000,||(1,raw.2 as i64),||(status,u64::MAX));
                traces[1].independent_time_observation=Some(time_bracket("fake-test-observation",
                    vec![boundary_value(boundary.clone()),boundary_value(boundary)]));
                traces[1].start_observation=Some(serde_json::json!({"diagnosticEndpointFormat":{
                    "deviceRateHz":null,"getValueHresult":-1,"rawBlobHex":null,"nativeApiError":"property unavailable"}}));
                for k in 0..2 {traces[k].observe_reading(Ok(raw),960,Ok(144),(raw.2-1,raw.2+1),Some(0),&mut clocks[k],None).unwrap();}
                assert_eq!(clocks[0].origin,clocks[1].origin);
                assert_eq!(clocks[0].validation_failure(),clocks[1].validation_failure());
                assert_eq!(traces[0].last_clock,traces[1].last_clock);
            }
            assert_eq!(clocks[0].finish(),clocks[1].finish());
            for trace in &mut traces {
                // Pre-existing file must produce explicit optional create-new failure,
                // never turn a native/strict result red or green or overwrite evidence.
                let sidecar=trace.path.with_file_name("aec-source-playback-clock-independent-diagnostic.json");
                std::fs::write(&sidecar,b"existing custody").unwrap();
                assert!(trace.finish().is_ok());
                assert!(trace.final_observation.as_ref().unwrap()["persistenceError"].is_string());
                assert_eq!(std::fs::read(&sidecar).unwrap(),b"existing custody");
            }
            for name in ["aec-source-playback-clock.jsonl","aec-source-playback-clock-failures.jsonl"] {
                assert_eq!(std::fs::read(dir.path().join("baseline").join(name)).unwrap(),
                    std::fs::read(dir.path().join("augmented").join(name)).unwrap());
            }
            assert_eq!(clocks[0].validation_failure().is_some(),fails);
            let independent_bytes=std::fs::read_to_string(&traces[1].independent_path).unwrap();
            let independent_rows: Vec<serde_json::Value>=independent_bytes.lines()
                .map(|line|serde_json::from_str(line).unwrap()).collect();
            assert_eq!(independent_rows.len(),3);
            for (i,value) in independent_rows.into_iter().enumerate() {
                assert_eq!(value["sequence"],i as u64);assert_eq!(value["acceptanceAuthority"],false);
                assert!(!value["clock1"].is_null());
                if i==1 {assert!(value["clock1"]["before"]["interruptBefore100ns"].is_null());}
            }
            let parse=|path: &Path| -> Vec<serde_json::Value> {std::fs::read_to_string(path).unwrap().lines()
                .map(|line|serde_json::from_str(line).unwrap()).collect()};
            for (original,mut augmented) in parse(&traces[0].path).into_iter().zip(parse(&traces[1].path)) {
                assert!(augmented.get("diagnosticIndependentTime").is_none());
                augmented["diagnosticStart"]=serde_json::Value::Null;
                assert_eq!(original,augmented);
            }
        }
    }

    #[test]
    fn independent_time_false_bool_is_null_and_optional_io_failure_is_explicit() {
        let (_, boundary)=capture_time_boundary(10000000,||(0,777),||(0,888));
        let value=boundary_value(boundary);
        for name in ["rawQpcTicks","interruptBefore100ns","interruptAfter100ns","interruptMonotonic"] {
            assert!(value[name].is_null());
        }
        assert_eq!(value["qpcRawBool"],0);assert_eq!(value["interruptBeforeRawBool"],0);
        assert!(value["interruptBeforeError"].is_string());assert_eq!(value["acceptanceAuthority"],false);
        let value=persist_optional_snapshot(serde_json::json!({"acceptanceAuthority":false,"persistenceError":null}),
            |_|Err("injected write/flush/sync loss".into()));
        assert_eq!(value["persistenceError"],"injected write/flush/sync loss");
        assert_eq!(value["acceptanceAuthority"],false);
    }

    #[test]
    fn separate_time_journal_collision_does_not_change_legacy_start_or_strict_bytes() {
        let dir=tempfile::tempdir().unwrap();let pcm=dir.path().join("source.pcm");
        let optional=pcm.with_file_name("aec-source-playback-clock-independent-time.jsonl");
        std::fs::write(&optional,b"existing time custody").unwrap();
        let mut trace=RawClockTrace::open(&pcm,"endpoint",48000,10000000).unwrap();
        let legacy=serde_json::json!({"schemaVersion":1,"artifactKind":"aec-source-playback-clock-start-diagnostic",
            "rawStartHresult":-1,"nativeApiError":"retained failed Start","callStartQpc100ns":123});
        let mut full=legacy.clone();full["diagnosticIndependentTime"]=serde_json::json!({"acceptanceAuthority":false,"before":null});
        full["diagnosticEndpointFormat"]=serde_json::json!({"acceptanceAuthority":false,"deviceRateHz":null,"getValueHresult":-1});
        trace.persist_start(full.clone()).unwrap();
        assert_eq!(trace.start_observation.as_ref(),Some(&legacy));
        let written: serde_json::Value=serde_json::from_slice(&std::fs::read(
            pcm.with_file_name("aec-source-playback-clock-start-diagnostic.json")).unwrap()).unwrap();
        assert_eq!(written,full);
        let mut strict=SourcePlaybackClock::new(Some(&pcm),"endpoint",48000).unwrap();
        for raw in [(40,384000,10001041),(3880,384000,10101041)] {
            trace.observe_reading(Ok(raw),960,Ok(144),(raw.2-1,raw.2+1),Some(0),&mut strict,None).unwrap();
        }
        assert!(strict.finish().is_ok());assert!(trace.finish().is_ok());
        assert_eq!(std::fs::read(&optional).unwrap(),b"existing time custody");
        let final_value=trace.final_observation.as_ref().unwrap();
        assert!(final_value["independentTimePersistenceError"].is_string());
        assert_eq!(final_value["independentTimeRowsWritten"],0);
        let rows: Vec<serde_json::Value>=std::fs::read_to_string(&trace.path).unwrap().lines()
            .map(|line|serde_json::from_str(line).unwrap()).collect();
        for row in rows {assert_eq!(row["diagnosticStart"],legacy);assert!(row.get("diagnosticIndependentTime").is_none());}
    }

}
