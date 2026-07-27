/**
 * Pure logic for the startup IPC-ping stress runner.
 *
 * Nothing here launches a process: scripts/testing/run-startup-ipc-stress.ps1
 * owns the N launches, the polling and the kills, and hands the per-run evidence
 * back as JSON. Marker detection, latency statistics, pass/fail evaluation and
 * report shaping live here so they can be unit-tested without a desktop session
 * (scripts/testing/startup-orchestration.test.mjs).
 *
 * Why the ping is observed through app.log instead of a CLI call:
 * `omni-desktop-shell.exe` registers no CLI plugin and never reads argv, so
 * "<exe> tauri invoke debug_ipc_ping" would silently launch a *second* app
 * instance rather than probe the running one. The authoritative out-of-process
 * signal that the native IPC channel came up is therefore the log line the
 * `debug_ipc_ping` command writes when the renderer reaches it, with the
 * info-level `runtime-bootstrap` notification (emitted only after that ping
 * succeeded) as the fallback marker for runs where the debug level is off.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  isMain,
  parseCliArgs,
  readJson,
  repoRoot,
  sortableTimestamp,
  writeJson,
} from '../lib/testing-common.mjs';
import { currentGitCommit } from './watch-mode-report.mjs';
import {
  IPC_NEVER_CONNECTED_MARKER,
  RELEASE_EXECUTABLE_NAME,
  resolveReleaseExecutable,
} from './overlay-driver-smoke.mjs';

export { IPC_NEVER_CONNECTED_MARKER, RELEASE_EXECUTABLE_NAME };

export const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/startup-ipc-stress';
export const DEFAULT_APP_LOG_PATH = 'artifacts/diagnostics/logs/app.log';
export const DEFAULT_RUN_COUNT = 10;
/**
 * Must stay above the native IPC watchdog grace (IPC_WATCHDOG_GRACE = 65s in
 * apps/desktop/src-tauri/src/main.rs): a run that never connects has to stay
 * alive long enough for `startup.ipc_never_connected` to be written, otherwise
 * the stress would kill the process before the evidence exists.
 */
export const DEFAULT_PING_TIMEOUT_MS = 90_000;
export const IPC_WATCHDOG_GRACE_MS = 65_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

/** Native log line written by the `debug_ipc_ping` command handler itself. */
export const IPC_PING_LOG_MARKER = 'debug_ipc_ping';
/** Info-level notification id emitted by `bootstrap_runtime`, i.e. after the ping. */
export const IPC_BRIDGE_READY_MARKER = 'runtime-bootstrap';
export const IPC_CONNECTED_MARKERS = [IPC_PING_LOG_MARKER, IPC_BRIDGE_READY_MARKER];

/** `debug_ipc_ping` runs at debug level; release builds default to info. */
export const STRESS_LAUNCH_ENVIRONMENT = { OMNI_LOG_LEVEL: 'debug' };

const FAILURE_WORDS = /fail|error|timeout|超时|未响应/i;

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const asFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Pull `status=<x> elapsedMs=<n>` out of a `debug_ipc_ping` log line. */
export function parseIpcPingLogLine(line) {
  const text = String(line ?? '');
  return {
    storageStatus: text.match(/status=([A-Za-z0-9_-]+)/)?.[1] ?? null,
    nativeElapsedMs: asFiniteNumber(text.match(/elapsedMs=(\d+)/)?.[1]),
  };
}

/**
 * First line in the log delta that proves the native IPC channel accepted a
 * ping. Lines that merely mention the command while reporting a failure (the
 * renderer's "debug_ipc_ping failed" forward) never count as success.
 */
export function findIpcPingEvidence(logDelta) {
  const lines = String(logDelta ?? '').split(/\r?\n/);
  let fallback = null;
  for (const line of lines) {
    if (!line.trim() || line.includes(IPC_NEVER_CONNECTED_MARKER)) continue;
    if (line.includes(IPC_PING_LOG_MARKER) && !FAILURE_WORDS.test(line)) {
      return { connected: true, marker: IPC_PING_LOG_MARKER, line, ...parseIpcPingLogLine(line) };
    }
    if (fallback === null && line.includes(IPC_BRIDGE_READY_MARKER) && !FAILURE_WORDS.test(line)) {
      fallback = { connected: true, marker: IPC_BRIDGE_READY_MARKER, line, storageStatus: null, nativeElapsedMs: null };
    }
  }
  return fallback ?? { connected: false, marker: null, line: null, storageStatus: null, nativeElapsedMs: null };
}

