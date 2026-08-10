import {
  isMain,
  repoRoot,
  runPrepareReportCli,
  writeJson,
  writeTimestampedReport,
} from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  PERFORMANCE_MEASUREMENT_NAMES,
  PERFORMANCE_THRESHOLDS,
  RELEASE_MANUAL_SCHEMA_VERSION,
} from './release-manual-evidence.mjs';

const defaultOutputRoot = 'artifacts/testing/perf-baseline';

const baselinePayload = (generatedAt, provenance) => ({
  schemaVersion: RELEASE_MANUAL_SCHEMA_VERSION,
  artifactKind: 'performance-baseline',
  generatedAt,
  operator: '',
  build: provenance.headCommit ?? '',
  verdict: 'PENDING',
  provenance,
  environment: 'Windows desktop shell',
  scenario: 'Provider probe + subtitle display + speech dispatch + diagnostics export',
  thresholds: { ...PERFORMANCE_THRESHOLDS },
  measurements: Object.fromEntries(PERFORMANCE_MEASUREMENT_NAMES.map((name) => [name, null])),
  sourceEvidence: {
    receiptPath: '',
    receiptSha256: '',
  },
  notes: [
    'This file is a pending schema template, not a fill-in-the-numbers release artifact.',
    'Create the release baseline with assemble-performance-baseline.mjs on the same exact clean HEAD as the canonical strict Watch matrix.',
    'The assembler archives all 18 report.json and system-metrics.json files; the validator independently recomputes every aggregate from those raw artifacts.',
    'Hand-written measurements, a standalone performance-source.json, missing system samples, or rehashed edited aggregates cannot pass.',
  ],
});

export const preparePerformanceBaselineReport = ({ outputRoot = defaultOutputRoot } = {}) =>
  writeTimestampedReport({
    outputRoot,
    filePrefix: 'desktop-perf-baseline',
    extension: 'json',
    render: (reportPath, generatedAt) => writeJson(
      reportPath,
      baselinePayload(generatedAt, currentGitProvenance({ cwd: repoRoot })),
    ),
  });

if (isMain(import.meta.url)) {
  runPrepareReportCli(preparePerformanceBaselineReport, { outputRoot: defaultOutputRoot });
}
