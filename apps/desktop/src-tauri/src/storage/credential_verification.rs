//! Session-only credential authority. Neither secrets nor secret-derived values live here.
//! Restart intentionally revokes all proofs: external vault edits cannot be attested.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use uuid::Uuid;

use crate::provider::contracts::{ProviderDraftInput, ProviderProbeProfileRuntime};

#[derive(Default)]
struct Authority {
    revisions: HashMap<String, (String, usize)>,
    proofs: HashMap<String, Proof>,
}
struct Proof {
    reference: String,
    revision: String,
    provider: ProviderDraftInput,
    snapshot: Value,
}
static AUTHORITY: OnceLock<Mutex<Authority>> = OnceLock::new();
fn authority() -> &'static Mutex<Authority> { AUTHORITY.get_or_init(Mutex::default) }
fn reference_key(reference: &str) -> String {
    // Match Windows' case-insensitive, normalized target identity, including aliases.
    super::credential::normalize_reference(reference).to_ascii_lowercase()
}
fn revision_locked(state: &mut Authority, reference: &str) -> Option<String> {
    let entry = state.revisions.entry(reference.into()).or_insert_with(|| (Uuid::new_v4().to_string(), 0));
    (entry.1 == 0).then(|| entry.0.clone())
}
pub(crate) fn revision(reference: &str) -> Option<String> {
    let mut state = authority().lock().ok()?;
    revision_locked(&mut state, &reference_key(reference))
}

pub(crate) struct CredentialWrite { reference: String }
impl CredentialWrite {
    pub(crate) fn begin(reference: &str) -> Result<Self, String> {
        let reference = reference_key(reference);
        let mut state = authority().lock().map_err(|_| "credential authority unavailable")?;
        let entry = state.revisions.entry(reference.clone()).or_default();
        entry.0 = Uuid::new_v4().to_string();
        entry.1 += 1;
        state.proofs.retain(|_, proof| proof.reference != reference);
        Ok(Self { reference })
    }
}
impl Drop for CredentialWrite {
    fn drop(&mut self) {
        if let Ok(mut state) = authority().lock() {
            if let Some(entry) = state.revisions.get_mut(&self.reference) {
                entry.0 = Uuid::new_v4().to_string();
                entry.1 = entry.1.saturating_sub(1);
            }
        }
    }
}

#[derive(Default)]
struct Reads { observed: Vec<(String, String)>, invalid: bool }
thread_local! { static READS: RefCell<Vec<Reads>> = const { RefCell::new(Vec::new()) }; }
/// Called on the requesting thread only after an actual successful vault read.
pub(crate) fn observe_read(reference: &str, before: Option<String>, has_secret: bool) {
    let after = revision(reference);
    READS.with(|reads| {
        for scope in reads.borrow_mut().iter_mut() {
            if has_secret && before.is_some() && before == after {
                scope.observed.push((reference_key(reference), before.clone().unwrap()));
            } else { scope.invalid = true; }
        }
    });
}
/// Observe after the blocking vault worker returns, on the probe's executing thread.
pub(crate) fn read_with_revision(
    reference: &str,
    read: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    let before = revision(reference);
    let result = read();
    observe_read(reference, before, matches!(&result, Ok(Some(secret)) if !secret.is_empty()));
    result
}

