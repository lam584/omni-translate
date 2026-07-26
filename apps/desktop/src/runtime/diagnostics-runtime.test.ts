import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('./tauri-runtime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime(),
}));

import {
  appendFrontendDiagnosticsLog,
  exportDiagnosticsBundleRuntime,
  getRecentDiagnosticsLogsRuntime,
  runDiagnosticsSelfCheckRuntime,
  runSubtitleOverlaySelfCheckRuntime,
} from './diagnostics-runtime';
import { getRecentFrontendLogEntries, loggerTestHelpers } from './logger';

describe('diagnostics runtime', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauriRuntime.mockReset().mockReturnValue(false);
    loggerTestHelpers.reset();
  });

  it('provides browser preview self-checks and both export scopes', async () => {
    expect((await runDiagnosticsSelfCheckRuntime()).diagnostics).toMatchObject({
      status: 'ready',
      driverStatus: 'warning',
      deviceStatus: 'warning',
    });
    expect((await runSubtitleOverlaySelfCheckRuntime()).bridgeStatus).toBe('browser-preview');

    const full = await exportDiagnosticsBundleRuntime('full');
    expect(full.artifact).toMatchObject({ fileCount: 6, outputPath: 'browser-preview/diagnostics-full.zip' });
    expect(full.snapshot.diagnostics).toMatchObject({ lastExportScope: 'full', lastExportPath: 'browser-preview/diagnostics-full.zip' });

    const quick = await exportDiagnosticsBundleRuntime('quick');
    expect(quick.artifact).toMatchObject({ fileCount: 3, outputPath: 'browser-preview/diagnostics-quick.zip' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('maps desktop self-checks and exports to native invoke commands', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'diagnostics_v2'
        ? { data: { command }, warnings: [] }
        : { command },
    );

    expect(await runDiagnosticsSelfCheckRuntime()).toEqual({ command: 'diagnostics_v2' });
    expect(await runSubtitleOverlaySelfCheckRuntime()).toEqual({ command: 'diagnostics_v2' });
    expect(await exportDiagnosticsBundleRuntime('quick')).toEqual({
      artifact: { command: 'diagnostics_v2' },
      snapshot: { command: 'get_runtime_snapshot' },
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ['diagnostics_v2', { command: { action: 'selfCheck' } }],
      ['diagnostics_v2', { command: { action: 'overlaySelfCheck' } }],
      ['diagnostics_v2', { command: { action: 'export', scope: 'quick' } }],
      ['get_runtime_snapshot'],
    ]);
  });

  it('mirrors browser diagnostics to the console with and without detail', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    appendFrontendDiagnosticsLog('runtime', 'info', 'ready');
    appendFrontendDiagnosticsLog('runtime', 'warning', 'degraded', 'driver missing');

    expect(infoSpy).toHaveBeenCalledWith('[omni][runtime]', 'ready');
    expect(warnSpy).toHaveBeenCalledWith('[omni][runtime]', 'degraded', 'driver missing');
    expect(getRecentFrontendLogEntries().map((entry) => entry.summary)).toEqual(['ready', 'degraded']);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('forwards batched frontend diagnostics logs and retains entries on IPC failure', async () => {
    vi.useFakeTimers();
    try {
      mocks.isTauriRuntime.mockReturnValue(true);
      mocks.invoke.mockRejectedValue(new Error('log unavailable'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      appendFrontendDiagnosticsLog('runtime', 'error', 'failed');
      // Error-level entries take the urgent flush path (0ms timer).
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.invoke).toHaveBeenCalledWith('append_frontend_diagnostics_logs', {
        entries: [
          expect.objectContaining({
            category: 'runtime',
            level: 'error',
            summary: 'failed',
            detail: null,
          }),
        ],
        droppedCount: 0,
      });
      // The failed batch stays buffered for the exponential-backoff retry.
      expect(loggerTestHelpers.pendingCount()).toBe(1);

      mocks.invoke.mockClear();
      mocks.invoke.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(loggerTestHelpers.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no recent native logs in browser preview mode', async () => {
    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('maps recent native log IPC responses and missing arrays', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    const entry = {
      id: 'route-ready',
      category: 'runtime',
      level: 'info',
      summary: 'watch_mode.route_ready',
      detail: null,
      emittedAt: '2026-07-25T00:00:00.000Z',
    } as const;
    mocks.invoke.mockResolvedValueOnce({ recentLogs: [entry] }).mockResolvedValueOnce({});

    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([entry]);
    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([]);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'get_diagnostics_snapshot');
  });

  it('degrades failed recent-log IPC reads to an empty list', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error('diagnostics unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith('[omni][runtime]', 'get_diagnostics_snapshot failed', 'diagnostics unavailable');
  });
});
