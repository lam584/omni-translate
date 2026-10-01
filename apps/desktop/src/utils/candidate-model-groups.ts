import type { CandidateModelGroupId, ProviderCandidateModelGroup, ProviderDraft } from '../schema/config';

export const candidateModelGroupOrder: readonly CandidateModelGroupId[] = [
  'text-processing',
  'audio-understanding',
  'audio-generation',
  'realtime-multimodal',
];

export function emptyCandidateModelGroups(): ProviderCandidateModelGroup[] {
  return candidateModelGroupOrder.map((group) => ({ group, modelIds: [] }));
}

/** Normalize persisted candidate pools without interpreting obsolete scene assignments. */
export function ensureCandidateModelGroups(groups: ProviderCandidateModelGroup[] | undefined): ProviderCandidateModelGroup[] {
  return candidateModelGroupOrder.map((group) => ({
    group,
    modelIds: [...new Set((groups ?? []).find((item) => item.group === group)?.modelIds ?? [])],
  }));
}

/** Hydrate once at the config load boundary. Legacy scene selections never become candidates. */
export function migrateProviderCandidateModelGroups(provider: ProviderDraft): ProviderDraft {
  const groups = ensureCandidateModelGroups(provider.candidateModelGroups);
  const hasLegacyAssignments = Object.prototype.hasOwnProperty.call(provider, 'sceneModelAssignments');
  if (!hasLegacyAssignments && provider.candidateModelGroups
    && JSON.stringify(groups) === JSON.stringify(provider.candidateModelGroups)) return provider;
  const { sceneModelAssignments: _legacy, ...rest } = provider as ProviderDraft & { sceneModelAssignments?: unknown };
  void _legacy;
  return { ...rest, candidateModelGroups: groups };
}