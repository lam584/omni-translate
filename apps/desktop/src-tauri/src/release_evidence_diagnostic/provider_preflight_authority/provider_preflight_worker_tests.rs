use super::*;
use super::tests::sign_test_authority;

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

// Complete native-validator input, including a real executing-binary hash and
// registry-derived model identity. No Provider connection or credentials used.
fn grant_fixture(profile: PreflightAuthorityProfile, worker_count: usize) -> Value {
    let identity = profile.model_protocol_profile_identity().unwrap();
    let workers = (0..worker_count).map(|index| json!({
        "workerId": format!("vm{index}"),
        "interactiveUser": "VMUser",
        "vmIdentity": { "provider": "vmware", "uuidBios": format!("bios-{index}") },
        "transportAuthority": if index == 0 { json!({ "kind": "local" }) } else { json!({
            "kind": "ssh", "hostKeyAlias": format!("vm{index}"),
            "hostKeyAlgorithm": "ssh-ed25519",
            "hostKeySha256": format!("SHA256:{}", if index == 1 { "A" } else { "B" }.repeat(43)),
        }) },
    })).collect::<Vec<_>>();
    let cells = (0..profile.cell_count()).map(|index| {
        let (tier, feedback, device) = match profile {
            PreflightAuthorityProfile::StrictReleaseMatrix => (
                if index < 3 { "pairwise-live" } else { "model-stability" },
                CELL_FEEDBACK_MODES[index], CELL_DEVICE_CLASSES[index],
            ),
            PreflightAuthorityProfile::IncidentPlusReplay => (
                "incident-plus", ["process-exclusion", "virtual-driver", "echo-cancel"][index],
                ["default-speaker", "usb", "default-speaker"][index],
            ),
        };
        let mut cell = json!({
            "cellIndex": index,
            "cellId": format!("{tier}::{}::{feedback}::{device}", profile.preflight_model()),
            "providerId": PROVIDER_ID, "modelId": profile.preflight_model(),
            "protocol": profile.preflight_protocol(), "feedbackLoopPrevention": feedback,
            "deviceClass": device, "maxExternalAudioSamples": profile.cell_max_samples(index),
            "workerId": format!("vm{}", index % worker_count.max(1)),
            "waveIndex": index / worker_count.max(1), "leaseId": format!("lease-{index}"),
            "deviceProfileInstanceId": format!("profile-{index}"),
        });
        if let Some(identity) = &identity {
            cell["modelProtocolProfileIdentity"] = model_protocol_profile_identity_value(identity).unwrap();
        }
        cell
    }).collect::<Vec<_>>();
    let mut authorization = json!({
        "providerId": PROVIDER_ID, "model": profile.preflight_model(),
        "protocol": profile.preflight_protocol(), "operation": profile.operation(),
        "inputMode": if identity.is_some() { "none" } else { "text-only" },
        "systemPromptTemplate": "game-live-translation-cn", "invocationCount": 1,
        "externalAudioSamples": 0, "timeoutMs": 12000, "temperature": 0.2,
        "responseModalities": ["text"], "customHeaders": [],
    });
    if let Some(identity) = &identity {
        authorization["modelProtocolProfileIdentity"] = model_protocol_profile_identity_value(identity).unwrap();
        authorization["providerInputMode"] = json!("none");
        authorization["responseMode"] = json!("text-only");
        authorization["terminalEvent"] = json!("session.finished");
        authorization["lifecycleBudget"] = json!({ "firstServerEventLatencyMs": 1200, "socketEventTimeoutMs": 12000 });
    } else {
        authorization["tokenBudget"] = json!({ "maxInputTokens": 4096, "maxOutputTokens": 256 });
    }
    let executable = fs::read(std::env::current_exe().unwrap()).unwrap();
    json!({
        "schemaVersion": profile.signed_authority_schema_version(),
        "artifactKind": if identity.is_some() { GRANT_KIND } else { INCIDENT_GRANT_KIND },
        "incidentId": INCIDENT_ID,
        "provenance": { "source": "git", "captureStatus": "captured", "worktreeClean": true,
            "dirtyEntryCount": 0, "headCommit": HEAD },
        "workers": workers, "cells": cells, "authorization": authorization,
        "localIsolationAuthority": { "providerCalls": 0 },
        "budget": { "inputSampleRateHz": 16000, "cellMaxExternalAudioSamples": profile.declared_cell_max_samples(),
            "matrixMaxExternalAudioSamples": profile.matrix_max_samples(),
            "reclaimPolicy": "never-within-execution", "retryPolicy": "new-execution-required" },
        "runtimeBinaryHashes": [{ "path": "target/release/omni-desktop-shell.exe",
            "sha256": sha256_bytes(&executable), "bytes": executable.len() }],
    })
}

