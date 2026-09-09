import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteProviderPreflightDispatch, validateRemotePreflightRequest } from './run-watch-mode-provider-preflight-worker.mjs';
import { sha256Canonical } from './watch-mode-shard-authority.mjs';

const SHA = 'a'.repeat(64);
const request = (workerId = 'vm131') => ({
  schemaVersion: 1,
  artifactKind: 'watch-mode-remote-provider-preflight-request',
  executionId: 'remote-preflight-fixture',
  executor: {
    workerId, interactiveUser: 'VMUser',
    workspaceRoot: 'E:\\watch-worker',
    transportAuthority: { kind: 'ssh', hostKeyAlias: workerId, hostKeyAlgorithm: 'ssh-ed25519', hostKeySha256: `SHA256:${'A'.repeat(43)}` },
    vmIdentity: { provider: 'vmware', uuidBios: '969f4d56-84f8-d592-ca8a-4536ae2cd4ec' },
    vmIdentityDigest: sha256Canonical({ provider: 'vmware', uuidBios: '969f4d56-84f8-d592-ca8a-4536ae2cd4ec' }), runtimeBundleDigest: SHA,
    readinessAuthority: { path: `worker-readiness/${workerId}.json`, bytes: 10, sha256: SHA, providerCalls: 0, workerId },
  },
  grantPath: 'E:\\remote\\provider-preflight-grant.json',
  leaseReservationDirectory: 'E:\\remote\\provider-preflight-lease-reservations',
  authorizationDigest: SHA,
  executablePath: 'E:\\watch-worker\\target\\release\\omni-desktop-shell.exe',
  outputDirectory: 'E:\\remote\\evidence',
});

const observation = () => ({
  observedWorkerId: 'vm131', observedInteractiveUser: 'VMUser',
  observedVmIdentity: request().executor.vmIdentity,
  observedRuntimeBundleDigest: SHA,
  observedReadinessAuthority: request().executor.readinessAuthority,
});

test('request binds one vm131 executor and fixed no-retry budget', () => {
  const value = validateRemotePreflightRequest(request(), observation());
  assert.equal(value.executor.workerId, 'vm131');
  assert.equal(value.lifecycleBudget.firstServerEventLatencyMs, 1_200);
  assert.equal(value.retryPolicy, 'new-execution-required');
});

test('request accepts a different explicitly signed SSH executor instead of a fixed worker name', () => {
  const signed = request('vm167');
  const observed = {
    ...observation(),
    observedWorkerId: 'vm167',
    observedVmIdentity: signed.executor.vmIdentity,
    observedReadinessAuthority: signed.executor.readinessAuthority,
  };
  const value = validateRemotePreflightRequest(signed, observed);
  assert.equal(value.executor.workerId, 'vm167');
  assert.equal(value.retryPolicy, 'new-execution-required');
});

test('identity, runtime hash, and readiness mismatch fail before Provider dispatch', async () => {
  for (const overrides of [
    { observedWorkerId: 'vm169' },
    { observedRuntimeBundleDigest: 'b'.repeat(64) },
    { observedReadinessAuthority: { ...request().executor.readinessAuthority, sha256: 'b'.repeat(64) } },
  ]) {
    let calls = 0;
    const dispatch = createRemoteProviderPreflightDispatch({
      inspectExecutor: async () => ({ ...observation(), ...overrides }),
      claimAuthorization: async () => ({ claimed: true }),
      runProviderPreflight: async () => { calls += 1; return { status: 'completed' }; },
      collectEvidence: async (result) => result,
    });
    await assert.rejects(dispatch(request()));
    assert.equal(calls, 0);
  }
});

test('existing claim is zero-call; SSH and collection failures never retry or fall back', async () => {
  let calls = 0;
  const base = {
    inspectExecutor: async () => observation(),
    runProviderPreflight: async () => { calls += 1; throw new Error('ssh failed'); },
    collectEvidence: async () => { throw new Error('collection failed'); },
  };
  await assert.rejects(createRemoteProviderPreflightDispatch({ ...base, claimAuthorization: async () => ({ claimed: false }) })(request()), /already consumed/);
  assert.equal(calls, 0);
  await assert.rejects(createRemoteProviderPreflightDispatch({ ...base, claimAuthorization: async () => ({ claimed: true }) })(request()), /ssh failed/);
  assert.equal(calls, 1);
  await assert.rejects(createRemoteProviderPreflightDispatch({
    ...base, claimAuthorization: async () => ({ claimed: true }),
    runProviderPreflight: async () => { calls += 1; return { status: 'completed' }; },
  })(request()), /collection failed/);
  assert.equal(calls, 2);
});

test('secret-shaped material is rejected from request JSON', () => {
  for (const [key, value] of [['apiKey', 'secret'], ['credential', 'secret'], ['environment', { TOKEN: 'secret' }], ['argv', ['secret']]]) {
    assert.throws(() => validateRemotePreflightRequest({ ...request(), [key]: value }, observation()), /unexpected|secret/i);
  }
  assert.doesNotMatch(JSON.stringify(request()), /api.?key|credential|secret/i);
});
