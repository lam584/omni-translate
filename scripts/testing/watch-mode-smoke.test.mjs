import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRunManifest } from './verify-watch-mode-evidence.mjs';
import { runWatchModeSmoke, createSmokeAssignments } from './run-watch-mode-smoke.mjs';
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
  currentVm3Profile,
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
        return { passed: true, evidence: `evidence/${cell.cellId}` };
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

test('VM3 local adapter binds the present default speaker and one local worker', () => {
  assert.deepEqual(localWorkerCapabilities, [
    { workerId: 'vm3-local', deviceClasses: ['default-speaker'] },
  ]);
  const profile = currentVm3Profile();
  assert.equal(profile.deviceClass, 'default-speaker');
  assert.match(profile.physicalPlaybackDeviceId, /^\{0\.0\.0\.00000000\}\.\{[a-f0-9-]+\}$/i);
  assert.match(profile.expectedPhysicalPlaybackDeviceName, /High Definition Audio Device/);
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
