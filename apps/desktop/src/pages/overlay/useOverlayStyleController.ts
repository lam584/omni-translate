import { useCallback } from 'react';

import type { SubtitleDraft } from '../../schema/config';
import type { OverlayStylePreset } from './overlayDomain';

type OverlayStyleControllerOptions = {
  overlayBackgroundColor: string;
  overlayBackgroundOpacity: number;
  overlayFontFamily: string;
  overlayOpacity: number;
  overlayTextColor: string;
  overlayTextOpacity: number;
  overlaySourceTextStyle: SubtitleDraft['overlaySourceTextStyle'];
  overlayTranslationTextStyle: SubtitleDraft['overlayTranslationTextStyle'];
  updateSubtitleDraft: (patch: Partial<SubtitleDraft>) => void;
};

export function useOverlayStyleController({
  overlayBackgroundColor,
  overlayBackgroundOpacity,
  overlayFontFamily,
  overlayOpacity,
  overlayTextColor,
  overlayTextOpacity,
  overlaySourceTextStyle,
  overlayTranslationTextStyle,
  updateSubtitleDraft,
}: OverlayStyleControllerOptions) {
  const applyOverlayStylePreset = useCallback((preset: OverlayStylePreset) => {
    updateSubtitleDraft({
      overlayBackgroundColor: preset.backgroundColor,
      overlayBackgroundOpacity: preset.backgroundOpacity,
      overlayFontFamily: preset.fontFamily ?? overlayFontFamily,
      overlayOpacity: preset.opacity,
      overlayTextColor: preset.textColor,
      overlayTextOpacity: preset.textOpacity,
      overlaySourceTextStyle: { ...overlaySourceTextStyle, color: preset.textColor },
      overlayTranslationTextStyle: { ...overlayTranslationTextStyle, color: preset.textColor },
    });
  }, [overlayFontFamily, overlaySourceTextStyle, overlayTranslationTextStyle, updateSubtitleDraft]);

  const matchesOverlayStylePreset = useCallback((preset: OverlayStylePreset) => (
    overlayBackgroundColor.toLowerCase() === preset.backgroundColor.toLowerCase()
      && Math.abs(overlayBackgroundOpacity - preset.backgroundOpacity) < 0.01
      && Math.abs(overlayOpacity - preset.opacity) < 0.01
      && overlayTextColor.toLowerCase() === preset.textColor.toLowerCase()
      && overlaySourceTextStyle.color.toLowerCase() === preset.textColor.toLowerCase()
      && overlayTranslationTextStyle.color.toLowerCase() === preset.textColor.toLowerCase()
      && Math.abs(overlayTextOpacity - preset.textOpacity) < 0.01
  ), [overlayBackgroundColor, overlayBackgroundOpacity, overlayOpacity, overlaySourceTextStyle.color,
    overlayTextColor, overlayTextOpacity, overlayTranslationTextStyle.color]);

  const applyOverlayFontSize = useCallback((fontSize: number) => {
    updateSubtitleDraft({ overlayFontSize: fontSize });
  }, [updateSubtitleDraft]);

  const applyOverlayBackgroundOpacity = useCallback((opacity: number) => {
    updateSubtitleDraft({ overlayBackgroundOpacity: opacity });
  }, [updateSubtitleDraft]);

  const applyOverlayTextColor = useCallback((color: string) => {
    updateSubtitleDraft({
      overlayTextColor: color,
      overlaySourceTextStyle: { ...overlaySourceTextStyle, color },
      overlayTranslationTextStyle: { ...overlayTranslationTextStyle, color },
    });
  }, [overlaySourceTextStyle, overlayTranslationTextStyle, updateSubtitleDraft]);

  return {
    applyOverlayBackgroundOpacity,
    applyOverlayFontSize,
    applyOverlayStylePreset,
    applyOverlayTextColor,
    matchesOverlayStylePreset,
  };
}
