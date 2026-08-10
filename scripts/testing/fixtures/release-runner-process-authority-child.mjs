import { repoRoot } from '../../lib/testing-common.mjs';
import { testOnlyValidateReleaseRunnerProcessAuthority } from '../release-manual-collector.mjs';

const runner = 'scripts/testing/fixtures/release-runner-process-authority-child.mjs';

try {
  const authority = testOnlyValidateReleaseRunnerProcessAuthority({
    runner,
    workspaceRoot: repoRoot,
    testOnlyUseProductionProcessAuthority: true,
  });
  process.stdout.write(`${JSON.stringify(authority)}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
