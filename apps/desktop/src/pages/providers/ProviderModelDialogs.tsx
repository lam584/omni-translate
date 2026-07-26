import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import ModalDialog from '../../components/ModalDialog';
import type { ProviderCapability, ProviderInteractionCapability } from '../../schema/provider-contract';
import {
  formatProviderCapabilityLabel,
  formatProviderInteractionCapabilityLabel,
  formatProviderInteractionCapabilityShortLabel,
  formatRealtimeAudioModeLabel,
  isRealtimeAudioMode,
  providerCapabilityOrder,
  providerInteractionCapabilityOrder,
  realtimeAudioModeOrder,
} from '../../utils/provider-model-capabilities';
import type { PendingModelRegistration } from './providersPageHelpers';

type PendingProps = {
  pending: PendingModelRegistration;
  onChange: (next: PendingModelRegistration | null | ((current: PendingModelRegistration | null) => PendingModelRegistration | null)) => void;
  onCapabilityToggle: (capability: ProviderCapability) => void;
  onInteractionToggle: (capability: ProviderInteractionCapability) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function PendingModelRegistrationDialog(props: PendingProps) {
  const { t } = useTranslation();
  return <ModalDialog aria-label={t('providers.pendingModel.title')} className="provider-modal provider-advanced-modal content-card page-card compact-card" onClose={props.onClose} variant="provider">
      <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.pendingModel.title')}</h3><p>{props.pending.model.id}</p></div><button className="provider-header-icon" onClick={props.onClose} title={t('providers.pendingModel.closeTitle')} type="button"><AppIcon name="close" size={13} /></button></div>
      <div className="field-grid provider-field-grid provider-modal-grid">
        <div className="field-stack field-span-full"><span>{t('providers.pendingModel.capabilities')}</span><div className="provider-scenario-switcher provider-capability-registry-pills">{providerCapabilityOrder.map((capability) => <button className={props.pending.capabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'} key={capability} onClick={() => props.onCapabilityToggle(capability)} type="button">{formatProviderCapabilityLabel(capability)}</button>)}</div></div>
        <label className="field-stack field-span-full"><span>{t('providers.pendingModel.realtimeAudioMode')}</span><select className="select-input" onChange={(event) => {
          const value = event.target.value;
          props.onChange((current) => current && isRealtimeAudioMode(value) ? { ...current, realtimeAudioMode: value } : current);
        }} value={props.pending.realtimeAudioMode}>{realtimeAudioModeOrder.map((mode) => <option key={mode} value={mode}>{formatRealtimeAudioModeLabel(mode)}</option>)}</select></label>
        <div className="field-stack field-span-full"><span>{t('providers.pendingModel.interactionCapabilities')}</span><div className="provider-scenario-switcher provider-capability-registry-pills">{providerInteractionCapabilityOrder.map((capability) => <button className={props.pending.interactionCapabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'} key={capability} onClick={() => props.onInteractionToggle(capability)} title={formatProviderInteractionCapabilityLabel(capability)} type="button">{formatProviderInteractionCapabilityShortLabel(capability)}</button>)}</div></div>
      </div>
      <div className="provider-modal-actions"><button className="icon-button" onClick={props.onClose} type="button">{t('common.cancel')}</button><button className="icon-button provider-primary-action" disabled={props.pending.capabilities.length === 0} onClick={props.onConfirm} type="button">{t('providers.pendingModel.registerAndAdd')}</button></div>
  </ModalDialog>;
}

export function AudioModeHelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const modes = [
    ['manualFullAudio', 'DashScope Omni', 'client'],
    ['serverVad', 'DashScope / OpenAI', 'server'],
    ['semanticVad', 'DashScope Omni', 'server'],
    ['geminiAuto', 'Gemini Live', 'server'],
    ['geminiManual', 'Gemini Live', 'client'],
  ] as const;
  return <ModalDialog aria-label={t('providers.audioModeHelp.title')} className="provider-modal provider-advanced-modal content-card page-card compact-card" onClose={onClose} variant="provider">
      <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.audioModeHelp.title')}</h3><p>{t('providers.audioModeHelp.description')}</p></div><button className="provider-header-icon" onClick={onClose} title={t('providers.audioModeHelp.closeTitle')} type="button"><AppIcon name="close" size={13} /></button></div>
      <div className="audio-mode-help-list">{modes.map(([key, provider, segmentation]) => <div className="audio-mode-help-item" key={key}><div className="audio-mode-help-header"><span className="audio-mode-help-name">{t(`providers.audioModeHelp.${key}.name`)}</span><span className="audio-mode-help-tag">{provider}</span><span className={`audio-mode-help-tag audio-mode-help-tag-${segmentation}`}>{t(`providers.audioModeHelp.${segmentation}Segmentation`)}</span></div><p className="audio-mode-help-desc">{t(`providers.audioModeHelp.${key}.description`)}</p><p className="audio-mode-help-models">{t(`providers.audioModeHelp.${key}.models`)}</p></div>)}</div>
  </ModalDialog>;
}
