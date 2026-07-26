import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { defaultProviderTemplate } from '../mocks/provider-templates';
import { PENDING_PROBE_CHECKED_AT } from '../schema/provider-probe';
import { buildProviderDraftPatchFromTemplate, mapProbeVerdictToConfigStatus } from './provider-draft';

describe('provider draft status mapping', () => {
  it('marks unavailable probes unsupported and keeps other verdicts ready', () => {
    expect(mapProbeVerdictToConfigStatus('unavailable')).toBe('unsupported');
    expect(mapProbeVerdictToConfigStatus('available')).toBe('ready');
    expect(mapProbeVerdictToConfigStatus('realtime-risk')).toBe('ready');
  });

  it('persists the stable non-localized pending sentinel in probe.checkedAt', () => {
    const patch = buildProviderDraftPatchFromTemplate(structuredClone(appConfigDraftMock.providers[0]), defaultProviderTemplate);

    expect(patch.probe?.checkedAt).toBe(PENDING_PROBE_CHECKED_AT);
    expect(patch.probe?.profileId.endsWith('-pending')).toBe(true);
  });
});
