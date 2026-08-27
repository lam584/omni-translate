use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use super::contracts::{ProviderDraftInput, ProviderRuntimeError};

static ACTIVE_RELEASE_CONNECTION: Mutex<Option<ReleaseConnectionOwner>> = Mutex::new(None);
static NEXT_CONNECTION_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReleaseConnectionOwner {
    pub(crate) scenario: String,
    pub(crate) execution_id: String,
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) generation: u64,
}

impl ReleaseConnectionOwner {
    pub(crate) fn label(&self) -> String {
        format!("{}:{}:{}:{}:{}", self.scenario, self.execution_id, self.provider_id, self.model_id, self.generation)
    }
}

pub(crate) struct ReleaseConnectionLease {
    owner: Option<ReleaseConnectionOwner>,
}

impl ReleaseConnectionLease {
    pub(crate) fn owner(&self) -> Option<&ReleaseConnectionOwner> { self.owner.as_ref() }
}

impl Drop for ReleaseConnectionLease {
    fn drop(&mut self) {
        let Some(owner) = self.owner.as_ref() else { return };
        if let Ok(mut active) = ACTIVE_RELEASE_CONNECTION.lock() {
            if active.as_ref().is_some_and(|candidate| candidate == owner) {
                *active = None;
            }
        }
    }
}

fn lock_active() -> Result<MutexGuard<'static, Option<ReleaseConnectionOwner>>, ProviderRuntimeError> {
    ACTIVE_RELEASE_CONNECTION.lock().map_err(|_| ProviderRuntimeError::new(
        "provider.connection-ownership-unavailable",
        "Provider connection ownership state is poisoned.",
    ))
}

fn release_scenario() -> Option<String> {
    if let Ok(scenario) = std::env::var("OMNI_RELEASE_EVIDENCE_SCENARIO") {
        if matches!(scenario.as_str(), "E2E-PROVIDER-CONFIG" | "E2E-PROVIDER-PROBE" | "E2E-DIAGNOSTICS-EXPORT") {
            return Some(scenario);
        }
    }
    (std::env::var("OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY").as_deref() == Ok("1"))
        .then(|| "watch-mode-strict-paid".to_string())
}

pub(crate) fn acquire(provider: &ProviderDraftInput) -> Result<ReleaseConnectionLease, ProviderRuntimeError> {
    let Some(scenario) = release_scenario() else { return Ok(ReleaseConnectionLease { owner: None }); };
    let execution_id = std::env::var("OMNI_PROVIDER_PREFLIGHT_EXECUTION_ID")
        .or_else(|_| std::env::var("OMNI_SHARD_EXECUTION_ID"))
        .map_err(|_| ProviderRuntimeError::new(
        "provider.connection-owner-missing",
        "Release-evidence Provider connection requires an execution identity.",
    ))?;
    let owner = ReleaseConnectionOwner {
        scenario,
        execution_id,
        provider_id: provider.provider_id.clone(),
        model_id: provider.model.clone(),
        generation: NEXT_CONNECTION_GENERATION.fetch_add(1, Ordering::SeqCst),
    };
    let mut active = lock_active()?;
    if let Some(existing) = active.as_ref() {
        return Err(ProviderRuntimeError::new(
            "provider.connection-owner-conflict",
            format!("A release-evidence Provider connection is already owned by {}.", existing.label()),
        ));
    }
    *active = Some(owner.clone());
    Ok(ReleaseConnectionLease { owner: Some(owner) })
}
