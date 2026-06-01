use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::contracts::{ConfigExportArtifact, ConfigSnapshotRecord};

const CURRENT_SCHEMA_VERSION: i64 = 1;
const RELATIONAL_SCHEMA_NAME: &str = "0001_relational_config_storage";
const DEFAULT_CONFIG_JSON: &str = include_str!("../../defaults/app-config.default.json");

const OLD_CONFIG_TABLES: [&str; 10] = [
    "provider_settings",
    "provider_probe_cache",
    "audio_preferences",
    "driver_runtime",
    "glossary_bindings",
    "diagnostic_preferences",
    // These names are reused by the relational schema, but old versions used
    // incompatible single-row payload_json definitions.
    "audio_routes",
    "subtitle_preferences",
    "speech_preferences",
    "onboarding_state",
];

const RELATIONAL_TABLES: [&str; 27] = [
    "config_documents",
    "runtime_state_cache",
    "provider_model_catalog_item_capabilities",
    "provider_model_catalog_items",
    "provider_model_catalog_cache",
    "provider_model_capabilities",
    "provider_scene_model_ids",
    "provider_scene_model_assignments",
    "provider_response_modalities",
    "provider_custom_headers",
    "provider_auth_refs",
    "providers",
    "audio_route_outputs",
    "audio_routes",
    "audio_device_preferences",
    "subtitle_preferences",
    "speech_preferences",
    "driver_preferences",
    "diagnostic_preferences",
    "glossary_injection_order",
    "glossary_community_packages",
    "glossary_active_packages",
    "glossary_preferences",
    "onboarding_unresolved_risks",
    "onboarding_completed_steps",
    "onboarding_state",
    "config_snapshots",
];

#[derive(Clone)]
pub struct ConfigRepository {
    db_path: PathBuf,
    export_dir: PathBuf,
    snapshot_dir: PathBuf,
}

#[derive(Clone, Debug)]
pub struct RepositoryStats {
    pub schema_version: i64,
    pub has_persisted_config: bool,
    pub snapshot_count: usize,
    pub last_saved_at: Option<String>,
    pub last_export_path: Option<String>,
    pub last_import_path: Option<String>,
}

impl ConfigRepository {
    pub fn new(db_path: PathBuf, export_dir: PathBuf, snapshot_dir: PathBuf) -> Self {
        Self {
            db_path,
            export_dir,
            snapshot_dir,
        }
    }

    #[allow(dead_code)]
    pub fn current_schema_version() -> i64 {
        CURRENT_SCHEMA_VERSION
    }

    pub fn database_path(&self) -> &Path {
        &self.db_path
    }

    pub fn initialize(&self) -> Result<RepositoryStats, String> {
        self.ensure_directories()?;
        let connection = self.open_connection()?;
        self.apply_migrations(&connection)?;
        self.read_stats(&connection)
    }

