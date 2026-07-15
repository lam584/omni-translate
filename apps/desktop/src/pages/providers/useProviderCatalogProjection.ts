import { useMemo } from 'react';

import type { ProviderScenario } from '../../schema/config';
import type { ProviderTemplateCatalogEntry } from '../../utils/provider-template-catalog';
import { capabilityForScenario, providerCapabilityOrder } from '../../utils/provider-model-capabilities';
import type { ModelCatalogScenarioFilter, ModelCatalogState } from './providersPageHelpers';

type Params = {
  modelCatalog: ModelCatalogState;
  modelCatalogQuery: string;
  selectedCatalogScenario: ModelCatalogScenarioFilter;
  templateEntries: ProviderTemplateCatalogEntry[];
  templateQuery: string;
};

export function useProviderCatalogProjection({
  modelCatalog,
  modelCatalogQuery,
  selectedCatalogScenario,
  templateEntries,
  templateQuery,
}: Params) {
  const filteredTemplateEntries = useMemo(() => {
    const query = templateQuery.trim().toLowerCase();
    if (!query) return templateEntries;
    return templateEntries.filter(({ template }) => [
      template.displayName,
      template.description,
      template.notes,
      template.protocolLabel,
      ...template.presetModels.map((preset) => `${preset.displayName} ${preset.model}`),
    ].join(' ').toLowerCase().includes(query));
  }, [templateEntries, templateQuery]);

  const filteredCatalogModels = useMemo(() => {
    const capability = selectedCatalogScenario === 'all' ? null : capabilityForScenario(selectedCatalogScenario);
    const matches = capability ? modelCatalog.models.filter((model) => model.capabilities.includes(capability)) : modelCatalog.models;
    const candidates = capability && matches.length === 0 && modelCatalog.models.length > 0 ? modelCatalog.models : matches;
    const query = modelCatalogQuery.trim().toLowerCase();
    if (!query) return candidates;
    return candidates.filter((model) => [model.id, model.displayName, model.ownedBy ?? '', ...model.capabilities]
      .join(' ').toLowerCase().includes(query));
  }, [modelCatalog.models, modelCatalogQuery, selectedCatalogScenario]);

  const scenarioFilterHasMatches = useMemo(() => selectedCatalogScenario === 'all'
    || modelCatalog.models.some((model) => model.capabilities.includes(capabilityForScenario(selectedCatalogScenario))),
  [modelCatalog.models, selectedCatalogScenario]);

  const catalogSections = useMemo(() => {
    const capabilities = selectedCatalogScenario === 'all' || !scenarioFilterHasMatches
      ? providerCapabilityOrder
      : [capabilityForScenario(selectedCatalogScenario as ProviderScenario)];
    return capabilities.map((capability) => ({
      capability,
      models: filteredCatalogModels.filter((model) => model.capabilities.includes(capability)),
    })).filter((section) => section.models.length > 0);
  }, [filteredCatalogModels, scenarioFilterHasMatches, selectedCatalogScenario]);

  const uncategorizedCatalogModels = useMemo(() => selectedCatalogScenario === 'all'
    ? filteredCatalogModels.filter((model) => model.capabilities.length === 0)
    : [], [filteredCatalogModels, selectedCatalogScenario]);

  return { catalogSections, filteredCatalogModels, filteredTemplateEntries, uncategorizedCatalogModels };
}
