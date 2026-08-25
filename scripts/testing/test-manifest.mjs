export const coreTestSteps = [
  { name: 'workspace-tests', command: 'npm test --workspaces --if-present' },
  { name: 'desktop-shell-tests', command: 'npm run test:desktop-shell' },
  { name: 'benchmark-core-tests', command: 'npm run test:benchmark-core' },
  { name: 'diagnostics-benchmark-tests', command: 'npm run test:diagnostics-benchmark' },
  { name: 'bridge-service-native-tests', command: 'npm run test:bridge-service-native' },
  { name: 'contracts', command: 'npm run test:contracts' },
  { name: 'config-paths', command: 'npm run test:config-paths' },
  { name: 'integration-bridge-contract', command: 'npm run test:integration:bridge-contract' },
  { name: 'driver-boundaries', command: 'npm run test:driver-boundaries' },
  { name: 'watch-mode-tooling', command: 'npm run test:watch-mode-report' },
  { name: 'release-tooling', command: 'npm run test:release-lib' },
  { name: 'quality-gate-tooling', command: 'npm run test:quality-gate-tooling' },
  { name: 'startup-tooling', command: 'npm run test:startup-readiness' },
  { name: 'powershell-tooling', command: 'npm run test:powershell-tooling' },
];

export const automatedGateSteps = [
  { name: 'audit-architecture', command: 'npm run audit:architecture' },
  { name: 'audit-powershell-boundaries', command: 'npm run audit:powershell-boundaries' },
  { name: 'audit-dead-code', command: 'npm run audit:dead-code' },
  { name: 'audit-error-handling', command: 'npm run audit:error-handling' },
  { name: 'audit-rust-warnings', command: 'npm run audit:rust-warnings' },
  { name: 'i18n-ratchet', command: 'npm run i18n:coverage:ratchet' },
  { name: 'verify-desktop', command: 'npm run verify:desktop' },
  ...coreTestSteps.filter(({ name }) => !['workspace-tests', 'desktop-shell-tests', 'bridge-service-native-tests'].includes(name)),
  { name: 'coverage-base', command: 'npm run coverage:gate:base' },
];

export function selectAutomatedGateSteps({ skipDesktopShell = false, skipBridgeService = false } = {}) {
  const steps = [...automatedGateSteps];
  if (!skipDesktopShell) {
    steps.push({ name: 'check-desktop-shell', command: 'npm run check:desktop-shell' });
    steps.push({ name: 'test-desktop-shell', command: 'npm run test:desktop-shell' });
  }
  if (!skipBridgeService) {
    steps.push({ name: 'check-bridge-service-native', command: 'npm run check:bridge-service-native' });
    steps.push({ name: 'test-bridge-service-native', command: 'npm run test:bridge-service-native' });
  }
  return steps;
}
