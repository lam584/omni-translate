import assert from 'node:assert/strict';
import test from 'node:test';

import { runProviderNetworkHealth } from './watch-mode-provider-network-health.mjs';

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
