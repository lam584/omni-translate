import assert from 'node:assert/strict';
import test from 'node:test';

import { runProviderNetworkHealth, validateProviderNetworkHealthRequest } from './watch-mode-provider-network-health.mjs';
import { sha256Canonical } from './watch-mode-shard-authority.mjs';

const signedExecutorRequest = (workerId = 'vm167') => {
  const vmIdentity = { provider: 'vmware', uuidBios: 'aa164d56-0aa6-566c-40c6-94424ccbb654' };
  return {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-network-health-request',
    executionId: 'watch-network-signed-executor',
    executor: {
      workerId, interactiveUser: 'VMUser', vmIdentity,
      transportAuthority: { kind: 'ssh', hostKeyAlias: workerId, hostKeyAlgorithm: 'ssh-ed25519', hostKeySha256: `SHA256:${'A'.repeat(43)}` },
      vmIdentityDigest: sha256Canonical(vmIdentity),
      runtimeBundleDigest: 'a'.repeat(64),
      readinessAuthority: {
        path: `worker-readiness/${workerId}.json`, bytes: 10, sha256: 'b'.repeat(64),
        providerCalls: 0, workerId,
      },
    },
  };
};

test('network health CLI validates the complete signed configured executor rather than a fixed worker name', () => {
  assert.equal(validateProviderNetworkHealthRequest(signedExecutorRequest()).executor.workerId, 'vm167');
  const mismatched = signedExecutorRequest();
  mismatched.executor.readinessAuthority.workerId = 'vm131';
  assert.throws(() => validateProviderNetworkHealthRequest(mismatched), /signed configured executor/u);
});

test('network health performs zero-provider DNS, TLS and WebSocket checks', async () => {
  let tlsCalls = 0;
  const receipt = await runProviderNetworkHealth({
    executionId: 'watch-network-test',
    providerId: 'dashscope',
    resolveDns: async () => [{ address: '203.0.113.1', family: 4 }],
    connect: async () => ({ latencyMs: 20 + tlsCalls++, authorized: true, protocol: 'TLSv1.3' }),
    probeWebSocket: async () => ({ reachable: true, statusCode: 401 }),
    inspectExistingConnections: async () => [],
  });
  assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.providerCalls, 0);
  assert.equal(receipt.tls.samples.length, 3);
});

test('network health fails before authorization when an Omni connection already exists', async () => {
  await assert.rejects(runProviderNetworkHealth({
    executionId: 'watch-network-conflict',
    providerId: 'dashscope',
    resolveDns: async () => [{ address: '203.0.113.1', family: 4 }],
    connect: async () => ({ latencyMs: 20, authorized: true, protocol: 'TLSv1.3' }),
    probeWebSocket: async () => ({ reachable: true, statusCode: 401 }),
    inspectExistingConnections: async () => [{ pid: 100, processName: 'omni-desktop-shell' }],
  }), /network health failed/);
});
