import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';

export const PROVIDER_PREFLIGHT_EMITTER_TIMEOUT_MS = 300_000;
export const PROVIDER_PREFLIGHT_EXIT_GRACE_MS = 5_000;
export const PROVIDER_PREFLIGHT_CLOSE_GRACE_MS = 3_000;
export const PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS = 10_000;
export const PROVIDER_PREFLIGHT_FAILURE_FILE = 'provider-preflight-failure.json';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function queryProcessSnapshot(pid) {
  const source = String.raw`
$process = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue
if (-not $process) { [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress; exit 0 }
$managed = Get-Process -Id ${Number(pid)} -ErrorAction Stop
[pscustomobject]@{
  exists = $true
  pid = [int]$process.ProcessId
  parentPid = [int]$process.ParentProcessId
  imagePath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
  startedAt = $managed.StartTime.ToUniversalTime().ToString('o')
} | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', source,
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (result.error || Number(result.status) !== 0) return null;
  try { return JSON.parse(String(result.stdout).trim()); } catch { return null; }
}

function sameProcess(authority, actual) {
  if (!authority?.pid || !actual?.exists || Number(actual.pid) !== Number(authority.pid)) return false;
  const normalize = (value) => path.win32.resolve(String(value ?? '')).toLowerCase();
  return normalize(actual.imagePath) === normalize(authority.imagePath)
    && String(actual.startedAt) === String(authority.startedAt);
}

function requestClose(authority) {
  const payload = Buffer.from(JSON.stringify(authority), 'utf8').toString('base64');
  const source = String.raw`
$authority = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$authority.pid)" -ErrorAction SilentlyContinue
if (-not $process) { [pscustomobject]@{ status = 'already-exited' } | ConvertTo-Json -Compress; exit 0 }
$managed = Get-Process -Id ([int]$authority.pid) -ErrorAction Stop
$actualPath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
$actualStart = $managed.StartTime.ToUniversalTime().ToString('o')
if ($actualPath -cne [IO.Path]::GetFullPath([string]$authority.imagePath) -or $actualStart -cne [string]$authority.startedAt) { throw 'preflight process identity changed' }
$requested = $managed.CloseMainWindow()
[pscustomobject]@{ status = 'close-requested'; closeMainWindow = [bool]$requested } | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', source,
  ], { encoding: 'utf8', windowsHide: true, timeout: PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS });
  if (result.error || Number(result.status) !== 0) throw new Error(String(result.stderr || result.stdout || result.error?.message).trim());
  return JSON.parse(String(result.stdout).trim());
}

function forceOwnedProcessTree(authority) {
  const actual = queryProcessSnapshot(authority.pid);
  if (!actual?.exists) return { status: 'already-exited', forced: false };
  if (!sameProcess(authority, actual)) throw new Error('refusing to terminate a preflight PID whose identity changed');
  const result = spawnSync('taskkill.exe', ['/PID', String(authority.pid), '/F', '/T'], {
    encoding: 'utf8', windowsHide: true, timeout: PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS,
  });
  if (result.error || ![0, 128].includes(Number(result.status))) {
    throw new Error(String(result.stderr || result.stdout || result.error?.message).trim());
  }
  return { status: 'forced', forced: true, exitCode: Number(result.status) };
}

function probeFields(outputDirectory, emitter) {
  const probe = readJson(path.join(outputDirectory, 'provider-probe-result.json'));
  const raw = probe?.value?.rawProbeResult ?? probe?.rawProbeResult ?? probe?.value ?? probe;
  return {
    modelId: raw?.modelId ?? probe?.modelId ?? null,
    verdict: raw?.verdict ?? probe?.value?.verdict ?? probe?.verdict
      ?? (emitter?.status === 'failed' ? 'infrastructure-failure' : null),
    measuredLatencyMs: Number.isFinite(Number(raw?.measuredLatencyMs)) ? Number(raw.measuredLatencyMs) : null,
    latencyBudgetMs: Number.isFinite(Number(raw?.latencyBudgetMs)) ? Number(raw.latencyBudgetMs) : 1200,
    connectionAttempts: Number.isFinite(Number(raw?.connectionAttempts)) ? Number(raw.connectionAttempts) : null,
    connectionCount: Number.isFinite(Number(raw?.connectionCount)) ? Number(raw.connectionCount) : null,
    connectionOpened: raw?.connectionOpened === true,
    connectionClosed: raw?.connectionClosed === true,
    connectionGeneration: Number.isFinite(Number(raw?.connectionGeneration))
      ? Number(raw.connectionGeneration)
      : null,
    streamingObserved: raw?.streamingObserved ?? null,
    responseShapeValid: raw?.responseShapeValid ?? null,
    connectionOwner: raw?.connectionOwner ?? null,
  };
}

