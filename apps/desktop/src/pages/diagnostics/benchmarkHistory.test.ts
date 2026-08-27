import { describe, expect, it } from 'vitest';
import { benchmarkHistorySaveInput, groupBenchmarkHistoryByScoreVersion, isFinalBenchmarkHistoryRecord } from './benchmarkHistory';

describe('benchmark history helpers', () => {
  it('fills the v2 persistence defaults without creating a client-side fallback', () => {
    expect(benchmarkHistorySaveInput({
      runId: 'run-1', model: 'model', runStatus: 'running', scoreStatus: 'pending',
    })).toEqual({
      runId: 'run-1', model: 'model', runStatus: 'running', scoreStatus: 'pending',
      scoreVersion: 'benchmark-score/v2', totalScore: null, grade: null,
      report: null, score: null, error: null,
    });
  });

  it('groups score versions so legacy v1 is never compared with v2', () => {
    const base = {
      runId: 'run', createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z',
      model: 'model', runStatus: 'completed' as const, scoreStatus: 'final' as const,
      totalScore: 88, grade: 'B', error: null,
    };
    const groups = groupBenchmarkHistoryByScoreVersion([
      { ...base, recordId: 'v1', scoreVersion: 'benchmark-score/v1' },
      { ...base, recordId: 'v2', scoreVersion: 'benchmark-score/v2' },
    ]);
    expect(groups.map(({ scoreVersion, records }) => [scoreVersion, records.map(({ recordId }) => recordId)]))
      .toEqual([
        ['benchmark-score/v2', ['v2']],
        ['benchmark-score/v1', ['v1']],
      ]);
  });

  it('recognizes only completed formal score records as final', () => {
    const summary = {
      recordId: 'history-1', runId: 'run-1', createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z',
      model: 'model', runStatus: 'completed' as const, scoreStatus: 'final' as const,
      scoreVersion: 'benchmark-score/v1', totalScore: 88, grade: 'B', error: null,
    };
    expect(isFinalBenchmarkHistoryRecord(summary)).toBe(true);
    expect(isFinalBenchmarkHistoryRecord({ ...summary, scoreStatus: 'judging' })).toBe(false);
    expect(isFinalBenchmarkHistoryRecord({ ...summary, totalScore: null })).toBe(false);
  });
});
