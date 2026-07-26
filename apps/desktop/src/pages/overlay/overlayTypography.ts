import type { CSSProperties } from 'react';

import type {
  SubtitleDraft,
  SubtitleOverlayTextStyle,
} from '../../schema/config';
import { mixOpacity, withAlpha } from '../../utils/color-alpha';

export type OverlayTextEffectPresetId = 'none' | 'soft' | 'crisp' | 'contrast' | 'glow';

export const DEFAULT_SOURCE_TEXT_STYLE: SubtitleOverlayTextStyle = {
  color: '#fff8ef',
  fontWeight: 500,
  outlineEnabled: true,
  outlineColor: '#000000',
  outlineWidth: 1,
  shadowEnabled: true,
  shadowColor: '#000000',
  shadowOpacity: 0.45,
  shadowOffsetX: 0,
  shadowOffsetY: 2,
  shadowBlur: 8,
};

export const DEFAULT_TRANSLATION_TEXT_STYLE: SubtitleOverlayTextStyle = {
  ...DEFAULT_SOURCE_TEXT_STYLE,
  fontWeight: 700,
  shadowOpacity: 0.4,
};

export const overlayTextEffectPresets: Record<OverlayTextEffectPresetId, Pick<SubtitleOverlayTextStyle,
  'outlineEnabled' | 'outlineColor' | 'outlineWidth' | 'shadowEnabled' | 'shadowColor' |
  'shadowOpacity' | 'shadowOffsetX' | 'shadowOffsetY' | 'shadowBlur'>> = {
  none: {
    outlineEnabled: false, outlineColor: '#000000', outlineWidth: 1,
    shadowEnabled: false, shadowColor: '#000000', shadowOpacity: 0,
    shadowOffsetX: 0, shadowOffsetY: 0, shadowBlur: 0,
  },
  soft: {
    outlineEnabled: false, outlineColor: '#000000', outlineWidth: 1,
    shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 0.45,
    shadowOffsetX: 0, shadowOffsetY: 2, shadowBlur: 14,
  },
  crisp: {
    outlineEnabled: true, outlineColor: '#000000', outlineWidth: 1,
    shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 0.4,
    shadowOffsetX: 0, shadowOffsetY: 2, shadowBlur: 8,
  },
  contrast: {
    outlineEnabled: true, outlineColor: '#000000', outlineWidth: 2,
    shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 0.65,
    shadowOffsetX: 0, shadowOffsetY: 3, shadowBlur: 4,
  },
  glow: {
    outlineEnabled: true, outlineColor: '#ffffff', outlineWidth: 0.5,
    shadowEnabled: true, shadowColor: '#38bdf8', shadowOpacity: 0.65,
    shadowOffsetX: 0, shadowOffsetY: 0, shadowBlur: 12,
  },
};

function finiteClamp(value: number, fallback: number, min: number, max: number) {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, finite));
}

function safeColor(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}

export function resolveOverlayTextStyle(
  value: Partial<SubtitleOverlayTextStyle> | undefined,
  defaults: SubtitleOverlayTextStyle,
  legacyColor?: string,
): SubtitleOverlayTextStyle {
  const merged = { ...defaults, ...(value ?? {}) };
  return {
    ...merged,
    color: safeColor(value?.color ?? legacyColor ?? defaults.color, defaults.color),
    outlineColor: safeColor(merged.outlineColor, defaults.outlineColor),
    outlineWidth: finiteClamp(merged.outlineWidth, defaults.outlineWidth, 0.5, 4),
    shadowColor: safeColor(merged.shadowColor, defaults.shadowColor),
    shadowOpacity: finiteClamp(merged.shadowOpacity, defaults.shadowOpacity, 0, 1),
    shadowOffsetX: finiteClamp(merged.shadowOffsetX, defaults.shadowOffsetX, -10, 10),
    shadowOffsetY: finiteClamp(merged.shadowOffsetY, defaults.shadowOffsetY, -10, 10),
    shadowBlur: finiteClamp(merged.shadowBlur, defaults.shadowBlur, 0, 24),
    fontWeight: [400, 500, 600, 700].includes(merged.fontWeight) ? merged.fontWeight : defaults.fontWeight,
  };
}

function shadowValue(style: SubtitleOverlayTextStyle, textAlpha: number) {
  if (!style.shadowEnabled || style.shadowOpacity <= 0) return 'none';
  return `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlur}px ${withAlpha(style.shadowColor, textAlpha * style.shadowOpacity)}`;
}

export function buildSubtitleOverlayCssVariables(subtitles: SubtitleDraft): CSSProperties {
  const backgroundAlpha = mixOpacity(subtitles.overlayOpacity, subtitles.overlayBackgroundOpacity);
  const textAlpha = mixOpacity(subtitles.overlayOpacity, subtitles.overlayTextOpacity);
  const source = resolveOverlayTextStyle(subtitles.overlaySourceTextStyle, DEFAULT_SOURCE_TEXT_STYLE, subtitles.overlayTextColor);
  const translation = resolveOverlayTextStyle(subtitles.overlayTranslationTextStyle, DEFAULT_TRANSLATION_TEXT_STYLE, subtitles.overlayTextColor);
  const align = ['left', 'center', 'right'].includes(subtitles.overlayTextAlign) ? subtitles.overlayTextAlign : 'center';

  return {
    '--subtitle-overlay-background': withAlpha(subtitles.overlayBackgroundColor, backgroundAlpha),
    '--subtitle-overlay-border': withAlpha('#ffffff', 0.12 * backgroundAlpha),
    '--subtitle-overlay-shadow': withAlpha('#000000', 0.28 * backgroundAlpha),
    '--subtitle-overlay-blur': `${Math.round(12 * backgroundAlpha)}px`,
    '--subtitle-overlay-font-family': subtitles.overlayFontFamily,
    '--subtitle-overlay-text-align': align,
    '--subtitle-overlay-source-text': withAlpha(source.color, textAlpha),
    '--subtitle-overlay-source-weight': source.fontWeight,
    '--subtitle-overlay-source-outline-color': withAlpha(source.outlineColor, textAlpha),
    '--subtitle-overlay-source-outline-width': source.outlineEnabled ? `${source.outlineWidth}px` : '0px',
    '--subtitle-overlay-source-shadow': shadowValue(source, textAlpha),
    '--subtitle-overlay-translation-text': withAlpha(translation.color, textAlpha),
    '--subtitle-overlay-translation-weight': translation.fontWeight,
    '--subtitle-overlay-translation-outline-color': withAlpha(translation.outlineColor, textAlpha),
    '--subtitle-overlay-translation-outline-width': translation.outlineEnabled ? `${translation.outlineWidth}px` : '0px',
    '--subtitle-overlay-translation-shadow': shadowValue(translation, textAlpha),
    '--subtitle-overlay-translation-opacity': '0.92',
  } as CSSProperties;
}
