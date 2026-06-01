import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerTemplates } from '../mocks/provider-templates';
import {
  PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT,
  buildProviderTemplateCatalogEntries,
  persistProviderTemplateCatalogEntries,
  readProviderTemplateCatalogPreferences,
  writeProviderTemplateCatalogPreferences,
} from './provider-template-catalog';

describe('provider template catalog', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists preferences and dispatches the catalog update event', () => {
    const listener = vi.fn();
    window.addEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, listener);
    const entries = buildProviderTemplateCatalogEntries(providerTemplates.slice(0, 3), []);

    persistProviderTemplateCatalogEntries(entries.reverse());

    expect(readProviderTemplateCatalogPreferences()).toHaveLength(3);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, listener);
  });

  it('ignores missing, non-array and malformed preferences', () => {
    expect(readProviderTemplateCatalogPreferences()).toEqual([]);
    window.localStorage.setItem('omni.providerTemplateCatalogPrefs', '{}');
    expect(readProviderTemplateCatalogPreferences()).toEqual([]);
    window.localStorage.setItem('omni.providerTemplateCatalogPrefs', '{broken-json');
    expect(readProviderTemplateCatalogPreferences()).toEqual([]);
  });

  it('sorts equal preferences by display name and works without browser storage', () => {
    const templates = providerTemplates.slice(0, 2).map((template) => ({ ...template, displayName: template.id }));
    const entries = buildProviderTemplateCatalogEntries(templates.reverse(), [
      { templateId: templates[0].id, enabled: true, order: 1 },
      { templateId: templates[1].id, enabled: false, order: 1, hidden: true },
    ]);
    expect(entries.map((entry) => entry.template.displayName)).toEqual(
      entries.map((entry) => entry.template.displayName).toSorted(),
    );

    vi.stubGlobal('window', undefined);
    expect(readProviderTemplateCatalogPreferences()).toEqual([]);
    expect(() => writeProviderTemplateCatalogPreferences([])).not.toThrow();
  });
});
