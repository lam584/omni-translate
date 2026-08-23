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
  classifyReport,
  currentVm3Profile,
  resolveVm3SmokeLiveTimeoutMs,
  VM3_SMOKE_LIVE_TIMEOUT_HARD_CAP_MS,
  VM3_SMOKE_START_MIN_C_FREE_BYTES,
  vm3SmokeStartSpaceFailure,
  workerCapabilities as localWorkerCapabilities,
} from './watch-mode-smoke-local-adapter.mjs';

const workers = [{ workerId: 'vm3', deviceClasses: ['default-speaker'] }];

test('smoke plan locks the 6 + 3 + 8 coverage, full-media durations, and one-hour budget', () => {
  const plan = createWatchModeSmokePlan({ executionId: 'smoke-plan-test' });
  assert.equal(smokePlanFailure(plan), null);
  assert.equal(SMOKE_LOCAL_CELLS.length, 6);
  assert.equal(SMOKE_PLUS_CELLS.length, 3);
  assert.equal(SMOKE_RELEASE_CELLS.length, 8);
  assert.equal(plan.cells.length, 17);
  assert.equal(plan.totalBudgetSeconds, WATCH_MODE_SMOKE_BUDGET_SECONDS);
  assert.equal(plan.artifactKind, WATCH_MODE_SMOKE_ARTIFACT_KIND);
  assert.equal(plan.smokeOnly, true);
  assert.deepEqual(new Set(SMOKE_LOCAL_CELLS.map((cell) => cell.durationSeconds)), new Set([30]));
  assert.deepEqual(new Set([...SMOKE_PLUS_CELLS, ...SMOKE_RELEASE_CELLS].map((cell) => cell.durationSeconds)), new Set([180]));
  assert.deepEqual(new Set(plan.cells.map((cell) => cell.deviceClass)), new Set(['default-speaker']));
  assert.deepEqual(new Set(plan.cells.map((cell) => cell.sourceDeviceClass)), new Set(['default-speaker', 'usb']));
});

test('smoke assignments execute all cells serially on VM3', () => {
  const plan = createWatchModeSmokePlan({ executionId: 'smoke-assignment-test' });
  const assignments = createSmokeAssignments(plan.cells, workers);
  assert.equal(assignments.length, 17);
  assert.equal(new Set(assignments.map((entry) => entry.cellId)).size, 17);
  assert.deepEqual(new Set(assignments.map((entry) => entry.workerId)), new Set(['vm3']));
  for (const waveIndex of new Set(assignments.map((entry) => entry.waveIndex))) {
    const wave = assignments.filter((entry) => entry.waveIndex === waveIndex);
    assert.equal(new Set(wave.map((entry) => entry.workerId)).size, wave.length);
  }
  assert.deepEqual(assignments.map((entry) => entry.waveIndex), Array.from({ length: 17 }, (_, index) => index));
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
    assert.equal(calls.length, 17);
    assert.equal(new Set(calls).size, 17);
    assert.equal(result.manifest.passed, false);
    assert.equal(result.manifest.blocksAuthoritativeRun, true);
    assert.equal(result.manifest.outcomes.filter((entry) => entry.status === 'failed').length, 1);
    assert.equal(result.manifest.artifactKind, WATCH_MODE_SMOKE_ARTIFACT_KIND);
    assert.equal(result.manifest.smokeOnly, true);
    assert.equal(result.manifest.selection.reason, 'full 17-cell VM3 smoke');
    assert.equal(result.manifest.selection.stopOnFirstFailure, false);
    assert.equal(result.manifest.providerCalls, 11);
    assert.equal(result.manifest.dispatch.startedCount, 17);
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

test('VM3 smoke preflight requires the seven-GiB C-drive start buffer', () => {
  assert.match(vm3SmokeStartSpaceFailure(VM3_SMOKE_START_MIN_C_FREE_BYTES - 1), /7 GB smoke start buffer/);
  assert.match(vm3SmokeStartSpaceFailure(Number.NaN), /free space is unavailable/);
  assert.equal(vm3SmokeStartSpaceFailure(VM3_SMOKE_START_MIN_C_FREE_BYTES), null);
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
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 124);
    assert.equal(result.error, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
