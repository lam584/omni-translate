import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import ModalDialog from '../../components/ModalDialog';
import type { ProviderModelCapabilityRegistryEntry } from '../../schema/config';
import type { ProviderCapability, ProviderInteractionCapability } from '../../schema/provider-contract';
import {
  formatProviderCapabilityLabel,
  formatProviderCapabilityShortLabel,
  formatProviderInteractionCapabilityLabel,
  formatProviderInteractionCapabilityShortLabel,
  formatRealtimeAudioModeLabel,
  inferRealtimeAudioModeFromModelName,
  isRealtimeAudioMode,
  providerCapabilityOrder,
  providerInteractionCapabilityOrder,
  realtimeAudioModeOrder,
} from '../../utils/provider-model-capabilities';

type Props = {
  entries: ProviderModelCapabilityRegistryEntry[];
  onClose: () => void;
  onOpenHelp: () => void;
  onAdd: () => void;
  onChange: (id: string, patch: Partial<ProviderModelCapabilityRegistryEntry>) => void;
  onCapabilityToggle: (id: string, capability: ProviderCapability) => void;
  onInteractionToggle: (id: string, capability: ProviderInteractionCapability) => void;
  onRemove: (id: string) => void;
};

export default function ProviderCapabilityRegistryDialog(props: Props) {
  const { t } = useTranslation();
  return <ModalDialog aria-label={t('providers.capabilityRegistry.title')} className="provider-modal provider-advanced-modal content-card page-card compact-card" onClose={props.onClose} variant="provider">
      <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.capabilityRegistry.title')}</h3><p>{t('providers.capabilityRegistry.description')}</p></div><div className="provider-model-toolbar"><button className="icon-button" onClick={props.onAdd} type="button"><AppIcon name="cloud" size={14} />{t('providers.capabilityRegistry.addEntry')}</button><button className="provider-header-icon" onClick={props.onOpenHelp} title={t('providers.audioModeHelp.title')} type="button"><AppIcon name="help-circle" size={13} /></button><button className="provider-header-icon" onClick={props.onClose} title={t('providers.capabilityRegistry.closeTitle')} type="button"><AppIcon name="close" size={13} /></button></div></div>
      <div className="provider-custom-header-list">{props.entries.length ? props.entries.map((entry) => <div className="provider-capability-registry-item" key={entry.id}>
        <input className="text-input" onChange={(event) => props.onChange(entry.id, { modelId: event.target.value })} placeholder={t('providers.capabilityRegistry.modelIdPlaceholder')} value={entry.modelId} />
        <div className="provider-scenario-switcher provider-capability-registry-pills">{providerCapabilityOrder.map((capability) => <button className={entry.capabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'} key={capability} onClick={() => props.onCapabilityToggle(entry.id, capability)} title={formatProviderCapabilityLabel(capability)} type="button">{formatProviderCapabilityShortLabel(capability)}</button>)}</div>
        <select className="select-input provider-capability-mode-select" onChange={(event) => props.onChange(entry.id, { realtimeAudioMode: isRealtimeAudioMode(event.target.value) ? event.target.value : inferRealtimeAudioModeFromModelName(entry.modelId) })} title={t('providers.pendingModel.realtimeAudioMode')} value={entry.realtimeAudioMode ?? inferRealtimeAudioModeFromModelName(entry.modelId)}>{realtimeAudioModeOrder.map((mode) => <option key={mode} value={mode}>{formatRealtimeAudioModeLabel(mode)}</option>)}</select>
        <div className="provider-scenario-switcher provider-capability-registry-pills">{providerInteractionCapabilityOrder.map((capability) => <button className={(entry.interactionCapabilities ?? []).includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'} key={capability} onClick={() => props.onInteractionToggle(entry.id, capability)} title={formatProviderInteractionCapabilityLabel(capability)} type="button">{formatProviderInteractionCapabilityShortLabel(capability)}</button>)}</div>
        <button className="provider-header-icon provider-header-icon-danger" onClick={() => props.onRemove(entry.id)} title={t('providers.capabilityRegistry.deleteEntry')} type="button"><AppIcon name="close" size={13} /></button>
      </div>) : <div className="provider-directory-empty provider-scene-empty"><strong>{t('providers.capabilityRegistry.emptyTitle')}</strong><p>{t('providers.capabilityRegistry.emptyDescription')}</p></div>}</div>
  </ModalDialog>;
}
