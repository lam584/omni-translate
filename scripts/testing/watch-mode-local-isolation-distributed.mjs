import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { sameAuthorityInventory } from './watch-mode-evidence-authority.mjs';
import { LOCAL_ISOLATION_CELLS } from './watch-mode-balanced-release-plan.mjs';

export const DISTRIBUTED_LOCAL_ISOLATION_WORKER_MODES = Object.freeze({
  vm171: 'process-exclusion',
  vm167: 'echo-cancel',
  vm169: 'virtual-driver',
});

const SHA256 = /^[a-f0-9]{64}$/u;
export const LOCAL_ISOLATION_WORKER_REQUEST_KIND = 'watch-mode-local-isolation-worker-cell-request';
export const LOCAL_ISOLATION_DISTRIBUTION_KIND = 'watch-mode-local-isolation-runtime-distribution';

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const digest = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex');

const portable = (value) => value.split(path.sep).join('/');
const fileHash = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const runProcess = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (exitCode) => {
    if (exitCode !== 0) reject(new Error(`${command} failed (${exitCode}): ${stderr || stdout}`));
    else resolve({ exitCode, stdout, stderr });
  });
});

export function createLocalIsolationWorkerRequest(request) {
  const core = {
    schemaVersion: 1,
    artifactKind: LOCAL_ISOLATION_WORKER_REQUEST_KIND,
    worker: {
      workerId: request.worker.workerId,
      vmIdentity: request.worker.vmIdentity,
      vmIdentityDigest: request.worker.vmIdentityDigest,
    },
    phase: request.phase,
    cell: request.cell,
    profile: request.profile,
    provenance: request.provenance,
    implementationHashes: request.implementationHashes,
    runtimeBinaryHashes: request.runtimeBinaryHashes,
    workerAuthority: request.workerAuthority,
    targetDurationSeconds: request.targetDurationSeconds,
    cellArtifactKind: request.artifactKind,
    outputRoot: request.outputRoot,
    distributionAuthority: request.distributionAuthority,
  };
  return { ...core, requestDigest: digest(core) };
}

export function validateLocalIsolationWorkerRequest(request) {
  const core = { ...request };
  delete core.requestDigest;
  if (request?.schemaVersion !== 1 || request?.artifactKind !== LOCAL_ISOLATION_WORKER_REQUEST_KIND
      || request.requestDigest !== digest(core)) {
    throw new Error('local isolation worker request digest mismatch');
  }
  const vmIdentityDigest = digest(request.worker?.vmIdentity);
  if (request.worker?.vmIdentityDigest !== vmIdentityDigest
      || request.workerAuthority?.vmIdentityDigest !== vmIdentityDigest
      || request.workerAuthority?.workerId !== request.worker?.workerId
      || request.workerAuthority?.deviceProfileInstanceId !== request.profile?.instanceId
      || request.cell?.providerMode !== 'disabled'
      || !request.distributionAuthority?.manifestPath
      || !SHA256.test(String(request.distributionAuthority?.distributionDigest ?? ''))) {
    throw new Error('local isolation worker request identity is invalid');
  }
  return request;
}

export function createLocalIsolationWorkerResultEnvelope(request, result) {
  return { requestDigest: request.requestDigest, result, resultDigest: digest(result) };
}

export function createDistributionRevalidationReceipt({ manifest, expectedRuntimeBinaryHashes }) {
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const runtimeBinaryHashes = expectedRuntimeBinaryHashes.map((expected) => {
    const observed = byPath.get(expected.path);
    if (!observed || observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) {
      throw new Error(`local isolation pre-launch runtime authority mismatch: ${expected.path}`);
    }
    return observed;
  });
  const core = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-local-isolation-pre-launch-revalidation',
    distributionDigest: manifest.distributionDigest,
    files: manifest.files,
    runtimeBinaryHashes,
  };
  return { ...core, receiptDigest: digest(core) };
}

export function validateDistributionRevalidationReceipt(receipt, {
  runtimeBinaryHashes,
  distributionDigest,
}) {
  const core = { ...receipt };
  delete core.receiptDigest;
  if (receipt?.schemaVersion !== 1
      || receipt?.artifactKind !== 'watch-mode-local-isolation-pre-launch-revalidation'
      || receipt?.distributionDigest !== distributionDigest
      || receipt?.receiptDigest !== digest(core)
      || !sameAuthorityInventory(receipt?.runtimeBinaryHashes, runtimeBinaryHashes)) {
    throw new Error('local isolation pre-launch revalidation receipt mismatch');
  }
  return receipt;
}

