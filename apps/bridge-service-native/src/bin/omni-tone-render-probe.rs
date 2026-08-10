#[cfg(not(windows))]
fn main() {
    eprintln!("omni-tone-render-probe is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    let quiet = std::env::args().any(|arg| arg == "--quiet");
    match probe::run() {
        Ok(result) => {
            if !quiet {
                println!("{}", serde_json::to_string(&result).unwrap());
            }
        }
        Err(error) => {
            if !quiet {
                println!(
                    "{}",
                    serde_json::to_string(&probe::ToneRenderResult::failed(error)).unwrap()
                );
            }
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod probe {
    use omni_bridge_service::probe_support::{error_text, open_render_stream};
    use serde::Serialize;
    use std::collections::VecDeque;
    use std::f32::consts::TAU;
    use std::thread;
    use std::time::{Duration, Instant};
    use wasapi::{
        initialize_mta, AudioClient, AudioRenderClient, Device, DeviceEnumerator, Direction,
        SampleType, WaveFormat,
    };

    const SAMPLE_RATE: usize = 48_000;
    const CHANNELS: usize = 2;
    const BYTES_PER_FRAME: usize = CHANNELS * std::mem::size_of::<f32>();

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ToneRenderResult {
        passed: bool,
        process_id: u32,
        endpoint_id: String,
        endpoint_name: String,
        frequency_hz: f32,
        amplitude: f32,
        rendered_frames: usize,
        rendered_seconds: f64,
        detail: Option<String>,
    }

    impl ToneRenderResult {
        pub(super) fn failed(detail: String) -> Self {
            Self {
                passed: false,
                process_id: std::process::id(),
                endpoint_id: String::new(),
                endpoint_name: String::new(),
                frequency_hz: 0.0,
                amplitude: 0.0,
                rendered_frames: 0,
                rendered_seconds: 0.0,
                detail: Some(detail),
            }
        }
    }

    struct Args {
        endpoint_id: String,
        frequency_hz: f32,
        amplitude: f32,
        seconds: f32,
    }

    struct ToneRender {
        audio_client: AudioClient,
        render_client: AudioRenderClient,
    }

    impl ToneRender {
        fn start(device: &Device, format: &WaveFormat) -> Result<Self, String> {
            let (audio_client, render_client) = open_render_stream(device, format)?;
            Ok(Self {
                audio_client,
                render_client,
            })
        }

        fn write_available(&mut self, pending: &mut VecDeque<f32>) -> Result<usize, String> {
            let available_frames = self
                .audio_client
                .get_available_space_in_frames()
                .map_err(error_text)? as usize;
            if available_frames == 0 || pending.is_empty() {
                return Ok(0);
            }

            let frames = available_frames.min(pending.len() / CHANNELS);
            let mut packet = Vec::with_capacity(frames * BYTES_PER_FRAME);
            for _ in 0..frames * CHANNELS {
                packet.extend_from_slice(&pending.pop_front().unwrap().to_le_bytes());
            }
            self.render_client
                .write_to_device(frames, &packet, None)
                .map_err(error_text)?;
            Ok(frames)
        }
    }

    impl Drop for ToneRender {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    pub(super) fn run() -> Result<ToneRenderResult, String> {
        let args = parse_args()?;
        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let device = find_render_device(&enumerator, &args.endpoint_id)?;
        let endpoint_id = device.get_id().map_err(error_text)?;
        let endpoint_name = device.get_friendlyname().map_err(error_text)?;
        let format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            SAMPLE_RATE,
            CHANNELS,
            None,
        );
        let mut render = ToneRender::start(&device, &format)?;
        let total_frames = (SAMPLE_RATE as f32 * args.seconds) as usize;
        let mut pending = VecDeque::with_capacity(total_frames * CHANNELS);
        for frame in 0..total_frames {
            let sample = args.amplitude
                * (TAU * args.frequency_hz * frame as f32 / SAMPLE_RATE as f32).sin();
            for _ in 0..CHANNELS {
                pending.push_back(sample);
            }
        }

        let started = Instant::now();
        let timeout = Duration::from_secs_f32(args.seconds + 8.0);
        let mut rendered_frames = 0usize;
        while !pending.is_empty() {
            rendered_frames += render.write_available(&mut pending)?;
            if started.elapsed() > timeout {
                return Err(format!(
                    "timed out rendering tone: renderedFrames={rendered_frames} totalFrames={total_frames}"
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
        thread::sleep(Duration::from_millis(300));

        Ok(ToneRenderResult {
            passed: true,
            process_id: std::process::id(),
            endpoint_id,
            endpoint_name,
            frequency_hz: args.frequency_hz,
            amplitude: args.amplitude,
            rendered_frames,
            rendered_seconds: rendered_frames as f64 / SAMPLE_RATE as f64,
            detail: None,
        })
    }

    fn parse_args() -> Result<Args, String> {
        let mut endpoint_id = None;
        let mut frequency_hz = None;
        let mut amplitude = None;
        let mut seconds = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--endpoint-id" => endpoint_id = Some(next_arg(&mut args, "--endpoint-id")?),
                "--frequency-hz" => {
                    frequency_hz = Some(parse_f32(
                        &next_arg(&mut args, "--frequency-hz")?,
                        "--frequency-hz",
                    )?)
                }
                "--amplitude" => {
                    amplitude = Some(parse_f32(
                        &next_arg(&mut args, "--amplitude")?,
                        "--amplitude",
                    )?)
                }
                "--seconds" => {
                    seconds = Some(parse_f32(
                        &next_arg(&mut args, "--seconds")?,
                        "--seconds",
                    )?)
                }
                "--quiet" => {}
                "--help" | "-h" => {
                    return Err("Usage: omni-tone-render-probe --endpoint-id <id> --frequency-hz <hz> --amplitude <0..1> --seconds <seconds>".to_string())
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }

        let frequency_hz = frequency_hz
            .filter(|value| value.is_finite() && *value >= 20.0 && *value <= 20_000.0)
            .ok_or_else(|| "--frequency-hz must be in 20..=20000".to_string())?;
        let amplitude = amplitude
            .filter(|value| value.is_finite() && *value > 0.0 && *value <= 1.0)
            .ok_or_else(|| "--amplitude must be in (0, 1]".to_string())?;
        let seconds = seconds
            .filter(|value| value.is_finite() && *value >= 0.1 && *value <= 30.0)
            .ok_or_else(|| "--seconds must be in 0.1..=30".to_string())?;
        Ok(Args {
            endpoint_id: endpoint_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "--endpoint-id is required".to_string())?,
            frequency_hz,
            amplitude,
            seconds,
        })
    }

    fn next_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
        let value = args.next().unwrap_or_default();
        if value.trim().is_empty() {
            return Err(format!("{name} requires a value"));
        }
        Ok(value)
    }

    fn parse_f32(raw: &str, name: &str) -> Result<f32, String> {
        raw.parse::<f32>()
            .map_err(|error| format!("invalid {name} '{raw}': {error}"))
    }

    fn find_render_device(
        enumerator: &DeviceEnumerator,
        endpoint_id: &str,
    ) -> Result<Device, String> {
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(error_text)?;
        let mut endpoints = Vec::new();
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            let id = device.get_id().map_err(error_text)?;
            let name = device.get_friendlyname().map_err(error_text)?;
            if id == endpoint_id {
                return Ok(device);
            }
            endpoints.push(format!("{name} [{id}]"));
        }
        Err(format!(
            "render endpoint not found. endpointId={endpoint_id} available={}",
            endpoints.join(" | ")
        ))
    }
}
