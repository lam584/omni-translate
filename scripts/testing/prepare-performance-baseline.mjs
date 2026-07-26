import path from 'node:path';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  repoRoot,
  sortableTimestamp,
  writeJson,
} from '../lib/testing-common.mjs';

const defaultOutputRoot = 'artifacts/testing/perf-baseline';

const baselinePayload = (generatedAt) => ({
  generatedAt,
  operator: '',
  build: '',
  verdict: 'PENDING',
  environment: 'Windows desktop shell',
  scenario: 'Provider probe + subtitle display + speech dispatch + diagnostics export',
  thresholds: {
    providerFirstEventLatencyMs: 1200,
    subtitleCueCommitLatencyMs: 800,
    ttsRoundTripLatencyMs: 2200,
    cpuP95Percent: 65,
    memoryPeakMb: 900,
    stabilityWindowMinutes: 30,
    allowedDropouts: 0,
  },
  measurements: {
    providerFirstEventLatencyMs: null,
    subtitleCueCommitLatencyMs: null,
    ttsRoundTripLatencyMs: null,
    cpuP95Percent: null,
    memoryPeakMb: null,
    observedDropouts: null,
  },
  notes: [
    'Fill measurements after running the Milestone M smoke path in the desktop shell.',
    'CPU should be recorded as sample P95 and memory should use peak working set or minimum available ratio.',
  ],
});

export const preparePerformanceBaselineReport = ({ outputRoot = defaultOutputRoot } = {}) => {
  const targetDir = ensureDir(path.resolve(repoRoot, outputRoot));
  const reportPath = path.join(targetDir, `desktop-perf-baseline-${compactTimestamp()}.json`);
  writeJson(reportPath, baselinePayload(sortableTimestamp()));
  return reportPath;
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { outputRoot: defaultOutputRoot } });
    console.log(preparePerformanceBaselineReport(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
