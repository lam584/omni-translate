// Shared fixtures for the DiagnosticsPage helpers test suite, which is split
// across DiagnosticsPage.helpers.test.ts, DiagnosticsPage.helpers.benchmark.test.ts
// and DiagnosticsPage.helpers.live-events.test.ts.
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { BenchmarkReport, BenchmarkRunResult } from '../runtime/benchmark-runtime';
import { diagnosticsPageHelpers } from '../pages/DiagnosticsPage';

export type LiveEvents = Parameters<typeof diagnosticsPageHelpers.formatLiveEventsTxt>[0];

/** Live-session events payload with all milestone fields nulled; override per test. */
export function liveEvents(overrides: Partial<LiveEvents> = {}): LiveEvents {
  return {
    sessionStartedAt: 'unix-ms:1000',
    elapsedMs: 5000,
    model: 'test-model',
    asrDeltas: [],
    outputDeltas: [],
    asrFinal: '',
    translationFinal: '',
    pipelineMilestones: { preconnectStartedMs: null, sessionReadyMs: null, routeStartedMs: null, firstAudioSentMs: null, firstSpeechStartedMs: null, queuedAudioChunks: null, droppedBeforeReady: null, firstAudibleChunkMs: null, silenceSkippedBeforeAudible: null, totalInputChunksAtSpeech: null },
    ...overrides,
  };
}

/** Renders LiveSessionEventDetail for the given live-events overrides. */
export function renderLiveDetail(overrides: Partial<LiveEvents> = {}) {
  return renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, {
    events: liveEvents(overrides),
    loading: false,
  }));
}

export function benchmarkReport(overrides: {
  realtimeAudioMode?: BenchmarkReport['realtimeAudioMode'];
  run?: Partial<BenchmarkRunResult>;
} = {}): BenchmarkReport {
  const run: BenchmarkRunResult = {
    runIndex: 0,
    model: 'qwen3.5-omni-plus-realtime',
    connectMs: 10,
    sessionReadyMs: 20,
    audioSendMs: 100,
    audioChunksSent: 2,
    audioDurationSecs: 3,
    firstAsrMs: null,
    asrDeltas: [],
    asrFinal: '',
    firstOutputMs: 150,
    firstCommittedMs: null,
    outputDeltas: [],
    translationFinal: '',
    responseCreatedMs: 120,
    responseDoneMs: null,
    responseDoneAudioChunksSent: null,
    responseDoneAudioSentSecs: null,
    responseCount: 0,
    speechStartedMs: null,
    speechStoppedMs: null,
    timeToFirstTokenMs: 150,
    timeToFirstCommittedMs: null,
    totalOutputDurationMs: null,
    outputDeltaCount: 0,
    ...overrides.run,
  };

  return {
    model: run.model,
    realtimeAudioMode: overrides.realtimeAudioMode,
    audioFile: 'sample.mp3',
    audioDurationSecs: run.audioDurationSecs,
    runs: [run],
    summary: {
      runCount: 1,
      successfulRuns: 1,
      avgConnectMs: 10,
      avgSessionReadyMs: 20,
      avgTimeToFirstTokenMs: null,
      avgTimeToFirstCommittedMs: null,
      avgOutputDeltaIntervalMs: null,
      avgOutputDeltasPerRun: run.outputDeltas.length,
      avgTotalOutputDurationMs: null,
      p50DeltaIntervalMs: null,
      p90DeltaIntervalMs: null,
      p99DeltaIntervalMs: null,
      minDeltaIntervalMs: null,
      maxDeltaIntervalMs: null,
    },
  };
}
