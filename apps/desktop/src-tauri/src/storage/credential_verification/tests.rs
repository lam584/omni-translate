use super::*;
use crate::provider::contracts::ProviderRoutingDecision;
use crate::storage::repository::ConfigRepository;
use serde_json::json;

fn fixture() -> (tempfile::TempDir, ConfigRepository, Value, ProviderDraftInput) {
    let dir = tempfile::tempdir().unwrap();
    let repo = ConfigRepository::new(dir.path().join("config.db"), dir.path().join("exports"), dir.path().join("snapshots"));
    repo.initialize().unwrap();
    let mut config = repo.load_config().unwrap();
    config["providers"].as_array_mut().unwrap().truncate(1);
    config["providers"][0]["model"] = json!("custom-credential-test-model");
    config["providers"][0]["providerId"] = json!(format!("test-provider-{}", Uuid::new_v4()));
    config["providers"][0]["authRef"]["reference"] = json!(format!("credential://test/{}", Uuid::new_v4()));
    let provider = serde_json::from_value(config["providers"][0].clone()).unwrap();
    (dir, repo, config, provider)
}
fn result(provider: &ProviderDraftInput) -> ProviderProbeProfileRuntime {
    ProviderProbeProfileRuntime {
        id: "unsigned".into(), template_id: provider.template_id.clone(), provider_id: provider.provider_id.clone(),
        verdict: "available".into(), checked_at: "2026-09-21T00:00:00Z".into(), measured_latency_ms: 1, latency_budget_ms: 1000,
        stream_supported: true, error_shape_stable: true, response_shape_stable: true,
        transport_requested: "http".into(), transport_effective: "http".into(), fallback_applied: false,
        input_tokens: None, output_tokens: None, audio_seconds: None, connection_attempts: 1,
        connection_count: 1, connection_opened: true, connection_closed: true, connection_owner: None,
        connection_generation: None, checks: vec![], guidance: vec![],
        routing_decision: ProviderRoutingDecision::for_verdict("available", 1, false), error: None, wire_evidence: None,
    }
}
fn attest(config: &mut Value, provider: &ProviderDraftInput) -> String {
    let scope = ProbeCredentialScope::begin();
    let reference = &provider.auth_ref.reference;
    observe_read(reference, revision(reference), true);
    let mut result = result(provider);
    scope.attest(provider, &mut result);
    assert!(result.error.is_none());
    let proof = authority().lock().unwrap().proofs.get(&result.id).unwrap().snapshot.clone();
    config["providers"][0]["probe"] = proof;
    config["providers"][0]["status"] = json!("ready");
    result.id
}
fn pending(config: &Value) { assert_eq!(config["providers"][0]["probe"]["checkedAt"], "pending-probe"); }

#[test]
fn repository_save_load_import_reject_revoked_and_unsigned_evidence_without_renderer() {
    let (dir, repo, mut config, provider) = fixture();
    attest(&mut config, &provider);
    repo.save_config(&config).unwrap();
    assert_eq!(repo.load_config().unwrap()["providers"][0]["status"], "ready");
    // A vault write starts revocation before any OS write or success response.
    let write = CredentialWrite::begin(&provider.auth_ref.reference).unwrap();
    pending(&repo.load_config().unwrap());
    drop(write);
    // A stale frontend save cannot restore a previously valid proof.
    repo.save_config(&config).unwrap();
    pending(&repo.load_config().unwrap());
    let path = dir.path().join("import.json");
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    pending(&repo.import_config(&path).unwrap());
    config["providers"][0]["probe"]["profileId"] = json!("legacy-unsigned");
    repo.save_config(&config).unwrap();
    pending(&repo.load_config().unwrap());
}

#[test]
fn new_session_cannot_restore_proof_even_with_matching_config_and_revision_text() {
    let (_dir, repo, mut config, provider) = fixture();
    let id = attest(&mut config, &provider);
    repo.save_config(&config).unwrap();
    // Simulate loss of this session's authority, without disrupting parallel tests.
    authority().lock().unwrap().proofs.remove(&id);
    pending(&repo.load_config().unwrap());
}

#[test]
fn old_probe_after_rotation_or_without_actual_read_cannot_attest() {
    let (_dir, _repo, _config, provider) = fixture();
    let scope = ProbeCredentialScope::begin();
    let mut no_read = result(&provider);
    scope.attest(&provider, &mut no_read);
    assert_eq!(no_read.checked_at, "pending-probe");
    observe_read(&provider.auth_ref.reference, revision(&provider.auth_ref.reference), true);
    drop(CredentialWrite::begin(&provider.auth_ref.reference).unwrap());
    let mut old_result = result(&provider);
    scope.attest(&provider, &mut old_result);
    assert!(old_result.error.is_some());
    assert!(!old_result.id.starts_with("credential-proof:"));
}

#[test]
fn overlapping_and_timed_out_worker_writes_remain_pending_until_workers_finish() {
    let reference = format!("credential://overlap/{}", Uuid::new_v4());
    let before = revision(&reference).unwrap();
    let first = CredentialWrite::begin(&reference).unwrap();
    let second = CredentialWrite::begin(&reference).unwrap();
    assert!(revision(&reference).is_none());
    drop(first);
    assert!(revision(&reference).is_none());
    let (release, wait) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || { let _write = second; wait.recv().unwrap(); });
    // Caller may already have returned a timeout; worker still owns revocation.
    assert!(revision(&reference).is_none());
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_ne!(revision(&reference).unwrap(), before);
}

