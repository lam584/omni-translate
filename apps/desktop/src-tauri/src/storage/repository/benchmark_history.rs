//! Durable, secret-free benchmark history storage.
//!
//! The benchmark report and score are intentionally stored as JSON rather
//! than being coupled to a particular scorer implementation.  This keeps the
//! database useful across score-detail additions while the explicit v1 marker
//! prevents old scoring systems from being compared with the new one.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use uuid::Uuid;

use crate::common::MapErrToString;
use crate::storage::contracts::{
    BenchmarkHistoryClearResult, BenchmarkHistoryDeleteResult, BenchmarkHistoryPage,
    BenchmarkHistoryRecord, BenchmarkHistorySummary,
};

use super::{current_timestamp, ConfigRepository};

pub(crate) const BENCHMARK_SCORE_VERSION: &str = "benchmark-score/v1";
const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 100;
const INTERRUPTED_RUN_ERROR: &str = "Benchmark process was interrupted before completion.";

/// Renderer-independent write input.  Required lifecycle fields make each
/// save a self-contained history snapshot; report/score are nullable because
/// a record is created before the benchmark has produced either payload.
#[derive(Clone, Debug)]
pub(crate) struct BenchmarkHistorySaveInput {
    pub record_id: Option<String>,
    pub run_id: String,
    pub model: String,
    pub run_status: String,
    pub score_status: String,
    pub score_version: Option<String>,
    pub total_score: Option<f64>,
    pub grade: Option<String>,
    pub report: Option<Value>,
    pub score: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug)]
struct BenchmarkHistoryRow {
    record_id: String,
    run_id: String,
    created_at: String,
    updated_at: String,
    model: String,
    run_status: String,
    score_status: String,
    score_version: Option<String>,
    total_score: Option<f64>,
    grade: Option<String>,
    report_json: Option<String>,
    score_json: Option<String>,
    error: Option<String>,
}

impl BenchmarkHistoryRow {
    fn into_record(self) -> Result<BenchmarkHistoryRecord, String> {
        Ok(BenchmarkHistoryRecord {
            record_id: self.record_id,
            run_id: self.run_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            model: self.model,
            run_status: self.run_status,
            score_status: self.score_status,
            score_version: self.score_version,
            total_score: self.total_score,
            grade: self.grade,
            report: parse_json_column(self.report_json, "report_json")?,
            score: parse_json_column(self.score_json, "score_json")?,
            error: self.error,
        })
    }

    fn into_summary(self) -> BenchmarkHistorySummary {
        BenchmarkHistorySummary {
            record_id: self.record_id,
            run_id: self.run_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            model: self.model,
            run_status: self.run_status,
            score_status: self.score_status,
            score_version: self.score_version,
            total_score: self.total_score,
            grade: self.grade,
            error: self.error,
        }
    }
}

impl ConfigRepository {
    pub(crate) fn save_benchmark_history(
        &self,
        input: BenchmarkHistorySaveInput,
    ) -> Result<BenchmarkHistoryRecord, String> {
        validate_history_input(&input)?;
        let connection = self.migrated_connection()?;
        let timestamp = current_timestamp();
        let record_id = match input.record_id.as_deref() {
            Some(record_id) => {
                let existing = find_history_by_record_id(&connection, record_id)?
                    .ok_or_else(|| format!("benchmark history record not found: {record_id}"))?;
                if existing.run_id != input.run_id {
                    return Err(format!(
                        "benchmark history record {record_id} belongs to run {}, not {}",
                        existing.run_id, input.run_id
                    ));
                }
                existing.record_id
            }
            None => find_history_by_run_id(&connection, &input.run_id)?
                .map(|existing| existing.record_id)
                .unwrap_or_else(new_history_record_id),
        };

        let report_json = serialize_history_json(input.report)?;
        let score_json = serialize_history_json(input.score)?;
        let error = input.error.as_deref().map(sanitize_error_text);
        let score_version = input
            .score_version
            .as_deref()
            .unwrap_or(BENCHMARK_SCORE_VERSION);

        connection
            .execute(
                "INSERT INTO benchmark_history (
                    record_id, run_id, created_at, updated_at, model, run_status,
                    score_status, score_version, total_score, grade, report_json,
                    score_json, error
                 ) VALUES (
                    ?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
                 )
                 ON CONFLICT(record_id) DO UPDATE SET
                    run_id = excluded.run_id,
                    updated_at = excluded.updated_at,
                    model = excluded.model,
                    run_status = excluded.run_status,
                    score_status = excluded.score_status,
                    score_version = excluded.score_version,
                    total_score = excluded.total_score,
                    grade = excluded.grade,
                    report_json = excluded.report_json,
                    score_json = excluded.score_json,
                    error = excluded.error",
                params![
                    record_id,
                    input.run_id,
                    timestamp,
                    input.model,
                    input.run_status,
                    input.score_status,
                    score_version,
                    input.total_score,
                    input.grade,
                    report_json,
                    score_json,
                    error,
                ],
            )
            .map_err_str()?;

