import type { ProviderDraft, ProviderModelCapabilityOverride, ProviderModelCapabilityRegistryEntry } from '../schema/config';
import frozenSeeds from '../schema/model-registry-v1-seed.json';

// These fields are advisory, never protocol authority. Preserve all other fields
// in the original legacy rows for compatibility and future migration tools.
const fields = ['capabilities', 'interactionCapabilities', 'apiModes', 'realtimeAudioMode', 'notes', 'hidden', 'displayName'] as const;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function migrateProviderModelRegistry<T extends ProviderDraft>(provider: T): T {
  if (provider.modelRegistryVersion === 2) return provider;
  const overrides: ProviderModelCapabilityOverride[] = [...(provider.modelCapabilityOverrides ?? [])];
  for (const row of provider.localModelCapabilityRegistry ?? []) {
    const seed = frozenSeeds.find((candidate) => candidate.modelId === row.modelId && candidate.id === row.id);
    if (!seed || row.source === 'manual') {
      overrides.push({ modelId: row.modelId, source: row.source === 'manual' ? 'user' : 'legacy', ...advisoryFields(row) });
      continue;
    }
    const delta: ProviderModelCapabilityOverride = { modelId: row.modelId, source: 'legacy' };
    for (const field of fields) {
      const baseline = field === 'realtimeAudioMode'
        ? (seed as Record<string, unknown>)[field] ?? 'server_vad'
        : (seed as Record<string, unknown>)[field];
      if ((row as unknown as Record<string, unknown>)[field] !== undefined && !same((row as unknown as Record<string, unknown>)[field], baseline)) {
        Object.assign(delta, { [field]: (row as unknown as Record<string, unknown>)[field] });
      }
    }
    if (Object.keys(delta).length > 2) overrides.push(delta);
  }
  return { ...provider, modelRegistryVersion: 2, modelCapabilityOverrides: overrides };
}

function advisoryFields(row: object) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field))
    .map((field) => [field, (row as Record<string, unknown>)[field]]));
}

/** Exact ID; explicit user wins, ties retain the first row and emit diagnostics. */
export function resolveModelCapabilityOverride(
  modelId: string,
  inherited: ProviderModelCapabilityRegistryEntry | null,
  overrides: ProviderModelCapabilityOverride[],
) {
  const matches = overrides.filter((row) => row.modelId === modelId);
  const override = matches.find((row) => row.source !== 'legacy') ?? matches[0];
  return {
    entry: override ? { ...inherited, ...advisoryFields(override), modelId } : inherited,
    source: override ? 'override' as const : 'inherited' as const,
    diagnostics: matches.length > 1 ? ['duplicate-model-id'] : [],
  };
}
import { createDefaultLocalModelCapabilityRegistry } from './provider-model-capabilities';
import { PROVIDER_MANIFEST_REGISTRY } from '../provider-manifest/bundle';

