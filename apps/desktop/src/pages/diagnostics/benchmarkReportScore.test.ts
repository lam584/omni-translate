import { describe, expect, it } from 'vitest';
import type { BenchmarkReport } from '../../runtime/benchmark-runtime';
import {
  calculateChrF2,
  scoreBenchmarkReport,
  scoreLatencyRamp,
  type BenchmarkSemanticJudgeEvidence,
} from './benchmarkReportScore';

const judge = (runs: Array<{ runIndex: number; score: number }>): BenchmarkSemanticJudgeEvidence => ({
  model: 'judge-model',
  rubricVersion: 'benchmark-semantic-judge/v1',
  score: runs.reduce((sum, run) => sum + run.score, 0) / runs.length,
  runs: runs.map(({ runIndex, score }) => ({
    runIndex,
    score,
    subscores: { adequacy: score, factsTerminology: score, omissionsAdditions: score, fluency: score },
    rationale: '',
    criticalErrors: [],
  })),
});

const report = (): BenchmarkReport => ({
  model: 'model', audioFile: 'general.wav', audioDurationSecs: 120,
  runs: [{ runIndex: 0, model: 'model', connectMs: 100, sessionReadyMs: 200, audioSendMs: 120_000,
    audioChunksSent: 100, audioDurationSecs: 120, firstAsrMs: 500, asrDeltas: [], asrFinal: 'hello',
    audioStartedAtMs: 100, audioStartOrigin: 'provider-offset', sourceStableAtMs: 600,
    audioToSourceFirstMs: 400, audioToLlmFirstMs: 2_000,
    audioToRenderFirstMs: 2_000, audioToRenderFinalMs: 5_000,
    firstOutputMs: 2_100, firstCommittedMs: 5_100, outputDeltas: [], translationFinal: '你好',
    responseCreatedMs: 100, responseDoneMs: 120_100, responseDoneAudioChunksSent: 100,
    responseDoneAudioSentSecs: 120, responseCount: 1, speechStartedMs: 100, speechStoppedMs: 119_000,
    timeToFirstTokenMs: 2_000, timeToFirstCommittedMs: 5_000, totalOutputDurationMs: 118_000, outputDeltaCount: 10 }],
  summary: { runCount: 1, successfulRuns: 1, avgConnectMs: 100, avgSessionReadyMs: 200,
    avgTimeToFirstTokenMs: 2_000, avgTimeToFirstCommittedMs: 5_000, avgOutputDeltaIntervalMs: 10,
    avgOutputDeltasPerRun: 10, avgTotalOutputDurationMs: 118_000, p50DeltaIntervalMs: 10,
    p90DeltaIntervalMs: 20, p99DeltaIntervalMs: 30, minDeltaIntervalMs: 5, maxDeltaIntervalMs: 40 },
});

function score(input: BenchmarkReport, semanticJudge = judge([{ runIndex: 0, score: 100 }])) {
  return scoreBenchmarkReport(input, {
    benchmarkState: 'completed',
    sourceText: 'hello',
    referenceTranslation: '你好',
    semanticJudge,
  });
}