        self.get_benchmark_history(&record_id)
    }

    pub(crate) fn get_benchmark_history(
        &self,
        record_id: &str,
    ) -> Result<BenchmarkHistoryRecord, String> {
        let connection = self.migrated_connection()?;
        find_history_by_record_id(&connection, record_id)?
            .ok_or_else(|| format!("benchmark history record not found: {record_id}"))?
            .into_record()
    }

    pub(crate) fn list_benchmark_history(
        &self,
        page: Option<u32>,
        page_size: Option<u32>,
    ) -> Result<BenchmarkHistoryPage, String> {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        let offset = (u64::from(page) - 1)
            .saturating_mul(u64::from(page_size))
            .min(i64::MAX as u64) as i64;
        let connection = self.migrated_connection()?;
        let total_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM benchmark_history", [], |row| row.get(0))
            .map_err_str()?;
        let mut statement = connection
            .prepare(
                "SELECT record_id, run_id, created_at, updated_at, model, run_status,
                        score_status, score_version, total_score, grade, report_json,
                        score_json, error
                 FROM benchmark_history
                 ORDER BY created_at DESC, record_id DESC
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err_str()?;
        let rows = statement
            .query_map(params![i64::from(page_size), offset], row_to_history)
            .map_err_str()?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err_str()?.into_summary());
        }

        Ok(BenchmarkHistoryPage {
            records,
            page,
            page_size,
            total_count: total_count.max(0) as u64,
        })
    }

    pub(crate) fn delete_benchmark_history(
        &self,
        record_id: &str,
    ) -> Result<BenchmarkHistoryDeleteResult, String> {
        let connection = self.migrated_connection()?;
        let deleted = connection
            .execute(
                "DELETE FROM benchmark_history WHERE record_id = ?1",
                params![record_id],
            )
            .map_err_str()?;
        Ok(BenchmarkHistoryDeleteResult {
            deleted: deleted > 0,
        })
    }

    pub(crate) fn clear_benchmark_history(&self) -> Result<BenchmarkHistoryClearResult, String> {
        let connection = self.migrated_connection()?;
        let deleted_count = connection
            .execute("DELETE FROM benchmark_history", [])
            .map_err_str()?;
        Ok(BenchmarkHistoryClearResult {
            deleted_count: deleted_count as u64,
        })
    }

    /// Called only during application startup, after migrations have created
    /// the table.  It never runs from ordinary history writes, so an active
    /// benchmark remains active while it persists progress.
    pub(crate) fn mark_stale_benchmark_runs_interrupted(
        &self,
        connection: &Connection,
    ) -> Result<u64, String> {
        let updated = connection
            .execute(
                "UPDATE benchmark_history
                 SET run_status = 'interrupted',
                     score_status = CASE
                       WHEN score_status = 'pending' THEN 'benchmark-failed'
                       ELSE score_status
                     END,
                     error = COALESCE(error, ?1),
                     updated_at = ?2
                 WHERE run_status = 'running'",
                params![INTERRUPTED_RUN_ERROR, current_timestamp()],
            )
            .map_err_str()?;
        Ok(updated as u64)
    }
}

