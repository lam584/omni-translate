import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function evaluateWatchContentJudgeSidecar({
  enabled = false, authorized = false, model = null, parameters = {}, sourceText = '',
  candidateText = '', facts = [], transport,
} = {}) {
  const request = { sourceText, candidateText, facts };
  const base = {
    schemaVersion: 1, mode: 'sidecar-only', affectsGate: false,
    requestSha256: sha256(request), model: model ? { id: model, parameters } : null,
  };
  if (!enabled) return { ...base, status: 'disabled', usage: null, latencyMs: 0, responseSha256: null };
  if (!authorized) return { ...base, status: 'unauthorized', usage: null, latencyMs: 0, responseSha256: null };
  if (typeof transport !== 'function') return { ...base, status: 'unavailable', usage: null, latencyMs: 0, responseSha256: null };
  const startedAt = performance.now();
  try {
    const response = await transport({ model, parameters, request });
    return {
      ...base, status: 'completed', usage: response?.usage ?? null,
      latencyMs: Math.round(performance.now() - startedAt),
      responseSha256: sha256(response?.result ?? null), result: response?.result ?? null,
    };
  } catch (error) {
    return {
      ...base, status: 'inconclusive', usage: null,
      latencyMs: Math.round(performance.now() - startedAt), responseSha256: null,
      error: String(error?.message ?? error),
    };
  }
}
