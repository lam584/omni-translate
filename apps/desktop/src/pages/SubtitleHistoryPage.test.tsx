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

import { captureRegisteredListeners, listenMock } from '../test-utils/tauri-invoke-mock';

const initialState = useAppStore.getState();
const initialResolvedLanguageDescriptor = Object.getOwnPropertyDescriptor(i18n, 'resolvedLanguage');
const initialWindowConfirm = window.confirm;
const listSessions = vi.fn();
const listCues = vi.fn();
const playCueAudio = vi.fn();
const getStats = vi.fn();
const deleteSession = vi.fn();
const clear = vi.fn();
const stopPlayback = vi.fn();

const api = {
  capabilities: { hasNativeShell: true },
  history: {
    listSessions,
    getSession: vi.fn(),
    listCues,
    getStats,
    deleteSession,
    clear,
    playCueAudio,
    stopPlayback,
  },
} as unknown as DesktopApi & { capabilities: { hasNativeShell: boolean } };

const completedSession = {
  id: 'session-1', startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_001_000,
  status: 'completed', cueCount: 2, audioBytes: 2048,
};

const firstCue = {
  id: 'history-cue-1', cueId: 'cue-1', sequence: 1, revision: 1,
  routeDirection: 'inbound', sourceText: 'hello', translatedText: '你好',
  sourceCommitted: true, translationCommitted: true,
  startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_000_500,
  sourceAudioAvailable: true, translatedAudioAvailable: true,
};

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const view = registerDomHarness({
  setup: async () => {
    useAppStore.setState(initialState, true);
    if (initialResolvedLanguageDescriptor) {
      Object.defineProperty(i18n, 'resolvedLanguage', initialResolvedLanguageDescriptor);
    }
    window.confirm = initialWindowConfirm;
    await i18n.changeLanguage('en');
    api.capabilities.hasNativeShell = true;
    listenMock.mockReset().mockResolvedValue(() => undefined);
    listSessions.mockReset().mockResolvedValue({
      items: [completedSession],
      nextCursor: null,
    });
    listCues.mockReset().mockResolvedValue({
      items: [firstCue],
      nextCursor: null,
    });
    getStats.mockReset().mockResolvedValue({ sessionCount: 1, cueCount: 2, audioBytes: 2048 });
    deleteSession.mockReset().mockResolvedValue({ deleted: true });
    clear.mockReset().mockResolvedValue({ deletedCount: 1 });
    playCueAudio.mockReset().mockResolvedValue({ playbackId: 'play-1', status: 'started' });
    stopPlayback.mockReset().mockResolvedValue({ stopped: true });
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

  it('renders the preview-only state without querying native history', async () => {
    api.capabilities.hasNativeShell = false;

    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();

    expect(listSessions).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('available in the desktop app');
    expect(view.container.textContent).toContain('No subtitle history yet');
  });

  it('formats all storage units and falls back from a missing resolved locale', async () => {
    const numberLocaleSpy = vi.spyOn(Number.prototype, 'toLocaleString');
    try {
      Object.defineProperty(i18n, 'resolvedLanguage', {
        configurable: true,
        writable: true,
        value: undefined,
      });
      getStats
        .mockResolvedValueOnce({ sessionCount: 1234, cueCount: 5678, audioBytes: 100 })
        .mockResolvedValueOnce({ sessionCount: 1, cueCount: 2, audioBytes: 2048 })
        .mockResolvedValueOnce({ sessionCount: 1, cueCount: 2, audioBytes: 3 * 1024 ** 2 })
        .mockResolvedValueOnce({ sessionCount: 1, cueCount: 2, audioBytes: 4 * 1024 ** 3 });

      await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
      await flushAsyncWork();
      expect(numberLocaleSpy).toHaveBeenCalledWith('en');
      expect(view.container.textContent).toContain('100 B');

      for (const expected of ['2.0 KiB', '3.0 MiB', '4.00 GiB']) {
        await click(buttonByText(view.container, 'Refresh'));
        await flushAsyncWork();
        expect(view.container.textContent).toContain(expected);
      }
    } finally {
      numberLocaleSpy.mockRestore();
      if (initialResolvedLanguageDescriptor) {
        Object.defineProperty(i18n, 'resolvedLanguage', initialResolvedLanguageDescriptor);
      }
    }
  });

  it('appends unique session and cue pages while rendering active and missing fields', async () => {
    const activeSession = {
      ...completedSession,
      id: 'session-active',
      endedAtMs: null,
      status: 'active',
      cueCount: 1,
      audioBytes: 10,
    };
    listSessions
      .mockResolvedValueOnce({ items: [completedSession, activeSession], nextCursor: 'sessions-2' })
      .mockResolvedValueOnce({
        items: [completedSession, { ...completedSession, id: 'session-2', cueCount: 1 }],
        nextCursor: null,
      });
    listCues
      .mockResolvedValueOnce({ items: [firstCue], nextCursor: 'cues-2' })
      .mockResolvedValueOnce({
        items: [firstCue, {
          ...firstCue,
          id: 'history-cue-2', cueId: 'cue-2', sequence: 2,
          translatedText: '', sourceAudioAvailable: false, translatedAudioAvailable: false,
        }],
        nextCursor: null,
      });

    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();
    expect(view.container.textContent).toContain('Active');

    await click(buttonByText(view.container, 'Load more sessions'));
    await flushAsyncWork();
    expect(listSessions).toHaveBeenLastCalledWith('sessions-2', 25);
    expect(view.container.querySelectorAll('.subtitle-history-session')).toHaveLength(3);

    await click(buttonByText(view.container, '2 cues'));
    await flushAsyncWork();
    await click(buttonByText(view.container, 'Load more cues'));
    await flushAsyncWork();
    expect(listCues).toHaveBeenLastCalledWith('session-1', 'cues-2', 50);
    expect(view.container.querySelectorAll('.subtitle-history-cue')).toHaveLength(2);
    expect(view.container.textContent).toContain('Translation unavailable');
    const playbackButtons = view.container.querySelectorAll<HTMLButtonElement>('.subtitle-history-cue:last-of-type button');
    expect(Array.from(playbackButtons).every((button) => button.disabled)).toBe(true);
  });

  it('handles cancelled, unsuccessful, selected, and failed session deletion', async () => {
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();
    const deleteButton = view.container.querySelector<HTMLButtonElement>('button[aria-label="Delete session"]');

    window.confirm = vi.fn(() => false);
    await click(deleteButton);
    expect(deleteSession).not.toHaveBeenCalled();

    window.confirm = vi.fn(() => true);
    deleteSession.mockResolvedValueOnce({ deleted: false });
    await click(deleteButton);
    expect(view.container.querySelectorAll('.subtitle-history-session')).toHaveLength(1);

    await click(buttonByText(view.container, '2 cues'));
    await flushAsyncWork();
    deleteSession.mockResolvedValueOnce({ deleted: true });
    getStats.mockResolvedValueOnce({ sessionCount: 0, cueCount: 0, audioBytes: 0 });
    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="Delete session"]'));
    await flushAsyncWork();
    expect(view.container.querySelectorAll('.subtitle-history-session')).toHaveLength(0);
    expect(view.container.textContent).toContain('Select a session to review its cues');

    listSessions.mockResolvedValueOnce({ items: [completedSession], nextCursor: null });
    await click(buttonByText(view.container, 'Refresh'));
    await flushAsyncWork();
    deleteSession.mockRejectedValueOnce('delete denied');
    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="Delete session"]'));
    await flushAsyncWork();
    expect(view.container.textContent).toContain('delete denied');
  });

  it('honours clear cancellation and surfaces clear and refresh failures', async () => {
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();

    window.confirm = vi.fn(() => false);
    await click(buttonByText(view.container, 'Clear ended history'));
    expect(clear).not.toHaveBeenCalled();

    window.confirm = vi.fn(() => true);
    clear.mockRejectedValueOnce(new Error('clear failed'));
    await click(buttonByText(view.container, 'Clear ended history'));
    await flushAsyncWork();
    expect(view.container.textContent).toContain('clear failed');

    listSessions.mockRejectedValueOnce('refresh failed');
    await click(buttonByText(view.container, 'Refresh'));
    await flushAsyncWork();
    expect(view.container.textContent).toContain('refresh failed');
  });

  it('surfaces unexpected action rejections through the shared error handler', async () => {
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();
    window.confirm = vi.fn(() => {
      throw new Error('confirmation failed');
    });

    await click(buttonByText(view.container, 'Clear ended history'));
    await flushAsyncWork();

    expect(clear).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('confirmation failed');
  });

  it('clears the selected session and reloads after clearing history', async () => {
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();
    await click(buttonByText(view.container, '2 cues'));
    await flushAsyncWork();

    listSessions.mockResolvedValueOnce({ items: [], nextCursor: null });
    await click(buttonByText(view.container, 'Clear ended history'));
    await flushAsyncWork();

    expect(clear).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('Select a session to review its cues');
    expect(view.container.textContent).toContain('No subtitle history yet');
  });

  it('stops an active cue and reports playback and cue-loading failures', async () => {
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();
    await click(buttonByText(view.container, '2 cues'));
    await flushAsyncWork();

    await click(buttonByText(view.container, 'Source audio'));
    expect(buttonByText(view.container, 'Source audio')?.querySelector('svg')).not.toBeNull();
    await click(buttonByText(view.container, 'Source audio'));
    expect(stopPlayback).toHaveBeenCalledTimes(1);

    playCueAudio.mockRejectedValueOnce(new Error('play failed'));
    await click(buttonByText(view.container, 'Translated audio'));
    await flushAsyncWork();
    expect(view.container.textContent).toContain('play failed');

    listCues.mockRejectedValueOnce('cue load failed');
    await click(buttonByText(view.container, '2 cues'));
    await flushAsyncWork();
    expect(view.container.textContent).toContain('cue load failed');
  });

  it('refreshes from history events and reflects all playback event states', async () => {
    const listeners = captureRegisteredListeners();
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();
    await click(buttonByText(view.container, '2 cues'));
    await flushAsyncWork();

    const changed = listeners.get('history://changed');
    const playback = listeners.get('history://playback');
    expect(changed).toBeTypeOf('function');
    expect(playback).toBeTypeOf('function');

    act(() => changed?.({ payload: { kind: 'cue-upserted', sessionId: 'session-1' } }));
    await flushAsyncWork();
    expect(listSessions.mock.calls.length).toBeGreaterThan(1);
    expect(listCues.mock.calls.length).toBeGreaterThan(1);

    const sourceButton = buttonByText(view.container, 'Source audio');
    act(() => playback?.({ payload: { status: 'started', cueId: 'cue-1', track: 'source', playbackId: 'p1' } }));
    expect(sourceButton?.querySelector('rect[x="7"][width="10"]')).not.toBeNull();
    act(() => playback?.({ payload: { status: 'completed', cueId: 'cue-1', track: 'source', playbackId: 'p1' } }));
    expect(sourceButton?.querySelector('path[d="m9 7 8 5-8 5V7Z"]')).not.toBeNull();
    act(() => playback?.({ payload: { status: 'failed', cueId: 'cue-1', track: 'source', playbackId: 'p1', reason: 'device-lost' } }));
    expect(view.container.textContent).toContain('device-lost');

    act(() => playback?.({ payload: {
      status: 'failed', cueId: 'cue-1', track: 'source', playbackId: 'p2',
      reason: 'device-lost', error: 'speaker unavailable',
    } }));
    expect(view.container.textContent).toContain('speaker unavailable');
  });

  it('reports listener setup failure and disposes a late subscription on unmount', async () => {
    listenMock.mockRejectedValueOnce(new Error('listen failed'));
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await flushAsyncWork();
    expect(view.container.textContent).toContain('listen failed');

    await view.unmount();
    view.remount();
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const resolvers: Array<(value: () => void) => void> = [];
    listenMock.mockReset().mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
    await view.render(<DesktopApiProvider api={api}><SubtitleHistoryPage /></DesktopApiProvider>);
    await act(async () => { await Promise.resolve(); });
    await view.unmount();
    await act(async () => {
      resolvers[0]?.(firstUnlisten);
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[1]?.(secondUnlisten);
      await Promise.resolve();
    });
    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
    view.remount();
  });
});