fn new_history_record_id() -> String {
    format!("benchmark-history-{}", Uuid::now_v7().simple())
}

fn validate_history_input(input: &BenchmarkHistorySaveInput) -> Result<(), String> {
    if input.run_id.trim().is_empty() {
        return Err("benchmark history runId must not be empty".to_string());
    }
    if input.model.trim().is_empty() {
        return Err("benchmark history model must not be empty".to_string());
    }
    if let Some(record_id) = input.record_id.as_deref() {
        if record_id.trim().is_empty() {
            return Err("benchmark history recordId must not be empty".to_string());
        }
    }
    if !matches!(
        input.run_status.as_str(),
        "running" | "completed" | "failed" | "interrupted"
    ) {
        return Err(format!(
            "unsupported benchmark history runStatus: {}",
            input.run_status
        ));
    }
    if !matches!(
        input.score_status.as_str(),
        "pending"
            | "judging"
            | "final"
            | "evidence-insufficient"
            | "judge-failed"
            | "benchmark-failed"
    ) {
        return Err(format!(
            "unsupported benchmark history scoreStatus: {}",
            input.score_status
        ));
    }
    if let Some(score_version) = input.score_version.as_deref() {
        if score_version != BENCHMARK_SCORE_VERSION {
            return Err(format!(
                "unsupported benchmark score version: {score_version}; expected {BENCHMARK_SCORE_VERSION}"
            ));
        }
    }
    if let Some(total_score) = input.total_score {
        if !total_score.is_finite() || !(0.0..=100.0).contains(&total_score) {
            return Err("benchmark history totalScore must be a finite number from 0 to 100".to_string());
        }
    }
    if let Some(grade) = input.grade.as_deref() {
        if !matches!(grade, "A" | "B" | "C" | "D" | "F") {
            return Err(format!("unsupported benchmark history grade: {grade}"));
        }
    }
    if input.score_status == "final" {
        if input.run_status != "completed" {
            return Err("a final benchmark score requires a completed run".to_string());
        }
        if input.total_score.is_none() || input.grade.is_none() {
            return Err("a final benchmark score requires totalScore and grade".to_string());
        }
    } else if input.total_score.is_some() || input.grade.is_some() {
        return Err("totalScore and grade are only allowed for a final benchmark score".to_string());
    }
    Ok(())
}

fn find_history_by_record_id(
    connection: &Connection,
    record_id: &str,
) -> Result<Option<BenchmarkHistoryRow>, String> {
    connection
        .query_row(
            "SELECT record_id, run_id, created_at, updated_at, model, run_status,
                    score_status, score_version, total_score, grade, report_json,
                    score_json, error
             FROM benchmark_history WHERE record_id = ?1",
            params![record_id],
            row_to_history,
        )
        .optional()
        .map_err_str()
}

fn find_history_by_run_id(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<BenchmarkHistoryRow>, String> {
    connection
        .query_row(
            "SELECT record_id, run_id, created_at, updated_at, model, run_status,
                    score_status, score_version, total_score, grade, report_json,
                    score_json, error
             FROM benchmark_history WHERE run_id = ?1",
            params![run_id],
            row_to_history,
        )
        .optional()
        .map_err_str()
}

fn row_to_history(row: &Row<'_>) -> rusqlite::Result<BenchmarkHistoryRow> {
    Ok(BenchmarkHistoryRow {
        record_id: row.get(0)?,
        run_id: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        model: row.get(4)?,
        run_status: row.get(5)?,
        score_status: row.get(6)?,
        score_version: row.get(7)?,
        total_score: row.get(8)?,
        grade: row.get(9)?,
        report_json: row.get(10)?,
        score_json: row.get(11)?,
        error: row.get(12)?,
    })
}

fn serialize_history_json(value: Option<Value>) -> Result<Option<String>, String> {
    value
        .map(strip_sensitive_json)
        .map(|value| serde_json::to_string(&value).map_err(|error| error.to_string()))
        .transpose()
}

fn parse_json_column(value: Option<String>, column: &str) -> Result<Option<Value>, String> {
    value
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| format!("benchmark history {column} is invalid JSON: {error}"))
        })
        .transpose()
}

