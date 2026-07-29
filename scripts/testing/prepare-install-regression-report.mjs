import {
  isMain,
  runPrepareReportCli,
  writeText,
  writeTimestampedReport,
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

export const prepareInstallRegressionReport = ({ outputRoot = defaultOutputRoot } = {}) =>
  writeTimestampedReport({
    outputRoot,
    filePrefix: 'install-regression',
    extension: 'md',
    render: (reportPath, generatedAt) => writeText(reportPath, reportLines(generatedAt).join('\n')),
  });

if (isMain(import.meta.url)) {
  runPrepareReportCli(prepareInstallRegressionReport, { outputRoot: defaultOutputRoot });
}
