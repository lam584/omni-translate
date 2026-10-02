use super::*;

// Executes the checked-in Node producers, including grant and lease signature
// verification. Fixture signing keys are generated in memory; no provider/key store.
#[test]
fn node_consumption_selection_and_digest_match_rust_for_both_models() {
    let script = r#"
import { createBalancedReleasePlan, liveCellsForReleasePlan } from './scripts/testing/watch-mode-balanced-release-plan.mjs';
import { createWorkerReadinessRequest, generateCoordinatorSigningKeyPair } from './scripts/testing/watch-mode-shard-authority.mjs';
import { createProviderPreflightGrant, createProviderPreflightLeaseReservations, providerPreflightAuthorizationConsumption } from './scripts/testing/watch-mode-provider-preflight-authorization.mjs';
const authority = path => ({ path, bytes: 17, sha256: 'a'.repeat(64) });
import fs from 'node:fs';
import crypto from 'node:crypto';
const executable = fs.readFileSync(process.argv[1]);
const runtime = {path: 'target/release/omni-desktop-shell.exe', bytes: executable.length, sha256: crypto.createHash('sha256').update(executable).digest('hex')};
const selection = {modelId: 'qwen3.8-livetranslate-flash-realtime', endpointHost: 'acceptance.cn-beijing.maas.aliyuncs.com', region: 'cn-beijing'};
const results = [];
for (const releaseSelection of [undefined, selection, ...['vm131', 'vm171'].map(aecWorker => ({...selection, executionScope: 'aec-c03-iteration', aecWorker}))]) {
  const workerId = releaseSelection?.aecWorker ?? 'local';
  const workers = [{ workerId, workspaceRoot: 'E:/fixture', transportAuthority: { kind: 'local' }, interactiveUser: 'tester', vmIdentity: { provider: 'vmware', uuidBios: 'fixture-vm' }, deviceProfileInstances: [{ instanceId: 'local-default', profileId: 'vmware-hda-default', deviceClass: 'default-speaker', physicalPlaybackDeviceId: 'default', expectedPhysicalPlaybackDeviceName: '' }] }];
  const assignments = liveCellsForReleasePlan(createBalancedReleasePlan(releaseSelection)).map((cell, index) => ({ cellId: cell.cellId, workerId, waveIndex: index, deviceProfileInstanceId: 'local-default', leaseId: 'lease-' + index }));
  const generatedAt = new Date();
  const signingKeys = generateCoordinatorSigningKeyPair();
  const common = { executionId: 'rust-node-preflight-test', generatedAt, provenance: { schemaVersion: 1, source: 'git', captureStatus: 'captured', headCommit: '1'.repeat(40), worktreeClean: true, dirtyEntryCount: 0 }, runtimeBinaryHashes: [runtime], workers, assignments, releaseSelection };
  const grant = createProviderPreflightGrant({ ...common, expiresAt: new Date(generatedAt.getTime() + 3600000), authorityImplementationHashes: [authority('matrix/fixture.mjs')], shardOrchestrationImplementationHashes: [authority('shard/fixture.mjs')], localIsolationAuthority: { ...authority('local/isolation.json'), providerCalls: 0 }, workerReadinessRequest: createWorkerReadinessRequest(common), workerReadinessRequestAuthority: authority('worker-readiness-request.json'), workerReadinessAuthorities: [{ ...authority('worker-readiness/' + workerId + '.json'), workerId, providerCalls: 0 }], signingKeys });
  const leaseReservations = createProviderPreflightLeaseReservations({ grant, signingKeys, issuedAt: new Date(generatedAt.getTime() + 1) });
  results.push({ grant, consumption: providerPreflightAuthorizationConsumption({ grant, leaseReservations }) });
}
console.log(JSON.stringify(results));
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(std::env::current_exe().unwrap()).current_dir(root)
        .output().expect("Node is required for the cross-language contract regression");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let fixtures: Value = serde_json::from_slice(&output.stdout).unwrap();
    for fixture in fixtures.as_array().unwrap() {
        let grant = &fixture["grant"];
        let consumption = &fixture["consumption"];
        verify_signed_authority(grant, Some(grant["coordinator"]["publicKeyPem"].as_str().unwrap()), "Node grant").unwrap();
        validate_readiness_selection(grant).unwrap();
        let mut projected = serde_json::Map::new();
        copy_release_selection(grant, &mut projected);
        assert_eq!(projected.get("releaseSelection"), consumption.get("releaseSelection"));
        assert_eq!(projected.contains_key("releaseSelection"), grant.get("releaseSelection").is_some());
        let digests = consumption["leaseReservationDigests"].as_array().unwrap()
            .to_vec();
        assert_eq!(preflight_authorization_digest(grant, &digests, PreflightAuthorityProfile::StrictReleaseMatrix).unwrap(),
            consumption["authorizationDigest"].as_str().unwrap());
        let identity = selected_registry_identity(grant, PreflightAuthorityProfile::StrictReleaseMatrix).unwrap().unwrap();
        validate_model_protocol_profile_identity(consumption.get("modelProtocolProfileIdentity"), &identity, "Node consumption").unwrap();
        let profile = PreflightAuthorityProfile::StrictReleaseMatrix;
        validate_grant(grant, &"1".repeat(40), profile, Some(&identity)).unwrap();
        let scope = GrantCellScope::from_grant(grant, profile).unwrap();
        assert_eq!(scope.cell_count(), grant["cells"].as_array().unwrap().len());
        assert_eq!(scope.matrix_max_samples(), grant["budget"]["matrixMaxExternalAudioSamples"].as_u64().unwrap());
        for (index, cell) in grant["cells"].as_array().unwrap().iter().enumerate() {
            assert_eq!(scope.cell_max_samples(index), cell["maxExternalAudioSamples"].as_u64().unwrap());
        }
        if scope.model == PREFLIGHT_MODEL_V2 {
            let mut old_budget = grant.clone();
            old_budget["budget"]["matrixMaxExternalAudioSamples"] = json!(10_100_180);
            assert!(validate_grant(&old_budget, &"1".repeat(40), profile, Some(&identity)).is_err());
            let aec_index = if scope.aec_worker.is_some() { 0 } else { 2 };
            for policy in [Value::Null, json!("media-input-complete-v1")] {
                let mut changed = grant.clone();
                changed["cells"][aec_index]["completionPolicy"] = policy;
                assert!(validate_grant(&changed, &"1".repeat(40), profile, Some(&identity)).is_err());
            }
        }
        if scope.aec_worker.is_some() {
            for pointer in ["/executor/workerId", "/cells/0/workerId", "/releaseSelection/aecWorker"] {
                let mut changed = grant.clone();
                *changed.pointer_mut(pointer).unwrap() = json!("foreign");
                assert!(validate_grant(&changed, &"1".repeat(40), profile, Some(&identity)).is_err());
            }
            let mut changed = grant.clone();
            changed["cells"][0]["waveIndex"] = json!(1);
            assert!(validate_grant(&changed, &"1".repeat(40), profile, Some(&identity)).is_err());
        }
    }
}

