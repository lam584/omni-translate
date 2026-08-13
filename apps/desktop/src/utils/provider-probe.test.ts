import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { providerProbeProfiles } from '../mocks/provider-probes';
import { PENDING_PROBE_CHECKED_AT } from '../schema/provider-probe';
import type { ProviderProbeProfileRuntime } from '../schema/provider-runtime';
import {
  getProbeCheckTone,
  getProbeVerdictLabel,
  getProbeVerdictTone,
  isPendingProbeCheckedAt,
  resolveProbeView,
} from './provider-probe';

describe('provider-probe helpers', () => {
  it('maps verdict and check states to display labels and tones', () => {
    expect(getProbeVerdictLabel('available')).toBe('可用');
    expect(getProbeVerdictLabel('realtime-risk')).toBe('不推荐实时');
    expect(getProbeVerdictLabel('unavailable')).toBe('不可用');
    expect(getProbeVerdictTone('available')).toBe('ready');
    expect(getProbeVerdictTone('realtime-risk')).toBe('warning');
    expect(getProbeVerdictTone('unavailable')).toBe('unsupported');
    expect(getProbeCheckTone('pass')).toBe('ready');
    expect(getProbeCheckTone('warn')).toBe('warning');
    expect(getProbeCheckTone('fail')).toBe('unsupported');
  });

  it('recognizes the sentinel and legacy localized pending values and localizes them in the probe view', () => {
    expect(isPendingProbeCheckedAt(PENDING_PROBE_CHECKED_AT)).toBe(true);
    expect(isPendingProbeCheckedAt('待重新探测')).toBe(true);
    expect(isPendingProbeCheckedAt('Pending re-probe')).toBe(true);
    expect(isPendingProbeCheckedAt('2026-05-29T08:00:00Z')).toBe(false);
    expect(isPendingProbeCheckedAt('')).toBe(false);

    const pendingProvider = structuredClone(appConfigDraftMock.providers[0]);
    pendingProvider.probe.profileId = `probe-${pendingProvider.providerId}-pending`;
    pendingProvider.probe.checkedAt = PENDING_PROBE_CHECKED_AT;

    expect(resolveProbeView(pendingProvider, null).checkedAt).toBe('待重新探测');
  });

  it('prefers a matching runtime probe over draft fallback data', () => {
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    const runtimeProbe: ProviderProbeProfileRuntime = {
      id: 'runtime-probe',
      templateId: provider.templateId,
      providerId: provider.providerId,
      verdict: 'available',
      checkedAt: '2026-05-29T08:00:00Z',
      measuredLatencyMs: 42,
      latencyBudgetMs: 1200,
      streamSupported: true,
      errorShapeStable: true,
      responseShapeStable: true,
      transportRequested: 'websocket',
      transportEffective: 'websocket',
      fallbackApplied: false,
      inputTokens: null,
      outputTokens: null,
      audioSeconds: null,
      checks: [],
      guidance: ['runtime'],
      routingDecision: { subtitlePriority: 'balanced', speechDisposition: 'ready', rationale: 'test' },
      error: null,
    };

    expect(resolveProbeView(provider, runtimeProbe)).toBe(runtimeProbe);
  });

  it('builds fallback probe guidance for risky and unavailable drafts', () => {
    const riskyProvider = structuredClone(appConfigDraftMock.providers[0]);
    riskyProvider.probe = {
      ...riskyProvider.probe,
      profileId: '',
      verdict: 'realtime-risk',
      checkedAt: '',
      streamSupported: false,
      errorShapeStable: true,
      responseShapeStable: false,
    };
    const unavailableProvider = structuredClone(appConfigDraftMock.providers[0]);
    unavailableProvider.providerId = 'provider-unavailable-test';
    unavailableProvider.probe = {
      ...unavailableProvider.probe,
      profileId: '',
      verdict: 'unavailable',
      checkedAt: '',
      streamSupported: false,
      errorShapeStable: false,
      responseShapeStable: false,
    };

    const risky = resolveProbeView(riskyProvider, null);
    const unavailable = resolveProbeView(unavailableProvider, null);

    expect(risky.measuredLatencyMs).toBe(1680);
    expect(risky.checks.map((check) => check.status)).toEqual(['fail', 'pass', 'fail']);
    expect(risky.guidance[0]).toContain('字幕');
    expect(unavailable.measuredLatencyMs).toBe(0);
    expect(unavailable.guidance[0]).toContain('服务地址');
  });

  it('uses matching mock probes and builds an available fallback', () => {
    const mockedProvider = structuredClone(appConfigDraftMock.providers[0]);
    mockedProvider.probe.profileId = providerProbeProfiles[0].id;
    mockedProvider.probe.checkedAt = providerProbeProfiles[0].checkedAt;
    expect(resolveProbeView(mockedProvider, null)).toBe(providerProbeProfiles[0]);

    const availableProvider = structuredClone(appConfigDraftMock.providers[0]);
    availableProvider.providerId = 'provider-available-test';
    availableProvider.probe = {
      ...availableProvider.probe,
      profileId: '',
      verdict: 'available',
      checkedAt: '',
    };
    const available = resolveProbeView(availableProvider, null);
    expect(available.measuredLatencyMs).toBe(840);
    expect(available.guidance).toEqual(['可以直接发送测试请求。']);
  });
});
