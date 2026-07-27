/**
 * Replays REAL cue-update sequences harvested from a recorded run
 * (artifacts/diagnostics/logs/app.log) through the REAL overlay display path
 * and pins the layout-stability invariants the overlay depends on.
 *
 * Nothing here is mocked: the fixture holds literal SubtitleCueRuntime payloads
 * reconstructed from the log's `[EVENT] transcription.completed`,
 * `[EVENT_CONTEXT] response.done` and `[EVENT] response.done -> COMMIT` lines,
 * and every assertion runs the production `overlayDomain` helpers over them.
 */
import { describe, expect, it } from 'vitest';

import traceRaw from '../../src-tauri/fixtures/session-traces/overlay-cue-sequences.json?raw';
import {
  getCueDisplaySegments,
  getCueLiveSourceTail,
  getOverlayTimeline,
  splitDisplayLines,
} from '../pages/overlay/overlayDomain';
import type { OverlayDisplaySegment } from '../pages/overlay/overlayDomain';
import type { SubtitleCueRuntime } from '../schema/audio-runtime';

type TraceFrame = {
  label: string;
  logLine: number;
  atMs: number;
  cues: SubtitleCueRuntime[];
};

type TraceSequence = {
  id: string;
  kind: 'cue-stream' | 'replay-comparison';
  title: string;
  logLines: number[];
  frames: TraceFrame[];
};

const fixture = JSON.parse(traceRaw) as {
  harvest: { sourceLog: string };
  sequences: TraceSequence[];
};

const sequences = fixture.sequences;
const cueStreams = sequences.filter((sequence) => sequence.kind === 'cue-stream');

function sequenceById(id: string): TraceSequence {
  const found = sequences.find((sequence) => sequence.id === id);
  if (!found) throw new Error(`fixture is missing the "${id}" sequence`);
  return found;
}

function stripWhitespace(value: string) {
  return value.replace(/\s+/gu, '');
}

function sourceRows(segments: OverlayDisplaySegment[]) {
  return segments.map((segment) => segment.sourceText);
}

function isPrefixOf(shorter: readonly string[], longer: readonly string[]) {
  return shorter.length <= longer.length && shorter.every((value, index) => longer[index] === value);
}

/** Mirrors the live-slot predicate inside getOverlayTimeline. */
function claimsLiveSlot(cue: SubtitleCueRuntime) {
  const segments = getCueDisplaySegments(cue);
  const hasPendingRow = segments.some((segment) => (
    segment.pending && (segment.sourceText.trim().length > 0 || segment.translatedText.trim().length > 0)
  ));
  const tail = cue.committed ? '' : getCueLiveSourceTail(cue);
  return hasPendingRow || tail.length > 0;
}

describe('session trace fixture', () => {
  it('carries the harvested sequences and log anchors', () => {
    expect(fixture.harvest.sourceLog).toBe('artifacts/diagnostics/logs/app.log');
    expect(sequences.map((sequence) => sequence.id)).toEqual([
      'partial-translation-window',
      'overlapping-rehypothesis',
      'rolling-commit-window',
      'replay-retranslation',
    ]);
    expect(sequences.map((sequence) => sequence.frames.length)).toEqual([6, 8, 6, 2]);

    for (const sequence of sequences) {
      const frameLines = sequence.frames.map((frame) => frame.logLine);
      expect(new Set(frameLines)).toEqual(new Set(sequence.logLines));
      for (const frame of sequence.frames) {
        expect(frame.cues.length).toBeGreaterThan(0);
        for (const cue of frame.cues) {
          expect(cue.cueId).toMatch(/^omni-cue-\d{13}$/u);
          expect(cue.routeDirection).toBe('inbound');
          expect(cue.startedAt).toMatch(/^unix-ms:\d{13}$/u);
          expect(cue.endedAt).toMatch(/^unix-ms:\d{13}$/u);
          // The recorded build never emitted display segments, so these traces
          // exercise the fallback branch of getCueDisplaySegments.
          expect(cue.displaySegments).toBeUndefined();
          expect(cue.displaySourceText).toBeUndefined();
        }
      }
    }
  });

  it('keeps every frame ordered by the real event clock', () => {
    for (const sequence of sequences) {
      const stamps = sequence.frames.map((frame) => frame.atMs);
      expect(stamps).toEqual([...stamps].sort((left, right) => left - right));
      for (const frame of sequence.frames) {
        for (const cue of frame.cues) {
          expect(Number(cue.endedAt.slice('unix-ms:'.length))).toBeLessThanOrEqual(frame.atMs);
        }
      }
    }
  });
});

