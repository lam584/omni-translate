const SENSITIVE_KEY = /(authorization|cookie|token|secret|api[-_]?key|access[-_]?key|credential|password)/i;
const SENSITIVE_QUERY_KEY = /^(authorization|cookie|token|secret|api[-_]?key|access[-_]?key|key|credential|password)$/i;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:authorization|cookie|token|secret|api[-_]?key|access[-_]?key|key|credential|password)=)[^&#\s]*/gi, '$1[REDACTED]');
  }
}

function redactSensitiveDataInner(value: unknown, parentKey: string, seen: WeakSet<object>): unknown {
  if (SENSITIVE_KEY.test(parentKey)) return '[REDACTED]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (parentKey === 'customHeaders') {
      return value.map((entry) => entry && typeof entry === 'object'
        ? { ...(entry as Record<string, unknown>), value: '[REDACTED]' }
        : '[REDACTED]');
    }
    return value.map((entry) => redactSensitiveDataInner(entry, '', seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSensitiveDataInner(entry, key, seen)]));
  }
  return typeof value === 'string' ? redactUrl(value) : value;
}

export function redactSensitiveData(value: unknown): unknown {
  return redactSensitiveDataInner(value, '', new WeakSet());
}

export function stringifyRedacted(value: unknown): string {
  return JSON.stringify(redactSensitiveData(value), null, 2);
}
