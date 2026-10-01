import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { providerTemplates } from '../mocks/provider-templates';
import candidatePresetConfig from '../defaults/provider-candidate-presets.json';
import { buildProviderDraftPatchFromTemplate } from './provider-draft';
import type { CandidateModelGroupId, ProviderDraft, ProviderSceneModelAssignment } from '../schema/config';
import { candidateModelGroupOrder, emptyCandidateModelGroups, migrateProviderCandidateModelGroups } from './candidate-model-groups';

describe('provider candidate groups migration', () => {
  it('discards all old scene selections, preserving credentials, capabilities, and metadata', () => {
    const original = structuredClone(appConfigDraftMock.providers[0]) as ProviderDraft & { sceneModelAssignments: ProviderSceneModelAssignment[] };
    original.sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['legacy-watch'] },
      { scenario: 'game', modelIds: ['legacy-game'] },
      { scenario: 'voice-room', modelIds: ['legacy-voice'] },
      { scenario: 'subtitle-translate', modelIds: ['legacy-subtitle'] },
    ];
    original.authRef.reference = 'credential-reference';
    original.localModelCapabilityRegistry = [{ id: 'user-model', modelId: 'custom', source: 'manual', capabilities: ['text-generation'] } as ProviderDraft['localModelCapabilityRegistry'][number]];
    original.modelMetadataCache = { source: 'bailian-api', fetchedAt: '2026-01-01T00:00:00Z', endpoint: 'https://workspace.cn-beijing.example.invalid', models: [] };
    const migrated = migrateProviderCandidateModelGroups(original);
    expect(migrated).not.toHaveProperty('sceneModelAssignments');
    expect(JSON.stringify(migrated)).not.toContain('sceneModelAssignments');
    expect(migrated.candidateModelGroups).toEqual(emptyCandidateModelGroups());
    expect(migrated.authRef).toEqual(original.authRef);
    expect(migrated.localModelCapabilityRegistry).toEqual(original.localModelCapabilityRegistry);
    expect(migrated.modelMetadataCache).toEqual(original.modelMetadataCache);
    expect(migrateProviderCandidateModelGroups(migrated)).toBe(migrated);
    expect(original.sceneModelAssignments).toHaveLength(4);
  });

  it('does not emit the legacy property when creating a provider', () => {
    const patch = buildProviderDraftPatchFromTemplate(appConfigDraftMock.providers[0], providerTemplates[0]!);
    expect(patch).not.toHaveProperty('sceneModelAssignments');
    expect(patch.candidateModelGroups).toEqual(emptyCandidateModelGroups());
  });
  it('seeds only declared Workspace and DeepSeek candidate groups on new/reset drafts', () => {
    const current = structuredClone(appConfigDraftMock.providers[0]);
    current.candidateModelGroups = [{ group: 'audio-generation', modelIds: ['custom-tts'] }];
    const expected = [
      ['template-dashscope-workspace', [
        ['text-processing', ['qwen3.8-flash']],
        ['audio-understanding', ['qwen3.8-livetranslate-flash-realtime']],
        ['audio-generation', []],
        ['realtime-multimodal', ['qwen3.8-livetranslate-flash-realtime', 'qwen3.8-omni-flash-realtime']],
      ]],
      ['template-deepseek', [
        ['text-processing', ['deepseek-v4.1-flash']],
        ['audio-understanding', []],
        ['audio-generation', []],
        ['realtime-multimodal', []],
      ]],
    ] as const;
    for (const [templateId, groups] of expected) {
      const template = providerTemplates.find((item) => item.id === templateId)!;
      const configured: Partial<Record<CandidateModelGroupId, string[]>> = candidatePresetConfig[templateId];
      expect(configured).toEqual(Object.fromEntries(groups.filter(([, modelIds]) => modelIds.length)
        .map(([group, modelIds]) => [group, [...modelIds]])));
      const first = buildProviderDraftPatchFromTemplate(current, { ...template, presetModels: [] });
      expect(first.candidateModelGroups).toEqual(groups.map(([group, modelIds]) => ({ group, modelIds: [...modelIds] })));
      const reset = buildProviderDraftPatchFromTemplate({ ...current, ...first, candidateModelGroups: current.candidateModelGroups }, template);
      expect(reset.candidateModelGroups).toEqual(first.candidateModelGroups);
      expect(reset.candidateModelGroups).toEqual(candidateModelGroupOrder.map((group) => ({
        group, modelIds: [...(configured[group] ?? [])],
      })));
      expect(reset.candidateModelGroups).not.toBe(first.candidateModelGroups);
    }
  });
  it('keeps new candidate choices without treating legacy scenes as candidates', () => {
    const original = structuredClone(appConfigDraftMock.providers[0]) as ProviderDraft & { sceneModelAssignments: ProviderSceneModelAssignment[] };
    original.sceneModelAssignments = [{ scenario: 'watch', modelIds: ['obsolete-watch'] }];
    original.candidateModelGroups = [{ group: 'audio-generation', modelIds: ['my-tts', 'my-tts'] }];
    const migrated = migrateProviderCandidateModelGroups(original);
    expect(migrated).not.toHaveProperty('sceneModelAssignments');
    expect(migrated.candidateModelGroups?.map(({ group }) => group)).toEqual(candidateModelGroupOrder);
    expect(migrated.candidateModelGroups?.find(({ group }) => group === 'audio-generation')?.modelIds).toEqual(['my-tts']);
    expect(migrated.candidateModelGroups?.find(({ group }) => group === 'realtime-multimodal')?.modelIds).toEqual([]);
    expect(migrated.candidateModelGroups?.flatMap(({ modelIds }) => modelIds)).not.toContain(original.sceneModelAssignments[0]?.modelIds[0]);
  });
});
