import { useState } from 'react';
import i18n from '../../i18n/config';
import { refreshBridgeRuntime } from '../../runtime/bridge-runtime';
import {
  exportDiagnosticsBundleRuntime,
  runDiagnosticsSelfCheckRuntime,
  runSubtitleOverlaySelfCheckRuntime,
} from '../../runtime/diagnostics-runtime';
import { getLiveSessionEventsRuntime, type LiveSessionEvents } from '../../runtime/live-session-events-runtime';
import { useDesktopCapabilities } from '../../runtime/desktop-api-context';
import type { DiagnosticsExportScope } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';

export type DiagnosticsRepairTask = { id: string; label: string; run: () => Promise<void> };

export function useDiagnosticsWorkbenchController(repairOptions: DiagnosticsRepairTask[], selectedRepairIds: string[]) {
  const { hasNativeShell } = useDesktopCapabilities();
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const pushRuntimeNotification = useAppStore((state) => state.pushRuntimeNotification);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [liveEventsModalOpen, setLiveEventsModalOpen] = useState(false);
  const [liveEvents, setLiveEvents] = useState<LiveSessionEvents | null>(null);
  const [liveEventsLoading, setLiveEventsLoading] = useState(false);

  const runBusyAction = async (actionId: string, runner: () => Promise<RuntimeSnapshot>) => {
    setBusyAction(actionId);
    try {
      setRuntimeSnapshot(await runner());
    } finally {
      setBusyAction(null);
    }
  };

  const runAutomaticRepair = async () => {
    const selected = repairOptions.filter((option) => selectedRepairIds.includes(option.id));
    if (selected.length === 0) return;
    setBusyAction('auto-repair');
    try {
      const failures: string[] = [];
      for (const option of selected) {
        try {
          await option.run();
        } catch (error) {
          failures.push(option.label);
          pushRuntimeNotification({
            id: `auto-repair-${option.id}-${Date.now()}`,
            level: 'error', source: 'diagnostics',
            message: i18n.t('diagnostics.notifications.autoRepairFailed', { label: option.label, error: error instanceof Error ? error.message : String(error) }),
            emittedAt: new Date().toISOString(),
          });
        }
      }
      if (hasNativeShell) setRuntimeSnapshot(await refreshBridgeRuntime());
      if (failures.length === 0) {
        pushRuntimeNotification({
          id: `auto-repair-success-${Date.now()}`,
          level: 'info', source: 'diagnostics',
          message: i18n.t('diagnostics.notifications.autoRepairSuccess', { count: selected.length }),
          emittedAt: new Date().toISOString(),
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const runExportAction = async (scope: DiagnosticsExportScope) => {
    setBusyAction('export');
    try {
      const result = await exportDiagnosticsBundleRuntime(scope);
      setRuntimeSnapshot(result.snapshot);
      updateDiagnosticsDraft({ lastExportScope: scope });
    } finally {
      setBusyAction(null);
    }
  };

  const refreshLiveEvents = async () => {
    setLiveEventsLoading(true);
    try {
      setLiveEvents(await getLiveSessionEventsRuntime());
    } finally {
      setLiveEventsLoading(false);
    }
  };

  const openLiveEventsModal = async () => {
    setLiveEventsModalOpen(true);
    await refreshLiveEvents();
  };

  return {
    busyAction, liveEvents, liveEventsLoading, liveEventsModalOpen,
    closeLiveEventsModal: () => setLiveEventsModalOpen(false),
    openLiveEventsModal, refreshLiveEvents, runAutomaticRepair, runBusyAction, runExportAction,
    runSelfCheck: () => runBusyAction('self-check', runDiagnosticsSelfCheckRuntime),
    runOverlaySelfCheck: () => runBusyAction('overlay-self-check', runSubtitleOverlaySelfCheckRuntime),
    runBridgeRefresh: () => runBusyAction('bridge-refresh', refreshBridgeRuntime),
  };
}

export const useDiagnosticsActions = useDiagnosticsWorkbenchController;
