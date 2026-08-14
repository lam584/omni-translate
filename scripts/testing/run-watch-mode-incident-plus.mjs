import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  buildStrictRuntimeAuthority,
  runStrictProviderPreflight,
  strictRuntimeEnvironment,
} from './run-watch-mode-live-matrix.mjs';
import {
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
} from './watch-mode-evidence-authority.mjs';
import {
  createIncidentPlusPreflightCompletion,
  createIncidentPlusAssignments,
  createIncidentPlusExecutionPlan,
  createIncidentPlusPreflightGrant,
  createIncidentPlusPreflightLeaseReservations,
  createIncidentPlusReadinessRequests,
  currentIncidentPlusImplementationHashes,
  issueIncidentPlusCellLeases,
  validateIncidentPlusCellResult,
  writeIncidentPlusPreflightAuthorizationPackage,
  writeIncidentPlusExecutionPlan,
  writeIncidentPlusManifest,
  writeIncidentPlusVerificationReceipt,
} from './watch-mode-incident-plus-authority.mjs';
import {
  PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY,
  createSshProductionTransport,
  readProductionWorkerConfig,
  remotePowerShellInvocation,
  scpBaseArgs,
  sshBaseArgs,
  validateProductionWorkerConfig,
} from './run-watch-mode-live-production-coordinator.mjs';
import {
  PROVIDER_PREFLIGHT_AUTHORIZATION_DIGEST_ENV,
  PROVIDER_PREFLIGHT_GRANT_PATH_ENV,
  PROVIDER_PREFLIGHT_RESERVATION_DIRECTORY_ENV,
} from './watch-mode-provider-preflight-authorization.mjs';
import {
  atomicWriteJson,
  coordinatorKeyIdForPublicKey,
  generateCoordinatorSigningKeyPair,
} from './watch-mode-shard-authority.mjs';

export const INCIDENT_PLUS_RUNNER_ID = 'scripts/testing/run-watch-mode-incident-plus.mjs';

