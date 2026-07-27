import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { appendFrontendDiagnosticsLog, exportDiagnosticsBundleRuntime, openExportDirectoryRuntime } from '../../runtime/diagnostics-runtime';
import type { RuntimeNotification } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { CONFIG_PERSIST_RETRY_EVENT, DESKTOP_RUNTIME_RETRY_EVENT } from '../../runtime/bootstrap/retry-events';
import AppIcon from '../icons/AppIcon';
import {
  isSessionToastNotification,
  MAX_VISIBLE_TOASTS,
  runtimeErrorPresentation,
  WARNING_AUTO_DISMISS_MS,
} from './runtime-toast-helpers';

/**
 * Global toast host for session-domain runtime notifications, mounted in
 * AppLayout so disconnects, credential failures and device loss stay visible
 * while the user is on other pages. Errors persist until dismissed; warnings
 * auto-dismiss. Store-level id dedupe already throttles reconnect storms, and
 * the seen-id set here keeps re-pushed ids from re-toasting.
 */
function RuntimeToastHost() {
  const { t } = useTranslation();
  const runtimeNotifications = useAppStore((state) => state.runtimeNotifications);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const [toasts, setToasts] = useState<RuntimeNotification[]>(() =>
    useAppStore.getState().runtimeNotifications
      .filter((item) => item.source === 'desktop-runtime' && item.level === 'error')
      .slice(-MAX_VISIBLE_TOASTS)
      .reverse(),
  );
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const seenIdsRef = useRef(new Set(useAppStore.getState().runtimeNotifications.map((item) => item.id)));
  const dismissTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const seen = seenIdsRef.current;
    const fresh = runtimeNotifications.filter((item) => !seen.has(item.id));
    if (fresh.length === 0) {
      return;
    }
    fresh.forEach((item) => seen.add(item.id));
    const freshToasts = fresh.filter(isSessionToastNotification);
    if (freshToasts.length === 0) {
      return;
    }
    setToasts((previous) => [...freshToasts, ...previous].slice(0, MAX_VISIBLE_TOASTS));
    freshToasts
      .filter((item) => item.level === 'warning')
      .forEach((item) => {
        const timer = window.setTimeout(() => {
          setToasts((previous) => previous.filter((toast) => toast.id !== item.id));
        }, WARNING_AUTO_DISMISS_MS);
        dismissTimersRef.current.push(timer);
      });
  }, [runtimeNotifications]);

  useEffect(() => () => {
    dismissTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const dismissToast = (id: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  };

  const runExport = async () => {
    setExportBusy(true);
    setExportError(null);
    try {
      const result = await exportDiagnosticsBundleRuntime('quick');
      setRuntimeSnapshot(result.snapshot);
      try {
        await openExportDirectoryRuntime(result.artifact.outputPath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setExportError(
          `${t('diagnostics.status.completed')}：${result.artifact.outputPath} · ${t('diagnostics.actions.openExportDirectory')} ${t('diagnostics.status.failed')}：${detail}`,
        );
        appendFrontendDiagnosticsLog('runtime', 'warning', `[Toast] opening diagnostics export directory failed: ${detail}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setExportError(`${t('diagnostics.feedback.exportFailed')} ${detail}`);
      appendFrontendDiagnosticsLog('runtime', 'warning', `[Toast] diagnostics export failed: ${detail}`);
    } finally {
      setExportBusy(false);
    }
  };

  const retryDesktopRuntime = (toast: RuntimeNotification) => {
    window.dispatchEvent(new Event(toast.id.startsWith('config-persist-failed-')
      ? CONFIG_PERSIST_RETRY_EVENT
      : DESKTOP_RUNTIME_RETRY_EVENT));
    dismissToast(toast.id);
  };

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div aria-label={t('session.toastRegionAria')} className="runtime-toast-region" role="region">
      {toasts.map((toast) => (
        <div
          className={`runtime-toast runtime-toast-${toast.level}`}
          key={toast.id}
          role={toast.level === 'error' ? 'alert' : 'status'}
        >
          <AppIcon name="alert" size={14} />
          <span className="runtime-toast-message">{runtimeErrorPresentation(toast, t).summary}</span>
          {exportError && toast.level === 'error' && toast.source !== 'desktop-runtime' ? (
            <span className="runtime-toast-export-error" role="status">{exportError}</span>
          ) : null}
          {toast.source === 'desktop-runtime' ? (
            <button className="runtime-toast-action" onClick={() => retryDesktopRuntime(toast)} type="button">
              <AppIcon name="refresh" size={12} />
              {t('common.retry')}
            </button>
          ) : toast.level === 'error' && (
            <button
              className="runtime-toast-action"
              disabled={exportBusy}
              onClick={() => void runExport()}
              type="button"
            >
              <AppIcon name="layers" size={12} />
              {exportBusy ? t('diagnostics.actions.exporting') : t('session.exportDiagnostics')}
            </button>
          )}
          {toast.level === 'error' && (
            <button
              aria-label={t('close')}
              className="runtime-toast-close"
              onClick={() => dismissToast(toast.id)}
              type="button"
            >
              <AppIcon name="close" size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default RuntimeToastHost;
