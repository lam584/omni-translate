export function describeRuntimeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; details?: { requestId?: unknown } };
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      const metadata = [
        typeof candidate.code === 'string' && candidate.code.trim() ? candidate.code.trim() : null,
        typeof candidate.details?.requestId === 'string' && candidate.details.requestId.trim()
          ? `requestId=${candidate.details.requestId.trim()}`
          : null,
      ].filter(Boolean);
      return metadata.length > 0 ? `${candidate.message} (${metadata.join(', ')})` : candidate.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
