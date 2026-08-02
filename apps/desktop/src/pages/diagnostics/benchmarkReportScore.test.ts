import { describe, expect, it } from 'vitest';
import type { BenchmarkReport } from '../../runtime/benchmark-runtime';
import { scoreBenchmarkReport } from './benchmarkReportScore';

const report = (): BenchmarkReport => ({
  model: 'model', audioFile: 'general.wav', audioDurationSecs: 120,
  runs: [{ runIndex: 0, model: 'model', connectMs: 100, sessionReadyMs: 200, audioSendMs: 120_000,
    audioChunksSent: 100, audioDurationSecs: 120, firstAsrMs: 500, asrDeltas: [], asrFinal: 'hello',
    firstOutputMs: 2_000, firstCommittedMs: 5_000, outputDeltas: [], translationFinal: '你好',
    responseCreatedMs: 100, responseDoneMs: 120_100, responseDoneAudioChunksSent: 100,
    responseDoneAudioSentSecs: 120, responseCount: 1, speechStartedMs: 100, speechStoppedMs: 119_000,
    timeToFirstTokenMs: 2_000, timeToFirstCommittedMs: 5_000, totalOutputDurationMs: 118_000, outputDeltaCount: 10 }],
  summary: { runCount: 1, successfulRuns: 1, avgConnectMs: 100, avgSessionReadyMs: 200,
    avgTimeToFirstTokenMs: 2_000, avgTimeToFirstCommittedMs: 5_000, avgOutputDeltaIntervalMs: 10,
    avgOutputDeltasPerRun: 10, avgTotalOutputDurationMs: 118_000, p50DeltaIntervalMs: 10,
    p90DeltaIntervalMs: 20, p99DeltaIntervalMs: 30, minDeltaIntervalMs: 5, maxDeltaIntervalMs: 40 },
});

describe('scoreBenchmarkReport', () => {
  it('scores objective dimensions without inventing a semantic score', () => {
    expect(scoreBenchmarkReport(report())).toMatchObject({ total: 100, grade: 'A', semanticEvidence: 'unavailable', dimensions: { semantic: null, latency: 100, completeness: 100, reliability: 100 } });
  });
  it('allows LLM judgment to change semantic only', () => {
    const base = scoreBenchmarkReport(report());
    const judged = scoreBenchmarkReport(report(), { llmSemanticScore: 50 });
    expect(judged.dimensions).toMatchObject({ semantic: 50, latency: base.dimensions.latency, completeness: base.dimensions.completeness, reliability: base.dimensions.reliability });
  });

  it('uses reference evidence for known translations and blends an LLM score when present', () => {
    const reference = scoreBenchmarkReport(report(), { referenceTranslation: '你好' });
    expect(reference).toMatchObject({
      semanticEvidence: 'reference-proxy',
      dimensions: { semantic: 100 },
    });

    const judged = scoreBenchmarkReport(report(), { referenceTranslation: '你好', llmSemanticScore: 50 });
    expect(judged).toMatchObject({ semanticEvidence: 'llm-judge', dimensions: { semantic: 70 } });
  });

  it('scores response-relative latency instead of the absolute audio offset', () => {
    const longAudio = report();
    const run = longAudio.runs[0]!;
    run.responseCreatedMs = 113_614.4;
    run.firstOutputMs = 113_615;
    run.firstCommittedMs = 113_615.6;
    run.timeToFirstTokenMs = 113_615;
    run.timeToFirstCommittedMs = 113_615.6;
    expect(scoreBenchmarkReport(longAudio).dimensions.latency).toBe(100);
  });
});
