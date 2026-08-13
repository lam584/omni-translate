import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_ISOLATION_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  buildLocalIsolationRuntime,
  createLocalIsolationMatrixDirectory,
  localIsolationRuntimeInventory,
  LOCAL_ISOLATION_REUSE_ALLOWED_PATHS,
  LOCAL_ISOLATION_REUSE_MODE,
  LOCAL_ISOLATION_REUSABLE_LEGACY_PLAN_IDS,
  LOCAL_ISOLATION_RUNTIME_BINARY_PATHS,
  runLocalIsolationProbeIteration,
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

test('only known plans with identical zero-provider cells may reuse local authority', () => {
  assert.deepEqual(LOCAL_ISOLATION_REUSABLE_LEGACY_PLAN_IDS, [
    'watch-mode-balanced-v2',
    'watch-mode-balanced-v4',
  ]);
});

test('provider-only credential decoding is explicitly outside the zero-provider isolation layer', () => {
  assert.equal(
    LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes(
      'apps/desktop/src-tauri/src/storage/credential.rs',
    ),
    true,
  );
  assert.equal(LOCAL_ISOLATION_CELLS.every((cell) => cell.providerMode === 'disabled'), true);
});

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
  let recordedAecGate = null;
  buildLocalIsolationRuntime({
    workspaceRoot: process.cwd(),
    provenance,
    provenanceReader: () => provenance,
    runtimeHashesReader: () => [],
    recordAecGate: (result) => {
      recordedAecGate = result;
    },
    run: (command, args, options) => {
      calls.push({ command, args, target: options.env.CARGO_TARGET_DIR });
      return { status: 0 };
    },
  });
  const npmPrefix = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : [];
  assert.deepEqual(calls.map(({ args }) => args), [
    [...npmPrefix, 'run', 'test:aec3-msvc'],
    [...npmPrefix, 'run', 'build:desktop-shell'],
    [...npmPrefix, 'run', 'build:bridge-service-native'],
    [...npmPrefix, 'run', 'driver:build-sysvad'],
    ['build', '--manifest-path', 'scripts/diagnostics/omni-realtime/Cargo.toml'],
  ]);
  assert.equal(
    calls[0].target,
    path.join(process.cwd(), 'target', 'local-isolation-aec-gate'),
  );
  assert.ok(calls.slice(1).every(({ target }) => target === path.join(process.cwd(), 'target')));
  assert.deepEqual(recordedAecGate, { status: 0 });
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

test('local isolation retries only transient WASAPI endpoint creation failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-retry-'));
  const cellDirectory = path.join(root, 'cell');
  const calls = [];
  const waits = [];
  const result = runLocalIsolationProbeIteration({
    cell: LOCAL_ISOLATION_CELLS[0],
    profile: {
      profileId: 'default-speaker',
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: 'default',
      expectedPhysicalPlaybackDeviceName: 'Speaker',
    },
    cellDirectory,
    iteration: 1,
    workspaceRoot: root,
    waitForRetry: (delayMs) => waits.push(delayMs),
    run: () => {
      calls.push('probe');
      if (calls.length === 1) {
        return {
          exitCode: 1,
          stdout: '{"passed":false,"detail":"Windows returned an error: 0x8889000F"}\n',
          stderr: '',
          error: null,
        };
      }
      return {
        exitCode: 0,
        stdout: '{"passed":true,"resolvedPhysicalPlaybackDeviceName":"Speaker"}\n',
        stderr: '',
        error: null,
      };
    },
  });
  assert.deepEqual(calls, ['probe', 'probe']);
  assert.deepEqual(waits, [750]);
  assert.equal(result.probes[0].attempts, 2);
  assert.equal(
    fs.existsSync(path.join(cellDirectory, 'iterations', '0001', 'process-exclusion.attempt-1.stdout.log')),
    true,
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

test('local isolation reuse accepts the exact clean HEAD with identical implementation authority', () => {
  const runtimeBinaryHashes = LOCAL_ISOLATION_RUNTIME_BINARY_PATHS.map((entryPath, index) => ({
    path: entryPath,
    bytes: index + 1,
    sha256: String(index + 1).padStart(64, '0'),
  }));
  const implementationHashes = [{
    path: 'scripts/testing/watch-mode-local-isolation.mjs',
    bytes: 10,
    sha256: 'a'.repeat(64),
  }];
  const failure = reusableLocalIsolationAuthorityFailure({
    manifest: {
      provenance,
      implementationHashes,
      runtimeBinaryHashes,
    },
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    reuseAuthority: {
      mode: LOCAL_ISOLATION_REUSE_MODE,
      sourceCommit: provenance.headCommit,
      verifiedCommit: provenance.headCommit,
      changedPaths: [],
      sourceRuntimeBinaryHashes: runtimeBinaryHashes,
      currentRuntimeBinaryHashes: runtimeBinaryHashes,
    },
    workspaceRoot: process.cwd(),
  });
  assert.equal(failure, null);
});

test('local isolation runtime scope excludes paid-only media injector binaries', () => {
  const local = [
    { path: 'target/release/omni-bridge-service.exe', bytes: 1, sha256: 'a' },
    { path: 'target/release/omni-physical-output-probe.exe', bytes: 2, sha256: 'b' },
  ];
  const scoped = localIsolationRuntimeInventory([
    ...local,
    { path: 'target/release/omni-watch-media-injector.exe', bytes: 3, sha256: 'c' },
  ]);
  assert.deepEqual(scoped, local);
});
