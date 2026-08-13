import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  DEFAULT_FEEDBACK_MODES,
  DEFAULT_MODELS,
  MATRIX_DEFAULTS,
  SUPPORTED_DEVICE_CLASSES,
  buildStrictRuntimeAuthority,
  buildVerifyArgv,
  publishSuccessfulStrictMatrixManifest,
  resolveReusableLocalIsolationManifest,
  runStrictProviderPreflight,
  stageShardMatrixIntegration,
  strictRuntimeEnvironment,
  writeMatrixRunManifest,
} from './run-watch-mode-live-matrix.mjs';
import {
  currentAuthorityImplementationHashes,
  fileAuthorityEntry,
  resolveAuthorityPath,
} from './watch-mode-evidence-authority.mjs';
import {
  createReusableLocalIsolationAuthority,
  verifyLocalIsolationManifest,
} from './watch-mode-local-isolation.mjs';
import {
  assertCellExternalProviderBudget,
  writeMatrixExternalProviderBudget,
} from './watch-mode-external-provider-budget.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  SHARD_CELL_RESULT_FILE,
  SHARD_EXECUTION_PLAN_FILE,
  atomicWriteJson,
  createWorkerReadinessRequest,
  currentShardOrchestrationImplementationHashes,
  validateShardCellResult,
  validateShardManifest,
} from './watch-mode-shard-authority.mjs';
import {
  defaultThreeVmAssignments,
  prepareCoordinatorExecution,
  runCoordinatorWaves,
  writeCoordinatorAggregate,
} from './run-watch-mode-live-coordinator.mjs';
import {
  PROVIDER_PREFLIGHT_AUTHORIZATION_DIGEST_ENV,
  PROVIDER_PREFLIGHT_GRANT_PATH_ENV,
  PROVIDER_PREFLIGHT_RESERVATION_DIRECTORY_ENV,
} from './watch-mode-provider-preflight-authorization.mjs';

export const PRODUCTION_COORDINATOR_RUNNER_ID =
  'scripts/testing/run-watch-mode-live-production-coordinator.mjs';
export const PRODUCTION_WORKER_CONFIG_SCHEMA_VERSION = 1;
export const PRODUCTION_WORKER_CONFIG_KIND = 'watch-mode-production-shard-workers';
export const PRODUCTION_REMOTE_CELL_TIMEOUT_MS = 650_000;
export const PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS = 15 * 60 * 1_000;
export const PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS = 10 * 60 * 1_000;


// The SSH process is control-plane only. The checked-in helper registers a
// one-shot InteractiveToken task whose action is the separately hashed static
// launcher; no paid shard process is ever started by this session-0 shell.
export const PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY = String.raw`
$control = Join-Path ([string]$payload.workspaceRoot) 'scripts\testing\invoke-watch-mode-interactive-task.ps1'
if (-not (Test-Path -LiteralPath $control -PathType Leaf)) { throw 'interactive task control script is missing' }
$controlHash = (Get-FileHash -LiteralPath $control -Algorithm SHA256).Hash.ToLowerInvariant()
if ($controlHash -cne [string]$payload.controlScriptSha256) { throw 'interactive task control script hash mismatch' }
$json = $payload.interactiveRequest | ConvertTo-Json -Depth 30 -Compress
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$controlOutput = @(& $control -PayloadBase64 $encoded)
# The control is a PowerShell script, not a native executable. A successful
# script invocation does not set LASTEXITCODE, and comparing that null value to
# zero falsely rejects the immutable readiness/terminal authorities it wrote.
# ErrorActionPreference=Stop already propagates script failures.
$controlOutput
`;


export const PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY = String.raw`
$workspace = [string]$payload.workspaceRoot
$remoteRoot = [string]$payload.remoteRoot
$readinessRoot = Join-Path $remoteRoot 'readiness'
[void](New-Item -ItemType Directory -Path $readinessRoot -Force)
$driverRequired = [bool]$payload.driverRequired
$expected = $payload.driver
$driverScript = Join-Path $workspace 'scripts\installer\test-development-driver.ps1'
$authority = $null
if ($driverRequired) {
  # A development Authenticode signature and the WDK-stamped DriverVer make a
  # freshly rebuilt package byte-distinct even when the driver source did not
  # change.  Synchronize the exact runtime package that this execution signed
  # before collecting readiness; otherwise every new strict build would be
  # compared with the preceding installed package and could never reach the
  # Provider preflight.  Resolve and validate DevCon plus the package before
  # the destructive repair begins.
  $devconAuthorityScript = Join-Path $workspace 'scripts\installer\devcon-authority.ps1'
  $installScript = Join-Path $workspace 'scripts\installer\install-development-driver.ps1'
  $repairScript = Join-Path $workspace 'scripts\installer\repair-driver.ps1'
  $devconCandidate = Join-Path $workspace 'artifacts\tooling\devcon.exe'
  . $devconAuthorityScript
  $devcon = Resolve-OmniDevconPath -WorkspaceRoot $workspace -ExplicitPath $devconCandidate
  $driverRuntimeRoot = Join-Path $remoteRoot 'logs\driver-runtime-sync'
  $packageRoot = Join-Path $workspace 'drivers\windows-virtual-mic\package'
  $packageSysHash = (Get-FileHash -LiteralPath (Join-Path $packageRoot 'omni-virtual-speaker.sys') -Algorithm SHA256).Hash.ToLowerInvariant()
  $packageCatHash = (Get-FileHash -LiteralPath (Join-Path $packageRoot 'omni-virtual-speaker.cat') -Algorithm SHA256).Hash.ToLowerInvariant()
  $packageInfHash = (Get-FileHash -LiteralPath (Join-Path $packageRoot 'omni-virtual-speaker.inf') -Algorithm SHA256).Hash.ToLowerInvariant()
  if (
    $packageSysHash -ne [string]$expected.sysSha256 -or
    $packageCatHash -ne [string]$expected.catSha256 -or
    $packageInfHash -ne [string]$expected.infSha256
  ) { throw 'driver package changed after signed runtime distribution' }
  $driverArguments = @{
    WorkspaceRoot = $workspace
    RuntimeRoot = $driverRuntimeRoot
    InstallChannel = 'development'
    DriverVersion = '0.10.0-dev'
    BridgeVersion = '0.1.0'
    TargetDeviceId = 'virtual-mic-default'
    DevconPath = $devcon
  }
  & $installScript @driverArguments -ValidatePackageOnly
  & $repairScript @driverArguments -Action 'reinstall-driver'

  $driverEvidenceRoot = Join-Path $readinessRoot 'virtual-mic'
  $driverOutput = @(& $driverScript -WorkspaceRoot $workspace -VirtualMicEvidenceOutputDirectory $driverEvidenceRoot)
  $driver = $driverOutput | Where-Object { $_ -and $_.PSObject.Properties['InstalledDriverAuthority'] } | Select-Object -Last 1
  if (-not $driver -or -not $driver.InstalledDriverAuthority) { throw 'installed driver authority was not returned' }
  $authority = $driver.InstalledDriverAuthority
  if (
    [string]$authority.installedServiceState -ne 'Running' -or
    [string]$authority.installedSysSha256 -ne [string]$expected.sysSha256 -or
    [string]$authority.packageSysSha256 -ne [string]$expected.sysSha256 -or
    [string]$authority.packageCatSha256 -ne [string]$expected.catSha256 -or
    [string]$authority.packageInfSha256 -ne [string]$expected.infSha256 -or
    [string]$authority.installedSysSignatureStatus -ne 'Valid' -or
    [string]$authority.packageCatalogSignatureStatus -ne 'Valid'
  ) { throw 'installed SYS/service/package identity does not match the signed runtime bundle' }
} else {
  $packageRoot = Join-Path $workspace 'drivers\windows-virtual-mic\package'
  $authority = [ordered]@{
    packageSysSha256 = (Get-FileHash -LiteralPath (Join-Path $packageRoot 'omni-virtual-speaker.sys') -Algorithm SHA256).Hash.ToLowerInvariant()
    packageCatSha256 = (Get-FileHash -LiteralPath (Join-Path $packageRoot 'omni-virtual-speaker.cat') -Algorithm SHA256).Hash.ToLowerInvariant()
    packageInfSha256 = (Get-FileHash -LiteralPath (Join-Path $packageRoot 'omni-virtual-speaker.inf') -Algorithm SHA256).Hash.ToLowerInvariant()
    installedServiceState = 'not-required'
  }
  if ([string]$authority.packageSysSha256 -ne [string]$expected.sysSha256 -or [string]$authority.packageCatSha256 -ne [string]$expected.catSha256 -or [string]$authority.packageInfSha256 -ne [string]$expected.infSha256) {
    throw 'non-VD worker driver package bytes do not match the signed runtime bundle'
  }
}
$control = [ordered]@{
  schemaVersion = 1
  artifactKind = 'watch-mode-worker-control-readiness'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  executionId = [string]$payload.executionId
  readinessRequestDigest = [string]$payload.readinessRequestDigest
  workerId = [string]$payload.workerId
  vmIdentityDigest = [string]$payload.vmIdentityDigest
  runtimeBundleDigest = [string]$payload.runtimeBundleDigest
  providerCalls = 0
  driverRequired = $driverRequired
  driver = $authority
}
$controlPath = Join-Path $readinessRoot 'control-readiness.json'
if (Test-Path -LiteralPath $controlPath) { throw 'control readiness authority already exists' }
[IO.File]::WriteAllText($controlPath, (($control | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
$control | ConvertTo-Json -Depth 12 -Compress
`;

