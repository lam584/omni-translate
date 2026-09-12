import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from '../lib/testing-common.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import { verifyDistributedRuntimeDistribution } from './watch-mode-local-isolation-distributed.mjs';
import { windowsPowerShellEnvironment } from './run-watch-mode-live-production-coordinator.mjs';
import { verifyAecTapEvidence } from './watch-mode-aec-tap-evidence.mjs';
import { checkWatchDiskSpace } from './watch-mode-disk-lifecycle.mjs';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
export const LOCAL_AEC_DESKTOP_ENV_ALLOWLIST = Object.freeze(['SystemRoot','windir','SystemDrive','ComSpec','PATH','PATHEXT','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','COMMONPROGRAMW6432','USERNAME','USERDOMAIN','COMPUTERNAME','SESSIONNAME','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS']);
export const isProviderCredentialEnvironmentName = (name) => /(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|CREDENTIAL)/iu.test(name);
const writeJson = (name, value) => fs.writeFileSync(name, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
export const AEC_PROBE_JOB_HELPER = 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveFinalizer.psm1';
export const AEC_PROBE_INTERACTIVE_FILES = Object.freeze([
  'scripts/testing/lib/powershell/Omni.Testing.IO.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.Process.psm1',
  'scripts/testing/run-watch-mode-interactive-task.ps1',
  'scripts/testing/report-watch-mode-desktop-identity.ps1',
  'scripts/testing/collect-watch-mode-interactive-process-authority.ps1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveRequest.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveLocalAec.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveDesktopIdentity.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1',
  AEC_PROBE_JOB_HELPER,
  'scripts/testing/run-watch-mode-local-aec-probe.mjs',
]);
// Compiled into the opt-in startup implementation and its producer receipt.
// This is a non-executing version guard, not a substitute for selecting the
// trusted signed distribution digest. NEVER run an old EXE to query support:
// it could ignore the opt-in and preconnect a persisted Provider at startup.
export const AEC_PROBE_CAPABILITY_ID = 'omni-local-aec-probe/no-provider-startup/v1/20260912';

function readProbeReceipt(outputDirectory) {
  const file = path.join(outputDirectory, 'local-aec-probe-result.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024
      || fs.realpathSync.native(file) !== file) throw new Error('invalid or unbounded local AEC producer receipt');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
}

export function verifyLocalAecProbeRuntime(runtimeRoot, expectedDistributionDigest) {
  if (!/^[a-f0-9]{64}$/u.test(expectedDistributionDigest ?? '')) throw new Error('expected distribution digest is required');
  const root = fs.realpathSync.native(runtimeRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-distribution.json'), 'utf8'));
  if (manifest.distributionDigest !== expectedDistributionDigest || !Array.isArray(manifest.files)) {
    throw new Error('local AEC runtime does not match the explicitly selected distribution');
  }
  const names = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':')
        || file.path.split('/').some((part) => !part || part === '.' || part === '..')
        || names.has(file.path.toLowerCase())) throw new Error('unsafe or duplicate distribution file');
    names.add(file.path.toLowerCase());
    const candidate = path.join(root, ...file.path.split('/'));
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(candidate) !== candidate) {
      throw new Error(`distribution entry must be a regular local file: ${file.path}`);
    }
  }
  for (const name of AUTHORITY_RUNTIME_BINARY_FILES) {
    if (!names.has(name.toLowerCase())) throw new Error(`incomplete 15-file runtime: ${name}`);
  }
  verifyDistributedRuntimeDistribution({ workspaceRoot: root, manifest });
  const desktop = manifest.files.find((file) => file.path === 'target/release/omni-desktop-shell.exe');
  if (!desktop) throw new Error('desktop runtime entry must use its canonical path');
  if (!fs.readFileSync(path.join(root, desktop.path)).includes(Buffer.from(AEC_PROBE_CAPABILITY_ID))) {
    throw new Error('selected Desktop lacks the compiled zero-Provider local-AEC capability; refusing normal launch');
  }
  const interactiveFiles = Object.fromEntries(AEC_PROBE_INTERACTIVE_FILES.map((name) => {
    const entry = manifest.files.find((file) => file.path === name);
    if (!entry) throw new Error(`selected runtime does not freeze interactive probe dependency: ${name}`);
    return [name, { path: path.join(root, ...name.split('/')), sha256: entry.sha256 }];
  }));
  return { root, executable: path.join(root, desktop.path), executableSha256: desktop.sha256,
    helperSha256: interactiveFiles[AEC_PROBE_JOB_HELPER].sha256, interactiveFiles,
    probeCapabilityId: AEC_PROBE_CAPABILITY_ID, distributionDigest: manifest.distributionDigest };
}