#[test]
fn readiness_cannot_substitute_or_drop_the_signed_selection() {
    let selection = json!({"modelId": PREFLIGHT_MODEL_V2,
        "endpointHost": "acceptance.cn-beijing.maas.aliyuncs.com", "region": "cn-beijing"});
    let valid = json!({"releaseSelection": selection, "workerReadinessRequest": {"releaseSelection": selection}});
    validate_readiness_selection(&valid).unwrap();
    validate_readiness_selection(&json!({})).unwrap();
    for pointer in ["/releaseSelection", "/workerReadinessRequest/releaseSelection"] {
        let mut changed = valid.clone();
        *changed.pointer_mut(pointer).unwrap() = Value::Null;
        assert!(validate_readiness_selection(&changed).is_err());
    }
    for field in ["modelId", "endpointHost", "region"] {
        let mut changed = valid.clone();
        changed["workerReadinessRequest"]["releaseSelection"][field] = json!("substitution");
        assert!(validate_readiness_selection(&changed).is_err());
    }
    let mut missing = valid.clone();
    missing.as_object_mut().unwrap().remove("workerReadinessRequest");
    assert!(validate_readiness_selection(&missing).is_err());
    let mut downgrade = valid;
    downgrade.as_object_mut().unwrap().remove("releaseSelection");
    assert!(validate_readiness_selection(&downgrade).is_err());
}
