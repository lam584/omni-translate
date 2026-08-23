import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  buildRunnerArgv,
  lastRunDirectoryLine,
  resolveLiveRunnerTimeoutMs,
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
const VM3_SHORT_LIVE_ROOT = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-smoke-runtime');
export const SMOKE_PROVIDER_SESSION_AUTHORITY_FILE = 'smoke-provider-session-authority.json';
export const SMOKE_PROVIDER_SESSION_AUTHORITY_KIND = 'watch-mode-smoke-provider-session-authority';
export const VM3_SMOKE_START_MIN_C_FREE_BYTES = 7 * 1024 ** 3;
export const VM3_SMOKE_STOP_MIN_C_FREE_BYTES = 5 * 1024 ** 3;
export const VM3_SMOKE_LIVE_TIMEOUT_HARD_CAP_MS = 15 * 60 * 1_000;
const VM3_PREFLIGHT_BUILD_SETTINGS = Object.freeze({
  cargoRegistryProtocol: 'sparse',
  cargoOffline: true,
  cargoBuildJobs: 1,
  cargoIncremental: false,
  cargoProfileTestDebug: 0,
  // A cold Tauri release link legitimately exceeds 15 minutes on VM3. Keep
  // an enforceable bound, but do not classify a progressing local build as a
  // hang before it can emit the authority executable.
  runtimeBuildTimeoutMs: 1_800_000,
  regressionCommandTimeoutMs: 900_000,
});

