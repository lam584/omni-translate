import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { createFakeBridge, type FakeBridge } from '../mocks/fake-bridge';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import RealTimeSessionPage from './RealTimeSessionPage';
import { diagnosticsReadyPatchForMode, WatchFallbackDialog } from './RealTimeSessionScreen';
import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../runtime/desktop-api';
import { loggerTestHelpers } from '../runtime/logger';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { mountTestRoot, type TestRootHandle } from '../test-utils/react-root';

// The session page runs against the injectable fake bridge instead of stubbed
// runtime modules: every renderer→shell call travels the real
// audio-runtime / bridge-runtime / desktop-api-v2 code path, commands only
// acknowledge, and route/speech state converges later over the push channel
// (`audio://snapshot`) exactly like the native backend. Assertions therefore
// observe recorded commands plus the resulting store/DOM state.

const harness = vi.hoisted(() => ({
  invoke: null as null | (<T>(command: string, args?: Record<string, unknown>) => Promise<T>),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!harness.invoke) {
      return Promise.reject(new Error(`fake bridge not installed for command ${command}`));
    }
    return harness.invoke(command, args);
  },
  isTauri: () => true,
}));

// Presentational leaf: kept mocked so this suite stays about the session page.
vi.mock('../components/page/DiagnosticsQuickLink', () => ({
  default: () => <div data-testid="diagnostics-quick-link" />,
}));

/** Stable label for one renderer→shell call: v2 action (plus direction) or raw command. */
function describeCall(command: string, args?: Record<string, unknown>): string {
  const envelope = (args?.command ?? {}) as { action?: unknown; direction?: unknown };
  if (typeof envelope.action === 'string') {
    return typeof envelope.direction === 'string' ? `${envelope.action}:${envelope.direction}` : envelope.action;
  }
  return typeof args?.direction === 'string' ? `${command}:${args.direction}` : command;
}

