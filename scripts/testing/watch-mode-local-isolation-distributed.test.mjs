import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDistributedLocalIsolationAssignments,
  createLocalIsolationWorkerRequest,
  createLocalIsolationWorkerResultEnvelope,
  distributeLocalIsolationRuntime,
  executeDistributedLocalIsolationCell,
  revalidateDistributionForWorkerRequest,
  runDistributedLocalIsolationCells,
  validateLocalIsolationWorkerRequest,
} from './watch-mode-local-isolation-distributed.mjs';

test('remote directory creation uses encoded Windows PowerShell compatible syntax', () => {
  const source = fs.readFileSync(new URL('./watch-mode-local-isolation-distributed.mjs', import.meta.url), 'utf8');
  assert.match(source, /'-EncodedCommand'/);
  assert.match(source, /New-Item -ItemType Directory -Force -Path/);
  assert.doesNotMatch(source, /New-Item -ItemType Directory -Force -LiteralPath/);
});

const hashes = [{ path: 'target/release/omni-bridge-service.exe', bytes: 10, sha256: 'a'.repeat(64) }];
const canonicalize = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  : Array.isArray(value) ? value.map(canonicalize) : value;
const vmDigest = (value) => crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');

const worker = (workerId, uuid, endpoint = `${workerId}-endpoint`) => {
  const vmIdentity = { provider: 'vmware', uuidBios: uuid };
  return {
    workerId,
    vmIdentity,
    vmIdentityDigest: vmDigest(vmIdentity),
    workspaceRoot: `C:\\omni-${workerId}`,
    deviceProfileInstances: [{
      instanceId: `${workerId}-default`,
      profileId: `${workerId}-hda`,
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: endpoint,
      expectedPhysicalPlaybackDeviceName: `${workerId} HDA`,
    }],
  };
};

const workers = () => [
  worker('vm171', 'uuid-171'),
  worker('vm167', 'uuid-167'),
  worker('vm169', 'uuid-169'),
];

const resultFor = (request, overrides = {}) => {
  const revalidationCore = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-local-isolation-pre-launch-revalidation',
    distributionDigest: 'd'.repeat(64),
    files: [],
    runtimeBinaryHashes: hashes,
  };
  return ({
  cellId: request.cell.cellId,
  feedbackLoopPrevention: request.cell.feedbackLoopPrevention,
  workerId: request.workerAuthority.workerId,
  vmIdentityDigest: request.workerAuthority.vmIdentityDigest,
  deviceProfileInstanceId: request.workerAuthority.deviceProfileInstanceId,
  deviceProfileId: request.profile.profileId,
  requestedDeviceId: request.profile.physicalPlaybackDeviceId,
  expectedDeviceName: request.profile.expectedPhysicalPlaybackDeviceName,
  providerCalls: 0,
  verdict: 'passed',
  runtimeBinaryHashes: hashes,
  receipt: { path: `${request.cell.cellId}/cell-authority.json`, bytes: 10, sha256: 'b'.repeat(64) },
  preLaunchRevalidation: { ...revalidationCore, receiptDigest: vmDigest(revalidationCore) },
  ...overrides,
  });
};

test('distributed local isolation supports deterministic one/two/three worker placement', () => {
  const assignments = createDistributedLocalIsolationAssignments({ workers: workers() });
  assert.deepEqual(
    Object.fromEntries(assignments.map(({ worker: entry, cell }) => [entry.workerId, cell.feedbackLoopPrevention])),
    { vm171: 'process-exclusion', vm167: 'echo-cancel', vm169: 'virtual-driver' },
  );
  const duplicateVm = workers();
  duplicateVm[2].vmIdentity = duplicateVm[1].vmIdentity;
  duplicateVm[2].vmIdentityDigest = duplicateVm[1].vmIdentityDigest;
  assert.throws(
    () => createDistributedLocalIsolationAssignments({ workers: duplicateVm }),
    /duplicate VM/,
  );
  const single = createDistributedLocalIsolationAssignments({ workers: [worker('solo', 'uuid-solo')] });
  assert.deepEqual(single.map((entry) => entry.worker.workerId), ['solo', 'solo', 'solo']);
  const dual = createDistributedLocalIsolationAssignments({
    workers: [worker('first', 'uuid-first'), worker('second', 'uuid-second')],
  });
  assert.deepEqual(dual.map((entry) => entry.worker.workerId), ['first', 'second', 'first']);
  assert.throws(() => createDistributedLocalIsolationAssignments({ workers: [] }), /one to three/);
});

