import { act } from 'react';
import { describe, expect, it } from 'vitest';

import type { WatchIssueRuntime, WatchSessionReportRuntime } from '../../schema/audio-runtime';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import WatchSessionReportPanel from './WatchSessionReportPanel';

function issue(
  code: string,
  severity: WatchIssueRuntime['severity'],
  occurrenceCount: number,
): WatchIssueRuntime {
  return {
    category: 'model',
    code,
    severity,
    message: `${code} 原始错误`,
    cueId: null,
    elapsedMs: 120,
    occurrenceCount,
  };
}

function reportFixture(): WatchSessionReportRuntime {
  return {
    sessionId: 'watch-session-render-test',
    status: 'completed',
    routeMode: 'watch',
    providerId: 'dashscope',
    model: 'qwen-realtime',
    startedAt: 'unix-ms:0',
    endedAt: 'unix-ms:500',
    elapsedMs: 500,
    summary: {
      durationMs: 500,
      cueCount: 0,
      completeCueCount: 0,
      visibleRenderCueCount: 0,
      unrenderedCueCount: 0,
      issueCount: 2,
      issueOccurrenceCount: 3,
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
    cues: [],
    events: [{
      eventId: 'session-event-1',
      stage: 'session',
      kind: 'provider-connect-failed',
      elapsedMs: 120,
      text: '',
      detail: 'upstream websocket closed unexpectedly',
      finalEvent: false,
      accepted: false,
      visible: null,
      callId: 'call-session-1',
      attemptId: 'attempt-session-2',
    }],
    issues: [
      issue('provider-connect-failed', 'error', 2),
      issue('provider-retry', 'warning', 1),
    ],
    droppedCueCount: 0,
    droppedEventCount: 0,
  };
}

describe('WatchSessionReportPanel rendering', () => {
  const view = registerDomHarness();

  it('renders classified issue counts and expands session-level technical events', async () => {
    await view.render(<WatchSessionReportPanel report={reportFixture()} />);

    expect(view.container.textContent).toContain('异常分类');
    expect(view.container.textContent).toContain('2 个问题类型 · 共 3 次');
    expect(view.container.textContent).toContain('模型与服务');
    expect(view.container.textContent).toContain('provider-connect-failed');
    expect(view.container.textContent).not.toContain('基准评分');

    const details = view.container.querySelector<HTMLDetailsElement>('.watch-report-session-events');
    expect(details?.textContent).toContain('会话级技术明细');
    await act(async () => {
      if (details) {
        details.open = true;
        details.dispatchEvent(new Event('toggle', { bubbles: true }));
      }
    });

    expect(details?.textContent).toContain('session · provider-connect-failed');
    expect(details?.textContent).toContain('call=call-session-1');
    expect(details?.textContent).toContain('attempt=attempt-session-2');
    expect(details?.textContent).toContain('upstream websocket closed unexpectedly');
  });
});
