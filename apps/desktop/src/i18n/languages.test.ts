import { describe, expect, it } from 'vitest';
import { supportedLanguages } from './languages';

describe('supportedLanguages', () => {
  it('uses readable native language names', () => {
    expect(supportedLanguages.find((item) => item.code === 'zh-CN')?.nativeName).toBe('简体中文');
    expect(supportedLanguages.find((item) => item.code === 'es')?.nativeName).toBe('Español');
    expect(supportedLanguages.find((item) => item.code === 'ja')?.nativeName).toBe('日本語');
    expect(supportedLanguages.find((item) => item.code === 'ko')?.nativeName).toBe('한국어');
  });
});