test('three workers run concurrently while smoke precedes formal on every worker', async () => {
  const calls = [];
  const waiting = [];
  let releaseSmokes;
  const allSmokesStarted = new Promise((resolve) => { releaseSmokes = resolve; });
  const output = await runDistributedLocalIsolationCells({
    workers: workers(),
    provenance: {},
    implementationHashes: hashes,
    runtimeBinaryHashes: hashes,
    smokeDurationSeconds: 45,
    executeCell: async (request) => {
      calls.push(`${request.worker.workerId}:${request.phase}`);
      if (request.phase === 'smoke') {
        waiting.push(request.worker.workerId);
        if (waiting.length === 3) releaseSmokes();
        await allSmokesStarted;
      }
      return resultFor(request);
    },
  });
  assert.equal(waiting.length, 3);
  for (const id of ['vm171', 'vm167', 'vm169']) {
    assert.ok(calls.indexOf(`${id}:smoke`) < calls.indexOf(`${id}:formal`));
  }
  assert.deepEqual(output.cells.map((cell) => cell.feedbackLoopPrevention), [
    'process-exclusion', 'virtual-driver', 'echo-cancel',
  ]);
  assert.equal(new Set(output.cells.map((cell) => cell.vmIdentityDigest)).size, 3);
});

test('distributed local isolation fails closed on Provider use, endpoint tamper, or runtime tamper', async () => {
  for (const overrides of [
    { providerCalls: 1 },
    { requestedDeviceId: 'wrong-endpoint' },
    { runtimeBinaryHashes: [{ ...hashes[0], sha256: 'c'.repeat(64) }] },
  ]) {
    await assert.rejects(
      runDistributedLocalIsolationCells({
        workers: workers(), provenance: {}, implementationHashes: hashes,
        runtimeBinaryHashes: hashes, smokeDurationSeconds: 45,
        executeCell: async (request) => resultFor(request, overrides),
      }),
      /distributed local isolation failed/,
    );
  }
});

test('worker requests and result envelopes are immutable', () => {
  const assignment = createDistributedLocalIsolationAssignments({ workers: workers() })[0];
  const request = createLocalIsolationWorkerRequest({
    worker: assignment.worker, phase: 'formal', cell: assignment.cell, profile: assignment.profile,
    provenance: {}, implementationHashes: hashes, runtimeBinaryHashes: hashes,
    workerAuthority: {
      workerId: assignment.worker.workerId,
      vmIdentityDigest: assignment.worker.vmIdentityDigest,
      deviceProfileInstanceId: assignment.profile.instanceId,
    },
    targetDurationSeconds: 300, artifactKind: 'watch-mode-local-isolation-cell', outputRoot: 'C:\\out',
    distributionAuthority: { manifestPath: 'C:\\runtime-distribution.json', distributionDigest: 'd'.repeat(64) },
  });
  assert.equal(validateLocalIsolationWorkerRequest(request), request);
  assert.throws(() => validateLocalIsolationWorkerRequest({ ...request, targetDurationSeconds: 1 }), /digest mismatch/);
  const envelope = createLocalIsolationWorkerResultEnvelope(request, { passed: true });
  assert.equal(envelope.requestDigest, request.requestDigest);
  assert.match(envelope.resultDigest, /^[a-f0-9]{64}$/u);
});

