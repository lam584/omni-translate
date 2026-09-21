import { useAppStore } from '../../stores/app-store';
import { resetModelCapabilityOverride } from '../../utils/provider-model-capabilities-registry';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import ModalDialog from '../../components/ModalDialog';
import type { ProviderModelCapabilityRegistryEntry } from '../../schema/config';
import type { ProviderCapability, ProviderInteractionCapability } from '../../schema/provider-contract';
import {
  isRealtimeAudioMode,
  providerCapabilityHintKey,
  providerCapabilityLabelKey,
  providerCapabilityOrder,
  providerInteractionCapabilityGroupLabelKey,
  providerInteractionCapabilityGroups,
  providerInteractionCapabilityHintKey,
  providerInteractionCapabilityLabelKey,
  realtimeAudioModeHelpKey,
  realtimeAudioModeOrder,
} from '../../utils/provider-model-capabilities';

type Props = {
  entries: ProviderModelCapabilityRegistryEntry[];
  modelIdSuggestions: string[];
  onClose: () => void;
  onOpenHelp: () => void;
  onAdd: () => void;
  onChange: (id: string, patch: Partial<ProviderModelCapabilityRegistryEntry>) => void;
  onCapabilityToggle: (id: string, capability: ProviderCapability) => void;
  onInteractionToggle: (id: string, capability: ProviderInteractionCapability) => void;
  onRemove: (id: string) => void;
};

const MODEL_ID_DATALIST_ID = 'provider-capability-registry-model-ids';

export default function ProviderCapabilityRegistryDialog(props: Props) {
  const { t } = useTranslation();
  const restoreInheritance = (modelId: string) => {
    const state = useAppStore.getState();
    const provider = state.configDraft.providers.find((item) => item.templateId === state.configDraft.activeProviderTemplateId);
    if (provider) state.updateActiveProviderDraft(resetModelCapabilityOverride(provider, modelId));
  };
  // Only the first entry for a model id wins at resolve time, so surface later
  // duplicates inline instead of silently ignoring them.
  const duplicateEntryIds = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const entry of props.entries) {
      const key = entry.modelId;
      if (!key) continue;
      if (seen.has(key)) duplicates.add(entry.id);
      else seen.add(key);
    }
    return duplicates;
  }, [props.entries]);
  return <ModalDialog aria-label={t('providers.capabilityRegistry.title')} className="provider-modal provider-advanced-modal provider-capability-registry-modal content-card page-card compact-card" onClose={props.onClose} variant="provider">
      <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.capabilityRegistry.title')}</h3><p>{t('providers.capabilityRegistry.description')}</p></div><div className="provider-model-toolbar"><button className="icon-button" onClick={props.onAdd} type="button"><AppIcon name="plus" size={14} />{t('providers.capabilityRegistry.addEntry')}</button><button className="provider-header-icon" onClick={props.onOpenHelp} title={t('providers.audioModeHelp.title')} type="button"><AppIcon name="help-circle" size={13} /></button><button className="provider-header-icon" onClick={props.onClose} title={t('providers.capabilityRegistry.closeTitle')} type="button"><AppIcon name="close" size={13} /></button></div></div>
      <datalist id={MODEL_ID_DATALIST_ID}>{props.modelIdSuggestions.map((modelId) => <option key={modelId} value={modelId} />)}</datalist>
      <div className="provider-custom-header-list provider-capability-registry-list">{props.entries.length ? <>
        <div aria-hidden="true" className="provider-capability-registry-head">
          <span>{t('providers.capabilityRegistry.modelIdLabel')}</span>
          <span>{t('providers.pendingModel.capabilities')}</span>
          <span>{t('providers.pendingModel.realtimeAudioMode')}</span>
          <span>{t('providers.pendingModel.interactionCapabilities')}</span>
          <span />
        </div>
        {props.entries.map((entry) => <div className="provider-capability-registry-item" key={entry.id}>
        <div className="provider-capability-registry-model-cell">
          <input aria-label={t('providers.capabilityRegistry.modelIdLabel')} className="text-input" list={MODEL_ID_DATALIST_ID} onChange={(event) => props.onChange(entry.id, { modelId: event.target.value })} placeholder={t('providers.capabilityRegistry.modelIdPlaceholder')} value={entry.modelId} />
          <p className="provider-setting-footnote">{t('audioRouting.chainSource')}: {entry.source ?? 'manual'} · {t('customProvider.fieldTransport')}: {entry.profileId ? entry.profileId + '@' + entry.profileVersion : t('sceneReadiness.providerNotVerified')}</p>
          {entry.modelProtocolProfile?.adapterStatus !== undefined && entry.modelProtocolProfile.adapterStatus !== 'enabled' ? <p>{t('providerProbe.verdictUnavailable')} · {t('providers.common.disabled')}</p> : null}
          {(duplicateEntryIds.has(entry.id) || entry.registryDiagnostics?.includes('duplicate-model-id')) ? <p className="provider-capability-registry-duplicate">{t('providers.capabilityRegistry.duplicateModelId')}</p> : null}
        </div>
        <div className="provider-scenario-switcher provider-capability-registry-pills">{providerCapabilityOrder.map((capability) => <button className={entry.capabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'} key={capability} onClick={() => props.onCapabilityToggle(entry.id, capability)} title={t(providerCapabilityHintKey(capability))} type="button">{t(providerCapabilityLabelKey(capability))}</button>)}</div>
        <select className="select-input provider-capability-mode-select" onChange={(event) => props.onChange(entry.id, { realtimeAudioMode: isRealtimeAudioMode(event.target.value) ? event.target.value : 'server_vad' })} title={t('providers.pendingModel.realtimeAudioMode')} value={entry.realtimeAudioMode ?? 'server_vad'}>{realtimeAudioModeOrder.map((mode) => <option key={mode} value={mode}>{t(`${realtimeAudioModeHelpKey(mode)}.name`)}</option>)}</select>
        <div className="provider-capability-registry-interactions">{providerInteractionCapabilityGroups.map((group) => <div className="provider-capability-group" key={group.id}>
          <span className="provider-capability-group-label">{t(providerInteractionCapabilityGroupLabelKey(group.id))}</span>
          <div className="provider-scenario-switcher provider-capability-registry-pills">{group.capabilities.map((capability) => <button className={(entry.interactionCapabilities ?? []).includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'} key={capability} onClick={() => props.onInteractionToggle(entry.id, capability)} title={t(providerInteractionCapabilityHintKey(capability))} type="button">{t(providerInteractionCapabilityLabelKey(capability))}</button>)}</div>
        </div>)}</div>
<label><input type="checkbox" checked={entry.hidden ?? false} onChange={(event) => props.onChange(entry.id, { hidden: event.target.checked })} />{t('watchReport.hidden')}</label>
        <button type="button" onClick={() => restoreInheritance(entry.modelId)}>{t('audioRouting.restoreDefaults')} ({t('common.delete')})</button>
        <button className="provider-header-icon provider-header-icon-danger" onClick={() => props.onRemove(entry.id)} title={t('providers.capabilityRegistry.deleteEntry')} type="button"><AppIcon name="trash" size={13} /></button>
      </div>)}
      </> : <div className="provider-directory-empty provider-scene-empty"><strong>{t('providers.capabilityRegistry.emptyTitle')}</strong><p>{t('providers.capabilityRegistry.emptyDescription')}</p></div>}</div>
  </ModalDialog>;
}
