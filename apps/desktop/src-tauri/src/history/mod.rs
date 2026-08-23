mod crypto;
mod repository;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::audio::contracts::{AudioRuntimeSnapshot, SubtitleCueRuntime};

pub(crate) use repository::{
    HistoryCuePage, HistorySessionDetail, HistorySessionPage, HistoryStatistics,
};
use repository::{CueWrite, HistoryRepository};

struct HistoryState {
    database_path: PathBuf,
    repository: Option<Arc<HistoryRepository>>,
    unavailable_reason: Option<String>,
    active_session_id: Option<String>,
}

#[derive(Clone)]
pub(crate) struct HistoryStateStore {
    inner: Arc<Mutex<Option<HistoryState>>>,
    cue_tx: SyncSender<QueuedCue>,
    control_tx: mpsc::Sender<ArchiveControl>,
}

const CUE_MUTATION_CAPACITY: usize = 1_024;
const CUE_BATCH_INTERVAL: Duration = Duration::from_millis(100);
const STOP_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct QueuedCue {
    session_id: String,
    cue: SubtitleCueRuntime,
    updated_at_ms: i64,
}

enum ArchiveControl {
    Begin { session_id: String, started_at_ms: i64 },
    Finish {
        session_id: String,
        ended_at_ms: i64,
        acknowledged: mpsc::Sender<Result<(), String>>,
    },
}

impl HistoryStateStore {
    pub(crate) fn new() -> Self {
        let inner = Arc::new(Mutex::new(None));
        let (cue_tx, cue_rx) = mpsc::sync_channel(CUE_MUTATION_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel();
        let worker_inner = inner.clone();
        std::thread::Builder::new()
            .name("subtitle-history-archive".to_string())
            .spawn(move || archive_worker(worker_inner, cue_rx, control_rx))
            .expect("spawn subtitle history archive worker");
        Self { inner, cue_tx, control_tx }
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
                .and_then(|cipher| HistoryRepository::initialize(database_path.clone(), cipher)),
        };
        let (repository, unavailable_reason) = match repository {
            Ok(repository) => (Some(Arc::new(repository)), None),
            Err(error) => (None, Some(error)),
        };
        let path = database_path.to_string_lossy().to_string();
        *inner = Some(HistoryState {
            database_path,
            repository,
            unavailable_reason,
            active_session_id: None,
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

    fn queue_cue(&self, cue: &SubtitleCueRuntime) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = available_state_mut(&mut inner)?;
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

    pub(crate) fn begin_session(&self) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = available_state_mut(&mut inner)?;
        if let Some(session_id) = state.active_session_id.clone() {
            return Ok(session_id);
        }
        let session_id = uuid::Uuid::now_v7().to_string();
        let started_at_ms = unix_ms();
        state.active_session_id = Some(session_id.clone());
        self.control_tx
            .send(ArchiveControl::Begin { session_id: session_id.clone(), started_at_ms })
            .map_err(|_| "字幕历史写入 worker 已停止".to_string())?;
        Ok(session_id)
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

pub(crate) fn begin_route_session<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.state::<HistoryStateStore>().begin_session() {
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
    if !history_dir.exists() {
        return Ok(false);
    }
    let mut directories = vec![history_dir.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                directories.push(path);
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".flac.enc"))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn archive_worker(
    state: Arc<Mutex<Option<HistoryState>>>,
    cue_rx: Receiver<QueuedCue>,
    control_rx: Receiver<ArchiveControl>,
) {
    let mut pending = HashMap::<(String, String), QueuedCue>::new();
    let mut next_flush = Instant::now() + CUE_BATCH_INTERVAL;
    loop {
        while let Ok(control) = control_rx.try_recv() {
            match control {
                ArchiveControl::Begin { session_id, started_at_ms } => {
                    with_worker_repository(&state, |repository| {
                        repository.create_session(&session_id, started_at_ms)
                    });
                }
                ArchiveControl::Finish { session_id, ended_at_ms, acknowledged } => {
                    drain_latest(&cue_rx, &mut pending, |cue| {
                        (cue.session_id.clone(), cue.cue.cue_id.clone())
                    });
                    let result = flush_pending_cues(&state, &mut pending).and_then(|()| {
                        worker_repository_result(&state, |repository| {
                            repository.end_session(&session_id, ended_at_ms)
                        })
                    });
                    let _ = acknowledged.send(result);
                }
            }
        }

        let now = Instant::now();
        if now >= next_flush {
            drain_latest(&cue_rx, &mut pending, |cue| {
                (cue.session_id.clone(), cue.cue.cue_id.clone())
            });
            let _ = flush_pending_cues(&state, &mut pending);
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
                let _ = flush_pending_cues(&state, &mut pending);
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
    use super::drain_latest;
    use std::collections::HashMap;
    use std::sync::mpsc;

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
}
