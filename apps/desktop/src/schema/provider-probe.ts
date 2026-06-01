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