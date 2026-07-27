pub mod contracts;
pub mod credential;
pub mod events;
pub mod repository;
pub mod service;

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use self::contracts::{ConfigExportArtifact, ConfigSnapshotRecord, StorageRuntimeSnapshot};
use self::repository::{ConfigRepository, RepositoryStats};

struct StoragePaths {
    database_path: PathBuf,
    export_dir: PathBuf,
    snapshot_dir: PathBuf,
    glossary_packages_dir: PathBuf,
    cache_dir: PathBuf,
    temp_audio_dir: PathBuf,
    temp_download_dir: PathBuf,
}

struct StorageState {
    repository: ConfigRepository,
    snapshot: StorageRuntimeSnapshot,
}

pub struct StorageStateStore {
    inner: Mutex<Option<StorageState>>,
}

impl StorageStateStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn ensure_initialized<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<StorageRuntimeSnapshot, String> {
        if let Some(snapshot) = self.current_snapshot() {
            return Ok(snapshot);
        }

        let paths = storage_paths(app)?;
        ensure_support_directories(&paths)?;

        let repository = ConfigRepository::new(
            paths.database_path.clone(),
            paths.export_dir,
            paths.snapshot_dir,
        );
        let stats = repository.initialize()?;
        let snapshot = build_storage_snapshot(&repository, &stats);

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "storage state poisoned".to_string())?;
        *inner = Some(StorageState {
            repository,
            snapshot: snapshot.clone(),
        });

        Ok(snapshot)
    }

    pub fn snapshot(&self) -> StorageRuntimeSnapshot {
        self.current_snapshot()
            .unwrap_or_else(StorageRuntimeSnapshot::preview)
    }

    pub fn load_config(&self) -> Result<Value, String> {
        let repository = self.repository()?;
        repository.load_config()
    }

    pub fn save_config(&self, config: &Value) -> Result<StorageRuntimeSnapshot, String> {
        let repository = self.repository()?;
        let stats = repository.save_config(config)?;
        self.refresh_snapshot(&repository, stats)
    }

    pub fn reset_config(&self) -> Result<Value, String> {
        let repository = self.repository()?;
        let config = repository.reset_config()?;
        let stats = repository.initialize()?;
        let _ = self.refresh_snapshot(&repository, stats)?;
        Ok(config)
    }

    pub fn export_config(&self) -> Result<ConfigExportArtifact, String> {
        let repository = self.repository()?;
        let artifact = repository.export_config()?;
        let stats = repository.initialize()?;
        let _ = self.refresh_snapshot(&repository, stats)?;
        Ok(artifact)
    }

    pub fn import_config(&self, file_path: &str) -> Result<Value, String> {
        let repository = self.repository()?;
        let config = repository.import_config(PathBuf::from(file_path).as_path())?;
        let stats = repository.initialize()?;
        let _ = self.refresh_snapshot(&repository, stats)?;
        Ok(config)
    }

    pub fn create_snapshot(&self, reason: &str) -> Result<ConfigSnapshotRecord, String> {
        let repository = self.repository()?;
        let snapshot = repository.create_snapshot(reason)?;
        let stats = repository.initialize()?;
        let _ = self.refresh_snapshot(&repository, stats)?;
        Ok(snapshot)
    }

    pub fn rollback_snapshot(&self, snapshot_id: &str) -> Result<Value, String> {
        let repository = self.repository()?;
        let config = repository.rollback_snapshot(snapshot_id)?;
        let stats = repository.initialize()?;
        let _ = self.refresh_snapshot(&repository, stats)?;
        Ok(config)
    }

    fn repository(&self) -> Result<ConfigRepository, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "storage state poisoned".to_string())?;
        inner
            .as_ref()
            .map(|state| state.repository.clone())
            .ok_or_else(|| "storage repository is not initialized".to_string())
    }

    fn refresh_snapshot(
        &self,
        repository: &ConfigRepository,
        stats: RepositoryStats,
    ) -> Result<StorageRuntimeSnapshot, String> {
        let snapshot = build_storage_snapshot(repository, &stats);
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "storage state poisoned".to_string())?;

        if let Some(state) = inner.as_mut() {
            state.snapshot = snapshot.clone();
        }

        Ok(snapshot)
    }

    fn current_snapshot(&self) -> Option<StorageRuntimeSnapshot> {
        let inner = self.inner.lock().ok()?;
        inner.as_ref().map(|state| state.snapshot.clone())
    }
}

fn storage_paths<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<StoragePaths, String> {
    let roaming_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = roaming_dir.join("config");

    Ok(StoragePaths {
        database_path: config_dir.join("omni-config.db"),
        export_dir: config_dir.join("exports"),
        snapshot_dir: config_dir.join("snapshots"),
        glossary_packages_dir: roaming_dir.join("glossary").join("packages"),
        cache_dir: local_dir.join("cache"),
        temp_audio_dir: local_dir.join("temp-audio"),
        temp_download_dir: local_dir.join("downloads"),
    })
}

fn ensure_support_directories(paths: &StoragePaths) -> Result<(), String> {
    for directory in [
        paths.glossary_packages_dir.as_path(),
        paths.cache_dir.as_path(),
        paths.temp_audio_dir.as_path(),
        paths.temp_download_dir.as_path(),
    ] {
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn build_storage_snapshot(
    repository: &ConfigRepository,
    stats: &RepositoryStats,
) -> StorageRuntimeSnapshot {
    StorageRuntimeSnapshot {
        status: "ready".to_string(),
        schema_version: stats.schema_version,
        database_path: repository.database_path().to_string_lossy().to_string(),
        credential_backend: "windows-credential-manager".to_string(),
        has_persisted_config: stats.has_persisted_config,
        snapshot_count: stats.snapshot_count,
        last_saved_at: stats.last_saved_at.clone(),
        last_export_path: stats.last_export_path.clone(),
        last_import_path: stats.last_import_path.clone(),
    }
}
