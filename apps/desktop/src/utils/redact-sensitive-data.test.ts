import { describe, expect, it } from 'vitest';
import { redactSensitiveData, stringifyRedacted } from './redact-sensitive-data';

describe('redactSensitiveData', () => {
  it('removes custom headers, secret-shaped fields, and URL query credentials', () => {
    const secret = 'diagnostics-test-secret-7f3a';
    const output = stringifyRedacted({
      customHeaders: [{ name: 'X-Anything', value: secret, enabled: true }],
      nested: { apiKey: secret, cookie: secret, harmless: 'visible' },
      baseUrl: `https://example.test/v1?token=${secret}&region=cn`,
    });

    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('visible');
    expect(output).toContain('region=cn');
  });

  it('redacts primitive custom-header entries and preserves primitive values', () => {
    expect(redactSensitiveData({ customHeaders: [null, 'raw-header', { name: 'x', value: 'secret' }] })).toEqual({
      customHeaders: ['[REDACTED]', '[REDACTED]', { name: 'x', value: '[REDACTED]' }],
    });
    expect(redactSensitiveData(7)).toBe(7);
  });

  it('marks circular arrays and objects without recursing forever', () => {
    const array: unknown[] = [];
    array.push(array);
    const object: Record<string, unknown> = {};
    object.self = object;

    expect(redactSensitiveData(array)).toEqual(['[CIRCULAR]']);
    expect(redactSensitiveData(object)).toEqual({ self: '[CIRCULAR]' });
  });
});
