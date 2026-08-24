use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use ts_rs::TS;

use super::audio::{decrypt_flac_segment, AudioTrack};
use super::fs_safety::canonical_archive_file;
use super::{unix_ms, HistoryStateStore};

pub const HISTORY_CHANGED_EVENT: &str = "history://changed";
pub const HISTORY_PLAYBACK_EVENT: &str = "history://playback";
const PLAYBACK_SOURCE: &str = "history-playback";
const PLAYBACK_STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, serde::Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HistoryAudioTrack {
    Source,
    Translated,
}

impl HistoryAudioTrack {
    fn archive_track(self) -> AudioTrack {
        match self {
            Self::Source => AudioTrack::Source,
            Self::Translated => AudioTrack::Translated,
        }
    }

    fn as_str(self) -> &'static str {
        self.archive_track().as_str()
    }
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryChangedEventV2 {
    #[ts(type = "'sessionStarted' | 'sessionFinalized' | 'sessionDeleted' | 'historyCleared' | 'archiveGap'")]
    pub reason: String,
    pub session_id: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPlaybackEventV2 {
    pub playback_id: String,
    pub session_id: String,
    pub cue_id: String,
    pub track: HistoryAudioTrack,
    #[ts(type = "'started' | 'stopped' | 'failed'")]
    pub status: String,
    pub reason: Option<String>,
    pub error: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPlaybackStartV2 {
    pub playback_id: String,
    #[ts(type = "'started'")]
    pub status: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPlaybackStopV2 {
    pub stopped: bool,
}

#[derive(Clone)]
struct ActivePlayback {
    generation: u64,
    playback_id: String,
    ownership_cue_id: String,
    session_id: String,
    cue_id: String,
    track: HistoryAudioTrack,
}

#[derive(Default)]
struct PlaybackState {
    next_generation: u64,
    active: Option<ActivePlayback>,
}

#[derive(Clone, Default)]
pub(super) struct HistoryPlaybackController {
    inner: Arc<Mutex<PlaybackState>>,
}

impl HistoryPlaybackController {
    pub(super) fn has_active(&self) -> bool {
        self.inner
            .lock()
            .map(|state| state.active.is_some())
            .unwrap_or(true)
    }

    fn begin(
        &self,
        session_id: &str,
        cue_id: &str,
        track: HistoryAudioTrack,
    ) -> Result<ActivePlayback, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "历史播放状态损坏".to_string())?;
        state.next_generation = state.next_generation.saturating_add(1);
        let playback_id = uuid::Uuid::now_v7().to_string();
        let active = ActivePlayback {
            generation: state.next_generation,
            ownership_cue_id: format!("history-{playback_id}"),
            playback_id,
            session_id: session_id.to_string(),
            cue_id: cue_id.to_string(),
            track,
        };
        state.active = Some(active.clone());
        Ok(active)
    }

    fn is_active(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|state| {
                state
                    .active
                    .as_ref()
                    .is_some_and(|active| active.generation == generation)
            })
            .unwrap_or(false)
    }

    fn take(&self) -> Result<Option<ActivePlayback>, String> {
        self.inner
            .lock()
            .map(|mut state| state.active.take())
            .map_err(|_| "历史播放状态损坏".to_string())
    }

    fn finish(&self, generation: u64) -> Option<ActivePlayback> {
        self.inner.lock().ok().and_then(|mut state| {
            if state
                .active
                .as_ref()
                .is_some_and(|active| active.generation == generation)
            {
                state.active.take()
            } else {
                None
            }
        })
    }

    fn restore_if_empty(&self, active: ActivePlayback) {
        if let Ok(mut state) = self.inner.lock() {
            if state.active.is_none() {
                state.active = Some(active);
            }
        }
    }
}

#[derive(Debug)]
struct DecodedAudioPiece {
    sample_rate_hz: u32,
    samples: Vec<i16>,
}