export function localAecProbePowerShell({ runtime, outputDirectory, requestPath, deadlineUtc, workspaceRoot, executionId }) {
  const file = (name) => runtime.interactiveFiles[name];
  const requestModule = file('scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveRequest.psm1');
  const schedulerModule = file('scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1');
  const launcher = file('scripts/testing/run-watch-mode-interactive-task.ps1');
  const collector = file('scripts/testing/collect-watch-mode-interactive-process-authority.ps1');
  const desktopReporter = file('scripts/testing/report-watch-mode-desktop-identity.ps1');
  const runner = file('scripts/testing/run-watch-mode-local-aec-probe.mjs');
  const helper = file(AEC_PROBE_JOB_HELPER);
  const timeoutMs = Math.max(1, Date.parse(deadlineUtc) - Date.now());
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$OutputEncoding=[System.Text.Encoding]::UTF8
$workspace=${quote(workspaceRoot)}
$requestModule=${quote(requestModule.path)}
$schedulerModule=${quote(schedulerModule.path)}
if((Get-FileHash -LiteralPath $requestModule -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(requestModule.sha256)}) {throw 'interactive request module changed after preflight'}
if((Get-FileHash -LiteralPath $schedulerModule -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(schedulerModule.sha256)}) {throw 'interactive scheduler module changed after preflight'}
Import-Module $requestModule -Force
Import-Module $schedulerModule -Force
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$payload=[ordered]@{
 schemaVersion=1; artifactKind='watch-mode-interactive-task-request'; mode='local-aec-probe'
 workspaceRoot=$workspace; remoteRoot=${quote(outputDirectory)}; executionId=${quote(executionId)}
 planDigest=${quote(runtime.distributionDigest)}; workerId=$env:COMPUTERNAME.ToLowerInvariant()
 vmIdentityDigest=${quote(runtime.distributionDigest)}; expectedVmUuidBios=[string](Get-CimInstance Win32_ComputerSystemProduct).UUID
 user=$identity.Name.Split('\\')[-1]; timeoutMs=${timeoutMs}; expectedCredentialReference='none'
 requireSeparateControlPlane=$true; launcherSha256=${quote(launcher.sha256)}
 processAuthorityCollectorSha256=${quote(collector.sha256)}; shardRunnerSha256=${quote(runner.sha256)}
 probeRequestPath=${quote(requestPath)}; probeRequestSha256=(Get-FileHash -LiteralPath ${quote(requestPath)} -Algorithm SHA256).Hash.ToLowerInvariant()
 outputDirectory=${quote(outputDirectory)}; desktopExecutable=${quote(runtime.executable)}
 desktopExecutableSha256=${quote(runtime.executableSha256)}; finalizerHelperPath=${quote(helper.path)}
 finalizerHelperSha256=${quote(helper.sha256)}; desktopIdentityReporterPath=${quote(desktopReporter.path)}
 desktopIdentityReporterSha256=${quote(desktopReporter.sha256)}; nodeDesktopAuthorityPath=(Join-Path ${quote(outputDirectory)} 'node-desktop-identity.json')
}
$payloadBase64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Depth 20 -Compress)))
$context=Resolve-OmniInteractiveTaskRequest -PayloadBase64 $payloadBase64
Invoke-OmniInteractiveScheduledTask -Context $context
`;
}

export function localAecProbeDesktopPowerShell({ executable, executableSha256, runtimeRoot, outputDirectory, requestPath, deadlineUtc, helperPath, helperSha256 }) {
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$OutputEncoding=[System.Text.Encoding]::UTF8
$helper=${quote(helperPath)}
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(helperSha256)}) {throw 'process-custody helper changed after preflight'}
Import-Module $helper -Force
$allowed=@(${LOCAL_AEC_DESKTOP_ENV_ALLOWLIST.map(quote).join(',')})
foreach($variable in @(Get-ChildItem Env:)) { if($allowed -cnotcontains $variable.Name) { [Environment]::SetEnvironmentVariable($variable.Name,$null,'Process') } }
$env:OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST=${quote(requestPath)}
$env:OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY=${quote(outputDirectory)}
$credentialNames=@(Get-ChildItem Env: | Where-Object {$_.Name -match '(?i)(API_KEY|ACCESS_KEY|SECRET|TOKEN|CREDENTIAL)' } | ForEach-Object {$_.Name})
$audit=[ordered]@{schemaVersion=1;artifactKind='watch-mode-local-aec-desktop-environment-audit';credentialLikeCount=$credentialNames.Count;retainedNames=@(Get-ChildItem Env: | ForEach-Object {$_.Name} | Sort-Object);injectedNames=@('OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST','OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY')}
$auditBytes=[Text.UTF8Encoding]::new($false).GetBytes(($audit | ConvertTo-Json -Depth 4))
$auditStream=[IO.File]::Open(${quote(path.join(outputDirectory, 'desktop-environment-audit.json'))},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read); try{$auditStream.Write($auditBytes,0,$auditBytes.Length);$auditStream.Flush()}finally{$auditStream.Dispose()}
if($credentialNames.Count -ne 0) {throw 'credential-like environment survived local AEC desktop scrub'}
$exe=${quote(executable)}
if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(executableSha256)}) {throw 'desktop bytes changed after preflight'}
$result=[OmniInteractiveFinalizerJob]::Run($exe,'',${quote(runtimeRoot)},[DateTime]::Parse(${quote(deadlineUtc)}).ToUniversalTime())
[pscustomobject]@{exitCode=$result.ExitCode;stdout=$result.Stdout;stderr=$result.Stderr;ownedJobExited=$true} | ConvertTo-Json -Depth 4 -Compress
`;
}

