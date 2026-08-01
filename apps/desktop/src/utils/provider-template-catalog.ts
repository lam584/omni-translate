import type { ProviderTemplate } from '../schema/provider-template';

const PROVIDER_TEMPLATE_CATALOG_STORAGE_KEY = 'omni.providerTemplateCatalogPrefs';
export const PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT = 'omni.providerTemplateCatalogPrefs.updated';

export type ProviderTemplateCatalogPreference = {
  templateId: string;
  enabled: boolean;
  order: number;
  hidden?: boolean;
};

export type ProviderTemplateCatalogEntry = {
  template: ProviderTemplate;
  enabled: boolean;
  order: number;
  hidden: boolean;
};

const DEFAULT_ENABLED_TEMPLATE_IDS = new Set([
  'template-dashscope-realtime',
  'template-deepseek',
]);

function storageAvailable() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readProviderTemplateCatalogPreferences(): ProviderTemplateCatalogPreference[] {
  if (!storageAvailable()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(PROVIDER_TEMPLATE_CATALOG_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProviderTemplateCatalogPreference[]) : [];
  } catch {
    return [];
  }
}

export function writeProviderTemplateCatalogPreferences(preferences: ProviderTemplateCatalogPreference[]) {
  if (!storageAvailable()) {
    return;
  }

  window.localStorage.setItem(PROVIDER_TEMPLATE_CATALOG_STORAGE_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, { detail: preferences }));
}

export function buildProviderTemplateCatalogEntries(
  templates: ProviderTemplate[],
  preferences: ProviderTemplateCatalogPreference[],
): ProviderTemplateCatalogEntry[] {
  const preferenceMap = new Map(preferences.map((item) => [item.templateId, item]));

  return templates
    .map((template, index) => {
      const preference = preferenceMap.get(template.id);

      return {
        template,
        enabled: preference?.enabled ?? DEFAULT_ENABLED_TEMPLATE_IDS.has(template.id),
        order: preference?.order ?? index,
        hidden: preference?.hidden ?? false,
      };
    })
    .sort((left, right) => left.order - right.order || left.template.displayName.localeCompare(right.template.displayName));
}

export function persistProviderTemplateCatalogEntries(entries: ProviderTemplateCatalogEntry[]) {
  writeProviderTemplateCatalogPreferences(
    entries.map((entry, index) => ({
      templateId: entry.template.id,
      enabled: entry.enabled,
      order: index,
      hidden: entry.hidden,
    })),
  );
}