impl HistoryStateStore {
    pub(crate) fn play_cue_audio<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        cue_id: &str,
        track: HistoryAudioTrack,
    ) -> Result<HistoryPlaybackStartV2, String> {
        if routes_active(&app.state::<crate::audio::state::AudioStateStore>().snapshot()) {
            return Err("实时翻译 route 活跃时不能播放历史音频".to_string());
        }
        self.stop_playback(app, "superseded")?;
        let pieces = self.load_cue_audio(session_id, cue_id, track)?;
        if pieces.is_empty() {
            return Err(format!("该 cue 没有 {} 音轨", track.as_str()));
        }
        if routes_active(&app.state::<crate::audio::state::AudioStateStore>().snapshot()) {
            return Err("实时翻译 route 已启动，历史音频播放已取消".to_string());
        }

        let config = app
            .state::<crate::storage::StorageStateStore>()
            .load_config()
            .map_err(|error| format!("读取历史播放设备配置失败：{error}"))?;
        let device_id = config
            .pointer("/devices/playbackDeviceId")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string);
        let output_level = config
            .pointer("/devices/outputLevel")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(100)
            .min(100);
        let active = self.playback.begin(session_id, cue_id, track)?;
        let controller = self.playback.clone();
        let thread_app = app.clone();
        let thread_active = active.clone();
        let spawn = std::thread::Builder::new()
            .name("subtitle-history-playback".to_string())
            .spawn(move || {
                emit_playback(&thread_app, &thread_active, "started", None, None);
                let ownership = thread_app
                    .state::<crate::audio::state::AudioStateStore>()
                    .desktop_playback_ownership()
                    .clone();
                let result = pieces.into_iter().try_for_each(|piece| {
                    if !controller.is_active(thread_active.generation) {
                        return Ok(());
                    }
                    crate::audio::speech::play_to_speaker(
                        &piece.samples,
                        piece.sample_rate_hz,
                        1,
                        device_id.as_deref(),
                        output_level,
                        &ownership,
                        &thread_active.ownership_cue_id,
                        PLAYBACK_SOURCE,
                        |_| Ok(()),
                    )
                    .map(|_| ())
                });
                if let Some(completed) = controller.finish(thread_active.generation) {
                    match result {
                        Ok(()) => emit_playback(
                            &thread_app,
                            &completed,
                            "stopped",
                            Some("completed"),
                            None,
                        ),
                        Err(error) => emit_playback(
                            &thread_app,
                            &completed,
                            "failed",
                            None,
                            Some(error),
                        ),
                    }
                }
            });
        if let Err(error) = spawn {
            let _ = self.playback.finish(active.generation);
            emit_playback(app, &active, "failed", None, Some(error.to_string()));
            return Err(format!("启动历史音频播放线程失败：{error}"));
        }
        Ok(HistoryPlaybackStartV2 {
            playback_id: active.playback_id,
            status: "started".to_string(),
        })
    }

    pub(crate) fn stop_playback<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        reason: &str,
    ) -> Result<HistoryPlaybackStopV2, String> {
        let Some(active) = self.playback.take()? else {
            return Ok(HistoryPlaybackStopV2 { stopped: false });
        };
        let result = app
            .state::<crate::audio::state::AudioStateStore>()
            .desktop_playback_ownership()
            .cancel_and_drain_matching(
                &active.ownership_cue_id,
                PLAYBACK_SOURCE,
                PLAYBACK_STOP_TIMEOUT,
            );
        match result {
            Ok(_) => {
                emit_playback(app, &active, "stopped", Some(reason), None);
                Ok(HistoryPlaybackStopV2 { stopped: true })
            }
            Err(error) => {
                self.playback.restore_if_empty(active.clone());
                emit_playback(app, &active, "failed", None, Some(error.clone()));
                Err(error)
            }
        }
    }

    fn load_cue_audio(
        &self,
        session_id: &str,
        cue_id: &str,
        track: HistoryAudioTrack,
    ) -> Result<Vec<DecodedAudioPiece>, String> {
        let (repository, history_dir) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "history state poisoned".to_string())?;
            let state = inner
                .as_ref()
                .ok_or_else(|| "字幕历史尚未初始化".to_string())?;
            (super::repository(state)?, state.history_dir.clone())
        };
        load_cue_audio_from_repository(
            &repository,
            &history_dir,
            session_id,
            cue_id,
            track,
        )
    }
}

