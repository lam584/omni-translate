import type { ProviderDraft, ProviderScenario } from '../schema/config';

/** 遍历 providers 时只依赖的最小结构；页面传完整 ProviderDraft，测试可传最小 fixture。 */
export type ProviderModelSource = Pick<ProviderDraft, 'templateId' | 'sceneModelAssignments'>;

export type ProviderModelEntry<P extends ProviderModelSource> = {
  templateId: string;
  modelId: string;
  scenario: ProviderScenario;
  provider: P;
};

export type ProviderModelDedupeKey = 'provider-model' | 'model';

export type CollectProviderModelOptionsConfig<P extends ProviderModelSource, T> = {
  /** 场景白名单；缺省表示遍历全部 sceneModelAssignments。 */
  scenarios?: readonly ProviderScenario[];
  /** 允许的 templateId 集合；undefined 表示不做模板过滤（Diagnostics 现状）。 */
  templateFilter?: ReadonlySet<string>;
  /** 'provider-model' 按 `${templateId}::${modelId}` 去重；'model' 按裸 modelId 全局先到先得。 */
  dedupeKey: ProviderModelDedupeKey;
  /** 每个首次出现的 (dedupe key) 条目回调一次；provider 级字段由调用方自取。 */
  project: (entry: ProviderModelEntry<P>) => T;
};

/**
 * providers × sceneModelAssignments → 模型选项的共享三层遍历。
 * 去重、过滤、投影全部参数化：三个调用方（AudioRouting / Diagnostics / Glossary）
 * 各自的语义差异（去重粒度、模板启用过滤口径、场景白名单、展示名来源）留在页面侧。
 */
export function collectProviderModelOptions<P extends ProviderModelSource, T>(
  providers: readonly P[],
  options: CollectProviderModelOptionsConfig<P, T>,
): T[] {
  const { scenarios, templateFilter, dedupeKey, project } = options;
  const collected = new Map<string, T>();

  for (const provider of providers) {
    if (templateFilter && !templateFilter.has(provider.templateId)) continue;
    for (const assignment of provider.sceneModelAssignments ?? []) {
      if (scenarios && !scenarios.includes(assignment.scenario)) continue;
      for (const modelId of assignment.modelIds) {
        const key = dedupeKey === 'provider-model' ? `${provider.templateId}::${modelId}` : modelId;
        if (collected.has(key)) continue;
        collected.set(key, project({ templateId: provider.templateId, modelId, scenario: assignment.scenario, provider }));
      }
    }
  }

  return [...collected.values()];
}
