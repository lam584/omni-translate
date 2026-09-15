import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalIncrementalFinalCues,
  createEarlyStopRequest,
  evaluateAuditedCueForEarlyStop,
  parseIncrementalJsonLines,
  evaluateIncrementalEarlyStop,
  validateIncrementalTerminal,
} from './watch-mode-incremental-evidence.mjs';

const identity = { runMarker: 'run-1', cellId: 'c02', leaseId: 'lease-1', launchId: 'launch-1', mediaSha256: 'media-1' };
const event = (overrides = {}) => ({
  schemaVersion: 1, artifactKind: 'watch-mode-incremental-cue-event', identity,
  sessionId: 'session-1', eventSequence: 1, stage: 'model-final', cueId: 'cue-1',
  revision: 1, sequence: 1, modelFinal: true, publishFinal: false, renderFinal: false,
  renderedText: '', mediaSha256: identity.mediaSha256, ...overrides,
});
const terminal = (overrides = {}) => ({
  schemaVersion: 1, artifactKind: 'watch-mode-incremental-terminal', identity,
  mediaSha256: identity.mediaSha256, sessionId: 'session-1',
  lastProducedSequence: 3, lastPersistedSequence: 3,
  droppedEventCount: 0, writerError: null, complete: true, ...overrides,
});

test('a trailing partial JSONL write is ignored while a malformed complete line is inconclusive', () => {
  const complete = JSON.stringify(event());
  assert.deepEqual(parseIncrementalJsonLines(`${complete}\n{"partial"`).events, [event()]);
  assert.deepEqual(parseIncrementalJsonLines(`${complete}\nnot-json\n`).violations,
    ['invalid complete JSONL line 2']);
});

test('only a fully finalized rendered revision is eligible for early stop', () => {
  const result = canonicalIncrementalFinalCues([
    event(),
    event({ eventSequence: 2, stage: 'publish-final', publishFinal: true }),
    event({ eventSequence: 3, stage: 'render-final', publishFinal: true, renderFinal: true, renderedText: '草稿' }),
    event({ eventSequence: 4, revision: 2, sequence: 2, stage: 'model-final', renderedText: '' }),
  ], identity);
  assert.deepEqual(result.cues, []);
});

test('a deterministic hard fact mismatch emits failed-incomplete request', () => {
  const final = event({ eventSequence: 3, stage: 'render-final', publishFinal: true, renderFinal: true,
    renderedText: '它是一艘潜艇，额定功率72.5千瓦时' });
  const evaluation = evaluateIncrementalEarlyStop({ events: [final], terminal: terminal(), expectedIdentity: identity,
    evaluateCue: () => ({ status: 'failed', deterministic: true, hardFailures: ['fact.solar-cell-submarine'] }) });
  assert.equal(evaluation.shouldStop, true);
  const request = createEarlyStopRequest({ evaluation, identity, observedAtMs: 1234 });
  assert.equal(request.disposition, 'failed-incomplete');
  assert.match(request.digest, /^[a-f0-9]{64}$/u);
});

test('terminal authority is required and fails closed on drops, writer errors, and sequence mismatch', () => {
  const events = [event({ eventSequence: 3 })];
  assert.equal(validateIncrementalTerminal(null, events, identity).complete, false);
  for (const badTerminal of [
    terminal({ droppedEventCount: 1 }),
    terminal({ writerError: 'disk full' }),
    terminal({ lastPersistedSequence: 2 }),
  ]) assert.equal(validateIncrementalTerminal(badTerminal, events, identity).complete, false);
});

test('a deterministic mismatch cannot stop without complete terminal authority', () => {
  const final = event({ eventSequence: 3, stage: 'render-final', publishFinal: true, renderFinal: true, renderedText: '潜艇' });
  const result = evaluateIncrementalEarlyStop({ events: [final], expectedIdentity: identity,
    evaluateCue: () => ({ status: 'failed', deterministic: true, hardFailures: ['fact'] }) });
  assert.equal(result.shouldStop, false);
  assert.equal(result.status, 'inconclusive');
  assert.ok(result.violations.includes('incremental terminal is missing'));
});

test('media identity mismatch is inconclusive and cannot trigger a stop', () => {
  const final = event({ eventSequence: 3, stage: 'render-final', publishFinal: true, renderFinal: true,
    renderedText: '潜艇', mediaSha256: 'different-media' });
  const result = evaluateIncrementalEarlyStop({ events: [final], terminal: terminal(), expectedIdentity: identity,
    evaluateCue: () => ({ status: 'failed', deterministic: true, hardFailures: ['fact'] }) });
  assert.equal(result.shouldStop, false);
  assert.equal(result.status, 'inconclusive');
  assert.ok(result.violations.includes('mediaSha256 mismatch'));
});

test('audited contradictions stop but an incomplete valid prefix remains inconclusive', () => {
  assert.deepEqual(evaluateAuditedCueForEarlyStop({ renderedText: '这是一艘潜艇。' }).hardFailures,
    ['prototype.solar-battery']);
  const prefix = evaluateAuditedCueForEarlyStop({ renderedText: '会议在周二开始。' });
  assert.equal(prefix.status, 'inconclusive');
  assert.equal(prefix.deterministic, false);
});

test('partial, inconclusive, stale, and identity-mismatched evidence never stops a cell', () => {
  const final = event({ eventSequence: 3, stage: 'render-final', publishFinal: true, renderFinal: true, renderedText: '合法文本' });
  for (const verdict of [
    { status: 'inconclusive', deterministic: false, hardFailures: [] },
    { status: 'failed', deterministic: false, hardFailures: ['candidate.only'] },
  ]) {
    assert.equal(evaluateIncrementalEarlyStop({ events: [final], expectedIdentity: identity,
      evaluateCue: () => verdict }).shouldStop, false);
  }
  const mismatched = { ...final, identity: { ...identity, leaseId: 'other' } };
  const result = evaluateIncrementalEarlyStop({ events: [mismatched], terminal: terminal(), expectedIdentity: identity,
    evaluateCue: () => ({ status: 'failed', deterministic: true, hardFailures: ['must-not-run'] }) });
  assert.equal(result.shouldStop, false);
  assert.equal(result.status, 'inconclusive');
});
