use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::contracts::{ConfigExportArtifact, ConfigSnapshotRecord};
use crate::common::MapErrToString;

mod json_merge;
mod benchmark_history;
mod persisters;
mod persistence_methods;
mod schema;
mod snapshot_service;

pub(crate) use self::benchmark_history::BenchmarkHistorySaveInput;

use self::json_merge::{
    default_config_value, enforce_current_driver_contract, merge_objects, write_json_file,
};
use self::schema::{
    tables_cleared_on_save, CREATE_BENCHMARK_HISTORY_SCHEMA_SQL,
    CREATE_RELATIONAL_SCHEMA_SQL, CURRENT_SCHEMA_VERSION, OLD_CONFIG_TABLES,
    RELATIONAL_SCHEMA_NAME, RELATIONAL_TABLES,
};
use self::snapshot_service::ConfigSnapshotService;
use self::persisters::{
    AudioConfigPersister, PreferencesPersister, ProviderConfigPersister, RuntimeCachePersister,
};

const CONFIG_CONTRACT_VERSION: i64 = 2;

#[derive(Clone)]
pub(crate) struct ConfigRepository {
    db_path: PathBuf,
    export_dir: PathBuf,
    snapshot_dir: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct RepositoryStats {
    pub schema_version: i64,
    pub has_persisted_config: bool,
    pub snapshot_count: usize,
    pub last_saved_at: Option<String>,
    pub last_export_path: Option<String>,
    pub last_import_path: Option<String>,
}

impl ConfigRepository {
    pub(crate) fn new(db_path: PathBuf, export_dir: PathBuf, snapshot_dir: PathBuf) -> Self {
        Self {
            db_path,
            export_dir,
            snapshot_dir,
        }
    }

    #[allow(dead_code, reason = "schema version accessor is used by migration audit tooling")]
    pub(crate) fn current_schema_version() -> i64 {
        CURRENT_SCHEMA_VERSION
    }

    pub(crate) fn database_path(&self) -> &Path {
        &self.db_path
    }

    pub(crate) fn initialize(&self) -> Result<RepositoryStats, String> {
        self.ensure_directories()?;
        let connection = self.migrated_connection()?;
        self.read_stats(&connection)
    }

    /// Startup-only initialization.  Unlike ordinary repository opens, this
    /// recovers a process that exited while a benchmark was still marked
    /// `running`; config saves and ordinary history updates must never turn an
    /// active benchmark into an interrupted one.
    pub(crate) fn initialize_for_app_startup(&self) -> Result<RepositoryStats, String> {
        self.ensure_directories()?;
        let connection = self.migrated_connection()?;
        self.mark_stale_benchmark_runs_interrupted(&connection)?;
        self.read_stats(&connection)
    }

