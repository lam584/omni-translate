import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRunManifest } from './verify-watch-mode-evidence.mjs';
import {
  SMOKE_PREFLIGHT_RESULT_FILE,
  VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
  runWatchModeSmoke,
  createSmokeAssignments,
} from './run-watch-mode-smoke.mjs';
import {
  SMOKE_LOCAL_CELLS,
  SMOKE_PLUS_CELLS,
  SMOKE_RELEASE_CELLS,
  WATCH_MODE_SMOKE_ARTIFACT_KIND,
  WATCH_MODE_SMOKE_BUDGET_SECONDS,
  createWatchModeSmokePlan,
  smokePlanFailure,
} from './watch-mode-smoke-plan.mjs';
import {
  SMOKE_PROVIDER_SESSION_AUTHORITY_FILE,
  SMOKE_PROVIDER_SESSION_AUTHORITY_KIND,
  buildVm3PaidSmokeRunRequest,
  classifyTimeboxedCommandOutcome,
  classifyReport,
  createRuntimeBuildRunner,
  currentVm3Profile,
  evaluateSmokeProviderSessionAuthority,
  readSmokeProviderSessionAuthority,
  resolveVm3SmokeLiveTimeoutMs,
  smokeLiveReportCompletenessFailure,
  timeboxedCommandOutcomeFailure,
  VM3_SMOKE_LIVE_TIMEOUT_HARD_CAP_MS,
  VM3_SMOKE_START_MIN_C_FREE_BYTES,
  vm3RuntimeBuildSpaceFailure,
  vm3SmokeStartSpaceFailure,
  workerCapabilities as localWorkerCapabilities,
} from './watch-mode-smoke-local-adapter.mjs';

const workers = [{ workerId: 'vm3', deviceClasses: ['default-speaker'] }];

test('smoke plan locks the 3 + 3 + 8 single-device coverage and full-media durations', () => {
  const plan = createWatchModeSmokePlan({ executionId: 'smoke-plan-test' });
  assert.equal(smokePlanFailure(plan), null);
  assert.equal(SMOKE_LOCAL_CELLS.length, 3);
  assert.equal(SMOKE_PLUS_CELLS.length, 3);
  assert.equal(SMOKE_RELEASE_CELLS.length, 8);
  assert.equal(plan.cells.length, 14);
  assert.equal(plan.totalBudgetSeconds, WATCH_MODE_SMOKE_BUDGET_SECONDS);
  assert.equal(plan.artifactKind, WATCH_MODE_SMOKE_ARTIFACT_KIND);
  assert.equal(plan.smokeOnly, true);
  assert.deepEqual(new Set(SMOKE_LOCAL_CELLS.map((cell) => cell.durationSeconds)), new Set([30]));
  assert.deepEqual(new Set([...SMOKE_PLUS_CELLS, ...SMOKE_RELEASE_CELLS].map((cell) => cell.durationSeconds)), new Set([180]));
  assert.deepEqual(new Set(plan.cells.map((cell) => cell.deviceClass)), new Set(['default-speaker']));
  assert.deepEqual(new Set(plan.cells.map((cell) => cell.sourceDeviceClass)), new Set(['default-speaker']));
});

test('smoke assignments execute all cells serially on VM3', () => {
  const plan = createWatchModeSmokePlan({ executionId: 'smoke-assignment-test' });
  const assignments = createSmokeAssignments(plan.cells, workers);
  assert.equal(assignments.length, 14);
  assert.equal(new Set(assignments.map((entry) => entry.cellId)).size, 14);
  assert.deepEqual(new Set(assignments.map((entry) => entry.workerId)), new Set(['vm3']));
  for (const waveIndex of new Set(assignments.map((entry) => entry.waveIndex))) {
    const wave = assignments.filter((entry) => entry.waveIndex === waveIndex);
    assert.equal(new Set(wave.map((entry) => entry.workerId)).size, wave.length);
  }
  assert.deepEqual(assignments.map((entry) => entry.waveIndex), Array.from({ length: 14 }, (_, index) => index));
  assert.throws(() => createSmokeAssignments(plan.cells, []), /exactly one worker/);
});

