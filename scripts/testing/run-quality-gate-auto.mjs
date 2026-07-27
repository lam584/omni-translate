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

const defaultOutputRoot = 'artifacts/logs/testing/quality-gate-auto';

export const buildAutoSteps = ({ skipDesktopShell = false, skipBridgeService = false } = {}) => {
  const steps = [
    { name: 'audit-architecture', command: 'npm run audit:architecture' },
    { name: 'audit-error-handling', command: 'npm run audit:error-handling' },
    { name: 'verify-desktop', command: 'npm run verify:desktop' },
    { name: 'contracts', command: 'npm run test:contracts' },
    { name: 'integration-bridge-contract', command: 'npm run test:integration:bridge-contract' },
    { name: 'coverage-all', command: 'npm run coverage:gate' },
  ];
  if (!skipDesktopShell) {
    steps.push({ name: 'check-desktop-shell', command: 'npm run check:desktop-shell' });
    steps.push({ name: 'test-desktop-shell', command: 'npm run test:desktop-shell' });
  }
  if (!skipBridgeService) {
    steps.push({ name: 'check-bridge-service-native', command: 'npm run check:bridge-service-native' });
    steps.push({ name: 'test-bridge-service-native', command: 'npm run test:bridge-service-native' });
  }
  return steps;
};

export const runQualityGateAuto = ({
  outputRoot = defaultOutputRoot,
  skipDesktopShell = false,
  skipBridgeService = false,
} = {}) => {
  const targetDir = ensureDir(path.resolve(repoRoot, outputRoot, compactTimestamp()));

  const results = [];
  for (const step of buildAutoSteps({ skipDesktopShell, skipBridgeService })) {
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
