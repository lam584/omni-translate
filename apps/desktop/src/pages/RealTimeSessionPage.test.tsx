import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import RealTimeSessionPage from './RealTimeSessionPage';
import { useAppStore } from '../stores/app-store';

const startAudioRouteRuntimeMock = vi.fn();
const startSpeechDispatchRuntimeMock = vi.fn();
const startTranslateWorkerRuntimeMock = vi.fn();
const stopAudioRouteRuntimeMock = vi.fn();
const stopSpeechDispatchRuntimeMock = vi.fn();
const stopTranslateWorkerRuntimeMock = vi.fn();
const clearSubtitleCuesRuntimeMock = vi.fn();
const showSubtitleOverlayWindowMock = vi.fn();
const toggleSubtitleOverlayWindowMock = vi.fn();
const installDriverRuntimeMock = vi.fn();
const repairDriverRuntimeMock = vi.fn();
const startBridgeServiceRuntimeMock = vi.fn();

vi.mock('../components/page/DiagnosticsQuickLink', () => ({
  default: () => <div data-testid="diagnostics-quick-link" />,
}));

vi.mock('../runtime/audio-runtime', () => ({
  startAudioRouteRuntime: (...args: unknown[]) => startAudioRouteRuntimeMock(...args),
  startSpeechDispatchRuntime: (...args: unknown[]) => startSpeechDispatchRuntimeMock(...args),
  startTranslateWorkerRuntime: (...args: unknown[]) => startTranslateWorkerRuntimeMock(...args),
  stopAudioRouteRuntime: (...args: unknown[]) => stopAudioRouteRuntimeMock(...args),
  stopSpeechDispatchRuntime: (...args: unknown[]) => stopSpeechDispatchRuntimeMock(...args),
  stopTranslateWorkerRuntime: (...args: unknown[]) => stopTranslateWorkerRuntimeMock(...args),
  clearSubtitleCuesRuntime: (...args: unknown[]) => clearSubtitleCuesRuntimeMock(...args),
  showSubtitleOverlayWindow: (...args: unknown[]) => showSubtitleOverlayWindowMock(...args),
  toggleSubtitleOverlayWindow: (...args: unknown[]) => toggleSubtitleOverlayWindowMock(...args),
}));

vi.mock('../runtime/bridge-runtime', () => ({
  installDriverRuntime: (...args: unknown[]) => installDriverRuntimeMock(...args),
  repairDriverRuntime: (...args: unknown[]) => repairDriverRuntimeMock(...args),
  startBridgeServiceRuntime: (...args: unknown[]) => startBridgeServiceRuntimeMock(...args),
}));

