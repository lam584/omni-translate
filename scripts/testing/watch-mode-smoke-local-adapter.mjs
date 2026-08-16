import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  buildRunnerArgv,
  lastRunDirectoryLine,
  resolveWatchRealtimeProtocol,
} from './run-watch-mode-live-matrix.mjs';
import {
  buildLocalIsolationRuntime,
  runLocalIsolationCell,
} from './watch-mode-local-isolation.mjs';
import {
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
} from './watch-mode-evidence-authority.mjs';

const PROFILE = Object.freeze({
  profileId: 'vm3-hda-default',
  deviceClass: 'default-speaker',
  physicalPlaybackDeviceId: '{0.0.0.00000000}.{a609dee5-4ffd-49d6-b7f2-705cfa934363}',
  expectedPhysicalPlaybackDeviceName: '扬声器 (High Definition Audio Device)',
});

export const workerCapabilities = Object.freeze([
  Object.freeze({ workerId: 'vm3-local', deviceClasses: ['default-speaker'] }),
]);

let runtimeAuthority = null;
const VM3_CARGO_HOME = path.join(repoRoot, 'artifacts', 'testing', 'cargo-home');

function runNpm(script, timeout = 900_000, temporaryRoot) {
  const environment = {
    ...process.env,
    // VM3 reaches the sparse index reliably while the legacy git index can
    // remain stalled for several minutes before Cargo reports a timeout.
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
    // Preflight has already fetched the lockfile closure. Keeping the smoke
    // offline prevents a transient registry stall from masking a local result.
    CARGO_NET_OFFLINE: 'true',
    CARGO_HOME: VM3_CARGO_HOME,
    // VM3 has constrained commit memory while its system drive is full. A
    // single non-incremental Cargo job keeps the smoke preflight below that
    // limit without weakening any of the compiled checks.
    CARGO_BUILD_JOBS: '1',
    CARGO_INCREMENTAL: '0',
  };
  if (temporaryRoot) {
    environment.TEMP = temporaryRoot;
    environment.TMP = temporaryRoot;
    environment.TMPDIR = temporaryRoot;
    environment.NPM_CONFIG_CACHE = path.join(temporaryRoot, 'npm-cache');
  }
  const requiresElevation = process.platform === 'win32'
    && (script === 'driver:install' || script === 'driver:test');
  if (requiresElevation) {
    const driverScript = script === 'driver:install'
      ? path.join(repoRoot, 'scripts', 'installer', 'install-development-driver.ps1')
      : path.join(repoRoot, 'scripts', 'installer', 'test-development-driver.ps1');
    const driverScriptArguments = script === 'driver:install'
      ? [
        '-WorkspaceRoot', repoRoot,
        '-RuntimeRoot', path.join(repoRoot, 'artifacts', 'diagnostics', 'logs'),
        '-InstallChannel', 'development',
        '-DriverVersion', '0.10.0-dev',
        '-BridgeVersion', '0.1.0',
        '-TargetDeviceId', 'virtual-mic-default',
      ]
      : [];
    const temporaryOutputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-smoke-elevated-driver-'));
    const outputLog = path.join(temporaryOutputRoot, 'driver.log');
    const quotePowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const childCommand = [
      "$ErrorActionPreference = 'Stop'",
      `& ${quotePowerShell(driverScript)} ${driverScriptArguments.map(quotePowerShell).join(' ')} *>> ${quotePowerShell(outputLog)}`,
      'exit $LASTEXITCODE',
    ].join('; ');
    const childEncodedCommand = Buffer.from(childCommand, 'utf16le').toString('base64');
    const parentCommand = [
      "$ErrorActionPreference = 'Stop'",
      `$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -Wait -WindowStyle Hidden -WorkingDirectory ${quotePowerShell(repoRoot)} -ArgumentList @('-NoProfile', '-EncodedCommand', ${quotePowerShell(childEncodedCommand)})`,
      'exit $process.ExitCode',
    ].join('; ');
    // Do not encode the parent elevation request.  Windows PowerShell emits
    // CLIXML and returns a non-zero status for the nested encoded host under
    // this VM's UAC policy, whereas a direct -Command elevation preserves the
    // child process exit code (the only authoritative status here).
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', parentCommand], {
      cwd: repoRoot,
      env: environment,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    });
    const elevatedOutput = fs.existsSync(outputLog) ? fs.readFileSync(outputLog, 'utf8') : '';
    fs.rmSync(temporaryOutputRoot, { recursive: true, force: true });
    return {
      command: `elevated npm run ${script}`,
      status: result.status ?? 1,
      stdout: elevatedOutput,
      stderr: result.stderr ?? '',
      passed: !result.error && result.status === 0,
      error: result.error?.message ?? null,
    };
  }
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', [
    '/d', '/s', '/c', 'npm.cmd', 'run', script,
  ], {
    cwd: repoRoot,
    env: environment,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return {
    command: `npm run ${script}`,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    passed: !result.error && result.status === 0,
    error: result.error?.message ?? null,
  };
}

