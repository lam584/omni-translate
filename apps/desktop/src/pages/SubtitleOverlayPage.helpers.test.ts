import { describe, expect, it } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { subtitleOverlayPageHelpers } from './SubtitleOverlayPage';
import { overlayFallbackText, overlayFontSizeOptions } from './overlay/overlayDomain';

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
    cue.committed = false;
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
    cue.committed = false;
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

  it('offers large subtitle font sizes through the overlay menu', () => {
    expect(overlayFontSizeOptions.at(-1)).toBe(96);
    expect(overlayFontSizeOptions).toContain(72);
  });

  it('promotes completed fallback sentences while keeping only the final tail pending', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.committed = false;
    cue.displaySegments = undefined;
    cue.displaySourceText = 'First source. Second source is still live';
    cue.sourceText = cue.displaySourceText;
    cue.translatedText = '第一句。第二句仍在输出';

    const segments = subtitleOverlayPageHelpers.getCueDisplaySegments(cue);

    expect(segments.map((segment) => segment.pending)).toEqual([false, true]);
    expect(segments[0]).toMatchObject({ translatedText: '第一句。' });
    expect(segments[1]).toMatchObject({ translatedText: '第二句仍在输出' });
  });

  it('treats every display segment as final after its cue commits', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.committed = true;
    cue.sourceText = 'Committed source';
    cue.displaySourceText = cue.sourceText;
    cue.translatedText = '已提交译文';
    cue.displaySegments = [{ sourceText: cue.sourceText, translatedText: cue.translatedText, pending: true }];

    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)).toEqual([
      expect.objectContaining({ pending: false }),
    ]);
  });

  it('keeps only the newest pending segment in the global live timeline', () => {
    const oldest = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    oldest.cueId = 'oldest-live';
    oldest.committed = false;
    oldest.sourceText = 'Older source tail';
    oldest.displaySourceText = oldest.sourceText;
    oldest.translatedText = '较早的实时译文';
    oldest.displaySegments = undefined;
    const newest = structuredClone(oldest);
    newest.cueId = 'newest-live';
    newest.sourceText = 'Newest source tail';
    newest.displaySourceText = newest.sourceText;
    newest.translatedText = '最新实时译文';

    const timeline = subtitleOverlayPageHelpers.getOverlayTimeline([oldest, newest]);

    expect(timeline.liveCue?.cueId).toBe('newest-live');
    expect(timeline.liveSegment?.translatedText).toBe('最新实时译文');
    expect(timeline.cues[0].historySegments).toEqual([
      expect.objectContaining({ translatedText: '较早的实时译文', pending: true }),
    ]);
    expect(timeline.cues[1].historySegments).toHaveLength(0);
  });

  it('keeps the raw ASR tail of an older uncommitted cue when a newer cue owns the live slot', () => {
    const older = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    older.cueId = 'older-uncommitted';
    older.committed = false;
    older.sourceText = 'Hello world extra tail tokens';
    older.displaySourceText = 'Hello world';
    older.translatedText = '你好世界。';
    older.displaySegments = [{ sourceText: 'Hello world', translatedText: '你好世界。', pending: false }];
    const newest = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    newest.cueId = 'newest-live';
    newest.committed = false;
    newest.sourceText = 'Newest live source';
    newest.displaySourceText = newest.sourceText;
    newest.translatedText = '最新实时译文';
    newest.displaySegments = undefined;

    const timeline = subtitleOverlayPageHelpers.getOverlayTimeline([older, newest]);

    expect(timeline.liveCue?.cueId).toBe('newest-live');
    expect(timeline.liveSegment).toMatchObject({ sourceText: 'Newest live source', translatedText: '最新实时译文' });
    expect(timeline.liveSourceTail).toBe('extra tail tokens');
    expect(timeline.cues[0].historySegments).toEqual([
      expect.objectContaining({ sourceText: 'Hello world', translatedText: '你好世界。' }),
    ]);
  });

  it('selects mismatched live source and translation tails independently', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    const sourceLines = ['source one', 'source two', 'source three', 'source four'];
    const translatedLines = ['译文第一行', '译文第二行', '译文第三行'];
    cue.committed = false;
    cue.sourceText = sourceLines.join('\n');
    cue.displaySourceText = cue.sourceText;
    cue.translatedText = translatedLines.join('\n');
    cue.displaySegments = sourceLines.map((sourceText, index) => ({
      sourceText,
      translatedText: translatedLines[index] ?? '',
      pending: index === 2 || index === 3,
    }));

    const timeline = subtitleOverlayPageHelpers.getOverlayTimeline([cue]);

    expect(timeline.liveSegment).toMatchObject({
      sourceText: 'source four',
      translatedText: '译文第三行',
      pending: true,
    });
    expect(timeline.cues[0].historySegments.map((segment) => segment.translatedText).filter(Boolean))
      .toEqual(['译文第一行', '译文第二行']);
    expect(timeline.cues[0].historySegments.map((segment) => segment.sourceText).filter(Boolean))
      .toEqual(['source one', 'source two', 'source three']);

    cue.committed = true;
    const committedTimeline = subtitleOverlayPageHelpers.getOverlayTimeline([cue]);
    expect(committedTimeline.liveSegment).toBeNull();
    expect(committedTimeline.cues[0].historySegments.map((segment) => segment.translatedText).filter(Boolean))
      .toEqual(translatedLines);
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

  it('turns committed Omni language blocks into adjacent bilingual groups', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    const sourceLines = [
      'The future: flying cars that',
      'can take you anywhere and so much more.',
      'All starting with this one dollar light, which you can find',
    ];
    const translatedLines = [
      '而且还有很多其他的东西。',
      '一切都从这个一美元的灯开始，你可以买到……',
    ];
    cue.cueId = 'omni-cue-1785124891551';
    cue.committed = true;
    cue.sourceText = sourceLines.join('\n');
    cue.displaySourceText = cue.sourceText;
    cue.translatedText = translatedLines.join('\n');
    cue.displaySegments = [
      ...sourceLines.map((sourceText) => ({ sourceText, translatedText: '', pending: false })),
      ...translatedLines.map((translatedText) => ({ sourceText: '', translatedText, pending: false })),
    ];

    const segments = subtitleOverlayPageHelpers.getCueDisplaySegments(cue);

    expect(segments).toHaveLength(2);
    expect(segments.every((segment) => segment.sourceText && segment.translatedText)).toBe(true);
    expect(segments).toEqual([
      expect.objectContaining({
        sourceText: 'The future: flying cars that can take you anywhere and so much more.',
        translatedText: '而且还有很多其他的东西。',
        pending: false,
      }),
      expect.objectContaining({
        sourceText: 'All starting with this one dollar light, which you can find',
        translatedText: '一切都从这个一美元的灯开始，你可以买到……',
        pending: false,
      }),
    ]);
    expect(segments.map((segment) => segment.sourceText).join('').replace(/\s+/gu, ''))
      .toBe(sourceLines.join('').replace(/\s+/gu, ''));
    expect(segments.map((segment) => segment.translatedText).join('').replace(/\s+/gu, ''))
      .toBe(translatedLines.join('').replace(/\s+/gu, ''));
  });

  it('keeps correctly paired and live segment layouts unchanged', () => {
    const cue = structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0]);
    cue.sourceText = 'First. Second.';
    cue.displaySourceText = cue.sourceText;
    cue.translatedText = '第一句。第二句。';
    cue.displaySegments = [
      { sourceText: 'First.', translatedText: '第一句。', pending: false },
      { sourceText: 'Second.', translatedText: '第二句。', pending: false },
    ];
    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)).toEqual([
      expect.objectContaining({ sourceText: 'First.', translatedText: '第一句。' }),
      expect.objectContaining({ sourceText: 'Second.', translatedText: '第二句。' }),
    ]);

    cue.committed = false;
    cue.sourceText = 'First.';
    cue.displaySourceText = cue.sourceText;
    cue.translatedText = '第一句。';
    cue.displaySegments = [
      { sourceText: 'First.', translatedText: '', pending: true },
      { sourceText: '', translatedText: '第一句。', pending: true },
    ];
    expect(subtitleOverlayPageHelpers.getCueDisplaySegments(cue)).toEqual([
      expect.objectContaining({ sourceText: 'First.', translatedText: '', pending: true }),
      expect.objectContaining({ sourceText: '', translatedText: '第一句。', pending: false }),
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

  // The resize math converts screen deltas and the min/max overlay bounds from
  // logical into physical pixels, so both the applied delta and the clamp
  // floor grow with the display scale. Expected values below come straight
  // from the production formula (delta = round(screenDelta * scale),
  // minWidth = round(220 * scale), minHeight = round(72 * scale)).
  it.each([
    [1.25, { deltaWidth: 425, deltaHeight: 238, minWidth: 275, minHeight: 90 }],
    [1.5, { deltaWidth: 430, deltaHeight: 245, minWidth: 330, minHeight: 108 }],
    [2, { deltaWidth: 440, deltaHeight: 260, minWidth: 440, minHeight: 144 }],
  ] as const)('scales resize deltas and clamp floors to physical pixels at scaleFactor %s', (scaleFactor, expected) => {
    const base = {
      direction: 'SouthEast' as const,
      frameId: null,
      pointerId: 1,
      scaleFactor,
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

    // A 20x30 screen-pixel drag moves more physical pixels on a HiDPI display.
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds(base, 30, 50)).toEqual({
      width: expected.deltaWidth, height: expected.deltaHeight, x: 100, y: 150,
    });

    // Shrinking past the limit stops at the DPI-scaled minimum, not at the
    // logical 220x72 (which would let the window collapse on HiDPI screens).
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'East' }, -1_000, 20).width)
      .toBe(expected.minWidth);
    expect(subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'South' }, 10, -1_000).height)
      .toBe(expected.minHeight);

    // West/North additionally shift the origin by exactly the width/height the
    // window gave up, keeping the opposite edge pinned.
    const west = subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'West' }, 1_000, 20);
    expect(west).toEqual({ width: expected.minWidth, height: 200, x: 100 + (400 - expected.minWidth), y: 150 });
    const north = subtitleOverlayPageHelpers.calculateOverlayResizeBounds({ ...base, direction: 'North' }, 10, 1_000);
    expect(north).toEqual({ width: 400, height: expected.minHeight, x: 100, y: 150 + (200 - expected.minHeight) });
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
