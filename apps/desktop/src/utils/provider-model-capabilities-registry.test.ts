import { describe, expect, it } from 'vitest';
import type { ProviderDraft } from '../schema/config';
import vectors from '../schema/model-registry-migration-vectors.json';
import { migrateProviderModelRegistry, resolveModelCapabilityOverride } from './provider-model-capabilities-registry';

describe('instance model registry v2', () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const provider = migrateProviderModelRegistry(vector.input as unknown as ProviderDraft);
      expect(provider.modelCapabilityOverrides).toEqual(vector.overrides);
      if (vector.resolveModelId) {
        const resolved = resolveModelCapabilityOverride(vector.resolveModelId, null, provider.modelCapabilityOverrides ?? []);
        expect(resolved.entry?.capabilities).toEqual(vector.resolvedCapabilities);
        expect(resolved.diagnostics).toEqual(['duplicate-model-id']);
      }
      expect(migrateProviderModelRegistry(provider)).toEqual(provider);
      expect(provider.localModelCapabilityRegistry).toEqual(vector.input.localModelCapabilityRegistry);
    });
  }
  it('uses exact IDs and preserves empty arrays and duplicate diagnostics', () => {
    const inherited = { id: 'seed', modelId: 'Exact', capabilities: ['speech-to-text' as const] };
    expect(resolveModelCapabilityOverride('Exact', inherited, [{modelId: 'Exact', capabilities: []}]).entry?.capabilities).toEqual([]);
    expect(resolveModelCapabilityOverride('exact', null, [{modelId: 'Exact', capabilities: []}]).entry).toBeNull();
    expect(resolveModelCapabilityOverride('Exact', inherited, [{modelId: 'Exact'}, {modelId: 'Exact'}]).diagnostics).toEqual(['duplicate-model-id']);
  });
});
import resolutionVectors from '../schema/model-registry-resolution-vectors.json';
import type { ProviderModelCapabilityOverride, ProviderModelCapabilityRegistryEntry } from '../schema/config';
for (const vector of resolutionVectors) {
  it(`shared resolution: ${vector.name}`, () => {
    const result = resolveModelCapabilityOverride(vector.modelId,
      vector.inherited as ProviderModelCapabilityRegistryEntry | null,
      vector.overrides as ProviderModelCapabilityOverride[]);
    if (vector.duplicate) expect(result.diagnostics).toEqual(['duplicate-model-id']);
    expect(result.entry).toEqual(vector.expected);
  });
}
import { appConfigDraftMock as productionDefaults } from '../defaults/app-config';
import { effectiveProviderModelRegistry, modelRegistryEditorPatch, resetModelCapabilityOverride } from './provider-model-capabilities-registry';
import { PROVIDER_MANIFEST_REGISTRY } from '../provider-manifest/bundle';
it('persists only advisory deltas for new configs, including restore, while projecting the complete module', () => {
  const provider = structuredClone(productionDefaults.providers[0]);
  expect(provider.modelRegistryVersion).toBe(2);
  expect(provider.localModelCapabilityRegistry).toEqual([]);
  expect(provider.modelCapabilityOverrides).toEqual([]);
  const projected = effectiveProviderModelRegistry(provider);
  const manifest = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(provider.templateId)!;
  expect(projected.map((entry) => entry.modelId)).toEqual(manifest.models.map((model) => model.id));
  const row = projected.find((entry) => entry.capabilities.length > 0)!;
  const patch = modelRegistryEditorPatch(provider, projected.map((entry) => entry.id === row.id ? { ...entry, capabilities: [] } : entry), projected);
  expect(patch.localModelCapabilityRegistry).toEqual([]);
  expect(patch.modelCapabilityOverrides).toEqual([{modelId: row.modelId, capabilities: [], source: 'user'}]);
  const restored = resetModelCapabilityOverride({ ...provider, ...patch }, row.modelId);
  expect(restored.localModelCapabilityRegistry).toEqual([]);
  expect(restored.modelCapabilityOverrides).toEqual([]);
});
it('supports missing optional v2 arrays and preserves custom manual migration metadata', () => {
  const sparse = { ...productionDefaults.providers[0], modelCapabilityOverrides: undefined, localModelCapabilityRegistry: undefined as never };
  const projected = effectiveProviderModelRegistry(sparse);
  expect(projected.some((row) => row.modelId === sparse.model)).toBe(true);
  expect(resetModelCapabilityOverride(sparse, 'missing').modelCapabilityOverrides).toEqual([]);
  const patch = modelRegistryEditorPatch(sparse, [{id: 'user-row', modelId: 'my.Model', capabilities: [], notes: 'mine'}]);
  expect(patch.modelCapabilityOverrides).toEqual([{modelId: 'my.Model', source: 'user', capabilities: [], notes: 'mine'}]);
  expect(patch.localModelCapabilityRegistry).toEqual([{id: 'user-row', modelId: 'my.Model', capabilities: [], notes: 'mine'}]);
  const legacy = migrateProviderModelRegistry({ ...sparse, modelRegistryVersion: undefined, localModelCapabilityRegistry: [{id: 'user', modelId: 'my.Model', source: 'manual', capabilities: [], notes: 'retained'}] });
  expect(legacy.modelCapabilityOverrides).toEqual([{modelId: 'my.Model', source: 'user', capabilities: [], notes: 'retained'}]);
  expect(migrateProviderModelRegistry({...sparse, modelRegistryVersion: undefined}).modelCapabilityOverrides).toEqual([]);
});
it('preserves inherited overrides on partial edits, reports duplicates, and keeps instances isolated', () => {
  const row = { id: 'custom', modelId: 'my.Model', capabilities: ['text-generation' as const], notes: 'before' };
  const provider: ProviderDraft = {...productionDefaults.providers[0], localModelCapabilityRegistry: [row], modelCapabilityOverrides: [
    {modelId: row.modelId, source: 'legacy', capabilities: ['text-generation'], notes: 'before'},
    {modelId: 'another', notes: 'untouched'},
  ]};
  const patch = modelRegistryEditorPatch(provider, [{...row, notes: 'after'}]);
  expect(patch.modelCapabilityOverrides).toEqual([{modelId: row.modelId, source: 'user', capabilities: ['text-generation'], notes: 'after'}, {modelId: 'another', notes: 'untouched'}]);
  const removed = modelRegistryEditorPatch(provider, []);
  expect(removed.modelCapabilityOverrides?.[0]).toMatchObject({modelId: row.modelId, hidden: true, capabilities: []});
  const duplicate = effectiveProviderModelRegistry({...provider, modelCapabilityOverrides: [{modelId: row.modelId, notes: 'first'}, {modelId: row.modelId, notes: 'second'}]}).find((entry) => entry.modelId === row.modelId);
  expect(duplicate).toMatchObject({notes: 'first', registryDiagnostics: ['duplicate-model-id']});
  expect(effectiveProviderModelRegistry(productionDefaults.providers[0]).some((entry) => entry.modelId === row.modelId)).toBe(false);
  const unregistered = {...provider, templateId: 'template-without-module', modelCapabilityOverrides: [{modelId: 'only-override', capabilities: []}]};
  expect(effectiveProviderModelRegistry(unregistered).find((entry) => entry.modelId === 'only-override')).toMatchObject({id:'override-only-override', capabilities: []});
});

