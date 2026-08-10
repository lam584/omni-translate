import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BALANCED_RELEASE_CELLS,
  BALANCED_RELEASE_PLAN,
  LIVE_LLM_CELLS,
  LOCAL_ISOLATION_CELLS,
  MODEL_STABILITY_CELLS,
  PAIRWISE_LIVE_CELLS,
  RELEASE_DEVICE_CLASSES,
  RELEASE_FEEDBACK_MODES,
  RELEASE_MODELS,
  balancedReleasePlanFailure,
} from './watch-mode-balanced-release-plan.mjs';

test('balanced release plan caps paid LLM time at 38 minutes', () => {
  assert.equal(BALANCED_RELEASE_PLAN.paidLlmSeconds, 38 * 60);
  assert.equal(LOCAL_ISOLATION_CELLS.length, 9);
  assert.equal(PAIRWISE_LIVE_CELLS.length, 6);
  assert.equal(MODEL_STABILITY_CELLS.length, 2);
  assert.equal(LIVE_LLM_CELLS.length, 8);
  assert.equal(BALANCED_RELEASE_CELLS.length, 17);
  assert.equal(balancedReleasePlanFailure(BALANCED_RELEASE_PLAN), null);
});

test('local isolation covers every route and device without a provider', () => {
  const pairs = new Set(LOCAL_ISOLATION_CELLS.map((entry) => (
    `${entry.feedbackLoopPrevention}::${entry.deviceClass}`
  )));
  assert.equal(pairs.size, RELEASE_FEEDBACK_MODES.length * RELEASE_DEVICE_CLASSES.length);
  assert.ok(LOCAL_ISOLATION_CELLS.every((entry) => (
    entry.providerMode === 'disabled'
    && entry.modelId === null
    && entry.durationSeconds === 300
  )));
});

test('pairwise live cells cover each model against every route and device', () => {
  for (const modelId of RELEASE_MODELS) {
    assert.deepEqual(
      new Set(PAIRWISE_LIVE_CELLS.filter((entry) => entry.modelId === modelId)
        .map((entry) => entry.feedbackLoopPrevention)),
      new Set(RELEASE_FEEDBACK_MODES),
    );
    assert.deepEqual(
      new Set(PAIRWISE_LIVE_CELLS.filter((entry) => entry.modelId === modelId)
        .map((entry) => entry.deviceClass)),
      new Set(RELEASE_DEVICE_CLASSES),
    );
  }
  assert.ok(PAIRWISE_LIVE_CELLS.every((entry) => entry.durationSeconds === 180));
});

test('model stability uses one ten-minute cell per model', () => {
  assert.deepEqual(MODEL_STABILITY_CELLS.map((entry) => entry.modelId), RELEASE_MODELS);
  assert.ok(MODEL_STABILITY_CELLS.every((entry) => (
    entry.durationSeconds === 600
    && entry.feedbackLoopPrevention === 'process-exclusion'
    && entry.deviceClass === 'default-speaker'
  )));
});

test('balanced plan rejects duration and provider-mode weakening', () => {
  const weakenedDuration = structuredClone(BALANCED_RELEASE_PLAN);
  weakenedDuration.cells[9].durationSeconds = 30;
  assert.match(balancedReleasePlanFailure(weakenedDuration), /durationSeconds/);

  const paidLocal = structuredClone(BALANCED_RELEASE_PLAN);
  paidLocal.cells[0].providerMode = 'live-dashscope';
  assert.match(balancedReleasePlanFailure(paidLocal), /providerMode/);
});
