import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
} from './watch-mode-evidence-authority.mjs';
import {
  INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  INCIDENT_PLUS_CELL_RESULT_FILE,
  currentIncidentPlusImplementationHashes,
  validateIncidentPlusCellResult,
  validateIncidentPlusReadinessRequest,
  validateIncidentPlusWorkerReadiness,
  verifyIncidentPlusCellLease,
  verifyIncidentPlusExecutionPlan,
  writeIncidentPlusCellResult,
} from './watch-mode-incident-plus-authority.mjs';
import { atomicWriteJson } from './watch-mode-shard-authority.mjs';
import { buildLiveWatchModeRunRequest } from './watch-mode-run-request.mjs';

export const INCIDENT_PLUS_CELL_RUNNER_ID =
  'scripts/testing/run-watch-mode-incident-plus-cell.mjs';
export const INCIDENT_PLUS_CELL_TIMEOUT_MS = 578_000;
export const INCIDENT_PLUS_INTERACTIVE_EXECUTION_KIND =
  'watch-mode-interactive-incident-plus-cell-execution';

const LIVE_RUNNER_SCRIPT = path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.ps1');
const LIVE_RUNNER_ENTRY = path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.mjs');
const COMPATIBILITY_READINESS_KIND = 'watch-mode-production-worker-zero-provider-readiness';

function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

function lastExistingRunDirectory(text, rootDirectory) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const candidate = path.isAbsolute(line) ? line : path.resolve(rootDirectory, line);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

