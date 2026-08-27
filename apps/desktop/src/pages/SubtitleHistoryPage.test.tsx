import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n/config';
import type { DesktopApi } from '../runtime/desktop-api';
import { DesktopApiProvider } from '../runtime/desktop-api-context';
import { useAppStore } from '../stores/app-store';
import { registerDomHarness } from '../test-utils/component-test-harness';
import { buttonByText, click } from '../test-utils/dom-interactions';
import SubtitleHistoryPage from './SubtitleHistoryPage';

vi.mock('@tauri-apps/api/event', async () => (await import('../test-utils/tauri-invoke-mock')).tauriEventMockModule());

import { listenMock } from '../test-utils/tauri-invoke-mock';

const initialState = useAppStore.getState();
const listSessions = vi.fn();
const listCues = vi.fn();
const playCueAudio = vi.fn();

const api = {
  capabilities: { hasNativeShell: true },
  history: {
    listSessions,
    getSession: vi.fn(),
    listCues,
    getStats: vi.fn(async () => ({ sessionCount: 1, cueCount: 2, audioBytes: 2048 })),
    deleteSession: vi.fn(async () => ({ deleted: true })),
    clear: vi.fn(async () => ({ deletedCount: 1 })),
    playCueAudio,
    stopPlayback: vi.fn(async () => ({ stopped: true })),
  },
} as unknown as DesktopApi;

const view = registerDomHarness({
  setup: async () => {
    useAppStore.setState(initialState, true);
    await i18n.changeLanguage('en');
    listenMock.mockReset().mockResolvedValue(() => undefined);
    listSessions.mockReset().mockResolvedValue({
      items: [{
        id: 'session-1', startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_001_000,
        status: 'completed', cueCount: 2, audioBytes: 2048,
      }],
      nextCursor: null,
    });
    listCues.mockReset().mockResolvedValue({
      items: [{
        id: 'history-cue-1', cueId: 'cue-1', sequence: 1, revision: 1,
        routeDirection: 'inbound', sourceText: 'hello', translatedText: '你好',
        sourceCommitted: true, translationCommitted: true,
        startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_000_500,
        sourceAudioAvailable: true, translatedAudioAvailable: true,
      }],
      nextCursor: null,
    });
    playCueAudio.mockReset().mockResolvedValue({ playbackId: 'play-1', status: 'started' });
  },
});

describe('SubtitleHistoryPage', () => {
  beforeEach(() => {
    window.confirm = vi.fn(() => true);
  });

  it('pages into cues, starts native playback, and disables it during a live route', async () => {
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(listSessions).toHaveBeenCalledWith(undefined, 25);

    await click(buttonByText(view.container, '2 cues'));
    await act(async () => { await Promise.resolve(); });
    expect(listCues).toHaveBeenCalledWith('session-1', undefined, 50);
    const sourceButton = buttonByText(view.container, 'Source audio');
    expect(sourceButton?.disabled).toBe(false);
    await click(sourceButton);
    expect(playCueAudio).toHaveBeenCalledWith('session-1', 'cue-1', 'source');

    act(() => {
      useAppStore.setState((state) => ({
        audioRuntimeSnapshot: {
          ...state.audioRuntimeSnapshot,
          inbound: { ...state.audioRuntimeSnapshot.inbound, streamBound: true },
        },
      }));
    });
    expect(buttonByText(view.container, 'Source audio')?.disabled).toBe(true);
    expect(view.container.textContent).toContain('disabled while a live audio route is active');
  });
});
