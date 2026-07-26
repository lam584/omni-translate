import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { createFakeBridge, type FakeBridge } from '../mocks/fake-bridge';
import SubtitleOverlayPage from '../pages/SubtitleOverlayPage';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import {
  getAudioRuntimeSnapshotRuntime,
  startAudioRouteRuntime,
  startSpeechDispatchRuntime,
  stopAudioRouteRuntime,
  stopSpeechDispatchRuntime,
  waitForWatchRouteReadyRuntime,
} from './audio-runtime';
import { refreshBridgeRuntime, startBridgeServiceRuntime, stopBridgeServiceRuntime } from './bridge-runtime';

// Contract integration layer for the desktop-runtime ↔ bridge boundary. The
// real renderer runtime modules run against an injectable fake bridge / fake
// provider (no real credentials, no physical audio devices), converting the
// former manual E2E checklist rows — subtitle display, locked overlay
// click-through, TTS counters — into automated cases.

const harness = vi.hoisted(() => ({
  runtime: true,
  invoke: null as null | (<T>(command: string, args?: Record<string, unknown>) => Promise<T>),
  pointer: { x: 0, y: 0 },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!harness.invoke) {
      return Promise.reject(new Error(`fake bridge not installed for command ${command}`));
    }
    return harness.invoke(command, args);
  },
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    constructor(public x: number, public y: number) {}
  },
  LogicalSize: class LogicalSize {
    constructor(public width: number, public height: number) {}
  },
}));

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: vi.fn(async () => ({
      close: vi.fn(async () => undefined),
      popup: vi.fn(async () => undefined),
    })),
  },
}));

vi.mock('@tauri-apps/api/window', () => {
  const windowHandle = {
    innerSize: vi.fn(async () => ({ width: 640, height: 180 })),
    onResized: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 640, height: 180 })),
    scaleFactor: vi.fn(async () => 1),
    setDecorations: vi.fn(async () => undefined),
    setIgnoreCursorEvents: vi.fn(async () => undefined),
    setPosition: vi.fn(async () => undefined),
    setResizable: vi.fn(async () => undefined),
    setShadow: vi.fn(async () => undefined),
    setSize: vi.fn(async () => undefined),
    startDragging: vi.fn(async () => undefined),
    startResizeDragging: vi.fn(async () => undefined),
  };

  return {
    PhysicalPosition: class PhysicalPosition {
      constructor(public x: number, public y: number) {}
    },
    currentMonitor: vi.fn(async () => ({
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
    })),
    cursorPosition: vi.fn(async () => ({ ...harness.pointer })),
    getCurrentWindow: () => windowHandle,
  };
});

