//! Persistence boundaries for independently evolving configuration domains.
//!
//! `ConfigRepository` continues to own the single SQLite transaction.  These
//! objects deliberately receive that transaction connection rather than opening
//! their own one, so a failed domain write still rolls back the entire config.

use rusqlite::Connection;
use serde_json::Value;

use super::ConfigRepository;

/// Generate a domain persister that borrows the shared `ConfigRepository` and
/// forwards its `persist` call to one or more repository methods. Every
/// persister has the same skeleton (`new` + `persist`); only the delegated body
/// differs, so it lives here once instead of being repeated per domain.
macro_rules! config_persister {
    ($name:ident, |$repo:ident, $conn:ident, $config:ident, $timestamp:ident| $body:expr) => {
        pub(super) struct $name<'a> {
            repository: &'a ConfigRepository,
        }

        impl<'a> $name<'a> {
            pub(super) fn new(repository: &'a ConfigRepository) -> Self {
                Self { repository }
            }

            pub(super) fn persist(
                &self,
                $conn: &Connection,
                $config: &Value,
                $timestamp: &str,
            ) -> Result<(), String> {
                let $repo = self.repository;
                $body
            }
        }
    };
}

config_persister!(ProviderConfigPersister, |repo, connection, config, timestamp| {
    repo.persist_providers(connection, config, timestamp)
});

config_persister!(AudioConfigPersister, |repo, connection, config, timestamp| {
    repo.persist_audio(connection, config, timestamp)
});

config_persister!(PreferencesPersister, |repo, connection, config, timestamp| {
    repo.persist_subtitles(connection, config, timestamp)?;
    repo.persist_speech(connection, config, timestamp)?;
    repo.persist_driver(connection, config, timestamp)?;
    repo.persist_glossary(connection, config, timestamp)?;
    repo.persist_diagnostics(connection, config, timestamp)?;
    repo.persist_onboarding(connection, config, timestamp)
});

config_persister!(RuntimeCachePersister, |repo, connection, config, timestamp| {
    repo.persist_runtime_cache(connection, config, timestamp)
});
