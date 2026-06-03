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
    use serde::Serialize;
    use std::f32::consts::TAU;
    use std::thread;
    use std::time::{Duration, Instant};
    use wasapi::{
        initialize_mta, AudioCaptureClient, AudioClient, AudioRenderClient, Device,
        DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
    };

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

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ProbeResult {
        pub passed: bool,
        pub endpoint_id: String,
        pub endpoint_name: String,
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
    pub struct FailureResult {
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
            let mut audio_client = device.get_iaudioclient().map_err(error_text)?;
            let (_, minimum_period) = audio_client.get_device_period().map_err(error_text)?;
            audio_client
                .initialize_client(
                    format,
                    &Direction::Capture,
                    &StreamMode::PollingShared {
                        autoconvert: true,
                        buffer_duration_hns: minimum_period,
                    },
                )
                .map_err(error_text)?;
            let capture_client = audio_client.get_audiocaptureclient().map_err(error_text)?;
            audio_client.start_stream().map_err(error_text)?;
            Ok(Self {
                audio_client,
                capture_client,
            })
        }

        fn collect_available(&self, metrics: &mut CaptureMetrics) -> Result<(), String> {
            while let Some(packet_frames) = self
                .capture_client
                .get_next_packet_size()
                .map_err(error_text)?
                .filter(|frames| *frames > 0)
            {
                let mut packet = vec![0_u8; packet_frames as usize * BYTES_PER_FRAME];
                let (frames_read, buffer_info) = self
                    .capture_client
                    .read_from_device(&mut packet)
                    .map_err(error_text)?;
                packet.truncate(frames_read as usize * BYTES_PER_FRAME);
                if buffer_info.flags.silent {
                    packet.fill(0);
                }
                metrics.push_packet(&packet, buffer_info.flags.silent);
            }
            Ok(())
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
            let mut audio_client = device.get_iaudioclient().map_err(error_text)?;
            let (_, minimum_period) = audio_client.get_device_period().map_err(error_text)?;
            audio_client
                .initialize_client(
                    format,
                    &Direction::Render,
                    &StreamMode::PollingShared {
                        autoconvert: true,
                        buffer_duration_hns: minimum_period,
                    },
                )
                .map_err(error_text)?;
            let render_client = audio_client.get_audiorenderclient().map_err(error_text)?;
            audio_client.start_stream().map_err(error_text)?;
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

    pub fn run_probe() -> Result<ProbeResult, String> {
        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let device = find_virtual_speaker(&enumerator)?;
        let endpoint_id = device.get_id().map_err(error_text)?;
        let endpoint_name = device.get_friendlyname().map_err(error_text)?;
        let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
        let capture = LoopbackCapture::start(&device, &format)?;

        let idle = collect_for(&capture, Duration::from_millis(IDLE_DURATION_MS))?;

        let mut render = ToneRender::start(&device, &format)?;
        let tone = collect_with_tone_for(
            &capture,
            &mut render,
            Duration::from_millis(TONE_DURATION_MS),
        )?;
        drop(render);

        let _ = collect_for(&capture, Duration::from_millis(SETTLE_DURATION_MS))?;
        let post_tone_idle = collect_for(&capture, Duration::from_millis(IDLE_DURATION_MS))?;
        let tone_frequency_hz = estimate_dominant_frequency(&tone.mono_samples);
        let tone_component = component_amplitude(&tone.mono_samples, TONE_FREQUENCY_HZ);
        let mut failures = Vec::new();
        require_capture("idle", &idle, &mut failures);
        require_capture("tone", &tone, &mut failures);
        require_capture("post-tone idle", &post_tone_idle, &mut failures);
        if idle.peak > MAX_IDLE_PEAK {
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
        if post_tone_idle.peak > MAX_IDLE_PEAK {
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

    fn component_amplitude(samples: &[f32], frequency_hz: f32) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let omega = TAU * frequency_hz / SAMPLE_RATE as f32;
        let mut real = 0.0_f64;
        let mut imaginary = 0.0_f64;
        for (index, sample) in samples.iter().enumerate() {
            let angle = omega as f64 * index as f64;
            real += *sample as f64 * angle.cos();
            imaginary -= *sample as f64 * angle.sin();
        }
        (2.0 * (real * real + imaginary * imaginary).sqrt() / samples.len() as f64) as f32
    }

    fn estimate_dominant_frequency(samples: &[f32]) -> f32 {
        let coarse = (100..=5_000)
            .step_by(25)
            .map(|frequency| frequency as f32)
            .max_by(|left, right| {
                component_amplitude(samples, *left).total_cmp(&component_amplitude(samples, *right))
            })
            .unwrap_or(0.0);
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
