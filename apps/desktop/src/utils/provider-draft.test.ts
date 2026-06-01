import { describe, expect, it } from 'vitest';
import { mapProbeVerdictToConfigStatus } from './provider-draft';

describe('provider draft status mapping', () => {
  it('marks unavailable probes unsupported and keeps other verdicts ready', () => {
    expect(mapProbeVerdictToConfigStatus('unavailable')).toBe('unsupported');
    expect(mapProbeVerdictToConfigStatus('available')).toBe('ready');
    expect(mapProbeVerdictToConfigStatus('realtime-risk')).toBe('ready');
  });
});
