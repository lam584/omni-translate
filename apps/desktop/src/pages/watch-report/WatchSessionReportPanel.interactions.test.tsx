import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WatchCueComparisonRuntime,
  WatchIssueRuntime,
  WatchSessionReportRuntime,
  WatchTimelineEventRuntime,
} from '../../schema/audio-runtime';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { buttonByText, click, selectValue } from '../../test-utils/dom-interactions';

const runtimeSpies = vi.hoisted(() => ({
  exportReport: vi.fn(),
  openExportDirectory: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('./watchSessionReportFormat', async (importOriginal) => ({
  ...await importOriginal<typeof import('./watchSessionReportFormat')>(),
  exportWatchSessionReport: runtimeSpies.exportReport,
}));

vi.mock('../../runtime/diagnostics-runtime', () => ({
  openExportDirectoryRuntime: runtimeSpies.openExportDirectory,
}));

import WatchSessionReportPanel from './WatchSessionReportPanel';

const statuses: WatchCueComparisonRuntime['comparisonStatus'][] = [
  'exact',
  'formatting-only',
  'different',
  'not-published',
  'not-rendered',
  'model-error',
  'superseded',
  'pending',
];

function timelineEvent(
  eventId: string,
  overrides: Partial<WatchTimelineEventRuntime> = {},
): WatchTimelineEventRuntime {
  return {
    eventId,
    stage: 'model',
    kind: 'translation-delta',
    elapsedMs: 40,
    text: '',
    detail: null,
    finalEvent: false,
    accepted: true,
    visible: null,
    callId: null,
    attemptId: null,
    ...overrides,
  };
}

function issue(
  category: WatchIssueRuntime['category'],
  cueId: string | null,
  severity: WatchIssueRuntime['severity'] = 'warning',
  occurrenceCount = 1,
): WatchIssueRuntime {
  return {
    category,
    code: `${category}-problem`,
    severity,
    message: `${category} evidence`,
    cueId,
    elapsedMs: 60,
    occurrenceCount,
  };
}

function cue(
  status: WatchCueComparisonRuntime['comparisonStatus'],
  index: number,
  issues: WatchIssueRuntime[] = [],
): WatchCueComparisonRuntime {
  const cueId = `cue-${status}`;
  return {
    cueId,
    revision: index % 2 ? 2 : 1,
    routeDirection: 'inbound',
    translationPath: index === 0 ? '' : 'provider-realtime',
    sourceText: index === 1 ? '' : `source-${index}`,
    llmText: index === 2 ? '' : `llm-${index}`,
    publishedText: index === 3 ? '' : `published-${index}`,
    publishedSegments: [],
    renderedSourceText: '',
    renderedText: index === 4 ? '' : `rendered-${index}`,
    comparisonStatus: status,
    sourceAtMs: index < 2 ? 100 : index * 100,
    llmFirstAtMs: 10,
    llmFinalAtMs: 20,
    publishedFirstAtMs: 30,
    publishedFinalAtMs: 40,
    renderedFirstAtMs: 50,
    renderedFinalAtMs: 60,
    sourceToLlmFirstMs: index === 0 ? null : 10 + index,
    sourceToRenderMs: index === 0 ? null : 800 - index * 50,
    llmFirstToPublishMs: index === 1 ? null : 20,
    publishToRenderMs: index === 2 ? null : 30,
    llmFirstToRenderMs: index === 3 ? null : 40,
    llmFinalToPublishMs: index === 4 ? null : 50,
    publishedFinalToRenderMs: index === 5 ? null : 60,
    llmFinalToRenderMs: null,
    events: index === 0 ? [
      timelineEvent('cue-event-visible', {
        text: 'event text',
        detail: 'event detail',
        visible: true,
        callId: 'call-1',
        attemptId: 'attempt-1',
      }),
      timelineEvent('cue-event-hidden', { accepted: false, visible: false }),
    ] : [],
    issues,
    droppedEventCount: 0,
  };
}

function reportFixture(overrides: Partial<WatchSessionReportRuntime> = {}): WatchSessionReportRuntime {
  const cues = statuses.map((status, index) => cue(
    status,
    index,
    index === 0 ? [issue('model', `cue-${status}`, 'error', 2)]
      : index === 2 ? [issue('content', `cue-${status}`)]
        : [],
  ));
  const issues = [
    issue('session', null, 'error', 3),
    issue('output', null, 'warning', 2),
  ];
  return {
    sessionId: 'watch-interactions',
    status: 'active',
    routeMode: 'watch',
    providerId: '',
    model: '',
    startedAt: 'unix-ms:0',
    endedAt: null,
    elapsedMs: 900,
    summary: {
      durationMs: 900,
      cueCount: cues.length,
      completeCueCount: 3,
      visibleRenderCueCount: 4,
      unrenderedCueCount: 2,
      issueCount: 4,
      issueOccurrenceCount: 8,
      averageSourceToLlmFirstMs: 40,
      p95SourceToLlmFirstMs: 70,
      maxSourceToLlmFirstMs: 80,
      averageSourceToRenderMs: 500,
      p95SourceToRenderMs: 700,
      maxSourceToRenderMs: 750,
      averageLlmFirstToRenderMs: 300,
      p95LlmFirstToRenderMs: 400,
      maxLlmFirstToRenderMs: 450,
      averageLlmFinalToRenderMs: 200,
      p95LlmFinalToRenderMs: 300,
      maxLlmFinalToRenderMs: 350,
      slowestCueId: 'cue-formatting-only',
    },
    cues,
    events: [timelineEvent('session-event', {
      stage: 'session',
      kind: 'route-ready',
      finalEvent: true,
      text: 'session text',
      detail: 'session detail',
    })],
    issues,
    droppedCueCount: 0,
    droppedEventCount: 0,
    ...overrides,
  };
}

describe('WatchSessionReportPanel interactions', () => {
  const view = registerDomHarness();

  beforeEach(() => {
    runtimeSpies.exportReport.mockReset();
    runtimeSpies.openExportDirectory.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders every cue state and applies issue, difference, category, latency and sequence controls', async () => {
    await view.render(<WatchSessionReportPanel report={reportFixture()} />);

    expect(view.container.textContent).toContain('watchReport.modelFallback');
    expect(view.container.textContent).toContain('session-problem');
    expect(view.container.querySelector('.watch-report-session-events')).not.toBeNull();

    const selects = Array.from(view.container.querySelectorAll<HTMLSelectElement>('.watch-report-controls select'));
    await selectValue(selects[0]!, 'different');
    expect(view.container.querySelectorAll('.watch-report-cue')).toHaveLength(2);

    await selectValue(selects[0]!, 'all');
    expect(view.container.querySelectorAll('.watch-report-cue')).toHaveLength(statuses.length);
    for (const status of statuses) {
      expect(view.container.textContent).toContain(`cue-${status}`);
    }

    await selectValue(selects[1]!, 'latency');
    expect(view.container.querySelector('.watch-report-cue strong')?.textContent).toBe('cue-formatting-only');
    await selectValue(selects[1]!, 'sequence');
    expect(view.container.querySelector('.watch-report-cue strong')?.textContent).toBe('cue-exact');

    await selectValue(selects[2]!, 'model');
    expect(view.container.querySelectorAll('.watch-report-cue')).toHaveLength(1);
    expect(view.container.textContent).toContain('cue-exact');
    await selectValue(selects[2]!, 'all');

    const details = Array.from(view.container.querySelectorAll<HTMLDetailsElement>('.watch-report-events'));
    await act(async () => {
      for (const element of details) {
        element.open = true;
        element.dispatchEvent(new Event('toggle', { bubbles: true }));
      }
    });
    expect(view.container.textContent).toContain('call=call-1');
    expect(view.container.textContent).toContain('attempt=attempt-1');
    expect(view.container.textContent).toContain('event detail');
    expect(view.container.textContent).toContain('watchReport.visible');
    expect(view.container.textContent).toContain('watchReport.hidden');
    expect(view.container.textContent).toContain('watchReport.rejected');
  });

  it('handles refresh, clear and export success, cancellation, and rejection', async () => {
    const onRefresh = vi.fn().mockRejectedValueOnce(new Error('refresh failed'));
    const onClear = vi.fn().mockResolvedValue(undefined);
    const onExported = vi.fn();
    runtimeSpies.exportReport.mockResolvedValue({ outputPath: 'C:/reports/watch.json', fileCount: 1 });
    await view.render(
      <WatchSessionReportPanel
        onClear={onClear}
        onExported={onExported}
        onRefresh={onRefresh}
        report={reportFixture()}
      />,
    );

    await click(buttonByText(view.container, 'watchReport.refresh'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('refresh failed');
    await click(buttonByText(view.container, 'watchReport.clear'));
    expect(onClear).toHaveBeenCalledOnce();

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await click(buttonByText(view.container, 'JSON'));
    expect(runtimeSpies.exportReport).not.toHaveBeenCalled();

    await click(buttonByText(view.container, 'JSON'));
    expect(runtimeSpies.exportReport).toHaveBeenCalledWith(expect.any(Object), 'json');
    expect(onExported).toHaveBeenCalledWith({ outputPath: 'C:/reports/watch.json', fileCount: 1 });
    expect(view.container.querySelector<HTMLInputElement>('.watch-report-export-path')?.value).toBe('C:/reports/watch.json');

    runtimeSpies.exportReport.mockRejectedValueOnce('TXT route failed');
    await click(buttonByText(view.container, 'TXT'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('TXT route failed');
  });

  it('copies and opens an existing receipt while surfacing clipboard and folder failures', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce('clipboard denied');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    runtimeSpies.openExportDirectory.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('folder denied'));
    await view.render(
      <WatchSessionReportPanel
        lastExportReceipt={{ outputPath: 'D:/exports/watch.txt', fileCount: 1 }}
        report={reportFixture()}
      />,
    );

    const pathInput = view.container.querySelector<HTMLInputElement>('.watch-report-export-path')!;
    const select = vi.spyOn(pathInput, 'select');
    pathInput.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pathInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(select).toHaveBeenCalledTimes(2);

    await click(buttonByText(view.container, 'watchReport.copyPath'));
    expect(writeText).toHaveBeenCalledWith('D:/exports/watch.txt');
    expect(view.container.textContent).toContain('watchReport.pathCopied');
    await click(buttonByText(view.container, 'watchReport.pathCopied'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('clipboard denied');

    await click(buttonByText(view.container, 'diagnostics.actions.openExportDirectory'));
    expect(runtimeSpies.openExportDirectory).toHaveBeenCalledWith('D:/exports/watch.txt');
    await click(buttonByText(view.container, 'diagnostics.actions.openExportDirectory'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('folder denied');
  });

  it('renders loading, explicit error, and empty states without a report', async () => {
    await view.render(<WatchSessionReportPanel loading report={null} />);
    expect(view.container.textContent).toContain('watchReport.loading');

    await view.render(<WatchSessionReportPanel error="report unavailable" report={null} />);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('report unavailable');

    await view.render(<WatchSessionReportPanel report={null} />);
    expect(view.container.textContent).toContain('watchReport.empty');
  });
});