export function executeInteractiveLocalAecRequest(commandPath) {
  const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
  if (command.mode !== 'local-aec-probe' || command.cellId !== 'local-aec-probe') throw new Error('invalid interactive local AEC command');
  const requestBytes = fs.readFileSync(command.probeRequestPath);
  if (hash(requestBytes) !== command.probeRequestSha256) throw new Error('interactive local AEC request hash mismatch');
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(requestBytes));
  if (hash(fs.readFileSync(command.desktopIdentityReporterPath)) !== command.desktopIdentityReporterSha256) throw new Error('desktop identity reporter hash mismatch');
  const reporter = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',command.desktopIdentityReporterPath,
    '-ExpectedParentProcessId',String(process.pid),'-OutputPath',command.nodeDesktopAuthorityPath,
    '-ExecutionId',command.executionId,'-PlanDigest',command.planDigest,'-LeaseId',command.leaseId,'-LeaseDigest',command.leaseDigest,
    '-CellId',command.cellId,'-WorkerId',command.workerId,'-VmIdentityDigest',command.vmIdentityDigest],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, env: windowsPowerShellEnvironment() });
  if (reporter.error || reporter.status !== 0) throw new Error(reporter.error?.message ?? reporter.stderr ?? 'desktop identity reporter failed');
  const desktopReceipt = JSON.parse(fs.readFileSync(command.nodeDesktopAuthorityPath, 'utf8').replace(/^\uFEFF/u, ''));
  if (desktopReceipt.schemaVersion !== 1 || desktopReceipt.artifactKind !== 'watch-mode-process-desktop-identity'
      || desktopReceipt.reporterParentPid !== process.pid || desktopReceipt.parentProcess?.pid !== process.pid || !desktopReceipt.desktop
      || ['executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest'].some((name) => desktopReceipt[name] !== command[name])) throw new Error('desktop identity receipt is invalid');
  const script = localAecProbeDesktopPowerShell({ executable: command.desktopExecutable, executableSha256: command.desktopExecutableSha256,
    runtimeRoot: command.workspaceRoot, outputDirectory: command.outputDirectory, requestPath: command.probeRequestPath,
    deadlineUtc: request.deadlineUtc, helperPath: command.finalizerHelperPath, helperSha256: command.finalizerHelperSha256 });
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: Math.max(1, Date.parse(request.deadlineUtc) - Date.now()) + 12_000, maxBuffer: 8 * 1024 * 1024, env: windowsPowerShellEnvironment() });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? 'interactive Desktop probe failed');
  const parsed = JSON.parse(result.stdout.trim());
  fs.writeFileSync(path.join(command.outputDirectory, 'owned-launch-result.json'), JSON.stringify(parsed, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  if (parsed.exitCode !== 0 || parsed.ownedJobExited !== true) throw new Error('interactive Desktop descendants did not exit');
  const executionReceipt = { schemaVersion: 1, artifactKind: 'watch-mode-interactive-local-aec-execution',
    executionId: command.executionId, planDigest: command.planDigest, leaseId: command.leaseId, leaseDigest: command.leaseDigest,
    cellId: command.cellId, workerId: command.workerId, vmIdentityDigest: command.vmIdentityDigest, exitCode: 0, completedAt: new Date().toISOString() };
  fs.writeFileSync(command.executionReceiptPath, JSON.stringify(executionReceipt, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return parsed;
}

function verifyInteractiveCustody(result, outputDirectory, executionId, expectedPlanDigest, expectedRequestDigest) {
  const terminal = result?.terminal; const taskTerminal = result?.taskTerminal;
  if (terminal?.schemaVersion !== 2 || terminal.artifactKind !== 'watch-mode-interactive-task-terminal'
      || terminal.mode !== 'local-aec-probe' || terminal.executionId !== executionId || terminal.exitCode !== 0
      || terminal.processAuthorityExitCode !== 0 || taskTerminal?.schemaVersion !== 2
      || taskTerminal.artifactKind !== 'watch-mode-interactive-scheduled-task-terminal'
      || taskTerminal.lastTaskResult !== 0 || taskTerminal.logonType !== 'InteractiveToken') throw new Error('interactive task terminal is incomplete');
  const authority = JSON.parse(fs.readFileSync(result.processAuthorityPath, 'utf8'));
  const launch = JSON.parse(fs.readFileSync(result.launchPath, 'utf8'));
  const cleanup = JSON.parse(fs.readFileSync(path.join(path.dirname(result.commandPath), 'cleanup.scheduler.json'), 'utf8'));
  const outputRoot = path.resolve(outputDirectory);
  const isWithinOutput = (file) => { const relative = path.relative(outputRoot, path.resolve(file)); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
  const environmentAuditPath = path.join(outputDirectory, 'desktop-environment-audit.json');
  if (!isWithinOutput(launch.nodeDesktopAuthorityPath) || !isWithinOutput(environmentAuditPath)) throw new Error('interactive authority artifact escaped output root');
  const desktopAuthority = JSON.parse(fs.readFileSync(launch.nodeDesktopAuthorityPath, 'utf8').replace(/^\uFEFF/u, ''));
  const environmentAudit = JSON.parse(fs.readFileSync(environmentAuditPath, 'utf8').replace(/^\uFEFF/u, ''));
  const binding = { executionId, planDigest: expectedPlanDigest, leaseId: executionId, leaseDigest: expectedRequestDigest,
    cellId: 'local-aec-probe', workerId: terminal.workerId, vmIdentityDigest: terminal.vmIdentityDigest };
  const matches = (value) => Object.entries(binding).every(([name, expected]) => value?.[name] === expected);
  const root = authority.processes?.find((entry) => entry.pid === authority.rootProcessId);
  const imageMatches = (entry) => {
    try { const stat = fs.lstatSync(entry.imagePath); return stat.isFile() && !stat.isSymbolicLink()
      && fs.realpathSync.native(entry.imagePath).toLowerCase() === path.resolve(entry.imagePath).toLowerCase()
      && hash(fs.readFileSync(entry.imagePath)) === entry.imageSha256; } catch { return false; }
  };
  const paths = [result.commandPath,result.launchPath,result.processAuthorityPath,result.terminalPath,result.taskTerminalPath,launch.nodeDesktopAuthorityPath,environmentAuditPath];
  if (launch.schemaVersion !== 2 || launch.artifactKind !== 'watch-mode-interactive-shard-launch-authority'
      || authority.schemaVersion !== 2 || authority.artifactKind !== 'watch-mode-interactive-process-authority'
      || !matches(launch) || !matches(authority) || !matches(terminal) || !matches(taskTerminal)
      || launch.sessionId !== 1 || launch.nodeDesktop !== launch.desktop || !launch.desktop || !launch.ownerSid?.startsWith('S-1-')
      || desktopAuthority.schemaVersion !== 1 || desktopAuthority.artifactKind !== 'watch-mode-process-desktop-identity' || !matches(desktopAuthority)
      || hash(fs.readFileSync(launch.nodeDesktopAuthorityPath)) !== launch.nodeDesktopAuthoritySha256
      || desktopAuthority.reporterParentPid !== launch.nodeProcess?.pid || desktopAuthority.parentProcess?.pid !== launch.nodeProcess?.pid
      || desktopAuthority.parentProcess.startedAt !== launch.nodeProcess.startedAt
      || path.resolve(desktopAuthority.parentProcess.imagePath).toLowerCase() !== path.resolve(launch.nodeProcess.imagePath).toLowerCase()
      || desktopAuthority.parentProcess.imageSha256 !== launch.nodeProcess.imageSha256 || desktopAuthority.sessionId !== launch.sessionId
      || desktopAuthority.ownerSid !== launch.ownerSid || desktopAuthority.desktop !== launch.desktop
      || environmentAudit.schemaVersion !== 1 || environmentAudit.artifactKind !== 'watch-mode-local-aec-desktop-environment-audit'
      || environmentAudit.credentialLikeCount !== 0 || environmentAudit.retainedNames?.some(isProviderCredentialEnvironmentName)
      || authority.passed !== true || authority.errors?.length !== 0 || authority.executionExitCode !== 0
      || authority.expectedSessionId !== launch.sessionId || authority.expectedOwnerSid !== launch.ownerSid
      || authority.rootProcessId !== launch.nodeProcess?.pid || authority.processCount !== authority.processes?.length
      || !root || root.role !== 'shard-node' || root.startedAt !== launch.nodeProcess.startedAt
      || root.parentPid !== launch.nodeProcess.parentPid || root.parentPid !== launch.taskProcess?.pid
      || path.resolve(root.imagePath).toLowerCase() !== path.resolve(launch.nodeProcess.imagePath).toLowerCase()
      || root.imageSha256 !== launch.nodeProcess.imageSha256 || root.sessionId !== launch.sessionId || root.ownerSid !== launch.ownerSid
      || authority.processes.some((entry) => entry.sessionId !== launch.sessionId || entry.ownerSid !== launch.ownerSid
        || !path.isAbsolute(entry.imagePath) || !/^[a-f0-9]{64}$/u.test(entry.imageSha256) || !imageMatches(entry))
      || paths.some((file) => !isWithinOutput(file))
      || cleanup.passed !== true || cleanup.taskCleanupPassed !== true || cleanup.processCleanup?.passed !== true) {
    throw new Error('interactive task identity, descendant authority, or cleanup is incomplete');
  }
  return { launch, authority, cleanup };
}

function verifyOperationReceipt(probe, request, tap, sourceFrames) {
  const render = probe.render;
  const capture = probe.capture;
  const config = probe.requestedConfig;
  const validCounter = (value) => Number.isSafeInteger(value) && value > 0;
  if (probe.sourcePcmFrames !== sourceFrames || probe.stimulusPreambleFrames !== 16_000
      || probe.stimulusSampleRateHz !== 16_000 || probe.stimulusChannelCount !== 1
      || probe.stimulusFrames !== sourceFrames + 16_000 || !render || !capture
      || !Array.isArray(config?.providers) || config.providers.length !== 0
      || config.devices?.feedbackLoopPrevention !== 'echo-cancel' || config.devices.aecEnabled !== true
      || config.devices.outputDeviceId !== request.physicalDeviceId
      || config.devices.inboundRoute?.input?.deviceId !== request.physicalDeviceId
      || capture.routeId !== config.devices.inboundRoute?.routeId
      || render.deviceId !== request.physicalDeviceId || render.sampleRateHz !== 48_000
      || render.requestedDeviceId !== request.physicalDeviceId || render.effectiveDeviceId !== request.physicalDeviceId
      || render.sourcePcmFrames !== sourceFrames || render.stimulusFrames !== sourceFrames + 16_000
      || render.stimulusPreambleFrames !== 16_000 || render.stimulusSampleRateHz !== 16_000
      || render.stimulusChannelCount !== 1
      || render.channelCount !== 2 || !validCounter(render.renderedFrames)
      || render.renderedFrames !== (sourceFrames + 16_000) * 3
      || typeof render.rendererInstanceId !== 'string' || !render.rendererInstanceId
      || !validCounter(render.ownerGeneration)
      || capture.direction !== 'inbound' || capture.requestedDeviceId !== request.physicalDeviceId
      || capture.effectiveDeviceId !== request.physicalDeviceId || capture.streamBound !== false
      || capture.captureState !== 'idle' || !validCounter(capture.framesCaptured)
      || capture.countsFinal !== true || capture.sampleRateHz !== 48_000 || capture.channelCount !== 2
      || capture.lastError !== null || capture.lastErrorCode !== null
      || tap.sampleCounts.render !== render.renderedFrames * 2
      || tap.sampleCounts.pre !== capture.framesCaptured * 2
      || tap.sampleCounts.post !== capture.framesCaptured * 2) {
    throw new Error('local AEC operation receipt contradicts stimulus, endpoint, final capture or tap accounting');
  }
}

export async function runLocalAecProbe(options, dependencies = {}) {
  const outputParent = path.resolve(options.outputParent);
  const parentStat = fs.lstatSync(outputParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('probe output parent must be a real directory');
  const executionId = `local-aec-${crypto.randomUUID()}`;
  const outputDirectory = path.join(fs.realpathSync.native(outputParent), executionId);
  fs.mkdirSync(outputDirectory);
  const base = { schemaVersion: 1, artifactKind: 'watch-mode-local-aec-probe-runner', executionId,
    startedAt: new Date().toISOString(), status: 'failed', releaseEligible: false, providerCalls: 0,
    ownedJobExited: false };
  let nativeResult = null;
  let custodyConfirmed = false;
  let launchAttempted = false;
  let probe = null;
  try {
    (dependencies.checkDiskSpace ?? checkWatchDiskSpace)({ receiptPath: path.join(outputDirectory, 'disk-space.json') });
    const timeoutSeconds = Number(options.timeoutSeconds ?? 300);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300) throw new Error('probe timeout must be 30-300 seconds');
    const deadline = Date.now() + timeoutSeconds * 1000;
    if (!/^\{0\.0\.0\.00000000\}\.\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/iu.test(options.physicalDeviceId ?? '')) {
      throw new Error('an exact physical render endpoint ID is required');
    }
    const runtime = verifyLocalAecProbeRuntime(path.resolve(options.runtimeRoot), options.distributionDigest);
    const renderPcmPath = fs.realpathSync.native(options.renderPcmPath);
    const bytes = fs.readFileSync(renderPcmPath);
    if (!bytes.length || bytes.length % 2 || bytes.length > 16_000 * 2 * 180) throw new Error('invalid bounded s16le/16k/mono stimulus');
    const request = { schemaVersion: 1, executionId, outputDirectory, renderPcmPath, deadlineUtc: new Date(deadline).toISOString(),
      renderPcmSha256: hash(bytes), physicalDeviceId: options.physicalDeviceId };
    const requestPath = path.join(outputDirectory, 'request.json');
    writeJson(requestPath, request);
    writeJson(path.join(outputDirectory, 'selected-runtime.json'), runtime);
    const workspaceRoot = fs.realpathSync.native(options.workspaceRoot ?? runtime.root);
    const helperPath = path.join(workspaceRoot, AEC_PROBE_JOB_HELPER);
    if (!fs.lstatSync(helperPath).isFile() || fs.realpathSync.native(helperPath) !== helperPath
        || hash(fs.readFileSync(helperPath)) !== runtime.helperSha256) {
      throw new Error('process-custody helper differs from the selected distribution');
    }
    const script = localAecProbePowerShell({ runtime, outputDirectory, requestPath,
      deadlineUtc: new Date(deadline).toISOString(), workspaceRoot, executionId });
    fs.writeFileSync(path.join(outputDirectory, 'launch.ps1'), script, { encoding: 'utf8', flag: 'wx' });
    const execute = dependencies.execute ?? ((source) => {
      if (process.platform !== 'win32') throw new Error('local AEC hardware probe requires Windows');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
        windowsHide: true, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()) + 12_000,
        maxBuffer: 8 * 1024 * 1024, env: windowsPowerShellEnvironment(),
      });
      fs.writeFileSync(path.join(outputDirectory, 'launcher.stdout.log'), result.stdout ?? '', { flag: 'wx' });
      fs.writeFileSync(path.join(outputDirectory, 'launcher.stderr.log'), result.stderr ?? '', { flag: 'wx' });
      if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `owned local probe failed: ${result.stderr}`);
      return JSON.parse(result.stdout.trim());
    });
    launchAttempted = true;
    nativeResult = await execute(script, { outputDirectory, request, requestPath, runtime, deadline });
    writeJson(path.join(outputDirectory, 'interactive-scheduler-result.json'), nativeResult ?? null);
    const interactiveCustody = verifyInteractiveCustody(nativeResult, outputDirectory, executionId, runtime.distributionDigest, hash(fs.readFileSync(requestPath)));
    custodyConfirmed = true;
    probe = readProbeReceipt(outputDirectory);
    if (probe.schemaVersion !== 1 || probe.artifactKind !== 'watch-mode-local-aec-probe'
        || probe.executionId !== executionId || probe.status !== 'completed'
        || probe.probeCapabilityId !== AEC_PROBE_CAPABILITY_ID
        || probe.providerCalls !== 0 || probe.releaseEligible !== false || probe.recognitionSenderAttached !== false
        || probe.sourcePcmSha256 !== request.renderPcmSha256 || !probe.tap || probe.failure || probe.tapError || probe.cleanupError) {
      throw new Error('local AEC probe evidence is missing, incomplete, or mismatched');
    }
    const tapIntegrity = verifyAecTapEvidence(outputDirectory, probe.tap);
    verifyOperationReceipt(probe, request, tapIntegrity, bytes.length / 2);
    const result = { ...base, status: 'completed', completedAt: new Date().toISOString(), ownedJobExited: true, interactiveCustody,
      providerAccounting: 'supported-probe-reported-zero',
      outputDirectory, probe, tapIntegrity, distributionDigest: runtime.distributionDigest };
    writeJson(path.join(outputDirectory, 'result.json'), result);
    return result;
  } catch (error) {
    // A nonzero native exit can throw before execute returns. Retain any
    // producer accounting already committed, without trusting it as a pass.
    let producerReadError = null;
    if (launchAttempted && probe === null) {
      try { probe = readProbeReceipt(outputDirectory); }
      catch (readError) { producerReadError = readError.message; }
    }
    const reportedCalls = probe?.executionId === executionId && Number.isSafeInteger(probe?.providerCalls)
      && probe.providerCalls >= 0 ? probe.providerCalls : null;
    writeJson(path.join(outputDirectory, 'result.json'), { ...base, completedAt: new Date().toISOString(),
      providerCalls: launchAttempted ? reportedCalls : 0,
      providerAccounting: !launchAttempted ? 'not-launched' : reportedCalls === null ? 'unknown' : 'unverified-producer-report',
      observedProducerAccounting: probe ? { executionId: probe.executionId, providerCalls: probe.providerCalls ?? null } : null,
      producerReadError,
      ownedJobExited: custodyConfirmed, failure: error.message });
    error.outputDirectory = outputDirectory;
    throw error;
  }
}

export function parseLocalAecProbeArgs(argv) {
  const flags = new Map([['--runtime-root','runtimeRoot'], ['--distribution-digest','distributionDigest'],
    ['--output-parent','outputParent'], ['--render-pcm','renderPcmPath'], ['--physical-device-id','physicalDeviceId'],
    ['--workspace-root','workspaceRoot'], ['--timeout-seconds','timeoutSeconds']]);
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!flags.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`invalid local AEC argument: ${argv[i]}`);
    const key = flags.get(argv[i]);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate local AEC argument: ${argv[i]}`);
    result[key] = argv[i + 1];
  }
  for (const key of ['runtimeRoot','distributionDigest','outputParent','renderPcmPath','physicalDeviceId']) {
    if (!result[key]) throw new Error(`${key} is required`);
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv[2] === '--execute-interactive-request') console.log(JSON.stringify(executeInteractiveLocalAecRequest(process.argv[3])));
    else console.log(JSON.stringify(await runLocalAecProbe(parseLocalAecProbeArgs(process.argv.slice(2)))));
  }
  catch (error) { console.error(`${error.message}; output=${error.outputDirectory ?? 'not-created'}`); process.exitCode = 1; }
}
