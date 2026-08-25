use std::path::{Path, PathBuf};

use omni_benchmark_core::pcm::{analyze_canonical_waveform, analyze_pcm, analyze_pcm_fingerprint, analyze_translated_loopback, compare_pcm, compare_signed_pcm};

const PROFILE: &str = "watch-physical-output/v1";
const FINGERPRINT_PROFILE: &str = "fingerprint-components-v1";
const SIGNED_PROFILES: [&str; 3] = ["signed-waveform-v1", "translated-loopback-v1", "canonical-waveform-v1"];

#[derive(Debug)]
enum AudioCommand {
    Analyze { input: PathBuf, format: String, sample_rate_hz: Option<u32>, profile: String, frequencies: Vec<f64> },
    Compare {
        reference: PathBuf, recorded: PathBuf, wrong_references: Vec<PathBuf>, format: String,
        sample_rate_hz: Option<u32>, reference_sample_rate_hz: Option<u32>, reference_channels: Option<usize>,
        reference_offset_samples: usize, reference_sample_count: Option<usize>, expected_start_samples: Option<i64>, profile: String,
    },
}

fn next_value(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next().ok_or_else(|| format!("{name} requires a value"))
}

fn parse(arguments: &[String]) -> Result<AudioCommand, String> {
    let operation = arguments.first().ok_or_else(|| "audio requires analyze or compare".to_string())?;
    let mut input = None;
    let mut reference = None;
    let mut recorded = None;
    let mut wrong_references = Vec::new();
    let mut format = "auto".to_string();
    let mut sample_rate_hz = None;
    let mut reference_sample_rate_hz = None;
    let mut reference_channels = None;
    let mut reference_offset_samples = 0;
    let mut reference_sample_count = None;
    let mut expected_start_samples = None;
    let mut frequencies = Vec::new();
    let mut profile = PROFILE.to_string();
    let mut arguments = arguments[1..].iter().cloned();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--input" => input = Some(PathBuf::from(next_value(&mut arguments, "--input")?)),
            "--reference" => reference = Some(PathBuf::from(next_value(&mut arguments, "--reference")?)),
            "--recorded" => recorded = Some(PathBuf::from(next_value(&mut arguments, "--recorded")?)),
            "--wrong-reference" => wrong_references.push(PathBuf::from(next_value(&mut arguments, "--wrong-reference")?)),
            "--format" => format = next_value(&mut arguments, "--format")?,
            "--profile" => profile = next_value(&mut arguments, "--profile")?,
            "--sample-rate" => {
                let value = next_value(&mut arguments, "--sample-rate")?.parse::<u32>()
                    .map_err(|error| format!("invalid --sample-rate: {error}"))?;
                if value == 0 { return Err("--sample-rate must be greater than zero".to_string()); }
                sample_rate_hz = Some(value);
            }
            "--reference-sample-rate" => reference_sample_rate_hz = Some(next_value(&mut arguments, "--reference-sample-rate")?.parse().map_err(|error| format!("invalid --reference-sample-rate: {error}"))?),
            "--reference-channels" => reference_channels = Some(next_value(&mut arguments, "--reference-channels")?.parse().map_err(|error| format!("invalid --reference-channels: {error}"))?),
            "--reference-offset-samples" => reference_offset_samples = next_value(&mut arguments, "--reference-offset-samples")?.parse().map_err(|error| format!("invalid --reference-offset-samples: {error}"))?,
            "--reference-sample-count" => reference_sample_count = Some(next_value(&mut arguments, "--reference-sample-count")?.parse().map_err(|error| format!("invalid --reference-sample-count: {error}"))?),
            "--expected-start-samples" => expected_start_samples = Some(next_value(&mut arguments, "--expected-start-samples")?.parse().map_err(|error| format!("invalid --expected-start-samples: {error}"))?),
            "--frequency" => frequencies.push(next_value(&mut arguments, "--frequency")?.parse().map_err(|error| format!("invalid --frequency: {error}"))?),
            other => return Err(format!("unknown audio {operation} argument: {other}")),
        }
    }
    if profile != PROFILE && profile != FINGERPRINT_PROFILE && !SIGNED_PROFILES.contains(&profile.as_str()) { return Err(format!("unsupported audio analysis profile: {profile}")); }
    if !matches!(format.as_str(), "auto" | "pcm16le" | "wav") {
        return Err(format!("unsupported audio input format: {format}"));
    }
    match operation.as_str() {
        "analyze" => {
            if profile != PROFILE && profile != FINGERPRINT_PROFILE { return Err(format!("audio analyze does not support profile: {profile}")); }
            Ok(AudioCommand::Analyze {
                input: input.ok_or_else(|| "audio analyze requires --input".to_string())?,
                format,
                sample_rate_hz,
                profile,
                frequencies,
            })
        }
        "compare" => Ok(AudioCommand::Compare {
            reference: reference.ok_or_else(|| "audio compare requires --reference".to_string())?,
            recorded: recorded.ok_or_else(|| "audio compare requires --recorded".to_string())?,
            wrong_references,
            reference_sample_rate_hz,
            reference_channels,
            reference_offset_samples,
            reference_sample_count,
            expected_start_samples,
            format,
            sample_rate_hz,
            profile,
        }),
        _ => Err(format!("unknown audio operation: {operation}")),
    }
}

