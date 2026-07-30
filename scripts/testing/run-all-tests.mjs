import { isMain, parseCliArgs, repoRoot, runCommand } from '../lib/testing-common.mjs';
import { coreTestSteps } from './test-manifest.mjs';

export const buildSteps = ({ skipIntegration = false } = {}) => {
  const steps = [...coreTestSteps];
  if (!skipIntegration) {
    steps.push({ name: 'llm-audio-integration', command: 'npm run test:llm-integration' });
  }
  return steps;
};

export const runAllTests = ({ skipIntegration = false } = {}) => {
  for (const step of buildSteps({ skipIntegration })) {
    console.error(`>>> ${step.name}: ${step.command}`);
    const exitCode = runCommand(step.command, { cwd: repoRoot });
    if (exitCode !== 0) {
      throw new Error(`Test step failed: ${step.name}`);
    }
  }
  console.error('All requested tests passed.');
};

if (isMain(import.meta.url)) {
  try {
    runAllTests(parseCliArgs(process.argv.slice(2), { booleans: ['skip-integration'] }));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
