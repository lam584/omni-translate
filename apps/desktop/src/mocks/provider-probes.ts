import type { ProviderProbeProfile } from '../schema/provider-probe';

export const providerProbeProfiles: ProviderProbeProfile[] = [
  {
    id: 'probe-openai-baseline',
    templateId: 'template-openai-compatible-realtime',
    providerId: 'provider-openai',
    verdict: 'realtime-risk',
    checkedAt: '2026-05-10T10:20:00+08:00',
    measuredLatencyMs: 1680,
    latencyBudgetMs: 1200,
    streamSupported: true,
    errorShapeStable: true,
    responseShapeStable: true,
    checks: [
      {
        id: 'probe-openai-streaming',
        key: 'streaming',
        label: '流式能力',
        status: 'pass',
        summary: '能够稳定返回增量文本事件，可作为字幕链路输入。',
      },
      {
        id: 'probe-openai-latency',
        key: 'latency',
        label: '实时适用性',
        status: 'warn',
        summary: '当前样例延迟高于实时预算，适合字幕优先，不建议默认开启译音。',
      },
      {
        id: 'probe-openai-errors',
        key: 'error-shape',
        label: '错误结构',
        status: 'pass',
        summary: '错误结构稳定，便于统一提示与重试策略。',
      },
      {
        id: 'probe-openai-response-shape',
        key: 'response-shape',
        label: '响应格式稳定性',
        status: 'pass',
        summary: '响应结构稳定，可供后续 Gateway 正常解析。',
      },
    ],
    guidance: [
      '可用于字幕链路。',
      '默认关闭译音叠加，避免高延迟阻塞字幕。',
      '建议在高级模式中保留更高 timeout 但打开字幕优先。',
    ],
  },
  {
    id: 'probe-dashscope-baseline',
    templateId: 'template-dashscope-realtime',
    providerId: 'provider-dashscope',
    verdict: 'available',
    checkedAt: '2026-05-10T10:30:00+08:00',
    measuredLatencyMs: 820,
    latencyBudgetMs: 1200,
    streamSupported: true,
    errorShapeStable: true,
    responseShapeStable: true,
    checks: [
      {
        id: 'probe-dashscope-streaming',
        key: 'streaming',
        label: '流式能力',
        status: 'pass',
        summary: 'WebSocket 实时返回稳定，适合持续增量翻译。',
      },
      {
        id: 'probe-dashscope-latency',
        key: 'latency',
        label: '实时适用性',
        status: 'pass',
        summary: '延迟处于预算内，可进入实时字幕与译音链路。',
      },
      {
        id: 'probe-dashscope-errors',
        key: 'error-shape',
        label: '错误结构',
        status: 'pass',
        summary: '错误返回结构稳定，适合统一诊断提示。',
      },
      {
        id: 'probe-dashscope-response-shape',
        key: 'response-shape',
        label: '响应格式稳定性',
        status: 'pass',
        summary: '响应事件可预测，后续 Gateway 可直接复用。',
      },
    ],
    guidance: [
      '可作为实时字幕与译音的优先模板。',
      '推荐默认启用 WebSocket。',
      '继续沿用模板层的区域和提示词默认值。',
    ],
  },
];

export const defaultProviderProbeProfile = providerProbeProfiles[1];