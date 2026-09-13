use super::DecodedAudio;
use rodio::Source;
use std::path::Path;

pub(super) fn decode_media(path: &Path) -> Result<DecodedAudio, String> {
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
    let decoder = rodio::Decoder::try_from(file)
        .map_err(|error| format!("failed to decode media '{}': {error}", path.display()))?;
    let source_sample_rate_hz = decoder.sample_rate().get();
    let source_channels = decoder.channels().get() as usize;
    let samples = decoder.collect::<Vec<f32>>();
    Ok(DecodedAudio {
        samples,
        source_sample_rate_hz,
        source_channels,
    })
}