export function resolveVm3SmokeLiveTimeoutMs({
  durationSeconds,
  warmupSeconds,
  playbackSeconds,
  postPlaybackWaitSeconds,
  sessionReadyTimeoutSeconds,
}) {
  const derivedTimeoutMs = resolveLiveRunnerTimeoutMs({
    playbackSeconds,
    postPlaybackWaitSeconds,
    sessionReadyTimeoutSeconds,
    watchAutoStopAfterSeconds: durationSeconds,
  }) + warmupSeconds * 1_000;
  return Math.min(derivedTimeoutMs, VM3_SMOKE_LIVE_TIMEOUT_HARD_CAP_MS);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function vm3SmokeStartSpaceFailure(freeBytes) {
  if (!Number.isFinite(freeBytes)) return 'VM3 C: free space is unavailable; refusing to start smoke preflight';
  if (freeBytes < VM3_SMOKE_START_MIN_C_FREE_BYTES) {
    return `VM3 C: free space is below the 7 GB smoke start buffer (${freeBytes} bytes)`;
  }
  return null;
}

function readVm3CFreeBytes(run = spawnSync) {
  if (process.platform !== 'win32') return null;
  const probe = run('powershell.exe', ['-NoProfile', '-Command', '(Get-PSDrive -Name C).Free'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  if (probe?.error || probe?.status !== 0) return Number.NaN;
  return Number.parseInt(String(probe.stdout ?? '').trim(), 10);
}

export function sampleDiskSpace() {
  return {
    drive: 'C:',
    freeBytes: readVm3CFreeBytes(),
    stopMinFreeBytes: VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
  };
}

function shortLiveOutputRoot(executionRoot) {
  const executionKey = crypto
    .createHash('sha256')
    .update(path.resolve(executionRoot))
    .digest('hex')
    .slice(0, 16);
  return path.join(VM3_SHORT_LIVE_ROOT, executionKey);
}

function linkLogicalLiveArtifacts(executionRoot, shortOutputRoot) {
  const logicalOutputRoot = path.join(executionRoot, 'live-cells');
  if (fs.existsSync(logicalOutputRoot)) return logicalOutputRoot;
  fs.mkdirSync(path.dirname(logicalOutputRoot), { recursive: true });
  try {
    fs.symlinkSync(shortOutputRoot, logicalOutputRoot, 'junction');
  } catch (error) {
    // The physical short path remains authoritative. A junction is a
    // convenience for browsing from the execution manifest, and should not
    // turn a live result into an orchestration failure on restricted hosts.
    if (error?.code !== 'EEXIST') return shortOutputRoot;
  }
  return logicalOutputRoot;
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
    || !sameJson(cached?.buildSettings, VM3_PREFLIGHT_BUILD_SETTINGS)
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
    buildSettings: VM3_PREFLIGHT_BUILD_SETTINGS,
    runtimeAuthority: authority,
    checks: checks.map(({ command, status, passed, startedAt, completedAt, durationMs, timedOut, logFile }) => ({
      command, status, passed, startedAt, completedAt, durationMs, timedOut, logFile,
    })),
  };
  fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, VM3_PREFLIGHT_CACHE_FILE);
  return cache;
}

function runNpm(script, timeout = 900_000, temporaryRoot) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
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
      timedOut: result.error?.code === 'ETIMEDOUT',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
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
  // spawnSync's timeout stops its direct cmd.exe child but Windows can retain
  // Cargo/rustc descendants. A preflight timeout must end the smoke-owned
  // process tree, otherwise the coordinator never reaches its failed manifest.
  if (result.error?.code === 'ETIMEDOUT' && Number.isInteger(result.pid) && result.pid > 0) {
    spawnSync('taskkill.exe', ['/PID', String(result.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
  }
  return {
    command: `npm run ${script}`,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    passed: !result.error && result.status === 0,
    error: result.error?.message ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
  };
}

function writePreflightLog(preflightRoot, name, result) {
  const logFile = path.join(preflightRoot, `${name}.log`);
  fs.writeFileSync(logFile, [result.stdout ?? '', result.stderr ?? ''].join('\n'), 'utf8');
  result.logFile = logFile;
  return result;
}

function createRuntimeBuildRunner({ checks, preflightRoot, temporaryRoot }) {
  let lastDiskCheckMs = 0;
  const checkDiskSpace = () => {
    // The C: guard is intentionally sampled before the first build command
    // and then hourly.  It prevents a new build step when VM3 is below the
    // plan's 5 GB floor; the coordinator will persist the resulting failure.
    if (process.platform !== 'win32' || Date.now() - lastDiskCheckMs < 60 * 60 * 1_000) return;
    lastDiskCheckMs = Date.now();
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-PSDrive -Name C).Free'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    const freeBytes = Number.parseInt(String(probe.stdout ?? '').trim(), 10);
    if (!Number.isFinite(freeBytes) || freeBytes <= VM3_SMOKE_STOP_MIN_C_FREE_BYTES) {
      throw new Error(`VM3 C: free space is at or below the 5 GB smoke floor (${Number.isFinite(freeBytes) ? freeBytes : 'unavailable'} bytes)`);
    }
  };
  return (command, args, options) => {
    checkDiskSpace();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const processRoot = fs.mkdtempSync(path.join(temporaryRoot, 'timeboxed-build-'));
    const stdoutPath = path.join(processRoot, 'stdout.log');
    const stderrPath = path.join(processRoot, 'stderr.log');
    const payload = Buffer.from(JSON.stringify({
      command,
      arguments: args,
      cwd: options.cwd,
      environment: options.env,
    }), 'utf8').toString('base64');
    const wrapper = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(repoRoot, 'scripts', 'testing', 'run-timeboxed-command.ps1'),
      '-PayloadBase64', payload,
      '-TimeoutMs', String(VM3_PREFLIGHT_BUILD_SETTINGS.runtimeBuildTimeoutMs),
      '-StdoutPath', stdoutPath,
      '-StderrPath', stderrPath,
      '-MinCFreeBytes', String(VM3_SMOKE_STOP_MIN_C_FREE_BYTES),
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: VM3_PREFLIGHT_BUILD_SETTINGS.runtimeBuildTimeoutMs + 60_000,
      windowsHide: true,
    });
    const result = {
      status: wrapper.status,
      error: wrapper.error,
      stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : wrapper.stdout,
      stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : wrapper.stderr,
      timedOut: wrapper.status === 124 || wrapper.status === 125 || wrapper.error?.code === 'ETIMEDOUT',
    };
    const check = writePreflightLog(preflightRoot, `runtime-build-${checks.length + 1}`, {
      command: [command, ...args].join(' '),
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      passed: !result.error && result.status === 0,
      error: result.error?.message ?? null,
      timedOut: result.timedOut,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    });
    checks.push(check);
    return result;
  };
}