vi.mock('./tauri-runtime', () => ({
  isTauriRuntime: () => harness.runtime,
  waitForTauriRuntime: async () => harness.runtime,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

function createConfig(): AppConfigDraft {
  const config = structuredClone(appConfigDraftMock);
  config.subtitles.overlayLocked = false;
  return config;
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text);
}

describe('desktop-runtime ↔ bridge contract integration (fake bridge)', () => {
  let fake: FakeBridge;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    harness.runtime = true;
    harness.pointer = { x: 5000, y: 5000 };
    fake = createFakeBridge();
    harness.invoke = fake.invoke;
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: fake.getAudioSnapshot(),
      configDraft: createConfig(),
      runtimeSnapshot: fake.getRuntimeSnapshot(),
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    harness.invoke = null;
    vi.useRealTimers();
  });

  async function renderOverlay() {
    await act(async () => {
      root.render(<SubtitleOverlayPage />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function flushAsync() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function advanceLockedRevealPoll() {
    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('drives the bridge_v2 lifecycle contract without real credentials', async () => {
    const config = createConfig();

    const refreshed = await refreshBridgeRuntime();
    expect(refreshed.bridgeStatus).toBe('tauri-shell');

    const started = await startBridgeServiceRuntime(config);
    expect(started.bridge.processStatus).toBe('running');
    expect(started.bridge.lifecycleState).toBe('ready');
    expect(started.bridge.sessionId).toBe('fake-bridge-session');

    const stopped = await stopBridgeServiceRuntime();
    expect(stopped.bridge.processStatus).toBe('stopped');
    expect(stopped.bridge.sessionId).toBeNull();

    expect(fake.commandCalls('bridge_v2').map((call) => call.action)).toEqual(['refresh', 'start', 'stop']);
  });

  // Manual E2E row "Subtitle display": start inbound capture, drive the
  // native-style convergence, and confirm subtitle cues appear in the overlay.
  it('acknowledges route start with an armed snapshot and converges to capturing via the event channel', async () => {
    const config = createConfig();
    const pushedSnapshots: AudioRuntimeSnapshot[] = [];
    await fake.listen<AudioRuntimeSnapshot>('audio://snapshot', (event) => {
      pushedSnapshots.push(event.payload);
      useAppStore.getState().setAudioRuntimeSnapshot(event.payload);
    });

    const accepted = await startAudioRouteRuntime('inbound', config);

    // Real backend semantics: the command acknowledges acceptance. Capturing
    // arrives later through the push channel, never in the return value.
    expect(fake.commandCalls('start_audio_route')).toHaveLength(1);
    expect(accepted.inbound.captureState).toBe('armed');
    expect(accepted.inbound.streamBound).toBe(false);
    expect(accepted.subtitleOverlay.recentCues).toHaveLength(0);

    await fake.settle();

    const converged = pushedSnapshots.at(-1);
    expect(converged?.inbound.captureState).toBe('capturing');
    expect(converged?.inbound.streamBound).toBe(true);
    const cue = converged?.subtitleOverlay.recentCues[0];
    expect(cue?.routeDirection).toBe('inbound');
    expect(cue?.translatedText).toBe('译文：fake inbound speech');

    await renderOverlay();
    expect(container.textContent).toContain('译文：fake inbound speech');
  });

  it('resolves waitForWatchRouteReadyRuntime only after native convergence', async () => {
    const config = createConfig();
    const accepted = await startAudioRouteRuntime('inbound', config);
    expect(accepted.inbound.streamBound).toBe(false);

    const readyPromise = waitForWatchRouteReadyRuntime(1_000);
    await fake.settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    const ready = await readyPromise;

    expect(ready.inbound.streamBound).toBe(true);
    expect(ready.inbound.captureState).toBe('capturing');
  });

  it('delivers an accepted-then-failed route start as an async lastError snapshot', async () => {
    const config = createConfig();
    fake.failNextRouteStart('inbound', {
      lastError: 'watch_mode.route_command_timeout: capture initialization timed out',
      recommendedAction: 'restart-bridge',
    });
    const pushed: AudioRuntimeSnapshot[] = [];
    await fake.listen<AudioRuntimeSnapshot>('audio://snapshot', (event) => pushed.push(event.payload));

    // The command itself still succeeds — the native worker fails later.
    const accepted = await startAudioRouteRuntime('inbound', config);
    expect(accepted.inbound.captureState).toBe('armed');
    expect(accepted.inbound.lastError).toBeNull();

    await fake.settle();

    const failed = pushed.at(-1);
    expect(failed?.inbound.lastError).toContain('route_command_timeout');
    expect(failed?.inbound.recommendedAction).toBe('restart-bridge');
    expect(failed?.inbound.streamBound).toBe(false);
    expect(failed?.status).toBe('degraded');
  });

  it('rejects a v2 command with the ServiceErrorV2 wire shape when injected', async () => {
    fake.rejectNextAction('startSpeech', {
      code: 'speech.start-rejected',
      message: '扬声器初始化被占用',
      retriable: true,
    });

    await expect(startSpeechDispatchRuntime(createConfig())).rejects.toMatchObject({
      code: 'speech.start-rejected',
      message: '扬声器初始化被占用',
      retriable: true,
    });
  });

  it('resolves an in-flight invoke only after the newer push snapshot landed (interleaving)', async () => {
    const config = createConfig();
    const order: string[] = [];
    await fake.listen<AudioRuntimeSnapshot>('audio://snapshot', (event) => {
      if (event.payload.inbound.streamBound) order.push('push:capturing');
    });

    fake.holdInvokeUntilConvergence('start_audio_route');
    const inFlight = startAudioRouteRuntime('inbound', config).then((snapshot) => {
      order.push(`invoke:${snapshot.inbound.captureState}`);
      return snapshot;
    });
    const returned = await inFlight;

    // The event channel carried the newer capturing state before the invoke
    // resolved, and the invoke's return value is the stale acceptance state:
    // consumers must treat pushes, not return values, as the source of truth.
    expect(order).toEqual(['push:capturing', 'invoke:armed']);
    expect(returned.inbound.captureState).toBe('armed');
    expect(fake.getAudioSnapshot().inbound.captureState).toBe('capturing');
  });

  it('streams an uncommitted cue without display segments and keeps the layout stable after commit', async () => {
    // The streaming path re-hypothesizes text (grow, then shrink) with the cue
    // uncommitted and displaySegments entirely absent — the serde
    // skip_serializing_if shape the real backend sends.
    const pushed: AudioRuntimeSnapshot[] = [];
    await fake.listen<AudioRuntimeSnapshot>('audio://snapshot', (event) => pushed.push(event.payload));

    const cueId = fake.streamCue('inbound', ['fake partial', 'fake partial sentence', 'fake partial se']);
    for (const snapshot of pushed) {
      const active = snapshot.subtitleOverlay.activeCue;
      expect(active?.cueId).toBe(cueId);
      expect(active?.committed).toBe(false);
      expect(active?.displaySegments).toBeUndefined();
      expect(active?.translatedText).toBe('');
    }

    const committed = fake.commitActiveCue();
    expect(committed.committed).toBe(true);
    expect(committed.displaySegments).toHaveLength(1);
    expect(committed.translatedText).toBe('译文：fake partial se');

    // Subtitle segments double as the TTS schedule: once committed, further
    // snapshots must not re-arrange the segment rows (a layout flip would
    // replay already-spoken audio).
    const before = fake.getAudioSnapshot().subtitleOverlay.activeCue?.displaySegments;
    fake.dispatchSpeechCue();
    await fake.settle();
    const after = fake.getAudioSnapshot().subtitleOverlay.activeCue?.displaySegments;
    expect(after).toEqual(before);
  });

  it('surfaces realtime reconnect transitions through sttConnection and a progress cue', async () => {
    const pushed: AudioRuntimeSnapshot[] = [];
    await fake.listen<AudioRuntimeSnapshot>('audio://snapshot', (event) => pushed.push(event.payload));

    fake.dropRealtimeConnection('provider closed the WebSocket');
    const reconnecting = pushed.at(-1);
    expect(reconnecting?.sttConnection.state).toBe('reconnecting');
    expect(reconnecting?.sttConnection.reconnectAttempt).toBe(1);
    expect(reconnecting?.sttConnection.lastDisconnectReason).toContain('WebSocket');
    expect(reconnecting?.subtitleOverlay.recentCues[0]?.sourceText).toContain('正在重新连接');

    fake.restoreRealtimeConnection();
    expect(pushed.at(-1)?.sttConnection.state).toBe('connected');
  });

  it('converges stopRoute through stopping to idle and supports the stuck-in-stopping scenario', async () => {
    await startAudioRouteRuntime('inbound', createConfig());
    await fake.settle();
    expect(fake.getAudioSnapshot().inbound.streamBound).toBe(true);

    const stopping = await stopAudioRouteRuntime('inbound');
    expect(stopping.inbound.captureState).toBe('stopping');
    await fake.settle();
    const stopped = fake.getAudioSnapshot();
    expect(stopped.inbound.captureState).toBe('idle');
    expect(stopped.sessionStartedAt).toBeNull();

    // Stuck in stopping: the native stop never converges.
    await startAudioRouteRuntime('inbound', createConfig());
    await fake.settle();
    fake.holdNextStopRoute('inbound');
    await stopAudioRouteRuntime('inbound');
    await fake.settle();
    expect(fake.getAudioSnapshot().inbound.captureState).toBe('stopping');
  });

  // Manual E2E row "Locked subtitle overlay input": lock keeps the window in
  // click-through mode, the unlock hotspot stays interactive, and unlocking
  // restores full window interaction.
  it('propagates locked click-through and hotspot interactivity through the window-state contract', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: { ...state.configDraft.subtitles, overlayLocked: true },
      },
    }));

    await renderOverlay();

    // Locked: the native window is told to pass clicks through the center.
    expect(fake.getOverlayWindowState()).toEqual({ locked: true, rounded: true, hotspotInteractive: false });

    // Pointer moves onto the top-right unlock hotspot: the unlock button must
    // stay clickable while the rest of the overlay keeps passing clicks through.
    harness.pointer = { x: 600, y: 20 };
    await advanceLockedRevealPoll();
    expect(fake.getOverlayWindowState()).toEqual({ locked: true, rounded: true, hotspotInteractive: true });

    // Clicking unlock restores normal window interaction (drag/resize/menu).
    const unlockButton = findButton(container, '解锁');
    expect(unlockButton).not.toBeUndefined();
    await act(async () => unlockButton?.click());
    await flushAsync();

    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(false);
    expect(fake.commandCalls('unlock_subtitle_overlay')).toHaveLength(1);
    expect(fake.getOverlayWindowState()).toMatchObject({ locked: false });
  });

  // Manual E2E row "TTS outbound": start the dispatch worker, drive one cue
  // through the worker lifecycle, and confirm the counters advance then.
  it('keeps counters still at start_speech and advances them through the worker dispatch lifecycle', async () => {
    const config = createConfig();
    config.speech.outputTarget = 'both';

    const baseline = await getAudioRuntimeSnapshotRuntime();
    expect(baseline.speech.speakerFramesWritten).toBe(0);
    expect(baseline.speech.virtualMicFramesWritten).toBe(0);

    // Real start_speech_dispatch semantics: the command only starts the
    // worker (waiting-subtitle) — nothing plays and no counter moves yet.
    const started = await startSpeechDispatchRuntime(config);
    expect(started.speech.dispatchState).toBe('waiting-subtitle');
    expect(started.speech.speakerFramesWritten).toBe(0);
    expect(started.speech.virtualMicFramesWritten).toBe(0);
    expect(started.speech.recentEvents).toHaveLength(0);

    // A cue arrives and the worker dispatches it: deferred →
    // realtime-audio-requested → playing → completed, all via pushes.
    fake.streamCue('inbound', ['fake speech line']);
    fake.commitActiveCue();
    fake.dispatchSpeechCue();
    await fake.settle();

    const dispatched = fake.getAudioSnapshot();
    expect(dispatched.speech.speakerFramesWritten).toBeGreaterThan(0);
    expect(dispatched.speech.virtualMicFramesWritten).toBeGreaterThan(0);
    const kinds = dispatched.speech.recentEvents.map((event) => event.kind);
    expect(kinds).toEqual(['speech.completed', 'speech.realtime-audio-requested', 'speech.deferred']);

    const stopped = await stopSpeechDispatchRuntime();
    expect(stopped.speech.dispatchState).toBe('idle');
    expect(stopped.speech.speakerFramesWritten).toBe(dispatched.speech.speakerFramesWritten);

    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(1);
    expect(fake.sessionActionCalls('stopSpeech')).toHaveLength(1);
  });

  it('folds a missing speaker device into speech.lastError and degraded status', async () => {
    await startSpeechDispatchRuntime(createConfig());
    fake.streamCue('inbound', ['line for the broken speaker']);
    fake.commitActiveCue();
    fake.degradeNextSpeechDispatch('扬声器设备缺失：无法打开输出流');

    const pushed: AudioRuntimeSnapshot[] = [];
    await fake.listen<AudioRuntimeSnapshot>('audio://snapshot', (event) => pushed.push(event.payload));
    fake.dispatchSpeechCue();
    await fake.settle();

    const degraded = pushed.at(-1);
    expect(degraded?.speech.status).toBe('degraded');
    expect(degraded?.speech.lastError).toContain('扬声器设备缺失');
    expect(degraded?.speech.dispatchState).toBe('error');
    expect(degraded?.speech.recentEvents[0]?.kind).toBe('speech.error');
    // The failure is asynchronous: it never appeared in a command return.
    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(1);
  });
});