fn read_pcm16le(bytes: &[u8]) -> Vec<i16> {
    bytes.chunks_exact(2).map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]])).collect()
}

fn read_wav(bytes: &[u8], path: &Path) -> Result<(Vec<i16>, u32), String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("'{}' is not a RIFF/WAVE file", path.display()));
    }
    let mut offset = 12;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start.saturating_add(size);
        if end > bytes.len() { return Err(format!("'{}' contains a truncated WAV chunk", path.display())); }
        if id == b"fmt " && size >= 16 {
            format = Some((
                u16::from_le_bytes(bytes[start..start + 2].try_into().unwrap()),
                u16::from_le_bytes(bytes[start + 2..start + 4].try_into().unwrap()),
                u32::from_le_bytes(bytes[start + 4..start + 8].try_into().unwrap()),
                u16::from_le_bytes(bytes[start + 14..start + 16].try_into().unwrap()),
            ));
        } else if id == b"data" { data = Some(&bytes[start..end]); }
        offset = end + (size & 1);
    }
    let (encoding, channels, sample_rate_hz, bits) = format.ok_or_else(|| "WAV fmt chunk is missing".to_string())?;
    if encoding != 1 || bits != 16 || channels == 0 {
        return Err(format!("WAV must be PCM16 with at least one channel; encoding={encoding} bits={bits} channels={channels}"));
    }
    let interleaved = read_pcm16le(data.ok_or_else(|| "WAV data chunk is missing".to_string())?);
    let mono = if channels == 1 { interleaved } else {
        interleaved.chunks_exact(channels as usize)
            .map(|frame| (frame.iter().map(|sample| i64::from(*sample)).sum::<i64>() / i64::from(channels)) as i16)
            .collect()
    };
    Ok((mono, sample_rate_hz))
}

fn read_audio(path: &Path, format: &str, sample_rate_hz: Option<u32>) -> Result<(Vec<i16>, u32, &'static str), String> {
    let bytes = std::fs::read(path).map_err(|error| format!("failed to read audio '{}': {error}", path.display()))?;
    let wav = format == "wav" || (format == "auto" && bytes.starts_with(b"RIFF"));
    if wav {
        let (samples, rate) = read_wav(&bytes, path)?;
        if let Some(expected) = sample_rate_hz {
            if expected != rate { return Err(format!("WAV sample rate {rate} does not match --sample-rate {expected}")); }
        }
        Ok((samples, rate, "wav"))
    } else {
        let rate = sample_rate_hz.ok_or_else(|| "raw pcm16le input requires --sample-rate".to_string())?;
        Ok((read_pcm16le(&bytes), rate, "pcm16le"))
    }
}

