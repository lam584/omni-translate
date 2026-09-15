import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import AppIcon from '../../components/icons/AppIcon';
import ModalDialog from '../../components/ModalDialog';
import {
  customProviderProtocolProfileOptions,
  resolveCustomProviderProtocolProfileOption,
} from '../../provider-manifest/custom-profile-options';
import type { ProviderKind } from '../../schema/provider-contract';
import type { CustomProviderTemplateDraft } from '../../utils/custom-provider-templates';
import { ProviderDialogHeader } from './ProviderDialogShared';

type CustomProviderDialogProps = {
  draft: CustomProviderTemplateDraft;
  error: string | null;
  onClose: () => void;
  onKindChange: (kind: ProviderKind) => void;
  onSave: () => void;
  setDraft: Dispatch<SetStateAction<CustomProviderTemplateDraft>>;
};

export default function CustomProviderDialog({
  draft,
  error,
  onClose,
  onKindChange,
  onSave,
  setDraft,
}: CustomProviderDialogProps) {
  const { t } = useTranslation();
  const protocolProfiles = customProviderProtocolProfileOptions(draft.kind);

  return (
    <ModalDialog aria-label={t('providers.customDialog.title')} className="provider-modal content-card page-card compact-card" onClose={onClose} variant="provider">
        <ProviderDialogHeader closeTitle={t('common.close')} description={t('providers.customDialog.description')} onClose={onClose} title={t('providers.customDialog.title')} />

        <div className="field-grid provider-field-grid provider-modal-grid">
          <label className="field-stack">
            <span>{t('providers.customDialog.platformName')}</span>
            <input className="text-input" onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder={t('providers.customDialog.platformNamePlaceholder')} value={draft.displayName} />
          </label>
          <label className="field-stack">
            <span>{t('providers.customDialog.model', { defaultValue: '模型 ID' })}</span>
            <input className="text-input" onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} placeholder="gpt-4o" value={draft.model} />
          </label>
          <label className="field-stack field-span-full">
            <span>{t('providers.customDialog.protocolProfile', { defaultValue: 'Protocol Profile（精确版本）' })}</span>
            <select
              className="select-input"
              onChange={(event) => {
                const option = resolveCustomProviderProtocolProfileOption(draft.kind, event.target.value);
                setDraft((current) => ({
                  ...current,
                  protocolProfileKey: event.target.value,
                  ...(option ? {
                    transport: option.transport,
                    authHeaderName: option.authHeaderName,
                    authScheme: option.authScheme,
                  } : {}),
                }));
              }}
              required
              value={draft.protocolProfileKey}
            >
              <option value="">{t('providers.customDialog.protocolProfilePlaceholder', { defaultValue: '请选择（不会自动推断）' })}</option>
              {protocolProfiles.map((profile) => (
                <option key={profile.key} value={profile.key}>{profile.label}</option>
              ))}
            </select>
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
            <select className="select-input" disabled value={draft.transport}>
              <option value={draft.transport}>{draft.transport}</option>
            </select>
          </label>
          <label className="field-stack">
            <span>{t('providers.customDialog.authHeader')}</span>
            <input className="text-input" disabled placeholder="Authorization" value={draft.authHeaderName} />
          </label>
          <label className="field-stack">
            <span>{t('providers.customDialog.authScheme')}</span>
            <select className="select-input" disabled value={draft.authScheme}>
              <option value={draft.authScheme}>{draft.authScheme}</option>
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
            <AppIcon name="plus" size={14} />
            {t('providers.customDialog.createAction')}
          </button>
        </div>
    </ModalDialog>
  );
}
