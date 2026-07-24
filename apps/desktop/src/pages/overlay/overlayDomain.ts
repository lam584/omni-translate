import zhCN from '../../i18n/locales/zh-CN.json';
import type { SubtitleCueRuntime, SubtitleDisplaySegmentRuntime } from '../../schema/audio-runtime';

export type OverlayStylePreset = {
  backgroundColor: string;
  backgroundOpacity: number;
  fontFamily?: string;
  opacity: number;
  textColor: string;
  textOpacity: number;
};

export const overlayStylePresets: Record<'classic' | 'glass' | 'contrast', OverlayStylePreset> = {
  classic: {
    backgroundColor: '#111827',
    backgroundOpacity: 0.84,
    opacity: 0.88,
    textColor: '#fff8ef',
    textOpacity: 1,
  },
  glass: {
    backgroundColor: '#0f172a',
    backgroundOpacity: 0.46,
    opacity: 0.82,
    textColor: '#f8fafc',
    textOpacity: 0.94,
  },
  contrast: {
    backgroundColor: '#020617',
    backgroundOpacity: 0.96,
    opacity: 1,
    textColor: '#fef3c7',
    textOpacity: 1,
  },
};

export const overlayThemeOptions = [
  { id: 'classic', labelKey: 'overlay.styleClassic', preset: overlayStylePresets.classic },
  { id: 'glass', labelKey: 'overlay.styleGlass', preset: overlayStylePresets.glass },
  { id: 'contrast', labelKey: 'overlay.styleContrast', preset: overlayStylePresets.contrast },
] as const;

export const overlayFontSizeOptions = [18, 22, 24, 28, 32, 36, 42, 48] as const;

export const overlayBackgroundOpacityOptions = [0, 0.25, 0.45, 0.65, 0.84, 1] as const;

export const overlayTextColorOptions = [
  { id: 'warm-white', labelKey: 'overlay.textColorWarmWhite', value: '#fff8ef' },
  { id: 'pure-white', labelKey: 'overlay.textColorPureWhite', value: '#ffffff' },
  { id: 'amber', labelKey: 'overlay.textColorAmber', value: '#fef3c7' },
  { id: 'mint', labelKey: 'overlay.textColorMint', value: '#bbf7d0' },
  { id: 'sky', labelKey: 'overlay.textColorSky', value: '#bae6fd' },
  { id: 'rose', labelKey: 'overlay.textColorRose', value: '#fecdd3' },
] as const;

export type OverlayContextMenuState = {
  open: boolean;
  x: number;
  y: number;
};

export type LockedRevealState = {
  interactive: boolean;
  visible: boolean;
};

export type OverlayDragState = {
  pointerId: number;
  frameId: number | null;
  scaleFactor: number;
  startScreenX: number;
  startScreenY: number;
  startWindowX: number;
  startWindowY: number;
  targetX: number;
  targetY: number;
};

export type OverlayResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

