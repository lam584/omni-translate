import path from 'node:path';

import {
  compactTimestamp,
  echoLogTail,
  ensureDir,
  isMain,
  parseCliArgs,
  repoRoot,
  runLoggedStep,
  sortableTimestamp,
  writeJson,
} from '../lib/testing-common.mjs';
import { selectAutomatedGateSteps } from './test-manifest.mjs';
import { loadReusableTestReceipt } from './watch-mode-test-receipts.mjs';

const defaultOutputRoot = 'artifacts/logs/testing/quality-gate-auto';

export const buildAutoSteps = ({ skipDesktopShell = false, skipBridgeService = false } = {}) => {
  return selectAutomatedGateSteps({ skipDesktopShell, skipBridgeService });
};

export const runQualityGateAuto = ({
  outputRoot = defaultOutputRoot,
  skipDesktopShell = false,
  skipBridgeService = false,
} = {}) => {
  const targetDir = ensureDir(path.resolve(repoRoot, outputRoot, compactTimestamp()));

  const results = [];
  for (const step of buildAutoSteps({ skipDesktopShell, skipBridgeService })) {
    const reusable = loadReusableTestReceipt(step);
    if (reusable) {
      console.error(`>>> ${step.name}: verified clean-HEAD receipt ${reusable.receiptPath}`);
      results.push({
        name: step.name,
        command: step.command,
        logPath: path.join(path.dirname(reusable.receiptPath), reusable.receipt.log.path),
        status: 'passed',
        reusedReceipt: reusable.receiptPath,
      });
      continue;
    }
    const logPath = path.join(targetDir, `${step.name}.log`);
    console.error(`>>> ${step.name}: ${step.command}`);
    const exitCode = runLoggedStep(step.command, logPath, { cwd: repoRoot });
    echoLogTail(logPath, 40);
    if (exitCode !== 0) {
      throw new Error(`Quality gate (auto) step failed: ${step.name}`);
    }
    results.push({ name: step.name, command: step.command, logPath, status: 'passed' });
  }

  const summaryPath = path.join(targetDir, 'quality-gate-auto-summary.json');
  writeJson(summaryPath, {
    generatedAt: sortableTimestamp(),
    workspaceRoot: repoRoot,
    // Audit trail: record which automated suites were skipped for this run.
    degradation: { skipDesktopShell, skipBridgeService },
    automatedResults: results,
  });
  return summaryPath;
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), {
      booleans: ['skip-desktop-shell', 'skip-bridge-service'],
      defaults: { outputRoot: defaultOutputRoot },
    });
    console.log(runQualityGateAuto(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
