import { useTranslation } from 'react-i18next';
import AppIcon from './icons/AppIcon';

export type BootstrapStepStatus = 'pending' | 'active' | 'done' | 'error';

export type BootstrapStep = {
  id: string;
  label: string;
  status: BootstrapStepStatus;
  detail?: string;
};

type BootstrapOverlayProps = {
  steps: BootstrapStep[];
  visible: boolean;
};

const statusIcon: Record<BootstrapStepStatus, string | null> = {
  pending: null,
  active: '◎',
  done: '✓',
  error: '✕',
};

export default function BootstrapOverlay({ steps, visible }: BootstrapOverlayProps) {
  const { t } = useTranslation();

  if (!visible) {
    return null;
  }

  return (
    <div className="bootstrap-overlay">
      <div className="bootstrap-overlay-card">
        <div className="bootstrap-spinner" role="status">
          <AppIcon name="spark" size={28} />
        </div>
        <p className="bootstrap-title">{t('common.bootstrapTitle')}</p>
        <ul className="bootstrap-step-list">
          {steps.map((step) => (
            <li
              key={step.id}
              className={`bootstrap-step bootstrap-step-${step.status}`}
            >
              <span className="bootstrap-step-marker">
                {statusIcon[step.status] ?? ' '}
              </span>
              <span className="bootstrap-step-label">{step.label}</span>
              {step.detail ? (
                <span className="bootstrap-step-detail">{step.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