export const PRODUCTION_WORKER_READINESS_FINALIZE_BODY = String.raw`
$root = Join-Path ([string]$payload.remoteRoot) 'readiness'
$controlPath = Join-Path $root 'control-readiness.json'
$interactivePath = Join-Path ([string]$payload.remoteRoot) 'interactive\readiness\interactive-readiness.json'
if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf) -or -not (Test-Path -LiteralPath $interactivePath -PathType Leaf)) {
  throw 'worker readiness component authority is missing'
}
$control = Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8 | ConvertFrom-Json
$interactive = Get-Content -LiteralPath $interactivePath -Raw -Encoding UTF8 | ConvertFrom-Json
if (
  $control.executionId -ne [string]$payload.executionId -or
  $interactive.executionId -ne [string]$payload.executionId -or
  $control.readinessRequestDigest -ne [string]$payload.readinessRequestDigest -or
  $interactive.readinessRequestDigest -ne [string]$payload.readinessRequestDigest -or
  $control.workerId -ne [string]$payload.workerId -or
  $interactive.workerId -ne [string]$payload.workerId -or
  $control.vmIdentityDigest -ne [string]$payload.vmIdentityDigest -or
  $interactive.vmIdentityDigest -ne [string]$payload.vmIdentityDigest -or
  [int]$control.providerCalls -ne 0 -or [int]$interactive.providerCalls -ne 0 -or
  [int]$interactive.sessionId -ne 1 -or [string]$interactive.user -ne [string]$payload.user -or
  [string]$interactive.credentialStatus.backend -ne 'windows-credential-manager' -or
  $interactive.credentialStatus.exists -ne $true -or
  [string]$interactive.credentialStatus.reference -ne 'credential://provider/dashscope/default' -or
  [string]$interactive.credentialStatus.targetName -ne 'OmniTranslate:credential___provider_dashscope_default' -or
  $interactive.credentialStatus.blobNonEmpty -ne $true -or
  [int]$interactive.credentialStatus.credentialBlobBytes -le 0 -or
  [int]$interactive.credentialStatus.credentialBlobBytes -gt 2560 -or
  -not [string]$interactive.credentialStatus.checkedAt -or
  -not $interactive.credentialStatus.probeProcess -or
  @($interactive.profiles).Count -ne @($payload.profiles).Count
) { throw 'worker readiness component identity/session binding mismatch' }
$receipt = [ordered]@{
  schemaVersion = 1
  artifactKind = 'watch-mode-production-worker-zero-provider-readiness'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  executionId = [string]$payload.executionId
  readinessRequestDigest = [string]$payload.readinessRequestDigest
  workerId = [string]$payload.workerId
  vmIdentityDigest = [string]$payload.vmIdentityDigest
  runtimeBundleDigest = [string]$payload.runtimeBundleDigest
  providerCalls = 0
  driverRequired = [bool]$control.driverRequired
  driver = $control.driver
  interactiveSession = [ordered]@{
    user = [string]$interactive.user
    ownerSid = [string]$interactive.ownerSid
    sessionId = [int]$interactive.sessionId
    desktop = [string]$interactive.desktop
    explorerProcessCount = 1
    commandSha256 = [string]$interactive.commandSha256
    taskProcess = $interactive.taskProcess
    explorerProcess = $interactive.explorerProcess
  }
  credentialStatus = $interactive.credentialStatus
  profiles = @($interactive.profiles)
  componentAuthorities = [ordered]@{
    controlPath = 'readiness/control-readiness.json'
    controlSha256 = (Get-FileHash -LiteralPath $controlPath -Algorithm SHA256).Hash.ToLowerInvariant()
    interactivePath = 'interactive/readiness/interactive-readiness.json'
    interactiveSha256 = (Get-FileHash -LiteralPath $interactivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$receiptPath = Join-Path $root 'zero-provider-readiness.json'
if (Test-Path -LiteralPath $receiptPath) { throw 'worker readiness receipt already exists' }
[IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 20 -Compress
`;

export const PRODUCTION_PRESERVED_WORKER_READINESS_BODY = String.raw`
$receiptPath = Join-Path ([string]$payload.remoteRoot) 'readiness\zero-provider-readiness.json'
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'pre-provider readiness receipt is missing' }
Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 |
  ConvertFrom-Json |
  ConvertTo-Json -Depth 20 -Compress
`;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/i;
const SAFE_UUID = /^[a-z0-9][a-z0-9._:-]{3,127}$/i;
const SAFE_REMOTE_WINDOWS_ROOT = /^[a-z]:\\[a-z0-9._-]+(?:\\[a-z0-9._-]+)*$/i;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys must be exactly ${expected.join(', ')}`);
  }
}

function regularFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file: ${resolved}`);
  }
  return resolved;
}

function executableValue(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (path.isAbsolute(text) || text.includes('/') || text.includes('\\')) return regularFile(text, label);
  if (!/^[a-z0-9._-]+(?:\.exe)?$/i.test(text)) throw new Error(`${label} is not a safe executable name`);
  return text;
}

function knownHostsContainsAlias(filePath, alias, port) {
  const accepted = new Set([alias, `[${alias}]:${port}`]);
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).some((line) => {
    const hosts = line.trim().split(/\s+/, 1)[0]?.split(',') ?? [];
    return hosts.some((host) => accepted.has(host));
  });
}

function validateProfile(profile, workerId, index) {
  exactKeys(profile, [
    'instanceId',
    'profileId',
    'deviceClass',
    'physicalPlaybackDeviceId',
    'expectedPhysicalPlaybackDeviceName',
  ], `worker ${workerId} device profile ${index}`);
  for (const key of ['instanceId', 'profileId']) {
    if (!SAFE_ID.test(String(profile[key] ?? ''))) {
      throw new Error(`worker ${workerId} device profile ${index} ${key} is not portable`);
    }
  }
  if (!SUPPORTED_DEVICE_CLASSES.includes(profile.deviceClass)) {
    throw new Error(`worker ${workerId} device profile ${index} has unsupported deviceClass`);
  }
  for (const key of ['physicalPlaybackDeviceId', 'expectedPhysicalPlaybackDeviceName']) {
    const text = String(profile[key] ?? '');
    if (text.length > 512 || /[\r\n\0]/.test(text)) {
      throw new Error(`worker ${workerId} device profile ${index} ${key} is invalid`);
    }
  }
  return structuredClone(profile);
}

function canonicalDeviceProfiles(profiles, authorityLabel) {
  const byClass = new Map();
  for (const profile of profiles) {
    const projected = {
      profileId: profile.profileId,
      deviceClass: profile.deviceClass,
      physicalPlaybackDeviceId: profile.physicalPlaybackDeviceId,
      expectedPhysicalPlaybackDeviceName: profile.expectedPhysicalPlaybackDeviceName,
    };
    const prior = byClass.get(profile.deviceClass);
    if (prior && JSON.stringify(prior) !== JSON.stringify(projected)) {
      throw new Error(`${authorityLabel} disagree on ${profile.deviceClass} matrix profile identity`);
    }
    byClass.set(profile.deviceClass, projected);
  }
  return SUPPORTED_DEVICE_CLASSES.map((deviceClass) => {
    const profile = byClass.get(deviceClass);
    if (!profile) throw new Error(`${authorityLabel} have no ${deviceClass} profile`);
    return profile;
  });
}