// A thread-local scope must never be moved to another worker for Drop/attestation.
pub(crate) struct ProbeCredentialScope(std::marker::PhantomData<std::rc::Rc<()>>);
impl ProbeCredentialScope {
    pub(crate) fn begin() -> Self {
        READS.with(|reads| reads.borrow_mut().push(Reads::default()));
        Self(std::marker::PhantomData)
    }
    pub(crate) fn attest(&self, provider: &ProviderDraftInput, result: &mut ProviderProbeProfileRuntime) {
        let reference = reference_key(&provider.auth_ref.reference);
        let evidence = READS.with(|reads| {
            let reads = reads.borrow();
            let scope = reads.last()?;
            if scope.invalid || scope.observed.is_empty() { return None; }
            let revision = scope.observed[0].1.clone();
            scope.observed.iter().all(|item| item == &(reference.clone(), revision.clone())).then_some(revision)
        });
        let mut state = match authority().lock() { Ok(state) => state, Err(_) => { invalidate_unproven_custom_result(provider, result); return; } };
        let current = revision_locked(&mut state, &reference);
        if evidence.is_none() || evidence != current || result.error.is_some() {
            invalidate_unproven_custom_result(provider, result);
            return;
        }
        result.id = format!("credential-proof:{}", Uuid::new_v4());
        let snapshot = serde_json::json!({
            "profileId": result.id, "verdict": result.verdict, "checkedAt": result.checked_at,
            "streamSupported": result.stream_supported, "errorShapeStable": result.error_shape_stable,
            "responseShapeStable": result.response_shape_stable,
        });
        state.proofs.retain(|_, proof| proof.provider.provider_id != provider.provider_id || proof.provider.template_id != provider.template_id);
        state.proofs.insert(result.id.clone(), Proof {
            reference, revision: evidence.unwrap(), provider: comparable_provider(provider.clone()), snapshot,
        });
    }
}
impl Drop for ProbeCredentialScope {
    fn drop(&mut self) { READS.with(|reads| { reads.borrow_mut().pop(); }); }
}
fn is_known_model(provider: &ProviderDraftInput) -> bool {
    matches!(crate::provider::provider_manifest::manifest_model_capability_metadata(provider, &provider.model, None), Ok(Some(_)))
}
fn invalidate_unproven_custom_result(provider: &ProviderDraftInput, result: &mut ProviderProbeProfileRuntime) {
    // Built-in model operation/diagnostics do not require a custom-model receipt.
    if is_known_model(provider) { return; }
    result.checked_at = "pending-probe".into();
    // A stale successful network response must not be presented as verified.
    if result.error.is_none() {
        result.verdict = "unavailable".into();
        result.error = Some(crate::provider::contracts::ProviderRuntimeError::new(
            "auth.invalid", "Credential verification is no longer current; verify again.",
        ));
    }
}
fn comparable_provider(mut provider: ProviderDraftInput) -> ProviderDraftInput {
    provider.model_catalog_cache = Default::default();
    provider
}

/// Used at the repository boundary, including callers without a renderer.
pub(crate) fn reconcile_config(config: &mut Value) {
    let state = authority().lock().ok();
    let Some(providers) = config.get_mut("providers").and_then(Value::as_array_mut) else { return; };
    for provider in providers {
        let known = serde_json::from_value::<ProviderDraftInput>(provider.clone()).ok()
            .is_some_and(|input| is_known_model(&input));
        let valid = (|| {
            let state = state.as_ref()?;
            let probe = provider.get("probe")?;
            let proof = state.proofs.get(probe.get("profileId")?.as_str()?)?;
            let (revision, pending) = state.revisions.get(&proof.reference)?;
            if *pending != 0 || revision != &proof.revision { return None; }
            let input: ProviderDraftInput = serde_json::from_value(provider.clone()).ok()?;
            if comparable_provider(input) != proof.provider { return None; }
            if !proof.snapshot.as_object()?.iter().all(|(key, value)| probe.get(key) == Some(value)) { return None; }
            Some(())
        })().is_some();
        if !valid {
            if let Some(object) = provider.as_object_mut() {
                // Preserve known models' existing operational readiness across restart.
                // Only the custom verification claim loses authority without a receipt.
                if !known { object.insert("status".into(), Value::String("draft".into())); }
                if let Some(probe) = object.get_mut("probe").and_then(Value::as_object_mut) {
                    if !known { probe.insert("checkedAt".into(), Value::String("pending-probe".into())); }
                    probe.remove("configurationSignature");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
