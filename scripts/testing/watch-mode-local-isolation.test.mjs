import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_ISOLATION_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  createLocalIsolationMatrixDirectory,
  runLocalIsolationProbeIteration,
  runLocalIsolationCell,
} from './watch-mode-local-isolation.mjs';
import { buildDevelopmentSmokeRuntime } from './watch-mode-development-smoke-runtime.mjs';

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

test('local isolation atomically replaces the latest-successful publication pointer', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'testing', 'watch-mode-local-isolation.mjs'),
    'utf8',
  );
  assert.match(
    source,
    /atomicWriteJson\(canonicalPath,[\s\S]*?\}, \{ overwrite: true \}\);/u,
    'a new clean-HEAD isolation run must replace the canonical pointer without mutating its immutable source manifest',
  );
});

test('development smoke runtime rebuilds Bridge and driver from the exact clean HEAD', () => {
  const calls = [];
  let recordedAecGate = null;
  let removedAuthorityExecutable = null;
  buildDevelopmentSmokeRuntime({
    workspaceRoot: process.cwd(),
    provenance,
    provenanceReader: () => provenance,
    runtimeHashesReader: () => [],
    runtimeArtifactExists: () => true,
    recordAecGate: (result) => {
      recordedAecGate = result;
    },
    removeRuntimeAuthorityExecutable: (executablePath) => {
      removedAuthorityExecutable = executablePath;
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
    ['build', '--locked', '--release', '--manifest-path', 'scripts/diagnostics/omni-benchmark/Cargo.toml'],
  ]);
  assert.equal(
    calls[0].target,
    path.join(process.cwd(), 'target', 'local-isolation-aec-gate'),
  );
  assert.ok(calls.slice(1).every(({ target }) => target === path.join(process.cwd(), 'target')));
  assert.deepEqual(recordedAecGate, { status: 0 });
  assert.equal(
    removedAuthorityExecutable,
    path.join(process.cwd(), 'target', 'release', 'omni-desktop-shell.exe'),
  );
});

test('development smoke stops before later runtime builds when the Desktop authority artifact is absent', () => {
  const calls = [];
  assert.throws(
    () => buildDevelopmentSmokeRuntime({
      workspaceRoot: process.cwd(),
      provenance,
      provenanceReader: () => provenance,
      runtimeArtifactExists: () => false,
      removeRuntimeAuthorityExecutable: () => {},
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    }),
    /authority artifact target\/release\/omni-desktop-shell\.exe is missing/,
  );
  const npmPrefix = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : [];
  assert.deepEqual(calls.map(({ args }) => args), [
    [...npmPrefix, 'run', 'test:aec3-msvc'],
    [...npmPrefix, 'run', 'build:desktop-shell'],
  ]);
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

test('local isolation retries transient WASAPI endpoint creation failures', () => {
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

test('local isolation retries a briefly missing physical endpoint but keeps the requested id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-missing-endpoint-'));
  const cellDirectory = path.join(root, 'cell');
  const calls = [];
  const waits = [];
  const requestedDeviceId = '{0.0.0.00000000}.{usb-endpoint}';
  const result = runLocalIsolationProbeIteration({
    cell: { ...LOCAL_ISOLATION_CELLS[0], feedbackLoopPrevention: 'virtual-driver' },
    profile: {
      profileId: 'usb-speaker',
      deviceClass: 'usb',
      physicalPlaybackDeviceId: requestedDeviceId,
      expectedPhysicalPlaybackDeviceName: 'USB Audio',
    },
    cellDirectory,
    iteration: 1,
    workspaceRoot: root,
    waitForRetry: (delayMs) => waits.push(delayMs),
    run: (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return {
          exitCode: 0,
          stdout: '{"passed":true,"endpointName":"Omni Translate Virtual Speaker"}\n',
          stderr: '',
          error: null,
        };
      }
      if (calls.length === 2) {
        return {
          exitCode: 1,
          stdout: `${JSON.stringify({ passed: false, detail: `physical playback device was not found: ${requestedDeviceId}` })}\n`,
          stderr: '',
          error: null,
        };
      }
      return {
        exitCode: 0,
        stdout: '{"passed":true,"resolvedPhysicalPlaybackDeviceName":"SPDIF (USB Audio)"}\n',
        stderr: '',
        error: null,
      };
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [750]);
  assert.equal(result.probes[1].attempts, 2);
  assert.ok(calls[1].args.includes(requestedDeviceId));
  assert.ok(calls[2].args.includes(requestedDeviceId));
  assert.equal(
    fs.existsSync(path.join(cellDirectory, 'iterations', '0001', 'physical-output.attempt-1.stdout.log')),
    true,
  );
});

test('local isolation retries only an identity-bound incomplete process fingerprint window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-fingerprint-retry-'));
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
    cellDirectory: path.join(root, 'cell'),
    iteration: 1,
    workspaceRoot: root,
    waitForRetry: (delayMs) => waits.push(delayMs),
    run: () => {
      calls.push('probe');
      if (calls.length === 1) {
        return {
          exitCode: 1,
          stdout: `${JSON.stringify({
            passed: false,
            detail: 'external fingerprint did not survive process loopback: component=0.005 minimum=0.010; excluded/external source ratio is too high',
            processExclusionFingerprint: {
              bridgeProcessId: 42,
              excludedProcessId: 42,
              sourceCaptureMode: 'process-exclusion',
              captureBackend: 'wasapi-process-exclusion',
              processLoopbackStatus: 'ready',
              physicalExternalComponent: 0.2,
              physicalBridgeChildComponent: 0.2,
            },
          })}\n`,
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
});

test('local isolation does not retry unrelated probe failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-nonretryable-'));
  const calls = [];
  assert.throws(
    () => runLocalIsolationProbeIteration({
      cell: LOCAL_ISOLATION_CELLS[0],
      profile: {
        profileId: 'default-speaker',
        deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: 'default',
        expectedPhysicalPlaybackDeviceName: '',
      },
      cellDirectory: path.join(root, 'cell'),
      iteration: 1,
      workspaceRoot: root,
      waitForRetry: () => assert.fail('unrelated failure must not wait for retry'),
      run: () => {
        calls.push('probe');
        return {
          exitCode: 1,
          stdout: '{"passed":false,"detail":"bridge rejected physical output tone"}\n',
          stderr: '',
          error: null,
        };
      },
    }),
    /process-exclusion failed/,
  );
  assert.deepEqual(calls, ['probe']);
});