export function validateProductionWorkerConfig(config, { configDirectory = repoRoot } = {}) {
  exactKeys(config, [
    'schemaVersion',
    'artifactKind',
    'sshExecutable',
    'scpExecutable',
    'workers',
  ], 'production worker config');
  if (
    config.schemaVersion !== PRODUCTION_WORKER_CONFIG_SCHEMA_VERSION
    || config.artifactKind !== PRODUCTION_WORKER_CONFIG_KIND
    || !Array.isArray(config.workers)
    || ![2, 3].includes(config.workers.length)
  ) throw new Error('production worker config must be schema v1 with exactly two or three workers');
  const sshExecutable = executableValue(config.sshExecutable, 'sshExecutable');
  const scpExecutable = executableValue(config.scpExecutable, 'scpExecutable');
  const workerIds = new Set();
  const hosts = new Set();
  const workers = config.workers.map((worker, workerIndex) => {
    exactKeys(worker, [
      'workerId',
      'host',
      'port',
      'user',
      'identityFile',
      'knownHostsFile',
      'hostKeyAlias',
      'workspaceRoot',
      'guestExecutionRoot',
      'vmIdentity',
      'deviceProfileInstances',
    ], `production worker ${workerIndex}`);
    const workerId = String(worker.workerId ?? '');
    const host = String(worker.host ?? '');
    const user = String(worker.user ?? '');
    const hostKeyAlias = String(worker.hostKeyAlias ?? '');
    const port = Number(worker.port);
    if (!SAFE_ID.test(workerId) || workerIds.has(workerId)) throw new Error(`worker ${workerIndex} has invalid or duplicate workerId`);
    if (!SAFE_HOST.test(host) || host.includes('..') || hosts.has(`${host}:${port}`)) throw new Error(`worker ${workerId} has invalid or duplicate host`);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`worker ${workerId} has invalid SSH port`);
    if (!/^[a-z0-9._-]{1,64}$/i.test(user)) throw new Error(`worker ${workerId} has invalid SSH user`);
    if (!SAFE_ID.test(hostKeyAlias)) throw new Error(`worker ${workerId} has invalid hostKeyAlias`);
    if (!SAFE_REMOTE_WINDOWS_ROOT.test(String(worker.workspaceRoot ?? ''))) throw new Error(`worker ${workerId} workspaceRoot must be a fixed safe Windows path without spaces`);
    if (!SAFE_REMOTE_WINDOWS_ROOT.test(String(worker.guestExecutionRoot ?? ''))) throw new Error(`worker ${workerId} guestExecutionRoot must be a fixed safe Windows path without spaces`);
    exactKeys(worker.vmIdentity, ['provider', 'uuidBios'], `worker ${workerId} vmIdentity`);
    if (worker.vmIdentity.provider !== 'vmware' || !SAFE_UUID.test(String(worker.vmIdentity.uuidBios ?? ''))) {
      throw new Error(`worker ${workerId} must bind a portable VMware BIOS UUID`);
    }
    const identityFile = regularFile(path.resolve(configDirectory, worker.identityFile), `worker ${workerId} identityFile`);
    const knownHostsFile = regularFile(path.resolve(configDirectory, worker.knownHostsFile), `worker ${workerId} knownHostsFile`);
    if (!knownHostsContainsAlias(knownHostsFile, hostKeyAlias, port)) {
      throw new Error(`worker ${workerId} known_hosts does not pin hostKeyAlias ${hostKeyAlias}`);
    }
    if (!Array.isArray(worker.deviceProfileInstances) || worker.deviceProfileInstances.length === 0) {
      throw new Error(`worker ${workerId} has no device profile instances`);
    }
    const deviceProfileInstances = worker.deviceProfileInstances.map((profile, index) => (
      validateProfile(profile, workerId, index)
    ));
    if (new Set(deviceProfileInstances.map((profile) => profile.instanceId)).size !== deviceProfileInstances.length) {
      throw new Error(`worker ${workerId} reuses a device profile instanceId`);
    }
    workerIds.add(workerId);
    hosts.add(`${host}:${port}`);
    return {
      workerId,
      host,
      port,
      user,
      identityFile,
      knownHostsFile,
      hostKeyAlias,
      workspaceRoot: worker.workspaceRoot,
      guestExecutionRoot: worker.guestExecutionRoot,
      vmIdentity: structuredClone(worker.vmIdentity),
      deviceProfileInstances,
    };
  });
  // Placement is capability-based: exactly one worker owns the USB endpoint,
  // while every remaining worker supplies a default-speaker profile.
  const assignments = defaultThreeVmAssignments(workers);
  const workersById = new Map(workers.map((worker) => [worker.workerId, worker]));
  const assignedProfiles = assignments.map((assignment) => {
    const worker = workersById.get(assignment.workerId);
    const profile = worker?.deviceProfileInstances.find(
      (entry) => entry.instanceId === assignment.deviceProfileInstanceId,
    );
    if (!profile) {
      throw new Error(`production worker assignment has no profile ${assignment.deviceProfileInstanceId}`);
    }
    return profile;
  });
  canonicalDeviceProfiles(assignedProfiles, 'production worker assignments');
  return { sshExecutable, scpExecutable, workers };
}

export function readProductionWorkerConfig(configPath) {
  const resolved = regularFile(configPath, 'production worker config');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`production worker config is not valid UTF-8 JSON: ${error.message}`);
  }
  return validateProductionWorkerConfig(parsed, { configDirectory: path.dirname(resolved) });
}

export function sshBaseArgs(worker) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${worker.knownHostsFile}`,
    '-o', `HostKeyAlias=${worker.hostKeyAlias}`,
    '-o', 'ConnectTimeout=15',
    '-i', worker.identityFile,
    '-p', String(worker.port),
  ];
}

export function scpBaseArgs(worker) {
  return [
    '-q',
    '-O',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${worker.knownHostsFile}`,
    '-o', `HostKeyAlias=${worker.hostKeyAlias}`,
    '-o', 'ConnectTimeout=15',
    '-i', worker.identityFile,
    '-P', String(worker.port),
  ];
}

function runChildProcess(executable, args, {
  cwd = repoRoot,
  signal,
  timeoutMs = 60_000,
  environment = process.env,
  input = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
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
    child.stdin.once('error', (error) => {
      // A remote process can fail and close stdin before ssh has consumed the
      // entire script. Its exit code/stderr remain the useful failure signal.
      if (error.code !== 'EPIPE') finish(() => reject(error));
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (exitCode) => finish(() => resolve({
      exitCode: exitCode ?? 1,
      stdout,
      stderr,
    })));
    timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(input);
  });
}

const REMOTE_POWERSHELL_STDIN_BOOTSTRAP = Buffer.from(
  '$source = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($source))',
  'utf16le',
).toString('base64');

export function remotePowerShellInvocation(body, payload) {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return {
    args: [
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', REMOTE_POWERSHELL_STDIN_BOOTSTRAP,
    ],
    input: [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      `$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadBase64}'))`,
      '$payload = $payloadJson | ConvertFrom-Json',
      body,
    ].join('\n'),
  };
}

function lastNonEmptyLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}

function remotePathForScp(remotePath) {
  return String(remotePath).replaceAll('\\', '/');
}

function remoteSpec(worker, remotePath) {
  return `${worker.user}@${worker.host}:${remotePathForScp(remotePath)}`;
}

function ensureSuccessful(result, label) {
  if (Number(result?.exitCode) !== 0) {
    const stderr = String(result?.stderr ?? '').trim();
    const stdout = String(result?.stdout ?? '').trim();
    throw new Error(`${label} failed with exit ${result?.exitCode ?? 'unknown'}: ${stderr || stdout || 'remote command produced no diagnostics'}`);
  }
  return result;
}

