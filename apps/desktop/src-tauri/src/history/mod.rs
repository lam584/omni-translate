mod audio;
mod crypto;
mod fs_safety;
mod repository;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use serde_json::Value;

use crate::audio::contracts::{AudioRuntimeSnapshot, SubtitleCueRuntime};

pub(crate) use repository::{
    HistoryCuePage, HistorySessionDetail, HistorySessionPage, HistoryStatistics,
};
use audio::AudioTrack;
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
    audio_tx: SyncSender<QueuedAudio>,
    queued_audio_ms: Arc<AtomicU64>,
    audio_gap_sessions: Arc<Mutex<HashSet<String>>>,
    control_tx: mpsc::Sender<ArchiveControl>,
}

const CUE_MUTATION_CAPACITY: usize = 1_024;
const AUDIO_MUTATION_CAPACITY: usize = 512;
const AUDIO_INGRESS_MAX_MS: u64 = 10_000;
const CUE_BATCH_INTERVAL: Duration = Duration::from_millis(100);
const STOP_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct QueuedCue {
    session_id: String,
    cue: SubtitleCueRuntime,
    updated_at_ms: i64,
}

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
        let (audio_tx, audio_rx) = mpsc::sync_channel(AUDIO_MUTATION_CAPACITY);
        let queued_audio_ms = Arc::new(AtomicU64::new(0));
        let audio_gap_sessions = Arc::new(Mutex::new(HashSet::new()));
        let (control_tx, control_rx) = mpsc::channel();
        let worker_inner = inner.clone();
        let worker_queued_audio_ms = queued_audio_ms.clone();
        let worker_audio_gap_sessions = audio_gap_sessions.clone();
        std::thread::Builder::new()
            .name("subtitle-history-archive".to_string())
            .spawn(move || {
                archive_worker(
                    worker_inner,
                    cue_rx,
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
            audio_tx,
            queued_audio_ms,
            audio_gap_sessions,
            control_tx,
        }
    }

    pub(crate) fn ensure_initialized<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Result<String, String> {
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
        self.cue_tx.try_send(queued).map_err(|error| match error {
            TrySendError::Full(_) => "字幕历史写入队列已满，本次 mutation 已跳过".to_string(),
            TrySendError::Disconnected(_) => "字幕历史写入 worker 已停止".to_string(),
        })?;
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

    pub(crate) fn clear(&self) -> Result<i64, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = available_state_mut(&mut inner)?;
        let repository = repository(state)?;
        drop(inner);
        repository.clear()
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

pub(crate) fn begin_route_session<R: tauri::Runtime>(app: &AppHandle<R>) {
    let archive_policy = app
        .state::<crate::storage::StorageStateStore>()
        .load_config()
        .map(|config| HistoryArchivePolicy::from_config(&config))
        .unwrap_or_else(|error| {
            log::warn!("[omni][history] history config unavailable; using secure enabled defaults: {error}");
            HistoryArchivePolicy::default()
        });
    if let Err(error) = app
        .state::<HistoryStateStore>()
        .begin_session(archive_policy)
    {
        log::warn!("[omni][history] session archive could not start: {error}");
    }
}

pub(crate) fn finalize_session_if_routes_idle<R: tauri::Runtime>(
    app: &AppHandle<R>,
    snapshot: &AudioRuntimeSnapshot,
) {
    if snapshot.inbound.stream_bound || snapshot.outbound.stream_bound {
        return;
    }
    if let Err(error) = app.state::<HistoryStateStore>().finish_active_session() {
        log::warn!("[omni][history] session archive could not finalize: {error}");
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
                    drain_latest(&cue_rx, &mut pending, |cue| {
                        (cue.session_id.clone(), cue.cue.cue_id.clone())
                    });
                    drain_audio(&audio_rx, &mut audio, &state, &queued_audio_ms);
                    let result = flush_pending_cues(&state, &mut pending)
                        .and_then(|()| flush_session_audio(&state, &mut audio, &session_id))
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
            drain_latest(&cue_rx, &mut pending, |cue| {
                (cue.session_id.clone(), cue.cue.cue_id.clone())
            });
            let _ = flush_pending_cues(&state, &mut pending);
            drain_audio(&audio_rx, &mut audio, &state, &queued_audio_ms);
            next_flush = now + CUE_BATCH_INTERVAL;
        }
        let wait = next_flush
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(20));
        match cue_rx.recv_timeout(wait) {
            Ok(cue) => {
                pending.insert((cue.session_id.clone(), cue.cue.cue_id.clone()), cue);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                drain_audio(&audio_rx, &mut audio, &state, &queued_audio_ms);
                let _ = flush_pending_cues(&state, &mut pending);
                let sessions = audio
                    .keys()
                    .map(|key| key.session_id.clone())
                    .collect::<HashSet<_>>();
                for session_id in sessions {
                    let _ = flush_session_audio(&state, &mut audio, &session_id);
                }
                return;
            }
        }
    }
}

fn drain_latest<T, K>(
    receiver: &Receiver<T>,
    pending: &mut HashMap<K, T>,
    key: impl Fn(&T) -> K,
) where
    K: std::hash::Hash + Eq,
{
    while let Ok(value) = receiver.try_recv() {
        pending.insert(key(&value), value);
    }
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
    let mut batch = pending.drain().map(|(_, cue)| cue).collect::<Vec<_>>();
    batch.sort_by_key(|cue| cue.updated_at_ms);
    worker_repository_result(state, |repository| {
        let writes = batch
            .iter()
            .map(|queued| CueWrite {
                session_id: &queued.session_id,
                cue_id: &queued.cue.cue_id,
                route_direction: &queued.cue.route_direction,
                source_text: &queued.cue.source_text,
                translated_text: &queued.cue.translated_text,
                source_committed: queued.cue.committed,
                translation_committed: queued.cue.translation_committed,
                started_at_ms: parse_ms_marker(&queued.cue.started_at).unwrap_or(queued.updated_at_ms),
                ended_at_ms: parse_ms_marker(&queued.cue.ended_at).unwrap_or(queued.updated_at_ms),
            })
            .collect::<Vec<_>>();
        repository.upsert_cues_batch(&writes, unix_ms())
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

fn parse_ms_marker(value: &str) -> Option<i64> {
    value.strip_prefix("unix-ms:").unwrap_or(value).parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finish_drain_keeps_only_the_latest_revision_for_each_cue() {
        let (sender, receiver) = mpsc::sync_channel(8);
        sender.send(("cue-1", 1)).unwrap();
        sender.send(("cue-2", 1)).unwrap();
        sender.send(("cue-1", 2)).unwrap();
        let mut pending = HashMap::new();

        drain_latest(&receiver, &mut pending, |mutation| mutation.0);

        assert_eq!(pending.len(), 2);
        assert_eq!(pending["cue-1"].1, 2);
        assert_eq!(pending["cue-2"].1, 1);
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