export async function runManagedProviderPreflight({
  executablePath,
  outputDirectory,
  environment,
  executionId,
  providerId,
  signal,
  spawnProcess = spawn,
  emitterTimeoutMs = PROVIDER_PREFLIGHT_EMITTER_TIMEOUT_MS,
  exitGraceMs = PROVIDER_PREFLIGHT_EXIT_GRACE_MS,
  closeGraceMs = PROVIDER_PREFLIGHT_CLOSE_GRACE_MS,
  cleanupTimeoutMs = PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS,
  now = () => new Date(),
  querySnapshot = queryProcessSnapshot,
  closeOwnedProcess = requestClose,
  forceOwnedProcess = forceOwnedProcessTree,
} = {}) {
  fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
  if (fs.existsSync(outputDirectory)) {
    throw new Error(`provider preflight output directory already exists: ${outputDirectory}`);
  }
  const startedAt = now();
  const child = spawnProcess(executablePath, [], {
    cwd: path.dirname(executablePath), env: environment, windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  let exitCode = null;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code) => { exited = true; exitCode = code; });
  const authorityDeadline = Date.now() + 5_000;
  let snapshot = null;
  while (!snapshot?.exists && Date.now() < authorityDeadline) {
    snapshot = querySnapshot(child.pid);
    if (!snapshot?.exists) await delay(50);
  }
  const processAuthority = {
    pid: child.pid,
    parentPid: snapshot?.parentPid ?? process.pid,
    imagePath: snapshot?.imagePath ?? path.resolve(executablePath),
    imageSha256: sha256(executablePath),
    startedAt: snapshot?.startedAt ?? startedAt.toISOString(),
  };
  const emitterPath = path.join(outputDirectory, 'emitter-result.json');
  const deadline = Date.now() + emitterTimeoutMs;
  let emitter = null;
  let primaryError = null;
  while (!emitter && !exited && Date.now() < deadline && !signal?.aborted) {
    const candidate = readJson(emitterPath);
    if (['completed', 'failed'].includes(candidate?.status)) emitter = candidate;
    else await delay(100);
  }
  // Process exit and the final emitter receipt can become observable in either
  // order. Give the immutable receipt a short visibility grace period before
  // classifying a clean exit as an emitter failure.
  if (!emitter && exited && !signal?.aborted) {
    const visibilityDeadline = Math.min(deadline, Date.now() + 500);
    while (!emitter && Date.now() < visibilityDeadline) {
      const candidate = readJson(emitterPath);
      if (['completed', 'failed'].includes(candidate?.status)) emitter = candidate;
      else await delay(25);
    }
  }
  if (signal?.aborted) primaryError = new Error(`provider preflight aborted: ${signal.reason?.message ?? signal.reason ?? 'signal'}`);
  else if (!emitter && Date.now() >= deadline) primaryError = new Error(`provider preflight emitter timed out after ${emitterTimeoutMs}ms`);
  else if (!emitter && exited) primaryError = new Error(`provider preflight exited before terminal emitter result: exit=${exitCode ?? 'unknown'}`);
  else if (emitter?.status === 'failed') primaryError = new Error(String(emitter.error ?? 'provider preflight emitter failed'));

  const cleanupErrors = [];
  const termination = { terminalEmitterObserved: Boolean(emitter), closeRequest: null, forced: false };
  const waitForExit = async (milliseconds) => {
    const end = Date.now() + milliseconds;
    while (!exited && Date.now() < end) await delay(50);
    return exited;
  };
  await waitForExit(exitGraceMs);
  if (!exited) {
    try { termination.closeRequest = closeOwnedProcess(processAuthority); } catch (error) { cleanupErrors.push(error.message); }
    await waitForExit(closeGraceMs);
  }
  if (!exited) {
    try { Object.assign(termination, forceOwnedProcess(processAuthority)); } catch (error) { cleanupErrors.push(error.message); }
    await waitForExit(cleanupTimeoutMs);
  }
  termination.exited = exited;
  termination.exitCode = exitCode;
  const fields = probeFields(outputDirectory, emitter);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy?.();
  if (exited) {
    child.removeAllListeners?.();
    child.unref?.();
  }
  if (!primaryError && (exitCode ?? 0) !== 0) primaryError = new Error(`provider preflight process failed with exit ${exitCode}`);
  if (!primaryError && (cleanupErrors.length > 0 || !exited)) {
    primaryError = new Error(`provider preflight cleanup failed: ${cleanupErrors.join('; ') || 'owned process did not exit'}`);
  }
  if (primaryError) {
    const stableErrorCode = signal?.aborted
      ? 'provider.preflight.interrupted'
      : !emitter
        ? 'provider.preflight.emitter-timeout'
        : cleanupErrors.length > 0 || !exited
          ? 'provider.preflight.cleanup-failed'
          : fields.verdict === 'realtime-risk'
            ? 'provider.preflight.latency-budget-exceeded'
            : 'provider.preflight.failed';
    const failure = {
      schemaVersion: 1,
      artifactKind: 'watch-mode-provider-preflight-failure',
      generatedAt: now().toISOString(),
      executionId,
      providerId,
      stableErrorCode,
      ...fields,
      process: processAuthority,
      termination,
      primaryError: { code: stableErrorCode, message: primaryError.message },
      cleanupErrors,
      stdoutTail: stdout.slice(-8_192),
      stderrTail: stderr.slice(-8_192),
    };
    // The Desktop owns successful publication of outputDirectory by atomically
    // renaming its sibling staging directory. Only a failed execution that did
    // not publish evidence transfers directory ownership back to the runner.
    if (!fs.existsSync(outputDirectory)) fs.mkdirSync(outputDirectory, { recursive: false });
    const failurePath = path.join(outputDirectory, PROVIDER_PREFLIGHT_FAILURE_FILE);
    atomicWriteJson(failurePath, failure);
    const error = new Error(primaryError.message);
    error.failurePath = failurePath;
    error.failure = failure;
    throw error;
  }
  return {
    emitter,
    emitterPath,
    outputDirectory,
    processAuthority,
    termination,
    fields,
    emitterAuthority: fileAuthorityEntry(emitterPath, 'emitter-result.json'),
  };
}
