use base64::Engine;

pub(super) fn resample_48k_stereo_to_16k_mono(input: &[u8]) -> Vec<i16> {
    let sample_count = input.len() / 4;
    if sample_count == 0 {
        return Vec::new();
    }

    let stereo_float: Vec<f32> = input
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();

    let mono_len = sample_count / 2;
    let mut mono = Vec::with_capacity(mono_len);
    for i in 0..mono_len {
        let left = stereo_float[i * 2];
        let right = stereo_float[i * 2 + 1];
        mono.push((left + right) * 0.5);
    }

    let ratio = 48_000 / 16_000;
    let out_len = mono.len() / ratio;
    let mut resampled = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = i * ratio;
        let window = &mono[start..start + ratio];
        resampled.push(window.iter().sum::<f32>() / ratio as f32);
    }

    resampled
        .iter()
        .map(|sample| {
            let clamped = sample.clamp(-1.0, 1.0);
            (clamped * 32767.0) as i16
        })
        .collect()
}

pub(super) fn base64_encode_i16(samples: &[i16]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();

    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

pub(super) fn asr_chunk_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares = samples.iter().fold(0.0_f64, |sum, sample| {
        let value = *sample as f64 / 32768.0;
        sum + value * value
    });
    (sum_squares / samples.len() as f64).sqrt() as f32
}

pub(super) fn base64_decode_to_i16(encoded: &str) -> Result<Vec<i16>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("base64 decode error: {e}"))?;
    if bytes.len() % 2 != 0 {
        return Err("odd byte count for i16 PCM".to_string());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}
