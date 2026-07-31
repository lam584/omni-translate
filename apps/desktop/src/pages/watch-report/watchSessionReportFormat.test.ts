import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WatchCueComparisonRuntime,
  WatchIssueRuntime,
  WatchSessionReportRuntime,
  WatchTimelineEventRuntime,
} from '../../schema/audio-runtime';

const mocks = vi.hoisted(() => ({
  writeExportArtifact: vi.fn(),
}));

vi.mock('../../runtime/export-artifact-runtime', () => ({
  writeExportArtifactRuntime: mocks.writeExportArtifact,
}));

import {
  exportWatchSessionReport,
  formatWatchSessionReportJson,
  formatWatchSessionReportTxt,
} from './watchSessionReportFormat';

const timelineEvent: WatchTimelineEventRuntime = {
  eventId: 'event-render-1',
  stage: 'render',
  kind: 'overlay-rendered',
  elapsedMs: 950,
  text: '你好',
  detail: 'rendererRevision=3',
  finalEvent: true,
  accepted: true,
  visible: true,
  callId: 'call-1',
  attemptId: 'attempt-2',
};

const sessionTimelineEvent: WatchTimelineEventRuntime = {
  eventId: 'event-session-1',
  stage: 'session',
  kind: 'provider-connect-failed',
  elapsedMs: 125,
  text: 'connection status',
  detail: 'websocket closed unexpectedly',
  finalEvent: false,
  accepted: false,
  visible: null,
  callId: 'session-call-1',
  attemptId: 'session-attempt-2',
};

function issue(
  category: WatchIssueRuntime['category'],
  code: string,
  occurrenceCount: number,
  cueId: string | null = null,
): WatchIssueRuntime {
  return {
    category,
    code,
    severity: category === 'output' ? 'error' : 'warning',
    message: `${code} details`,
    cueId,
    elapsedMs: 950,
    occurrenceCount,
  };
}

function cue(
  revision: number,
  comparisonStatus: WatchCueComparisonRuntime['comparisonStatus'],
  overrides: Partial<WatchCueComparisonRuntime> = {},
): WatchCueComparisonRuntime {
  return {
    cueId: 'cue-logical-1',
    revision,
    routeDirection: 'inbound',
    translationPath: 'provider-dashscope',
    sourceText: 'Hello',
    llmText: '你好',
    publishedText: '你好',
    publishedSegments: [],
    renderedSourceText: 'Hello',
    renderedText: '你好',
    comparisonStatus,
    sourceAtMs: 100,
    llmFirstAtMs: 200,
    llmFinalAtMs: 300,
    publishedFirstAtMs: 500,
    publishedFinalAtMs: 550,
    renderedFirstAtMs: 950,
    renderedFinalAtMs: 1_000,
    sourceToLlmFirstMs: 100,
    sourceToRenderMs: 850,
    llmFirstToPublishMs: 300,
    publishToRenderMs: 450,
    llmFirstToRenderMs: 750,
    llmFinalToPublishMs: 250,
    publishedFinalToRenderMs: 450,
    llmFinalToRenderMs: 700,
    events: [timelineEvent],
    issues: [],
    droppedEventCount: 0,
    ...overrides,
  };
}

function reportFixture(): WatchSessionReportRuntime {
  return {
    sessionId: 'watch-session-1',
    status: 'completed',
    routeMode: 'watch',
    providerId: 'dashscope',
    model: 'qwen3.5-omni-plus-realtime',
    startedAt: '2026-07-31T10:00:00.000Z',
    endedAt: '2026-07-31T10:03:00.000Z',
    elapsedMs: 180_000,
    summary: {
      durationMs: 180_000,
      cueCount: 2,
      completeCueCount: 1,
      visibleRenderCueCount: 1,
      unrenderedCueCount: 1,
      issueCount: 3,
      issueOccurrenceCount: 483,
      averageSourceToLlmFirstMs: 8_664,
      p95SourceToLlmFirstMs: 9_000,
      maxSourceToLlmFirstMs: 9_500,
      averageSourceToRenderMs: 9_247,
      p95SourceToRenderMs: 9_606,
      maxSourceToRenderMs: 9_606,
      averageLlmFirstToRenderMs: 583,
      p95LlmFirstToRenderMs: 606,
      maxLlmFirstToRenderMs: 606,
      averageLlmFinalToRenderMs: 400,
      p95LlmFinalToRenderMs: 420,
      maxLlmFinalToRenderMs: 420,
      slowestCueId: 'cue-logical-1',
    },
    cues: [
      cue(1, 'superseded', {
        renderedText: '',
        sourceToRenderMs: null,
        renderedFirstAtMs: null,
        renderedFinalAtMs: null,
        events: [],
      }),
      cue(2, 'exact', {
        issues: [issue('content', 'content-different', 3, 'cue-logical-1')],
      }),
      cue(1, 'not-rendered', {
        cueId: 'cue-logical-2',
        renderedText: '',
        sourceToRenderMs: null,
        renderedFirstAtMs: null,
        renderedFinalAtMs: null,
        events: [],
        droppedEventCount: 4,
      }),
    ],
    events: [sessionTimelineEvent],
    issues: [
      issue('render', 'unmatched-render-receipt', 478),
      issue('output', 'virtual-mic-write-failed', 2),
    ],
    droppedCueCount: 0,
    droppedEventCount: 7,
  };
}