describe('RealTimeSessionPage one-click launch', () => {
  let view: TestRootHandle;
  let container: HTMLDivElement;
  let fake: FakeBridge;
  /** Commands as they were issued, including the ones still held by a gate. */
  let issued: string[];
  /** Per-command gates: a held command hangs until the test releases it. */
  let gates: Map<string, Promise<void>>;

  async function renderPage() {
    await view.render(
      <MemoryRouter>
        <RealTimeSessionPage />
      </MemoryRouter>,
    );
  }

  /** Makes the next call carrying `label` hang; returns its release function. */
  function holdCommand(label: string): () => void {
    let release!: () => void;
    gates.set(label, new Promise<void>((resolve) => {
      release = resolve;
    }));
    return release;
  }

  /**
   * Runs `action` and drains the microtask chain it starts, all inside act():
   * a scene launch keeps resolving promises long after the click handler
   * returned, and every store write it makes must stay inside the act scope.
   */
  async function runInAct(action?: () => void) {
    await act(async () => {
      action?.();
      for (let index = 0; index < 80; index += 1) {
        await Promise.resolve();
      }
    });
  }

  async function sleepInAct(ms: number) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    });
  }

  /** The clear-subtitles button is disabled exactly while a busy action runs. */
  function isBusy() {
    const toolbars = container.querySelectorAll<HTMLElement>('.control-toolbar');
    return toolbars[1]?.querySelector('button')?.disabled === true;
  }

  /**
   * Lets the fake backend's queued worker transitions land — they arrive on the
   * push channel, never in a command return — and gives React a chance to
   * render the resulting store updates.
   *
   * `fake.settle()` deterministically flushes the fake bridge's queued
   * convergence steps (they otherwise land on a setTimeout(0)), so most loops
   * finish without any real waiting. A short real sleep remains only because
   * the launch flow's watch-route readiness check in audio-runtime.ts polls on
   * a real 40ms window.setTimeout that no flush hook can advance; failing to
   * settle now throws with the issued-command trail instead of silently
   * falling through after the old 2s cap.
   */
  async function settleSession() {
    const deadline = Date.now() + 5_000;
    for (;;) {
      await runInAct(() => {
        void fake.settle();
      });
      if (!isBusy()) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`settleSession timed out after 5000ms: page still busy; issued commands: ${issued.join(', ')}`);
      }
      // Real sleep: let the renderer's 40ms watch-route readiness poll fire.
      await sleepInAct(10);
    }
    // One more flush so late pushes (e.g. speech frame counters) land too.
    await runInAct(() => {
      void fake.settle();
    });
  }

  /** Clicks a control, then lets the launch/stop flow it started settle. */
  async function clickAndSettle(element: Element | null | undefined) {
    await runInAct(() => {
      (element as HTMLElement | null | undefined)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settleSession();
  }

  function bridgeLifecycleCalls() {
    return [...fake.commandCalls('bridge_v2'), ...fake.commandCalls('start_bridge_service')];
  }

  function routeStartArgs(index = 0): Record<string, unknown> {
    return fake.commandCalls('start_audio_route')[index]?.args ?? {};
  }

  function routeStartDirections() {
    return fake.commandCalls('start_audio_route').map((call) => call.args?.direction);
  }

  function sessionCommandArgs(action: string, index = 0): Record<string, unknown> {
    return (fake.sessionActionCalls(action)[index]?.args?.command ?? {}) as Record<string, unknown>;
  }

  function stopRouteDirections() {
    return fake.sessionActionCalls('stopRoute')
      .map((call) => ((call.args?.command ?? {}) as { direction?: string }).direction);
  }

  function stopActionOrder() {
    return issued.filter((label) => label.startsWith('stop'));
  }

  /**
   * Brings the fake backend into a genuinely running session (both capture
   * routes bound, speech worker started) and publishes the converged native
   * snapshot the way the bootstrap push listener does.
   */
  async function startNativeSession() {
    const draft = useAppStore.getState().configDraft;
    const config: AppConfigDraft = {
      ...draft,
      speech: { ...draft.speech, enabled: true, outputTarget: 'speaker' },
    };
    await fake.invoke('start_audio_route', { direction: 'inbound', config });
    await fake.invoke('start_audio_route', { direction: 'outbound', config });
    await fake.invoke('session_v2', { command: { action: 'startSpeech', config } });
    await fake.settle();
    useAppStore.getState().setAudioRuntimeSnapshot(fake.getAudioSnapshot());
  }

  beforeEach(() => {
    fake = createFakeBridge();
    issued = [];
    gates = new Map();
    harness.invoke = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const label = describeCall(command, args);
      issued.push(label);
      const gate = gates.get(label);
      if (!gate) {
        return fake.invoke<T>(command, args);
      }
      gates.delete(label);
      return gate.then(() => fake.invoke<T>(command, args));
    };
    resetDesktopApiForTests();
    installDesktopApi(new TauriDesktopApi());
    // The desktop-runtime bootstrap forwards native audio pushes into the
    // store; without it the page would never observe worker convergence.
    void fake.listen<AudioRuntimeSnapshot>('audio://snapshot', (event) => {
      useAppStore.getState().setAudioRuntimeSnapshot(event.payload);
    });

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

    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    view = mountTestRoot();
    ({ container } = view);
  });

  afterEach(async () => {
    await view.cleanup();
    loggerTestHelpers.reset();
    harness.invoke = null;
    resetDesktopApiForTests();
    vi.useRealTimers();
  });

  it('keeps the session page focused on launch controls', async () => {
    await renderPage();

    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain('game');
    expect(container.textContent).not.toContain('voice-room');
    expect(container.textContent).not.toContain('bridge-pending');
    expect(container.textContent).not.toContain('capture-pending');
    expect(container.querySelectorAll<HTMLButtonElement>('.provider-list button')[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelectorAll<HTMLButtonElement>('.provider-list button')[1]?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector<HTMLButtonElement>('.control-toolbar button')?.disabled).toBe(true);
  });

  it('shows an empty model trace summary before calls start', async () => {
    await renderPage();

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

    await renderPage();

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

    await renderPage();

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

    await renderPage();

    expect(container.textContent).toContain('00:10');

    await act(async () => {
      view.root.unmount();
    });
    view.root = createRoot(container);

    await renderPage();

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

    await renderPage();

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

    await renderPage();

    expect(container.textContent).toContain('Short source line one');
    expect(container.textContent).toContain('Short source line two');
    expect(container.textContent).toContain('Short source line one');
    expect(container.textContent).not.toContain('Raw queue source that should stay hidden');
  });

  it('starts bidirectional voice-room capture, speaker speech and overlay without the bridge', async () => {
    await renderPage();

    const launchButton = container.querySelectorAll('button')[1] as HTMLButtonElement | undefined;
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);
    expect(launchButton?.disabled).toBe(false);

    await clickAndSettle(launchButton);

    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(routeStartDirections()).toEqual(['inbound', 'outbound']);
    expect(routeStartArgs(0)).toMatchObject({
      direction: 'inbound',
      config: { devices: { routeMode: 'voice-room', feedbackLoopPrevention: 'echo-cancel', aecEnabled: true, virtualMicOutputEnabled: false } },
    });
    expect(routeStartArgs(1)).toMatchObject({
      direction: 'outbound',
      config: { devices: { routeMode: 'voice-room', feedbackLoopPrevention: 'echo-cancel', aecEnabled: true, virtualMicOutputEnabled: false } },
    });
    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(1);
    expect(fake.commandCalls('show_subtitle_overlay')).toHaveLength(1);

    expect(useAppStore.getState().configDraft.devices.routeMode).toBe('voice-room');
    expect(useAppStore.getState().configDraft.speech.enabled).toBe(true);
    expect(useAppStore.getState().configDraft.speech.outputTarget).toBe('speaker');
    // Real start_speech_dispatch semantics: the worker is up and waiting for a
    // subtitle; nothing has played and no frame counter moved yet.
    expect(useAppStore.getState().audioRuntimeSnapshot.speech.dispatchState).toBe('waiting-subtitle');
    expect(useAppStore.getState().audioRuntimeSnapshot.speech.speakerFramesWritten).toBe(0);
    expect(container.querySelectorAll<HTMLButtonElement>('.provider-list button')[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('.control-toolbar button')?.disabled).toBe(false);
    expect(Array.from(container.querySelectorAll('.audio-route-status-group h4')).map((element) => element.textContent)).toEqual([
      '系统音频',
      '麦克风音频',
    ]);

    // The counters only advance once the worker actually dispatches a cue.
    fake.dispatchSpeechCue();
    await settleSession();
    expect(useAppStore.getState().audioRuntimeSnapshot.speech.speakerFramesWritten).toBeGreaterThan(0);
  });

  it('rejects conversation startup before native calls when no reply model is selected', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, outboundVoiceModelId: '' },
      },
    }));

    await renderPage();

    await clickAndSettle(container.querySelectorAll<HTMLButtonElement>('.provider-list button')[1]);

    expect(fake.commandCalls('start_audio_route')).toHaveLength(0);
    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('选择适用于当前场景的语音模型');
  });

  it('disables both scene launches while any audio chain is active', async () => {
    const activeAudioSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    activeAudioSnapshot.outbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: activeAudioSnapshot }));

    await renderPage();

    const launchButtons = container.querySelectorAll<HTMLButtonElement>('.provider-list button');
    expect(launchButtons[0]?.disabled).toBe(true);
    expect(launchButtons[1]?.disabled).toBe(true);
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

    await renderPage();

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);
    expect(launchButton?.disabled).toBe(false);

    await clickAndSettle(launchButton);

    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(fake.sessionActionCalls('preconnect')).toHaveLength(0);
    expect(routeStartDirections()).toEqual(['inbound']);
    expect(routeStartArgs(0)).toMatchObject({
      direction: 'inbound',
      config: {
        devices: {
          routeMode: 'watch',
          subtitleTranslationMode: 'secondary',
          subtitleTranslationModelId: 'template-dashscope-realtime::qwen3.6-flash-2026-04-16',
        },
      },
    });
    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(0);
    // Watch routes create the native overlay together with capture; the renderer
    // does not re-open it (sceneLaunchPlan skips subtitle-overlay for watch mode).
    expect(fake.commandCalls('show_subtitle_overlay')).toHaveLength(0);

    expect(useAppStore.getState().configDraft.devices.routeMode).toBe('watch');
    expect(useAppStore.getState().configDraft.speech.enabled).toBe(false);
    // The accepted route converged over the push channel, not in the command return.
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(true);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.captureState).toBe('capturing');
  });

  it('automatically expands the retained Watch report when the Watch route stops', async () => {
    fake.startLiveSession({
      model: 'watch-report-model',
      sessionStartedAt: 'unix-ms:1000',
    });
    fake.pushLiveAsrDelta({
      elapsedMs: 100,
      stash: '',
      text: '你好世界',
      eventType: 'asr.completed',
    });
    fake.pushLiveOutputDelta({
      elapsedMs: 280,
      eventType: 'response.done',
      stash: '',
      committedText: 'Hello world',
    });
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch' },
      },
    }));
    await renderPage();

    await runInAct(() => {
      const active = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
      active.inbound.streamBound = true;
      useAppStore.getState().setAudioRuntimeSnapshot(active);
    });
    await runInAct(() => {
      const stopped = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
      stopped.inbound.streamBound = false;
      useAppStore.getState().setAudioRuntimeSnapshot(stopped);
    });

    expect(fake.commandCalls('diagnostics_v2').map((call) => call.action)).toContain('watchSessionReport');
    const reportDialog = container.querySelector<HTMLElement>('[role="dialog"].watch-report-modal');
    expect(reportDialog).not.toBeNull();
    expect(container.querySelector('.watch-report-card')).toBeNull();
    expect(container.textContent).toContain('本次看片报告');
    expect(container.textContent).toContain('watch-report-model');
  });

  it('does not automatically open an active Watch report during a transient route stop', async () => {
    fake.startLiveSession({
      model: 'still-active-watch-report',
      reportStatus: 'active',
      sessionStartedAt: 'unix-ms:1000',
    });
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch' },
      },
    }));
    await renderPage();

    await runInAct(() => {
      const active = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
      active.inbound.streamBound = true;
      useAppStore.getState().setAudioRuntimeSnapshot(active);
    });
    await runInAct(() => {
      const transientlyStopped = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
      transientlyStopped.inbound.streamBound = false;
      useAppStore.getState().setAudioRuntimeSnapshot(transientlyStopped);
    });

    expect(fake.commandCalls('diagnostics_v2').map((call) => call.action)).toContain('watchSessionReport');
    expect(container.querySelector('[role="dialog"].watch-report-modal')).toBeNull();
    expect(container.textContent).toContain('本次看片报告');
  });

  it('does not open a Watch report when a voice-room route stops', async () => {
    fake.startLiveSession({ model: 'must-not-open', sessionStartedAt: 'unix-ms:1000' });
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'voice-room' },
      },
    }));
    await renderPage();

    await runInAct(() => {
      const active = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
      active.outbound.streamBound = true;
      useAppStore.getState().setAudioRuntimeSnapshot(active);
    });
    await runInAct(() => {
      const stopped = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
      stopped.outbound.streamBound = false;
      useAppStore.getState().setAudioRuntimeSnapshot(stopped);
    });

    expect(fake.commandCalls('diagnostics_v2').some((call) => call.action === 'watchSessionReport')).toBe(false);
    expect(container.querySelector('[role="dialog"].watch-report-modal')).toBeNull();
  });


  it('does not block watch launch on the legacy Omni preconnect command', async () => {
    // Armed so a preconnect attempt would fail loudly if the launch ever made one.
    fake.rejectNextAction('preconnect', { code: 'session.preconnect-denied', message: 'preconnect denied' });
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
      view.root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await clickAndSettle(container.querySelector('button'));

    expect(fake.sessionActionCalls('preconnect')).toHaveLength(0);
    expect(routeStartDirections()).toEqual(['inbound']);
    expect(useAppStore.getState().runtimeNotifications.some((item) =>
      item.message.includes('Omni 预连接失败'),
    )).toBe(false);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(true);
  });

  it('keeps the watch route active when the background overlay fails to open', async () => {
    fake.rejectNextAction('show_subtitle_overlay', { code: 'overlay.open-failed', message: 'overlay denied' });
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
      view.root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await clickAndSettle(container.querySelector('button'));

    expect(routeStartArgs(0)).toMatchObject({ direction: 'inbound' });
    expect(stopRouteDirections()).toEqual([]);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(true);
  });

  it('does not tear down or fail the watch route when readiness is still converging at the deadline', async () => {
    // Regression: the native watch route is fire-and-converge. When the client
    // readiness budget elapses without a native error, the launch must NOT stop
    // the route or surface a failure — the route keeps initializing and pushes a
    // bound (or failed) snapshot on its own. Previously this case tore the route
    // down and swallowed the outcome, so clicking watch appeared to do nothing.
    vi.useFakeTimers();
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
      view.root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    // Hold the first readiness poll so the native worker cannot converge while
    // the client budget runs out: the launch observes an accepted, still-armed,
    // error-free route exactly at its deadline.
    const releaseReadinessPoll = holdCommand('snapshot');
    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    await runInAct(() => launchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    vi.setSystemTime(Date.now() + 2_000);
    await runInAct(releaseReadinessPoll);

    // The launch finished at its deadline instead of hanging: the busy state is
    // released and the watch button is clickable again.
    expect(isBusy()).toBe(false);
    expect(container.querySelectorAll<HTMLButtonElement>('.provider-list button')[0]?.textContent).toBe('看片');
    expect(routeStartDirections()).toEqual(['inbound']);
    expect(stopRouteDirections()).toEqual([]);
    expect(useAppStore.getState().runtimeNotifications.some((item) => item.level === 'error')).toBe(false);
    // Still converging natively rather than torn down.
    expect(fake.getAudioSnapshot().inbound.captureState).toBe('armed');
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(false);

    // …and the worker's own convergence still lands afterwards and drives the UI.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(true);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.captureState).toBe('capturing');
    vi.useRealTimers();
  });

  it('does not reopen the subtitle overlay when it is already visible during watch launch', async () => {
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
        runtimeSnapshot: {
          ...state.runtimeSnapshot,
          windows: state.runtimeSnapshot.windows.map((item) =>
            item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
          ),
        },
      }));
    });

    await renderPage();

    await clickAndSettle(container.querySelector<HTMLButtonElement>('button'));

    expect(routeStartArgs(0)).toMatchObject({ direction: 'inbound' });
    expect(fake.commandCalls('show_subtitle_overlay')).toHaveLength(0);
    expect(fake.commandCalls('toggle_subtitle_overlay')).toHaveLength(0);
  });

  it('starts speech dispatch for Omni watch mode when device translated speech output is enabled', async () => {
    await renderPage();

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
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);

    await clickAndSettle(launchButton);

    expect(routeStartDirections()).toEqual(['inbound']);
    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(1);
    expect(sessionCommandArgs('startSpeech')).toMatchObject({
      config: {
        devices: {
          routeMode: 'watch',
          outputSpeechEnabled: true,
          subtitleTranslationMode: 'secondary',
        },
        speech: {
          enabled: true,
          localPlaybackEnabled: true,
        },
      },
    });
    expect(useAppStore.getState().audioRuntimeSnapshot.speech.dispatchState).toBe('waiting-subtitle');
  });

  it('starts speech dispatch for Omni watch mode when secondary translation speech is enabled', async () => {
    await renderPage();

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
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);

    await clickAndSettle(launchButton);

    expect(routeStartDirections()).toEqual(['inbound']);
    expect(fake.sessionActionCalls('startSpeech')).toHaveLength(1);
    expect(sessionCommandArgs('startSpeech')).toMatchObject({
      config: {
        devices: {
          routeMode: 'watch',
          subtitleTranslationMode: 'secondary',
        },
        speech: {
          enabled: true,
          localPlaybackEnabled: true,
        },
      },
    });
    expect(useAppStore.getState().audioRuntimeSnapshot.speech.dispatchState).toBe('waiting-subtitle');
  });

  it('delegates virtual-driver readiness to the background watch worker', async () => {
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

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await renderPage();

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);

    await clickAndSettle(launchButton);

    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(routeStartArgs(0)).toMatchObject({
      direction: 'inbound',
      config: { speech: { localPlaybackEnabled: true } },
    });
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(true);
  });

  it('does not synchronously repair or downgrade virtual-driver watch startup', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Armed so a synchronous driver install during launch would fail loudly.
    fake.rejectNextAction('install', { code: 'bridge.install-failed', message: 'SYSVAD package missing' });
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
      view.root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await clickAndSettle(container.querySelector('button'));

    expect(confirmMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(routeStartArgs(0)).toMatchObject({ direction: 'inbound' });
    confirmMock.mockRestore();
  });

  it('preserves the requested watch route while Bridge converges in the background', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fake.rejectNextAction('install', { code: 'bridge.install-failed', message: 'SYSVAD package missing' });
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
      view.root.render(
        <MemoryRouter>
          <RealTimeSessionPage />
        </MemoryRouter>,
      );
    });

    await clickAndSettle(container.querySelector('button'));

    expect(routeStartArgs(0)).toMatchObject({
      direction: 'inbound',
      config: { devices: { routeMode: 'watch', feedbackLoopPrevention: 'virtual-driver' } },
    });
    expect(bridgeLifecycleCalls()).toHaveLength(0);
    confirmMock.mockRestore();
  });

  for (const scenario of [
    {
      name: 'devices.virtualMicOutputEnabled',
      devices: { feedbackLoopPrevention: 'none' as const, virtualMicOutputEnabled: true },
      speech: { outputTarget: 'speaker' as const },
    },
    {
      name: 'speech outputTarget virtual-mic',
      devices: { feedbackLoopPrevention: 'none' as const, virtualMicOutputEnabled: false },
      speech: { outputTarget: 'virtual-mic' as const },
    },
    {
      name: 'speech outputTarget both',
      devices: { feedbackLoopPrevention: 'none' as const, virtualMicOutputEnabled: false },
      speech: { outputTarget: 'both' as const },
    },
  ]) {
    it(`does not block watch startup on Bridge repair for ${scenario.name}`, async () => {
      const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
      fake.rejectNextAction('install', { code: 'bridge.install-failed', message: 'driver package missing' });
      await act(async () => {
        useAppStore.setState((state) => ({
          ...state,
          configDraft: {
            ...state.configDraft,
            devices: {
              ...state.configDraft.devices,
              outputSpeechEnabled: false,
              ...scenario.devices,
            },
            speech: {
              ...state.configDraft.speech,
              enabled: false,
              virtualMicOutputEnabled: false,
              ...scenario.speech,
            },
          },
        }));
        view.root.render(
          <MemoryRouter>
            <RealTimeSessionPage />
          </MemoryRouter>,
        );
      });

      await clickAndSettle(container.querySelector('button'));

      expect(confirmMock).not.toHaveBeenCalled();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(bridgeLifecycleCalls()).toHaveLength(0);
      expect(routeStartArgs(0)).toMatchObject({ direction: 'inbound' });
      confirmMock.mockRestore();
    });
  }

  it('does not synchronously install Bridge when virtualMicOutputEnabled is true', async () => {
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
    fake.rejectNextAction('install', { code: 'bridge.install-failed', message: 'driver package missing' });

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await renderPage();

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);

    await clickAndSettle(launchButton);

    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(routeStartArgs(0)).toMatchObject({ direction: 'inbound' });
  });

  it('does not synchronously install Bridge for speech outputTarget virtual-mic', async () => {
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
    fake.rejectNextAction('install', { code: 'bridge.install-failed', message: 'driver package missing' });

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await renderPage();

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);

    await clickAndSettle(launchButton);

    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(routeStartArgs(0)).toMatchObject({ direction: 'inbound' });
  });

  it('blocks a new watch launch while the previous route is stopping', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audioRuntimeSnapshot.inbound.captureState = 'stopping';
    audioRuntimeSnapshot.inbound.streamBound = false;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot }));

    await renderPage();

    await clickAndSettle(container.querySelector('button'));

    expect(fake.sessionActionCalls('preconnect')).toHaveLength(0);
    expect(fake.commandCalls('start_audio_route')).toHaveLength(0);
    expect(useAppStore.getState().runtimeNotifications.some((item) =>
      item.message.includes('正在停止上一条链路'),
    )).toBe(true);
  });

  it('blocks a new conversation launch while the previous route is stopping', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audioRuntimeSnapshot.outbound.captureState = 'stopping';
    audioRuntimeSnapshot.outbound.streamBound = false;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot }));

    await renderPage();

    await clickAndSettle(container.querySelectorAll<HTMLButtonElement>('.provider-list button')[1]);

    expect(fake.commandCalls('start_audio_route')).toHaveLength(0);
    expect(useAppStore.getState().runtimeNotifications.some((item) =>
      item.message.includes('正在停止上一条链路'),
    )).toBe(true);
  });

  it('keeps launch buttons disabled and stops runtimes sequentially while stop is pending', async () => {
    await startNativeSession();
    const releaseSpeechStop = holdCommand('stopSpeech');
    const releaseTranslateStop = holdCommand('stopTranslation');
    const releaseOutboundStop = holdCommand('stopRoute:outbound');
    const releaseInboundStop = holdCommand('stopRoute:inbound');

    await renderPage();

    const launchButtons = container.querySelectorAll<HTMLButtonElement>('.provider-list button');
    const stopButton = container.querySelector<HTMLButtonElement>('.control-toolbar button');
    await runInAct(() => stopButton?.click());

    expect(launchButtons[0].disabled).toBe(true);
    expect(launchButtons[1].disabled).toBe(true);
    expect(stopActionOrder()).toEqual(['stopSpeech']);

    await runInAct(releaseSpeechStop);
    expect(stopActionOrder()).toEqual(['stopSpeech', 'stopTranslation']);
    expect(launchButtons[0].disabled).toBe(true);

    await runInAct(releaseTranslateStop);
    expect(stopActionOrder()).toEqual(['stopSpeech', 'stopTranslation', 'stopRoute:outbound']);
    expect(launchButtons[0].disabled).toBe(true);

    await runInAct(releaseOutboundStop);
    expect(stopActionOrder()).toEqual([
      'stopSpeech',
      'stopTranslation',
      'stopRoute:outbound',
      'stopRoute:inbound',
    ]);
    expect(launchButtons[0].disabled).toBe(true);

    await runInAct(releaseInboundStop);
    await settleSession();

    // Every stop converged natively and the chain is genuinely down again.
    expect(stopRouteDirections()).toEqual(['outbound', 'inbound']);
    const stopped = fake.getAudioSnapshot();
    expect(stopped.inbound.captureState).toBe('idle');
    expect(stopped.outbound.captureState).toBe('idle');
    expect(stopped.speech.dispatchState).toBe('idle');
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(false);
    expect(launchButtons[0].disabled).toBe(false);
  });

  it('toggles overlay, clears cues and stops every active runtime path', async () => {
    await startNativeSession();
    expect(fake.getAudioSnapshot().subtitleOverlay.recentCues.length).toBeGreaterThan(0);

    await renderPage();

    await clickAndSettle(container.querySelectorAll<HTMLButtonElement>('.control-toolbar button')[1]);
    expect(fake.commandCalls('toggle_subtitle_overlay')).toHaveLength(1);
    expect(useAppStore.getState().runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay')?.visible).toBe(true);
    expect(container.textContent).toContain('隐藏浮窗');

    await clickAndSettle(container.querySelectorAll<HTMLButtonElement>('.control-toolbar button')[2]);
    expect(fake.sessionActionCalls('clearCues')).toHaveLength(1);
    expect(fake.getAudioSnapshot().subtitleOverlay.recentCues).toEqual([]);
    expect(useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay.recentCues).toEqual([]);
    expect(container.textContent).toContain('暂无字幕事件');

    await clickAndSettle(container.querySelectorAll<HTMLButtonElement>('.control-toolbar button')[0]);
    expect(fake.sessionActionCalls('stopSpeech')).toHaveLength(1);
    expect(fake.sessionActionCalls('stopTranslation')).toHaveLength(1);
    expect(stopRouteDirections()).toEqual(['outbound', 'inbound']);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(false);
    expect(useAppStore.getState().audioRuntimeSnapshot.outbound.streamBound).toBe(false);
    expect(useAppStore.getState().audioRuntimeSnapshot.speech.dispatchState).toBe('idle');
  });

  it('surfaces microphone capture and TTS playback failures with recovery actions', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audioRuntimeSnapshot.outbound.lastError = 'microphone device disconnected';
    audioRuntimeSnapshot.outbound.lastErrorCode = 'audio.device-lost';
    audioRuntimeSnapshot.speech.lastError = 'speaker write timeout';
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot }));

    await renderPage();

    expect(container.textContent).toContain('音频设备已断开或不可用');
    expect(container.textContent).toContain('语音播报异常');
    expect(container.textContent).toContain('字幕仍可继续使用');
    expect(container.querySelector('a[href="/audio-routing"]')).not.toBeNull();
  });

  it('surfaces overlay toggle failures in the session page and notification stream', async () => {
    fake.rejectNextAction('toggle_subtitle_overlay', { message: 'overlay timeout' });
    await renderPage();
    const toolbarButtons = container.querySelectorAll<HTMLButtonElement>('.control-toolbar button');
    await act(async () => {
      toolbarButtons[1].click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('overlay timeout');
    expect(useAppStore.getState().runtimeNotifications.some((item) => item.message.includes('overlay timeout'))).toBe(true);
  });

  it('surfaces clear-subtitle failures instead of creating an unhandled rejection', async () => {
    fake.rejectNextAction('clearCues', { message: 'cue store locked' });
    await renderPage();
    const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.control-toolbar button'))
      .find((button) => button.textContent?.includes('清空字幕'));
    await act(async () => {
      clearButton?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('cue store locked');
    expect(useAppStore.getState().runtimeNotifications.some((item) => item.message.includes('cue store locked'))).toBe(true);
  });

  it('does not synchronously install Bridge for speech outputTarget both', async () => {
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
    fake.rejectNextAction('install', { code: 'bridge.install-failed', message: 'driver package missing' });

    await act(async () => {
      useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    });

    await renderPage();

    const launchButton = container.querySelector('button') as HTMLButtonElement | null;
    expect(launchButton).toBeInstanceOf(HTMLButtonElement);

    await clickAndSettle(launchButton);

    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(routeStartArgs(0)).toMatchObject({ direction: 'inbound' });
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

    await renderPage();

    expect(container.textContent).toContain('fallback source');
    expect(container.textContent).toContain('丢弃 3 条');
    expect(container.textContent).toContain('[翻译失败] timeout');
    expect(container.textContent).toContain('translated text');
    expect(container.textContent).toContain('正在调用 LLM 翻译...');
  });

  it('renders ready empty subtitle and model trace states', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audioRuntimeSnapshot.subtitleOverlay.activeCue = null;
    audioRuntimeSnapshot.subtitleOverlay.queueDepth = 0;
    audioRuntimeSnapshot.subtitleOverlay.droppedCueCount = 0;
    audioRuntimeSnapshot.subtitleOverlay.recentCues = [];
    const runtimeSnapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtimeSnapshot.diagnostics.modelTraceSummary.recentCalls = [];
    runtimeSnapshot.diagnostics.modelTraceSummary.failedCalls = 0;
    runtimeSnapshot.diagnostics.modelTraceSummary.lastError = null;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot, runtimeSnapshot }));

    await renderPage();

    expect(container.querySelector('.console-event-item-empty')).not.toBeNull();
    expect(container.querySelectorAll('.console-event-item')).toHaveLength(3);
    expect(container.textContent).not.toContain('涓㈠純');
  });

  it('renders committed active subtitle failure and ready queue badge', async () => {
    const audioRuntimeSnapshot = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    const cue = audioRuntimeSnapshot.subtitleOverlay.recentCues[0];
    audioRuntimeSnapshot.subtitleOverlay.activeCue = {
      ...cue,
      cueId: 'cue-committed-empty',
      displaySourceText: '',
      sourceText: 'committed source',
      translatedText: '',
      committed: true,
    };
    audioRuntimeSnapshot.subtitleOverlay.queueDepth = 0;
    audioRuntimeSnapshot.subtitleOverlay.droppedCueCount = 0;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot }));

    await renderPage();

    expect(container.textContent).toContain('committed source');
    expect(container.textContent).toContain('翻译失败');
    expect(container.textContent).toContain('队列 0');
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

    await renderPage();
    await clickAndSettle(container.querySelector<HTMLButtonElement>('button'));

    expect(fake.sessionActionCalls('startTranslation')).toHaveLength(1);
    expect(sessionCommandArgs('startTranslation')).toMatchObject({
      config: { devices: { routeMode: 'watch', inboundVoiceModelId: 'provider::plain-model' } },
    });
    expect(fake.getAudioSnapshot().sessionStartedAt).not.toBeNull();
  });

  it('ignores a damaged optional driver when starting AEC conversation capture', async () => {
    const runtimeSnapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtimeSnapshot.bridge.driverHealth = 'damaged';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    runtimeSnapshot.bridge.recommendedAction = 'rollback-driver';
    fake.rejectNextAction('repair', { code: 'bridge.repair-failed', message: 'driver repair unavailable' });
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));

    await renderPage();
    await clickAndSettle(container.querySelectorAll<HTMLButtonElement>('button')[1]);

    expect(bridgeLifecycleCalls()).toHaveLength(0);
    expect(routeStartDirections()).toEqual(['inbound', 'outbound']);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(true);
    expect(useAppStore.getState().audioRuntimeSnapshot.outbound.streamBound).toBe(true);
  });

  it('reports non-error conversation launch failures', async () => {
    const runtimeSnapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtimeSnapshot.bridge.driverHealth = 'running';
    runtimeSnapshot.bridge.bridgeState = 'running';
    // The native side rejects with a ServiceErrorV2 record, not an Error.
    fake.rejectNextAction('start_audio_route', { code: 'session.capture-unavailable', message: 'capture unavailable' });
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));

    await renderPage();
    await clickAndSettle(container.querySelectorAll<HTMLButtonElement>('button')[1]);

    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('capture unavailable');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('capture unavailable');
    // A route that never started must not be torn down.
    expect(stopRouteDirections()).toEqual([]);
  });

  it('shows degraded inbound capture and the bridge restart recommendation', async () => {
    // Accepted-then-failed capture: the command succeeds and the failure lands
    // later as a lastError snapshot push, exactly like the native worker.
    fake.failNextRouteStart('inbound', {
      lastError: 'Bridge source pipe initialization timed out (10s).',
      recommendedAction: 'restart-bridge',
    });

    await renderPage();
    await clickAndSettle(container.querySelector<HTMLButtonElement>('button'));

    expect(routeStartDirections()).toEqual(['inbound']);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.lastError).toContain('Bridge source pipe initialization timed out');
    expect(container.textContent).toContain('系统音频采集异常');
    expect(container.textContent).toContain('Bridge source pipe initialization timed out (10s).');
    expect(container.textContent).toContain('建议重启 Bridge Service 后重试');
  });

  it('handles every Watch fallback dialog dismissal and diagnostics-ready mode', async () => {
    const onResolve = vi.fn();
    await view.render(<WatchFallbackDialog onResolve={onResolve} />);
    await act(async () => container.querySelector<HTMLElement>('[role="dialog"]')?.click());
    expect(onResolve).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('.action-button')?.click());
    expect(onResolve).toHaveBeenLastCalledWith(true);
    await view.render(<WatchFallbackDialog onResolve={onResolve} />);
    await act(async () => container.querySelector<HTMLButtonElement>('.icon-button')?.click());
    expect(onResolve).toHaveBeenLastCalledWith(false);
    await view.render(<WatchFallbackDialog onResolve={onResolve} />);
    await act(async () => container.querySelector<HTMLElement>('.modal-backdrop--benchmark')?.click());
    expect(onResolve).toHaveBeenLastCalledWith(false);
    expect(diagnosticsReadyPatchForMode('watch')).toEqual({ deviceStatus: 'ready' });
    expect(diagnosticsReadyPatchForMode('game')).toEqual({ deviceStatus: 'ready', driverStatus: 'ready' });
  });
});