    pub(crate) fn load_config(&self) -> Result<Value, String> {
        let connection = self.migrated_connection()?;

        let defaults = default_config_value()?;
        let mut root = defaults.clone();
        let persisted: Option<String> = connection
            .query_row(
                "SELECT config_json FROM config_documents WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err_str()?;

        if let Some(config_json) = persisted {
            let stored: Value = serde_json::from_str(&config_json).map_err_str()?;
            merge_objects(&mut root, &stored);
            enforce_current_driver_contract(&mut root, &defaults);
        }

        Ok(root)
    }

    pub(crate) fn save_config(&self, config: &Value) -> Result<RepositoryStats, String> {
        let timestamp = current_timestamp();
        self.save_config_in_transaction(config, &timestamp, None)
    }

    fn save_config_in_transaction(
        &self,
        config: &Value,
        timestamp: &str,
        fail_on_step: Option<&str>,
    ) -> Result<RepositoryStats, String> {
        let mut connection = self.migrated_connection()?;

        let tx = connection.transaction().map_err_str()?;
        self.persist_config_with_failpoint(&tx, config, timestamp, fail_on_step)?;
        tx.commit().map_err_str()?;

        self.read_stats(&connection)
    }

    fn persist_config_with_failpoint(
        &self,
        conn: &Connection,
        config: &Value,
        timestamp: &str,
        fail_on_step: Option<&str>,
    ) -> Result<(), String> {
        let check = |step: &str| -> Result<(), String> {
            if fail_on_step == Some(step) {
                return Err(format!("failpoint triggered at {step}"));
            }
            Ok(())
        };

        check("clear_config_tables")?;
        self.clear_config_tables(conn)?;
        check("config_documents")?;
        self.upsert_config_document(conn, config, timestamp)?;
        check("providers")?;
        ProviderConfigPersister::new(self).persist(conn, config, timestamp)?;
        check("audio")?;
        AudioConfigPersister::new(self).persist(conn, config, timestamp)?;
        check("subtitles")?;
        PreferencesPersister::new(self).persist(conn, config, timestamp)?;
        check("speech")?;
        // Preferences are committed as one domain, while these individual
        // checkpoints remain for deterministic rollback tests.
        check("driver")?;
        check("glossary")?;
        check("diagnostics")?;
        check("onboarding")?;
        check("runtime_state_cache")?;
        RuntimeCachePersister::new(self).persist(conn, config, timestamp)?;
        check("last_saved_at")?;
        self.upsert_metadata(conn, "last_saved_at", timestamp, timestamp)?;

        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn save_config_with_failpoint(
        &self,
        config: &Value,
        fail_on_step: &str,
    ) -> Result<RepositoryStats, String> {
        let timestamp = current_timestamp();
        self.save_config_in_transaction(config, &timestamp, Some(fail_on_step))
    }

    pub(crate) fn reset_config(&self) -> Result<Value, String> {
        let default_config = default_config_value()?;
        self.save_config(&default_config)?;
        Ok(default_config)
    }

    pub(crate) fn export_config(&self) -> Result<ConfigExportArtifact, String> {
        let config = self.load_config()?;
        let connection = self.migrated_connection()?;
        let stats = self.read_stats(&connection)?;
        let exported_at = current_timestamp();
        let file_name = format!("config-export-{}.json", normalize_timestamp(&exported_at));
        let file_path = self.export_dir.join(file_name);
        let export_document = serde_json::json!({
            "configContractVersion": CONFIG_CONTRACT_VERSION,
            "exportedAt": exported_at,
            "config": config,
        });
        write_json_file(&file_path, &export_document)?;
        self.upsert_metadata(
            &connection,
            "last_export_path",
            &file_path.to_string_lossy(),
            &exported_at,
        )?;

        let exported_path = file_path.to_string_lossy().to_string();
        Ok(ConfigExportArtifact {
            file_path: exported_path.clone(),
            output_path: exported_path,
            file_count: 1,
            exported_at,
            config_contract_version: CONFIG_CONTRACT_VERSION,
            snapshot_count: stats.snapshot_count,
        })
    }

    pub(crate) fn import_config(&self, file_path: &Path) -> Result<Value, String> {
        let content = fs::read_to_string(file_path).map_err_str()?;
        let document: Value = serde_json::from_str(&content).map_err_str()?;
        let config = extract_imported_config(document)?;
        let snapshot = self.create_snapshot("before-v2-config-import")?;

        self.save_config(&config)?;
        let connection = self.migrated_connection()?;
        if let Err(error) = self.upsert_metadata(
            &connection,
            "last_import_path",
            &file_path.to_string_lossy(),
            &current_timestamp(),
        ) {
            let rollback_error = self.rollback_snapshot(&snapshot.snapshot_id).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "config import metadata update failed: {error}; rollback failed: {rollback_error}"
                ),
                None => format!("config import metadata update failed; restored previous snapshot: {error}"),
            });
        }
        self.load_config()
    }

    pub(crate) fn create_snapshot(&self, reason: &str) -> Result<ConfigSnapshotRecord, String> {
        ConfigSnapshotService::new(self).create(reason)
    }

    pub(crate) fn rollback_snapshot(&self, snapshot_id: &str) -> Result<Value, String> {
        ConfigSnapshotService::new(self).rollback(snapshot_id)
    }

