import { describe, expect, it } from 'vitest';

import { isRejectedTranslationValue } from './config';
import { supportedLanguages } from './languages';

describe('i18n language configuration', () => {
  describe('translation resource validation', () => {
    it('rejects third-party quota responses stored as translations', () => {
      expect(
        isRejectedTranslationValue(
          'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.',
        ),
      ).toBe(true);
    });

    it('keeps ordinary localized text', () => {
      expect(isRejectedTranslationValue('保存成功')).toBe(false);
    });
  });

  describe('supportedLanguages', () => {
    it('uses readable native language names', () => {
      expect(supportedLanguages.find((item) => item.code === 'zh-CN')?.nativeName).toBe('简体中文');
      expect(supportedLanguages.find((item) => item.code === 'es')?.nativeName).toBe('Español');
      expect(supportedLanguages.find((item) => item.code === 'ja')?.nativeName).toBe('日本語');
      expect(supportedLanguages.find((item) => item.code === 'ko')?.nativeName).toBe('한국어');
    });
  });
});
