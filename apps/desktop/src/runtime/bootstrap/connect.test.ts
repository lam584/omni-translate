import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import { useAppStore } from '../../stores/app-store';
import { resetDesktopApiForTests } from '../desktop-api';
import { CONFIG_DRAFT_FALLBACK_STORAGE_KEY } from './config-fallback';
import { connectDesktopRuntimeBridge } from './connect';

vi.mock('@tauri-apps/api/core', async () => (await import('../../test-utils/tauri-invoke-mock')).tauriCoreMockModule());

vi.mock('@tauri-apps/api/event', async () => (await import('../../test-utils/tauri-invoke-mock')).tauriEventMockModule());

import { captureRegisteredListeners, emitMock, invokeMock, listenMock } from '../../test-utils/tauri-invoke-mock';
import { enableTauriDesktopRuntime } from '../../test-utils/runtime-test-harness';

type V2Args = { command?: { action?: string } };

function happyInvoke(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation(async (command: string, args?: V2Args) => {
    const action = args?.command?.action;
    const key = `${command}:${action ?? ''}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value;
    }
    if (command.startsWith('append_frontend_diagnostics_log')) return undefined;
    if (command === 'configuration_v2' && (action === 'bootstrapRuntime' || action === 'runtimeSnapshot')) {
      return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
    }
    if (command === 'configuration_v2' && action === 'load') {
      return { data: structuredClone(appConfigDraftMock), warnings: [] };
    }
    if (command === 'configuration_v2' && action === 'save') {
      return { data: structuredClone(runtimeSnapshotMock.storage), warnings: [] };
    }
    if (command === 'session_v2') {
      return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
    }
    if (command === 'bridge_v2') {
      return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
    }
    throw new Error(`unexpected command: ${key}`);
  });
}

/** Resets the shared IPC mocks and re-installs the Tauri desktop API. */
function resetConnectHarness() {
  invokeMock.mockReset();
  emitMock.mockReset().mockResolvedValue(undefined);
  listenMock.mockReset().mockResolvedValue(() => {});
  window.localStorage.clear();
  enableTauriDesktopRuntime();
}

/** Registers the shared connect-bridge beforeEach/afterEach pair. */
function registerConnectHooks() {
  beforeEach(resetConnectHarness);
  afterEach(() => {
    resetDesktopApiForTests();
  });
}

/** Routes configuration_v2 save through the given handler; every other command succeeds. */
function mockSaveInvoke(onSave: () => unknown) {
  invokeMock.mockImplementation(async (command: string, args?: V2Args) => {
    const action = args?.command?.action;
    if (command === 'configuration_v2' && action === 'save') {
      return onSave();
    }
    if (command.startsWith('append_frontend_diagnostics_log')) return undefined;
    if (command === 'session_v2') return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
    return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
  });
}

/** Connects with the given invoke overrides and returns the pushed notification messages. */
async function connectAndCollectWarnings(
  overrides: Record<string, unknown> = {},
  { settleTick = false } = {},
) {
  happyInvoke(overrides);
  const pushSpy = vi.spyOn(useAppStore.getState(), 'pushRuntimeNotification');

  const cleanup = await connectDesktopRuntimeBridge();
  if (settleTick) await new Promise((resolve) => setTimeout(resolve, 0));

  const messages = pushSpy.mock.calls.map(([notification]) => notification.message);
  cleanup();
  pushSpy.mockRestore();
  return messages;
}

describe('connectDesktopRuntimeBridge failure and sync edges', () => {
  registerConnectHooks();

  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: structuredClone(appConfigDraftMock),
      runtimeSnapshot: structuredClone(runtimeSnapshotMock),
      audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
      runtimeNotifications: [],
    }));
  });

  it('reports listener registration failures as deferred warnings without blocking connect', async () => {
    listenMock.mockRejectedValue(new Error('event channel down'));

    const messages = await connectAndCollectWarnings({}, { settleTick: true });

    expect(messages.some((message) => message.includes('Runtime event listener failed'))).toBe(true);
    expect(messages.some((message) => message.includes('Config sync listener failed'))).toBe(true);
  });

  it('reconciles the audio snapshot once after the background listeners register', async () => {
    // Regression: push events emitted between `bootstrap_audio` and the
    // background `listen()` registration were silently lost — the store kept a
    // stale snapshot until the next unrelated push. After registration
    // succeeds, one authoritative snapshot fetch must reconcile the gap.
    const reconciled = structuredClone(audioRuntimeSnapshotMock);
    reconciled.inbound.framesCaptured = 777;
    happyInvoke({ 'session_v2:snapshot': { data: reconciled, warnings: [] } });

    const cleanup = await connectDesktopRuntimeBridge();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshotCalls = invokeMock.mock.calls.filter(
      ([command, args]) => command === 'session_v2' && (args as V2Args)?.command?.action === 'snapshot',
    );
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(1);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.framesCaptured).toBe(777);
    cleanup();
  });

  it('degrades to low-frequency audio snapshot polling when the audio listener fails to register', async () => {
    // Regression: a failed `listen()` registration only warned. The audio
    // snapshot push channel is the only convergence signal for watch startup,
    // so losing it silently froze the session UI. It must fall back to polling.
    vi.useFakeTimers();
    try {
      const polled = structuredClone(audioRuntimeSnapshotMock);
      polled.inbound.framesCaptured = 888;
      happyInvoke({ 'session_v2:snapshot': { data: polled, warnings: [] } });
      listenMock.mockRejectedValue(new Error('event channel down'));

      const cleanup = await connectDesktopRuntimeBridge();
      await vi.advanceTimersByTimeAsync(0);
      invokeMock.mockClear();

      await vi.advanceTimersByTimeAsync(30_000);
      const pollCalls = () => invokeMock.mock.calls.filter(
        ([command, args]) => command === 'session_v2' && (args as V2Args)?.command?.action === 'snapshot',
      ).length;
      expect(pollCalls()).toBeGreaterThanOrEqual(1);
      expect(useAppStore.getState().audioRuntimeSnapshot.inbound.framesCaptured).toBe(888);

      const countBeforeCleanup = pollCalls();
      cleanup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pollCalls()).toBe(countBeforeCleanup);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resynchronizes through session_v2 when a subtitle delta sequence has a gap', async () => {
    const reconciled = structuredClone(audioRuntimeSnapshotMock);
    reconciled.subtitleOverlay.streamId = 'gap-stream';
    reconciled.subtitleOverlay.generation = 2;
    reconciled.subtitleOverlay.seq = 8;
    reconciled.subtitleOverlay.recentCues = [];
    reconciled.subtitleOverlay.activeCue = null;
    happyInvoke({ 'session_v2:snapshot': { data: reconciled, warnings: [] } });
    const listeners = captureRegisteredListeners();

    const cleanup = await connectDesktopRuntimeBridge();
    await new Promise((resolve) => setTimeout(resolve, 0));
    invokeMock.mockClear();
    listeners.get('audio://subtitle-delta')?.({
      payload: {
        streamId: useAppStore.getState().subtitleStreamId,
        generation: useAppStore.getState().subtitleGeneration,
        seq: useAppStore.getState().subtitleSeq + 2,
        operation: 'upsert',
        cue: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock.mock.calls.some(
      ([command, args]) => command === 'session_v2' && (args as V2Args)?.command?.action === 'snapshot',
    )).toBe(true);
    expect(useAppStore.getState().subtitleStreamId).toBe('gap-stream');
    expect(useAppStore.getState().subtitleSeq).toBe(8);
    cleanup();
  });

  it('retries subtitle resync when another gap arrives while the baseline snapshot is in flight', async () => {
    happyInvoke();
    const listeners = captureRegisteredListeners();
    const cleanup = await connectDesktopRuntimeBridge();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const initial = useAppStore.getState();
    const firstBaseline = structuredClone(initial.audioRuntimeSnapshot);
    firstBaseline.snapshotSeq = initial.audioRuntimeSnapshot.snapshotSeq + 100;
    firstBaseline.subtitleOverlay.streamId = initial.subtitleStreamId;
    firstBaseline.subtitleOverlay.generation = initial.subtitleGeneration;
    firstBaseline.subtitleOverlay.seq = initial.subtitleSeq + 2;
    firstBaseline.subtitleOverlay.recentCues = [];
    firstBaseline.subtitleOverlay.activeCue = null;

    const finalCue = {
      cueId: 'cue-final-after-second-gap',
      routeDirection: 'inbound' as const,
      sourceText: 'authoritative source final',
      translatedText: '权威最终译文',
      startedAt: 'unix-ms:1',
      endedAt: 'unix-ms:2',
      committed: true,
      translationCommitted: true,
    };
    const secondBaseline = structuredClone(firstBaseline);
    secondBaseline.snapshotSeq += 1;
    secondBaseline.subtitleOverlay.seq += 1;
    secondBaseline.subtitleOverlay.recentCues = [finalCue];
    secondBaseline.subtitleOverlay.activeCue = finalCue;

    let releaseFirstSnapshot: ((value: unknown) => void) | undefined;
    let snapshotCallCount = 0;
    invokeMock.mockImplementation(async (command: string, args?: V2Args) => {
      const action = args?.command?.action;
      if (command === 'session_v2' && action === 'snapshot') {
        snapshotCallCount += 1;
        if (snapshotCallCount === 1) {
          return new Promise((resolve) => { releaseFirstSnapshot = resolve; });
        }
        return { data: secondBaseline, warnings: [] };
      }
      if (command.startsWith('append_frontend_diagnostics_log')) return undefined;
      return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
    });

    const emitGap = (seq: number) => listeners.get('audio://subtitle-delta')?.({
      payload: {
        streamId: initial.subtitleStreamId,
        generation: initial.subtitleGeneration,
        seq,
        operation: 'upsert',
        cue: null,
      },
    });
    emitGap(initial.subtitleSeq + 2);
    await Promise.resolve();
    emitGap(initial.subtitleSeq + 3);
    await Promise.resolve();
    expect(snapshotCallCount).toBe(1);

    releaseFirstSnapshot?.({ data: firstBaseline, warnings: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(snapshotCallCount).toBe(2);
    expect(useAppStore.getState().subtitleSeq).toBe(secondBaseline.subtitleOverlay.seq);
    expect(useAppStore.getState().subtitleOrderedCueIds).toContain(finalCue.cueId);
    expect(useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay.recentCues).toHaveLength(1);
    expect(useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay.recentCues.length)
      .toBeLessThanOrEqual(32);
    cleanup();
  });

  it('degrades to the runtime-error snapshot when bootstrapRuntime fails after the ping', async () => {
    happyInvoke({ 'configuration_v2:bootstrapRuntime': new Error('runtime store exploded') });

    const steps: string[] = [];
    const cleanup = await connectDesktopRuntimeBridge((stepId, status) => steps.push(`${stepId}:${status}`));

    expect(steps).toEqual([
      'init-runtime:active',
      'init-runtime:error',
      'init-audio:error',
      'load-config:error',
    ]);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('runtime-error');
    cleanup();
  });

  it('keeps runtime state when config load fails and reports the warning', async () => {
    const messages = await connectAndCollectWarnings({ 'configuration_v2:load': new Error('sqlite offline') });

    expect(messages.some((message) => message.includes('配置读取失败') || message.includes('Configuration loading failed'))).toBe(true);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).not.toBe('runtime-error');
  });

  it('marks audio done-degraded when the audio bootstrap fails', async () => {
    happyInvoke({ 'session_v2:bootstrap': new Error('audio stack busy') });

    const pushSpy = vi.spyOn(useAppStore.getState(), 'pushRuntimeNotification');
    const steps: Array<[string, string, string | undefined]> = [];
    const cleanup = await connectDesktopRuntimeBridge((stepId, status, detail) => steps.push([stepId, status, detail]));
    await Promise.resolve();

    const audioDone = steps.find(([stepId, status]) => stepId === 'init-audio' && status === 'done');
    expect(audioDone?.[0]).toBe('init-audio');
    const messages = pushSpy.mock.calls.map(([notification]) => notification.message);
    expect(messages.some((message) => message.includes('Audio device refresh deferred'))).toBe(true);
    cleanup();
    pushSpy.mockRestore();
  });

  it('reports a warning when the post-hydration snapshot refresh fails', async () => {
    const messages = await connectAndCollectWarnings({ 'configuration_v2:runtimeSnapshot': new Error('snapshot rebuild failed') });

    expect(messages.some((message) => message.includes('Runtime snapshot refresh after config load failed'))).toBe(true);
  });

  it('ignores echoed cross-window payloads that match the last serialized config', async () => {
    happyInvoke();
    const listeners = captureRegisteredListeners();

    const cleanup = await connectDesktopRuntimeBridge();
    const current = useAppStore.getState().configDraft;
    invokeMock.mockClear();

    // Same serialized payload: both the Tauri sync event and the storage event
    // are dropped before touching the store.
    listeners.get('config://draft-updated')?.({ payload: structuredClone(current) });
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'omni.configDraftShadow',
      newValue: JSON.stringify(current),
    }));

    expect(useAppStore.getState().configDraft).toBe(current);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'configuration_v2').length).toBe(0);
    cleanup();
  });

  it('keeps the fallback slot when a newer draft arrived while the save was in flight', async () => {
    happyInvoke();
    const cleanup = await connectDesktopRuntimeBridge();

    // Queue a first draft; while its save is inflight the second draft lands,
    // so the fallback written for the second draft must survive the first
    // save's cleanup pass.
    let releaseFirstSave: (() => void) | undefined;
    let saveCount = 0;
    happyInvoke();
    invokeMock.mockImplementation(async (command: string, args?: V2Args) => {
      const action = args?.command?.action;
      if (command === 'configuration_v2' && action === 'save') {
        saveCount += 1;
        if (saveCount === 1) {
          await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
        }
        return { data: structuredClone(runtimeSnapshotMock.storage), warnings: [] };
      }
      if (command === 'configuration_v2' && action === 'runtimeSnapshot') {
        return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      }
      if (command.startsWith('append_frontend_diagnostics_log')) return undefined;
      if (command === 'session_v2') return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (command === 'bridge_v2') return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      throw new Error(`unexpected ${command}:${action}`);
    });

    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 51 });
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 52 });
    releaseFirstSave?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const stored = JSON.parse(window.localStorage.getItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY) ?? 'null');
    expect(stored?.subtitles?.overlayFontSize).toBe(52);
    cleanup();
  });
});

describe('connectDesktopRuntimeBridge disposal races', () => {
  registerConnectHooks();

  it('immediately releases listeners that resolve after cleanup', async () => {
    happyInvoke();
    const unlisten = vi.fn();
    let resolveListen: ((value: () => void) => void) | undefined;
    listenMock
      .mockImplementationOnce(() => new Promise<() => void>((resolve) => { resolveListen = resolve; }))
      .mockResolvedValue(() => {});

    const cleanup = await connectDesktopRuntimeBridge();
    cleanup();
    resolveListen?.(unlisten);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('abandons an in-flight persist retry after disposal', async () => {
    happyInvoke();
    const cleanup = await connectDesktopRuntimeBridge();

    let rejectSave: ((reason: unknown) => void) | undefined;
    mockSaveInvoke(() => new Promise((_resolve, reject) => { rejectSave = reject; }));

    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 61 });
    cleanup();
    rejectSave?.(new Error('save failed after dispose'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No error notification is pushed once disposed: the retry loop bails out.
    expect(useAppStore.getState().runtimeNotifications.every(
      (item) => !item.message.includes('Config write to SQLite failed'),
    )).toBe(true);
  });

  it('skips persisting a draft object that serializes identically', async () => {
    happyInvoke();
    const cleanup = await connectDesktopRuntimeBridge();
    invokeMock.mockClear();

    useAppStore.getState().setConfigDraft(structuredClone(useAppStore.getState().configDraft));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock.mock.calls.filter(
      ([command, args]) => command === 'configuration_v2' && (args as V2Args)?.command?.action === 'save',
    ).length).toBe(0);
    cleanup();
  });
});

describe('connectDesktopRuntimeBridge dispose after successful save', () => {
  registerConnectHooks();

  it('does not touch the store when disposed right after the native save settled', async () => {
    happyInvoke();
    const cleanup = await connectDesktopRuntimeBridge();
    // Let the background bridge autostart settle before spying.
    await new Promise((resolve) => setTimeout(resolve, 0));

    let resolveSave: ((value: unknown) => void) | undefined;
    mockSaveInvoke(() => new Promise((resolve) => { resolveSave = resolve; }));

    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 63 });
    const setRuntimeSnapshotSpy = vi.spyOn(useAppStore.getState(), 'setRuntimeSnapshot');
    cleanup();
    resolveSave?.({ data: structuredClone(runtimeSnapshotMock.storage), warnings: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setRuntimeSnapshotSpy).not.toHaveBeenCalled();
    setRuntimeSnapshotSpy.mockRestore();
  });
});

describe('connectDesktopRuntimeBridge retry-loop disposal', () => {
  registerConnectHooks();

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the retry loop at the loop head when disposed during the backoff sleep', async () => {
    happyInvoke();
    const cleanup = await connectDesktopRuntimeBridge();
    await new Promise((resolve) => setTimeout(resolve, 0));

    vi.useFakeTimers();
    let saveAttempts = 0;
    mockSaveInvoke(() => {
      saveAttempts += 1;
      throw new Error('sqlite busy');
    });

    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 64 });
    await vi.advanceTimersByTimeAsync(0);
    expect(saveAttempts).toBe(1);
    cleanup();
    // The backoff sleep elapses after disposal: the loop head bails out and
    // no further save attempt is made.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saveAttempts).toBe(1);
  });
});