#[test]
fn proof_cannot_be_reused_by_another_instance_or_changed_connection() {
    let (_dir, _repo, mut config, provider) = fixture();
    attest(&mut config, &provider);
    for (field, changed) in [("providerId", "other-instance"), ("model", "other-model"), ("baseUrl", "https://different.invalid")] {
        let mut edited = config.clone();
        edited["providers"][0][field] = json!(changed);
        reconcile_config(&mut edited);
        pending(&edited);
    }
    let mut tampered = config.clone();
    tampered["providers"][0]["probe"]["checkedAt"] = json!("forged");
    reconcile_config(&mut tampered);
    pending(&tampered);
    let other = format!("credential://unrelated/{}", Uuid::new_v4());
    drop(CredentialWrite::begin(&other).unwrap());
    reconcile_config(&mut config);
    assert_eq!(config["providers"][0]["status"], "ready");
}

#[test]
fn normalized_alias_write_revokes_shared_vault_identity() {
    let (_dir, _repo, mut config, provider) = fixture();
    attest(&mut config, &provider);
    let alias = super::super::credential::normalize_reference(&provider.auth_ref.reference).to_uppercase();
    drop(CredentialWrite::begin(&alias).unwrap());
    reconcile_config(&mut config);
    pending(&config);
}

#[test]
fn known_models_keep_operational_readiness_on_restart_without_custom_verification_claim() {
    let (_dir, repo, config, _) = fixture();
    let bundle: Value = serde_json::from_str(include_str!("../../../../../../contracts/provider-manifests.compiled.v1.json")).unwrap();
    let mut checked = 0;
    let mut checked_35 = false;
    for manifest in bundle["manifests"].as_array().unwrap() {
        for model in manifest["models"].as_array().unwrap() {
            let mut known = config.clone();
            let row = &mut known["providers"][0];
            row["templateId"] = manifest["provider"]["templateId"].clone();
            row["manifestProviderId"] = manifest["provider"]["id"].clone();
            row["kind"] = json!(if manifest["provider"]["id"] == "bailian" { "dashscope" } else { "openai-compatible" });
            row["model"] = model["id"].clone();
            row["status"] = json!("ready");
            row["probe"]["profileId"] = json!("credential-proof:previous-process");
            row["probe"]["checkedAt"] = json!("2026-09-20T10:00:00Z");
            row["probe"]["configurationSignature"] = json!("untrusted-old-claim");
            let input: ProviderDraftInput = serde_json::from_value(row.clone()).unwrap();
            assert!(is_known_model(&input));
            let scope = ProbeCredentialScope::begin();
            let mut diagnostic = result(&input);
            scope.attest(&input, &mut diagnostic); // no read receipt must not break built-in diagnostics
            assert!(diagnostic.error.is_none());
            assert_eq!(diagnostic.verdict, "available");
            repo.save_config(&known).unwrap();
            let loaded = repo.load_config().unwrap();
            let saved = &loaded["providers"][0];
            assert_eq!(saved["status"], "ready");
            assert_eq!(saved["probe"]["checkedAt"], "2026-09-20T10:00:00Z");
            assert!(saved["probe"].get("configurationSignature").is_none());
            checked_35 |= model["id"] == "qwen3.5-livetranslate-flash-realtime";
            checked += 1;
        }
    }
    assert!(checked > 10);
    assert!(checked_35);
}

#[test]
fn probe_scope_created_inside_dispatched_worker_observes_vault_worker_read() {
    let (_dir, _repo, _config, provider) = fixture();
    std::thread::spawn(move || {
        // Gateway creates its scope inside the executing probe method, not before dispatch.
        let scope = ProbeCredentialScope::begin();
        read_with_revision(&provider.auth_ref.reference, || {
            std::thread::spawn(|| Ok(Some("offline-test-value".into()))).join().unwrap()
        }).unwrap();
        let mut result = result(&provider);
        scope.attest(&provider, &mut result);
        assert!(result.error.is_none());
        assert!(result.id.starts_with("credential-proof:"));
    }).join().unwrap();
}

#[test]
fn unrelated_thread_read_cannot_authenticate_parent_scope_or_leak_after_drop() {
    let (_dir, _repo, _config, provider) = fixture();
    let scope = ProbeCredentialScope::begin();
    let reference = provider.auth_ref.reference.clone();
    std::thread::spawn(move || {
        read_with_revision(&reference, || Ok(Some("offline-test-value".into()))).unwrap();
    }).join().unwrap();
    let mut unproven = result(&provider);
    scope.attest(&provider, &mut unproven);
    assert_eq!(unproven.checked_at, "pending-probe");
    drop(scope);
    let next = ProbeCredentialScope::begin();
    let mut unproven = result(&provider);
    next.attest(&provider, &mut unproven);
    assert_eq!(unproven.checked_at, "pending-probe");
}
