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
import { prepareInstallRegressionReport } from './prepare-install-regression-report.mjs';
import { prepareManualE2eReport } from './prepare-manual-e2e-report.mjs';
import { preparePerformanceBaselineReport } from './prepare-performance-baseline.mjs';
import { runQualityGateAuto } from './run-quality-gate-auto.mjs';

const defaultOutputRoot = 'artifacts/logs/testing/quality-gate';

const isBlank = (value) => value == null || String(value).trim() === '';

const readReportText = (reportPath) => fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, '');

const resolveExistingPath = (candidate) => {
  const resolved = path.resolve(repoRoot, candidate);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cannot find path '${resolved}' because it does not exist.`);
  }
  return resolved;
};

export const testMarkdownManualReport = (content) => {
  const issues = [];
  if (/TODO/.test(content)) issues.push('contains TODO placeholders');
  if (/^- Operator:\s*$/m.test(content)) issues.push('operator is missing');
  if (/^- Build:\s*$/m.test(content)) issues.push('build is missing');
  if (/^- \[ \] PASS$/m.test(content)) issues.push('PASS checkbox is not selected');
  if (!/^- \[[xX]\] PASS$/m.test(content)) issues.push('missing selected PASS verdict');
  if (/^- \[[xX]\] FAIL$/m.test(content)) issues.push('FAIL verdict is selected');
  if (/^- \[ \] (?!FAIL$).+/m.test(content)) issues.push('contains unchecked checklist items');
  return issues;
};

export const testPerformanceReport = (payload) => {
  const issues = [];
  for (const [name, value] of Object.entries(payload?.measurements ?? {})) {
    if (value == null) issues.push(`missing measurement: ${name}`);
  }
  if (payload?.verdict !== 'PASS') issues.push('verdict is not PASS');
  if (isBlank(payload?.operator)) issues.push('operator is missing');
  if (isBlank(payload?.build)) issues.push('build is missing');
  return issues;
};

export const buildQualityGateSummary = ({
  autoSummary,
  workspaceRoot = repoRoot,
  e2eReport,
  performanceBaseline,
  installRegression,
  e2eIssues,
  performanceIssues,
  installIssues,
  allowPendingManual = false,
  generatedAt = sortableTimestamp(),
}) => {
  const manualArtifactResults = [
    { name: 'manual-e2e', path: e2eReport, status: 'passed', issues: [...e2eIssues] },
    { name: 'performance-baseline', path: performanceBaseline, status: 'passed', issues: [...performanceIssues] },
    { name: 'install-regression', path: installRegression, status: 'passed', issues: [...installIssues] },
  ];
  for (const artifact of manualArtifactResults) {
    if (artifact.issues.length > 0) {
      artifact.status = 'pending';
    }
  }
  const manualVerificationStatus =
    manualArtifactResults.some((artifact) => artifact.status !== 'passed') ? 'pending' : 'passed';

  const automatedIntegration = (autoSummary.automatedResults ?? [])
    .filter((result) => result.name === 'integration-bridge-contract');
  if (automatedIntegration.length === 0) {
    throw new Error(
      "Automated integration step 'integration-bridge-contract' is missing from the automated quality gate results.",
    );
  }

  // Audit trail: make every degradation lever of this run explicit in the
  // summary, so an exit-0 run with skipped suites or pending manual reports
  // stays reviewable. Does not affect step selection or the exit code.
  const autoDegradation = autoSummary.degradation ?? {};
  const degradation = {
    allowPendingManual,
    skipDesktopShell: autoDegradation.skipDesktopShell ?? false,
    skipBridgeService: autoDegradation.skipBridgeService ?? false,
    manualArtifactStatuses: Object.fromEntries(
      manualArtifactResults.map((artifact) => [artifact.name, artifact.status]),
    ),
    degradedPass:
      (autoDegradation.skipDesktopShell ?? false) ||
      (autoDegradation.skipBridgeService ?? false) ||
      (allowPendingManual && manualVerificationStatus !== 'passed'),
  };

  return {
    generatedAt,
    workspaceRoot,
    automatedResults: autoSummary.automatedResults,
    automatedIntegration: {
      name: 'integration-bridge-contract',
      status: automatedIntegration[0].status,
      logPath: automatedIntegration[0].logPath,
      coveredManualScenarios: ['subtitle-display', 'locked-overlay-click-through', 'tts-counters'],
    },
    manualVerificationStatus,
    degradation,
    manualArtifacts: {
      e2eReport,
      performanceBaseline,
      installRegression,
    },
    manualArtifactResults,
  };
};

export const runQualityGate = ({
  outputRoot = defaultOutputRoot,
  manualE2eReport = '',
  performanceBaselineReport = '',
  installRegressionReport = '',
  allowPendingManual = false,
} = {}) => {
  const autoSummaryPath = runQualityGateAuto({ outputRoot });
  if (isBlank(autoSummaryPath) || !fs.existsSync(autoSummaryPath)) {
    throw new Error(`Automated quality gate did not emit a usable summary path. Captured output: ${autoSummaryPath}`);
  }

  const autoSummary = readJson(autoSummaryPath);
  const timestamp = path.basename(path.dirname(autoSummaryPath));
  const manualRoot = path.join(outputRoot, timestamp);

  const e2eReport = isBlank(manualE2eReport)
    ? prepareManualE2eReport({ outputRoot: path.join(manualRoot, 'manual-e2e') })
    : resolveExistingPath(manualE2eReport);
  const performanceBaseline = isBlank(performanceBaselineReport)
    ? preparePerformanceBaselineReport({ outputRoot: path.join(manualRoot, 'perf-baseline') })
    : resolveExistingPath(performanceBaselineReport);
  const installRegression = isBlank(installRegressionReport)
    ? prepareInstallRegressionReport({ outputRoot: path.join(manualRoot, 'install-regression') })
    : resolveExistingPath(installRegressionReport);

  const summary = buildQualityGateSummary({
    autoSummary,
    e2eReport,
    performanceBaseline,
    installRegression,
    e2eIssues: testMarkdownManualReport(readReportText(e2eReport)),
    performanceIssues: testPerformanceReport(readJson(performanceBaseline)),
    installIssues: testMarkdownManualReport(readReportText(installRegression)),
    allowPendingManual,
  });

  const summaryPath = path.join(path.dirname(autoSummaryPath), 'quality-gate-summary.json');
  writeJson(summaryPath, summary);
  return { summaryPath, manualVerificationStatus: summary.manualVerificationStatus, summary };
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), {
      booleans: ['allow-pending-manual'],
      defaults: {
        outputRoot: defaultOutputRoot,
        manualE2eReport: '',
        performanceBaselineReport: '',
        installRegressionReport: '',
      },
    });
    const { summaryPath, manualVerificationStatus } = runQualityGate(args);
    console.log(summaryPath);
    if (manualVerificationStatus !== 'passed' && !args.allowPendingManual) {
      console.error(
        `Manual verification is pending. Fill operator/build/verdict and mark every manual checklist PASS before treating quality:gate as passed. Summary: ${summaryPath}`,
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
