#[cfg(not(windows))]
fn main() {
    eprintln!("omni-watch-media-injector is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    match injector::run() {
        Ok(result) => println!("{}", serde_json::to_string(&result).unwrap()),
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string(&injector::InjectorResult::failed(error)).unwrap()
            );
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod injector {
    use omni_bridge_service::probe_support::open_render_stream;
    use serde::Serialize;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use wasapi::{
        initialize_mta, AudioClient, AudioRenderClient, Device, DeviceEnumerator, Direction,
        SampleType, WaveFormat,
    };

    const TARGET_SAMPLE_RATE: usize = 48_000;
    const TARGET_CHANNELS: usize = 2;
    const BYTES_PER_SAMPLE: usize = std::mem::size_of::<f32>();
    const BYTES_PER_FRAME: usize = TARGET_CHANNELS * BYTES_PER_SAMPLE;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct InjectorResult {
        pub passed: bool,
        pub media_path: String,
        pub endpoint_id: String,
        pub endpoint_name: String,
        pub process_id: u32,
        pub started_at_ms: u64,
        pub finished_at_ms: u64,
        pub source_sample_rate_hz: u32,
        pub source_channels: usize,
        pub rendered_frames: usize,
        pub rendered_seconds: f64,
        pub detail: Option<String>,
    }

    impl InjectorResult {
        pub(super) fn failed(detail: String) -> Self {
            Self {
                passed: false,
                media_path: String::new(),
                endpoint_id: String::new(),
                endpoint_name: String::new(),
                process_id: std::process::id(),
                started_at_ms: 0,
                finished_at_ms: unix_ms(),
                source_sample_rate_hz: 0,
                source_channels: 0,
                rendered_frames: 0,
                rendered_seconds: 0.0,
                detail: Some(detail),
            }
        }
    }

    struct Args {
        media_path: PathBuf,
        endpoint_id: Option<String>,
        endpoint_name: String,
        max_seconds: Option<f64>,
        reference_pcm16k_mono_path: Option<PathBuf>,
    }

    struct DecodedAudio {
        samples: Vec<f32>,
        source_sample_rate_hz: u32,
        source_channels: usize,
    }

    struct MediaRender {
        audio_client: AudioClient,
        render_client: AudioRenderClient,
    }

    impl MediaRender {
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

            let frames = available_frames.min(pending.len() / TARGET_CHANNELS);
            let mut packet = Vec::with_capacity(frames * BYTES_PER_FRAME);
            for _ in 0..(frames * TARGET_CHANNELS) {
                packet.extend_from_slice(&pending.pop_front().unwrap().to_le_bytes());
            }
            self.render_client
                .write_to_device(frames, &packet, None)
                .map_err(error_text)?;
            Ok(frames)
        }
    }

    impl Drop for MediaRender {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    pub(super) fn run() -> Result<InjectorResult, String> {
        let started_at_ms = unix_ms();
        let args = parse_args()?;
        let decoded = decode_mp3(&args.media_path)?;
        if decoded.samples.is_empty() {
            return Err(format!(
                "media decoded to zero samples: {}",
                args.media_path.display()
            ));
        }
        let target_samples = resample_to_48k_stereo(
            &decoded.samples,
            decoded.source_sample_rate_hz,
            decoded.source_channels,
        );
        let max_samples = args.max_seconds.map(|seconds| {
            (seconds.max(0.1) * TARGET_SAMPLE_RATE as f64) as usize * TARGET_CHANNELS
        });
        let target_samples = match max_samples {
            Some(limit) => target_samples.into_iter().take(limit).collect::<Vec<_>>(),
            None => target_samples,
        };
        if let Some(path) = args.reference_pcm16k_mono_path.as_ref() {
            let reference_samples = resample_to_16k_mono(
                &decoded.samples,
                decoded.source_sample_rate_hz,
                decoded.source_channels,
                args.max_seconds,
            );
            write_pcm16le(path, &reference_samples)?;
        }

        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let device = find_render_device(
            &enumerator,
            args.endpoint_id.as_deref(),
            &args.endpoint_name,
        )?;
        let endpoint_id = device.get_id().map_err(error_text)?;
        let endpoint_name = device.get_friendlyname().map_err(error_text)?;
        let format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            TARGET_SAMPLE_RATE,
            TARGET_CHANNELS,
            None,
        );
        let mut render = MediaRender::start(&device, &format)?;
        let total_frames = target_samples.len() / TARGET_CHANNELS;
        let mut pending = VecDeque::from(target_samples);
        let started = Instant::now();
        let timeout =
            Duration::from_secs_f64(total_frames as f64 / TARGET_SAMPLE_RATE as f64 + 8.0);
        let mut rendered_frames = 0usize;
        while !pending.is_empty() {
            rendered_frames += render.write_available(&mut pending)?;
            if started.elapsed() > timeout {
                return Err(format!(
                    "timed out rendering media: renderedFrames={rendered_frames} totalFrames={total_frames}"
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
        thread::sleep(Duration::from_millis(300));

        Ok(InjectorResult {
            passed: true,
            media_path: args.media_path.display().to_string(),
            endpoint_id,
            endpoint_name,
            process_id: std::process::id(),
            started_at_ms,
            finished_at_ms: unix_ms(),
            source_sample_rate_hz: decoded.source_sample_rate_hz,
            source_channels: decoded.source_channels,
            rendered_frames,
            rendered_seconds: rendered_frames as f64 / TARGET_SAMPLE_RATE as f64,
            detail: None,
        })
    }

    fn parse_args() -> Result<Args, String> {
        let mut media_path = None;
        let mut endpoint_id = None;
        let mut endpoint_name = "Omni Translate Virtual Speaker".to_string();
        let mut max_seconds = None;
        let mut reference_pcm16k_mono_path = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--media" => media_path = Some(PathBuf::from(next_arg(&mut args, "--media")?)),
                "--endpoint-id" => endpoint_id = Some(next_arg(&mut args, "--endpoint-id")?),
                "--endpoint-name" => endpoint_name = next_arg(&mut args, "--endpoint-name")?,
                "--reference-pcm16k-mono-path" => {
                    reference_pcm16k_mono_path = Some(PathBuf::from(next_arg(
                        &mut args,
                        "--reference-pcm16k-mono-path",
                    )?))
                }
                "--max-seconds" => {
                    let raw = next_arg(&mut args, "--max-seconds")?;
                    max_seconds = Some(
                        raw.parse::<f64>()
                            .map_err(|error| format!("invalid --max-seconds '{raw}': {error}"))?,
                    );
                }
                "--help" | "-h" => {
                    return Err(
                        "Usage: omni-watch-media-injector --media <mp3> [--endpoint-id <id>] [--endpoint-name <name>] [--max-seconds <seconds>] [--reference-pcm16k-mono-path <path>]".to_string(),
                    );
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }
        Ok(Args {
            media_path: media_path.ok_or_else(|| "--media <mp3> is required".to_string())?,
            endpoint_id,
            endpoint_name,
            max_seconds,
            reference_pcm16k_mono_path,
        })
    }

    fn next_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
        let value = args.next().unwrap_or_default();
        if value.trim().is_empty() {
            return Err(format!("{name} requires a value"));
        }
        Ok(value)
    }

    fn find_render_device(
        enumerator: &DeviceEnumerator,
        endpoint_id: Option<&str>,
        endpoint_name: &str,
    ) -> Result<Device, String> {
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(error_text)?;
        let mut names = Vec::new();
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            let id = device.get_id().map_err(error_text)?;
            let name = device.get_friendlyname().map_err(error_text)?;
            if endpoint_id
                .map(|requested| requested == id)
                .unwrap_or(false)
                || name.contains(endpoint_name)
            {
                return Ok(device);
            }
            names.push(format!("{name} [{id}]"));
        }
        Err(format!(
            "render endpoint not found. endpointId={:?} endpointName={} available={}",
            endpoint_id,
            endpoint_name,
            names.join(" | ")
        ))
    }

    fn decode_mp3(path: &PathBuf) -> Result<DecodedAudio, String> {
        let file = std::fs::File::open(path)
            .map_err(|error| format!("failed to open media '{}': {error}", path.display()))?;
        let mut decoder = minimp3::Decoder::new(file);
        let mut samples = Vec::new();
        let mut source_sample_rate_hz = None;
        let mut source_channels = None;
        loop {
            match decoder.next_frame() {
                Ok(frame) => {
                    source_sample_rate_hz.get_or_insert(frame.sample_rate.max(1) as u32);
                    source_channels.get_or_insert(frame.channels.max(1));
                    samples.extend(
                        frame
                            .data
                            .into_iter()
                            .map(|sample| sample as f32 / i16::MAX as f32),
                    );
                }
                Err(minimp3::Error::Eof) => break,
                Err(error) => {
                    return Err(format!(
                        "failed to decode media '{}': {error}",
                        path.display()
                    ))
                }
            }
        }
        Ok(DecodedAudio {
            samples,
            source_sample_rate_hz: source_sample_rate_hz.unwrap_or(TARGET_SAMPLE_RATE as u32),
            source_channels: source_channels.unwrap_or(1),
        })
    }

    fn resample_to_48k_stereo(samples: &[f32], sample_rate_hz: u32, channels: usize) -> Vec<f32> {
        if samples.is_empty() {
            return Vec::new();
        }
        let channels = channels.max(1);
        let source_frames = samples.len() / channels;
        let target_frames =
            source_frames.saturating_mul(TARGET_SAMPLE_RATE) / sample_rate_hz.max(1) as usize;
        let ratio = sample_rate_hz.max(1) as f64 / TARGET_SAMPLE_RATE as f64;
        let mut output = Vec::with_capacity(target_frames * TARGET_CHANNELS);
        for target_index in 0..target_frames {
            let source_index = ((target_index as f64) * ratio).floor() as usize;
            let source_index = source_index.min(source_frames.saturating_sub(1));
            let frame_start = source_index * channels;
            let left = samples[frame_start].clamp(-1.0, 1.0);
            let right = if channels > 1 {
                samples[frame_start + 1].clamp(-1.0, 1.0)
            } else {
                left
            };
            output.push(left);
            output.push(right);
        }
        output
    }

    fn resample_to_16k_mono(
        samples: &[f32],
        sample_rate_hz: u32,
        channels: usize,
        max_seconds: Option<f64>,
    ) -> Vec<i16> {
        if samples.is_empty() {
            return Vec::new();
        }
        let channels = channels.max(1);
        let source_frames = samples.len() / channels;
        let target_rate = 16_000usize;
        let mut target_frames =
            source_frames.saturating_mul(target_rate) / sample_rate_hz.max(1) as usize;
        if let Some(seconds) = max_seconds {
            target_frames = target_frames.min((seconds.max(0.1) * target_rate as f64) as usize);
        }
        let ratio = sample_rate_hz.max(1) as f64 / target_rate as f64;
        let mut output = Vec::with_capacity(target_frames);
        for target_index in 0..target_frames {
            let source_index = ((target_index as f64) * ratio).floor() as usize;
            let source_index = source_index.min(source_frames.saturating_sub(1));
            let frame_start = source_index * channels;
            let mut sum = 0.0f32;
            for channel in 0..channels {
                sum += samples[frame_start + channel].clamp(-1.0, 1.0);
            }
            let mono = (sum / channels as f32).clamp(-1.0, 1.0);
            output.push((mono * i16::MAX as f32) as i16);
        }
        output
    }

    fn write_pcm16le(path: &PathBuf, samples: &[i16]) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create reference PCM directory '{}': {error}",
                    parent.display()
                )
            })?;
        }
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(path, bytes).map_err(|error| {
            format!(
                "failed to write reference PCM '{}': {error}",
                path.display()
            )
        })
    }

    fn error_text(error: impl std::fmt::Display) -> String {
        error.to_string()
    }

    fn unix_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}