function portableRelative(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside its incident execution root`);
  }
  return relative.split(path.sep).join('/');
}

export function incidentPlusCellAuthoritySnapshot({ workspaceRoot = repoRoot } = {}) {
  return {
    provenance: currentGitProvenance({ cwd: workspaceRoot }),
    authorityImplementationHashes: currentAuthorityImplementationHashes({ workspaceRoot }),
    runtimeBinaryHashes: currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
    incidentImplementationHashes: currentIncidentPlusImplementationHashes({ workspaceRoot }),
  };
}

export function assertIncidentPlusCellWorkerAuthority(plan, snapshot, { now = new Date() } = {}) {
  return verifyIncidentPlusExecutionPlan(plan, {
    now,
    currentProvenance: snapshot.provenance,
    currentAuthorityImplementationHashes: snapshot.authorityImplementationHashes,
    currentRuntimeBinaryHashes: snapshot.runtimeBinaryHashes,
    currentIncidentImplementationHashes: snapshot.incidentImplementationHashes,
  });
}

function assertCompatibilityDriverReadiness({
  readinessPath,
  plan,
  worker,
}) {
  const receipt = readRegularJson(readinessPath, 'incident Plus virtual-driver compatibility readiness');
  if (
    receipt.schemaVersion !== 1
    || receipt.artifactKind !== COMPATIBILITY_READINESS_KIND
    || receipt.executionId !== plan.executionId
    || receipt.workerId !== worker.workerId
    || receipt.vmIdentityDigest !== worker.vmIdentityDigest
    || Number(receipt.providerCalls) !== 0
    || receipt.driverRequired !== true
    || !receipt.driver
  ) throw new Error('incident Plus virtual-driver compatibility readiness is not bound to this worker/runtime');
  return path.resolve(readinessPath);
}

export function buildIncidentPlusCellExecutionRequest({
  plan,
  lease,
  workerId,
  vmIdentity,
  executionRoot,
  readinessReceiptPath,
  readinessRequest,
  driverReadinessReceiptPath = null,
  now = new Date(),
}) {
  verifyIncidentPlusCellLease(lease, plan, { now });
  const worker = plan.workers.find((entry) => entry.workerId === workerId);
  if (!worker || lease.workerId !== workerId) {
    throw new Error('incident Plus lease is assigned to another worker');
  }
  if (JSON.stringify(worker.vmIdentity) !== JSON.stringify(vmIdentity)) {
    throw new Error('incident Plus worker VM identity does not match its signed plan');
  }
  const cell = plan.cells[Number(lease.cellIndex)];
  const checkedRequest = validateIncidentPlusReadinessRequest(readinessRequest, plan);
  if (checkedRequest.workerId !== workerId) {
    throw new Error('incident Plus readiness request belongs to another worker');
  }
  validateIncidentPlusWorkerReadiness({
    receiptPath: readinessReceiptPath,
    request: readinessRequest,
    plan,
    now,
  });
  const driverReadiness = cell.feedbackLoopPrevention === 'virtual-driver'
    ? assertCompatibilityDriverReadiness({
      readinessPath: driverReadinessReceiptPath,
      plan,
      worker,
    })
    : null;
  const cellOutputRoot = path.join(
    path.resolve(executionRoot),
    'runs',
    `c${String(cell.cellIndex + 1).padStart(2, '0')}`,
  );
  return {
    cell,
    worker,
    cellOutputRoot,
    readinessReceiptPath: path.resolve(readinessReceiptPath),
    driverReadinessReceiptPath: driverReadiness,
    runnerOptions: {
      outputRoot: cellOutputRoot,
      mediaPath: path.join(repoRoot, 'scripts', 'testing', 'fixtures', 'watch-mode-en-original.wav'),
      warmupSeconds: 12,
      model: cell.modelId,
      watchRealtimeProtocol: 'dashscope-omni',
      subtitleTranslationMode: 'native',
      playbackSeconds: 0,
      postPlaybackWaitSeconds: 120,
      sessionReadyTimeoutSeconds: 90,
      watchAutoStopAfterSeconds: 180,
      physicalPlaybackDeviceId: cell.deviceProfileInstance.physicalPlaybackDeviceId,
      physicalPlaybackDeviceClass: cell.deviceClass,
      physicalPlaybackDeviceProfileId: cell.deviceProfileInstance.profileId,
      expectedPhysicalPlaybackDeviceName: cell.deviceProfileInstance.expectedPhysicalPlaybackDeviceName,
      feedbackMode: cell.feedbackLoopPrevention,
      matrixCellId: cell.cellId,
    },
    environment: {
      OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY: '1',
      OMNI_WATCH_MODE_INCIDENT_ID: plan.incidentId,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID: plan.providerIdentity.providerId,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID: plan.providerIdentity.templateId,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND: plan.providerIdentity.providerKind,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST: plan.providerIdentity.endpointHost,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE:
        plan.providerIdentity.credentialReference,
      OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID: lease.leaseId,
      OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES: String(INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES),
      OMNI_WATCH_MODE_CELL_ID: cell.cellId,
      OMNI_SHARD_EXECUTION_ID: plan.executionId,
      OMNI_SHARD_PLAN_DIGEST: plan.planDigest,
      OMNI_SHARD_LEASE_DIGEST: lease.leaseDigest,
      OMNI_SHARD_WORKER_ID: workerId,
      OMNI_SHARD_VM_IDENTITY_DIGEST: worker.vmIdentityDigest,
    },
  };
}

export function buildIncidentPlusPowerShellRunnerArgv(requestPath) {
  return [LIVE_RUNNER_ENTRY, '--request', path.resolve(requestPath)];
}

export function executeIncidentPlusPowerShellCell(request, {
  signal,
  environment = process.env,
  timeoutMs = INCIDENT_PLUS_CELL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const runRequest = buildLiveWatchModeRunRequest(request.runnerOptions, {
      authorityMode: 'incident-replay-plus',
      workerReadinessReceipt: request.driverReadinessReceiptPath,
    });
    const requestPath = path.join(request.runnerOptions.outputRoot, 'run-request.json');
    atomicWriteJson(requestPath, runRequest);
    const child = spawn(process.execPath, buildIncidentPlusPowerShellRunnerArgv(requestPath), {
      cwd: repoRoot,
      env: { ...environment, ...request.environment },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      child.stdout?.destroy();
      callback();
    };
    const terminate = () => {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/F', '/T'], {
          cwd: repoRoot,
          stdio: 'ignore',
          timeout: 5_000,
        });
      } else {
        child.kill('SIGKILL');
      }
    };
    const abort = () => terminate();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (exitCode) => finish(() => resolve({
      exitCode: exitCode ?? 1,
      stdout,
      runDirectory: lastExistingRunDirectory(stdout, repoRoot),
    })));
    const timeout = setTimeout(() => terminate(), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function runLeasedIncidentPlusCell({
  plan,
  lease,
  workerId,
  vmIdentity,
  executionRoot,
  readinessReceiptPath,
  readinessRequest,
  driverReadinessReceiptPath = null,
  authoritySnapshot,
  readAuthoritySnapshot = () => authoritySnapshot,
  executeCell = executeIncidentPlusPowerShellCell,
  interactiveExecutionReceiptPath = null,
  assertExternalProviderBudget = null,
  signal,
  now = () => new Date(),
}) {
  const startedAt = now();
  assertIncidentPlusCellWorkerAuthority(plan, authoritySnapshot, { now: startedAt });
  const request = buildIncidentPlusCellExecutionRequest({
    plan,
    lease,
    workerId,
    vmIdentity,
    executionRoot,
    readinessReceiptPath,
    readinessRequest,
    driverReadinessReceiptPath,
    now: startedAt,
  });
  const execution = await executeCell(request, { signal });
  if (Number(execution?.exitCode) !== 0 || !execution?.runDirectory) {
    throw new Error(`incident Plus cell ${request.cell.cellId} did not complete its bounded live session`);
  }
  const runDirectory = path.resolve(execution.runDirectory);
  portableRelative(request.cellOutputRoot, runDirectory, 'incident Plus run directory');
  const resultPath = path.join(runDirectory, INCIDENT_PLUS_CELL_RESULT_FILE);
  if (fs.existsSync(resultPath)) throw new Error('incident Plus cell result already exists');
  const completedAt = now();
  assertIncidentPlusCellWorkerAuthority(plan, readAuthoritySnapshot(), { now: completedAt });
  const resultOptions = {
    plan,
    lease,
    workerId,
    vmIdentity,
    executionRoot,
    runDirectory,
    readinessReceiptPath,
    readinessRequest,
    generatedAt: completedAt,
    ...(assertExternalProviderBudget ? { assertExternalProviderBudget } : {}),
  };
  const result = writeIncidentPlusCellResult(resultOptions);
  const validationOptions = {
    resultPath: result.resultPath,
    plan,
    lease,
    executionRoot,
    readinessReceiptPath,
    readinessRequest,
    now: completedAt,
    ...(assertExternalProviderBudget ? { assertExternalProviderBudget } : {}),
  };
  validateIncidentPlusCellResult(validationOptions);
  if (interactiveExecutionReceiptPath) {
    const receipt = {
      schemaVersion: 1,
      artifactKind: INCIDENT_PLUS_INTERACTIVE_EXECUTION_KIND,
      completedAt: completedAt.toISOString(),
      executionId: plan.executionId,
      planDigest: plan.planDigest,
      leaseId: lease.leaseId,
      leaseDigest: lease.leaseDigest,
      cellId: lease.cellId,
      workerId,
      vmIdentityDigest: request.worker.vmIdentityDigest,
      runDirectory: portableRelative(executionRoot, runDirectory, 'interactive incident Plus run directory'),
      resultPath: portableRelative(executionRoot, result.resultPath, 'interactive incident Plus result'),
      exitCode: 0,
    };
    atomicWriteJson(path.resolve(interactiveExecutionReceiptPath), receipt);
  }
  return { request, execution, runDirectory, ...result };
}

export function parseIncidentPlusCellCliArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      plan: '',
      lease: '',
      workerId: '',
      vmUuidBios: '',
      executionRoot: '',
      readinessReceipt: '',
      readinessRequest: '',
      driverReadinessReceipt: '',
      finalizeInteractiveRequest: '',
    },
  });
}

export function finalizeInteractiveIncidentPlusCell({
  request,
  authoritySnapshot = incidentPlusCellAuthoritySnapshot(),
  now = new Date(),
  assertExternalProviderBudget = null,
}) {
  if (
    request?.schemaVersion !== 1
    || request?.artifactKind !== 'watch-mode-interactive-cell-finalization-request'
    || !request.readinessRequestPath
  ) throw new Error('unsupported interactive incident Plus cell finalization request');
  const plan = readRegularJson(request.planPath, 'signed incident Plus plan');
  const lease = readRegularJson(request.leasePath, 'signed incident Plus cell lease');
  assertIncidentPlusCellWorkerAuthority(plan, authoritySnapshot, { now });
  const worker = plan.workers.find((entry) => entry.workerId === request.workerId);
  if (!worker || String(worker.vmIdentity?.uuidBios).toLowerCase()
    !== String(request.vmUuidBios).toLowerCase()) {
    throw new Error('interactive incident Plus finalizer worker/VM UUID does not match the signed plan');
  }
  verifyIncidentPlusCellLease(lease, plan, { now });
  if (lease.workerId !== worker.workerId) {
    throw new Error('interactive incident Plus finalizer lease belongs to another worker');
  }
  const execution = readRegularJson(request.executionReceiptPath, 'interactive incident Plus execution receipt');
  if (
    execution.schemaVersion !== 1
    || execution.artifactKind !== INCIDENT_PLUS_INTERACTIVE_EXECUTION_KIND
    || execution.executionId !== plan.executionId
    || execution.planDigest !== plan.planDigest
    || execution.leaseId !== lease.leaseId
    || execution.leaseDigest !== lease.leaseDigest
    || execution.cellId !== lease.cellId
    || execution.workerId !== worker.workerId
    || execution.vmIdentityDigest !== worker.vmIdentityDigest
    || Number(execution.exitCode) !== 0
  ) throw new Error('interactive incident Plus execution receipt identity/status mismatch');
  const root = path.resolve(request.shardRoot);
  const resultPath = path.resolve(root, ...String(execution.resultPath).split('/'));
  portableRelative(root, resultPath, 'interactive incident Plus result');
  const readinessRequest = readRegularJson(
    request.readinessRequestPath,
    'incident Plus readiness request for interactive finalization',
  );
  validateIncidentPlusCellResult({
    resultPath,
    plan,
    lease,
    executionRoot: root,
    readinessReceiptPath: request.readinessReceiptPath,
    readinessRequest,
    now,
    ...(assertExternalProviderBudget ? { assertExternalProviderBudget } : {}),
  });
  return { resultPath, plan, lease };
}

if (isMain(import.meta.url)) {
  try {
    const options = parseIncidentPlusCellCliArgs(process.argv.slice(2));
    if (String(options.finalizeInteractiveRequest ?? '').trim()) {
      const request = readRegularJson(
        options.finalizeInteractiveRequest,
        'interactive incident Plus cell finalization request',
      );
      const outcome = finalizeInteractiveIncidentPlusCell({ request });
      console.log(outcome.resultPath);
      process.exit(0);
    }
    for (const key of ['plan', 'lease', 'workerId', 'vmUuidBios', 'executionRoot', 'readinessReceipt', 'readinessRequest']) {
      if (!String(options[key] ?? '').trim()) {
        throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
      }
    }
    const plan = readRegularJson(options.plan, 'signed incident Plus plan');
    const lease = readRegularJson(options.lease, 'signed incident Plus cell lease');
    const worker = plan.workers?.find((entry) => entry.workerId === options.workerId);
    if (!worker || String(worker.vmIdentity?.uuidBios).toLowerCase()
      !== String(options.vmUuidBios).toLowerCase()) {
      throw new Error('CLI worker/VM UUID does not match the signed incident Plus plan');
    }
    const outcome = await runLeasedIncidentPlusCell({
      plan,
      lease,
      workerId: options.workerId,
      vmIdentity: worker.vmIdentity,
      executionRoot: path.resolve(options.executionRoot),
      readinessReceiptPath: options.readinessReceipt,
      readinessRequest: readRegularJson(options.readinessRequest, 'incident Plus readiness request'),
      driverReadinessReceiptPath: options.driverReadinessReceipt || null,
      authoritySnapshot: incidentPlusCellAuthoritySnapshot(),
      readAuthoritySnapshot: () => incidentPlusCellAuthoritySnapshot(),
      interactiveExecutionReceiptPath: process.env.OMNI_SHARD_INTERACTIVE_EXECUTION_RECEIPT_PATH || null,
    });
    console.log(outcome.resultPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
