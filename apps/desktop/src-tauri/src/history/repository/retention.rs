use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::HistoryRepository;
use crate::history::fs_safety::{canonical_archive_file, walk_regular_archive_files};

pub(super) const RETENTION_MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1_000;
pub(super) const RETENTION_MAX_SESSIONS: usize = 500;
pub(super) const RETENTION_MAX_BYTES: i64 = 5 * 1024 * 1024 * 1024;

struct RetentionVictim {
    session_id: String,
}

impl HistoryRepository {
    pub(in crate::history) fn run_retention(
        &self,
        history_dir: &Path,
        now_ms: i64,
    ) -> Result<usize, String> {
        self.resume_deleting_sessions(history_dir)?;
        let victims = self.select_retention_victims(now_ms)?;
        if victims.is_empty() {
            self.cleanup_orphan_audio(history_dir)?;
            return Ok(0);
        }
        let connection = self.open()?;
        for victim in &victims {
            connection
                .execute(
                    "UPDATE subtitle_sessions SET status = 'deleting'
                     WHERE id = ?1 AND ended_at_ms IS NOT NULL",
                    [&victim.session_id],
                )
                .map_err(|error| error.to_string())?;
        }
        drop(connection);
        self.resume_deleting_sessions(history_dir)?;
        self.cleanup_orphan_audio(history_dir)?;
        Ok(victims.len())
    }

    fn select_retention_victims(&self, now_ms: i64) -> Result<Vec<RetentionVictim>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, ended_at_ms, audio_bytes
                 FROM subtitle_sessions
                 WHERE ended_at_ms IS NOT NULL AND status != 'deleting'
                 ORDER BY ended_at_ms ASC, id ASC",
            )
            .map_err(|error| error.to_string())?;
        let ended = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        let mut total_audio_bytes: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(audio_bytes), 0) FROM subtitle_sessions",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let age_cutoff = now_ms.saturating_sub(RETENTION_MAX_AGE_MS);
        let mut victims = Vec::new();
        for (index, (session_id, ended_at_ms, audio_bytes)) in ended.iter().enumerate() {
            let too_old = *ended_at_ms < age_cutoff;
            let exceeds_count = ended.len().saturating_sub(index) > RETENTION_MAX_SESSIONS;
            let exceeds_bytes = total_audio_bytes > RETENTION_MAX_BYTES;
            if too_old || exceeds_count || exceeds_bytes {
                victims.push(RetentionVictim {
                    session_id: session_id.clone(),
                });
                total_audio_bytes = total_audio_bytes.saturating_sub(*audio_bytes);
            }
        }
        Ok(victims)
    }

    pub(super) fn resume_deleting_sessions(&self, history_dir: &Path) -> Result<(), String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT subtitle_sessions.id, encrypted_path FROM subtitle_sessions
                 LEFT JOIN subtitle_audio_segments
                   ON subtitle_audio_segments.session_id = subtitle_sessions.id
                 WHERE subtitle_sessions.status = 'deleting'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        let mut session_ids = HashSet::new();
        for (session_id, encrypted_path) in rows {
            session_ids.insert(session_id);
            if let Some(encrypted_path) = encrypted_path {
                let encrypted_path = PathBuf::from(encrypted_path);
                if let Some(canonical_path) =
                    canonical_archive_file(history_dir, &encrypted_path)?
                {
                    match std::fs::remove_file(&canonical_path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.to_string()),
                    }
                }
            }
        }
        for session_id in session_ids {
            connection
                .execute(
                    "DELETE FROM subtitle_sessions WHERE id = ?1 AND status = 'deleting'",
                    [&session_id],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn cleanup_orphan_audio(&self, history_dir: &Path) -> Result<(), String> {
        if !history_dir.exists() {
            return Ok(());
        }
        let connection = self.open()?;
        let mut statement = connection
            .prepare("SELECT encrypted_path FROM subtitle_audio_segments")
            .map_err(|error| error.to_string())?;
        let stored_paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        let mut known = HashSet::new();
        for stored_path in stored_paths {
            if let Some(canonical_path) =
                canonical_archive_file(history_dir, &PathBuf::from(stored_path))?
            {
                known.insert(canonical_path);
            }
        }
        for path in walk_regular_archive_files(history_dir)? {
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
            let Some(canonical_path) = canonical_archive_file(history_dir, &path)? else {
                continue;
            };
            let is_part = name.ends_with(".flac.enc.part");
            let is_orphan = name.ends_with(".flac.enc") && !known.contains(&canonical_path);
            if is_part || is_orphan {
                match std::fs::remove_file(canonical_path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        Ok(())
    }
}
