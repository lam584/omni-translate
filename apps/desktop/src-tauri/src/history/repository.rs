use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::crypto::HistoryCipher;

mod cursor;
use cursor::{decode_cue_cursor, decode_session_cursor};
mod retention;
use retention::RETENTION_MAX_BYTES;
#[cfg(test)]
use retention::{RETENTION_MAX_AGE_MS, RETENTION_MAX_SESSIONS};

const INITIAL_SCHEMA_VERSION: i64 = 1;
const RUNTIME_LINEAGE_SCHEMA_VERSION: i64 = 2;
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
    pub source_audio_available: bool,
    pub translated_audio_available: bool,
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
    pub sequence: i64,
    pub revision: i64,
    pub route_direction: &'a str,
    pub source_text: &'a str,
    pub translated_text: &'a str,
    pub source_committed: bool,
    pub translation_committed: bool,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

pub(super) struct AudioSegmentWrite<'a> {
    pub session_id: &'a str,
    pub cue_refs: &'a [AudioCueRefWrite<'a>],
    pub track: &'a str,
    pub sequence: i64,
    pub started_at_ms: i64,
    pub duration_ms: i64,
    pub sample_rate_hz: u32,
    pub encrypted_path: &'a Path,
    pub encrypted_bytes: i64,
}

pub(super) struct AudioCueRefWrite<'a> {
    pub cue_id: &'a str,
    pub offset_samples: i64,
    pub length_samples: i64,
}

pub(super) struct AudioCueSegmentRead {
    pub sequence: i64,
    pub sample_rate_hz: u32,
    pub encrypted_path: PathBuf,
    pub offset_samples: usize,
    pub length_samples: usize,
}