test('smoke retains partial failures, does not retry, and writes a non-authoritative manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-'));
  const calls = [];
  try {
    const result = await runWatchModeSmoke({
      executionId: 'smoke-execution-test',
      workerCapabilities: workers,
      outputRoot: root,
      runCell: async ({ cell }) => {
        calls.push(cell.cellId);
        return {
          passed: cell.cellId !== SMOKE_PLUS_CELLS[0].cellId,
          ...(cell.cellId === SMOKE_PLUS_CELLS[0].cellId ? { classification: 'product' } : {}),
          evidence: `evidence/${cell.cellId}`,
          providerCalls: cell.providerMode === 'disabled' ? 0 : 1,
        };
      },
    });
    assert.equal(calls.length, 14);
    assert.equal(new Set(calls).size, 14);
    assert.equal(result.manifest.passed, false);
    assert.equal(result.manifest.blocksAuthoritativeRun, true);
    assert.equal(result.manifest.outcomes.filter((entry) => entry.status === 'failed').length, 1);
    assert.equal(result.manifest.artifactKind, WATCH_MODE_SMOKE_ARTIFACT_KIND);
    assert.equal(result.manifest.smokeOnly, true);
    assert.equal(result.manifest.selection.reason, 'full 14-cell VM3 smoke');
    assert.equal(result.manifest.selection.stopOnFirstFailure, false);
    assert.equal(result.manifest.providerCalls, 11);
    assert.equal(result.manifest.dispatch.startedCount, 14);
    assert.deepEqual(result.manifest.dispatch.duplicateCellIds, []);
    assert.throws(() => readRunManifest(result.manifestPath), /smoke manifest is non-authoritative/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smoke records a failed or paid preflight before any cell dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-'));
  const result = await runWatchModeSmoke({
    executionId: 'smoke-preflight-test', workerCapabilities: workers,
    outputRoot: root,
    runPreflight: async () => ({ passed: true, providerCalls: 1 }),
    runCell: async () => { throw new Error('must not execute'); },
  });
  try {
    assert.equal(result.manifest.passed, false);
    assert.equal(result.manifest.blocksAuthoritativeRun, true);
    assert.equal(result.manifest.outcomes.length, 0);
    assert.equal(result.manifest.preflight.providerCalls, 1);
    assert.equal(fs.existsSync(result.manifestPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smoke writes a failed manifest when preflight throws', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-'));
  try {
    const result = await runWatchModeSmoke({
      executionId: 'smoke-preflight-crash-test', workerCapabilities: workers, outputRoot: root,
      runPreflight: async () => { throw new Error('runtime build timed out'); },
      runCell: async () => { throw new Error('must not execute'); },
    });
    assert.equal(result.manifest.passed, false);
    assert.equal(result.manifest.preflight.failure, 'runtime build timed out');
    assert.equal(result.manifest.outcomes.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smoke targeted execution dispatches only selected cells and records its reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-targeted-'));
  const selected = [SMOKE_PLUS_CELLS[0].cellId, SMOKE_RELEASE_CELLS[1].cellId];
  const calls = [];
  try {
    const result = await runWatchModeSmoke({
      executionId: 'smoke-targeted-test',
      workerCapabilities: workers,
      outputRoot: root,
      cellIds: selected,
      selectionReason: 'verify bridge lifecycle repair',
      runCell: async ({ cell }) => {
        calls.push(cell.cellId);
        return { passed: true, evidence: `evidence/${cell.cellId}`, providerCalls: 1 };
      },
    });
    assert.deepEqual(calls, selected);
    assert.equal(result.manifest.selection.mode, 'targeted');
    assert.deepEqual(result.manifest.selection.cellIds, selected);
    assert.equal(result.manifest.selection.reason, 'verify bridge lifecycle repair');
    assert.equal(result.manifest.passed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smoke checkpoints an active paid dispatch before its outcome settles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-active-ledger-'));
  const selected = [SMOKE_PLUS_CELLS[0].cellId, SMOKE_PLUS_CELLS[1].cellId];
  let releaseSecond;
  const secondBlocked = new Promise((resolve) => { releaseSecond = resolve; });
  let notifySecondStarted;
  const secondStarted = new Promise((resolve) => { notifySecondStarted = resolve; });
  try {
    const running = runWatchModeSmoke({
      executionId: 'smoke-active-ledger-test',
      workerCapabilities: workers,
      outputRoot: root,
      cellIds: selected,
      selectionReason: 'prove active Provider reservation',
      runCell: async ({ cell }) => {
        if (cell.cellId === selected[1]) {
          notifySecondStarted();
          await secondBlocked;
        }
        return { passed: true, evidence: `evidence/${cell.cellId}`, providerCalls: 1 };
      },
    });
    await secondStarted;
    const checkpoint = JSON.parse(fs.readFileSync(path.join(root, 'smoke-active-ledger-test', 'smoke-manifest.json'), 'utf8'));
    assert.equal(checkpoint.activeCellId, selected[1]);
    assert.equal(checkpoint.providerCalls, 2);
    assert.equal(checkpoint.dispatch.startedCount, 2);
    assert.equal(checkpoint.dispatch.completedCount, 1);
    assert.deepEqual(checkpoint.dispatch.active, {
      cellId: selected[1], workerId: 'vm3', providerCalls: 1,
    });
    releaseSecond();
    const result = await running;
    assert.equal(result.manifest.providerCalls, 2);
    assert.equal(result.manifest.dispatch.startedCount, 2);
    assert.equal(result.manifest.dispatch.completedCount, 2);
  } finally {
    releaseSecond?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('targeted smoke can stop after its first failed cell without changing full-smoke defaults', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-first-failure-'));
  const selected = [SMOKE_PLUS_CELLS[0].cellId, SMOKE_PLUS_CELLS[1].cellId, SMOKE_PLUS_CELLS[2].cellId];
  const calls = [];
  try {
    const result = await runWatchModeSmoke({
      executionId: 'smoke-first-failure-test',
      workerCapabilities: workers,
      outputRoot: root,
      cellIds: selected,
      selectionReason: 'prove directed stop policy',
      stopOnFirstFailure: true,
      runCell: async ({ cell }) => {
        calls.push(cell.cellId);
        return { passed: false, classification: 'product', providerCalls: 1 };
      },
    });
    assert.deepEqual(calls, [selected[0]]);
    assert.equal(result.manifest.selection.stopOnFirstFailure, true);
    assert.equal(result.manifest.providerCalls, 1);
    assert.equal(result.manifest.dispatch.startedCount, 1);
    assert.match(result.manifest.stopReason, /stopped after failed cell/);
    await assert.rejects(runWatchModeSmoke({
      executionId: 'smoke-full-first-failure-rejected',
      workerCapabilities: workers,
      outputRoot: root,
      stopOnFirstFailure: true,
      runCell: async () => ({ passed: true, providerCalls: 0 }),
    }), /allowed only for targeted execution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smoke persists preflight provenance before dispatch and records C-drive minimum space', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-ledger-'));
  const selected = [SMOKE_LOCAL_CELLS[0].cellId];
  const runtimeAuthority = [{ path: 'target/release/omni-desktop-shell.exe', sha256: 'a'.repeat(64) }];
  try {
    const result = await runWatchModeSmoke({
      executionId: 'smoke-ledger-test',
      workerCapabilities: workers,
      outputRoot: root,
      cellIds: selected,
      selectionReason: 'prove execution ledger',
      sampleDiskSpace: async () => 8 * 1024 ** 3,
      runPreflight: async () => ({
        passed: true,
        providerCalls: 0,
        provenance: { headCommit: '0123456789abcdef', worktreeClean: true },
        deviceProfile: { profileId: 'vm3-hda-default' },
        buildSettings: { cargoOffline: true },
        runtimeAuthority,
      }),
      runCell: async ({ executionRoot }) => {
        const preflightPath = path.join(executionRoot, SMOKE_PREFLIGHT_RESULT_FILE);
        assert.equal(fs.existsSync(preflightPath), true, 'preflight receipt must exist before dispatch');
        const receipt = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.equal(receipt.result.provenance.headCommit, '0123456789abcdef');
        return { passed: true, providerCalls: 0, evidence: 'evidence/local' };
      },
    });
    assert.equal(result.manifest.passed, true);
    assert.equal(result.manifest.executionStatus, 'completed');
    assert.equal(result.manifest.diskSpace.samples.length, 3);
    assert.equal(result.manifest.diskSpace.minimumFreeBytes, 8 * 1024 ** 3);
    assert.deepEqual(result.manifest.provenance.runtimeAuthority, runtimeAuthority);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smoke does not dispatch another cell after the C-drive stop floor is reached', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-disk-stop-'));
  const selected = [SMOKE_LOCAL_CELLS[0].cellId, SMOKE_LOCAL_CELLS[1].cellId];
  const freeBytes = [8 * 1024 ** 3, 8 * 1024 ** 3, VM3_SMOKE_STOP_MIN_C_FREE_BYTES];
  const calls = [];
  try {
    const result = await runWatchModeSmoke({
      executionId: 'smoke-disk-stop-test',
      workerCapabilities: workers,
      outputRoot: root,
      cellIds: selected,
      selectionReason: 'prove runtime disk stop',
      sampleDiskSpace: async () => freeBytes.shift(),
      runCell: async ({ cell }) => {
        calls.push(cell.cellId);
        return { passed: true, providerCalls: 0, evidence: 'evidence/local' };
      },
    });
    assert.deepEqual(calls, [selected[0]]);
    assert.equal(result.manifest.passed, false);
    assert.equal(result.manifest.blocksAuthoritativeRun, true);
    assert.equal(result.manifest.outcomes.length, 1);
    assert.equal(result.manifest.diskSpace.minimumFreeBytes, VM3_SMOKE_STOP_MIN_C_FREE_BYTES);
    assert.match(result.manifest.stopReason, /at or below the smoke stop floor/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an external Provider failure remains non-passing and blocks authoritative execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-provider-stop-'));
  try {
    const result = await runWatchModeSmoke({
      executionId: 'smoke-provider-stop-test',
      workerCapabilities: workers,
      outputRoot: root,
      cellIds: [SMOKE_PLUS_CELLS[0].cellId],
      selectionReason: 'prove external failures cannot pass',
      runCell: async () => ({
        passed: false,
        classification: 'provider-external',
        providerCalls: 1,
        evidence: 'evidence/provider-failure',
      }),
    });
    assert.equal(result.manifest.passed, false);
    assert.equal(result.manifest.blocksAuthoritativeRun, true);
    assert.equal(result.manifest.providerCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VM3 local adapter binds the present default speaker and one local worker', () => {
  assert.deepEqual(localWorkerCapabilities, [
    { workerId: 'vm3-local', deviceClasses: ['default-speaker'] },
  ]);
  const profile = currentVm3Profile();
  assert.equal(profile.deviceClass, 'default-speaker');
  assert.match(profile.physicalPlaybackDeviceId, /^\{0\.0\.0\.00000000\}\.\{[a-f0-9-]+\}$/i);
  assert.match(profile.expectedPhysicalPlaybackDeviceName, /High Definition Audio Device/);
});

test('VM3 paid smoke runner emits one typed local canonical request', () => {
  const request = buildVm3PaidSmokeRunRequest({
    cell: SMOKE_PLUS_CELLS[0],
    outputRoot: 'artifacts/testing/watch-mode-smoke-runtime/test',
    liveTiming: {
      durationSeconds: 180,
      warmupSeconds: 5,
      playbackSeconds: 0,
      postPlaybackWaitSeconds: 20,
      sessionReadyTimeoutSeconds: 60,
    },
  });
  assert.equal(request.schemaVersion, 'watch-mode-run-request/v1');
  assert.equal(request.authorityMode, 'local-canonical-smoke');
  assert.equal(request.physicalContentMode, 'local-canonical');
});

function completePaidSmokeReport(cell = SMOKE_PLUS_CELLS[0]) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-24T00:00:00.000Z',
    commit: '0123456789abcdef',
    provenance: { headCommit: '0123456789abcdef', worktreeClean: true },
    buildHash: null,
    mode: 'live',
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceEvidence: {},
    realtimeSession: {},
    translationRoute: 'native',
    watchSessionReport: {
      sessionId: 'watch-session-smoke-test',
      status: 'completed',
      routeMode: 'watch',
      providerId: 'provider-dashscope',
      model: cell.modelId,
      startedAt: 'unix-ms:1000',
      endedAt: 'unix-ms:181000',
      elapsedMs: cell.durationSeconds * 1_000,
      summary: {
        durationMs: cell.durationSeconds * 1_000,
        cueCount: 1,
        completeCueCount: 1,
        visibleRenderCueCount: 1,
        unrenderedCueCount: 0,
        issueCount: 0,
        issueOccurrenceCount: 0,
      },
      cues: [{
        cueId: 'cue-1',
        comparisonStatus: 'exact',
        sourceText: 'complete source cue',
        llmText: '完整译文',
        publishedText: '完整译文',
        renderedText: '完整译文',
        llmFirstAtMs: 1,
        publishedFirstAtMs: 2,
        renderedFirstAtMs: 3,
        llmFirstToRenderMs: 2,
        publishToRenderMs: 1,
      }],
      events: [],
      issues: [],
      droppedCueCount: 0,
      droppedEventCount: 0,
    },
    verdict: 'passed',
    failureLayer: null,
    failureReason: null,
    suspectFiles: [],
    layers: Object.fromEntries([
      'environment',
      'driver',
      'wasapi',
      'bridge',
      'physicalOutput',
      'physicalOutputContent',
      'aec',
      'speechSegmentation',
      'strictContent',
      'app',
      'provider',
    ].map((layer) => [layer, { status: 'passed', reason: null, reasons: [], data: {} }])),
    diagnostics: {},
    artifacts: {},
  };
}

test('VM3 paid smoke passes only with one primary and zero auxiliary Provider sessions', () => {
  const cell = SMOKE_PLUS_CELLS[0];
  const report = completePaidSmokeReport(cell);
  const authority = {
    schemaVersion: 1,
    artifactKind: SMOKE_PROVIDER_SESSION_AUTHORITY_KIND,
    nonAuthoritative: true,
    passed: true,
    providerSessions: 1,
    auxiliaryProviderSessions: 0,
  };
  assert.deepEqual(
    evaluateSmokeProviderSessionAuthority({ report, authority, expectedCell: cell }),
    {
      passed: true,
      providerCalls: 1,
      authorityFailure: null,
      reportFailure: null,
      classification: null,
    },
  );
  assert.equal(
    evaluateSmokeProviderSessionAuthority({
      report: {
        ...report,
        verdict: 'failed',
        failureLayer: 'provider',
        failureReason: 'provider returned an error',
      },
      authority,
      expectedCell: cell,
    }).passed,
    false,
  );
  assert.match(
    evaluateSmokeProviderSessionAuthority({
      report,
      authority: { ...authority, schemaVersion: 2 },
      expectedCell: cell,
    }).authorityFailure,
    /wrong schemaVersion/,
  );
  const auxiliary = evaluateSmokeProviderSessionAuthority({
    report,
    authority: { ...authority, auxiliaryProviderSessions: 1 },
    expectedCell: cell,
  });
  assert.equal(auxiliary.passed, false);
  assert.equal(auxiliary.providerCalls, 2);
  assert.match(auxiliary.authorityFailure, /auxiliary Provider sessions; expected 0/);
});

test('VM3 paid smoke report completeness fails closed before a passing verdict can count', () => {
  const cell = SMOKE_PLUS_CELLS[0];
  const report = completePaidSmokeReport(cell);
  assert.equal(smokeLiveReportCompletenessFailure(report, {
    expectedModelId: cell.modelId,
    expectedFeedbackLoopPrevention: cell.feedbackLoopPrevention,
    minimumDurationMs: cell.durationSeconds * 1_000,
  }), null);

  assert.match(
    smokeLiveReportCompletenessFailure({ verdict: 'passed' }),
    /wrong schemaVersion/,
  );
  assert.match(
    smokeLiveReportCompletenessFailure({
      ...report,
      watchSessionReport: { ...report.watchSessionReport, elapsedMs: 179_999 },
    }),
    /duration is too short/,
  );
  assert.match(
    smokeLiveReportCompletenessFailure({
      ...report,
      watchSessionReport: { ...report.watchSessionReport, droppedEventCount: 1 },
    }),
    /dropped evidence/,
  );
  assert.match(
    smokeLiveReportCompletenessFailure({
      ...report,
      watchSessionReport: {
        ...report.watchSessionReport,
        cues: [],
        summary: { ...report.watchSessionReport.summary, completeCueCount: 0 },
      },
    }),
    /no complete model/,
  );
  assert.match(
    smokeLiveReportCompletenessFailure({
      ...report,
      watchSessionReport: {
        ...report.watchSessionReport,
        cues: [
          ...report.watchSessionReport.cues,
          {
            cueId: 'cue-incomplete-tail',
            comparisonStatus: 'not-published',
            sourceText: 'accepted source tail without model output',
            llmText: '',
            publishedText: '',
            renderedText: '',
          },
        ],
      },
    }),
    /incomplete accepted cue lifecycle.*cue-incomplete-tail/,
  );
  assert.equal(smokeLiveReportCompletenessFailure({
    ...report,
    verdict: 'blocked',
    failureLayer: 'environment',
    failureReason: 'runtime precondition failed',
  }), null, 'a complete non-passing report must retain its own failure classification');
  const mismatchedCell = SMOKE_PLUS_CELLS[1];
  const mismatched = evaluateSmokeProviderSessionAuthority({
    report,
    authority: {
      schemaVersion: 1,
      artifactKind: SMOKE_PROVIDER_SESSION_AUTHORITY_KIND,
      nonAuthoritative: true,
      passed: true,
      providerSessions: 1,
      auxiliaryProviderSessions: 0,
    },
    expectedCell: mismatchedCell,
  });
  assert.equal(mismatched.passed, false);
  assert.equal(mismatched.classification, 'orchestration');
  assert.match(mismatched.reportFailure, /feedbackLoopPrevention/);
});

test('VM3 paid smoke authority read fails closed for missing and invalid receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-authority-'));
  const cell = SMOKE_PLUS_CELLS[0];
  const report = completePaidSmokeReport(cell);
  try {
    const missing = readSmokeProviderSessionAuthority(root);
    assert.equal(missing.authority, null);
    assert.match(missing.failure, /missing smoke-provider-session-authority\.json/);
    assert.deepEqual(
      evaluateSmokeProviderSessionAuthority({
        report,
        authority: missing.authority,
        readFailure: missing.failure,
        expectedCell: cell,
      }),
      {
        passed: false,
        providerCalls: 1,
        authorityFailure: missing.failure,
        reportFailure: null,
        classification: 'orchestration',
      },
    );

    fs.writeFileSync(path.join(root, SMOKE_PROVIDER_SESSION_AUTHORITY_FILE), '{invalid\n', 'utf8');
    const invalid = readSmokeProviderSessionAuthority(root);
    assert.equal(invalid.authority, null);
    assert.match(invalid.failure, /invalid smoke-provider-session-authority\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VM3 smoke preflight requires the seven-GiB C-drive start buffer', () => {
  assert.match(vm3SmokeStartSpaceFailure(VM3_SMOKE_START_MIN_C_FREE_BYTES - 1), /7 GB smoke start buffer/);
  assert.match(vm3SmokeStartSpaceFailure(Number.NaN), /free space is unavailable/);
  assert.equal(vm3SmokeStartSpaceFailure(VM3_SMOKE_START_MIN_C_FREE_BYTES), null);
});

test('runtime build disk and timeout outcomes remain distinct', () => {
  assert.match(vm3RuntimeBuildSpaceFailure(VM3_SMOKE_STOP_MIN_C_FREE_BYTES), /5 GB smoke floor/);
  assert.match(vm3RuntimeBuildSpaceFailure(Number.NaN), /unavailable before runtime build/);
  assert.equal(vm3RuntimeBuildSpaceFailure(VM3_SMOKE_STOP_MIN_C_FREE_BYTES + 1), null);
  assert.deepEqual(classifyTimeboxedCommandOutcome({
    status: 125,
    errorCode: null,
    outcome: { reason: 'c-drive-floor' },
  }), {
    terminationReason: 'c-drive-floor',
    timedOut: false,
    diskFloorReached: true,
  });
  assert.deepEqual(classifyTimeboxedCommandOutcome({
    status: 125,
    errorCode: null,
    outcome: { reason: 'child-exit' },
  }), {
    terminationReason: 'child-exit',
    timedOut: false,
    diskFloorReached: false,
  });
  assert.deepEqual(classifyTimeboxedCommandOutcome({
    status: 124,
    errorCode: null,
    outcome: { reason: 'timeout' },
  }), {
    terminationReason: 'timeout',
    timedOut: true,
    diskFloorReached: false,
  });
});

test('timeboxed outcome semantics reject forged disk, timestamp, minimum, and trigger claims', () => {
  const startedAt = '2026-08-24T00:00:00.000Z';
  const sampledAt = '2026-08-24T00:00:00.500Z';
  const completedAt = '2026-08-24T00:00:01.000Z';
  const floorSample = {
    sampledAt,
    freeBytes: VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
    error: null,
  };
  const validFloor = {
    schemaVersion: 1,
    artifactKind: 'timeboxed-command-outcome',
    reason: 'c-drive-floor',
    exitCode: 125,
    thresholdBytes: VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
    trigger: floorSample,
    minimumCFreeBytes: VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
    samples: [floorSample],
    childProcessId: 123,
    startedAt,
    completedAt,
    durationMs: 1_000,
    failure: null,
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  assert.equal(timeboxedCommandOutcomeFailure(validFloor, { status: 125 }), null);

  const wrongThreshold = copy(validFloor);
  wrongThreshold.thresholdBytes += 1;
  assert.match(timeboxedCommandOutcomeFailure(wrongThreshold, { status: 125 }), /threshold must equal/);

  const missingTrigger = copy(validFloor);
  missingTrigger.trigger = null;
  assert.match(timeboxedCommandOutcomeFailure(missingTrigger, { status: 125 }), /requires a trigger/);

  const aboveFloorTrigger = copy(validFloor);
  aboveFloorTrigger.trigger.freeBytes += 1;
  aboveFloorTrigger.samples[0].freeBytes += 1;
  aboveFloorTrigger.minimumCFreeBytes += 1;
  assert.match(timeboxedCommandOutcomeFailure(aboveFloorTrigger, { status: 125 }), /at or below the threshold/);

  const wrongMinimum = copy(validFloor);
  wrongMinimum.minimumCFreeBytes -= 1;
  assert.match(timeboxedCommandOutcomeFailure(wrongMinimum, { status: 125 }), /does not match sampled minimum/);

  const invalidTimestamp = copy(validFloor);
  invalidTimestamp.samples[0].sampledAt = 'not-a-timestamp';
  invalidTimestamp.trigger.sampledAt = 'not-a-timestamp';
  assert.match(timeboxedCommandOutcomeFailure(invalidTimestamp, { status: 125 }), /sample timestamp/);

  const negativeDuration = copy(validFloor);
  negativeDuration.durationMs = -1;
  assert.match(timeboxedCommandOutcomeFailure(negativeDuration, { status: 125 }), /non-negative finite/);

  const healthySample = {
    sampledAt,
    freeBytes: VM3_SMOKE_STOP_MIN_C_FREE_BYTES + 1,
    error: null,
  };
  const validTimeout = {
    ...copy(validFloor),
    reason: 'timeout',
    exitCode: 124,
    trigger: null,
    minimumCFreeBytes: healthySample.freeBytes,
    samples: [healthySample],
  };
  assert.equal(timeboxedCommandOutcomeFailure(validTimeout, { status: 124 }), null);
  const timeoutWithTrigger = copy(validTimeout);
  timeoutWithTrigger.trigger = healthySample;
  assert.match(timeboxedCommandOutcomeFailure(timeoutWithTrigger, { status: 124 }), /must not contain a trigger/);

  const validChild125 = {
    ...copy(validFloor),
    reason: 'child-exit',
    exitCode: 125,
    trigger: null,
    minimumCFreeBytes: null,
    samples: [],
  };
  assert.equal(timeboxedCommandOutcomeFailure(validChild125, { status: 125 }), null);
  const childWithTrigger = copy(validChild125);
  childWithTrigger.trigger = healthySample;
  assert.match(timeboxedCommandOutcomeFailure(childWithTrigger, { status: 125 }), /must not contain a trigger/);
});

test('runtime build runner samples C before every command and refuses the second command at the floor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-runtime-build-floor-'));
  const preflightRoot = path.join(root, 'preflight');
  const temporaryRoot = path.join(root, 'temporary');
  fs.mkdirSync(preflightRoot, { recursive: true });
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const checks = [];
  const freeBytes = [VM3_SMOKE_STOP_MIN_C_FREE_BYTES + 1, VM3_SMOKE_STOP_MIN_C_FREE_BYTES];
  const wrapperCalls = [];
  try {
    const runWrapper = (command, args) => {
      wrapperCalls.push({ command, args });
      const outcomePath = args[args.indexOf('-OutcomePath') + 1];
      fs.writeFileSync(outcomePath, `${JSON.stringify({
        schemaVersion: 1,
        artifactKind: 'timeboxed-command-outcome',
        reason: 'child-exit',
        exitCode: 0,
        thresholdBytes: VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
        trigger: null,
        minimumCFreeBytes: null,
        samples: [],
        childProcessId: 123,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
        failure: null,
      })}\n`, 'utf8');
      return { status: 0, stdout: '', stderr: '' };
    };
    const run = createRuntimeBuildRunner({
      checks,
      preflightRoot,
      temporaryRoot,
      platform: 'win32',
      sampleCFreeBytes: () => freeBytes.shift(),
      runWrapper,
    });
    const first = run('cmd.exe', ['/d', '/c', 'exit', '0'], {
      cwd: process.cwd(),
      env: process.env,
    });
    assert.equal(first.status, 0);
    assert.equal(first.terminationReason, 'child-exit');
    assert.throws(() => run('cmd.exe', ['/d', '/c', 'exit', '0'], {
      cwd: process.cwd(),
      env: process.env,
    }), /at or below the 5 GB smoke floor/);
    assert.equal(wrapperCalls.length, 1, 'the command at the floor must never launch');
    assert.equal(checks.length, 2);
    assert.equal(checks[0].cFreeBytesBeforeStart, VM3_SMOKE_STOP_MIN_C_FREE_BYTES + 1);
    assert.equal(checks[1].cFreeBytesBeforeStart, VM3_SMOKE_STOP_MIN_C_FREE_BYTES);
    assert.equal(checks[1].status, 125);
    assert.equal(checks[1].timedOut, false);
    assert.equal(checks[1].diskFloorReached, true);
    assert.equal(checks[1].timeboxOutcome.reason, 'c-drive-floor');
    assert.equal(checks[1].timeboxOutcome.trigger.freeBytes, VM3_SMOKE_STOP_MIN_C_FREE_BYTES);
    assert.equal(fs.existsSync(checks[1].timeboxOutcomeFile), true);
    assert.equal(timeboxedCommandOutcomeFailure(checks[1].timeboxOutcome, { status: 125 }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime build runner rejects a semantically forged disk-floor receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-runtime-build-forged-floor-'));
  const preflightRoot = path.join(root, 'preflight');
  const temporaryRoot = path.join(root, 'temporary');
  fs.mkdirSync(preflightRoot, { recursive: true });
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const checks = [];
  try {
    const run = createRuntimeBuildRunner({
      checks,
      preflightRoot,
      temporaryRoot,
      platform: 'win32',
      sampleCFreeBytes: () => VM3_SMOKE_STOP_MIN_C_FREE_BYTES + 2,
      runWrapper: (_command, args) => {
        const outcomePath = args[args.indexOf('-OutcomePath') + 1];
        const sampledAt = new Date().toISOString();
        const forgedFreeBytes = VM3_SMOKE_STOP_MIN_C_FREE_BYTES + 1;
        const sample = { sampledAt, freeBytes: forgedFreeBytes, error: null };
        fs.writeFileSync(outcomePath, `${JSON.stringify({
          schemaVersion: 1,
          artifactKind: 'timeboxed-command-outcome',
          reason: 'c-drive-floor',
          exitCode: 125,
          thresholdBytes: VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
          trigger: sample,
          minimumCFreeBytes: forgedFreeBytes,
          samples: [sample],
          childProcessId: 123,
          startedAt: sampledAt,
          completedAt: sampledAt,
          durationMs: 0,
          failure: null,
        })}\n`, 'utf8');
        return { status: 125, stdout: '', stderr: '' };
      },
    });
    const result = run('cmd.exe', ['/d', '/c', 'exit', '0'], {
      cwd: process.cwd(),
      env: process.env,
    });
    assert.equal(result.status, 125);
    assert.match(result.error?.message ?? '', /at or below the threshold/);
    assert.equal(result.terminationReason, 'unknown');
    assert.equal(result.diskFloorReached, false);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].passed, false);
    assert.equal(checks[0].timeboxOutcome, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VM3 live smoke timeout covers a 180-second cell lifecycle and remains hard-capped', () => {
  const timeoutMs = resolveVm3SmokeLiveTimeoutMs({
    durationSeconds: 180,
    warmupSeconds: 5,
    playbackSeconds: 0,
    postPlaybackWaitSeconds: 20,
    sessionReadyTimeoutSeconds: 60,
  });
  assert.equal(timeoutMs, 545_000);
  assert.ok(timeoutMs > 5 * 60 * 1_000, 'the live cell must retain post-capture processing time');
  assert.equal(VM3_SMOKE_LIVE_TIMEOUT_HARD_CAP_MS, 15 * 60 * 1_000);
  assert.equal(resolveVm3SmokeLiveTimeoutMs({
    durationSeconds: 7_200,
    warmupSeconds: 5,
    playbackSeconds: 0,
    postPlaybackWaitSeconds: 20,
    sessionReadyTimeoutSeconds: 60,
  }), VM3_SMOKE_LIVE_TIMEOUT_HARD_CAP_MS);
});

test('smoke adapter classifies provider 50002 cue evidence as external even when the runner layer is app', () => {
  assert.equal(classifyReport({
    failureLayer: 'app',
    failureReason: 'watch session report contains an explicit cue issue; issues=COMMON_ERROR,model-no-output',
    watchSessionReport: {
      cues: [{
        events: [{
          kind: 'provider-error',
          detail: 'providerCode=COMMON_ERROR message=<50002> InternalError.Algo.ModelServingError',
        }],
      }],
    },
  }), 'provider-external');
});

test('Windows timebox terminates its owned child process tree', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-timebox-'));
  try {
    const outcomePath = path.join(root, 'outcome.json');
    const payload = Buffer.from(JSON.stringify({
      command: 'cmd.exe',
      arguments: ['/d', '/s', '/c', 'ping.exe -n 20 127.0.0.1'],
      cwd: process.cwd(),
      environment: { Path: process.env.Path ?? '' },
    }), 'utf8').toString('base64');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(process.cwd(), 'scripts', 'testing', 'run-timeboxed-command.ps1'),
      '-PayloadBase64', payload,
      '-TimeoutMs', '500',
      '-StdoutPath', path.join(root, 'stdout.log'),
      '-StderrPath', path.join(root, 'stderr.log'),
      '-OutcomePath', outcomePath,
      '-PollIntervalMs', '50',
    // Windows PowerShell can spend several seconds loading CIM while the host
    // is under concurrent test/build pressure. The wrapper still enforces its
    // own 500 ms child deadline; this outer bound only prevents the harness
    // from killing the wrapper while it is closing redirected handles.
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 124);
    assert.equal(result.error, undefined);
    const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
    assert.equal(outcome.reason, 'timeout');
    assert.equal(outcome.exitCode, 124);
    assert.equal(outcome.thresholdBytes, 0);
    assert.equal(outcome.trigger, null);
    assert.equal(outcome.minimumCFreeBytes, null);
    assert.deepEqual(outcome.samples, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Windows timebox records a disk-floor receipt and removes its descendant process', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-smoke-disk-timebox-'));
  const childScript = path.join(root, 'child.ps1');
  const descendantPidPath = path.join(root, 'descendant.pid');
  const outcomePath = path.join(root, 'outcome.json');
  try {
    fs.writeFileSync(childScript, [
      'param([Parameter(Mandatory = $true)][string]$PidPath)',
      "$child = Start-Process -FilePath 'ping.exe' -ArgumentList @('-n', '30', '127.0.0.1') -PassThru",
      '[IO.File]::WriteAllText($PidPath, [string]$child.Id)',
      '$child.WaitForExit()',
      '',
    ].join('\r\n'), 'utf8');
    const payload = Buffer.from(JSON.stringify({
      command: 'powershell.exe',
      arguments: [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', childScript,
        '-PidPath', descendantPidPath,
      ],
      cwd: process.cwd(),
      environment: { Path: process.env.Path ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
    }), 'utf8').toString('base64');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(process.cwd(), 'scripts', 'testing', 'run-timeboxed-command.ps1'),
      '-PayloadBase64', payload,
      '-TimeoutMs', '6000',
      '-StdoutPath', path.join(root, 'stdout.log'),
      '-StderrPath', path.join(root, 'stderr.log'),
      '-OutcomePath', outcomePath,
      '-MinCFreeBytes', String(Number.MAX_SAFE_INTEGER),
      '-PollIntervalMs', '2000',
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 125, result.stderr);
    assert.equal(result.error, undefined);
    const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
    assert.equal(outcome.reason, 'c-drive-floor');
    assert.equal(outcome.exitCode, 125);
    assert.equal(outcome.thresholdBytes, Number.MAX_SAFE_INTEGER);
    assert.ok(outcome.samples.length >= 1);
    assert.equal(outcome.trigger.freeBytes, outcome.minimumCFreeBytes);
    assert.ok(outcome.trigger.freeBytes > 0);
    assert.equal(fs.existsSync(descendantPidPath), true, 'the descendant must start before the disk guard kills the tree');
    const descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, 'utf8'), 10);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    for (const processId of [outcome.childProcessId, descendantPid]) {
      const probe = spawnSync('powershell.exe', [
        '-NoProfile', '-Command',
        `if (Get-Process -Id ${processId} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`,
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
      assert.equal(probe.status, 0, `process ${processId} survived the disk-floor tree kill`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
