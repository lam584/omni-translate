import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_STARTUP_PHASE_THRESHOLDS } from './verify-startup-readiness.mjs';

export const STARTUP_COLLECTION_SCHEMA = 'startup-readiness-collection/v1';

const FRONTEND_STEP_BUDGETS = DEFAULT_STARTUP_PHASE_THRESHOLDS.frontendStepMs;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function readText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function frontendStepDurations(frontend) {
  const durations = {};
  for (const [id, step] of Object.entries(frontend?.steps ?? {})) {
    const endedAt = finite(step?.doneAtMs) ? step.doneAtMs : step?.errorAtMs;
    if (finite(step?.activeAtMs) && finite(endedAt)) durations[id] = endedAt - step.activeAtMs;
  }
  if (finite(frontend?.bootstrapOverlayCompletionDelayMs)) {
    durations['bootstrap-overlay-delay'] = frontend.bootstrapOverlayCompletionDelayMs;
  }
  return durations;
}

function phaseMetrics(collection) {
  const ready = collection.readiness ?? {};
  const window = collection.window ?? {};
  const frontend = ready.frontend;
  const launchEpochMs = Date.parse(collection.launchStartedAt);
  let mountElapsed = null;
  let readySignalElapsed = null;
  if (finite(frontend?.appMountedAtEpochMs)) mountElapsed = frontend.appMountedAtEpochMs - launchEpochMs;
  else if (finite(frontend?.timeOriginMs)) mountElapsed = frontend.timeOriginMs - launchEpochMs;
  if (finite(frontend?.readySignalAtEpochMs)) readySignalElapsed = frontend.readySignalAtEpochMs - launchEpochMs;
  else if (finite(mountElapsed) && finite(frontend?.readyAfterAppMountMs)) readySignalElapsed = mountElapsed + frontend.readyAfterAppMountMs;
  const windowToReadyMs = finite(ready.detectedElapsedMs) && finite(window.detectedElapsedMs)
    ? (finite(readySignalElapsed) ? readySignalElapsed : ready.detectedElapsedMs) - window.detectedElapsedMs
    : null;
  return {
    readiness: { ...ready, windowToReadyMs },
    phases: {
      launchToWindowMs: window.detected ? window.detectedElapsedMs : null,
      windowToReadyMs,
      windowToFrontendMountMs: finite(mountElapsed) && finite(window.detectedElapsedMs) ? mountElapsed - window.detectedElapsedMs : null,
      frontendMountToReadySignalMs: finite(frontend?.readyAfterAppMountMs) ? frontend.readyAfterAppMountMs : null,
      readySignalToNativeLogMs: finite(ready.detectedElapsedMs) && finite(readySignalElapsed) ? ready.detectedElapsedMs - readySignalElapsed : null,
    },
    frontendStepDurationsMs: frontendStepDurations(frontend),
  };
}

function commandMetrics(collection) {
  const stdout = `${readText(collection.artifacts?.stdout)}\n${readText(collection.artifacts?.viteStdout)}`;
  const stderr = readText(collection.artifacts?.stderr);
  const vite = stdout.match(/ready in\s+(\d+(?:\.\d+)?)\s*(ms|s)/i);
  const cargo = stderr.match(/Finished.+?in\s+(\d+(?:\.\d+)?)s/i);
  return {
    viteReadyMs: vite ? Math.round(Number(vite[1]) * (vite[2].toLowerCase() === 's' ? 1000 : 1)) : null,
    cargoBuildMs: cargo ? Math.round(Number(cargo[1]) * 1000) : null,
  };
}

function classifyDevFailure(collection) {
  const combined = `${readText(collection.artifacts?.stdout)}\n${readText(collection.artifacts?.stderr)}`;
  if (/os error 740|请求的操作需要提升|requires elevation|requires elevated|requireAdministrator/i.test(combined)) {
    return { verdict: 'requires-elevation', summary: 'The desktop shell requires elevation and could not be launched from this PowerShell session.' };
  }
  if (/Port\s+\d+\s+is already in use|error when starting dev server/i.test(combined)) {
    return { verdict: 'dev-server-start-failed', summary: 'The frontend dev server failed to start.' };
  }
  if (/could not compile|error\[E\d+\]|failed to remove file/i.test(combined)) {
    return { verdict: 'tauri-build-failed', summary: 'The Tauri Rust shell did not build successfully.' };
  }
  if (/beforeDevCommand.*non-zero status code|DevCommand.*non-zero/i.test(combined)) {
    return { verdict: 'tauri-dev-command-failed', summary: 'The Tauri dev command exited or failed before readiness.' };
  }
  return null;
}

function thresholdIssues(metrics, thresholds) {
  const issues = [];
  const checks = [
    ['windowToFrontendMountMs', thresholds.maxWindowToFrontendMountMs],
    ['frontendMountToReadySignalMs', thresholds.maxFrontendBootstrapMs],
    ['readySignalToNativeLogMs', thresholds.maxReadySignalToNativeLogMs],
  ];
  for (const [name, budget] of checks) {
    if (finite(metrics.phases[name]) && metrics.phases[name] > budget) issues.push(`${name}=${metrics.phases[name]} exceeds ${budget}ms`);
  }
  for (const [name, duration] of Object.entries(metrics.frontendStepDurationsMs)) {
    const budget = FRONTEND_STEP_BUDGETS[name];
    if (finite(budget) && duration > budget) issues.push(`frontend step '${name}' duration ${duration}ms exceeds ${budget}ms`);
  }
  return issues;
}

