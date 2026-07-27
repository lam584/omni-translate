import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../lib/testing-common.mjs';
import { prepareInstallRegressionReport } from './prepare-install-regression-report.mjs';
import { prepareManualE2eReport } from './prepare-manual-e2e-report.mjs';
import { preparePerformanceBaselineReport } from './prepare-performance-baseline.mjs';
import { buildAutoSteps } from './run-quality-gate-auto.mjs';
import {
  buildQualityGateSummary,
  testMarkdownManualReport,
  testPerformanceReport,
} from './run-quality-gate.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-test-'));

const passingMarkdown = [
  '# Desktop E2E Smoke Report',
  '',
  '- GeneratedAt: 2026-07-27T00:00:00',
  '- Operator: QA Robot',
  '- Build: 1.2.3',
  '',
  '## Scenario Checklist',
  '',
  '- [x] Save Provider config and secret reference successfully.',
  '- Result: ok',
  '',
  '## Final Verdict',
  '',
  '- [x] PASS',
  '- [ ] FAIL',
  '- Notes: all scenarios verified',
].join('\n');

const passingPerformancePayload = {
  generatedAt: '2026-07-27T00:00:00',
  operator: 'QA Robot',
  build: '1.2.3',
  verdict: 'PASS',
  measurements: {
    providerFirstEventLatencyMs: 800,
    subtitleCueCommitLatencyMs: 500,
    ttsRoundTripLatencyMs: 1500,
    cpuP95Percent: 40,
    memoryPeakMb: 600,
    observedDropouts: 0,
  },
};

const autoSummaryFixture = {
  generatedAt: '2026-07-27T00:00:00',
  workspaceRoot: 'E:/repo',
  automatedResults: [
    { name: 'contracts', command: 'npm run test:contracts', logPath: 'contracts.log', status: 'passed' },
    {
      name: 'integration-bridge-contract',
      command: 'npm run test:integration:bridge-contract',
      logPath: 'integration-bridge-contract.log',
      status: 'passed',
    },
  ],
};

test('testMarkdownManualReport accepts a fully completed report', () => {
  assert.deepEqual(testMarkdownManualReport(passingMarkdown), []);
});

test('testMarkdownManualReport flags TODO placeholders', () => {
  const content = passingMarkdown.replace('- Notes: all scenarios verified', '- Notes: TODO');
  assert.deepEqual(testMarkdownManualReport(content), ['contains TODO placeholders']);
});

test('testMarkdownManualReport flags unchecked checklist items', () => {
  const content = passingMarkdown.replace(
    '- [x] Save Provider config and secret reference successfully.',
    '- [ ] Save Provider config and secret reference successfully.',
  );
  assert.deepEqual(testMarkdownManualReport(content), ['contains unchecked checklist items']);
});

test('testMarkdownManualReport flags a selected FAIL verdict', () => {
  const content = passingMarkdown.replace('- [ ] FAIL', '- [x] FAIL');
  assert.deepEqual(testMarkdownManualReport(content), ['FAIL verdict is selected']);
});

test('testMarkdownManualReport flags an unselected PASS checkbox', () => {
  const content = passingMarkdown.replace('- [x] PASS', '- [ ] PASS');
  assert.deepEqual(testMarkdownManualReport(content), [
    'PASS checkbox is not selected',
    'missing selected PASS verdict',
    'contains unchecked checklist items',
  ]);
});

test('testMarkdownManualReport flags a missing operator', () => {
  const content = passingMarkdown.replace('- Operator: QA Robot', '- Operator:');
  assert.deepEqual(testMarkdownManualReport(content), ['operator is missing']);
});

test('testMarkdownManualReport flags a missing build', () => {
  const content = passingMarkdown.replace('- Build: 1.2.3', '- Build: ');
  assert.deepEqual(testMarkdownManualReport(content), ['build is missing']);
});

test('testPerformanceReport accepts a completed PASS payload', () => {
  assert.deepEqual(testPerformanceReport(passingPerformancePayload), []);
});

test('testPerformanceReport flags null measurements and a non-PASS verdict', () => {
  const payload = {
    ...passingPerformancePayload,
    operator: '',
    build: '   ',
    verdict: 'PENDING',
    measurements: { ...passingPerformancePayload.measurements, cpuP95Percent: null, observedDropouts: null },
  };
  assert.deepEqual(testPerformanceReport(payload), [
    'missing measurement: cpuP95Percent',
    'missing measurement: observedDropouts',
    'verdict is not PASS',
    'operator is missing',
    'build is missing',
  ]);
});

