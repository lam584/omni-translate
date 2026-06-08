import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('./tauri-runtime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime(),
}));

import { getLiveSessionEventsRuntime } from './live-session-events-runtime';

describe('live session events runtime', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauriRuntime.mockReset().mockReturnValue(false);
  });

  it('returns empty events in browser preview mode', async () => {
    const events = await getLiveSessionEventsRuntime();
    expect(events).toEqual({
      sessionStartedAt: '',
      elapsedMs: 0,
      model: '',
      asrDeltas: [],
      outputDeltas: [],
      asrFinal: '',
      translationFinal: '',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('invokes native command and parses JSON in Tauri mode', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    const payload = {
      sessionStartedAt: 'unix-ms:1000',
      elapsedMs: 5000,
      model: 'qwen3.5-omni-plus-realtime',
      asrDeltas: [
        { elapsedMs: 100, stash: '你好', text: '', eventType: 'asr.delta' },
      ],
      outputDeltas: [
        { elapsedMs: 200, eventType: 'response.done', stash: '', committedText: 'Hello' },
      ],
      asrFinal: '你好',
      translationFinal: 'Hello',
    };
    mocks.invoke.mockResolvedValue(JSON.stringify(payload));

    const events = await getLiveSessionEventsRuntime();
    expect(mocks.invoke).toHaveBeenCalledWith('get_live_session_events');
    expect(events.model).toBe('qwen3.5-omni-plus-realtime');
    expect(events.elapsedMs).toBe(5000);
    expect(events.asrDeltas).toHaveLength(1);
    expect(events.asrDeltas[0].stash).toBe('你好');
    expect(events.outputDeltas).toHaveLength(1);
    expect(events.outputDeltas[0].committedText).toBe('Hello');
    expect(events.asrFinal).toBe('你好');
    expect(events.translationFinal).toBe('Hello');
  });

  it('rejects when native invoke fails', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error('command not found'));

    await expect(getLiveSessionEventsRuntime()).rejects.toThrow('command not found');
  });

  it('rejects when native invoke returns invalid JSON', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockResolvedValue('not-json');

    await expect(getLiveSessionEventsRuntime()).rejects.toThrow();
  });
});
