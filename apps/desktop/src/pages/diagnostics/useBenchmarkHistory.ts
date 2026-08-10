import { useCallback, useEffect, useState } from 'react';
import { useDesktopApiV2 } from '../../runtime/desktop-api-context';
import {
  benchmarkHistoryPageFromNative,
  benchmarkHistoryRecordFromNative,
  benchmarkHistorySaveInput,
  type BenchmarkHistoryPage,
  type BenchmarkHistoryRecord,
  type BenchmarkHistorySaveInput,
  type BenchmarkHistorySummary,
} from './benchmarkHistory';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSummary(record: BenchmarkHistoryRecord): BenchmarkHistorySummary {
  return {
    recordId: record.recordId,
    runId: record.runId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    model: record.model,
    runStatus: record.runStatus,
    scoreStatus: record.scoreStatus,
    scoreVersion: record.scoreVersion,
    totalScore: record.totalScore,
    grade: record.grade,
    error: record.error,
  };
}

function newestFirst(records: BenchmarkHistorySummary[]): BenchmarkHistorySummary[] {
  return [...records].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.recordId.localeCompare(left.recordId));
}

/** Durable benchmark history state backed only by the native diagnostics API. */
export function useBenchmarkHistory(enabled = true) {
  const desktopApi = useDesktopApiV2();
  const [page, setPage] = useState<BenchmarkHistoryPage>({ records: [], page: 1, pageSize: 50, totalCount: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (requestedPage: number, append = false) => {
    if (!desktopApi.capabilities.hasNativeShell) {
      setPage({ records: [], page: 1, pageSize: 50, totalCount: 0 });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = benchmarkHistoryPageFromNative(await desktopApi.diagnostics.listBenchmarkHistory(requestedPage, 50));
      setPage((current) => append ? {
        ...next,
        records: newestFirst([...current.records, ...next.records.filter((record) => !current.records.some((existing) => existing.recordId === record.recordId))]),
      } : next);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  const refresh = useCallback(async () => load(1), [load]);

  useEffect(() => {
    if (!enabled) return;
    // Defer the initial async load past effect setup; React's lint rule
    // correctly rejects synchronous state updates directly from an effect.
    queueMicrotask(() => {
      void refresh().catch((caught) => setError(errorText(caught)));
    });
  }, [enabled, refresh]);

  const save = useCallback(async (input: BenchmarkHistorySaveInput): Promise<BenchmarkHistoryRecord> => {
    const persisted = benchmarkHistoryRecordFromNative(
      await desktopApi.diagnostics.saveBenchmarkHistory(benchmarkHistorySaveInput(input)),
    );
    setPage((current) => {
      const summary = toSummary(persisted);
      const exists = current.records.some((record) => record.recordId === summary.recordId);
      return {
        ...current,
        // A save can insert a new newest record while the user has loaded
        // multiple offset-based pages. Reset to page one so the next
        // "Load more" request cannot skip the old second page after all
        // offsets shifted by one.
        page: 1,
        records: newestFirst([summary, ...current.records.filter((record) => record.recordId !== summary.recordId)]).slice(0, current.pageSize),
        totalCount: exists ? current.totalCount : current.totalCount + 1,
      };
    });
    return persisted;
  }, [desktopApi]);

  const get = useCallback(async (recordId: string): Promise<BenchmarkHistoryRecord> =>
    benchmarkHistoryRecordFromNative(await desktopApi.diagnostics.getBenchmarkHistory(recordId)), [desktopApi]);

  const remove = useCallback(async (recordId: string) => {
    const result = await desktopApi.diagnostics.deleteBenchmarkHistory(recordId);
    if (result.deleted) {
      setPage((current) => ({
        ...current,
        records: current.records.filter((record) => record.recordId !== recordId),
        totalCount: Math.max(0, current.totalCount - 1),
      }));
    }
    return result;
  }, [desktopApi]);

  const clear = useCallback(async () => {
    const result = await desktopApi.diagnostics.clearBenchmarkHistory();
    setPage((current) => ({ ...current, records: [], totalCount: 0 }));
    return result;
  }, [desktopApi]);

  const loadMore = useCallback(async () => {
    if (page.records.length >= page.totalCount || loading) return;
    await load(page.page + 1, true);
  }, [load, loading, page.page, page.records.length, page.totalCount]);

  return {
    clear,
    error,
    get,
    loadMore,
    loading,
    page,
    refresh,
    remove,
    save,
  };
}
