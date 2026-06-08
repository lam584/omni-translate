use std::collections::VecDeque;

pub(super) fn drain_sample_chunks(
    sample_queue: &mut VecDeque<u8>,
    chunk_len: usize,
) -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    while sample_queue.len() >= chunk_len {
        let mut chunk = vec![0_u8; chunk_len];
        for item in &mut chunk {
            *item = sample_queue.pop_front().expect("chunk should be filled");
        }
        chunks.push(chunk);
    }
    chunks
}

pub(super) fn pcm16le_to_f32le(payload: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(payload.len() * 2);
    for sample in payload.chunks_exact(2) {
        let value = i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32;
        output.extend_from_slice(&value.to_le_bytes());
    }
    output
}

pub(super) fn calculate_chunk_db(chunk: &[u8]) -> f32 {
    let mut sample_count = 0_usize;
    let mut power_sum = 0.0_f64;
    for sample in chunk.chunks_exact(4) {
        let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]) as f64;
        power_sum += value * value;
        sample_count += 1;
    }

    if sample_count == 0 {
        return -90.0;
    }

    let rms = (power_sum / sample_count as f64).sqrt().max(1e-6);
    (20.0 * rms.log10()) as f32
}

pub(super) fn bytes_to_f32_stereo(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]))
        .collect()
}

pub(super) fn f32_stereo_to_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.clamp(-1.0, 1.0).to_le_bytes());
    }
    bytes
}
