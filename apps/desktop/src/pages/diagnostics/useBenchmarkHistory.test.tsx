import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { registerDomHarness } from '../../test-utils/component-test-harness';

const runtime = vi.hoisted(() => ({
  listBenchmarkHistory: vi.fn(),
  saveBenchmarkHistory: vi.fn(),
}));

vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopApiV2: () => ({
    capabilities: { hasNativeShell: true },
    diagnostics: {
      listBenchmarkHistory: runtime.listBenchmarkHistory,
      saveBenchmarkHistory: runtime.saveBenchmarkHistory,
    },
  }),
}));

import { useBenchmarkHistory } from './useBenchmarkHistory';

function summary(recordId: string, createdAt: string) {
  return {
    recordId,
    runId: `run-${recordId}`,
    createdAt,
    updatedAt: createdAt,
    model: 'voice-model',
    runStatus: 'completed' as const,
    scoreStatus: 'evidence-insufficient' as const,
    scoreVersion: 'benchmark-score/v1',
    totalScore: null,
    grade: null,
    error: null,
  };
}

describe('useBenchmarkHistory', () => {
  let history: ReturnType<typeof useBenchmarkHistory>;

  function Harness() {
    history = useBenchmarkHistory(false);
    return null;
  }

  const view = registerDomHarness({
    setup: () => {
      vi.clearAllMocks();
      const firstPage = Array.from({ length: 50 }, (_, index) => summary(`first-${index}`, `2026-08-09T00:${String(59 - index).padStart(2, '0')}:00.000Z`));
      const secondPage = Array.from({ length: 50 }, (_, index) => summary(`second-${index}`, `2026-08-08T00:${String(59 - index).padStart(2, '0')}:00.000Z`));
      runtime.listBenchmarkHistory.mockImplementation(async (page: number, pageSize: number) => {
        expect(pageSize).toBe(50);
        return {
          records: page === 1 ? firstPage : page === 2 ? secondPage : [],
          page,
          pageSize,
          totalCount: 100,
        };
      });
      runtime.saveBenchmarkHistory.mockResolvedValue({
        ...summary('newest', '2026-08-10T00:00:00.000Z'),
        runStatus: 'running',
        scoreStatus: 'pending',
        report: null,
        score: null,
      });
    },
  });

  it('resets to page one after a save so the next page request does not skip records', async () => {
    await view.render(<Harness />);
    await act(async () => { await history.refresh(); });
    await act(async () => { await history.loadMore(); });
    expect(history.page.page).toBe(2);
    expect(history.page.records).toHaveLength(100);

    await act(async () => {
      await history.save({ runId: 'run-newest', model: 'voice-model', runStatus: 'running', scoreStatus: 'pending' });
    });

    expect(history.page.page).toBe(1);
    expect(history.page.records).toHaveLength(50);
    expect(history.page.records[0]?.recordId).toBe('newest');

    await act(async () => { await history.loadMore(); });
    expect(runtime.listBenchmarkHistory).toHaveBeenLastCalledWith(2, 50);
  });
});