fn load_cue_audio_from_repository(
    repository: &super::repository::HistoryRepository,
    history_dir: &std::path::Path,
    session_id: &str,
    cue_id: &str,
    track: HistoryAudioTrack,
) -> Result<Vec<DecodedAudioPiece>, String> {
    let archive_track = track.archive_track();
    repository
        .cue_audio_segments(session_id, cue_id, archive_track.as_str())?
        .into_iter()
        .map(|segment| {
                let path = canonical_archive_file(&history_dir, &segment.encrypted_path)?
                    .ok_or_else(|| format!("历史音频文件缺失：{}", segment.encrypted_path.display()))?;
                let (decoded_rate, decoded) = decrypt_flac_segment(
                    &repository.cipher(),
                    session_id,
                    archive_track,
                    segment.sequence,
                    &path,
                )?;
                if decoded_rate != segment.sample_rate_hz {
                    return Err(format!(
                        "历史音频采样率与索引不一致：decoded={decoded_rate} indexed={}",
                        segment.sample_rate_hz
                    ));
                }
                let end = segment
                    .offset_samples
                    .checked_add(segment.length_samples)
                    .ok_or_else(|| "历史音频引用范围溢出".to_string())?;
                let samples = decoded
                    .get(segment.offset_samples..end)
                    .ok_or_else(|| "历史音频引用超出 FLAC 样本范围".to_string())?
                    .to_vec();
                Ok(DecodedAudioPiece {
                    sample_rate_hz: decoded_rate,
                    samples,
                })
        })
        .collect()
}

pub(super) fn emit_changed<R: Runtime>(
    app: &AppHandle<R>,
    reason: &str,
    session_id: Option<String>,
) {
    let _ = app.emit(HISTORY_CHANGED_EVENT, changed_event(reason, session_id));
}

pub(super) fn changed_event(
    reason: &str,
    session_id: Option<String>,
) -> HistoryChangedEventV2 {
    HistoryChangedEventV2 {
        reason: reason.to_string(),
        session_id,
        timestamp_ms: unix_ms().max(0) as u64,
    }
}

fn emit_playback<R: Runtime>(
    app: &AppHandle<R>,
    active: &ActivePlayback,
    status: &str,
    reason: Option<&str>,
    error: Option<String>,
) {
    let _ = app.emit(
        HISTORY_PLAYBACK_EVENT,
        HistoryPlaybackEventV2 {
            playback_id: active.playback_id.clone(),
            session_id: active.session_id.clone(),
            cue_id: active.cue_id.clone(),
            track: active.track,
            status: status.to_string(),
            reason: reason.map(str::to_string),
            error,
            timestamp_ms: unix_ms().max(0) as u64,
        },
    );
}

