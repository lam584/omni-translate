import crypto from 'node:crypto';

import {
  LIVE_LLM_CELLS,
  RELEASE_DEVICE_CLASSES,
  RELEASE_FEEDBACK_MODES,
} from './watch-mode-balanced-release-plan.mjs';

export const WATCH_MODE_SMOKE_SCHEMA_VERSION = 1;
export const WATCH_MODE_SMOKE_ARTIFACT_KIND = 'watch-mode-non-authoritative-smoke';
export const WATCH_MODE_SMOKE_PLAN_ID = 'watch-mode-smoke-v1-30-minute-full-coverage';
export const WATCH_MODE_SMOKE_BUDGET_SECONDS = 30 * 60;
export const WATCH_MODE_SMOKE_LOCAL_DURATION_SECONDS = 30;
export const WATCH_MODE_SMOKE_PLUS_DURATION_SECONDS = 45;
export const WATCH_MODE_SMOKE_RELEASE_DURATION_SECONDS = 45;
export const WATCH_MODE_SMOKE_PLUS_MODEL = 'qwen3.5-omni-plus-realtime';

const clone = (value) => structuredClone(value);

function cell({ tier, sourceTier = tier, modelId, feedbackLoopPrevention, deviceClass, sourceDeviceClass = deviceClass, durationSeconds }) {
  return Object.freeze({
    cellId: [tier, sourceTier, modelId ?? 'no-provider', feedbackLoopPrevention, sourceDeviceClass].join('::'),
    tier,
    sourceTier,
    modelId,
    feedbackLoopPrevention,
    deviceClass,
    sourceDeviceClass,
    durationSeconds,
    providerMode: modelId ? 'live-dashscope' : 'disabled',
    smokeOnly: true,
    retryPolicy: 'no-retry-within-execution',
  });
}

export const SMOKE_LOCAL_CELLS = Object.freeze(RELEASE_FEEDBACK_MODES.flatMap((feedbackLoopPrevention) => (
  RELEASE_DEVICE_CLASSES.map((sourceDeviceClass) => cell({
    tier: 'local-isolation', modelId: null, feedbackLoopPrevention,
    deviceClass: 'default-speaker', sourceDeviceClass,
    durationSeconds: WATCH_MODE_SMOKE_LOCAL_DURATION_SECONDS,
  }))
)));

export const SMOKE_PLUS_CELLS = Object.freeze(RELEASE_FEEDBACK_MODES.map((feedbackLoopPrevention, index) => cell({
  tier: 'incident-plus',
  modelId: WATCH_MODE_SMOKE_PLUS_MODEL,
  feedbackLoopPrevention,
  deviceClass: 'default-speaker',
  sourceDeviceClass: RELEASE_DEVICE_CLASSES[index % RELEASE_DEVICE_CLASSES.length],
  durationSeconds: WATCH_MODE_SMOKE_PLUS_DURATION_SECONDS,
})));

export const SMOKE_RELEASE_CELLS = Object.freeze(LIVE_LLM_CELLS.map((releaseCell) => cell({
  tier: 'release-matrix',
  sourceTier: releaseCell.tier,
  modelId: releaseCell.modelId,
  feedbackLoopPrevention: releaseCell.feedbackLoopPrevention,
  deviceClass: 'default-speaker',
  sourceDeviceClass: releaseCell.deviceClass,
  durationSeconds: WATCH_MODE_SMOKE_RELEASE_DURATION_SECONDS,
})));

export const WATCH_MODE_SMOKE_CELLS = Object.freeze([
  ...SMOKE_LOCAL_CELLS,
  ...SMOKE_PLUS_CELLS,
  ...SMOKE_RELEASE_CELLS,
]);

export const WATCH_MODE_SMOKE_PHASES = Object.freeze([
  Object.freeze({ name: 'zero-cost-regression-and-readiness', budgetSeconds: 5 * 60 }),
  Object.freeze({ name: 'local-isolation', budgetSeconds: 4 * 60 }),
  Object.freeze({ name: 'incident-plus', budgetSeconds: 6 * 60 }),
  Object.freeze({ name: 'release-matrix', budgetSeconds: 10 * 60 }),
  Object.freeze({ name: 'report-collection', budgetSeconds: 5 * 60 }),
]);

export function smokePlanFailure(plan) {
  if (!plan || typeof plan !== 'object') return 'smoke plan is missing';
  if (plan.schemaVersion !== WATCH_MODE_SMOKE_SCHEMA_VERSION) return 'smoke plan schema version is invalid';
  if (plan.planId !== WATCH_MODE_SMOKE_PLAN_ID) return 'smoke plan id is invalid';
  if (plan.artifactKind !== WATCH_MODE_SMOKE_ARTIFACT_KIND || plan.smokeOnly !== true) {
    return 'smoke plan must be explicitly non-authoritative';
  }
  if (plan.totalBudgetSeconds !== WATCH_MODE_SMOKE_BUDGET_SECONDS) return 'smoke plan budget is invalid';
  if (JSON.stringify(plan.phases) !== JSON.stringify(WATCH_MODE_SMOKE_PHASES)) return 'smoke plan phases are invalid';
  if (JSON.stringify(plan.cells) !== JSON.stringify(WATCH_MODE_SMOKE_CELLS)) return 'smoke plan cells are invalid';
  return null;
}

export function createWatchModeSmokePlan({ executionId = `watch-mode-smoke-${crypto.randomUUID()}` } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{3,127}$/i.test(executionId)) throw new Error('executionId is invalid');
  return {
    schemaVersion: WATCH_MODE_SMOKE_SCHEMA_VERSION,
    artifactKind: WATCH_MODE_SMOKE_ARTIFACT_KIND,
    smokeOnly: true,
    planId: WATCH_MODE_SMOKE_PLAN_ID,
    executionId,
    totalBudgetSeconds: WATCH_MODE_SMOKE_BUDGET_SECONDS,
    phases: clone(WATCH_MODE_SMOKE_PHASES),
    cells: clone(WATCH_MODE_SMOKE_CELLS),
  };
}
