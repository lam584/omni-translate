import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => (await import('../test-utils/tauri-invoke-mock')).tauriCoreMockModule());

import {
  appendFrontendDiagnosticsLog,
  exportDiagnosticsBundleRuntime,
  getRecentDiagnosticsLogsRuntime,
  openExportDirectoryRuntime,
  runDiagnosticsSelfCheckRuntime,
  runSubtitleOverlaySelfCheckRuntime,
} from './diagnostics-runtime';
import { getRecentFrontendLogEntries, loggerTestHelpers } from './logger';
import { invokeMock } from '../test-utils/tauri-invoke-mock';
import { enablePreviewDesktopRuntime, enableTauriDesktopRuntime } from '../test-utils/runtime-test-harness';

describe('diagnostics runtime', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enablePreviewDesktopRuntime();
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
    expect(full.artifact).toMatchObject({ fileCount: 7, outputPath: 'browser-preview/diagnostics-full.zip' });
    expect(full.snapshot.diagnostics).toMatchObject({ lastExportScope: 'full', lastExportPath: 'browser-preview/diagnostics-full.zip' });

    const quick = await exportDiagnosticsBundleRuntime('quick');
    expect(quick.artifact).toMatchObject({ fileCount: 3, outputPath: 'browser-preview/diagnostics-quick.zip' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('maps desktop self-checks and exports to native invoke commands', async () => {
    enableTauriDesktopRuntime();
    invokeMock.mockImplementation(async (command: string) =>
      command === 'diagnostics_v2' || command === 'configuration_v2'
        ? { data: { command }, warnings: [] }
        : { command },
    );

    expect(await runDiagnosticsSelfCheckRuntime()).toEqual({ command: 'diagnostics_v2' });
    expect(await runSubtitleOverlaySelfCheckRuntime()).toEqual({ command: 'diagnostics_v2' });
    expect(await exportDiagnosticsBundleRuntime('quick')).toEqual({
      artifact: { command: 'diagnostics_v2' },
      snapshot: { command: 'configuration_v2' },
    });
    expect(invokeMock.mock.calls).toEqual([
      ['diagnostics_v2', { command: { action: 'selfCheck' } }],
      ['diagnostics_v2', { command: { action: 'overlaySelfCheck' } }],
      ['diagnostics_v2', { command: { action: 'export', scope: 'quick' } }],
      ['configuration_v2', { command: { action: 'runtimeSnapshot' } }],
    ]);
  });

  it('opens an exported artifact through the diagnostics command boundary', async () => {
    enableTauriDesktopRuntime();
    invokeMock.mockResolvedValue({ data: null, warnings: [] });

    await expect(openExportDirectoryRuntime('C:/exports/report.zip')).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('diagnostics_v2', {
      command: { action: 'openExportDirectory', outputPath: 'C:/exports/report.zip' },
    });
  });

  it('mirrors browser diagnostics to the console with and without detail', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    appendFrontendDiagnosticsLog('runtime', 'info', 'ready');
    appendFrontendDiagnosticsLog('runtime', 'warning', 'degraded', 'driver missing');
    appendFrontendDiagnosticsLog('runtime', 'debug', 'trace');

    expect(infoSpy).toHaveBeenCalledWith('[omni][runtime]', 'ready');
    expect(warnSpy).toHaveBeenCalledWith('[omni][runtime]', 'degraded', 'driver missing');
    expect(debugSpy).toHaveBeenCalledWith('[omni][runtime]', 'trace');
    expect(getRecentFrontendLogEntries().map((entry) => entry.summary)).toEqual(['ready', 'degraded', 'trace']);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('forwards batched frontend diagnostics logs and retains entries on IPC failure', async () => {
    vi.useFakeTimers();
    try {
      enableTauriDesktopRuntime();
      invokeMock.mockRejectedValue(new Error('log unavailable'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      appendFrontendDiagnosticsLog('runtime', 'error', 'failed');
      // Error-level entries take the urgent flush path (0ms timer).
      await vi.advanceTimersByTimeAsync(0);

      expect(invokeMock).toHaveBeenCalledWith('append_frontend_diagnostics_logs', {
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

      invokeMock.mockClear();
      invokeMock.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(loggerTestHelpers.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no recent native logs in browser preview mode', async () => {
    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('maps recent native log IPC responses and missing arrays', async () => {
    enableTauriDesktopRuntime();
    const entry = {
      id: 'route-ready',
      category: 'runtime',
      level: 'info',
      summary: 'watch_mode.route_ready',
      detail: null,
      emittedAt: '2026-07-25T00:00:00.000Z',
    } as const;
    invokeMock
      .mockResolvedValueOnce({ data: { recentLogs: [entry] }, warnings: [] })
      .mockResolvedValueOnce({ data: {}, warnings: [] });

    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([entry]);
    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'diagnostics_v2', { command: { action: 'snapshot' } });
  });

  it('degrades failed recent-log IPC reads to an empty list', async () => {
    enableTauriDesktopRuntime();
    invokeMock.mockRejectedValue(new Error('diagnostics unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(getRecentDiagnosticsLogsRuntime()).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith('[omni][runtime]', 'get_diagnostics_snapshot failed', 'diagnostics unavailable');
  });
});
