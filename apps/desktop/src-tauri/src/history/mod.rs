mod audio;
mod crypto;
mod cue_ingress;
mod fs_safety;
mod playback;
mod repository;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use serde_json::Value;

use crate::audio::contracts::{AudioRuntimeSnapshot, SubtitleCueRuntime};

pub(crate) use repository::{
    HistoryCuePage, HistorySessionDetail, HistorySessionPage, HistoryStatistics,
};
pub(crate) use playback::{
    HistoryAudioTrack, HistoryChangedEventV2, HistoryPlaybackEventV2,
    HistoryPlaybackStartV2, HistoryPlaybackStopV2,
};
pub(crate) use playback::emit_changed;
use audio::AudioTrack;
use cue_ingress::{
    drain_cue_overflow, drain_latest_cues, insert_latest_cue, parse_ms_marker, QueuedCue,
};
use repository::{AudioCueRefWrite, AudioSegmentWrite, CueWrite, HistoryRepository};

struct HistoryState {
    database_path: PathBuf,
    history_dir: PathBuf,
    repository: Option<Arc<HistoryRepository>>,
    unavailable_reason: Option<String>,
    active_session_id: Option<String>,
    archive_policy: HistoryArchivePolicy,
}

#[derive(Clone, Copy)]
struct HistoryArchivePolicy {
    enabled: bool,
    source_audio_enabled: bool,
    translated_audio_enabled: bool,
}

impl Default for HistoryArchivePolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            source_audio_enabled: true,
            translated_audio_enabled: true,
        }
    }
}

