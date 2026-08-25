use std::path::PathBuf;

pub(crate) use omni_benchmark_core::{base64_encode_i16, resample_to_16k};

use crate::reporting::AudioFileInfo;

// ──────────────────────────────── Constants ────────────────────────────────

pub const CHUNK_SAMPLES: usize = 320; // 20ms @ 16kHz
pub const CHUNK_SEND_INTERVAL_MS: u64 = 18;

// ──────────────────────────────── Audio I/O ─────────────────────────────────

pub struct AudioDecodeResult {
    pub samples: Vec<i16>,
    pub info: AudioFileInfo,
}

pub fn read_audio_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    read_audio_with_info(path).map(|r| r.samples)
}

pub fn read_audio_with_info(path: &PathBuf) -> Result<AudioDecodeResult, String> {
    let file_size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());
    let format = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("unknown")
        .to_ascii_lowercase();

    let (samples, original_sample_rate, channels) = match format.as_str() {
        "mp3" => read_mp3_with_metadata(path)?,
        "wav" | "wave" => read_wav_with_metadata(path)?,
        "pcm" | "s16le" | "raw" => {
            let s = read_pcm16_mono_samples(path)?;
            (s, 16_000u32, 1u16)
        }
        other => {
            return Err(format!(
                "unsupported audio extension '{}'; expected .mp3, .wav, .pcm, .s16le, or .raw",
                if other.is_empty() { "(none)" } else { other }
            ))
        }
    };

    let duration_secs = samples.len() as f64 / 16_000.0;
    let info = AudioFileInfo {
        file_name,
        format,
        file_size_bytes,
        original_sample_rate,
        channels,
        decoded_samples: samples.len(),
        duration_secs,
    };

    Ok(AudioDecodeResult { samples, info })
}

fn read_mp3_with_metadata(path: &PathBuf) -> Result<(Vec<i16>, u32, u16), String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("open MP3 '{}': {e}", path.display()))?;
    let mut decoder = minimp3::Decoder::new(file);
    let mut mono = Vec::new();
    let mut sample_rate: Option<u32> = None;
    let mut channels: u16 = 1;

    loop {
        match decoder.next_frame() {
            Ok(frame) => {
                sample_rate.get_or_insert(frame.sample_rate.max(1) as u32);
                let ch = frame.channels.max(1);
                if ch > 1 {
                    channels = ch as u16;
                }
                mono.extend(frame.data.chunks(ch).map(|ch_slice| {
                    ch_slice
                        .iter()
                        .copied()
                        .map(|s| s as f32 / i16::MAX as f32)
                        .sum::<f32>()
                        / ch_slice.len().max(1) as f32
                }));
            }
            Err(minimp3::Error::Eof) => break,
            Err(e) => return Err(format!("MP3 decode '{}': {e}", path.display())),
        }
    }

    let original_rate = sample_rate.unwrap_or(16_000);
    Ok((resample_to_16k(&mono, original_rate), original_rate, channels))
}

fn read_wav_with_metadata(path: &PathBuf) -> Result<(Vec<i16>, u32, u16), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read WAV '{}': {e}", path.display()))?;
    let wav = parse_wav(&bytes).map_err(|e| format!("WAV decode '{}': {e}", path.display()))?;
    let channels = wav.channels;
    let rate = wav.sample_rate;
    Ok((resample_to_16k(&wav.samples, rate), rate, channels))
}

fn read_pcm16_mono_samples(path: &PathBuf) -> Result<Vec<i16>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read PCM '{}': {e}", path.display()))?;
    if bytes.len() % 2 != 0 {
        return Err(format!(
            "PCM file '{}' has odd byte length {}; expected signed 16-bit little-endian mono",
            path.display(),
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect())
}

struct WavAudio {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
}

fn parse_wav(bytes: &[u8]) -> Result<WavAudio, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }

    let mut offset = 12usize;
    let mut format_tag = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut data_range = None;

    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        offset += 8;
        if offset + chunk_size > bytes.len() {
            return Err("truncated chunk".to_string());
        }
        match chunk_id {
            b"fmt " => {
                if chunk_size < 16 {
                    return Err("fmt chunk too short".to_string());
                }
                format_tag = Some(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]));
                channels = Some(u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]));
                sample_rate = Some(u32::from_le_bytes([
                    bytes[offset + 4],
                    bytes[offset + 5],
                    bytes[offset + 6],
                    bytes[offset + 7],
                ]));
                bits_per_sample =
                    Some(u16::from_le_bytes([bytes[offset + 14], bytes[offset + 15]]));
            }
            b"data" => data_range = Some((offset, offset + chunk_size)),
            _ => {}
        }
        offset += chunk_size + (chunk_size % 2);
    }

    let format_tag = format_tag.ok_or_else(|| "missing fmt chunk".to_string())?;
    let channels = channels
        .filter(|value| *value > 0)
        .ok_or_else(|| "invalid channel count".to_string())? as usize;
    let sample_rate = sample_rate
        .filter(|value| *value > 0)
        .ok_or_else(|| "invalid sample rate".to_string())?;
    let bits_per_sample = bits_per_sample.ok_or_else(|| "missing bits per sample".to_string())?;
    let (start, end) = data_range.ok_or_else(|| "missing data chunk".to_string())?;
    let data = &bytes[start..end];

    let mono = match (format_tag, bits_per_sample) {
        (1, 16) => data
            .chunks_exact(channels * 2)
            .map(|frame| {
                frame
                    .chunks_exact(2)
                    .take(channels)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
                    .sum::<f32>()
                    / channels as f32
            })
            .collect(),
        (3, 32) => data
            .chunks_exact(channels * 4)
            .map(|frame| {
                frame
                    .chunks_exact(4)
                    .take(channels)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .sum::<f32>()
                    / channels as f32
            })
            .collect(),
        _ => {
            return Err(format!(
                "unsupported WAV format tag {} with {} bits per sample",
                format_tag, bits_per_sample
            ))
        }
    };

    Ok(WavAudio {
        samples: mono,
        sample_rate,
        channels: channels as u16,
    })
}
