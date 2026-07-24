import { describe, expect, it } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { subtitleOverlayPageHelpers } from './SubtitleOverlayPage';
import { overlayFallbackText } from './overlay/overlayDomain';

describe('subtitle overlay page helpers', () => {
  it('resolves fallback translations and preserves unknown or object keys', () => {
    expect(overlayFallbackText('overlay')).toBe('overlay');
    expect(overlayFallbackText('overlay.missing.key')).toBe('overlay.missing.key');
    expect(overlayFallbackText('overlay.unlockAction')).toBe('解锁');
  });
  it('clamps values and converts monitor positions to bounded percentages', () => {
    expect(subtitleOverlayPageHelpers.clamp(-1, 0, 10)).toBe(0);
    expect(subtitleOverlayPageHelpers.clamp(5, 0, 10)).toBe(5);
    expect(subtitleOverlayPageHelpers.clamp(11, 0, 10)).toBe(10);
    expect(subtitleOverlayPageHelpers.toOverlayAxisPercent(200, 100, 0)).toBe(0);
    expect(subtitleOverlayPageHelpers.toOverlayAxisPercent(50, 100, 100)).toBe(0);
    expect(subtitleOverlayPageHelpers.toOverlayAxisPercent(150, 100, 100)).toBe(50);
    expect(subtitleOverlayPageHelpers.toOverlayAxisPercent(250, 100, 100)).toBe(100);
  });

  it('splits fallback subtitle lines and preserves pending translations', () => {
    expect(subtitleOverlayPageHelpers.splitDisplayLines(' first \n\n second ')).toEqual(['first', 'second']);
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.displaySegments = undefined;
    cue.displaySourceText = 'first\nsecond';
    cue.translatedText = '第一句';
    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)).toEqual([
      { id: `${cue.cueId}-fallback-0`, sourceText: 'first', translatedText: '第一句', pending: false },
      { id: `${cue.cueId}-fallback-1`, sourceText: 'second', translatedText: '', pending: true },
    ]);
  });

  it('filters empty explicit segments and falls back to raw source text', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.displaySegments = [
      { sourceText: '', translatedText: '', pending: false },
      { sourceText: 'source', translatedText: '', pending: true },
      { sourceText: '', translatedText: '译文', pending: false },
    ];
    cue.displaySourceText = 'source';
    cue.sourceText = 'source';
    cue.translatedText = '译文';
    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)).toEqual([
      { id: `${cue.cueId}-segment-0-0`, sourceText: 'source', translatedText: '', pending: true },
      { id: `${cue.cueId}-segment-1-0`, sourceText: '', translatedText: '译文', pending: false },
    ]);

    cue.displaySegments = [];
    cue.displaySourceText = '';
    cue.sourceText = 'raw source';
    cue.translatedText = '';
    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)[0]).toMatchObject({
      sourceText: 'raw source',
      pending: true,
    });
  });

  it('wraps accumulating explicit segments into paired bilingual rows without repetition', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.displaySegments = [{
      sourceText: 'Project Aurora has a one billion dollar reliability fund for a research station on Mars.',
      translatedText: '这是一艘价值十亿美元的火箭飞船，未来终有一天会带你一路前往火星并住进崭新的家园。',
      pending: true,
    }];
    cue.displaySourceText = cue.displaySegments[0].sourceText;
    cue.sourceText = cue.displaySegments[0].sourceText;
    cue.translatedText = cue.displaySegments[0].translatedText;

    const segments = subtitleOverlayPageHelpers.getCueDisplaySegments(cue);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => segment.sourceText.length > 0)).toBe(true);
    expect(segments.filter((segment) => segment.translatedText).every((segment) => segment.sourceText.length > 0)).toBe(true);
    expect(segments.map((segment) => segment.sourceText).join(' ').replace(/\s+/gu, ' ').trim()).toBe(cue.displaySegments[0].sourceText);
    expect(segments.map((segment) => segment.translatedText).join('').replace(/\s+/gu, '')).toBe(cue.displaySegments[0].translatedText);
  });

  it('keeps translated-only fallback lines when source text is empty', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.displaySegments = undefined;
    cue.displaySourceText = '';
    cue.sourceText = '';
    cue.translatedText = 'translated only';

    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)).toEqual([
      {
        id: `${cue.cueId}-fallback-0`,
        sourceText: '',
        translatedText: 'translated only',
        pending: false,
      },
    ]);
  });

  it('pads explicit source rows when translation wraps onto more lines', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.displaySegments = [{ sourceText: 'one source line', translatedText: 'first translation\nsecond translation', pending: false }];
    cue.displaySourceText = 'one source line';
    cue.sourceText = 'one source line';
    cue.translatedText = 'first translation\nsecond translation';

    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)).toEqual([
      expect.objectContaining({ sourceText: 'one source line', translatedText: 'first translation' }),
      expect.objectContaining({ sourceText: '', translatedText: 'second translation' }),
    ]);
  });

  it('calculates every resize direction and enforces minimum dimensions', () => {
    const base = {
      direction: 'SouthEast' as const,
      frameId: null,
      pointerId: 1,
      scaleFactor: 1,
      startScreenX: 10,
      startScreenY: 20,
      startWindowHeight: 200,
      startWindowWidth: 400,
      startWindowX: 100,
      startWindowY: 150,
      targetHeight: 200,
      targetWidth: 400,
      targetX: 100,
      targetY: 150,
    };
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds(base, 30, 50)).toEqual({
      height: 230, width: 420, x: 100, y: 150,
    });
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'NorthWest' }, 30, 50)).toEqual({
      height: 170, width: 380, x: 120, y: 180,
    });
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'East' }, -1000, 20)).toEqual({
      height: 200, width: 220, x: 100, y: 150,
    });
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'North' }, 10, 1000)).toEqual({
      height: 72, width: 400, x: 100, y: 278,
    });
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'West' }, 1000, 20)).toEqual({
      height: 200, width: 220, x: 280, y: 150,
    });
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'South' }, 10, -1000)).toEqual({
      height: 72, width: 400, x: 100, y: 150,
    });
  });

  it('calculates locked reveal visibility and interaction hotspot boundaries', () => {
    const position = { x: 100, y: 200 };
    const size = { width: 400, height: 100 };
    expect(subtitleOverlayPageHelpers.calculateLockedRevealState({ x: 50, y: 250 }, position, size)).toEqual({
      interactive: false, visible: false,
    });
    expect(subtitleOverlayPageHelpers.calculateLockedRevealState({ x: 200, y: 250 }, position, size)).toEqual({
      interactive: false, visible: true,
    });
    expect(subtitleOverlayPageHelpers.calculateLockedRevealState({ x: 450, y: 220 }, position, size)).toEqual({
      interactive: true, visible: true,
    });
    expect(subtitleOverlayPageHelpers.calculateLockedRevealState({ x: 100, y: 206 }, position, { width: 40, height: 40 })).toEqual({
      interactive: true, visible: true,
    });
  });

  it('scales the locked reveal hotspot to physical pixels on high-DPI displays', () => {
    const position = { x: 200, y: 300 };
    const size = { width: 1280, height: 360 };

    expect(subtitleOverlayPageHelpers.calculateLockedRevealState(
      { x: 1403, y: 348 },
      position,
      size,
      2,
    )).toEqual({ interactive: true, visible: true });
    expect(subtitleOverlayPageHelpers.calculateLockedRevealState(
      { x: 1350, y: 348 },
      position,
      size,
      1,
    )).toEqual({ interactive: false, visible: true });
    expect(subtitleOverlayPageHelpers.calculateLockedRevealState(
      { x: 450, y: 220 },
      { x: 100, y: 200 },
      { width: 400, height: 100 },
      Number.NaN,
    )).toEqual({ interactive: true, visible: true });
  });

});
