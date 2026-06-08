import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import AppIcon from '../../components/icons/AppIcon';
import type { ProviderAuthScheme, ProviderKind, ProviderTransport } from '../../schema/provider-contract';
import type { CustomProviderTemplateDraft } from '../../utils/custom-provider-templates';
import { providersPageHelpers } from './providersPageHelpers';

type CustomProviderDialogProps = {
  draft: CustomProviderTemplateDraft;
  error: string | null;
  onClose: () => void;
  onKindChange: (kind: ProviderKind) => void;
  onSave: () => void;
  setDraft: Dispatch<SetStateAction<CustomProviderTemplateDraft>>;
};

const { formatTransportLabel, supportedTransportsForKind } = providersPageHelpers;

export default function CustomProviderDialog({
  draft,
  error,
  onClose,
  onKindChange,
  onSave,
  setDraft,
}: CustomProviderDialogProps) {
  const { t } = useTranslation();
  const transports: ProviderTransport[] = supportedTransportsForKind(draft.kind);

  return (
    <div className="provider-modal-backdrop" onClick={onClose} role="presentation">
      <div aria-label={t('providers.customDialog.title')} aria-modal="true" className="provider-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="provider-panel-heading provider-panel-heading-compact">
          <div>
            <h3>{t('providers.customDialog.title')}</h3>
            <p>{t('providers.customDialog.description')}</p>
          </div>
          <button className="provider-header-icon" onClick={onClose} title={t('common.close')} type="button">
            <AppIcon name="close" size={13} />
          </button>
        </div>

        <div className="field-grid provider-field-grid provider-modal-grid">
          <label className="field-stack">
            <span>{t('providers.customDialog.platformName')}</span>
            <input className="text-input" onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder={t('providers.customDialog.platformNamePlaceholder')} value={draft.displayName} />
          </label>
          <label className="field-stack">
            <span>{t('providers.customDialog.platformType')}</span>
            <select className="select-input" onChange={(event) => onKindChange(event.target.value as ProviderKind)} value={draft.kind}>
              <option value="openai-compatible">OpenAI Compatible</option>
              <option value="dashscope">DashScope</option>
              <option value="openrouter">OpenRouter</option>
              <option value="nvidia">NVIDIA</option>
              <option value="ollama">Ollama</option>
              <option value="lmstudio">LM Studio</option>
            </select>
          </label>
          <label className="field-stack field-span-full">
            <span>{t('providers.customDialog.baseUrl')}</span>
            <input className="text-input" onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://example.com/v1" value={draft.baseUrl} />
          </label>
          <label className="field-stack">
            <span>{t('providers.customDialog.transport')}</span>
            <select className="select-input" onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as ProviderTransport }))} value={draft.transport}>
              {transports.map((transport) => (
                <option key={transport} value={transport}>
                  {formatTransportLabel(transport)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-stack">
            <span>{t('providers.customDialog.authHeader')}</span>
            <input className="text-input" onChange={(event) => setDraft((current) => ({ ...current, authHeaderName: event.target.value }))} placeholder="Authorization" value={draft.authHeaderName} />
          </label>
          <label className="field-stack">
            <span>{t('providers.customDialog.authScheme')}</span>
            <select className="select-input" onChange={(event) => setDraft((current) => ({ ...current, authScheme: event.target.value as ProviderAuthScheme }))} value={draft.authScheme}>
              <option value="bearer">Bearer</option>
              <option value="api-key">API Key</option>
              <option value="none">{t('providers.common.none')}</option>
            </select>
          </label>
          {draft.kind === 'dashscope' ? (
            <label className="field-stack">
              <span>{t('providers.customDialog.region')}</span>
              <input className="text-input" onChange={(event) => setDraft((current) => ({ ...current, region: event.target.value }))} placeholder="cn-beijing" value={draft.region} />
            </label>
          ) : null}
          <label className="field-stack">
            <span>{t('providers.customDialog.timeoutMs')}</span>
            <input className="text-input" min={1000} onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: Number(event.target.value) || 0 }))} step={500} type="number" value={draft.timeoutMs} />
          </label>
        </div>

        {error ? <div className="provider-inline-alert provider-inline-alert-warning">{error}</div> : null}

        <div className="provider-modal-actions provider-modal-actions-compact">
          <button className="icon-button" onClick={onClose} type="button">
            <AppIcon name="close" size={13} />
            {t('common.cancel')}
          </button>
          <button className="action-button" onClick={onSave} type="button">
            <AppIcon name="cloud" size={14} />
            {t('providers.customDialog.createAction')}
          </button>
        </div>
      </div>
    </div>
  );
}