pub(crate) fn try_run(arguments: &[String]) -> Option<Result<(), String>> {
    if arguments.first().map(String::as_str) != Some("audio") { return None; }
    Some((|| {
        let command = parse(&arguments[1..])?;
        let (value, operation, input_format, profile) = match command {
            AudioCommand::Analyze { input, format, sample_rate_hz, profile, frequencies } => {
                let (samples, rate, detected) = read_audio(&input, &format, sample_rate_hz)?;
                let value = if profile == FINGERPRINT_PROFILE {
                    serde_json::to_value(analyze_pcm_fingerprint(&samples, rate, &frequencies))
                } else { serde_json::to_value(analyze_pcm(&samples, rate)) };
                (value, "analyze", detected, profile)
            }
            AudioCommand::Compare { reference, recorded, wrong_references, format, sample_rate_hz, reference_sample_rate_hz, reference_channels, reference_offset_samples, reference_sample_count, expected_start_samples, profile } => {
                if profile == "translated-loopback-v1" {
                    let reference_bytes = std::fs::read(&reference).map_err(|error| format!("failed to read audio '{}': {error}", reference.display()))?;
                    let all_reference = read_pcm16le(&reference_bytes);
                    let end = reference_sample_count.map(|count| reference_offset_samples.saturating_add(count)).unwrap_or(all_reference.len());
                    let reference = all_reference.get(reference_offset_samples..end)
                        .ok_or_else(|| "translated reference sample range is outside the PCM file".to_string())?;
                    let (recorded, recorded_rate, detected) = read_audio(&recorded, &format, sample_rate_hz)?;
                    if recorded_rate != 16_000 { return Err("translated loopback recording must be 16 kHz".to_string()); }
                    let value = serde_json::to_value(analyze_translated_loopback(
                        reference,
                        reference_channels.ok_or_else(|| "translated-loopback-v1 requires --reference-channels".to_string())?,
                        reference_sample_rate_hz.ok_or_else(|| "translated-loopback-v1 requires --reference-sample-rate".to_string())?,
                        &recorded,
                        expected_start_samples.ok_or_else(|| "translated-loopback-v1 requires --expected-start-samples".to_string())?,
                    )?);
                    (value, "compare", detected, profile)
                } else {
                let (reference, reference_rate, detected_reference) = read_audio(&reference, &format, sample_rate_hz)?;
                let (recorded, recorded_rate, detected_recorded) = read_audio(&recorded, &format, sample_rate_hz)?;
                if reference_rate != recorded_rate { return Err(format!("audio sample rates differ: {reference_rate} vs {recorded_rate}")); }
                let detected = if detected_reference == detected_recorded { detected_reference } else { "mixed" };
                let value = if profile == PROFILE {
                    serde_json::to_value(compare_pcm(&reference, &recorded, reference_rate))
                } else if profile == "canonical-waveform-v1" {
                    let controls = wrong_references.into_iter().map(|control| {
                        let label = control.file_name().and_then(|value| value.to_str()).unwrap_or("wrong-reference").to_string();
                        let (samples, rate, _) = read_audio(&control, &format, sample_rate_hz)?;
                        if rate != reference_rate { return Err(format!("wrong-reference sample rate differs: {rate} vs {reference_rate}")); }
                        Ok((label, samples))
                    }).collect::<Result<Vec<_>, String>>()?;
                    serde_json::to_value(analyze_canonical_waveform(&reference, &recorded, &controls, reference_rate)?)
                } else {
                    serde_json::to_value(compare_signed_pcm(&reference, &recorded, reference_rate))
                };
                (value, "compare", detected, profile)
                }
            }
        };
        let mut value = value.map_err(|error| format!("failed to serialize audio result: {error}"))?;
        let object = value
            .as_object_mut().ok_or_else(|| "audio result was not an object".to_string())?;
        object.insert("schemaVersion".to_string(), "omni-audio-analysis/v1".into());
        object.insert("profile".to_string(), profile.into());
        object.insert("operation".to_string(), operation.into());
        object.insert("inputFormat".to_string(), input_format.into());
        println!("{value}");
        Ok(())
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_requires_operation_paths_and_rejects_unknown_profiles() {
        assert!(parse(&["analyze".into()]).unwrap_err().contains("--input"));
        assert!(parse(&["compare".into()]).unwrap_err().contains("--reference"));
        assert!(parse(&["analyze".into(), "--input".into(), "a.pcm".into(), "--profile".into(), "old".into()]).is_err());
    }

    #[test]
    fn reads_pcm16_mono_wav() {
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&38_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&32_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2_u32.to_le_bytes());
        wav.extend_from_slice(&123_i16.to_le_bytes());
        let (samples, rate) = read_wav(&wav, Path::new("test.wav")).unwrap();
        assert_eq!((samples, rate), (vec![123], 16_000));
    }
}
