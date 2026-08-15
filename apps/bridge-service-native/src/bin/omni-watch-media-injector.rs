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
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use wasapi::{
        initialize_mta, AudioClient, AudioRenderClient, Device, DeviceEnumerator, Direction,
        SampleType, WaveFormat,
    };

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
        pub render_sample_rate_hz: u32,
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
                render_sample_rate_hz: 0,
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
        let decoded = decode_media(&args.media_path)?;
        if decoded.samples.is_empty() {
            return Err(format!(
                "media decoded to zero samples: {}",
                args.media_path.display()
            ));
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
        let render_sample_rate_hz = device
            .get_iaudioclient()
            .and_then(|client| client.get_mixformat())
            .map_err(error_text)?
            .get_samplespersec()
            .max(1);
        let target_samples = resample_to_render_stereo(
            &decoded.samples,
            decoded.source_sample_rate_hz,
            decoded.source_channels,
            render_sample_rate_hz,
        );
        let max_samples = args.max_seconds.map(|seconds| {
            (seconds.max(0.1) * render_sample_rate_hz as f64) as usize * TARGET_CHANNELS
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

        let format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            render_sample_rate_hz as usize,
            TARGET_CHANNELS,
            None,
        );
        let mut render = MediaRender::start(&device, &format)?;
        let total_frames = target_samples.len() / TARGET_CHANNELS;
        let mut pending = VecDeque::from(target_samples);
        let started = Instant::now();
        let timeout =
            Duration::from_secs_f64(total_frames as f64 / render_sample_rate_hz as f64 + 8.0);
        let mut rendered_frames = 0usize;
        while !pending.is_empty() {
            rendered_frames += render.write_available(&mut pending)?;
            if started.elapsed() > timeout {
                return Err(format!(
                    "timed out rendering media: renderedFrames={rendered_frames} totalFrames={total_frames} sourceSampleRateHz={} renderSampleRateHz={render_sample_rate_hz}",
                    decoded.source_sample_rate_hz,
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
            render_sample_rate_hz,
            rendered_frames,
            rendered_seconds: rendered_frames as f64 / render_sample_rate_hz as f64,
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
                        "Usage: omni-watch-media-injector --media <wav-or-mp3> [--endpoint-id <id>] [--endpoint-name <name>] [--max-seconds <seconds>] [--reference-pcm16k-mono-path <path>]".to_string(),
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
            if render_device_matches_request(endpoint_id, &id, &name, endpoint_name) {
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

    fn render_device_matches_request(
        requested_endpoint_id: Option<&str>,
        actual_endpoint_id: &str,
        actual_endpoint_name: &str,
        requested_endpoint_name: &str,
    ) -> bool {
        // An explicit endpoint ID is authoritative. Falling back to the
        // legacy friendly-name selector here can silently route media to the
        // virtual speaker while the live recorder captures a physical device.
        match requested_endpoint_id {
            // MMDevice GUID text is case-insensitive. PnP commonly exposes
            // uppercase hex while WASAPI returns lowercase hex for the same
            // endpoint, so a byte-sensitive comparison rejects a valid,
            // explicitly selected device.
            Some(requested) => requested.eq_ignore_ascii_case(actual_endpoint_id),
            None => actual_endpoint_name.contains(requested_endpoint_name),
        }
    }

    fn decode_media(path: &Path) -> Result<DecodedAudio, String> {
        let bytes = std::fs::read(path)
            .map_err(|error| format!("failed to read media '{}': {error}", path.display()))?;
        if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
            return decode_wav_pcm(path, &bytes);
        }
        decode_mp3(path)
    }

    fn decode_wav_pcm(path: &Path, bytes: &[u8]) -> Result<DecodedAudio, String> {
        let mut cursor = 12usize;
        let mut format_chunk = None;
        let mut data_chunk = None;
        while cursor + 8 <= bytes.len() {
            let chunk_id = &bytes[cursor..cursor + 4];
            let chunk_size = u32::from_le_bytes(
                bytes[cursor + 4..cursor + 8]
                    .try_into()
                    .expect("WAV chunk size is four bytes"),
            ) as usize;
            let chunk_start = cursor + 8;
            let chunk_end = chunk_start
                .checked_add(chunk_size)
                .ok_or_else(|| format!("WAV chunk size overflows '{}': {chunk_size}", path.display()))?;
            if chunk_end > bytes.len() {
                return Err(format!(
                    "WAV chunk exceeds file '{}': end={chunk_end} length={}",
                    path.display(),
                    bytes.len()
                ));
            }
            match chunk_id {
                b"fmt " => format_chunk = Some(&bytes[chunk_start..chunk_end]),
                b"data" => data_chunk = Some(&bytes[chunk_start..chunk_end]),
                _ => {}
            }
            cursor = chunk_end + (chunk_size & 1);
        }

        let format = format_chunk
            .ok_or_else(|| format!("WAV media has no fmt chunk: {}", path.display()))?;
        if format.len() < 16 {
            return Err(format!(
                "WAV fmt chunk is too short for '{}': {} bytes",
                path.display(),
                format.len()
            ));
        }
        let audio_format = u16::from_le_bytes([format[0], format[1]]);
        let channels = u16::from_le_bytes([format[2], format[3]]) as usize;
        let sample_rate = u32::from_le_bytes([format[4], format[5], format[6], format[7]]);
        let block_align = u16::from_le_bytes([format[12], format[13]]) as usize;
        let bits_per_sample = u16::from_le_bytes([format[14], format[15]]);
        if channels == 0 || sample_rate == 0 || bits_per_sample == 0 {
            return Err(format!(
                "WAV fmt chunk has invalid audio parameters for '{}': channels={channels} sampleRate={sample_rate} bits={bits_per_sample}",
                path.display()
            ));
        }
        if audio_format != 1 && audio_format != 3 {
            return Err(format!(
                "WAV media '{}' uses unsupported audio format {audio_format}; expected PCM (1) or IEEE float (3)",
                path.display()
            ));
        }
        let bytes_per_sample = (bits_per_sample as usize).div_ceil(8);
        let expected_block_align = channels
            .checked_mul(bytes_per_sample)
            .ok_or_else(|| format!("WAV block alignment overflows '{}': channels={channels}", path.display()))?;
        if block_align != expected_block_align {
            return Err(format!(
                "WAV block alignment mismatch for '{}': declared={block_align} expected={expected_block_align}",
                path.display()
            ));
        }
        let data = data_chunk
            .ok_or_else(|| format!("WAV media has no data chunk: {}", path.display()))?;
        if data.len() % block_align != 0 {
            return Err(format!(
                "WAV data is not frame-aligned for '{}': bytes={} blockAlign={block_align}",
                path.display(),
                data.len()
            ));
        }

        let mut samples = Vec::with_capacity(data.len() / bytes_per_sample);
        for sample in data.chunks_exact(bytes_per_sample) {
            let value = match (audio_format, bits_per_sample) {
                (1, 8) => (sample[0] as f32 - 128.0) / 128.0,
                (1, 16) => i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32_768.0,
                (1, 24) => {
                    let raw = (sample[0] as i32)
                        | ((sample[1] as i32) << 8)
                        | ((sample[2] as i32) << 16);
                    let signed = if raw & 0x0080_0000 != 0 {
                        raw | !0x00ff_ffff
                    } else {
                        raw
                    };
                    signed as f32 / 8_388_608.0
                }
                (1, 32) => {
                    i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]) as f32
                        / 2_147_483_648.0
                }
                (3, 32) => f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]),
                (3, 64) => f64::from_le_bytes([
                    sample[0], sample[1], sample[2], sample[3], sample[4], sample[5], sample[6],
                    sample[7],
                ]) as f32,
                _ => {
                    return Err(format!(
                        "WAV media '{}' uses unsupported sample format={audio_format} bits={bits_per_sample}",
                        path.display()
                    ));
                }
            };
            if !value.is_finite() {
                return Err(format!("WAV media '{}' contains a non-finite sample", path.display()));
            }
            samples.push(value.clamp(-1.0, 1.0));
        }
        Ok(DecodedAudio {
            samples,
            source_sample_rate_hz: sample_rate,
            source_channels: channels,
        })
    }

    fn decode_mp3(path: &Path) -> Result<DecodedAudio, String> {
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
            source_sample_rate_hz: source_sample_rate_hz.unwrap_or(48_000),
            source_channels: source_channels.unwrap_or(1),
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn decodes_pcm16_wav_instead_of_treating_it_as_mp3() {
            let directory = tempfile::tempdir().expect("tempdir");
            let path = directory.path().join("sample.wav");
            let pcm = [-32_768i16, -16_384, 0, 16_384, 32_767];
            let data_len = (pcm.len() * 2) as u32;
            let mut wav = Vec::new();
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36u32 + data_len).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16u32.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&24_000u32.to_le_bytes());
            wav.extend_from_slice(&48_000u32.to_le_bytes());
            wav.extend_from_slice(&2u16.to_le_bytes());
            wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data_len.to_le_bytes());
            for sample in pcm {
                wav.extend_from_slice(&sample.to_le_bytes());
            }
            std::fs::write(&path, wav).expect("write WAV");

            let decoded = decode_media(&path).expect("decode WAV");
            assert_eq!(decoded.source_sample_rate_hz, 24_000);
            assert_eq!(decoded.source_channels, 1);
            assert_eq!(decoded.samples.len(), pcm.len());
            assert!((decoded.samples[0] + 1.0).abs() < 0.0001);
            assert!(decoded.samples[2].abs() < 0.0001);
            assert!((decoded.samples[4] - 0.9999695).abs() < 0.0001);
        }

        #[test]
        fn explicit_endpoint_id_never_falls_back_to_virtual_speaker_name() {
            assert!(render_device_matches_request(
                Some("{physical-endpoint}"),
                "{physical-endpoint}",
                "Speakers (High Definition Audio Device)",
                "Omni Translate Virtual Speaker",
            ));
            assert!(render_device_matches_request(
                Some("{0.0.0.00000000}.{0FA47289-698C-4F9B-BBB2-6775530CE776}"),
                "{0.0.0.00000000}.{0fa47289-698c-4f9b-bbb2-6775530ce776}",
                "Speakers (Omni Translate Virtual Speaker)",
                "Omni Translate Virtual Speaker",
            ));
            assert!(!render_device_matches_request(
                Some("{physical-endpoint}"),
                "{virtual-endpoint}",
                "Omni Translate Virtual Speaker",
                "Omni Translate Virtual Speaker",
            ));
            assert!(render_device_matches_request(
                None,
                "{virtual-endpoint}",
                "Omni Translate Virtual Speaker",
                "Omni Translate Virtual Speaker",
            ));
        }

        #[test]
        fn render_resampling_preserves_duration_across_endpoint_clocks() {
            let source = vec![0.25_f32; 24_000];
            let rendered_16k = resample_to_render_stereo(&source, 24_000, 1, 16_000);
            let rendered_48k = resample_to_render_stereo(&source, 24_000, 1, 48_000);
            assert_eq!(rendered_16k.len(), 16_000 * TARGET_CHANNELS);
            assert_eq!(rendered_48k.len(), 48_000 * TARGET_CHANNELS);
        }
    }

    fn resample_to_render_stereo(
        samples: &[f32],
        sample_rate_hz: u32,
        channels: usize,
        render_sample_rate_hz: u32,
    ) -> Vec<f32> {
        if samples.is_empty() {
            return Vec::new();
        }
        let channels = channels.max(1);
        let source_frames = samples.len() / channels;
        let target_frames = source_frames.saturating_mul(render_sample_rate_hz.max(1) as usize)
            / sample_rate_hz.max(1) as usize;
        let ratio = sample_rate_hz.max(1) as f64 / render_sample_rate_hz.max(1) as f64;
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
