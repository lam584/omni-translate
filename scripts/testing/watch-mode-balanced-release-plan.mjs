import { isDeepStrictEqual } from 'node:util';
import {
  deriveWatchModelProtocolIdentity,
  watchModelProtocolIdentityFailure,
} from './watch-mode-model-protocol-authority.mjs';

// v12 keeps terminal completion event-driven: the exact local playback
// quiescence event wins, while the 120-second drain timeout is an abnormal
// watchdog rather than a PCM-duration prediction.
// A strict receipt may cover only the exact LiveTranslate release
// model and the explicitly validated default-speaker endpoint. Process
// exclusion restart timing is explicit and independent of watchdog duration.
export const BALANCED_RELEASE_PLAN_ID = 'watch-mode-balanced-v12-event-driven-playback-drain';
export const BALANCED_RELEASE_PLAN_SCHEMA_VERSION = 12;
export const CANONICAL_PROVIDER_REFERENCE_FRAMES = 2_013_045;
export const CANONICAL_MEDIA_SHA256 = 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f';
export const PROVIDER_INPUT_SAMPLE_RATE_HZ = 16_000;
export const PROCESS_EXCLUSION_RESTART_AFTER_SECONDS = 90;
export const PROCESS_EXCLUSION_RESTART_QUIET_SECONDS = 45;
export const PROCESS_EXCLUSION_QUIET_FRAMES = PROCESS_EXCLUSION_RESTART_QUIET_SECONDS * 16_000;
export const ORDINARY_CAPTURE_GRACE_FRAMES = 10 * 16_000;
export const PROCESS_EXCLUSION_CAPTURE_GRACE_FRAMES = 9 * 16_000;

export const RELEASE_MODELS = Object.freeze([
  'qwen3.5-livetranslate-flash-realtime',
]);

// Supported selection is separate from the historical/default v12 plan.
// Adding a model must not silently double the paid cells or rewrite 3.5 evidence.
export const SUPPORTED_RELEASE_MODELS = Object.freeze([
  ...RELEASE_MODELS, 'qwen3.8-livetranslate-flash-realtime',
]);
export const SELECTABLE_RELEASE_PLAN_SCHEMA_VERSION = 13;
export const SELECTABLE_RELEASE_PLAN_ID = 'watch-mode-balanced-v13-explicit-model-endpoint';

export const RELEASE_FEEDBACK_MODES = Object.freeze([
  'process-exclusion',
  'virtual-driver',
  'echo-cancel',
]);

export const RELEASE_DEVICE_CLASSES = Object.freeze([
  'default-speaker',
]);

export const RELEASE_INPUT_COMPLETION_WATCHDOG_SECONDS = Object.freeze({
  'process-exclusion': 225,
  'virtual-driver': 180,
  'echo-cancel': 180,
});
export const RELEASE_PROVIDER_FINISH_TIMEOUT_SECONDS = 15;
export const RELEASE_LOCAL_PLAYBACK_DRAIN_TIMEOUT_SECONDS = 120;
export const RELEASE_REPORT_WRITE_TIMEOUT_SECONDS = 10;
export const RELEASE_CELL_HARD_WATCHDOG_SECONDS = Object.freeze(
  Object.fromEntries(RELEASE_FEEDBACK_MODES.map((feedbackMode) => [
    feedbackMode,
    RELEASE_INPUT_COMPLETION_WATCHDOG_SECONDS[feedbackMode]
      + RELEASE_PROVIDER_FINISH_TIMEOUT_SECONDS
      + RELEASE_LOCAL_PLAYBACK_DRAIN_TIMEOUT_SECONDS
      + RELEASE_REPORT_WRITE_TIMEOUT_SECONDS,
  ])),
);
export const RELEASE_MAX_CELL_HARD_WATCHDOG_SECONDS = Math.max(
  ...Object.values(RELEASE_CELL_HARD_WATCHDOG_SECONDS),
);

