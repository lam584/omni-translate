import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  installDriverRuntime,
  refreshBridgeRuntime,
  repairDriverRuntime,
  startBridgeServiceRuntime,
  uninstallDriverRuntime,
} from '../../runtime/bridge-runtime';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { resolveRecommendedDriverAction, type DriverManagementAction } from '../../utils/driver-management';
import { resolveDriverDiagnosis } from '../../utils/driver-diagnostics';
import AppIcon from '../icons/AppIcon';

type DriverAction = DriverManagementAction;
type DriverManagementVariant = 'settings' | 'onboarding';
type FeedbackTone = 'success' | 'warning' | 'error';

function isDriverReady(health: string, bridgeState: string) {
  return health !== 'not-installed' && health !== 'damaged' && health !== 'version-mismatch' && bridgeState === 'running';
}

export default function DriverManagementCard({ variant = 'settings' }: { variant?: DriverManagementVariant }) {
  const { t } = useTranslation();
  const configDraft = useAppStore((state) => state.configDraft);
  const snapshot = useAppStore((state) => state.runtimeSnapshot);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const bridge = snapshot.bridge;
  const [busy, setBusy] = useState<DriverAction | null>(null);
  const [feedback, setFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const installed = bridge.driverHealth !== 'not-installed';
  const needsRepair = bridge.driverHealth === 'damaged' || bridge.driverHealth === 'version-mismatch';
  const ready = isDriverReady(bridge.driverHealth, bridge.bridgeState);
  const probing = bridge.driverProbeState === 'probing';
  const primaryAction = resolveRecommendedDriverAction(bridge);
  const diagnosis = resolveDriverDiagnosis(bridge);
  const rawDiagnosticSummary = bridge.driverDetail ?? bridge.lastDriverOperation?.summary ?? null;

  const actionKey =
    needsRepair ? 'repair' : primaryAction === 'start-bridge' ? 'startBridge' : primaryAction === 'refresh' ? 'refresh' : 'install';
  const statusTone = diagnosis.tone;
  const statusIcon = ready ? 'check' : statusTone === 'error' ? 'alert' : 'wrench';

  const run = async (action: DriverAction) => {
    setBusy(action);
    setFeedback(null);
    try {
      const next =
        action === 'refresh'
          ? await refreshBridgeRuntime()
          : action === 'uninstall'
            ? await uninstallDriverRuntime()
            : action === 'reinstall' || needsRepair
              ? await repairDriverRuntime('reinstall-driver', configDraft)
              : action === 'start-bridge'
                ? await startBridgeServiceRuntime(configDraft)
                : await installDriverRuntime(configDraft);
      setRuntimeSnapshot(next);
      const nextReady = isDriverReady(next.bridge.driverHealth, next.bridge.bridgeState);
      setFeedback({
        tone: nextReady ? 'success' : 'warning',
        message: t(nextReady ? 'driverManagement.feedbackReady' : 'driverManagement.feedbackNeedsAttention'),
      });
    } catch {
      let refreshedSnapshot: RuntimeSnapshot | null = null;
      try {
        refreshedSnapshot = await refreshBridgeRuntime();
        setRuntimeSnapshot(refreshedSnapshot);
      } catch {
        // Keep the original action failure visible even if the follow-up refresh also fails.
      }
      const feedbackKey = refreshedSnapshot ? resolveDriverDiagnosis(refreshedSnapshot.bridge).key : 'operationFailed';
      setFeedback({ tone: 'error', message: t(`driverManagement.feedback.${feedbackKey}`) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`driver-management-card driver-management-card-${variant}`}>
      <div className="driver-management-status">
        <span className={`driver-management-status-icon driver-management-status-icon-${statusTone}`}>
          <AppIcon name={statusIcon} size={18} />
        </span>
        <div>
          <h3>{t(`driverManagement.status.${diagnosis.key}`)}</h3>
          <p>{t(`driverManagement.description.${diagnosis.key}`)}</p>
          {bridge.driverVersion ? <span className="driver-management-version">{bridge.driverVersion}</span> : null}
        </div>
      </div>

      <div className="driver-management-actions">
        <button
          type="button"
          className="settings-action driver-management-primary"
          disabled={Boolean(busy) || probing || ready}
          onClick={() => void run(primaryAction)}
        >
          {busy === primaryAction ? t('driverManagement.processing') : t(`driverManagement.action.${actionKey}`)}
        </button>
        {variant === 'settings' ? (
          <>
            <button type="button" className="settings-action" disabled={Boolean(busy) || !installed} onClick={() => void run('uninstall')}>
              {t('driverManagement.action.uninstall')}
            </button>
            <button type="button" className="settings-action" disabled={Boolean(busy)} onClick={() => void run('reinstall')}>
              {t('driverManagement.action.reinstall')}
            </button>
          </>
        ) : null}
        <button type="button" className="settings-action driver-management-secondary" disabled={Boolean(busy) || probing} onClick={() => void run('refresh')}>
          {probing ? t('driverManagement.processing') : t('driverManagement.action.refresh')}
        </button>
        <button
          type="button"
          className="settings-action driver-management-secondary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? 'driverManagement.action.hideDetails' : 'driverManagement.action.showDetails')}
        </button>
      </div>

      {feedback ? <p className={`driver-management-feedback driver-management-feedback-${feedback.tone}`}>{feedback.message}</p> : null}

      {expanded ? (
        <dl className="driver-management-details">
          <div><dt>{t('driverManagement.detail.rootNodes')}</dt><dd>{bridge.rootDeviceCount} · {bridge.rootInstanceIds.join(', ') || t('driverManagement.value.none')}</dd></div>
          <div><dt>{t('driverManagement.detail.probeState')}</dt><dd>{t(`driverManagement.value.${bridge.driverProbeState}`)}</dd></div>
          <div><dt>{t('driverManagement.detail.endpoint')}</dt><dd>{bridge.endpointName ?? t('driverManagement.value.notFound')}</dd></div>
          <div><dt>{t('driverManagement.detail.abi')}</dt><dd>{bridge.abiVersion ?? t('driverManagement.value.unavailable')}</dd></div>
          <div><dt>TESTSIGNING</dt><dd>{t(bridge.testSigningEnabled ? 'driverManagement.value.enabled' : 'driverManagement.value.disabled')}</dd></div>
          <div><dt>{t('driverManagement.detail.signatureEnforcementBypass')}</dt><dd>{t(bridge.signatureEnforcementBypassed ? 'driverManagement.value.enabledUntilRestart' : 'driverManagement.value.disabled')}</dd></div>
          <div><dt>{t('driverManagement.detail.memoryIntegrity')}</dt><dd>{t(bridge.memoryIntegrityEnabled ? 'driverManagement.value.enabled' : 'driverManagement.value.disabled')}</dd></div>
          <div><dt>Secure Boot</dt><dd>{bridge.secureBootEnabled == null ? t('driverManagement.value.unknown') : t(bridge.secureBootEnabled ? 'driverManagement.value.enabled' : 'driverManagement.value.disabled')}</dd></div>
          <div><dt>{t('driverManagement.detail.secureBootProbe')}</dt><dd>{t(`driverManagement.value.${bridge.secureBootProbeStatus}`)}</dd></div>
          <div><dt>Bridge</dt><dd>{bridge.bridgeState}</dd></div>
          <div><dt>{t('driverManagement.detail.errorCode')}</dt><dd>{bridge.lastErrorCode ?? t('driverManagement.value.none')}</dd></div>
          <div><dt>{t('driverManagement.detail.recentLog')}</dt><dd>{bridge.lastDriverOperation?.logPath || t('driverManagement.value.none')}</dd></div>
          <div><dt>{t('driverManagement.detail.summary')}</dt><dd>{t(`driverManagement.description.${diagnosis.key}`)}</dd></div>
          <div><dt>{t('driverManagement.detail.rawSummary')}</dt><dd>{rawDiagnosticSummary ?? t('driverManagement.value.none')}</dd></div>
        </dl>
      ) : null}
    </section>
  );
}
