import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { useDiagnosticsWorkbenchController, type DiagnosticsRepairTask } from './useDiagnosticsActions';

const runtime = vi.hoisted(() => ({
  exportBundle: vi.fn(), getEvents: vi.fn(), isTauri: vi.fn(), refreshBridge: vi.fn(),
  selfCheck: vi.fn(), overlaySelfCheck: vi.fn(),
}));

vi.mock('../../runtime/diagnostics-runtime', () => ({
  exportDiagnosticsBundleRuntime: runtime.exportBundle,
  runDiagnosticsSelfCheckRuntime: runtime.selfCheck,
  runSubtitleOverlaySelfCheckRuntime: runtime.overlaySelfCheck,
}));
vi.mock('../../runtime/live-session-events-runtime', () => ({ getLiveSessionEventsRuntime: runtime.getEvents }));
vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopCapabilities: () => ({ hasNativeShell: Boolean(runtime.isTauri()) }),
}));
vi.mock('../../runtime/bridge-runtime', () => ({ refreshBridgeRuntime: runtime.refreshBridge }));

describe('useDiagnosticsWorkbenchController', () => {
  let root: Root;
  let container: HTMLDivElement;
  let controller: ReturnType<typeof useDiagnosticsWorkbenchController>;
  let repairs: DiagnosticsRepairTask[];
  let selected: string[];
  let snapshot: RuntimeSnapshot;

  function Harness() {
    controller = useDiagnosticsWorkbenchController(repairs, selected);
    return null;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    snapshot = useAppStore.getState().runtimeSnapshot;
    repairs = [];
    selected = [];
    runtime.isTauri.mockReturnValue(false);
    runtime.refreshBridge.mockResolvedValue(snapshot);
    runtime.selfCheck.mockResolvedValue(snapshot);
    runtime.overlaySelfCheck.mockResolvedValue(snapshot);
    runtime.exportBundle.mockResolvedValue({ snapshot });
    runtime.getEvents.mockResolvedValue({ events: [], truncated: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function mount() {
    await act(async () => root.render(<Harness />));
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
    expect(useAppStore.getState().runtimeNotifications.at(-1)?.message).toContain('repair failed (bridge.failed)');
  });

  it('runs every workbench action and live-event transition', async () => {
    await mount();
    await act(async () => controller.runSelfCheck());
    await act(async () => controller.runOverlaySelfCheck());
    await act(async () => controller.runBridgeRefresh());
    await act(async () => controller.runExportAction('full'));
    await act(async () => controller.openLiveEventsModal());
    expect(controller.liveEventsModalOpen).toBe(true);
    expect(controller.liveEvents).toEqual({ events: [], truncated: false });
    await act(async () => controller.refreshLiveEvents());
    await act(async () => controller.closeLiveEventsModal());
    expect(controller.liveEventsModalOpen).toBe(false);
  });
});
