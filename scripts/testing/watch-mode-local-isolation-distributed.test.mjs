import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/testing-common.mjs';
import { writeLocalIsolationFailureManifest } from './watch-mode-local-isolation.mjs';

import {
  createDistributedLocalIsolationAssignments,
  createLocalIsolationWorkerRequest,
  createLocalIsolationWorkerResultEnvelope,
  distributeLocalIsolationRuntime,
  executeDistributedLocalIsolationCell,
  revalidateDistributionForWorkerRequest,
  runLocalIsolationProcess,
  runDistributedLocalIsolationCells,
  validateLocalIsolationWorkerRequest,
} from './watch-mode-local-isolation-distributed.mjs';

test('remote directory creation uses encoded Windows PowerShell compatible syntax', () => {
  const source = fs.readFileSync(new URL('./watch-mode-local-isolation-distributed.mjs', import.meta.url), 'utf8');
  assert.match(source, /'-EncodedCommand'/);
  assert.match(source, /New-Item -ItemType Directory -Force -Path/);
  assert.doesNotMatch(source, /New-Item -ItemType Directory -Force -LiteralPath/);
});

test('worker cell creates its nested phase output root before the exclusive cell directory', () => {
  const source = fs.readFileSync(new URL('./watch-mode-local-isolation.mjs', import.meta.url), 'utf8');
  assert.match(source, /fs\.mkdirSync\(request\.outputRoot, \{ recursive: true \}\);\s+const result = await runLocalIsolationCell/);
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
    invocationId: 'test-invocation',
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

test('real distributed CLI bootstraps independently of the source checkout and can be redistributed', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bootstrap-'));
  const local = { ...worker('vm171', 'uuid-171'), transport: { kind: 'local' }, guestExecutionRoot: path.join(root, 'guest') };
  const deploy = (stage) => distributeLocalIsolationRuntime({
    workers: [local], workspaceRoot: repoRoot, runtimeBinaryHashes: [], stagingRoot: path.join(root, stage),
  });
  const [deployment] = await deploy('stage-1');
  const cli = path.join(deployment.workspaceRoot, 'scripts/testing/watch-mode-local-isolation.mjs');
  const result = spawnSync(process.execPath, [cli, '--verify-distribution', deployment.workerManifestPath], {
    cwd: deployment.workspaceRoot, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified, true);
  const [again] = await deploy('stage-2');
  assert.equal(again.workspaceRoot, deployment.workspaceRoot);
  fs.appendFileSync(deployment.workerManifestPath, ' ');
  await assert.rejects(deploy('stage-3'), /existing distribution manifest changed/);
});

test('real worker launches the rehashed distributed executable and creates a missing phase root', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-launch-'));
  const source = path.join(root, 'source');
  const binaryPath = 'target/release/omni-physical-output-probe.exe';
  // Node is deliberately not an audio probe: its bad-option diagnostic proves
  // which executable the real worker launched, without touching audio/Provider.
  const bytes = fs.readFileSync(process.execPath);
  const runtime = [{ path: binaryPath, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  const { collectLocalIsolationDistributionFiles } = await import('./watch-mode-local-isolation-distributed.mjs');
  for (const entry of collectLocalIsolationDistributionFiles({ workspaceRoot: repoRoot, runtimeBinaryHashes: [] })) {
    const destination = path.join(source, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.sourcePath, destination);
  }
  fs.mkdirSync(path.dirname(path.join(source, binaryPath)), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(source, binaryPath));
  const identity = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID'], { encoding: 'utf8', windowsHide: true });
  assert.equal(identity.status, 0, identity.stderr);
  const local = { ...worker('vm171', identity.stdout.trim()), transport: { kind: 'local' }, workspaceRoot: source, guestExecutionRoot: path.join(root, 'guest') };
  const [deployment] = await distributeLocalIsolationRuntime({ workers: [local], workspaceRoot: source, runtimeBinaryHashes: runtime, stagingRoot: path.join(root, 'stage') });
  // A stale checkout must neither satisfy revalidation nor be executed.
  fs.writeFileSync(path.join(source, binaryPath), 'stale-source-binary');
  const assignment = createDistributedLocalIsolationAssignments({ workers: [local] })[0];
  const output = path.join(root, 'not-created', 'smoke');
  await assert.rejects(executeDistributedLocalIsolationCell({
    request: {
      worker: local, phase: 'smoke', cell: assignment.cell, profile: assignment.profile,
      provenance: {}, implementationHashes: [], runtimeBinaryHashes: runtime,
      workerAuthority: { workerId: local.workerId, vmIdentityDigest: local.vmIdentityDigest, deviceProfileInstanceId: assignment.profile.instanceId },
      targetDurationSeconds: 0, artifactKind: 'watch-mode-local-isolation-smoke-cell', distribution: deployment,
    },
    requestRoot: path.join(root, 'requests'), workerWorkspaceRoot: deployment.workspaceRoot, localOutputRoot: output,
  }), /bad option/);
  const stderr = fs.readFileSync(path.join(output, assignment.cell.cellId.replaceAll('::', '--'), 'iterations/0001/process-exclusion.stderr.log'), 'utf8');
  assert.ok(stderr.includes(path.join(deployment.workspaceRoot, binaryPath)), stderr);
  assert.ok(!stderr.includes(path.join(source, binaryPath)), stderr);
});

test('collect-all preserves every worker failure in a persistent failed manifest', async () => {
  const completed = [];
  let failure;
  try {
    await runDistributedLocalIsolationCells({
      workers: workers(), provenance: {}, implementationHashes: hashes, runtimeBinaryHashes: hashes, smokeDurationSeconds: 45,
      executeCell: async (request) => {
        await new Promise((resolve) => setImmediate(resolve));
        completed.push(request.worker.workerId);
        throw new Error(`endpoint diagnostic ${request.worker.workerId}`);
      },
    });
  } catch (error) { failure = error; }
  assert.equal(completed.length, 3);
  assert.ok(failure instanceof AggregateError);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-failure-'));
  const manifestPath = writeLocalIsolationFailureManifest({ matrixDirectory: root, provenance: {}, error: failure });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.verdict, 'failed');
  assert.equal(manifest.error.errors.length, 3);
  for (const id of ['vm171', 'vm167', 'vm169']) {
    assert.ok(manifest.error.errors.some((entry) => entry.message.includes(`worker ${id} smoke`) && entry.cause.message === `endpoint diagnostic ${id}`));
  }
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

test('one/two worker transports isolate every cell and invocation while rejecting a duplicate', async () => {
  for (const kind of ['local', 'ssh']) {
    for (const count of [1, 2]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni transport schedule '));
      const configured = workers().slice(0, count).map((entry) => ({
        ...entry, transport: { kind }, host: entry.workerId, user: 'worker', port: 22,
        guestExecutionRoot: 'E:\\li-test',
        identityFile: 'test-key', knownHostsFile: 'test-hosts', hostKeyAlias: entry.workerId,
      }));
      const remoteFiles = new Map();
      const transfers = [];
      const outputCells = new Set();
      const invocations = new Set();
      const requests = [];
      const finish = (immutable) => {
        validateLocalIsolationWorkerRequest(immutable);
        const outputCell = `${immutable.outputRoot}/${immutable.worker.workerId}/${immutable.cell.cellId}`;
        assert.equal(outputCells.has(outputCell), false, `output collision: ${outputCell}`);
        outputCells.add(outputCell);
        invocations.add(immutable.invocationId);
        requests.push(immutable);
        const result = resultFor(immutable);
        if (kind === 'ssh') {
          const receipt = JSON.stringify({ artifacts: [{ path: 'iterations/0001/runtime/process-exclusion-physical-output.wav' }] });
          result.receipt = { path: 'cell-authority.json', bytes: Buffer.byteLength(receipt), sha256: crypto.createHash('sha256').update(receipt).digest('hex') };
          remoteFiles.set(`worker@${immutable.worker.workerId}:${path.win32.join(immutable.outputRoot, immutable.cell.cellId.replaceAll('::', '--'), 'cell-authority.json').replaceAll('\\', '/')}`, receipt);
        }
        return JSON.stringify(createLocalIsolationWorkerResultEnvelope(immutable, result));
      };
      const run = async (command, args, options = {}) => {
        if (kind === 'local') {
          const immutable = JSON.parse(fs.readFileSync(args[2], 'utf8'));
          fs.writeFileSync(args[4], finish(immutable), { flag: 'wx' });
        } else if (command === 'scp.exe') {
          assert.equal(options.timeoutMs ?? 120_000, 120_000);
          assert.ok(args.includes('-O'));
          assert.ok(args.includes('StrictHostKeyChecking=yes'));
          assert.ok(!args.includes('-T'));
          const [from, to] = args.slice(-2);
          const localOperand = from.startsWith('worker@') ? to : from;
          if (localOperand.includes('\\')) throw new Error(`scp: error: unexpected filename: ${localOperand}`);
          assert.ok(localOperand.includes(' '), 'space stays within one argv operand');
          assert.ok(!localOperand.includes('"'), 'spawn arguments need no shell quotes');
          transfers.push([from, to]);
          if (args.includes('-r')) {
            const receipt = `${from}/cell-authority.json`;
            assert.ok(remoteFiles.has(receipt), 'recursive download requires remote receipt');
            assert.ok(transfers.slice(0, -1).some(([source]) => source === receipt), 'receipt downloaded before directory');
            const destination = path.join(to, path.posix.basename(from));
            fs.mkdirSync(destination, { recursive: true });
            fs.writeFileSync(path.join(destination, 'cell-authority.json'), remoteFiles.get(receipt), { flag: 'wx' });
            return { exitCode: 0 };
          }
          if (remoteFiles.has(from)) {
            fs.writeFileSync(to, remoteFiles.get(from), { flag: 'wx' });
          } else {
            assert.equal(remoteFiles.has(to), false, `request collision: ${to}`);
            remoteFiles.set(to, fs.readFileSync(from, 'utf8'));
          }
        } else {
          const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
          const requestPath = script.match(/'--worker-cell-request' '([^']+)'/u)?.[1];
          if (requestPath) {
            assert.ok(options.timeoutMs >= 180_000);
            const resultPath = script.match(/'--worker-cell-result' '([^']+)'/u)[1];
            const host = args.find((arg) => arg.startsWith('worker@'));
            const spec = (value) => `${host}:${value.replaceAll('\\', '/')}`;
            const immutable = JSON.parse(remoteFiles.get(spec(requestPath)));
            assert.ok(requestPath.includes(immutable.invocationId));
            assert.ok(immutable.outputRoot.includes(immutable.invocationId));
            assert.match(immutable.invocationId, /^[a-f0-9]{24}$/u);
            assert.ok(immutable.outputRoot.startsWith('E:\\li-test\\li\\'));
            const deepest = path.win32.join(immutable.outputRoot, immutable.cell.cellId.replaceAll('::', '--'), 'iterations/0001/runtime/process-exclusion-physical-output.wav');
            assert.ok(deepest.length <= 240, deepest);
            remoteFiles.set(spec(resultPath), finish(immutable));
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      if (kind === 'ssh') {
        const source = path.join(root, 'source space');
        const entry = path.join(source, 'scripts/testing/watch-mode-local-isolation.mjs');
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(entry, '// transport fixture');
        fs.writeFileSync(path.join(source, 'runtime.exe'), 'runtime');
        const runtime = [{ path: 'runtime.exe', bytes: 7, sha256: crypto.createHash('sha256').update('runtime').digest('hex') }];
        const distributions = await distributeLocalIsolationRuntime({ workers: configured, workspaceRoot: source,
          runtimeBinaryHashes: runtime, stagingRoot: path.join(root, 'stage space'), run });
        for (const distribution of distributions) {
          const prefix = `worker@${distribution.workerId}:`;
          const copies = transfers.filter(([, to]) => to.startsWith(prefix));
          assert.deepEqual(copies.map(([from]) => path.basename(from)), ['runtime.exe', 'watch-mode-local-isolation.mjs', 'runtime-distribution.json']);
          const manifest = JSON.parse(remoteFiles.get(`${prefix}${distribution.workerManifestPath.replaceAll('\\', '/')}`));
          assert.equal(manifest.distributionDigest, distribution.manifest.distributionDigest);
        }
      }
      for (const invocation of ['first', 'second']) {
        let firstRequest;
        const transport = (request) => {
          firstRequest ??= request;
          return executeDistributedLocalIsolationCell({
            request: { ...request, distribution: { workerManifestPath: path.join(root, 'runtime-distribution.json'), manifest: { distributionDigest: 'd'.repeat(64) } } },
            requestRoot: path.join(root, invocation, 'worker-requests'),
            workerWorkspaceRoot: path.join(root, 'distributed'),
            localOutputRoot: path.join(root, invocation, request.phase),
            run,
          });
        };
        const results = await runDistributedLocalIsolationCells({
          workers: configured, provenance: {}, implementationHashes: hashes,
          runtimeBinaryHashes: hashes, smokeDurationSeconds: 45, executeCell: transport,
        });
        assert.equal(results.cells.length, 3);
        await assert.rejects(transport(firstRequest), /EEXIST/);
      }
      assert.equal(requests.length, 12);
      assert.equal(invocations.size, 2);
      assert.throws(() => validateLocalIsolationWorkerRequest({ ...requests[0], invocationId: 'tampered' }), /digest mismatch/);
    }
  }
});

test('remote output keeps deep artifacts outside the long runtime root and rejects oversized roots before transport', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-short-output-'));
  const assignment = createDistributedLocalIsolationAssignments({ workers: workers() })[0];
  const runtimeRoot = `E:\\omni-shards-run3\\local-isolation-${'a'.repeat(64)}`;
  const request = {
    worker: { ...assignment.worker, transport: { kind: 'ssh' }, guestExecutionRoot: 'E:\\omni-shards-run3' },
    phase: 'formal', cell: assignment.cell, profile: assignment.profile,
    runtimeBinaryHashes: hashes, targetDurationSeconds: 500,
    workerAuthority: { workerId: assignment.worker.workerId, vmIdentityDigest: assignment.worker.vmIdentityDigest, deviceProfileInstanceId: assignment.profile.instanceId },
    distribution: { workerManifestPath: path.win32.join(runtimeRoot, 'runtime-distribution.json'), manifest: { distributionDigest: 'd'.repeat(64) } },
  };
  const requestRoot = path.join(root, 'invocation', 'worker-requests');
  const stop = new Error('transport inspection complete');
  await assert.rejects(executeDistributedLocalIsolationCell({
    request, requestRoot, workerWorkspaceRoot: runtimeRoot, localOutputRoot: path.join(root, 'output'),
    run: async () => { throw stop; },
  }), (error) => error === stop);
  const immutable = JSON.parse(fs.readFileSync(path.join(requestRoot, fs.readdirSync(requestRoot)[0]), 'utf8'));
  const deepSuffix = path.win32.join(assignment.cell.cellId.replaceAll('::', '--'), 'iterations/0001/runtime/process-exclusion-physical-output.wav');
  const oldRoot = path.win32.join(runtimeRoot, 'artifacts/local-isolation', 'x'.repeat(41), 'formal');
  assert.ok(path.win32.join(oldRoot, deepSuffix).length > 260);
  assert.ok(path.win32.join(immutable.outputRoot, deepSuffix).length < 240);
  assert.equal(immutable.distributionAuthority.manifestPath, request.distribution.workerManifestPath);
  assert.equal(immutable.targetDurationSeconds, 500);
  let calls = 0;
  await assert.rejects(executeDistributedLocalIsolationCell({
    request: { ...request, worker: { ...request.worker, guestExecutionRoot: `E:\\${'long-root'.repeat(20)}` } },
    requestRoot: path.join(root, 'too-long', 'worker-requests'), workerWorkspaceRoot: runtimeRoot, localOutputRoot: path.join(root, 'output'),
    run: async () => { calls += 1; },
  }), /legacy SCP path budget exceeded/);
  assert.equal(calls, 0);
});

test('real hung process timeout terminates its owned Windows child tree and preserves diagnostics', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-process-timeout-'));
  const pidsPath = path.join(root, 'pids.json');
  const script = `const fs = require('node:fs'); const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' }); fs.writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid])); console.error('hung-worker-diagnostic'); setInterval(() => {}, 1000);`;
  const started = Date.now();
  await assert.rejects(runLocalIsolationProcess(process.execPath, ['-e', script, pidsPath], { timeoutMs: 3000 }), /timed out after 3000ms.*hung-worker-diagnostic/su);
  assert.ok(Date.now() - started < 15_000);
  const pids = JSON.parse(fs.readFileSync(pidsPath, 'utf8'));
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('directory SCP waits for envelope/receipt integrity and actual source/destination path budgets', async () => {
  for (const scenario of ['envelope', 'receipt', 'destination-path', 'source-path']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-scp-inventory-'));
    const assignment = createDistributedLocalIsolationAssignments({ workers: workers() })[0];
    const request = {
      worker: { ...assignment.worker, transport: { kind: 'ssh' }, guestExecutionRoot: 'E:\\li' },
      phase: 'formal', cell: assignment.cell, profile: assignment.profile, runtimeBinaryHashes: hashes,
      targetDurationSeconds: 500, distribution: { workerManifestPath: 'E:\\runtime\\runtime-distribution.json', manifest: { distributionDigest: 'd'.repeat(64) } },
    };
    let checked;
    let directoryCopies = 0;
    let workerTimeout;
    const artifact = scenario === 'source-path' ? `${'deep/'.repeat(40)}leaf.wav` : 'iterations/0001/runtime/probe.wav';
    const receipt = JSON.stringify({ artifacts: [{ path: artifact }] });
    await assert.rejects(executeDistributedLocalIsolationCell({
      request, requestRoot: path.join(root, 'invocation', 'requests'), workerWorkspaceRoot: 'E:\\runtime',
      localOutputRoot: scenario === 'destination-path' ? path.join(root, 'long-output'.repeat(11)) : path.join(root, 'out'),
      run: async (command, args, options = {}) => {
        if (command === 'scp.exe') {
          if (args.includes('-r')) { directoryCopies += 1; return; }
          const [from, to] = args.slice(-2);
          if (from.endsWith('-request.json')) checked = JSON.parse(fs.readFileSync(from, 'utf8'));
          else if (from.endsWith('-result.json')) {
            const envelope = createLocalIsolationWorkerResultEnvelope(checked, {
              receipt: { bytes: Buffer.byteLength(receipt), sha256: crypto.createHash('sha256').update(receipt).digest('hex') },
            });
            if (scenario === 'envelope') envelope.resultDigest = 'f'.repeat(64);
            fs.writeFileSync(to, JSON.stringify(envelope));
          } else fs.writeFileSync(to, scenario === 'receipt' ? `${receipt} ` : receipt);
        } else if (Buffer.from(args.at(-1), 'base64').toString('utf16le').includes('--worker-cell-request')) {
          workerTimeout = options.timeoutMs;
        }
      },
    }), /tampered|legacy SCP path budget exceeded/);
    assert.equal(workerTimeout, 680_000, '500-second formal run must not receive the 120-second SCP deadline');
    assert.equal(directoryCopies, 0, scenario);
  }
});
