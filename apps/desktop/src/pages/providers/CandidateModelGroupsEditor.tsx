import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import StatusBadge from '../../components/page/StatusBadge';
import type { CandidateModelGroupId, ProviderCandidateModelGroup, ProviderDraft, ProviderModelCapabilityRegistryEntry } from '../../schema/config';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import { providerCapabilityLabelKey } from '../../utils/provider-model-capabilities';
import { isBailianMetadataExpired } from '../../utils/bailian-model-metadata';
import { candidateModelGroupOrder, ensureCandidateModelGroups } from '../../utils/candidate-model-groups';
import { providersPageHelpers } from './providersPageHelpers';

type Props = {
  provider: ProviderDraft;
  modelLookup: Map<string, ProviderModelRuntime>;
  localModelCapabilityRegistry: ProviderModelCapabilityRegistryEntry[];
  onChange: (patch: Partial<ProviderDraft>) => void;
  onOpenModelCatalog?: (group: CandidateModelGroupId) => void;
};

export default function CandidateModelGroupsEditor({ provider, modelLookup, localModelCapabilityRegistry, onChange, onOpenModelCatalog }: Props) {
  const { t } = useTranslation();
  const [dragged, setDragged] = useState<{ group: CandidateModelGroupId; modelId: string } | null>(null);
  const groups = ensureCandidateModelGroups(provider.candidateModelGroups);
  const metadata = isBailianMetadataExpired(provider.modelMetadataCache) ? [] : provider.modelMetadataCache?.models ?? [];
  const metadataByModelId = new Map(metadata.map((row) => [row.modelId, row]));

  const update = (group: CandidateModelGroupId, modelIds: string[]) => {
    const candidateModelGroups: ProviderCandidateModelGroup[] = groups.map((entry) => entry.group === group
      ? { group, modelIds }
      : entry);
    onChange({ candidateModelGroups, status: 'draft' });
  };
  const reorder = (group: CandidateModelGroupId, targetId: string) => {
    if (!dragged || dragged.group !== group || dragged.modelId === targetId) return;
    const current = groups.find((entry) => entry.group === group)!.modelIds;
    const source = current.indexOf(dragged.modelId);
    const target = current.indexOf(targetId);
    if (source < 0 || target < 0) return;
    const next = [...current];
    next.splice(source, 1);
    next.splice(target, 0, dragged.modelId);
    update(group, next);
    setDragged(null);
  };

  return <article className="content-card page-card compact-card provider-panel-card provider-panel-card-compact">
    <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.candidateModels.title')}</h3></div><div className="provider-panel-tools"><StatusBadge label={t('providers.sceneModels.addedCount', { count: groups.reduce((count, entry) => count + entry.modelIds.length, 0) })} tone="pending" /></div></div>
    <div className="provider-scene-grid">
      {candidateModelGroupOrder.map((group) => {
        const modelIds = groups.find((entry) => entry.group === group)!.modelIds;
        return <section className="provider-scene-card" key={group}>
          <div className="provider-scene-card-header"><div><strong>{t(`providers.candidateModels.groups.${group}`)}</strong><p>{modelIds.length ? t('providers.sceneModels.addedCount', { count: modelIds.length }) : t('providers.sceneModels.noneAdded')}</p></div>{onOpenModelCatalog ? <button className="icon-button" onClick={() => onOpenModelCatalog(group)} type="button"><AppIcon name="plus" size={14} />{t('providers.actions.addModel')}</button> : null}</div>
          {modelIds.length ? <div className="provider-scene-model-list">{modelIds.map((modelId) => {
            const model = modelLookup.get(modelId) ?? providersPageHelpers.createDerivedRuntimeModel(modelId, localModelCapabilityRegistry);
            const directoryRow = metadataByModelId.get(modelId);
            return <div className="provider-scene-model-item" draggable key={modelId} onDragStart={() => setDragged({ group, modelId })} onDragEnd={() => setDragged(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => reorder(group, modelId)}>
              <div className="provider-scene-model-copy"><strong>{model.displayName}</strong>{model.displayName.trim() !== model.id.trim() ? <span>{model.id}</span> : null}</div>
              <div className="provider-scene-model-actions">{directoryRow ? <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight"><span className="provider-meta-chip">{t('providers.candidateModels.inputModalities', { modalities: directoryRow.requestModalities.join(', ') || '—' })}</span><span className="provider-meta-chip">{t('providers.candidateModels.outputModalities', { modalities: directoryRow.responseModalities.join(', ') || '—' })}</span></div> : null}{model.capabilities.length ? <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight">{model.capabilities.map((capability) => <span className={`provider-meta-chip provider-capability-chip provider-capability-chip-${capability}`} key={`${model.id}-${capability}`}><AppIcon name={providersPageHelpers.resolveCapabilityIconName(capability)} size={12} />{t(providerCapabilityLabelKey(capability))}</span>)}</div> : <span className="provider-setting-footnote">{t('providers.modelCatalog.noDeclaredCapabilities')}</span>}<button aria-label={t('providers.candidateModels.remove', { model: model.id, group: t(`providers.candidateModels.groups.${group}`) })} className="provider-header-icon provider-header-icon-danger" onClick={() => update(group, modelIds.filter((id) => id !== modelId))} type="button"><AppIcon name="trash" size={13} /></button></div>
            </div>;
          })}</div> : <div className="provider-directory-empty provider-scene-empty"><strong>{t('providers.sceneModels.noneAdded')}</strong></div>}
        </section>;
      })}
    </div>
  </article>;
}
