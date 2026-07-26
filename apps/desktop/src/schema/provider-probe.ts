export type ProviderProbeVerdict = 'available' | 'realtime-risk' | 'unavailable';

export type ProviderProbeCheckStatus = 'pass' | 'warn' | 'fail';

export type ProviderProbeCheckKey = 'streaming' | 'latency' | 'error-shape' | 'response-shape';

export type ProviderProbeCheck = {
  id: string;
  key: ProviderProbeCheckKey;
  label: string;
  status: ProviderProbeCheckStatus;
  summary: string;
};

export type ProviderProbeProfile = {
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
  checks: ProviderProbeCheck[];
  guidance: string[];
};

export type ProviderProbeSnapshot = {
  profileId: string;
  verdict: ProviderProbeVerdict;
  checkedAt: string;
  streamSupported: boolean;
  errorShapeStable: boolean;
  responseShapeStable: boolean;
};

// Stable sentinel persisted in probe.checkedAt before the first verification
// attempt. Must stay non-localized so reads work regardless of the UI language;
// display layers translate it via providerProbe.pendingProbe.
export const PENDING_PROBE_CHECKED_AT = 'pending-probe';