import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WatchCueComparisonRuntime,
  WatchSessionReportRuntime,
  WatchTimelineEventRuntime,
} from '../schema/audio-runtime';

const runtime = vi.hoisted(() => ({
  watchSessionReport: vi.fn(),
}));

vi.mock('./desktop-api', () => ({
  activeDesktopApi: () => ({
    diagnostics: {
      watchSessionReport: runtime.watchSessionReport,
    },
  }),
}));

import {
  EMPTY_PIPELINE_MILESTONES,
  getLiveSessionEventsRuntime,
} from './live-session-events-runtime';

function event(
  stage: WatchTimelineEventRuntime['stage'],
  finalEvent: boolean,
  text: string,
  elapsedMs: number,
): WatchTimelineEventRuntime {
  return {
    eventId: `${stage}-${elapsedMs}`,
    stage,
    kind: finalEvent ? 'final' : 'delta',
    elapsedMs,
    text,
    detail: null,
    finalEvent,
    accepted: true,
    visible: null,
    callId: null,
    attemptId: null,
  };
}

function cue(
  sourceText: string,
  llmText: string,
  events: WatchTimelineEventRuntime[],
): WatchCueComparisonRuntime {
  return {
    cueId: 'cue-1',
    revision: 1,
    routeDirection: 'inbound',
    translationPath: 'provider-realtime',
    sourceText,
    llmText,
    publishedText: llmText,
    publishedSegments: [],
    renderedSourceText: sourceText,
    renderedText: llmText,
    comparisonStatus: 'exact',
    sourceAtMs: null,
    llmFirstAtMs: null,
    llmFinalAtMs: null,
    publishedFirstAtMs: null,
    publishedFinalAtMs: null,
    renderedFirstAtMs: null,
    renderedFinalAtMs: null,
    sourceToLlmFirstMs: null,
    sourceToRenderMs: null,
    llmFirstToPublishMs: null,
    publishToRenderMs: null,
    llmFirstToRenderMs: null,
    llmFinalToPublishMs: null,
    publishedFinalToRenderMs: null,
    llmFinalToRenderMs: null,
    events,
    issues: [],
    droppedEventCount: 0,
  };
}

function report(cues: WatchCueComparisonRuntime[]): WatchSessionReportRuntime {
  return {
    sessionId: 'watch-session-1',
    status: 'completed',
    routeMode: 'watch',
    providerId: 'provider',
    model: 'realtime-model',
    startedAt: 'unix-ms:1000',
    endedAt: 'unix-ms:1600',
    elapsedMs: 600,
    summary: {
      durationMs: 600,
      cueCount: cues.length,
      completeCueCount: cues.length,
      visibleRenderCueCount: cues.length,
      unrenderedCueCount: 0,
      issueCount: 0,
      issueOccurrenceCount: 0,
      averageSourceToLlmFirstMs: null,
      p95SourceToLlmFirstMs: null,
      maxSourceToLlmFirstMs: null,
      averageSourceToRenderMs: null,
      p95SourceToRenderMs: null,
      maxSourceToRenderMs: null,
      averageLlmFirstToRenderMs: null,
      p95LlmFirstToRenderMs: null,
      maxLlmFirstToRenderMs: null,
      averageLlmFinalToRenderMs: null,
      p95LlmFinalToRenderMs: null,
      maxLlmFinalToRenderMs: null,
      slowestCueId: null,
    },
    cues,
    events: [],
    issues: [],
    droppedCueCount: 0,
    droppedEventCount: 0,
  };
}

describe('live session events runtime', () => {
  beforeEach(() => {
    runtime.watchSessionReport.mockReset();
  });

  it('returns a fresh empty snapshot when no watch report is retained', async () => {
    runtime.watchSessionReport.mockResolvedValue(null);

    const first = await getLiveSessionEventsRuntime();
    first.pipelineMilestones.queuedAudioChunks = 7;
    const second = await getLiveSessionEventsRuntime();

    expect(second).toEqual({
      sessionStartedAt: '',
      elapsedMs: 0,
      model: '',
      asrDeltas: [],
      outputDeltas: [],
      asrFinal: '',
      translationFinal: '',
      pipelineMilestones: EMPTY_PIPELINE_MILESTONES,
    });
  });

  it('maps source and model deltas while ignoring unrelated stages', async () => {
    runtime.watchSessionReport.mockResolvedValue(report([
      cue('source final', 'translation final', [
        event('source', false, 'source delta', 10),
        event('source', true, 'source final', 20),
        event('model', false, 'translation delta', 30),
        event('model', true, 'translation final', 40),
        event('publish', true, 'ignored', 50),
      ]),
    ]));

    await expect(getLiveSessionEventsRuntime()).resolves.toEqual({
      sessionStartedAt: 'unix-ms:1000',
      elapsedMs: 600,
      model: 'realtime-model',
      asrDeltas: [
        { elapsedMs: 10, stash: 'source delta', text: '', eventType: 'delta' },
        { elapsedMs: 20, stash: '', text: 'source final', eventType: 'final' },
      ],
      outputDeltas: [
        {
          elapsedMs: 30,
          eventType: 'delta',
          stash: 'translation delta',
          committedText: '',
        },
        {
          elapsedMs: 40,
          eventType: 'final',
          stash: '',
          committedText: 'translation final',
        },
      ],
      asrFinal: 'source final',
      translationFinal: 'translation final',
      pipelineMilestones: EMPTY_PIPELINE_MILESTONES,
    });
  });

  it('uses empty final text when a report has no cues', async () => {
    runtime.watchSessionReport.mockResolvedValue(report([]));

    const result = await getLiveSessionEventsRuntime();

    expect(result.asrFinal).toBe('');
    expect(result.translationFinal).toBe('');
  });
});