/** `startup.ipc_never_connected` lines in one run's app.log delta. */
export function detectNeverConnected(logDelta) {
  const lines = String(logDelta ?? '')
    .split(/\r?\n/)
    .filter((line) => line.includes(IPC_NEVER_CONNECTED_MARKER));
  return { detected: lines.length > 0, lines };
}

export function buildStartupIpcStressPlan({
  workspaceRoot = '.',
  version = null,
  runs = DEFAULT_RUN_COUNT,
  pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  releaseExecutablePath = '',
  outputRoot = DEFAULT_OUTPUT_ROOT,
  appLogPath = DEFAULT_APP_LOG_PATH,
  exists = () => false,
} = {}) {
  const resolvedRuns = asPositiveInteger(runs, null);
  if (resolvedRuns === null) {
    throw new Error(`startup IPC stress run count must be a positive integer; got ${runs}`);
  }
  const resolvedTimeout = asPositiveInteger(pingTimeoutMs, DEFAULT_PING_TIMEOUT_MS);
  const releaseExecutable = resolveReleaseExecutable({
    workspaceRoot,
    version,
    explicitPath: releaseExecutablePath,
    exists,
  });
  return {
    workspaceRoot,
    outputRoot,
    runs: resolvedRuns,
    pingTimeoutMs: resolvedTimeout,
    pollIntervalMs: asPositiveInteger(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    watchdogGraceMs: IPC_WATCHDOG_GRACE_MS,
    /**
     * A run that never pings must outlive the native watchdog grace, otherwise
     * `startup.ipc_never_connected` can never be observed.
     */
    timeoutCoversWatchdogGrace: resolvedTimeout > IPC_WATCHDOG_GRACE_MS,
    appLogPath,
    releaseExecutable,
    environment: { ...STRESS_LAUNCH_ENVIRONMENT },
    ipcConnectedMarkers: [...IPC_CONNECTED_MARKERS],
    neverConnectedMarker: IPC_NEVER_CONNECTED_MARKER,
    perRunSteps: [
      'record the current app.log length',
      `launch ${releaseExecutable.path} with ${Object.entries(STRESS_LAUNCH_ENVIRONMENT).map(([key, value]) => `${key}=${value}`).join(' ')}`,
      `poll the app.log delta every ${asPositiveInteger(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)}ms for ${IPC_CONNECTED_MARKERS.join(' or ')} (up to ${resolvedTimeout}ms)`,
      `keep a non-connecting run alive past the ${IPC_WATCHDOG_GRACE_MS}ms watchdog grace so ${IPC_NEVER_CONNECTED_MARKER} can be recorded`,
      'force-stop the process tree and any surviving omni-desktop-shell process',
      'store the app.log delta, the measured latency and the watchdog verdict for this run',
    ],
  };
}

export function formatStartupIpcStressPlanText(plan) {
  return [
    '=== startup IPC-ping stress (plan) ===',
    `workspaceRoot: ${plan.workspaceRoot}`,
    `outputRoot:    ${plan.outputRoot}`,
    `runs:          ${plan.runs}`,
    `ping timeout:  ${plan.pingTimeoutMs}ms (watchdog grace ${plan.watchdogGraceMs}ms, covered=${plan.timeoutCoversWatchdogGrace})`,
    `poll interval: ${plan.pollIntervalMs}ms`,
    `app log:       ${plan.appLogPath}`,
    '',
    `release executable: ${plan.releaseExecutable.path}`,
    `release executable found: ${plan.releaseExecutable.found}`,
    ...(plan.releaseExecutable.found ? [] : [`  build it with: ${plan.releaseExecutable.buildHint}`]),
    '',
    `launch environment: ${Object.entries(plan.environment).map(([key, value]) => `${key}=${value}`).join(' ')}`,
    `IPC connected markers: ${plan.ipcConnectedMarkers.join(', ')}`,
    `never-connected marker: ${plan.neverConnectedMarker}`,
    '',
    'per run:',
    ...plan.perRunSteps.map((step) => `  - ${step}`),
    '',
    'exit code: nonzero if any run never reached a successful IPC ping',
  ].join('\n');
}

/**
 * Normalize one raw run into the record the summary consumes. `connected` is
 * derived from the recorded log delta, never trusted from the caller, so a
 * runner bug cannot report a connection that the log does not show.
 */
export function buildStressRunRecord(raw = {}) {
  const logDelta = String(raw.logDelta ?? '');
  const evidence = findIpcPingEvidence(logDelta);
  const watchdog = detectNeverConnected(logDelta);
  const launched = raw.launched !== false;
  return {
    index: asPositiveInteger(raw.index, 0),
    launched,
    launchError: raw.launchError ?? null,
    processId: raw.processId ?? null,
    connected: launched && evidence.connected,
    marker: evidence.marker,
    markerLine: evidence.line,
    storageStatus: evidence.storageStatus,
    nativeElapsedMs: evidence.nativeElapsedMs,
    latencyMs: evidence.connected ? asFiniteNumber(raw.latencyMs) : null,
    waitedMs: asFiniteNumber(raw.waitedMs),
    neverConnected: watchdog.detected,
    neverConnectedLines: watchdog.lines,
    killed: raw.killed === true,
    logDeltaBytes: logDelta.length,
  };
}

const percentile = (sortedValues, fraction) => {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil(fraction * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length, Math.max(1, rank)) - 1];
};

