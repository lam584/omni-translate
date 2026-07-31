import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => (await import('../test-utils/tauri-invoke-mock')).tauriCoreMockModule());

import type { WatchSessionReportRuntime } from '../schema/audio-runtime';
import { invokeMock } from '../test-utils/tauri-invoke-mock';
import { enablePreviewDesktopRuntime, enableTauriDesktopRuntime } from '../test-utils/runtime-test-harness';
import {
  clearWatchSessionReportRuntime,
  getWatchSessionReportRuntime,
} from './watch-session-report-runtime';

const report: WatchSessionReportRuntime = {
  sessionId: 'watch-session-1',
  status: 'completed',
  routeMode: 'watch',
  providerId: 'openai',
  model: 'gpt-realtime',
  startedAt: 'unix-ms:1000',
  endedAt: 'unix-ms:1600',
  elapsedMs: 600,
  summary: {
    durationMs: 600,
    cueCount: 0,
    completeCueCount: 0,
    visibleRenderCueCount: 0,
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
  cues: [],
  events: [],
  issues: [],
  droppedCueCount: 0,
  droppedEventCount: 0,
};

describe('watch session report runtime', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enablePreviewDesktopRuntime();
  });

  it('returns no retained report in browser preview mode', async () => {
    await expect(getWatchSessionReportRuntime()).resolves.toBeNull();
    await expect(clearWatchSessionReportRuntime()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('reads and clears the report through diagnostics_v2 in Tauri mode', async () => {
    enableTauriDesktopRuntime();
    invokeMock
      .mockResolvedValueOnce({ data: report, warnings: [] })
      .mockResolvedValueOnce({ data: null, warnings: [] });

    await expect(getWatchSessionReportRuntime()).resolves.toEqual(report);
    await expect(clearWatchSessionReportRuntime()).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'diagnostics_v2', {
      command: { action: 'watchSessionReport' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'diagnostics_v2', {
      command: { action: 'clearWatchSessionReport' },
    });
  });

  it('propagates native failures', async () => {
    enableTauriDesktopRuntime();
    invokeMock.mockRejectedValue(new Error('command not found'));

    await expect(getWatchSessionReportRuntime()).rejects.toThrow('command not found');
  });
});