test('local distribution copies and verifies the script closure and signed runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-distribution-'));
  const source = path.join(root, 'source');
  const guest = path.join(root, 'guest');
  fs.mkdirSync(path.join(source, 'scripts', 'testing'), { recursive: true });
  fs.mkdirSync(path.join(source, 'target', 'release'), { recursive: true });
  fs.writeFileSync(path.join(source, 'scripts', 'testing', 'watch-mode-local-isolation.mjs'), "import './dependency.mjs';\n", 'utf8');
  fs.writeFileSync(path.join(source, 'scripts', 'testing', 'dependency.mjs'), 'export const ok = true;\n', 'utf8');
  const binary = path.join(source, 'target', 'release', 'bridge.exe');
  fs.writeFileSync(binary, 'runtime', 'utf8');
  const binaryBytes = fs.readFileSync(binary);
  const runtime = [{
    path: 'target/release/bridge.exe', bytes: binaryBytes.length,
    sha256: crypto.createHash('sha256').update(binaryBytes).digest('hex'),
  }];
  const local = worker('vm171', 'uuid-171');
  local.transport = { kind: 'local' };
  local.guestExecutionRoot = guest;
  const [deployment] = await distributeLocalIsolationRuntime({
    workers: [local], workspaceRoot: source, runtimeBinaryHashes: runtime,
    stagingRoot: path.join(root, 'stage'),
  });
  assert.equal(fs.existsSync(path.join(deployment.workspaceRoot, 'scripts', 'testing', 'dependency.mjs')), true);
  assert.equal(fs.existsSync(path.join(deployment.workspaceRoot, 'target', 'release', 'bridge.exe')), true);
  const request = {
    runtimeBinaryHashes: runtime,
    distributionAuthority: {
      manifestPath: deployment.workerManifestPath,
      distributionDigest: deployment.manifest.distributionDigest,
    },
  };
  assert.equal(
    revalidateDistributionForWorkerRequest({ request, workspaceRoot: deployment.workspaceRoot }).distributionDigest,
    deployment.manifest.distributionDigest,
  );
  fs.writeFileSync(path.join(deployment.workspaceRoot, 'scripts', 'testing', 'dependency.mjs'), 'tampered\n', 'utf8');
  assert.throws(
    () => revalidateDistributionForWorkerRequest({ request, workspaceRoot: deployment.workspaceRoot }),
    /distributed file changed/,
  );
});

test('one and two worker schedules never overlap cells on the same worker', async () => {
  for (const configured of [
    [worker('solo', 'uuid-solo')],
    [worker('first', 'uuid-first'), worker('second', 'uuid-second')],
  ]) {
    const active = new Set();
    await runDistributedLocalIsolationCells({
      workers: configured, provenance: {}, implementationHashes: hashes,
      runtimeBinaryHashes: hashes, smokeDurationSeconds: 45,
      executeCell: async (request) => {
        assert.equal(active.has(request.worker.workerId), false, `overlap on ${request.worker.workerId}`);
        active.add(request.worker.workerId);
        await new Promise((resolve) => setImmediate(resolve));
        active.delete(request.worker.workerId);
        return resultFor(request);
      },
    });
  }
});

test('local cell transport binds request digest to returned result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-transport-'));
  const assignment = createDistributedLocalIsolationAssignments({ workers: workers() })[0];
  assignment.worker.transport = { kind: 'local' };
  const request = {
    worker: assignment.worker, phase: 'formal', cell: assignment.cell, profile: assignment.profile,
    provenance: {}, implementationHashes: hashes, runtimeBinaryHashes: hashes,
    workerAuthority: {
      workerId: assignment.worker.workerId, vmIdentityDigest: assignment.worker.vmIdentityDigest,
      deviceProfileInstanceId: assignment.profile.instanceId,
    }, targetDurationSeconds: 300, artifactKind: 'watch-mode-local-isolation-cell',
    distribution: {
      workerManifestPath: path.join(root, 'runtime-distribution.json'),
      manifest: { distributionDigest: 'd'.repeat(64) },
    },
  };
  const returned = await executeDistributedLocalIsolationCell({
    request, requestRoot: path.join(root, 'requests'), workerWorkspaceRoot: root,
    localOutputRoot: path.join(root, 'output'),
    run: async (_command, args) => {
      const requestPath = args[args.indexOf('--worker-cell-request') + 1];
      const resultPath = args[args.indexOf('--worker-cell-result') + 1];
      const immutable = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
      fs.writeFileSync(resultPath, `${JSON.stringify(createLocalIsolationWorkerResultEnvelope(immutable, { ok: true }))}\n`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(returned, { ok: true });
});
