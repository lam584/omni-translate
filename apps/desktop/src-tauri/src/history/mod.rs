mod crypto;
mod repository;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::audio::contracts::SubtitleCueRuntime;

pub(crate) use repository::{
    HistoryCuePage, HistorySessionDetail, HistorySessionPage, HistoryStatistics,
};
use repository::{CueWrite, HistoryRepository};

struct HistoryState {
    repository: HistoryRepository,
    active_session_id: Option<String>,
}

#[derive(Clone)]
pub(crate) struct HistoryStateStore {
    inner: Arc<Mutex<Option<HistoryState>>>,
}

impl HistoryStateStore {
    pub(crate) fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(None)) }
    }

    pub(crate) fn ensure_initialized<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        if let Some(state) = inner.as_ref() {
            return Ok(state.repository.database_path().to_string_lossy().to_string());
        }
        let history_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("history");
        let database_path = history_dir.join("subtitle-history.db");
        let existing_archive = HistoryRepository::contains_encrypted_payload(&database_path)?;
        let cipher = crypto::HistoryCipher::from_system_credentials(existing_archive)?;
        let repository = HistoryRepository::initialize(database_path, cipher)?;
        let path = repository.database_path().to_string_lossy().to_string();
        *inner = Some(HistoryState { repository, active_session_id: None });
        Ok(path)
    }

    pub(crate) fn persist_cue(&self, cue: &SubtitleCueRuntime) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = inner.as_mut().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        let now = unix_ms();
        let session_id = match state.active_session_id.clone() {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                state.repository.create_session(&id, parse_ms_marker(&cue.started_at).unwrap_or(now))?;
                state.active_session_id = Some(id.clone());
                id
            }
        };
        state.repository.upsert_cue(
            CueWrite {
                session_id: &session_id,
                cue_id: &cue.cue_id,
                route_direction: &cue.route_direction,
                source_text: &cue.source_text,
                translated_text: &cue.translated_text,
                source_committed: cue.committed,
                translation_committed: cue.translation_committed,
                started_at_ms: parse_ms_marker(&cue.started_at).unwrap_or(now),
                ended_at_ms: parse_ms_marker(&cue.ended_at).unwrap_or(now),
            },
            now,
        )?;
        Ok(session_id)
    }

    pub(crate) fn begin_session(&self) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = inner.as_mut().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        if let Some(session_id) = state.active_session_id.clone() {
            return Ok(session_id);
        }
        let session_id = uuid::Uuid::now_v7().to_string();
        state.repository.create_session(&session_id, unix_ms())?;
        state.active_session_id = Some(session_id.clone());
        Ok(session_id)
    }

    pub(crate) fn finish_active_session(&self) -> Result<Option<String>, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = inner.as_mut().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        let Some(session_id) = state.active_session_id.take() else { return Ok(None); };
        state.repository.end_session(&session_id, unix_ms())?;
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
        let state = inner.as_mut().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        state.repository.delete_session(session_id)
    }

    pub(crate) fn clear(&self) -> Result<u64, String> {
        let mut inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = inner.as_mut().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        state.repository.clear()
    }

    fn with_repository<T>(&self, operation: impl FnOnce(&HistoryRepository) -> Result<T, String>) -> Result<T, String> {
        let inner = self.inner.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = inner.as_ref().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        operation(&state.repository)
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
