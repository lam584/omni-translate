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
    let identity = selected_registry_identity(&parsed, profile)?;
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

fn v2_grant_fixture() -> Value {
    let mut grant = grant_fixture(PreflightAuthorityProfile::StrictReleaseMatrix, 1);
    grant["releaseSelection"] = json!({ "modelId": PREFLIGHT_MODEL_V2,
        "endpointHost": "acceptance.cn-beijing.maas.aliyuncs.com", "region": "cn-beijing" });
    grant["workerReadinessRequest"] = json!({"releaseSelection": grant["releaseSelection"].clone()});
    let identity = selected_registry_identity(&grant, PreflightAuthorityProfile::StrictReleaseMatrix)
        .unwrap().unwrap();
    grant["authorization"]["model"] = json!(PREFLIGHT_MODEL_V2);
    grant["authorization"]["modelProtocolProfileIdentity"] = json!(identity);
    // Explicit 3.8 selection uses the canonical full-matrix AEC authority,
    // rather than the legacy 3.5 budget inherited from grant_fixture.
    grant["budget"]["cellMaxExternalAudioSamples"] = json!(2_880_000);
    grant["budget"]["matrixMaxExternalAudioSamples"] = json!(10_807_135);
    for (index, cell) in grant["cells"].as_array_mut().unwrap().iter_mut().enumerate() {
        if index == 2 {
            cell["maxExternalAudioSamples"] = json!(2_880_000);
            cell["completionPolicy"] = json!("aec-output-quiescent-v2");
        }
        cell["cellId"] = json!(cell["cellId"].as_str().unwrap().replace(PREFLIGHT_MODEL, PREFLIGHT_MODEL_V2));
        cell["modelId"] = json!(PREFLIGHT_MODEL_V2);
        cell["modelProtocolProfileIdentity"] = json!(identity);
    }
    grant
}

#[test]
fn signed_v2_release_is_exactly_four_cells_and_registry_authorized() {
    let grant = v2_grant_fixture();
    assert_eq!(grant["cells"].as_array().unwrap().len(), 4);
    assert_eq!(grant["budget"]["cellMaxExternalAudioSamples"], 2_880_000);
    assert_eq!(grant["budget"]["matrixMaxExternalAudioSamples"], 10_807_135);
    let cells = grant["cells"].as_array().unwrap();
    assert_eq!(cells.iter().map(|cell| cell["maxExternalAudioSamples"].as_u64().unwrap())
        .collect::<Vec<_>>(), vec![2_877_045, 2_173_045, 2_880_000, 2_877_045]);
    assert_eq!(cells[2]["completionPolicy"], "aec-output-quiescent-v2");
    for index in [0, 1, 3] {
        assert!(cells[index].get("completionPolicy").is_none());
    }
    verify_fixture(grant, PreflightAuthorityProfile::StrictReleaseMatrix).unwrap();
}

#[test]
fn resigned_v2_release_rejects_budget_and_completion_policy_tampering() {
    let profile = PreflightAuthorityProfile::StrictReleaseMatrix;
    let valid = v2_grant_fixture();
    verify_fixture(valid.clone(), profile).unwrap();
    for (pointer, value, expected_error) in [
        ("/budget/cellMaxExternalAudioSamples", json!(2_877_045), "worker/local/budget authority"),
        ("/budget/matrixMaxExternalAudioSamples", json!(10_100_180), "worker/local/budget authority"),
        ("/budget/matrixMaxExternalAudioSamples", json!(10_807_136), "worker/local/budget authority"),
        ("/cells/2/maxExternalAudioSamples", json!(2_173_045), "cell 2 is not canonical"),
        ("/cells/2/maxExternalAudioSamples", json!(2_880_001), "cell 2 is not canonical"),
        ("/cells/2/completionPolicy", json!("media-input-complete-v1"), "cell 2 completion/scope is not canonical"),
    ] {
        let mut changed = valid.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        // Re-sign each mutation so rejection proves semantic authority validation,
        // not merely detection of a broken signature.
        let error = verify_fixture(changed, profile).unwrap_err();
        assert!(error.contains(expected_error), "{pointer}: {error}");
    }
    let mut missing_policy = valid.clone();
    missing_policy["cells"][2].as_object_mut().unwrap().remove("completionPolicy");
    assert!(verify_fixture(missing_policy, profile).unwrap_err()
        .contains("cell 2 completion/scope is not canonical"));
    for index in [0, 1, 3] {
        let mut extra_policy = valid.clone();
        extra_policy["cells"][index]["completionPolicy"] = json!("aec-output-quiescent-v2");
        assert!(verify_fixture(extra_policy, profile).unwrap_err()
            .contains(&format!("cell {index} completion/scope is not canonical")));
    }
}

#[test]
fn signed_v2_release_rejects_generic_missing_selection_and_mixed_cells() {
    let profile = PreflightAuthorityProfile::StrictReleaseMatrix;
    let original = v2_grant_fixture();
    for pointer in ["/releaseSelection/endpointHost", "/releaseSelection/region",
        "/authorization/model", "/cells/0/modelId", "/cells/1/modelProtocolProfileIdentity/exactModelId",
        "/cells/2/modelProtocolProfileIdentity/wireDialect", "/cells/3/leaseId"] {
        let mut grant = original.clone();
        *grant.pointer_mut(pointer).unwrap() = json!(match pointer {
            "/releaseSelection/endpointHost" => PROVIDER_ENDPOINT_HOST,
            "/releaseSelection/region" => "ap-southeast-1",
            "/cells/2/modelProtocolProfileIdentity/wireDialect" => "bailian-livetranslate-session-ws-v1",
            "/cells/3/leaseId" => "lease-0",
            _ => PREFLIGHT_MODEL,
        });
        assert!(verify_fixture(grant, profile).is_err(), "{pointer}");
    }
    let mut missing = original;
    missing.as_object_mut().unwrap().remove("releaseSelection");
    assert!(verify_fixture(missing, profile).is_err());
}

#[test]
fn resigned_v2_grant_cannot_substitute_readiness_selection() {
    let profile = PreflightAuthorityProfile::StrictReleaseMatrix;
    let valid = v2_grant_fixture();
    for field in ["modelId", "endpointHost", "region"] {
        let mut changed = valid.clone();
        changed["workerReadinessRequest"]["releaseSelection"][field] = json!("substituted");
        assert!(verify_fixture(changed, profile).unwrap_err().contains("readiness releaseSelection"));
    }
    let mut missing = valid.clone();
    missing.as_object_mut().unwrap().remove("workerReadinessRequest");
    assert!(verify_fixture(missing, profile).unwrap_err().contains("readiness releaseSelection"));
    let mut downgraded = valid;
    downgraded.as_object_mut().unwrap().remove("releaseSelection");
    assert!(verify_fixture(downgraded, profile).unwrap_err().contains("readiness releaseSelection"));
}
