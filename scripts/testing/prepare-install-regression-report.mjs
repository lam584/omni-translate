import path from 'node:path';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  repoRoot,
  sortableTimestamp,
  writeText,
} from '../lib/testing-common.mjs';

const defaultOutputRoot = 'artifacts/testing/install-regression';

const reportLines = (generatedAt) => [
  '# Install Regression Report',
  '',
  `- GeneratedAt: ${generatedAt}`,
  '- Operator: TODO',
  '- Build: TODO',
  '- RuntimeRoot: ./artifacts/diagnostics/logs',
  '',
  '## Checklist',
  '',
  '1. Fresh install',
  '- [ ] Run npm run driver:install.',
  '- [ ] Confirm driver-install-state.json is updated.',
  '',
  '2. Repair',
  '- [ ] Run npm run driver:repair.',
  '- [ ] Confirm Bridge handshake can recover.',
  '',
  '3. Uninstall',
  '- [ ] Run npm run driver:uninstall.',
  '- [ ] Confirm runtime state returns to not-installed.',
  '',
  '4. Upgrade overwrite',
  '- [ ] Re-run npm run driver:install over an existing runtime root.',
  '- [ ] Confirm old backups are bounded and latest version is active.',
  '',
  '5. Release layout',
  '- [ ] Run npm run installer:prepare.',
  '- [ ] Confirm artifacts/installer/<version> contains bridge-service-native/omni-bridge-service.exe, bridge-service-native/omni-driver-audio-probe.exe, scripts, and driver assets.',
  '',
  '## Final Verdict',
  '',
  '- [ ] PASS',
  '- [ ] FAIL',
  '- Notes:',
];

export const prepareInstallRegressionReport = ({ outputRoot = defaultOutputRoot } = {}) => {
  const targetDir = ensureDir(path.resolve(repoRoot, outputRoot));
  const reportPath = path.join(targetDir, `install-regression-${compactTimestamp()}.md`);
  writeText(reportPath, reportLines(sortableTimestamp()).join('\n'));
  return reportPath;
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { outputRoot: defaultOutputRoot } });
    console.log(prepareInstallRegressionReport(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