export function summarizeStartupIpcStressRuns(runs = [], { requestedRuns = null, pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS } = {}) {
  const records = Array.isArray(runs) ? runs : [];
  const latencies = records
    .filter((run) => run.connected && Number.isFinite(Number(run.latencyMs)))
    .map((run) => Number(run.latencyMs))
    .sort((left, right) => left - right);
  const failures = [];

  if (records.length === 0) {
    failures.push('no startup IPC stress runs were executed');
  }
  if (requestedRuns != null && records.length < requestedRuns) {
    failures.push(`only ${records.length} of ${requestedRuns} requested runs were executed`);
  }
  for (const run of records) {
    if (!run.launched) {
      failures.push(`run ${run.index} failed to launch the release shell: ${run.launchError ?? 'no error recorded'}`);
      continue;
    }
    if (!run.connected) {
      failures.push(
        `run ${run.index} never reached a successful IPC ping within ${pingTimeoutMs}ms (waited ${run.waitedMs ?? '-'}ms)`,
      );
    }
    if (run.neverConnected) {
      failures.push(`run ${run.index} logged ${IPC_NEVER_CONNECTED_MARKER}: ${run.neverConnectedLines.at(-1)}`);
    }
  }

  return {
    totalRuns: records.length,
    requestedRuns,
    connectedRuns: records.filter((run) => run.connected).length,
    neverConnectedRuns: records.filter((run) => !run.connected).length,
    watchdogRuns: records.filter((run) => run.neverConnected).length,
    launchFailures: records.filter((run) => !run.launched).length,
    latencyMs: {
      samples: latencies.length,
      min: latencies.at(0) ?? null,
      max: latencies.at(-1) ?? null,
      mean: latencies.length > 0
        ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length)
        : null,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    passed: failures.length === 0,
    failures,
  };
}

export function buildStartupIpcStressReport({
  evidence = {},
  generatedAt = sortableTimestamp(),
  gitCommit = null,
  artifacts = {},
} = {}) {
  const dryRun = evidence.dryRun === true;
  const runs = Array.isArray(evidence.runs) ? evidence.runs.map(buildStressRunRecord) : [];
  const pingTimeoutMs = asPositiveInteger(evidence.plan?.pingTimeoutMs, DEFAULT_PING_TIMEOUT_MS);
  const summary = dryRun
    ? { totalRuns: 0, requestedRuns: evidence.plan?.runs ?? null, connectedRuns: 0, neverConnectedRuns: 0, watchdogRuns: 0, launchFailures: 0, latencyMs: { samples: 0, min: null, max: null, mean: null, p50: null, p95: null }, passed: true, failures: [] }
    : summarizeStartupIpcStressRuns(runs, { requestedRuns: evidence.plan?.runs ?? null, pingTimeoutMs });
  return {
    schemaVersion: 1,
    kind: 'startup-ipc-stress',
    generatedAt,
    gitCommit,
    runId: evidence.runId ?? null,
    dryRun,
    verdict: dryRun ? 'dry-run' : summary.passed ? 'passed' : 'failed',
    startedAt: evidence.startedAt ?? null,
    finishedAt: evidence.finishedAt ?? null,
    plan: evidence.plan ?? null,
    runnerError: evidence.runnerError ?? null,
    summary,
    runs,
    artifacts,
  };
}

