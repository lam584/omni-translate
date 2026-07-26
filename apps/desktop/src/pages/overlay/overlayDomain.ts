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

export const MIN_OVERLAY_FONT_SIZE = 16;
export const MAX_OVERLAY_FONT_SIZE = 96;
export const overlayFontSizeOptions = [18, 22, 24, 28, 32, 36, 42, 48, 56, 64, 72, 80, 96] as const;

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
export const MAX_OVERLAY_HEIGHT = 720;
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
  cueCommitted: boolean,
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

  const referenceText = segment.translatedText.trim() || segment.sourceText.trim();
  const hasUntranslatedSource = alignedSourceLines.some((source, lineIndex) => (
    Boolean(source) && !alignedTranslatedLines[lineIndex]
  ));
  const keepLiveTail = !cueCommitted && (
    hasUntranslatedSource || (segment.pending && !hasTerminalCaptionBoundary(referenceText))
  );

  return Array.from({ length: lineCount }, (_, lineIndex) => ({
    sourceText: alignedSourceLines[lineIndex] ?? '',
    translatedText: alignedTranslatedLines[lineIndex],
    pending: keepLiveTail && lineIndex === lineCount - 1,
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
    ? rawExplicitSegments.flatMap((segment, segmentIndex) => (
      expandExplicitSegment(cue.cueId, segment, segmentIndex, cue.committed)
    ))
    : undefined;

  if (explicitSegments && explicitSegments.length > 0) {
    return explicitSegments;
  }

  const sourceLines = splitDisplayLines(cue.displaySourceText || cue.sourceText);
  const translatedLines = splitDisplayLines(cue.translatedText);
  const segmentCount = Math.max(sourceLines.length, translatedLines.length);
  const referenceText = cue.translatedText.trim() || (cue.displaySourceText || cue.sourceText).trim();
  const hasUntranslatedSource = sourceLines.some((source, index) => Boolean(source) && !translatedLines[index]);
  const keepLiveTail = !cue.committed && (
    hasUntranslatedSource || !hasTerminalCaptionBoundary(referenceText)
  );

  return Array.from({ length: segmentCount }, (_, index) => ({
    id: `${cue.cueId}-fallback-${index}`,
    sourceText: sourceLines[index] ?? '',
    translatedText: translatedLines[index] ?? '',
    pending: keepLiveTail && index === segmentCount - 1,
  })).filter((segment) => segment.sourceText || segment.translatedText);
}

function hasTerminalCaptionBoundary(text: string): boolean {
  return /(?:[.!?;。！？；]|\n)\s*$/u.test(text);
}

const WHITESPACE_CHAR = /\s/u;

// Returns the raw ASR tail of the cue that is not yet represented by any
// display segment, so the live stream row can surface source tokens while the
// realtime API keeps iterating on the same sentence. Falls back to an empty
// string when the displayed segments are not a prefix of the raw source text
// (e.g. after a revision rewrite), to avoid rendering stale fragments.
export function getCueLiveSourceTail(cue: SubtitleCueRuntime): string {
  const displayedChars = Array.from(
    getCueDisplaySegments(cue)
      .map((segment) => segment.sourceText)
      .join('')
      .replace(/\s+/gu, ''),
  );
  const rawChars = Array.from(cue.sourceText || '');
  let matched = 0;
  let index = 0;
  while (index < rawChars.length && matched < displayedChars.length) {
    if (WHITESPACE_CHAR.test(rawChars[index])) {
      index += 1;
      continue;
    }
    if (rawChars[index] !== displayedChars[matched]) return '';
    matched += 1;
    index += 1;
  }
  if (matched < displayedChars.length) return '';
  return rawChars.slice(index).join('').trim();
}

export type OverlayTimelineCue = {
  cue: SubtitleCueRuntime;
  historySegments: OverlayDisplaySegment[];
};

export type OverlayTimeline = {
  cues: OverlayTimelineCue[];
  liveCue: SubtitleCueRuntime | null;
  liveSegment: OverlayDisplaySegment | null;
  liveSourceTail: string;
};

/**
 * Builds one ordered overlay timeline. Source and translation wrap at
 * different widths, so their newest pending rows are selected independently
 * and combined only for the fixed live slot. Every other readable field stays
 * in history, including unfinished rows from older overlapping cues. Raw ASR
 * tails have no history row, so every uncommitted cue keeps its tail in the
 * live slot, joined in cue order.
 */
export function getOverlayTimeline(cues: SubtitleCueRuntime[]): OverlayTimeline {
  const segmentsByCue = cues.map((cue) => getCueDisplaySegments(cue));
  let liveCueIndex = -1;
  let liveSourceSegmentIndex = -1;
  let liveTranslationSegmentIndex = -1;
  const liveSourceTails: string[] = [];

  cues.forEach((cue, cueIndex) => {
    const segments = segmentsByCue[cueIndex];
    let pendingSourceIndex = -1;
    let pendingTranslationIndex = -1;
    segments.forEach((segment, segmentIndex) => {
      if (!segment.pending) return;
      if (segment.sourceText.trim()) pendingSourceIndex = segmentIndex;
      if (segment.translatedText.trim()) pendingTranslationIndex = segmentIndex;
    });
    const sourceTail = cue.committed ? '' : getCueLiveSourceTail(cue);
    if (sourceTail) liveSourceTails.push(sourceTail);
    if (pendingSourceIndex >= 0 || pendingTranslationIndex >= 0 || sourceTail) {
      liveCueIndex = cueIndex;
      liveSourceSegmentIndex = pendingSourceIndex;
      liveTranslationSegmentIndex = pendingTranslationIndex;
    }
  });

  const liveSegments = liveCueIndex >= 0 ? segmentsByCue[liveCueIndex] : [];
  const liveSourceText = liveSourceSegmentIndex >= 0
    ? liveSegments[liveSourceSegmentIndex]?.sourceText ?? ''
    : '';
  const liveTranslatedText = liveTranslationSegmentIndex >= 0
    ? liveSegments[liveTranslationSegmentIndex]?.translatedText ?? ''
    : '';
  const liveSegment = liveSourceText || liveTranslatedText
    ? {
        id: `${cues[liveCueIndex].cueId}-live`,
        sourceText: liveSourceText,
        translatedText: liveTranslatedText,
        pending: true,
      }
    : null;

  return {
    cues: cues.map((cue, cueIndex) => ({
      cue,
      historySegments: segmentsByCue[cueIndex]
        .map((segment, segmentIndex) => {
          if (cueIndex !== liveCueIndex) return segment;
          const sourceText = segmentIndex === liveSourceSegmentIndex ? '' : segment.sourceText;
          const translatedText = segmentIndex === liveTranslationSegmentIndex ? '' : segment.translatedText;
          if (!sourceText && !translatedText) return null;
          return {
            ...segment,
            sourceText,
            translatedText,
            pending: segmentIndex === liveSourceSegmentIndex
              || segmentIndex === liveTranslationSegmentIndex
              ? false
              : segment.pending,
          };
        })
        .filter((segment): segment is OverlayDisplaySegment => segment !== null),
    })),
    liveCue: liveCueIndex >= 0 ? cues[liveCueIndex] : null,
    liveSegment,
    liveSourceTail: liveSourceTails.join(' '),
  };
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
  getCueLiveSourceTail,
  getOverlayTimeline,
  toOverlayAxisPercent,
};
