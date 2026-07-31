import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubtitleCueRuntime } from '../../schema/audio-runtime';
import type { DesktopApi } from '../../runtime/desktop-api';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import {
  buildOverlayRenderModels,
  useOverlayRenderReceipt,
} from './useOverlayRenderReceipt';

const rendered = vi.fn().mockResolvedValue(undefined);
const isVisible = vi.fn().mockResolvedValue(true);
const desktopApi = {
  capabilities: { hasNativeShell: true },
  overlay: { rendered },
  window: { isVisible },
} as unknown as DesktopApi;

function cue(overrides: Partial<SubtitleCueRuntime> = {}): SubtitleCueRuntime {
  return {
    cueId: 'cue-1',
    routeDirection: 'inbound',
    sourceText: '你好',
    translatedText: 'Hello',
    startedAt: 'unix-ms:1000',
    endedAt: 'unix-ms:1200',
    committed: true,
    translationCommitted: true,
    ...overrides,
  };
}

function Harness({
  cues,
  sessionId,
}: {
  cues: SubtitleCueRuntime[];
  sessionId: string | null;
}) {
  useOverlayRenderReceipt({
    desktopApi,
    displayCues: cues,
    reportSessionId: sessionId,
  });
  return null;
}

describe('useOverlayRenderReceipt', () => {
  const frames: Array<{ id: number; callback: FrameRequestCallback }> = [];
  const cancelled = new Set<number>();
  let nextFrameId = 1;

  const view = registerDomHarness({
    setup: () => {
      rendered.mockReset().mockResolvedValue(undefined);
      isVisible.mockReset().mockResolvedValue(true);
      frames.length = 0;
      cancelled.clear();
      nextFrameId = 1;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        const id = nextFrameId++;
        frames.push({ id, callback });
        return id;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
        cancelled.add(id);
      });
    },
    beforeUnmount: () => {
      vi.restoreAllMocks();
    },
  });

  async function flushMicrotasks() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function runNextFrame() {
    while (frames.length) {
      const frame = frames.shift();
      if (!frame || cancelled.has(frame.id)) continue;
      await act(async () => {
        frame.callback(16);
        await Promise.resolve();
      });
      return;
    }
    throw new Error('expected a pending animation frame');
  }

  async function crossRenderedFrame() {
    await flushMicrotasks();
    await runNextFrame();
    await runNextFrame();
    await flushMicrotasks();
  }

  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('uses the same display segments as the overlay render model', () => {
    expect(buildOverlayRenderModels([cue({
      sourceText: '第一句第二句',
      translatedText: 'FirstSecond',
      committed: false,
      translationCommitted: false,
      displaySegments: [
        { sourceText: '第一句', translatedText: 'First', pending: false },
        { sourceText: '第二句', translatedText: 'Second', pending: true },
      ],
    })])).toEqual([{
      cueId: 'cue-1',
      sourceText: '第一句\n第二句',
      translatedText: 'First\nSecond',
      committed: false,
    }]);
  });

  it('emits a visible receipt only after crossing a render frame and deduplicates unchanged content', async () => {
    const cues = [cue()];
    await view.render(<Harness cues={cues} sessionId="watch-1" />);
    await flushMicrotasks();
    expect(rendered).not.toHaveBeenCalled();

    await runNextFrame();
    expect(rendered).not.toHaveBeenCalled();
    await runNextFrame();
    await flushMicrotasks();

    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'watch-1',
      cueId: 'cue-1',
      revision: 1,
      sourceText: '你好',
      translatedText: 'Hello',
      committed: true,
      visible: true,
      renderedAtMs: expect.any(Number),
    }));

    await view.render(<Harness cues={[cue()]} sessionId="watch-1" />);
    await crossRenderedFrame();
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it('records hidden updates without a visible latency sample and confirms again after re-show', async () => {
    isVisible.mockResolvedValue(false);
    await view.render(<Harness cues={[cue()]} sessionId="watch-hidden" />);
    await flushMicrotasks();

    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'watch-hidden',
      visible: false,
    }));
    expect(frames.filter((frame) => !cancelled.has(frame.id))).toHaveLength(0);

    isVisible.mockResolvedValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await crossRenderedFrame();

    expect(rendered).toHaveBeenCalledTimes(2);
    expect(rendered).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'watch-hidden',
      revision: 1,
      visible: true,
    }));
  });

  it('keeps one frame chain across rapid deltas and extends it by only one frame when content changes', async () => {
    let resolveVisibility: ((visible: boolean) => void) | undefined;
    const visibility = new Promise<boolean>((resolve) => {
      resolveVisibility = resolve;
    });
    isVisible.mockImplementation(() => visibility);

    await view.render(<Harness cues={[cue({ translatedText: 'H' })]} sessionId="watch-stream" />);
    expect(frames.filter((frame) => !cancelled.has(frame.id))).toHaveLength(1);

    // A delta before the first frame updates the pending model without
    // cancelling or starting another two-frame confirmation.
    await view.render(<Harness cues={[cue({ translatedText: 'He' })]} sessionId="watch-stream" />);
    expect(frames.filter((frame) => !cancelled.has(frame.id))).toHaveLength(1);
    expect(cancelled).toHaveLength(0);

    await runNextFrame();
    expect(frames.filter((frame) => !cancelled.has(frame.id))).toHaveLength(1);

    // A delta between callbacks needs exactly one additional stable frame.
    await view.render(<Harness cues={[cue({ translatedText: 'Hello' })]} sessionId="watch-stream" />);
    await runNextFrame();
    expect(frames.filter((frame) => !cancelled.has(frame.id))).toHaveLength(1);
    expect(rendered).not.toHaveBeenCalled();

    resolveVisibility?.(true);
    await flushMicrotasks();
    await runNextFrame();
    await flushMicrotasks();

    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'watch-stream',
      revision: 3,
      translatedText: 'Hello',
      visible: true,
    }));
    expect(nextFrameId).toBe(4);
  });

  it('starts crossing render frames without waiting for a slow native visibility IPC', async () => {
    let resolveVisibility: ((visible: boolean) => void) | undefined;
    const visibility = new Promise<boolean>((resolve) => {
      resolveVisibility = resolve;
    });
    isVisible.mockImplementation(() => visibility);

    await view.render(<Harness cues={[cue()]} sessionId="watch-slow-visibility" />);
    expect(frames.filter((frame) => !cancelled.has(frame.id))).toHaveLength(1);

    await runNextFrame();
    await runNextFrame();
    expect(rendered).not.toHaveBeenCalled();
    expect(frames.filter((frame) => !cancelled.has(frame.id))).toHaveLength(0);

    resolveVisibility?.(true);
    await flushMicrotasks();
    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'watch-slow-visibility',
      visible: true,
    }));
  });

  it('cancels an old-session confirmation and starts cue revisions fresh for the new session', async () => {
    await view.render(<Harness cues={[cue()]} sessionId="watch-old" />);
    await flushMicrotasks();
    expect(frames).toHaveLength(1);

    await view.render(<Harness cues={[cue()]} sessionId="watch-new" />);
    await flushMicrotasks();
    while (frames.length) await runNextFrame();
    await flushMicrotasks();

    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'watch-new',
      revision: 1,
    }));
  });

  it('drops a late native visibility result from an old session', async () => {
    let resolveOldVisibility: ((visible: boolean) => void) | undefined;
    const oldVisibility = new Promise<boolean>((resolve) => {
      resolveOldVisibility = resolve;
    });
    isVisible.mockImplementationOnce(() => oldVisibility);

    await view.render(<Harness cues={[cue()]} sessionId="watch-old-slow" />);
    await runNextFrame();

    isVisible.mockResolvedValue(true);
    await view.render(<Harness cues={[cue({ translatedText: 'New' })]} sessionId="watch-new-fast" />);
    while (frames.some((frame) => !cancelled.has(frame.id))) await runNextFrame();
    await flushMicrotasks();

    resolveOldVisibility?.(true);
    await flushMicrotasks();

    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'watch-new-fast',
      translatedText: 'New',
      revision: 1,
    }));
  });
});
