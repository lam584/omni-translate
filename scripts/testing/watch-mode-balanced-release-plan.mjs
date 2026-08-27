// v2 is intentionally incompatible with the former three-device matrix.  A
// strict receipt must never make the now-unavailable Bluetooth class look
// covered by the two independently verified physical endpoint classes.
export const BALANCED_RELEASE_PLAN_ID = 'watch-mode-balanced-v7-single-machine';
export const BALANCED_RELEASE_PLAN_SCHEMA_VERSION = 7;
export const PAID_PROVIDER_SESSION_CEILING_SECONDS = 24 * 60;
export const PAID_PROVIDER_CELL_CEILING_SECONDS = 3 * 60;

export const RELEASE_MODELS = Object.freeze([
  'qwen3.5-omni-flash-realtime',
  'qwen3.5-livetranslate-flash-realtime',
]);

export const RELEASE_FEEDBACK_MODES = Object.freeze([
  'process-exclusion',
  'virtual-driver',
  'echo-cancel',
]);

export const RELEASE_DEVICE_CLASSES = Object.freeze([
  'default-speaker',
]);

export const RELEASE_TIER_DURATIONS_SECONDS = Object.freeze({
  'local-isolation': 300,
  // The canonical source is about 126 seconds. The strict runner's audited
  // three-minute floor leaves roughly 54 seconds for the final provider and
  // physical-output drain while avoiding paid idle tail. Eight cells cap the
  // total provider budget at 24 minutes.
  'pairwise-live': 180,
  'model-stability': 180,
});

const cell = ({ tier, modelId = null, feedbackLoopPrevention, deviceClass }) => Object.freeze({
  cellId: [tier, modelId ?? 'no-provider', feedbackLoopPrevention, deviceClass].join('::'),
  tier,
  providerMode: tier === 'local-isolation' ? 'disabled' : 'live-dashscope',
  durationSeconds: RELEASE_TIER_DURATIONS_SECONDS[tier],
  externalProviderSessionCeilingSeconds: tier === 'local-isolation'
    ? 0
    : RELEASE_TIER_DURATIONS_SECONDS[tier],
  auxiliaryExternalAudioSeconds: 0,
  subtitleTranslationMode: tier === 'local-isolation' ? 'disabled' : 'native',
  modelId,
  feedbackLoopPrevention,
  deviceClass,
});

export const LOCAL_ISOLATION_CELLS = Object.freeze(
  RELEASE_FEEDBACK_MODES.flatMap((feedbackLoopPrevention) => (
    RELEASE_DEVICE_CLASSES.map((deviceClass) => cell({
      tier: 'local-isolation',
      feedbackLoopPrevention,
      deviceClass,
    }))
  )),
);

export const PAIRWISE_LIVE_CELLS = Object.freeze([
  cell({
    tier: 'pairwise-live',
    modelId: RELEASE_MODELS[0],
    feedbackLoopPrevention: 'process-exclusion',
    deviceClass: 'default-speaker',
  }),
  cell({
    tier: 'pairwise-live',
    modelId: RELEASE_MODELS[0],
    feedbackLoopPrevention: 'virtual-driver',
    deviceClass: 'default-speaker',
  }),
  cell({
    tier: 'pairwise-live',
    modelId: RELEASE_MODELS[0],
    feedbackLoopPrevention: 'echo-cancel',
    deviceClass: 'default-speaker',
  }),
  cell({
    tier: 'pairwise-live',
    modelId: RELEASE_MODELS[1],
    feedbackLoopPrevention: 'process-exclusion',
    deviceClass: 'default-speaker',
  }),
  cell({
    tier: 'pairwise-live',
    modelId: RELEASE_MODELS[1],
    feedbackLoopPrevention: 'virtual-driver',
    deviceClass: 'default-speaker',
  }),
  cell({
    tier: 'pairwise-live',
    modelId: RELEASE_MODELS[1],
    feedbackLoopPrevention: 'echo-cancel',
    deviceClass: 'default-speaker',
  }),
]);

export const MODEL_STABILITY_CELLS = Object.freeze(
  RELEASE_MODELS.map((modelId) => cell({
    tier: 'model-stability',
    modelId,
    feedbackLoopPrevention: 'process-exclusion',
    deviceClass: 'default-speaker',
  })),
);

export const LIVE_LLM_CELLS = Object.freeze([
  ...PAIRWISE_LIVE_CELLS,
  ...MODEL_STABILITY_CELLS,
]);

export const BALANCED_RELEASE_CELLS = Object.freeze([
  ...LOCAL_ISOLATION_CELLS,
  ...LIVE_LLM_CELLS,
]);

