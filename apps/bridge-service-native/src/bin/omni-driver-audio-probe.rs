#[cfg(not(windows))]
fn main() {
    eprintln!("omni-driver-audio-probe is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    use probe::{run_probe, FailureResult};

    match run_probe() {
        Ok(result) => {
            println!("{}", serde_json::to_string(&result).unwrap());
            if !result.passed {
                std::process::exit(1);
            }
        }
        Err(detail) => {
            println!(
                "{}",
                serde_json::to_string(&FailureResult {
                    passed: false,
                    detail,
                })
                .unwrap()
            );
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod probe {
    use omni_bridge_service::probe_support::{
        coarse_dominant_frequency, component_amplitude, for_each_capture_packet, open_capture_stream,
        open_render_stream, DriverStatus, DRIVER_STATUS_BASE_SIZE, IOCTL_OMNI_BRIDGE_QUERY_STATUS,
        IOCTL_OMNI_BRIDGE_RESET, OMNI_BRIDGE_DEVICE_PATH,
    };
    use serde::Serialize;
    use std::f32::consts::TAU;
    use std::fs::OpenOptions;
    use std::os::windows::io::AsRawHandle;
    use std::thread;
    use std::time::{Duration, Instant};
    use wasapi::{
        initialize_mta, AudioCaptureClient, AudioClient, AudioRenderClient, Device,
        DeviceEnumerator, Direction, SampleType, WaveFormat,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const SAMPLE_RATE: usize = 48_000;
    const CHANNELS: usize = 2;
    const BYTES_PER_SAMPLE: usize = std::mem::size_of::<f32>();
    const BYTES_PER_FRAME: usize = CHANNELS * BYTES_PER_SAMPLE;
    const TONE_FREQUENCY_HZ: f32 = 1_000.0;
    const TONE_AMPLITUDE: f32 = 0.2;
    const IDLE_DURATION_MS: u64 = 700;
    const TONE_DURATION_MS: u64 = 1_200;
    const SETTLE_DURATION_MS: u64 = 350;
    const MAX_IDLE_PEAK: f32 = 0.002;
    const MIN_TONE_RMS: f32 = 0.03;
    const MIN_TONE_COMPONENT: f32 = 0.03;
    const MAX_TONE_FREQUENCY_ERROR_HZ: f32 = 30.0;
    const MIN_BASELINE_RMS: f32 = 0.03;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ProbeResult {
        pub passed: bool,
        pub endpoint_id: String,
        pub endpoint_name: String,
        pub captured_bytes_before_tone: u64,
        pub captured_bytes_after_tone: u64,
        pub delivered_bytes_before_tone: u64,
        pub delivered_bytes_after_tone: u64,
        pub dropped_bytes_after_tone: u64,
        pub idle_frames: usize,
        pub idle_peak: f32,
        pub idle_rms: f32,
        pub tone_frames: usize,
        pub tone_peak: f32,
        pub tone_rms: f32,
        pub tone_frequency_hz: f32,
        pub tone_component: f32,
        pub post_tone_idle_frames: usize,
        pub post_tone_idle_peak: f32,
        pub post_tone_idle_rms: f32,
        pub silent_packets: u64,
        pub invalid_samples: u64,
        pub detail: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct FailureResult {
        pub passed: bool,
        pub detail: String,
    }

    #[derive(Default)]
    struct CaptureMetrics {
        mono_samples: Vec<f32>,
        peak: f32,
        square_sum: f64,
        silent_packets: u64,
        invalid_samples: u64,
    }

    impl CaptureMetrics {
        fn push_packet(&mut self, packet: &[u8], silent: bool) {
            if silent {
                self.silent_packets += 1;
            }
            for frame in packet.chunks_exact(BYTES_PER_FRAME) {
                let mut mono = 0.0_f32;
                for channel in 0..CHANNELS {
                    let offset = channel * BYTES_PER_SAMPLE;
                    let sample = f32::from_le_bytes(frame[offset..offset + 4].try_into().unwrap());
                    if sample.is_finite() {
                        mono += sample.clamp(-1.0, 1.0);
                    } else {
                        self.invalid_samples += 1;
                    }
                }
                mono /= CHANNELS as f32;
                self.peak = self.peak.max(mono.abs());
                self.square_sum += (mono as f64) * (mono as f64);
                self.mono_samples.push(mono);
            }
        }

        fn frames(&self) -> usize {
            self.mono_samples.len()
        }

        fn rms(&self) -> f32 {
            if self.mono_samples.is_empty() {
                0.0
            } else {
                (self.square_sum / self.mono_samples.len() as f64).sqrt() as f32
            }
        }
    }

    struct LoopbackCapture {
        audio_client: AudioClient,
        capture_client: AudioCaptureClient,
    }

    impl LoopbackCapture {
        fn start(device: &Device, format: &WaveFormat) -> Result<Self, String> {
            let (audio_client, capture_client) = open_capture_stream(device, format)?;
            Ok(Self {
                audio_client,
                capture_client,
            })
        }

        fn collect_available(&self, metrics: &mut CaptureMetrics) -> Result<(), String> {
            for_each_capture_packet(&self.capture_client, BYTES_PER_FRAME, |packet, silent| {
                metrics.push_packet(packet, silent);
            })
        }
    }

    impl Drop for LoopbackCapture {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    struct ToneRender {
        audio_client: AudioClient,
        render_client: AudioRenderClient,
        phase: f32,
    }

    impl ToneRender {
        fn start(device: &Device, format: &WaveFormat) -> Result<Self, String> {
            let (audio_client, render_client) = open_render_stream(device, format)?;
            Ok(Self {
                audio_client,
                render_client,
                phase: 0.0,
            })
        }

        fn write_available(&mut self) -> Result<(), String> {
            let frames = self
                .audio_client
                .get_available_space_in_frames()
                .map_err(error_text)? as usize;
            if frames == 0 {
                return Ok(());
            }
            let mut packet = Vec::with_capacity(frames * BYTES_PER_FRAME);
            let phase_step = TAU * TONE_FREQUENCY_HZ / SAMPLE_RATE as f32;
            for _ in 0..frames {
                let sample = self.phase.sin() * TONE_AMPLITUDE;
                self.phase = (self.phase + phase_step) % TAU;
                for _ in 0..CHANNELS {
                    packet.extend_from_slice(&sample.to_le_bytes());
                }
            }
            self.render_client
                .write_to_device(frames, &packet, None)
                .map_err(error_text)
        }
    }

    impl Drop for ToneRender {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    pub(super) fn run_probe() -> Result<ProbeResult, String> {
        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let device = find_virtual_speaker(&enumerator)?;
        let endpoint_id = device.get_id().map_err(error_text)?;
        let endpoint_name = device.get_friendlyname().map_err(error_text)?;
        let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
        reset_driver_ring()?;
        let capture = LoopbackCapture::start(&device, &format)?;

        let idle = collect_for(&capture, Duration::from_millis(IDLE_DURATION_MS))?;
        let status_before_tone = query_driver_status()?;

        let mut render = ToneRender::start(&device, &format)?;
        let tone = collect_with_tone_for(
            &capture,
            &mut render,
            Duration::from_millis(TONE_DURATION_MS),
        )?;
        drop(render);
        let status_after_tone = query_driver_status()?;

        let _ = collect_for(&capture, Duration::from_millis(SETTLE_DURATION_MS))?;
        let post_tone_idle = collect_for(&capture, Duration::from_millis(IDLE_DURATION_MS))?;
        reset_driver_ring()?;
        let idle_frequency_hz = estimate_dominant_frequency(&idle.mono_samples);
        let tone_frequency_hz = estimate_dominant_frequency(&tone.mono_samples);
        let post_tone_idle_frequency_hz = estimate_dominant_frequency(&post_tone_idle.mono_samples);
        let tone_component = component_amplitude(&tone.mono_samples, TONE_FREQUENCY_HZ);
        let baseline_is_audible =
            idle.rms() >= MIN_BASELINE_RMS && post_tone_idle.rms() >= MIN_BASELINE_RMS;
        let mut failures = Vec::new();
        require_capture("idle", &idle, &mut failures);
        require_capture("tone", &tone, &mut failures);
        require_capture("post-tone idle", &post_tone_idle, &mut failures);
        if !baseline_is_audible && idle.peak > MAX_IDLE_PEAK {
            failures.push(format!(
                "idle peak {:.6} exceeds {:.6}",
                idle.peak, MAX_IDLE_PEAK
            ));
        }
        if tone.rms() < MIN_TONE_RMS {
            failures.push(format!(
                "tone rms {:.6} is below {:.6}",
                tone.rms(),
                MIN_TONE_RMS
            ));
        }
        if baseline_is_audible {
            if idle_frequency_hz <= 0.0
                || tone_frequency_hz <= 0.0
                || post_tone_idle_frequency_hz <= 0.0
            {
                failures.push(
                    "audible virtual endpoint baseline did not produce a stable frequency"
                        .to_string(),
                );
            }
        } else {
            if tone_component < MIN_TONE_COMPONENT {
                failures.push(format!(
                    "1 kHz component {:.6} is below {:.6}",
                    tone_component, MIN_TONE_COMPONENT
                ));
            }
            if (tone_frequency_hz - TONE_FREQUENCY_HZ).abs() > MAX_TONE_FREQUENCY_ERROR_HZ {
                failures.push(format!(
                    "tone frequency {:.1} Hz is not near {:.1} Hz",
                    tone_frequency_hz, TONE_FREQUENCY_HZ
                ));
            }
        }
        if !baseline_is_audible && post_tone_idle.peak > MAX_IDLE_PEAK {
            failures.push(format!(
                "post-tone idle peak {:.6} exceeds {:.6}",
                post_tone_idle.peak, MAX_IDLE_PEAK
            ));
        }
        let invalid_samples =
            idle.invalid_samples + tone.invalid_samples + post_tone_idle.invalid_samples;
        if invalid_samples > 0 {
            failures.push(format!("captured {invalid_samples} non-finite sample(s)"));
        }
        let detail = (!failures.is_empty()).then(|| failures.join("; "));

        Ok(ProbeResult {
            passed: detail.is_none(),
            endpoint_id,
            endpoint_name,
            captured_bytes_before_tone: status_before_tone.captured_bytes,
            captured_bytes_after_tone: status_after_tone.captured_bytes,
            delivered_bytes_before_tone: status_before_tone.delivered_bytes,
            delivered_bytes_after_tone: status_after_tone.delivered_bytes,
            dropped_bytes_after_tone: status_after_tone.dropped_bytes,
            idle_frames: idle.frames(),
            idle_peak: idle.peak,
            idle_rms: idle.rms(),
            tone_frames: tone.frames(),
            tone_peak: tone.peak,
            tone_rms: tone.rms(),
            tone_frequency_hz,
            tone_component,
            post_tone_idle_frames: post_tone_idle.frames(),
            post_tone_idle_peak: post_tone_idle.peak,
            post_tone_idle_rms: post_tone_idle.rms(),
            silent_packets: idle.silent_packets
                + tone.silent_packets
                + post_tone_idle.silent_packets,
            invalid_samples,
            detail,
        })
    }

    fn find_virtual_speaker(enumerator: &DeviceEnumerator) -> Result<Device, String> {
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(error_text)?;
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            if device
                .get_friendlyname()
                .map(|name| name.contains("Omni Translate Virtual Speaker"))
                .unwrap_or(false)
            {
                return Ok(device);
            }
        }
        Err("Omni Translate Virtual Speaker render endpoint was not found".to_string())
    }

    fn open_driver() -> Result<std::fs::File, String> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(OMNI_BRIDGE_DEVICE_PATH)
            .map_err(error_text)
    }

    fn reset_driver_ring() -> Result<(), String> {
        let driver = open_driver()?;
        let mut bytes_returned = 0_u32;
        let ok = unsafe {
            DeviceIoControl(
                driver.as_raw_handle(),
                IOCTL_OMNI_BRIDGE_RESET,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                0,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(format!(
                "driver reset failed before WASAPI probe: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    fn query_driver_status() -> Result<DriverStatus, String> {
        let driver = open_driver()?;
        let mut status = DriverStatus::default();
        let mut bytes_returned = 0_u32;
        let ok = unsafe {
            DeviceIoControl(
                driver.as_raw_handle(),
                IOCTL_OMNI_BRIDGE_QUERY_STATUS,
                std::ptr::null_mut(),
                0,
                (&mut status as *mut DriverStatus).cast(),
                std::mem::size_of::<DriverStatus>() as u32,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "driver status query failed during WASAPI probe: {}",
                std::io::Error::last_os_error()
            ));
        }
        if bytes_returned < DRIVER_STATUS_BASE_SIZE {
            return Err(format!(
                "driver status query returned {bytes_returned} byte(s); expected at least {DRIVER_STATUS_BASE_SIZE}"
            ));
        }
        Ok(status)
    }

    fn collect_for(
        capture: &LoopbackCapture,
        duration: Duration,
    ) -> Result<CaptureMetrics, String> {
        let started_at = Instant::now();
        let mut metrics = CaptureMetrics::default();
        while started_at.elapsed() < duration {
            capture.collect_available(&mut metrics)?;
            thread::sleep(Duration::from_millis(2));
        }
        capture.collect_available(&mut metrics)?;
        Ok(metrics)
    }

    fn collect_with_tone_for(
        capture: &LoopbackCapture,
        render: &mut ToneRender,
        duration: Duration,
    ) -> Result<CaptureMetrics, String> {
        let started_at = Instant::now();
        let mut metrics = CaptureMetrics::default();
        while started_at.elapsed() < duration {
            render.write_available()?;
            capture.collect_available(&mut metrics)?;
            thread::sleep(Duration::from_millis(2));
        }
        capture.collect_available(&mut metrics)?;
        Ok(metrics)
    }

    fn require_capture(label: &str, metrics: &CaptureMetrics, failures: &mut Vec<String>) {
        if metrics.frames() < SAMPLE_RATE / 3 {
            failures.push(format!(
                "{label} captured only {} frame(s); expected at least {}",
                metrics.frames(),
                SAMPLE_RATE / 3
            ));
        }
    }

    fn estimate_dominant_frequency(samples: &[f32]) -> f32 {
        let coarse = coarse_dominant_frequency(samples);
        let start = (coarse as i32 - 25).max(1);
        let end = coarse as i32 + 25;
        (start..=end)
            .step_by(5)
            .map(|frequency| frequency as f32)
            .max_by(|left, right| {
                component_amplitude(samples, *left).total_cmp(&component_amplitude(samples, *right))
            })
            .unwrap_or(coarse)
    }

    fn error_text(error: impl std::fmt::Display) -> String {
        error.to_string()
    }
}
