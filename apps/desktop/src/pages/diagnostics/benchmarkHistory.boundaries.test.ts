import { describe, expect, it } from 'vitest';
import type { BenchmarkHistoryRecord as NativeRecord } from '../../schema/generated/runtime-core';
import { createEmptyBenchmarkReport } from './diagnosticsOverview';
import { benchmarkHistoryRecordFromNative, benchmarkScoreFromHistory, groupBenchmarkHistoryByScoreVersion, historyScoreStatus, type BenchmarkStoredScore, type BenchmarkHistorySummary } from './benchmarkHistory';

const summary: BenchmarkHistorySummary = { recordId: 'one', runId: 'run', createdAt: '', updatedAt: '', model: 'model', runStatus: 'completed', scoreStatus: 'final', scoreVersion: null, totalScore: null, grade: null, error: null };

describe('durable history decoding boundaries', () => {
  it('normalizes missing latency evidence to null without treating a zero-duration run as an offset', () => {
    const report = createEmptyBenchmarkReport('model', 'file.wav');
    report.runs = [{ runIndex: 0, audioDurationSecs: 0, firstOutputMs: null, firstCommittedMs: null, timeToFirstTokenMs: null, timeToFirstCommittedMs: null, responseDoneMs: null } as typeof report.runs[number]];
    const result = benchmarkHistoryRecordFromNative({ ...summary, report, score: null } as NativeRecord);
    expect(result.report?.runs[0]).toMatchObject({ audioStartedAtMs: 0, audioStartOrigin: null, audioToRenderFirstMs: null, audioToRenderFinalMs: null });
    report.runs[0] = { ...report.runs[0], timeToFirstTokenMs: 0, timeToFirstCommittedMs: 12 };
    const migrated = benchmarkHistoryRecordFromNative({ ...summary, report, score: null } as NativeRecord);
    expect(migrated.report?.runs[0]).toMatchObject({ audioToRenderFirstMs: 0, audioToRenderFinalMs: 12 });
  });

  it.each([false, 'score', { schemaVersion: 'benchmark-score/v2', version: 'wrong', dimensions: {} }, { schemaVersion: 'benchmark-score/v2', version: 'benchmark-score/v2', dimensions: null }])('rejects malformed score %j', (value) => {
    expect(benchmarkScoreFromHistory(value)).toBeNull();
  });

  it.each([['judging', 'judging'], ['benchmark-running', 'pending'], ['judge-failed', 'judge-failed'], ['benchmark-failed', 'benchmark-failed'], ['evidence-insufficient', 'evidence-insufficient']] as const)('maps %s to durable %s', (status, expected) => {
    expect(historyScoreStatus({ status } as BenchmarkStoredScore)).toBe(expected);
  });

  it('puts unknown/null versions after supported versions with deterministic version tie-breaking', () => {
    const records = ['z-custom', null, 'a-custom', 'benchmark-score/v1', 'benchmark-score/v2'].map((version, index) => ({ ...summary, recordId: String(index), scoreVersion: version }));
    expect(groupBenchmarkHistoryByScoreVersion(records).map((group) => group.scoreVersion)).toEqual(['benchmark-score/v2', 'benchmark-score/v1', 'a-custom', null, 'z-custom']);
    expect(records[0].scoreVersion).toBe('z-custom');
  });
});