test('prepareManualE2eReport writes a stub the markdown validator rejects', () => {
  const dir = makeTempDir();
  try {
    const reportPath = prepareManualE2eReport({ outputRoot: dir });
    assert.ok(fs.existsSync(reportPath));
    assert.match(path.basename(reportPath), /^desktop-e2e-\d{8}-\d{6}\.md$/);
    const issues = testMarkdownManualReport(fs.readFileSync(reportPath, 'utf8'));
    assert.ok(issues.length > 0);
    assert.ok(issues.includes('contains TODO placeholders'));
    assert.ok(issues.includes('missing selected PASS verdict'));
    assert.ok(issues.includes('contains unchecked checklist items'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareInstallRegressionReport writes a stub the markdown validator rejects', () => {
  const dir = makeTempDir();
  try {
    const reportPath = prepareInstallRegressionReport({ outputRoot: dir });
    assert.ok(fs.existsSync(reportPath));
    assert.match(path.basename(reportPath), /^install-regression-\d{8}-\d{6}\.md$/);
    const issues = testMarkdownManualReport(fs.readFileSync(reportPath, 'utf8'));
    assert.ok(issues.length > 0);
    assert.ok(issues.includes('PASS checkbox is not selected'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preparePerformanceBaselineReport writes a stub the performance validator rejects', () => {
  const dir = makeTempDir();
  try {
    const reportPath = preparePerformanceBaselineReport({ outputRoot: dir });
    assert.ok(fs.existsSync(reportPath));
    assert.match(path.basename(reportPath), /^desktop-perf-baseline-\d{8}-\d{6}\.json$/);
    const payload = readJson(reportPath);
    assert.equal(payload.verdict, 'PENDING');
    assert.deepEqual(Object.keys(payload.measurements), [
      'providerFirstEventLatencyMs',
      'subtitleCueCommitLatencyMs',
      'ttsRoundTripLatencyMs',
      'cpuP95Percent',
      'memoryPeakMb',
      'observedDropouts',
    ]);
    const issues = testPerformanceReport(payload);
    assert.ok(issues.length > 0);
    assert.ok(issues.includes('verdict is not PASS'));
    assert.ok(issues.includes('operator is missing'));
    assert.ok(issues.includes('missing measurement: providerFirstEventLatencyMs'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildQualityGateSummary marks artifacts with issues as pending', () => {
  const summary = buildQualityGateSummary({
    autoSummary: autoSummaryFixture,
    workspaceRoot: 'E:/repo',
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
    e2eIssues: ['contains TODO placeholders'],
    performanceIssues: [],
    installIssues: [],
    generatedAt: '2026-07-27T00:00:01',
  });
  assert.equal(summary.manualVerificationStatus, 'pending');
  assert.equal(summary.generatedAt, '2026-07-27T00:00:01');
  assert.equal(summary.workspaceRoot, 'E:/repo');
  assert.equal(summary.automatedResults, autoSummaryFixture.automatedResults);
  assert.deepEqual(summary.automatedIntegration, {
    name: 'integration-bridge-contract',
    status: 'passed',
    logPath: 'integration-bridge-contract.log',
    coveredManualScenarios: ['subtitle-display', 'locked-overlay-click-through', 'tts-counters'],
  });
  assert.deepEqual(summary.manualArtifacts, {
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
  });
  assert.deepEqual(summary.manualArtifactResults, [
    { name: 'manual-e2e', path: 'e2e.md', status: 'pending', issues: ['contains TODO placeholders'] },
    { name: 'performance-baseline', path: 'perf.json', status: 'passed', issues: [] },
    { name: 'install-regression', path: 'install.md', status: 'passed', issues: [] },
  ]);
});

test('buildQualityGateSummary reports passed when every artifact is clean', () => {
  const summary = buildQualityGateSummary({
    autoSummary: autoSummaryFixture,
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
    e2eIssues: [],
    performanceIssues: [],
    installIssues: [],
  });
  assert.equal(summary.manualVerificationStatus, 'passed');
  assert.deepEqual(summary.manualArtifactResults.map((artifact) => artifact.status), [
    'passed',
    'passed',
    'passed',
  ]);
});

test('buildQualityGateSummary throws when the integration step is missing', () => {
  assert.throws(
    () => buildQualityGateSummary({
      autoSummary: { automatedResults: [{ name: 'contracts', status: 'passed', logPath: 'x' }] },
      e2eReport: 'e2e.md',
      performanceBaseline: 'perf.json',
      installRegression: 'install.md',
      e2eIssues: [],
      performanceIssues: [],
      installIssues: [],
    }),
    /integration-bridge-contract' is missing/,
  );
});

test('buildAutoSteps honors the skip switches', () => {
  assert.deepEqual(buildAutoSteps().map((step) => step.name), [
    'audit-architecture',
    'audit-error-handling',
    'verify-desktop',
    'contracts',
    'integration-bridge-contract',
    'coverage-all',
    'check-desktop-shell',
    'test-desktop-shell',
    'check-bridge-service-native',
    'test-bridge-service-native',
  ]);
  assert.deepEqual(
    buildAutoSteps({ skipDesktopShell: true, skipBridgeService: true }).map((step) => step.name),
    ['audit-architecture', 'audit-error-handling', 'verify-desktop', 'contracts', 'integration-bridge-contract', 'coverage-all'],
  );
});
