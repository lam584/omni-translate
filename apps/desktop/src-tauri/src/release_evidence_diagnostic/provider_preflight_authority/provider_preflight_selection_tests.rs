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
const results = [];
for (const releaseSelection of [undefined, { modelId: 'qwen3.8-livetranslate-flash-realtime', endpointHost: 'acceptance.cn-beijing.maas.aliyuncs.com', region: 'cn-beijing' }]) {
  const workers = [{ workerId: 'local', workspaceRoot: 'E:/fixture', transportAuthority: { kind: 'local' }, interactiveUser: 'tester', vmIdentity: { provider: 'vmware', uuidBios: 'fixture-vm' }, deviceProfileInstances: [{ instanceId: 'local-default', profileId: 'vmware-hda-default', deviceClass: 'default-speaker', physicalPlaybackDeviceId: 'default', expectedPhysicalPlaybackDeviceName: '' }] }];
  const assignments = liveCellsForReleasePlan(createBalancedReleasePlan(releaseSelection)).map((cell, index) => ({ cellId: cell.cellId, workerId: 'local', waveIndex: index, deviceProfileInstanceId: 'local-default', leaseId: 'lease-' + index }));
  const generatedAt = new Date();
  const signingKeys = generateCoordinatorSigningKeyPair();
  const common = { executionId: 'rust-node-preflight-test', generatedAt, provenance: { schemaVersion: 1, source: 'git', captureStatus: 'captured', headCommit: '1'.repeat(40), worktreeClean: true, dirtyEntryCount: 0 }, runtimeBinaryHashes: [authority('runtime/fixture.exe')], workers, assignments, releaseSelection };
  const grant = createProviderPreflightGrant({ ...common, expiresAt: new Date(generatedAt.getTime() + 3600000), authorityImplementationHashes: [authority('matrix/fixture.mjs')], shardOrchestrationImplementationHashes: [authority('shard/fixture.mjs')], localIsolationAuthority: { ...authority('local/isolation.json'), providerCalls: 0 }, workerReadinessRequest: createWorkerReadinessRequest(common), workerReadinessRequestAuthority: authority('worker-readiness-request.json'), workerReadinessAuthorities: [{ ...authority('worker-readiness/local.json'), workerId: 'local', providerCalls: 0 }], signingKeys });
  const leaseReservations = createProviderPreflightLeaseReservations({ grant, signingKeys, issuedAt: new Date(generatedAt.getTime() + 1) });
  results.push({ grant, consumption: providerPreflightAuthorizationConsumption({ grant, leaseReservations }) });
}
console.log(JSON.stringify(results));
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "-e", script]).current_dir(root)
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
