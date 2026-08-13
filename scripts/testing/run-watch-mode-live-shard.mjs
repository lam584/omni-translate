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
  SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_CELL_RESULT_FILE,
  SHARD_INPUT_SAMPLE_RATE_HZ,
  SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE,
  SHARD_INTERACTIVE_COMMAND_FILE,
  SHARD_INTERACTIVE_LAUNCH_FILE,
  SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE,
  SHARD_INTERACTIVE_TERMINAL_FILE,
  SHARD_INTERACTIVE_TASK_TERMINAL_FILE,
  SHARD_INTERACTIVE_CLAIM_RELEASE_FILE,
  SHARD_INTERACTIVE_CELL_EXECUTION_FILE,
  SHARD_WORKER_READINESS_FILE,
  atomicWriteJson,
  currentShardOrchestrationImplementationHashes,
  validateShardCellResult,
  validateInteractiveSessionAuthority,
  validateInteractiveLaunchAuthority,
  validateWorkerZeroProviderReadinessAuthority,
  verifyCellLease,
  verifySignedExecutionPlan,
  writeShardCellResult,
  writeShardManifest,
} from './watch-mode-shard-authority.mjs';

export const SHARD_WORKER_RUNNER_ID = 'scripts/testing/run-watch-mode-live-shard.mjs';
export const SHARD_LEASE_CLAIM_KIND = 'watch-mode-paid-shard-lease-claim';
export const SHARD_LEASE_TERMINAL_KIND = 'watch-mode-paid-shard-lease-terminal';
export const SHARD_WORKER_TIMEOUT_MS = 578_000;
export const SHARD_LIVE_RUNNER_SCRIPT = path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.ps1');

const WATCH_PROTOCOLS = Object.freeze({
  'qwen3.5-omni-flash-realtime': 'dashscope-omni',
  'qwen3.5-livetranslate-flash-realtime': 'dashscope-livetranslate',
});

const sanitizeCellId = (cellId) => String(cellId).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');

const INTERACTIVE_EXECUTION_KIND = 'watch-mode-interactive-shard-cell-execution';

function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

async function waitForRegularFile(filePath, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isFile() && !stats.isSymbolicLink() && stats.size > 0) return path.resolve(filePath);
    } catch {
      // The interactive launcher creates the authority only after it has the
      // exact Node PID/start-time. The Node cannot claim a lease before this.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`${label} was not published before the lease-claim deadline`);
}

function currentWindowsProcessIdentity() {
  if (process.platform !== 'win32') {
    throw new Error('production interactive shard identity is only available on Windows');
  }
  // Windows PowerShell 5.1 does not reliably expose trailing native argv in
  // $args when powershell.exe is invoked with -Command. process.pid is an
  // integer owned by this process, so embed its decimal representation in the
  // fixed script instead of depending on that ambiguous command-line boundary.
  const processId = Number(process.pid);
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${processId}' -ErrorAction Stop`,
    '$o=Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop',
    '$s=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop',
    `$g=Get-Process -Id ${processId} -ErrorAction Stop`,
    "$h=(Get-FileHash -LiteralPath ([string]$p.ExecutablePath) -Algorithm SHA256).Hash.ToLowerInvariant()",
    '[ordered]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;sessionId=[int]$p.SessionId;imagePath=[IO.Path]::GetFullPath([string]$p.ExecutablePath);imageSha256=$h;startedAt=$g.StartTime.ToUniversalTime().ToString(\'o\');ownerUser=[string]$o.User;ownerDomain=[string]$o.Domain;ownerSid=[string]$s.Sid}|ConvertTo-Json -Compress',
  ].join(';');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`failed to inspect interactive shard Node identity: ${result.stderr || result.error?.message}`);
  }
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

export function shardAuthoritySnapshot({ workspaceRoot = repoRoot } = {}) {
  return {
    provenance: currentGitProvenance({ cwd: workspaceRoot }),
    authorityImplementationHashes: currentAuthorityImplementationHashes({ workspaceRoot }),
    runtimeBinaryHashes: currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
    shardOrchestrationImplementationHashes: currentShardOrchestrationImplementationHashes({ workspaceRoot }),
  };
}