    pub fn load_config(&self) -> Result<Value, String> {
        let connection = self.open_connection()?;
        self.apply_migrations(&connection)?;

        let mut root = default_config_value()?;
        let persisted: Option<String> = connection
            .query_row(
                "SELECT config_json FROM config_documents WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;

        if let Some(config_json) = persisted {
            let stored: Value =
                serde_json::from_str(&config_json).map_err(|error| error.to_string())?;
            merge_objects(&mut root, &stored);
        }

        Ok(root)
    }

    pub fn save_config(&self, config: &Value) -> Result<RepositoryStats, String> {
        let timestamp = current_timestamp();
        self.save_config_in_transaction(config, &timestamp, None)
    }

    fn save_config_in_transaction(
        &self,
        config: &Value,
        timestamp: &str,
        fail_on_step: Option<&str>,
    ) -> Result<RepositoryStats, String> {
        let mut connection = self.open_connection()?;
        self.apply_migrations(&connection)?;

        let tx = connection.transaction().map_err(|e| e.to_string())?;
        self.persist_config_with_failpoint(&tx, config, timestamp, fail_on_step)?;
        tx.commit().map_err(|e| e.to_string())?;

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
        self.persist_providers(conn, config, timestamp)?;
        check("audio")?;
        self.persist_audio(conn, config, timestamp)?;
        check("subtitles")?;
        self.persist_subtitles(conn, config, timestamp)?;
        check("speech")?;
        self.persist_speech(conn, config, timestamp)?;
        check("driver")?;
        self.persist_driver(conn, config, timestamp)?;
        check("glossary")?;
        self.persist_glossary(conn, config, timestamp)?;
        check("diagnostics")?;
        self.persist_diagnostics(conn, config, timestamp)?;
        check("onboarding")?;
        self.persist_onboarding(conn, config, timestamp)?;
        check("runtime_state_cache")?;
        self.persist_runtime_cache(conn, config, timestamp)?;
        check("last_saved_at")?;
        self.upsert_metadata(conn, "last_saved_at", timestamp, timestamp)?;

        Ok(())
    }

    #[cfg(test)]
    pub fn save_config_with_failpoint(
        &self,
        config: &Value,
        fail_on_step: &str,
    ) -> Result<RepositoryStats, String> {
        let timestamp = current_timestamp();
        self.save_config_in_transaction(config, &timestamp, Some(fail_on_step))
    }

    pub fn reset_config(&self) -> Result<Value, String> {
        let default_config = default_config_value()?;
        self.save_config(&default_config)?;
        Ok(default_config)
    }

    pub fn export_config(&self) -> Result<ConfigExportArtifact, String> {
        let config = self.load_config()?;
        let connection = self.open_connection()?;
        self.apply_migrations(&connection)?;
        let stats = self.read_stats(&connection)?;
        let exported_at = current_timestamp();
        let file_name = format!("config-export-{}.json", normalize_timestamp(&exported_at));
        let file_path = self.export_dir.join(file_name);
        write_json_file(&file_path, &config)?;
        self.upsert_metadata(
            &connection,
            "last_export_path",
            &file_path.to_string_lossy(),
            &exported_at,
        )?;

        Ok(ConfigExportArtifact {
            file_path: file_path.to_string_lossy().to_string(),
            exported_at,
            snapshot_count: stats.snapshot_count,
        })
    }

    pub fn import_config(&self, file_path: &Path) -> Result<Value, String> {
        let content = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
        let config: Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
        self.save_config(&config)?;

        let connection = self.open_connection()?;
        self.apply_migrations(&connection)?;
        self.upsert_metadata(
            &connection,
            "last_import_path",
            &file_path.to_string_lossy(),
            &current_timestamp(),
        )?;
        Ok(self.load_config()?)
    }

    pub fn create_snapshot(&self, reason: &str) -> Result<ConfigSnapshotRecord, String> {
        let config = self.load_config()?;
        let connection = self.open_connection()?;
        self.apply_migrations(&connection)?;
        let created_at = current_timestamp();
        let snapshot_id = format!("snapshot-{}", normalize_timestamp(&created_at));

        connection
            .execute(
                "INSERT INTO config_snapshots (snapshot_id, reason, config_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    snapshot_id,
                    reason,
                    serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?,
                    created_at
                ],
            )
            .map_err(|error| error.to_string())?;

        let snapshot_file = self.snapshot_dir.join(format!("{}.json", snapshot_id));
        write_json_file(&snapshot_file, &config)?;

        Ok(ConfigSnapshotRecord {
            snapshot_id,
            reason: reason.to_string(),
            created_at,
        })
    }

