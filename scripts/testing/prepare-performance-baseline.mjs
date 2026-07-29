import {
  isMain,
  runPrepareReportCli,
  writeJson,
  writeTimestampedReport,
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

export const preparePerformanceBaselineReport = ({ outputRoot = defaultOutputRoot } = {}) =>
  writeTimestampedReport({
    outputRoot,
    filePrefix: 'desktop-perf-baseline',
    extension: 'json',
    render: (reportPath, generatedAt) => writeJson(reportPath, baselinePayload(generatedAt)),
  });

if (isMain(import.meta.url)) {
  runPrepareReportCli(preparePerformanceBaselineReport, { outputRoot: defaultOutputRoot });
}
