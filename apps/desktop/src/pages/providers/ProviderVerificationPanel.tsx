import StatusBadge, { type StatusTone } from '../../components/page/StatusBadge';
import AppIcon from '../../components/icons/AppIcon';
import ModalDialog from '../../components/ModalDialog';
import { useTranslation } from 'react-i18next';
import type { ProviderProbeProfileRuntime, ProviderSmokeResult } from '../../schema/provider-runtime';
import type { ProviderProbeView } from '../../utils/provider-probe';
import { providersPageHelpers } from './providersPageHelpers';

type ProviderVerificationPanelProps = {
  activeProbe: ProviderProbeView;
  probeResult: ProviderProbeProfileRuntime | null;
  smokeResult: ProviderSmokeResult | null;
  summaryLabel: string;
  summaryTone: StatusTone;
  onClose: () => void;
};

const {
  formatSmokeStatusLabel,
  formatSubtitlePriorityLabel,
} = providersPageHelpers;

export default function ProviderVerificationPanel({
  activeProbe,
  probeResult,
  smokeResult,
  summaryLabel,
  summaryTone,
  onClose,
}: ProviderVerificationPanelProps) {
  const { t } = useTranslation();

  return (
    <ModalDialog aria-label={t('providers.verification.title')} className="provider-modal provider-validation-modal content-card page-card compact-card" onClose={onClose} variant="provider">
        <div className="provider-panel-heading provider-panel-heading-compact">
          <div>
            <h3>{t('providers.verification.title')}</h3>
            <p>{t('providers.verification.description')}</p>
          </div>
          <div className="provider-model-toolbar">
            <StatusBadge label={summaryLabel} tone={summaryTone} />
            <button className="provider-header-icon" onClick={onClose} title={t('providers.verification.closeTitle')} type="button">
              <AppIcon name="close" size={13} />
            </button>
          </div>
        </div>

        <div className="provider-validation-grid">
          <section className="provider-validation-section">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>{t('providers.verification.probeTitle')}</h3>
                <p>{t('providers.verification.probeDescription')}</p>
              </div>
            </div>
            <ul className="bullet-list provider-insight-list provider-insight-list-compact">
              <li>{t('providers.verification.checkedAt', { value: activeProbe.checkedAt })}</li>
              <li>{t('providers.verification.latency', { measured: activeProbe.measuredLatencyMs, budget: activeProbe.latencyBudgetMs })}</li>
              <li>{t('providers.verification.transportRequested', { value: activeProbe.transportRequested })}</li>
              <li>{t('providers.verification.transportEffective', { value: activeProbe.transportEffective })}</li>
              <li>{t('providers.verification.streamSupported', { value: activeProbe.streamSupported ? t('common.supported') : t('common.unsupported') })}</li>
              <li>{t('providers.verification.fallbackApplied', { value: activeProbe.fallbackApplied ? t('common.applied') : t('common.notApplied') })}</li>
              <li>{t('providers.verification.subtitlePriority', { value: formatSubtitlePriorityLabel(probeResult?.routingDecision.subtitlePriority ?? 'balanced') })}</li>
            </ul>
            {activeProbe.guidance.length ? (
              <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight">
                {activeProbe.guidance.map((item) => (
                  <span className="provider-meta-chip provider-meta-chip-muted" key={item}>
                    {item}
                  </span>
                ))}
              </div>
            ) : null}
            {probeResult?.error ? (
              <p className="provider-setting-footnote">
                {t('providers.verification.errorDetail', {
                  code: probeResult.error.code,
                  message: probeResult.error.message,
                  suggestion: probeResult.error.suggestion
                    ? t('providers.verification.suggestionSuffix', { suggestion: probeResult.error.suggestion })
                    : '',
                })}
              </p>
            ) : null}
          </section>

          {smokeResult ? (
            <section className="provider-validation-section">
              <div className="provider-panel-heading provider-panel-heading-compact">
                <div>
                  <h3>{t('providers.verification.smokeTitle')}</h3>
                  <p>{t('providers.verification.smokeDescription')}</p>
                </div>
              </div>
              <ul className="bullet-list provider-insight-list provider-insight-list-compact">
                <li>{t('providers.verification.requestId', { value: smokeResult.requestId })}</li>
                <li>{t('providers.verification.status', { value: formatSmokeStatusLabel(smokeResult.status) })}</li>
                <li>{t('providers.verification.duration', { value: smokeResult.durationMs })}</li>
                <li>{t('providers.verification.firstEventLatency', { value: smokeResult.firstEventLatencyMs ?? '?' })}</li>
                <li>{t('providers.verification.streamObserved', { value: smokeResult.streamObserved ? t('common.observed') : t('common.notObserved') })}</li>
                <li>{t('providers.verification.subtitlePriority', { value: formatSubtitlePriorityLabel(smokeResult.routingDecision.subtitlePriority) })}</li>
              </ul>
              <p className="provider-setting-footnote">
                {smokeResult.error
                  ? t('providers.verification.smokeError', { code: smokeResult.error.code, message: smokeResult.error.message })
                  : t('providers.verification.returnedText', { value: smokeResult.transcript || '?' })}
              </p>
              {smokeResult.eventLog.length > 0 ? (
                <div className="result-log">
                  {smokeResult.eventLog.slice(0, 8).map((event) => (
                    <p key={`${event.eventType}-${event.summary}`}>
                      {t('providers.verification.eventTriggered', { eventType: event.eventType, summary: event.summary })}
                    </p>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
    </ModalDialog>
  );
}
