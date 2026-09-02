import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compactTimestamp, isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import {
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  sameAuthorityInventory,
} from './watch-mode-evidence-authority.mjs';
import {
  BALANCED_RELEASE_PLAN_ID,
  LOCAL_ISOLATION_CELLS,
  RELEASE_DEVICE_CLASSES,
} from './watch-mode-balanced-release-plan.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import {
  createLocalIsolationWorkerResultEnvelope,
  distributeLocalIsolationRuntime,
  executeDistributedLocalIsolationCell,
  localIsolationFailureDetails,
  revalidateDistributionForWorkerRequest,
  runDistributedLocalIsolationCells,
  validateLocalIsolationWorkerRequest,
  validateDistributionRevalidationReceipt,
  verifyDistributedRuntimeDistribution,
} from './watch-mode-local-isolation-distributed.mjs';

export const LOCAL_ISOLATION_SCHEMA_VERSION = 3;
export const LOCAL_ISOLATION_ARTIFACT_KIND = 'watch-mode-local-isolation-authority';
export const LOCAL_ISOLATION_CELL_ARTIFACT_KIND = 'watch-mode-local-isolation-cell';
export const LOCAL_ISOLATION_RUNNER_ID = 'scripts/testing/watch-mode-local-isolation.mjs';
export const LOCAL_ISOLATION_CANONICAL_MANIFEST = 'latest-successful-watch-mode-local-isolation.json';
export const LOCAL_ISOLATION_RUNTIME_BINARY_PATHS = Object.freeze([
  'target/release/omni-bridge-service.exe',
  'target/release/omni-physical-output-probe.exe',
  'target/release/omni-tone-render-probe.exe',
  'target/release/omni-driver-audio-probe.exe',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
  'drivers/windows-virtual-mic/package/driver-package.json',
]);

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/watch-mode-local-isolation';
const BRIDGE_EXE = 'target/release/omni-bridge-service.exe';
const PHYSICAL_PROBE_EXE = 'target/release/omni-physical-output-probe.exe';
const DRIVER_PROBE_EXE = 'target/release/omni-driver-audio-probe.exe';
const TONE_PROBE_EXE = 'target/release/omni-tone-render-probe.exe';
const TRANSIENT_ENDPOINT_CREATE_FAILED = '0x8889000f';
const TRANSIENT_ENDPOINT_NOT_FOUND = 'physical playback device was not found:';
const TRANSIENT_ENDPOINT_CREATE_MAX_ATTEMPTS = 3;
const TRANSIENT_ENDPOINT_CREATE_RETRY_DELAY_MS = 750;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const portable = (value) => value.split(path.sep).join('/');

const currentLocalIsolationImplementationHashes = ({ workspaceRoot }) => [
  ...currentAuthorityImplementationHashes({ workspaceRoot }),
  fileAuthorityEntry(
    path.resolve(workspaceRoot, 'scripts/testing/watch-mode-local-isolation-distributed.mjs'),
    'scripts/testing/watch-mode-local-isolation-distributed.mjs',
  ),
];

const atomicWriteJson = (filePath, value, { overwrite = false } = {}) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  if (overwrite && fs.existsSync(filePath)) fs.rmSync(filePath);
  fs.renameSync(temporary, filePath);
};

function assertCleanCurrentHead(provenance) {
  if (
    provenance?.captureStatus !== 'captured'
    || provenance?.worktreeClean !== true
    || Number(provenance?.dirtyEntryCount) !== 0
    || !/^[a-f0-9]{40}$/iu.test(String(provenance?.headCommit ?? ''))
  ) throw new Error('local isolation requires the exact current clean HEAD');
}

export function parseLocalIsolationDeviceProfiles(value, { workspaceRoot = repoRoot } = {}) {
  if (!value) throw new Error('--device-profiles is required');
  const text = String(value).trim();
  const parsed = JSON.parse(
    (text.startsWith('[') || text.startsWith('{')
      ? text
      : fs.readFileSync(path.resolve(workspaceRoot, text), 'utf8')).replace(/^\uFEFF/, ''),
  );
  const profiles = Array.isArray(parsed) ? parsed : parsed?.deviceProfiles;
  if (!Array.isArray(profiles)) throw new Error('--device-profiles must contain a JSON array');
  const normalized = profiles.map((profile) => ({
    profileId: String(profile?.profileId ?? '').trim(),
    deviceClass: String(profile?.deviceClass ?? '').trim(),
    physicalPlaybackDeviceId: String(profile?.physicalPlaybackDeviceId ?? '').trim(),
    expectedPhysicalPlaybackDeviceName: String(profile?.expectedPhysicalPlaybackDeviceName ?? '').trim(),
  }));
  const classes = normalized.map(({ deviceClass }) => deviceClass);
  if (
    normalized.length !== RELEASE_DEVICE_CLASSES.length
    || !RELEASE_DEVICE_CLASSES.every((deviceClass) => classes.filter((entry) => entry === deviceClass).length === 1)
  ) throw new Error(`local isolation requires exactly one profile for ${RELEASE_DEVICE_CLASSES.join(', ')}`);
  for (const profile of normalized) {
    if (
      !profile.profileId
      || !profile.physicalPlaybackDeviceId
      || profile.physicalPlaybackDeviceId.toLowerCase() === 'default'
      || !profile.expectedPhysicalPlaybackDeviceName
    ) {
      throw new Error(`local isolation device profile ${profile.deviceClass || '-'} is incomplete`);
    }
  }
  return normalized;
}

