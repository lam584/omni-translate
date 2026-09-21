import assert from 'node:assert/strict';
import test from 'node:test';
import { createBalancedReleasePlan, liveCellsForReleasePlan } from './watch-mode-balanced-release-plan.mjs';
import { createWorkerReadinessRequest, generateCoordinatorSigningKeyPair, signCoordinatorAuthority } from './watch-mode-shard-authority.mjs';
import { createProviderPreflightGrant, verifyProviderPreflightGrant, createProviderPreflightLeaseReservations, providerPreflightAuthorizationConsumption } from './watch-mode-provider-preflight-authorization.mjs';

const selection = { modelId: 'qwen3.8-livetranslate-flash-realtime', endpointHost: 'acceptance.cn-beijing.maas.aliyuncs.com', region: 'cn-beijing' };
const authority = path => ({ path, bytes: 17, sha256: 'a'.repeat(64) });
function fixture(releaseSelection) {
  const workers = [{ workerId: 'local', workspaceRoot: 'E:/fixture', transportAuthority: { kind: 'local' }, interactiveUser: 'tester', vmIdentity: { provider: 'vmware', uuidBios: 'fixture-vm' }, deviceProfileInstances: [{ instanceId: 'local-default', profileId: 'vmware-hda-default', deviceClass: 'default-speaker', physicalPlaybackDeviceId: 'default', expectedPhysicalPlaybackDeviceName: '' }] }];
  const assignments = liveCellsForReleasePlan(createBalancedReleasePlan(releaseSelection)).map((cell, index) => ({ cellId: cell.cellId, workerId: 'local', waveIndex: index, deviceProfileInstanceId: 'local-default', leaseId: `lease-${index}` }));
  const provenance = { schemaVersion: 1, source: 'git', captureStatus: 'captured', headCommit: '1'.repeat(40), worktreeClean: true, dirtyEntryCount: 0 };
  const runtimeBinaryHashes = [authority('runtime/fixture.exe')];
  const generatedAt = new Date();
  const signingKeys = generateCoordinatorSigningKeyPair();
  const common = { executionId: 'dual-model-preflight-test', generatedAt, provenance, runtimeBinaryHashes, workers, assignments, releaseSelection };
  const grant = createProviderPreflightGrant({ ...common, expiresAt: new Date(generatedAt.getTime() + 3600000), authorityImplementationHashes: [authority('matrix/fixture.mjs')], shardOrchestrationImplementationHashes: [authority('shard/fixture.mjs')], localIsolationAuthority: { ...authority('local/isolation.json'), providerCalls: 0 }, workerReadinessRequest: createWorkerReadinessRequest(common), workerReadinessRequestAuthority: authority('worker-readiness-request.json'), workerReadinessAuthorities: [{ ...authority('worker-readiness/local.json'), workerId: 'local', providerCalls: 0 }], signingKeys });
  return { grant, signingKeys, generatedAt };
}

test('preflight grants preserve default 3.5 and bind explicit 3.8 through consumption', () => {
  for (const selected of [undefined, selection]) {
    const { grant, signingKeys, generatedAt } = fixture(selected);
    verifyProviderPreflightGrant(grant, { releaseSelection: selected });
    const leaseReservations = createProviderPreflightLeaseReservations({ grant, signingKeys, issuedAt: new Date(generatedAt.getTime() + 1) });
    const consumption = providerPreflightAuthorizationConsumption({ grant, leaseReservations });
    assert.deepEqual(consumption.releaseSelection, selected);
    assert.equal(grant.cells.length, 4);
    assert.equal(grant.budget.matrixMaxExternalAudioSamples, 10100180);
  }
});

test('re-signed preflight grants reject readiness workspace substitution and model downgrade', () => {
  const { grant, signingKeys } = fixture(selection);
  assert.throws(() => verifyProviderPreflightGrant(grant, { releaseSelection: undefined }), /releaseSelection mismatch/);
  for (const mutate of [
    value => { value.releaseSelection.endpointHost = 'other.cn-beijing.maas.aliyuncs.com'; },
    value => { delete value.releaseSelection; },
    value => { value.authorization.model = 'qwen3.5-livetranslate-flash-realtime'; },
    value => { value.cells[0].maxExternalAudioSamples++; },
  ]) {
    const changed = structuredClone(grant);
    delete changed.signature;
    delete changed.digest;
    mutate(changed);
    const signed = signCoordinatorAuthority(changed, signingKeys.privateKeyPem, signingKeys.publicKeyPem);
    assert.throws(() => verifyProviderPreflightGrant(signed));
  }
});
