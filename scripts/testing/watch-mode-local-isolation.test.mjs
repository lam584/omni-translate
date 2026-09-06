import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_ISOLATION_CELLS, LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import { verifyProductionLocalIsolationManifest } from './run-watch-mode-live-production-coordinator.mjs';
import { defaultSingleWorkerAssignments, defaultTwoWorkerAssignments, fixedThreeWorkerAssignments } from './run-watch-mode-live-coordinator.mjs';
import { fixedFourWorkerAssignments } from './watch-mode-four-worker-plan.mjs';
import {
  createLocalIsolationMatrixDirectory,
  runLocalIsolationProbeIteration,
  runLocalIsolationCell,
  runLocalIsolationMatrix,
  publishLocalIsolationManifest,
  verifyLocalIsolationManifest,
} from './watch-mode-local-isolation.mjs';
import { AUTHORITY_IMPLEMENTATION_FILES, AUTHORITY_RUNTIME_BINARY_FILES, currentAuthorityImplementationHashes, currentAuthorityRuntimeBinaryHashes, fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';
import { generateCoordinatorSigningKeyPair, coordinatorKeyIdForPublicKey } from './watch-mode-shard-authority.mjs';
import { createDistributionRevalidationReceipt, LOCAL_ISOLATION_DISTRIBUTION_KIND } from './watch-mode-local-isolation-distributed.mjs';
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

for (const workerCount of [1, 2, 3, 4]) {
test('worker-relative receipts assemble into a strict source and canonical publication without rewriting receipts: ' + workerCount, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-assembly-'));
  const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
  const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
  const write = (relative, bytes) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  };
  for (const name of [...AUTHORITY_IMPLEMENTATION_FILES, ...AUTHORITY_RUNTIME_BINARY_FILES, 'scripts/testing/watch-mode-local-isolation-distributed.mjs']) write(name, `fixture:${name}`);
  const authorityDir = 'artifacts/testing/watch-mode-strict-runtime/test-release';
  const keys = generateCoordinatorSigningKeyPair();
  const publicPath = write(`${authorityDir}/public.pem`, keys.publicKeyPem);
  const privatePath = write(`${authorityDir}/private.pem`, keys.privateKeyPem);
  const certPath = write(`${authorityDir}/certificate.cer`, fs.readFileSync(path.join(root, 'drivers/windows-virtual-mic/package/omni-translate-development-driver.cer')));
  const aecPath = write(`${authorityDir}/aec.log`, 'fixture AEC passed');
  const runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot: root });
  const authority = {
    schemaVersion: 1, artifactKind: 'watch-mode-strict-runtime-authority', releaseId: 'test-release', provenance,
    implementationHashes: currentAuthorityImplementationHashes({ workspaceRoot: root }), runtimeBinaryHashes,
    certificate: {
      keyAlgorithm: 'RSA', keyLength: 3072, hashAlgorithm: 'SHA256', enhancedKeyUsage: 'Code Signing',
      signingMode: 'local-self-signed', trustScope: 'vmware-testsigning-only', publicProductionTrust: false,
      certificateAuthority: fileAuthorityEntry(certPath, 'certificate.cer'),
    },
    coordinatorSigning: {
      algorithm: 'Ed25519', keyId: coordinatorKeyIdForPublicKey(keys.publicKeyPem),
      publicKeyAuthority: fileAuthorityEntry(publicPath, 'public.pem'), privateKeyAuthority: fileAuthorityEntry(privatePath, 'private.pem'),
    },
    aec3Gate: { verdict: 'passed', authority: fileAuthorityEntry(aecPath, 'aec.log') },
  };
  authority.authorityDigest = digest(authority);
  const runtimeAuthorityPath = write(`${authorityDir}/strict-runtime-authority.json`, JSON.stringify(authority));
  const vmIdentity = { provider: 'fixture', uuidBios: 'fixture-only' };
  write('scripts/testing/watch-mode-four-worker-plan.mjs', 'fixture:four-worker-plan');
  const worker = {
    workerId: 'fixture-worker', vmIdentity, vmIdentityDigest: digest(vmIdentity),
    deviceProfileInstances: [{ instanceId: 'fixture-instance', profileId: 'fixture-profile', deviceClass: 'default-speaker', physicalPlaybackDeviceId: 'fixture-endpoint', expectedPhysicalPlaybackDeviceName: 'Fixture Speaker' }],
  };
  let matrixDirectory;
  const matrixWorkers = workerCount === 1 ? [worker] : ['vm171', 'vm167', 'vm169', 'vm131'].slice(0, workerCount).map((workerId) => {
    const vmIdentity = { provider: 'fixture', uuidBios: workerId };
    return { ...worker, workerId, vmIdentity, vmIdentityDigest: digest(vmIdentity), deviceProfileInstances: [{
      ...worker.deviceProfileInstances[0], instanceId: workerId + '-instance', physicalPlaybackDeviceId: workerId + '-endpoint',
    }] };
  });
  let distribution;
  const originalReceipts = new Map();
  const output = await runLocalIsolationMatrix({
    workers: matrixWorkers, deviceProfiles: matrixWorkers.flatMap((entry) => entry.deviceProfileInstances), workspaceRoot: root, provenance, runtimeAuthorityPath,
    now: () => 1_700_000_000_000,
    distributeRuntime: async ({ stagingRoot }) => {
      matrixDirectory = path.dirname(stagingRoot);
      fs.mkdirSync(stagingRoot);
      distribution = { schemaVersion: 1, artifactKind: LOCAL_ISOLATION_DISTRIBUTION_KIND, files: runtimeBinaryHashes };
      distribution.distributionDigest = digest(distribution);
      const manifestPath = path.join(stagingRoot, 'runtime-distribution.json');
      fs.writeFileSync(manifestPath, JSON.stringify(distribution));
      return matrixWorkers.map((entry) => ({ workerId: entry.workerId, workspaceRoot: root, manifest: distribution, manifestPath }));
    },
    executeWorkerCell: async (request) => {
      const outputRoot = path.join(request.phase === 'smoke' ? path.join(matrixDirectory, 'preflight-smoke') : matrixDirectory, request.worker.workerId);
      fs.mkdirSync(outputRoot, { recursive: true });
      let clock = 0;
      const result = await runLocalIsolationCell({
        ...request, outputRoot, workspaceRoot: root,
        now: () => { clock += request.targetDurationSeconds * 1000; return clock; },
        runIteration: ({ cellDirectory }) => fs.writeFileSync(path.join(cellDirectory, 'probe.json'), '{"passed":true}'),
      });
      const receiptPath = path.join(outputRoot, result.receipt.path);
      originalReceipts.set(receiptPath, fs.readFileSync(receiptPath));
      assert.ok(!result.receipt.path.startsWith('preflight-smoke/'));
      return { ...result,
        runDirectory: request.worker.workerId + '/' + result.runDirectory,
        receipt: { ...result.receipt, path: request.worker.workerId + '/' + result.receipt.path },
        preLaunchRevalidation: createDistributionRevalidationReceipt({ manifest: distribution, expectedRuntimeBinaryHashes: runtimeBinaryHashes }) };
    },
  });
  const options = { workspaceRoot: root, provenance, runtimeAuthorityPath };
  const assignments = [defaultSingleWorkerAssignments, defaultTwoWorkerAssignments,
    fixedThreeWorkerAssignments, fixedFourWorkerAssignments][workerCount - 1](matrixWorkers);
  const boundOptions = { ...options, manifestPath: output.manifestPath, expectedWorkers: matrixWorkers, expectedAssignments: assignments };
  const verifyProduction = ({ expectedWorkers, expectedAssignments, ...verification }) => verifyProductionLocalIsolationManifest({
    ...verification, workers: expectedWorkers, assignments: expectedAssignments,
  });
  assert.doesNotThrow(() => verifyProduction(boundOptions));
  if (workerCount === 3) {
    const fourth = structuredClone(matrixWorkers[0]);
    fourth.workerId = 'vm131';
    fourth.vmIdentity = { provider: 'fixture', uuidBios: 'vm131' };
    fourth.vmIdentityDigest = digest(fourth.vmIdentity);
    const fourAssignments = structuredClone(assignments);
    fourAssignments[2].workerId = fourth.workerId;
    assert.throws(() => verifyProduction({ ...boundOptions,
      expectedWorkers: [...matrixWorkers, fourth], expectedAssignments: fourAssignments,
    }), /current paid assignment/);
  }
  if (workerCount === 4) {
    const rejected = [];
    for (const mutate of [
      (workers) => { workers[3].vmIdentity.uuidBios = 'different-bios'; workers[3].vmIdentityDigest = digest(workers[3].vmIdentity); },
      (workers) => { workers[3].deviceProfileInstances[0].physicalPlaybackDeviceId = 'different-endpoint'; },
    ]) {
      const changed = structuredClone(matrixWorkers);
      mutate(changed);
      try { verifyProduction({ ...boundOptions, expectedWorkers: changed }); rejected.push(false); }
      catch (error) { assert.match(error.message, /current paid assignment/); rejected.push(true); }
    }
    assert.deepEqual(rejected, [true, true], 'both changed BIOS and changed endpoint must reject');
  }
  if (workerCount === 4) {
    assert.deepEqual(output.manifest.cells.map((cell) => [cell.workerId, cell.feedbackLoopPrevention]), [
      ['vm171', 'process-exclusion'], ['vm169', 'virtual-driver'], ['vm131', 'echo-cancel'], ['vm167', 'process-exclusion'],
    ]);
    for (const mutate of [
      (manifest) => { [manifest.cells[0], manifest.cells[3]] = [manifest.cells[3], manifest.cells[0]]; },
      (manifest) => { manifest.cells[2].vmIdentityDigest = manifest.cells[1].vmIdentityDigest; },
      (manifest) => { manifest.preflightSmoke[2].workerId = 'vm167'; },
      (manifest) => { manifest.cells.pop(); },
      (manifest) => { manifest.cells[3].cellId = manifest.cells[0].cellId; },
    ]) {
      const invalid = structuredClone(output.manifest);
      mutate(invalid);
      const invalidPath = path.join(matrixDirectory, 'four-worker-negative.json');
      fs.writeFileSync(invalidPath, JSON.stringify(invalid));
      assert.throws(() => verifyLocalIsolationManifest({ ...options, manifestPath: invalidPath }),
        /four-worker local isolation|must contain 4 cells|is incomplete or used a Provider/);
    }
  }
  assert.equal(verifyLocalIsolationManifest({ ...options, manifestPath: output.manifestPath }).cells.length, workerCount >= 3 ? 4 : 3);
  assert.equal(verifyLocalIsolationManifest({ ...options, manifestPath: output.canonicalPath }).preflightSmoke.length, workerCount >= 3 ? 4 : 3);
  for (const entry of output.manifest.preflightSmoke) {
    assert.ok(entry.runDirectory.startsWith('preflight-smoke/'));
    assert.ok(entry.receipt.path.startsWith('preflight-smoke/'));
  }
  for (const [file, bytes] of originalReceipts) assert.deepEqual(fs.readFileSync(file), bytes);
  const publicationBytes = fs.readFileSync(output.canonicalPath);
  assert.throws(() => publishLocalIsolationManifest({ manifest: output.manifest, matrixDirectory, canonicalPath: output.canonicalPath, ...options }), /source manifest already exists/);
  const failedRoot = path.join(path.dirname(matrixDirectory), 'failed-invocation');
  fs.mkdirSync(failedRoot);
  for (const entry of fs.readdirSync(matrixDirectory)) {
    if (entry !== 'local-isolation-manifest.json') fs.cpSync(path.join(matrixDirectory, entry), path.join(failedRoot, entry), { recursive: true });
  }
  const invalid = structuredClone(output.manifest);
  invalid.preflightSmoke[0].receipt.sha256 = '0'.repeat(64);
  assert.throws(() => publishLocalIsolationManifest({ manifest: invalid, matrixDirectory: failedRoot, canonicalPath: output.canonicalPath, ...options }), /receipt hash mismatch/);
  assert.equal(fs.existsSync(path.join(failedRoot, 'local-isolation-manifest.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(failedRoot, 'local-isolation-failure.json'), 'utf8')).verdict, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(failedRoot, 'local-isolation-candidate.json'), 'utf8')).verdict, 'failed');
  assert.deepEqual(fs.readFileSync(output.canonicalPath), publicationBytes);
  const tampered = JSON.parse(publicationBytes);
  tampered.preflightSmoke[0].runDirectory = 'forged';
  const tamperedPath = path.join(path.dirname(output.canonicalPath), 'tampered.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  assert.throws(() => verifyLocalIsolationManifest({ ...options, manifestPath: tamperedPath }), /does not match its source/);
});

}

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

test('local isolation retries an identity-bound source window below the fixed frame floor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-source-window-retry-'));
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
            detail: 'Bridge source pipe captured only 39360 frame(s)',
            processExclusionFingerprint: {
              bridgeProcessId: 42,
              excludedProcessId: 42,
              sourceCaptureMode: 'process-exclusion',
              captureBackend: 'wasapi-process-exclusion',
              processLoopbackStatus: 'ready',
              physicalExternalComponent: 0.2,
              physicalBridgeChildComponent: 0.2,
              sourceCapturedFrames: 39_360,
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