export function revalidateDistributionForWorkerRequest({ request, workspaceRoot }) {
  const manifest = JSON.parse(fs.readFileSync(
    path.resolve(request.distributionAuthority.manifestPath), 'utf8',
  ).replace(/^\uFEFF/u, ''));
  if (manifest.distributionDigest !== request.distributionAuthority.distributionDigest) {
    throw new Error('local isolation worker distribution authority does not match the immutable request');
  }
  verifyDistributedRuntimeDistribution({ workspaceRoot, manifest });
  return createDistributionRevalidationReceipt({
    manifest,
    expectedRuntimeBinaryHashes: request.runtimeBinaryHashes,
  });
}

export function verifyDistributedRuntimeDistribution({ workspaceRoot, manifest }) {
  if (manifest?.schemaVersion !== 1 || manifest?.artifactKind !== LOCAL_ISOLATION_DISTRIBUTION_KIND) {
    throw new Error('local isolation runtime distribution manifest is invalid');
  }
  const core = { ...manifest };
  delete core.distributionDigest;
  if (manifest.distributionDigest !== digest(core)) {
    throw new Error('local isolation runtime distribution digest mismatch');
  }
  for (const entry of manifest.files ?? []) {
    const candidate = path.resolve(workspaceRoot, ...String(entry.path).split('/'));
    const bytes = fs.readFileSync(candidate);
    if (bytes.length !== entry.bytes || fileHash(candidate) !== entry.sha256) {
      throw new Error(`local isolation distributed file changed: ${entry.path}`);
    }
  }
  return manifest;
}

const importedModules = (source) => [
  ...source.matchAll(/(?:\bfrom\s+|\bimport\s*)['"](\.\.?\/[^'"]+)['"]/gu),
].map((match) => match[1]);

