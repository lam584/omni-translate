pub(super) const CURRENT_SCHEMA_VERSION: i64 = 1;
pub(super) const RELATIONAL_SCHEMA_NAME: &str = "0001_relational_config_storage";
pub(super) const DEFAULT_CONFIG_JSON: &str =
    include_str!("../../../defaults/app-config.default.json");

pub(super) const OLD_CONFIG_TABLES: [&str; 10] = [
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

/// Tables that must survive save_config's clear-then-write cycle.
pub(super) const PRESERVED_ON_SAVE_TABLES: [&str; 1] = ["config_snapshots"];

/// Derived from RELATIONAL_TABLES: every relational table except the
/// preserved set, keeping config_documents as the final delete inside the
/// save transaction (preserves the historical clear order).
pub(super) fn tables_cleared_on_save() -> impl Iterator<Item = &'static str> {
    RELATIONAL_TABLES
        .into_iter()
        .filter(|table| !PRESERVED_ON_SAVE_TABLES.contains(table) && *table != "config_documents")
        .chain(std::iter::once("config_documents"))
}

pub(super) const RELATIONAL_TABLES: [&str; 27] = [
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

pub(super) const CREATE_RELATIONAL_SCHEMA_SQL: &str = r#"
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{
        tables_cleared_on_save, CREATE_RELATIONAL_SCHEMA_SQL, PRESERVED_ON_SAVE_TABLES,
        RELATIONAL_TABLES,
    };

    /// Tables managed outside the relational config payload; they are created
    /// by CREATE_RELATIONAL_SCHEMA_SQL but never dropped on rebuild.
    const BOOKKEEPING_TABLES: [&str; 2] = ["storage_migrations", "storage_metadata"];

    fn created_table_names() -> BTreeSet<&'static str> {
        CREATE_RELATIONAL_SCHEMA_SQL
            .lines()
            .filter_map(|line| {
                let rest = line.trim().strip_prefix("CREATE TABLE ")?;
                let rest = rest.strip_prefix("IF NOT EXISTS ").unwrap_or(rest);
                Some(rest.split_whitespace().next()?.trim_end_matches('('))
            })
            .collect()
    }

    #[test]
    fn relational_tables_match_create_schema_sql() {
        let mut expected = created_table_names();
        for table in BOOKKEEPING_TABLES {
            assert!(
                expected.remove(table),
                "bookkeeping table {table} should be created by the schema SQL"
            );
        }
        let declared: BTreeSet<&'static str> = RELATIONAL_TABLES.into_iter().collect();
        assert_eq!(
            declared, expected,
            "RELATIONAL_TABLES must list exactly the tables created by CREATE_RELATIONAL_SCHEMA_SQL"
        );
        assert_eq!(
            RELATIONAL_TABLES.len(),
            declared.len(),
            "RELATIONAL_TABLES must not contain duplicates"
        );
    }

    #[test]
    fn preserved_tables_are_relational_tables() {
        for table in PRESERVED_ON_SAVE_TABLES {
            assert!(
                RELATIONAL_TABLES.contains(&table),
                "preserved table {table} must be part of RELATIONAL_TABLES"
            );
        }
    }

    #[test]
    fn cleared_tables_are_exactly_the_unpreserved_relational_tables() {
        let cleared: Vec<&'static str> = tables_cleared_on_save().collect();
        let cleared_set: BTreeSet<&'static str> = cleared.iter().copied().collect();
        assert_eq!(
            cleared.len(),
            cleared_set.len(),
            "clear list must not contain duplicates"
        );

        let expected: BTreeSet<&'static str> = RELATIONAL_TABLES
            .into_iter()
            .filter(|table| !PRESERVED_ON_SAVE_TABLES.contains(table))
            .collect();
        assert_eq!(
            cleared_set, expected,
            "every relational table except the preserved set must be cleared on save"
        );
        assert_eq!(
            cleared.last(),
            Some(&"config_documents"),
            "config_documents must remain the final delete of the save transaction"
        );
    }
}
