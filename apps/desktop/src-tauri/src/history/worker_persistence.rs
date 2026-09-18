use super::*;
use super::repository::CueWrite;

pub(super) fn run_worker_retention(state: &Arc<Mutex<Option<HistoryState>>>) -> Result<(), String> {
    let (repository, history_dir) = worker_archive_context(state)?;
    repository.run_retention(&history_dir, unix_ms()).map(|_| ())
}

pub(super) fn worker_archive_context(
    state: &Arc<Mutex<Option<HistoryState>>>,
) -> Result<(Arc<HistoryRepository>, PathBuf), String> {
    let state = state.lock().map_err(|_| "history state poisoned".to_string())?;
    let state = state.as_ref().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
    Ok((repository(state)?, state.history_dir.clone()))
}

pub(super) fn flush_pending_cues(
    state: &Arc<Mutex<Option<HistoryState>>>,
    pending: &mut HashMap<(String, String), QueuedCue>,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    let mut batch = pending.values().cloned().collect::<Vec<_>>();
    batch.sort_by_key(|cue| cue.updated_at_ms);
    let result = worker_repository_result(state, |repository| {
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
    });
    if result.is_err() && history_persistence_disabled(state) {
        pending.clear();
    }
    result
}

pub(super) fn is_unrecoverable_database_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("database disk image is malformed")
        || normalized.contains("file is not a database")
        || normalized.contains("database corruption")
}

fn disable_history_after_unrecoverable_error(
    state: &Arc<Mutex<Option<HistoryState>>>,
    error: &str,
) -> bool {
    if !is_unrecoverable_database_error(error) {
        return false;
    }
    let Ok(mut state) = state.lock() else {
        return false;
    };
    let Some(state) = state.as_mut() else {
        return false;
    };
    if state.unavailable_reason.is_some() {
        return false;
    }
    state.unavailable_reason = Some(error.to_string());
    state.repository = None;
    state.active_session_id = None;
    true
}

fn history_persistence_disabled(state: &Arc<Mutex<Option<HistoryState>>>) -> bool {
    state
        .lock()
        .ok()
        .and_then(|state| state.as_ref().map(|state| state.unavailable_reason.is_some()))
        .unwrap_or(false)
}

pub(super) fn worker_repository_result<T>(
    state: &Arc<Mutex<Option<HistoryState>>>,
    operation: impl FnOnce(&HistoryRepository) -> Result<T, String>,
) -> Result<T, String> {
    let repository = {
        let state = state.lock().map_err(|_| "history state poisoned".to_string())?;
        let state = state.as_ref().ok_or_else(|| "字幕历史尚未初始化".to_string())?;
        repository(state)?
    };
    match operation(&repository) {
        Ok(value) => Ok(value),
        Err(error) => {
            if disable_history_after_unrecoverable_error(state, &error) {
                log::warn!(
                    "[omni][history] persistence disabled after unrecoverable database failure; realtime translation continues: {error}"
                );
            }
            Err(error)
        }
    }
}

pub(super) fn with_worker_repository(
    state: &Arc<Mutex<Option<HistoryState>>>,
    operation: impl FnOnce(&HistoryRepository) -> Result<(), String>,
) {
    if let Err(error) = worker_repository_result(state, operation) {
        if !history_persistence_disabled(state) {
            log::warn!("[omni][history] archive worker mutation failed: {error}");
        }
    }
}