export function assertShardWorkerAuthority(plan, snapshot, { now = new Date() } = {}) {
  return verifySignedExecutionPlan(plan, {
    now,
    currentProvenance: snapshot.provenance,
    currentAuthorityImplementationHashes: snapshot.authorityImplementationHashes,
    currentRuntimeBinaryHashes: snapshot.runtimeBinaryHashes,
    currentShardImplementationHashes: snapshot.shardOrchestrationImplementationHashes,
  });
}

export function buildShardCellExecutionRequest({
  plan,
  lease,
  workerId,
  vmIdentity,
  shardRoot,
  now = new Date(),
}) {
  const cell = verifyCellLease(lease, plan, { now });
  const worker = plan.workers.find((candidate) => candidate.workerId === workerId);
  if (!worker || cell.workerId !== workerId) throw new Error('signed cell lease is assigned to another worker');
  if (JSON.stringify(worker.vmIdentity) !== JSON.stringify(vmIdentity)) {
    throw new Error('current VM identity does not match the signed cell lease');
  }
  const cellOutputRoot = path.join(
    path.resolve(shardRoot),
    'runs',
    // Keep the guest path below the legacy Win32 MAX_PATH boundary. The
    // signed cellId remains in the lease, environment, receipts, and final
    // manifest; repeating it in this directory made the longest required
    // artifact names unwriteable on otherwise valid Windows guests.
    `c${String(cell.cellIndex + 1).padStart(2, '0')}`,
  );
  const profile = cell.deviceProfileInstance;
  const protocol = WATCH_PROTOCOLS[cell.modelId];
  if (!protocol) throw new Error(`no production realtime protocol is defined for ${cell.modelId}`);
  return {
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseDigest: lease.leaseDigest,
    leaseId: lease.leaseId,
    workerId,
    vmIdentityDigest: worker.vmIdentityDigest,
    cell,
    cellOutputRoot,
    runnerOptions: {
      outputRoot: cellOutputRoot,
      mediaPath: path.join(repoRoot, 'scripts', 'testing', 'fixtures', 'watch-mode-en-original.wav'),
      warmupSeconds: 12,
      model: cell.modelId,
      watchRealtimeProtocol: protocol,
      subtitleTranslationMode: 'native',
      playbackSeconds: 0,
      postPlaybackWaitSeconds: 120,
      sessionReadyTimeoutSeconds: 90,
      watchAutoStopAfterSeconds: 180,
      physicalPlaybackDeviceId: profile.physicalPlaybackDeviceId,
      physicalPlaybackDeviceClass: profile.deviceClass,
      physicalPlaybackDeviceProfileId: profile.profileId,
      expectedPhysicalPlaybackDeviceName: profile.expectedPhysicalPlaybackDeviceName,
      feedbackMode: cell.feedbackLoopPrevention,
      strictPaidAuthority: true,
      matrixCellId: cell.cellId,
      readinessReceiptPath: null,
    },
    environment: {
      OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY: '1',
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID: plan.providerIdentity.providerId,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID: plan.providerIdentity.templateId,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND: plan.providerIdentity.providerKind,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST: plan.providerIdentity.endpointHost,
      OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE:
        plan.providerIdentity.credentialReference,
      OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID: lease.leaseId,
      OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES: String(SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES),
      OMNI_WATCH_MODE_CELL_ID: cell.cellId,
      OMNI_SHARD_EXECUTION_ID: plan.executionId,
      OMNI_SHARD_PLAN_DIGEST: plan.planDigest,
      OMNI_SHARD_LEASE_DIGEST: lease.leaseDigest,
      OMNI_SHARD_WORKER_ID: workerId,
      OMNI_SHARD_VM_IDENTITY_DIGEST: worker.vmIdentityDigest,
      OMNI_SHARD_INPUT_SAMPLE_RATE_HZ: String(SHARD_INPUT_SAMPLE_RATE_HZ),
    },
  };
}

