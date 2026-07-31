import { describe, expect, it } from 'vitest';

import type {
  WatchCueComparisonRuntime,
  WatchIssueRuntime,
  WatchSessionReportRuntime,
} from '../../schema/audio-runtime';
import { groupWatchReportIssues } from './watchReportIssues';

function issue(
  occurrenceCount: number,
  cueId: string | null,
  category: WatchIssueRuntime['category'] = 'data',
): WatchIssueRuntime {
  return {
    category,
    code: 'unmatched-render-receipt',
    severity: 'warning',
    message: '悬浮窗回执无法关联。',
    cueId,
    elapsedMs: 100,
    occurrenceCount,
  };
}

function cue(cueId: string, issues: WatchIssueRuntime[]): WatchCueComparisonRuntime {
  return {
    cueId,
    revision: 1,
    routeDirection: 'inbound',
    translationPath: 'provider-realtime',
    sourceText: '',
    llmText: '',
    publishedText: '',
    publishedSegments: [],
    renderedSourceText: '',
    renderedText: '',
    comparisonStatus: 'pending',
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
    events: [],
    issues,
    droppedEventCount: 0,
  };
}

function report(
  issues: WatchIssueRuntime[],
  cues: WatchCueComparisonRuntime[],
): WatchSessionReportRuntime {
  return {
    sessionId: 'watch-session-1',
    status: 'completed',
    routeMode: 'watch',
    providerId: 'provider',
    model: 'model',
    startedAt: 'unix-ms:0',
    endedAt: 'unix-ms:100',
    elapsedMs: 100,
    summary: {
      durationMs: 100,
      cueCount: cues.length,
      completeCueCount: 0,
      visibleRenderCueCount: 0,
      unrenderedCueCount: cues.length,
      issueCount: issues.length + cues.reduce((total, item) => total + item.issues.length, 0),
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
    issues,
    droppedCueCount: 0,
    droppedEventCount: 0,
  };
}

describe('groupWatchReportIssues', () => {
  it('renders hundreds of duplicate receipts as one classified issue with a total count', () => {
    const groups = groupWatchReportIssues(report(
      [issue(470, 'cue-a')],
      [cue('cue-b', [issue(8, 'cue-b')])],
    ));

    expect(groups).toEqual([expect.objectContaining({
      category: 'data',
      code: 'unmatched-render-receipt',
      occurrenceCount: 478,
      cueIds: ['cue-a', 'cue-b'],
    })]);
  });

  it('keeps identical technical codes in different user-facing categories separate', () => {
    const groups = groupWatchReportIssues(report(
      [issue(1, null, 'data'), issue(1, null, 'render')],
      [],
    ));

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.category)).toEqual(['render', 'data']);
  });
});