    pub fn rollback_snapshot(&self, snapshot_id: &str) -> Result<Value, String> {
        let connection = self.open_connection()?;
        self.apply_migrations(&connection)?;
        let config_json: String = connection
            .query_row(
                "SELECT config_json FROM config_snapshots WHERE snapshot_id = ?1",
                params![snapshot_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;

        let config: Value =
            serde_json::from_str(&config_json).map_err(|error| error.to_string())?;
        self.save_config(&config)?;
        Ok(self.load_config()?)
    }

    fn ensure_directories(&self) -> Result<(), String> {
        if let Some(parent) = self.db_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::create_dir_all(&self.export_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.snapshot_dir).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn open_connection(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err(|error| error.to_string())
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
            .map_err(|error| error.to_string())?;

        if self.schema_needs_reset(connection)? {
            self.rebuild_schema(connection)?;
        }

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
            .map_err(|error| error.to_string())?;

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

        for table in [
            "config_documents",
            "providers",
            "provider_auth_refs",
            "audio_device_preferences",
            "audio_routes",
            "subtitle_preferences",
            "speech_preferences",
            "driver_preferences",
            "diagnostic_preferences",
            "onboarding_state",
            "config_snapshots",
        ] {
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
            .map_err(|error| error.to_string())?;

        for table in RELATIONAL_TABLES {
            connection
                .execute(&format!("DROP TABLE IF EXISTS {table}"), [])
                .map_err(|error| error.to_string())?;
        }
        for table in OLD_CONFIG_TABLES {
            connection
                .execute(&format!("DROP TABLE IF EXISTS {table}"), [])
                .map_err(|error| error.to_string())?;
        }

        connection
            .execute_batch(CREATE_RELATIONAL_SCHEMA_SQL)
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn read_stats(&self, connection: &Connection) -> Result<RepositoryStats, String> {
        let persisted_row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM config_documents", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        let snapshot_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM config_snapshots", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;

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
            .map_err(|error| error.to_string())
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
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    fn clear_config_tables(&self, connection: &Connection) -> Result<(), String> {
        for table in [
            "runtime_state_cache",
            "provider_model_catalog_item_capabilities",
            "provider_model_catalog_items",
            "provider_model_catalog_cache",
            "provider_model_capabilities",
            "provider_scene_model_ids",
            "provider_scene_model_assignments",
            "provider_response_modalities",
            "provider_custom_headers",
            "provider_auth_refs",
            "providers",
            "audio_route_outputs",
            "audio_routes",
            "audio_device_preferences",
            "subtitle_preferences",
            "speech_preferences",
            "driver_preferences",
            "diagnostic_preferences",
            "glossary_injection_order",
            "glossary_community_packages",
            "glossary_active_packages",
            "glossary_preferences",
            "onboarding_unresolved_risks",
            "onboarding_completed_steps",
            "onboarding_state",
            "config_documents",
        ] {
            connection
                .execute(&format!("DELETE FROM {table}"), [])
                .map_err(|error| error.to_string())?;
        }

        Ok(())
    }

    fn upsert_config_document(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let config_json = serde_json::to_string(config).map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO config_documents (id, schema_version, config_json, updated_at)
                 VALUES (1, ?1, ?2, ?3)",
                params![CURRENT_SCHEMA_VERSION, config_json, timestamp],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn persist_providers(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        if let Some(providers) = config.get("providers").and_then(Value::as_array) {
            for (position, provider) in providers.iter().enumerate() {
                self.persist_provider(
                    connection,
                    &format!("provider-{position}"),
                    position as i64,
                    false,
                    provider,
                    timestamp,
                )?;
            }
        }

        // Backward compat: also persist legacy provider/linkedProviders if present
        if let Some(provider) = config.get("provider") {
            self.persist_provider(connection, "primary", 0, true, provider, timestamp)?;
        }

        if let Some(linked) = config.get("linkedProviders").and_then(Value::as_array) {
            for (position, provider) in linked.iter().enumerate() {
                self.persist_provider(
                    connection,
                    &format!("linked-{position}"),
                    (position + 1) as i64,
                    false,
                    provider,
                    timestamp,
                )?;
            }
        }

        Ok(())
    }

    fn persist_provider(
        &self,
        connection: &Connection,
        provider_key: &str,
        position: i64,
        is_primary: bool,
        provider: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT INTO providers (
                  provider_key, position, is_primary, template_id, template_version, template_source,
                  provider_id, kind, display_name, mode, model, base_url, transport, region,
                  stream_enabled, timeout_ms, system_prompt_template, temperature, max_output_tokens,
                  probe_profile_id, probe_verdict, probe_checked_at, probe_stream_supported,
                  probe_error_shape_stable, probe_response_shape_stable, status, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
                params![
                    provider_key,
                    position,
                    bool_to_i64(is_primary),
                    string_at(provider, "/templateId"),
                    string_at(provider, "/templateVersion"),
                    string_at(provider, "/templateSource"),
                    string_at(provider, "/providerId"),
                    string_at(provider, "/kind"),
                    string_at(provider, "/displayName"),
                    string_at(provider, "/mode"),
                    string_at(provider, "/model"),
                    string_at(provider, "/baseUrl"),
                    string_at(provider, "/transport"),
                    string_at(provider, "/region"),
                    bool_at(provider, "/streamEnabled").map(bool_to_i64),
                    i64_at(provider, "/timeoutMs"),
                    string_at(provider, "/systemPromptTemplate"),
                    f64_at(provider, "/temperature"),
                    i64_at(provider, "/maxOutputTokens"),
                    string_at(provider, "/probe/profileId"),
                    string_at(provider, "/probe/verdict"),
                    string_at(provider, "/probe/checkedAt"),
                    bool_at(provider, "/probe/streamSupported").map(bool_to_i64),
                    bool_at(provider, "/probe/errorShapeStable").map(bool_to_i64),
                    bool_at(provider, "/probe/responseShapeStable").map(bool_to_i64),
                    string_at(provider, "/status"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;

        if let Some(auth_ref) = provider.get("authRef") {
            connection
                .execute(
                    "INSERT INTO provider_auth_refs (provider_key, kind, reference, header_name, scheme)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        provider_key,
                        string_at(auth_ref, "/kind"),
                        string_at(auth_ref, "/reference"),
                        string_at(auth_ref, "/headerName"),
                        string_at(auth_ref, "/scheme"),
                    ],
                )
                .map_err(|error| error.to_string())?;
        }

        insert_string_array(
            connection,
            "provider_response_modalities",
            "provider_key",
            provider_key,
            "modality",
            provider.get("responseModalities"),
        )?;

        if let Some(headers) = provider.get("customHeaders").and_then(Value::as_array) {
            for (position, header) in headers.iter().enumerate() {
                connection
                    .execute(
                        "INSERT INTO provider_custom_headers (provider_key, header_id, position, name, value, enabled)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            provider_key,
                            string_at(header, "/id").unwrap_or_else(|| format!("header-{position}")),
                            position as i64,
                            string_at(header, "/name"),
                            string_at(header, "/value"),
                            bool_at(header, "/enabled").map(bool_to_i64),
                        ],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }

        if let Some(assignments) = provider
            .get("sceneModelAssignments")
            .and_then(Value::as_array)
        {
            for (position, assignment) in assignments.iter().enumerate() {
                let scenario = string_at(assignment, "/scenario")
                    .unwrap_or_else(|| format!("scenario-{position}"));
                connection
                    .execute(
                        "INSERT INTO provider_scene_model_assignments (provider_key, scenario, position)
                         VALUES (?1, ?2, ?3)",
                        params![provider_key, scenario, position as i64],
                    )
                    .map_err(|error| error.to_string())?;

                if let Some(model_ids) = assignment.get("modelIds").and_then(Value::as_array) {
                    for (model_position, model_id) in model_ids.iter().enumerate() {
                        if let Some(model_id) = model_id.as_str() {
                            connection
                                .execute(
                                    "INSERT INTO provider_scene_model_ids (provider_key, scenario, model_id, position)
                                     VALUES (?1, ?2, ?3, ?4)",
                                    params![provider_key, scenario, model_id, model_position as i64],
                                )
                                .map_err(|error| error.to_string())?;
                        }
                    }
                }
            }
        }

        if let Some(entries) = provider
            .get("localModelCapabilityRegistry")
            .and_then(Value::as_array)
        {
            for (position, entry) in entries.iter().enumerate() {
                let entry_id =
                    string_at(entry, "/id").unwrap_or_else(|| format!("capability-{position}"));
                if let Some(capabilities) = entry.get("capabilities").and_then(Value::as_array) {
                    for (capability_position, capability) in capabilities.iter().enumerate() {
                        if let Some(capability) = capability.as_str() {
                            connection
                                .execute(
                                    "INSERT INTO provider_model_capabilities (provider_key, entry_id, model_id, capability, position)
                                     VALUES (?1, ?2, ?3, ?4, ?5)",
                                    params![
                                        provider_key,
                                        entry_id,
                                        string_at(entry, "/modelId"),
                                        capability,
                                        capability_position as i64,
                                    ],
                                )
                                .map_err(|error| error.to_string())?;
                        }
                    }
                }
            }
        }

        if let Some(cache) = provider.get("modelCatalogCache") {
            connection
                .execute(
                    "INSERT INTO provider_model_catalog_cache (provider_key, signature, source, endpoint, fetched_at, error)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        provider_key,
                        string_at(cache, "/signature"),
                        string_at(cache, "/source"),
                        string_at(cache, "/endpoint"),
                        string_at(cache, "/fetchedAt"),
                        string_at(cache, "/error"),
                    ],
                )
                .map_err(|error| error.to_string())?;

            if let Some(models) = cache.get("models").and_then(Value::as_array) {
                for (position, model) in models.iter().enumerate() {
                    let model_id = string_at(model, "/id")
                        .unwrap_or_else(|| format!("catalog-model-{position}"));
                    connection
                        .execute(
                            "INSERT INTO provider_model_catalog_items (
                              provider_key, item_id, position, display_name, owned_by, created_at,
                              provider_template_id, provider_template_name
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                            params![
                                provider_key,
                                model_id,
                                position as i64,
                                string_at(model, "/displayName"),
                                string_at(model, "/ownedBy"),
                                i64_at(model, "/createdAt"),
                                string_at(model, "/providerTemplateId"),
                                string_at(model, "/providerTemplateName"),
                            ],
                        )
                        .map_err(|error| error.to_string())?;

                    if let Some(capabilities) = model.get("capabilities").and_then(Value::as_array)
                    {
                        for (capability_position, capability) in capabilities.iter().enumerate() {
                            if let Some(capability) = capability.as_str() {
                                connection
                                    .execute(
                                        "INSERT INTO provider_model_catalog_item_capabilities (provider_key, item_id, capability, position)
                                         VALUES (?1, ?2, ?3, ?4)",
                                        params![provider_key, model_id, capability, capability_position as i64],
                                    )
                                    .map_err(|error| error.to_string())?;
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    fn persist_audio(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let devices = config.get("devices").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO audio_device_preferences (
                  id, route_mode, input_device_id, output_device_id, virtual_render_device_id, playback_device_id,
                  virtual_mic_state, support_profile_id, subtitle_translation_mode,
                  subtitle_translation_model_id, inbound_voice_model_id, outbound_voice_model_id,
                  text_to_speech_model_id,
                  feedback_loop_prevention, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    string_at(devices, "/routeMode"),
                    string_at(devices, "/inputDeviceId"),
                    string_at(devices, "/outputDeviceId"),
                    string_at(devices, "/virtualRenderDeviceId"),
                    string_at(devices, "/playbackDeviceId"),
                    string_at(devices, "/virtualMicState"),
                    string_at(devices, "/supportProfileId"),
                    string_at(devices, "/subtitleTranslationMode"),
                    string_at(devices, "/subtitleTranslationModelId"),
                    string_at(devices, "/inboundVoiceModelId"),
                    string_at(devices, "/outboundVoiceModelId"),
                    string_at(devices, "/textToSpeechModelId"),
                    string_at(devices, "/feedbackLoopPrevention"),
                    string_at(devices, "/status"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;

        self.persist_audio_route(
            connection,
            "inbound",
            devices.get("inboundRoute"),
            timestamp,
        )?;
        self.persist_audio_route(
            connection,
            "outbound",
            devices.get("outboundRoute"),
            timestamp,
        )?;
        Ok(())
    }

    fn persist_audio_route(
        &self,
        connection: &Connection,
        direction_key: &str,
        route: Option<&Value>,
        timestamp: &str,
    ) -> Result<(), String> {
        let route = route.unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO audio_routes (
                  direction_key, route_id, direction, input_source_id, input_kind, input_device_id,
                  input_state, input_muted, input_buffer_ahead_ms, input_pre_buffer_state,
                  keep_original_audio, translated_audio_enabled, translated_audio_gain_db,
                  original_audio_gain_db, ducking_enabled, ducking_depth_percent, monitor_mode,
                  capture_buffer_ms, translation_buffer_ms, playback_buffer_ms, compensation_ms,
                  push_to_talk_enabled, push_to_talk_hotkey, push_to_talk_state,
                  push_to_talk_release_delay_ms, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
                params![
                    direction_key,
                    string_at(route, "/routeId"),
                    string_at(route, "/direction"),
                    string_at(route, "/input/sourceId"),
                    string_at(route, "/input/kind"),
                    string_at(route, "/input/deviceId"),
                    string_at(route, "/input/state"),
                    bool_at(route, "/input/muted").map(bool_to_i64),
                    i64_at(route, "/input/bufferAheadMs"),
                    string_at(route, "/input/preBufferState"),
                    bool_at(route, "/mixControl/keepOriginalAudio").map(bool_to_i64),
                    bool_at(route, "/mixControl/translatedAudioEnabled").map(bool_to_i64),
                    f64_at(route, "/mixControl/translatedAudioGainDb"),
                    f64_at(route, "/mixControl/originalAudioGainDb"),
                    bool_at(route, "/mixControl/duckingEnabled").map(bool_to_i64),
                    i64_at(route, "/mixControl/duckingDepthPercent"),
                    string_at(route, "/mixControl/monitorMode"),
                    i64_at(route, "/latencyControl/captureBufferMs"),
                    i64_at(route, "/latencyControl/translationBufferMs"),
                    i64_at(route, "/latencyControl/playbackBufferMs"),
                    i64_at(route, "/latencyControl/compensationMs"),
                    bool_at(route, "/pushToTalk/enabled").map(bool_to_i64),
                    string_at(route, "/pushToTalk/hotkey"),
                    string_at(route, "/pushToTalk/state"),
                    i64_at(route, "/pushToTalk/releaseDelayMs"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;

        if let Some(outputs) = route.get("outputs").and_then(Value::as_array) {
            for (position, output) in outputs.iter().enumerate() {
                connection
                    .execute(
                        "INSERT INTO audio_route_outputs (direction_key, target_id, position, kind, device_id, enabled)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            direction_key,
                            string_at(output, "/targetId").unwrap_or_else(|| format!("output-{position}")),
                            position as i64,
                            string_at(output, "/kind"),
                            string_at(output, "/deviceId"),
                            bool_at(output, "/enabled").map(bool_to_i64),
                        ],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }

        Ok(())
    }

    fn persist_subtitles(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let subtitles = config.get("subtitles").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO subtitle_preferences (
                  id, source_language, target_language, translation_language_preference,
                  display_mode, caption_density, priority_mode, instructions, overlay_opacity,
                  overlay_locked, overlay_text_color, overlay_text_opacity, overlay_background_color,
                  overlay_background_opacity, overlay_font_family, overlay_width, overlay_height,
                  overlay_x, overlay_y, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                params![
                    string_at(subtitles, "/sourceLanguage"),
                    string_at(subtitles, "/targetLanguage"),
                    string_at(subtitles, "/translationLanguagePreference"),
                    string_at(subtitles, "/mode"),
                    string_at(subtitles, "/captionDensity"),
                    string_at(subtitles, "/priority"),
                    string_at(subtitles, "/instructions"),
                    f64_at(subtitles, "/overlayOpacity"),
                    bool_at(subtitles, "/overlayLocked").map(bool_to_i64),
                    string_at(subtitles, "/overlayTextColor"),
                    f64_at(subtitles, "/overlayTextOpacity"),
                    string_at(subtitles, "/overlayBackgroundColor"),
                    f64_at(subtitles, "/overlayBackgroundOpacity"),
                    string_at(subtitles, "/overlayFontFamily"),
                    i64_at(subtitles, "/overlayWidth"),
                    i64_at(subtitles, "/overlayHeight"),
                    i64_at(subtitles, "/overlayX"),
                    i64_at(subtitles, "/overlayY"),
                    string_at(subtitles, "/status"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn persist_speech(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let speech = config.get("speech").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO speech_preferences (
                  id, speech_enabled, target_language, voice_preset_id, text_to_speech_model_id,
                  voice, output_target,
                  local_playback_enabled, virtual_mic_output_enabled, dispatch_state, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    bool_at(speech, "/enabled").map(bool_to_i64),
                    string_at(speech, "/targetLanguage"),
                    string_at(speech, "/voicePresetId"),
                    string_at(speech, "/textToSpeechModelId"),
                    string_at(speech, "/voice"),
                    string_at(speech, "/outputTarget"),
                    bool_at(speech, "/localPlaybackEnabled").map(bool_to_i64),
                    bool_at(speech, "/virtualMicOutputEnabled").map(bool_to_i64),
                    string_at(speech, "/dispatchState"),
                    string_at(speech, "/status"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn persist_driver(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let driver = config.get("driver").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO driver_preferences (
                  id, protocol_version, install_channel, install_phase, target_device_id,
                  expected_driver_version, expected_bridge_version, rollback_supported,
                  last_error_code, recommended_action, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    string_at(driver, "/protocolVersion"),
                    string_at(driver, "/installChannel"),
                    string_at(driver, "/installPhase"),
                    string_at(driver, "/targetDeviceId"),
                    string_at(driver, "/expectedDriverVersion"),
                    string_at(driver, "/expectedBridgeVersion"),
                    bool_at(driver, "/rollbackSupported").map(bool_to_i64),
                    string_at(driver, "/lastErrorCode"),
                    string_at(driver, "/recommendedAction"),
                    string_at(driver, "/status"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn persist_glossary(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let glossary = config.get("glossary").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO glossary_preferences (
                  id, template_id, scenario, injection_strategy, game_dictionary_id,
                  import_strategy, export_format, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    string_at(glossary, "/templateId"),
                    string_at(glossary, "/scenario"),
                    string_at(glossary, "/injectionStrategy"),
                    string_at(glossary, "/gameDictionaryId"),
                    string_at(glossary, "/importStrategy"),
                    string_at(glossary, "/exportFormat"),
                    string_at(glossary, "/status"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;

        insert_string_array(
            connection,
            "glossary_active_packages",
            "config_id",
            "1",
            "package_id",
            glossary.get("activePackageIds"),
        )?;
        insert_string_array(
            connection,
            "glossary_community_packages",
            "config_id",
            "1",
            "package_id",
            glossary.get("communityPackageIds"),
        )?;
        insert_string_array(
            connection,
            "glossary_injection_order",
            "config_id",
            "1",
            "source",
            glossary.get("injectionOrder"),
        )?;
        Ok(())
    }

    fn persist_diagnostics(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let diagnostics = config.get("diagnostics").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO diagnostic_preferences (
                  id, install_status, last_export_scope, support_tier, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5)",
                params![
                    string_at(diagnostics, "/installStatus"),
                    string_at(diagnostics, "/lastExportScope"),
                    string_at(diagnostics, "/supportTier"),
                    string_at(diagnostics, "/status"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn persist_onboarding(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let onboarding = config.get("onboarding").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO onboarding_state (id, active_preset_id, checklist_status, updated_at)
                 VALUES (1, ?1, ?2, ?3)",
                params![
                    string_at(onboarding, "/activePresetId"),
                    string_at(onboarding, "/checklistStatus"),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        insert_string_array(
            connection,
            "onboarding_completed_steps",
            "config_id",
            "1",
            "step_id",
            onboarding.get("completedStepIds"),
        )?;
        insert_string_array(
            connection,
            "onboarding_unresolved_risks",
            "config_id",
            "1",
            "risk_id",
            onboarding.get("unresolvedRiskIds"),
        )?;
        Ok(())
    }

    fn persist_runtime_cache(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let driver = config.get("driver").unwrap_or(&Value::Null);
        let diagnostics = config.get("diagnostics").unwrap_or(&Value::Null);
        for (key, value) in [
            ("driver.driverHealth", string_at(driver, "/driverHealth")),
            ("driver.bridgeState", string_at(driver, "/bridgeState")),
            (
                "diagnostics.driverStatus",
                string_at(diagnostics, "/driverStatus"),
            ),
            (
                "diagnostics.providerStatus",
                string_at(diagnostics, "/providerStatus"),
            ),
            (
                "diagnostics.deviceStatus",
                string_at(diagnostics, "/deviceStatus"),
            ),
        ] {
            if let Some(value) = value {
                connection
                    .execute(
                        "INSERT INTO runtime_state_cache (key, value, updated_at) VALUES (?1, ?2, ?3)",
                        params![key, value, timestamp],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}

const CREATE_RELATIONAL_SCHEMA_SQL: &str = r#"
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

CREATE TABLE config_documents (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE providers (
  provider_key TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  template_id TEXT,
  template_version TEXT,
  template_source TEXT,
  provider_id TEXT,
  kind TEXT,
  display_name TEXT,
  mode TEXT,
  model TEXT,
  base_url TEXT,
  transport TEXT,
  region TEXT,
  stream_enabled INTEGER,
  timeout_ms INTEGER,
  system_prompt_template TEXT,
  temperature REAL,
  max_output_tokens INTEGER,
  probe_profile_id TEXT,
  probe_verdict TEXT,
  probe_checked_at TEXT,
  probe_stream_supported INTEGER,
  probe_error_shape_stable INTEGER,
  probe_response_shape_stable INTEGER,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_auth_refs (
  provider_key TEXT PRIMARY KEY,
  kind TEXT,
  reference TEXT,
  header_name TEXT,
  scheme TEXT
);

CREATE TABLE provider_custom_headers (
  provider_key TEXT NOT NULL,
  header_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT,
  value TEXT,
  enabled INTEGER,
  PRIMARY KEY (provider_key, header_id)
);

CREATE TABLE provider_response_modalities (
  provider_key TEXT NOT NULL,
  modality TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (provider_key, position)
);

CREATE TABLE provider_scene_model_assignments (
  provider_key TEXT NOT NULL,
  scenario TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (provider_key, scenario)
);

CREATE TABLE provider_scene_model_ids (
  provider_key TEXT NOT NULL,
  scenario TEXT NOT NULL,
  model_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (provider_key, scenario, position)
);

CREATE TABLE provider_model_capabilities (
  provider_key TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  model_id TEXT,
  capability TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (provider_key, entry_id, capability)
);

CREATE TABLE provider_model_catalog_cache (
  provider_key TEXT PRIMARY KEY,
  signature TEXT,
  source TEXT,
  endpoint TEXT,
  fetched_at TEXT,
  error TEXT
);

CREATE TABLE provider_model_catalog_items (
  provider_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  display_name TEXT,
  owned_by TEXT,
  created_at INTEGER,
  provider_template_id TEXT,
  provider_template_name TEXT,
  PRIMARY KEY (provider_key, item_id)
);

CREATE TABLE provider_model_catalog_item_capabilities (
  provider_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (provider_key, item_id, capability)
);

CREATE TABLE audio_device_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  route_mode TEXT,
  input_device_id TEXT,
  output_device_id TEXT,
  virtual_render_device_id TEXT,
  playback_device_id TEXT,
  virtual_mic_state TEXT,
  support_profile_id TEXT,
  subtitle_translation_mode TEXT,
  subtitle_translation_model_id TEXT,
  inbound_voice_model_id TEXT,
  outbound_voice_model_id TEXT,
  text_to_speech_model_id TEXT,
  feedback_loop_prevention TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE audio_routes (
  direction_key TEXT PRIMARY KEY,
  route_id TEXT,
  direction TEXT,
  input_source_id TEXT,
  input_kind TEXT,
  input_device_id TEXT,
  input_state TEXT,
  input_muted INTEGER,
  input_buffer_ahead_ms INTEGER,
  input_pre_buffer_state TEXT,
  keep_original_audio INTEGER,
  translated_audio_enabled INTEGER,
  translated_audio_gain_db REAL,
  original_audio_gain_db REAL,
  ducking_enabled INTEGER,
  ducking_depth_percent INTEGER,
  monitor_mode TEXT,
  capture_buffer_ms INTEGER,
  translation_buffer_ms INTEGER,
  playback_buffer_ms INTEGER,
  compensation_ms INTEGER,
  push_to_talk_enabled INTEGER,
  push_to_talk_hotkey TEXT,
  push_to_talk_state TEXT,
  push_to_talk_release_delay_ms INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE audio_route_outputs (
  direction_key TEXT NOT NULL,
  target_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT,
  device_id TEXT,
  enabled INTEGER,
  PRIMARY KEY (direction_key, target_id)
);

CREATE TABLE subtitle_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_language TEXT,
  target_language TEXT,
  translation_language_preference TEXT,
  display_mode TEXT,
  caption_density TEXT,
  priority_mode TEXT,
  instructions TEXT,
  overlay_opacity REAL,
  overlay_locked INTEGER,
  overlay_text_color TEXT,
  overlay_text_opacity REAL,
  overlay_background_color TEXT,
  overlay_background_opacity REAL,
  overlay_font_family TEXT,
  overlay_width INTEGER,
  overlay_height INTEGER,
  overlay_x INTEGER,
  overlay_y INTEGER,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE speech_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  speech_enabled INTEGER,
  target_language TEXT,
  voice_preset_id TEXT,
  text_to_speech_model_id TEXT,
  voice TEXT,
  output_target TEXT,
  local_playback_enabled INTEGER,
  virtual_mic_output_enabled INTEGER,
  dispatch_state TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE driver_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  protocol_version TEXT,
  install_channel TEXT,
  install_phase TEXT,
  target_device_id TEXT,
  expected_driver_version TEXT,
  expected_bridge_version TEXT,
  rollback_supported INTEGER,
  last_error_code TEXT,
  recommended_action TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE diagnostic_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  install_status TEXT,
  last_export_scope TEXT,
  support_tier TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE glossary_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  template_id TEXT,
  scenario TEXT,
  injection_strategy TEXT,
  game_dictionary_id TEXT,
  import_strategy TEXT,
  export_format TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE glossary_active_packages (
  config_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (config_id, position)
);

CREATE TABLE glossary_community_packages (
  config_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (config_id, position)
);

CREATE TABLE glossary_injection_order (
  config_id TEXT NOT NULL,
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (config_id, position)
);

CREATE TABLE onboarding_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_preset_id TEXT,
  checklist_status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE onboarding_completed_steps (
  config_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (config_id, position)
);

CREATE TABLE onboarding_unresolved_risks (
  config_id TEXT NOT NULL,
  risk_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (config_id, position)
);

CREATE TABLE runtime_state_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE config_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"#;

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(exists.is_some())
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;

    for row in rows {
        if row.map_err(|error| error.to_string())? == column {
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
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn default_config_value() -> Result<Value, String> {
    serde_json::from_str(DEFAULT_CONFIG_JSON).map_err(|error| error.to_string())
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn merge_objects(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                merge_objects(
                    target_map.entry(key.clone()).or_insert(Value::Null),
                    patch_value,
                );
            }
        }
        (target_value, patch_value) => {
            *target_value = patch_value.clone();
        }
    }
}

fn string_at(root: &Value, pointer: &str) -> Option<String> {
    root.pointer(pointer)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn bool_at(root: &Value, pointer: &str) -> Option<bool> {
    root.pointer(pointer).and_then(Value::as_bool)
}

fn i64_at(root: &Value, pointer: &str) -> Option<i64> {
    root.pointer(pointer).and_then(Value::as_i64)
}

fn f64_at(root: &Value, pointer: &str) -> Option<f64> {
    root.pointer(pointer).and_then(Value::as_f64)
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn current_timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("unix:{}", duration.as_secs()),
        Err(_) => "unix:0".to_string(),
    }
}

fn normalize_timestamp(timestamp: &str) -> String {
    timestamp.replace(':', "-")
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, OptionalExtension};
    use serde_json::json;
    use tempfile::TempDir;

    use super::{default_config_value, table_exists, ConfigRepository};

    fn test_repository() -> (TempDir, ConfigRepository) {
        let temp_dir = TempDir::new().expect("temp dir should be created");
        let repository = ConfigRepository::new(
            temp_dir.path().join("db").join("omni-config.db"),
            temp_dir.path().join("exports"),
            temp_dir.path().join("snapshots"),
        );

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
    fn saves_relational_rows_and_loads_full_document() {
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");

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
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");

        let mut config = default_config_value().expect("default config should parse");
        config["providers"][0]["model"] = json!("snapshot-base");
        config["speech"]["outputTarget"] = json!("speaker");
        repository
            .save_config(&config)
            .expect("config should persist");

        let exported = repository.export_config().expect("config should export");
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
    fn load_merges_missing_document_fields_with_defaults() {
        let (_temp_dir, repository) = test_repository();
        repository
            .initialize()
            .expect("repository should initialize");
        let connection = repository
            .open_connection()
            .expect("connection should open");
        connection
            .execute(
                "INSERT INTO config_documents (id, schema_version, config_json, updated_at)
                 VALUES (1, 1, ?1, 'test')",
                params![r#"{"providers":[{"model":"partial-model"}]}"#],
            )
            .expect("partial config should insert");

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
}