fn verify_fixture(core: Value, profile: PreflightAuthorityProfile) -> Result<(), String> {
    let signed = sign_test_authority(core.as_object().unwrap().clone());
    let bytes = serde_json::to_vec(&signed).unwrap();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    let public_key = required_str(&parsed, "/coordinator/publicKeyPem", "test key")?;
    verify_signed_authority(&parsed, Some(public_key), "signed worker fixture")?;
    let identity = profile.model_protocol_profile_identity()?;
    validate_grant(&parsed, HEAD, profile, identity.as_ref())
}

#[test]
fn signed_strict_grants_accept_one_to_four_workers_and_reject_zero_five() {
    let profile = PreflightAuthorityProfile::StrictReleaseMatrix;
    for count in 0..=5 {
        let result = verify_fixture(grant_fixture(profile, count), profile);
        if (1..=4).contains(&count) {
            result.unwrap_or_else(|error| panic!("{count} workers: {error}"));
        } else {
            assert!(result.unwrap_err().contains("worker/local/budget authority"));
        }
    }
}

#[test]
fn signed_incident_grants_still_require_exactly_two_workers() {
    let profile = PreflightAuthorityProfile::IncidentPlusReplay;
    for count in 0..=5 {
        let result = verify_fixture(grant_fixture(profile, count), profile);
        if count == 2 { result.unwrap(); } else {
            assert!(result.unwrap_err().contains("worker/local/budget authority"));
        }
    }
}

#[test]
fn signed_multiworker_grants_reject_duplicate_workers_slots_and_leases() {
    let profile = PreflightAuthorityProfile::StrictReleaseMatrix;
    let valid = grant_fixture(profile, 3);
    let mut duplicate_worker = valid.clone();
    duplicate_worker["workers"][1]["workerId"] = json!("vm0");
    assert!(verify_fixture(duplicate_worker, profile).unwrap_err().contains("identities must be unique"));
    let mut duplicate_slot = valid.clone();
    duplicate_slot["cells"][1]["workerId"] = json!("vm0");
    assert!(verify_fixture(duplicate_slot, profile).unwrap_err().contains("cell 1 is not canonical"));
    let mut duplicate_lease = valid;
    duplicate_lease["cells"][1]["leaseId"] = json!("lease-0");
    assert!(verify_fixture(duplicate_lease, profile).unwrap_err().contains("cell 1 is not canonical"));
}

#[test]
fn signed_transport_fields_survive_roundtrip_and_tampering_breaks_signature() {
    let signed = sign_test_authority(grant_fixture(PreflightAuthorityProfile::StrictReleaseMatrix, 3).as_object().unwrap().clone());
    let mut parsed: Value = serde_json::from_slice(&serde_json::to_vec(&signed).unwrap()).unwrap();
    assert_eq!(parsed["workers"][1]["transportAuthority"], signed["workers"][1]["transportAuthority"]);
    let public_key = required_str(&parsed, "/coordinator/publicKeyPem", "test key").unwrap().to_string();
    verify_signed_authority(&parsed, Some(&public_key), "transport roundtrip").unwrap();
    parsed["workers"][1]["transportAuthority"]["hostKeyAlias"] = json!("different-worker");
    assert!(verify_signed_authority(&parsed, Some(&public_key), "transport tamper").unwrap_err().contains("digest mismatch"));
    let mut core = parsed.as_object().unwrap().clone();
    core.remove("signature");
    core.remove("digest");
    parsed["digest"] = json!(sha256_canonical(&Value::Object(core)).unwrap());
    assert!(verify_signed_authority(&parsed, Some(&public_key), "transport rehash").unwrap_err().contains("signature verification failed"));
}
