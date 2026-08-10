import type { BenchmarkHistorySummary } from './benchmarkHistory';
import { parseRuntimeTimestampMs } from '../../utils/runtime-timestamp';

export function formatHistoryTime(value: string): string {
  const timestampMs = parseRuntimeTimestampMs(value);
  const date = timestampMs == null ? null : new Date(timestampMs);
  return date == null || Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function historyScore(record: BenchmarkHistorySummary): string {
  return record.totalScore == null ? '—' : `${record.totalScore.toFixed(1)} ${record.grade ?? ''}`.trim();
}
