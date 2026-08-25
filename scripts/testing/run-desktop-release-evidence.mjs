import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  readJson,
  repoRoot,
} from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import {
  hashCollectorArtifact,
  validateRawReleaseManualEvidence,
} from './release-manual-collector.mjs';

export const DESKTOP_RELEASE_EVIDENCE_SCENARIOS = Object.freeze([
  'E2E-PROVIDER-CONFIG',
  'E2E-PROVIDER-PROBE',
  'E2E-DIAGNOSTICS-EXPORT',
]);

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/desktop-release-evidence';
const DEFAULT_COLLECTOR_OUTPUT_ROOT = 'artifacts/testing/release-manual-collector';
const DEFAULT_TIMEOUT_MS = 180_000;
const DESKTOP_EXECUTABLE_NAME = 'omni-desktop-shell.exe';
const DESKTOP_BUILD_SCRIPT = 'scripts/development/build-desktop-release.mjs';

const sha256File = (candidate) => crypto
  .createHash('sha256')
  .update(fs.readFileSync(candidate))
  .digest('hex');

const assertExactCleanProvenance = (provenance) => {
  if (
    !/^[a-f0-9]{40}$/i.test(String(provenance?.headCommit ?? ''))
    || provenance?.worktreeClean !== true
    || Number(provenance?.dirtyEntryCount) !== 0
  ) throw new Error('desktop release evidence requires the current exact clean HEAD');
};

export function parseDesktopReleaseEvidenceArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      scenarioId: '',
      outputRoot: DEFAULT_OUTPUT_ROOT,
      collectorOutputRoot: DEFAULT_COLLECTOR_OUTPUT_ROOT,
      providerId: '',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  });
}

export function buildCurrentDesktopRelease({
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  timeoutMs = 600_000,
  run = spawnSync,
  provenanceReader = () => currentGitProvenance({ cwd: workspaceRoot }),
} = {}) {
  assertExactCleanProvenance(provenance);
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const executablePath = path.join(
    absoluteWorkspace,
    'target',
    'release',
    DESKTOP_EXECUTABLE_NAME,
  );
  fs.rmSync(executablePath, { force: true });
  const environment = { ...process.env };
  environment.CARGO_TARGET_DIR = path.join(absoluteWorkspace, 'target');
  environment.OMNI_BUILD_COMMIT = provenance.headCommit;
  delete environment.CARGO_BUILD_TARGET;
  const result = run(process.execPath, [path.join(absoluteWorkspace, ...DESKTOP_BUILD_SCRIPT.split('/'))], {
    cwd: absoluteWorkspace,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
    timeout: Number(timeoutMs),
  });
  if (Number(result?.status) !== 0) {
    throw new Error(`current-HEAD Desktop release build failed: ${result?.stderr ?? ''}`);
  }
  const after = provenanceReader();
  const mismatch = exactGitProvenanceFailure(provenance, after, {
    recordedSubject: 'Desktop build provenance',
    currentSubject: 'post-build checkout provenance',
  });
  if (mismatch) throw new Error(mismatch);
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw new Error(`Desktop release build did not produce ${executablePath}`);
  }
  return executablePath;
}

export function buildDesktopReleaseEvidencePlan({
  scenarioId,
  workspaceRoot = repoRoot,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  collectorOutputRoot = DEFAULT_COLLECTOR_OUTPUT_ROOT,
  providerId = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  suffix = crypto.randomUUID().slice(0, 8),
  exists = fs.existsSync,
  desktopExecutable,
  source,
  dryRun,
  skip,
  simulated,
} = {}) {
  if ([desktopExecutable, source, dryRun, skip, simulated].some((value) => value !== undefined)) {
    throw new Error(
      'Desktop production emitter does not accept executable/source/dry-run/skip/simulated overrides',
    );
  }
  if (!DESKTOP_RELEASE_EVIDENCE_SCENARIOS.includes(scenarioId)) {
    throw new Error(
      `--scenario-id must be one of: ${DESKTOP_RELEASE_EVIDENCE_SCENARIOS.join(', ')}`,
    );
  }
  assertExactCleanProvenance(provenance);
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const absoluteExecutable = path.join(
    absoluteWorkspace,
    'target',
    'release',
    DESKTOP_EXECUTABLE_NAME,
  );
  if (!exists(absoluteExecutable) || !fs.statSync(absoluteExecutable).isFile()) {
    throw new Error(
      `canonical release Desktop executable is missing: ${absoluteExecutable}; run npm run build:desktop-shell`,
    );
  }
  const parsedTimeout = Number(timeoutMs);
  if (!Number.isInteger(parsedTimeout) || parsedTimeout < 30_000 || parsedTimeout > 600_000) {
    throw new Error('--timeout-ms must be an integer between 30000 and 600000');
  }
  const runDirectory = path.resolve(
    workspaceRoot,
    outputRoot,
    provenance.headCommit.slice(0, 12),
    `${compactTimestamp(now)}-${scenarioId.toLowerCase()}-${suffix}`,
  );
  return {
    scenarioId,
    workspaceRoot,
    collectorOutputRoot,
    provenance,
    executablePath: absoluteExecutable,
    executableSha256: sha256File(absoluteExecutable),
    runDirectory,
    timeoutMs: parsedTimeout,
    environment: {
      OMNI_RELEASE_EVIDENCE_SCENARIO: scenarioId,
      OMNI_RELEASE_EVIDENCE_OUTPUT_DIRECTORY: runDirectory,
      OMNI_RELEASE_EVIDENCE_HEAD_COMMIT: provenance.headCommit,
      OMNI_LOG_LEVEL: 'debug',
      ...(providerId ? { OMNI_RELEASE_EVIDENCE_PROVIDER_ID: providerId } : {}),
    },
  };
}