describe.each(cueStreams.map((sequence) => [sequence.id, sequence] as const))(
  'replaying %s through the real overlay display path',
  (_id, sequence) => {
    it('never re-arranges the rows of a cue once it is committed', () => {
      const frozen = new Map<string, { frameIndex: number; segments: OverlayDisplaySegment[]; cue: SubtitleCueRuntime }>();
      let committedCueCount = 0;

      sequence.frames.forEach((frame, frameIndex) => {
        const timeline = getOverlayTimeline(frame.cues);

        frame.cues.forEach((cue, cueIndex) => {
          if (!cue.committed) {
            // Commitment is one-way: a cue that has been frozen may never
            // reopen and start re-arranging itself again.
            expect(frozen.has(cue.cueId)).toBe(false);
            return;
          }
          const segments = getCueDisplaySegments(cue);

          // A committed cue never keeps a live/pending row.
          for (const segment of segments) {
            expect(segment.pending).toBe(false);
          }
          // Nothing that happens later may steal rows out of a committed cue.
          expect(timeline.cues[cueIndex].historySegments).toEqual(segments);
          expect(timeline.liveCue?.cueId).not.toBe(cue.cueId);

          const previous = frozen.get(cue.cueId);
          if (!previous) {
            committedCueCount += 1;
            frozen.set(cue.cueId, { frameIndex, segments, cue });
            return;
          }
          // The payload itself is frozen (the log shows no cue ever committing twice)…
          expect(cue).toEqual(previous.cue);
          // …and so is every rendered row, id included.
          expect(segments).toEqual(previous.segments);
          expect(frameIndex).toBeGreaterThan(previous.frameIndex);
        });
      });

      expect(committedCueCount).toBeGreaterThan(0);
    });

    it('grows an uncommitted cue by appending only, under a stable cue id', () => {
      let growthSteps = 0;

      for (let index = 1; index < sequence.frames.length; index += 1) {
        const previousCues = new Map(sequence.frames[index - 1].cues.map((cue) => [cue.cueId, cue]));
        const currentCues = sequence.frames[index].cues;

        // The overlay only ever gains cues within one trace.
        expect(currentCues.length).toBeGreaterThanOrEqual(previousCues.size);
        for (const cueId of previousCues.keys()) {
          expect(currentCues.some((cue) => cue.cueId === cueId)).toBe(true);
        }

        for (const cue of currentCues) {
          const previous = previousCues.get(cue.cueId);
          if (!previous || previous.committed) continue;
          growthSteps += 1;

          // Same cue id, same identity anchor, text only appends.
          expect(cue.cueId).toBe(previous.cueId);
          expect(cue.startedAt).toBe(previous.startedAt);
          expect(cue.sourceText.startsWith(previous.sourceText)).toBe(true);
          expect(cue.translatedText.startsWith(previous.translatedText)).toBe(true);

          const before = getCueDisplaySegments(previous);
          const after = getCueDisplaySegments(cue);
          // Rows are only ever added, and the source column never re-flows:
          // the rows already on screen keep their exact text and their ids.
          expect(after.length).toBeGreaterThanOrEqual(before.length);
          expect(isPrefixOf(sourceRows(before), sourceRows(after))).toBe(true);
          expect(isPrefixOf(before.map((segment) => segment.id), after.map((segment) => segment.id))).toBe(true);
        }
      }

      expect(growthSteps).toBeGreaterThan(0);
    });

    it('routes every source character either into a row or into the live tail', () => {
      for (const frame of sequence.frames) {
        const timeline = getOverlayTimeline(frame.cues);

        for (const cue of frame.cues) {
          const rendered = stripWhitespace(sourceRows(getCueDisplaySegments(cue)).join(''));
          const tail = getCueLiveSourceTail(cue);
          expect(rendered + stripWhitespace(tail)).toBe(stripWhitespace(cue.sourceText));
          if (cue.committed) expect(timeline.liveSourceTail).not.toContain(cue.sourceText);
        }

        const expectedTail = frame.cues
          .filter((cue) => !cue.committed)
          .map((cue) => getCueLiveSourceTail(cue))
          .filter(Boolean)
          .join(' ');
        expect(timeline.liveSourceTail).toBe(expectedTail);
      }
    });

    it('parks the live slot on the newest uncommitted cue only', () => {
      for (const frame of sequence.frames) {
        const timeline = getOverlayTimeline(frame.cues);
        const claimants = frame.cues.filter(claimsLiveSlot);
        const newest = claimants.length > 0 ? claimants[claimants.length - 1] : null;

        expect(timeline.liveCue?.cueId ?? null).toBe(newest?.cueId ?? null);
        expect(timeline.liveCue?.committed ?? false).toBe(false);

        if (!newest) {
          expect(timeline.liveSegment).toBeNull();
          continue;
        }

        const pendingRows = getCueDisplaySegments(newest).filter((segment) => segment.pending);
        const newestPendingSource = [...pendingRows].reverse().find((segment) => segment.sourceText.trim())?.sourceText ?? '';
        const newestPendingTranslation = [...pendingRows].reverse().find((segment) => segment.translatedText.trim())?.translatedText ?? '';
        if (!newestPendingSource && !newestPendingTranslation) {
          expect(timeline.liveSegment).toBeNull();
          continue;
        }
        expect(timeline.liveSegment).toEqual({
          id: `${newest.cueId}-live`,
          sourceText: newestPendingSource,
          translatedText: newestPendingTranslation,
          pending: true,
        });
      }
    });

    it('keeps every rendered row id unique within a frame', () => {
      for (const frame of sequence.frames) {
        const ids = frame.cues.flatMap((cue) => getCueDisplaySegments(cue).map((segment) => segment.id));
        expect(new Set(ids).size).toBe(ids.length);
      }
    });
  },
);