const cell = ({ tier, modelId = null, feedbackLoopPrevention, deviceClass }) => {
  const paid = tier !== 'local-isolation';
  const quietFrames = paid && feedbackLoopPrevention === 'process-exclusion'
    ? PROCESS_EXCLUSION_QUIET_FRAMES
    : 0;
  const captureGraceFrames = paid && feedbackLoopPrevention === 'process-exclusion'
    ? PROCESS_EXCLUSION_CAPTURE_GRACE_FRAMES
    : paid ? ORDINARY_CAPTURE_GRACE_FRAMES : 0;
  const authoritativeTransformedReferenceFrames = paid
    ? CANONICAL_PROVIDER_REFERENCE_FRAMES + quietFrames
    : 0;
  const inputCompletionWatchdogSeconds = paid
    ? RELEASE_INPUT_COMPLETION_WATCHDOG_SECONDS[feedbackLoopPrevention]
    : 0;
  const processExclusionRestartAfterSeconds = paid && feedbackLoopPrevention === 'process-exclusion'
    ? PROCESS_EXCLUSION_RESTART_AFTER_SECONDS
    : 0;
  const processExclusionRestartQuietSeconds = paid && feedbackLoopPrevention === 'process-exclusion'
    ? PROCESS_EXCLUSION_RESTART_QUIET_SECONDS
    : 0;
  return Object.freeze({
  cellId: [tier, modelId ?? 'no-provider', feedbackLoopPrevention, deviceClass].join('::'),
  tier,
  providerMode: tier === 'local-isolation' ? 'disabled' : 'live-dashscope',
  ...(paid ? {
    inputCompletionWatchdogSeconds,
    processExclusionRestartAfterSeconds,
    processExclusionRestartQuietSeconds,
    providerFinishTimeoutSeconds: RELEASE_PROVIDER_FINISH_TIMEOUT_SECONDS,
    localPlaybackDrainTimeoutSeconds: RELEASE_LOCAL_PLAYBACK_DRAIN_TIMEOUT_SECONDS,
    reportWriteTimeoutSeconds: RELEASE_REPORT_WRITE_TIMEOUT_SECONDS,
    cellHardWatchdogSeconds: RELEASE_CELL_HARD_WATCHDOG_SECONDS[feedbackLoopPrevention],
  } : { durationSeconds: 300 }),
  authoritativeTransformedReferenceFrames,
  inputSampleRateHz: paid ? PROVIDER_INPUT_SAMPLE_RATE_HZ : 0,
  mediaSha256: paid ? CANONICAL_MEDIA_SHA256 : null,
  boundedCaptureGraceFrames: captureGraceFrames,
  maxExternalAudioSamples: authoritativeTransformedReferenceFrames + captureGraceFrames,
  auxiliaryExternalAudioSeconds: 0,
  subtitleTranslationMode: tier === 'local-isolation' ? 'disabled' : 'native',
  modelId,
  ...(paid ? {
    modelProtocolProfileIdentity: deriveWatchModelProtocolIdentity(modelId),
  } : {}),
  feedbackLoopPrevention,
  deviceClass,
  });
};

export const LOCAL_ISOLATION_CELLS = Object.freeze(
  RELEASE_FEEDBACK_MODES.flatMap((feedbackLoopPrevention) => (
    RELEASE_DEVICE_CLASSES.map((deviceClass) => cell({
      tier: 'local-isolation',
      feedbackLoopPrevention,
      deviceClass,
    }))
  )),
);

export const PAIRWISE_LIVE_CELLS = Object.freeze(
  RELEASE_FEEDBACK_MODES.map((feedbackLoopPrevention) => cell({
    tier: 'pairwise-live',
    modelId: RELEASE_MODELS[0],
    feedbackLoopPrevention,
    deviceClass: 'default-speaker',
  })),
);

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
      durationSeconds: 300,
      cellCount: LOCAL_ISOLATION_CELLS.length,
    }),
    Object.freeze({
      tier: 'pairwise-live',
      providerMode: 'live-dashscope',
      inputCompletionWatchdogSecondsByFeedbackMode:
        RELEASE_INPUT_COMPLETION_WATCHDOG_SECONDS,
      cellCount: PAIRWISE_LIVE_CELLS.length,
    }),
    Object.freeze({
      tier: 'model-stability',
      providerMode: 'live-dashscope',
      inputCompletionWatchdogSecondsByFeedbackMode:
        RELEASE_INPUT_COMPLETION_WATCHDOG_SECONDS,
      cellCount: MODEL_STABILITY_CELLS.length,
    }),
  ]),
  cells: BALANCED_RELEASE_CELLS,
  paidLlmSeconds: LIVE_LLM_CELLS.reduce(
    (total, entry) => total + entry.maxExternalAudioSamples / 16_000,
    0,
  ),
  paidProviderInputSampleCeiling: LIVE_LLM_CELLS.reduce(
    (total, entry) => total + entry.maxExternalAudioSamples,
    0,
  ),
  externalProviderBudget: Object.freeze({
    scope: 'strict-paid-provider-input-samples',
    cellMaxInputSamples: Math.max(...LIVE_LLM_CELLS.map((entry) => entry.maxExternalAudioSamples)),
    matrixMaxInputSamples: LIVE_LLM_CELLS.reduce(
      (total, entry) => total + entry.maxExternalAudioSamples,
      0,
    ),
    inputSampleRateHz: 16_000,
    sourceTranscriptCalls: 0,
    physicalOutputSttCalls: 0,
    secondaryTranslationCalls: 0,
    secondaryTtsCalls: 0,
    auxiliaryExternalAudioSeconds: 0,
    subtitleTranslationMode: 'native',
  }),
});