function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink JSON file`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

export function normalizeIncidentPlusWorkers(workerConfig) {
  const workers = Array.isArray(workerConfig?.workers) ? workerConfig.workers : workerConfig;
  if (!Array.isArray(workers)) throw new Error('incident Plus worker configuration requires a workers array');
  const allProfiles = workers.flatMap((worker) => (
    (Array.isArray(worker?.deviceProfileInstances) ? worker.deviceProfileInstances : []).map((profile) => ({
      worker,
      profile,
    }))
  ));
  const usbProfiles = allProfiles.filter(({ profile }) => profile?.deviceClass === 'usb');
  if (usbProfiles.length !== 1) {
    throw new Error('incident Plus worker configuration requires exactly one USB device profile');
  }
  const defaultProfiles = allProfiles.filter(({ profile }) => profile?.deviceClass === 'default-speaker');
  const defaultProfilesOnOtherWorker = defaultProfiles.filter(({ worker }) => (
    worker?.workerId !== usbProfiles[0].worker?.workerId
  ));
  const selectedDefault = defaultProfilesOnOtherWorker.length === 1
    ? defaultProfilesOnOtherWorker[0]
    : (defaultProfiles.length === 1 ? defaultProfiles[0] : null);
  if (!selectedDefault) {
    throw new Error('incident Plus requires exactly one default-speaker profile on the non-USB worker');
  }
  return workers.map((worker) => ({
    workerId: worker.workerId,
    ...(worker.user ? { interactiveUser: worker.user } : {}),
    vmIdentity: worker.vmIdentity,
    deviceProfileInstances: [
      ...(worker.workerId === selectedDefault.worker.workerId ? [selectedDefault.profile] : []),
      ...(worker.workerId === usbProfiles[0].worker.workerId ? [usbProfiles[0].profile] : []),
    ],
  }));
}

export function prepareIncidentPlusExecution({
  workerConfig,
  localIsolationAuthority,
  executionRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-incident-plus'),
  executionId = `incident-plus-${crypto.randomUUID()}`,
  generatedAt = new Date(),
  expiresAt = new Date(generatedAt.getTime() + 6 * 60 * 60 * 1_000),
  signingKeys = generateCoordinatorSigningKeyPair(),
  provenance = currentGitProvenance({ cwd: repoRoot }),
  authorityImplementationHashes = currentAuthorityImplementationHashes({ workspaceRoot: repoRoot }),
  runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot: repoRoot }),
  incidentImplementationHashes = currentIncidentPlusImplementationHashes({ workspaceRoot: repoRoot }),
}) {
  const workers = normalizeIncidentPlusWorkers(workerConfig);
  const assignments = createIncidentPlusAssignments(workers);
  const plan = createIncidentPlusExecutionPlan({
    executionId,
    generatedAt,
    expiresAt,
    provenance,
    authorityImplementationHashes,
    runtimeBinaryHashes,
    incidentImplementationHashes,
    localIsolationAuthority,
    workers,
    assignments,
    signingKeys,
  });
  const leases = issueIncidentPlusCellLeases(plan, signingKeys, { issuedAt: generatedAt });
  const readinessRequests = createIncidentPlusReadinessRequests(plan, signingKeys, { generatedAt });
  const root = path.resolve(executionRoot, executionId);
  if (fs.existsSync(root)) throw new Error(`incident Plus execution root already exists: ${root}`);
  const written = writeIncidentPlusExecutionPlan({
    executionRoot: root,
    plan,
    leases,
    readinessRequests,
  });
  const grantAt = new Date(generatedAt.getTime() + 1_000);
  const reservationAt = new Date(generatedAt.getTime() + 2_000);
  const grant = createIncidentPlusPreflightGrant({
    plan,
    leases,
    generatedAt: grantAt,
    signingKeys,
  });
  const leaseReservations = createIncidentPlusPreflightLeaseReservations({
    grant,
    plan,
    issuedAt: reservationAt,
    signingKeys,
  });
  const preflightAuthorization = writeIncidentPlusPreflightAuthorizationPackage({
    executionRoot: root,
    plan,
    grant,
    leaseReservations,
  });
  return {
    executionRoot: root,
    plan,
    leases,
    readinessRequests,
    grant,
    leaseReservations,
    preflightAuthorization,
    signingKeys,
    ...written,
  };
}

/**
 * Build the Desktop authority binary before writing an execution plan.  The
 * text-only preflight grant is deliberately signed by a fresh coordinator
 * key, and the Desktop verifier only accepts that grant when the same public
 * key identity was compiled into the release binary.  Keeping the build
 * before plan issuance prevents a superficially valid, but unusable, Plus
 * incident authority from ever reaching a Provider call.
 *
 * This remains separate from `prepareIncidentPlusExecution` so fixtures and
 * offline authority tests can inject deterministic inventories without
 * rebuilding native binaries.
 */
export function prepareCurrentIncidentPlusExecution({
  workerConfig,
  localIsolationAuthority,
  executionRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-incident-plus'),
  executionId = `incident-plus-${crypto.randomUUID()}`,
  generatedAt = new Date(),
  expiresAt = new Date(generatedAt.getTime() + 6 * 60 * 60 * 1_000),
  signingKeys = generateCoordinatorSigningKeyPair(),
  buildRuntimeAuthority = buildStrictRuntimeAuthority,
  captureProvenance = () => currentGitProvenance({ cwd: repoRoot }),
  captureAuthorityImplementationHashes = () => currentAuthorityImplementationHashes({ workspaceRoot: repoRoot }),
  captureIncidentImplementationHashes = () => currentIncidentPlusImplementationHashes({ workspaceRoot: repoRoot }),
  environment = process.env,
}) {
  const coordinatorKeyId = coordinatorKeyIdForPublicKey(signingKeys.publicKeyPem);
  const runtimeBinaryHashes = buildRuntimeAuthority({
    environment: {
      ...strictRuntimeEnvironment(environment),
      OMNI_PROVIDER_PREFLIGHT_COORDINATOR_KEY_ID: coordinatorKeyId,
    },
  });
  // The build is a mandatory provenance boundary.  In particular, do not
  // issue leases if a generated package, external edit, or stale checkout
  // made the evidence worktree dirty while compiling the signed runtime.
  const provenance = captureProvenance();
  if (provenance?.worktreeClean !== true || Number(provenance?.dirtyEntryCount) !== 0) {
    throw new Error('incident Plus runtime build changed the evidence worktree; refuse to issue a signed plan');
  }
  return prepareIncidentPlusExecution({
    workerConfig,
    localIsolationAuthority,
    executionRoot,
    executionId,
    generatedAt,
    expiresAt,
    signingKeys,
    provenance,
    authorityImplementationHashes: captureAuthorityImplementationHashes(),
    runtimeBinaryHashes,
    incidentImplementationHashes: captureIncidentImplementationHashes(),
  });
}

const INTERACTIVE_CONTROL = 'scripts/testing/invoke-watch-mode-interactive-task.ps1';
const INTERACTIVE_LAUNCHER = 'scripts/testing/run-watch-mode-interactive-task.ps1';
const INTERACTIVE_PROCESS_COLLECTOR =
  'scripts/testing/collect-watch-mode-interactive-process-authority.ps1';
const INTERACTIVE_ENDPOINT_RUNNER = 'scripts/testing/run-watch-mode-live-shard.mjs';
const INTERACTIVE_INCIDENT_RUNNER = 'scripts/testing/run-watch-mode-incident-plus-cell.mjs';
const INCIDENT_PLUS_PREFLIGHT_FILE = 'incident-plus-preflight.json';
const INCIDENT_PLUS_REMOTE_CELL_TIMEOUT_MS = 650_000;

function lastNonEmptyLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}

function requireRemoteSuccess(result, label) {
  if (Number(result?.exitCode) !== 0) {
    throw new Error(`${label} failed: ${String(result?.stderr ?? '').trim() || String(result?.stdout ?? '').trim() || 'remote command returned no diagnostics'}`);
  }
  return result;
}

function parseRemoteJson(result, label) {
  requireRemoteSuccess(result, label);
  try {
    return JSON.parse(lastNonEmptyLine(result.stdout));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function remotePathForScp(remotePath) {
  return String(remotePath).replaceAll('\\', '/');
}

function remoteSpec(worker, remotePath) {
  return `${worker.user}@${worker.host}:${remotePathForScp(remotePath)}`;
}

function safeRemoteChild(root, candidate, label) {
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) {
    throw new Error(`${label} is outside the incident worker execution root`);
  }
  return relative;
}

function runRemoteProcess(executable, args, {
  cwd = repoRoot,
  signal,
  timeoutMs = 60_000,
  input = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => child.kill('SIGKILL');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (exitCode) => finish(() => resolve({
      exitCode: exitCode ?? 1,
      stdout,
      stderr,
    })));
    timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.once('error', (error) => {
      if (error.code !== 'EPIPE') finish(() => reject(error));
    });
    child.stdin.end(Buffer.from(String(input), 'utf8'));
  });
}

function incidentImplementationHash(plan, relativePath) {
  const entry = plan.authority.incidentImplementationHashes.find((candidate) => (
    candidate.path === relativePath
  ));
  if (!entry || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 ?? ''))) {
    throw new Error(`incident Plus authority is missing ${relativePath}`);
  }
  return entry.sha256;
}

function compatibilityTransportPlan(plan) {
  const orchestrationFiles = [
    INTERACTIVE_CONTROL,
    INTERACTIVE_LAUNCHER,
    INTERACTIVE_PROCESS_COLLECTOR,
    INTERACTIVE_ENDPOINT_RUNNER,
  ];
  return {
    ...plan,
    authority: {
      ...plan.authority,
      shardOrchestrationImplementationHashes: orchestrationFiles.map((relativePath) => {
        const entry = plan.authority.incidentImplementationHashes.find((candidate) => (
          candidate.path === relativePath
        ));
        if (!entry) throw new Error(`incident Plus authority is missing ${relativePath}`);
        return {
          path: relativePath,
          bytes: entry.bytes,
          sha256: incidentImplementationHash(plan, relativePath),
        };
      }),
    },
    // The production readiness helper needs one digest binding its temporary
    // control receipt.  The actual Plus readiness request remains per-worker
    // and is validated separately below; it is never substituted into the
    // strict eight-cell plan or result schema.
    workerReadinessRequest: { requestDigest: plan.planDigest },
  };
}

function requirePlanWorker(config, planWorker) {
  const worker = config.workers.find((entry) => entry.workerId === planWorker.workerId);
  if (!worker) throw new Error(`incident Plus worker configuration is missing ${planWorker.workerId}`);
  return worker;
}

function makeIncidentInteractiveRequest({ plan, worker, cell, lease, remoteRoot, remotePlanPath }) {
  const readinessRequestPath = path.win32.join(
    remoteRoot,
    `worker-readiness-request-${worker.workerId}.json`,
  );
  const readinessPath = path.win32.join(remoteRoot, 'readiness', `${worker.workerId}.json`);
  const request = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-task-request',
    mode: 'incident-plus-cell',
    workspaceRoot: worker.workspaceRoot,
    remoteRoot,
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    workerId: worker.workerId,
    vmIdentityDigest: cell.vmIdentityDigest,
    expectedVmUuidBios: worker.vmIdentity.uuidBios,
    user: worker.user,
    timeoutMs: INCIDENT_PLUS_REMOTE_CELL_TIMEOUT_MS - 30_000,
    controlScriptSha256: incidentImplementationHash(plan, INTERACTIVE_CONTROL),
    launcherSha256: incidentImplementationHash(plan, INTERACTIVE_LAUNCHER),
    processAuthorityCollectorSha256: incidentImplementationHash(plan, INTERACTIVE_PROCESS_COLLECTOR),
    shardRunnerSha256: incidentImplementationHash(plan, INTERACTIVE_INCIDENT_RUNNER),
    expectedCredentialReference: plan.providerIdentity.credentialReference,
    planPath: remotePlanPath,
    planSha256: null,
    leasePath: path.win32.join(remoteRoot, 'leases', `${cell.cellIndex + 1}.json`),
    leaseSha256: null,
    leaseId: lease.leaseId,
    leaseDigest: lease.leaseDigest,
    cellId: cell.cellId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    readinessPath,
    readinessRequestPath,
    ...(cell.feedbackLoopPrevention === 'virtual-driver'
      ? { driverReadinessPath: path.win32.join(remoteRoot, 'readiness', 'zero-provider-readiness.json') }
      : {}),
  };
  return request;
}

/**
 * Execute the signed Plus incident replay on the two configured Windows VMs.
 * The implementation deliberately reuses only the no-provider driver/session
 * preparation primitive from the strict coordinator.  Its plan, leases,
 * preflight grant, result writer, manifest, and verifier all stay Plus-only.
 */
export async function runIncidentPlusProductionCoordinator({
  workerConfig,
  localIsolationAuthority,
  executionRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-incident-plus'),
  executionId = `incident-plus-${crypto.randomUUID()}`,
  now = () => new Date(),
  operations = {},
}) {
  const config = typeof workerConfig === 'string'
    ? readProductionWorkerConfig(workerConfig)
    : validateProductionWorkerConfig(workerConfig, { configDirectory: repoRoot });
  if (config.workers.length !== 2) {
    throw new Error('Plus incident replay requires exactly two configured VM workers');
  }
  const generatedAt = now();
  const preparation = await (operations.prepareExecution ?? ((options) => prepareCurrentIncidentPlusExecution(options)))({
    workerConfig: config,
    localIsolationAuthority,
    executionRoot,
    executionId,
    generatedAt,
    expiresAt: new Date(generatedAt.getTime() + 6 * 60 * 60 * 1_000),
  });
  const { plan, leases, readinessRequests, signingKeys } = preparation;
  const root = preparation.executionRoot;
  const requestByWorker = new Map(readinessRequests.map((request) => [request.workerId, request]));
  const planPath = path.resolve(preparation.planPath);
  const leasePaths = preparation.leasePaths;
  const compatibilityPlan = compatibilityTransportPlan(plan);
  const prepareTransport = operations.createPreparationTransport ?? ((options) => (
    createSshProductionTransport(options)
  ));
  const compatibilityTransport = await prepareTransport({
    config,
    plan: compatibilityPlan,
    planPath,
    leasePaths,
    coordinatorExecutionRoot: root,
  });

  const runProcess = operations.runProcess ?? runRemoteProcess;
  const remoteRoots = new Map(config.workers.map((worker) => [
    worker.workerId,
    path.win32.join(worker.guestExecutionRoot, plan.executionId, worker.workerId),
  ]));
  const remote = async (worker, body, payload, options = {}) => {
    const invocation = remotePowerShellInvocation(body, payload);
    return runProcess(config.sshExecutable, [
      ...sshBaseArgs(worker),
      `${worker.user}@${worker.host}`,
      ...invocation.args,
    ], { ...options, input: invocation.input });
  };
  const upload = async (worker, localPath, remotePath, options = {}) => {
    const result = await runProcess(config.scpExecutable, [
      ...scpBaseArgs(worker), localPath, remoteSpec(worker, remotePath),
    ], options);
    return requireRemoteSuccess(result, `upload to ${worker.workerId}`);
  };
  const download = async (worker, remotePath, localDirectory, options = {}) => {
    fs.mkdirSync(localDirectory, { recursive: true });
    const result = await runProcess(config.scpExecutable, [
      ...scpBaseArgs(worker), '-r', remoteSpec(worker, remotePath), localDirectory,
    ], options);
    return requireRemoteSuccess(result, `download from ${worker.workerId}`);
  };

  const prepareWorkers = operations.prepareWorkers ?? (async () => {
    const completed = await Promise.all(plan.workers.map(async (planWorker) => {
      const worker = requirePlanWorker(config, planWorker);
      const prepared = await compatibilityTransport.prepareWorker({ worker: planWorker });
      const remoteRoot = remoteRoots.get(worker.workerId);
      const readinessRequest = requestByWorker.get(worker.workerId);
      const localRequestPath = path.join(root, `worker-readiness-request-${worker.workerId}.json`);
      const remoteRequestPath = path.win32.join(remoteRoot, path.basename(localRequestPath));
      await upload(worker, localRequestPath, remoteRequestPath, { timeoutMs: 60_000 });
      const plusReadiness = parseRemoteJson(await remote(worker, String.raw`