function elapsedMarker(marker, launchEpochMs) {
  if (!marker?.detected) return { detected: false, elapsedMs: null };
  return { detected: true, elapsedMs: marker.timestamp ? Math.round(Date.parse(marker.timestamp) - launchEpochMs) : null, ...(marker.convergence !== undefined ? { convergence: marker.convergence } : {}) };
}

export function buildStartupReadinessReport(collection) {
  if (collection?.schemaVersion !== STARTUP_COLLECTION_SCHEMA) throw new Error(`unsupported startup collection schema: ${collection?.schemaVersion}`);
  const thresholds = { ...collection.thresholds, frontendStepMs: FRONTEND_STEP_BUDGETS };
  const metrics = phaseMetrics(collection);
  const phaseIssues = thresholdIssues(metrics, thresholds);
  let verdict = 'passed';
  let failure = null;
  if (collection.dryRun) verdict = 'dry-run';
  else if (collection.preflightFailure) {
    verdict = collection.preflightFailure.code;
    failure = { verdict, summary: collection.preflightFailure.message };
  } else if (metrics.readiness.detected && Object.values(metrics.readiness.frontend?.steps ?? {}).some((step) => finite(step?.errorAtMs))) {
    verdict = 'bootstrap-error-before-ready';
    failure = { verdict, summary: 'Frontend bootstrap completed through an error path, so the app was not considered functionally ready.' };
  } else if (metrics.readiness.detected && finite(metrics.readiness.windowToReadyMs) && metrics.readiness.windowToReadyMs > thresholds.maxWindowToReadyMs) {
    verdict = 'readiness-threshold-failed';
    failure = { verdict, summary: `Window-to-readiness latency exceeded the ${thresholds.maxWindowToReadyMs}ms threshold.` };
  } else if (metrics.readiness.detected && phaseIssues.length > 0) {
    verdict = 'startup-phase-threshold-failed';
    failure = { verdict, summary: `Startup phase thresholds failed: ${phaseIssues.join('; ')}` };
  } else if (!metrics.readiness.detected) {
    failure = classifyDevFailure(collection);
    verdict = failure?.verdict ?? (collection.process?.exitedBeforeReady ? 'process-exited-before-ready' : collection.window?.detected ? 'ready-timeout' : 'window-timeout');
  }
  const launchEpochMs = Date.parse(collection.launchStartedAt);
  const full = collection.fullReadinessRaw;
  const fullReadiness = full ? {
    routeReady: elapsedMarker(full.routeReady, launchEpochMs),
    stylesReady: elapsedMarker(full.stylesReady, launchEpochMs),
    bridgeConverged: elapsedMarker(full.bridgeConverged, launchEpochMs),
    fullReady: elapsedMarker(full.fullReady, launchEpochMs),
  } : null;
  const baseCommandMetrics = commandMetrics(collection);
  const windowMs = collection.window?.detected ? collection.window.detectedElapsedMs : null;
  const readyMs = metrics.readiness.detected ? metrics.readiness.detectedElapsedMs : null;
  const fullMs = fullReadiness?.fullReady?.elapsedMs ?? null;
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runId: collection.runId,
    dryRun: Boolean(collection.dryRun),
    verdict,
    command: collection.command,
    launchStartedAt: collection.launchStartedAt,
    timeoutSeconds: collection.timeoutSeconds,
    thresholds,
    devServer: collection.devServer,
    poll: collection.poll,
    window: collection.window,
    readiness: metrics.readiness,
    phases: metrics.phases,
    frontendStepDurationsMs: metrics.frontendStepDurationsMs,
    fullReadiness,
    devCommandMetrics: {
      ...baseCommandMetrics,
      commandToWindowMs: windowMs,
      commandToReadyMs: readyMs,
      commandToFullReadyMs: fullMs,
      windowToFullReadyMs: finite(windowMs) && finite(fullMs) ? fullMs - windowMs : null,
      routeLoadMs: fullReadiness?.routeReady?.elapsedMs ?? null,
      stylesLoadMs: fullReadiness?.stylesReady?.elapsedMs ?? null,
      bridgeConvergeMs: fullReadiness?.bridgeConverged?.elapsedMs ?? null,
    },
    failure,
    process: collection.process,
    artifacts: { ...collection.artifacts, collection: path.basename(collection.collectionPath ?? 'startup-collection.json') },
  };
}

function markdown(report) {
  return [
    '# Startup readiness report', '',
    `- runId: \`${report.runId}\``,
    `- verdict: **${report.verdict}**`,
    `- command: \`${report.command}\``,
    `- window detected: ${report.window?.detectedElapsedMs ?? 'n/a'} ms`,
    `- readiness detected: ${report.readiness?.detectedElapsedMs ?? 'n/a'} ms`,
    `- window to readiness: ${report.readiness?.windowToReadyMs ?? 'n/a'} ms`,
  ].join('\n');
}

export function writeStartupReadinessReport({ inputPath, outputDirectory }) {
  const collection = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  collection.collectionPath = inputPath;
  const report = buildStartupReadinessReport(collection);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'report.md'), `${markdown(report)}\n`);
  return report;
}

function parseArgs(argv) {
  const result = { inputPath: null, outputDirectory: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input') result.inputPath = path.resolve(argv[++i]);
    else if (argv[i] === '--output') result.outputDirectory = path.resolve(argv[++i]);
  }
  if (!result.inputPath || !result.outputDirectory) throw new Error('usage: node startup-readiness-report.mjs --input <startup-collection.json> --output <run-directory>');
  return result;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const report = writeStartupReadinessReport(parseArgs(process.argv.slice(2)));
  console.log(path.join(path.resolve(parseArgs(process.argv.slice(2)).outputDirectory), 'report.json'));
  process.exitCode = report.verdict === 'passed' || report.verdict === 'dry-run' ? 0 : 1;
}
