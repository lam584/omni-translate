import AppIcon from '../../components/icons/AppIcon';
import ModalDialog from '../../components/ModalDialog';
import StatusBadge from '../../components/page/StatusBadge';
import { useTranslation } from 'react-i18next';
import type { ProviderScenario } from '../../schema/config';
import type { ProviderCapability } from '../../schema/provider-contract';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import { providerCapabilityLabelKey } from '../../utils/provider-model-capabilities';
import { providersPageHelpers, type ModelCatalogScenarioFilter, type ModelCatalogState } from './providersPageHelpers';

type CatalogSection = {
  capability: ProviderCapability;
  models: ProviderModelRuntime[];
};

type ProviderModelCatalogProps = {
  catalog: ModelCatalogState;
  catalogSections: CatalogSection[];
  description: string;
  manualModelIdDraft: string;
  query: string;
  selectedScenario: ModelCatalogScenarioFilter;
  targetScenario: ProviderScenario;
  uncategorizedModels: ProviderModelRuntime[];
  isModelAdded: (scenario: ModelCatalogScenarioFilter, modelId: string) => boolean;
  onClose: () => void;
  onManualAdd: () => void;
  onManualDraftChange: (value: string) => void;
  onOpenCapabilityRegistry: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onScenarioChange: (scenario: ModelCatalogScenarioFilter) => void;
  onToggleModel: (scenario: ProviderScenario, model: ProviderModelRuntime) => void;
};

const {
  formatModelCatalogSourceLabel,
  formatScenarioLabel,
  formatTimestampLabel,
  providerScenarioOrder,
  resolveCapabilityIconName,
  resolveModelIconName,
} = providersPageHelpers;

function ProviderModelCatalogItem({
  added,
  model,
  onToggle,
}: {
  added: boolean;
  model: ProviderModelRuntime;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className={added ? 'provider-model-item provider-model-item-active provider-model-item-compact' : 'provider-model-item provider-model-item-compact'}>
      <div className="provider-model-item-leading">
        <span className="provider-model-item-icon" aria-hidden="true">
          <AppIcon name={resolveModelIconName(model)} size={14} />
        </span>
        <div className="provider-model-item-copy">
          <strong>{model.displayName}</strong>
          {model.displayName.trim() !== model.id.trim() ? <span>{model.id}</span> : null}
        </div>
      </div>
      <div className="provider-model-item-meta">
        {model.capabilities.length > 0 ? (
          <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight">
            {model.capabilities.map((capability) => (
              <span className={`provider-meta-chip provider-capability-chip provider-capability-chip-${capability}`} key={`${model.id}-${capability}`}>
                <AppIcon name={resolveCapabilityIconName(capability)} size={12} />
                {t(providerCapabilityLabelKey(capability))}
              </span>
            ))}
          </div>
        ) : (
          <span className="provider-setting-footnote">{t('providers.modelCatalog.noDeclaredCapabilities')}</span>
        )}
        <button className={added ? 'icon-button provider-row-action provider-row-action-danger' : 'icon-button provider-row-action'} onClick={onToggle} type="button">
          <AppIcon name={added ? 'trash' : 'plus'} size={13} />
          {added ? t('common.delete') : t('common.add')}
        </button>
      </div>
    </div>
  );
}

