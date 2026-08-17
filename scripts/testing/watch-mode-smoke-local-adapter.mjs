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
const VM3_PREFLIGHT_CACHE_ROOT = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-smoke', 'preflight-cache');
const VM3_PREFLIGHT_CACHE_FILE = path.join(VM3_PREFLIGHT_CACHE_ROOT, 'vm3-runtime-preflight.json');
const VM3_PREFLIGHT_CACHE_SCHEMA_VERSION = 1;

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readReusablePreflight() {
  if (!fs.existsSync(VM3_PREFLIGHT_CACHE_FILE)) return null;
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(VM3_PREFLIGHT_CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
  const provenance = currentGitProvenance({ cwd: repoRoot });
  if (
    cached?.schemaVersion !== VM3_PREFLIGHT_CACHE_SCHEMA_VERSION
    || cached?.passed !== true
    || Number(cached?.providerCalls) !== 0
    || cached?.provenance?.headCommit !== provenance.headCommit
    || provenance.worktreeClean !== true
    || Number(provenance.dirtyEntryCount) !== 0
    || !sameJson(cached?.deviceProfile, PROFILE)
  ) return null;
  const hashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot: repoRoot });
  if (!sameJson(cached?.runtimeAuthority, hashes)) return null;
  return { cached, runtimeAuthority: hashes };
}

function writeReusablePreflight({ checks, runtimeAuthority: authority }) {
  fs.mkdirSync(VM3_PREFLIGHT_CACHE_ROOT, { recursive: true });
  const temporary = `${VM3_PREFLIGHT_CACHE_FILE}.${process.pid}.tmp`;
  const cache = {
    schemaVersion: VM3_PREFLIGHT_CACHE_SCHEMA_VERSION,
    passed: true,
    providerCalls: 0,
    completedAt: new Date().toISOString(),
    provenance: currentGitProvenance({ cwd: repoRoot }),
    deviceProfile: PROFILE,
    runtimeAuthority: authority,
    checks: checks.map(({ command, status, passed }) => ({ command, status, passed })),
  };
  fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, VM3_PREFLIGHT_CACHE_FILE);
  return cache;
}

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
    // The desktop-shell test links a very large Windows binary. Debug symbols
    // alone exceed VM3's available commit budget even with one Cargo job; the
    // smoke still compiles and executes the identical test code without them.
    CARGO_PROFILE_TEST_DEBUG: '0',
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
    const launcher = path.join(repoRoot, 'scripts', 'testing', 'run-elevated-driver.ps1');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
      '-Action', script === 'driver:install' ? 'install' : 'test',
      '-WorkspaceRoot', repoRoot,
    ], {
      cwd: repoRoot,
      env: environment,
      encoding: 'utf8',
      timeout,
      windowsHide: false,
    });
    return {
      command: `elevated npm run ${script}`,
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
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
  const reusable = readReusablePreflight();
  if (reusable) {
    runtimeAuthority = reusable.runtimeAuthority;
    return {
      passed: true,
      providerCalls: 0,
      checks: reusable.cached.checks,
      runtimeBinaryCount: runtimeAuthority.length,
      deviceProfile: PROFILE,
      preflightReuse: {
        reused: true,
        cacheFile: VM3_PREFLIGHT_CACHE_FILE,
        completedAt: reusable.cached.completedAt,
        headCommit: reusable.cached.provenance.headCommit,
      },
    };
  }
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
  const originalCargoProfileTestDebug = process.env.CARGO_PROFILE_TEST_DEBUG;
  process.env.CARGO_REGISTRIES_CRATES_IO_PROTOCOL = 'sparse';
  process.env.CARGO_NET_OFFLINE = 'true';
  process.env.TEMP = temporaryRoot;
  process.env.TMP = temporaryRoot;
  process.env.TMPDIR = temporaryRoot;
  process.env.NPM_CONFIG_CACHE = path.join(temporaryRoot, 'npm-cache');
  process.env.CARGO_HOME = VM3_CARGO_HOME;
  process.env.CARGO_BUILD_JOBS = '1';
  process.env.CARGO_INCREMENTAL = '0';
  process.env.CARGO_PROFILE_TEST_DEBUG = '0';
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
    if (originalCargoProfileTestDebug === undefined) delete process.env.CARGO_PROFILE_TEST_DEBUG;
    else process.env.CARGO_PROFILE_TEST_DEBUG = originalCargoProfileTestDebug;
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
  const cache = writeReusablePreflight({ checks, runtimeAuthority });
  return {
    passed: true,
    providerCalls: 0,
    checks,
    runtimeBinaryCount: runtimeAuthority.length,
    deviceProfile: PROFILE,
    preflightReuse: {
      reused: false,
      cacheFile: VM3_PREFLIGHT_CACHE_FILE,
      headCommit: cache.provenance.headCommit,
    },
  };
}

function runPowerShell(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-smoke-elevated-live-'));
    const outputLog = path.join(temporaryRoot, 'runner.log');
    const launcher = path.join(repoRoot, 'scripts', 'testing', 'run-elevated-watch-mode-live.ps1');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
      '-WorkspaceRoot', repoRoot,
      '-OutputLog', outputLog,
      '-RunnerArgumentsBase64', Buffer.from(JSON.stringify(argv), 'utf8').toString('base64'),
    ], {
      cwd: repoRoot,
      windowsHide: false,
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
      const stdout = fs.existsSync(outputLog) ? readPowerShellOutputLog(outputLog) : '';
      try {
        fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      } catch {
        // The elevated child can retain a short-lived handle to its log.
        // Retaining this temporary evidence is safer than obscuring its result.
      }
      process.stderr.write(stdout);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function readPowerShellOutputLog(outputLog) {
  const content = fs.readFileSync(outputLog);
  // Out-File in the elevated PowerShell wrapper can emit UTF-16LE on Windows.
  // Decode it before handing lines to lastRunDirectoryLine; UTF-8 decoding
  // leaves embedded NULs and hides the authoritative run directory.
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString('utf16le');
  }
  return content.toString('utf8').replace(/^\uFEFF/, '');
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
  // Elevated PowerShell output is not a dependable transport for the run path:
  // its encoding and the wrapper's final cleanup can both obscure the final
  // Write-Output line.  Snapshot the serial worker's output root instead, so
  // the report generated by this invocation remains authoritative.
  const directoriesBeforeRun = new Set(
    fs.readdirSync(outputRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
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
  const outputRunDirectory = lastRunDirectoryLine(processResult.stdout, repoRoot);
  const createdRunDirectories = fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !directoriesBeforeRun.has(entry.name))
    .map((entry) => path.join(outputRoot, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, 'report.json')))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const runDirectory = createdRunDirectories[0] ?? outputRunDirectory ?? null;
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