export function startupIpcStressExitCode(report) {
  return report?.verdict === 'failed' ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Thin CLI seam: JSON in, JSON out.
//   --mode plan   (writes plan.json, prints the plan text)
//   --mode report (reads evidence.json, writes report.json, sets the exit code)

function readVersion(workspaceRoot) {
  try {
    return readJson(path.join(workspaceRoot, 'package.json')).version ?? null;
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), {
      booleans: ['dry-run'],
      defaults: {
        mode: 'plan',
        output: '',
        input: '',
        workspaceRoot: '',
        runs: String(DEFAULT_RUN_COUNT),
        pingTimeoutMs: String(DEFAULT_PING_TIMEOUT_MS),
        pollIntervalMs: String(DEFAULT_POLL_INTERVAL_MS),
        releaseExecutablePath: '',
        outputRoot: DEFAULT_OUTPUT_ROOT,
        appLogPath: DEFAULT_APP_LOG_PATH,
      },
    });
    const workspaceRoot = args.workspaceRoot || repoRoot;
    const outputDir = args.output || path.join(workspaceRoot, DEFAULT_OUTPUT_ROOT);
    fs.mkdirSync(outputDir, { recursive: true });

    if (args.mode === 'plan') {
      const plan = buildStartupIpcStressPlan({
        workspaceRoot,
        version: readVersion(workspaceRoot),
        runs: Number(args.runs),
        pingTimeoutMs: Number(args.pingTimeoutMs),
        pollIntervalMs: Number(args.pollIntervalMs),
        releaseExecutablePath: args.releaseExecutablePath,
        outputRoot: args.outputRoot,
        appLogPath: args.appLogPath,
        exists: (candidate) => fs.existsSync(candidate),
      });
      const planPath = path.join(outputDir, 'plan.json');
      writeJson(planPath, plan);
      console.log(formatStartupIpcStressPlanText(plan));
      if (args.dryRun) {
        const reportPath = path.join(outputDir, 'report.json');
        writeJson(
          reportPath,
          buildStartupIpcStressReport({
            evidence: { dryRun: true, plan, runId: path.basename(outputDir) },
            gitCommit: currentGitCommit(),
            artifacts: { plan: planPath, report: reportPath },
          }),
        );
        console.log(reportPath);
      } else {
        console.log(planPath);
      }
      process.exit(0);
    }

    if (args.mode !== 'report') {
      throw new Error(`Unknown --mode ${args.mode}; expected plan or report`);
    }

    const inputDir = args.input || outputDir;
    const evidencePath = path.join(inputDir, 'evidence.json');
    if (!fs.existsSync(evidencePath)) {
      throw new Error(`startup IPC stress evidence was not written: ${evidencePath}`);
    }
    const reportPath = path.join(outputDir, 'report.json');
    const report = buildStartupIpcStressReport({
      evidence: readJson(evidencePath),
      gitCommit: currentGitCommit(),
      artifacts: { evidence: evidencePath, report: reportPath, plan: path.join(inputDir, 'plan.json') },
    });
    writeJson(reportPath, report);
    console.log(reportPath);
    console.log(
      `runs=${report.summary.totalRuns} connected=${report.summary.connectedRuns} `
      + `neverConnected=${report.summary.neverConnectedRuns} watchdogLines=${report.summary.watchdogRuns} `
      + `latencyMs p50=${report.summary.latencyMs.p50 ?? '-'} p95=${report.summary.latencyMs.p95 ?? '-'} max=${report.summary.latencyMs.max ?? '-'}`,
    );
    if (report.verdict === 'failed') {
      console.error(`startup IPC stress FAILED (${report.summary.failures.length} issue(s)):`);
      for (const failure of report.summary.failures) {
        console.error(`- ${failure}`);
      }
    }
    process.exit(startupIpcStressExitCode(report));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