export function collectLocalIsolationDistributionFiles({ workspaceRoot, runtimeBinaryHashes }) {
  const entry = path.resolve(workspaceRoot, 'scripts/testing/watch-mode-local-isolation.mjs');
  const scripts = new Set();
  const visit = (filePath) => {
    const resolved = path.resolve(filePath);
    if (scripts.has(resolved)) return;
    scripts.add(resolved);
    const source = fs.readFileSync(resolved, 'utf8');
    for (const specifier of importedModules(source)) {
      const dependency = path.resolve(path.dirname(resolved), specifier);
      if (dependency.endsWith('.mjs')) visit(dependency);
    }
  };
  visit(entry);
  const files = new Map();
  for (const script of scripts) {
    const bytes = fs.readFileSync(script);
    files.set(portable(path.relative(workspaceRoot, script)), {
      path: portable(path.relative(workspaceRoot, script)), bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sourcePath: script,
    });
  }
  for (const authority of runtimeBinaryHashes) {
    const sourcePath = path.resolve(workspaceRoot, ...authority.path.split('/'));
    const bytes = fs.readFileSync(sourcePath);
    if (bytes.length !== authority.bytes || fileHash(sourcePath) !== authority.sha256) {
      throw new Error(`local isolation source runtime changed: ${authority.path}`);
    }
    files.set(authority.path, { ...authority, sourcePath });
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

const sshArgs = (worker) => [
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${worker.knownHostsFile}`, '-o', `HostKeyAlias=${worker.hostKeyAlias}`,
  '-i', worker.identityFile, '-p', String(worker.port),
];
const scpArgs = (worker) => [
  '-q', '-O', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${worker.knownHostsFile}`,
  '-o', `HostKeyAlias=${worker.hostKeyAlias}`, '-i', worker.identityFile, '-P', String(worker.port),
];
const remoteSpec = (worker, filePath) => `${worker.user}@${worker.host}:${filePath.replaceAll('\\', '/')}`;
const remotePowerShellArgs = (script) => [
  'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64'),
];

export async function distributeLocalIsolationRuntime({
  workers,
  workspaceRoot,
  runtimeBinaryHashes,
  stagingRoot,
  sshExecutable = 'ssh.exe',
  scpExecutable = 'scp.exe',
  run = runProcess,
}) {
  const files = collectLocalIsolationDistributionFiles({ workspaceRoot, runtimeBinaryHashes });
  const manifestCore = {
    schemaVersion: 1,
    artifactKind: LOCAL_ISOLATION_DISTRIBUTION_KIND,
    files: files.map(({ sourcePath: _sourcePath, ...entry }) => entry),
  };
  const manifest = { ...manifestCore, distributionDigest: digest(manifestCore) };
  fs.mkdirSync(stagingRoot, { recursive: true });
  const manifestPath = path.join(stagingRoot, 'runtime-distribution.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return Promise.all(workers.map(async (worker) => {
    const destinationRoot = path.join(worker.guestExecutionRoot, `local-isolation-${manifest.distributionDigest}`);
    if (worker.transport.kind === 'local') {
      for (const entry of files) {
        const destination = path.join(destinationRoot, ...entry.path.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (!fs.existsSync(destination)) fs.copyFileSync(entry.sourcePath, destination, fs.constants.COPYFILE_EXCL);
      }
      verifyDistributedRuntimeDistribution({ workspaceRoot: destinationRoot, manifest });
    } else {
      const directories = [...new Set(files.map((entry) => (
        path.win32.dirname(path.win32.join(destinationRoot, ...entry.path.split('/')))
      )))];
      const mkdirScript = directories.map((directory) => (
        `New-Item -ItemType Directory -Force -LiteralPath '${directory}' | Out-Null`
      )).join(';');
      await run(sshExecutable, [...sshArgs(worker), `${worker.user}@${worker.host}`, ...remotePowerShellArgs(mkdirScript)]);
      for (const entry of files) {
        const destination = path.win32.join(destinationRoot, ...entry.path.split('/'));
        await run(scpExecutable, [...scpArgs(worker), entry.sourcePath, remoteSpec(worker, destination)]);
      }
      const remoteManifest = path.win32.join(destinationRoot, 'runtime-distribution.json');
      await run(scpExecutable, [...scpArgs(worker), manifestPath, remoteSpec(worker, remoteManifest)]);
      await run(sshExecutable, [...sshArgs(worker), `${worker.user}@${worker.host}`, 'node.exe',
        path.win32.join(destinationRoot, 'scripts/testing/watch-mode-local-isolation.mjs'),
        '--verify-distribution', remoteManifest]);
    }
    const workerManifestPath = path.join(destinationRoot, 'runtime-distribution.json');
    if (worker.transport.kind === 'local') {
      fs.copyFileSync(manifestPath, workerManifestPath, fs.constants.COPYFILE_EXCL);
    }
    return {
      workerId: worker.workerId, workspaceRoot: destinationRoot, manifest, manifestPath,
      workerManifestPath,
    };
  }));
}

