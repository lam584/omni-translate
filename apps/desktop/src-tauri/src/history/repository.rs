use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::crypto::HistoryCipher;

const SCHEMA_VERSION: i64 = 1;
const MAX_PAGE_SIZE: u32 = 100;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistorySessionSummary {
    pub id: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub status: String,
    pub cue_count: i64,
    pub audio_bytes: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistorySessionPage {
    pub items: Vec<HistorySessionSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryCue {
    pub id: String,
    pub cue_id: String,
    pub sequence: i64,
    pub revision: i64,
    pub route_direction: String,
    pub source_text: String,
    pub translated_text: String,
    pub source_committed: bool,
    pub translation_committed: bool,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistorySessionDetail {
    pub session: HistorySessionSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryCuePage {
    pub items: Vec<HistoryCue>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryStatistics {
    pub session_count: i64,
    pub cue_count: i64,
    pub audio_bytes: i64,
}

pub(super) struct HistoryRepository {
    database_path: PathBuf,
    cipher: HistoryCipher,
}

pub(super) struct CueWrite<'a> {
    pub session_id: &'a str,
    pub cue_id: &'a str,
    pub route_direction: &'a str,
    pub source_text: &'a str,
    pub translated_text: &'a str,
    pub source_committed: bool,
    pub translation_committed: bool,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

impl HistoryRepository {
    pub(super) fn contains_encrypted_payload(database_path: &Path) -> Result<bool, String> {
        if !database_path.exists() {
            return Ok(false);
        }
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        let cues_table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subtitle_cues')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !cues_table_exists {
            return Ok(false);
        }
        let has_cues: bool = connection
            .query_row("SELECT EXISTS(SELECT 1 FROM subtitle_cues LIMIT 1)", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        let audio_table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subtitle_audio_segments')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let has_audio = audio_table_exists
            && connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM subtitle_audio_segments LIMIT 1)",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| error.to_string())?;
        Ok(has_cues || has_audio)
    }

    pub(super) fn initialize(database_path: PathBuf, cipher: HistoryCipher) -> Result<Self, String> {
        if let Some(parent) = database_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let repository = Self { database_path, cipher };
        let connection = repository.open()?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA busy_timeout=5000;
                 CREATE TABLE IF NOT EXISTS history_migrations (
                   version INTEGER PRIMARY KEY,
                   name TEXT NOT NULL,
                   applied_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS subtitle_sessions (
                   id TEXT PRIMARY KEY,
                   started_at_ms INTEGER NOT NULL,
                   ended_at_ms INTEGER,
                   status TEXT NOT NULL DEFAULT 'active',
                   cue_count INTEGER NOT NULL DEFAULT 0,
                   audio_bytes INTEGER NOT NULL DEFAULT 0,
                   created_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS subtitle_cues (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL REFERENCES subtitle_sessions(id) ON DELETE CASCADE,
                   cue_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   revision INTEGER NOT NULL DEFAULT 1,
                   route_direction TEXT NOT NULL,
                   source_text_enc BLOB NOT NULL,
                   translated_text_enc BLOB NOT NULL,
                   source_committed INTEGER NOT NULL,
                   translation_committed INTEGER NOT NULL,
                   started_at_ms INTEGER NOT NULL,
                   ended_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL,
                   UNIQUE(session_id, cue_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_subtitle_cues_session_sequence
                   ON subtitle_cues(session_id, sequence);
                 CREATE TABLE IF NOT EXISTS subtitle_audio_segments (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL REFERENCES subtitle_sessions(id) ON DELETE CASCADE,
                   track TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   started_at_ms INTEGER NOT NULL,
                   duration_ms INTEGER NOT NULL,
                   sample_rate INTEGER NOT NULL,
                   channels INTEGER NOT NULL,
                   encrypted_path TEXT NOT NULL,
                   byte_size INTEGER NOT NULL,
                   created_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS subtitle_cue_audio_refs (
                   cue_id TEXT NOT NULL REFERENCES subtitle_cues(id) ON DELETE CASCADE,
                   audio_segment_id TEXT NOT NULL REFERENCES subtitle_audio_segments(id) ON DELETE CASCADE,
                   offset_ms INTEGER NOT NULL,
                   duration_ms INTEGER NOT NULL,
                   track TEXT NOT NULL,
                   PRIMARY KEY(cue_id, audio_segment_id, track)
                 );",
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT OR IGNORE INTO history_migrations(version, name, applied_at_ms)
                 VALUES (?1, 'initial-history-schema', CAST(unixepoch('subsec') * 1000 AS INTEGER))",
                [SCHEMA_VERSION],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE subtitle_sessions
                 SET status = 'interrupted', ended_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
                 WHERE status = 'active' AND ended_at_ms IS NULL",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(repository)
    }

    pub(super) fn create_session(&self, id: &str, started_at_ms: i64) -> Result<(), String> {
        self.open()?
            .execute(
                "INSERT OR IGNORE INTO subtitle_sessions(id, started_at_ms, created_at_ms) VALUES (?1, ?2, ?2)",
                params![id, started_at_ms],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(super) fn end_session(&self, id: &str, ended_at_ms: i64) -> Result<(), String> {
        self.open()?
            .execute(
                "UPDATE subtitle_sessions SET ended_at_ms = ?2, status = 'completed' WHERE id = ?1 AND ended_at_ms IS NULL",
                params![id, ended_at_ms],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn upsert_cue(&self, cue: CueWrite<'_>, updated_at_ms: i64) -> Result<(), String> {
        let connection = self.open()?;
        self.upsert_cue_on(&connection, &cue, updated_at_ms)
    }

    pub(super) fn upsert_cues_batch(
        &self,
        cues: &[CueWrite<'_>],
        updated_at_ms: i64,
    ) -> Result<(), String> {
        if cues.is_empty() {
            return Ok(());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        for cue in cues {
            self.upsert_cue_on(&transaction, cue, updated_at_ms)?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    fn upsert_cue_on(
        &self,
        connection: &Connection,
        cue: &CueWrite<'_>,
        updated_at_ms: i64,
    ) -> Result<(), String> {
        let source_aad = format!("history/v1:{0}:{1}:source", cue.session_id, cue.cue_id);
        let translated_aad = format!("history/v1:{0}:{1}:translated", cue.session_id, cue.cue_id);
        let source = self
            .cipher
            .encrypt(cue.source_text.as_bytes(), source_aad.as_bytes())?;
        let translated = self
            .cipher
            .encrypt(cue.translated_text.as_bytes(), translated_aad.as_bytes())?;
        let existing: Option<(String, i64, i64)> = connection
            .query_row(
                "SELECT id, sequence, revision FROM subtitle_cues WHERE session_id = ?1 AND cue_id = ?2",
                params![cue.session_id, cue.cue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((id, sequence, revision)) = existing {
            connection
                .execute(
                    "UPDATE subtitle_cues SET revision = ?2, route_direction = ?3,
                       source_text_enc = ?4, translated_text_enc = ?5,
                       source_committed = ?6, translation_committed = ?7,
                       started_at_ms = ?8, ended_at_ms = ?9, updated_at_ms = ?10
                     WHERE id = ?1",
                    params![
                        id,
                        revision + 1,
                        cue.route_direction,
                        source,
                        translated,
                        cue.source_committed,
                        cue.translation_committed,
                        cue.started_at_ms,
                        cue.ended_at_ms,
                        updated_at_ms,
                    ],
                )
                .map_err(|error| error.to_string())?;
            let _ = sequence;
        } else {
            let sequence: i64 = connection
                .query_row(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 FROM subtitle_cues WHERE session_id = ?1",
                    [cue.session_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "INSERT INTO subtitle_cues(
                       id, session_id, cue_id, sequence, revision, route_direction,
                       source_text_enc, translated_text_enc, source_committed,
                       translation_committed, started_at_ms, ended_at_ms, updated_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        uuid::Uuid::now_v7().to_string(),
                        cue.session_id,
                        cue.cue_id,
                        sequence,
                        cue.route_direction,
                        source,
                        translated,
                        cue.source_committed,
                        cue.translation_committed,
                        cue.started_at_ms,
                        cue.ended_at_ms,
                        updated_at_ms,
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        connection
            .execute(
                "UPDATE subtitle_sessions SET cue_count = (SELECT COUNT(*) FROM subtitle_cues WHERE session_id = ?1)
                 WHERE id = ?1",
                [cue.session_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(super) fn list_sessions(&self, cursor: Option<&str>, limit: u32) -> Result<HistorySessionPage, String> {
        let limit = limit.clamp(1, MAX_PAGE_SIZE);
        let (cursor_time, cursor_id) = decode_session_cursor(cursor)?;
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, started_at_ms, ended_at_ms, status, cue_count, audio_bytes
                 FROM subtitle_sessions
                 WHERE (?1 IS NULL
                    OR COALESCE(ended_at_ms, started_at_ms) < ?1
                    OR (COALESCE(ended_at_ms, started_at_ms) = ?1 AND id < ?2))
                 ORDER BY COALESCE(ended_at_ms, started_at_ms) DESC, id DESC
                 LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![cursor_time, cursor_id, limit + 1], session_from_row)
            .map_err(|error| error.to_string())?;
        let mut items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = if has_more {
            items.last().map(|item| {
                format!("{}|{}", item.ended_at_ms.unwrap_or(item.started_at_ms), item.id)
            })
        } else {
            None
        };
        Ok(HistorySessionPage {
            items,
            next_cursor,
        })
    }

    pub(super) fn get_session(&self, session_id: &str) -> Result<Option<HistorySessionDetail>, String> {
        let connection = self.open()?;
        let session = connection
            .query_row(
                "SELECT id, started_at_ms, ended_at_ms, status, cue_count, audio_bytes FROM subtitle_sessions WHERE id = ?1",
                [session_id],
                session_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(session) = session else { return Ok(None); };
        Ok(Some(HistorySessionDetail { session }))
    }

    pub(super) fn list_cues(
        &self,
        session_id: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<HistoryCuePage, String> {
        let limit = limit.clamp(1, MAX_PAGE_SIZE);
        let after_sequence = decode_cue_cursor(cursor)?;
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, cue_id, sequence, revision, route_direction, source_text_enc,
                        translated_text_enc, source_committed, translation_committed,
                        started_at_ms, ended_at_ms
                 FROM subtitle_cues
                 WHERE session_id = ?1 AND (?2 IS NULL OR sequence > ?2)
                 ORDER BY sequence ASC LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![session_id, after_sequence, limit + 1], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, Vec<u8>>(6)?,
                    row.get::<_, bool>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut cues = Vec::new();
        for row in rows {
            let (id, cue_id, sequence, revision, route_direction, source, translated,
                source_committed, translation_committed, started_at_ms, ended_at_ms) =
                row.map_err(|error| error.to_string())?;
            let source_aad = format!("history/v1:{session_id}:{cue_id}:source");
            let translated_aad = format!("history/v1:{session_id}:{cue_id}:translated");
            let source_text = String::from_utf8(self.cipher.decrypt(&source, source_aad.as_bytes())?)
                .map_err(|_| "字幕历史原文不是有效 UTF-8".to_string())?;
            let translated_text = String::from_utf8(self.cipher.decrypt(&translated, translated_aad.as_bytes())?)
                .map_err(|_| "字幕历史译文不是有效 UTF-8".to_string())?;
            cues.push(HistoryCue {
                id,
                cue_id,
                sequence,
                revision,
                route_direction,
                source_text,
                translated_text,
                source_committed,
                translation_committed,
                started_at_ms,
                ended_at_ms,
            });
        }
        let has_more = cues.len() > limit as usize;
        cues.truncate(limit as usize);
        let next_cursor = if has_more {
            cues.last().map(|cue| cue.sequence.to_string())
        } else {
            None
        };
        Ok(HistoryCuePage { items: cues, next_cursor })
    }

    pub(super) fn statistics(&self) -> Result<HistoryStatistics, String> {
        self.open()?
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(cue_count), 0), COALESCE(SUM(audio_bytes), 0) FROM subtitle_sessions",
                [],
                |row| Ok(HistoryStatistics {
                    session_count: row.get(0)?, cue_count: row.get(1)?, audio_bytes: row.get(2)?,
                }),
            )
            .map_err(|error| error.to_string())
    }

    pub(super) fn delete_session(&self, session_id: &str) -> Result<bool, String> {
        let changed = self.open()?
            .execute("DELETE FROM subtitle_sessions WHERE id = ?1 AND ended_at_ms IS NOT NULL", [session_id])
            .map_err(|error| error.to_string())?;
        Ok(changed > 0)
    }

    pub(super) fn clear(&self) -> Result<i64, String> {
        let connection = self.open()?;
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM subtitle_sessions WHERE ended_at_ms IS NOT NULL", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        connection
            .execute("DELETE FROM subtitle_sessions WHERE ended_at_ms IS NOT NULL", [])
            .map_err(|error| error.to_string())?;
        Ok(count)
    }

    fn open(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.database_path).map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistorySessionSummary> {
    Ok(HistorySessionSummary {
        id: row.get(0)?,
        started_at_ms: row.get(1)?,
        ended_at_ms: row.get(2)?,
        status: row.get(3)?,
        cue_count: row.get(4)?,
        audio_bytes: row.get(5)?,
    })
}

fn decode_session_cursor(cursor: Option<&str>) -> Result<(Option<i64>, Option<String>), String> {
    let Some(cursor) = cursor.filter(|value| !value.is_empty()) else {
        return Ok((None, None));
    };
    let (time, id) = cursor
        .split_once('|')
        .ok_or_else(|| "无效的历史 session 游标".to_string())?;
    let time = time
        .parse::<i64>()
        .map_err(|_| "无效的历史 session 游标".to_string())?;
    if id.is_empty() {
        return Err("无效的历史 session 游标".to_string());
    }
    Ok((Some(time), Some(id.to_string())))
}

fn decode_cue_cursor(cursor: Option<&str>) -> Result<Option<i64>, String> {
    cursor
        .filter(|value| !value.is_empty())
        .map(|value| value.parse::<i64>().map_err(|_| "无效的历史 cue 游标".to_string()))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cues_are_encrypted_at_rest_and_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("history.sqlite3");
        let repository = HistoryRepository::initialize(
            database_path.clone(),
            HistoryCipher::for_test([11; 32]),
        )
        .unwrap();
        repository.create_session("session-1", 100).unwrap();
        repository
            .upsert_cue(
                CueWrite {
                    session_id: "session-1", cue_id: "cue-1", route_direction: "inbound",
                    source_text: "private source", translated_text: "私密译文",
                    source_committed: true, translation_committed: true,
                    started_at_ms: 101, ended_at_ms: 102,
                },
                103,
            )
            .unwrap();

        let raw = std::fs::read(database_path).unwrap();
        assert!(!raw.windows(14).any(|part| part == b"private source"));
        let cues = repository.list_cues("session-1", None, 50).unwrap();
        assert_eq!(cues.items[0].source_text, "private source");
        assert_eq!(cues.items[0].translated_text, "私密译文");
        assert_eq!(repository.list_sessions(None, 25).unwrap().items.len(), 1);

        for entry in std::fs::read_dir(directory.path()).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let raw = std::fs::read(path).unwrap();
                assert!(!raw.windows(14).any(|part| part == b"private source"));
                assert!(!raw.windows("私密译文".len()).any(|part| part == "私密译文".as_bytes()));
            }
        }
    }
}
