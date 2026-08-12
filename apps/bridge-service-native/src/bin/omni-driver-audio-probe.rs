#[cfg(not(windows))]
fn main() {
    if omni_bridge_service::emit_build_commit_if_requested() {
        return;
    }
    eprintln!("omni-driver-audio-probe is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if omni_bridge_service::emit_build_commit_if_requested() {
        return;
    }
    use probe::{reset_only, run_inject_only, run_probe, FailureResult, InjectionResult, ResetResult};

    if std::env::args().any(|arg| arg == "--reset-only") {
        match reset_only() {
            Ok(result) => println!("{}", serde_json::to_string(&result).unwrap()),
            Err(detail) => {
                println!(
                    "{}",
                    serde_json::to_string(&ResetResult {
                        passed: false,
                        detail: Some(detail),
                    })
                    .unwrap()
                );
                std::process::exit(1);
            }
        }
        return;
    }

    if std::env::args().any(|arg| arg == "--inject-only") {
        match run_inject_only() {
            Ok(result) => println!("{}", serde_json::to_string(&result).unwrap()),
            Err(detail) => {
                println!(
                    "{}",
                    serde_json::to_string(&InjectionResult {
                        passed: false,
                        frames_written: 0,
                        detail: Some(detail),
                    })
                    .unwrap()
                );
                std::process::exit(1);
            }
        }
        return;
    }

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
        open_render_stream, IOCTL_OMNI_BRIDGE_BEGIN_MIC_SESSION, IOCTL_OMNI_BRIDGE_END_MIC_SESSION,
        OMNI_BRIDGE_ABI_VERSION,
        VIRTUAL_MIC_BITS_PER_SAMPLE, VIRTUAL_MIC_BLOCK_ALIGN_BYTES, VIRTUAL_MIC_CHANNEL_COUNT,
        VIRTUAL_MIC_SAMPLE_RATE_HZ,
    };
    use serde::Serialize;
    use std::f32::consts::TAU;
    use std::thread;
    use std::time::{Duration, Instant};
    use wasapi::{
        initialize_mta, AudioCaptureClient, AudioClient, AudioRenderClient, Device,
        DeviceEnumerator, Direction, SampleType, WaveFormat,
    };

    mod collection;
    mod driver_io;
    use collection::{
        collect_for, collect_virtual_mic_for, collect_virtual_mic_with_tone_for,
        collect_with_tone_for, error_text, estimate_dominant_frequency, require_capture,
        require_virtual_mic_capture,
    };
    use driver_io::{
        open_driver, query_driver_status, reset_driver_ring, virtual_mic_session_ioctl,
        write_virtual_mic_pcm,
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
    const MIN_BASELINE_RMS: f32 = 0.03;
    const MIC_BYTES_PER_FRAME: usize = VIRTUAL_MIC_BLOCK_ALIGN_BYTES as usize;
    const MIC_CHUNK_FRAMES: usize = VIRTUAL_MIC_SAMPLE_RATE_HZ as usize / 50;

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
        pub virtual_mic: VirtualMicProbeResult,
        pub detail: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct VirtualMicProbeResult {
        pub endpoint_id: String,
        pub endpoint_name: String,
        pub generation: u64,
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
        pub written_bytes: u64,
        pub consumed_bytes: u64,
        pub dropped_bytes: u64,
        pub underrun_bytes: u64,
        pub rejected_writes: u64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct FailureResult {
        pub passed: bool,
        pub detail: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct InjectionResult {
        pub passed: bool,
        pub frames_written: usize,
        pub detail: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ResetResult {
        pub passed: bool,
        pub detail: Option<String>,
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

    #[derive(Default)]
    struct VirtualMicCaptureMetrics {
        mono_samples: Vec<f32>,
        peak: f32,
        square_sum: f64,
    }

    impl VirtualMicCaptureMetrics {
        fn push_packet(&mut self, packet: &[u8]) {
            for sample in packet.chunks_exact(MIC_BYTES_PER_FRAME) {
                let normalized = i16::from_le_bytes(sample.try_into().unwrap()) as f32
                    / i16::MAX as f32;
                self.peak = self.peak.max(normalized.abs());
                self.square_sum += (normalized as f64) * (normalized as f64);
                self.mono_samples.push(normalized);
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

    struct VirtualMicCapture {
        audio_client: AudioClient,
        capture_client: AudioCaptureClient,
    }

    impl VirtualMicCapture {
        fn start(device: &Device, format: &WaveFormat) -> Result<Self, String> {
            let (audio_client, capture_client) = open_capture_stream(device, format)?;
            Ok(Self {
                audio_client,
                capture_client,
            })
        }

        fn collect_available(
            &self,
            metrics: &mut VirtualMicCaptureMetrics,
        ) -> Result<(), String> {
            for_each_capture_packet(&self.capture_client, MIC_BYTES_PER_FRAME, |packet, _| {
                metrics.push_packet(packet);
            })
        }
    }

    impl Drop for VirtualMicCapture {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    struct VirtualMicInjector {
        driver: std::fs::File,
        generation: u64,
        phase: f32,
        ended: bool,
    }

    impl VirtualMicInjector {
        fn start(generation: u64) -> Result<Self, String> {
            let driver = open_driver()?;
            virtual_mic_session_ioctl(
                &driver,
                IOCTL_OMNI_BRIDGE_BEGIN_MIC_SESSION,
                generation,
            )?;
            Ok(Self {
                driver,
                generation,
                phase: 0.0,
                ended: false,
            })
        }

        fn write_tone_chunk(&mut self) -> Result<(), String> {
            let phase_step = TAU * TONE_FREQUENCY_HZ / VIRTUAL_MIC_SAMPLE_RATE_HZ as f32;
            let mut samples = Vec::with_capacity(MIC_CHUNK_FRAMES);
            for _ in 0..MIC_CHUNK_FRAMES {
                let sample = (self.phase.sin() * TONE_AMPLITUDE * i16::MAX as f32).round() as i16;
                self.phase = (self.phase + phase_step) % TAU;
                samples.push(sample);
            }
            write_virtual_mic_pcm(&self.driver, self.generation, &samples)
        }

        fn end(&mut self) -> Result<(), String> {
            if self.ended {
                return Ok(());
            }
            self.ended = true;
            virtual_mic_session_ioctl(
                &self.driver,
                IOCTL_OMNI_BRIDGE_END_MIC_SESSION,
                self.generation,
            )
        }
    }

    impl Drop for VirtualMicInjector {
        fn drop(&mut self) {
            let _ = self.end();
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

    pub(super) fn reset_only() -> Result<ResetResult, String> {
        reset_driver_ring()?;
        Ok(ResetResult {
            passed: true,
            detail: None,
        })
    }

    pub(super) fn run_inject_only() -> Result<InjectionResult, String> {
        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let device = find_virtual_speaker(&enumerator)?;
        let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
        let mut render = ToneRender::start(&device, &format)?;
        let deadline = Instant::now() + Duration::from_millis(TONE_DURATION_MS);
        let mut frames_written = 0usize;
        while Instant::now() < deadline {
            let available = render
                .audio_client
                .get_available_space_in_frames()
                .map_err(error_text)? as usize;
            if available > 0 {
                render.write_available()?;
                frames_written = frames_written.saturating_add(available);
            } else {
                thread::sleep(Duration::from_millis(2));
            }
        }
        thread::sleep(Duration::from_millis(100));
        drop(render);
        if frames_written == 0 {
            return Err("inject-only render submitted zero frames".to_string());
        }
        Ok(InjectionResult {
            passed: true,
            frames_written,
            detail: None,
        })
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
        let virtual_mic = run_virtual_mic_probe(&enumerator, &mut failures)?;
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
            virtual_mic,
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

    fn find_virtual_microphone(enumerator: &DeviceEnumerator) -> Result<Device, String> {
        let collection = enumerator
            .get_device_collection(&Direction::Capture)
            .map_err(error_text)?;
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            if device
                .get_friendlyname()
                .map(|name| name.contains("Omni Translate Virtual Microphone"))
                .unwrap_or(false)
            {
                return Ok(device);
            }
        }
        Err("Omni Translate Virtual Microphone capture endpoint was not found".to_string())
    }

    fn run_virtual_mic_probe(
        enumerator: &DeviceEnumerator,
        failures: &mut Vec<String>,
    ) -> Result<VirtualMicProbeResult, String> {
        let device = find_virtual_microphone(enumerator)?;
        let endpoint_id = device.get_id().map_err(error_text)?;
        let endpoint_name = device.get_friendlyname().map_err(error_text)?;
        let format = WaveFormat::new(
            VIRTUAL_MIC_BITS_PER_SAMPLE as usize,
            VIRTUAL_MIC_BITS_PER_SAMPLE as usize,
            &SampleType::Int,
            VIRTUAL_MIC_SAMPLE_RATE_HZ as usize,
            VIRTUAL_MIC_CHANNEL_COUNT as usize,
            None,
        );
        let capture = VirtualMicCapture::start(&device, &format)?;
        let idle = collect_virtual_mic_for(&capture, Duration::from_millis(IDLE_DURATION_MS))?;

        let before = query_driver_status()?;
        if before.abi_version != OMNI_BRIDGE_ABI_VERSION
            || before.mic_ring_capacity_bytes == 0
            || before.mic_sample_rate_hz != VIRTUAL_MIC_SAMPLE_RATE_HZ
            || before.mic_channel_count != VIRTUAL_MIC_CHANNEL_COUNT
            || before.mic_bits_per_sample != VIRTUAL_MIC_BITS_PER_SAMPLE
        {
            return Err(format!(
                "virtual microphone driver capability mismatch: abi=0x{:08X}, capacity={}, rate={}, channels={}, bits={}",
                before.abi_version,
                before.mic_ring_capacity_bytes,
                before.mic_sample_rate_hz,
                before.mic_channel_count,
                before.mic_bits_per_sample,
            ));
        }
        let generation = before.mic_generation.wrapping_add(1).max(1);
        let mut injector = VirtualMicInjector::start(generation)?;
        let tone = collect_virtual_mic_with_tone_for(
            &capture,
            &mut injector,
            Duration::from_millis(TONE_DURATION_MS),
        )?;
        injector.end()?;
        let _ = collect_virtual_mic_for(&capture, Duration::from_millis(SETTLE_DURATION_MS))?;
        let post_tone_idle =
            collect_virtual_mic_for(&capture, Duration::from_millis(IDLE_DURATION_MS))?;
        let after = query_driver_status()?;

        require_virtual_mic_capture("virtual mic idle", &idle, failures);
        require_virtual_mic_capture("virtual mic tone", &tone, failures);
        require_virtual_mic_capture("virtual mic post-tone idle", &post_tone_idle, failures);
        let tone_frequency_hz = estimate_dominant_frequency(&tone.mono_samples);
        let tone_component = component_amplitude(&tone.mono_samples, TONE_FREQUENCY_HZ);
        if idle.peak > MAX_IDLE_PEAK {
            failures.push(format!(
                "virtual mic idle peak {:.6} exceeds {:.6}",
                idle.peak, MAX_IDLE_PEAK
            ));
        }
        if tone.rms() < MIN_TONE_RMS {
            failures.push(format!(
                "virtual mic tone rms {:.6} is below {:.6}",
                tone.rms(), MIN_TONE_RMS
            ));
        }
        if tone_component < MIN_TONE_COMPONENT {
            failures.push(format!(
                "virtual mic 1 kHz component {:.6} is below {:.6}",
                tone_component, MIN_TONE_COMPONENT
            ));
        }
        if (tone_frequency_hz - TONE_FREQUENCY_HZ).abs() > MAX_TONE_FREQUENCY_ERROR_HZ {
            failures.push(format!(
                "virtual mic tone frequency {:.1} Hz is not near {:.1} Hz",
                tone_frequency_hz, TONE_FREQUENCY_HZ
            ));
        }
        if post_tone_idle.peak > MAX_IDLE_PEAK {
            failures.push(format!(
                "virtual mic post-tone idle peak {:.6} exceeds {:.6}",
                post_tone_idle.peak, MAX_IDLE_PEAK
            ));
        }
        if after.mic_generation != generation {
            failures.push(format!(
                "virtual mic generation changed during probe: expected={generation}, actual={}",
                after.mic_generation
            ));
        }
        if after.mic_session_active != 0 {
            failures.push("virtual mic session remained active after END".to_string());
        }
        if after.mic_written_bytes < (VIRTUAL_MIC_SAMPLE_RATE_HZ as u64 * 2) {
            failures.push(format!(
                "virtual mic driver accepted only {} byte(s) of the injected tone",
                after.mic_written_bytes
            ));
        }
        if after.mic_consumed_bytes == 0 {
            failures.push("virtual mic capture pin consumed zero injected bytes".to_string());
        }
        if after.mic_dropped_bytes != 0 {
            failures.push(format!(
                "virtual mic ring dropped {} byte(s) during paced injection",
                after.mic_dropped_bytes
            ));
        }
        if after.mic_rejected_writes != 0 {
            failures.push(format!(
                "virtual mic driver rejected {} write(s) during probe",
                after.mic_rejected_writes
            ));
        }

        Ok(VirtualMicProbeResult {
            endpoint_id,
            endpoint_name,
            generation,
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
            written_bytes: after.mic_written_bytes,
            consumed_bytes: after.mic_consumed_bytes,
            dropped_bytes: after.mic_dropped_bytes,
            underrun_bytes: after.mic_underrun_bytes,
            rejected_writes: after.mic_rejected_writes,
        })
    }

}