describe('watch session report export formatting', () => {
  beforeEach(() => {
    mocks.writeExportArtifact.mockReset();
    mocks.writeExportArtifact.mockResolvedValue({
      outputPath: 'C:/exports/watch-session-report.txt',
      fileCount: 1,
    });
  });

  it('labels source-to-render as end-to-end and preserves the application-only metric', () => {
    const text = formatWatchSessionReportTxt(reportFixture());

    expect(text).toContain('Average source -> visible render (end-to-end): 9247 ms');
    expect(text).toContain('P95 / max source -> visible render (end-to-end): 9606 ms / 9606 ms');
    expect(text).toContain('Average LLM first -> visible render (application pipeline): 583 ms');
    expect(text).toContain('Source->render (end-to-end): 850 ms');
    expect(text).toContain('LLM first->render (application pipeline): 750 ms');
    expect(text).not.toContain('Average LLM first -> visible render (end-to-end)');
  });

  it('distinguishes logical cues from retained revisions and marks superseded detail', () => {
    const text = formatWatchSessionReportTxt(reportFixture());

    expect(text).toContain('Logical cues: 2');
    expect(text).toContain('Cue revisions retained: 3');
    expect(text).toContain('Superseded revisions retained: 1');
    expect(text).toContain('Published logical cues without visible render: 1');
    expect(text).toContain('cue-logical-1 rev 1 [superseded]');
    expect(text).toContain(
      'Disposition: superseded by a later revision; excluded from logical-cue summary metrics',
    );
  });

  it('exports classified issue groups and their aggregated occurrence counts', () => {
    const text = formatWatchSessionReportTxt(reportFixture());

    expect(text).toContain('Issue groups: 3');
    expect(text).toContain('Issue occurrences: 483');
    expect(text).toContain('render: 1 group(s), 478 occurrence(s)');
    expect(text).toContain('content: 1 group(s), 3 occurrence(s)');
    expect(text).toContain('output: 1 group(s), 2 occurrence(s)');
    expect(text).toContain(
      'Session issue [render] warning/unmatched-render-receipt x478',
    );
    expect(text).toContain('Issue [content] warning/content-different x3 cue=cue-logical-1');
    expect(text).toContain('call=call-1 attempt=attempt-2');
    expect(text).toContain('Dropped cue events: 4');
  });

  it('exports every session-level timeline field in TXT', () => {
    const text = formatWatchSessionReportTxt(reportFixture());

    expect(text).toContain('--- Session timeline events (1) ---');
    expect(text).toContain('+125ms session · provider-connect-failed');
    expect(text).toContain('event=event-session-1');
    expect(text).toContain('call=session-call-1');
    expect(text).toContain('attempt=session-attempt-2');
    expect(text).toContain('accepted=false');
    expect(text).toContain('final=false');
    expect(text).toContain('visible=-');
    expect(text).toContain('text=connection status');
    expect(text).toContain('| websocket closed unexpectedly');
  });

  it('keeps the new comparison, timing, and issue fields in JSON', () => {
    const parsed = JSON.parse(formatWatchSessionReportJson(reportFixture())) as WatchSessionReportRuntime;

    expect(parsed.summary.averageSourceToRenderMs).toBe(9_247);
    expect(parsed.summary.issueOccurrenceCount).toBe(483);
    expect(parsed.cues[0]?.comparisonStatus).toBe('superseded');
    expect(parsed.cues[1]?.sourceToRenderMs).toBe(850);
    expect(parsed.issues[0]).toMatchObject({
      category: 'render',
      occurrenceCount: 478,
    });
  });

  it('passes the enriched JSON representation to the artifact writer', async () => {
    const report = reportFixture();

    await exportWatchSessionReport(report, 'json');

    expect(mocks.writeExportArtifact).toHaveBeenCalledOnce();
    const [filename, content, mimeType] = mocks.writeExportArtifact.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(filename).toMatch(/^watch-session-report-qwen3\.5-omni-plus-realtime-.*\.json$/);
    expect(mimeType).toBe('application/json');
    const parsed = JSON.parse(content) as WatchSessionReportRuntime;
    expect(parsed.summary).toMatchObject({
      averageSourceToRenderMs: 9_247,
      issueOccurrenceCount: 483,
    });
    expect(parsed.cues[0]).toMatchObject({ comparisonStatus: 'superseded' });
    expect(parsed.issues[0]).toMatchObject({ category: 'render', occurrenceCount: 478 });
  });
});