/** A selection authorizes exactly four cells for one model, never an implicit eight-cell run. */
export function createBalancedReleasePlan({ modelId = RELEASE_MODELS[0], endpointHost, region = 'cn-beijing' } = {}) {
  if (!SUPPORTED_RELEASE_MODELS.includes(modelId)) throw new Error('unsupported exact release model');
  if (region !== 'cn-beijing') throw new Error('release plan requires the validated cn-beijing region');
  if (modelId === RELEASE_MODELS[0]) {
    if (endpointHost !== undefined && endpointHost !== 'dashscope.aliyuncs.com') {
      throw new Error('historical 3.5 release endpoint must remain dashscope.aliyuncs.com');
    }
    return BALANCED_RELEASE_PLAN;
  }
  if (typeof endpointHost !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/.test(endpointHost)) {
    throw new Error('3.8 release plan requires an explicit Beijing workspace endpoint host');
  }
  const identity = deriveWatchModelProtocolIdentity(modelId, { endpointHost, region });
  const paidCells = LIVE_LLM_CELLS.map((entry) => Object.freeze({
    ...entry,
    cellId: [entry.tier, modelId, entry.feedbackLoopPrevention, entry.deviceClass].join('::'),
    modelId,
    modelProtocolProfileIdentity: identity,
  }));
  return Object.freeze({
    ...BALANCED_RELEASE_PLAN,
    schemaVersion: SELECTABLE_RELEASE_PLAN_SCHEMA_VERSION,
    planId: SELECTABLE_RELEASE_PLAN_ID,
    models: Object.freeze([modelId]),
    providerEndpoint: Object.freeze({ region, endpointHost }),
    cells: Object.freeze([...LOCAL_ISOLATION_CELLS, ...paidCells]),
  });
}

// The serialized selection is optional only for the legacy/default plan.
export function normalizeReleaseSelection(selection) {
  if (selection === undefined) return undefined;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).some(key => !['modelId', 'endpointHost', 'region'].includes(key))
      || selection.modelId !== SUPPORTED_RELEASE_MODELS[1]) {
    throw new Error('releaseSelection must explicitly select the supported 3.8 model');
  }
  const plan = createBalancedReleasePlan(selection);
  return Object.freeze({modelId: plan.models[0], ...plan.providerEndpoint});
}

export function liveCellsForReleasePlan(plan = BALANCED_RELEASE_PLAN) {
  const failure = balancedReleasePlanFailure(plan);
  if (failure) throw new Error(failure);
  return plan.cells.filter((entry) => entry.providerMode !== 'disabled');
}

export const expectedBalancedCellIds = (plan = BALANCED_RELEASE_PLAN) => plan.cells.map(({ cellId }) => cellId);

export function balancedReleasePlanFailure(plan) {
  if (!plan || typeof plan !== 'object') return 'balanced release validation plan is missing';
  if (plan.schemaVersion === SELECTABLE_RELEASE_PLAN_SCHEMA_VERSION) {
    try {
      if (!Array.isArray(plan.models) || plan.models.length !== 1 || plan.models[0] !== SUPPORTED_RELEASE_MODELS[1]) {
        return 'v13 release plan requires one exact 3.8 model';
      }
      const expected = createBalancedReleasePlan({ modelId: plan.models[0], ...plan.providerEndpoint });
      return isDeepStrictEqual(plan, expected) ? null : 'selected release plan differs from exact model/endpoint/budget contract';
    } catch (error) { return error.message; }
  }
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
      ...(expected.providerMode === 'disabled' ? ['durationSeconds'] : [
        'inputCompletionWatchdogSeconds',
        'processExclusionRestartAfterSeconds',
        'processExclusionRestartQuietSeconds',
        'providerFinishTimeoutSeconds',
        'localPlaybackDrainTimeoutSeconds',
        'reportWriteTimeoutSeconds',
        'cellHardWatchdogSeconds',
      ]),
      'authoritativeTransformedReferenceFrames',
      'boundedCaptureGraceFrames',
      'maxExternalAudioSamples',
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
    if (expected.providerMode !== 'disabled') {
      const profileFailure = watchModelProtocolIdentityFailure(
        recorded?.modelProtocolProfileIdentity,
        expected.modelProtocolProfileIdentity,
        `balanced release validation plan cell ${expected.cellId} model protocol profile identity`,
      );
      if (profileFailure) return profileFailure;
    }
  }
  if (Number(plan.paidLlmSeconds) !== BALANCED_RELEASE_PLAN.paidLlmSeconds) {
    return 'balanced release validation plan paid LLM budget is inconsistent';
  }
  if (
    Number(plan.paidProviderInputSampleCeiling)
      !== BALANCED_RELEASE_PLAN.paidProviderInputSampleCeiling
    || JSON.stringify(plan.externalProviderBudget) !== JSON.stringify(BALANCED_RELEASE_PLAN.externalProviderBudget)
  ) {
    return 'balanced release validation plan external provider budget is inconsistent';
  }
  return null;
}
