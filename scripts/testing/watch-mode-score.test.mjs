import assert from 'node:assert/strict';
import test from 'node:test';
import { combineLlmSemanticScore, scoreDeterministic } from './watch-mode-score.mjs';

const report = { verdict: 'passed', failureLayer: null, layers: { app: { status: 'passed' } } };

test('scores content, latency, completeness, and reliability independently', () => {
  const scored = scoreDeterministic({
    report,
    referenceText: '你好世界一百美元',
    evidence: {
      content: { translation: '你好世界一百美元', subtitleQueue: { firstVisibleTranslationLatencySeconds: 2, firstFinalTranslationLatencySeconds: 5, finalWriteCount: 10, queuedSegmentCount: 10, playedSegmentCount: 10 } },
      queue: { firstVisibleTranslationLatencySeconds: 2, firstFinalTranslationLatencySeconds: 5, finalWriteCount: 10, queuedSegmentCount: 10, playedSegmentCount: 10 },
      strict: { coverage: 1 }, snapshots: { provider: { totalCalls: 10, failedCalls: 0 } },
    },
  });
  assert.deepEqual(scored.dimensions, { semantic: 100, latency: 100, completeness: 100, reliability: 100 });
  assert.equal(scored.total, 100);
  assert.equal(scored.grade, 'A');
});

test('hard gate caps failed runs below passing score', () => {
  const scored = scoreDeterministic({
    report: { ...report, verdict: 'failed', failureLayer: 'provider', failureReason: 'timeout' },
    referenceText: 'same',
    evidence: { content: { translation: 'same' }, queue: { firstVisibleTranslationLatencySeconds: 1, firstFinalTranslationLatencySeconds: 1, finalWriteCount: 1, queuedSegmentCount: 1, playedSegmentCount: 1 }, strict: { coverage: 1 }, snapshots: { provider: { totalCalls: 1, failedCalls: 0 } } },
  });
  assert.equal(scored.total, 59);
  assert.equal(scored.grade, 'F');
  assert.equal(scored.gate.passed, false);
});

test('missing latency evidence scores latency as zero instead of inventing a value', () => {
  const scored = scoreDeterministic({ report, referenceText: 'same', evidence: { content: { translation: 'same' }, queue: {}, strict: {}, snapshots: { provider: { totalCalls: 1, failedCalls: 0 } } } });
  assert.equal(scored.dimensions.latency, 0);
  assert.equal(scored.metrics.firstVisibleTranslationLatencySeconds, null);
});

test('explicit null latency evidence is not treated as zero seconds', () => {
  const scored = scoreDeterministic({ report, referenceText: 'same', evidence: { content: { translation: 'same' }, queue: { firstVisibleTranslationLatencySeconds: null, firstFinalTranslationLatencySeconds: null }, strict: {}, snapshots: { provider: { totalCalls: 1, failedCalls: 0 } } } });
  assert.equal(scored.dimensions.latency, 0);
  assert.equal(scored.metrics.firstFinalTranslationLatencySeconds, null);
});

test('LLM judge can change semantic quality only', () => {
  const original = { semantic: 50, latency: 63, completeness: 74, reliability: 85 };
  const combined = combineLlmSemanticScore(original, 100);
  assert.deepEqual(combined, { semantic: 80, latency: 63, completeness: 74, reliability: 85 });
});