impl HistoryArchivePolicy {
    fn from_config(config: &Value) -> Self {
        Self {
            enabled: config
                .pointer("/subtitles/history/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            source_audio_enabled: config
                .pointer("/subtitles/history/sourceAudioEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            translated_audio_enabled: config
                .pointer("/subtitles/history/translatedAudioEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }
    }
}

#[derive(Clone)]
pub(crate) struct HistoryStateStore {
    inner: Arc<Mutex<Option<HistoryState>>>,
    cue_tx: SyncSender<QueuedCue>,
    cue_overflow: Arc<Mutex<HashMap<(String, String), QueuedCue>>>,
    audio_tx: SyncSender<QueuedAudio>,
    queued_audio_ms: Arc<AtomicU64>,
    audio_gap_sessions: Arc<Mutex<HashSet<String>>>,
    control_tx: mpsc::Sender<ArchiveControl>,
    playback: playback::HistoryPlaybackController,
    changed_emitter: Arc<Mutex<Option<HistoryChangedEmitter>>>,
}

type HistoryChangedEmitter = Arc<dyn Fn(HistoryChangedEventV2) + Send + Sync>;

const CUE_MUTATION_CAPACITY: usize = 1_024;
const AUDIO_MUTATION_CAPACITY: usize = 512;
const AUDIO_INGRESS_MAX_MS: u64 = 10_000;
const CUE_BATCH_INTERVAL: Duration = Duration::from_millis(100);
const STOP_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

struct QueuedAudio {
    session_id: String,
    cue_id: Option<String>,
    track: AudioTrack,
    sample_rate_hz: u32,
    started_at_ms: i64,
    duration_ms: u64,
    samples: Vec<i16>,
}

#[derive(Clone, Hash, Eq, PartialEq)]
struct AudioAccumulatorKey {
    session_id: String,
    track: AudioTrack,
    sample_rate_hz: u32,
}

struct AudioCueSpan {
    cue_id: String,
    offset_samples: i64,
    length_samples: i64,
}

struct AudioAccumulator {
    started_at_ms: i64,
    samples: Vec<i16>,
    cue_spans: Vec<AudioCueSpan>,
}

enum ArchiveControl {
    Begin { session_id: String, started_at_ms: i64 },
    Finish {
        session_id: String,
        ended_at_ms: i64,
        acknowledged: mpsc::Sender<Result<(), String>>,
    },
    AudioGap { session_id: String },
}

impl HistoryStateStore {
    pub(crate) fn new() -> Self {
        let inner = Arc::new(Mutex::new(None));
        let (cue_tx, cue_rx) = mpsc::sync_channel(CUE_MUTATION_CAPACITY);
        let cue_overflow = Arc::new(Mutex::new(HashMap::new()));
        let (audio_tx, audio_rx) = mpsc::sync_channel(AUDIO_MUTATION_CAPACITY);
        let queued_audio_ms = Arc::new(AtomicU64::new(0));
        let audio_gap_sessions = Arc::new(Mutex::new(HashSet::new()));
        let (control_tx, control_rx) = mpsc::channel();
        let worker_inner = inner.clone();
        let worker_queued_audio_ms = queued_audio_ms.clone();
        let worker_audio_gap_sessions = audio_gap_sessions.clone();
        let worker_cue_overflow = cue_overflow.clone();
        std::thread::Builder::new()
            .name("subtitle-history-archive".to_string())
            .spawn(move || {
                archive_worker(
                    worker_inner,
                    cue_rx,
                    worker_cue_overflow,
                    audio_rx,
                    control_rx,
                    worker_queued_audio_ms,
                    worker_audio_gap_sessions,
                )
            })
            .expect("spawn subtitle history archive worker");
        Self {
            inner,
            cue_tx,
            cue_overflow,
            audio_tx,
            queued_audio_ms,
            audio_gap_sessions,
            control_tx,
            playback: playback::HistoryPlaybackController::default(),
            changed_emitter: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn ensure_initialized<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Result<String, String> {
        if let Ok(mut emitter) = self.changed_emitter.lock() {
            let event_app = app.clone();
            *emitter = Some(Arc::new(move |event| {
                let _ = event_app.emit(playback::HISTORY_CHANGED_EVENT, event);
            }));
        }
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        if let Some(state) = inner.as_ref() {
            return Ok(state.database_path.to_string_lossy().to_string());
        }
        let history_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("history");
        let database_path = history_dir.join("subtitle-history.db");
        let database_probe = HistoryRepository::contains_encrypted_payload(&database_path);
        let audio_probe = contains_encrypted_audio(&history_dir);
        let preflight_error = database_probe
            .as_ref()
            .err()
            .or_else(|| audio_probe.as_ref().err())
            .cloned();
        let existing_archive = database_probe.unwrap_or(true) || audio_probe.unwrap_or(true);
        let repository = match preflight_error {
            Some(error) => Err(error),
            None => crypto::HistoryCipher::from_system_credentials(existing_archive)
                .and_then(|cipher| HistoryRepository::initialize(database_path.clone(), cipher))
                .and_then(|repository| {
                    repository.run_retention(&history_dir, unix_ms())?;
                    Ok(repository)
                }),
        };
        let (repository, unavailable_reason) = match repository {
            Ok(repository) => (Some(Arc::new(repository)), None),
            Err(error) => (None, Some(error)),
        };
        let path = database_path.to_string_lossy().to_string();
        *inner = Some(HistoryState {
            database_path,
            history_dir,
            repository,
            unavailable_reason,
            active_session_id: None,
            archive_policy: HistoryArchivePolicy::default(),
        });
        Ok(path)
    }

    pub(crate) fn unavailable_reason(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|state| state.as_ref().and_then(|state| state.unavailable_reason.clone()))
    }

    pub(crate) fn archive_cue(&self, cue: &SubtitleCueRuntime) {
        if let Err(error) = self.queue_cue(cue) {
            log::warn!("[omni][history] subtitle cue archive skipped: {error}");
        }
    }

    pub(crate) fn archive_source_pcm(&self, samples: &[i16], sample_rate_hz: u32) {
        self.queue_audio(None, AudioTrack::Source, samples, sample_rate_hz);
    }

    pub(crate) fn archive_translated_pcm(
        &self,
        cue_id: &str,
        samples: &[i16],
        sample_rate_hz: u32,
    ) {
        self.queue_audio(
            Some(cue_id.to_string()),
            AudioTrack::Translated,
            samples,
            sample_rate_hz,
        );
    }

    fn queue_audio(
        &self,
        cue_id: Option<String>,
        track: AudioTrack,
        samples: &[i16],
        sample_rate_hz: u32,
    ) {
        if samples.is_empty() || sample_rate_hz == 0 {
            return;
        }
        let session_id = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return,
            };
            let Ok(state) = available_state_mut(&mut inner) else {
                return;
            };
            let Some(session_id) = state.active_session_id.clone() else {
                return;
            };
            let track_enabled = match track {
                AudioTrack::Source => state.archive_policy.source_audio_enabled,
                AudioTrack::Translated => state.archive_policy.translated_audio_enabled,
            };
            if !state.archive_policy.enabled || !track_enabled {
                return;
            }
            session_id
        };
        let duration_ms = (samples.len() as u64)
            .saturating_mul(1_000)
            .div_ceil(u64::from(sample_rate_hz));
        if self
            .queued_audio_ms
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                queued
                    .checked_add(duration_ms)
                    .filter(|next| *next <= AUDIO_INGRESS_MAX_MS)
            })
            .is_err()
        {
            self.report_audio_gap(session_id);
            return;
        }
        let queued = QueuedAudio {
            session_id: session_id.clone(),
            cue_id,
            track,
            sample_rate_hz,
            started_at_ms: unix_ms().saturating_sub(duration_ms as i64),
            duration_ms,
            samples: samples.to_vec(),
        };
        if self.audio_tx.try_send(queued).is_err() {
            self.queued_audio_ms.fetch_sub(duration_ms, Ordering::AcqRel);
            self.report_audio_gap(session_id);
        }
    }

    fn report_audio_gap(&self, session_id: String) {
        let should_report = self
            .audio_gap_sessions
            .lock()
            .map(|mut sessions| sessions.insert(session_id.clone()))
            .unwrap_or(false);
        if should_report
            && self
                .control_tx
                .send(ArchiveControl::AudioGap {
                    session_id: session_id.clone(),
                })
                .is_err()
        {
            if let Ok(mut sessions) = self.audio_gap_sessions.lock() {
                sessions.remove(&session_id);
            }
        } else if should_report {
            if let Ok(emitter) = self.changed_emitter.lock() {
                if let Some(emitter) = emitter.as_ref() {
                    emitter(playback::changed_event("archiveGap", Some(session_id)));
                }
            }
        }
    }

    fn queue_cue(&self, cue: &SubtitleCueRuntime) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = available_state_mut(&mut inner)?;
        if !state.archive_policy.enabled {
            return Ok(String::new());
        }
        let now = unix_ms();
        let session_id = match state.active_session_id.clone() {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                state.active_session_id = Some(id.clone());
                self.control_tx
                    .send(ArchiveControl::Begin {
                        session_id: id.clone(),
                        started_at_ms: parse_ms_marker(&cue.started_at).unwrap_or(now),
                    })
                    .map_err(|_| "字幕历史写入 worker 已停止".to_string())?;
                id
            }
        };
        drop(inner);
        let queued = QueuedCue {
            session_id: session_id.clone(),
            cue: cue.clone(),
            updated_at_ms: now,
        };
        match self.cue_tx.try_send(queued) {
            Ok(()) => {}
            Err(TrySendError::Full(queued)) => {
                let mut overflow = self
                    .cue_overflow
                    .lock()
                    .map_err(|_| "字幕历史 overflow 队列已损坏".to_string())?;
                insert_latest_cue(&mut overflow, queued);
            }
            Err(TrySendError::Disconnected(_)) => {
                return Err("字幕历史写入 worker 已停止".to_string());
            }
        }
        Ok(session_id)
    }

    fn begin_session(&self, archive_policy: HistoryArchivePolicy) -> Result<Option<String>, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = available_state_mut(&mut inner)?;
        if let Some(session_id) = state.active_session_id.clone() {
            return Ok(Some(session_id));
        }
        state.archive_policy = archive_policy;
        if !archive_policy.enabled {
            return Ok(None);
        }
        let session_id = uuid::Uuid::now_v7().to_string();
        let started_at_ms = unix_ms();
        state.active_session_id = Some(session_id.clone());
        self.control_tx
            .send(ArchiveControl::Begin { session_id: session_id.clone(), started_at_ms })
            .map_err(|_| "字幕历史写入 worker 已停止".to_string())?;
        Ok(Some(session_id))
    }

    pub(crate) fn finish_active_session(&self) -> Result<Option<String>, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = available_state_mut(&mut inner)?;
        let Some(session_id) = state.active_session_id.take() else { return Ok(None); };
        drop(inner);
        let (acknowledged, receiver) = mpsc::channel();
        self.control_tx
            .send(ArchiveControl::Finish {
                session_id: session_id.clone(),
                ended_at_ms: unix_ms(),
                acknowledged,
            })
            .map_err(|_| "字幕历史写入 worker 已停止".to_string())?;
        receiver
            .recv_timeout(STOP_FLUSH_TIMEOUT)
            .map_err(|_| "字幕历史停止 flush 超过 2 秒".to_string())??;
        Ok(Some(session_id))
    }

    pub(crate) fn list_sessions(&self, cursor: Option<&str>, limit: u32) -> Result<HistorySessionPage, String> {
        self.with_repository(|repository| repository.list_sessions(cursor, limit))
    }

    pub(crate) fn get_session(&self, session_id: &str) -> Result<Option<HistorySessionDetail>, String> {
        self.with_repository(|repository| repository.get_session(session_id))
    }

    pub(crate) fn list_cues(
        &self,
        session_id: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<HistoryCuePage, String> {
        self.with_repository(|repository| repository.list_cues(session_id, cursor, limit))
    }

    pub(crate) fn statistics(&self) -> Result<HistoryStatistics, String> {
        self.with_repository(HistoryRepository::statistics)
    }

    pub(crate) fn delete_session(&self, session_id: &str) -> Result<bool, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = available_state_mut(&mut inner)?;
        let repository = repository(state)?;
        drop(inner);
        repository.delete_session(session_id)
    }

    pub(crate) fn clear<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Result<i64, String> {
        let snapshot = app.state::<crate::audio::state::AudioStateStore>().snapshot();
        if snapshot.inbound.stream_bound || snapshot.outbound.stream_bound {
            return Err("实时翻译 route 活跃时不能清空历史".to_string());
        }
        if self.playback.has_active() {
            return Err("历史音频播放活跃时不能清空历史".to_string());
        }
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = inner
            .as_mut()
            .ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        if state.active_session_id.is_some() {
            return Err("历史 session 活跃时不能清空历史".to_string());
        }
        if state.unavailable_reason.is_some() {
            return self.recover_unavailable_locked(state);
        }
        let repository = repository(state)?;
        drop(inner);
        repository.clear()
    }

    fn recover_unavailable_locked(&self, state: &mut HistoryState) -> Result<i64, String> {
        let deleted_count = HistoryRepository::ended_session_count_at(&state.database_path)
            .unwrap_or(0);
        fs_safety::clear_history_contents(&state.history_dir)?;
        let cipher = crypto::HistoryCipher::from_system_credentials(false)
            .or_else(|_| crypto::HistoryCipher::reinitialize_system_credentials())?;
        let repository = HistoryRepository::initialize(state.database_path.clone(), cipher)?;
        state.repository = Some(Arc::new(repository));
        state.unavailable_reason = None;
        state.archive_policy = HistoryArchivePolicy::default();
        Ok(deleted_count)
    }

    #[cfg(test)]
    fn recover_unavailable_with_cipher_for_test(
        &self,
        cipher: crypto::HistoryCipher,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = inner
            .as_mut()
            .ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        fs_safety::clear_history_contents(&state.history_dir)?;
        let repository = HistoryRepository::initialize(state.database_path.clone(), cipher)?;
        state.repository = Some(Arc::new(repository));
        state.unavailable_reason = None;
        Ok(())
    }

    fn with_repository<T>(&self, operation: impl FnOnce(&HistoryRepository) -> Result<T, String>) -> Result<T, String> {
        let repository = {
            let inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
            let state = inner.as_ref().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
            repository(state)?
        };
        operation(&repository)
    }
}

