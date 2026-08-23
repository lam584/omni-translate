/**
 * Replays deterministic, hand-authored cue-update sequences through the real
 * overlay display path and pins the layout-stability invariants it depends on.
 * The fixture uses synthetic packet labels and counter-based time markers only.
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

type TraceFrameDefinition = {
  label: string;
  tickMs: number;
  cueStates: string[];
};

type TraceFrame = Omit<TraceFrameDefinition, 'cueStates'> & {
  cues: SubtitleCueRuntime[];
};

type TraceSequenceDefinition = {
  id: string;
  kind: 'cue-stream' | 'replay-comparison';
  title: string;
  shapes: string[];
  frames: TraceFrameDefinition[];
};

type TraceSequence = Omit<TraceSequenceDefinition, 'frames'> & {
  frames: TraceFrame[];
};

const fixture = JSON.parse(traceRaw) as {
  provenance: {
    kind: string;
    description: string;
    clock: string;
    schema: string;
  };
  cueStates: Record<string, SubtitleCueRuntime>;
  sequences: TraceSequenceDefinition[];
};

const sequences: TraceSequence[] = fixture.sequences.map((sequence) => ({
  ...sequence,
  frames: sequence.frames.map(({ cueStates, ...frame }) => ({
    ...frame,
    cues: cueStates.map((stateName) => {
      const cue = fixture.cueStates[stateName];
      if (!cue) throw new Error(`fixture is missing the "${stateName}" cue state`);
      return cue;
    }),
  })),
}));

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

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectKeys(entry, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(entry, keys);
  }
  return keys;
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

describe('synthetic session trace fixture', () => {
  it('contains only counter-based, hand-authored test evidence', () => {
    expect(fixture.provenance.kind).toBe('deterministic-synthetic');
    const forbiddenKeys = [
      'sourceLog',
      'harvestedOn',
      'harvestedBy',
      'logLine',
      'logLines',
      'session',
      'frameOrderNote',
      'provenanceWarning',
    ];
    const fixtureKeys = collectObjectKeys(fixture);
    for (const forbiddenKey of forbiddenKeys) expect(fixtureKeys.has(forbiddenKey)).toBe(false);
    expect(traceRaw).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/u);
    expect(traceRaw).not.toMatch(/[+-]\d{2}:\d{2}/u);

    for (const cue of Object.values(fixture.cueStates)) {
      expect(cue.cueId).toMatch(/^synthetic-cue-[a-z0-9-]+$/u);
      expect(cue.sourceText).toMatch(/^Synthetic /u);
    }
  });

  it('carries the intended synthetic behavior sequences', () => {
    expect(sequences.map((sequence) => sequence.id)).toEqual([
      'partial-translation-window',
      'overlapping-rehypothesis',
      'rolling-commit-window',
      'replay-retranslation',
    ]);
    expect(sequences.map((sequence) => sequence.frames.length)).toEqual([4, 6, 4, 2]);

    for (const sequence of sequences) {
      for (const frame of sequence.frames) {
        expect(frame.cues.length).toBeGreaterThan(0);
        for (const cue of frame.cues) {
          expect(cue.routeDirection).toBe('inbound');
          expect(cue.startedAt).toMatch(/^unix-ms:\d{13}$/u);
          expect(cue.endedAt).toMatch(/^unix-ms:\d{13}$/u);
          expect(cue.displaySegments).toBeUndefined();
          expect(cue.displaySourceText).toBeUndefined();
        }
      }
    }
  });

  it('keeps every frame ordered by its synthetic counter', () => {
    for (const sequence of sequences) {
      const ticks = sequence.frames.map((frame) => frame.tickMs);
      expect(ticks).toEqual([...ticks].sort((left, right) => left - right));
      for (const frame of sequence.frames) {
        for (const cue of frame.cues) {
          expect(Number(cue.endedAt.slice('unix-ms:'.length))).toBeLessThanOrEqual(frame.tickMs);
        }
      }
    }
  });
});

describe.each(cueStreams.map((sequence) => [sequence.id, sequence] as const))(
  'replaying synthetic sequence %s through the real overlay display path',
  (_id, sequence) => {
    it('never re-arranges the rows of a cue once it is committed', () => {
      const frozen = new Map<string, { frameIndex: number; segments: OverlayDisplaySegment[]; cue: SubtitleCueRuntime }>();
      let committedCueCount = 0;

      sequence.frames.forEach((frame, frameIndex) => {
        const timeline = getOverlayTimeline(frame.cues);

        frame.cues.forEach((cue, cueIndex) => {
          if (!cue.committed) {
            expect(frozen.has(cue.cueId)).toBe(false);
            return;
          }
          const segments = getCueDisplaySegments(cue);

          expect(segments.every((segment) => !segment.pending)).toBe(true);
          expect(timeline.cues[cueIndex].historySegments).toEqual(segments);
          expect(timeline.liveCue?.cueId).not.toBe(cue.cueId);

          const previous = frozen.get(cue.cueId);
          if (!previous) {
            committedCueCount += 1;
            frozen.set(cue.cueId, { frameIndex, segments, cue });
            return;
          }
          expect(cue).toEqual(previous.cue);
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

        expect(currentCues.length).toBeGreaterThanOrEqual(previousCues.size);
        for (const cueId of previousCues.keys()) {
          expect(currentCues.some((cue) => cue.cueId === cueId)).toBe(true);
        }

        for (const cue of currentCues) {
          const previous = previousCues.get(cue.cueId);
          if (!previous || previous.committed) continue;
          growthSteps += 1;

          expect(cue.startedAt).toBe(previous.startedAt);
          expect(cue.sourceText.startsWith(previous.sourceText)).toBe(true);
          expect(cue.translatedText.startsWith(previous.translatedText)).toBe(true);

          const before = getCueDisplaySegments(previous);
          const after = getCueDisplaySegments(cue);
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

describe('synthetic overlapping re-hypothesis', () => {
  const sequence = sequenceById('overlapping-rehypothesis');
  const frameByLabel = (needle: string) => {
    const frame = sequence.frames.find((candidate) => candidate.label.includes(needle));
    if (!frame) throw new Error(`no frame labelled "${needle}"`);
    return frame;
  };

  it('leaves the live slot on the stale cue when a newer cue commits', () => {
    const frame = frameByLabel('seed commits');
    const timeline = getOverlayTimeline(frame.cues);

    expect(timeline.liveCue?.cueId).toBe('synthetic-cue-stale');
    expect(timeline.liveSegment?.sourceText).toContain('Pending tail.');
    expect(frame.cues.find((cue) => cue.cueId === 'synthetic-cue-overlap-seed')?.committed).toBe(true);
  });

  it('renders repeated synthetic words in both independently keyed cues', () => {
    const frame = frameByLabel('extension commits');
    const earlier = frame.cues.find((cue) => cue.cueId === 'synthetic-cue-overlap-seed') as SubtitleCueRuntime;
    const later = frame.cues.find((cue) => cue.cueId === 'synthetic-cue-overlap-extension') as SubtitleCueRuntime;

    expect(later.sourceText.startsWith(earlier.sourceText)).toBe(true);
    expect(stripWhitespace(sourceRows(getCueDisplaySegments(earlier)).join(''))).toBe(stripWhitespace(earlier.sourceText));
    expect(stripWhitespace(sourceRows(getCueDisplaySegments(later)).join(''))).toBe(stripWhitespace(later.sourceText));
  });

  it('does not disturb a committed cue when an empty update arrives', () => {
    const before = frameByLabel('extension commits').cues.find((cue) => cue.cueId === 'synthetic-cue-overlap-extension');
    const after = frameByLabel('empty update').cues.find((cue) => cue.cueId === 'synthetic-cue-overlap-extension');

    expect(after).toEqual(before);
    expect(getCueDisplaySegments(after as SubtitleCueRuntime))
      .toEqual(getCueDisplaySegments(before as SubtitleCueRuntime));
  });
});

describe('synthetic partial-translation window', () => {
  const sequence = sequenceById('partial-translation-window');

  it('fills the same source rows when the translation lands', () => {
    const sourceOnly = sequence.frames[2].cues.find((cue) => cue.cueId === 'synthetic-cue-beta') as SubtitleCueRuntime;
    const committed = sequence.frames[3].cues.find((cue) => cue.cueId === 'synthetic-cue-beta') as SubtitleCueRuntime;
    const before = getCueDisplaySegments(sourceOnly);
    const after = getCueDisplaySegments(committed);

    expect(sourceOnly.translatedText).toBe('');
    expect(before.every((row) => row.translatedText === '')).toBe(true);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(sourceRows(after)).toEqual(sourceRows(before));
    expect(after.map((row) => row.translatedText).join('')).toBe(committed.translatedText);
  });

  it('marks only the trailing row of an untranslated cue as live', () => {
    const sourceOnly = sequence.frames[2].cues.find((cue) => cue.cueId === 'synthetic-cue-beta') as SubtitleCueRuntime;
    const rows = getCueDisplaySegments(sourceOnly);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.pending).toBe(true);
    expect(rows.slice(0, -1).every((row) => !row.pending)).toBe(true);
  });
});

describe('synthetic replay re-translation', () => {
  const sequence = sequenceById('replay-retranslation');

  it('does not re-flow already-rendered rows when one clause is appended', () => {
    const [shorter, longer] = sequence.frames.map((frame) => frame.cues[0]);

    expect(longer.sourceText.startsWith(shorter.sourceText)).toBe(true);
    expect(longer.cueId).not.toBe(shorter.cueId);
    expect(longer.translatedText).not.toBe(shorter.translatedText);

    const shorterLines = splitDisplayLines(shorter.sourceText);
    const longerLines = splitDisplayLines(longer.sourceText);
    expect(isPrefixOf(shorterLines, longerLines)).toBe(true);
    expect(longerLines.length).toBeGreaterThan(shorterLines.length);
    expect(isPrefixOf(
      sourceRows(getCueDisplaySegments(shorter)).filter(Boolean),
      sourceRows(getCueDisplaySegments(longer)).filter(Boolean),
    )).toBe(true);
  });
});
