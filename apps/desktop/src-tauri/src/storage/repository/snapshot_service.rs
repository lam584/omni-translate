use rusqlite::params;
use serde_json::Value;

use crate::common::MapErrToString;

use super::json_merge::write_json_file;
use super::{current_timestamp, normalize_timestamp, ConfigRepository};
use crate::storage::contracts::ConfigSnapshotRecord;

/// Owns durable configuration snapshots while `ConfigRepository` retains the
/// database/transaction facade used by the rest of the application.
pub(super) struct ConfigSnapshotService<'a> {
    repository: &'a ConfigRepository,
}

impl<'a> ConfigSnapshotService<'a> {
    pub(super) fn new(repository: &'a ConfigRepository) -> Self {
        Self { repository }
    }

    pub(super) fn create(&self, reason: &str) -> Result<ConfigSnapshotRecord, String> {
        let config = self.repository.load_config()?;
        let connection = self.repository.migrated_connection()?;
        let created_at = current_timestamp();
        let base_snapshot_id = format!("snapshot-{}", normalize_timestamp(&created_at));
        let config_json = serde_json::to_string_pretty(&config).map_err_str()?;
        let mut collision_index = 0_u32;
        let snapshot_id = loop {
            let candidate = if collision_index == 0 {
                base_snapshot_id.clone()
            } else {
                format!("{base_snapshot_id}-{collision_index}")
            };
            match connection.execute(
                "INSERT INTO config_snapshots (snapshot_id, reason, config_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![&candidate, reason, &config_json, &created_at],
            ) {
                Ok(_) => break candidate,
                Err(error)
                    if error
                        .to_string()
                        .contains("UNIQUE constraint failed: config_snapshots.snapshot_id") =>
                {
                    collision_index += 1;
                }
                Err(error) => return Err(error.to_string()),
            }
        };

        write_json_file(
            &self.repository.snapshot_dir.join(format!("{snapshot_id}.json")),
            &config,
        )?;
        Ok(ConfigSnapshotRecord {
            snapshot_id,
            reason: reason.to_string(),
            created_at,
        })
    }

    pub(super) fn rollback(&self, snapshot_id: &str) -> Result<Value, String> {
        let connection = self.repository.migrated_connection()?;
        let config_json: String = connection
            .query_row(
                "SELECT config_json FROM config_snapshots WHERE snapshot_id = ?1",
                params![snapshot_id],
                |row| row.get(0),
            )
            .map_err_str()?;
        let config: Value = serde_json::from_str(&config_json).map_err_str()?;
        self.repository.save_config(&config)?;
        self.repository.load_config()
    }
}