export function overlayFallbackText(key: string): string {
  let value: unknown = zhCN;
  for (const segment of key.split('.')) {
    if (!value || typeof value !== 'object' || !(segment in value)) return key;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : key;
}

export type OverlayResizeState = {
  direction: OverlayResizeDirection;
  frameId: number | null;
  pointerId: number;
  scaleFactor: number;
  startScreenX: number;
  startScreenY: number;
  startWindowHeight: number;
  startWindowWidth: number;
  startWindowX: number;
  startWindowY: number;
  targetHeight: number;
  targetWidth: number;
  targetX: number;
  targetY: number;
};

export type OverlayDisplaySegment = SubtitleDisplaySegmentRuntime & {
  id: string;
};

export const LOCK_BUTTON_HOTSPOT_HEIGHT = 36;
export const LOCK_BUTTON_HOTSPOT_INSET = 6;
export const LOCK_BUTTON_HOTSPOT_WIDTH = 65;
export const LOCK_BUTTON_POLL_INTERVAL_MS = 120;
export const MIN_OVERLAY_WIDTH = 220;
export const MIN_OVERLAY_HEIGHT = 72;
export const MAX_OVERLAY_WIDTH = 1280;
export const MAX_OVERLAY_HEIGHT = 360;
export const MIN_SUBTITLE_FONT_SCALE = 0.78;
export const TRANSLATION_FONT_SCALE = 0.82;
export const OVERLAY_RESIZE_DEBOUNCE_MS = 300;

export const OVERLAY_RESIZE_HANDLES: ReadonlyArray<{ className: string; direction: OverlayResizeDirection }> = [
  { className: 'subtitle-overlay-resize-handle-north', direction: 'North' },
  { className: 'subtitle-overlay-resize-handle-south', direction: 'South' },
  { className: 'subtitle-overlay-resize-handle-east', direction: 'East' },
  { className: 'subtitle-overlay-resize-handle-west', direction: 'West' },
  { className: 'subtitle-overlay-resize-handle-northeast', direction: 'NorthEast' },
  { className: 'subtitle-overlay-resize-handle-northwest', direction: 'NorthWest' },
  { className: 'subtitle-overlay-resize-handle-southeast', direction: 'SouthEast' },
  { className: 'subtitle-overlay-resize-handle-southwest', direction: 'SouthWest' },
];

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const MAX_LATIN_CAPTION_CHARS = 72;
const MAX_LATIN_CAPTION_WORDS = 12;
const MAX_CJK_CAPTION_CHARS = 24;

function wrapCaptionSentence(sentence: string) {
  const trimmed = sentence.trim();
  if (!trimmed) return [];
  const hasCjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(trimmed);
  if (hasCjk) {
    return Array.from(trimmed).reduce<string[]>((lines, character) => {
      const lastIndex = lines.length - 1;
      if (lastIndex < 0 || Array.from(lines[lastIndex]).length >= MAX_CJK_CAPTION_CHARS) lines.push(character);
      else lines[lastIndex] += character;
      return lines;
    }, []);
  }

  return trimmed.split(/\s+/u).reduce<string[]>((lines, word) => {
    const lastIndex = lines.length - 1;
    const candidate = lastIndex < 0 ? word : `${lines[lastIndex]} ${word}`;
    const wordCount = candidate.split(/\s+/u).length;
    if (lastIndex < 0 || candidate.length > MAX_LATIN_CAPTION_CHARS || wordCount > MAX_LATIN_CAPTION_WORDS) lines.push(word);
    else lines[lastIndex] = candidate;
    return lines;
  }, []);
}

export function splitDisplayLines(text: string) {
  return text
    .split(/(?<=[.!?;。！？；])\s*|\n+/u)
    .flatMap(wrapCaptionSentence)
    .filter(Boolean);
}

function expandExplicitSegment(
  cueId: string,
  segment: SubtitleDisplaySegmentRuntime,
  segmentIndex: number,
): OverlayDisplaySegment[] {
  const sourceLines = splitDisplayLines(segment.sourceText);
  const translatedLines = splitDisplayLines(segment.translatedText);
  const lineCount = Math.max(sourceLines.length, translatedLines.length);
  const alignedSourceLines = sourceLines.length > 0
    ? sourceLines
    : Array.from({ length: lineCount }, () => '');
  const alignedTranslatedLines = [
    ...translatedLines,
    ...Array.from({ length: lineCount - translatedLines.length }, () => ''),
  ];

  return Array.from({ length: lineCount }, (_, lineIndex) => ({
    sourceText: alignedSourceLines[lineIndex] ?? '',
    translatedText: alignedTranslatedLines[lineIndex],
    pending: segment.pending || (Boolean(alignedSourceLines[lineIndex]) && !alignedTranslatedLines[lineIndex]),
    id: `${cueId}-segment-${segmentIndex}-${lineIndex}`,
  }));
}

export function getCueDisplaySegments(cue: SubtitleCueRuntime): OverlayDisplaySegment[] {
  const rawExplicitSegments = cue.displaySegments
    ?.filter((segment) => segment.sourceText.trim().length > 0 || segment.translatedText.trim().length > 0);
  const authoritativeSourceText = cue.displaySourceText || cue.sourceText;
  const normalizedAuthoritativeSource = authoritativeSourceText.replace(/\s+/gu, '');
  const normalizedExplicitSource = rawExplicitSegments?.map((segment) => segment.sourceText).join('').replace(/\s+/gu, '') ?? '';
  const normalizedAuthoritativeTranslation = cue.translatedText.replace(/\s+/gu, '');
  const normalizedExplicitTranslation = rawExplicitSegments?.map((segment) => segment.translatedText).join('').replace(/\s+/gu, '') ?? '';
  const explicitSegments = rawExplicitSegments
    && normalizedExplicitSource === normalizedAuthoritativeSource
    && normalizedExplicitTranslation === normalizedAuthoritativeTranslation
    ? rawExplicitSegments.flatMap((segment, segmentIndex) => expandExplicitSegment(cue.cueId, segment, segmentIndex))
    : undefined;

  if (explicitSegments && explicitSegments.length > 0) {
    return explicitSegments;
  }

  const sourceLines = splitDisplayLines(cue.displaySourceText || cue.sourceText);
  const translatedLines = splitDisplayLines(cue.translatedText);
  const segmentCount = Math.max(sourceLines.length, translatedLines.length);

  return Array.from({ length: segmentCount }, (_, index) => ({
    id: `${cue.cueId}-fallback-${index}`,
    sourceText: sourceLines[index] ?? '',
    translatedText: translatedLines[index] ?? '',
    pending: Boolean(sourceLines[index]) && !translatedLines[index],
  })).filter((segment) => segment.sourceText || segment.translatedText);
}

export function toOverlayAxisPercent(position: number, workAreaStart: number, availableDistance: number) {
  if (availableDistance <= 0) {
    return 0;
  }

  return clamp(Math.round(((position - workAreaStart) / availableDistance) * 100), 0, 100);
}

export function calculateOverlayResizeBounds(resizeState: OverlayResizeState, screenX: number, screenY: number) {
  const deltaX = Math.round((screenX - resizeState.startScreenX) * resizeState.scaleFactor);
  const deltaY = Math.round((screenY - resizeState.startScreenY) * resizeState.scaleFactor);
  const minWidth = Math.round(MIN_OVERLAY_WIDTH * resizeState.scaleFactor);
  const minHeight = Math.round(MIN_OVERLAY_HEIGHT * resizeState.scaleFactor);
  const maxWidth = Math.round(MAX_OVERLAY_WIDTH * resizeState.scaleFactor);
  const maxHeight = Math.round(MAX_OVERLAY_HEIGHT * resizeState.scaleFactor);
  let width = resizeState.startWindowWidth;
  let height = resizeState.startWindowHeight;
  let x = resizeState.startWindowX;
  let y = resizeState.startWindowY;

  if (resizeState.direction.includes('East')) {
    width = clamp(resizeState.startWindowWidth + deltaX, minWidth, maxWidth);
  }

  if (resizeState.direction.includes('South')) {
    height = clamp(resizeState.startWindowHeight + deltaY, minHeight, maxHeight);
  }

  if (resizeState.direction.includes('West')) {
    width = clamp(resizeState.startWindowWidth - deltaX, minWidth, maxWidth);
    x = resizeState.startWindowX + (resizeState.startWindowWidth - width);
  }

  if (resizeState.direction.includes('North')) {
    height = clamp(resizeState.startWindowHeight - deltaY, minHeight, maxHeight);
    y = resizeState.startWindowY + (resizeState.startWindowHeight - height);
  }

  return { height, width, x, y };
}

export function calculateLockedRevealState(
  pointer: { x: number; y: number },
  overlayPosition: { x: number; y: number },
  overlaySize: { height: number; width: number },
  scaleFactor = 1,
): LockedRevealState {
  const physicalScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const insideOverlayBounds =
    pointer.x >= overlayPosition.x &&
    pointer.x <= overlayPosition.x + overlaySize.width &&
    pointer.y >= overlayPosition.y &&
    pointer.y <= overlayPosition.y + overlaySize.height;
  const hotspotWidth = LOCK_BUTTON_HOTSPOT_WIDTH * physicalScale;
  const hotspotHeight = LOCK_BUTTON_HOTSPOT_HEIGHT * physicalScale;
  const hotspotInset = LOCK_BUTTON_HOTSPOT_INSET * physicalScale;
  const hotspotLeft = overlayPosition.x + Math.max(0, overlaySize.width - hotspotWidth - hotspotInset);
  const hotspotTop = overlayPosition.y + hotspotInset;
  const insideLockHotspot =
    insideOverlayBounds &&
    pointer.x >= hotspotLeft &&
    pointer.x <= hotspotLeft + hotspotWidth &&
    pointer.y >= hotspotTop &&
    pointer.y <= hotspotTop + hotspotHeight;

  return { interactive: insideLockHotspot, visible: insideOverlayBounds };
}

export const subtitleOverlayPageHelpers = {
  calculateLockedRevealState,
  calculateOverlayResizeBounds,
  clamp,
  splitDisplayLines,
  getCueDisplaySegments,
  toOverlayAxisPercent,
};