export async function executeDistributedLocalIsolationCell({
  request,
  requestRoot,
  workerWorkspaceRoot,
  localOutputRoot,
  sshExecutable = 'ssh.exe',
  scpExecutable = 'scp.exe',
  run = runProcess,
}) {
  const remoteOutputRoot = path.win32.join(workerWorkspaceRoot, 'artifacts', 'local-isolation', request.phase);
  const checked = createLocalIsolationWorkerRequest({
    ...request,
    outputRoot: request.worker.transport.kind === 'local' ? localOutputRoot : remoteOutputRoot,
    distributionAuthority: {
      manifestPath: request.distribution.workerManifestPath,
      distributionDigest: request.distribution.manifest.distributionDigest,
    },
  });
  const workerId = checked.worker.workerId;
  const worker = request.worker;
  fs.mkdirSync(requestRoot, { recursive: true });
  const localRequestPath = path.join(requestRoot, `${workerId}-${request.phase}-request.json`);
  const localResultPath = path.join(requestRoot, `${workerId}-${request.phase}-result.json`);
  fs.writeFileSync(localRequestPath, `${JSON.stringify(checked, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const script = path.win32.join(workerWorkspaceRoot, 'scripts/testing/watch-mode-local-isolation.mjs');
  if (worker.transport.kind === 'local') {
    await run(process.execPath, [script, '--worker-cell-request', localRequestPath, '--worker-cell-result', localResultPath], { cwd: workerWorkspaceRoot });
  } else {
    const remoteRequest = path.win32.join(workerWorkspaceRoot, 'worker-requests', path.basename(localRequestPath));
    const remoteResult = path.win32.join(workerWorkspaceRoot, 'worker-requests', path.basename(localResultPath));
    await run(sshExecutable, [...sshArgs(worker), `${worker.user}@${worker.host}`, ...remotePowerShellArgs(
      `New-Item -ItemType Directory -Force -LiteralPath '${path.win32.dirname(remoteRequest)}' | Out-Null`,
    )]);
    await run(scpExecutable, [...scpArgs(worker), localRequestPath, remoteSpec(worker, remoteRequest)]);
    await run(sshExecutable, [...sshArgs(worker), `${worker.user}@${worker.host}`, 'node.exe', script,
      '--worker-cell-request', remoteRequest, '--worker-cell-result', remoteResult]);
    await run(scpExecutable, [...scpArgs(worker), remoteSpec(worker, remoteResult), localResultPath]);
    fs.mkdirSync(localOutputRoot, { recursive: true });
    const remoteCellDirectory = path.win32.join(remoteOutputRoot, checked.cell.cellId.replaceAll('::', '--'));
    await run(scpExecutable, [...scpArgs(worker), '-r', remoteSpec(worker, remoteCellDirectory), localOutputRoot]);
  }
  const envelope = JSON.parse(fs.readFileSync(localResultPath, 'utf8').replace(/^\uFEFF/u, ''));
  if (envelope.requestDigest !== checked.requestDigest || envelope.resultDigest !== digest(envelope.result)) {
    throw new Error(`local isolation worker ${workerId} result envelope was tampered`);
  }
  return envelope.result;
}

function validateWorker(worker, workerIds, vmDigests) {
  const workerId = String(worker?.workerId ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(workerId)) throw new Error('distributed local isolation worker id is invalid');
  if (workerIds.has(workerId)) throw new Error(`distributed local isolation duplicate worker ${workerId}`);
  workerIds.add(workerId);
  const vmIdentityDigest = digest(worker?.vmIdentity);
  if (worker.vmIdentityDigest && worker.vmIdentityDigest !== vmIdentityDigest) {
    throw new Error(`distributed local isolation worker ${workerId} VM identity digest mismatch`);
  }
  if (vmDigests.has(vmIdentityDigest)) throw new Error('distributed local isolation workers bind a duplicate VM');
  vmDigests.add(vmIdentityDigest);
  const candidates = (worker.deviceProfileInstances ?? []).filter((profile) => (
    profile?.deviceClass === 'default-speaker'
  ));
  if (candidates.length !== 1) {
    throw new Error(`distributed local isolation worker ${workerId} requires exactly one default-speaker profile`);
  }
  const profile = candidates[0];
  if (!profile.instanceId || !profile.profileId || !profile.physicalPlaybackDeviceId
      || !profile.expectedPhysicalPlaybackDeviceName) {
    throw new Error(`distributed local isolation worker ${workerId} device profile is incomplete`);
  }
  return { ...worker, workerId, vmIdentityDigest, profile };
}

export function createDistributedLocalIsolationAssignments({ workers }) {
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > 3) {
    throw new Error('distributed local isolation requires one to three workers');
  }
  const workerIds = new Set();
  const vmDigests = new Set();
  const normalized = workers.map((worker) => validateWorker(worker, workerIds, vmDigests));
  let workersByCell;
  if (normalized.length === 3) {
    const byId = new Map(normalized.map((worker) => [worker.workerId, worker]));
    for (const workerId of Object.keys(DISTRIBUTED_LOCAL_ISOLATION_WORKER_MODES)) {
      if (!byId.has(workerId)) throw new Error(`distributed local isolation is missing worker ${workerId}`);
    }
    workersByCell = LOCAL_ISOLATION_CELLS.map((cell) => normalized.find((worker) => (
      DISTRIBUTED_LOCAL_ISOLATION_WORKER_MODES[worker.workerId] === cell.feedbackLoopPrevention
    )));
  } else {
    workersByCell = LOCAL_ISOLATION_CELLS.map((_cell, index) => normalized[index % normalized.length]);
  }
  return LOCAL_ISOLATION_CELLS.map((cell, index) => Object.freeze({
    worker: workersByCell[index], cell, profile: workersByCell[index].profile,
  }));
}

function validateResult(result, assignment, runtimeBinaryHashes, phase) {
  const expectedCellId = phase === 'smoke' ? `${assignment.cell.cellId}::smoke` : assignment.cell.cellId;
  if (
    result?.cellId !== expectedCellId
    || result?.workerId !== assignment.worker.workerId
    || result?.vmIdentityDigest !== assignment.worker.vmIdentityDigest
    || result?.deviceProfileInstanceId !== assignment.profile.instanceId
    || result?.deviceProfileId !== assignment.profile.profileId
    || result?.requestedDeviceId !== assignment.profile.physicalPlaybackDeviceId
    || result?.expectedDeviceName !== assignment.profile.expectedPhysicalPlaybackDeviceName
    || result?.feedbackLoopPrevention !== assignment.cell.feedbackLoopPrevention
    || result?.providerCalls !== 0
    || result?.verdict !== 'passed'
  ) throw new Error(`distributed local isolation ${phase} result identity/endpoint mismatch for ${expectedCellId}`);
  if (!sameAuthorityInventory(result.runtimeBinaryHashes, runtimeBinaryHashes)) {
    throw new Error(`distributed local isolation ${phase} result runtime hashes changed for ${expectedCellId}`);
  }
  if (!result.receipt || !Number.isSafeInteger(result.receipt.bytes) || result.receipt.bytes <= 0
      || !SHA256.test(String(result.receipt.sha256 ?? ''))) {
    throw new Error(`distributed local isolation ${phase} result has no immutable receipt for ${expectedCellId}`);
  }
  const revalidation = result.preLaunchRevalidation;
  try {
    validateDistributionRevalidationReceipt(revalidation, {
      runtimeBinaryHashes,
      distributionDigest: revalidation?.distributionDigest,
    });
  } catch {
    throw new Error(`distributed local isolation ${phase} has no runtime pre-launch revalidation for ${expectedCellId}`);
  }
  return result;
}

export async function runDistributedLocalIsolationCells({
  workers,
  provenance,
  implementationHashes,
  runtimeBinaryHashes,
  smokeDurationSeconds,
  executeCell,
}) {
  if (typeof executeCell !== 'function') throw new Error('distributed local isolation requires a cell transport');
  const assignments = createDistributedLocalIsolationAssignments({ workers });
  const byWorker = new Map();
  for (const assignment of assignments) {
    const queued = byWorker.get(assignment.worker.workerId) ?? [];
    queued.push(assignment);
    byWorker.set(assignment.worker.workerId, queued);
  }
  const pipelines = [...byWorker.values()].map(async (workerAssignments) => {
    const completed = [];
    for (const assignment of workerAssignments) {
    const authority = {
      workerId: assignment.worker.workerId,
      vmIdentityDigest: assignment.worker.vmIdentityDigest,
      deviceProfileInstanceId: assignment.profile.instanceId,
    };
    const common = {
      worker: assignment.worker,
      profile: assignment.profile,
      provenance,
      implementationHashes,
      runtimeBinaryHashes,
      workerAuthority: authority,
    };
      const smoke = validateResult(await executeCell({
      ...common,
      phase: 'smoke',
      cell: { ...assignment.cell, cellId: `${assignment.cell.cellId}::smoke` },
      targetDurationSeconds: smokeDurationSeconds,
      artifactKind: 'watch-mode-local-isolation-smoke-cell',
    }), assignment, runtimeBinaryHashes, 'smoke');
      const formal = validateResult(await executeCell({
      ...common,
      phase: 'formal',
      cell: assignment.cell,
      targetDurationSeconds: assignment.cell.durationSeconds,
      artifactKind: 'watch-mode-local-isolation-cell',
    }), assignment, runtimeBinaryHashes, 'formal');
      completed.push({ smoke, formal });
    }
    return completed;
  });
  const settled = await Promise.allSettled(pipelines);
  const failures = settled.filter((entry) => entry.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(failures.map((entry) => entry.reason), 'distributed local isolation failed');
  }
  const completed = settled.flatMap((entry) => entry.value);
  const byMode = new Map(completed.map((entry) => [entry.formal.feedbackLoopPrevention, entry]));
  return {
    preflightSmoke: LOCAL_ISOLATION_CELLS.map((cell) => byMode.get(cell.feedbackLoopPrevention)?.smoke),
    cells: LOCAL_ISOLATION_CELLS.map((cell) => byMode.get(cell.feedbackLoopPrevention)?.formal),
  };
}
