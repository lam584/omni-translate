import { afterEach, describe, expect, it } from 'vitest';

import type { WatchSessionReportRuntime } from '../schema/audio-runtime';
import { installDesktopApi, resetDesktopApiForTests } from './desktop-api';
import { PreviewDesktopApi } from './preview-desktop-api';
import {
  EMPTY_PIPELINE_MILESTONES,
  getLiveSessionEventsRuntime,
} from './live-session-events-runtime';

afterEach(() => resetDesktopApiForTests());

function installReport(report: WatchSessionReportRuntime | null): void {
  const api = new PreviewDesktopApi();
  api.diagnostics.watchSessionReport = async <T,>() => report as T;
  installDesktopApi(api);
}

describe('getLiveSessionEventsRuntime', () => {
  it('returns an independent empty snapshot when no watch report exists', async () => {
    installReport(null);

    const first = await getLiveSessionEventsRuntime();
    first.pipelineMilestones.routeStartedMs = 42;
    const second = await getLiveSessionEventsRuntime();

    expect(second).toEqual({
      sessionStartedAt: '',
      elapsedMs: 0,
      model: '',
      asrDeltas: [],
      outputDeltas: [],
      asrFinal: '',
      translationFinal: '',
      pipelineMilestones: EMPTY_PIPELINE_MILESTONES,
    });
    expect(second.pipelineMilestones).not.toBe(first.pipelineMilestones);
  });

  it('maps provisional and final source/model events without leaking other stages', async () => {
    installReport({
      startedAt: 'unix-ms:1000',
      elapsedMs: 875,
      model: 'qwen-realtime',
      cues: [
        {
          cueId: 'cue-1',
          sourceText: 'first source',
          llmText: 'first translation',
          events: [
            { eventId: 's-1', stage: 'source', kind: 'asr-delta', elapsedMs: 10, text: 'hel', finalEvent: false },
            { eventId: 's-2', stage: 'source', kind: 'asr-final', elapsedMs: 20, text: 'hello', finalEvent: true },
            { eventId: 'm-1', stage: 'model', kind: 'text-delta', elapsedMs: 30, text: '你', finalEvent: false },
            { eventId: 'm-2', stage: 'model', kind: 'text-final', elapsedMs: 40, text: '你好', finalEvent: true },
            { eventId: 'r-1', stage: 'render', kind: 'visible', elapsedMs: 50, text: 'ignored', finalEvent: true },
          ],
        },
        {
          cueId: 'cue-2',
          sourceText: 'latest source',
          llmText: 'latest translation',
          events: [],
        },
      ],
    } as WatchSessionReportRuntime);

    const events = await getLiveSessionEventsRuntime();

    expect(events).toMatchObject({
      sessionStartedAt: 'unix-ms:1000',
      elapsedMs: 875,
      model: 'qwen-realtime',
      asrFinal: 'latest source',
      translationFinal: 'latest translation',
      pipelineMilestones: EMPTY_PIPELINE_MILESTONES,
    });
    expect(events.asrDeltas).toEqual([
      { elapsedMs: 10, eventType: 'asr-delta', stash: 'hel', text: '' },
      { elapsedMs: 20, eventType: 'asr-final', stash: '', text: 'hello' },
    ]);
    expect(events.outputDeltas).toEqual([
      { elapsedMs: 30, eventType: 'text-delta', stash: '你', committedText: '' },
      { elapsedMs: 40, eventType: 'text-final', stash: '', committedText: '你好' },
    ]);
  });
});
