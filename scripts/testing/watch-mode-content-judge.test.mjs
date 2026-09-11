import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateWatchContentJudgeSidecar } from './watch-mode-content-judge.mjs';

test('judge sidecar never calls transport unless enabled and authorized', async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return { result: { verdict: 'passed' } }; };
  const disabled = await evaluateWatchContentJudgeSidecar({ transport });
  const unauthorized = await evaluateWatchContentJudgeSidecar({ enabled: true, transport });
  assert.equal(disabled.status, 'disabled');
  assert.equal(unauthorized.status, 'unauthorized');
  assert.equal(calls, 0);
  assert.equal(disabled.affectsGate, false);
});

test('authorized judge sidecar records hashes, model configuration, usage, and latency', async () => {
  const result = await evaluateWatchContentJudgeSidecar({
    enabled: true,
    authorized: true,
    model: 'fixture-judge',
    parameters: { temperature: 0 },
    sourceText: 'solar battery',
    candidateText: '太阳能电池',
    facts: [{ id: 'entity' }],
    transport: async () => ({ result: { status: 'passed' }, usage: { inputTokens: 3, outputTokens: 1 } }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.affectsGate, false);
  assert.match(result.requestSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.responseSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.model, { id: 'fixture-judge', parameters: { temperature: 0 } });
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 1 });
  assert.ok(result.latencyMs >= 0);
});