/** Read-only compatibility projection; persisted legacy rows are never rewritten. */
export function effectiveProviderModelRegistry(provider: ProviderDraft): ProviderModelCapabilityRegistryEntry[] {
  const migrated = migrateProviderModelRegistry(provider);
  const manifest = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(provider.templateId);
  const defaults = createDefaultLocalModelCapabilityRegistry(provider.templateId).filter((entry) => !manifest || manifest.models.some((model) => model.id === entry.modelId));
  const overrideIds = (migrated.modelCapabilityOverrides ?? []).map((entry) => entry.modelId);
  const ids = new Set([...(provider.localModelCapabilityRegistry ?? []).filter((entry) => defaults.some((baseline) => baseline.modelId === entry.modelId) || overrideIds.includes(entry.modelId)).map((entry) => entry.modelId), ...defaults.map((entry) => entry.modelId), ...overrideIds]);
  return [...ids].map((modelId) => {
    const baseline = defaults.find((entry) => entry.modelId === modelId) ?? null;
    const result = resolveModelCapabilityOverride(modelId, baseline, migrated.modelCapabilityOverrides ?? []);
    return {
      id: provider.localModelCapabilityRegistry?.find((entry) => entry.modelId === modelId)?.id ?? baseline?.id ?? `override-${modelId}`, capabilities: [], ...result.entry,
      modelId,
      source: result.source === 'override' ? 'manual' as const : baseline?.source,
      registryDiagnostics: result.diagnostics,
      ...(result.entry?.capabilities === undefined ? { inheritUpstreamCapabilities: true } : {}),
    };
  });
}
export function modelRegistryEditorPatch(provider: ProviderDraft, entries: ProviderModelCapabilityRegistryEntry[], previousEntries?: ProviderModelCapabilityRegistryEntry[]): Partial<ProviderDraft> {
  const migrated = migrateProviderModelRegistry(provider);
  const previous = previousEntries ?? provider.localModelCapabilityRegistry ?? [];
  const changed = entries.filter((entry) => !previous.some((old) => old.id === entry.id && same(old, entry)));
  const removed = previous.filter((entry) => !entries.some((next) => next.id === entry.id));
  const ids = new Set([...changed, ...removed].map((entry) => entry.modelId));
  const overrides: ProviderModelCapabilityOverride[] = [
    ...changed.map((entry) => {
      const before = previous.find((row) => row.id === entry.id && row.modelId === entry.modelId);
      const existing = (migrated.modelCapabilityOverrides ?? []).find((row) => row.modelId === entry.modelId && row.source !== 'legacy')
        ?? (migrated.modelCapabilityOverrides ?? []).find((row) => row.modelId === entry.modelId);
      const delta = Object.fromEntries(fields.filter((field) => entry[field] !== undefined && (!before || !same(entry[field], before[field])))
        .map((field) => [field, entry[field]]));
      return { modelId: entry.modelId, ...advisoryFields(existing ?? {}), ...delta, source: 'user' as const };
    }),
    ...removed.filter((entry) => !changed.some((next) => next.modelId === entry.modelId)).map((entry) => ({ modelId: entry.modelId, source: 'user' as const, hidden: true, capabilities: [] })),
    ...(migrated.modelCapabilityOverrides ?? []).filter((entry) => !ids.has(entry.modelId)),
  ];
  const module = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(provider.templateId);
  const legacyIds = new Set((provider.localModelCapabilityRegistry ?? []).map((entry) => entry.id));
  const compatibilityRows = provider.modelRegistryVersion === 2
    ? entries.filter((entry) => legacyIds.has(entry.id) || !module?.models.some((model) => model.id === entry.modelId))
    : entries;
  // A projection omits shadowed/opaque legacy rows. Preserve them when an
  // unrelated row is edited; only an explicit removal deletes its legacy ID.
  const changes = new Map(changed.map((row) => [row.id, row]));
  const removals = new Set(removed.map((row) => row.id));
  const consumed = new Set<string>();
  const retained = (provider.localModelCapabilityRegistry ?? []).filter((row) => !removals.has(row.id)).map((row) => {
    const change = changes.get(row.id);
    if (!change || consumed.has(row.id)) return row;
    consumed.add(row.id);
    return { ...row, ...change };
  });
  const ordered: ProviderModelCapabilityRegistryEntry[] = [];
  const used = new Set<number>();
  for (const row of compatibilityRows) {
    const index = retained.findIndex((candidate, offset) => candidate.id === row.id && !used.has(offset));
    if (index >= 0) { ordered.push(retained[index]); used.add(index); }
    else if (changes.has(row.id)) ordered.push(row);
  }
  ordered.push(...retained.filter((_, index) => !used.has(index)));
  return { modelRegistryVersion: 2, modelCapabilityOverrides: overrides, localModelCapabilityRegistry: ordered };
}
export function resetModelCapabilityOverride(provider: ProviderDraft, modelId: string): Partial<ProviderDraft> {
  const migrated = migrateProviderModelRegistry(provider);
  const inherited = (provider.localModelCapabilityRegistry ?? []).some((entry) => entry.modelId === modelId)
    ? createDefaultLocalModelCapabilityRegistry(provider.templateId).filter((entry) => entry.modelId === modelId) : [];
  return {
    modelRegistryVersion: 2,
    modelCapabilityOverrides: (migrated.modelCapabilityOverrides ?? []).filter((entry) => entry.modelId !== modelId),
    localModelCapabilityRegistry: [...(provider.localModelCapabilityRegistry ?? []).filter((entry) => entry.modelId !== modelId), ...inherited],
  };
}
