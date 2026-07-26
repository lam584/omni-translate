import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { appendFrontendDiagnosticsLog, exportDiagnosticsBundleRuntime } from '../../runtime/diagnostics-runtime';
import type { RuntimeNotification } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import AppIcon from '../icons/AppIcon';
import {
  isSessionToastNotification,
  MAX_VISIBLE_TOASTS,
  toastDisplayText,
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
  const [toasts, setToasts] = useState<RuntimeNotification[]>([]);
  const [exportBusy, setExportBusy] = useState(false);
  const seenIdsRef = useRef<Set<string> | null>(null);
  const dismissTimersRef = useRef<number[]>([]);

  useEffect(() => {
    if (seenIdsRef.current === null) {
      // Notifications already present at mount predate this host; only
      // items pushed afterwards should toast.
      seenIdsRef.current = new Set(runtimeNotifications.map((item) => item.id));
      return;
    }
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
    try {
      const result = await exportDiagnosticsBundleRuntime('quick');
      setRuntimeSnapshot(result.snapshot);
    } catch (error) {
      appendFrontendDiagnosticsLog('runtime', 'warning', `[Toast] diagnostics export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExportBusy(false);
    }
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
          <span className="runtime-toast-message">{toastDisplayText(toast.message, t)}</span>
          {toast.level === 'error' && (
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
