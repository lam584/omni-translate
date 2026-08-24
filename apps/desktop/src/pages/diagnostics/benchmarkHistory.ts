import type { BenchmarkReport } from '../../runtime/benchmark-runtime';
import type { BenchmarkHistorySavePayload } from '../../runtime/desktop-api-v2';
import type {
  BenchmarkHistoryClearResult as NativeBenchmarkHistoryClearResult,
  BenchmarkHistoryDeleteResult as NativeBenchmarkHistoryDeleteResult,
  BenchmarkHistoryPage as NativeBenchmarkHistoryPage,
  BenchmarkHistoryRecord as NativeBenchmarkHistoryRecord,
} from '../../schema/generated/runtime-core';
import type { BenchmarkResultScore } from './benchmarkReportScore';

export type BenchmarkStoredScore = BenchmarkResultScore;

/**
 * Persisted, versioned benchmark result. The native diagnostics boundary owns
 * storage; this module deliberately contains no browser-storage fallback so
 * users never mistake a preview-only record for durable benchmark history.
 */
export type BenchmarkRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type BenchmarkScoreStatus =
  | 'pending'
  | 'judging'
  | 'final'
  | 'evidence-insufficient'
  | 'judge-failed'
  | 'benchmark-failed';

export type BenchmarkHistorySummary = {
  recordId: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  runStatus: BenchmarkRunStatus;
  scoreStatus: BenchmarkScoreStatus;
  scoreVersion: string | null;
  totalScore: number | null;
  grade: string | null;
  error: string | null;
};

export type BenchmarkHistoryRecord = BenchmarkHistorySummary & {
  report: BenchmarkReport | null;
  score: unknown | null;
};

export type BenchmarkHistoryPage = {
  records: BenchmarkHistorySummary[];
  page: number;
  pageSize: number;
  totalCount: number;
};

export type BenchmarkHistorySaveInput = BenchmarkHistorySavePayload & {
  report?: BenchmarkReport | null;
};

export type BenchmarkHistoryApi = {
  listBenchmarkHistory: (page?: number, pageSize?: number) => Promise<BenchmarkHistoryPage>;
  getBenchmarkHistory: (recordId: string) => Promise<BenchmarkHistoryRecord>;
  saveBenchmarkHistory: (record: BenchmarkHistorySaveInput) => Promise<BenchmarkHistoryRecord>;
  deleteBenchmarkHistory: (recordId: string) => Promise<{ deleted: boolean }>;
  clearBenchmarkHistory: () => Promise<{ deletedCount: number }>;
};

function isBenchmarkReport(value: unknown): value is BenchmarkReport {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { runs?: unknown }).runs));
}

/** Decodes the native JSON payload at the renderer boundary. */
export function benchmarkHistoryRecordFromNative(record: NativeBenchmarkHistoryRecord): BenchmarkHistoryRecord {
  return {
    ...record,
    runStatus: record.runStatus as BenchmarkRunStatus,
    scoreStatus: record.scoreStatus as BenchmarkScoreStatus,
    report: isBenchmarkReport(record.report) ? record.report : null,
  };
}

export function benchmarkHistoryPageFromNative(page: NativeBenchmarkHistoryPage): BenchmarkHistoryPage {
  return {
    ...page,
    records: page.records.map((record) => ({
      ...record,
      runStatus: record.runStatus as BenchmarkRunStatus,
      scoreStatus: record.scoreStatus as BenchmarkScoreStatus,
    })),
  };
}

export function benchmarkScoreFromHistory(value: unknown): BenchmarkStoredScore | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<BenchmarkStoredScore>;
  const supported = candidate.schemaVersion === 'benchmark-score/v1'
    || candidate.schemaVersion === 'benchmark-score/v2';
  return supported
    && candidate.version === candidate.schemaVersion
    && candidate.dimensions != null
    ? candidate as BenchmarkStoredScore
    : null;
}

export function historyScoreStatus(score: BenchmarkStoredScore): BenchmarkScoreStatus {
  switch (score.status) {
    case 'official': return 'final';
    case 'judging': return 'judging';
    case 'benchmark-running': return 'pending';
    case 'judge-failed': return 'judge-failed';
    case 'benchmark-failed': return 'benchmark-failed';
    case 'evidence-insufficient': return 'evidence-insufficient';
  }
}

export const benchmarkHistoryDeleteResultFromNative = (result: NativeBenchmarkHistoryDeleteResult) => result;
export const benchmarkHistoryClearResultFromNative = (result: NativeBenchmarkHistoryClearResult) => result;

export function benchmarkHistorySaveInput(
  input: BenchmarkHistorySaveInput,
): BenchmarkHistorySaveInput {
  // Keep the only schema boundary small and explicit. The native side applies
  // a recursive secret-key redaction as defense in depth before persistence.
  return {
    ...input,
    scoreVersion: input.scoreVersion ?? 'benchmark-score/v2',
    totalScore: input.totalScore ?? null,
    grade: input.grade ?? null,
    report: input.report ?? null,
    score: input.score ?? null,
    error: input.error ?? null,
  };
}

export function groupBenchmarkHistoryByScoreVersion(
  records: readonly BenchmarkHistorySummary[],
): Array<{ scoreVersion: string | null; records: BenchmarkHistorySummary[] }> {
  const grouped = new Map<string | null, BenchmarkHistorySummary[]>();
  for (const record of records) {
    const group = grouped.get(record.scoreVersion) ?? [];
    group.push(record);
    grouped.set(record.scoreVersion, group);
  }
  const rank = (version: string | null) => version === 'benchmark-score/v2' ? 0 : version === 'benchmark-score/v1' ? 1 : 2;
  return [...grouped.entries()]
    .sort(([left], [right]) => rank(left) - rank(right) || String(left).localeCompare(String(right)))
    .map(([scoreVersion, groupRecords]) => ({ scoreVersion, records: groupRecords }));
}

export function isFinalBenchmarkHistoryRecord(record: BenchmarkHistorySummary): boolean {
  return record.runStatus === 'completed' && record.scoreStatus === 'final' && record.totalScore != null;
}