pub(crate) fn initialize<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let history = app.state::<HistoryStateStore>();
    let history_path = history.ensure_initialized(app)?;
    if let Some(reason) = history.unavailable_reason() {
        crate::log_warn!(
            app,
            "runtime",
            "加密字幕历史不可用，实时翻译继续运行",
            format!("db={history_path} reason={reason}")
        );
    } else {
        crate::log_info!(
            app,
            "runtime",
            "加密字幕历史初始化完成",
            format!("db={history_path}")
        );
    }
    Ok(())
}

pub(crate) fn begin_route_session<R: tauri::Runtime>(app: &AppHandle<R>, config: &Value) {
    let history = app.state::<HistoryStateStore>();
    if let Err(error) = history.stop_playback(app, "routeStarted") {
        log::warn!("[omni][history] history playback could not stop before route start: {error}");
    }
    let archive_policy = HistoryArchivePolicy::from_config(config);
    match history.begin_session(archive_policy) {
        Ok(Some(session_id)) => playback::emit_changed(app, "sessionStarted", Some(session_id)),
        Ok(None) => {}
        Err(error) => log::warn!("[omni][history] session archive could not start: {error}"),
    }
}

pub(crate) fn finalize_session_if_routes_idle<R: tauri::Runtime>(
    app: &AppHandle<R>,
    snapshot: &AudioRuntimeSnapshot,
) {
    if snapshot.inbound.stream_bound || snapshot.outbound.stream_bound {
        return;
    }
    match app.state::<HistoryStateStore>().finish_active_session() {
        Ok(Some(session_id)) => playback::emit_changed(app, "sessionFinalized", Some(session_id)),
        Ok(None) => {}
        Err(error) => log::warn!("[omni][history] session archive could not finalize: {error}"),
    }
}