describe('the recorded overlap at 2026-07-26 17:29-17:31', () => {
  const sequence = sequenceById('overlapping-rehypothesis');
  const frameByLabel = (needle: string) => {
    const frame = sequence.frames.find((candidate) => candidate.label.includes(needle));
    if (!frame) throw new Error(`no frame labelled "${needle}"`);
    return frame;
  };

  it('leaves the live slot on the stale cue when a newer cue commits', () => {
    // Log line 90042: cue …206713 commits while cue …156892 — opened 50s
    // earlier at line 90028 — has still never received a translation.
    const frame = frameByLabel('cue-C commits');
    const timeline = getOverlayTimeline(frame.cues);

    expect(timeline.liveCue?.cueId).toBe('omni-cue-1785058156892');
    expect(timeline.liveSegment).toEqual({
      id: 'omni-cue-1785058156892-live',
      sourceText: 'And throughout this',
      translatedText: '',
      pending: true,
    });

    const committed = frame.cues.find((cue) => cue.cueId === 'omni-cue-1785058206713');
    expect(committed?.committed).toBe(true);
    // The 14-character source keeps its single source row while the
    // 110-character translation wraps into nine rows beneath it.
    const rows = getCueDisplaySegments(committed as SubtitleCueRuntime);
    expect(rows).toHaveLength(9);
    expect(rows[0].sourceText).toBe('With this one.');
    expect(rows.slice(1).map((row) => row.sourceText)).toEqual(Array.from({ length: 8 }, () => ''));
    expect(rows.every((row) => row.pending === false)).toBe(true);
  });

  it('renders the duplicated words of the re-hypothesis in both cues', () => {
    const frame = frameByLabel('cue-D commit');
    const earlier = frame.cues.find((cue) => cue.cueId === 'omni-cue-1785058206713') as SubtitleCueRuntime;
    const later = frame.cues.find((cue) => cue.cueId === 'omni-cue-1785058248796') as SubtitleCueRuntime;

    expect(earlier.sourceText).toBe('With this one.');
    expect(later.sourceText.startsWith('With this one dollar light,')).toBe(true);

    const laterRows = getCueDisplaySegments(later);
    expect(laterRows).toHaveLength(7);
    expect(laterRows[0].sourceText).toBe('With this one dollar light, which when you combine millions of them');
    expect(laterRows[6]).toEqual({
      id: 'omni-cue-1785058248796-fallback-6',
      sourceText: '',
      translatedText: '人们……',
      pending: false,
    });
    // Both cues keep their own words: the overlay never merges the overlap away.
    expect(getCueDisplaySegments(earlier)[0].sourceText).toBe('With this one.');
  });

  it('does not disturb the cue when an empty transcription.completed arrives', () => {
    // Log line 90051 delivers source="" for cue …248796 long after its deltas
    // filled it; the cue on screen must not shrink or re-flow.
    const before = frameByLabel('accumulates a 347-char').cues.find((cue) => cue.cueId === 'omni-cue-1785058248796');
    const after = frameByLabel('must not clear it').cues.find((cue) => cue.cueId === 'omni-cue-1785058248796');

    expect(after?.sourceText).toBe(before?.sourceText);
    expect(getCueDisplaySegments(after as SubtitleCueRuntime))
      .toEqual(getCueDisplaySegments(before as SubtitleCueRuntime));
    expect(getCueDisplaySegments(after as SubtitleCueRuntime)).toHaveLength(6);
  });
});

