import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
  isTauri: () => false,
}));


import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from './desktop-api';
import { PreviewDesktopApi } from './preview-desktop-api';
import { getLiveSessionEventsRuntime } from './live-session-events-runtime';

describe('live session events runtime', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    resetDesktopApiForTests();
    installDesktopApi(new PreviewDesktopApi());
  });

  it('returns empty events in browser preview mode', async () => {
    const events = await getLiveSessionEventsRuntime();
    expect(events).toMatchObject({
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

  it('invokes the diagnostics_v2 command and maps envelope events in Tauri mode', async () => {
    installDesktopApi(new TauriDesktopApi());
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
    mocks.invoke.mockResolvedValue({ data: payload, warnings: [] });

    const events = await getLiveSessionEventsRuntime();
    expect(mocks.invoke).toHaveBeenCalledWith('diagnostics_v2', { command: { action: 'liveSessionEvents' } });
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
    installDesktopApi(new TauriDesktopApi());
    mocks.invoke.mockRejectedValue(new Error('command not found'));

    await expect(getLiveSessionEventsRuntime()).rejects.toThrow('command not found');
  });

  it('rejects when the native envelope payload is malformed', async () => {
    installDesktopApi(new TauriDesktopApi());
    mocks.invoke.mockResolvedValue('not-json');

    await expect(getLiveSessionEventsRuntime()).rejects.toThrow();
  });
});