fn routes_active(snapshot: &crate::audio::contracts::AudioRuntimeSnapshot) -> bool {
    snapshot.inbound.stream_bound || snapshot.outbound.stream_bound
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::repository::{AudioCueRefWrite, AudioSegmentWrite, CueWrite, HistoryRepository};

    #[test]
    fn route_gate_rejects_either_active_direction() {
        let mut snapshot = crate::audio::contracts::AudioRuntimeSnapshot::preview();
        assert!(!routes_active(&snapshot));
        snapshot.inbound.stream_bound = true;
        assert!(routes_active(&snapshot));
        snapshot.inbound.stream_bound = false;
        snapshot.outbound.stream_bound = true;
        assert!(routes_active(&snapshot));
    }

    #[test]
    fn controller_stop_is_idempotent() {
        let controller = HistoryPlaybackController::default();
        assert!(controller.take().unwrap().is_none());
        let active = controller
            .begin("session-a", "cue-a", HistoryAudioTrack::Source)
            .unwrap();
        assert!(controller.is_active(active.generation));
        assert!(controller.take().unwrap().is_some());
        assert!(controller.take().unwrap().is_none());
        assert!(!controller.is_active(active.generation));
    }

    #[test]
    fn unavailable_history_never_falls_back_to_plaintext_playback() {
        let directory = tempfile::tempdir().unwrap();
        let store = HistoryStateStore::new();
        *store.inner.lock().unwrap() = Some(super::super::HistoryState {
            database_path: directory.path().join("subtitle-history.db"),
            history_dir: directory.path().to_path_buf(),
            repository: None,
            unavailable_reason: Some("字幕历史密钥缺失".to_string()),
            active_session_id: None,
            archive_policy: super::super::HistoryArchivePolicy::default(),
        });

        let error = store
            .load_cue_audio("session-a", "cue-a", HistoryAudioTrack::Source)
            .expect_err("missing key must fail closed before reading audio");
        assert!(error.contains("字幕历史不可用"));
    }

    #[test]
    fn cue_audio_decodes_cross_segment_refs_in_sequence_and_detects_tamper() {
        let directory = tempfile::tempdir().unwrap();
        let cipher = crate::history::crypto::HistoryCipher::for_test([53; 32]);
        let repository = HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            cipher.clone(),
        )
        .unwrap();
        repository.create_session("session-a", 1_000).unwrap();
        repository
            .upsert_cue(
                CueWrite {
                    session_id: "session-a",
                    cue_id: "cue-a",
                    route_direction: "inbound",
                    source_text: "source",
                    translated_text: "translated",
                    source_committed: true,
                    translation_committed: true,
                    started_at_ms: 1_000,
                    ended_at_ms: 2_000,
                },
                2_000,
            )
            .unwrap();
        let first_samples = vec![10, 11, 12, 13];
        let second_samples = vec![20, 21, 22, 23];
        let first = crate::history::audio::archive_flac_segment(
            directory.path(),
            &cipher,
            "session-a",
            AudioTrack::Translated,
            1,
            16_000,
            &first_samples,
        )
        .unwrap();
        let second = crate::history::audio::archive_flac_segment(
            directory.path(),
            &cipher,
            "session-a",
            AudioTrack::Translated,
            2,
            16_000,
            &second_samples,
        )
        .unwrap();
        let cue_refs = [AudioCueRefWrite {
            cue_id: "cue-a",
            offset_samples: 1,
            length_samples: 2,
        }];
        for (sequence, archived) in [(1, &first), (2, &second)] {
            repository
                .insert_audio_segment(AudioSegmentWrite {
                    session_id: "session-a",
                    cue_refs: &cue_refs,
                    track: "translated",
                    sequence,
                    started_at_ms: 1_000,
                    duration_ms: archived.duration_ms,
                    sample_rate_hz: 16_000,
                    encrypted_path: &archived.path,
                    encrypted_bytes: archived.encrypted_bytes as i64,
                })
                .unwrap();
        }

        let pieces = load_cue_audio_from_repository(
            &repository,
            directory.path(),
            "session-a",
            "cue-a",
            HistoryAudioTrack::Translated,
        )
        .unwrap();
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces[0].samples, vec![11, 12]);
        assert_eq!(pieces[1].samples, vec![21, 22]);

        let mut tampered = std::fs::read(&second.path).unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x20;
        std::fs::write(&second.path, tampered).unwrap();
        assert!(load_cue_audio_from_repository(
            &repository,
            directory.path(),
            "session-a",
            "cue-a",
            HistoryAudioTrack::Translated,
        )
        .is_err());
    }
}
