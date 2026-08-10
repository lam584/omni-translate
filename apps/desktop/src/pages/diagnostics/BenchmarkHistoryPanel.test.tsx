import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BenchmarkHistoryPanel } from './BenchmarkHistoryPanel';
import type { BenchmarkHistorySummary } from './benchmarkHistory';
import { formatHistoryTime, historyScore } from './benchmarkHistoryFormat';

const record: BenchmarkHistorySummary = {
  recordId: 'record-1', runId: 'run-1', createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z',
  model: 'benchmark-model', runStatus: 'completed', scoreStatus: 'final', scoreVersion: 'benchmark-score/v1',
  totalScore: 83.5, grade: 'B', error: null,
};

describe('BenchmarkHistoryPanel', () => {
  it('renders formal scores and makes history actions available', () => {
    const html = renderToStaticMarkup(createElement(BenchmarkHistoryPanel, {
      error: null, hasMore: false, loading: false, records: [record], totalCount: 1,
      onClear: vi.fn(), onDelete: vi.fn(), onLoadMore: vi.fn(), onOpen: vi.fn(), onRefresh: vi.fn(),
    }));
    expect(html).toContain('benchmark-history');
    expect(html).toContain('benchmark-model');
    expect(html).toContain('83.5 B');
  });

  it('formats invalid timestamps safely and avoids inventing a score', () => {
    expect(formatHistoryTime('not-a-time')).toBe('not-a-time');
    expect(formatHistoryTime('unix:1779974788')).not.toBe('unix:1779974788');
    expect(historyScore({ ...record, totalScore: null, grade: null })).toBe('—');
  });
});