fn available_state_mut<'a>(state: &'a mut Option<HistoryState>) -> Result<&'a mut HistoryState, String> {
    let state = state.as_mut().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
    if let Some(reason) = state.unavailable_reason.as_ref() {
        return Err(format!("字幕历史不可用：{reason}"));
    }
    Ok(state)
}

fn repository(state: &HistoryState) -> Result<Arc<HistoryRepository>, String> {
    state.repository.clone().ok_or_else(|| {
        format!(
            "字幕历史不可用：{}",
            state.unavailable_reason.as_deref().unwrap_or("archive repository unavailable")
        )
    })
}

fn contains_encrypted_audio(history_dir: &Path) -> Result<bool, String> {
    Ok(fs_safety::walk_regular_archive_files(history_dir)?
        .iter()
        .any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".flac.enc"))
        }))
}

fn archive_worker(
    state: Arc<Mutex<Option<HistoryState>>>,
    cue_rx: Receiver<QueuedCue>,
    cue_overflow: Arc<Mutex<HashMap<(String, String), QueuedCue>>>,
    audio_rx: Receiver<QueuedAudio>,
    control_rx: Receiver<ArchiveControl>,
    queued_audio_ms: Arc<AtomicU64>,
    audio_gap_sessions: Arc<Mutex<HashSet<String>>>,
) {
    let mut pending = HashMap::<(String, String), QueuedCue>::new();
    let mut audio = HashMap::<AudioAccumulatorKey, AudioAccumulator>::new();
    let mut next_flush = Instant::now() + CUE_BATCH_INTERVAL;
    loop {
        while let Ok(control) = control_rx.try_recv() {
            match control {
                ArchiveControl::Begin { session_id, started_at_ms } => {
                    if let Ok(mut sessions) = audio_gap_sessions.lock() {
                        sessions.remove(&session_id);
                    }
                    with_worker_repository(&state, |repository| {
                        repository.create_session(&session_id, started_at_ms)
                    });
                }
                ArchiveControl::Finish { session_id, ended_at_ms, acknowledged } => {
                    drain_latest_cues(&cue_rx, &cue_overflow, &mut pending);
                    let result = flush_finished_session_payload(
                        &state,
                        &mut pending,
                        &audio_rx,
                        &mut audio,
                        &queued_audio_ms,
                        &session_id,
                    )
                        .and_then(|()| {
                            worker_repository_result(&state, |repository| {
                                repository.end_session(&session_id, ended_at_ms)
                            })
                        })
                        .and_then(|()| run_worker_retention(&state));
                    if let Ok(mut sessions) = audio_gap_sessions.lock() {
                        sessions.remove(&session_id);
                    }
                    let _ = acknowledged.send(result);
                }
                ArchiveControl::AudioGap { session_id } => {
                    with_worker_repository(&state, |repository| {
                        repository.mark_archive_gap(&session_id)
                    });
                }
            }
        }

        let now = Instant::now();
        if now >= next_flush {
            drain_latest_cues(&cue_rx, &cue_overflow, &mut pending);
            let _ = flush_pending_cues(&state, &mut pending);
            drain_audio(&audio_rx, &mut audio, &state, &queued_audio_ms);
            next_flush = now + CUE_BATCH_INTERVAL;
        }
        let wait = next_flush
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(20));
        match cue_rx.recv_timeout(wait) {
            Ok(cue) => {
                insert_latest_cue(&mut pending, cue);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                drain_cue_overflow(&cue_overflow, &mut pending);
                if flush_pending_cues(&state, &mut pending).is_ok() {
                    drain_audio(&audio_rx, &mut audio, &state, &queued_audio_ms);
                    let sessions = audio
                        .keys()
                        .map(|key| key.session_id.clone())
                        .collect::<HashSet<_>>();
                    for session_id in sessions {
                        let _ = flush_session_audio(&state, &mut audio, &session_id);
                    }
                }
                return;
            }
        }
    }
}