describe('the recorded partial-translation window at 2026-07-26 12:07', () => {
  const sequence = sequenceById('partial-translation-window');

  it('shows the source alone before the translation lands, then fills the same rows', () => {
    const sourceOnly = sequence.frames[2].cues.find((cue) => cue.cueId === 'omni-cue-1785038850965') as SubtitleCueRuntime;
    const committed = sequence.frames[3].cues.find((cue) => cue.cueId === 'omni-cue-1785038850965') as SubtitleCueRuntime;

    expect(sourceOnly.translatedText).toBe('');
    const before = getCueDisplaySegments(sourceOnly);
    const after = getCueDisplaySegments(committed);

    expect(before).toHaveLength(3);
    expect(after).toHaveLength(3);
    expect(before.every((row) => row.translatedText === '')).toBe(true);
    // Identical row ids and identical source text: the translation drops into
    // the rows that were already on screen instead of re-laying them out.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(sourceRows(after)).toEqual(sourceRows(before));
    expect(after.map((row) => row.translatedText)).toEqual([
      '这是一艘价值数百万美元的火箭飞船，一项未来的技术',
      '，总有一天会带你一路前往火星，住进你全新的家园，',
      '一个价值五亿美元的……',
    ]);
    expect(after.map((row) => row.translatedText).join('')).toBe(committed.translatedText);
  });

  it('marks only the trailing row of an untranslated cue as live', () => {
    const sourceOnly = sequence.frames[4].cues.find((cue) => cue.cueId === 'omni-cue-1785038862759') as SubtitleCueRuntime;
    const rows = getCueDisplaySegments(sourceOnly);

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.pending)).toEqual([false, false, false, false, false, true]);
    expect(rows[5].sourceText).toBe('This is');
  });
});

describe('the recorded re-translation of the same audio', () => {
  const sequence = sequenceById('replay-retranslation');

  it('does not re-flow already-rendered rows when a further sentence is appended', () => {
    const [shorter, longer] = sequence.frames.map((frame) => frame.cues[0]);

    expect(longer.sourceText.startsWith(shorter.sourceText)).toBe(true);
    expect(longer.cueId).not.toBe(shorter.cueId);
    expect(longer.translatedText).not.toBe(shorter.translatedText);

    const shorterLines = splitDisplayLines(shorter.sourceText);
    const longerLines = splitDisplayLines(longer.sourceText);
    expect(shorterLines).toEqual(['This is a one billion dollar rocket ship.']);
    expect(longerLines).toEqual([
      'This is a one billion dollar rocket ship.',
      'A future technology that will one day take you.',
    ]);
    expect(isPrefixOf(shorterLines, longerLines)).toBe(true);

    // Same guarantee through the full display path, not just the line splitter.
    expect(isPrefixOf(
      sourceRows(getCueDisplaySegments(shorter)).filter(Boolean),
      sourceRows(getCueDisplaySegments(longer)).filter(Boolean),
    )).toBe(true);
  });
});