export async function runPreflight({ executionRoot }) {
  const preflightRoot = path.join(executionRoot, 'preflight');
  const temporaryRoot = path.join(executionRoot, 'temporary');
  fs.mkdirSync(preflightRoot, { recursive: true });
  fs.mkdirSync(temporaryRoot, { recursive: true });
  fs.mkdirSync(VM3_CARGO_HOME, { recursive: true });
  const checks = [];
  for (const script of [
    'test:watch-mode-report',
    'test:desktop-shell',
    'test:integration:bridge-contract',
    'test:contracts',
  ]) {
    const result = runNpm(script, 900_000, temporaryRoot);
    checks.push(result);
    fs.writeFileSync(path.join(preflightRoot, `${script.replaceAll(':', '-')}.log`), [
      result.stdout, result.stderr,
    ].join('\n'), 'utf8');
    if (!result.passed) {
      return { passed: false, providerCalls: 0, checks, failure: `${result.command} failed` };
    }
  }
  const originalProtocol = process.env.CARGO_REGISTRIES_CRATES_IO_PROTOCOL;
  const originalOffline = process.env.CARGO_NET_OFFLINE;
  const originalTemp = process.env.TEMP;
  const originalTmp = process.env.TMP;
  const originalTmpDir = process.env.TMPDIR;
  const originalNpmCache = process.env.NPM_CONFIG_CACHE;
  const originalCargoHome = process.env.CARGO_HOME;
  const originalCargoJobs = process.env.CARGO_BUILD_JOBS;
  const originalCargoIncremental = process.env.CARGO_INCREMENTAL;
  process.env.CARGO_REGISTRIES_CRATES_IO_PROTOCOL = 'sparse';
  process.env.CARGO_NET_OFFLINE = 'true';
  process.env.TEMP = temporaryRoot;
  process.env.TMP = temporaryRoot;
  process.env.TMPDIR = temporaryRoot;
  process.env.NPM_CONFIG_CACHE = path.join(temporaryRoot, 'npm-cache');
  process.env.CARGO_HOME = VM3_CARGO_HOME;
  process.env.CARGO_BUILD_JOBS = '1';
  process.env.CARGO_INCREMENTAL = '0';
  try {
    runtimeAuthority = buildLocalIsolationRuntime({ workspaceRoot: repoRoot });
  } finally {
    if (originalProtocol === undefined) delete process.env.CARGO_REGISTRIES_CRATES_IO_PROTOCOL;
    else process.env.CARGO_REGISTRIES_CRATES_IO_PROTOCOL = originalProtocol;
    if (originalOffline === undefined) delete process.env.CARGO_NET_OFFLINE;
    else process.env.CARGO_NET_OFFLINE = originalOffline;
    if (originalTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = originalTemp;
    if (originalTmp === undefined) delete process.env.TMP;
    else process.env.TMP = originalTmp;
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    if (originalNpmCache === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = originalNpmCache;
    if (originalCargoHome === undefined) delete process.env.CARGO_HOME;
    else process.env.CARGO_HOME = originalCargoHome;
    if (originalCargoJobs === undefined) delete process.env.CARGO_BUILD_JOBS;
    else process.env.CARGO_BUILD_JOBS = originalCargoJobs;
    if (originalCargoIncremental === undefined) delete process.env.CARGO_INCREMENTAL;
    else process.env.CARGO_INCREMENTAL = originalCargoIncremental;
  }
  const driverInstall = runNpm('driver:install', 900_000, temporaryRoot);
  checks.push(driverInstall);
  fs.writeFileSync(path.join(preflightRoot, 'driver-install.log'), [
    driverInstall.stdout, driverInstall.stderr,
  ].join('\n'), 'utf8');
  if (!driverInstall.passed) {
    return { passed: false, providerCalls: 0, checks, failure: 'npm run driver:install failed' };
  }
  const driverProbe = runNpm('driver:test', 900_000, temporaryRoot);
  checks.push(driverProbe);
  fs.writeFileSync(path.join(preflightRoot, 'driver-test.log'), [
    driverProbe.stdout, driverProbe.stderr,
  ].join('\n'), 'utf8');
  if (!driverProbe.passed) {
    return { passed: false, providerCalls: 0, checks, failure: 'npm run driver:test failed' };
  }
  return {
    passed: true,
    providerCalls: 0,
    checks,
    runtimeBinaryCount: runtimeAuthority.length,
    deviceProfile: PROFILE,
  };
}

function runPowerShell(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-smoke-elevated-live-'));
    const outputLog = path.join(temporaryRoot, 'runner.log');
    const quotePowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const childCommand = [
      "$ErrorActionPreference = 'Stop'",
      `& ${quotePowerShell(path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.ps1'))} ${argv.map(quotePowerShell).join(' ')} *>> ${quotePowerShell(outputLog)}`,
      'exit $LASTEXITCODE',
    ].join('; ');
    const childEncodedCommand = Buffer.from(childCommand, 'utf16le').toString('base64');
    const parentCommand = [
      "$ErrorActionPreference = 'Stop'",
      `$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -Wait -WindowStyle Hidden -WorkingDirectory ${quotePowerShell(repoRoot)} -ArgumentList @('-NoProfile', '-EncodedCommand', ${quotePowerShell(childEncodedCommand)})`,
      'exit $process.ExitCode',
    ].join('; ');
    const parentEncodedCommand = Buffer.from(parentCommand, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', parentEncodedCommand], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('exit', (exitCode) => {
      clearTimeout(timeout);
      const stdout = fs.existsSync(outputLog) ? fs.readFileSync(outputLog, 'utf8') : '';
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      process.stderr.write(stdout);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function classifyReport(report) {
  const layer = String(report?.failureLayer ?? '').toLowerCase();
  const reason = String(report?.failureReason ?? '');
  if (layer === 'provider' && /(?:50002|\b5\d\d\b|429|rate.?limit|timeout)/i.test(reason)) return 'provider-external';
  if (['driver', 'wasapi', 'physicaloutput', 'physicaloutputcontent'].includes(layer)) return 'device';
  if (layer === 'ci') return 'ci';
  return 'product';
}

export async function runCell({ cell, executionRoot }) {
  if (!runtimeAuthority) throw new Error('VM3 smoke runtime was not built by preflight');
  if (cell.providerMode === 'disabled') {
    const outputRoot = path.join(executionRoot, 'local-cells');
    fs.mkdirSync(outputRoot, { recursive: true });
    const result = await runLocalIsolationCell({
      cell,
      profile: PROFILE,
      outputRoot,
      provenance: currentGitProvenance({ cwd: repoRoot }),
      implementationHashes: currentAuthorityImplementationHashes({ workspaceRoot: repoRoot }),
      runtimeBinaryHashes: runtimeAuthority,
      workspaceRoot: repoRoot,
    });
    return { passed: result.verdict === 'passed', evidence: result.runDirectory, providerCalls: 0 };
  }

  const outputRoot = path.join(executionRoot, 'live-cells');
  fs.mkdirSync(outputRoot, { recursive: true });
  const argv = buildRunnerArgv({
    model: cell.modelId,
    watchRealtimeProtocol: resolveWatchRealtimeProtocol(cell.modelId),
    subtitleTranslationMode: 'native',
    feedbackMode: cell.feedbackLoopPrevention,
    outputRoot,
    warmupSeconds: 5,
    playbackSeconds: 0,
    postPlaybackWaitSeconds: 20,
    sessionReadyTimeoutSeconds: 60,
    watchAutoStopAfterSeconds: cell.durationSeconds,
    physicalPlaybackDeviceId: PROFILE.physicalPlaybackDeviceId,
    physicalPlaybackDeviceClass: PROFILE.deviceClass,
    physicalPlaybackDeviceProfileId: PROFILE.profileId,
    expectedPhysicalPlaybackDeviceName: PROFILE.expectedPhysicalPlaybackDeviceName,
    skipDriverRepair: true,
    useDefaultEndpointPlayback: true,
    stopDesktopAfterPlayback: true,
    cellId: cell.cellId,
  });
  const processResult = await runPowerShell(argv, 5 * 60 * 1_000);
  const runDirectory = lastRunDirectoryLine(processResult.stdout, repoRoot);
  const reportPath = runDirectory ? path.join(runDirectory, 'report.json') : null;
  let report = null;
  if (reportPath && fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));
  }
  const passed = processResult.exitCode === 0 && report?.verdict === 'passed';
  return {
    passed,
    ...(passed ? {} : { classification: report ? classifyReport(report) : 'orchestration' }),
    evidence: runDirectory ?? null,
    reportPath,
    exitCode: processResult.exitCode,
    failureLayer: report?.failureLayer ?? null,
    failureReason: report?.failureReason ?? (processResult.stderr.trim() || 'live runner failed without a report'),
  };
}

export function currentVm3Profile() {
  return structuredClone(PROFILE);
}

export function currentRuntimeAuthority() {
  return runtimeAuthority ?? currentAuthorityRuntimeBinaryHashes({ workspaceRoot: repoRoot });
}
