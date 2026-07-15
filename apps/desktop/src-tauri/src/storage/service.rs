//! Narrow configuration service used by Tauri command handlers.

use std::path::Path;

use serde_json::Value;

use super::contracts::{ConfigExportArtifact, ConfigSnapshotRecord, StorageRuntimeSnapshot};
use super::StorageStateStore;

pub struct ConfigurationService<'a> {
    store: &'a StorageStateStore,
}

impl<'a> ConfigurationService<'a> {
    pub fn new(store: &'a StorageStateStore) -> Self { Self { store } }
    pub fn load(&self) -> Result<Value, String> { self.store.load_config() }
    pub fn save(&self, config: &Value) -> Result<StorageRuntimeSnapshot, String> { self.store.save_config(config) }
    pub fn reset(&self) -> Result<Value, String> { self.store.reset_config() }
    pub fn export(&self) -> Result<ConfigExportArtifact, String> { self.store.export_config() }
    pub fn import(&self, path: &Path) -> Result<Value, String> {
        self.store.import_config(&path.to_string_lossy())
    }
    pub fn snapshot(&self, reason: &str) -> Result<ConfigSnapshotRecord, String> { self.store.create_snapshot(reason) }
    pub fn rollback(&self, snapshot_id: &str) -> Result<Value, String> { self.store.rollback_snapshot(snapshot_id) }
}
