import { describe, expect, it } from 'vitest';

import { parseRuntimeTimestampMs } from './runtime-timestamp';

describe('parseRuntimeTimestampMs', () => {
  it('treats the unix: prefix as seconds', () => {
    expect(parseRuntimeTimestampMs('unix:1779974788')).toBe(1_779_974_788_000);
    expect(parseRuntimeTimestampMs('unix:0')).toBe(0);
  });

  it('treats the unix-ms: prefix as milliseconds', () => {
    expect(parseRuntimeTimestampMs('unix-ms:1779974788817')).toBe(1_779_974_788_817);
  });

  it('treats bare 10-digit strings as seconds and 13-digit strings as milliseconds', () => {
    expect(parseRuntimeTimestampMs('1779974788')).toBe(1_779_974_788_000);
    expect(parseRuntimeTimestampMs('1779974788817')).toBe(1_779_974_788_817);
  });

  it('parses ISO-8601 strings via Date.parse', () => {
    expect(parseRuntimeTimestampMs('2026-07-26T00:00:00.000Z')).toBe(
      Date.parse('2026-07-26T00:00:00.000Z'),
    );
  });

  it('returns null for empty or unparseable values', () => {
    expect(parseRuntimeTimestampMs(null)).toBeNull();
    expect(parseRuntimeTimestampMs(undefined)).toBeNull();
    expect(parseRuntimeTimestampMs('')).toBeNull();
    expect(parseRuntimeTimestampMs('invalid')).toBeNull();
    expect(parseRuntimeTimestampMs('unix:abc')).toBeNull();
    expect(parseRuntimeTimestampMs('unix-ms:abc')).toBeNull();
  });
});