impl HistoryRepository {
    pub(super) fn ended_session_count_at(database_path: &Path) -> Result<i64, String> {
        if !database_path.exists() {
            return Ok(0);
        }
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        let sessions_table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subtitle_sessions')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !sessions_table_exists {
            return Ok(0);
        }
        connection
            .query_row(
                "SELECT COUNT(*) FROM subtitle_sessions WHERE ended_at_ms IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub(super) fn cipher(&self) -> HistoryCipher {
        self.cipher.clone()
    }

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
        let mut connection = repository.open()?;
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
                   archive_gap_count INTEGER NOT NULL DEFAULT 0,
                   created_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS subtitle_cues (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL REFERENCES subtitle_sessions(id) ON DELETE CASCADE,
                   cue_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   revision INTEGER NOT NULL DEFAULT 1,
                   runtime_sequence INTEGER NOT NULL DEFAULT 0,
                   runtime_revision INTEGER NOT NULL DEFAULT 0,
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
                   created_at_ms INTEGER NOT NULL,
                   UNIQUE(session_id, track, sequence)
                 );
                 CREATE TABLE IF NOT EXISTS subtitle_cue_audio_refs (
                   cue_id TEXT NOT NULL REFERENCES subtitle_cues(id) ON DELETE CASCADE,
                   audio_segment_id TEXT NOT NULL REFERENCES subtitle_audio_segments(id) ON DELETE CASCADE,
                   offset_samples INTEGER NOT NULL,
                   length_samples INTEGER NOT NULL,
                   track TEXT NOT NULL,
                   PRIMARY KEY(cue_id, audio_segment_id, track)
                 );",
            )
            .map_err(|error| error.to_string())?;
        migrate_legacy_audio_refs(&mut connection)?;
        ensure_column(
            &connection,
            "subtitle_sessions",
            "archive_gap_count",
            "ALTER TABLE subtitle_sessions ADD COLUMN archive_gap_count INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "subtitle_cue_audio_refs",
            "offset_samples",
            "ALTER TABLE subtitle_cue_audio_refs ADD COLUMN offset_samples INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "subtitle_cue_audio_refs",
            "length_samples",
            "ALTER TABLE subtitle_cue_audio_refs ADD COLUMN length_samples INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "subtitle_cues",
            "runtime_sequence",
            "ALTER TABLE subtitle_cues ADD COLUMN runtime_sequence INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "subtitle_cues",
            "runtime_revision",
            "ALTER TABLE subtitle_cues ADD COLUMN runtime_revision INTEGER NOT NULL DEFAULT 0",
        )?;
        connection
            .execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS subtitle_audio_segments_track_sequence
                 ON subtitle_audio_segments(session_id, track, sequence)",
                [],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT OR IGNORE INTO history_migrations(version, name, applied_at_ms)
                 VALUES (?1, 'initial-history-schema', CAST(unixepoch('subsec') * 1000 AS INTEGER))",
                [INITIAL_SCHEMA_VERSION],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT OR IGNORE INTO history_migrations(version, name, applied_at_ms)
                 VALUES (?1, 'runtime-cue-lineage', CAST(unixepoch('subsec') * 1000 AS INTEGER))",
                [RUNTIME_LINEAGE_SCHEMA_VERSION],
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

    pub(super) fn mark_archive_gap(&self, session_id: &str) -> Result<(), String> {
        self.open()?
            .execute(
                "UPDATE subtitle_sessions
                 SET archive_gap_count = archive_gap_count + 1
                 WHERE id = ?1",
                [session_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(super) fn next_audio_sequence(&self, session_id: &str, track: &str) -> Result<i64, String> {
        self.open()?
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) + 1
                 FROM subtitle_audio_segments WHERE session_id = ?1 AND track = ?2",
                params![session_id, track],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub(super) fn insert_audio_segment(&self, segment: AudioSegmentWrite<'_>) -> Result<(), String> {
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let segment_id = uuid::Uuid::now_v7().to_string();
        transaction
            .execute(
                "INSERT INTO subtitle_audio_segments(
                   id, session_id, track, sequence, started_at_ms, duration_ms,
                   sample_rate, channels, encrypted_path, byte_size, created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9,
                           CAST(unixepoch('subsec') * 1000 AS INTEGER))",
                params![
                    segment_id,
                    segment.session_id,
                    segment.track,
                    segment.sequence,
                    segment.started_at_ms,
                    segment.duration_ms,
                    segment.sample_rate_hz,
                    segment.encrypted_path.to_string_lossy(),
                    segment.encrypted_bytes,
                ],
            )
            .map_err(|error| error.to_string())?;
        if !segment.cue_refs.is_empty() {
            for cue_ref in segment.cue_refs {
                let internal_cue_id: Option<String> = transaction
                    .query_row(
                        "SELECT id FROM subtitle_cues WHERE session_id = ?1 AND cue_id = ?2",
                        params![segment.session_id, cue_ref.cue_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
                if let Some(internal_cue_id) = internal_cue_id {
                    transaction
                        .execute(
                            "INSERT OR REPLACE INTO subtitle_cue_audio_refs(
                               cue_id, audio_segment_id, offset_samples, length_samples, track
                             ) VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![
                                internal_cue_id,
                                segment_id,
                                cue_ref.offset_samples,
                                cue_ref.length_samples,
                                segment.track,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
        } else {
            let segment_end_ms = segment.started_at_ms.saturating_add(segment.duration_ms);
            let mut statement = transaction
                .prepare(
                    "SELECT id, MAX(started_at_ms, ?2), MIN(ended_at_ms, ?3)
                     FROM subtitle_cues
                     WHERE session_id = ?1 AND started_at_ms < ?3 AND ended_at_ms > ?2",
                )
                .map_err(|error| error.to_string())?;
            let overlaps = statement
                .query_map(
                    params![segment.session_id, segment.started_at_ms, segment_end_ms],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
                )
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            drop(statement);
            for (cue_id, overlap_start, overlap_end) in overlaps {
                let offset_samples = overlap_start
                    .saturating_sub(segment.started_at_ms)
                    .saturating_mul(i64::from(segment.sample_rate_hz))
                    / 1_000;
                let length_samples = overlap_end
                    .saturating_sub(overlap_start)
                    .saturating_mul(i64::from(segment.sample_rate_hz))
                    / 1_000;
                transaction
                    .execute(
                        "INSERT OR REPLACE INTO subtitle_cue_audio_refs(
                           cue_id, audio_segment_id, offset_samples, length_samples, track
                         ) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![cue_id, segment_id, offset_samples, length_samples, segment.track],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .execute(
                "UPDATE subtitle_sessions SET audio_bytes = audio_bytes + ?2 WHERE id = ?1",
                params![segment.session_id, segment.encrypted_bytes],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(super) fn audio_archive_allowed(&self) -> Result<bool, String> {
        let bytes: i64 = self.open()?.query_row(
            "SELECT COALESCE(SUM(audio_bytes), 0) FROM subtitle_sessions",
            [],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        Ok(bytes < RETENTION_MAX_BYTES)
    }

    pub(super) fn cue_audio_segments(
        &self,
        session_id: &str,
        cue_id: &str,
        track: &str,
    ) -> Result<Vec<AudioCueSegmentRead>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT audio.sequence, audio.sample_rate, audio.encrypted_path,
                        refs.offset_samples, refs.length_samples
                 FROM subtitle_cues AS cues
                 JOIN subtitle_cue_audio_refs AS refs ON refs.cue_id = cues.id
                 JOIN subtitle_audio_segments AS audio ON audio.id = refs.audio_segment_id
                 WHERE cues.session_id = ?1 AND cues.cue_id = ?2
                   AND refs.track = ?3 AND audio.track = ?3
                 ORDER BY audio.sequence ASC, refs.offset_samples ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![session_id, cue_id, track], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut segments = Vec::new();
        for row in rows {
            let (sequence, sample_rate_hz, path, offset_samples, length_samples) =
                row.map_err(|error| error.to_string())?;
            if sample_rate_hz == 0 || offset_samples < 0 || length_samples <= 0 {
                return Err(format!(
                    "历史音频引用无效：sequence={sequence} offset={offset_samples} length={length_samples} sampleRate={sample_rate_hz}"
                ));
            }
            segments.push(AudioCueSegmentRead {
                sequence,
                sample_rate_hz,
                encrypted_path: PathBuf::from(path),
                offset_samples: usize::try_from(offset_samples)
                    .map_err(|_| "历史音频 offset 超出平台范围".to_string())?,
                length_samples: usize::try_from(length_samples)
                    .map_err(|_| "历史音频 length 超出平台范围".to_string())?,
            });
        }
        Ok(segments)
    }

    #[cfg(test)]
    pub(super) fn audio_segments_for_test(
        &self,
        session_id: &str,
        track: &str,
    ) -> Result<Vec<(i64, u32, PathBuf)>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT sequence, sample_rate, encrypted_path
                 FROM subtitle_audio_segments
                 WHERE session_id = ?1 AND track = ?2 ORDER BY sequence",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![session_id, track], |row| {
                Ok((row.get(0)?, row.get(1)?, PathBuf::from(row.get::<_, String>(2)?)))
            })
            .map_err(|error| error.to_string())?;
        rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    pub(super) fn cue_audio_ref_count_for_test(
        &self,
        session_id: &str,
        cue_id: &str,
        track: &str,
    ) -> Result<i64, String> {
        self.open()?
            .query_row(
                "SELECT COUNT(*) FROM subtitle_cue_audio_refs
                 JOIN subtitle_cues ON subtitle_cues.id = subtitle_cue_audio_refs.cue_id
                 WHERE subtitle_cues.session_id = ?1
                   AND subtitle_cues.cue_id = ?2
                   AND subtitle_cue_audio_refs.track = ?3",
                params![session_id, cue_id, track],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
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
                "SELECT id, runtime_revision, runtime_sequence
                 FROM subtitle_cues WHERE session_id = ?1 AND cue_id = ?2",
                params![cue.session_id, cue.cue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((id, runtime_revision, runtime_sequence)) = existing {
            if (cue.revision, cue.sequence) >= (runtime_revision, runtime_sequence) {
                connection
                    .execute(
                        "UPDATE subtitle_cues SET revision = ?2,
                           runtime_revision = ?2, runtime_sequence = ?3,
                           route_direction = ?4, source_text_enc = ?5,
                           translated_text_enc = ?6, source_committed = ?7,
                           translation_committed = ?8, started_at_ms = ?9,
                           ended_at_ms = ?10, updated_at_ms = ?11
                         WHERE id = ?1",
                        params![
                            id,
                            cue.revision,
                            cue.sequence,
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
                       id, session_id, cue_id, sequence, revision,
                       runtime_sequence, runtime_revision, route_direction,
                       source_text_enc, translated_text_enc, source_committed,
                       translation_committed, started_at_ms, ended_at_ms, updated_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?7, ?8, ?9,
                               ?10, ?11, ?12, ?13, ?14)",
                    params![
                        uuid::Uuid::now_v7().to_string(),
                        cue.session_id,
                        cue.cue_id,
                        sequence,
                        cue.revision,
                        cue.sequence,
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
                "SELECT id, cue_id, sequence, runtime_sequence, runtime_revision,
                        route_direction, source_text_enc,
                        translated_text_enc, source_committed, translation_committed,
                        started_at_ms, ended_at_ms,
                        EXISTS(SELECT 1 FROM subtitle_cue_audio_refs refs
                               WHERE refs.cue_id = subtitle_cues.id AND refs.track = 'source'),
                        EXISTS(SELECT 1 FROM subtitle_cue_audio_refs refs
                               WHERE refs.cue_id = subtitle_cues.id AND refs.track = 'translated')
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
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Vec<u8>>(6)?,
                    row.get::<_, Vec<u8>>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, bool>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, bool>(12)?,
                    row.get::<_, bool>(13)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut cues = Vec::new();
        let mut archive_sequences = Vec::new();
        for row in rows {
            let (
                id,
                cue_id,
                archive_sequence,
                sequence,
                revision,
                route_direction,
                source,
                translated,
                source_committed,
                translation_committed,
                started_at_ms,
                ended_at_ms,
                source_audio_available,
                translated_audio_available,
            ) = row.map_err(|error| error.to_string())?;
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
                source_audio_available,
                translated_audio_available,
            });
            archive_sequences.push(archive_sequence);
        }
        let has_more = cues.len() > limit as usize;
        cues.truncate(limit as usize);
        archive_sequences.truncate(limit as usize);
        let next_cursor = if has_more {
            archive_sequences.last().map(i64::to_string)
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
            .execute(
                "UPDATE subtitle_sessions SET status = 'deleting'
                 WHERE id = ?1 AND ended_at_ms IS NOT NULL",
                [session_id],
            )
            .map_err(|error| error.to_string())?;
        if changed > 0 {
            self.resume_deleting_sessions(self.history_dir()?)?;
        }
        Ok(changed > 0)
    }

    pub(super) fn clear(&self) -> Result<i64, String> {
        let connection = self.open()?;
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM subtitle_sessions WHERE ended_at_ms IS NOT NULL", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE subtitle_sessions SET status = 'deleting' WHERE ended_at_ms IS NOT NULL",
                [],
            )
            .map_err(|error| error.to_string())?;
        drop(connection);
        self.resume_deleting_sessions(self.history_dir()?)?;
        Ok(count)
    }

    fn open(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.database_path).map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn history_dir(&self) -> Result<&Path, String> {
        self.database_path
            .parent()
            .ok_or_else(|| "字幕历史数据库缺少父目录".to_string())
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_statement: &str,
) -> Result<(), String> {
    let columns = table_columns(connection, table)?;
    if !columns.iter().any(|value| value == column) {
        connection
            .execute(alter_statement, [])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    let columns = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(columns)
}

fn migrate_legacy_audio_refs(connection: &mut Connection) -> Result<(), String> {
    if !table_columns(connection, "subtitle_cue_audio_refs")?
        .iter()
        .any(|column| column == "offset_ms")
    {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute_batch(
            "ALTER TABLE subtitle_cue_audio_refs RENAME TO subtitle_cue_audio_refs_legacy;
             CREATE TABLE subtitle_cue_audio_refs (
               cue_id TEXT NOT NULL REFERENCES subtitle_cues(id) ON DELETE CASCADE,
               audio_segment_id TEXT NOT NULL REFERENCES subtitle_audio_segments(id) ON DELETE CASCADE,
               offset_samples INTEGER NOT NULL,
               length_samples INTEGER NOT NULL,
               track TEXT NOT NULL,
               PRIMARY KEY(cue_id, audio_segment_id, track)
             );
             INSERT INTO subtitle_cue_audio_refs(
               cue_id, audio_segment_id, offset_samples, length_samples, track
             )
             SELECT legacy.cue_id, legacy.audio_segment_id,
                    legacy.offset_ms * segments.sample_rate / 1000,
                    legacy.duration_ms * segments.sample_rate / 1000,
                    legacy.track
             FROM subtitle_cue_audio_refs_legacy AS legacy
             JOIN subtitle_audio_segments AS segments ON segments.id = legacy.audio_segment_id;
             DROP TABLE subtitle_cue_audio_refs_legacy;",
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
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
                    session_id: "session-1", cue_id: "cue-1", sequence: 1, revision: 1,
                    route_direction: "inbound",
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

    #[test]
    fn cue_api_preserves_runtime_lineage_and_rejects_superseded_mutations() {
        let directory = tempfile::tempdir().unwrap();
        let repository = HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            HistoryCipher::for_test([13; 32]),
        )
        .unwrap();
        repository.create_session("session-lineage", 100).unwrap();

        for (sequence, revision, translated_text, updated_at_ms) in [
            (10, 2, "preview", 101),
            (10, 2, "same-lineage-latest", 102),
            (11, 3, "final", 103),
            (12, 2, "superseded-late-result", 104),
        ] {
            repository
                .upsert_cue(
                    CueWrite {
                        session_id: "session-lineage",
                        cue_id: "cue-1",
                        sequence,
                        revision,
                        route_direction: "inbound",
                        source_text: "source",
                        translated_text,
                        source_committed: true,
                        translation_committed: revision == 3,
                        started_at_ms: 100,
                        ended_at_ms: updated_at_ms,
                    },
                    updated_at_ms,
                )
                .unwrap();
        }

        let cues = repository.list_cues("session-lineage", None, 50).unwrap();
        assert_eq!(cues.items.len(), 1);
        assert_eq!(cues.items[0].sequence, 11);
        assert_eq!(cues.items[0].revision, 3);
        assert_eq!(cues.items[0].translated_text, "final");
        assert!(cues.items[0].translation_committed);
    }

    #[test]
    fn retention_removes_only_oldest_ended_sessions_and_recovers_orphans() {
        let directory = tempfile::tempdir().unwrap();
        let repository = HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            HistoryCipher::for_test([17; 32]),
        )
        .unwrap();
        for index in 0..=RETENTION_MAX_SESSIONS {
            let id = format!("ended-{index:04}");
            repository.create_session(&id, index as i64).unwrap();
            repository.end_session(&id, index as i64 + 1).unwrap();
        }
        repository.create_session("active", 9_999).unwrap();
        let orphan = directory.path().join("orphan.flac.enc");
        std::fs::write(&orphan, b"encrypted orphan").unwrap();
        let part = directory.path().join("unfinished.flac.enc.part");
        std::fs::write(&part, b"partial").unwrap();

        let removed = repository
            .run_retention(directory.path(), RETENTION_MAX_AGE_MS)
            .unwrap();

        assert_eq!(removed, 1);
        assert!(repository.get_session("ended-0000").unwrap().is_none());
        assert!(repository.get_session("active").unwrap().is_some());
        assert!(!orphan.exists());
        assert!(!part.exists());
    }

    #[test]
    fn retention_enforces_age_and_capacity_without_deleting_active_session() {
        let directory = tempfile::tempdir().unwrap();
        let repository = HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            HistoryCipher::for_test([19; 32]),
        )
        .unwrap();
        let now_ms = RETENTION_MAX_AGE_MS.saturating_mul(2);
        repository.create_session("expired", 1).unwrap();
        repository.end_session("expired", 2).unwrap();
        repository.create_session("capacity-oldest", now_ms - 20).unwrap();
        repository.end_session("capacity-oldest", now_ms - 19).unwrap();
        repository.create_session("capacity-newest", now_ms - 10).unwrap();
        repository.end_session("capacity-newest", now_ms - 9).unwrap();
        repository.create_session("active", now_ms).unwrap();
        let connection = repository.open().unwrap();
        connection
            .execute(
                "UPDATE subtitle_sessions SET audio_bytes = 100 WHERE id = 'capacity-oldest'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE subtitle_sessions SET audio_bytes = ?1 WHERE id = 'capacity-newest'",
                [RETENTION_MAX_BYTES],
            )
            .unwrap();
        drop(connection);

        assert_eq!(repository.run_retention(directory.path(), now_ms).unwrap(), 2);
        assert!(repository.get_session("expired").unwrap().is_none());
        assert!(repository.get_session("capacity-oldest").unwrap().is_none());
        assert!(repository.get_session("capacity-newest").unwrap().is_some());
        assert!(repository.get_session("active").unwrap().is_some());
    }

    #[test]
    fn active_capacity_pressure_pauses_audio_but_keeps_subtitle_writes() {
        let directory = tempfile::tempdir().unwrap();
        let repository = HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            HistoryCipher::for_test([23; 32]),
        )
        .unwrap();
        repository.create_session("active", 100).unwrap();
        repository
            .open()
            .unwrap()
            .execute(
                "UPDATE subtitle_sessions SET audio_bytes = ?1 WHERE id = 'active'",
                [RETENTION_MAX_BYTES + 1],
            )
            .unwrap();

        assert_eq!(repository.run_retention(directory.path(), 200).unwrap(), 0);
        assert!(!repository.audio_archive_allowed().unwrap());
        repository
            .upsert_cue(
                CueWrite {
                    session_id: "active",
                    cue_id: "cue-active",
                    sequence: 1,
                    revision: 1,
                    route_direction: "inbound",
                    source_text: "source remains durable",
                    translated_text: "字幕继续保存",
                    source_committed: true,
                    translation_committed: true,
                    started_at_ms: 110,
                    ended_at_ms: 120,
                },
                121,
            )
            .unwrap();
        assert_eq!(repository.list_cues("active", None, 50).unwrap().items.len(), 1);
    }

    #[test]
    fn retention_resumes_a_session_already_marked_deleting() {
        let directory = tempfile::tempdir().unwrap();
        let repository = HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            HistoryCipher::for_test([31; 32]),
        )
        .unwrap();
        repository.create_session("victim", 1).unwrap();
        repository.end_session("victim", 2).unwrap();
        let audio_path = directory.path().join("victim").join("source").join("00000001.flac.enc");
        std::fs::create_dir_all(audio_path.parent().unwrap()).unwrap();
        std::fs::write(&audio_path, b"encrypted").unwrap();
        repository
            .insert_audio_segment(AudioSegmentWrite {
                session_id: "victim",
                cue_refs: &[],
                track: "source",
                sequence: 1,
                started_at_ms: 1,
                duration_ms: 1,
                sample_rate_hz: 16_000,
                encrypted_path: &audio_path,
                encrypted_bytes: 9,
            })
            .unwrap();
        repository
            .open()
            .unwrap()
            .execute("UPDATE subtitle_sessions SET status = 'deleting' WHERE id = 'victim'", [])
            .unwrap();

        assert_eq!(repository.run_retention(directory.path(), 10).unwrap(), 0);
        assert!(!audio_path.exists());
        assert!(repository.get_session("victim").unwrap().is_none());
    }

    #[test]
    fn initialization_upgrades_early_schema_v1_audio_columns_in_place() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("subtitle-history.db");
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE subtitle_sessions (
                   id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
                   status TEXT NOT NULL DEFAULT 'active', cue_count INTEGER NOT NULL DEFAULT 0,
                   audio_bytes INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE subtitle_cues (
                   id TEXT PRIMARY KEY, session_id TEXT NOT NULL, cue_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                   route_direction TEXT NOT NULL, source_text_enc BLOB NOT NULL,
                   translated_text_enc BLOB NOT NULL, source_committed INTEGER NOT NULL,
                   translation_committed INTEGER NOT NULL, started_at_ms INTEGER NOT NULL,
                   ended_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
                   UNIQUE(session_id, cue_id)
                 );
                 CREATE TABLE subtitle_audio_segments (
                   id TEXT PRIMARY KEY, session_id TEXT NOT NULL, track TEXT NOT NULL,
                   sequence INTEGER NOT NULL, started_at_ms INTEGER NOT NULL,
                   duration_ms INTEGER NOT NULL, sample_rate INTEGER NOT NULL,
                   channels INTEGER NOT NULL, encrypted_path TEXT NOT NULL,
                   byte_size INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE subtitle_cue_audio_refs (
                   cue_id TEXT NOT NULL, audio_segment_id TEXT NOT NULL,
                   offset_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
                   track TEXT NOT NULL, PRIMARY KEY(cue_id, audio_segment_id, track)
                 );",
            )
            .unwrap();
        drop(connection);

        HistoryRepository::initialize(database_path.clone(), HistoryCipher::for_test([41; 32]))
            .unwrap();
        let connection = Connection::open(database_path).unwrap();
        for (table, column) in [
            ("subtitle_sessions", "archive_gap_count"),
            ("subtitle_cues", "runtime_sequence"),
            ("subtitle_cues", "runtime_revision"),
            ("subtitle_cue_audio_refs", "offset_samples"),
            ("subtitle_cue_audio_refs", "length_samples"),
        ] {
            let mut statement = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap();
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(columns.iter().any(|value| value == column));
        }
    }

    #[test]
    fn deleting_session_rejects_parent_directory_path_from_database() {
        let sandbox = tempfile::tempdir().unwrap();
        let history_dir = sandbox.path().join("history");
        let repository = HistoryRepository::initialize(
            history_dir.join("subtitle-history.db"),
            HistoryCipher::for_test([43; 32]),
        )
        .unwrap();
        repository.create_session("unsafe", 1).unwrap();
        repository.end_session("unsafe", 2).unwrap();
        let outside = sandbox.path().join("outside.flac.enc");
        std::fs::write(&outside, b"outside ciphertext").unwrap();
        let escaped_path = history_dir.join("..").join("outside.flac.enc");
        repository
            .insert_audio_segment(AudioSegmentWrite {
                session_id: "unsafe",
                cue_refs: &[],
                track: "source",
                sequence: 1,
                started_at_ms: 1,
                duration_ms: 1,
                sample_rate_hz: 16_000,
                encrypted_path: &escaped_path,
                encrypted_bytes: 18,
            })
            .unwrap();
        repository
            .open()
            .unwrap()
            .execute("UPDATE subtitle_sessions SET status = 'deleting' WHERE id = 'unsafe'", [])
            .unwrap();

        assert!(repository.run_retention(&history_dir, 10).is_err());
        assert!(outside.exists());
        assert!(repository.get_session("unsafe").unwrap().is_some());
    }
}