fn flush_finished_session_payload(
    state: &Arc<Mutex<Option<HistoryState>>>,
    pending: &mut HashMap<(String, String), QueuedCue>,
    audio_rx: &Receiver<QueuedAudio>,
    audio: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    queued_audio_ms: &AtomicU64,
    session_id: &str,
) -> Result<(), String> {
    flush_pending_cues(state, pending)?;
    drain_audio(audio_rx, audio, state, queued_audio_ms);
    flush_session_audio(state, audio, session_id)
}

fn drain_audio(
    receiver: &Receiver<QueuedAudio>,
    accumulators: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    state: &Arc<Mutex<Option<HistoryState>>>,
    queued_audio_ms: &AtomicU64,
) {
    while let Ok(audio) = receiver.try_recv() {
        queued_audio_ms.fetch_sub(audio.duration_ms, Ordering::AcqRel);
        if let Err(error) = append_audio(accumulators, state, audio) {
            log::warn!("[omni][history] audio archive mutation failed: {error}");
        }
    }
}

fn append_audio(
    accumulators: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    state: &Arc<Mutex<Option<HistoryState>>>,
    audio: QueuedAudio,
) -> Result<(), String> {
    let key = AudioAccumulatorKey {
        session_id: audio.session_id,
        track: audio.track,
        sample_rate_hz: audio.sample_rate_hz,
    };
    let max_samples = audio.sample_rate_hz as usize * 30;
    let mut consumed = 0usize;
    while consumed < audio.samples.len() {
        let accumulator = accumulators.entry(key.clone()).or_insert_with(|| AudioAccumulator {
            started_at_ms: audio.started_at_ms.saturating_add(
                (consumed as i64).saturating_mul(1_000) / i64::from(audio.sample_rate_hz),
            ),
            samples: Vec::with_capacity(max_samples),
            cue_spans: Vec::new(),
        });
        let take = (max_samples - accumulator.samples.len()).min(audio.samples.len() - consumed);
        if let Some(cue_id) = audio.cue_id.as_deref() {
            let offset_samples = accumulator.samples.len() as i64;
            let length_samples = take as i64;
            if let Some(span) = accumulator.cue_spans.last_mut().filter(|span| {
                span.cue_id == cue_id
                    && span.offset_samples.saturating_add(span.length_samples) == offset_samples
            }) {
                span.length_samples = span.length_samples.saturating_add(length_samples);
            } else {
                accumulator.cue_spans.push(AudioCueSpan {
                    cue_id: cue_id.to_string(),
                    offset_samples,
                    length_samples,
                });
            }
        }
        accumulator.samples.extend_from_slice(&audio.samples[consumed..consumed + take]);
        consumed += take;
        if accumulator.samples.len() == max_samples {
            flush_audio_key(state, accumulators, &key)?;
        }
    }
    Ok(())
}

