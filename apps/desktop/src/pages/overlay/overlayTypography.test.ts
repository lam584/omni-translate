import { describe, expect, it } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import {
  buildSubtitleOverlayCssVariables,
  DEFAULT_SOURCE_TEXT_STYLE,
  resolveOverlayTextStyle,
} from './overlayTypography';

describe('subtitle overlay typography', () => {
  it('builds independent source and translation effects with a single text alpha composition', () => {
    const subtitles = structuredClone(appConfigDraftMock.subtitles);
    subtitles.overlayOpacity = 0.5;
    subtitles.overlayTextOpacity = 0.5;
    subtitles.overlayTextAlign = 'right';
    subtitles.overlaySourceTextStyle.outlineWidth = 2;
    subtitles.overlayTranslationTextStyle.shadowOffsetX = -3;

    const style = buildSubtitleOverlayCssVariables(subtitles) as Record<string, string | number>;
    expect(style['--subtitle-overlay-text-align']).toBe('right');
    expect(style['--subtitle-overlay-source-outline-width']).toBe('2px');
    expect(style['--subtitle-overlay-source-text']).toContain('0.25');
    expect(style['--subtitle-overlay-translation-shadow']).toContain('-3px 2px 8px');
    expect(style['--subtitle-overlay-translation-opacity']).toBe('0.92');
  });

  it('removes disabled effects and clamps malformed persisted values', () => {
    const resolved = resolveOverlayTextStyle({
      outlineEnabled: false,
      outlineWidth: 99,
      shadowEnabled: false,
      shadowOpacity: -2,
      shadowOffsetX: Number.NaN,
      shadowBlur: 100,
    }, DEFAULT_SOURCE_TEXT_STYLE, '#112233');

    expect(resolved.color).toBe('#112233');
    expect(resolved.outlineWidth).toBe(4);
    expect(resolved.shadowOpacity).toBe(0);
    expect(resolved.shadowOffsetX).toBe(0);
    expect(resolved.shadowBlur).toBe(24);

    const subtitles = structuredClone(appConfigDraftMock.subtitles);
    subtitles.overlaySourceTextStyle = resolved;
    const style = buildSubtitleOverlayCssVariables(subtitles) as Record<string, string | number>;
    expect(style['--subtitle-overlay-source-outline-width']).toBe('0px');
    expect(style['--subtitle-overlay-source-shadow']).toBe('none');
  });
});
