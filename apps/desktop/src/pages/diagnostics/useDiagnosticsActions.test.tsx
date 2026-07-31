import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { useDiagnosticsWorkbenchController, type DiagnosticsRepairTask } from './useDiagnosticsActions';

const runtime = vi.hoisted(() => ({
  clearReport: vi.fn(), exportBundle: vi.fn(), getReport: vi.fn(), isTauri: vi.fn(), refreshBridge: vi.fn(),
  selfCheck: vi.fn(), overlaySelfCheck: vi.fn(), openExportDirectory: vi.fn(),
}));

vi.mock('../../runtime/diagnostics-runtime', () => ({
  exportDiagnosticsBundleRuntime: runtime.exportBundle,
  openExportDirectoryRuntime: runtime.openExportDirectory,
  runDiagnosticsSelfCheckRuntime: runtime.selfCheck,
  runSubtitleOverlaySelfCheckRuntime: runtime.overlaySelfCheck,
}));
vi.mock('../../runtime/watch-session-report-runtime', () => ({
  clearWatchSessionReportRuntime: runtime.clearReport,
  getWatchSessionReportRuntime: runtime.getReport,
}));
vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopCapabilities: () => ({ hasNativeShell: Boolean(runtime.isTauri()) }),
}));
vi.mock('../../runtime/bridge-runtime', () => ({ refreshBridgeRuntime: runtime.refreshBridge }));

describe('useDiagnosticsWorkbenchController', () => {
  let controller: ReturnType<typeof useDiagnosticsWorkbenchController>;
  let repairs: DiagnosticsRepairTask[];
  let selected: string[];
  let snapshot: RuntimeSnapshot;

  function Harness() {
    controller = useDiagnosticsWorkbenchController(repairs, selected);
    return null;
  }

  const view = registerDomHarness({
    setup: () => {
      vi.clearAllMocks();
      snapshot = useAppStore.getState().runtimeSnapshot;
      repairs = [];
      selected = [];
      runtime.isTauri.mockReturnValue(false);
      runtime.refreshBridge.mockResolvedValue(snapshot);
      runtime.selfCheck.mockResolvedValue(snapshot);
      runtime.overlaySelfCheck.mockResolvedValue(snapshot);
      runtime.exportBundle.mockResolvedValue({
        artifact: { scope: 'full', outputPath: 'C:\\diagnostics.zip', generatedAt: '2026-07-27T00:00:00.000Z', fileCount: 3 },
        snapshot,
      });
      runtime.clearReport.mockResolvedValue(undefined);
      runtime.getReport.mockResolvedValue(null);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
    },
    beforeUnmount: () => {
      vi.restoreAllMocks();
    },
  });

  async function mount() {
    await view.render(<Harness />);
  }

  it('does nothing when no repair is selected', async () => {
    await mount();
    await act(async () => controller.runAutomaticRepair());
    expect(controller.busyAction).toBeNull();
  });

  it('records non-Error repair failures without publishing success', async () => {
    repairs = [{ id: 'bad', label: 'Broken', run: vi.fn().mockRejectedValue('offline') }];
    selected = ['bad'];
    await mount();
    await act(async () => controller.runAutomaticRepair());
    const notification = useAppStore.getState().runtimeNotifications.find((item) => item.id.startsWith('auto-repair-bad-'));
    expect(notification?.message).toContain('offline');
    expect(controller.actionFeedback?.tone).toBe('error');
    expect(controller.actionFeedback?.detail).toContain('offline');
  });

  it('refreshes a native bridge after successful repairs', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    repairs = [{ id: 'ok', label: 'Repair', run }];
    selected = ['ok'];
    runtime.isTauri.mockReturnValue(true);
    await mount();
    await act(async () => controller.runAutomaticRepair());
    expect(run).toHaveBeenCalledOnce();
    expect(runtime.refreshBridge).toHaveBeenCalledOnce();
    expect(controller.actionFeedback?.tone).toBe('ready');
  });

  it('keeps repair results visible when the post-repair refresh fails', async () => {
    repairs = [{ id: 'ok', label: 'Repair', run: vi.fn().mockResolvedValue(undefined) }];
    selected = ['ok'];
    runtime.isTauri.mockReturnValue(true);
    runtime.refreshBridge.mockRejectedValue(new Error('bridge offline'));
    await mount();
    await act(async () => controller.runAutomaticRepair());
    expect(controller.actionFeedback?.tone).toBe('error');
    expect(controller.actionFeedback?.detail).toContain('bridge offline');
  });

  it('turns rejected workbench actions into visible feedback', async () => {
    runtime.selfCheck.mockRejectedValue(new Error('ipc timeout'));
    await mount();
    await act(async () => controller.runSelfCheck());
    expect(controller.actionFeedback?.tone).toBe('error');
    expect(controller.actionFeedback?.detail).toBe('ipc timeout');
    expect(controller.busyAction).toBeNull();
  });

  it('reports diagnostics export success and failure', async () => {
    await mount();
    await act(async () => controller.runExportAction('full'));
    expect(controller.actionFeedback?.tone).toBe('ready');
    expect(controller.actionFeedback?.detail).toContain('C:\\diagnostics.zip');

    runtime.exportBundle.mockRejectedValue(new Error('disk full'));
    await act(async () => controller.runExportAction('full'));
    expect(controller.actionFeedback?.tone).toBe('error');
    expect(controller.actionFeedback?.detail).toBe('disk full');
  });

  it('keeps a native repair failure after the refreshed snapshot replaces notifications', async () => {
    repairs = [{
      id: 'bad',
      label: 'Repair',
      run: vi.fn().mockRejectedValue({ code: 'bridge.failed', message: 'repair failed', retriable: true }),
    }];
    selected = ['bad'];
    runtime.isTauri.mockReturnValue(true);
    runtime.refreshBridge.mockResolvedValue({ ...snapshot, notifications: [] });
    await mount();
    await act(async () => controller.runAutomaticRepair());
    const notification = useAppStore.getState().runtimeNotifications
      .find((item) => item.id.startsWith('auto-repair-bad-'));
    expect(notification?.message).toContain('repair failed (bridge.failed)');
  });

  it('does not create a full diagnostics bundle when the sensitive-content warning is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await mount();

    await act(async () => controller.runExportAction('full'));

    expect(runtime.exportBundle).not.toHaveBeenCalled();
    expect(controller.busyAction).toBeNull();
  });

  it('runs every workbench action and watch-report transition', async () => {
    await mount();
    await act(async () => controller.runSelfCheck());
    await act(async () => controller.runOverlaySelfCheck());
    await act(async () => controller.runBridgeRefresh());
    await act(async () => controller.runExportAction('full'));
    await act(async () => controller.openWatchReportModal());
    expect(controller.watchReportModalOpen).toBe(true);
    expect(controller.watchReport).toBeNull();
    await act(async () => controller.refreshWatchReport());
    await act(async () => controller.clearWatchReport());
    expect(runtime.clearReport).toHaveBeenCalledOnce();
    await act(async () => controller.closeWatchReportModal());
    expect(controller.watchReportModalOpen).toBe(false);
  });

  it('distinguishes a watch-report read failure from an empty report', async () => {
    runtime.getReport.mockRejectedValue(new Error('report store unavailable'));
    await mount();
    await act(async () => controller.openWatchReportModal());
    expect(controller.watchReportModalOpen).toBe(true);
    expect(controller.watchReport).toBeNull();
    expect(controller.watchReportError).toBe('report store unavailable');
    expect(controller.watchReportLoading).toBe(false);
  });
});
