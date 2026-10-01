import { describe, expect, it } from 'vitest';
import type { CandidateModelGroupId } from '../schema/config';
import { collectProviderModelOptions, type ProviderModelSource } from './provider-model-options';

type FixtureProvider = ProviderModelSource & {
  displayName: string;
  authReference: string;
};

function makeProvider(
  templateId: string,
  displayName: string,
  assignments: Array<[CandidateModelGroupId, string[]]>,
  authReference = '',
): FixtureProvider {
  return {
    templateId,
    displayName,
    authReference,
    candidateModelGroups: assignments.map(([group, modelIds]) => ({ group, modelIds })),
  };
}

describe('collectProviderModelOptions', () => {
  it('AudioRouting 形态：provider-model 粒度去重 + 模板启用过滤，遍历全部场景', () => {
    const providers = [
      makeProvider('tpl-a', 'Provider A', [
        ['audio-understanding', ['m1', 'm2']],
        ['audio-generation', ['m1']],
      ]),
      makeProvider('tpl-disabled', 'Provider Disabled', [['audio-understanding', ['m1']]]),
      makeProvider('tpl-c', 'Provider C', [['realtime-multimodal', ['m1']]]),
    ];

    const result = collectProviderModelOptions(providers, {
      templateFilter: new Set(['tpl-a', 'tpl-c']),
      dedupeKey: 'provider-model',
      project: ({ templateId, modelId, group, provider }) => ({
        key: `${templateId}::${modelId}`,
        group,
        providerName: provider.displayName,
      }),
    });

    expect(result).toEqual([
      // 同一 provider 内 m1 在 watch/game 两个场景出现，仅保留首个（watch）
      { key: 'tpl-a::m1', group: 'audio-understanding', providerName: 'Provider A' },
      { key: 'tpl-a::m2', group: 'audio-understanding', providerName: 'Provider A' },
      // 不同 provider 的同名模型不互相去重（provider-model 粒度）
      { key: 'tpl-c::m1', group: 'realtime-multimodal', providerName: 'Provider C' },
    ]);
  });

  it('Diagnostics 形态：裸 modelId 全局去重（先到先得）+ 无模板过滤 + 场景白名单，project 可取 provider 级字段', () => {
    const providers = [
      makeProvider('tpl-1', 'Provider 1', [['audio-understanding', ['shared', 'p1-only']]], 'ref-1'),
      makeProvider(
        'tpl-2-would-be-disabled',
        'Provider 2',
        [
          ['audio-generation', ['shared']],
          ['realtime-multimodal', ['p2-model']],
          ['text-processing', ['sub-model']],
        ],
        'ref-2',
      ),
    ];

    const result = collectProviderModelOptions(providers, {
      groups: ['audio-understanding', 'audio-generation', 'realtime-multimodal'],
      dedupeKey: 'model',
      project: ({ modelId, provider }) => ({
        modelId,
        // 组装 BenchmarkVoiceModel 所需的 provider 级字段可以直接从 provider 上取
        authReference: provider.authReference,
      }),
    });

    expect(result).toEqual([
      // shared 全局先到先得，归属第一个 provider（保留其 provider 级字段）
      { modelId: 'shared', authReference: 'ref-1' },
      { modelId: 'p1-only', authReference: 'ref-1' },
      // 无模板过滤：未在任何启用集合中的 provider 也参与
      { modelId: 'p2-model', authReference: 'ref-2' },
      // sub-model 被场景白名单排除
    ]);
    expect(result.map((item) => item.modelId)).not.toContain('sub-model');
  });

  it('Glossary 形态：仅 subtitle-translate 场景 + 仅 enabled 模板集合 + 裸 modelId 去重', () => {
    const providers = [
      makeProvider('tpl-a', 'Provider A', [
        ['text-processing', ['s1', 's2']],
        ['audio-understanding', ['w1']],
      ]),
      makeProvider('tpl-b', 'Provider B', [['text-processing', ['s3']]]),
      makeProvider('tpl-hidden-but-enabled', 'Provider H', [['text-processing', ['s1']]]),
    ];

    const result = collectProviderModelOptions(providers, {
      groups: ['text-processing'],
      // Glossary 的集合只看 enabled（不看 hidden），因此 hidden 模板也可出现在集合里
      templateFilter: new Set(['tpl-a', 'tpl-hidden-but-enabled']),
      dedupeKey: 'model',
      project: ({ modelId, provider }) => ({
        modelId,
        displayName: modelId,
        providerName: provider.displayName,
      }),
    });

    expect(result).toEqual([
      { modelId: 's1', displayName: 's1', providerName: 'Provider A' },
      { modelId: 's2', displayName: 's2', providerName: 'Provider A' },
    ]);
  });

  it('容忍 candidateModelGroups 缺失（运行时防御，与页面 ?? [] 行为一致）', () => {
    const providers = [
      { templateId: 'tpl-a', displayName: 'Provider A', authReference: '', candidateModelGroups: undefined } as unknown as FixtureProvider,
      makeProvider('tpl-b', 'Provider B', [['audio-understanding', ['m1']]]),
    ];

    const result = collectProviderModelOptions(providers, {
      dedupeKey: 'model',
      project: ({ modelId }) => modelId,
    });

    expect(result).toEqual(['m1']);
  });
});