export function buildPowerShellRunnerArgv(request) {
  const options = request.runnerOptions;
  const argv = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', SHARD_LIVE_RUNNER_SCRIPT,
    '-OutputRoot', options.outputRoot,
    '-MediaPath', options.mediaPath,
    '-WarmupSeconds', String(options.warmupSeconds),
    '-WatchModelId', options.model,
    '-WatchRealtimeProtocol', options.watchRealtimeProtocol,
    '-SubtitleTranslationMode', options.subtitleTranslationMode,
    '-PlaybackSeconds', String(options.playbackSeconds),
    '-PostPlaybackWaitSeconds', String(options.postPlaybackWaitSeconds),
    '-SessionReadyTimeoutSeconds', String(options.sessionReadyTimeoutSeconds),
    '-WatchAutoStopAfterSeconds', String(options.watchAutoStopAfterSeconds),
    '-PhysicalPlaybackDeviceId', options.physicalPlaybackDeviceId,
    '-PhysicalPlaybackDeviceClass', options.physicalPlaybackDeviceClass,
    '-PhysicalPlaybackDeviceProfileId', options.physicalPlaybackDeviceProfileId,
    '-FeedbackLoopPrevention', options.feedbackMode,
    '-ExpectedPhysicalPlaybackDeviceName', options.expectedPhysicalPlaybackDeviceName,
    '-StrictPaidAuthority',
    '-MatrixCellId', options.matrixCellId,
  ];
  if (options.readinessReceiptPath) {
    argv.push('-WorkerReadinessReceiptPath', options.readinessReceiptPath);
  }
  return argv;
}

function lastExistingRunDirectory(text, rootDirectory) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const candidate = path.isAbsolute(line) ? line : path.resolve(rootDirectory, line);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

