import { defaultProviderProbeProfile, providerProbeProfiles } from '../mocks/provider-probes';
import type { ProviderDraft } from '../schema/config';
import type { ProviderProbeCheck, ProviderProbeVerdict } from '../schema/provider-probe';
import type { ProviderProbeProfileRuntime } from '../schema/provider-runtime';

export type ProviderProbeView = {
  id: string;
  templateId: string;
  providerId: string;
  verdict: ProviderProbeVerdict;
  checkedAt: string;
  measuredLatencyMs: number;
  latencyBudgetMs: number;
  streamSupported: boolean;
  errorShapeStable: boolean;
  responseShapeStable: boolean;
  transportRequested?: string;
  transportEffective?: string;
  fallbackApplied?: boolean;
  checks: ProviderProbeCheck[];
  guidance: string[];
};

export function getProbeVerdictLabel(verdict: ProviderProbeVerdict) {
  if (verdict === 'available') {
    return '可用';
  }

  if (verdict === 'realtime-risk') {
    return '不推荐实时';
  }

  return '不可用';
}

export function getProbeVerdictTone(verdict: ProviderProbeVerdict) {
  if (verdict === 'available') {
    return 'ready';
  }

  if (verdict === 'realtime-risk') {
    return 'warning';
  }

  return 'unsupported';
}

export function getProbeCheckTone(status: 'pass' | 'warn' | 'fail') {
  if (status === 'pass') {
    return 'ready';
  }

  if (status === 'warn') {
    return 'warning';
  }

  return 'unsupported';
}

export function resolveProbeView(provider: ProviderDraft, runtimeProbe?: ProviderProbeProfileRuntime | null): ProviderProbeView {
  if (runtimeProbe && runtimeProbe.providerId === provider.providerId) {
    return runtimeProbe;
  }

  const matchedMock = providerProbeProfiles.find(
    (item) => item.id === provider.probe.profileId && item.checkedAt === provider.probe.checkedAt,
  );

  if (matchedMock) {
    return matchedMock;
  }

  return {
    id: provider.probe.profileId || defaultProviderProbeProfile.id,
    templateId: provider.templateId,
    providerId: provider.providerId,
    verdict: provider.probe.verdict,
    checkedAt: provider.probe.checkedAt || '未探测',
    measuredLatencyMs: provider.probe.verdict === 'available' ? 840 : provider.probe.verdict === 'realtime-risk' ? 1680 : 0,
    latencyBudgetMs: 1200,
    streamSupported: provider.probe.streamSupported,
    errorShapeStable: provider.probe.errorShapeStable,
    responseShapeStable: provider.probe.responseShapeStable,
    transportRequested: provider.transport,
    transportEffective: provider.transport,
    fallbackApplied: false,
    checks: [
      {
        id: `${provider.providerId}-streaming`,
        key: 'streaming',
        label: '实时返回',
        status: provider.probe.streamSupported ? 'pass' : 'fail',
        summary: provider.probe.streamSupported ? '支持实时返回。' : '暂不支持实时返回。',
      },
      {
        id: `${provider.providerId}-error-shape`,
        key: 'error-shape',
        label: '错误返回',
        status: provider.probe.errorShapeStable ? 'pass' : 'fail',
        summary: provider.probe.errorShapeStable ? '错误返回稳定。' : '错误返回不稳定。',
      },
      {
        id: `${provider.providerId}-response-shape`,
        key: 'response-shape',
        label: '结果返回',
        status: provider.probe.responseShapeStable ? 'pass' : 'fail',
        summary: provider.probe.responseShapeStable ? '结果返回稳定。' : '结果返回不稳定。',
      },
    ],
    guidance: buildFallbackGuidance(provider.probe.verdict),
  };
}

function buildFallbackGuidance(verdict: ProviderProbeVerdict) {
  if (verdict === 'available') {
    return ['可以直接发送测试请求。'];
  }

  if (verdict === 'realtime-risk') {
    return ['更适合先出字幕，播报建议延后。'];
  }

  return ['先检查服务地址、密钥和模型名。'];
}