$strictPath = Join-Path ([string]$payload.remoteRoot) 'readiness\zero-provider-readiness.json'
$target = [IO.Path]::GetFullPath([string]$payload.targetPath)
if (-not (Test-Path -LiteralPath $strictPath -PathType Leaf)) { throw 'compatibility zero-provider readiness is missing' }
if (Test-Path -LiteralPath $target -PathType Leaf) { throw 'incident Plus readiness already exists' }
$strict = Get-Content -LiteralPath $strictPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (
  $strict.executionId -ne [string]$payload.executionId -or
  $strict.workerId -ne [string]$payload.workerId -or
  $strict.vmIdentityDigest -ne [string]$payload.vmIdentityDigest -or
  [int]$strict.providerCalls -ne 0 -or
  [int]$strict.interactiveSession.sessionId -ne 1 -or
  $strict.credentialStatus.exists -ne $true
) { throw 'compatibility readiness does not bind this incident worker/session' }
$receipt = [ordered]@{
  schemaVersion = 1
  artifactKind = 'watch-mode-incident-plus-worker-zero-provider-readiness'
  incidentId = [string]$payload.incidentId
  generatedAt = [DateTime]::UtcNow.ToString('o')
  executionId = [string]$payload.executionId
  planDigest = [string]$payload.planDigest
  requestDigest = [string]$payload.requestDigest
  workerId = [string]$payload.workerId
  vmIdentityDigest = [string]$payload.vmIdentityDigest
  sourceHeadCommit = [string]$payload.sourceHeadCommit
  runtimeBundleDigest = [string]$payload.runtimeBundleDigest
  providerCalls = 0
  externalAudioSamples = 0
  interactiveSession = [ordered]@{ ready = $true; sessionId = 1 }
  credentials = [ordered]@{
    providerId = 'provider-dashscope'
    reference = 'credential://provider/dashscope/default'
    visible = $true
  }
  bridgeSource = [ordered]@{ ready = $true }
  virtualDriver = [ordered]@{ required = [bool]$payload.virtualDriverRequired; ready = [bool]$payload.virtualDriverRequired }
  processExclusion = [ordered]@{ ready = [bool]$payload.processExclusionRequired }
  echoCancel = [ordered]@{ ready = [bool]$payload.echoCancelRequired }
  profiles = @($payload.profiles)
}
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
[IO.File]::WriteAllText($target, (($receipt | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 12 -Compress
`, {
        remoteRoot,
        targetPath: path.win32.join(remoteRoot, 'readiness', `${worker.workerId}.json`),
        incidentId: plan.incidentId,
        executionId: plan.executionId,
        planDigest: plan.planDigest,
        requestDigest: readinessRequest.requestDigest,
        workerId: worker.workerId,
        vmIdentityDigest: planWorker.vmIdentityDigest,
        sourceHeadCommit: plan.provenance.headCommit,
        runtimeBundleDigest: plan.authority.runtimeBundleDigest,
        profiles: planWorker.deviceProfileInstances,
        virtualDriverRequired: readinessRequest.assignedCells.some((cell) => cell.feedbackLoopPrevention === 'virtual-driver'),
        processExclusionRequired: readinessRequest.assignedCells.some((cell) => cell.feedbackLoopPrevention === 'process-exclusion'),
        echoCancelRequired: readinessRequest.assignedCells.some((cell) => cell.feedbackLoopPrevention === 'echo-cancel'),
      }, { timeoutMs: 120_000 }), `worker ${worker.workerId} Plus zero-provider readiness`);
      const localReadinessDirectory = path.join(root, 'readiness');
      await download(
        worker,
        path.win32.join(remoteRoot, 'readiness', `${worker.workerId}.json`),
        localReadinessDirectory,
        { timeoutMs: 60_000 },
      );
      return { workerId: worker.workerId, readiness: plusReadiness };
    }));
    return completed;
  });
  const workerReadiness = await prepareWorkers();
  if (!Array.isArray(workerReadiness) || workerReadiness.length !== plan.workers.length) {
    throw new Error('incident Plus worker preparation did not return both zero-provider readiness receipts');
  }

  const runPreflight = operations.runPreflight ?? (() => {
    const raw = runStrictProviderPreflight({
      providerId: plan.providerIdentity.providerId,
      provenance: plan.provenance,
      environment: {
        ...strictRuntimeEnvironment(process.env),
        [PROVIDER_PREFLIGHT_GRANT_PATH_ENV]: preparation.preflightAuthorization.grantPath,
        [PROVIDER_PREFLIGHT_RESERVATION_DIRECTORY_ENV]: preparation.preflightAuthorization.reservationDirectory,
        [PROVIDER_PREFLIGHT_AUTHORIZATION_DIGEST_ENV]: preparation.preflightAuthorization.authorizationDigest,
      },
    });
    const evidenceDirectory = path.join(root, 'preflight-evidence');
    if (fs.existsSync(evidenceDirectory)) throw new Error('incident Plus preflight evidence directory already exists');
    fs.cpSync(raw.outputDirectory, evidenceDirectory, { recursive: true, errorOnExist: true });
    const preflight = createIncidentPlusPreflightCompletion({
      plan,
      leases,
      grant: preparation.grant,
      leaseReservations: preparation.leaseReservations,
      evidenceDirectory,
      authorizationRoot: preparation.preflightAuthorization.authorizationRoot,
      completedAt: now(),
      signingKeys,
    });
    const preflightPath = path.join(root, INCIDENT_PLUS_PREFLIGHT_FILE);
    atomicWriteJson(preflightPath, preflight);
    return { preflight, preflightPath };
  });
  const preflightOutcome = await runPreflight();
  if (!preflightOutcome?.preflight) throw new Error('incident Plus text-only preflight did not produce a signed completion');

  const dispatchCell = operations.dispatchCell ?? (async ({ cell, lease, signal }) => {
    const worker = requirePlanWorker(config, plan.workers.find((entry) => entry.workerId === cell.workerId));
    const remoteRoot = remoteRoots.get(worker.workerId);
    const leasePath = leasePaths[cell.cellIndex];
    const remoteLeasePath = path.win32.join(remoteRoot, 'leases', `${cell.cellIndex + 1}.json`);
    await upload(worker, leasePath, remoteLeasePath, { signal, timeoutMs: 60_000 });
    const interactiveRequest = makeIncidentInteractiveRequest({
      plan,
      worker,
      cell,
      lease,
      remoteRoot,
      remotePlanPath: path.win32.join(remoteRoot, 'shard-execution-plan.json'),
    });
    // Hash the coordinator-copied exact bytes just before the InteractiveToken
    // task is registered.  The control script independently hashes both files
    // again before it permits the Plus Node runner to read them.
    const hash = (candidate) => crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
    interactiveRequest.planSha256 = hash(planPath);
    interactiveRequest.leaseSha256 = hash(leasePath);
    const response = parseRemoteJson(await remote(worker, PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY, {
      workspaceRoot: worker.workspaceRoot,
      controlScriptSha256: interactiveRequest.controlScriptSha256,
      interactiveRequest,
    }, { signal, timeoutMs: INCIDENT_PLUS_REMOTE_CELL_TIMEOUT_MS }), `incident Plus cell ${cell.cellId}`);
    if (
      response.terminal?.leaseId !== lease.leaseId
      || Number(response.terminal?.exitCode) !== 0
      || Number(response.terminal?.processAuthorityExitCode) !== 0
      || Number(response.taskTerminal?.lastTaskResult) !== 0
      || Number(response.terminal?.sessionId) !== 1
    ) throw new Error(`incident Plus cell ${cell.cellId} did not finish in the signed interactive session`);
    const remoteResultPath = String(response.finalResultPath ?? '');
    const remoteRunDirectory = path.win32.dirname(remoteResultPath);
    safeRemoteChild(remoteRoot, remoteRunDirectory, `incident Plus cell ${cell.cellId} result`);
    const localCellParent = path.join(root, 'runs', `c${String(cell.cellIndex + 1).padStart(2, '0')}`);
    await download(worker, remoteRunDirectory, localCellParent, { timeoutMs: 300_000 });
    const localRunDirectory = path.join(localCellParent, path.win32.basename(remoteRunDirectory));
    const resultPath = path.join(localRunDirectory, 'incident-plus-cell-result.json');
    const readinessReceiptPath = path.join(root, 'readiness', `${worker.workerId}.json`);
    const validated = validateIncidentPlusCellResult({
      resultPath,
      plan,
      lease,
      executionRoot: root,
      readinessReceiptPath,
      readinessRequest: requestByWorker.get(worker.workerId),
      now: now(),
    });
    return { ...validated, resultPath, remoteResultPath };
  });
  const cancelCell = operations.cancelCell ?? ((context) => compatibilityTransport.cancelCell(context));
  const results = new Map();
  for (const wave of plan.waves) {
    const entries = wave.cellIds.map((cellId) => {
      const cell = plan.cells.find((candidate) => candidate.cellId === cellId);
      const lease = leases.find((candidate) => candidate.leaseId === cell.leaseId);
      return { cell, lease };
    });
    let firstFailure = null;
    const outcomes = await Promise.all(entries.map(async (entry) => {
      try {
        const outcome = await dispatchCell(entry);
        results.set(entry.cell.cellId, outcome);
        return outcome;
      } catch (error) {
        if (!firstFailure) {
          firstFailure = error;
          await Promise.all(entries.filter((candidate) => candidate.lease.leaseId !== entry.lease.leaseId)
            .map((candidate) => Promise.resolve(cancelCell(candidate)).catch(() => {})));
        }
        throw error;
      }
    }));
    if (firstFailure) throw firstFailure;
    if (outcomes.length !== entries.length) throw new Error(`incident Plus wave ${wave.waveIndex} has incomplete results`);
  }
  const resultPaths = plan.cells.map((cell) => results.get(cell.cellId)?.resultPath);
  if (resultPaths.some((entry) => !entry)) throw new Error('incident Plus execution did not produce all three cell results');
  const readinessReceiptPaths = plan.workers.map((worker) => path.join(root, 'readiness', `${worker.workerId}.json`));
  const writeManifest = operations.writeManifest ?? writeIncidentPlusManifest;
  const manifest = writeManifest({
    plan,
    leases,
    preflight: preflightOutcome.preflight,
    executionRoot: root,
    resultPaths,
    readinessReceiptPaths,
    readinessRequests,
    generatedAt: now(),
    signingKeys,
  });
  const writeVerification = operations.writeVerification ?? writeIncidentPlusVerificationReceipt;
  const verification = writeVerification({
    manifestPath: manifest.manifestPath,
    plan,
    leases,
    executionRoot: root,
    readinessReceiptPaths,
    readinessRequests,
    generatedAt: now(),
    signingKeys,
  });
  return {
    executionId: plan.executionId,
    executionRoot: root,
    planPath,
    preflightPath: preflightOutcome.preflightPath,
    manifestPath: manifest.manifestPath,
    verificationReceiptPath: verification.receiptPath,
  };
}

export function parseIncidentPlusCliArgs(argv) {
  return parseCliArgs(argv, {
    booleans: ['dispatch'],
    defaults: {
      workersConfig: '',
      localIsolationAuthority: '',
      executionRoot: 'artifacts/testing/watch-mode-incident-plus',
      executionId: '',
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    const options = parseIncidentPlusCliArgs(process.argv.slice(2));
    if (!options.workersConfig) throw new Error('--workers-config is required');
    if (!options.localIsolationAuthority) throw new Error('--local-isolation-authority is required');
    const workers = readRegularJson(path.resolve(repoRoot, options.workersConfig), 'incident Plus worker config');
    const localIsolationAuthority = readRegularJson(
      path.resolve(repoRoot, options.localIsolationAuthority),
      'incident Plus local isolation authority',
    );
    if (options.dispatch) {
      const result = await runIncidentPlusProductionCoordinator({
        workerConfig: path.resolve(repoRoot, options.workersConfig),
        localIsolationAuthority,
        executionRoot: path.resolve(repoRoot, options.executionRoot),
        ...(options.executionId ? { executionId: options.executionId } : {}),
      });
      console.log(result.verificationReceiptPath);
    } else {
      const result = prepareCurrentIncidentPlusExecution({
        workerConfig: workers,
        localIsolationAuthority,
        executionRoot: path.resolve(repoRoot, options.executionRoot),
        ...(options.executionId ? { executionId: options.executionId } : {}),
      });
      console.log(result.planPath);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
