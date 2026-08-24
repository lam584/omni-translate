use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use flacenc::bitsink::{BitSink, ByteSink};
use flacenc::component::BitRepr;
use flacenc::error::Verify;
use flacenc::source::MemSource;

use super::crypto::HistoryCipher;

const FLAC_BLOCK_SIZE: usize = 4_096;
const AUDIO_FILE_MAGIC: &[u8; 10] = b"OMNIFLAC01";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum AudioTrack {
    Source,
    Translated,
}

impl AudioTrack {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Translated => "translated",
        }
    }
}

pub(super) struct ArchivedAudioSegment {
    pub(super) path: PathBuf,
    pub(super) encrypted_bytes: u64,
    pub(super) duration_ms: i64,
}

pub(super) fn archive_flac_segment(
    history_dir: &Path,
    cipher: &HistoryCipher,
    session_id: &str,
    track: AudioTrack,
    sequence: i64,
    sample_rate_hz: u32,
    samples: &[i16],
) -> Result<ArchivedAudioSegment, String> {
    if sample_rate_hz == 0 || samples.is_empty() {
        return Err("FLAC 归档需要非空 PCM 和有效采样率".to_string());
    }
    let segment_id = format!("{sequence:08}");
    let aad = format!(
        "history/v1:{session_id}:{}:{segment_id}",
        track.as_str()
    );
    let flac = encode_flac(samples, sample_rate_hz)?;
    let encrypted = cipher.encrypt(&flac, aad.as_bytes())?;
    let mut envelope = Vec::with_capacity(AUDIO_FILE_MAGIC.len() + encrypted.len());
    envelope.extend_from_slice(AUDIO_FILE_MAGIC);
    envelope.extend_from_slice(&encrypted);
    let directory = history_dir.join(session_id).join(track.as_str());
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let final_path = directory.join(format!("{segment_id}.flac.enc"));
    let part_path = directory.join(format!("{segment_id}.flac.enc.part"));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&part_path)
            .map_err(|error| error.to_string())?;
        file.write_all(&envelope).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&part_path, &final_path).map_err(|error| error.to_string())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&part_path);
        return Err(error);
    }
    Ok(ArchivedAudioSegment {
        path: final_path,
        encrypted_bytes: envelope.len() as u64,
        duration_ms: (samples.len() as u64)
            .saturating_mul(1_000)
            .div_ceil(u64::from(sample_rate_hz)) as i64,
    })
}

pub(super) fn decrypt_flac_segment(
    cipher: &HistoryCipher,
    session_id: &str,
    track: AudioTrack,
    sequence: i64,
    path: &Path,
) -> Result<(u32, Vec<i16>), String> {
    let segment_id = format!("{sequence:08}");
    let aad = format!(
        "history/v1:{session_id}:{}:{segment_id}",
        track.as_str()
    );
    let envelope = fs::read(path).map_err(|error| error.to_string())?;
    if envelope.len() <= AUDIO_FILE_MAGIC.len()
        || &envelope[..AUDIO_FILE_MAGIC.len()] != AUDIO_FILE_MAGIC
    {
        return Err("历史音频文件版本头无效".to_string());
    }
    let flac = cipher.decrypt(&envelope[AUDIO_FILE_MAGIC.len()..], aad.as_bytes())?;
    decode_flac(&flac)
}

fn encode_flac(samples: &[i16], sample_rate_hz: u32) -> Result<Vec<u8>, String> {
    let signal = samples.iter().map(|sample| i32::from(*sample)).collect::<Vec<_>>();
    let source = MemSource::from_samples(&signal, 1, 16, sample_rate_hz as usize);
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, error)| error.to_string())?;
    let stream = flacenc::encode_with_fixed_block_size(
        &config,
        source,
        FLAC_BLOCK_SIZE.min(samples.len()).max(1),
    )
    .map_err(|error| error.to_string())?;
    let mut sink = ByteSink::new();
    stream.write(&mut sink).map_err(|error| error.to_string())?;
    sink.align_to_byte().map_err(|error| error.to_string())?;
    Ok(sink.into_inner())
}

fn decode_flac(flac: &[u8]) -> Result<(u32, Vec<i16>), String> {
    let mut reader = claxon::FlacReader::new(Cursor::new(flac)).map_err(|error| error.to_string())?;
    let info = reader.streaminfo();
    if info.channels != 1 || info.bits_per_sample != 16 {
        return Err(format!(
            "历史音频格式不兼容：channels={} bitsPerSample={}",
            info.channels, info.bits_per_sample
        ));
    }
    let samples = reader
        .samples()
        .map(|sample| {
            sample
                .map_err(|error| error.to_string())
                .and_then(|sample| i16::try_from(sample).map_err(|_| "FLAC 样本超出 i16".to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((info.sample_rate, samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_flac_round_trips_without_plaintext_file_or_temp_file() {
        let directory = tempfile::tempdir().unwrap();
        let cipher = HistoryCipher::for_test([29; 32]);
        let samples = (0..16_000)
            .map(|index| (((index % 101) as i16) - 50) * 300)
            .collect::<Vec<_>>();
        let archived = archive_flac_segment(
            directory.path(),
            &cipher,
            "session-a",
            AudioTrack::Source,
            1,
            16_000,
            &samples,
        )
        .unwrap();

        let encrypted = fs::read(&archived.path).unwrap();
        assert!(encrypted.starts_with(AUDIO_FILE_MAGIC));
        assert!(!encrypted.windows(4).any(|window| window == b"fLaC"));
        assert!(!fs::read_dir(archived.path.parent().unwrap())
            .unwrap()
            .any(|entry| entry.unwrap().path().to_string_lossy().ends_with(".part")));
        let (sample_rate, decoded) = decrypt_flac_segment(
            &cipher,
            "session-a",
            AudioTrack::Source,
            1,
            &archived.path,
        )
        .unwrap();
        assert_eq!(sample_rate, 16_000);
        assert_eq!(decoded, samples);

        let second = archive_flac_segment(
            directory.path(),
            &cipher,
            "session-a",
            AudioTrack::Source,
            2,
            16_000,
            &samples,
        )
        .unwrap();
        let second_encrypted = fs::read(second.path).unwrap();
        let nonce_start = AUDIO_FILE_MAGIC.len() + 7;
        assert_ne!(
            &encrypted[nonce_start..nonce_start + 12],
            &second_encrypted[nonce_start..nonce_start + 12]
        );
        assert!(decrypt_flac_segment(
            &cipher,
            "session-a",
            AudioTrack::Translated,
            1,
            &archived.path,
        )
        .is_err());

        let mut tampered = fs::read(&archived.path).unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x40;
        fs::write(&archived.path, tampered).unwrap();
        assert!(decrypt_flac_segment(
            &cipher,
            "session-a",
            AudioTrack::Source,
            1,
            &archived.path,
        )
        .is_err());
    }
}