/// Remove credential-shaped properties at every nesting depth before a report
/// ever reaches SQLite.  This keeps the scorer flexible without making the
/// history table a second credential store.
fn strip_sensitive_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(strip_sensitive_json).collect()),
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .filter(|(key, _)| !is_sensitive_key(key))
                .map(|(key, value)| (key, strip_sensitive_json(value)))
                .collect(),
        ),
        other => other,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "xapikey"
            | "proxyauthorization"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "authtoken"
            | "oauthtoken"
            | "bearertoken"
            | "securitytoken"
            | "xamzsecuritytoken"
            | "cookie"
            | "setcookie"
            | "passwd"
            | "apisecret"
            | "appsecret"
            | "clientsecret"
            | "accesskeysecret"
            | "credential"
            | "credentials"
            | "credentialsecret"
            | "authheader"
    ) || normalized.contains("apikey")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("authorization")
        || (normalized.ends_with("token") && normalized != "firsttoken")
        || normalized.ends_with("cookie")
}

fn sanitize_error_text(error: &str) -> String {
    let normalized = error.to_ascii_lowercase();
    if [
        "api key",
        "api_key",
        "api-key",
        "apikey",
        "x-api-key",
        "authorization:",
        "authorization=",
        "bearer ",
        "password=",
        "password:",
        "secret=",
        "secret:",
        "access_token",
        "access-token",
        "refresh_token",
        "refresh-token",
        "token=",
        "token:",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
        || crate::diagnostics::redaction::sanitize_text(error) != error
    {
        "[redacted: benchmark error may contain credential material]".to_string()
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tempfile::TempDir;

    use super::{
        sanitize_error_text, strip_sensitive_json, BenchmarkHistorySaveInput, ConfigRepository,
        BENCHMARK_SCORE_VERSION,
    };

    fn repository() -> (TempDir, ConfigRepository) {
        let temp_dir = TempDir::new().expect("temp dir should be created");
        let repository = ConfigRepository::new(
            temp_dir.path().join("db").join("omni-config.db"),
            temp_dir.path().join("exports"),
            temp_dir.path().join("snapshots"),
        );
        repository.initialize().expect("repository should initialize");
        (temp_dir, repository)
    }

    fn save_input(run_id: &str) -> BenchmarkHistorySaveInput {
        BenchmarkHistorySaveInput {
            record_id: None,
            run_id: run_id.to_string(),
            model: "test-model".to_string(),
            run_status: "running".to_string(),
            score_status: "pending".to_string(),
            score_version: None,
            total_score: None,
            grade: None,
            report: Some(json!({"run": run_id})),
            score: None,
            error: None,
        }
    }

    #[test]
    fn saves_lists_updates_and_reads_secret_free_history() {
        let (_temp_dir, repository) = repository();
        let mut input = save_input("run-1");
        input.report = Some(json!({
            "apiKey": "must-not-persist",
            "details": {"Authorization": "Bearer must-not-persist", "kept": true}
        }));
        input.score = Some(json!({"nested": {"x-api-key": "must-not-persist", "value": 91}}));
        let created = repository
            .save_benchmark_history(input)
            .expect("history record should save");

        assert_eq!(created.score_version.as_deref(), Some(BENCHMARK_SCORE_VERSION));
        assert!(created.report.as_ref().unwrap().get("apiKey").is_none());
        assert!(created.report.as_ref().unwrap()["details"].get("Authorization").is_none());
        assert_eq!(created.report.as_ref().unwrap()["details"]["kept"], true);
        assert!(created.score.as_ref().unwrap()["nested"].get("x-api-key").is_none());

        let mut completed = save_input("run-1");
        completed.record_id = Some(created.record_id.clone());
        completed.run_status = "completed".to_string();
        completed.score_status = "final".to_string();
        completed.total_score = Some(91.0);
        completed.grade = Some("A".to_string());
        completed.report = Some(json!({"completed": true}));
        completed.score = Some(json!({"version": BENCHMARK_SCORE_VERSION, "total": 91}));
        let updated = repository
            .save_benchmark_history(completed)
            .expect("history record should update");

        assert_eq!(updated.record_id, created.record_id);
        assert_eq!(updated.created_at, created.created_at);
        assert_eq!(updated.run_status, "completed");
        assert_eq!(updated.score_status, "final");
        assert_eq!(updated.total_score, Some(91.0));
        assert_eq!(updated.grade.as_deref(), Some("A"));

        let page = repository
            .list_benchmark_history(Some(1), Some(50))
            .expect("history should list");
        assert_eq!(page.total_count, 1);
        assert_eq!(page.records[0].record_id, created.record_id);
        assert_eq!(page.records[0].total_score, Some(91.0));
        let loaded = repository
            .get_benchmark_history(&created.record_id)
            .expect("history detail should load");
        assert_eq!(loaded.score.as_ref().unwrap()["total"], 91);
    }

    #[test]
    fn history_survives_config_saves_and_paginates_newest_first() {
        let (_temp_dir, repository) = repository();
        let first = repository
            .save_benchmark_history(save_input("run-1"))
            .expect("first history record should save");
        let second = repository
            .save_benchmark_history(save_input("run-2"))
            .expect("second history record should save");
        let config = super::super::default_config_value().expect("default config should parse");
        repository.save_config(&config).expect("config should save");

        let first_page = repository
            .list_benchmark_history(Some(1), Some(1))
            .expect("first page should load");
        let second_page = repository
            .list_benchmark_history(Some(2), Some(1))
            .expect("second page should load");
        assert_eq!(first_page.total_count, 2);
        assert_eq!(first_page.records.len(), 1);
        assert_eq!(second_page.records.len(), 1);
        assert_ne!(first_page.records[0].record_id, second_page.records[0].record_id);
        let ids = [
            first_page.records[0].record_id.as_str(),
            second_page.records[0].record_id.as_str(),
        ];
        assert!(ids.contains(&first.record_id.as_str()));
        assert!(ids.contains(&second.record_id.as_str()));
    }

    #[test]
    fn deletes_one_history_record_and_clears_the_rest() {
        let (_temp_dir, repository) = repository();
        let first = repository
            .save_benchmark_history(save_input("run-delete-1"))
            .expect("first history record should save");
        let second = repository
            .save_benchmark_history(save_input("run-delete-2"))
            .expect("second history record should save");

        assert!(repository
            .delete_benchmark_history(&first.record_id)
            .expect("single delete should succeed")
            .deleted);
        assert!(!repository
            .delete_benchmark_history(&first.record_id)
            .expect("repeated delete should succeed")
            .deleted);
        assert_eq!(
            repository
                .list_benchmark_history(None, None)
                .expect("remaining history should list")
                .total_count,
            1
        );

        let cleared = repository
            .clear_benchmark_history()
            .expect("clear should succeed");
        assert_eq!(cleared.deleted_count, 1);
        assert!(repository
            .get_benchmark_history(&second.record_id)
            .is_err());
    }

    #[test]
    fn history_migration_does_not_reset_an_existing_config_document() {
        let (_temp_dir, repository) = repository();
        let mut config = super::super::default_config_value().expect("default config should parse");
        config["providers"][0]["model"] = json!("history-migration-model");
        repository.save_config(&config).expect("config should save");

        let connection = repository
            .open_connection()
            .expect("connection should open for v2 simulation");
        connection
            .execute_batch("DROP TABLE benchmark_history;")
            .expect("history table should drop for v2 simulation");

        repository
            .initialize()
            .expect("history migration should initialize without a config reset");
        let restored = repository
            .get_benchmark_history("does-not-exist")
            .expect_err("newly-created history table should be queryable");
        assert!(restored.contains("not found"));
        let loaded = repository.load_config().expect("config should still load");
        assert_eq!(
            loaded.pointer("/providers/0/model").and_then(Value::as_str),
            Some("history-migration-model")
        );
    }

    #[test]
    fn startup_recovery_marks_only_running_records_interrupted() {
        let (_temp_dir, repository) = repository();
        let running = repository
            .save_benchmark_history(save_input("run-running"))
            .expect("running history record should save");
        let mut completed = save_input("run-completed");
        completed.run_status = "completed".to_string();
        completed.score_status = "evidence-insufficient".to_string();
        let completed = repository
            .save_benchmark_history(completed)
            .expect("completed history record should save");
        let mut judging = save_input("run-judging");
        judging.score_status = "judging".to_string();
        let judging = repository
            .save_benchmark_history(judging)
            .expect("judging history record should save");

        repository
            .initialize_for_app_startup()
            .expect("startup recovery should succeed");
        let interrupted = repository
            .get_benchmark_history(&running.record_id)
            .expect("running history record should load");
        let unchanged = repository
            .get_benchmark_history(&completed.record_id)
            .expect("completed history record should load");
        let interrupted_judging = repository
            .get_benchmark_history(&judging.record_id)
            .expect("judging history record should load");
        assert_eq!(interrupted.run_status, "interrupted");
        assert_eq!(interrupted.score_status, "benchmark-failed");
        assert!(interrupted.error.is_some());
        assert_eq!(unchanged.run_status, "completed");
        assert_eq!(unchanged.score_status, "evidence-insufficient");
        assert_eq!(interrupted_judging.run_status, "interrupted");
        assert_eq!(interrupted_judging.score_status, "judging");
    }

    #[test]
    fn rejects_old_score_versions_and_invalid_lifecycle_values() {
        let (_temp_dir, repository) = repository();
        let mut old_version = save_input("run-old-version");
        old_version.score_version = Some("legacy-score/v0".to_string());
        assert!(repository.save_benchmark_history(old_version).is_err());

        let mut invalid_status = save_input("run-invalid-status");
        invalid_status.score_status = "unknown".to_string();
        assert!(repository.save_benchmark_history(invalid_status).is_err());

        let mut unofficial_total = save_input("run-unofficial-total");
        unofficial_total.total_score = Some(50.0);
        assert!(repository.save_benchmark_history(unofficial_total).is_err());

        let mut incomplete_final = save_input("run-incomplete-final");
        incomplete_final.run_status = "completed".to_string();
        incomplete_final.score_status = "final".to_string();
        incomplete_final.total_score = Some(90.0);
        assert!(repository.save_benchmark_history(incomplete_final).is_err());
    }

    #[test]
    fn strips_sensitive_json_keys_at_every_depth() {
        let sanitized = strip_sensitive_json(json!({
            "secret": "top-level",
            "api-key-value": "variant",
            "safe": [{"refresh_token": "nested", "value": "kept"}],
            "headers": {"X-Api-Key": "header", "Content-Type": "application/json"},
            "metadata": {"secretValue": "variant", "kept": true},
            "sessionToken": "variant",
            "firstToken": {"good": 2000, "bad": 8000}
        }));
        assert!(sanitized.get("secret").is_none());
        assert!(sanitized.get("api-key-value").is_none());
        assert!(sanitized["safe"][0].get("refresh_token").is_none());
        assert_eq!(sanitized["safe"][0]["value"], "kept");
        assert!(sanitized["headers"].get("X-Api-Key").is_none());
        assert_eq!(sanitized["headers"]["Content-Type"], "application/json");
        assert!(sanitized["metadata"].get("secretValue").is_none());
        assert_eq!(sanitized["metadata"]["kept"], true);
        assert!(sanitized.get("sessionToken").is_none());
        assert_eq!(sanitized["firstToken"]["good"], 2000);
    }

    #[test]
    fn redacts_credential_shaped_errors() {
        for error in [
            "request failed: x-api-key: must-not-persist",
            "request failed: authorization=Bearer must-not-persist",
            "request failed: access_token=must-not-persist",
            "request failed: client_secret=must-not-persist",
            "request failed: Authorization: Token must-not-persist",
        ] {
            assert_eq!(
                sanitize_error_text(error),
                "[redacted: benchmark error may contain credential material]"
            );
        }

        assert_eq!(sanitize_error_text("request timed out"), "request timed out");
    }
}
