import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_ISOLATION_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  buildLocalIsolationRuntime,
  createLocalIsolationMatrixDirectory,
  reusableLocalIsolationAuthorityFailure,
  runLocalIsolationCell,
} from './watch-mode-local-isolation.mjs';

const hashes = [];
const provenance = {
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: 'a'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
};

test('local isolation creates its output root on a first clean-machine run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-root-'));
  const matrixDirectory = path.join(root, 'missing-parent', 'matrix');
  createLocalIsolationMatrixDirectory(matrixDirectory);
  assert.equal(fs.statSync(matrixDirectory).isDirectory(), true);
  assert.throws(
    () => createLocalIsolationMatrixDirectory(matrixDirectory),
    /EEXIST/,
  );
});

test('standalone local isolation rebuilds Bridge and driver from the exact clean HEAD', () => {
  const calls = [];
  buildLocalIsolationRuntime({
    workspaceRoot: process.cwd(),
    provenance,
    provenanceReader: () => provenance,
    runtimeHashesReader: () => [],
    run: (command, args, options) => {
      calls.push({ command, args, target: options.env.CARGO_TARGET_DIR });
      return { status: 0 };
    },
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['run', 'build:bridge-service-native'],
    ['run', 'driver:build-sysvad'],
  ]);
  assert.ok(calls.every(({ target }) => target === path.join(process.cwd(), 'target')));
});

test('local isolation cell records five minutes and zero provider calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-'));
  let clock = Date.parse('2026-08-11T00:00:00.000Z');
  const cell = LOCAL_ISOLATION_CELLS[0];
  const result = await runLocalIsolationCell({
    cell,
    profile: {
      profileId: 'default-speaker',
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: 'default',
      expectedPhysicalPlaybackDeviceName: '',
    },
    outputRoot: root,
    provenance,
    implementationHashes: hashes,
    runtimeBinaryHashes: hashes,
    now: () => clock,
    runIteration: ({ cellDirectory, iteration }) => {
      const directory = path.join(cellDirectory, 'iterations', String(iteration).padStart(4, '0'));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'result.json'), '{"passed":true}\n', 'utf8');
      clock += 60_000;
    },
  });
  assert.equal(result.providerCalls, 0);
  assert.equal(result.durationMs, 300_000);
  assert.equal(result.iterationCount, 5);
});

test('local isolation cell refuses a clock that does not reach its duration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-short-'));
  let calls = 0;
  await assert.rejects(
    runLocalIsolationCell({
      cell: { ...LOCAL_ISOLATION_CELLS[0], durationSeconds: 1 },
      profile: {
        profileId: 'default-speaker',
        deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: 'default',
        expectedPhysicalPlaybackDeviceName: '',
      },
      outputRoot: root,
      provenance,
      implementationHashes: hashes,
      runtimeBinaryHashes: hashes,
      now: () => (calls === 0 ? 1_000 : 1_500),
      runIteration: () => { calls += 1; throw new Error('probe failed'); },
    }),
    /probe failed/,
  );
});

test('local isolation reuse is explicit and cannot silently fall back to exact reuse', () => {
  const failure = reusableLocalIsolationAuthorityFailure({
    manifest: { provenance },
    provenance,
    implementationHashes: [],
    runtimeBinaryHashes: [],
    reuseAuthority: { mode: 'unexpected' },
    workspaceRoot: process.cwd(),
  });
  assert.match(failure, /reuse mode must be orchestration-only/);
});
