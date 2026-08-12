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

test('balanced release plan caps paid LLM time at 24 minutes', () => {
  assert.equal(BALANCED_RELEASE_PLAN.paidLlmSeconds, 24 * 60);
  assert.equal(LOCAL_ISOLATION_CELLS.length, 6);
  assert.equal(PAIRWISE_LIVE_CELLS.length, 6);
  assert.equal(MODEL_STABILITY_CELLS.length, 2);
  assert.equal(LIVE_LLM_CELLS.length, 8);
  assert.equal(BALANCED_RELEASE_CELLS.length, 14);
  assert.equal(balancedReleasePlanFailure(BALANCED_RELEASE_PLAN), null);

  const formerThreeDevicePlan = structuredClone(BALANCED_RELEASE_PLAN);
  formerThreeDevicePlan.planId = 'watch-mode-balanced-v2';
  formerThreeDevicePlan.schemaVersion = 2;
  assert.match(balancedReleasePlanFailure(formerThreeDevicePlan), /schema/);
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

test('pairwise live cells cover every model/route pair and every route on both real device classes', () => {
  for (const modelId of RELEASE_MODELS) {
    assert.deepEqual(
      new Set(PAIRWISE_LIVE_CELLS.filter((entry) => entry.modelId === modelId)
        .map((entry) => entry.feedbackLoopPrevention)),
      new Set(RELEASE_FEEDBACK_MODES),
    );
  }
  for (const feedbackLoopPrevention of RELEASE_FEEDBACK_MODES) {
    assert.deepEqual(
      new Set(PAIRWISE_LIVE_CELLS.filter((entry) => entry.feedbackLoopPrevention === feedbackLoopPrevention)
        .map((entry) => entry.deviceClass)),
      new Set(RELEASE_DEVICE_CLASSES),
    );
  }
  assert.ok(PAIRWISE_LIVE_CELLS.every((entry) => entry.durationSeconds === 180));
});

test('model stability uses one three-minute cell per model', () => {
  assert.deepEqual(MODEL_STABILITY_CELLS.map((entry) => entry.modelId), RELEASE_MODELS);
  assert.ok(MODEL_STABILITY_CELLS.every((entry) => (
    entry.durationSeconds === 180
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
