import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => (await import('../test-utils/tauri-invoke-mock')).tauriCoreMockModule());

import { invokeMock } from '../test-utils/tauri-invoke-mock';
import { enablePreviewDesktopRuntime, enableTauriDesktopRuntime } from '../test-utils/runtime-test-harness';
import { getLiveSessionEventsRuntime } from './live-session-events-runtime';

describe('live session events runtime', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enablePreviewDesktopRuntime();
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
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('invokes the diagnostics_v2 command and maps envelope events in Tauri mode', async () => {
    enableTauriDesktopRuntime();
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
    invokeMock.mockResolvedValue({ data: payload, warnings: [] });

    const events = await getLiveSessionEventsRuntime();
    expect(invokeMock).toHaveBeenCalledWith('diagnostics_v2', { command: { action: 'liveSessionEvents' } });
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
    enableTauriDesktopRuntime();
    invokeMock.mockRejectedValue(new Error('command not found'));

    await expect(getLiveSessionEventsRuntime()).rejects.toThrow('command not found');
  });

  it('rejects when the native envelope payload is malformed', async () => {
    enableTauriDesktopRuntime();
    invokeMock.mockResolvedValue('not-json');

    await expect(getLiveSessionEventsRuntime()).rejects.toThrow();
  });
});