describe('RealTimeSessionPage one-click launch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    startAudioRouteRuntimeMock.mockReset();
    startSpeechDispatchRuntimeMock.mockReset();
    startTranslateWorkerRuntimeMock.mockReset();
    stopAudioRouteRuntimeMock.mockReset();
    stopSpeechDispatchRuntimeMock.mockReset();
    stopTranslateWorkerRuntimeMock.mockReset();
    clearSubtitleCuesRuntimeMock.mockReset();
    showSubtitleOverlayWindowMock.mockReset();
    toggleSubtitleOverlayWindowMock.mockReset();
    installDriverRuntimeMock.mockReset();
    repairDriverRuntimeMock.mockReset();
    startBridgeServiceRuntimeMock.mockReset();

    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioRuntimeSnapshot = structuredClone(audioRuntimeSnapshotMock);

    configDraft.providers[0].status = 'draft';
    configDraft.speech.enabled = false;
    configDraft.devices.subtitleTranslationMode = 'secondary';
    configDraft.devices.subtitleTranslationModelId = 'template-dashscope-realtime::qwen3.6-flash-2026-04-16';
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    runtimeSnapshot.bridge.driverHealth = 'not-installed';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    runtimeSnapshot.windows = runtimeSnapshot.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: false } : item,
    );
    audioRuntimeSnapshot.inbound.streamBound = false;
    audioRuntimeSnapshot.outbound.streamBound = false;
    audioRuntimeSnapshot.speech.dispatchState = 'idle';

    const bridgeReadySnapshot = structuredClone(runtimeSnapshot);
    bridgeReadySnapshot.bridge.driverHealth = 'running';
    bridgeReadySnapshot.bridge.bridgeState = 'running';
    bridgeReadySnapshot.bridge.installPhase = 'ready';
    installDriverRuntimeMock.mockResolvedValue(bridgeReadySnapshot);

    const inboundReadySnapshot = structuredClone(audioRuntimeSnapshot);
    inboundReadySnapshot.inbound.streamBound = true;
    startAudioRouteRuntimeMock.mockImplementation(async (direction: 'inbound' | 'outbound') => {
      if (direction === 'inbound') {
        return inboundReadySnapshot;
      }

      const outboundReadySnapshot = structuredClone(inboundReadySnapshot);
      outboundReadySnapshot.outbound.streamBound = true;
      return outboundReadySnapshot;
    });

    const speechReadySnapshot = structuredClone(audioRuntimeSnapshot);
    speechReadySnapshot.inbound.streamBound = true;
    speechReadySnapshot.outbound.streamBound = true;
    speechReadySnapshot.speech.dispatchState = 'playing';
    speechReadySnapshot.speech.outputTarget = 'both';
    startSpeechDispatchRuntimeMock.mockResolvedValue(speechReadySnapshot);
    startTranslateWorkerRuntimeMock.mockResolvedValue(speechReadySnapshot);
    stopAudioRouteRuntimeMock.mockResolvedValue(audioRuntimeSnapshot);
    stopSpeechDispatchRuntimeMock.mockResolvedValue(audioRuntimeSnapshot);
    stopTranslateWorkerRuntimeMock.mockResolvedValue(audioRuntimeSnapshot);
    clearSubtitleCuesRuntimeMock.mockResolvedValue(audioRuntimeSnapshot);

    const overlayVisibleSnapshot = structuredClone(bridgeReadySnapshot);
    overlayVisibleSnapshot.windows = overlayVisibleSnapshot.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
    );
    showSubtitleOverlayWindowMock.mockResolvedValue(overlayVisibleSnapshot);
    toggleSubtitleOverlayWindowMock.mockResolvedValue(overlayVisibleSnapshot);

    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('keeps the session page focused on launch controls', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain('game');
    expect(container.textContent).not.toContain('voice-room');
    expect(container.textContent).not.toContain('bridge-pending');
    expect(container.textContent).not.toContain('capture-pending');

  });

  it('shows an empty model trace summary before calls start', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('shows recent model trace counts and errors', async () => {
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.diagnostics.modelTraceSummary = {
      activeTraceId: 'trace-1',
      totalCalls: 2,
      succeededCalls: 1,
      failedCalls: 1,
      lastError: 'model rejected request',
      lastCallAt: 'unix:2',
      recentCalls: [
        {
          traceId: 'trace-1',
          callId: 'call-2',
          name: 'provider.translate_text',
          status: 'failed',
          providerId: 'provider',
          model: 'qwen3.5-omni-plus-realtime',
          routeMode: 'watch',
          cueId: 'cue-2',
          startedAt: 'unix:1',
          completedAt: 'unix:2',
          elapsedMs: 123,
          lastError: 'model rejected request',
        },
      ],
    };
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('1 / 1');
    expect(container.textContent).toContain('qwen3.5-omni-plus-realtime');
    expect(container.textContent).toContain('cue-2');
    expect(container.textContent).toContain('model rejected request');
    expect(container.textContent).not.toContain('diagnostics/logs/app.log');
    expect(container.textContent).not.toContain('diagnostics/logs/app.log');
  });

  it('shows empty first translation latency metrics while a session has no samples', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audioRuntimeSnapshot.inbound.streamBound = true;
    audioRuntimeSnapshot.subtitleOverlay.firstTranslationAverageMs = null;
    audioRuntimeSnapshot.subtitleOverlay.firstTranslationLastMs = null;
    audioRuntimeSnapshot.subtitleOverlay.firstTranslationSampleCount = 0;
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot,
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('--');
    expect(container.textContent).toContain('--');
    expect(container.textContent).toContain('0');
    expect(container.textContent).toContain('0');
  });

  it('restores elapsed session time after the page remounts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1779974798817);

    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audioRuntimeSnapshot.inbound.streamBound = true;
    audioRuntimeSnapshot.sessionStartedAt = '1779974788817';
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot,
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('00:10');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('00:10');
    vi.useRealTimers();
  });

  it('shows first translation average and latest latency metrics', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audioRuntimeSnapshot.inbound.streamBound = true;
    audioRuntimeSnapshot.subtitleOverlay.firstTranslationAverageMs = 1234;
    audioRuntimeSnapshot.subtitleOverlay.firstTranslationLastMs = 987;
    audioRuntimeSnapshot.subtitleOverlay.firstTranslationSampleCount = 2;
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot,
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('1234 ms');
    expect(container.textContent).toContain('1234 ms');
    expect(container.textContent).toContain('123');
    expect(container.textContent).toContain('987 ms');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('2');
  });

  it('prefers displaySourceText in current subtitle and queue views', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    const cue = audioRuntimeSnapshot.subtitleOverlay.recentCues[0];
    cue.sourceText = 'Raw queue source that should stay hidden';
    cue.displaySourceText = 'Short source line one\nShort source line two';
    cue.translatedText = 'Translated line one';
    audioRuntimeSnapshot.subtitleOverlay.activeCue = cue;

    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot,
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('Short source line one');
    expect(container.textContent).toContain('Short source line two');
    expect(container.textContent).toContain('Short source line one');
    expect(container.textContent).not.toContain('Raw queue source that should stay hidden');
  });

  it('starts bridge, bidirectional capture, speech and overlay when launching conversation mode', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    const launchButton = container.querySelectorAll('button')[1] as HTMLButtonElement | undefined;
    expect(launchButton).toBeDefined();
    expect(launchButton?.disabled).toBe(false);

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(installDriverRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startBridgeServiceRuntimeMock).not.toHaveBeenCalled();
    expect(startAudioRouteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(startAudioRouteRuntimeMock).toHaveBeenNthCalledWith(1, 'inbound', expect.objectContaining({ devices: expect.objectContaining({ routeMode: 'game' }) }));
    expect(startAudioRouteRuntimeMock).toHaveBeenNthCalledWith(2, 'outbound', expect.objectContaining({ devices: expect.objectContaining({ routeMode: 'game' }) }));
    expect(startSpeechDispatchRuntimeMock).toHaveBeenCalledTimes(1);
    expect(showSubtitleOverlayWindowMock).toHaveBeenCalledTimes(1);

    expect(useAppStore.getState().configDraft.devices.routeMode).toBe('game');
    expect(useAppStore.getState().configDraft.speech.enabled).toBe(true);
    expect(useAppStore.getState().configDraft.speech.outputTarget).toBe('both');
    expect(useAppStore.getState().audioRuntimeSnapshot.speech.dispatchState).toBe('playing');
  });

  it('launches watch mode without forcing bridge or speech startup', async () => {
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            outputSpeechEnabled: false,
            virtualMicOutputEnabled: false,
            feedbackLoopPrevention: 'none',
          },
          speech: {
            ...state.configDraft.speech,
            enabled: false,
            outputTarget: 'speaker',
            virtualMicOutputEnabled: false,
          },
        },
      }));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeDefined();
    expect(launchButton?.disabled).toBe(false);

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(installDriverRuntimeMock).not.toHaveBeenCalled();
    expect(repairDriverRuntimeMock).not.toHaveBeenCalled();
    expect(startBridgeServiceRuntimeMock).not.toHaveBeenCalled();
    expect(startAudioRouteRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startAudioRouteRuntimeMock).toHaveBeenCalledWith(
      'inbound',
      expect.objectContaining({
        devices: expect.objectContaining({
          routeMode: 'watch',
          subtitleTranslationMode: 'secondary',
          subtitleTranslationModelId: 'template-dashscope-realtime::qwen3.6-flash-2026-04-16',
        }),
      }),
    );
    expect(startSpeechDispatchRuntimeMock).not.toHaveBeenCalled();
    expect(showSubtitleOverlayWindowMock).toHaveBeenCalledTimes(1);

    expect(useAppStore.getState().configDraft.devices.routeMode).toBe('watch');
    expect(useAppStore.getState().configDraft.speech.enabled).toBe(false);
  });

  it('starts speech dispatch for Omni watch mode when device translated speech output is enabled', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            outputSpeechEnabled: true,
          },
          speech: {
            ...state.configDraft.speech,
            enabled: false,
            localPlaybackEnabled: true,
          },
        },
      }));
    });

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeDefined();

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(startAudioRouteRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startSpeechDispatchRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startSpeechDispatchRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devices: expect.objectContaining({
          routeMode: 'watch',
          outputSpeechEnabled: true,
          subtitleTranslationMode: 'secondary',
        }),
        speech: expect.objectContaining({
          enabled: true,
          localPlaybackEnabled: true,
        }),
      }),
    );
  });

  it('starts speech dispatch for Omni watch mode when secondary translation speech is enabled', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          speech: {
            ...state.configDraft.speech,
            enabled: true,
            localPlaybackEnabled: true,
          },
        },
      }));
    });

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeDefined();

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(startAudioRouteRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startSpeechDispatchRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startSpeechDispatchRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devices: expect.objectContaining({
          routeMode: 'watch',
          subtitleTranslationMode: 'secondary',
        }),
        speech: expect.objectContaining({
          enabled: true,
          localPlaybackEnabled: true,
        }),
      }),
    );
  });

  it('starts bridge in watch mode when feedbackLoopPrevention is virtual-driver', async () => {
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            outputSpeechEnabled: false,
            virtualMicOutputEnabled: false,
            feedbackLoopPrevention: 'virtual-driver',
          },
          speech: {
            ...state.configDraft.speech,
            outputTarget: 'speaker',
            virtualMicOutputEnabled: false,
          },
        },
      }));
    });

    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.driverHealth = 'not-installed';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    const bridgeReady = structuredClone(runtimeSnapshot);
    bridgeReady.bridge.driverHealth = 'running';
    bridgeReady.bridge.bridgeState = 'running';
    bridgeReady.bridge.installPhase = 'ready';
    installDriverRuntimeMock.mockResolvedValue(bridgeReady);

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeDefined();

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(installDriverRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startBridgeServiceRuntimeMock).not.toHaveBeenCalled();
    expect(startAudioRouteRuntimeMock).toHaveBeenCalledWith(
      'inbound',
      expect.objectContaining({
        speech: expect.objectContaining({
          localPlaybackEnabled: true,
        }),
      }),
    );
  });

  it('falls back to subtitles-only when virtual-driver startup fails and the user accepts the downgrade', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
    installDriverRuntimeMock.mockRejectedValue(new Error('SYSVAD package missing'));
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            feedbackLoopPrevention: 'virtual-driver',
          },
        },
      }));
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement | null)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(startAudioRouteRuntimeMock).toHaveBeenCalledWith(
      'inbound',
      expect.objectContaining({
        devices: expect.objectContaining({
          feedbackLoopPrevention: 'none',
          outputSpeechEnabled: false,
          virtualMicOutputEnabled: false,
        }),
        speech: expect.objectContaining({
          enabled: false,
          outputTarget: 'speaker',
        }),
      }),
    );
    confirmMock.mockRestore();
  });

  it('falls back to temporary AEC speaker playback when the user rejects subtitles-only mode', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(false);
    installDriverRuntimeMock.mockRejectedValue(new Error('SYSVAD package missing'));
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            feedbackLoopPrevention: 'virtual-driver',
          },
        },
      }));
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement | null)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(startAudioRouteRuntimeMock).toHaveBeenCalledWith(
      'inbound',
      expect.objectContaining({
        devices: expect.objectContaining({
          feedbackLoopPrevention: 'echo-cancel',
          outputSpeechEnabled: true,
          virtualMicOutputEnabled: false,
          aecEnabled: true,
        }),
        speech: expect.objectContaining({
          enabled: true,
          outputTarget: 'speaker',
          localPlaybackEnabled: true,
        }),
      }),
    );
    confirmMock.mockRestore();
  });

  it('starts bridge in watch mode when virtualMicOutputEnabled is true', async () => {
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            outputSpeechEnabled: false,
            virtualMicOutputEnabled: true,
            feedbackLoopPrevention: 'none',
          },
        },
      }));
    });

    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.driverHealth = 'not-installed';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    const bridgeReady = structuredClone(runtimeSnapshot);
    bridgeReady.bridge.driverHealth = 'running';
    bridgeReady.bridge.bridgeState = 'running';
    bridgeReady.bridge.installPhase = 'ready';
    installDriverRuntimeMock.mockResolvedValue(bridgeReady);

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeDefined();

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(installDriverRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startBridgeServiceRuntimeMock).not.toHaveBeenCalled();
  });

  it('starts bridge in watch mode when speech outputTarget is virtual-mic', async () => {
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            outputSpeechEnabled: false,
            virtualMicOutputEnabled: false,
            feedbackLoopPrevention: 'none',
          },
          speech: {
            ...state.configDraft.speech,
            outputTarget: 'virtual-mic',
          },
        },
      }));
    });

    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.driverHealth = 'not-installed';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    const bridgeReady = structuredClone(runtimeSnapshot);
    bridgeReady.bridge.driverHealth = 'running';
    bridgeReady.bridge.bridgeState = 'running';
    bridgeReady.bridge.installPhase = 'ready';
    installDriverRuntimeMock.mockResolvedValue(bridgeReady);

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeDefined();

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(installDriverRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startBridgeServiceRuntimeMock).not.toHaveBeenCalled();
  });

  it('toggles overlay, clears cues and stops every active runtime path', async () => {
    const activeAudioSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    activeAudioSnapshot.inbound.streamBound = true;
    activeAudioSnapshot.outbound.streamBound = true;
    activeAudioSnapshot.speech.dispatchState = 'playing';
    const stoppedAudioSnapshot = structuredClone(activeAudioSnapshot);
    stoppedAudioSnapshot.inbound.streamBound = false;
    stoppedAudioSnapshot.outbound.streamBound = false;
    stoppedAudioSnapshot.speech.dispatchState = 'idle';
    stopAudioRouteRuntimeMock.mockResolvedValue(stoppedAudioSnapshot);
    stopSpeechDispatchRuntimeMock.mockResolvedValue(stoppedAudioSnapshot);
    stopTranslateWorkerRuntimeMock.mockResolvedValue(stoppedAudioSnapshot);
    clearSubtitleCuesRuntimeMock.mockResolvedValue(activeAudioSnapshot);
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: activeAudioSnapshot }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    const toolbarButtons = container.querySelectorAll<HTMLButtonElement>('.control-toolbar button');
    await act(async () => {
      toolbarButtons[1].click();
      await Promise.resolve();
    });
    expect(toggleSubtitleOverlayWindowMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      toolbarButtons[2].click();
      await Promise.resolve();
    });
    expect(clearSubtitleCuesRuntimeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      toolbarButtons[0].click();
      await Promise.resolve();
    });
    expect(stopSpeechDispatchRuntimeMock).toHaveBeenCalledTimes(1);
    expect(stopTranslateWorkerRuntimeMock).toHaveBeenCalledTimes(1);
    expect(stopAudioRouteRuntimeMock).toHaveBeenCalledWith('outbound');
    expect(stopAudioRouteRuntimeMock).toHaveBeenCalledWith('inbound');
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(false);
    expect(useAppStore.getState().audioRuntimeSnapshot.outbound.streamBound).toBe(false);
  });

  it('starts bridge in watch mode when speech outputTarget is both', async () => {
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          devices: {
            ...state.configDraft.devices,
            outputSpeechEnabled: false,
            virtualMicOutputEnabled: false,
            feedbackLoopPrevention: 'none',
          },
          speech: {
            ...state.configDraft.speech,
            outputTarget: 'both',
          },
        },
      }));
    });

    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.driverHealth = 'not-installed';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    const bridgeReady = structuredClone(runtimeSnapshot);
    bridgeReady.bridge.driverHealth = 'running';
    bridgeReady.bridge.bridgeState = 'running';
    bridgeReady.bridge.installPhase = 'ready';
    installDriverRuntimeMock.mockResolvedValue(bridgeReady);

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeDefined();

    await act(async () => {
      launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(installDriverRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startBridgeServiceRuntimeMock).not.toHaveBeenCalled();
  });

  it('renders queue warnings, source fallback and every translated cue state', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    const cue = audioRuntimeSnapshot.subtitleOverlay.recentCues[0];
    const activeCue = { ...cue, cueId: 'cue-active', displaySourceText: '', sourceText: 'fallback source', translatedText: '', committed: false };
    audioRuntimeSnapshot.subtitleOverlay.activeCue = activeCue;
    audioRuntimeSnapshot.subtitleOverlay.queueDepth = 2;
    audioRuntimeSnapshot.subtitleOverlay.droppedCueCount = 3;
    audioRuntimeSnapshot.subtitleOverlay.recentCues = [
      activeCue,
      { ...cue, cueId: 'cue-failure', translatedText: '[翻译失败] timeout', committed: true },
      { ...cue, cueId: 'cue-translated', translatedText: 'translated text', committed: true },
      { ...cue, cueId: 'cue-empty', translatedText: '', committed: true },
    ];
    const runtimeSnapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtimeSnapshot.diagnostics.modelTraceSummary.recentCalls = [
      {
        traceId: 'trace-empty',
        callId: 'call-empty',
        name: 'provider.translate_text',
        status: 'failed',
        providerId: 'provider',
        model: '',
        routeMode: 'watch',
        cueId: null,
        startedAt: 'unix:1',
        completedAt: 'unix:2',
        elapsedMs: null,
        lastError: null,
      },
    ];
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot, runtimeSnapshot }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('fallback source');
    expect(container.textContent).toContain('丢弃 3 条');
    expect(container.textContent).toContain('[翻译失败] timeout');
    expect(container.textContent).toContain('translated text');
    expect(container.textContent).toContain('正在调用 LLM 翻译...');
  });

  it('starts the translation worker for a non-omni watch model', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          inboundVoiceModelId: 'provider::plain-model',
          outputSpeechEnabled: false,
          virtualMicOutputEnabled: false,
          feedbackLoopPrevention: 'none',
        },
        speech: { ...state.configDraft.speech, enabled: false, outputTarget: 'speaker' },
      },
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });

    expect(startTranslateWorkerRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it('repairs a damaged driver and starts the stopped bridge before conversation capture', async () => {
    const runtimeSnapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtimeSnapshot.bridge.driverHealth = 'damaged';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    runtimeSnapshot.bridge.recommendedAction = 'rollback-driver';
    const repaired = structuredClone(runtimeSnapshot);
    repaired.bridge.driverHealth = 'running';
    const started = structuredClone(repaired);
    started.bridge.bridgeState = 'running';
    repairDriverRuntimeMock.mockResolvedValue(repaired);
    startBridgeServiceRuntimeMock.mockResolvedValue(started);
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('button')[1]?.click();
    });

    expect(repairDriverRuntimeMock).toHaveBeenCalledWith('rollback-driver', expect.any(Object));
    expect(startBridgeServiceRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it('reports non-error conversation launch failures', async () => {
    const runtimeSnapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtimeSnapshot.bridge.driverHealth = 'running';
    runtimeSnapshot.bridge.bridgeState = 'running';
    startAudioRouteRuntimeMock.mockRejectedValue('capture unavailable');
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('button')[1]?.click();
    });

    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('capture unavailable');
  });
});