describe('benchmark-score/v2', () => {
  it('uses reproducible Unicode NFKC chrF2 character 1–6 gram evidence', () => {
    const chrF2 = calculateChrF2('ＡＢ\nＣ', 'ABC');
    expect(chrF2).toMatchObject({ metric: 'chrF2', beta: 2, characterNgramOrder: 6, score: 100, precision: 100, recall: 100 });
    expect(chrF2?.orders.map(({ order }) => order)).toEqual([1, 2, 3]);
  });

  it('issues an official score only with all four dimensions and full judge evidence', () => {
    expect(score(report())).toMatchObject({
      schemaVersion: 'benchmark-score/v2',
      status: 'official',
      total: 100,
      grade: 'A',
      dimensions: {
        semantic: { score: 100, status: 'scored' },
        latency: { score: 100, status: 'scored' },
        completeness: { score: 100, status: 'scored' },
        stability: { score: 100, status: 'scored' },
      },
    });
  });

  it('does not reweight dimensions or issue a total while semantic evidence is missing', () => {
    const result = scoreBenchmarkReport(report(), {
      benchmarkState: 'completed',
      sourceText: 'hello',
      referenceTranslation: '你好',
    });
    expect(result).toMatchObject({ status: 'evidence-insufficient', total: null, grade: null });
    expect(result.dimensions.semantic.missingEvidence).toContain('judge-result-for-each-completed-run');
  });

  it('uses audio-to-visible latency and its documented boundary/linear thresholds', () => {
    expect(scoreLatencyRamp(2_000, 2_000, 8_000)).toBe(100);
    expect(scoreLatencyRamp(8_000, 2_000, 8_000)).toBe(0);
    expect(scoreLatencyRamp(5_000, 2_000, 8_000)).toBe(50);
    const slow = report();
    slow.runs[0]!.audioToRenderFirstMs = 5_000;
    slow.runs[0]!.audioToRenderFinalMs = 10_000;
    expect(score(slow).dimensions.latency.score).toBe(50);
  });

  it('requires latency evidence for every run rather than treating a gap as zero', () => {
    const incomplete = report();
    incomplete.runs[0]!.audioToRenderFinalMs = null;
    const result = score(incomplete);
    expect(result.status).toBe('evidence-insufficient');
    expect(result.total).toBeNull();
    expect(result.dimensions.latency.missingEvidence).toContain('run-0-audioToRenderFinal');
  });

  it('does not score low-confidence provider-event audio origins', () => {
    const incomplete = report();
    incomplete.runs[0]!.audioStartOrigin = 'provider-event';
    const result = score(incomplete);
    expect(result.status).toBe('evidence-insufficient');
    expect(result.dimensions.latency.score).toBeNull();
    expect(result.dimensions.latency.missingEvidence).toContain('run-0-audioToRenderFirst');
  });

  it('requires response-count telemetry before scoring stability', () => {
    const incomplete = report();
    incomplete.runs[0]!.responseCount = Number.NaN;
    const result = score(incomplete);
    expect(result.status).toBe('evidence-insufficient');
    expect(result.dimensions.stability.score).toBeNull();
    expect(result.dimensions.stability.missingEvidence).toContain('run-0-response-count');
  });

  it('aggregates every successful run and exposes duplicate-response deductions', () => {
    const multi = report();
    multi.runs.push({ ...multi.runs[0]!, runIndex: 1, translationFinal: '再见', responseCount: 3 });
    multi.summary.runCount = 2;
    multi.summary.successfulRuns = 2;
    const result = scoreBenchmarkReport(multi, {
      benchmarkState: 'completed',
      sourceText: 'hello',
      referenceTranslation: '你好',
      semanticJudge: judge([{ runIndex: 0, score: 100 }, { runIndex: 1, score: 50 }]),
    });
    expect(result.dimensions.semantic.evidence.judge.judgedRunIndexes).toEqual([0, 1]);
    expect(result.dimensions.stability.evidence.totalDeduction).toBe(10);
    expect(result.deductions).toHaveLength(2);
  });

  it('reports judge and benchmark failures without fabricating a total', () => {
    expect(scoreBenchmarkReport(report(), {
      benchmarkState: 'completed', sourceText: 'hello', referenceTranslation: '你好', judgeState: 'failed', judgeError: 'timeout',
    })).toMatchObject({ status: 'judge-failed', total: null });
    expect(scoreBenchmarkReport(report(), {
      benchmarkState: 'failed', sourceText: 'hello', referenceTranslation: '你好', semanticJudge: judge([{ runIndex: 0, score: 100 }]),
    })).toMatchObject({ status: 'benchmark-failed', total: null });
  });
});