export function executePowerShellShardCell(request, {
  signal,
  environment = process.env,
  timeoutMs = SHARD_WORKER_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', buildPowerShellRunnerArgv(request), {
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

function leaseClaimPath(shardRoot, leaseId) {
  return path.join(path.resolve(shardRoot), 'lease-claims', `${leaseId}.json`);
}

function leaseTerminalPath(shardRoot, leaseId) {
  return path.join(path.resolve(shardRoot), 'lease-terminals', `${leaseId}.json`);
}

function claimLease({ plan, lease, workerId, shardRoot, now }) {
  const claim = {
    schemaVersion: 1,
    artifactKind: SHARD_LEASE_CLAIM_KIND,
    claimedAt: now.toISOString(),
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseId: lease.leaseId,
    leaseDigest: lease.leaseDigest,
    cellId: lease.cellId,
    workerId,
    waveIndex: lease.waveIndex,
    retryPolicy: 'new-execution-required',
  };
  const claimPath = leaseClaimPath(shardRoot, lease.leaseId);
  atomicWriteJson(claimPath, claim);
  return { claimPath, claim };
}

function writeLeaseTerminal({ plan, lease, workerId, shardRoot, status, now, resultPath = null, error = null }) {
  const terminal = {
    schemaVersion: 1,
    artifactKind: SHARD_LEASE_TERMINAL_KIND,
    terminalAt: now.toISOString(),
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseId: lease.leaseId,
    leaseDigest: lease.leaseDigest,
    cellId: lease.cellId,
    workerId,
    status,
    ...(resultPath ? { resultPath: path.resolve(resultPath) } : {}),
    ...(error ? { error: String(error) } : {}),
  };
  const terminalPath = leaseTerminalPath(shardRoot, lease.leaseId);
  if (!fs.existsSync(terminalPath)) atomicWriteJson(terminalPath, terminal);
  return { terminalPath, terminal };
}

export async function runLeasedShardCell({
  plan,
  lease,
  workerId,
  vmIdentity,
  shardRoot,
  authoritySnapshot,
  readAuthoritySnapshot = () => authoritySnapshot,
  readinessReceiptPath = null,
  interactiveCommandPath = null,
  interactiveLaunchAuthorityPath = null,
  interactiveReleasePath = null,
  interactiveExecutionReceiptPath = null,
  executeCell = executePowerShellShardCell,
  signal,
  now = () => new Date(),
}) {
  const startedAt = now();
  assertShardWorkerAuthority(plan, authoritySnapshot, { now: startedAt });
  const cell = verifyCellLease(lease, plan, { now: startedAt });
  if (cell.workerId !== workerId) throw new Error(`cell ${cell.cellId} is not assigned to worker ${workerId}`);
  const request = buildShardCellExecutionRequest({
    plan,
    lease,
    workerId,
    vmIdentity,
    shardRoot,
    now: startedAt,
  });
  let checkedReadinessSource = null;
  if (plan.workerReadinessRequest) {
    if (!String(readinessReceiptPath ?? '').trim()) {
      throw new Error('signed production shard requires a zero-provider worker readiness receipt');
    }
    checkedReadinessSource = path.resolve(readinessReceiptPath);
    validateWorkerZeroProviderReadinessAuthority({
      receiptPath: checkedReadinessSource,
      plan,
      workerId,
      now: startedAt,
      authorityPath: path.basename(checkedReadinessSource),
    });
    request.runnerOptions.readinessReceiptPath = checkedReadinessSource;
    if (!String(interactiveLaunchAuthorityPath ?? '').trim()) {
      throw new Error('signed production shard requires interactive launch authority before lease claim');
    }
    if (interactiveCommandPath) {
      if (!interactiveReleasePath || !interactiveExecutionReceiptPath) {
        throw new Error('production interactive shard requires claim release/execution receipt paths');
      }
      await waitForRegularFile(interactiveLaunchAuthorityPath, 'interactive launch authority');
      await waitForRegularFile(interactiveReleasePath, 'interactive claim release');
      validateInteractiveLaunchAuthority({
        commandPath: path.resolve(interactiveCommandPath),
        launchPath: path.resolve(interactiveLaunchAuthorityPath),
        releasePath: path.resolve(interactiveReleasePath),
        plan,
        lease,
        worker: plan.workers.find((entry) => entry.workerId === workerId),
        currentProcess: currentWindowsProcessIdentity(),
      });
    } else {
      validateInteractiveSessionAuthority({
        authorityPath: path.resolve(interactiveLaunchAuthorityPath),
        lease,
        worker: plan.workers.find((entry) => entry.workerId === workerId),
      });
    }
  }
  claimLease({ plan, lease, workerId, shardRoot, now: startedAt });
  try {
    const execution = await executeCell(request, { signal });
    if (Number(execution?.exitCode) !== 0) {
      throw new Error(`paid shard cell ${cell.cellId} exited with ${execution?.exitCode ?? 'no exit code'}`);
    }
    if (!execution.runDirectory) throw new Error(`paid shard cell ${cell.cellId} returned no run directory`);
    const runDirectory = path.resolve(execution.runDirectory);
    const relative = path.relative(path.resolve(request.cellOutputRoot), runDirectory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`paid shard cell ${cell.cellId} run directory is outside its isolated output root`);
    }
    if (fs.existsSync(path.join(runDirectory, SHARD_CELL_RESULT_FILE))) {
      throw new Error(`paid shard cell ${cell.cellId} already has a shard result`);
    }
    const completedAt = now();
    if (interactiveExecutionReceiptPath) {
      const runDirectoryRelative = path.relative(path.resolve(shardRoot), runDirectory)
        .split(path.sep).join('/');
      if (!runDirectoryRelative || runDirectoryRelative.startsWith('../')) {
        throw new Error('interactive shard run directory is outside the guest shard root');
      }
      const executionReceipt = {
        schemaVersion: 1,
        artifactKind: INTERACTIVE_EXECUTION_KIND,
        completedAt: completedAt.toISOString(),
        executionId: plan.executionId,
        planDigest: plan.planDigest,
        leaseId: lease.leaseId,
        leaseDigest: lease.leaseDigest,
        cellId: lease.cellId,
        workerId,
        vmIdentityDigest: request.vmIdentityDigest,
        runDirectory: runDirectoryRelative,
        exitCode: Number(execution.exitCode),
      };
      atomicWriteJson(path.resolve(interactiveExecutionReceiptPath), executionReceipt);
      return {
        request,
        execution,
        resultPath: path.resolve(interactiveExecutionReceiptPath),
        executionReceipt,
      };
    }
    if (checkedReadinessSource) {
      const readinessDestination = path.join(runDirectory, SHARD_WORKER_READINESS_FILE);
      fs.copyFileSync(checkedReadinessSource, readinessDestination, fs.constants.COPYFILE_EXCL);
      validateWorkerZeroProviderReadinessAuthority({
        receiptPath: readinessDestination,
        plan,
        workerId,
        now: completedAt,
      });
      const interactiveDestination = path.join(runDirectory, SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE);
      fs.copyFileSync(
        path.resolve(interactiveLaunchAuthorityPath),
        interactiveDestination,
        fs.constants.COPYFILE_EXCL,
      );
      validateInteractiveSessionAuthority({
        authorityPath: interactiveDestination,
        plan,
        lease,
        worker: plan.workers.find((entry) => entry.workerId === workerId),
      });
    }
    const completionSnapshot = readAuthoritySnapshot();
    assertShardWorkerAuthority(plan, completionSnapshot, { now: completedAt });
    const { resultPath, result } = writeShardCellResult({
      plan,
      lease,
      workerId,
      vmIdentity,
      shardRoot,
      runDirectory,
      provenance: completionSnapshot.provenance,
      authorityImplementationHashes: completionSnapshot.authorityImplementationHashes,
      runtimeBinaryHashes: completionSnapshot.runtimeBinaryHashes,
      shardOrchestrationImplementationHashes: completionSnapshot.shardOrchestrationImplementationHashes,
      generatedAt: completedAt,
    });
    validateShardCellResult({
      resultPath,
      plan,
      lease,
      shardRoot,
      now: completedAt,
      currentProvenance: completionSnapshot.provenance,
      currentAuthorityImplementationHashes: completionSnapshot.authorityImplementationHashes,
      currentRuntimeBinaryHashes: completionSnapshot.runtimeBinaryHashes,
      currentShardImplementationHashes: completionSnapshot.shardOrchestrationImplementationHashes,
    });
    const terminal = writeLeaseTerminal({
      plan,
      lease,
      workerId,
      shardRoot,
      status: 'passed',
      now: completedAt,
      resultPath,
    });
    return { request, execution, resultPath, result, ...terminal };
  } catch (error) {
    writeLeaseTerminal({
      plan,
      lease,
      workerId,
      shardRoot,
      status: signal?.aborted ? 'cancelled' : 'failed',
      now: now(),
      error: error?.message ?? error,
    });
    throw error;
  }
}

function copyInteractiveArtifact(sourcePath, runDirectory, destinationName, label) {
  const source = path.resolve(sourcePath);
  const stats = fs.lstatSync(source);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file`);
  }
  const destination = path.join(runDirectory, destinationName);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

export function finalizeInteractiveShardCell({
  plan,
  lease,
  workerId,
  vmIdentity,
  shardRoot,
  executionReceiptPath,
  readinessReceiptPath,
  commandPath,
  launchPath,
  releasePath,
  processAuthorityPath,
  terminalPath,
  taskTerminalPath,
  authoritySnapshot = shardAuthoritySnapshot(),
  generatedAt = new Date(),
}) {
  assertShardWorkerAuthority(plan, authoritySnapshot, { now: generatedAt });
  const cell = verifyCellLease(lease, plan, { now: generatedAt });
  const worker = plan.workers.find((entry) => entry.workerId === workerId);
  if (!worker || cell.workerId !== workerId || JSON.stringify(worker.vmIdentity) !== JSON.stringify(vmIdentity)) {
    throw new Error('interactive cell finalizer worker/VM identity does not match the signed lease');
  }
  const execution = readRegularJson(executionReceiptPath, 'interactive cell execution receipt');
  if (
    execution.schemaVersion !== 1
    || execution.artifactKind !== INTERACTIVE_EXECUTION_KIND
    || execution.executionId !== plan.executionId
    || execution.planDigest !== plan.planDigest
    || execution.leaseId !== lease.leaseId
    || execution.leaseDigest !== lease.leaseDigest
    || execution.cellId !== lease.cellId
    || execution.workerId !== workerId
    || execution.vmIdentityDigest !== worker.vmIdentityDigest
    || Number(execution.exitCode) !== 0
  ) throw new Error('interactive cell execution receipt identity/status mismatch');
  const resolvedShardRoot = path.resolve(shardRoot);
  const runDirectory = path.resolve(resolvedShardRoot, ...String(execution.runDirectory).split('/'));
  const relative = path.relative(resolvedShardRoot, runDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('interactive cell execution run directory is outside its shard root');
  }
  if (fs.existsSync(path.join(runDirectory, SHARD_CELL_RESULT_FILE))) {
    throw new Error('interactive cell result was already finalized');
  }
  const readinessDestination = copyInteractiveArtifact(
    readinessReceiptPath,
    runDirectory,
    SHARD_WORKER_READINESS_FILE,
    'worker readiness receipt',
  );
  validateWorkerZeroProviderReadinessAuthority({
    receiptPath: readinessDestination,
    plan,
    workerId,
    now: generatedAt,
  });
  const destinations = {
    commandPath: copyInteractiveArtifact(
      commandPath, runDirectory, SHARD_INTERACTIVE_COMMAND_FILE, 'interactive command',
    ),
    launchPath: copyInteractiveArtifact(
      launchPath, runDirectory, SHARD_INTERACTIVE_LAUNCH_FILE, 'interactive launch',
    ),
    releasePath: copyInteractiveArtifact(
      releasePath, runDirectory, SHARD_INTERACTIVE_CLAIM_RELEASE_FILE, 'interactive claim release',
    ),
    processAuthorityPath: copyInteractiveArtifact(
      processAuthorityPath,
      runDirectory,
      SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE,
      'interactive process authority',
    ),
    terminalPath: copyInteractiveArtifact(
      terminalPath, runDirectory, SHARD_INTERACTIVE_TERMINAL_FILE, 'interactive terminal',
    ),
    taskTerminalPath: copyInteractiveArtifact(
      taskTerminalPath,
      runDirectory,
      SHARD_INTERACTIVE_TASK_TERMINAL_FILE,
      'interactive task terminal',
    ),
  };
  const executionDestination = copyInteractiveArtifact(
    executionReceiptPath,
    runDirectory,
    SHARD_INTERACTIVE_CELL_EXECUTION_FILE,
    'interactive cell execution receipt',
  );
  const interactive = validateInteractiveSessionAuthority({
    authorityPath: destinations.releasePath,
    commandPath: destinations.commandPath,
    launchPath: destinations.launchPath,
    processAuthorityPath: destinations.processAuthorityPath,
    terminalPath: destinations.terminalPath,
    taskTerminalPath: destinations.taskTerminalPath,
    executionPath: executionDestination,
    plan,
    lease,
    worker,
  });
  const summaryPath = path.join(runDirectory, SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE);
  atomicWriteJson(summaryPath, interactive.authority);
  const { resultPath, result } = writeShardCellResult({
    plan,
    lease,
    workerId,
    vmIdentity,
    shardRoot: resolvedShardRoot,
    runDirectory,
    provenance: authoritySnapshot.provenance,
    authorityImplementationHashes: authoritySnapshot.authorityImplementationHashes,
    runtimeBinaryHashes: authoritySnapshot.runtimeBinaryHashes,
    shardOrchestrationImplementationHashes:
      authoritySnapshot.shardOrchestrationImplementationHashes,
    generatedAt,
  });
  validateShardCellResult({
    resultPath,
    plan,
    lease,
    shardRoot: resolvedShardRoot,
    now: generatedAt,
    currentProvenance: authoritySnapshot.provenance,
    currentAuthorityImplementationHashes: authoritySnapshot.authorityImplementationHashes,
    currentRuntimeBinaryHashes: authoritySnapshot.runtimeBinaryHashes,
    currentShardImplementationHashes: authoritySnapshot.shardOrchestrationImplementationHashes,
  });
  const leaseTerminal = writeLeaseTerminal({
    plan,
    lease,
    workerId,
    shardRoot: resolvedShardRoot,
    status: 'passed',
    now: generatedAt,
    resultPath,
  });
  return { resultPath, result, runDirectory, ...leaseTerminal };
}

export function finalizeShardWorker({
  plan,
  leases,
  workerId,
  shardRoot,
  resultPaths,
  generatedAt = new Date(),
}) {
  return writeShardManifest({
    plan,
    leases,
    workerId,
    shardRoot,
    resultPaths,
    generatedAt,
  });
}

export function parseShardCliArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      plan: '',
      lease: '',
      workerId: '',
      vmUuidBios: '',
      shardRoot: '',
      finalizeInteractiveRequest: '',
      finalizeWorkerRequest: '',
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    const options = parseShardCliArgs(process.argv.slice(2));
    if (String(options.finalizeInteractiveRequest ?? '').trim()) {
      const request = readRegularJson(
        path.resolve(options.finalizeInteractiveRequest),
        'interactive cell finalization request',
      );
      if (
        request.schemaVersion !== 1
        || request.artifactKind !== 'watch-mode-interactive-cell-finalization-request'
      ) throw new Error('unsupported interactive cell finalization request');
      const plan = readRegularJson(request.planPath, 'signed shard plan');
      const lease = readRegularJson(request.leasePath, 'signed cell lease');
      const worker = plan.workers?.find((entry) => entry.workerId === request.workerId);
      if (!worker || String(worker.vmIdentity?.uuidBios).toLowerCase()
        !== String(request.vmUuidBios).toLowerCase()) {
        throw new Error('interactive cell finalizer worker/VM UUID does not match signed plan');
      }
      const outcome = finalizeInteractiveShardCell({
        plan,
        lease,
        workerId: request.workerId,
        vmIdentity: worker.vmIdentity,
        shardRoot: request.shardRoot,
        executionReceiptPath: request.executionReceiptPath,
        readinessReceiptPath: request.readinessReceiptPath,
        commandPath: request.commandPath,
        launchPath: request.launchPath,
        releasePath: request.releasePath,
        processAuthorityPath: request.processAuthorityPath,
        terminalPath: request.terminalPath,
        taskTerminalPath: request.taskTerminalPath,
      });
      console.log(outcome.resultPath);
      process.exit(0);
    }
    if (String(options.finalizeWorkerRequest ?? '').trim()) {
      const request = readRegularJson(
        path.resolve(options.finalizeWorkerRequest),
        'worker shard finalization request',
      );
      if (
        request.schemaVersion !== 1
        || request.artifactKind !== 'watch-mode-worker-shard-finalization-request'
        || !Array.isArray(request.leasePaths)
        || !Array.isArray(request.resultPaths)
      ) throw new Error('unsupported worker shard finalization request');
      const plan = readRegularJson(request.planPath, 'signed shard plan');
      const snapshot = shardAuthoritySnapshot();
      assertShardWorkerAuthority(plan, snapshot);
      const leases = request.leasePaths.map((entry) => readRegularJson(entry, 'signed cell lease'));
      const outcome = finalizeShardWorker({
        plan,
        leases,
        workerId: request.workerId,
        shardRoot: request.shardRoot,
        resultPaths: request.resultPaths,
      });
      assertShardWorkerAuthority(plan, shardAuthoritySnapshot());
      console.log(outcome.manifestPath);
      process.exit(0);
    }
    for (const key of ['plan', 'lease', 'workerId', 'vmUuidBios', 'shardRoot']) {
      if (!String(options[key] ?? '').trim()) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
    const plan = JSON.parse(fs.readFileSync(path.resolve(options.plan), 'utf8').replace(/^\uFEFF/, ''));
    const lease = JSON.parse(fs.readFileSync(path.resolve(options.lease), 'utf8').replace(/^\uFEFF/, ''));
    const worker = plan.workers?.find((entry) => entry.workerId === options.workerId);
    if (!worker || worker.vmIdentity?.uuidBios !== options.vmUuidBios) {
      throw new Error('CLI worker/VM UUID does not match the signed plan');
    }
    const outcome = await runLeasedShardCell({
      plan,
      lease,
      workerId: options.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot: path.resolve(options.shardRoot),
      authoritySnapshot: shardAuthoritySnapshot(),
      readAuthoritySnapshot: () => shardAuthoritySnapshot(),
      readinessReceiptPath: process.env.OMNI_SHARD_ZERO_PROVIDER_READINESS_PATH,
      interactiveCommandPath: process.env.OMNI_SHARD_INTERACTIVE_COMMAND_PATH,
      interactiveLaunchAuthorityPath: process.env.OMNI_SHARD_INTERACTIVE_LAUNCH_AUTHORITY_PATH,
      interactiveReleasePath: process.env.OMNI_SHARD_INTERACTIVE_RELEASE_PATH,
      interactiveExecutionReceiptPath:
        process.env.OMNI_SHARD_INTERACTIVE_EXECUTION_RECEIPT_PATH,
    });
    console.log(outcome.resultPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