export function runningDesktopProcesses({ run = spawnSync } = {}) {
  if (process.platform !== 'win32') return [];
  const result = run(
    'tasklist',
    ['/FI', 'IMAGENAME eq omni-desktop-shell.exe', '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`tasklist failed while checking Desktop ownership: ${result.stderr ?? ''}`);
  }
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^"omni-desktop-shell\.exe"/i.test(line))
    .map((line) => Number(line.match(/^"[^"]+","(\d+)"/)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

const waitForChild = (child, timeoutMs, { killTree = true } = {}) => new Promise((resolve, reject) => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (killTree && process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
      });
    } else child.kill('SIGKILL');
    reject(new Error(`Desktop release evidence timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, signal, processId: child.pid });
  });
});

export function validateDesktopReleaseEmitterOutput(plan, processId, { now = Date.now() } = {}) {
  if (!fs.existsSync(plan.runDirectory) || !fs.statSync(plan.runDirectory).isDirectory()) {
    throw new Error(`Desktop emitter did not publish ${plan.runDirectory}`);
  }
  const resultPath = path.join(plan.runDirectory, 'emitter-result.json');
  if (!fs.existsSync(resultPath)) throw new Error('Desktop emitter result is missing');
  const result = readJson(resultPath);
  if (
    result?.scenarioId !== plan.scenarioId
    || result?.status !== 'completed'
    || Number(result?.desktopProcessId) !== Number(processId)
  ) throw new Error('Desktop emitter result does not match the launched production process');
  if (String(result?.sourceHeadCommit ?? '').toLowerCase() !== plan.provenance.headCommit.toLowerCase()) {
    throw new Error('Desktop emitter build commit does not match the current exact clean HEAD');
  }
  if (result?.desktopExecutableSha256 !== plan.executableSha256) {
    throw new Error('Desktop emitter executable SHA-256 does not match the launched binary');
  }
  if (path.resolve(result?.desktopExecutable ?? '') !== path.resolve(plan.executablePath)) {
    throw new Error('Desktop emitter executable path does not match the launched binary');
  }
  const raw = validateRawReleaseManualEvidence(plan.runDirectory, plan.scenarioId, {
    workspaceRoot: plan.workspaceRoot,
    currentProvenance: plan.provenance,
    now,
  });
  if (raw.issues.length > 0 || !raw.summary) {
    throw new Error(`Desktop emitter output failed authority validation:\n- ${raw.issues.join('\n- ')}`);
  }
  return { result, raw };
}

export async function runDesktopReleaseEvidence({
  plan,
  launch = (executablePath, environment) => spawn(executablePath, [], {
    cwd: path.dirname(executablePath),
    env: { ...process.env, ...environment },
    stdio: 'ignore',
    windowsHide: false,
  }),
  listRunning = () => runningDesktopProcesses(),
  wait = waitForChild,
  collectEvidence,
  now = new Date(),
} = {}) {
  if (!plan) throw new Error('desktop release evidence plan is required');
  const running = listRunning();
  if (running.length > 0) {
    throw new Error(
      `close every existing omni-desktop-shell.exe before collection; running PIDs: ${running.join(', ')}`,
    );
  }
  if (typeof collectEvidence !== 'function') {
    throw new Error('Desktop raw packaging is private; invoke the production release collector entrypoint');
  }
  ensureDir(path.dirname(plan.runDirectory));
  const child = launch(plan.executablePath, plan.environment);
  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    throw new Error('failed to launch the production Desktop evidence process');
  }
  const terminal = await wait(child, plan.timeoutMs);
  if (terminal.code !== 0) {
    const failurePath = path.join(plan.runDirectory, 'emitter-result.json');
    const detail = fs.existsSync(failurePath)
      ? readJson(failurePath)?.error
      : `signal=${terminal.signal ?? 'none'}`;
    throw new Error(`Desktop release evidence process failed with exit ${terminal.code}: ${detail}`);
  }
  const checked = validateDesktopReleaseEmitterOutput(plan, terminal.processId, { now: now.getTime() });
  const collected = await collectEvidence({
    source: plan.runDirectory,
    scenarioId: plan.scenarioId,
    outputRoot: plan.collectorOutputRoot,
    workspaceRoot: plan.workspaceRoot,
    provenance: plan.provenance,
    now,
  });
  return {
    scenarioId: plan.scenarioId,
    processId: terminal.processId,
    invocationId: checked.result.invocationId,
    rawDirectory: plan.runDirectory,
    rawSha256: hashCollectorArtifact(plan.runDirectory).sha256,
    packageDirectory: collected.packageDirectory,
    manifestPath: collected.manifestPath,
  };
}

if (isMain(import.meta.url)) {
  setImmediate(async () => {
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('Desktop release evidence requires Windows x64');
      }
      const args = parseDesktopReleaseEvidenceArgs(process.argv.slice(2));
      const { collectDesktopReleaseManualEvidence } = await import('./release-manual-collector.mjs');
      const result = await collectDesktopReleaseManualEvidence(args);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
}