fn flush_session_audio(
    state: &Arc<Mutex<Option<HistoryState>>>,
    accumulators: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    session_id: &str,
) -> Result<(), String> {
    let keys = accumulators
        .keys()
        .filter(|key| key.session_id == session_id)
        .cloned()
        .collect::<Vec<_>>();
    for key in keys {
        flush_audio_key(state, accumulators, &key)?;
    }
    Ok(())
}

fn flush_audio_key(
    state: &Arc<Mutex<Option<HistoryState>>>,
    accumulators: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    key: &AudioAccumulatorKey,
) -> Result<(), String> {
    let Some(accumulator) = accumulators.remove(key) else {
        return Ok(());
    };
    if accumulator.samples.is_empty() {
        return Ok(());
    }
    let (repository, history_dir) = worker_archive_context(state)?;
    if !repository.audio_archive_allowed()? {
        repository.mark_archive_gap(&key.session_id)?;
        return Ok(());
    }
    let sequence = repository.next_audio_sequence(&key.session_id, key.track.as_str())?;
    let archived = match audio::archive_flac_segment(
        &history_dir,
        &repository.cipher(),
        &key.session_id,
        key.track,
        sequence,
        key.sample_rate_hz,
        &accumulator.samples,
    ) {
        Ok(archived) => archived,
        Err(error) => {
            let _ = repository.mark_archive_gap(&key.session_id);
            return Err(error);
        }
    };
    let cue_refs = accumulator
        .cue_spans
        .iter()
        .map(|span| AudioCueRefWrite {
            cue_id: &span.cue_id,
            offset_samples: span.offset_samples,
            length_samples: span.length_samples,
        })
        .collect::<Vec<_>>();
    let insert_result = repository.insert_audio_segment(AudioSegmentWrite {
        session_id: &key.session_id,
        cue_refs: &cue_refs,
        track: key.track.as_str(),
        sequence,
        started_at_ms: accumulator.started_at_ms,
        duration_ms: archived.duration_ms,
        sample_rate_hz: key.sample_rate_hz,
        encrypted_path: &archived.path,
        encrypted_bytes: i64::try_from(archived.encrypted_bytes).unwrap_or(i64::MAX),
    });
    if let Err(error) = insert_result {
        let _ = std::fs::remove_file(&archived.path);
        let _ = repository.mark_archive_gap(&key.session_id);
        return Err(error);
    }
    repository.run_retention(&history_dir, unix_ms())?;
    Ok(())
}

fn run_worker_retention(state: &Arc<Mutex<Option<HistoryState>>>) -> Result<(), String> {
    let (repository, history_dir) = worker_archive_context(state)?;
    repository.run_retention(&history_dir, unix_ms()).map(|_| ())
}

fn worker_archive_context(
    state: &Arc<Mutex<Option<HistoryState>>>,
) -> Result<(Arc<HistoryRepository>, PathBuf), String> {
    let state = state.lock().map_err(|_| "history state poisoned".to_string())?;
    let state = state.as_ref().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
    Ok((repository(state)?, state.history_dir.clone()))
}

fn flush_pending_cues(
    state: &Arc<Mutex<Option<HistoryState>>>,
    pending: &mut HashMap<(String, String), QueuedCue>,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    let mut batch = pending.values().cloned().collect::<Vec<_>>();
    batch.sort_by_key(|cue| cue.updated_at_ms);
    worker_repository_result(state, |repository| {
        let writes = batch
            .iter()
            .map(|queued| CueWrite {
                session_id: &queued.session_id,
                cue_id: &queued.cue.cue_id,
                sequence: queued
                    .cue
                    .sequence
                    .map(|value| i64::try_from(value).unwrap_or(i64::MAX))
                    .unwrap_or(0),
                revision: queued
                    .cue
                    .revision
                    .map(|value| i64::try_from(value).unwrap_or(i64::MAX))
                    .unwrap_or(0),
                route_direction: &queued.cue.route_direction,
                source_text: &queued.cue.source_text,
                translated_text: &queued.cue.translated_text,
                source_committed: queued.cue.committed,
                translation_committed: queued.cue.translation_committed,
                started_at_ms: parse_ms_marker(&queued.cue.started_at).unwrap_or(queued.updated_at_ms),
                ended_at_ms: parse_ms_marker(&queued.cue.ended_at).unwrap_or(queued.updated_at_ms),
            })
            .collect::<Vec<_>>();
        repository.upsert_cues_batch(&writes, unix_ms())?;
        pending.clear();
        Ok(())
    })
}

fn worker_repository_result<T>(
    state: &Arc<Mutex<Option<HistoryState>>>,
    operation: impl FnOnce(&HistoryRepository) -> Result<T, String>,
) -> Result<T, String> {
    let repository = {
        let state = state.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = state.as_ref().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        repository(state)?
    };
    operation(&repository)
}

