import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  PROCESS_EXCLUSION_RESTART_AFTER_SECONDS,
  PROCESS_EXCLUSION_RESTART_QUIET_SECONDS,
  balancedReleasePlanFailure,
} from './watch-mode-balanced-release-plan.mjs';
import { deriveWatchModelProtocolIdentity } from './watch-mode-model-protocol-authority.mjs';

test('balanced release plan binds the sole formal LiveTranslate model and exact input samples', () => {
  assert.deepEqual(RELEASE_MODELS, ['qwen3.5-livetranslate-flash-realtime']);
  assert.equal(BALANCED_RELEASE_PLAN.paidLlmSeconds, 631.26125);
  assert.equal(BALANCED_RELEASE_PLAN.paidProviderInputSampleCeiling, 10_100_180);
  assert.deepEqual(BALANCED_RELEASE_PLAN.externalProviderBudget, {
    scope: 'strict-paid-provider-input-samples',
    cellMaxInputSamples: 2_877_045,
    matrixMaxInputSamples: 10_100_180,
    inputSampleRateHz: 16_000,
    sourceTranscriptCalls: 0,
    physicalOutputSttCalls: 0,
    secondaryTranslationCalls: 0,
    secondaryTtsCalls: 0,
    auxiliaryExternalAudioSeconds: 0,
    subtitleTranslationMode: 'native',
  });
  assert.equal(LOCAL_ISOLATION_CELLS.length, 3);
  assert.equal(PAIRWISE_LIVE_CELLS.length, 3);
  assert.equal(MODEL_STABILITY_CELLS.length, 1);
  assert.equal(LIVE_LLM_CELLS.length, 4);
  assert.ok(LIVE_LLM_CELLS.every((cell) => (
    JSON.stringify(cell.modelProtocolProfileIdentity)
      === JSON.stringify(deriveWatchModelProtocolIdentity(cell.modelId))
  )));
  assert.equal(BALANCED_RELEASE_CELLS.length, 7);
  assert.deepEqual(
    LIVE_LLM_CELLS.map((cell) => cell.maxExternalAudioSamples),
    [2_877_045, 2_173_045, 2_173_045, 2_877_045],
  );
  assert.ok(LIVE_LLM_CELLS.every((cell) => (
    cell.authoritativeTransformedReferenceFrames + cell.boundedCaptureGraceFrames
      === cell.maxExternalAudioSamples
    && cell.maxExternalAudioSamples <= 2_877_045
  )));
  assert.equal(PROCESS_EXCLUSION_RESTART_AFTER_SECONDS, 90);
  assert.equal(PROCESS_EXCLUSION_RESTART_QUIET_SECONDS, 45);
  assert.ok(LIVE_LLM_CELLS.every((cell) => !('normalCompletionTargetSeconds' in cell)));
  assert.deepEqual(
    LIVE_LLM_CELLS.filter((cell) => cell.feedbackLoopPrevention === 'process-exclusion')
      .map((cell) => [
        cell.processExclusionRestartAfterSeconds,
        cell.processExclusionRestartQuietSeconds,
      ]),
    [[90, 45], [90, 45]],
  );
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

test('pairwise live cells cover every model/route pair on the default speaker', () => {
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
  assert.deepEqual(
    PAIRWISE_LIVE_CELLS.map((entry) => entry.inputCompletionWatchdogSeconds),
    [225, 180, 180],
  );
  assert.ok(PAIRWISE_LIVE_CELLS.every((entry) => (
    entry.providerFinishTimeoutSeconds === 15
    && entry.localPlaybackDrainTimeoutSeconds === 30
    && entry.reportWriteTimeoutSeconds === 10
    && entry.cellHardWatchdogSeconds === (
      entry.inputCompletionWatchdogSeconds + 15 + 30 + 10
    )
    && entry.auxiliaryExternalAudioSeconds === 0
    && entry.subtitleTranslationMode === 'native'
  )));
});

test('model stability uses one process-exclusion evidence cell per model', () => {
  assert.deepEqual(MODEL_STABILITY_CELLS.map((entry) => entry.modelId), RELEASE_MODELS);
  assert.ok(MODEL_STABILITY_CELLS.every((entry) => (
    entry.inputCompletionWatchdogSeconds === 225
    && entry.feedbackLoopPrevention === 'process-exclusion'
    && entry.deviceClass === 'default-speaker'
  )));
});

test('balanced plan rejects watchdog and provider-mode weakening', () => {
  const weakenedDuration = structuredClone(BALANCED_RELEASE_PLAN);
  weakenedDuration.cells[6].inputCompletionWatchdogSeconds = 30;
  assert.match(balancedReleasePlanFailure(weakenedDuration), /inputCompletionWatchdogSeconds/);

  const paidLocal = structuredClone(BALANCED_RELEASE_PLAN);
  paidLocal.cells[0].providerMode = 'live-dashscope';
  assert.match(balancedReleasePlanFailure(paidLocal), /providerMode/);

  const auxiliaryStt = structuredClone(BALANCED_RELEASE_PLAN);
  auxiliaryStt.externalProviderBudget.physicalOutputSttCalls = 1;
  assert.match(balancedReleasePlanFailure(auxiliaryStt), /external provider budget/);

  const secondary = structuredClone(BALANCED_RELEASE_PLAN);
  secondary.cells[4].subtitleTranslationMode = 'secondary';
  assert.match(balancedReleasePlanFailure(secondary), /subtitleTranslationMode/);
});

test('formal Watch documentation stays aligned with the LiveTranslate-only release authority', () => {
  const liveGuide = fs.readFileSync(
    new URL('../../docs/项目/Watch Mode 真实链路自动化测试.md', import.meta.url),
    'utf8',
  );
  const qualityGuide = fs.readFileSync(
    new URL('../../docs/项目/测试与质量门禁.md', import.meta.url),
    'utf8',
  );
  const fixtureGuide = fs.readFileSync(
    new URL('./fixtures/README.md', import.meta.url),
    'utf8',
  );

  assert.match(liveGuide, /3 个零 Provider local-isolation 格[\s\S]*4 个 LiveTranslate paid 格/u);
  assert.match(liveGuide, /10,100,180/u);
  assert.doesNotMatch(liveGuide, /8 份 live report|9 格本地隔离 authority|4 分钟配对时长|7 分钟稳定时长/u);

  assert.match(qualityGuide, /schema v6[\s\S]*4 份付费 live `report\.json`[\s\S]*3 个零 LLM 本地格/u);
  assert.doesNotMatch(qualityGuide, /8 份付费 live|6 个零 LLM 本地格|两条 3 分钟 `model-stability`/u);

  assert.match(fixtureGuide, /evidence-driven terminal/u);
  assert.doesNotMatch(fixtureGuide, /180-second Watch capture budget/u);
});
