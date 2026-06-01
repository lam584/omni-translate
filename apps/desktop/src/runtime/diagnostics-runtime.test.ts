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
    mocks.invoke.mockImplementation(async (command: string) => ({ command }));

    expect(await runDiagnosticsSelfCheckRuntime()).toEqual({ command: 'run_diagnostics_self_check' });
    expect(await runSubtitleOverlaySelfCheckRuntime()).toEqual({ command: 'run_subtitle_overlay_self_check' });
    expect(await exportDiagnosticsBundleRuntime('quick')).toEqual({
      artifact: { command: 'export_diagnostics_bundle' },
      snapshot: { command: 'get_runtime_snapshot' },
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ['run_diagnostics_self_check'],
      ['run_subtitle_overlay_self_check'],
      ['export_diagnostics_bundle', { scope: 'quick' }],
      ['get_runtime_snapshot'],
    ]);
  });
});
