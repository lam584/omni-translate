import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import { useAppStore } from '../../stores/app-store';
import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../desktop-api';
import { CONFIG_DRAFT_FALLBACK_STORAGE_KEY } from './config-fallback';
import { connectDesktopRuntimeBridge } from './connect';

const invokeMock = vi.fn();
const emitMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => false,
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: unknown[]) => emitMock(...args),
  listen: (...args: unknown[]) => listenMock(...args),
}));

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

describe('connectDesktopRuntimeBridge failure and sync edges', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    resetDesktopApiForTests();
    installDesktopApi(new TauriDesktopApi());
    useAppStore.setState((state) => ({
      ...state,
      configDraft: structuredClone(appConfigDraftMock),
      runtimeSnapshot: structuredClone(runtimeSnapshotMock),
      audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
      runtimeNotifications: [],
    }));
  });

  afterEach(() => {
    resetDesktopApiForTests();
  });

  it('reports listener registration failures as deferred warnings without blocking connect', async () => {
    happyInvoke();
    listenMock.mockRejectedValue(new Error('event channel down'));
    const pushSpy = vi.spyOn(useAppStore.getState(), 'pushRuntimeNotification');

    const cleanup = await connectDesktopRuntimeBridge();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const messages = pushSpy.mock.calls.map(([notification]) => notification.message);
    expect(messages.some((message) => message.includes('Runtime event listener failed'))).toBe(true);
    expect(messages.some((message) => message.includes('Config sync listener failed'))).toBe(true);
    cleanup();
    pushSpy.mockRestore();
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
    happyInvoke({ 'configuration_v2:load': new Error('sqlite offline') });
    const pushSpy = vi.spyOn(useAppStore.getState(), 'pushRuntimeNotification');

    const cleanup = await connectDesktopRuntimeBridge();

    const messages = pushSpy.mock.calls.map(([notification]) => notification.message);
    expect(messages.some((message) => message.includes('配置读取失败') || message.includes('Configuration loading failed'))).toBe(true);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).not.toBe('runtime-error');
    cleanup();
    pushSpy.mockRestore();
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
    happyInvoke({ 'configuration_v2:runtimeSnapshot': new Error('snapshot rebuild failed') });
    const pushSpy = vi.spyOn(useAppStore.getState(), 'pushRuntimeNotification');

    const cleanup = await connectDesktopRuntimeBridge();

    const messages = pushSpy.mock.calls.map(([notification]) => notification.message);
    expect(messages.some((message) => message.includes('Runtime snapshot refresh after config load failed'))).toBe(true);
    cleanup();
    pushSpy.mockRestore();
  });

  it('ignores echoed cross-window payloads that match the last serialized config', async () => {
    happyInvoke();
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, handler);
      return () => listeners.delete(eventName);
    });

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
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    resetDesktopApiForTests();
    installDesktopApi(new TauriDesktopApi());
  });

  afterEach(() => {
    resetDesktopApiForTests();
  });

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
    invokeMock.mockImplementation(async (command: string, args?: V2Args) => {
      const action = args?.command?.action;
      if (command === 'configuration_v2' && action === 'save') {
        return new Promise((_resolve, reject) => { rejectSave = reject; });
      }
      if (command.startsWith('append_frontend_diagnostics_log')) return undefined;
      if (command === 'session_v2') return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
    });

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
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    resetDesktopApiForTests();
    installDesktopApi(new TauriDesktopApi());
  });

  afterEach(() => {
    resetDesktopApiForTests();
  });

  it('does not touch the store when disposed right after the native save settled', async () => {
    happyInvoke();
    const cleanup = await connectDesktopRuntimeBridge();
    // Let the background bridge autostart settle before spying.
    await new Promise((resolve) => setTimeout(resolve, 0));

    let resolveSave: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementation(async (command: string, args?: V2Args) => {
      const action = args?.command?.action;
      if (command === 'configuration_v2' && action === 'save') {
        return new Promise((resolve) => { resolveSave = resolve; });
      }
      if (command.startsWith('append_frontend_diagnostics_log')) return undefined;
      if (command === 'session_v2') return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
    });

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
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    resetDesktopApiForTests();
    installDesktopApi(new TauriDesktopApi());
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDesktopApiForTests();
  });

  it('stops the retry loop at the loop head when disposed during the backoff sleep', async () => {
    happyInvoke();
    const cleanup = await connectDesktopRuntimeBridge();
    await new Promise((resolve) => setTimeout(resolve, 0));

    vi.useFakeTimers();
    let saveAttempts = 0;
    invokeMock.mockImplementation(async (command: string, args?: V2Args) => {
      const action = args?.command?.action;
      if (command === 'configuration_v2' && action === 'save') {
        saveAttempts += 1;
        throw new Error('sqlite busy');
      }
      if (command.startsWith('append_frontend_diagnostics_log')) return undefined;
      if (command === 'session_v2') return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
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
