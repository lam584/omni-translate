import i18n from '../i18n/config';
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
    return i18n.t('providerProbe.verdictAvailable');
  }

  if (verdict === 'realtime-risk') {
    return i18n.t('providerProbe.verdictRealtimeRisk');
  }

  return i18n.t('providerProbe.verdictUnavailable');
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
    checkedAt: provider.probe.checkedAt || i18n.t('providerProbe.notProbed'),
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
        label: i18n.t('providerProbe.checkStreaming'),
        status: provider.probe.streamSupported ? 'pass' : 'fail',
        summary: provider.probe.streamSupported ? i18n.t('providerProbe.checkStreamingPass') : i18n.t('providerProbe.checkStreamingFail'),
      },
      {
        id: `${provider.providerId}-error-shape`,
        key: 'error-shape',
        label: i18n.t('providerProbe.checkErrorShape'),
        status: provider.probe.errorShapeStable ? 'pass' : 'fail',
        summary: provider.probe.errorShapeStable ? i18n.t('providerProbe.checkErrorShapePass') : i18n.t('providerProbe.checkErrorShapeFail'),
      },
      {
        id: `${provider.providerId}-response-shape`,
        key: 'response-shape',
        label: i18n.t('providerProbe.checkResponseShape'),
        status: provider.probe.responseShapeStable ? 'pass' : 'fail',
        summary: provider.probe.responseShapeStable ? i18n.t('providerProbe.checkResponseShapePass') : i18n.t('providerProbe.checkResponseShapeFail'),
      },
    ],
    guidance: buildFallbackGuidance(provider.probe.verdict),
  };
}

function buildFallbackGuidance(verdict: ProviderProbeVerdict) {
  if (verdict === 'available') {
    return [i18n.t('providerProbe.guidanceAvailable')];
  }

  if (verdict === 'realtime-risk') {
    return [i18n.t('providerProbe.guidanceRealtimeRisk')];
  }

  return [i18n.t('providerProbe.guidanceUnavailable')];
}