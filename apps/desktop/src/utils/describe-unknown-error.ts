export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      const code = typeof candidate.code === 'string' && candidate.code.trim() ? ` (${candidate.code})` : '';
      return `${candidate.message}${code}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
