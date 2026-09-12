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

export function executeQualityGateStep(step, {
  targetDir, receiptLoader = loadReusableTestReceipt, execute = runLoggedStep,
  echo = echoLogTail, now = () => Date.now(),
} = {}) {
  const startedMs = now();
  const timing = () => {
    const completedMs = now();
    return { startedAt: new Date(startedMs).toISOString(), completedAt: new Date(completedMs).toISOString(), durationMs: Math.max(0, completedMs - startedMs) };
  };
  const logPath = path.join(targetDir, step.name + '.log');
  let phase = 'receipt-verification';
  let exitCode;
  try {
    const reusable = receiptLoader(step);
    if (reusable) {
      return { name: step.name, command: step.command,
        logPath: path.join(path.dirname(reusable.receiptPath), reusable.receipt.log.path),
        status: 'passed', reusedReceipt: reusable.receiptPath, validationMode: 'signed-receipt',
        sourceExecutionDurationMs: Date.parse(reusable.receipt.completedAt) - Date.parse(reusable.receipt.startedAt), ...timing() };
    }
    phase = 'execution';
    exitCode = execute(step.command, logPath, { cwd: repoRoot });
    phase = 'log-tail';
    echo(logPath, 40);
    return { name: step.name, command: step.command, logPath, exitCode,
      status: exitCode === 0 ? 'passed' : 'failed', validationMode: 'executed', ...timing() };
  } catch (cause) {
    const message = cause?.message ?? String(cause);
    const error = new Error(message, { cause });
    error.qualityGateStepResult = { name: step.name, command: step.command, logPath,
      ...(exitCode === undefined ? {} : { exitCode }), status: 'failed',
      validationMode: phase === 'receipt-verification' ? 'receipt-check' : 'executed',
      failure: { message, phase }, ...timing() };
    throw error;
  }
}

export const runQualityGateAuto = ({
  outputRoot = defaultOutputRoot,
  skipDesktopShell = false,
  skipBridgeService = false,
  operations = {}, // Trusted test seams, never populated from CLI arguments.
} = {}) => {
  const targetDir = ensureDir(path.resolve(repoRoot, outputRoot, compactTimestamp()));
  const startedMs = Date.now();
  const results = [];
  const summaryPath = path.join(targetDir, 'quality-gate-auto-summary.json');
  let failure = null;
  try {
    for (const step of operations.steps ?? buildAutoSteps({ skipDesktopShell, skipBridgeService })) {
      console.error('>>> ' + step.name + ': ' + step.command);
      const result = (operations.executeStep ?? executeQualityGateStep)(step, { targetDir });
      results.push(result);
      if (result.reusedReceipt) console.error('>>> verified signed receipt ' + result.reusedReceipt);
      if (result.status !== 'passed') throw new Error('Quality gate (auto) step failed: ' + step.name);
    }
  } catch (error) {
    if (error.qualityGateStepResult) results.push(error.qualityGateStepResult);
    failure = { message: error.message, classification: 'unclassified',
      failedStep: results.at(-1)?.status === 'failed' ? results.at(-1).name : null };
    throw error;
  } finally {
    writeJson(summaryPath, {
      generatedAt: sortableTimestamp(), workspaceRoot: repoRoot,
      startedAt: new Date(startedMs).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
      degradation: { skipDesktopShell, skipBridgeService },
      status: failure ? 'failed' : 'passed', failure, automatedResults: results,
      executedSteps: results.filter((r) => r.validationMode === 'executed').length,
      reusedSteps: results.filter((r) => r.validationMode === 'signed-receipt').length,
    });
  }
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