const commandResult = (command, args, { cwd, environment, timeoutMs }) => {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    command: portable(path.relative(cwd, command) || command),
    args,
    exitCode: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error?.message ?? null,
  };
};

const waitForTransientEndpointRetry = (delayMs) => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, delayMs);
};

const endpointAvailabilityDiagnostic = (result) => [
  result?.stdout,
  result?.stderr,
  result?.error,
].filter(Boolean).join('\n').toLowerCase();

const isRetryableEndpointAvailabilityFailure = (result) => {
  const diagnostic = endpointAvailabilityDiagnostic(result);
  return diagnostic.includes(TRANSIENT_ENDPOINT_CREATE_FAILED)
    || diagnostic.includes(TRANSIENT_ENDPOINT_NOT_FOUND);
};

const isRetryableProcessFingerprintWindowFailure = (result, label) => {
  if (label !== 'process-exclusion' || result?.error) return false;
  const lines = String(result?.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let payload;
  try {
    payload = JSON.parse(lines.at(-1) ?? '');
  } catch {
    return false;
  }
  const fingerprint = payload?.processExclusionFingerprint;
  const detail = String(payload?.detail ?? '');
  const incompleteSourceWindow = detail.includes('Bridge source pipe captured only ')
    && Number(fingerprint?.sourceCapturedFrames) > 0
    && Number(fingerprint?.sourceCapturedFrames) < 48_000;
  const incompleteExternalWindow = detail.includes('external fingerprint did not survive process loopback:');
  return payload?.passed === false
    && fingerprint?.sourceCaptureMode === 'process-exclusion'
    && fingerprint?.captureBackend === 'wasapi-process-exclusion'
    && fingerprint?.processLoopbackStatus === 'ready'
    && Number(fingerprint?.bridgeProcessId) > 0
    && Number(fingerprint?.excludedProcessId) === Number(fingerprint?.bridgeProcessId)
    && Number(fingerprint?.physicalExternalComponent) >= 0.01
    && Number(fingerprint?.physicalBridgeChildComponent) >= 0.01
    && (incompleteExternalWindow || incompleteSourceWindow)
    && !detail.includes('translation fingerprint was not physically detectable')
    && !detail.includes('leaked into source pipe');
};

const parseProbeJson = (result, label) => {
  if (result.exitCode !== 0 || result.error) {
    throw new Error(`${label} failed: exit=${result.exitCode} error=${result.error ?? '-'} stderr=${result.stderr}`);
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let parsed;
  try {
    parsed = JSON.parse(lines.at(-1) ?? '');
  } catch {
    throw new Error(`${label} did not emit a terminal JSON object`);
  }
  if (parsed?.passed !== true) throw new Error(`${label} did not pass: ${parsed?.detail ?? 'unknown'}`);
  return parsed;
};

export function runLocalIsolationProbeIteration({
  cell,
  profile,
  cellDirectory,
  iteration,
  workspaceRoot = repoRoot,
  environment = process.env,
  run = commandResult,
  waitForRetry = waitForTransientEndpointRetry,
}) {
  const iterationDirectory = path.join(cellDirectory, 'iterations', String(iteration).padStart(4, '0'));
  fs.mkdirSync(iterationDirectory, { recursive: true });
  const execute = (relativeCommand, args, label, timeoutMs = 90_000) => {
    let result;
    let attempts = 0;
    do {
      attempts += 1;
      result = run(path.resolve(workspaceRoot, relativeCommand), args, {
        cwd: workspaceRoot,
        environment,
        timeoutMs,
      });
      const retryable = isRetryableEndpointAvailabilityFailure(result)
        || isRetryableProcessFingerprintWindowFailure(result, label);
      if (retryable && attempts < TRANSIENT_ENDPOINT_CREATE_MAX_ATTEMPTS) {
        // AUDCLNT_E_ENDPOINT_CREATE_FAILED (0x8889000F) can be returned by a
        // just-released shared endpoint after many short WASAPI probe streams.
        // Windows can also briefly omit that same endpoint from enumeration
        // while the development driver settles between consecutive probes.
        // Preserve each failed attempt. Besides endpoint churn, a fully
        // identity-bound process-exclusion route may occasionally receive an
        // incomplete external-tone window while all physical fingerprints
        // remain present. Retry that narrow transient without weakening any
        // fingerprint threshold; every other failure remains fail-closed.
        fs.writeFileSync(path.join(iterationDirectory, `${label}.attempt-${attempts}.stdout.log`), result.stdout || '\n', 'utf8');
        fs.writeFileSync(path.join(iterationDirectory, `${label}.attempt-${attempts}.stderr.log`), result.stderr || '\n', 'utf8');
        waitForRetry(TRANSIENT_ENDPOINT_CREATE_RETRY_DELAY_MS);
        continue;
      }
      break;
    } while (true);
    fs.writeFileSync(path.join(iterationDirectory, `${label}.stdout.log`), result.stdout || '\n', 'utf8');
    fs.writeFileSync(path.join(iterationDirectory, `${label}.stderr.log`), result.stderr || '\n', 'utf8');
    return { result, attempts, parsed: parseProbeJson(result, label) };
  };
  const runtimeRoot = path.join(iterationDirectory, 'runtime');
  const physicalArgs = [
    '--bridge-exe', path.resolve(workspaceRoot, BRIDGE_EXE),
    '--runtime-root', runtimeRoot,
    '--physical-playback-device-id', profile.physicalPlaybackDeviceId,
  ];
  const probes = [];
  if (cell.feedbackLoopPrevention === 'process-exclusion') {
    const outcome = execute(PHYSICAL_PROBE_EXE, [
      ...physicalArgs,
      '--process-exclusion-fingerprint',
      '--tone-player-exe', path.resolve(workspaceRoot, TONE_PROBE_EXE),
    ], 'process-exclusion');
    probes.push({ kind: 'process-exclusion-fingerprint', attempts: outcome.attempts, data: outcome.parsed });
  } else {
    if (cell.feedbackLoopPrevention === 'virtual-driver') {
      const driver = execute(DRIVER_PROBE_EXE, [], 'virtual-driver');
      probes.push({ kind: 'virtual-driver-roundtrip', attempts: driver.attempts, data: driver.parsed });
    }
    const physical = execute(PHYSICAL_PROBE_EXE, physicalArgs, 'physical-output');
    probes.push({ kind: 'physical-output', attempts: physical.attempts, data: physical.parsed });
  }
  const resolvedNames = probes.map(({ data }) => (
    data.resolvedPhysicalPlaybackDeviceName ?? data.endpointName ?? ''
  )).filter(Boolean);
  if (
    profile.expectedPhysicalPlaybackDeviceName
    && resolvedNames.length > 0
    && !resolvedNames.some((name) => name.includes(profile.expectedPhysicalPlaybackDeviceName))
  ) {
    throw new Error(`local isolation ${cell.cellId} resolved the wrong endpoint: ${resolvedNames.join(', ')}`);
  }
  const result = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-local-isolation-iteration',
    cellId: cell.cellId,
    iteration,
    providerCalls: 0,
    probes,
  };
  atomicWriteJson(path.join(iterationDirectory, 'result.json'), result);
  return result;
}

const collectFiles = (directory) => {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name !== 'cell-authority.json') files.push(candidate);
    }
  };
  visit(directory);
  return files.sort().map((filePath) => {
    const bytes = fs.readFileSync(filePath);
    return {
      path: portable(path.relative(directory, filePath)),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
};

export async function runLocalIsolationCell({
  cell,
  profile,
  outputRoot,
  provenance,
  implementationHashes,
  runtimeBinaryHashes,
  workspaceRoot = repoRoot,
  now = () => Date.now(),
  runIteration = runLocalIsolationProbeIteration,
  targetDurationSeconds = cell.durationSeconds,
  artifactKind = LOCAL_ISOLATION_CELL_ARTIFACT_KIND,
  workerAuthority = null,
}) {
  const startedAtMs = now();
  const cellDirectory = path.join(outputRoot, cell.cellId.replaceAll('::', '--'));
  fs.mkdirSync(cellDirectory, { recursive: false });
  const targetDurationMs = targetDurationSeconds * 1_000;
  let iteration = 0;
  do {
    iteration += 1;
    await runIteration({ cell, profile, cellDirectory, iteration, workspaceRoot });
  } while (now() - startedAtMs < targetDurationMs);
  const finishedAtMs = now();
  if (finishedAtMs - startedAtMs < targetDurationMs) {
    throw new Error(`local isolation ${cell.cellId} did not span ${targetDurationMs}ms`);
  }
  const summary = {
    schemaVersion: 1,
    artifactKind,
    cellId: cell.cellId,
    tier: cell.tier,
    providerMode: cell.providerMode,
    providerCalls: 0,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    deviceProfileId: profile.profileId,
    ...(workerAuthority ? {
      workerId: workerAuthority.workerId,
      vmIdentityDigest: workerAuthority.vmIdentityDigest,
      deviceProfileInstanceId: workerAuthority.deviceProfileInstanceId,
    } : {}),
    requestedDeviceId: profile.physicalPlaybackDeviceId,
    expectedDeviceName: profile.expectedPhysicalPlaybackDeviceName,
    targetDurationMs,
    durationMs: finishedAtMs - startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    iterationCount: iteration,
    verdict: 'passed',
  };
  atomicWriteJson(path.join(cellDirectory, 'local-isolation-result.json'), summary);
  const artifacts = collectFiles(cellDirectory);
  const receipt = {
    ...summary,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    artifacts,
  };
  const receiptPath = path.join(cellDirectory, 'cell-authority.json');
  atomicWriteJson(receiptPath, receipt);
  return {
    ...summary,
    runtimeBinaryHashes,
    runDirectory: portable(path.relative(outputRoot, cellDirectory)),
    receipt: fileAuthorityEntry(receiptPath, portable(path.relative(outputRoot, receiptPath))),
  };
}

export function verifyLocalIsolationManifest({
  manifestPath,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  implementationHashes = currentLocalIsolationImplementationHashes({ workspaceRoot }),
  runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
  runtimeAuthorityPath = null,
}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const planIdAccepted = manifest.planId === BALANCED_RELEASE_PLAN_ID;
  if (
    manifest.schemaVersion !== LOCAL_ISOLATION_SCHEMA_VERSION
    || manifest.artifactKind !== LOCAL_ISOLATION_ARTIFACT_KIND
    || !planIdAccepted
    || manifest.providerCalls !== 0
    || manifest.verdict !== 'passed'
  ) throw new Error('local isolation manifest is not a passed balanced release authority');
  if (!runtimeAuthorityPath) throw new Error('local isolation verification requires the frozen strict runtime authority');
  const frozenRuntime = verifyStrictRuntimeAuthority(runtimeAuthorityPath, { workspaceRoot, provenance });
  if (
    manifest.runtimeAuthority?.authorityDigest !== frozenRuntime.authority.authorityDigest
    || manifest.runtimeAuthority?.releaseId !== frozenRuntime.authority.releaseId
  ) throw new Error('local isolation manifest is not bound to the supplied frozen strict runtime authority');
  const provenanceFailure = exactGitProvenanceFailure(manifest.provenance, provenance, {
    recordedSubject: 'local isolation manifest provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceFailure) throw new Error(provenanceFailure);
  if (
    !sameAuthorityInventory(manifest.implementationHashes, implementationHashes)
    || !sameAuthorityInventory(manifest.runtimeBinaryHashes, runtimeBinaryHashes)
  ) throw new Error('local isolation implementation/runtime authority mismatch');
  const manifestRoot = path.dirname(path.resolve(manifestPath));
  const aecLogAuthority = fileAuthorityEntry(
    path.resolve(manifestRoot, manifest.aec3Gate?.path ?? ''),
    manifest.aec3Gate?.path ?? '',
  );
  if (
    manifest.aec3Gate?.command !== 'npm run test:aec3-msvc'
    || manifest.aec3Gate?.verdict !== 'passed'
    || aecLogAuthority.bytes !== manifest.aec3Gate?.bytes
    || aecLogAuthority.sha256 !== manifest.aec3Gate?.sha256
  ) throw new Error('local isolation manifest does not bind a passed AEC3 MSVC gate');
  if (!Array.isArray(manifest.cells) || manifest.cells.length !== LOCAL_ISOLATION_CELLS.length) {
    throw new Error(`local isolation manifest must contain ${LOCAL_ISOLATION_CELLS.length} cells`);
  }
  if (!Array.isArray(manifest.preflightSmoke) || manifest.preflightSmoke.length !== LOCAL_ISOLATION_CELLS.length) {
    throw new Error('local isolation manifest must bind one short preflight smoke per feedback route');
  }
  const workerIds = new Map();
  const vmIdentityDigests = new Set();
  if (!Array.isArray(manifest.workerRuntimeDistributions)
      || manifest.workerRuntimeDistributions.length < 1
      || manifest.workerRuntimeDistributions.length > 3) {
    throw new Error('local isolation manifest must bind one to three worker runtime distributions');
  }
  const distributionWorkers = new Set();
  for (const distribution of manifest.workerRuntimeDistributions) {
    if (!distribution.workerId || distributionWorkers.has(distribution.workerId)) {
      throw new Error('local isolation manifest has a duplicate worker runtime distribution');
    }
    distributionWorkers.add(distribution.workerId);
    if (!distribution.vmIdentityDigest) throw new Error(`local isolation worker ${distribution.workerId} has no VM identity`);
    const distributionPath = path.resolve(manifestRoot, distribution.authority?.path ?? '');
    const authority = fileAuthorityEntry(distributionPath, distribution.authority?.path ?? '');
    if (authority.bytes !== distribution.authority?.bytes || authority.sha256 !== distribution.authority?.sha256) {
      throw new Error(`local isolation worker ${distribution.workerId} runtime distribution changed`);
    }
    const distributionManifest = JSON.parse(fs.readFileSync(distributionPath, 'utf8'));
    const distributedByPath = new Map(distributionManifest.files.map((entry) => [entry.path, entry]));
    const distributedRuntime = runtimeBinaryHashes.map((entry) => distributedByPath.get(entry.path));
    if (distributionManifest.distributionDigest !== distribution.distributionDigest
        || !sameAuthorityInventory(distributedRuntime, runtimeBinaryHashes)) {
      throw new Error(`local isolation worker ${distribution.workerId} runtime distribution authority mismatch`);
    }
  }
  for (let index = 0; index < LOCAL_ISOLATION_CELLS.length; index += 1) {
    const expected = LOCAL_ISOLATION_CELLS[index];
    const smoke = manifest.preflightSmoke[index];
    if (
      smoke?.cellId !== `${expected.cellId}::smoke`
      || smoke?.feedbackLoopPrevention !== expected.feedbackLoopPrevention
      || smoke?.providerCalls !== 0
      || smoke?.verdict !== 'passed'
      || Number(smoke?.targetDurationMs) < 30_000
      || Number(smoke?.targetDurationMs) > 60_000
      || Number(smoke?.durationMs) < Number(smoke?.targetDurationMs)
      || !smoke?.workerId
      || !smoke?.vmIdentityDigest
      || !smoke?.deviceProfileInstanceId
    ) throw new Error(`local isolation preflight smoke failed for ${expected.feedbackLoopPrevention}`);
    const smokeReceiptPath = path.resolve(manifestRoot, smoke.receipt?.path ?? '');
    const smokeAuthority = fileAuthorityEntry(smokeReceiptPath, smoke.receipt?.path ?? '');
    if (smokeAuthority.bytes !== smoke.receipt?.bytes || smokeAuthority.sha256 !== smoke.receipt?.sha256) {
      throw new Error(`local isolation preflight smoke receipt hash mismatch for ${expected.feedbackLoopPrevention}`);
    }
    const smokeReceipt = JSON.parse(fs.readFileSync(smokeReceiptPath, 'utf8'));
    const smokeDistribution = manifest.workerRuntimeDistributions.find((entry) => entry.workerId === smoke.workerId);
    validateDistributionRevalidationReceipt(smoke.preLaunchRevalidation, {
      runtimeBinaryHashes,
      distributionDigest: smokeDistribution?.distributionDigest,
    });
    if (
      smokeReceipt.cellId !== smoke.cellId
      || smokeReceipt.providerCalls !== 0
      || smokeReceipt.workerId !== smoke.workerId
      || smokeReceipt.vmIdentityDigest !== smoke.vmIdentityDigest
      || smokeReceipt.deviceProfileInstanceId !== smoke.deviceProfileInstanceId
      || smokeReceipt.deviceProfileId !== smoke.deviceProfileId
      || smokeReceipt.requestedDeviceId !== smoke.requestedDeviceId
      || smokeReceipt.expectedDeviceName !== smoke.expectedDeviceName
      || !sameAuthorityInventory(smokeReceipt.runtimeBinaryHashes, runtimeBinaryHashes)
    ) throw new Error(`local isolation preflight smoke receipt identity mismatch for ${expected.feedbackLoopPrevention}`);
    for (const artifact of smokeReceipt.artifacts ?? []) {
      const artifactPath = path.resolve(path.dirname(smokeReceiptPath), artifact.path);
      const current = fileAuthorityEntry(artifactPath, artifact.path);
      if (current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256) {
        throw new Error(`local isolation preflight smoke artifact changed: ${artifact.path}`);
      }
    }
  }
  const root = manifestRoot;
  for (let index = 0; index < LOCAL_ISOLATION_CELLS.length; index += 1) {
    const expected = LOCAL_ISOLATION_CELLS[index];
    const cell = manifest.cells[index];
    if (
      cell?.cellId !== expected.cellId
      || cell?.providerMode !== 'disabled'
      || Number(cell?.providerCalls) !== 0
      || Number(cell?.durationMs) < expected.durationSeconds * 1_000
      || Number(cell?.iterationCount) < 1
      || cell?.verdict !== 'passed'
      || !cell?.workerId
      || !cell?.vmIdentityDigest
      || !cell?.deviceProfileInstanceId
    ) throw new Error(`local isolation cell ${expected.cellId} is incomplete or used a Provider`);
    const priorVmDigest = workerIds.get(cell.workerId);
    if (priorVmDigest && priorVmDigest !== cell.vmIdentityDigest) {
      throw new Error(`local isolation worker ${cell.workerId} changed VM identity between cells`);
    }
    if (!priorVmDigest && vmIdentityDigests.has(cell.vmIdentityDigest)) {
      throw new Error(`local isolation VM identity is reused by worker ${cell.workerId}`);
    }
    workerIds.set(cell.workerId, cell.vmIdentityDigest);
    vmIdentityDigests.add(cell.vmIdentityDigest);
    const smoke = manifest.preflightSmoke[index];
    if (
      smoke.workerId !== cell.workerId
      || smoke.vmIdentityDigest !== cell.vmIdentityDigest
      || smoke.deviceProfileInstanceId !== cell.deviceProfileInstanceId
      || smoke.deviceProfileId !== cell.deviceProfileId
      || smoke.requestedDeviceId !== cell.requestedDeviceId
      || smoke.expectedDeviceName !== cell.expectedDeviceName
    ) throw new Error(`local isolation smoke/formal authority mismatch for ${expected.cellId}`);
    const receiptPath = path.resolve(root, cell.receipt.path);
    const authority = fileAuthorityEntry(receiptPath, cell.receipt.path);
    if (authority.bytes !== cell.receipt.bytes || authority.sha256 !== cell.receipt.sha256) {
      throw new Error(`local isolation cell ${expected.cellId} receipt hash mismatch`);
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const cellDistribution = manifest.workerRuntimeDistributions.find((entry) => entry.workerId === cell.workerId);
    validateDistributionRevalidationReceipt(cell.preLaunchRevalidation, {
      runtimeBinaryHashes,
      distributionDigest: cellDistribution?.distributionDigest,
    });
    if (
      receipt.cellId !== expected.cellId
      || receipt.providerCalls !== 0
      || receipt.workerId !== cell.workerId
      || receipt.vmIdentityDigest !== cell.vmIdentityDigest
      || receipt.deviceProfileInstanceId !== cell.deviceProfileInstanceId
      || receipt.deviceProfileId !== cell.deviceProfileId
      || receipt.requestedDeviceId !== cell.requestedDeviceId
      || receipt.expectedDeviceName !== cell.expectedDeviceName
      || !sameAuthorityInventory(receipt.runtimeBinaryHashes, runtimeBinaryHashes)
    ) {
      throw new Error(`local isolation cell ${expected.cellId} receipt identity mismatch`);
    }
    for (const artifact of receipt.artifacts ?? []) {
      const artifactPath = path.resolve(path.dirname(receiptPath), artifact.path);
      const current = fileAuthorityEntry(artifactPath, artifact.path);
      if (current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256) {
        throw new Error(`local isolation cell ${expected.cellId} artifact changed: ${artifact.path}`);
      }
    }
  }
  if (workerIds.size !== manifest.workerRuntimeDistributions.length
      || [...workerIds].some(([workerId, vmDigest]) => (
        !distributionWorkers.has(workerId)
        || manifest.workerRuntimeDistributions.find((entry) => entry.workerId === workerId)?.vmIdentityDigest !== vmDigest
      ))) {
    throw new Error('local isolation cells do not match the signed worker runtime distributions');
  }
  return manifest;
}

export async function runLocalIsolationMatrix({
  deviceProfiles,
  workers,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = () => Date.now(),
  runCell = runLocalIsolationCell,
  executeWorkerCell,
  distributeRuntime = distributeLocalIsolationRuntime,
  sshExecutable = 'ssh.exe',
  scpExecutable = 'scp.exe',
  smokeDurationSeconds = 45,
  runtimeAuthorityPath,
}) {
  assertCleanCurrentHead(provenance);
  if (!runtimeAuthorityPath) throw new Error('local isolation requires --runtime-authority');
  const frozenRuntime = verifyStrictRuntimeAuthority(runtimeAuthorityPath, { workspaceRoot, provenance });
  const implementationHashes = currentLocalIsolationImplementationHashes({ workspaceRoot });
  const runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot });
  const generatedAtMs = now();
  const matrixDirectory = path.resolve(
    workspaceRoot,
    outputRoot,
    `${compactTimestamp(new Date(generatedAtMs))}-${provenance.headCommit.slice(0, 12)}`,
  );
  createLocalIsolationMatrixDirectory(matrixDirectory);
  const recordFailure = (error) => {
    writeLocalIsolationFailureManifest({ matrixDirectory, provenance, error });
    throw error;
  };
  const aecGateLogPath = path.join(matrixDirectory, 'aec3-msvc-gate.log');
  const frozenAecLog = path.resolve(
    path.dirname(frozenRuntime.authorityPath),
    frozenRuntime.authority.aec3Gate.authority.path,
  );
  fs.copyFileSync(frozenAecLog, aecGateLogPath, fs.constants.COPYFILE_EXCL);
  if (!Number.isInteger(smokeDurationSeconds) || smokeDurationSeconds < 30 || smokeDurationSeconds > 60) {
    throw new Error('local isolation smoke duration must be between 30 and 60 seconds');
  }
  const smokeRoot = path.join(matrixDirectory, 'preflight-smoke');
  fs.mkdirSync(smokeRoot, { recursive: false });
  const distributionRoot = path.join(matrixDirectory, 'distribution');
  const deployments = await distributeRuntime({
    workers, workspaceRoot, runtimeBinaryHashes, stagingRoot: distributionRoot,
    sshExecutable, scpExecutable,
  }).catch(recordFailure);
  const deploymentByWorker = new Map(deployments.map((entry) => [entry.workerId, entry]));
  const requestRoot = path.join(matrixDirectory, 'worker-requests');
  fs.mkdirSync(requestRoot, { recursive: false });
  const localTransport = executeWorkerCell ?? (async (request) => executeDistributedLocalIsolationCell({
    request: { ...request, distribution: deploymentByWorker.get(request.worker.workerId) },
    requestRoot,
    workerWorkspaceRoot: deploymentByWorker.get(request.worker.workerId).workspaceRoot,
    localOutputRoot: request.phase === 'smoke' ? smokeRoot : matrixDirectory,
    sshExecutable,
    scpExecutable,
  }));
  const distributed = await runDistributedLocalIsolationCells({
    workers,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    smokeDurationSeconds,
    executeCell: localTransport,
  }).catch(recordFailure);
  const { preflightSmoke, cells } = distributed;
  const manifest = {
    schemaVersion: LOCAL_ISOLATION_SCHEMA_VERSION,
    artifactKind: LOCAL_ISOLATION_ARTIFACT_KIND,
    generatedAt: new Date(generatedAtMs).toISOString(),
    planId: BALANCED_RELEASE_PLAN_ID,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    runtimeAuthority: {
      releaseId: frozenRuntime.authority.releaseId,
      authorityDigest: frozenRuntime.authority.authorityDigest,
      authority: fileAuthorityEntry(
        frozenRuntime.authorityPath,
        portable(path.relative(matrixDirectory, frozenRuntime.authorityPath)),
      ),
    },
    aec3Gate: {
      command: 'npm run test:aec3-msvc',
      ...fileAuthorityEntry(aecGateLogPath, path.basename(aecGateLogPath)),
      verdict: 'passed',
    },
    deviceProfiles,
    workerRuntimeDistributions: deployments.map((entry) => ({
      workerId: entry.workerId,
      vmIdentityDigest: workers.find((worker) => worker.workerId === entry.workerId)?.vmIdentityDigest
        ?? crypto.createHash('sha256').update(JSON.stringify(
          Object.fromEntries(Object.entries(workers.find((worker) => worker.workerId === entry.workerId).vmIdentity).sort()),
        )).digest('hex'),
      workspaceRoot: entry.workspaceRoot,
      distributionDigest: entry.manifest.distributionDigest,
      authority: fileAuthorityEntry(
        entry.manifestPath,
        portable(path.relative(matrixDirectory, entry.manifestPath)),
      ),
    })),
    preflightSmoke,
    cells,
    providerCalls: 0,
    verdict: 'passed',
  };
  const manifestPath = path.join(matrixDirectory, 'local-isolation-manifest.json');
  atomicWriteJson(manifestPath, manifest);
  verifyLocalIsolationManifest({
    manifestPath,
    workspaceRoot,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    runtimeAuthorityPath: frozenRuntime.authorityPath,
  });
  const canonicalPath = path.resolve(workspaceRoot, outputRoot, LOCAL_ISOLATION_CANONICAL_MANIFEST);
  atomicWriteJson(canonicalPath, {
    ...manifest,
    sourceManifest: fileAuthorityEntry(
      manifestPath,
      portable(path.relative(path.dirname(canonicalPath), manifestPath)),
    ),
  }, { overwrite: true });
  return { manifestPath, canonicalPath, manifest };
}

export function createLocalIsolationMatrixDirectory(matrixDirectory) {
  fs.mkdirSync(path.dirname(matrixDirectory), { recursive: true });
  fs.mkdirSync(matrixDirectory, { recursive: false });
}

export function writeLocalIsolationFailureManifest({ matrixDirectory, provenance, error }) {
  const manifestPath = path.join(matrixDirectory, 'local-isolation-failure.json');
  atomicWriteJson(manifestPath, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-local-isolation-failure',
    verdict: 'failed',
    providerCalls: 0,
    provenance,
    error: localIsolationFailureDetails(error),
  });
  return manifestPath;
}

if (isMain(import.meta.url)) {
  try {
    if (process.platform !== 'win32') throw new Error('local isolation authority requires Windows');
    if (process.argv.includes('--verify-distribution')) {
      const args = parseCliArgs(process.argv.slice(2), { defaults: { verifyDistribution: '' } });
      const manifestPath = path.resolve(args.verifyDistribution);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/u, ''));
      verifyDistributedRuntimeDistribution({ workspaceRoot: path.dirname(manifestPath), manifest });
      console.log(JSON.stringify({ verified: true, distributionDigest: manifest.distributionDigest }));
      process.exit(0);
    }
    if (process.argv.includes('--worker-cell-request')) {
      const args = parseCliArgs(process.argv.slice(2), {
        defaults: { workerCellRequest: '', workerCellResult: '' },
      });
      const request = validateLocalIsolationWorkerRequest(JSON.parse(
        fs.readFileSync(path.resolve(args.workerCellRequest), 'utf8').replace(/^\uFEFF/u, ''),
      ));
      const identity = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID',
      ], { encoding: 'utf8', windowsHide: true });
      if (identity.status !== 0) throw new Error(`failed to read worker BIOS UUID: ${identity.stderr}`);
      if (String(identity.stdout).trim().toLowerCase() !== String(request.worker.vmIdentity.uuidBios).trim().toLowerCase()) {
        throw new Error('local isolation worker BIOS UUID does not match the immutable request');
      }
      const preLaunchRevalidation = revalidateDistributionForWorkerRequest({ request, workspaceRoot: repoRoot });
      fs.mkdirSync(request.outputRoot, { recursive: true });
      const result = await runLocalIsolationCell({
        cell: request.cell,
        profile: request.profile,
        outputRoot: request.outputRoot,
        provenance: request.provenance,
        implementationHashes: request.implementationHashes,
        runtimeBinaryHashes: request.runtimeBinaryHashes,
        workspaceRoot: repoRoot,
        targetDurationSeconds: request.targetDurationSeconds,
        artifactKind: request.cellArtifactKind,
        workerAuthority: request.workerAuthority,
      });
      atomicWriteJson(
        path.resolve(args.workerCellResult),
        createLocalIsolationWorkerResultEnvelope(request, { ...result, preLaunchRevalidation }),
      );
      console.log(JSON.stringify({ passed: true, cellId: result.cellId }));
      process.exit(0);
    }
    const args = parseCliArgs(process.argv.slice(2), {
      defaults: {
        outputRoot: DEFAULT_OUTPUT_ROOT,
        deviceProfiles: '',
        runtimeAuthority: '',
        workerConfig: '',
      },
    });
    if (!args.runtimeAuthority) throw new Error('--runtime-authority is required');
    if (!args.workerConfig) throw new Error('--worker-config is required');
    // Load the production validator in an isolated process. The production
    // coordinator imports this module to verify local authority, so importing
    // it back from this CLI would create a cyclic top-level-await dependency.
    const configLoader = spawnSync(process.execPath, [
      '--input-type=module', '--eval',
      `import { readProductionWorkerConfig } from ${JSON.stringify(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url).href)}; process.stdout.write(JSON.stringify(readProductionWorkerConfig(process.argv[1])));`,
      path.resolve(repoRoot, args.workerConfig),
    ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    if (configLoader.status !== 0) throw new Error(`worker config validation failed: ${configLoader.stderr}`);
    const workerConfig = JSON.parse(configLoader.stdout);
    const deviceProfiles = args.deviceProfiles
      ? parseLocalIsolationDeviceProfiles(args.deviceProfiles)
      : workerConfig.workers.flatMap((worker) => worker.deviceProfileInstances.map((profile) => ({
        ...profile, workerId: worker.workerId,
      })));
    const result = await runLocalIsolationMatrix({
      deviceProfiles,
      workers: workerConfig.workers,
      outputRoot: args.outputRoot,
      runtimeAuthorityPath: path.resolve(repoRoot, args.runtimeAuthority),
      sshExecutable: workerConfig.sshExecutable,
      scpExecutable: workerConfig.scpExecutable,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify(localIsolationFailureDetails(error), null, 2));
    process.exitCode = 1;
  }
}