export async function runPreflight({ executionRoot }) {
  const preflightRoot = path.join(executionRoot, 'preflight');
  const temporaryRoot = path.join(executionRoot, 'temporary');
  fs.mkdirSync(preflightRoot, { recursive: true });
  fs.mkdirSync(temporaryRoot, { recursive: true });
  fs.mkdirSync(VM3_CARGO_HOME, { recursive: true });
  const startFreeBytes = readVm3CFreeBytes();
  const startSpaceFailure = vm3SmokeStartSpaceFailure(startFreeBytes);
  if (startSpaceFailure) {
    const check = writePreflightLog(preflightRoot, 'c-drive-start-buffer', {
      command: 'Get-PSDrive -Name C | Select-Object -ExpandProperty Free',
      status: 1,
      stdout: Number.isFinite(startFreeBytes) ? `${startFreeBytes}\n` : '',
      stderr: startSpaceFailure,
      passed: false,
      error: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
    });
    return {
      passed: false,
      providerCalls: 0,
      checks: [check],
      failure: startSpaceFailure,
      classification: 'orchestration',
      diskSpace: { cFreeBytes: Number.isFinite(startFreeBytes) ? startFreeBytes : null, requiredStartBytes: VM3_SMOKE_START_MIN_C_FREE_BYTES },
    };
  }
  const reusable = readReusablePreflight();
  if (reusable) {
    runtimeAuthority = reusable.runtimeAuthority;
    return {
      passed: true,
      providerCalls: 0,
      checks: reusable.cached.checks,
      runtimeBinaryCount: runtimeAuthority.length,
      deviceProfile: PROFILE,
      provenance: reusable.cached.provenance,
      buildSettings: reusable.cached.buildSettings,
      runtimeAuthority,
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
    checks.push(writePreflightLog(preflightRoot, script.replaceAll(':', '-'), result));
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
    runtimeAuthority = buildLocalIsolationRuntime({
      workspaceRoot: repoRoot,
      run: createRuntimeBuildRunner({ checks, preflightRoot, temporaryRoot }),
    });
  } catch (error) {
    return {
      passed: false,
      providerCalls: 0,
      checks,
      failure: `local isolation runtime build failed: ${String(error?.message ?? error)}`,
    };
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
  checks.push(writePreflightLog(preflightRoot, 'driver-install', driverInstall));
  if (!driverInstall.passed) {
    return { passed: false, providerCalls: 0, checks, failure: 'npm run driver:install failed' };
  }
  const driverProbe = runNpm('driver:test', 900_000, temporaryRoot);
  checks.push(writePreflightLog(preflightRoot, 'driver-test', driverProbe));
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
    provenance: cache.provenance,
    buildSettings: cache.buildSettings,
    runtimeAuthority,
    preflightReuse: {
      reused: false,
      cacheFile: VM3_PREFLIGHT_CACHE_FILE,
      headCommit: cache.provenance.headCommit,
    },
  };
}

function runPowerShell(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Do not inherit the desktop process' C: TEMP. Live-runner logs and
    // physical-audio windows can be sizable on VM3, whose system drive has a
    // hard 5 GiB smoke floor.
    const smokeTempRoot = path.join(repoRoot, 'artifacts', 'tmp');
    fs.mkdirSync(smokeTempRoot, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(smokeTempRoot, 'omni-smoke-elevated-live-'));
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

export function classifyReport(report) {
  const layer = String(report?.failureLayer ?? '').toLowerCase();
  const reason = String(report?.failureReason ?? '');
  // The live runner promotes cue issues to the app layer so that a missing
  // translation remains a hard failure. Keep that verdict, but inspect the
  // attached cue evidence before assigning responsibility: a DashScope 50002
  // is a provider outage even when the resulting cue also has model-no-output.
  const providerEvidence = JSON.stringify(report?.watchSessionReport ?? report ?? '');
  if (
    /(?:50002|\b5\d\d\b|429|rate.?limit|timeout)/i.test(`${reason}\n${providerEvidence}`)
    && (layer === 'provider' || /providerCode=|ModelServingError|provider-error/i.test(providerEvidence))
  ) return 'provider-external';
  if (['driver', 'wasapi', 'physicaloutput', 'physicaloutputcontent'].includes(layer)) return 'device';
  if (layer === 'ci') return 'ci';
  return 'product';
}

export function readSmokeProviderSessionAuthority(runDirectory) {
  const authorityPath = runDirectory
    ? path.join(runDirectory, SMOKE_PROVIDER_SESSION_AUTHORITY_FILE)
    : null;
  if (!authorityPath || !fs.existsSync(authorityPath)) {
    return {
      authority: null,
      authorityPath,
      failure: `missing ${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE}`,
    };
  }
  try {
    const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8').replace(/^\uFEFF/, ''));
    return { authority, authorityPath, failure: null };
  } catch (error) {
    return {
      authority: null,
      authorityPath,
      failure: `invalid ${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE}: ${String(error?.message ?? error)}`,
    };
  }
}

const SMOKE_LIVE_REPORT_LAYERS = Object.freeze([
  'environment',
  'driver',
  'wasapi',
  'bridge',
  'physicalOutput',
  'physicalOutputContent',
  'aec',
  'speechSegmentation',
  'strictContent',
  'app',
  'provider',
]);

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function smokeLiveReportCompletenessFailure(report, {
  expectedModelId = null,
  expectedFeedbackLoopPrevention = null,
  minimumDurationMs = 180_000,
} = {}) {
  if (!isJsonObject(report)) return 'live report is not a JSON object';
  if (report.schemaVersion !== 1) return 'live report has the wrong schemaVersion';
  if (!isNonEmptyString(report.generatedAt) || !Number.isFinite(Date.parse(report.generatedAt))) {
    return 'live report is missing a valid generatedAt timestamp';
  }
  if (report.mode !== 'live') return `live report mode is ${String(report.mode)}, expected live`;
  if (!isNonEmptyString(report.modelId)) return 'live report is missing modelId';
  if (expectedModelId && report.modelId !== expectedModelId) {
    return `live report modelId is ${String(report.modelId)}, expected ${expectedModelId}`;
  }
  if (!isNonEmptyString(report.feedbackLoopPrevention)) {
    return 'live report is missing feedbackLoopPrevention';
  }
  if (
    expectedFeedbackLoopPrevention
    && report.feedbackLoopPrevention !== expectedFeedbackLoopPrevention
  ) {
    return `live report feedbackLoopPrevention is ${String(report.feedbackLoopPrevention)}, expected ${expectedFeedbackLoopPrevention}`;
  }
  if (report.translationRoute !== 'native') {
    return `live report translationRoute is ${String(report.translationRoute)}, expected native`;
  }
  if (!['passed', 'failed', 'blocked', 'inconclusive'].includes(report.verdict)) {
    return `live report verdict is ${String(report.verdict)}, expected passed, failed, blocked, or inconclusive`;
  }
  if (!isJsonObject(report.provenance)) return 'live report is missing provenance';
  if (!isJsonObject(report.layers)) return 'live report is missing layers';
  const missingLayers = SMOKE_LIVE_REPORT_LAYERS.filter(
    (layer) => !isNonEmptyString(report.layers[layer]?.status),
  );
  if (missingLayers.length > 0) {
    return `live report is missing layer status for ${missingLayers.join(', ')}`;
  }
  if (!isJsonObject(report.diagnostics)) return 'live report is missing diagnostics';
  if (!isJsonObject(report.artifacts)) return 'live report is missing artifacts';

  const watch = report.watchSessionReport;
  if (!isJsonObject(watch)) return 'live report is missing watchSessionReport';
  if (!isNonEmptyString(watch.sessionId)) return 'watchSessionReport is missing sessionId';
  if (watch.status !== 'completed') {
    return `watchSessionReport status is ${String(watch.status)}, expected completed`;
  }
  if (watch.routeMode !== 'watch') {
    return `watchSessionReport routeMode is ${String(watch.routeMode)}, expected watch`;
  }
  if (!isNonEmptyString(watch.providerId)) return 'watchSessionReport is missing providerId';
  if (!isNonEmptyString(watch.model)) return 'watchSessionReport is missing model';
  if (expectedModelId && watch.model !== expectedModelId) {
    return `watchSessionReport model is ${String(watch.model)}, expected ${expectedModelId}`;
  }
  if (!isNonEmptyString(watch.startedAt) || !isNonEmptyString(watch.endedAt)) {
    return 'watchSessionReport is missing startedAt or endedAt';
  }
  if (!isNonNegativeSafeInteger(watch.elapsedMs)) {
    return 'watchSessionReport elapsedMs must be a non-negative safe integer';
  }
  if (!isJsonObject(watch.summary)) return 'watchSessionReport is missing summary';
  for (const field of [
    'durationMs',
    'cueCount',
    'completeCueCount',
    'visibleRenderCueCount',
    'unrenderedCueCount',
    'issueCount',
    'issueOccurrenceCount',
  ]) {
    if (!isNonNegativeSafeInteger(watch.summary[field])) {
      return `watchSessionReport summary.${field} must be a non-negative safe integer`;
    }
  }
  if (!Array.isArray(watch.cues) || !Array.isArray(watch.events) || !Array.isArray(watch.issues)) {
    return 'watchSessionReport cues, events, and issues must be arrays';
  }
  if (!isNonNegativeSafeInteger(watch.droppedCueCount) || !isNonNegativeSafeInteger(watch.droppedEventCount)) {
    return 'watchSessionReport dropped cue/event counts must be non-negative safe integers';
  }

  if (report.verdict !== 'passed') {
    if (!isNonEmptyString(report.failureLayer) || !isNonEmptyString(report.failureReason)) {
      return 'non-passing live report is missing failureLayer or failureReason';
    }
    return null;
  }
  if (report.failureLayer !== null || report.failureReason !== null) {
    return 'passing live report must have null failureLayer and failureReason';
  }
  if (watch.droppedCueCount !== 0 || watch.droppedEventCount !== 0) {
    return `passing watchSessionReport dropped evidence: cues=${watch.droppedCueCount} events=${watch.droppedEventCount}`;
  }
  if (watch.elapsedMs < minimumDurationMs || watch.summary.durationMs < minimumDurationMs) {
    return `watchSessionReport duration is too short: elapsedMs=${watch.elapsedMs} summary.durationMs=${watch.summary.durationMs} minimum=${minimumDurationMs}`;
  }
  if (Math.abs(watch.elapsedMs - watch.summary.durationMs) > 1_000) {
    return `watchSessionReport duration fields disagree: elapsedMs=${watch.elapsedMs} summary.durationMs=${watch.summary.durationMs}`;
  }
  const acceptedContentCues = watch.cues.filter((cue) => (
    isJsonObject(cue)
    && isNonEmptyString(cue.cueId)
    && cue.comparisonStatus !== 'superseded'
    && [cue.sourceText, cue.llmText, cue.publishedText, cue.renderedText]
      .some(isNonEmptyString)
  ));
  const completeCues = acceptedContentCues.filter((cue) => (
    Number.isFinite(cue.llmFirstAtMs)
    && Number.isFinite(cue.publishedFirstAtMs)
    && Number.isFinite(cue.renderedFirstAtMs)
    && Number.isFinite(cue.llmFirstToRenderMs)
    && cue.llmFirstToRenderMs >= 0
    && Number.isFinite(cue.publishToRenderMs)
    && cue.publishToRenderMs >= 0
  ));
  if (completeCues.length === 0 || watch.summary.completeCueCount === 0) {
    return 'watchSessionReport has no complete model → publish → visible-render cue';
  }
  if (
    completeCues.length !== acceptedContentCues.length
    || watch.summary.completeCueCount < acceptedContentCues.length
  ) {
    const incompleteCueIds = acceptedContentCues
      .filter((cue) => !completeCues.includes(cue))
      .map((cue) => cue.cueId)
      .join(', ');
    return `watchSessionReport has incomplete accepted cue lifecycle(s): ${incompleteCueIds || '(summary mismatch)'}`;
  }
  if (watch.summary.unrenderedCueCount !== 0) {
    return `watchSessionReport has ${watch.summary.unrenderedCueCount} published cue(s) without visible rendering`;
  }
  return null;
}

export function evaluateSmokeProviderSessionAuthority({
  report,
  authority,
  readFailure = null,
  expectedCell = null,
}) {
  const hasPrimarySessionCount = Number.isSafeInteger(authority?.providerSessions)
    && authority.providerSessions >= 0;
  const hasAuxiliarySessionCount = Number.isSafeInteger(authority?.auxiliaryProviderSessions)
    && authority.auxiliaryProviderSessions >= 0;
  // This evaluator is reached only after the coordinator dispatched one paid
  // cell. Preserve that reserved call in a failed manifest when the child-side
  // receipt is missing or corrupt; recording zero would undercount a session
  // that may already have reached the network. A readable receipt remains the
  // source of the exact primary plus auxiliary count.
  const providerCalls = hasPrimarySessionCount && hasAuxiliarySessionCount
    ? authority.providerSessions + authority.auxiliaryProviderSessions
    : 1;
  const authorityFailure = readFailure ?? (
    !authority || typeof authority !== 'object' || Array.isArray(authority)
      ? `${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE} is not a JSON object`
      : authority.schemaVersion !== 1
        ? `${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE} has the wrong schemaVersion`
        : authority.artifactKind !== SMOKE_PROVIDER_SESSION_AUTHORITY_KIND
        ? `${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE} has the wrong artifactKind`
        : authority.nonAuthoritative !== true
          ? `${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE} must be non-authoritative`
          : authority.passed !== true
            ? `${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE} did not pass`
            : authority.providerSessions !== 1
              ? `${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE} recorded ${String(authority.providerSessions)} primary Provider sessions; expected 1`
              : authority.auxiliaryProviderSessions !== 0
                ? `${SMOKE_PROVIDER_SESSION_AUTHORITY_FILE} recorded ${String(authority.auxiliaryProviderSessions)} auxiliary Provider sessions; expected 0`
                : null
  );
  const reportFailure = smokeLiveReportCompletenessFailure(report, {
    expectedModelId: expectedCell?.modelId ?? null,
    expectedFeedbackLoopPrevention: expectedCell?.feedbackLoopPrevention ?? null,
    minimumDurationMs: Number.isFinite(Number(expectedCell?.durationSeconds))
      ? Number(expectedCell.durationSeconds) * 1_000
      : 180_000,
  });
  const passed = report?.verdict === 'passed'
    && reportFailure === null
    && authorityFailure === null;
  return {
    passed,
    providerCalls,
    authorityFailure,
    reportFailure,
    classification: passed
      ? null
      : (authorityFailure || reportFailure
          ? 'orchestration'
          : (report ? classifyReport(report) : 'orchestration')),
  };
}

function createdReportDirectories(outputRoot, directoriesBeforeRun) {
  return fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !directoriesBeforeRun.has(entry.name))
    .map((entry) => path.join(outputRoot, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, 'report.json')))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

async function waitForCreatedReportDirectory(outputRoot, directoriesBeforeRun, {
  timeoutMs = 120_000,
  pollIntervalMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const reportDirectory = createdReportDirectories(outputRoot, directoriesBeforeRun)[0];
    if (reportDirectory) return reportDirectory;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (true);
}

export function buildVm3PaidSmokeRunnerArgv({ cell, outputRoot, liveTiming }) {
  return buildRunnerArgv({
    model: cell.modelId,
    watchRealtimeProtocol: resolveWatchRealtimeProtocol(cell.modelId),
    subtitleTranslationMode: 'native',
    feedbackMode: cell.feedbackLoopPrevention,
    outputRoot,
    warmupSeconds: liveTiming.warmupSeconds,
    playbackSeconds: liveTiming.playbackSeconds,
    postPlaybackWaitSeconds: liveTiming.postPlaybackWaitSeconds,
    sessionReadyTimeoutSeconds: liveTiming.sessionReadyTimeoutSeconds,
    watchAutoStopAfterSeconds: liveTiming.durationSeconds,
    physicalPlaybackDeviceId: PROFILE.physicalPlaybackDeviceId,
    physicalPlaybackDeviceClass: PROFILE.deviceClass,
    physicalPlaybackDeviceProfileId: PROFILE.profileId,
    expectedPhysicalPlaybackDeviceName: PROFILE.expectedPhysicalPlaybackDeviceName,
    skipDriverRepair: true,
    useDefaultEndpointPlayback: true,
    stopDesktopAfterPlayback: true,
    localCanonicalContentAuthority: true,
    cellId: cell.cellId,
  });
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

  // The smoke execution id and cell names together exceed MAX_PATH once the
  // live runner appends authority artifact filenames. Give PowerShell a short
  // physical root, then expose it beneath the normal execution tree through a
  // junction for artifact browsing.
  const outputRoot = shortLiveOutputRoot(executionRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const logicalOutputRoot = linkLogicalLiveArtifacts(executionRoot, outputRoot);
  // Elevated PowerShell output is not a dependable transport for the run path:
  // its encoding and the wrapper's final cleanup can both obscure the final
  // Write-Output line.  Snapshot the serial worker's output root instead, so
  // the report generated by this invocation remains authoritative.
  const directoriesBeforeRun = new Set(
    fs.readdirSync(outputRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const liveTiming = Object.freeze({
    durationSeconds: cell.durationSeconds,
    warmupSeconds: 5,
    playbackSeconds: 0,
    postPlaybackWaitSeconds: 20,
    sessionReadyTimeoutSeconds: 60,
  });
  const argv = buildVm3PaidSmokeRunnerArgv({ cell, outputRoot, liveTiming });
  // Reuse the strict matrix lifecycle budget: readiness plus the longer of
  // Watch report completion and recorder completion, followed by STT/report
  // post-processing. Smoke adds its explicit warmup and enforces a final hard
  // cap so a degraded elevated process tree still cannot run indefinitely.
  const processResult = await runPowerShell(argv, resolveVm3SmokeLiveTimeoutMs(liveTiming));
  const outputRunDirectory = lastRunDirectoryLine(processResult.stdout, repoRoot);
  // The elevated launcher can exit before the child-side report writer flushes
  // its final JSON. This is completion waiting, not a cell retry: retain the
  // same invocation's report if it appears during the bounded grace period.
  const settledReportDirectory = await waitForCreatedReportDirectory(outputRoot, directoriesBeforeRun);
  const runDirectory = settledReportDirectory ?? outputRunDirectory ?? null;
  const reportPath = runDirectory ? path.join(runDirectory, 'report.json') : null;
  let report = null;
  if (reportPath && fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));
  }
  // The elevated wrapper can return a non-zero cleanup status after the live
  // runner has already written its report and Provider session authority. A
  // complete passing report plus exactly one primary Provider session is the
  // cell result; retain the launcher exit code below only as diagnostic
  // evidence instead of converting that pass into a product bug.
  const authorityResult = readSmokeProviderSessionAuthority(runDirectory);
  const authorityEvaluation = evaluateSmokeProviderSessionAuthority({
    report,
    authority: authorityResult.authority,
    readFailure: authorityResult.failure,
    expectedCell: cell,
  });
  const passed = authorityEvaluation.passed;
  return {
    passed,
    providerCalls: authorityEvaluation.providerCalls,
    ...(passed ? {} : { classification: authorityEvaluation.classification }),
    evidence: runDirectory
      ? path.join(logicalOutputRoot, path.basename(runDirectory))
      : null,
    reportPath: runDirectory
      ? path.join(logicalOutputRoot, path.basename(runDirectory), 'report.json')
      : null,
    exitCode: processResult.exitCode,
    failureLayer: report?.failureLayer ?? null,
    failureReason: authorityEvaluation.authorityFailure
      ?? authorityEvaluation.reportFailure
      ?? report?.failureReason
      ?? (processResult.stderr.trim() || 'live runner failed without a report'),
    providerSessionAuthorityPath: runDirectory
      ? path.join(logicalOutputRoot, path.basename(runDirectory), SMOKE_PROVIDER_SESSION_AUTHORITY_FILE)
      : null,
  };
}

export function currentVm3Profile() {
  return structuredClone(PROFILE);
}

export function currentRuntimeAuthority() {
  return runtimeAuthority ?? currentAuthorityRuntimeBinaryHashes({ workspaceRoot: repoRoot });
}
