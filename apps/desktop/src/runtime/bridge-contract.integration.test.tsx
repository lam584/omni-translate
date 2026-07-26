import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { createFakeBridge, type FakeBridge } from '../mocks/fake-bridge';
import SubtitleOverlayPage from '../pages/SubtitleOverlayPage';
import type { AppConfigDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import {
  getAudioRuntimeSnapshotRuntime,
  startAudioRouteRuntime,
  startSpeechDispatchRuntime,
  stopSpeechDispatchRuntime,
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

  // Manual E2E row "Subtitle display": start inbound capture and confirm
  // recent subtitle cues appear in the overlay.
  it('surfaces fake-provider subtitle cues in the overlay after starting inbound capture', async () => {
    const config = createConfig();

    const snapshot = await startAudioRouteRuntime('inbound', config);

    expect(fake.commandCalls('start_audio_route')).toHaveLength(1);
    expect(snapshot.inbound.captureState).toBe('capturing');
    expect(snapshot.inbound.streamBound).toBe(true);
    const cue = snapshot.subtitleOverlay.recentCues[0];
    expect(cue.routeDirection).toBe('inbound');
    expect(cue.translatedText).toBe('译文：fake inbound speech');

    // The runtime snapshot event listener path lands the snapshot in the store.
    useAppStore.getState().setAudioRuntimeSnapshot(snapshot);
    await renderOverlay();

    expect(container.textContent).toContain('译文：fake inbound speech');
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

  // Manual E2E row "TTS outbound": trigger speech dispatch and confirm the
  // speaker / virtual-mic counters advance.
  it('advances speaker and virtual-mic counters when speech dispatch runs against the fake bridge', async () => {
    const config = createConfig();
    config.speech.outputTarget = 'both';

    const baseline = await getAudioRuntimeSnapshotRuntime();
    expect(baseline.speech.speakerFramesWritten).toBe(0);
    expect(baseline.speech.virtualMicFramesWritten).toBe(0);

    const dispatched = await startSpeechDispatchRuntime(config);
    expect(dispatched.speech.dispatchState).toBe('playing');
    expect(dispatched.speech.outputTarget).toBe('both');
    expect(dispatched.speech.speakerFramesWritten).toBeGreaterThan(baseline.speech.speakerFramesWritten);
    expect(dispatched.speech.virtualMicFramesWritten).toBeGreaterThan(baseline.speech.virtualMicFramesWritten);
    expect(dispatched.speech.recentEvents[0]?.kind).toBe('speech.tts-requested');

    const stopped = await stopSpeechDispatchRuntime();
    expect(stopped.speech.dispatchState).toBe('idle');
    expect(stopped.speech.speakerFramesWritten).toBe(dispatched.speech.speakerFramesWritten);

    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(1);
    expect(fake.sessionActionCalls('stopSpeech')).toHaveLength(1);
  });
});
