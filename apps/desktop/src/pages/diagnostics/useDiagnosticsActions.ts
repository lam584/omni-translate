import { useState } from 'react';
import i18n from '../../i18n/config';
import { refreshBridgeRuntime } from '../../runtime/bridge-runtime';
import {
  exportDiagnosticsBundleRuntime,
  openExportDirectoryRuntime,
  runDiagnosticsSelfCheckRuntime,
  runSubtitleOverlaySelfCheckRuntime,
} from '../../runtime/diagnostics-runtime';
import {
  clearWatchSessionReportRuntime,
  getWatchSessionReportRuntime,
} from '../../runtime/watch-session-report-runtime';
import type { WatchSessionReportRuntime } from '../../schema/audio-runtime';
import { useDesktopCapabilities } from '../../runtime/desktop-api-context';
import type { DiagnosticsExportScope } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { describeUnknownError } from '../../utils/describe-unknown-error';

export type DiagnosticsRepairTask = { id: string; label: string; run: () => Promise<void> };

export type DiagnosticsActionFeedback = {
  tone: 'ready' | 'warning' | 'error';
  title: string;
  detail?: string;
  outputPath?: string;
};

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useDiagnosticsWorkbenchController(repairOptions: DiagnosticsRepairTask[], selectedRepairIds: string[]) {
  const { hasNativeShell } = useDesktopCapabilities();
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const pushRuntimeNotification = useAppStore((state) => state.pushRuntimeNotification);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<DiagnosticsActionFeedback | null>(null);
  const [watchReportModalOpen, setWatchReportModalOpen] = useState(false);
  const [watchReport, setWatchReport] = useState<WatchSessionReportRuntime | null>(null);
  const [watchReportError, setWatchReportError] = useState<string | null>(null);
  const [watchReportLoading, setWatchReportLoading] = useState(false);

  const runBusyAction = async (actionId: string, actionLabel: string, runner: () => Promise<RuntimeSnapshot>) => {
    setBusyAction(actionId);
    setActionFeedback(null);
    try {
      setRuntimeSnapshot(await runner());
    } catch (error) {
      setActionFeedback({
        tone: 'error',
        title: `${actionLabel} · ${i18n.t('diagnostics.status.failed')}`,
        detail: errorDetail(error),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const runAutomaticRepair = async () => {
    const selected = repairOptions.filter((option) => selectedRepairIds.includes(option.id));
    if (selected.length === 0) return;
    setBusyAction('auto-repair');
    setActionFeedback(null);
    try {
      const failures: Array<{ id: string; label: string; error: unknown }> = [];
      for (const option of selected) {
        try {
          await option.run();
        } catch (error) {
          failures.push({ id: option.id, label: option.label, error });
        }
      }
      if (hasNativeShell) {
        try {
          setRuntimeSnapshot(await refreshBridgeRuntime());
        } catch (error) {
          failures.push({
            id: 'refresh-runtime',
            label: i18n.t('diagnostics.actions.refreshRuntime'),
            error,
          });
        }
      }
      for (const failure of failures) {
        pushRuntimeNotification({
          id: `auto-repair-${failure.id}-${Date.now()}`,
          level: 'error', source: 'diagnostics',
          message: i18n.t('diagnostics.notifications.autoRepairFailed', {
            label: failure.label,
            error: describeUnknownError(failure.error),
          }),
          emittedAt: new Date().toISOString(),
        });
      }
      if (failures.length === 0) {
        const message = i18n.t('diagnostics.notifications.autoRepairSuccess', { count: selected.length });
        setActionFeedback({ tone: 'ready', title: message });
        pushRuntimeNotification({
          id: `auto-repair-success-${Date.now()}`,
          level: 'info', source: 'diagnostics',
          message,
          emittedAt: new Date().toISOString(),
        });
      } else {
        setActionFeedback({
          tone: 'error',
          title: `${i18n.t('diagnostics.repairs.autoRepair')} · ${i18n.t('diagnostics.status.failed')}`,
          detail: failures
            .map((failure) => `${failure.label} · ${describeUnknownError(failure.error)}`)
            .join('\n'),
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const runExportAction = async (scope: DiagnosticsExportScope) => {
    if (scope === 'full' && !window.confirm(i18n.t('watchReport.fullBundleWarning'))) {
      return;
    }
    setBusyAction('export');
    setActionFeedback(null);
    try {
      const result = await exportDiagnosticsBundleRuntime(scope);
      setRuntimeSnapshot(result.snapshot);
      updateDiagnosticsDraft({ lastExportScope: scope });
      setActionFeedback({
        tone: 'ready',
        title: `${i18n.t('diagnostics.actions.exportBundle')} · ${i18n.t('diagnostics.status.completed')}`,
        detail: `${result.artifact.outputPath} · ${i18n.t('diagnostics.labels.itemCount', { count: result.artifact.fileCount })}`,
        outputPath: result.artifact.outputPath,
      });
    } catch (error) {
      setActionFeedback({
        tone: 'error',
        title: `${i18n.t('diagnostics.actions.exportBundle')} · ${i18n.t('diagnostics.status.failed')}`,
        detail: errorDetail(error),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const refreshWatchReport = async () => {
    setWatchReportLoading(true);
    setWatchReportError(null);
    try {
      setWatchReport(await getWatchSessionReportRuntime());
    } catch (error) {
      setWatchReportError(errorDetail(error));
    } finally {
      setWatchReportLoading(false);
    }
  };

  const openWatchReportModal = async () => {
    setWatchReportModalOpen(true);
    await refreshWatchReport();
  };

  const clearWatchReport = async () => {
    await clearWatchSessionReportRuntime();
    setWatchReport(null);
  };

  return {
    actionFeedback, busyAction, watchReport, watchReportError, watchReportLoading, watchReportModalOpen,
    clearActionFeedback: () => setActionFeedback(null),
    clearWatchReport,
    closeWatchReportModal: () => setWatchReportModalOpen(false),
    openWatchReportModal, refreshWatchReport, runAutomaticRepair, runBusyAction, runExportAction,
    openExportDirectory: openExportDirectoryRuntime,
    runSelfCheck: () => runBusyAction('self-check', i18n.t('diagnostics.actions.rerunDiagnostics'), runDiagnosticsSelfCheckRuntime),
    runOverlaySelfCheck: () => runBusyAction('overlay-self-check', i18n.t('diagnostics.actions.testOverlay'), runSubtitleOverlaySelfCheckRuntime),
    runBridgeRefresh: () => runBusyAction('bridge-refresh', i18n.t('diagnostics.actions.refreshRuntime'), refreshBridgeRuntime),
  };
}

export const useDiagnosticsActions = useDiagnosticsWorkbenchController;
