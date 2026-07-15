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
  runDiagnosticsSelfCheckRuntime,
  runSubtitleOverlaySelfCheckRuntime,
} from './diagnostics-runtime';

describe('diagnostics runtime', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauriRuntime.mockReset().mockReturnValue(false);
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

  it('logs browser diagnostics locally with and without detail', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    appendFrontendDiagnosticsLog('runtime', 'info', 'ready');
    appendFrontendDiagnosticsLog('runtime', 'warning', 'degraded', 'driver missing');

    expect(logSpy).toHaveBeenCalledWith('[INFO] [runtime] ready');
    expect(logSpy).toHaveBeenCalledWith('[WARNING] [runtime] degraded\ndriver missing');
  });

  it('sends frontend diagnostics logs through Tauri and warns on failures', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error('log unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    appendFrontendDiagnosticsLog('runtime', 'error', 'failed');
    await Promise.resolve();

    expect(mocks.invoke).toHaveBeenCalledWith('append_frontend_diagnostics_log', {
      category: 'runtime',
      level: 'error',
      summary: 'failed',
      detail: null,
    });
    expect(warnSpy).toHaveBeenCalledWith('[diagnostics] append_frontend_diagnostics_log failed:', expect.any(Error));
  });
});