    fn ensure_directories(&self) -> Result<(), String> {
        if let Some(parent) = self.db_path.parent() {
            fs::create_dir_all(parent).map_err_str()?;
        }
        fs::create_dir_all(&self.export_dir).map_err_str()?;
        fs::create_dir_all(&self.snapshot_dir).map_err_str()?;
        Ok(())
    }

    fn migrated_connection(&self) -> Result<Connection, String> {
        let connection = self.open_connection()?;
        self.apply_migrations(&connection)?;
        Ok(connection)
    }

    fn open_connection(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err_str()
    }

    fn apply_migrations(&self, connection: &Connection) -> Result<(), String> {
        connection
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS storage_migrations (
                  version INTEGER PRIMARY KEY,
                  name TEXT NOT NULL,
                  applied_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS storage_metadata (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                ",
            )
            .map_err_str()?;

        if self.schema_needs_reset(connection)? {
            self.rebuild_schema(connection)?;
        }
        if !table_has_column(
            connection,
            "audio_routes",
            "translated_audio_auto_gain_enabled",
        )? {
            connection
                .execute(
                    "ALTER TABLE audio_routes ADD COLUMN translated_audio_auto_gain_enabled INTEGER",
                    [],
                )
                .map_err_str()?;
        }
        connection
            .execute_batch(CREATE_BENCHMARK_HISTORY_SCHEMA_SQL)
            .map_err_str()?;

        connection
            .execute(
                "INSERT INTO storage_migrations (version, name, applied_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(version) DO UPDATE SET name = excluded.name",
                params![
                    CURRENT_SCHEMA_VERSION,
                    RELATIONAL_SCHEMA_NAME,
                    current_timestamp()
                ],
            )
            .map_err_str()?;

        Ok(())
    }

    fn schema_needs_reset(&self, connection: &Connection) -> Result<bool, String> {
        for old_table in OLD_CONFIG_TABLES {
            if table_exists(connection, old_table)?
                && table_has_column(connection, old_table, "payload_json")?
            {
                return Ok(true);
            }
        }

        for table in RELATIONAL_TABLES {
            if !table_exists(connection, table)? {
                return Ok(true);
            }
        }

        for column in [
            "inbound_voice_model_id",
            "outbound_voice_model_id",
            "text_to_speech_model_id",
            "feedback_loop_prevention",
            "virtual_render_device_id",
        ] {
            if !table_has_column(connection, "audio_device_preferences", column)? {
                return Ok(true);
            }
        }
        if !table_has_column(connection, "speech_preferences", "text_to_speech_model_id")? {
            return Ok(true);
        }

        Ok(false)
    }

    fn rebuild_schema(&self, connection: &Connection) -> Result<(), String> {
        connection
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err_str()?;

        for table in RELATIONAL_TABLES {
            connection
                .execute(&format!("DROP TABLE IF EXISTS {table}"), [])
                .map_err_str()?;
        }
        for table in OLD_CONFIG_TABLES {
            connection
                .execute(&format!("DROP TABLE IF EXISTS {table}"), [])
                .map_err_str()?;
        }

        connection
            .execute_batch(CREATE_RELATIONAL_SCHEMA_SQL)
            .map_err_str()?;
        Ok(())
    }

    fn read_stats(&self, connection: &Connection) -> Result<RepositoryStats, String> {
        let persisted_row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM config_documents", [], |row| {
                row.get(0)
            })
            .map_err_str()?;
        let snapshot_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM config_snapshots", [], |row| {
                row.get(0)
            })
            .map_err_str()?;

        Ok(RepositoryStats {
            schema_version: CURRENT_SCHEMA_VERSION,
            has_persisted_config: persisted_row_count > 0,
            snapshot_count: snapshot_count as usize,
            last_saved_at: self.read_metadata(connection, "last_saved_at")?,
            last_export_path: self.read_metadata(connection, "last_export_path")?,
            last_import_path: self.read_metadata(connection, "last_import_path")?,
        })
    }

    fn read_metadata(&self, connection: &Connection, key: &str) -> Result<Option<String>, String> {
        connection
            .query_row(
                "SELECT value FROM storage_metadata WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err_str()
    }

    fn upsert_metadata(
        &self,
        connection: &Connection,
        key: &str,
        value: &str,
        timestamp: &str,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT INTO storage_metadata (key, value, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, timestamp],
            )
            .map_err_str()?;

        Ok(())
    }

    fn clear_config_tables(&self, connection: &Connection) -> Result<(), String> {
        for table in tables_cleared_on_save() {
            connection
                .execute(&format!("DELETE FROM {table}"), [])
                .map_err_str()?;
        }

        Ok(())
    }

    fn upsert_config_document(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let config_json = serde_json::to_string(config).map_err_str()?;
        connection
            .execute(
                "INSERT INTO config_documents (id, schema_version, config_json, updated_at)
                 VALUES (1, ?1, ?2, ?3)",
                params![CURRENT_SCHEMA_VERSION, config_json, timestamp],
            )
            .map_err_str()?;
        Ok(())
    }

}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )
        .optional()
        .map_err_str()?;
    Ok(exists.is_some())
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err_str()?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err_str()?;

    for row in rows {
        if row.map_err_str()? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn insert_string_array(
    connection: &Connection,
    table: &str,
    owner_column: &str,
    owner_value: &str,
    value_column: &str,
    value: Option<&Value>,
) -> Result<(), String> {
    if let Some(items) = value.and_then(Value::as_array) {
        for (position, item) in items.iter().enumerate() {
            if let Some(item) = item.as_str() {
                let sql = format!(
                    "INSERT INTO {table} ({owner_column}, {value_column}, position) VALUES (?1, ?2, ?3)"
                );
                connection
                    .execute(&sql, params![owner_value, item, position as i64])
                    .map_err_str()?;
            }
        }
    }
    Ok(())
}

fn current_timestamp() -> String {
    crate::shared::time::now_unix_seconds_marker()
}

fn normalize_timestamp(timestamp: &str) -> String {
    timestamp.replace(':', "-")
}

fn extract_imported_config(document: Value) -> Result<Value, String> {
    let Some(version) = document
        .get("configContractVersion")
        .and_then(Value::as_i64)
    else {
        if document.is_object() {
            return Ok(document);
        }
        return Err("legacy config import must be a JSON object".to_string());
    };

    if version > CONFIG_CONTRACT_VERSION {
        return Err(format!(
            "config export version {version} is newer than supported version {CONFIG_CONTRACT_VERSION}"
        ));
    }

    let config = document
        .get("config")
        .cloned()
        .ok_or_else(|| format!("config export version {version} is missing its config document"))?;
    if !config.is_object() {
        return Err("config export document must contain an object config".to_string());
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, OptionalExtension};
    use serde_json::{json, Value};
    use tempfile::TempDir;

    use super::{default_config_value, table_exists, table_has_column, ConfigRepository};

    fn test_repository() -> (TempDir, ConfigRepository) {
        let temp_dir = TempDir::new().expect("temp dir should be created");
        let repository = ConfigRepository::new(
            temp_dir.path().join("db").join("omni-config.db"),
            temp_dir.path().join("exports"),
            temp_dir.path().join("snapshots"),
        );

        (temp_dir, repository)
    }

    fn initialized_repository() -> (TempDir, ConfigRepository) {
        let (temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");
        (temp_dir, repository)
    }

    fn repository_with_config_document(config_json: &str) -> (TempDir, ConfigRepository) {
        let (temp_dir, repository) = initialized_repository();
        let connection = repository
            .open_connection()
            .expect("connection should open");
        connection
            .execute(
                "INSERT INTO config_documents (id, schema_version, config_json, updated_at)
                 VALUES (1, 1, ?1, 'test')",
                params![config_json],
            )
            .expect("config document should insert");
        (temp_dir, repository)
    }

    #[test]
    fn initializes_relational_schema_only() {
        let (_temp_dir, repository) = test_repository();
        let stats = repository
            .initialize()
            .expect("repository should initialize");
        let connection = repository
            .open_connection()
            .expect("connection should open");

        assert_eq!(
            stats.schema_version,
            ConfigRepository::current_schema_version()
        );
        assert!(!stats.has_persisted_config);
        assert!(table_exists(&connection, "providers").expect("table check should pass"));
        assert!(table_exists(&connection, "config_documents").expect("table check should pass"));
        assert!(
            !table_exists(&connection, "provider_settings").expect("table check should pass"),
            "old payload table should not exist"
        );
    }

    #[test]
    fn smart_gain_column_migration_preserves_existing_config_document() {
        let (_temp_dir, repository) = test_repository();
        repository.initialize().expect("repository should initialize");
        let mut config = default_config_value().expect("default config should parse");
        config["devices"]["outputLevel"] = json!(73);
        repository.save_config(&config).expect("config should save");

        {
            let connection = repository.open_connection().expect("connection should open");
            connection
                .execute_batch(
                    "ALTER TABLE audio_routes DROP COLUMN translated_audio_auto_gain_enabled;",
                )
                .expect("v1 column shape should be simulated");
        }

        repository.initialize().expect("repository should migrate");
        let connection = repository.open_connection().expect("connection should open");
        assert!(
            table_has_column(
                &connection,
                "audio_routes",
                "translated_audio_auto_gain_enabled",
            )
            .expect("column check should pass")
        );
        let loaded = repository.load_config().expect("config should load");
        assert_eq!(loaded.pointer("/devices/outputLevel"), Some(&json!(73)));
        assert_eq!(
            loaded.pointer(
                "/devices/inboundRoute/mixControl/translatedAudioAutoGainEnabled",
            ),
            Some(&json!(true))
        );
    }

    #[test]
    fn missing_relational_table_triggers_schema_reset() {
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");

        {
            let connection = repository
                .open_connection()
                .expect("connection should open");
            // glossary_preferences was absent from the old hand-written
            // existence checklist; dropping it must now force a rebuild.
            connection
                .execute_batch("DROP TABLE glossary_preferences;")
                .expect("table should drop");
        }

        repository
            .initialize()
            .expect("repository should reinitialize");
        let connection = repository
            .open_connection()
            .expect("connection should open");
        assert!(
            table_exists(&connection, "glossary_preferences").expect("table check should pass"),
            "schema rebuild should restore every relational table"
        );
    }

    #[test]
    fn resets_legacy_payload_tables_without_migrating_data() {
        let (_temp_dir, repository) = test_repository();
        repository.ensure_directories().expect("dirs should exist");
        let connection = repository
            .open_connection()
            .expect("connection should open");
        connection
            .execute_batch(
                "
                CREATE TABLE provider_settings (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                INSERT INTO provider_settings (id, payload_json, updated_at)
                VALUES (1, '{\"provider\":{\"model\":\"legacy-model\"}}', 'legacy');
                ",
            )
            .expect("legacy schema should be created");

        let stats = repository
            .initialize()
            .expect("repository should reset old schema");
        let loaded = repository.load_config().expect("config should load");

        assert!(!stats.has_persisted_config);
        assert_ne!(
            loaded
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str()),
            Some("legacy-model")
        );
        assert!(!table_exists(&connection, "provider_settings").expect("table check should pass"));
    }

    #[test]
    fn default_config_loads_when_no_persisted_document_exists() {
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");

        let loaded = repository.load_config().expect("config should load");
        let default = default_config_value().expect("default config should parse");

        assert_eq!(
            loaded
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str()),
            default
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str())
        );
    }

    #[test]
    fn load_config_upgrades_stale_driver_contract_versions() {
        let (_temp_dir, repository) = repository_with_config_document(
            r#"{"driver":{"protocolVersion":"2026-05-10","expectedDriverVersion":"0.9.0-dev","expectedBridgeVersion":"0.1.0","targetDeviceId":"custom-device"}}"#,
        );

        let loaded = repository.load_config().expect("config should load");
        let default = default_config_value().expect("default config should parse");

        assert_eq!(
            loaded.pointer("/driver/protocolVersion"),
            default.pointer("/driver/protocolVersion")
        );
        assert_eq!(
            loaded.pointer("/driver/expectedDriverVersion"),
            default.pointer("/driver/expectedDriverVersion")
        );
        assert_eq!(
            loaded.pointer("/driver/expectedBridgeVersion"),
            default.pointer("/driver/expectedBridgeVersion")
        );
        assert_eq!(
            loaded
                .pointer("/driver/targetDeviceId")
                .and_then(Value::as_str),
            Some("custom-device")
        );
    }

    #[test]
    fn saves_relational_rows_and_loads_full_document() {
        let (_temp_dir, repository) = initialized_repository();

        let mut config = default_config_value().expect("default config should parse");
        config["providers"][0]["model"] = json!("qwen-relational-test");
        config["providers"][0]["responseModalities"] = json!(["text", "audio"]);
        config["providers"][0]["customHeaders"] = json!([
            {"id": "h1", "name": "X-Test", "value": "yes", "enabled": true}
        ]);
        config["providers"][0]["sceneModelAssignments"] = json!([
            {"scenario": "watch", "modelIds": ["watch-a", "watch-b"]}
        ]);
        config["providers"][0]["localModelCapabilityRegistry"] = json!([
            {"id": "cap-1", "modelId": "model-a", "capabilities": ["speech-to-text", "text-to-speech"]}
        ]);
        config["providers"][0]["modelCatalogCache"] = json!({
            "signature": "sig",
            "source": "runtime",
            "endpoint": "https://example.test/models",
            "fetchedAt": "unix:1",
            "error": null,
            "models": [
                {
                    "id": "model-a",
                    "displayName": "Model A",
                    "ownedBy": "local",
                    "createdAt": 1,
                    "capabilities": ["speech-to-text"],
                    "providerTemplateId": "template-a",
                    "providerTemplateName": "Template A"
                }
            ]
        });
        let provider_clone = config["providers"][0].clone();
        if let Some(providers) = config.get_mut("providers").and_then(|v| v.as_array_mut()) {
            providers.push(provider_clone);
        }

        let stats = repository.save_config(&config).expect("config should save");
        let loaded = repository.load_config().expect("config should load");
        let connection = repository
            .open_connection()
            .expect("connection should open");
        let provider_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))
            .expect("provider count should read");
        let header_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM provider_custom_headers", [], |row| {
                row.get(0)
            })
            .expect("header count should read");
        let scene_model_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM provider_scene_model_ids", [], |row| {
                row.get(0)
            })
            .expect("scene model count should read");

        assert!(stats.has_persisted_config);
        assert_eq!(provider_count, 2);
        assert_eq!(header_count, 2);
        assert_eq!(scene_model_count, 4);
        assert_eq!(
            loaded
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str()),
            Some("qwen-relational-test")
        );
        assert_eq!(
            loaded
                .pointer("/providers/0/customHeaders/0/name")
                .and_then(|value| value.as_str()),
            Some("X-Test")
        );
    }

    #[test]
    fn saves_audio_route_outputs_and_preferences() {
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");

        let mut config = default_config_value().expect("default config should parse");
        config["devices"]["routeMode"] = json!("game");
        config["devices"]["textToSpeechModelId"] = json!("template-a::tts-route-model");
        config["speech"]["textToSpeechModelId"] = json!("template-a::tts-speech-model");
        config["devices"]["inboundRoute"]["outputs"] = json!([
            {"targetId": "subtitle", "kind": "subtitle-engine", "enabled": true},
            {"targetId": "speaker", "kind": "speaker", "deviceId": "speaker-test", "enabled": true}
        ]);
        config["devices"]["outboundRoute"]["pushToTalk"]["hotkey"] = json!("Alt+T");

        repository.save_config(&config).expect("config should save");
        let connection = repository
            .open_connection()
            .expect("connection should open");
        let route_mode: String = connection
            .query_row(
                "SELECT route_mode FROM audio_device_preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("route mode should read");
        let output_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM audio_route_outputs", [], |row| {
                row.get(0)
            })
            .expect("output count should read");
        let hotkey: String = connection
            .query_row(
                "SELECT push_to_talk_hotkey FROM audio_routes WHERE direction_key = 'outbound'",
                [],
                |row| row.get(0),
            )
            .expect("hotkey should read");
        let device_tts_model: String = connection
            .query_row(
                "SELECT text_to_speech_model_id FROM audio_device_preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("device tts model should read");
        let speech_tts_model: String = connection
            .query_row(
                "SELECT text_to_speech_model_id FROM speech_preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("speech tts model should read");

        assert_eq!(route_mode, "game");
        assert_eq!(output_count, 4);
        assert_eq!(hotkey, "Alt+T");
        assert_eq!(device_tts_model, "template-a::tts-route-model");
        assert_eq!(speech_tts_model, "template-a::tts-speech-model");
    }

    #[test]
    fn all_config_sections_round_trip() {
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");

        let mut config = default_config_value().expect("default config should parse");
        config["subtitles"]["targetLanguage"] = json!("fr");
        config["speech"]["outputTarget"] = json!("both");
        config["driver"]["targetDeviceId"] = json!("virtual-mic-v2");
        config["driver"]["bridgeState"] = json!("running");
        config["glossary"]["activePackageIds"] = json!(["pkg1", "pkg2"]);
        config["diagnostics"]["lastExportScope"] = json!("full");
        config["diagnostics"]["providerStatus"] = json!("ready");
        config["onboarding"]["completedStepIds"] = json!(["step1", "step2"]);

        repository.save_config(&config).expect("config should save");
        let loaded = repository.load_config().expect("config should load");
        let connection = repository
            .open_connection()
            .expect("connection should open");
        let runtime_status: Option<String> = connection
            .query_row(
                "SELECT value FROM runtime_state_cache WHERE key = ?1",
                params!["diagnostics.providerStatus"],
                |row| row.get(0),
            )
            .optional()
            .expect("runtime cache should read");

        assert_eq!(
            loaded
                .pointer("/subtitles/targetLanguage")
                .and_then(|value| value.as_str()),
            Some("fr")
        );
        assert_eq!(
            loaded
                .pointer("/speech/outputTarget")
                .and_then(|value| value.as_str()),
            Some("both")
        );
        assert_eq!(
            loaded
                .pointer("/driver/bridgeState")
                .and_then(|value| value.as_str()),
            Some("running")
        );
        assert_eq!(
            loaded
                .pointer("/glossary/activePackageIds")
                .and_then(|value| value.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(runtime_status.as_deref(), Some("ready"));
    }

    #[test]
    fn save_config_rolls_back_all_sections_when_mid_save_fails() {
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");

        let mut base = default_config_value().expect("default config should parse");
        base["providers"][0]["model"] = json!("base-model");
        base["speech"]["outputTarget"] = json!("speaker");
        repository
            .save_config(&base)
            .expect("base config should persist");

        let mut changed = base.clone();
        changed["providers"][0]["model"] = json!("new-model");
        changed["speech"]["outputTarget"] = json!("both");

        let err = repository
            .save_config_with_failpoint(&changed, "speech")
            .expect_err("save should fail before commit");
        assert!(err.contains("failpoint"));

        let loaded = repository
            .load_config()
            .expect("config should load after rollback");
        assert_eq!(
            loaded
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str()),
            Some("base-model")
        );
        assert_eq!(
            loaded
                .pointer("/speech/outputTarget")
                .and_then(|value| value.as_str()),
            Some("speaker")
        );
    }

    #[test]
    fn exports_imports_snapshots_and_rolls_back() {
        let (_temp_dir, repository) = initialized_repository();

        let mut config = default_config_value().expect("default config should parse");
        config["providers"][0]["model"] = json!("snapshot-base");
        config["speech"]["outputTarget"] = json!("speaker");
        repository
            .save_config(&config)
            .expect("config should persist");

        let exported = repository.export_config().expect("config should export");
        assert_eq!(exported.config_contract_version, 2);
        let export_content = std::fs::read_to_string(&exported.file_path)
            .expect("export document should be readable");
        let export_document: Value = serde_json::from_str(&export_content)
            .expect("export document should parse");
        assert_eq!(
            export_document
                .get("configContractVersion")
                .and_then(Value::as_i64),
            Some(2)
        );
        config["providers"][0]["model"] = json!("snapshot-changed");
        repository
            .save_config(&config)
            .expect("config should persist update");

        let snapshot = repository
            .create_snapshot("before-import")
            .expect("snapshot should create");
        let imported = repository
            .import_config(std::path::Path::new(&exported.file_path))
            .expect("config should import");
        assert_eq!(
            imported
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str()),
            Some("snapshot-base")
        );

        let rolled_back = repository
            .rollback_snapshot(&snapshot.snapshot_id)
            .expect("snapshot should rollback");
        assert_eq!(
            rolled_back
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str()),
            Some("snapshot-changed")
        );
    }

    #[test]
    fn imports_legacy_config_documents_and_rejects_future_versions() {
        let (temp_dir, repository) = test_repository();
        repository.initialize().expect("repository should initialize");

        let mut legacy = default_config_value().expect("default config should parse");
        legacy["providers"][0]["model"] = json!("legacy-import-model");
        let legacy_path = temp_dir.path().join("legacy-config.json");
        std::fs::write(&legacy_path, serde_json::to_string(&legacy).expect("legacy should serialize"))
            .expect("legacy export should write");

        let imported = repository.import_config(&legacy_path).expect("legacy config should import");
        assert_eq!(
            imported.pointer("/providers/0/model").and_then(Value::as_str),
            Some("legacy-import-model")
        );

        let future_path = temp_dir.path().join("future-config.json");
        std::fs::write(
            &future_path,
            r#"{"configContractVersion":3,"config":{}}"#,
        )
        .expect("future export should write");
        let error = repository
            .import_config(&future_path)
            .expect_err("future config should be rejected");
        assert!(error.contains("newer than supported"));
    }

    #[test]
    fn load_merges_missing_document_fields_with_defaults() {
        let (_temp_dir, repository) = repository_with_config_document(
            r#"{"providers":[{"model":"partial-model"}]}"#,
        );

        let loaded = repository.load_config().expect("config should load");
        assert_eq!(
            loaded
                .pointer("/providers/0/model")
                .and_then(|value| value.as_str()),
            Some("partial-model")
        );
        assert!(
            loaded
                .pointer("/devices/inboundRoute/input/deviceId")
                .is_some(),
            "missing fields should be supplied by defaults"
        );
    }

    #[test]
    fn load_enables_missing_history_without_overwriting_model_selections() {
        let (_temp_dir, repository) = repository_with_config_document(
            r#"{
              "providers":[{"model":"persisted-provider-model"}],
              "devices":{
                "inboundVoiceModelId":"persisted-inbound-model",
                "outboundVoiceModelId":"persisted-outbound-model",
                "textToSpeechModelId":"persisted-tts-model"
              },
              "subtitles":{"targetLanguage":"ja"}
            }"#,
        );

        let loaded = repository.load_config().expect("config should load");
        assert_eq!(loaded.pointer("/subtitles/history/enabled").and_then(Value::as_bool), Some(true));
        assert_eq!(
            loaded.pointer("/subtitles/history/sourceAudioEnabled").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            loaded.pointer("/subtitles/history/translatedAudioEnabled").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            loaded.pointer("/providers/0/model").and_then(Value::as_str),
            Some("persisted-provider-model")
        );
        assert_eq!(
            loaded.pointer("/devices/inboundVoiceModelId").and_then(Value::as_str),
            Some("persisted-inbound-model")
        );
        assert_eq!(
            loaded.pointer("/devices/outboundVoiceModelId").and_then(Value::as_str),
            Some("persisted-outbound-model")
        );
        assert_eq!(
            loaded.pointer("/devices/textToSpeechModelId").and_then(Value::as_str),
            Some("persisted-tts-model")
        );
    }
}
