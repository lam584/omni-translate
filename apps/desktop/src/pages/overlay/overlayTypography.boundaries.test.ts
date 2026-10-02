import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { buildSubtitleOverlayCssVariables, DEFAULT_SOURCE_TEXT_STYLE, resolveOverlayTextStyle } from './overlayTypography';

describe('overlay typography untrusted persisted values', () => {
  it('falls back to legacy/default color and style for missing settings', () => {
    expect(resolveOverlayTextStyle(undefined, DEFAULT_SOURCE_TEXT_STYLE)).toEqual(DEFAULT_SOURCE_TEXT_STYLE);
    expect(resolveOverlayTextStyle(undefined, DEFAULT_SOURCE_TEXT_STYLE, '#aabbcc').color).toBe('#aabbcc');
    expect(resolveOverlayTextStyle({ fontWeight: 999 as 500 }, DEFAULT_SOURCE_TEXT_STYLE).fontWeight).toBe(500);
  });
  it('omits disabled outlines and zero-opacity shadows on both text layers', () => {
    const subtitles = structuredClone(appConfigDraftMock.subtitles);
    subtitles.overlayTextAlign = 'unexpected' as 'center';
    for (const text of [subtitles.overlaySourceTextStyle, subtitles.overlayTranslationTextStyle]) {
      text.outlineEnabled = false;
      text.shadowEnabled = true;
      text.shadowOpacity = 0;
    }
    const css = buildSubtitleOverlayCssVariables(subtitles) as Record<string, string>;
    expect(css['--subtitle-overlay-text-align']).toBe('center');
    for (const layer of ['source', 'translation']) {
      expect(css[`--subtitle-overlay-${layer}-outline-width`]).toBe('0px');
      expect(css[`--subtitle-overlay-${layer}-shadow`]).toBe('none');
    }
  });
});
