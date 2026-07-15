import { describe, expect, it } from 'vitest';

import { isRejectedTranslationValue } from './config';

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
