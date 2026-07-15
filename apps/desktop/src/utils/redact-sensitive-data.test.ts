import { describe, expect, it } from 'vitest';
import { stringifyRedacted } from './redact-sensitive-data';

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
});