function parseRemoteJson(result, label) {
  ensureSuccessful(result, label);
  const line = lastNonEmptyLine(result.stdout);
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

export async function runRemoteJsonWithRetries(operation, label, {
  attempts = 3,
  delayMs = 1_000,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return parseRemoteJson(await operation(attempt), `${label} attempt ${attempt}`);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function safeRemoteChild(root, child, label) {
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(child));
  if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) {
    throw new Error(`${label} is outside its isolated remote shard root`);
  }
  return relative;
}

const ORCHESTRATION_CONTROL_SCRIPT = 'scripts/testing/invoke-watch-mode-interactive-task.ps1';
const ORCHESTRATION_LAUNCHER_SCRIPT = 'scripts/testing/run-watch-mode-interactive-task.ps1';
const ORCHESTRATION_PROCESS_COLLECTOR =
  'scripts/testing/collect-watch-mode-interactive-process-authority.ps1';
const ORCHESTRATION_SHARD_RUNNER = 'scripts/testing/run-watch-mode-live-shard.mjs';
const DASHSCOPE_CREDENTIAL_REFERENCE = 'credential://provider/dashscope/default';

function orchestrationHash(plan, relativePath) {
  const entry = plan.authority?.shardOrchestrationImplementationHashes
    ?.find((candidate) => candidate.path === relativePath);
  if (!entry || !/^[a-f0-9]{64}$/.test(String(entry.sha256 ?? ''))) {
    throw new Error(`signed shard orchestration inventory is missing ${relativePath}`);
  }
  return entry.sha256;
}

function interactiveRequestBase({ plan, worker, remoteRoot, mode, timeoutMs }) {
  return {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-task-request',
    mode,
    workspaceRoot: worker.workspaceRoot,
    remoteRoot,
    executionId: plan.executionId,
    planDigest: plan.planDigest ?? plan.workerReadinessRequest?.requestDigest,
    workerId: worker.workerId,
    vmIdentityDigest: plan.workers.find((entry) => entry.workerId === worker.workerId)?.vmIdentityDigest,
    expectedVmUuidBios: worker.vmIdentity.uuidBios,
    user: worker.user,
    timeoutMs,
    controlScriptSha256: orchestrationHash(plan, ORCHESTRATION_CONTROL_SCRIPT),
    launcherSha256: orchestrationHash(plan, ORCHESTRATION_LAUNCHER_SCRIPT),
    processAuthorityCollectorSha256: orchestrationHash(plan, ORCHESTRATION_PROCESS_COLLECTOR),
    shardRunnerSha256: orchestrationHash(plan, ORCHESTRATION_SHARD_RUNNER),
    expectedCredentialReference: DASHSCOPE_CREDENTIAL_REFERENCE,
  };
}

function interactiveTaskName({ executionId, workerId, leaseId }) {
  const identity = `${executionId}|${workerId}|${leaseId}`;
  return `OmniPaid-${crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)}`;
}

export function createSshProductionTransport({
  config,
  plan,
  planPath,
  leasePaths,
  coordinatorExecutionRoot,
  reusePreparedWorkers = false,
  runProcess = runChildProcess,
  workspaceRoot = repoRoot,
}) {
  const workersById = new Map(config.workers.map((worker) => [worker.workerId, worker]));
  const leasePathById = new Map(leasePaths.map((leasePath) => {
    const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8').replace(/^\uFEFF/, ''));
    return [lease.leaseId, leasePath];
  }));
  const remoteRoots = new Map(config.workers.map((worker) => [
    worker.workerId,
    path.win32.join(worker.guestExecutionRoot, plan.executionId, worker.workerId),
  ]));
  const validationRoots = new Map(config.workers.map((worker) => [
    worker.workerId,
    path.join(coordinatorExecutionRoot, 'validation-shards', worker.workerId),
  ]));
  const remoteLeasePaths = new Map();
  const completedRemoteResults = new Map();

  const runRemote = async (worker, body, payload, options = {}) => {
    const invocation = remotePowerShellInvocation(body, payload);
    return runProcess(config.sshExecutable, [
      ...sshBaseArgs(worker),
      `${worker.user}@${worker.host}`,
      ...invocation.args,
    ], {
      ...options,
      input: invocation.input,
    });
  };
  const upload = async (worker, localPath, remotePath, options = {}) => {
    const result = await runProcess(
      config.scpExecutable,
      [...scpBaseArgs(worker), localPath, remoteSpec(worker, remotePath)],
      options,
    );
    ensureSuccessful(result, `upload to ${worker.workerId}`);
  };
  const downloadTree = async (worker, remotePath, localParent, options = {}) => {
    fs.mkdirSync(localParent, { recursive: true });
    const result = await runProcess(
      config.scpExecutable,
      [...scpBaseArgs(worker), '-r', remoteSpec(worker, remotePath), localParent],
      options,
    );
    ensureSuccessful(result, `download from ${worker.workerId}`);
  };

  async function queryWorker(worker) {
    const result = await runRemote(worker, `
$workspace = [string]$payload.workspaceRoot
if (-not (Test-Path -LiteralPath $workspace -PathType Container)) { throw 'workspace is missing' }
$head = (& git.exe -C $workspace rev-parse HEAD 2>&1 | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git HEAD query failed' }
$dirty = @(& git.exe -C $workspace status --porcelain=v1 --untracked-files=all 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'git status query failed' }
$uuid = [string](Get-CimInstance Win32_ComputerSystemProduct).UUID
[pscustomobject]@{ headCommit = $head.ToLowerInvariant(); dirtyEntries = @($dirty).Count; uuidBios = $uuid.ToLowerInvariant() } | ConvertTo-Json -Compress
`, { workspaceRoot: worker.workspaceRoot }, { timeoutMs: 45_000 });
    const state = parseRemoteJson(result, `worker ${worker.workerId} readiness`);
    if (
      state.headCommit !== String(plan.provenance.headCommit).toLowerCase()
      || Number(state.dirtyEntries) !== 0
      || state.uuidBios !== String(worker.vmIdentity.uuidBios).toLowerCase()
    ) throw new Error(`worker ${worker.workerId} HEAD/clean-state/BIOS UUID does not match its signed identity`);
    return state;
  }

  async function prepareWorker({ worker: planWorker }) {
    const worker = workersById.get(planWorker.workerId);
    if (!worker) throw new Error(`transport has no worker ${planWorker.workerId}`);
    await queryWorker(worker);
    const remoteRoot = remoteRoots.get(worker.workerId);
    const remotePlanPath = path.win32.join(remoteRoot, SHARD_EXECUTION_PLAN_FILE);
    const runtimeEntries = plan.authority.runtimeBinaryHashes.map((entry) => {
      const localPath = resolveAuthorityPath(workspaceRoot, entry.path, 'runtime bundle entry');
      const current = fileAuthorityEntry(localPath, entry.path);
      if (current.bytes !== entry.bytes || current.sha256 !== entry.sha256) {
        throw new Error(`coordinator runtime bundle changed before worker distribution: ${entry.path}`);
      }
      return {
        ...entry,
        localPath,
        remotePath: path.win32.join(worker.workspaceRoot, ...entry.path.split('/')),
      };
    });
    const remoteWorkspaceState = parseRemoteJson(await runRemote(worker, `
$entries = @()
foreach ($entry in @($payload.entries)) {
  $target = [string]$entry.remotePath
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $item = Get-Item -LiteralPath $target
    $entries += [pscustomobject]@{
      path = [string]$entry.path
      exists = $true
      bytes = [int64]$item.Length
      sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  } else {
    $entries += [pscustomobject]@{ path = [string]$entry.path; exists = $false; bytes = 0; sha256 = $null }
  }
}
[pscustomobject]@{ entries = $entries } | ConvertTo-Json -Depth 4 -Compress
`, {
      entries: runtimeEntries.map(({ path: entryPath, remotePath }) => ({ path: entryPath, remotePath })),
    }), `worker ${worker.workerId} runtime pre-check`);
    if ((remoteWorkspaceState.entries ?? []).length !== runtimeEntries.length) {
      throw new Error(`worker ${worker.workerId} runtime pre-check returned an incomplete inventory`);
    }
    for (const entry of remoteWorkspaceState.entries ?? []) {
      const signed = runtimeEntries.find((candidate) => candidate.path === entry.path);
      if (!signed) throw new Error(`worker ${worker.workerId} returned an unrequested runtime path`);
      // Existing bytes may differ only at the exact fixed plan runtime target;
      // source files are never uploaded and remain protected by clean HEAD.
      if (entry.exists === true && (!Number.isInteger(Number(entry.bytes)) || !/^[a-f0-9]{64}$/.test(String(entry.sha256 ?? '')))) {
        throw new Error(`worker ${worker.workerId} runtime pre-check is malformed for ${entry.path}`);
      }
    }
    if (!reusePreparedWorkers) ensureSuccessful(await runRemote(worker, `
$root = [string]$payload.remoteRoot
if (Test-Path -LiteralPath $root) { throw 'remote execution root already exists' }
[void](New-Item -ItemType Directory -Path $root)
[void](New-Item -ItemType Directory -Path (Join-Path $root 'leases'))
[void](New-Item -ItemType Directory -Path (Join-Path $root 'logs'))
foreach ($directory in @($payload.runtimeDirectories)) {
  [void](New-Item -ItemType Directory -Path ([string]$directory) -Force)
}
`, {
      remoteRoot,
      runtimeDirectories: [...new Set(runtimeEntries.map((entry) => path.win32.dirname(entry.remotePath)))],
    }), `worker ${worker.workerId} isolated-root initialization`);
    await upload(worker, planPath, remotePlanPath);
    if (!reusePreparedWorkers) {
      for (const entry of runtimeEntries) await upload(worker, entry.localPath, entry.remotePath);
    }
    const verification = await runRemoteJsonWithRetries((attempt) => runRemote(worker, `
$actual = @()
foreach ($entry in @($payload.entries)) {
  $target = [string]$entry.remotePath
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "runtime missing: $target" }
  $item = Get-Item -LiteralPath $target
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($item.Length -ne [int64]$entry.bytes -or $hash -ne [string]$entry.sha256) { throw "runtime mismatch: $target" }
  $actual += [pscustomobject]@{ path = [string]$entry.path; bytes = [int64]$item.Length; sha256 = $hash }
}
$planHash = (Get-FileHash -LiteralPath ([string]$payload.planPath) -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{ runtime = $actual; planSha256 = $planHash } | ConvertTo-Json -Depth 5 -Compress
`, {
      entries: runtimeEntries.map(({ path: entryPath, bytes, sha256, remotePath }) => ({
        path: entryPath, bytes, sha256, remotePath,
      })),
      planPath: remotePlanPath,
    }), `worker ${worker.workerId} runtime verification`);
    if (verification.planSha256 !== fileAuthorityEntry(planPath, path.basename(planPath)).sha256) {
      throw new Error(`worker ${worker.workerId} copied plan hash mismatch`);
    }
    // Runtime targets are the only workspace writes. Re-check exact HEAD and a
    // clean tree afterward so a tracked package change or concurrent source
    // edit blocks every lease before the first paid cell.
    await queryWorker(worker);
    const runtimeByPath = new Map(runtimeEntries.map((entry) => [entry.path, entry]));
    const driver = {
      sysSha256: runtimeByPath.get('drivers/windows-virtual-mic/package/omni-virtual-speaker.sys')?.sha256,
      catSha256: runtimeByPath.get('drivers/windows-virtual-mic/package/omni-virtual-speaker.cat')?.sha256,
      infSha256: runtimeByPath.get('drivers/windows-virtual-mic/package/omni-virtual-speaker.inf')?.sha256,
    };
    if (Object.values(driver).some((value) => !/^[a-f0-9]{64}$/.test(String(value ?? '')))) {
      throw new Error(`worker ${worker.workerId} signed runtime lacks driver SYS/CAT/INF readiness bindings`);
    }
    const readinessPayload = {
      workspaceRoot: worker.workspaceRoot,
      remoteRoot,
      user: worker.user,
      executionId: plan.executionId,
      readinessRequestDigest: plan.workerReadinessRequest?.requestDigest ?? plan.planDigest,
      workerId: worker.workerId,
      vmIdentityDigest: plan.workers.find((entry) => entry.workerId === worker.workerId)?.vmIdentityDigest,
      runtimeBundleDigest: plan.authority.runtimeBundleDigest,
      driver,
      driverRequired: Boolean(plan.workers.find((entry) => (
        entry.workerId === worker.workerId
      ))?.driverRequired ?? plan.cells?.some((cell) => (
        cell.workerId === worker.workerId && cell.feedbackLoopPrevention === 'virtual-driver'
      ))),
      profiles: worker.deviceProfileInstances,
    };
    const readiness = reusePreparedWorkers
      ? parseRemoteJson(await runRemote(
          worker,
          PRODUCTION_PRESERVED_WORKER_READINESS_BODY,
          readinessPayload,
        ), `worker ${worker.workerId} preserved zero-provider readiness`)
      : await (async () => {
          parseRemoteJson(await runRemote(
            worker,
            PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY,
            readinessPayload,
            { timeoutMs: PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS },
          ), `worker ${worker.workerId} control-plane zero-provider readiness`);
          const runtimeByPathForReadiness = new Map(runtimeEntries.map((entry) => [entry.path, entry]));
          const probeEntry = runtimeByPathForReadiness.get('target/release/omni-physical-output-probe.exe');
          const bridgeEntry = runtimeByPathForReadiness.get('target/release/omni-bridge-service.exe');
          if (!probeEntry || !bridgeEntry) {
            throw new Error(`worker ${worker.workerId} runtime lacks endpoint/Bridge readiness executables`);
          }
          const interactiveRequest = {
            ...interactiveRequestBase({
              plan,
              worker,
              remoteRoot,
              mode: 'endpoint-readiness',
              timeoutMs: 300_000,
            }),
            readinessRequestDigest: readinessPayload.readinessRequestDigest,
            profiles: worker.deviceProfileInstances,
            probeExecutable: path.win32.join(worker.workspaceRoot, ...probeEntry.path.split('/')),
            bridgeExecutable: path.win32.join(worker.workspaceRoot, ...bridgeEntry.path.split('/')),
          };
          parseRemoteJson(await runRemote(
            worker,
            PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY,
            {
              workspaceRoot: worker.workspaceRoot,
              controlScriptSha256: interactiveRequest.controlScriptSha256,
              interactiveRequest,
            },
            { timeoutMs: 330_000 },
          ), `worker ${worker.workerId} interactive endpoint readiness`);
          return parseRemoteJson(await runRemote(
            worker,
            PRODUCTION_WORKER_READINESS_FINALIZE_BODY,
            readinessPayload,
            { timeoutMs: 45_000 },
          ), `worker ${worker.workerId} zero-provider readiness finalization`);
        })();
    if (
      Number(readiness.providerCalls) !== 0
      || readiness.readinessRequestDigest !== readinessPayload.readinessRequestDigest
      || readiness.executionId !== plan.executionId
      || readiness.workerId !== worker.workerId
      || readiness.credentialStatus?.backend !== 'windows-credential-manager'
      || readiness.credentialStatus?.exists !== true
      || readiness.credentialStatus?.reference !== DASHSCOPE_CREDENTIAL_REFERENCE
      || readiness.credentialStatus?.targetName !== 'OmniTranslate:credential___provider_dashscope_default'
      || readiness.credentialStatus?.blobNonEmpty !== true
      || !Number.isInteger(Number(readiness.credentialStatus?.credentialBlobBytes))
      || Number(readiness.credentialStatus?.credentialBlobBytes) <= 0
      || Number(readiness.credentialStatus?.credentialBlobBytes) > 2_560
      || !readiness.credentialStatus?.checkedAt
      || !readiness.credentialStatus?.probeProcess
      || !Array.isArray(readiness.profiles)
      || readiness.profiles.length !== worker.deviceProfileInstances.length
    ) throw new Error(`worker ${worker.workerId} zero-provider readiness receipt is incomplete`);
    return { workerId: worker.workerId, remoteRoot, readiness };
  }

  async function dispatchCell({ cell, lease, signal }) {
    const worker = workersById.get(cell.workerId);
    const remoteRoot = remoteRoots.get(cell.workerId);
    const leasePath = leasePathById.get(lease.leaseId);
    if (!worker || !remoteRoot || !leasePath) throw new Error(`transport lacks binding for ${cell.cellId}`);
    const remoteLeasePath = path.win32.join(remoteRoot, 'leases', `${String(cell.cellIndex + 1).padStart(2, '0')}-${lease.leaseId}.json`);
    await upload(worker, leasePath, remoteLeasePath, { signal, timeoutMs: 60_000 });
    remoteLeasePaths.set(lease.leaseId, remoteLeasePath);
    const interactiveRequest = {
      ...interactiveRequestBase({
        plan,
        worker,
        remoteRoot,
        mode: 'shard-cell',
        timeoutMs: PRODUCTION_REMOTE_CELL_TIMEOUT_MS - 30_000,
      }),
      planPath: path.win32.join(remoteRoot, SHARD_EXECUTION_PLAN_FILE),
      planSha256: fileAuthorityEntry(planPath, path.basename(planPath)).sha256,
      leasePath: remoteLeasePath,
      leaseSha256: fileAuthorityEntry(leasePath, path.basename(leasePath)).sha256,
      leaseId: lease.leaseId,
      leaseDigest: lease.leaseDigest,
      cellId: cell.cellId,
      feedbackLoopPrevention: cell.feedbackLoopPrevention,
      readinessPath: path.win32.join(remoteRoot, 'readiness', 'zero-provider-readiness.json'),
    };
    const result = await runRemote(worker, PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY, {
      workspaceRoot: worker.workspaceRoot,
      controlScriptSha256: interactiveRequest.controlScriptSha256,
      interactiveRequest,
    }, { signal, timeoutMs: PRODUCTION_REMOTE_CELL_TIMEOUT_MS });
    ensureSuccessful(result, `remote paid cell ${cell.cellId}`);
    const interactive = JSON.parse(lastNonEmptyLine(result.stdout));
    const interactiveTerminal = interactive.terminal;
    if (
      interactiveTerminal.leaseId !== lease.leaseId
      || interactiveTerminal.user !== worker.user
      || Number(interactiveTerminal.sessionId) !== 1
      || Number(interactiveTerminal.exitCode) !== 0
      || Number(interactiveTerminal.processAuthorityExitCode) !== 0
      || Number(interactive.taskTerminal?.lastTaskResult) !== 0
    ) throw new Error(`remote paid cell ${cell.cellId} did not finish in the bound interactive session`);
    const remoteResultPath = String(interactive.finalResultPath ?? '');
    const remoteRunDirectory = path.win32.dirname(remoteResultPath);
    const runRelative = safeRemoteChild(remoteRoot, remoteRunDirectory, `remote result ${cell.cellId}`);
    const validationRoot = validationRoots.get(worker.workerId);
    const localRunDirectory = path.join(validationRoot, ...runRelative.split(path.win32.sep));
    if (fs.existsSync(localRunDirectory)) throw new Error(`refusing to overwrite validation result for ${cell.cellId}`);
    await downloadTree(worker, remoteRunDirectory, path.dirname(localRunDirectory), { timeoutMs: 300_000 });
    const localResultPath = path.join(localRunDirectory, SHARD_CELL_RESULT_FILE);
    const validated = validateShardCellResult({
      resultPath: localResultPath,
      plan,
      lease,
      shardRoot: validationRoot,
      now: new Date(),
    });
    completedRemoteResults.set(cell.cellId, {
      leaseId: lease.leaseId,
      remoteResultPath,
      resultDigest: validated.result.resultDigest,
      commandPath: interactive.commandPath,
      commandSha256: interactive.commandSha256,
      launchPath: interactive.launchPath,
      terminalPath: interactive.terminalPath,
      taskTerminalPath: interactive.taskTerminalPath,
      processAuthorityPath: interactive.processAuthorityPath,
    });
    return { ...validated, resultPath: localResultPath };
  }

  async function cancelCell({ cell, lease }) {
    const worker = workersById.get(cell.workerId);
    const remoteRoot = remoteRoots.get(cell.workerId);
    if (!worker || !remoteRoot) return;
    const taskName = interactiveTaskName({
      executionId: plan.executionId,
      workerId: worker.workerId,
      leaseId: lease.leaseId,
    });
    await runRemote(worker, `
$root = [IO.Path]::GetFullPath([string]$payload.remoteRoot)
$taskPath = '\\OmniTranslate\\'
$taskName = [string]$payload.taskName
$launchPath = Join-Path $root ('interactive\\' + [string]$payload.leaseId + '\\launch.json')

# The task name is derived from the signed execution/worker/lease tuple.  Stop
# only that exact task before considering a child process.  A missing task is
# normal when the one-shot control helper has already cleaned it up.
if (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
}
for ($attempt = 0; $attempt -lt 20 -and -not (Test-Path -LiteralPath $launchPath -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 250
}
if (Test-Path -LiteralPath $launchPath -PathType Leaf) {
  try {
    $launch = Get-Content -LiteralPath $launchPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
      $launch.schemaVersion -ne 1 -or
      [string]$launch.artifactKind -ne 'watch-mode-interactive-shard-launch-authority' -or
      [string]$launch.executionId -ne [string]$payload.executionId -or
      [string]$launch.leaseId -ne [string]$payload.leaseId -or
      [string]$launch.workerId -ne [string]$payload.workerId -or
      [string]$launch.taskName -ne $taskName
    ) { throw 'launch authority does not bind the cancelled lease' }
    $processId = [int]$launch.nodeProcess.pid
    $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if ($actual) {
      $process = Get-Process -Id $processId -ErrorAction Stop
      $actualStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
      $actualImagePath = [IO.Path]::GetFullPath([string]$actual.ExecutablePath)
      $actualImageSha256 = (Get-FileHash -LiteralPath $actualImagePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if (
        [int]$actual.SessionId -eq [int]$launch.nodeProcess.sessionId -and
        $actualStartedAt -ceq [string]$launch.nodeProcess.startedAt -and
        $actualImagePath -ceq [IO.Path]::GetFullPath([string]$launch.nodeProcess.imagePath) -and
        $actualImageSha256 -ceq [string]$launch.nodeProcess.imageSha256
      ) { & taskkill.exe /PID $processId /F /T 2>$null | Out-Null }
    }
  } catch {
    # A malformed or stale launch authority never permits an unguarded kill.
  }
}
if (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
`, {
      remoteRoot,
      executionId: plan.executionId,
      workerId: worker.workerId,
      leaseId: lease.leaseId,
      taskName,
    }, { timeoutMs: 15_000 }).catch(() => {});
  }

  async function collectWorker({ worker: planWorker, leases, results, generatedAt = new Date() }) {
    const worker = workersById.get(planWorker.workerId);
    const remoteRoot = remoteRoots.get(planWorker.workerId);
    if (!worker || !remoteRoot) throw new Error(`transport lacks worker ${planWorker.workerId} for collection`);
    await queryWorker(worker);
    const expectedCells = plan.cells
      .filter((cell) => cell.workerId === planWorker.workerId)
      .sort((left, right) => left.cellIndex - right.cellIndex);
    const leaseById = new Map(leases.map((lease) => [lease.leaseId, lease]));
    if (leaseById.size !== leases.length) throw new Error('collection received duplicate lease identifiers');
    const assignedLeases = expectedCells.map((cell) => {
      const lease = leaseById.get(cell.leaseId);
      if (!lease || lease.cellId !== cell.cellId) {
        throw new Error(`worker ${planWorker.workerId} has no exact lease for ${cell.cellId}`);
      }
      return lease;
    });
    const remoteResultPaths = expectedCells.map((cell) => {
      const completed = completedRemoteResults.get(cell.cellId);
      const waveResult = results.get(cell.cellId);
      if (
        !completed
        || completed.leaseId !== cell.leaseId
        || !waveResult?.result
        || waveResult.result.resultDigest !== completed.resultDigest
      ) throw new Error(`worker ${planWorker.workerId} is missing the exact completed result for ${cell.cellId}`);
      safeRemoteChild(remoteRoot, completed.remoteResultPath, `completed remote result ${cell.cellId}`);
      return completed.remoteResultPath;
    });
    if (assignedLeases.length !== expectedCells.length || remoteResultPaths.length !== expectedCells.length) {
      throw new Error(`worker ${planWorker.workerId} assignment collection count is inconsistent`);
    }
    const remoteFinalizationRequestPath = path.win32.join(
      remoteRoot,
      'finalization',
      'worker-shard-finalization-request.json',
    );
    const remoteManifestPath = path.win32.join(remoteRoot, 'shard-manifest.json');
    const finalized = parseRemoteJson(await runRemote(worker, `
$workspace = [IO.Path]::GetFullPath([string]$payload.workspaceRoot)
$root = [IO.Path]::GetFullPath([string]$payload.remoteRoot)
$requestPath = [IO.Path]::GetFullPath([string]$payload.requestPath)
$runnerPath = Join-Path $workspace 'scripts\\testing\\run-watch-mode-live-shard.mjs'
if ((Get-FileHash -LiteralPath $runnerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$payload.shardRunnerSha256) {
  throw 'guest shard finalizer does not match the signed orchestration inventory'
}
$head = (& git.exe -C $workspace rev-parse HEAD 2>&1 | Select-Object -Last 1).Trim().ToLowerInvariant()
$dirty = @(& git.exe -C $workspace status --porcelain=v1 --untracked-files=all 2>&1)
if ($LASTEXITCODE -ne 0 -or $head -cne [string]$payload.expectedHeadCommit -or $dirty.Count -ne 0) {
  throw 'guest finalization requires the signed clean repository HEAD'
}
if (Test-Path -LiteralPath $requestPath -PathType Leaf) { throw 'worker finalization request already exists' }
if (@($payload.leasePaths).Count -ne [int]$payload.assignedCellCount -or @($payload.resultPaths).Count -ne [int]$payload.assignedCellCount) {
  throw 'worker finalization request does not preserve exact assigned-cell count'
}
foreach ($candidate in @($payload.leasePaths) + @($payload.resultPaths)) {
  $full = [IO.Path]::GetFullPath([string]$candidate)
  if (-not $full.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw 'worker finalization input is outside the guest shard root or missing'
  }
}
$request = [ordered]@{
  schemaVersion = 1
  artifactKind = 'watch-mode-worker-shard-finalization-request'
  planPath = [string]$payload.planPath
  leasePaths = @($payload.leasePaths)
  resultPaths = @($payload.resultPaths)
  workerId = [string]$payload.workerId
  shardRoot = $root
}
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($requestPath))
$bytes = (New-Object Text.UTF8Encoding($false)).GetBytes((($request | ConvertTo-Json -Depth 12 -Compress) + [Environment]::NewLine))
$stream = New-Object IO.FileStream($requestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough)
try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
$output = @(& node.exe $runnerPath '--finalize-worker-request' $requestPath 2>&1)
if ($LASTEXITCODE -ne 0) { throw "guest worker finalizer failed: $($output -join ' | ')" }
$manifestPath = [IO.Path]::GetFullPath([string](@($output | Where-Object { $_ } | Select-Object -Last 1)[0]))
if ($manifestPath -cne [IO.Path]::GetFullPath([string]$payload.expectedManifestPath) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'guest worker finalizer did not create the fixed shard manifest'
}
[ordered]@{ manifestPath = $manifestPath } | ConvertTo-Json -Compress
`, {
      workspaceRoot: worker.workspaceRoot,
      remoteRoot,
      requestPath: remoteFinalizationRequestPath,
      expectedManifestPath: remoteManifestPath,
      planPath: path.win32.join(remoteRoot, SHARD_EXECUTION_PLAN_FILE),
      leasePaths: assignedLeases.map((lease) => {
        const remoteLeasePath = remoteLeasePaths.get(lease.leaseId);
        if (!remoteLeasePath) throw new Error(`worker ${planWorker.workerId} did not retain remote lease ${lease.leaseId}`);
        safeRemoteChild(remoteRoot, remoteLeasePath, `remote lease ${lease.leaseId}`);
        return remoteLeasePath;
      }),
      resultPaths: remoteResultPaths,
      assignedCellCount: expectedCells.length,
      workerId: planWorker.workerId,
      expectedHeadCommit: String(plan.provenance.headCommit).toLowerCase(),
      shardRunnerSha256: orchestrationHash(plan, ORCHESTRATION_SHARD_RUNNER),
    }), `worker ${planWorker.workerId} guest shard finalization`);
    if (String(finalized.manifestPath).toLowerCase() !== remoteManifestPath.toLowerCase()) {
      throw new Error(`worker ${planWorker.workerId} returned an unexpected manifest path`);
    }
    const collectionParent = path.join(coordinatorExecutionRoot, 'collected-shards');
    const finalShardRoot = path.join(collectionParent, planWorker.workerId);
    if (fs.existsSync(finalShardRoot)) throw new Error(`refusing to overwrite collected shard ${planWorker.workerId}`);
    fs.mkdirSync(collectionParent, { recursive: true });
    const temporaryParent = path.join(
      collectionParent,
      `.incoming-${planWorker.workerId}-${process.pid}-${crypto.randomBytes(5).toString('hex')}`,
    );
    fs.mkdirSync(temporaryParent, { recursive: false });
    await downloadTree(worker, remoteRoot, temporaryParent, { timeoutMs: 600_000 });
    const downloaded = fs.readdirSync(temporaryParent, { withFileTypes: true });
    if (downloaded.length !== 1 || !downloaded[0].isDirectory() || downloaded[0].isSymbolicLink()) {
      throw new Error(`worker ${planWorker.workerId} recovery did not contain exactly one shard directory`);
    }
    const downloadedRoot = path.join(temporaryParent, downloaded[0].name);
    fs.renameSync(downloadedRoot, finalShardRoot);
    fs.rmdirSync(temporaryParent);
    const manifestPath = path.join(finalShardRoot, 'shard-manifest.json');
    validateShardManifest({
      manifestPath,
      shardRoot: finalShardRoot,
      plan,
      leases,
      now: generatedAt,
    });
    return { workerId: planWorker.workerId, shardRoot: finalShardRoot, manifestPath };
  }

  return { prepareWorker, dispatchCell, cancelCell, collectWorker };
}

function productionDeviceProfiles(plan) {
  return canonicalDeviceProfiles(
    plan.cells.map((cell) => cell.deviceProfileInstance),
    'signed workers',
  );
}

export async function runProductionCoordinator({
  workerConfig,
  reuseLocalIsolation,
  coordinatorOutputRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-live-coordinator'),
  evidenceOutputRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-live'),
  executionId = `watch-shard-${crypto.randomUUID()}`,
  now = () => new Date(),
  operations = {},
}) {
  const canonicalCoordinatorOutputRoot = path.join(
    repoRoot,
    'artifacts',
    'testing',
    'watch-mode-live-coordinator',
  );
  if (
    path.resolve(coordinatorOutputRoot) !== path.resolve(canonicalCoordinatorOutputRoot)
  ) {
    throw new Error('production provider preflight requires the canonical coordinator authorization root');
  }
  const config = typeof workerConfig === 'string'
    ? readProductionWorkerConfig(workerConfig)
    : validateProductionWorkerConfig(workerConfig, { configDirectory: repoRoot });
  if (!String(reuseLocalIsolation ?? '').trim()) {
    throw new Error('production coordinator requires --reuse-local-isolation before build/preflight/provider launch');
  }
  const generatedAt = now();
  const productionWorkers = config.workers.map(({
    workerId, user, vmIdentity, deviceProfileInstances,
  }) => ({
    workerId, interactiveUser: user, vmIdentity, deviceProfileInstances,
  }));
  const productionAssignments = defaultThreeVmAssignments(config.workers);
  const productionWaveCount = Math.max(...productionAssignments.map((entry) => entry.waveIndex)) + 1;
  const captureProvenance = operations.captureProvenance
    ?? (async () => currentGitProvenance({ cwd: repoRoot }));
  const buildRuntimeAuthority = operations.buildRuntimeAuthority
    ?? (async ({ coordinatorKeyId }) => buildStrictRuntimeAuthority({
      environment: {
        ...strictRuntimeEnvironment(process.env),
        OMNI_PROVIDER_PREFLIGHT_COORDINATOR_KEY_ID: coordinatorKeyId,
      },
    }));
  const captureAuthorityImplementationHashes = operations.captureAuthorityImplementationHashes
    ?? (async () => currentAuthorityImplementationHashes({ workspaceRoot: repoRoot }));
  const captureShardImplementationHashes = operations.captureShardImplementationHashes
    ?? (async () => currentShardOrchestrationImplementationHashes({ workspaceRoot: repoRoot }));
  const runProviderPreflight = operations.runProviderPreflight ?? (async ({
    provenance,
    grant,
    grantPath,
    leaseReservationDirectory,
    authorization,
    authorizationDigest,
  }) => {
    const preflight = runStrictProviderPreflight({
      providerId: grant.authorization.providerId,
      provenance,
      expectedAuthorization: authorization,
      environment: {
        ...strictRuntimeEnvironment(process.env),
        [PROVIDER_PREFLIGHT_GRANT_PATH_ENV]: grantPath,
        [PROVIDER_PREFLIGHT_RESERVATION_DIRECTORY_ENV]: leaseReservationDirectory,
        [PROVIDER_PREFLIGHT_AUTHORIZATION_DIGEST_ENV]: authorizationDigest,
      },
    });
    return {
      providerId: preflight.providerId,
      operation: 'text-translation-preflight',
      inputMode: 'text-only',
      providerInvocationCount: 1,
      status: 'completed',
      externalAudioSamples: 0,
      evidenceDirectory: preflight.outputDirectory,
    };
  });
  let readinessPreparation = null;
  const runZeroProviderWorkerReadiness = async (context) => {
    const implementation = operations.runZeroProviderWorkerReadiness ?? (async ({
      executionId: readinessExecutionId,
      executionRoot,
      generatedAt: readinessGeneratedAt,
      provenance,
      runtimeBinaryHashes,
      shardOrchestrationImplementationHashes,
      workers,
      assignments,
    }) => {
      const workerReadinessRequest = createWorkerReadinessRequest({
        executionId: readinessExecutionId,
        generatedAt: readinessGeneratedAt,
        provenance,
        runtimeBinaryHashes,
        workers,
        assignments,
      });
      const requestPath = path.join(executionRoot, 'worker-readiness-request.json');
      atomicWriteJson(requestPath, workerReadinessRequest);
      const readinessPlan = {
        executionId: readinessExecutionId,
        provenance,
        authority: {
          runtimeBinaryHashes: workerReadinessRequest.runtimeBinaryHashes,
          runtimeBundleDigest: workerReadinessRequest.runtimeBundleDigest,
          shardOrchestrationImplementationHashes,
        },
        workers: workerReadinessRequest.workers,
        cells: workerReadinessRequest.assignments,
        planDigest: workerReadinessRequest.requestDigest,
      };
      const readinessTransport = createSshProductionTransport({
        config,
        plan: readinessPlan,
        planPath: requestPath,
        leasePaths: [],
        coordinatorExecutionRoot: executionRoot,
      });
      const completed = await Promise.all(readinessPlan.workers.map((worker) => (
        readinessTransport.prepareWorker({ worker })
      )));
      const readinessAuthorityRoot = path.join(executionRoot, 'worker-readiness');
      return {
        workerReadinessRequest,
        requestAuthority: fileAuthorityEntry(requestPath, 'worker-readiness-request.json'),
        workers: completed.map((entry) => {
          const receiptPath = path.join(readinessAuthorityRoot, `${entry.workerId}.json`);
          atomicWriteJson(receiptPath, entry.readiness);
          return {
            workerId: entry.workerId,
            providerCalls: Number(entry.readiness.providerCalls),
            driverRequired: Boolean(entry.readiness.driverRequired),
            ...fileAuthorityEntry(
              receiptPath,
              `worker-readiness/${entry.workerId}.json`,
            ),
          };
        }),
      };
    });
    readinessPreparation = await implementation(context);
    return readinessPreparation;
  };
  const obtainLocalIsolationAuthority = operations.obtainLocalIsolationAuthority ?? (async ({
    provenance,
    runtimeBinaryHashes,
  }) => {
    const manifestPath = resolveReusableLocalIsolationManifest(reuseLocalIsolation, { workspaceRoot: repoRoot });
    const implementationHashes = currentAuthorityImplementationHashes({ workspaceRoot: repoRoot });
    const reuse = createReusableLocalIsolationAuthority({
      manifestPath,
      provenance,
      implementationHashes,
      runtimeBinaryHashes,
      workspaceRoot: repoRoot,
    });
    verifyLocalIsolationManifest({
      manifestPath,
      workspaceRoot: repoRoot,
      provenance,
      runtimeBinaryHashes,
      reuseAuthority: reuse,
    });
    const relative = path.relative(repoRoot, manifestPath).split(path.sep).join('/');
    return {
      ...fileAuthorityEntry(manifestPath, relative),
      manifestPath: relative,
      providerCalls: 0,
      reuse,
    };
  });
  const preparation = await (operations.prepareCoordinatorExecution ?? prepareCoordinatorExecution)({
    outputRoot: coordinatorOutputRoot,
    executionId,
    workers: productionWorkers,
    assignments: productionAssignments,
    generatedAt,
    expiresAt: new Date(generatedAt.getTime() + 6 * 60 * 60 * 1_000),
    captureProvenance,
    buildRuntimeAuthority,
    captureAuthorityImplementationHashes,
    captureShardImplementationHashes,
    runZeroProviderWorkerReadiness,
    runProviderPreflight,
    obtainLocalIsolationAuthority,
    minimumRemainingExecutionMs: (
      productionWaveCount * PRODUCTION_REMOTE_CELL_TIMEOUT_MS
      + PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS
    ),
  });
  if (!operations.createTransport && (
    !readinessPreparation?.workerReadinessRequest
    || preparation.plan?.workerReadinessRequest?.requestDigest
      !== readinessPreparation.workerReadinessRequest.requestDigest
  )) throw new Error('production SSH transport requires pre-provider readiness bound into the signed plan');
  const transport = operations.createTransport
    ? await operations.createTransport({ config, preparation })
    : createSshProductionTransport({
        config,
        plan: preparation.plan,
        planPath: preparation.planPath,
        leasePaths: preparation.leasePaths,
        coordinatorExecutionRoot: preparation.executionRoot,
        reusePreparedWorkers: true,
      });
  const waveOutcome = await (operations.runCoordinatorWaves ?? runCoordinatorWaves)({
    plan: preparation.plan,
    leases: preparation.leases,
    executionRoot: preparation.executionRoot,
    assertWorkerReady: ({ worker }) => transport.prepareWorker({ worker }),
    dispatchCell: ({ cell, lease, signal }) => transport.dispatchCell({ cell, lease, signal }),
    cancelCell: ({ cell, lease }) => transport.cancelCell({ cell, lease }),
    validateCompletedCell: async ({ outcome }) => {
      if (
        outcome?.result?.verdict !== 'passed'
        || !outcome.result.workerReadinessAuthority
      ) throw new Error('SSH worker result did not pass local raw/readiness validation');
      return outcome;
    },
    now,
  });
  const shards = await Promise.all(preparation.plan.workers.map((worker) => transport.collectWorker({
    worker,
    leases: preparation.leases,
    results: waveOutcome.results,
    generatedAt: now(),
  })));
  const aggregation = (operations.writeCoordinatorAggregate ?? writeCoordinatorAggregate)({
    outputRoot: preparation.executionRoot,
    executionRoot: preparation.executionRoot,
    plan: preparation.plan,
    leases: preparation.leases,
    shards,
    generatedAt: now(),
  });
  const staged = (operations.stageShardMatrixIntegration ?? stageShardMatrixIntegration)({
    evidenceRoot: evidenceOutputRoot,
    executionRootName: `shards-${preparation.plan.executionId}`,
    planPath: preparation.planPath,
    leasePaths: preparation.leasePaths,
    coordinatorAggregatePath: aggregation.aggregatePath,
    shards,
    collectedMatrixIntegration: aggregation.matrixIntegration,
  });
  const assertBudget = operations.assertCellExternalProviderBudget ?? assertCellExternalProviderBudget;
  const rawBudgets = staged.runDirectories.map((runDirectory, index) => assertBudget(
    runDirectory,
    {
      cellId: LIVE_LLM_CELLS[index].cellId,
      modelId: LIVE_LLM_CELLS[index].modelId,
      feedbackLoopPrevention: LIVE_LLM_CELLS[index].feedbackLoopPrevention,
      sessionCeilingSeconds: LIVE_LLM_CELLS[index].durationSeconds,
    },
  ));
  const matrixBudget = (operations.writeMatrixExternalProviderBudget ?? writeMatrixExternalProviderBudget)(evidenceOutputRoot, rawBudgets, {
    fileName: `watch-mode-external-provider-budget-${preparation.plan.executionId}.json`,
  });
  const budgetAuthority = fileAuthorityEntry(matrixBudget.filePath, path.basename(matrixBudget.filePath));
  const externalProviderBudget = {
    ...matrixBudget.ledger,
    ledgerPath: budgetAuthority.path,
    ledgerBytes: budgetAuthority.bytes,
    ledgerSha256: budgetAuthority.sha256,
  };
  const deviceProfiles = productionDeviceProfiles(preparation.plan);
  const manifestResult = (operations.writeMatrixRunManifest ?? writeMatrixRunManifest)({
    outputRoot: evidenceOutputRoot,
    modelList: DEFAULT_MODELS,
    feedbackModeList: DEFAULT_FEEDBACK_MODES,
    deviceProfiles,
    runDirectories: staged.runDirectories,
    strict: true,
    now: now(),
    provenance: preparation.plan.provenance,
    authorityRuntimeBinaryHashes: preparation.plan.authority.runtimeBinaryHashes,
    releaseCells: LIVE_LLM_CELLS,
    localIsolationAuthority: preparation.plan.localIsolationAuthority,
    externalProviderBudget,
    shardExecution: staged.shardExecution,
    matrixIntegration: staged.matrixIntegration,
  });
  const verifyResult = operations.runVerifier
    ? await operations.runVerifier({ manifestPath: manifestResult.manifestPath, evidenceOutputRoot })
    : spawnSync(
        process.execPath,
        buildVerifyArgv(
          evidenceOutputRoot,
          DEFAULT_MODELS,
          DEFAULT_FEEDBACK_MODES,
          SUPPORTED_DEVICE_CLASSES,
          manifestResult.manifestPath,
          { strict: true },
        ),
        { cwd: repoRoot, stdio: 'inherit', windowsHide: true },
      );
  if (Number(verifyResult?.status ?? verifyResult?.exitCode ?? 1) !== 0) {
    throw new Error('production sharded strict evidence verification failed; canonical manifest was not published');
  }
  const published = (operations.publishSuccessfulStrictMatrixManifest ?? publishSuccessfulStrictMatrixManifest)({
    outputRoot: evidenceOutputRoot,
    manifestPath: manifestResult.manifestPath,
    verifiedAt: now(),
    currentProvenance: preparation.plan.provenance,
    currentRuntimeBinaryHashes: preparation.plan.authority.runtimeBinaryHashes,
  });
  return {
    executionId: preparation.plan.executionId,
    coordinatorExecutionRoot: preparation.executionRoot,
    stagedExecutionRoot: staged.finalExecutionRoot,
    runManifest: manifestResult.manifestPath,
    canonicalRunManifest: published.canonicalPath,
    externalProviderBudget,
    waveCount: preparation.plan.waves.length,
    workerCount: preparation.plan.workers.length,
  };
}

export function parseProductionCoordinatorCliArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      workersConfig: '',
      reuseLocalIsolation: '',
      coordinatorOutputRoot: 'artifacts/testing/watch-mode-live-coordinator',
      evidenceOutputRoot: 'artifacts/testing/watch-mode-live',
      executionId: '',
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    const options = parseProductionCoordinatorCliArgs(process.argv.slice(2));
    if (!options.workersConfig) throw new Error('--workers-config is required');
    if (!options.reuseLocalIsolation) throw new Error('--reuse-local-isolation is required');
    if (options.executionId && !SAFE_ID.test(options.executionId)) throw new Error('--execution-id is not portable');
    const result = await runProductionCoordinator({
      workerConfig: path.resolve(repoRoot, options.workersConfig),
      reuseLocalIsolation: options.reuseLocalIsolation,
      coordinatorOutputRoot: path.resolve(repoRoot, options.coordinatorOutputRoot),
      evidenceOutputRoot: path.resolve(repoRoot, options.evidenceOutputRoot),
      ...(options.executionId ? { executionId: options.executionId } : {}),
    });
    console.log(result.canonicalRunManifest);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