export default function ProviderModelCatalog({
  catalog,
  catalogSections,
  description,
  manualModelIdDraft,
  query,
  selectedScenario,
  targetScenario,
  uncategorizedModels,
  isModelAdded,
  onClose,
  onManualAdd,
  onManualDraftChange,
  onOpenCapabilityRegistry,
  onQueryChange,
  onRefresh,
  onScenarioChange,
  onToggleModel,
}: ProviderModelCatalogProps) {
  const { t } = useTranslation();

  return (
    <ModalDialog aria-label={t('providers.modelCatalog.title')} className="provider-modal provider-model-modal content-card page-card compact-card" onClose={onClose} variant="provider">
        <div className="provider-panel-heading provider-panel-heading-compact">
          <div>
            <h3>{t('providers.modelCatalog.title')}</h3>
            <p>{description}</p>
          </div>
          <div className="provider-model-toolbar">
            <StatusBadge label={formatModelCatalogSourceLabel(catalog.source)} tone={catalog.source === 'runtime' ? 'ready' : 'draft'} />
            <StatusBadge label={t('providers.modelCatalog.scenarioBadge', { scenario: formatScenarioLabel(targetScenario) })} tone="pending" />
            <button className="provider-header-icon" onClick={onOpenCapabilityRegistry} title={t('providers.modelCatalog.editCapabilitiesTitle')} type="button">
              <AppIcon name="edit" size={14} />
            </button>
            <button className="provider-header-icon" onClick={onRefresh} title={t('providers.modelCatalog.refreshTitle')} type="button">
              <AppIcon name="refresh" size={14} />
            </button>
            <button className="provider-header-icon" onClick={onClose} title={t('providers.modelCatalog.closeTitle')} type="button">
              <AppIcon name="close" size={13} />
            </button>
          </div>
        </div>

        <div className="provider-scenario-switcher">
          {(['all', ...providerScenarioOrder] as ModelCatalogScenarioFilter[]).map((scenario) => (
            <button
              className={selectedScenario === scenario ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
              key={scenario}
              onClick={() => onScenarioChange(scenario)}
              type="button"
            >
              {scenario === 'all' ? t('providers.modelCatalog.allScenarios') : formatScenarioLabel(scenario)}
            </button>
          ))}
        </div>

        <div className="provider-directory-search provider-directory-search-compact">
          <AppIcon name="search" size={14} />
          <input
            className="provider-directory-search-input"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('providers.modelCatalog.searchPlaceholder')}
            type="search"
            value={query}
          />
        </div>

        {catalog.error ? <div className="provider-inline-alert provider-inline-alert-warning">{catalog.error}</div> : null}
        {catalog.fetchedAt ? <p className="provider-setting-footnote">{t('providers.modelCatalog.lastRefresh', { time: formatTimestampLabel(catalog.fetchedAt) })}</p> : null}

        <div className="provider-model-list provider-model-list-modal">
          {catalogSections.map((section) => (
            <section className="provider-capability-section" key={section.capability}>
              <div className="provider-capability-section-header">
                <div className={`provider-capability-badge provider-capability-badge-${section.capability}`}>
                  <AppIcon name={resolveCapabilityIconName(section.capability)} size={14} />
                </div>
                <div>
                  <strong>{t(providerCapabilityLabelKey(section.capability))}</strong>
                  <p>{t('providers.modelCatalog.modelCount', { count: section.models.length })}</p>
                </div>
              </div>

              <div className="provider-capability-section-list">
                {section.models.map((model) => (
                  <ProviderModelCatalogItem
                    added={isModelAdded(selectedScenario, model.id)}
                    key={`${section.capability}-${model.id}`}
                    model={model}
                    onToggle={() => onToggleModel(targetScenario, model)}
                  />
                ))}
              </div>
            </section>
          ))}

          {uncategorizedModels.length > 0 ? (
            <section className="provider-capability-section" key="unclassified-models">
              <div className="provider-capability-section-header">
                <div className="provider-capability-badge provider-capability-badge-unclassified">
                  <AppIcon name="alert" size={14} />
                </div>
                <div>
                  <strong>{t('providers.modelCatalog.uncategorized')}</strong>
                  <p>{t('providers.modelCatalog.modelCount', { count: uncategorizedModels.length })}</p>
                </div>
              </div>

              <div className="provider-capability-section-list">
                {uncategorizedModels.map((model) => (
                  <ProviderModelCatalogItem
                    added={isModelAdded(selectedScenario, model.id)}
                    key={`unclassified-${model.id}`}
                    model={model}
                    onToggle={() => onToggleModel(targetScenario, model)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div className="provider-scene-manual-row" style={{ marginTop: 12, padding: '0 16px 16px' }}>
          <input
            className="text-input"
            onChange={(event) => onManualDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onManualAdd();
              }
            }}
            placeholder={t('providers.modelCatalog.manualPlaceholder')}
            value={manualModelIdDraft}
          />
          <button className="icon-button" onClick={onManualAdd} type="button">
            <AppIcon name="plus" size={14} />
            {t('providers.modelCatalog.manualAdd')}
          </button>
        </div>
    </ModalDialog>
  );
}