export const BALANCED_RELEASE_PLAN = Object.freeze({
  schemaVersion: BALANCED_RELEASE_PLAN_SCHEMA_VERSION,
  planId: BALANCED_RELEASE_PLAN_ID,
  models: RELEASE_MODELS,
  feedbackLoopPreventionModes: RELEASE_FEEDBACK_MODES,
  deviceClasses: RELEASE_DEVICE_CLASSES,
  tiers: Object.freeze([
    Object.freeze({
      tier: 'local-isolation',
      providerMode: 'disabled',
      durationSeconds: RELEASE_TIER_DURATIONS_SECONDS['local-isolation'],
      cellCount: LOCAL_ISOLATION_CELLS.length,
    }),
    Object.freeze({
      tier: 'pairwise-live',
      providerMode: 'live-dashscope',
      durationSeconds: RELEASE_TIER_DURATIONS_SECONDS['pairwise-live'],
      cellCount: PAIRWISE_LIVE_CELLS.length,
    }),
    Object.freeze({
      tier: 'model-stability',
      providerMode: 'live-dashscope',
      durationSeconds: RELEASE_TIER_DURATIONS_SECONDS['model-stability'],
      cellCount: MODEL_STABILITY_CELLS.length,
    }),
  ]),
  cells: BALANCED_RELEASE_CELLS,
  paidLlmSeconds: LIVE_LLM_CELLS.reduce((total, entry) => total + entry.durationSeconds, 0),
  paidProviderSessionCeilingSeconds: LIVE_LLM_CELLS.reduce(
    (total, entry) => total + entry.externalProviderSessionCeilingSeconds,
    0,
  ),
  externalProviderBudget: Object.freeze({
    scope: 'strict-paid-realtime-session-window',
    cellCeilingSeconds: PAID_PROVIDER_CELL_CEILING_SECONDS,
    matrixCeilingSeconds: PAID_PROVIDER_SESSION_CEILING_SECONDS,
    inputSampleRateHz: 16_000,
    sourceTranscriptCalls: 0,
    physicalOutputSttCalls: 0,
    secondaryTranslationCalls: 0,
    secondaryTtsCalls: 0,
    auxiliaryExternalAudioSeconds: 0,
    subtitleTranslationMode: 'native',
  }),
});

export const expectedBalancedCellIds = () => BALANCED_RELEASE_CELLS.map(({ cellId }) => cellId);

export function balancedReleasePlanFailure(plan) {
  if (!plan || typeof plan !== 'object') return 'balanced release validation plan is missing';
  if (plan.schemaVersion !== BALANCED_RELEASE_PLAN_SCHEMA_VERSION) {
    return `balanced release validation plan schema must be ${BALANCED_RELEASE_PLAN_SCHEMA_VERSION}`;
  }
  if (plan.planId !== BALANCED_RELEASE_PLAN_ID) {
    return `balanced release validation plan id must be ${BALANCED_RELEASE_PLAN_ID}`;
  }
  const recordedIds = Array.isArray(plan.cells) ? plan.cells.map((entry) => entry?.cellId) : [];
  const expectedIds = expectedBalancedCellIds();
  if (JSON.stringify(recordedIds) !== JSON.stringify(expectedIds)) {
    return 'balanced release validation plan cells do not match the exact budget-approved plan';
  }
  for (let index = 0; index < BALANCED_RELEASE_CELLS.length; index += 1) {
    const expected = BALANCED_RELEASE_CELLS[index];
    const recorded = plan.cells[index];
    for (const key of [
      'tier',
      'providerMode',
      'durationSeconds',
      'externalProviderSessionCeilingSeconds',
      'auxiliaryExternalAudioSeconds',
      'subtitleTranslationMode',
      'modelId',
      'feedbackLoopPrevention',
      'deviceClass',
    ]) {
      if (recorded?.[key] !== expected[key]) {
        return `balanced release validation plan cell ${expected.cellId} has invalid ${key}`;
      }
    }
  }
  if (Number(plan.paidLlmSeconds) !== BALANCED_RELEASE_PLAN.paidLlmSeconds) {
    return 'balanced release validation plan paid LLM budget is inconsistent';
  }
  if (
    Number(plan.paidProviderSessionCeilingSeconds) !== PAID_PROVIDER_SESSION_CEILING_SECONDS
    || JSON.stringify(plan.externalProviderBudget) !== JSON.stringify(BALANCED_RELEASE_PLAN.externalProviderBudget)
  ) {
    return 'balanced release validation plan external provider budget is inconsistent';
  }
  return null;
}
