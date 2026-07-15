//! Persistence boundaries for independently evolving configuration domains.
//!
//! `ConfigRepository` continues to own the single SQLite transaction.  These
//! objects deliberately receive that transaction connection rather than opening
//! their own one, so a failed domain write still rolls back the entire config.

use rusqlite::Connection;
use serde_json::Value;

use super::ConfigRepository;

pub(super) struct ProviderConfigPersister<'a> {
    repository: &'a ConfigRepository,
}

impl<'a> ProviderConfigPersister<'a> {
    pub(super) fn new(repository: &'a ConfigRepository) -> Self {
        Self { repository }
    }

    pub(super) fn persist(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        self.repository.persist_providers(connection, config, timestamp)
    }
}

pub(super) struct AudioConfigPersister<'a> {
    repository: &'a ConfigRepository,
}

impl<'a> AudioConfigPersister<'a> {
    pub(super) fn new(repository: &'a ConfigRepository) -> Self {
        Self { repository }
    }

    pub(super) fn persist(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        self.repository.persist_audio(connection, config, timestamp)
    }
}

pub(super) struct PreferencesPersister<'a> {
    repository: &'a ConfigRepository,
}

impl<'a> PreferencesPersister<'a> {
    pub(super) fn new(repository: &'a ConfigRepository) -> Self {
        Self { repository }
    }

    pub(super) fn persist(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        self.repository.persist_subtitles(connection, config, timestamp)?;
        self.repository.persist_speech(connection, config, timestamp)?;
        self.repository.persist_driver(connection, config, timestamp)?;
        self.repository.persist_glossary(connection, config, timestamp)?;
        self.repository.persist_diagnostics(connection, config, timestamp)?;
        self.repository.persist_onboarding(connection, config, timestamp)
    }
}

pub(super) struct RuntimeCachePersister<'a> {
    repository: &'a ConfigRepository,
}

impl<'a> RuntimeCachePersister<'a> {
    pub(super) fn new(repository: &'a ConfigRepository) -> Self {
        Self { repository }
    }

    pub(super) fn persist(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        self.repository.persist_runtime_cache(connection, config, timestamp)
    }
}