fn with_worker_repository(
    state: &Arc<Mutex<Option<HistoryState>>>,
    operation: impl FnOnce(&HistoryRepository) -> Result<(), String>,
) {
    if let Err(error) = worker_repository_result(state, operation) {
        log::warn!("[omni][history] archive worker mutation failed: {error}");
    }
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(cue_id: &str) -> SubtitleCueRuntime {
        SubtitleCueRuntime {
            cue_id: cue_id.to_string(),
            revision: Some(1),
            sequence: Some(1),
            route_direction: "inbound".to_string(),
            source_text: "source".to_string(),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: "translated".to_string(),
            started_at: "unix-ms:1000".to_string(),
            ended_at: "unix-ms:2000".to_string(),
            committed: true,
            translation_committed: true,
            translation_state: Some(
                crate::audio::contracts::SubtitleTranslationStateRuntime::Final,
            ),
        }
    }

    fn install_test_state(
        store: &HistoryStateStore,
        directory: &Path,
        repository: Option<Arc<HistoryRepository>>,
        unavailable_reason: Option<String>,
    ) {
        *store.inner.lock().unwrap() = Some(HistoryState {
            database_path: directory.join("subtitle-history.db"),
            history_dir: directory.to_path_buf(),
            repository,
            unavailable_reason,
            active_session_id: None,
            archive_policy: HistoryArchivePolicy::default(),
        });
    }

    #[test]
    fn finish_drain_keeps_only_the_latest_revision_for_each_cue() {
        let mut pending = HashMap::new();
        let mut cue_one_first = cue("cue-1");
        cue_one_first.sequence = Some(1);
        let mut cue_two = cue("cue-2");
        cue_two.sequence = Some(2);
        let mut cue_one_final = cue("cue-1");
        cue_one_final.sequence = Some(3);
        cue_one_final.translated_text = "latest".to_string();
        for (updated_at_ms, cue) in [
            (1, cue_one_first),
            (2, cue_two),
            (3, cue_one_final),
        ] {
            insert_latest_cue(
                &mut pending,
                QueuedCue {
                    session_id: "session".to_string(),
                    cue,
                    updated_at_ms,
                },
            );
        }

        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending[&("session".to_string(), "cue-1".to_string())]
                .cue
                .translated_text,
            "latest"
        );
        assert_eq!(
            pending[&("session".to_string(), "cue-2".to_string())]
                .cue
                .sequence,
            Some(2)
        );
    }

    #[test]
    fn finish_flush_persists_cue_before_exact_thirty_second_audio_segment() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("subtitle-history.db");
        let repository = Arc::new(
            HistoryRepository::initialize(
                database_path.clone(),
                crypto::HistoryCipher::for_test([39; 32]),
            )
            .unwrap(),
        );
        repository.create_session("session-boundary", 1_000).unwrap();
        let state = Arc::new(Mutex::new(Some(HistoryState {
            database_path,
            history_dir: directory.path().to_path_buf(),
            repository: Some(repository.clone()),
            unavailable_reason: None,
            active_session_id: Some("session-boundary".to_string()),
            archive_policy: HistoryArchivePolicy::default(),
        })));
        let mut pending = HashMap::new();
        let mut boundary_cue = cue("cue-boundary");
        boundary_cue.sequence = Some(17);
        boundary_cue.revision = Some(4);
        boundary_cue.ended_at = "unix-ms:31000".to_string();
        insert_latest_cue(
            &mut pending,
            QueuedCue {
                session_id: "session-boundary".to_string(),
                cue: boundary_cue,
                updated_at_ms: 31_000,
            },
        );
        let samples = (0..3_000)
            .map(|index| ((index % 101) as i16) - 50)
            .collect::<Vec<_>>();
        let (audio_tx, audio_rx) = mpsc::sync_channel(1);
        audio_tx
            .send(QueuedAudio {
                session_id: "session-boundary".to_string(),
                cue_id: Some("cue-boundary".to_string()),
                track: AudioTrack::Translated,
                sample_rate_hz: 100,
                started_at_ms: 1_000,
                duration_ms: 30_000,
                samples: samples.clone(),
            })
            .unwrap();
        let queued_audio_ms = AtomicU64::new(30_000);
        let mut audio = HashMap::new();

        flush_finished_session_payload(
            &state,
            &mut pending,
            &audio_rx,
            &mut audio,
            &queued_audio_ms,
            "session-boundary",
        )
        .unwrap();

        assert!(pending.is_empty());
        assert!(audio.is_empty());
        assert_eq!(queued_audio_ms.load(Ordering::Acquire), 0);
        let pieces = playback::load_cue_audio_from_repository(
            &repository,
            directory.path(),
            "session-boundary",
            "cue-boundary",
            HistoryAudioTrack::Translated,
        )
        .unwrap();
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].sample_rate_hz, 100);
        assert_eq!(pieces[0].samples, samples);
    }

    #[test]
    fn disabled_route_config_never_creates_a_session_or_queues_content() {
        let directory = tempfile::tempdir().unwrap();
        let repository = Arc::new(
            HistoryRepository::initialize(
                directory.path().join("subtitle-history.db"),
                crypto::HistoryCipher::for_test([41; 32]),
            )
            .unwrap(),
        );
        let store = HistoryStateStore::new();
        install_test_state(&store, directory.path(), Some(repository.clone()), None);
        let policy = HistoryArchivePolicy::from_config(&serde_json::json!({
            "subtitles": { "history": { "enabled": false } }
        }));

        assert!(store.begin_session(policy).unwrap().is_none());
        assert!(store.queue_cue(&cue("cue-disabled")).unwrap().is_empty());
        store.archive_source_pcm(&[1; 160], 16_000);
        store.archive_translated_pcm("cue-disabled", &[2; 160], 16_000);

        let stats = repository.statistics().unwrap();
        assert_eq!(stats.session_count, 0);
        assert_eq!(stats.cue_count, 0);
        assert_eq!(stats.audio_bytes, 0);
        assert_eq!(store.queued_audio_ms.load(Ordering::Acquire), 0);
    }

    #[test]
    fn unavailable_archive_can_only_recover_by_clearing_then_writes_encrypted_cues() {
        let directory = tempfile::tempdir().unwrap();
        let old_repository = HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            crypto::HistoryCipher::for_test([43; 32]),
        )
        .unwrap();
        old_repository.create_session("old-session", 1_000).unwrap();
        old_repository
            .upsert_cue(
                CueWrite {
                    session_id: "old-session",
                    cue_id: "old-cue",
                    sequence: 1,
                    revision: 1,
                    route_direction: "inbound",
                    source_text: "known secret source",
                    translated_text: "known secret translated",
                    source_committed: true,
                    translation_committed: true,
                    started_at_ms: 1_000,
                    ended_at_ms: 2_000,
                },
                2_000,
            )
            .unwrap();
        drop(old_repository);
        let store = HistoryStateStore::new();
        install_test_state(
            &store,
            directory.path(),
            None,
            Some("字幕历史密钥缺失".to_string()),
        );
        assert!(store.list_sessions(None, 25).is_err());
        assert!(store.queue_cue(&cue("blocked-cue")).is_err());

        store
            .recover_unavailable_with_cipher_for_test(crypto::HistoryCipher::for_test([47; 32]))
            .unwrap();
        let repository = store
            .with_repository(|repository| Ok(repository.cipher()))
            .unwrap();
        let encrypted = repository.encrypt(b"new secret", b"recovered").unwrap();
        assert!(!encrypted.windows(10).any(|part| part == b"new secret"));
        assert!(store
            .begin_session(HistoryArchivePolicy::default())
            .unwrap()
            .is_some());
        assert!(!store.queue_cue(&cue("new-cue")).unwrap().is_empty());
    }

    #[test]
    fn translated_track_splits_at_thirty_seconds_and_links_cue_across_segments() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("subtitle-history.db");
        let repository = Arc::new(
            HistoryRepository::initialize(
                database_path.clone(),
                crypto::HistoryCipher::for_test([37; 32]),
            )
            .unwrap(),
        );
        repository.create_session("session-30s", 1_000).unwrap();
        repository
            .upsert_cue(
                CueWrite {
                    session_id: "session-30s",
                    cue_id: "cue-long",
                    sequence: 1,
                    revision: 1,
                    route_direction: "inbound",
                    source_text: "source",
                    translated_text: "translated",
                    source_committed: true,
                    translation_committed: true,
                    started_at_ms: 1_000,
                    ended_at_ms: 32_000,
                },
                32_000,
            )
            .unwrap();
        let state = Arc::new(Mutex::new(Some(HistoryState {
            database_path,
            history_dir: directory.path().to_path_buf(),
            repository: Some(repository.clone()),
            unavailable_reason: None,
            active_session_id: Some("session-30s".to_string()),
            archive_policy: HistoryArchivePolicy::default(),
        })));
        let mut accumulators = HashMap::new();
        append_audio(
            &mut accumulators,
            &state,
            QueuedAudio {
                session_id: "session-30s".to_string(),
                cue_id: Some("cue-long".to_string()),
                track: AudioTrack::Translated,
                sample_rate_hz: 100,
                started_at_ms: 1_000,
                duration_ms: 31_000,
                samples: vec![42; 3_100],
            },
        )
        .unwrap();
        flush_session_audio(&state, &mut accumulators, "session-30s").unwrap();

        let segments = repository
            .audio_segments_for_test("session-30s", "translated")
            .unwrap();
        assert_eq!(segments.len(), 2);
        let (_, first) = audio::decrypt_flac_segment(
            &repository.cipher(),
            "session-30s",
            AudioTrack::Translated,
            segments[0].0,
            &segments[0].2,
        )
        .unwrap();
        let (_, second) = audio::decrypt_flac_segment(
            &repository.cipher(),
            "session-30s",
            AudioTrack::Translated,
            segments[1].0,
            &segments[1].2,
        )
        .unwrap();
        assert_eq!(first.len(), 3_000);
        assert_eq!(second.len(), 100);
        assert_eq!(
            repository
                .cue_audio_ref_count_for_test("session-30s", "cue-long", "translated")
                .unwrap(),
            2
        );
    }
}
