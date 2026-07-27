fn apply_i16_gain(samples: &[i16], gain_db: f32) -> Vec<i16> {
    let gain = 10_f32.powf(gain_db / 20.0);
    samples
        .iter()
        .map(|sample| ((*sample as f32) * gain).clamp(i16::MIN as f32, i16::MAX as f32) as i16)
        .collect()
}

pub(crate) fn scale_i16_by_output_level(samples: &[i16], output_level: u64) -> Vec<i16> {
    let volume = playback_volume(output_level);
    samples
        .iter()
        .map(|sample| ((*sample as f32) * volume).clamp(i16::MIN as f32, i16::MAX as f32) as i16)
        .collect()
}

fn mix_pcm_tracks(left: &[i16], right: &[i16]) -> Vec<i16> {
    let len = left.len().max(right.len());
    let mut summed = Vec::with_capacity(len);
    for index in 0..len {
        let lhs = left.get(index).copied().unwrap_or(0) as i32;
        let rhs = right.get(index).copied().unwrap_or(0) as i32;
        summed.push(lhs + rhs);
    }
    let peak = summed.iter().map(|sample| sample.abs()).max().unwrap_or(0) as f32;
    let ceiling = 10.0_f32.powf(-1.0 / 20.0) * i16::MAX as f32;
    let scale = if peak > ceiling { ceiling / peak } else { 1.0 };
    summed
        .into_iter()
        .map(|sample| {
            (sample as f32 * scale)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16
        })
        .collect()
}

fn convert_captured_audio_to_mono_i16_24k(audio: &CapturedSegmentAudio) -> Vec<i16> {
    let mut mono = Vec::new();
    let frame_stride = audio.channel_count as usize * 4;
    if frame_stride == 0 {
        return mono;
    }

    for (frame_index, frame) in audio.pcm_f32le.chunks_exact(frame_stride).enumerate() {
        if audio.sample_rate_hz >= 48_000 && frame_index % 2 == 1 {
            continue;
        }

        let mut sample_sum = 0.0_f32;
        for channel_index in 0..audio.channel_count as usize {
            let offset = channel_index * 4;
            sample_sum += f32::from_le_bytes([
                frame[offset],
                frame[offset + 1],
                frame[offset + 2],
                frame[offset + 3],
            ]);
        }
        let sample = sample_sum / audio.channel_count.max(1) as f32;
        mono.push((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }

    mono
}

fn generate_prompt_tone(sample_rate_hz: u32, duration_ms: u32) -> Vec<i16> {
    let sample_count = (sample_rate_hz as u64 * duration_ms as u64 / 1_000) as usize;
    let mut tone = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let phase = index as f32 / sample_rate_hz as f32;
        let envelope = if index < 200 {
            index as f32 / 200.0
        } else if sample_count.saturating_sub(index) < 200 {
            sample_count.saturating_sub(index) as f32 / 200.0
        } else {
            1.0
        };
        tone.push(
            ((phase * 2.0 * std::f32::consts::PI * 880.0).sin() * envelope * 0.18 * i16::MAX as f32)
                as i16,
        );
    }
    tone
}
