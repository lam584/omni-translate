import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { useBenchmarkHistory } from './useBenchmarkHistory';

const runtime = vi.hoisted(() => ({ native: true, list: vi.fn(), save: vi.fn(), get: vi.fn(), remove: vi.fn(), clear: vi.fn() }));
vi.mock('../../runtime/desktop-api-context', () => ({ useDesktopApiV2: () => api }));
const api = { capabilities: { get hasNativeShell() { return runtime.native; } }, diagnostics: { listBenchmarkHistory: runtime.list, saveBenchmarkHistory: runtime.save, getBenchmarkHistory: runtime.get, deleteBenchmarkHistory: runtime.remove, clearBenchmarkHistory: runtime.clear } };
const record = (recordId: string) => ({ recordId, runId: 'run-' + recordId, createdAt: '2026-10-02T00:00:00Z', updatedAt: '', model: 'voice', runStatus: 'completed', scoreStatus: 'final', scoreVersion: 'benchmark-score/v2', totalScore: 90, grade: 'A', error: null, report: null, score: null });

describe('history errors, pagination and destructive-result boundaries', () => {
  let history: ReturnType<typeof useBenchmarkHistory>;
  function Harness({ enabled = false }: { enabled?: boolean }) { history = useBenchmarkHistory(enabled); return null; }
  const view = registerDomHarness({ setup: () => {
    runtime.native = true;
    for (const spy of [runtime.list, runtime.save, runtime.get, runtime.remove, runtime.clear]) spy.mockReset();
    runtime.list.mockResolvedValue({ records: [record('a')], page: 1, pageSize: 50, totalCount: 2 });
  } });

  it('does not invoke native storage in browser preview, including automatic refresh', async () => {
    runtime.native = false;
    await view.render(<Harness enabled />);
    await act(async () => history.refresh());
    expect(runtime.list).not.toHaveBeenCalled();
    expect(history.page).toEqual({ records: [], page: 1, pageSize: 50, totalCount: 0 });
    expect(history.loading).toBe(false);
  });

  it.each([new Error('database unavailable'), 'offline'])('surfaces refresh failure %s and clears it on recovery', async (error) => {
    runtime.list.mockRejectedValueOnce(error);
    await view.render(<Harness enabled />);
    expect(history.error).toBe(error instanceof Error ? error.message : error);
    expect(history.loading).toBe(false);
    await act(async () => history.refresh());
    expect(history.error).toBeNull();
    expect(history.page.records.map((row) => row.recordId)).toEqual(['a']);
  });

  it('deduplicates appended pages and sorts equal timestamps by record identity', async () => {
    await view.render(<Harness />);
    await act(async () => history.refresh());
    runtime.list.mockResolvedValueOnce({ records: [record('a'), record('z')], page: 2, pageSize: 50, totalCount: 2 });
    await act(async () => history.loadMore());
    expect(history.page.records.map((row) => row.recordId)).toEqual(['z', 'a']);
    await act(async () => history.loadMore());
    expect(runtime.list).toHaveBeenCalledTimes(2);
    runtime.save.mockResolvedValueOnce(record('a'));
    await act(async () => history.save({ runId: 'run-a', model: 'voice', runStatus: 'completed', scoreStatus: 'final' }));
    expect(history.page.totalCount).toBe(2);
    expect(history.page.records.map((row) => row.recordId)).toEqual(['z', 'a']);
  });

  it('honors deletion confirmation, retrieves detail, and clears storage only through the native command', async () => {
    await view.render(<Harness />);
    await act(async () => history.refresh());
    runtime.remove.mockResolvedValueOnce({ deleted: false }).mockResolvedValueOnce({ deleted: true });
    await act(async () => history.remove('a'));
    expect(history.page.records).toHaveLength(1);
    expect(history.page.totalCount).toBe(2);
    await act(async () => history.remove('a'));
    expect(history.page.records).toEqual([]);
    expect(history.page.totalCount).toBe(1);
    runtime.get.mockResolvedValue(record('a'));
    expect(await history.get('a')).toEqual(record('a'));
    expect(runtime.get).toHaveBeenCalledExactlyOnceWith('a');
    runtime.clear.mockResolvedValue({ deletedCount: 1 });
    await act(async () => { expect(await history.clear()).toEqual({ deletedCount: 1 }); });
    expect(runtime.clear).toHaveBeenCalledOnce();
    expect(history.page.totalCount).toBe(0);
  });
});