it('inherits discovered capabilities for notes-only unknown overrides but honors explicit empty arrays', async () => {
  const { resolveProviderModelCapabilities } = await import('./provider-model-capabilities');
  const provider: ProviderDraft = { ...productionDefaults.providers[0], modelCapabilityOverrides: [{modelId: 'new.Exact', notes: 'my note'}] };
  const discovered = { id: 'new.Exact', displayName: 'New', capabilities: ['text-generation' as const] };
  const registry = effectiveProviderModelRegistry(provider);
  expect(registry.find((entry) => entry.modelId === discovered.id)).toMatchObject({ notes: 'my note', inheritUpstreamCapabilities: true });
  expect(resolveProviderModelCapabilities(discovered, registry)).toEqual(['text-generation']);
  provider.modelCapabilityOverrides![0].capabilities = [];
  expect(resolveProviderModelCapabilities(discovered, effectiveProviderModelRegistry(provider))).toEqual([]);
});

it('keeps opaque legacy data and duplicate evidence when editing a projected row', () => {
  const first = { id: 'row', modelId: 'custom', capabilities: ['text-generation' as const], notes: 'first', futureOpaque: {keep: true} };
  const duplicate = { ...first, notes: 'duplicate evidence', futureOpaque: {keep: false} };
  const other = { id: 'other', modelId: 'other', capabilities: [], futureOpaque: {untouched: true} };
  const provider: ProviderDraft = { ...productionDefaults.providers[0], localModelCapabilityRegistry: [first, duplicate, other],
    modelCapabilityOverrides: [{modelId: 'custom', capabilities: ['text-generation']}],
  };
  const edited = { id: 'row', modelId: 'custom', capabilities: ['text-generation' as const], notes: 'changed' };
  const patch = modelRegistryEditorPatch(provider, [edited], [first]);
  expect(patch.localModelCapabilityRegistry).toEqual([{...first, notes: 'changed'}, duplicate, other]);
  expect(provider.localModelCapabilityRegistry).toEqual([first, duplicate, other]);
  const removal = modelRegistryEditorPatch(provider, [], [first]);
  expect(removal.localModelCapabilityRegistry).toEqual([other]);
});
it('does not persist unchanged inherited projection rows during legacy editing', () => {
  const provider = {...productionDefaults.providers[0], modelRegistryVersion: undefined, localModelCapabilityRegistry: []};
  const projected = effectiveProviderModelRegistry(provider);
  expect(modelRegistryEditorPatch(provider, projected, projected).localModelCapabilityRegistry).toEqual([]);
});
