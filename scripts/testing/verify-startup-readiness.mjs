import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_WINDOW_TO_READY_MS = 10000;
export const DEFAULT_STARTUP_PHASE_THRESHOLDS = {
  maxWindowToReadyMs: DEFAULT_MAX_WINDOW_TO_READY_MS,
  maxWindowToFrontendMountMs: 1000,
  maxFrontendBootstrapMs: 8500,
  maxReadySignalToNativeLogMs: 500,
  frontendStepMs: {
    'detect-runtime': 200,
    'check-ipc': 1000,
    'init-runtime': 1500,
    'init-audio': 3000,
    'load-config': 2400,
    'bootstrap-overlay-delay': 0,
  },
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function collectStartupReadinessIssues(report, options = {}) {
  const thresholds = options.thresholds ?? DEFAULT_STARTUP_PHASE_THRESHOLDS;
  const issues = [];

  if (report?.thresholds?.maxWindowToReadyMs !== thresholds.maxWindowToReadyMs) {
    issues.push(`expected threshold maxWindowToReadyMs=${thresholds.maxWindowToReadyMs}`);
  }
  if (report?.thresholds?.maxWindowToFrontendMountMs !== thresholds.maxWindowToFrontendMountMs) {
    issues.push(`expected threshold maxWindowToFrontendMountMs=${thresholds.maxWindowToFrontendMountMs}`);
  }
  if (report?.thresholds?.maxFrontendBootstrapMs !== thresholds.maxFrontendBootstrapMs) {
    issues.push(`expected threshold maxFrontendBootstrapMs=${thresholds.maxFrontendBootstrapMs}`);
  }
  if (report?.thresholds?.maxReadySignalToNativeLogMs !== thresholds.maxReadySignalToNativeLogMs) {
    issues.push(`expected threshold maxReadySignalToNativeLogMs=${thresholds.maxReadySignalToNativeLogMs}`);
  }

  if (!report?.window?.detected) {
    issues.push('main window was not detected');
  }

  if (!report?.readiness?.detected) {
    issues.push('startup readiness marker was not detected');
  }

  const windowToReadyMs = report?.readiness?.windowToReadyMs;
  if (!isFiniteNumber(windowToReadyMs)) {
    issues.push('readiness.windowToReadyMs is not a finite number');
  } else if (windowToReadyMs > thresholds.maxWindowToReadyMs) {
    issues.push(`window-to-readiness latency ${windowToReadyMs}ms exceeds ${thresholds.maxWindowToReadyMs}ms`);
  }

  const phases = report?.phases ?? {};
  const phaseChecks = [
    ['windowToFrontendMountMs', thresholds.maxWindowToFrontendMountMs],
    ['frontendMountToReadySignalMs', thresholds.maxFrontendBootstrapMs],
    ['readySignalToNativeLogMs', thresholds.maxReadySignalToNativeLogMs],
  ];
  for (const [phaseName, budget] of phaseChecks) {
    const value = phases[phaseName];
    if (!isFiniteNumber(value)) {
      issues.push(`phases.${phaseName} is not a finite number`);
    } else if (value > budget) {
      issues.push(`phases.${phaseName} ${value}ms exceeds ${budget}ms`);
    }
  }

  const steps = report?.readiness?.frontend?.steps ?? {};
  for (const [stepId, step] of Object.entries(steps)) {
    if (isFiniteNumber(step?.errorAtMs)) {
      issues.push(`bootstrap step '${stepId}' ended with error at ${step.errorAtMs}ms`);
    }
  }

  const stepDurations = report?.frontendStepDurationsMs ?? {};
  for (const [stepId, budget] of Object.entries(thresholds.frontendStepMs)) {
    const duration = stepDurations[stepId];
    if (!isFiniteNumber(duration)) {
      issues.push(`frontendStepDurationsMs['${stepId}'] is not a finite number`);
    } else if (duration > budget) {
      issues.push(`frontend step '${stepId}' duration ${duration}ms exceeds ${budget}ms`);
    }
  }

  return issues;
}

function latestReportPath(rootDir) {
  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const reportPath = path.join(rootDir, entry.name, 'report.json');
      return fs.existsSync(reportPath)
        ? { reportPath, mtimeMs: fs.statSync(reportPath).mtimeMs }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (entries.length === 0) {
    throw new Error(`No startup readiness report found under ${rootDir}`);
  }

  return entries[0].reportPath;
}

function parseArgs(argv) {
  const args = {
    input: null,
    root: path.resolve('artifacts/testing/startup-readiness'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      args.input = argv[++index];
    } else if (arg === '--root') {
      args.root = argv[++index];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input ? path.resolve(args.input) : latestReportPath(path.resolve(args.root));
  const report = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  const issues = collectStartupReadinessIssues(report);

  if (issues.length > 0) {
    console.error(`Startup readiness report failed: ${input}`);
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Startup readiness report passed: ${input}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
